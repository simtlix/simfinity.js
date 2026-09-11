import {
  GraphQLObjectType, GraphQLString, GraphQLID, GraphQLSchema, GraphQLList,
  GraphQLNonNull, GraphQLInputObjectType, GraphQLScalarType, __Field,
  GraphQLInt, GraphQLEnumType, GraphQLBoolean, GraphQLFloat, Kind,
} from 'graphql';
import mongoose from 'mongoose';

import SimfinityError from './errors/simfinity.error.js';
import InternalServerError from './errors/internal-server.error.js';
import QLOperator from './const/QLOperator.js';
import QLValue from './const/QLValue.js';
import QLSort from './const/QLSort.js';

mongoose.set('strictQuery', false);

const GraphQLJSON = new GraphQLScalarType({
  name: 'JSON',
  description: 'The `JSON` scalar type represents JSON values as specified by ECMA-404',
  serialize(value) {
    return value;
  },
  parseValue(value) {
    return value;
  },
  parseLiteral(ast) {
    switch (ast.kind) {
      case Kind.STRING:
      case Kind.BOOLEAN:
        return ast.value;
      case Kind.INT:
        return parseInt(ast.value, 10);
      case Kind.FLOAT:
        return parseFloat(ast.value);
      case Kind.OBJECT: {
        const value = Object.create(null);
        ast.fields.forEach((field) => {
          value[field.name.value] = GraphQLJSON.parseLiteral(field.value);
        });
        return value;
      }
      case Kind.LIST:
        return ast.values.map((n) => GraphQLJSON.parseLiteral(n));
      case Kind.NULL:
        return null;
      default:
        return undefined;
    }
  },
});

// getFields() supports both lazy and already materialized introspection fields.
// Reuse the shared field on repeated module evaluation to preserve type identity.
const introspectionFields = __Field.getFields();
if (!introspectionFields.extensions) {
  const RelationType = new GraphQLObjectType({
    name: 'RelationType',
    fields: () => ({
      embedded: { type: GraphQLBoolean },
      connectionField: { type: GraphQLString },
      displayField: { type: GraphQLString },
    }),
  });

  const FieldExtensionsType = new GraphQLObjectType({
    name: 'FieldExtensionsType',
    fields: () => ({
      relation: { type: RelationType },
      stateMachine: { type: GraphQLBoolean },
      readOnly: { type: GraphQLBoolean },
    }),
  });

  introspectionFields.extensions = {
    type: FieldExtensionsType,
    name: 'extensions',
    resolve: (obj) => obj.extensions,
    args: [],
    isDeprecated: false,
  };
}

const typesDict = { types: {} };
const waitingInputType = {};
const typesDictForUpdate = { types: {} };
const registeredMutations = {};

const operations = {
  SAVE: 'save',
  UPDATE: 'update',
  DELETE: 'delete',
  STATE_CHANGED: 'state_changed',
  CUSTOM_MUTATION: 'custom_mutation',
};

const buildErrorFormatter = (callback) => {
  const formatError = (err) => {
    let result = null;
    if (err instanceof SimfinityError) {
      result = err;
    } else {
      result = new InternalServerError(err.message, err);
    }

    if (callback) {
      const formattedError = callback(result);
      return formattedError || result;
    }
    return result;
  };
  return formatError;
};

const middlewares = [];

export const use = (middleware) => {
  middlewares.push(middleware);
};

export { buildErrorFormatter };

export { SimfinityError };

export { InternalServerError };

let preventCollectionCreation = false;

export const preventCreatingCollection = (prevent) => {
  preventCollectionCreation = !!prevent;
};

const QLFilter = new GraphQLInputObjectType({
  name: 'QLFilter',
  fields: () => ({
    operator: { type: QLOperator },
    value: { type: QLValue },
  }),
});

const QLTypeFilter = new GraphQLInputObjectType({
  name: 'QLTypeFilter',
  fields: () => ({
    operator: { type: QLOperator },
    value: { type: QLValue },
    path: { type: GraphQLString },
  }),
});

const IdInputType = new GraphQLInputObjectType({
  name: 'IdInputType',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLString) },
  }),
});

const QLTypeFilterExpression = new GraphQLInputObjectType({
  name: 'QLTypeFilterExpression',
  fields: () => ({
    terms: { type: new GraphQLList(QLTypeFilter) },
  }),
});

const QLFilterCondition = new GraphQLInputObjectType({
  name: 'QLFilterCondition',
  fields: () => ({
    field: { type: new GraphQLNonNull(GraphQLString) },
    operator: { type: QLOperator },
    value: { type: QLValue },
    path: { type: GraphQLString },
  }),
});

const QLFilterGroup = new GraphQLInputObjectType({
  name: 'QLFilterGroup',
  fields: () => ({
    AND: { type: new GraphQLList(QLFilterGroup) },
    OR: { type: new GraphQLList(QLFilterGroup) },
    conditions: { type: new GraphQLList(QLFilterCondition) },
  }),
});

const QLPagination = new GraphQLInputObjectType({
  name: 'QLPagination',
  fields: () => ({
    page: { type: new GraphQLNonNull(GraphQLInt) },
    size: { type: new GraphQLNonNull(GraphQLInt) },
    count: { type: GraphQLBoolean },
  }),
});

const QLSortExpression = new GraphQLInputObjectType({
  name: 'QLSortExpression',
  fields: () => ({
    terms: { type: new GraphQLList(QLSort) },
  }),
});

const QLAggregationOperation = new GraphQLEnumType({
  name: 'QLAggregationOperation',
  values: {
    SUM: { value: 'SUM' },
    COUNT: { value: 'COUNT' },
    AVG: { value: 'AVG' },
    MIN: { value: 'MIN' },
    MAX: { value: 'MAX' },
  },
});

const QLTypeAggregationFact = new GraphQLInputObjectType({
  name: 'QLTypeAggregationFact',
  fields: () => ({
    operation: { type: new GraphQLNonNull(QLAggregationOperation) },
    factName: { type: new GraphQLNonNull(GraphQLString) },
    path: { type: new GraphQLNonNull(GraphQLString) },
  }),
});

const QLTypeAggregationExpression = new GraphQLInputObjectType({
  name: 'QLTypeAggregationExpression',
  fields: () => ({
    groupId: { type: new GraphQLNonNull(GraphQLString) },
    facts: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(QLTypeAggregationFact))) },
  }),
});

const QLTypeAggregationResult = new GraphQLObjectType({
  name: 'QLTypeAggregationResult',
  fields: () => ({
    groupId: { type: GraphQLJSON },
    facts: { type: GraphQLJSON },
  }),
});

const isNonNullOfType = (fieldEntryType, graphQLType) => {
  let isOfType = false;
  if (fieldEntryType instanceof GraphQLNonNull) {
    isOfType = fieldEntryType.ofType instanceof graphQLType;
  }
  return isOfType;
};

const isNonNullOfTypeForNotScalar = (fieldEntryType, graphQLType) => {
  let isOfType = false;
  if (fieldEntryType instanceof GraphQLNonNull) {
    isOfType = fieldEntryType.ofType === graphQLType;
  }
  return isOfType;
};

const getEffectiveTypeName = (type) => {
  if (type instanceof GraphQLScalarType && type.baseScalarType) {
    return type.baseScalarType.name;
  }
  return type.name;
};

const isGraphQLisoDate = (typeName) => typeName === 'DateTime' || typeName === 'Date' || typeName === 'Time';

const unwrapNonNull = (type) => (type instanceof GraphQLNonNull ? type.ofType : type);

const unwrapListAndNonNull = (type) => {
  if (type instanceof GraphQLList || type instanceof GraphQLNonNull) {
    return type.ofType;
  }
  return type;
};

const isCustomValidatedScalar = (type) => type instanceof GraphQLScalarType && type.baseScalarType;

const matchesScalar = (fieldType, target) => {
  if (fieldType === target) return true;
  if (isNonNullOfTypeForNotScalar(fieldType, target)) return true;
  if (isCustomValidatedScalar(fieldType) && fieldType.baseScalarType === target) return true;
  if (isNonNullOfType(fieldType, GraphQLScalarType)
    && isCustomValidatedScalar(fieldType.ofType)
    && fieldType.ofType.baseScalarType === target) return true;
  return false;
};

const buildRelationLookup = ({
  collectionName, localField, foreignField, alias,
}) => ({
  lookup: {
    $lookup: {
      from: collectionName, foreignField, localField, as: alias,
    },
  },
  unwind: { $unwind: { path: `$${alias}`, preserveNullAndEmptyArrays: true } },
});

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const PATH_SEGMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const assertValidFilterPath = (path) => {
  if (typeof path !== 'string' || path.length === 0) {
    throw new SimfinityError('Filter path must be a non-empty string', 'INVALID_FILTER_PATH', 400);
  }
  for (const segment of path.split('.')) {
    if (!PATH_SEGMENT_RE.test(segment)) {
      throw new SimfinityError(`Invalid filter path segment: "${segment}"`, 'INVALID_FILTER_PATH', 400);
    }
  }
};

const normalizeFilterCondition = (condition) => {
  const { field } = condition;
  if (typeof field !== 'string') return condition;
  const dotIdx = field.indexOf('.');
  if (dotIdx < 0) return condition;
  if (condition.path != null && condition.path !== '') {
    throw new SimfinityError(
      'Filter condition cannot use both dotted field syntax and a separate path',
      'AMBIGUOUS_FILTER_FIELD',
      400,
    );
  }
  return {
    ...condition,
    field: field.slice(0, dotIdx),
    path: field.slice(dotIdx + 1),
  };
};

const OP_TO_MONGO = {
  LT: (v) => ({ $lt: v }),
  GT: (v) => ({ $gt: v }),
  LTE: (v) => ({ $lte: v }),
  GTE: (v) => ({ $gte: v }),
  NE: (v) => ({ $ne: v }),
  BTW: (v) => ({ $gte: v[0], $lte: v[1] }),
  LIKE: (v) => ({ $regex: `.*${escapeRegex(v)}.*` }),
};

const AGG_OP_TO_MONGO = {
  SUM: (path) => ({ $sum: `$${path}` }),
  COUNT: () => ({ $sum: 1 }),
  AVG: (path) => ({ $avg: `$${path}` }),
  MIN: (path) => ({ $min: `$${path}` }),
  MAX: (path) => ({ $max: `$${path}` }),
};

function createValidatedScalar(name, description, baseScalarType, validate) {
  if (!baseScalarType) {
    throw new Error('baseScalarType is required');
  }

  if (!(baseScalarType instanceof GraphQLScalarType)) {
    throw new Error('baseScalarType must be a valid GraphQL scalar type');
  }

  const validScalarTypes = [GraphQLString, GraphQLInt, GraphQLFloat, GraphQLBoolean, GraphQLID];
  const isValidStandardType = validScalarTypes.some((type) => baseScalarType === type);

  if (!isValidStandardType && !baseScalarType.name) {
    throw new Error('baseScalarType must be a standard GraphQL scalar type or a custom scalar with a valid name');
  }

  const kindMap = {
    String: Kind.STRING,
    Int: Kind.INT,
    Float: Kind.FLOAT,
    Boolean: Kind.BOOLEAN,
    ID: Kind.STRING,
  };

  const baseKind = kindMap[baseScalarType.name] || Kind.STRING;

  const scalar = new GraphQLScalarType({
    name: `${name}_${baseScalarType.name}`,
    description,
    serialize(value) {
      validate(value);
      return baseScalarType.serialize(value);
    },
    parseValue(value) {
      validate(value);
      return baseScalarType.parseValue(value);
    },
    parseLiteral(ast, variables) {
      if (ast.kind !== baseKind) {
        throw new Error(`${name}_${baseScalarType.name} must be a ${baseScalarType.name}`);
      }
      const value = baseScalarType.parseLiteral(ast, variables);
      validate(value);
      return value;
    },
  });

  scalar.baseScalarType = baseScalarType;
  return scalar;
}

/**
 * Creates a new GraphQLInputObjectType with a field excluded.
 * @param {string} inputNamePrefix - The prefix for the input type name.
 * @param {GraphQLInputObjectType} originalType - The original input type.
 * @param {string} fieldToExclude - The name of the field to exclude.
 * @returns {GraphQLInputObjectType} A new input type without the specified field.
 */
const createTypeWithExcludedField = (inputNamePrefix, originalType, fieldToExclude) => {
  const originalFields = originalType.getFields();
  const newFields = Object.fromEntries(
    Object.entries(originalFields)
      .filter(([fieldName]) => fieldName !== fieldToExclude)
      .map(([fieldName, field]) => [fieldName, {
        type: field.type,
        description: field.description,
        defaultValue: field.defaultValue,
      }]),
  );

  return new GraphQLInputObjectType({
    name: `${inputNamePrefix}${originalType.name}For${fieldToExclude.charAt(0).toUpperCase() + fieldToExclude.slice(1)}`,
    fields: newFields,
  });
};

const createOneToManyInputType = (inputNamePrefix, fieldEntryName,
  inputType, updateInputType, connectionField) => {
  let inputTypeForAdd = inputType;

  if (connectionField) {
    inputTypeForAdd = createTypeWithExcludedField(inputNamePrefix, inputType, connectionField);
  }

  return new GraphQLInputObjectType({
    name: `OneToMany${inputNamePrefix}${fieldEntryName}`,
    fields: () => ({
      added: {
        type: new GraphQLList(inputTypeForAdd),
      },
      updated: {
        type: new GraphQLList(updateInputType),
      },
      deleted: {
        type: new GraphQLList(GraphQLID),
      },
    }),
  });
};

const graphQLListInputType = (dict, fieldEntry, fieldEntryName, inputNamePrefix, connectionField) => {
  const { ofType } = fieldEntry.type;

  if (ofType instanceof GraphQLObjectType && dict.types[ofType.name].inputType) {
    if (!fieldEntry.extensions || !fieldEntry.extensions.relation
      || !fieldEntry.extensions.relation.embedded) {
      const oneToMany = createOneToManyInputType(inputNamePrefix, fieldEntryName,
        typesDict.types[ofType.name].inputType, typesDictForUpdate.types[ofType.name].inputType, connectionField);
      return oneToMany;
    }
    if (fieldEntry.extensions && fieldEntry.extensions.relation
      && fieldEntry.extensions.relation.embedded) {
      return new GraphQLList(dict.types[ofType.name].inputType);
    }
  } else if (ofType instanceof GraphQLScalarType || ofType instanceof GraphQLEnumType) {
    return new GraphQLList(ofType);
  }
  return null;
};

const buildInputType = (gqltype) => {
  const argTypes = gqltype.getFields();

  const fieldsArgs = {};
  const fieldsArgForUpdate = {};

  const selfReferenceCollections = {};

  for (const [fieldEntryName, fieldEntry] of Object.entries(argTypes)) {
    const fieldArg = {};
    const fieldArgForUpdate = {};

    if (!fieldEntry.extensions || !fieldEntry.extensions.readOnly) {
      const hasStateMachine = !!typesDict.types[gqltype.name].stateMachine;
      const stateFieldManagedByStateMachine = !!(fieldEntryName === 'state' && hasStateMachine);

      if (!stateFieldManagedByStateMachine) {
        if (fieldEntry.type instanceof GraphQLScalarType
          || fieldEntry.type instanceof GraphQLEnumType
          || isNonNullOfType(fieldEntry.type, GraphQLScalarType)
          || isNonNullOfType(fieldEntry.type, GraphQLEnumType)) {
          if (fieldEntryName !== 'id') {
            fieldArg.type = fieldEntry.type;
          }
          fieldArgForUpdate.type = fieldEntry.type instanceof GraphQLNonNull
            ? fieldEntry.type.ofType : fieldEntry.type;
          if (fieldEntry.type === GraphQLID) {
            fieldArgForUpdate.type = new GraphQLNonNull(GraphQLID);
          }
        } else if (fieldEntry.type instanceof GraphQLObjectType
          || isNonNullOfType(fieldEntry.type, GraphQLObjectType)) {
          if (fieldEntry.extensions && fieldEntry.extensions.relation) {
            const fieldEntryNameValue = fieldEntry.type instanceof GraphQLNonNull
              ? fieldEntry.type.ofType.name : fieldEntry.type.name;
            if (!fieldEntry.extensions.relation.embedded) {
              fieldArg.type = fieldEntry.type instanceof GraphQLNonNull
                ? new GraphQLNonNull(IdInputType) : IdInputType;
              fieldArgForUpdate.type = IdInputType;
            } else if (typesDict.types[fieldEntryNameValue].inputType
              && typesDictForUpdate.types[fieldEntryNameValue].inputType) {
              fieldArg.type = typesDict.types[fieldEntryNameValue].inputType;
              fieldArgForUpdate.type = typesDictForUpdate.types[fieldEntryNameValue].inputType;
            } else {
              return null;
            }
          } else {
            console.warn(`Configuration issue: Field ${fieldEntryName} does not define extensions.relation`);
          }
        } else if (fieldEntry.type instanceof GraphQLList) {
          if (fieldEntry.type.ofType === gqltype) {
            selfReferenceCollections[fieldEntryName] = fieldEntry;
          } else {
            const listInputTypeForAdd = graphQLListInputType(typesDict, fieldEntry, fieldEntryName, `${gqltype.name}A`, fieldEntry.extensions?.relation?.connectionField);
            const listInputTypeForUpdate = graphQLListInputType(typesDictForUpdate, fieldEntry, fieldEntryName, `${gqltype.name}U`, fieldEntry.extensions?.relation?.connectionField);
            if (listInputTypeForAdd && listInputTypeForUpdate) {
              fieldArg.type = listInputTypeForAdd;
              fieldArgForUpdate.type = listInputTypeForUpdate;
            } else {
              return null;
            }
          }
        }
        fieldArg.description = fieldEntry.description;
        fieldArgForUpdate.description = fieldEntry.description;

        if (fieldArg.type) {
          fieldsArgs[fieldEntryName] = fieldArg;
        }

        if (fieldArgForUpdate.type) {
          fieldsArgForUpdate[fieldEntryName] = fieldArgForUpdate;
        }
      } else {
        fieldEntry.extensions = { ...fieldEntry.extensions, stateMachine: true };
      }
    }
  }

  const inputTypeBody = {
    name: `${gqltype.name}Input`,
    description: gqltype.description,
    fields: fieldsArgs,
  };

  const inputTypeBodyForUpdate = {
    name: `${gqltype.name}InputForUpdate`,
    description: gqltype.description,
    fields: fieldsArgForUpdate,
  };

  const inputTypeForAdd = new GraphQLInputObjectType(inputTypeBody);
  const inputTypeForUpdate = new GraphQLInputObjectType(inputTypeBodyForUpdate);

  const inputTypeForAddFields = inputTypeForAdd._fields();

  Object.keys(selfReferenceCollections).forEach((fieldEntryName) => {
    if (Object.prototype.hasOwnProperty.call(selfReferenceCollections, fieldEntryName)) {
      inputTypeForAddFields[fieldEntryName] = {
        type: createOneToManyInputType('A', fieldEntryName, inputTypeForAdd, inputTypeForUpdate, selfReferenceCollections[fieldEntryName].extensions?.relation?.connectionField),
        name: fieldEntryName,
      };
    }
  });

  inputTypeForAdd._fields = () => inputTypeForAddFields;

  const inputTypeForUpdateFields = inputTypeForUpdate._fields();

  Object.keys(selfReferenceCollections).forEach((fieldEntryName) => {
    if (Object.prototype.hasOwnProperty.call(selfReferenceCollections, fieldEntryName)) {
      inputTypeForUpdateFields[fieldEntryName] = {
        type: createOneToManyInputType('U', fieldEntryName, inputTypeForAdd, inputTypeForUpdate, selfReferenceCollections[fieldEntryName].extensions?.relation?.connectionField),
        name: fieldEntryName,
      };
    }
  });

  inputTypeForUpdate._fields = () => inputTypeForUpdateFields;

  return { inputTypeBody: inputTypeForAdd, inputTypeBodyForUpdate: inputTypeForUpdate };
};

const getInputType = (type) => typesDict.types[type.name].inputType;

export { getInputType };

const buildPendingInputTypes = (waitingForInputType) => {
  let pending = waitingForInputType;
  let previousPendingCount = Object.keys(pending).length + 1;

  while (Object.keys(pending).length > 0) {
    const currentCount = Object.keys(pending).length;
    if (currentCount >= previousPendingCount) {
      const unresolved = Object.keys(pending).join(', ');
      throw new SimfinityError(
        `Could not build input types for: ${unresolved}. Check for circular or misconfigured relations.`,
        'INPUT_TYPE_UNRESOLVED',
        500,
      );
    }
    previousPendingCount = currentCount;

    const stillWaiting = {};
    for (const [key, value] of Object.entries(pending)) {
      const { gqltype } = value;
      if (typesDict.types[gqltype.name].inputType) continue;

      const result = buildInputType(gqltype);
      if (result && result.inputTypeBody && result.inputTypeBodyForUpdate) {
        typesDict.types[gqltype.name].inputType = result.inputTypeBody;
        typesDictForUpdate.types[gqltype.name].inputType = result.inputTypeBodyForUpdate;
      } else {
        stillWaiting[key] = value;
      }
    }
    pending = stillWaiting;
  }
};

const isEmpty = (value) => !value && value !== false && value !== 0;

const materializeModel = async (args, gqltype, linkToParent, operation, session) => {
  if (!args) {
    return null;
  }

  const argTypes = gqltype.getFields();

  const modelArgs = {};
  const collectionFields = {};

  for (const [fieldEntryName, fieldEntry] of Object.entries(argTypes)) {
    if (fieldEntry.extensions && fieldEntry.extensions.validations
      && fieldEntry.extensions.validations[operation]) {
      for (const validator of fieldEntry.extensions.validations[operation]) {
        await validator.validate(gqltype.name, fieldEntryName, args[fieldEntryName], session);
      }
    }

    if (!isEmpty(args[fieldEntryName])) {
      if (fieldEntry.type instanceof GraphQLScalarType
        || fieldEntry.type instanceof GraphQLEnumType
        || isNonNullOfType(fieldEntry.type, GraphQLScalarType)
        || isNonNullOfType(fieldEntry.type, GraphQLEnumType)) {
        modelArgs[fieldEntryName] = args[fieldEntryName];
      } else if (fieldEntry.type instanceof GraphQLObjectType
        || isNonNullOfType(fieldEntry.type, GraphQLObjectType)) {
        if (fieldEntry.extensions && fieldEntry.extensions.relation) {
          if (!fieldEntry.extensions.relation.embedded) {
            modelArgs[fieldEntry.extensions.relation.connectionField] = new mongoose.Types
              .ObjectId(args[fieldEntryName].id);
          } else {
            const fieldType = fieldEntry.type instanceof GraphQLNonNull
              ? fieldEntry.type.ofType : fieldEntry.type;
            modelArgs[fieldEntryName] = (await materializeModel(args[fieldEntryName], fieldType,
              null, operation, session)).modelArgs;
          }
        } else {
          throw new SimfinityError(
            `Field ${gqltype.name}.${fieldEntryName} is an object type but does not define extensions.relation`,
            'MISSING_RELATION_EXTENSION',
            500,
          );
        }
      } else if (fieldEntry.type instanceof GraphQLList) {
        const { ofType } = fieldEntry.type;
        if (ofType instanceof GraphQLObjectType && fieldEntry.extensions
          && fieldEntry.extensions.relation) {
          if (!fieldEntry.extensions.relation.embedded) {
            collectionFields[fieldEntryName] = args[fieldEntryName];
          } else if (fieldEntry.extensions.relation.embedded) {
            const collectionEntries = [];

            for (const element of args[fieldEntryName]) {
              const collectionEntry = (await materializeModel(element, ofType,
                null, operation, session)).modelArgs;
              if (collectionEntry) {
                collectionEntries.push(collectionEntry);
              }
            }
            modelArgs[fieldEntryName] = collectionEntries;
          }
        } else if (ofType instanceof GraphQLScalarType || ofType instanceof GraphQLEnumType) {
          modelArgs[fieldEntryName] = args[fieldEntryName];
        }
      }
    }
  }

  if (linkToParent) {
    linkToParent(modelArgs);
  }

  if (gqltype.extensions && gqltype.extensions.validations
    && gqltype.extensions.validations[operation]) {
    for (const validator of gqltype.extensions.validations[operation]) {
      await validator.validate(gqltype.name, args, modelArgs, session);
    }
  }

  return { modelArgs, collectionFields };
};

const MAX_TRANSIENT_RETRIES = 5;
const MAX_COMMIT_RETRIES = 5;

const commitWithRetry = async (session) => {
  for (let attempt = 0; ; attempt++) {
    try {
      await session.commitTransaction();
      return;
    } catch (error) {
      const isUnknown = error?.errorLabels?.includes('UnknownTransactionCommitResult');
      const isExpired = error?.code === 50 || error?.writeConcernError?.code === 50;
      if (!isUnknown || isExpired || attempt >= MAX_COMMIT_RETRIES) {
        throw error;
      }
      // An uncertain commit can already have succeeded. Retry only the commit,
      // never the writes or hooks, even if this error also carries a transient label.
    }
  }
};

const endOwnedSession = async (session, failed) => {
  try {
    await session.endSession();
  } catch (error) {
    if (!failed) throw error;
  }
};

const withTransaction = async (session, body, connection = mongoose.connection) => {
  if (session) {
    if (!session.inTransaction()) {
      throw new SimfinityError(
        'A supplied session must have an active transaction', 'ACTIVE_TRANSACTION_REQUIRED', 400,
      );
    }
    // The caller owns retries, commit, abort, and cleanup for a borrowed session.
    return body(session);
  }

  const mySession = connection === mongoose.connection
    ? await mongoose.startSession() : await connection.startSession();
  let failed = false;
  try {
    for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
      await mySession.startTransaction();
      try {
        const result = await body(mySession);
        await commitWithRetry(mySession);
        return result;
      } catch (error) {
        if (error?.errorLabels?.includes('UnknownTransactionCommitResult')) {
          throw error;
        }
        if (mySession.inTransaction()) {
          try {
            await mySession.abortTransaction();
          } catch {
            // Do not replace the operation error or retry on a session whose
            // previous transaction could not be aborted.
            throw error;
          }
        }
        const isTransient = error?.errorLabels?.includes('TransientTransactionError');
        if (isTransient && attempt < MAX_TRANSIENT_RETRIES) {
          continue;
        }
        throw error;
      }
    }
    throw new SimfinityError('Transaction exceeded retry limit', 'TRANSACTION_RETRY_EXCEEDED', 500);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await endOwnedSession(mySession, failed);
  }
};

const executeRegisteredMutation = (args, callback, context, session) => withTransaction(
  session,
  (mySession) => callback(args, mySession, context),
);

const iterateOnCollectionFields = async (materializedModel, gqltype, objectId, session, context) => {
  for (const [collectionFieldKey, collectionField] of Object.entries(materializedModel.collectionFields)) {
    if (collectionField.added) {
      await executeItemFunction(gqltype, collectionFieldKey, objectId, session,
        collectionField.added, operations.SAVE, context);
    }
    if (collectionField.updated) {
      await executeItemFunction(gqltype, collectionFieldKey, objectId, session,
        collectionField.updated, operations.UPDATE, context);
    }
    if (collectionField.deleted) {
      await executeItemFunction(gqltype, collectionFieldKey, objectId, session,
        collectionField.deleted, operations.DELETE, context);
    }
  }
};

const onDelete = async (Model, controller, id, session, context) => {
  const currentObject = await Model.findById({ _id: id }).session(session).lean();

  if (controller && controller.onDelete) {
    await controller.onDelete(currentObject, session, context);
  }

  return Model.findByIdAndDelete({ _id: id }).session(session);
};

const getEmbeddedFieldNames = (gqltype) => {
  const cached = typesDict.types[gqltype.name];
  if (cached && cached.embeddedFieldNames) return cached.embeddedFieldNames;
  const names = [];
  for (const [fieldName, fieldEntry] of Object.entries(gqltype.getFields())) {
    if (fieldEntry.extensions?.relation?.embedded) names.push(fieldName);
  }
  if (cached) cached.embeddedFieldNames = names;
  return names;
};

const onUpdateSubject = async (Model, gqltype, controller, args, session, linkToParent, context) => {
  const materializedModel = await materializeModel(args, gqltype, linkToParent, 'UPDATE', session);
  const objectId = args.id;
  const argTypes = gqltype.getFields();
  const embeddedFieldNames = getEmbeddedFieldNames(gqltype);

  if (embeddedFieldNames.length > 0) {
    const projection = Object.fromEntries(embeddedFieldNames.map((name) => [name, 1]));
    const currentObject = await Model.findById(objectId, projection).session(session).lean();
    if (currentObject) {
      for (const fieldEntryName of embeddedFieldNames) {
        const oldObjectData = currentObject[fieldEntryName];
        const newObjectData = materializedModel.modelArgs[fieldEntryName];
        if (newObjectData) {
          if (Array.isArray(oldObjectData) && Array.isArray(newObjectData)) {
            materializedModel.modelArgs[fieldEntryName] = newObjectData;
          } else {
            materializedModel.modelArgs[fieldEntryName] = { ...oldObjectData, ...newObjectData };
          }
        }
      }
    }
  }

  for (const [fieldEntryName, fieldEntry] of Object.entries(argTypes)) {
    if (args[fieldEntryName] === null && !(fieldEntry.type instanceof GraphQLNonNull)) {
      materializedModel.modelArgs = {
        ...materializedModel.modelArgs,
        $unset: { ...materializedModel.modelArgs.$unset, [fieldEntryName]: '' },
      };
    }
  }

  if (controller && controller.onUpdating) {
    await controller.onUpdating(objectId, materializedModel.modelArgs, session, context);
  }
  if (linkToParent) {
    linkToParent(materializedModel.modelArgs);
  }

  const result = await Model.findByIdAndUpdate(
    objectId, materializedModel.modelArgs, { new: true },
  ).session(session);

  if (!result) {
    throw new SimfinityError(`${gqltype.name} ${objectId} is not valid`, 'NOT_VALID_ID', 404);
  }

  if (materializedModel.collectionFields) {
    await iterateOnCollectionFields(materializedModel, gqltype, objectId, session, context);
  }

  if (controller && controller.onUpdated) {
    await controller.onUpdated(result, session, context);
  }

  return result;
};

const onStateChanged = async (Model, gqltype, controller, args, session, actionField, context) => {
  const storedModel = await Model.findById(args.id).session(session);
  if (!storedModel) {
    throw new SimfinityError(`${gqltype.name} ${args.id} is not valid`, 'NOT_VALID_ID', 404);
  }
  if (storedModel.state === actionField.from.name) {
    if (actionField.action) {
      await actionField.action(args, session);
    }

    args.state = actionField.to.name;
    let result = await onUpdateSubject(Model, gqltype, controller, args, session, null, context);
    result = result.toObject();
    result.state = actionField.to.value;
    return result;
  }
  throw new SimfinityError(`Action is not allowed from state ${storedModel.state}`, 'BAD_REQUEST', 400);
};

const onSaveObject = async (Model, gqltype, controller, args, session, linkToParent, context) => {
  const materializedModel = await materializeModel(args, gqltype, linkToParent, 'CREATE', session);
  if (typesDict.types[gqltype.name].stateMachine) {
    materializedModel.modelArgs.state = typesDict.types[gqltype.name]
      .stateMachine.initialState.name;
  }

  const newObject = new Model(materializedModel.modelArgs);
  newObject.$session(session);

  if (controller && controller.onSaving) {
    await controller.onSaving(newObject, args, session, context);
  }
  if (linkToParent) {
    linkToParent(newObject);
  }

  let result = await newObject.save();
  result = result.toObject();

  if (materializedModel.collectionFields) {
    await iterateOnCollectionFields(materializedModel, gqltype, newObject._id, session, context);
  }

  if (controller && controller.onSaved) {
    await controller.onSaved(result, args, session, context);
  }
  if (typesDict.types[gqltype.name].stateMachine) {
    result.state = typesDict.types[gqltype.name].stateMachine.initialState.value;
  }
  return result;
};

export const saveObject = async (typeName, args, session, context) => {
  const type = typesDict.types[typeName];
  return withTransaction(session,
    (mySession) => onSaveObject(type.model, type.gqltype, type.controller, args, mySession, null, context),
    type.model.db);
};

const executeOperation = (Model, gqltype, controller, args, operation, actionField, session, context) => withTransaction(
  session,
  async (mySession) => {
    switch (operation) {
      case operations.SAVE:
        return onSaveObject(Model, gqltype, controller, args, mySession, null, context);
      case operations.UPDATE:
        return onUpdateSubject(Model, gqltype, controller, args, mySession, null, context);
      case operations.DELETE:
        return onDelete(Model, controller, args, mySession, context);
      case operations.STATE_CHANGED:
        return onStateChanged(Model, gqltype, controller, args, mySession, actionField, context);
      default:
        return null;
    }
  },
  Model.db,
);

const executeItemFunction = async (gqltype, collectionField, objectId, session,
  collectionFieldsList, operationType, context) => {
  const argTypes = gqltype.getFields();
  const collectionGQLType = argTypes[collectionField].type.ofType;
  const { connectionField } = argTypes[collectionField].extensions.relation;
  const type = operationType === operations.UPDATE
    ? typesDictForUpdate.types[collectionGQLType.name] : typesDict.types[collectionGQLType.name];
  const linkToParent = (item) => {
    item[connectionField] = objectId;
    if (item.$unset) delete item.$unset[connectionField];
    if (item.$set) delete item.$set[connectionField];
  };

  for (const element of collectionFieldsList) {
    const args = operationType === operations.DELETE ? { id: element } : { input: element };
    await executeMiddleware({ type, args, operation: operationType, context });

    if (operationType === operations.UPDATE || operationType === operations.DELETE) {
      const id = operationType === operations.DELETE ? args.id : args.input.id;
      const child = await type.model.findById(id).session(session).lean();
      if (!child) {
        throw new SimfinityError(`${collectionGQLType.name} ${id} is not valid`, 'NOT_VALID_ID', 404);
      }
      if (String(child[connectionField]) !== String(objectId)) {
        throw new SimfinityError('Child does not belong to this parent', 'FORBIDDEN', 403);
      }
    }

    switch (operationType) {
      case operations.SAVE:
        await onSaveObject(type.model, collectionGQLType, type.controller,
          args.input, session, linkToParent, context);
        break;
      case operations.UPDATE:
        await onUpdateSubject(type.model, collectionGQLType, type.controller,
          args.input, session, linkToParent, context);
        break;
      case operations.DELETE:
        await onDelete(type.model, type.controller, args.id, session, context);
    }
  }
};

const shouldNotBeIncludedInSchema = (includedTypes,
  type) => includedTypes && !includedTypes.includes(type);

const executeMiddleware = async (context) => {
  const buildNext = (middlewaresParam) => {
    if (!middlewaresParam) {
      return async () => {};
    }
    return async () => {
      const middleware = middlewaresParam[0];
      if (middleware) {
        await middleware(context, buildNext(middlewaresParam.slice(1)));
      }
    };
  };

  await buildNext(middlewares)();
};

const executeScope = async (params) => {
  const { type, args, operation, context } = params;

  if (!type || !type.gqltype || !type.gqltype.extensions) {
    return null;
  }

  const extensions = type.gqltype.extensions;
  if (!extensions.scope || !extensions.scope[operation]) {
    return null;
  }

  const scopeFunction = extensions.scope[operation];
  if (typeof scopeFunction !== 'function') {
    return null;
  }

  return scopeFunction({ type, args, operation, context });
};

const resolveById = async (type, args, context, requiredId) => {
  await executeMiddleware({ type, args, operation: 'get_by_id', context });
  if (!type.gqltype.extensions?.scope?.get_by_id) {
    return requiredId
      ? type.model.findOne({ $and: [{ _id: requiredId }, { _id: args.id }] })
      : type.model.findById(args.id);
  }

  const queryArgs = { id: { operator: 'EQ', value: args.id } };
  await executeScope({ type, args: queryArgs, operation: 'get_by_id', context });
  const aggregateClauses = await buildQuery(queryArgs, type.gqltype);
  if (requiredId) {
    aggregateClauses.unshift({ $match: { _id: type.model.schema.path('_id').cast(requiredId) } });
  }
  if (aggregateClauses.length === 0) {
    return type.model.findOne({ _id: args.id });
  }
  const results = await type.model.aggregate(aggregateClauses);
  return results[0] || null;
};

const buildMutation = (name, includedMutationTypes, includedCustomMutations) => {
  const rootQueryArgs = {};
  rootQueryArgs.name = name;
  rootQueryArgs.fields = {};

  buildPendingInputTypes(waitingInputType);

  for (const type of Object.values(typesDict.types)) {
    if (!shouldNotBeIncludedInSchema(includedMutationTypes, type.gqltype)) {
      if (type.endpoint) {
        const argsObject = { input: { type: new GraphQLNonNull(type.inputType) } };

        rootQueryArgs.fields[`add${type.simpleEntityEndpointName}`] = {
          type: type.gqltype,
          description: 'add',
          args: argsObject,
          async resolve(parent, args, context) {
            const params = {
              type,
              args,
              operation: operations.SAVE,
              context,
            };

            await executeMiddleware(params);
            return executeOperation(type.model, type.gqltype, type.controller,
              args.input, operations.SAVE, null, null, context);
          },
        };
        rootQueryArgs.fields[`delete${type.simpleEntityEndpointName}`] = {
          type: type.gqltype,
          description: 'delete',
          args: { id: { type: new GraphQLNonNull(GraphQLID) } },
          async resolve(parent, args, context) {
            const params = {
              type,
              args,
              operation: operations.DELETE,
              context,
            };

            await executeMiddleware(params);
            return executeOperation(type.model, type.gqltype, type.controller,
              args.id, operations.DELETE, null, null, context);
          },
        };
      }
    }
  }

  for (const type of Object.values(typesDictForUpdate.types)) {
    if (!shouldNotBeIncludedInSchema(includedMutationTypes, type.gqltype)) {
      if (type.endpoint) {
        const argsObject = { input: { type: new GraphQLNonNull(type.inputType) } };
        rootQueryArgs.fields[`update${type.simpleEntityEndpointName}`] = {
          type: type.gqltype,
          description: 'update',
          args: argsObject,
          async resolve(parent, args, context) {
            const params = {
              type,
              args,
              operation: operations.UPDATE,
              context,
            };

            await executeMiddleware(params);
            return executeOperation(type.model, type.gqltype, type.controller,
              args.input, operations.UPDATE, null, null, context);
          },
        };
        if (type.stateMachine) {
          for (const [actionName, actionField] of Object.entries(type.stateMachine.actions)) {
            if ({}.hasOwnProperty.call(type.stateMachine.actions, actionName)) {
              rootQueryArgs.fields[`${actionName}_${type.simpleEntityEndpointName}`] = {
                type: type.gqltype,
                description: actionField.description,
                args: argsObject,
                async resolve(parent, args, context) {
                  const params = {
                    type,
                    args,
                    operation: operations.STATE_CHANGED,
                    actionName,
                    actionField,
                    context,
                  };

                  await executeMiddleware(params);
                  return executeOperation(type.model, type.gqltype, type.controller,
                    args.input, operations.STATE_CHANGED, actionField, null, context);
                },
              };
            }
          }
        }
      }
    }
  }

  for (const [entry, registeredMutation] of Object.entries(registeredMutations)) {
    if (!shouldNotBeIncludedInSchema(includedCustomMutations, entry)) {
      const argsObject = registeredMutation.inputModel
        ? { input: { type: new GraphQLNonNull(registeredMutation.inputModel) } } : null;
      rootQueryArgs.fields[entry] = {
        type: registeredMutation.outputModel,
        description: registeredMutation.description,
        args: argsObject,
        async resolve(parent, args, context) {
          const params = {
            args,
            operation: operations.CUSTOM_MUTATION,
            entry,
            context,
          };
          await executeMiddleware(params);
          return executeRegisteredMutation(args.input, registeredMutation.callback, context);
        },
      };
    }
  }

  return new GraphQLObjectType(rootQueryArgs);
};

const listItemMatchesScalar = (listType, target) => {
  const ofType = listType.ofType;
  return ofType === target
    || (isCustomValidatedScalar(ofType) && ofType.baseScalarType === target);
};

const withUnique = (fieldEntry, mongoType) => (fieldEntry.extensions && fieldEntry.extensions.unique
  ? { type: mongoType, unique: true }
  : mongoType);

const generateSchemaDefinition = (gqlType) => {
  const argTypes = gqlType.getFields();
  const schemaArg = {};

  for (const [fieldEntryName, fieldEntry] of Object.entries(argTypes)) {
    const { type } = fieldEntry;

    if (matchesScalar(type, GraphQLID)) {
      schemaArg[fieldEntryName] = mongoose.Schema.Types.ObjectId;
    } else if (matchesScalar(type, GraphQLString)
      || type instanceof GraphQLEnumType
      || isNonNullOfType(type, GraphQLEnumType)) {
      schemaArg[fieldEntryName] = withUnique(fieldEntry, String);
    } else if (matchesScalar(type, GraphQLInt) || matchesScalar(type, GraphQLFloat)) {
      schemaArg[fieldEntryName] = withUnique(fieldEntry, Number);
    } else if (matchesScalar(type, GraphQLBoolean)) {
      schemaArg[fieldEntryName] = Boolean;
    } else if (type instanceof GraphQLObjectType || isNonNullOfType(type, GraphQLObjectType)) {
      if (fieldEntry.extensions && fieldEntry.extensions.relation) {
        if (!fieldEntry.extensions.relation.embedded) {
          const key = fieldEntry.extensions.relation.connectionField || fieldEntry.name;
          schemaArg[key] = mongoose.Schema.Types.ObjectId;
        } else {
          const entryType = unwrapNonNull(type);
          if (entryType === gqlType) {
            throw new Error('A type cannot have a field of its same type and embedded');
          }
          schemaArg[fieldEntryName] = generateSchemaDefinition(entryType);
        }
      }
    } else if (type instanceof GraphQLList) {
      if (fieldEntry.extensions && fieldEntry.extensions.relation) {
        if (fieldEntry.extensions.relation.embedded) {
          if (type.ofType === gqlType) {
            throw new Error('A type cannot have a field of its same type and embedded');
          }
          schemaArg[fieldEntryName] = [generateSchemaDefinition(type.ofType)];
        }
      } else if (listItemMatchesScalar(type, GraphQLString) || type.ofType instanceof GraphQLEnumType) {
        schemaArg[fieldEntryName] = [String];
      } else if (listItemMatchesScalar(type, GraphQLBoolean)) {
        schemaArg[fieldEntryName] = [Boolean];
      } else if (listItemMatchesScalar(type, GraphQLInt) || listItemMatchesScalar(type, GraphQLFloat)) {
        schemaArg[fieldEntryName] = [Number];
      } else if (isGraphQLisoDate(getEffectiveTypeName(type.ofType))) {
        schemaArg[fieldEntryName] = [Date];
      }
    } else if (isGraphQLisoDate(getEffectiveTypeName(unwrapNonNull(type)))) {
      schemaArg[fieldEntryName] = Date;
    }
  }

  return schemaArg;
};

const findObjectIdFields = (schemaDefinition, parentPath = '') => {
  const objectIdFields = [];

  for (const [fieldName, fieldDefinition] of Object.entries(schemaDefinition)) {
    const currentPath = parentPath ? `${parentPath}.${fieldName}` : fieldName;

    if (fieldDefinition === mongoose.Schema.Types.ObjectId) {
      objectIdFields.push(currentPath);
    } else if (typeof fieldDefinition === 'object' && fieldDefinition !== null) {
      if (Array.isArray(fieldDefinition)) {
        const arrayElement = fieldDefinition[0];
        if (typeof arrayElement === 'object' && arrayElement !== null) {
          objectIdFields.push(...findObjectIdFields(arrayElement, currentPath));
        }
      } else if (fieldDefinition.type === mongoose.Schema.Types.ObjectId) {
        objectIdFields.push(currentPath);
      } else if (!fieldDefinition.type) {
        objectIdFields.push(...findObjectIdFields(fieldDefinition, currentPath));
      }
    }
  }

  return objectIdFields;
};

const createSchemaWithIndexes = (schemaDefinition) => {
  const schema = new mongoose.Schema(schemaDefinition);
  findObjectIdFields(schemaDefinition).forEach((fieldPath) => {
    schema.index({ [fieldPath]: 1 });
  });
  return schema;
};

const generateModel = (gqlType, onModelCreated, { createCollection = true } = {}) => {
  const schemaDefinition = generateSchemaDefinition(gqlType);
  const schema = createSchemaWithIndexes(schemaDefinition);
  const model = mongoose.model(gqlType.name, schema, gqlType.name);
  if (onModelCreated) {
    onModelCreated(model);
  }
  if (createCollection && !preventCollectionCreation) {
    model.createCollection();
  }
  return model;
};

const filterError = (message, code = 'INVALID_FILTER_VALUE') => new SimfinityError(message, code, 400);

const queryNamedType = (type) => {
  let result = type;
  while (result instanceof GraphQLList || result instanceof GraphQLNonNull) result = result.ofType;
  return result;
};

// Resolve GraphQL paths and storage paths together; supplied models own ID casting.
const resolveQueryPath = (gqltype, path) => {
  assertValidFilterPath(path);
  const parts = path.split('.');
  let currentType = gqltype;
  let currentModel = typesDict.types[gqltype.name]?.model;
  let mongoPath = '';
  let schemaPath = '';
  const aggregateClauses = {};

  for (const [index, part] of parts.entries()) {
    const field = Object.hasOwn(currentType.getFields(), part) ? currentType.getFields()[part] : null;
    if (!field) throw filterError(`Unknown query field: ${path}`, 'INVALID_FILTER_FIELD');
    const fieldType = queryNamedType(field.type);
    const relation = field.extensions?.relation;
    if (fieldType instanceof GraphQLObjectType) {
      if (index === parts.length - 1) throw filterError(`Query path must end in a scalar field: ${path}`, 'INVALID_FILTER_PATH');
      if (!relation || relation.embedded) {
        mongoPath = mongoPath ? `${mongoPath}.${part}` : part;
        schemaPath = schemaPath ? `${schemaPath}.${part}` : part;
      } else {
        const relatedModel = typesDict.types[fieldType.name]?.model;
        if (!relatedModel) throw filterError(`Related model is not available for ${path}`, 'INVALID_FILTER_PATH');
        const isList = unwrapNonNull(field.type) instanceof GraphQLList;
        const connField = relation.connectionField || part;
        const localLeaf = isList ? '_id' : connField;
        const alias = mongoPath ? `${mongoPath.replaceAll('.', '_')}_${part}` : part;
        aggregateClauses[alias] = buildRelationLookup({
          collectionName: relatedModel.collection.collectionName,
          localField: mongoPath ? `${mongoPath}.${localLeaf}` : localLeaf,
          foreignField: isList ? connField : '_id',
          alias,
        });
        mongoPath = alias;
        schemaPath = '';
        currentModel = relatedModel;
      }
      currentType = fieldType;
    } else {
      if (index !== parts.length - 1) throw filterError(`Cannot traverse scalar field in ${path}`, 'INVALID_FILTER_PATH');
      const leaf = part === 'id' ? '_id' : part;
      const storagePath = schemaPath ? `${schemaPath}.${leaf}` : leaf;
      return {
        mongoPath: mongoPath ? `${mongoPath}.${leaf}` : leaf,
        schemaType: currentModel?.schema?.path(storagePath),
        fieldType,
        storesStateName: part === 'state' && !!typesDict.types[currentType.name]?.stateMachine,
        aggregateClauses,
      };
    }
  }
  throw filterError(`Invalid query path: ${path}`, 'INVALID_FILTER_PATH');
};

const castFilterValue = (value, resolved) => {
  if (value === null) return null;
  if (value === undefined || Array.isArray(value)
    || (typeof value === 'object' && !(value instanceof Date) && !(value instanceof mongoose.Types.ObjectId))) {
    throw filterError(`Expected a scalar value for ${resolved.mongoPath}`);
  }
  try {
    const schemaType = resolved.schemaType?.caster || resolved.schemaType;
    const scalar = resolved.fieldType;
    if (scalar === GraphQLID && typeof value !== 'string' && typeof value !== 'number'
      && !(value instanceof mongoose.Types.ObjectId)) throw new Error('Invalid ID');
    // ID representation is a persistence concern, including String/Number/custom _id schemas.
    if (schemaType && (scalar === GraphQLID || resolved.mongoPath.endsWith('._id') || resolved.mongoPath === '_id'
      || schemaType.instance === 'ObjectId')) return schemaType.cast(value);
    const typeName = getEffectiveTypeName(scalar);
    if (isGraphQLisoDate(typeName)) {
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(date.getTime())) throw new Error('Invalid date');
      return date;
    }
    if (scalar === GraphQLID && !schemaType) return new mongoose.Types.ObjectId(value);
    if (scalar instanceof GraphQLEnumType) {
      const entry = scalar.getValues().find((item) => item.name === value)
        || scalar.getValues().find((item) => item.value === value);
      if (!entry) throw new Error('Invalid enum value');
      const stored = resolved.storesStateName ? entry.name : entry.value;
      return schemaType ? schemaType.cast(stored) : stored;
    }
    const parsed = (scalar.baseScalarType || scalar).parseValue(value);
    return schemaType ? schemaType.cast(parsed) : parsed;
  } catch {
    throw filterError(`Invalid value for ${resolved.mongoPath}`);
  }
};

const buildMatchesClause = (resolved, operator, value) => {
  const op = operator ?? 'EQ';
  if (!QLOperator.getValues().some((entry) => entry.value === op)) {
    throw filterError(`Unsupported filter operator: ${op}`, 'INVALID_FILTER_OPERATOR');
  }
  const collectionOperator = op === 'IN' || op === 'NIN' || op === 'BTW';
  if (collectionOperator && (!Array.isArray(value) || (op === 'BTW' && value.length !== 2))) {
    throw filterError(`${op} requires ${op === 'BTW' ? 'exactly two values' : 'an array value'}`);
  }
  if (op === 'LIKE' && (typeof value !== 'string' || getEffectiveTypeName(resolved.fieldType) !== 'String')) {
    throw filterError('LIKE requires a string field and string value');
  }
  if (value === null && op !== 'EQ' && op !== 'NE') throw filterError(`${op} does not accept null`);
  const cast = (item) => {
    if (item === null && collectionOperator) throw filterError(`${op} does not accept null elements`);
    return castFilterValue(item, resolved);
  };
  const coerced = collectionOperator ? value.map(cast) : op === 'LIKE' ? value : cast(value);
  if (op === 'EQ') return { [resolved.mongoPath]: coerced };
  if (op === 'IN' || op === 'NIN') return { [resolved.mongoPath]: { [op === 'IN' ? '$in' : '$nin']: coerced } };
  return { [resolved.mongoPath]: OP_TO_MONGO[op](coerced) };
};

const buildQueryTerms = async (filterField, qlField, fieldName, gqltype) => {
  const aggregateClauses = {};
  const matchesClauses = [];
  if (!qlField) throw filterError(`Unknown filter field: ${fieldName}`, 'INVALID_FILTER_FIELD');
  if (filterField == null) return { aggregateClauses, matchesClauses };
  if (typeof filterField !== 'object' || Array.isArray(filterField)) throw filterError(`Invalid filter for ${fieldName}`);
  const isObject = queryNamedType(qlField.type) instanceof GraphQLObjectType;
  if (isObject && (!Array.isArray(filterField.terms) || filterField.terms.length === 0)) {
    throw filterError(`Filter on ${fieldName} requires non-empty terms`, 'MISSING_FILTER_PATH');
  }
  const terms = isObject ? filterField.terms : [filterField];
  for (const term of terms) {
    if (!term || typeof term !== 'object' || Array.isArray(term)) throw filterError(`Invalid term for ${fieldName}`);
    if (isObject) assertValidFilterPath(term.path);
    const resolved = resolveQueryPath(gqltype, isObject ? `${fieldName}.${term.path}` : fieldName);
    Object.assign(aggregateClauses, resolved.aggregateClauses);
    matchesClauses.push(buildMatchesClause(resolved, term.operator, term.value));
  }
  return { aggregateClauses, matchesClauses };
};

const MAX_FILTER_GROUP_DEPTH = 5;

const validateLogicalLists = (group) => {
  if (!group || typeof group !== 'object' || Array.isArray(group)) throw filterError('Expected a filter group object');
  for (const key of ['AND', 'OR', 'conditions']) {
    if (group[key] != null && !Array.isArray(group[key])) throw filterError(`${key} requires an array`);
  }
};

const buildFilterGroupMatch = async (filterGroup, gqltype, aggregateClauses, aggregationsIncluded, depth = 0) => {
  if (depth > MAX_FILTER_GROUP_DEPTH) {
    throw new SimfinityError('Filter nesting too deep', 'FILTER_DEPTH_EXCEEDED', 400);
  }
  validateLogicalLists(filterGroup);

  const parts = [];
  const fields = gqltype.getFields();

  if (filterGroup.conditions?.length > 0) {
    for (const rawCondition of filterGroup.conditions) {
      if (!rawCondition || typeof rawCondition.field !== 'string') throw filterError('Filter conditions require a field');
      const condition = normalizeFilterCondition(rawCondition);
      const qlField = fields[condition.field];
      if (!qlField) {
        throw new SimfinityError(`Unknown filter field: ${condition.field}`, 'INVALID_FILTER_FIELD', 400);
      }

      const fieldType = unwrapListAndNonNull(qlField.type);
      const isObject = fieldType instanceof GraphQLObjectType || isNonNullOfType(fieldType, GraphQLObjectType);

      let filterInput;
      if (isObject) {
        if (!condition.path) {
          throw new SimfinityError(`Filter on object field "${condition.field}" requires a path`, 'MISSING_FILTER_PATH', 400);
        }
        filterInput = {
          terms: [{ path: condition.path, operator: condition.operator, value: condition.value }],
        };
      } else {
        if (condition.path != null && condition.path !== '') throw filterError(`Cannot traverse scalar field ${condition.field}`, 'INVALID_FILTER_PATH');
        filterInput = { operator: condition.operator, value: condition.value };
      }

      const result = await buildQueryTerms(filterInput, qlField, condition.field, gqltype);
      if (!result) continue;

      for (const [prop, aggregate] of Object.entries(result.aggregateClauses)) {
        if (!aggregationsIncluded[prop]) {
          aggregateClauses.push(aggregate.lookup, aggregate.unwind);
          aggregationsIncluded[prop] = true;
        }
      }
      for (const matchClause of Object.values(result.matchesClauses)) {
        for (const [matchKey, match] of Object.entries(matchClause)) {
          parts.push({ [matchKey]: match });
        }
      }
    }
  }

  if (filterGroup.AND?.length > 0) {
    for (const subGroup of filterGroup.AND) {
      const subMatch = await buildFilterGroupMatch(subGroup, gqltype, aggregateClauses, aggregationsIncluded, depth + 1);
      if (subMatch) parts.push(subMatch);
    }
  }

  if (filterGroup.OR?.length > 0) {
    const orParts = [];
    for (const subGroup of filterGroup.OR) {
      const subMatch = await buildFilterGroupMatch(subGroup, gqltype, aggregateClauses, aggregationsIncluded, depth + 1);
      if (subMatch) orParts.push(subMatch);
    }
    if (orParts.length === 1) {
      parts.push(orParts[0]);
    } else if (orParts.length > 1) {
      parts.push({ $or: orParts });
    }
  }

  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return { $and: parts };
};

const RESERVED_QUERY_KEYS = new Set(['pagination', 'sort', 'AND', 'OR', 'aggregation']);

const collectFiltersAndLookups = async (input, gqltype, aggregateClauses, aggregationsIncluded) => {
  validateLogicalLists(input);
  const flatMatchConditions = {};
  const repeatedConditions = [];
  let hasFlat = false;
  const fields = gqltype.getFields();

  for (const [key, filterField] of Object.entries(input)) {
    if (RESERVED_QUERY_KEYS.has(key)) continue;
    const qlField = fields[key];
    const result = await buildQueryTerms(filterField, qlField, key, gqltype);
    if (!result) continue;

    for (const [prop, aggregate] of Object.entries(result.aggregateClauses)) {
      if (!aggregationsIncluded[prop]) {
        aggregateClauses.push(aggregate.lookup, aggregate.unwind);
        aggregationsIncluded[prop] = true;
      }
    }
    for (const matchClause of Object.values(result.matchesClauses)) {
      for (const [matchKey, match] of Object.entries(matchClause)) {
        if (Object.hasOwn(flatMatchConditions, matchKey)) {
          repeatedConditions.push({ [matchKey]: match });
        } else {
          flatMatchConditions[matchKey] = match;
        }
        hasFlat = true;
      }
    }
  }

  const topLevelAndParts = [];
  if (hasFlat) topLevelAndParts.push(flatMatchConditions);
  topLevelAndParts.push(...repeatedConditions);

  if (input.AND?.length > 0) {
    for (const group of input.AND) {
      const groupMatch = await buildFilterGroupMatch(group, gqltype, aggregateClauses, aggregationsIncluded);
      if (groupMatch) topLevelAndParts.push(groupMatch);
    }
  }

  if (input.OR?.length > 0) {
    const orParts = [];
    for (const group of input.OR) {
      const groupMatch = await buildFilterGroupMatch(group, gqltype, aggregateClauses, aggregationsIncluded);
      if (groupMatch) orParts.push(groupMatch);
    }
    if (orParts.length === 1) {
      topLevelAndParts.push(orParts[0]);
    } else if (orParts.length > 1) {
      topLevelAndParts.push({ $or: orParts });
    }
  }

  if (topLevelAndParts.length === 1) return { $match: topLevelAndParts[0] };
  if (topLevelAndParts.length > 1) return { $match: { $and: topLevelAndParts } };
  return null;
};

const validateSortTerms = (sort) => {
  if (!Array.isArray(sort?.terms) || sort.terms.length === 0) throw filterError('Sort requires non-empty terms', 'INVALID_SORT');
  for (const term of sort.terms) {
    if (!term || !['ASC', 'DESC'].includes(term.order)) throw filterError('Sort order must be ASC or DESC', 'INVALID_SORT');
    assertValidFilterPath(term.field);
  }
  return sort.terms;
};

const buildSortClause = (sortTerms, gqltype, aggregateClauses, aggregationsIncluded) => {
  const sortExpressions = {};
  for (const sort of sortTerms) {
    const resolved = resolveQueryPath(gqltype, sort.field);
    for (const [alias, aggregate] of Object.entries(resolved.aggregateClauses)) {
      if (!aggregationsIncluded[alias]) {
        aggregateClauses.push(aggregate.lookup, aggregate.unwind);
        aggregationsIncluded[alias] = true;
      }
    }
    sortExpressions[resolved.mongoPath] = sort.order === 'ASC' ? 1 : -1;
  }
  return { $sort: sortExpressions };
};

let queryMaxPageSize = 1000;

export const configureQueryLimits = (options = {}) => {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) {
    throw new SimfinityError('Query limit options must be a plain object', 'INVALID_QUERY_LIMITS', 400);
  }
  const { maxPageSize = 1000 } = options;
  if (!Number.isSafeInteger(maxPageSize) || maxPageSize < 1) {
    throw new SimfinityError('maxPageSize must be a positive safe integer', 'INVALID_QUERY_LIMITS', 400);
  }
  queryMaxPageSize = maxPageSize;
};

const paginationStages = (pagination, withDefault) => {
  if (pagination == null) return withDefault ? [{ $skip: 0 }, { $limit: Math.min(100, queryMaxPageSize) }] : [];
  const { page, size } = pagination;
  const skip = size * (page - 1);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(size) || size < 1
    || size > queryMaxPageSize || !Number.isSafeInteger(skip)) {
    throw new SimfinityError(`Pagination requires positive safe integers and size <= ${queryMaxPageSize}`, 'INVALID_PAGINATION', 400);
  }
  return [{ $skip: skip }, { $limit: size }];
};

const buildQuery = async (input, gqltype, isCount) => {
  const aggregateClauses = [];
  const aggregationsIncluded = {};
  const paging = paginationStages(input.pagination, true);

  const matchStage = await collectFiltersAndLookups(input, gqltype, aggregateClauses, aggregationsIncluded);
  if (matchStage) aggregateClauses.push(matchStage);

  if (isCount) {
    aggregateClauses.push({ $count: 'size' });
    return aggregateClauses;
  }

  if (input.sort) {
    aggregateClauses.push(buildSortClause(validateSortTerms(input.sort), gqltype, aggregateClauses, aggregationsIncluded));
  }

  aggregateClauses.push(...paging);

  return aggregateClauses;
};

const buildFieldPath = (gqltype, fieldPath) => {
  assertValidFilterPath(fieldPath);
  const pathParts = fieldPath.split('.');
  const lookupPairs = [];
  let currentPath = '';
  let currentGQLType = gqltype;

  for (const part of pathParts) {
    const field = currentGQLType.getFields()[part];
    if (!field) {
      throw new Error(`Field ${part} not found in type ${currentGQLType.name}`);
    }

    const fieldType = unwrapListAndNonNull(field.type);
    const relation = field.extensions?.relation;

    if (fieldType instanceof GraphQLObjectType && relation && !relation.embedded) {
      const { collectionName } = typesDict.types[fieldType.name].model.collection;
      const connField = relation.connectionField || part;
      const lookupAlias = currentPath ? `${currentPath}_${part}` : part;
      const localField = currentPath ? `${currentPath}.${connField}` : connField;

      lookupPairs.push(buildRelationLookup({
        collectionName, localField, foreignField: '_id', alias: lookupAlias,
      }));

      currentPath = lookupAlias;
      currentGQLType = fieldType;
    } else if (fieldType instanceof GraphQLObjectType && relation?.embedded) {
      currentPath = currentPath ? `${currentPath}.${part}` : part;
      currentGQLType = fieldType;
    } else {
      const leaf = part === 'id' ? '_id' : part;
      currentPath = currentPath ? `${currentPath}.${leaf}` : leaf;
    }
  }

  return { mongoPath: currentPath, lookupPairs };
};

const appendLookupPairs = (aggregateClauses, aggregationsIncluded, lookupPairs) => {
  for (const { lookup, unwind } of lookupPairs) {
    const alias = lookup.$lookup.as;
    if (!aggregationsIncluded[alias]) {
      aggregateClauses.push(lookup, unwind);
      aggregationsIncluded[alias] = true;
    }
  }
};

const buildAggregationQuery = async (input, gqltype, aggregationExpression) => {
  const aggregateClauses = [];
  const aggregationsIncluded = {};
  const paging = paginationStages(input.pagination, false);

  const matchStage = await collectFiltersAndLookups(input, gqltype, aggregateClauses, aggregationsIncluded);
  if (matchStage) aggregateClauses.push(matchStage);

  const { groupId, facts } = aggregationExpression;
  const groupIdPath = buildFieldPath(gqltype, groupId);
  appendLookupPairs(aggregateClauses, aggregationsIncluded, groupIdPath.lookupPairs);

  const groupStage = { $group: { _id: `$${groupIdPath.mongoPath}` } };

  facts.forEach((fact) => {
    const factPath = buildFieldPath(gqltype, fact.path);
    appendLookupPairs(aggregateClauses, aggregationsIncluded, factPath.lookupPairs);

    const builder = AGG_OP_TO_MONGO[fact.operation];
    if (!builder) {
      throw new Error(`Unknown aggregation operation: ${fact.operation}`);
    }
    groupStage.$group[fact.factName] = builder(factPath.mongoPath);
  });

  aggregateClauses.push(groupStage);

  aggregateClauses.push({
    $project: {
      _id: 0,
      groupId: '$_id',
      facts: Object.fromEntries(facts.map((fact) => [fact.factName, `$${fact.factName}`])),
    },
  });

  const sortTerms = input.sort ? validateSortTerms(input.sort) : null;
  if (sortTerms) {
    const factNames = facts.map((fact) => fact.factName);
    const sortObject = {};
    sortTerms.forEach((sortTerm) => {
      const field = sortTerm.field || 'groupId';
      const sortFieldPath = factNames.includes(field) ? `facts.${field}` : 'groupId';
      sortObject[sortFieldPath] = sortTerm.order === 'ASC' ? 1 : -1;
    });
    aggregateClauses.push({ $sort: sortObject });
  } else {
    aggregateClauses.push({ $sort: { groupId: 1 } });
  }

  aggregateClauses.push(...paging);

  return aggregateClauses;
};

const buildRootQuery = (name, includedTypes) => {
  const rootQueryArgs = {};
  rootQueryArgs.name = name;
  rootQueryArgs.fields = {};

  for (const type of Object.values(typesDict.types)) {
    if (!shouldNotBeIncludedInSchema(includedTypes, type.gqltype)) {
      const wasAddedAsNoEnpointType = !type.simpleEntityEndpointName;
      if (!wasAddedAsNoEnpointType) {
        if (type.gqltype.getFields().id && !type.gqltype.getFields().id.resolve) {
          type.gqltype.getFields().id.resolve = (parent) => parent._id;
        }

        rootQueryArgs.fields[type.simpleEntityEndpointName] = {
          type: type.gqltype,
          args: { id: { type: GraphQLID } },
          async resolve(parent, args, context) {
            return resolveById(type, args, context);
          },
        };

        const argTypes = type.gqltype.getFields();

        const argsObject = createArgsForQuery(argTypes);

        rootQueryArgs.fields[type.listEntitiesEndpointName] = {
          type: new GraphQLList(type.gqltype),
          args: argsObject,
          async resolve(parent, args, context) {
            const params = {
              type,
              args,
              operation: 'find',
              context,
            };
            await executeMiddleware(params);
            await executeScope(params);
            const aggregateClauses = await buildQuery(args, type.gqltype);
            const wantsCount = !!(args.pagination && args.pagination.count);

            const dataPromise = aggregateClauses.length === 0
              ? type.model.find({})
              : type.model.aggregate(aggregateClauses);
            const countPromise = wantsCount
              ? buildQuery(args, type.gqltype, true).then((p) => type.model.aggregate(p))
              : null;

            const [result, resultCount] = await Promise.all([dataPromise, countPromise]);
            if (wantsCount) {
              context.count = resultCount[0] ? resultCount[0].size : 0;
            }
            return result;
          },
        };

        const aggregateArgsObject = { ...argsObject };
        aggregateArgsObject.aggregation = {
          type: new GraphQLNonNull(QLTypeAggregationExpression),
        };

        rootQueryArgs.fields[`${type.listEntitiesEndpointName}_aggregate`] = {
          type: new GraphQLList(QLTypeAggregationResult),
          args: aggregateArgsObject,
          async resolve(parent, args, context) {
            const params = {
              type,
              args,
              operation: 'aggregate',
              context,
            };
            await executeMiddleware(params);
            await executeScope(params);
            const aggregateClauses = await buildAggregationQuery(args, type.gqltype, args.aggregation);
            const result = await type.model.aggregate(aggregateClauses);
            return result;
          },
        };
      }
    }
  }

  return new GraphQLObjectType(rootQueryArgs);
};

export const createSchema = (includedQueryTypes, includedMutationTypes, includedCustomMutations) => {
  Object.values(typesDict.types).forEach((typeInfo) => {
    if (typeInfo.gqltype && !typeInfo.model) {
      if (typeInfo.endpoint) {
        typeInfo.model = generateModel(typeInfo.gqltype, typeInfo.onModelCreated);
      } else if (typeInfo.needsModel) {
        typeInfo.model = generateModel(typeInfo.gqltype, null, { createCollection: false });
      }
    }
  });

  Object.keys(typesDict.types).forEach((typeName) => {
    if (typesDictForUpdate.types[typeName]) {
      typesDictForUpdate.types[typeName].model = typesDict.types[typeName].model;
    }
  });

  Object.values(typesDict.types).forEach((typeInfo) => {
    if (typeInfo.gqltype) {
      autoGenerateResolvers(typeInfo.gqltype);
    }
  });

  return new GraphQLSchema({
    query: buildRootQuery('RootQueryType', includedQueryTypes),
    mutation: buildMutation('Mutation', includedMutationTypes, includedCustomMutations),
  });
};

export const getModel = (gqltype) => typesDict.types[gqltype.name].model;

export const getType = (typeName) => {
  if (typeof typeName === 'string') {
    return typesDict.types[typeName]?.gqltype;
  }
  if (typeName && typeName.name) {
    return typesDict.types[typeName.name]?.gqltype;
  }
  return null;
};

export const registerMutation = (name, description, inputModel, outputModel, callback) => {
  registeredMutations[name] = {
    description,
    inputModel,
    outputModel,
    callback,
  };
};

const autoGenerateResolvers = (gqltype) => {
  const fields = gqltype.getFields();

  for (const [fieldName, fieldEntry] of Object.entries(fields)) {
    if (fieldEntry.resolve) continue;
    const relation = fieldEntry.extensions?.relation;
    if (!relation || relation.embedded) continue;

    if (fieldEntry.type instanceof GraphQLList) {
      const relatedType = fieldEntry.type.ofType;
      const connectionField = relation.connectionField || fieldName;
      const relatedTypeInfo = typesDict.types[relatedType.name];
      const argsObject = createArgsForQuery(relatedTypeInfo.gqltype.getFields());
      delete argsObject[connectionField];

      fieldEntry.args = formatArgs(Object.entries(argsObject));
      fieldEntry.resolve = async (parent, args, context) => {
        if (!relatedTypeInfo || !relatedTypeInfo.model) {
          throw new Error(`Related type ${relatedType.name} not found or not connected. Make sure it's connected with simfinity.connect() or simfinity.addNoEndpointType().`);
        }
        const params = { type: relatedTypeInfo, args, operation: 'find', context };
        await executeMiddleware(params);
        await executeScope(params);
        const aggregateClauses = await buildQuery(args, relatedTypeInfo.gqltype);
        const parentId = parent.id || parent._id;
        const connectionPath = relatedTypeInfo.model.schema.path(connectionField);
        aggregateClauses.unshift({
          $match: { [connectionField]: connectionPath ? connectionPath.cast(parentId) : parentId },
        });
        return relatedTypeInfo.model.aggregate(aggregateClauses);
      };
    } else if (fieldEntry.type instanceof GraphQLObjectType
      || (fieldEntry.type instanceof GraphQLNonNull && fieldEntry.type.ofType instanceof GraphQLObjectType)) {
      const relatedType = unwrapNonNull(fieldEntry.type);
      const connectionField = relation.connectionField || fieldName;

      fieldEntry.resolve = async (parent, args, context) => {
        const relatedTypeInfo = typesDict.types[relatedType.name];
        if (!relatedTypeInfo || !relatedTypeInfo.model) {
          throw new Error(`Related type ${relatedType.name} not found or not connected. Make sure it's connected with simfinity.connect() or simfinity.addNoEndpointType().`);
        }
        const relatedId = parent[connectionField] || parent[fieldName];
        const id = relatedId?._id || relatedId;
        return id ? resolveById(relatedTypeInfo, { id: String(id) }, context, id) : null;
      };
    }
  }
};

export const connect = (model, gqltype, simpleEntityEndpointName,
  listEntitiesEndpointName, controller, onModelCreated, stateMachine) => {
  waitingInputType[gqltype.name] = {
    model,
    gqltype,
  };
  typesDict.types[gqltype.name] = {
    model,
    gqltype,
    simpleEntityEndpointName,
    listEntitiesEndpointName,
    endpoint: true,
    controller,
    stateMachine,
    onModelCreated,
  };

  typesDictForUpdate.types[gqltype.name] = { ...typesDict.types[gqltype.name] };
};

export const addNoEndpointType = (gqltype) => {
  waitingInputType[gqltype.name] = { gqltype };

  const fields = gqltype.getFields();
  let needsModel = false;
  for (const fieldEntry of Object.values(fields)) {
    if (fieldEntry.extensions?.relation
      && (fieldEntry.type instanceof GraphQLObjectType
        || fieldEntry.type instanceof GraphQLList
        || (fieldEntry.type instanceof GraphQLNonNull && fieldEntry.type.ofType instanceof GraphQLObjectType))) {
      needsModel = true;
      break;
    }
  }

  typesDict.types[gqltype.name] = {
    gqltype, endpoint: false, model: null, needsModel,
  };

  typesDictForUpdate.types[gqltype.name] = { ...typesDict.types[gqltype.name] };
};

export { createValidatedScalar };

export { default as validators } from './validators.js';
export { default as scalars } from './scalars.js';
export { default as plugins } from './plugins.js';
export { default as auth } from './auth/index.js';
export { default as mcp } from './mcp.js';
export {
  generateMCPTools,
  graphqlArgsToJSONSchema,
  createMCPServer,
  startStdioMCPServer,
  createHTTPMCPHandler,
} from './mcp.js';

export { buildQuery, buildFilterGroupMatch };

const createArgsForQuery = (argTypes) => {
    const argsObject = {};

    for (const [fieldEntryName, fieldEntry] of Object.entries(argTypes)) {
      argsObject[fieldEntryName] = {};

      if (fieldEntry.type instanceof GraphQLScalarType
        || isNonNullOfType(fieldEntry.type, GraphQLScalarType)
        || fieldEntry.type instanceof GraphQLEnumType
        || isNonNullOfType(fieldEntry.type, GraphQLEnumType)) {
        argsObject[fieldEntryName].type = QLFilter;
      } else if (fieldEntry.type instanceof GraphQLObjectType
        || isNonNullOfType(fieldEntry.type, GraphQLObjectType)) {
        argsObject[fieldEntryName].type = QLTypeFilterExpression;
      } else if (fieldEntry.type instanceof GraphQLList) {
        const listOfType = fieldEntry.type.ofType;
        if (listOfType instanceof GraphQLScalarType
          || isNonNullOfType(listOfType, GraphQLScalarType)
          || listOfType instanceof GraphQLEnumType
          || isNonNullOfType(listOfType, GraphQLEnumType)) {
          argsObject[fieldEntryName].type = QLFilter;
        } else {
          argsObject[fieldEntryName].type = QLTypeFilterExpression;
        }
      }
    }

    argsObject.pagination = {};
    argsObject.pagination.type = QLPagination;

    argsObject.sort = {};
    argsObject.sort.type = QLSortExpression;

    argsObject.AND = {};
    argsObject.AND.type = new GraphQLList(QLFilterGroup);

    argsObject.OR = {};
    argsObject.OR.type = new GraphQLList(QLFilterGroup);

    return argsObject;
};

function formatArgs(argsArray) {
  const graphqlArgs = [];
  for (const [key, value] of argsArray) {
    const item = {
      name: key,
      type: value.type,
    };
    graphqlArgs.push(item);
  }
  return graphqlArgs;
}
