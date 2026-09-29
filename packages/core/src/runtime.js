import { configureQueryLimits, getQueryMaxPageSize } from './query-limits.js';
import {
  GraphQLObjectType, GraphQLString, GraphQLID, GraphQLSchema, GraphQLList,
  GraphQLNonNull, GraphQLInputObjectType, GraphQLScalarType,
  GraphQLInt, GraphQLEnumType, GraphQLBoolean, Kind,
} from 'graphql';

import SimfinityError from './errors/simfinity.error.js';
import InternalServerError from './errors/internal-server.error.js';
import QLOperator from './const/QLOperator.js';
import QLValue from './const/QLValue.js';
import QLSort from './const/QLSort.js';
import { collectQueryPathEntries, collectQueryPaths, walkQueryPath } from './query-plan.js';
import './introspection.js';

// Resolvers Simfinity generates. Any other resolver on a registered type when its schema is first
// created is application code, such as a masking resolver, recorded once per type so later
// in-place wrapping (for example by the auth plugin) does not change the snapshot.
const generatedResolvers = new WeakSet();
const applicationResolvedFields = new WeakMap();
const markGenerated = (resolve) => {
  generatedResolvers.add(resolve);
  return resolve;
};
const listApplicationResolvedFields = (gqltype) => new Set(Object.entries(gqltype.getFields())
  .filter(([, field]) => field.resolve && !generatedResolvers.has(field.resolve))
  .map(([fieldName]) => fieldName));
const hasApplicationResolver = (gqltype, fieldName) => (
  applicationResolvedFields.get(gqltype) || listApplicationResolvedFields(gqltype)
).has(fieldName);
const forbiddenPath = (message) => new SimfinityError(message, 'FORBIDDEN_FILTER_PATH', 403);
const SCOPE_IGNORED_ARGS = new Set(['sort', 'pagination', 'aggregation']);

// Moves a joined type's scope group below the relation path that entered it.
const prefixScopeGroup = (group, prefix) => {
  if (!group || typeof group !== 'object' || Array.isArray(group)) {
    throw new SimfinityError('Expected a scope filter group object', 'INVALID_FILTER_VALUE', 400);
  }
  const prefixed = {};
  if (group.conditions != null) {
    prefixed.conditions = [].concat(group.conditions).map((condition) => ({
      field: `${prefix}.${condition?.path != null && condition.path !== '' ? `${condition.field}.${condition.path}` : condition?.field}`,
      operator: condition?.operator,
      value: condition?.value,
    }));
  }
  if (group.AND != null) prefixed.AND = [].concat(group.AND).map((item) => prefixScopeGroup(item, prefix));
  if (group.OR != null) prefixed.OR = [].concat(group.OR).map((item) => prefixScopeGroup(item, prefix));
  return prefixed;
};

const prefixScopeArgs = (scopeArgs, prefix, typeName) => {
  const conditions = [];
  const groups = [];
  for (const [name, value] of Object.entries(scopeArgs)) {
    if (value == null || SCOPE_IGNORED_ARGS.has(name)) continue;
    if (name === 'AND') groups.push(...[].concat(value).map((group) => prefixScopeGroup(group, prefix)));
    else if (name === 'OR') {
      const branches = [].concat(value);
      if (branches.length) groups.push({ OR: branches.map((group) => prefixScopeGroup(group, prefix)) });
    } else if (Object.hasOwn(value, 'terms')) {
      if (!Array.isArray(value.terms) || !value.terms.length) {
        throw new SimfinityError(`Scope filter ${typeName}.${name} requires non-empty terms`, 'MISSING_FILTER_PATH', 400);
      }
      for (const term of value.terms) {
        conditions.push({ field: `${prefix}.${name}.${term?.path}`, operator: term?.operator, value: term?.value });
      }
    } else conditions.push({ field: `${prefix}.${name}`, operator: value.operator, value: value.value });
  }
  return conditions.length ? [{ conditions }, ...groups] : groups;
};

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

export const buildErrorFormatter = (callback) => {
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

export { SimfinityError, InternalServerError };

const cloneInput = (value, type) => {
  if (value === null || value === undefined || !type) return value;
  if (type instanceof GraphQLNonNull) return cloneInput(value, type.ofType);
  if (type instanceof GraphQLList) {
    return Array.isArray(value)
      ? value.map((item) => cloneInput(item, type.ofType))
      : value;
  }
  if (type instanceof GraphQLInputObjectType) {
    const fields = type.getFields();
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      fields[key] ? cloneInput(item, fields[key].type) : item,
    ]));
  }
  if (type instanceof GraphQLScalarType && value instanceof Date) {
    return new Date(value.getTime());
  }
  return value;
};

export const createRuntime = (adapter) => {
  if (!adapter) {
    throw new SimfinityError('A database adapter is required', 'ADAPTER_REQUIRED', 500);
  }

  const stateValue = adapter.stateValue || ((state) => state.name);
  const typesDict = { types: {} };
  const waitingInputType = {};
  const typesDictForUpdate = { types: {} };
  const registeredMutations = {};
  const middlewares = [];

  const operations = {
    SAVE: 'save',
    UPDATE: 'update',
    DELETE: 'delete',
    STATE_CHANGED: 'state_changed',
    CUSTOM_MUTATION: 'custom_mutation',
  };

  const use = (middleware) => {
    middlewares.push(middleware);
  };

  let preventCollectionCreation = false;

  const preventCreatingCollection = (prevent) => {
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

const unwrapNonNull = (type) => (type instanceof GraphQLNonNull ? type.ofType : type);

const unwrapListAndNonNull = (type) => {
  let unwrapped = type;
  while (unwrapped instanceof GraphQLList || unwrapped instanceof GraphQLNonNull) {
    unwrapped = unwrapped.ofType;
  }
  return unwrapped;
};

const getListShape = (type) => {
  const outerNonNull = type instanceof GraphQLNonNull;
  const listType = unwrapNonNull(type);
  if (!(listType instanceof GraphQLList)) return null;
  const itemNonNull = listType.ofType instanceof GraphQLNonNull;
  return {
    outerNonNull,
    itemNonNull,
    itemType: unwrapNonNull(listType.ofType),
  };
};

const getFieldStorageName = (fieldName, field) => {
  const relation = field.extensions?.relation;
  return relation && !relation.embedded && !getListShape(field.type)
    ? relation.connectionField || fieldName
    : fieldName;
};

const normalizeConnectionField = (childType, declaredFieldName) => {
  if (!declaredFieldName) {
    return { declaredFieldName, graphqlFieldName: null, storageFieldName: null };
  }
  const childFields = childType.getFields();
  let graphqlFieldName = childFields[declaredFieldName] ? declaredFieldName : null;
  if (!graphqlFieldName) {
    const aliasedField = Object.entries(childFields).find(([fieldName, field]) => (
      getFieldStorageName(fieldName, field) === declaredFieldName
    ));
    graphqlFieldName = aliasedField?.[0] || null;
  }
  return {
    declaredFieldName,
    graphqlFieldName,
    storageFieldName: graphqlFieldName
      ? getFieldStorageName(graphqlFieldName, childFields[graphqlFieldName])
      : declaredFieldName,
  };
};

const wrapListInputType = (itemType, listShape, preserveOuterNonNull) => {
  const wrappedItem = listShape.itemNonNull ? new GraphQLNonNull(itemType) : itemType;
  const listType = new GraphQLList(wrappedItem);
  return preserveOuterNonNull && listShape.outerNonNull
    ? new GraphQLNonNull(listType)
    : listType;
};

/**
 * Creates a new GraphQLInputObjectType with a field excluded.
 * @param {string} inputNamePrefix - The prefix for the input type name.
 * @param {GraphQLInputObjectType} originalType - The original input type.
 * @param {string} fieldToExclude - The name of the field to exclude.
 * @returns {GraphQLInputObjectType} A new input type without the specified field.
 */
const createTypeWithExcludedField = (inputNamePrefix, originalType, fieldToExclude,
  connectionFieldName = fieldToExclude) => {
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
    name: `${inputNamePrefix}${originalType.name}For${connectionFieldName.charAt(0).toUpperCase() + connectionFieldName.slice(1)}`,
    fields: newFields,
  });
};

const createOneToManyInputType = (inputNamePrefix, fieldEntryName,
  inputType, updateInputType, connection, itemNonNull = false) => {
  let inputTypeForAdd = inputType;

  if (connection.declaredFieldName) {
    inputTypeForAdd = createTypeWithExcludedField(
      inputNamePrefix,
      inputType,
      connection.graphqlFieldName || connection.declaredFieldName,
      connection.declaredFieldName,
    );
  }

  return new GraphQLInputObjectType({
    name: `OneToMany${inputNamePrefix}${fieldEntryName}`,
    fields: () => ({
      added: {
        type: new GraphQLList(itemNonNull
          ? new GraphQLNonNull(inputTypeForAdd) : inputTypeForAdd),
      },
      updated: {
        type: new GraphQLList(itemNonNull
          ? new GraphQLNonNull(updateInputType) : updateInputType),
      },
      deleted: {
        type: new GraphQLList(itemNonNull ? new GraphQLNonNull(GraphQLID) : GraphQLID),
      },
    }),
  });
};

const graphQLListInputType = (dict, fieldEntry, fieldEntryName,
  inputNamePrefix, connectionField, preserveOuterNonNull) => {
  const listShape = getListShape(fieldEntry.type);
  if (!listShape) return null;
  const { itemType } = listShape;

  if (itemType instanceof GraphQLObjectType && dict.types[itemType.name].inputType) {
    if (!fieldEntry.extensions || !fieldEntry.extensions.relation
      || !fieldEntry.extensions.relation.embedded) {
      const oneToMany = createOneToManyInputType(inputNamePrefix, fieldEntryName,
        typesDict.types[itemType.name].inputType,
        typesDictForUpdate.types[itemType.name].inputType,
        normalizeConnectionField(itemType, connectionField),
        listShape.itemNonNull);
      return preserveOuterNonNull && listShape.outerNonNull
        ? new GraphQLNonNull(oneToMany)
        : oneToMany;
    }
    if (fieldEntry.extensions && fieldEntry.extensions.relation
      && fieldEntry.extensions.relation.embedded) {
      return wrapListInputType(
        dict.types[itemType.name].inputType,
        listShape,
        preserveOuterNonNull,
      );
    }
  } else if (itemType instanceof GraphQLScalarType || itemType instanceof GraphQLEnumType) {
    return wrapListInputType(itemType, listShape, preserveOuterNonNull);
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
          if (fieldEntryName === 'id' && unwrapNonNull(fieldEntry.type) === GraphQLID) {
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
        } else if (getListShape(fieldEntry.type)) {
          const listShape = getListShape(fieldEntry.type);
          if (listShape.itemType === gqltype) {
            selfReferenceCollections[fieldEntryName] = fieldEntry;
          } else {
            const listInputTypeForAdd = graphQLListInputType(typesDict, fieldEntry,
              fieldEntryName, `${gqltype.name}A`,
              fieldEntry.extensions?.relation?.connectionField, true);
            const listInputTypeForUpdate = graphQLListInputType(typesDictForUpdate, fieldEntry,
              fieldEntryName, `${gqltype.name}U`,
              fieldEntry.extensions?.relation?.connectionField, false);
            if (listInputTypeForAdd && listInputTypeForUpdate) {
              fieldArg.type = listInputTypeForAdd;
              fieldArgForUpdate.type = listInputTypeForUpdate;
            } else {
              return null;
            }
          }
        }
        if (fieldArg.type && fieldEntry.type instanceof GraphQLNonNull
          && !(fieldArg.type instanceof GraphQLNonNull)) fieldArg.type = new GraphQLNonNull(fieldArg.type);
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
      const fieldEntry = selfReferenceCollections[fieldEntryName];
      const listShape = getListShape(fieldEntry.type);
      const oneToMany = createOneToManyInputType('A', fieldEntryName,
        inputTypeForAdd, inputTypeForUpdate,
        normalizeConnectionField(
          gqltype,
          fieldEntry.extensions?.relation?.connectionField,
        ), listShape.itemNonNull);
      inputTypeForAddFields[fieldEntryName] = {
        type: listShape.outerNonNull ? new GraphQLNonNull(oneToMany) : oneToMany,
        name: fieldEntryName,
      };
    }
  });

  inputTypeForAdd._fields = () => inputTypeForAddFields;

  const inputTypeForUpdateFields = inputTypeForUpdate._fields();

  Object.keys(selfReferenceCollections).forEach((fieldEntryName) => {
    if (Object.prototype.hasOwnProperty.call(selfReferenceCollections, fieldEntryName)) {
      const fieldEntry = selfReferenceCollections[fieldEntryName];
      const listShape = getListShape(fieldEntry.type);
      inputTypeForUpdateFields[fieldEntryName] = {
        type: createOneToManyInputType('U', fieldEntryName,
          inputTypeForAdd, inputTypeForUpdate,
          normalizeConnectionField(
            gqltype,
            fieldEntry.extensions?.relation?.connectionField,
          ), listShape.itemNonNull),
        name: fieldEntryName,
      };
    }
  });

  inputTypeForUpdate._fields = () => inputTypeForUpdateFields;

  return { inputTypeBody: inputTypeForAdd, inputTypeBodyForUpdate: inputTypeForUpdate };
};

const getInputType = (type) => typesDict.types[type.name].inputType;

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

    if (args[fieldEntryName] !== undefined && args[fieldEntryName] !== null) {
      if (fieldEntry.type instanceof GraphQLScalarType
        || fieldEntry.type instanceof GraphQLEnumType
        || isNonNullOfType(fieldEntry.type, GraphQLScalarType)
        || isNonNullOfType(fieldEntry.type, GraphQLEnumType)) {
        modelArgs[fieldEntryName] = args[fieldEntryName];
      } else if (fieldEntry.type instanceof GraphQLObjectType
        || isNonNullOfType(fieldEntry.type, GraphQLObjectType)) {
        if (fieldEntry.extensions && fieldEntry.extensions.relation) {
          if (!fieldEntry.extensions.relation.embedded) {
            const connectionField = fieldEntry.extensions.relation.connectionField || fieldEntryName;
            modelArgs[connectionField] = adapter.castId(args[fieldEntryName].id);
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
      } else if (getListShape(fieldEntry.type)) {
        const { itemType } = getListShape(fieldEntry.type);
        if (itemType instanceof GraphQLObjectType && fieldEntry.extensions
          && fieldEntry.extensions.relation) {
          if (!fieldEntry.extensions.relation.embedded) {
            collectionFields[fieldEntryName] = args[fieldEntryName];
          } else if (fieldEntry.extensions.relation.embedded) {
            const collectionEntries = [];

            for (const element of args[fieldEntryName]) {
              if (element === null) {
                collectionEntries.push(null);
              } else {
                const collectionEntry = (await materializeModel(element, itemType,
                  null, operation, session)).modelArgs;
                if (collectionEntry) collectionEntries.push(collectionEntry);
              }
            }
            modelArgs[fieldEntryName] = collectionEntries;
          }
        } else if (itemType instanceof GraphQLScalarType || itemType instanceof GraphQLEnumType) {
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

const executeRegisteredMutation = (args, callback, context, session, inputModel) => {
  const inputSnapshot = cloneInput(args, inputModel);
  return adapter.withTransaction(
    session,
    (mySession) => callback(cloneInput(inputSnapshot, inputModel), mySession, context),
  );
};

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
  const currentObject = await adapter.getById(Model, id, session, { plain: true });

  if (controller && controller.onDelete) {
    await controller.onDelete(currentObject, session, context);
  }

  return adapter.delete(Model, id, session);
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

// Update inputs relax embedded NonNull members, so check the embedded values an update writes
// against the embedded output type. Omitted lists are written as [], as on create. With `patch`,
// only nested embedded values supplied by that patch are checked; stored nested values it keeps
// are not. `id` and readOnly members are not accepted by generated inputs and remain the
// application's responsibility.
const completeEmbeddedValue = (fieldName, fieldEntry, value, patch = null) => {
  const listShape = getListShape(fieldEntry.type);
  const embeddedType = listShape ? listShape.itemType : unwrapNonNull(fieldEntry.type);
  let items = [value];
  if (listShape) items = Array.isArray(value) ? value : [];
  for (const item of items) {
    if (item === null || item === undefined) {
      if (listShape && listShape.itemNonNull) {
        throw new SimfinityError(`Required value ${fieldName}[] is missing`, 'REQUIRED_VALUE', 400);
      }
      continue;
    }
    for (const [memberName, member] of Object.entries(embeddedType.getFields())) {
      const relation = member.extensions?.relation;
      const memberList = getListShape(member.type);
      if (relation && !relation.embedded && memberList) continue;
      const storageName = getFieldStorageName(memberName, member);
      if (item[storageName] === undefined && memberList) item[storageName] = [];
      if (memberName === 'id' || member.extensions?.readOnly) continue;
      const memberValue = item[storageName];
      if (memberValue === null || memberValue === undefined) {
        if (member.type instanceof GraphQLNonNull) {
          throw new SimfinityError(`Required value ${memberName} is missing`, 'REQUIRED_VALUE', 400);
        }
      } else if (relation && relation.embedded && (!patch || Object.hasOwn(patch, storageName))) {
        completeEmbeddedValue(memberName, member, memberValue);
      }
    }
  }
};

const onUpdateSubject = async (Model, gqltype, controller, args, session, linkToParent, context) => {
  const materializedModel = await materializeModel(args, gqltype, linkToParent, 'UPDATE', session);
  const objectId = args.id;
  const argTypes = gqltype.getFields();
  const embeddedFieldNames = getEmbeddedFieldNames(gqltype);

  if (embeddedFieldNames.length > 0) {
    const projection = Object.fromEntries(embeddedFieldNames.map((name) => [name, 1]));
    const currentObject = await adapter.getById(Model, objectId, session, {
      projection,
      plain: true,
      lock: true,
    });
    if (currentObject) {
      for (const fieldEntryName of embeddedFieldNames) {
        const oldObjectData = currentObject[fieldEntryName];
        const newObjectData = materializedModel.modelArgs[fieldEntryName];
        if (newObjectData) {
          if (Array.isArray(newObjectData)) {
            materializedModel.modelArgs[fieldEntryName] = newObjectData;
            completeEmbeddedValue(fieldEntryName, argTypes[fieldEntryName], newObjectData);
          } else {
            materializedModel.modelArgs[fieldEntryName] = { ...oldObjectData, ...newObjectData };
            completeEmbeddedValue(fieldEntryName, argTypes[fieldEntryName],
              materializedModel.modelArgs[fieldEntryName], newObjectData);
          }
        }
      }
    }
  }

  for (const [fieldEntryName, fieldEntry] of Object.entries(argTypes)) {
    if (args[fieldEntryName] === null && !(fieldEntry.type instanceof GraphQLNonNull)) {
      const relation = fieldEntry.extensions?.relation;
      const storageFieldName = relation && !relation.embedded && !(unwrapNonNull(fieldEntry.type) instanceof GraphQLList)
        ? relation.connectionField || fieldEntryName
        : fieldEntryName;
      materializedModel.modelArgs.$unset = {
        ...materializedModel.modelArgs.$unset,
        [storageFieldName]: '',
      };
    }
  }

  const unset = materializedModel.modelArgs.$unset || {};
  const set = { ...materializedModel.modelArgs };
  delete set.$unset;
  const update = adapter.prepareUpdate(set, unset);

  if (controller && controller.onUpdating) {
    await controller.onUpdating(objectId, update, session, context);
  }

  if (linkToParent) linkToParent(update);
  const result = await adapter.update(Model, objectId, update, session);
  if (!result) throw new SimfinityError(`${gqltype.name} ${objectId} is not valid`, 'NOT_VALID_ID', 404);

  if (materializedModel.collectionFields) {
    await iterateOnCollectionFields(materializedModel, gqltype, objectId, session, context);
  }

  if (controller && controller.onUpdated) {
    await controller.onUpdated(result, session, context);
  }

  return result;
};

const onStateChanged = async (Model, gqltype, controller, args, session, actionField, context) => {
  const storedModel = await adapter.getById(Model, args.id, session, { lock: true });
  if (!storedModel) {
    throw new SimfinityError(`${gqltype.name} ${args.id} is not valid`, 'NOT_VALID_ID', 404);
  }
  if (storedModel.state === stateValue(actionField.from)) {
    if (actionField.action) {
      await actionField.action(args, session);
    }

    args.state = stateValue(actionField.to);
    let result = await onUpdateSubject(Model, gqltype, controller, args, session, null, context);
    result = adapter.toObject(result);
    result.state = actionField.to.value;
    return result;
  }
  throw new SimfinityError(`Action is not allowed from state ${storedModel.state}`, 'BAD_REQUEST', 400);
};

const onSaveObject = async (Model, gqltype, controller, args, session, linkToParent, context) => {
  const materializedModel = await materializeModel(args, gqltype, linkToParent, 'CREATE', session);
  if (typesDict.types[gqltype.name].stateMachine) {
    materializedModel.modelArgs.state = stateValue(
      typesDict.types[gqltype.name].stateMachine.initialState,
    );
  }

  const newObject = adapter.newRecord(Model, materializedModel.modelArgs, session);

  if (controller && controller.onSaving) {
    await controller.onSaving(newObject, args, session, context);
  }

  if (linkToParent) linkToParent(newObject);
  let result = await adapter.saveRecord(Model, newObject, session);
  result = adapter.toObject(result);

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

const saveObject = async (typeName, args, session, context) => {
  const type = typesDict.types[typeName];
  const snapshot = cloneInput(args, type.inputType);
  return adapter.withTransaction(session, (transaction) => onSaveObject(
    type.model, type.gqltype, type.controller, cloneInput(snapshot, type.inputType), transaction, null, context,
  ), type.model);
};

const executeOperation = (Model, gqltype, controller, args, operation, actionField,
  session, context, inputType) => {
  const inputSnapshot = operation === operations.DELETE ? args : cloneInput(args, inputType);
  return adapter.withTransaction(
    session,
    async (mySession) => {
      const attemptArgs = operation === operations.DELETE
        ? inputSnapshot
        : cloneInput(inputSnapshot, inputType);
      switch (operation) {
        case operations.SAVE:
          return onSaveObject(Model, gqltype, controller, attemptArgs, mySession, null, context);
        case operations.UPDATE:
          return onUpdateSubject(Model, gqltype, controller, attemptArgs, mySession, null, context);
        case operations.DELETE:
          return onDelete(Model, controller, attemptArgs, mySession, context);
        case operations.STATE_CHANGED:
          return onStateChanged(Model, gqltype, controller,
            attemptArgs, mySession, actionField, context);
        default:
          return null;
      }
    },
    Model,
  );
};

const executeItemFunction = async (gqltype, collectionField, objectId, session,
  collectionFieldsList, operationType, context) => {
  const argTypes = gqltype.getFields();
  const collectionGQLType = unwrapListAndNonNull(argTypes[collectionField].type);
  const connection = normalizeConnectionField(
    collectionGQLType,
    argTypes[collectionField].extensions.relation.connectionField,
  );

  const type = operationType === operations.UPDATE
    ? typesDictForUpdate.types[collectionGQLType.name] : typesDict.types[collectionGQLType.name];
  const linkToParent = (item) => {
    item[connection.storageFieldName] = objectId;
    if (item.$unset) delete item.$unset[connection.storageFieldName];
    if (item.$set) delete item.$set[connection.storageFieldName];
  };

  for (const element of collectionFieldsList) {
    if (element === null) continue;
    const args = operationType === operations.DELETE ? { id: element } : { input: element };
    await executeMiddleware({ type, args, operation: operationType, context });

    if (operationType === operations.UPDATE || operationType === operations.DELETE) {
      const id = operationType === operations.DELETE ? args.id : args.input.id;
      const child = await adapter.getById(type.model, id, session, { plain: true, lock: true });
      if (!child) {
        throw new SimfinityError(`${collectionGQLType.name} ${id} is not valid`, 'NOT_VALID_ID', 404);
      }
      if (String(child[connection.storageFieldName]) !== String(objectId)) {
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

// Copies AND/OR group lists with new group objects and arrays, leaving conditions and other values
// shared.
const copyFilterGroups = (groups) => (Array.isArray(groups) ? groups.map((group) => {
  if (!group || typeof group !== 'object' || Array.isArray(group)) return group;
  const copy = { ...group };
  if (Array.isArray(group.conditions)) copy.conditions = [...group.conditions];
  if (Object.hasOwn(group, 'AND')) copy.AND = copyFilterGroups(group.AND);
  if (Object.hasOwn(group, 'OR')) copy.OR = copyFilterGroups(group.OR);
  return copy;
}) : groups);

// Checks the filter, sort and aggregation paths a client supplied, before middleware and scopes
// add trusted paths. Returns the scoped relations those paths enter, keyed by path, with the
// client AND/OR groups whose conditions use each path, or `topLevel` for every other form.
// graphql-js passes the same variable values to every resolver call of a request, so the client's
// AND/OR groups are first copied onto this call's args, and joined scopes are only placed in those copies.
const inspectClientPaths = (gqltype, args, operation) => {
  for (const key of ['AND', 'OR']) {
    if (Object.hasOwn(args, key)) args[key] = copyFilterGroups(args[key]);
  }
  const joinedScopes = new Map();
  for (const { segments, group } of collectQueryPathEntries(args, operation)) {
    walkQueryPath(gqltype, segments, ({ type, fieldName, field, index }) => {
      const path = segments.slice(0, index + 1).join('.');
      const queryable = field.extensions?.queryable;
      if (queryable === false || (queryable !== true && hasApplicationResolver(type, fieldName))) {
        throw forbiddenPath(`Query path ${path} uses the non-queryable field ${type.name}.${fieldName}`);
      }
      const relation = field.extensions?.relation;
      if (!relation || relation.embedded) return;
      const target = typesDict.types[unwrapListAndNonNull(field.type).name];
      if (typeof target?.gqltype?.extensions?.scope?.find !== 'function') return;
      if (!joinedScopes.has(path)) {
        joinedScopes.set(path, {
          target,
          collection: getListShape(field.type) ? `${type.name}.${fieldName}` : null,
          topLevel: false,
          groups: new Set(),
        });
      }
      const joined = joinedScopes.get(path);
      if (group) joined.groups.add(group);
      else joined.topLevel = true;
    });
  }
  return joinedScopes;
};

// A joined scope must not repeat the rows it restricts: its paths may not cross a collection, nor
// reach a non-embedded relation inside an embedded list, which is joined once per list item.
const assertJoinedScopePaths = (groups, prefix, target) => {
  const depth = prefix.split('.').length;
  for (const segments of collectQueryPaths({ AND: groups })) {
    let inList = false;
    walkQueryPath(target.gqltype, segments.slice(depth), ({ type, fieldName, field }) => {
      const relation = field.extensions?.relation;
      const list = !!getListShape(field.type);
      if (relation && !relation.embedded && (list || inList)) {
        throw forbiddenPath(`Query path ${prefix} enters ${target.gqltype.name}, whose find scope filters through `
          + `${list ? 'the collection' : 'the relation'} ${type.name}.${fieldName}${list ? '' : ' inside a list'}`);
      }
      inList ||= list;
    });
  }
};

const appendAndGroups = (owner, groups) => {
  if (owner.AND != null && !Array.isArray(owner.AND)) {
    throw new SimfinityError('AND requires an array', 'INVALID_FILTER_VALUE', 400);
  }
  owner.AND = [...(owner.AND || []), ...groups];
};

// The deepest AND/OR group nesting the backends accept; groups listed in args.AND/OR are at depth 0.
const MAX_FILTER_GROUP_DEPTH = 5;
const nestedGroups = (group) => [...[].concat(group.AND ?? []), ...[].concat(group.OR ?? [])];
const groupDepth = (group) => Math.max(0, ...nestedGroups(group)
  .filter((item) => item && typeof item === 'object').map((item) => groupDepth(item) + 1));

// Maps each AND/OR group of the query to the deepest level it appears at.
const collectFilterGroups = (args) => {
  const found = new Map();
  const visit = (group, depth) => {
    if (!group || typeof group !== 'object' || found.get(group) >= depth) return;
    found.set(group, depth);
    if (depth <= MAX_FILTER_GROUP_DEPTH) for (const item of nestedGroups(group)) visit(item, depth + 1);
  };
  for (const item of nestedGroups(args)) visit(item, 0);
  return found;
};

// Restricts referenced records reached by client paths with each target type's find scope. A path
// used only in AND/OR group conditions restricts just those groups, so an OR alternative that does
// not use it keeps its matches; any other use, a group that middleware or a scope detached, or a
// group too deep to hold the scope groups within the backends' depth limit, restricts the whole query.
const applyJoinedScopes = async (joinedScopes, params) => {
  let queryGroups;
  for (const [prefix, {
    target, collection, topLevel, groups: owners,
  }] of joinedScopes) {
    const scopeArgs = {};
    await executeScope({ type: target, args: scopeArgs, operation: 'find', context: params.context });
    const groups = prefixScopeArgs(scopeArgs, prefix, target.gqltype.name);
    if (!groups.length) continue;
    if (collection) throw forbiddenPath(`Query path ${prefix} enters the scoped collection ${collection}`);
    assertJoinedScopePaths(groups, prefix, target);
    queryGroups ??= collectFilterGroups(params.args);
    const addedDepth = 1 + Math.max(...groups.map(groupDepth));
    if (topLevel || [...owners].some((owner) => !queryGroups.has(owner)
      || queryGroups.get(owner) + addedDepth > MAX_FILTER_GROUP_DEPTH)) appendAndGroups(params.args, groups);
    else for (const owner of owners) appendAndGroups(owner, groups);
  }
};

// Unscoped relation reads of one request, grouped by related type until the promise jobs queued so
// far have run, and keyed by cast ID. Nothing is cached: each batch is read once and dropped.
const referenceBatches = new WeakMap();

const readReferences = async (type, keys, batch, context) => {
  let found = new Map();
  try {
    const records = await adapter.getByIds(type.model, keys.map((key) => batch.get(key)[0].id), { context });
    for (const record of records) {
      if (record != null) found.set(String(adapter.castId(record._id ?? record.id)), record);
    }
  } catch {
    found = null;
  }
  // After a failed batch, each ID is read alone, so an error fails only the fields that use it.
  const reads = new Map();
  for (const key of keys) {
    for (const { id, requiredId, resolve, reject } of batch.get(key)) {
      if (found) {
        resolve(found.get(key) ?? null);
        continue;
      }
      if (!reads.has(id)) {
        reads.set(id, Promise.resolve().then(() => adapter.getById(type.model, id, null, { requiredId, context })));
      }
      reads.get(id).then(resolve, reject);
    }
  }
};

const flushReferences = (type, batch, context) => {
  const keys = [...batch.keys()];
  const size = getQueryMaxPageSize();
  for (let start = 0; start < keys.length; start += size) {
    readReferences(type, keys.slice(start, start + size), batch, context);
  }
};

const loadReference = (type, id, requiredId, context) => {
  let key;
  try {
    key = String(adapter.castId(id));
  } catch {
    // An ID the adapter cannot cast is read alone, so only its field reports the error.
    return adapter.getById(type.model, id, null, { requiredId, context });
  }
  // Casting may normalize (e.g. ObjectId hex case), so non-canonical IDs are read alone too.
  if (key !== String(id)) return adapter.getById(type.model, id, null, { requiredId, context });
  return new Promise((resolve, reject) => {
    let batches = referenceBatches.get(context);
    if (!batches) {
      batches = new Map();
      referenceBatches.set(context, batches);
    }
    let batch = batches.get(type);
    if (!batch) {
      batch = new Map();
      batches.set(type, batch);
      // As DataLoader does, flush once the promise jobs queued so far have run, so sibling calls
      // that awaited middleware without I/O join the same batch.
      Promise.resolve().then(() => process.nextTick(() => {
        batches.delete(type);
        flushReferences(type, batch, context);
      }));
    }
    if (!batch.has(key)) batch.set(key, []);
    batch.get(key).push({
      id, requiredId, resolve, reject,
    });
  });
};

// `requiredId` marks a generated single-reference read. Middleware still runs per call; then, when the
// adapter reads by ID in batches, and unless the type has a get_by_id scope or middleware changed the
// ID, the read joins the request's batch.
const resolveById = async (type, args, context, requiredId) => {
  const requestedId = args.id;
  await executeMiddleware({ type, args, operation: 'get_by_id', context });
  if (!type.gqltype.extensions?.scope?.get_by_id) {
    if (requiredId != null && args.id === requestedId && typeof context === 'object' && context !== null
      && typeof adapter.getByIds === 'function' && type.gqltype.getFields().id) {
      return loadReference(type, args.id, requiredId, context);
    }
    return adapter.getById(type.model, args.id, null, { requiredId, context });
  }
  const queryArgs = { id: { operator: 'EQ', value: args.id } };
  await executeScope({ type, args: queryArgs, operation: 'get_by_id', context });
  const results = await adapter.find(type.model, type.gqltype, queryArgs, null, { requiredId, context });
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
              args.input, operations.SAVE, null, null, context, type.inputType);
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
              args.id, operations.DELETE, null, null, context, null);
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
              args.input, operations.UPDATE, null, null, context, type.inputType);
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
                    args.input, operations.STATE_CHANGED, actionField,
                    null, context, type.inputType);
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
          return executeRegisteredMutation(args.input, registeredMutation.callback,
            context, null, registeredMutation.inputModel);
        },
      };
    }
  }

  return new GraphQLObjectType(rootQueryArgs);
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
          type.gqltype.getFields().id.resolve = markGenerated((parent) => parent._id);
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
          extensions: { simfinityQuery: { typeName: type.gqltype.name, operation: 'find' } },
          async resolve(parent, args, context) {
            const joinedScopes = inspectClientPaths(type.gqltype, args, 'find');
            const params = {
              type,
              args,
              operation: 'find',
              context,
            };
            await executeMiddleware(params);
            await executeScope(params);
            await applyJoinedScopes(joinedScopes, params);
            const queryArgs = params.args;
            const wantsCount = !!(queryArgs.pagination && queryArgs.pagination.count);

            const dataPromise = adapter.find(type.model, type.gqltype, queryArgs, null);
            const countPromise = wantsCount
              ? adapter.count(type.model, type.gqltype, queryArgs, null)
              : null;

            const [result, resultCount] = await Promise.all([dataPromise, countPromise]);
            if (wantsCount) {
              context.count = resultCount;
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
          extensions: { simfinityQuery: { typeName: type.gqltype.name, operation: 'aggregate' } },
          async resolve(parent, args, context) {
            const joinedScopes = inspectClientPaths(type.gqltype, args, 'aggregate');
            const params = {
              type,
              args,
              operation: 'aggregate',
              context,
            };
            await executeMiddleware(params);
            await executeScope(params);
            await applyJoinedScopes(joinedScopes, params);
            return adapter.aggregate(type.model, type.gqltype, params.args, null);
          },
        };
      }
    }
  }

  return new GraphQLObjectType(rootQueryArgs);
};

const markReferencedTypesForModelGeneration = () => {
  Object.values(typesDict.types).forEach((typeInfo) => {
    Object.values(typeInfo.gqltype.getFields()).forEach((fieldEntry) => {
      const relation = fieldEntry.extensions?.relation;
      if (!relation || relation.embedded) return;

      const relatedType = unwrapListAndNonNull(fieldEntry.type);
      const relatedTypeInfo = typesDict.types[relatedType.name];
      if (relatedTypeInfo && !relatedTypeInfo.endpoint) {
        relatedTypeInfo.needsModel = true;
      }
    });
  });
};

const getRegistrations = () => Object.values(typesDict.types);

const createSchema = (includedQueryTypes, includedMutationTypes, includedCustomMutations) => {
  markReferencedTypesForModelGeneration();
  if (adapter.prepare) {
    adapter.prepare(getRegistrations(), { createCollection: !preventCollectionCreation });
  }

  Object.values(typesDict.types).forEach((typeInfo) => {
    if (typeInfo.gqltype && !typeInfo.model) {
      if (typeInfo.endpoint) {
        typeInfo.model = adapter.createModel(typeInfo.gqltype, typeInfo.onModelCreated, {
          createCollection: !preventCollectionCreation,
        });
      } else if (typeInfo.needsModel) {
        typeInfo.model = adapter.createModel(typeInfo.gqltype, null, { createCollection: false });
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

  const query = buildRootQuery('RootQueryType', includedQueryTypes);
  Object.values(typesDict.types).forEach(({ gqltype }) => {
    if (gqltype && !applicationResolvedFields.has(gqltype)) {
      applicationResolvedFields.set(gqltype, listApplicationResolvedFields(gqltype));
    }
  });

  return new GraphQLSchema({
    query,
    mutation: buildMutation('Mutation', includedMutationTypes, includedCustomMutations),
  });
};

const getModel = (gqltype) => typesDict.types[gqltype.name]?.model;

const getType = (typeName) => {
  if (typeof typeName === 'string') {
    return typesDict.types[typeName]?.gqltype;
  }
  if (typeName && typeName.name) {
    return typesDict.types[typeName.name]?.gqltype;
  }
  return null;
};

const registerMutation = (name, description, inputModel, outputModel, callback) => {
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

    const listShape = getListShape(fieldEntry.type);
    if (listShape) {
      const relatedType = listShape.itemType;
      const connection = normalizeConnectionField(
        relatedType,
        relation.connectionField || fieldName,
      );
      const relatedTypeInfo = typesDict.types[relatedType.name];
      const argsObject = createArgsForQuery(relatedTypeInfo.gqltype.getFields());
      if (connection.graphqlFieldName) delete argsObject[connection.graphqlFieldName];

      fieldEntry.args = formatArgs(Object.entries(argsObject));
      fieldEntry.extensions = {
        ...fieldEntry.extensions,
        simfinityQuery: { typeName: relatedType.name, operation: 'find' },
      };
      fieldEntry.resolve = markGenerated(async (parent, args, context) => {
        if (!relatedTypeInfo || !relatedTypeInfo.model) {
          throw new Error(`Related type ${relatedType.name} not found or not connected. Make sure it's connected with simfinity.connect() or simfinity.addNoEndpointType().`);
        }
        const joinedScopes = inspectClientPaths(relatedType, args, 'find');
        const params = { type: relatedTypeInfo, args, operation: 'find', context };
        await executeMiddleware(params);
        await executeScope(params);
        await applyJoinedScopes(joinedScopes, params);
        return adapter.findChildren(
          relatedTypeInfo.model,
          relatedTypeInfo.gqltype,
          connection.storageFieldName,
          parent.id || parent._id,
          params.args,
          null,
        );
      });
    } else if (fieldEntry.type instanceof GraphQLObjectType
      || (fieldEntry.type instanceof GraphQLNonNull && fieldEntry.type.ofType instanceof GraphQLObjectType)) {
      const relatedType = unwrapNonNull(fieldEntry.type);
      const connectionField = relation.connectionField || fieldName;

      fieldEntry.resolve = markGenerated(async (parent, args, context) => {
        const relatedTypeInfo = typesDict.types[relatedType.name];
        if (!relatedTypeInfo || !relatedTypeInfo.model) {
          throw new Error(`Related type ${relatedType.name} not found or not connected. Make sure it's connected with simfinity.connect() or simfinity.addNoEndpointType().`);
        }
        const relatedId = parent[connectionField] || parent[fieldName];
        const id = relatedId?._id || relatedId;
        return id ? resolveById(relatedTypeInfo, { id: String(id) }, context, id) : null;
      });
    }
  }
};

const connect = (model, gqltype, simpleEntityEndpointName,
  listEntitiesEndpointName, controller, onModelCreated, stateMachine) => {
  const registration = {
    model,
    gqltype,
    simpleEntityEndpointName,
    listEntitiesEndpointName,
    endpoint: true,
    controller,
    stateMachine,
    onModelCreated,
  };
  if (adapter.validateRegistration) adapter.validateRegistration(registration);

  waitingInputType[gqltype.name] = {
    model,
    gqltype,
  };
  typesDict.types[gqltype.name] = registration;

  typesDictForUpdate.types[gqltype.name] = { ...typesDict.types[gqltype.name] };
};

const addNoEndpointType = (gqltype) => {
  const fields = gqltype.getFields();
  let needsModel = false;
  for (const fieldEntry of Object.values(fields)) {
    if (fieldEntry.extensions?.relation
      && (fieldEntry.type instanceof GraphQLObjectType
        || getListShape(fieldEntry.type)
        || (fieldEntry.type instanceof GraphQLNonNull && fieldEntry.type.ofType instanceof GraphQLObjectType))) {
      needsModel = true;
      break;
    }
  }

  const registration = {
    gqltype, endpoint: false, model: null, needsModel,
  };
  if (adapter.validateRegistration) adapter.validateRegistration(registration);

  waitingInputType[gqltype.name] = { gqltype };
  typesDict.types[gqltype.name] = registration;
  typesDictForUpdate.types[gqltype.name] = { ...typesDict.types[gqltype.name] };
};

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
      } else if (getListShape(fieldEntry.type)) {
        const listOfType = getListShape(fieldEntry.type).itemType;
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

  if (adapter.bind) {
    adapter.bind({ getModel, getType, getRegistrations });
  }

  return {
    configureQueryLimits,
    connect,
    addNoEndpointType,
    createSchema,
    getModel,
    getType,
    getInputType,
    getRegistrations,
    use,
    registerMutation,
    saveObject,
    preventCreatingCollection,
  };
};
