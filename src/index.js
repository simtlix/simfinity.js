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

const fieldTypeDefinitions = __Field._fields;

const fixedFieldsWithExtensions = () => {
  const originalFields = fieldTypeDefinitions();
  originalFields.extensions = {
    type: FieldExtensionsType,
    name: 'extensions',
    resolve: (obj) => obj.extensions,
    args: [],
    isDeprecated: false,
  };
  return originalFields;
};

__Field._fields = fixedFieldsWithExtensions;

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

const coerceDateValue = (fieldType, holder, key) => {
  const typeName = getEffectiveTypeName(unwrapNonNull(fieldType));
  if (!isGraphQLisoDate(typeName)) return;
  const raw = holder[key];
  if (Array.isArray(raw)) {
    holder[key] = raw.map((v) => v && new Date(v));
  } else {
    holder[key] = raw && new Date(raw);
  }
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
    Object.entries(originalFields).filter(([fieldName]) => fieldName !== fieldToExclude),
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
      const doesEstateFieldExistButIsManagedByStateMachine = !!(fieldEntryName === 'state' && hasStateMachine);

      if (!doesEstateFieldExistButIsManagedByStateMachine) {
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
            const listInputTypeForAdd = graphQLListInputType(typesDict, fieldEntry, fieldEntryName, gqltype.name + 'A', fieldEntry.extensions?.relation?.connectionField);
            const listInputTypeForUpdate = graphQLListInputType(typesDictForUpdate, fieldEntry, fieldEntryName, gqltype.name +'U', fieldEntry.extensions?.relation?.connectionField);
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
    fields: fieldsArgs,
  };

  const inputTypeBodyForUpdate = {
    name: `${gqltype.name}InputForUpdate`,
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
  const stillWaitingInputType = {};
  let isThereAtLeastOneWaiting = false;

  Object.entries(waitingForInputType).forEach(([key, value]) => {
    const { gqltype } = value;

    if (!typesDict.types[gqltype.name].inputType) {
      const buildInputTypeResult = buildInputType(gqltype);

      if (buildInputTypeResult && buildInputTypeResult.inputTypeBody
        && buildInputTypeResult.inputTypeBodyForUpdate) {
        typesDict.types[gqltype.name].inputType = buildInputTypeResult.inputTypeBody;
        typesDictForUpdate.types[gqltype.name].inputType = buildInputTypeResult
          .inputTypeBodyForUpdate;
      } else {
        stillWaitingInputType[key] = value;
        isThereAtLeastOneWaiting = true;
      }
    }
  });

  if (isThereAtLeastOneWaiting) {
    buildPendingInputTypes(stillWaitingInputType);
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
          modelArgs[fieldEntry.name] = new mongoose.Types
            .ObjectId(args[fieldEntryName].id);
          console.warn(`Configuration issue: Field ${fieldEntryName} does not define extensions.relation`);
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

const withTransaction = async (session, body) => {
  const ownsSession = !session;
  const mySession = session || await mongoose.startSession();
  try {
    for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
      await mySession.startTransaction();
      try {
        const result = await body(mySession);
        await mySession.commitTransaction();
        return result;
      } catch (error) {
        await mySession.abortTransaction();
        const isTransient = error.errorLabels?.includes('TransientTransactionError');
        if (isTransient && attempt < MAX_TRANSIENT_RETRIES) {
          continue;
        }
        throw error;
      }
    }
    throw new SimfinityError('Transaction exceeded retry limit', 'TRANSACTION_RETRY_EXCEEDED', 500);
  } finally {
    if (ownsSession) {
      mySession.endSession();
    }
  }
};

const executeRegisteredMutation = (args, callback, session) => withTransaction(
  session,
  (mySession) => callback(args, mySession),
);

const iterateonCollectionFields = async (materializedModel, gqltype, objectId, session, context) => {
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

  const result = Model.findByIdAndUpdate(
    objectId, materializedModel.modelArgs, { new: true },
  ).session(session);

  if (materializedModel.collectionFields) {
    await iterateonCollectionFields(materializedModel, gqltype, objectId, session, context);
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

  let result = await newObject.save();
  result = result.toObject();

  if (materializedModel.collectionFields) {
    await iterateonCollectionFields(materializedModel, gqltype, newObject._id, session, context);
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
  return onSaveObject(type.model, type.gqltype, type.controller, args, session, null, context);
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
);

const executeItemFunction = async (gqltype, collectionField, objectId, session,
  collectionFieldsList, operationType, context) => {
  const argTypes = gqltype.getFields();
  const collectionGQLType = argTypes[collectionField].type.ofType;
  const { connectionField } = argTypes[collectionField].extensions.relation;

  let operationFunction = async () => { };

  switch (operationType) {
    case operations.SAVE:
      operationFunction = async (collectionItem) => {
        await onSaveObject(typesDict.types[collectionGQLType.name].model, collectionGQLType,
          typesDict.types[collectionGQLType.name].controller, collectionItem, session, (item) => {
            item[connectionField] = objectId;
          }, context);
      };
      break;
    case operations.UPDATE:
      operationFunction = async (collectionItem) => {
        await onUpdateSubject(typesDict.types[collectionGQLType.name].model, collectionGQLType,
          typesDict.types[collectionGQLType.name].controller, collectionItem, session, (item) => {
            item[connectionField] = objectId;
          }, context);
      };
      break;
    case operations.DELETE:
      operationFunction = async (collectionItem) => {
        await onDelete(typesDict.types[collectionGQLType.name].model,
          typesDict.types[collectionGQLType.name].controller, collectionItem, session, context);
      };
  }

  for (const element of collectionFieldsList) {
    await operationFunction(element);
  }
};

const shouldNotBeIncludedInSchema = (includedTypes,
  type) => includedTypes && !includedTypes.includes(type);

const excecuteMiddleware = async (context) => {
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

            await excecuteMiddleware(params);
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

            await excecuteMiddleware(params);
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

            await excecuteMiddleware(params);
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

                  await excecuteMiddleware(params);
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
          await excecuteMiddleware(params);
          return executeRegisteredMutation(args.input, registeredMutation.callback);
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

const coerceIdArray = (value) => value.map((element) => {
  if (element === null || element === undefined) {
    throw new SimfinityError('ID value cannot be null in collection filter', 'INVALID_FILTER_VALUE', 400);
  }
  return new mongoose.Types.ObjectId(element);
});

const buildMatchesClause = (fieldname, operator, value) => {
  const isIdField = fieldname.endsWith('_id');
  const op = operator || 'EQ';

  if (op === 'EQ') {
    return { [fieldname]: isIdField ? new mongoose.Types.ObjectId(value) : value };
  }
  if (op === 'IN' || op === 'NIN') {
    if (!Array.isArray(value)) {
      throw new SimfinityError(`${op} requires an array value for ${fieldname}`, 'INVALID_FILTER_VALUE', 400);
    }
    const coerced = isIdField ? coerceIdArray(value) : value;
    return { [fieldname]: { [op === 'IN' ? '$in' : '$nin']: coerced } };
  }
  const builder = OP_TO_MONGO[op];
  return builder ? { [fieldname]: builder(value) } : {};
};

const topLevelRelationLookup = (qlField, fieldType, fieldName) => {
  const { collectionName } = typesDict.types[fieldType.name].model.collection;
  const connField = qlField.extensions?.relation?.connectionField || fieldName;
  const isList = qlField.type instanceof GraphQLList;
  return buildRelationLookup({
    collectionName,
    localField: isList ? '_id' : connField,
    foreignField: isList ? connField : '_id',
    alias: fieldName,
  });
};

const nestedRelationLookup = (pathField, pathFieldType, currentPath, aliasPath, pathFieldName) => {
  const { collectionName } = typesDict.types[pathFieldType.name].model.collection;
  const connField = pathField.extensions?.relation?.connectionField || pathFieldName;
  const isList = pathField.type instanceof GraphQLList;
  return buildRelationLookup({
    collectionName,
    localField: isList ? `${currentPath}._id` : `${currentPath}.${connField}`,
    foreignField: isList ? connField : '_id',
    alias: aliasPath,
  });
};

const buildAggregationsForSort = (filterField, qlField, fieldName) => {
  const aggregateClauses = {};
  const fieldType = unwrapListAndNonNull(qlField.type);

  if (!(fieldType instanceof GraphQLObjectType || isNonNullOfType(fieldType, GraphQLObjectType))) {
    return aggregateClauses;
  }

  const resolvedFieldType = unwrapNonNull(fieldType);

  filterField.terms.forEach((term) => {
    if (qlField.extensions?.relation && !qlField.extensions.relation.embedded
      && !aggregateClauses[fieldName]) {
      aggregateClauses[fieldName] = topLevelRelationLookup(qlField, resolvedFieldType, fieldName);
    }

    let currentGQLPathFieldType = unwrapListAndNonNull(qlField.type);
    let aliasPath = fieldName;
    let embeddedPath = '';

    term.path.split('.').forEach((pathFieldName) => {
      const pathField = currentGQLPathFieldType.getFields()[pathFieldName];
      if (pathField.type instanceof GraphQLObjectType
        || pathField.type instanceof GraphQLList
        || isNonNullOfType(pathField.type, GraphQLObjectType)) {
        const pathFieldType = unwrapListAndNonNull(pathField.type);
        currentGQLPathFieldType = pathFieldType;

        if (pathField.extensions?.relation && !pathField.extensions.relation.embedded) {
          const currentPath = aliasPath + (embeddedPath !== '' ? `.${embeddedPath}` : '');
          aliasPath += (embeddedPath !== '' ? `_${embeddedPath}_` : '_') + pathFieldName;
          embeddedPath = '';

          if (!aggregateClauses[aliasPath]) {
            aggregateClauses[aliasPath] = nestedRelationLookup(
              pathField, pathFieldType, currentPath, aliasPath, pathFieldName,
            );
          }
        } else {
          embeddedPath = embeddedPath === '' ? pathFieldName : `${embeddedPath}.${pathFieldName}`;
        }
      }
    });
  });
  return aggregateClauses;
};

const buildQueryTerms = async (filterField, qlField, fieldName) => {
  const aggregateClauses = {};
  const matchesClauses = {};
  const fieldType = unwrapListAndNonNull(qlField.type);

  if (fieldType instanceof GraphQLScalarType
    || isNonNullOfType(fieldType, GraphQLScalarType)
    || fieldType instanceof GraphQLEnumType
    || isNonNullOfType(fieldType, GraphQLEnumType)) {
    coerceDateValue(fieldType, filterField, 'value');
    matchesClauses[fieldName] = buildMatchesClause(fieldName === 'id' ? '_id' : fieldName, filterField.operator, filterField.value);
    return { aggregateClauses, matchesClauses };
  }

  if (!(fieldType instanceof GraphQLObjectType || isNonNullOfType(fieldType, GraphQLObjectType))) {
    return { aggregateClauses, matchesClauses };
  }

  const resolvedFieldType = unwrapNonNull(fieldType);

  filterField.terms.forEach((term) => {
    if (qlField.extensions?.relation && !qlField.extensions.relation.embedded
      && !aggregateClauses[fieldName]) {
      aggregateClauses[fieldName] = topLevelRelationLookup(qlField, resolvedFieldType, fieldName);
    }

    if (term.path.indexOf('.') < 0) {
      const { type: leafType } = resolvedFieldType.getFields()[term.path];
      coerceDateValue(leafType, term, 'value');
      const leafName = resolvedFieldType.getFields()[term.path].name === 'id' ? '_id' : term.path;
      matchesClauses[fieldName] = buildMatchesClause(`${fieldName}.${leafName}`, term.operator, term.value);
      return;
    }

    let currentGQLPathFieldType = unwrapListAndNonNull(qlField.type);
    let aliasPath = fieldName;
    let embeddedPath = '';

    term.path.split('.').forEach((pathFieldName) => {
      const pathField = currentGQLPathFieldType.getFields()[pathFieldName];
      if (pathField.type instanceof GraphQLScalarType
        || isNonNullOfType(pathField.type, GraphQLScalarType)) {
        coerceDateValue(pathField.type, term, 'value');
        const leafName = pathFieldName === 'id' ? '_id' : pathFieldName;
        const mongoPath = aliasPath + (embeddedPath !== '' ? `.${embeddedPath}.` : '.') + leafName;
        matchesClauses[`${aliasPath}_${pathFieldName}`] = buildMatchesClause(mongoPath, term.operator, term.value);
        embeddedPath = '';
      } else if (pathField.type instanceof GraphQLObjectType
        || pathField.type instanceof GraphQLList
        || isNonNullOfType(pathField.type, GraphQLObjectType)) {
        const pathFieldType = unwrapListAndNonNull(pathField.type);
        currentGQLPathFieldType = pathFieldType;

        if (pathField.extensions?.relation && !pathField.extensions.relation.embedded) {
          const currentPath = aliasPath + (embeddedPath !== '' ? `.${embeddedPath}` : '');
          aliasPath += (embeddedPath !== '' ? `_${embeddedPath}_` : '_') + pathFieldName;
          embeddedPath = '';

          if (!aggregateClauses[aliasPath]) {
            aggregateClauses[aliasPath] = nestedRelationLookup(
              pathField, pathFieldType, currentPath, aliasPath, pathFieldName,
            );
          }
        } else {
          embeddedPath = embeddedPath === '' ? pathFieldName : `${embeddedPath}.${pathFieldName}`;
        }
      }
    });
  });

  return { aggregateClauses, matchesClauses };
};

const MAX_FILTER_GROUP_DEPTH = 5;

const buildFilterGroupMatch = async (filterGroup, gqltype, aggregateClauses, aggregationsIncluded, depth = 0) => {
  if (depth > MAX_FILTER_GROUP_DEPTH) {
    throw new SimfinityError('Filter nesting too deep', 'FILTER_DEPTH_EXCEEDED', 400);
  }

  const parts = [];
  const fields = gqltype.getFields();

  if (filterGroup.conditions?.length > 0) {
    for (const condition of filterGroup.conditions) {
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
        filterInput = { operator: condition.operator, value: condition.value };
      }

      const result = await buildQueryTerms(filterInput, qlField, condition.field);
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
  const flatMatchConditions = {};
  let hasFlat = false;
  const fields = gqltype.getFields();

  for (const [key, filterField] of Object.entries(input)) {
    if (RESERVED_QUERY_KEYS.has(key)) continue;
    const qlField = fields[key];
    const result = await buildQueryTerms(filterField, qlField, key);
    if (!result) continue;

    for (const [prop, aggregate] of Object.entries(result.aggregateClauses)) {
      aggregateClauses.push(aggregate.lookup, aggregate.unwind);
      aggregationsIncluded[prop] = true;
    }
    for (const matchClause of Object.values(result.matchesClauses)) {
      for (const [matchKey, match] of Object.entries(matchClause)) {
        flatMatchConditions[matchKey] = match;
        hasFlat = true;
      }
    }
  }

  const topLevelAndParts = [];
  if (hasFlat) topLevelAndParts.push(flatMatchConditions);

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

const buildSortClause = (sortTerms, gqltype, aggregateClauses, aggregationsIncluded) => {
  const sortExpressions = {};
  const fields = gqltype.getFields();

  sortTerms.forEach((sort) => {
    let fixedSortField = sort.field;
    if (sort.field.indexOf('.') >= 0) {
      const sortParts = sort.field.split('.');
      fixedSortField = sortParts[0];
      for (let i = 1; i < sortParts.length - 1; i++) {
        fixedSortField += `_${sortParts[i]}`;
      }
      fixedSortField += `.${sortParts[sortParts.length - 1]}`;
      const qlField = fields[sortParts[0]];
      const path = sort.field.slice(sort.field.indexOf('.') + 1);
      const sortAggregations = buildAggregationsForSort({ terms: [{ path }] }, qlField, sortParts[0]);
      for (const [prop, aggregate] of Object.entries(sortAggregations)) {
        if (!aggregationsIncluded[prop]) {
          aggregateClauses.push(aggregate.lookup, aggregate.unwind);
        }
      }
    }
    sortExpressions[fixedSortField] = sort.order === 'ASC' ? 1 : -1;
  });

  return { $sort: sortExpressions };
};

const buildQuery = async (input, gqltype, isCount) => {
  const aggregateClauses = [];
  const aggregationsIncluded = {};

  const matchStage = await collectFiltersAndLookups(input, gqltype, aggregateClauses, aggregationsIncluded);
  if (matchStage) aggregateClauses.push(matchStage);

  if (isCount) {
    aggregateClauses.push({ $count: 'size' });
    return aggregateClauses;
  }

  if (input.sort) {
    aggregateClauses.push(buildSortClause(input.sort.terms, gqltype, aggregateClauses, aggregationsIncluded));
  }

  let skipClause = { $skip: 0 };
  let limitClause = { $limit: 100 };
  if (input.pagination?.page && input.pagination?.size) {
    skipClause = { $skip: input.pagination.size * (input.pagination.page - 1) };
    limitClause = { $limit: input.pagination.size };
  }
  aggregateClauses.push(skipClause, limitClause);

  return aggregateClauses;
};

const buildFieldPath = (gqltype, fieldPath) => {
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

  const sortTerms = input.sort?.terms?.length > 0 ? input.sort.terms : null;
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

  if (input.pagination?.page && input.pagination?.size) {
    const skip = input.pagination.size * (input.pagination.page - 1);
    aggregateClauses.push({ $skip: skip }, { $limit: input.pagination.size });
  }

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
            const params = {
              type, args, operation: 'get_by_id', context,
            };
            await excecuteMiddleware(params);

            const hasScope = type.gqltype.extensions?.scope?.get_by_id;
            if (!hasScope) {
              return type.model.findById(args.id);
            }

            const queryArgs = { id: { operator: 'EQ', value: args.id } };
            await executeScope({
              type, args: queryArgs, operation: 'get_by_id', context,
            });
            const aggregateClauses = await buildQuery(queryArgs, type.gqltype);
            if (aggregateClauses.length === 0) {
              return type.model.findOne({ _id: args.id });
            }
            const results = await type.model.aggregate(aggregateClauses);
            return results[0] || null;
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
            await excecuteMiddleware(params);
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
            await excecuteMiddleware(params);
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
      fieldEntry.resolve = async (parent, args) => {
        if (!relatedTypeInfo || !relatedTypeInfo.model) {
          throw new Error(`Related type ${relatedType.name} not found or not connected. Make sure it's connected with simfinity.connect() or simfinity.addNoEndpointType().`);
        }
        args[connectionField] = {
          terms: [{ path: 'id', operator: 'EQ', value: parent.id || parent._id }],
        };
        const aggregateClauses = await buildQuery(args, relatedTypeInfo.gqltype);
        return relatedTypeInfo.model.aggregate(aggregateClauses);
      };
    } else if (fieldEntry.type instanceof GraphQLObjectType
      || (fieldEntry.type instanceof GraphQLNonNull && fieldEntry.type.ofType instanceof GraphQLObjectType)) {
      const relatedType = unwrapNonNull(fieldEntry.type);
      const connectionField = relation.connectionField || fieldName;

      fieldEntry.resolve = async (parent) => {
        const relatedTypeInfo = typesDict.types[relatedType.name];
        if (!relatedTypeInfo || !relatedTypeInfo.model) {
          throw new Error(`Related type ${relatedType.name} not found or not connected. Make sure it's connected with simfinity.connect() or simfinity.addNoEndpointType().`);
        }
        const relatedId = parent[connectionField] || parent[fieldName];
        return relatedId ? relatedTypeInfo.model.findById(relatedId) : null;
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