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
import './introspection.js';

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
          } else {
            materializedModel.modelArgs[fieldEntryName] = { ...oldObjectData, ...newObjectData };
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

  const result = await adapter.update(Model, objectId, update, session);

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
  return onSaveObject(type.model, type.gqltype, type.controller, args, session, null, context);
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

  let operationFunction = async () => { };

  switch (operationType) {
    case operations.SAVE:
      operationFunction = async (collectionItem) => {
        await onSaveObject(typesDict.types[collectionGQLType.name].model, collectionGQLType,
          typesDict.types[collectionGQLType.name].controller, collectionItem, session, (item) => {
            item[connection.storageFieldName] = objectId;
          }, context);
      };
      break;
    case operations.UPDATE:
      operationFunction = async (collectionItem) => {
        await onUpdateSubject(typesDict.types[collectionGQLType.name].model, collectionGQLType,
          typesDict.types[collectionGQLType.name].controller, collectionItem, session, (item) => {
            item[connection.storageFieldName] = objectId;
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
          type.gqltype.getFields().id.resolve = (parent) => parent._id;
        }

        rootQueryArgs.fields[type.simpleEntityEndpointName] = {
          type: type.gqltype,
          args: { id: { type: GraphQLID } },
          async resolve(parent, args, context) {
            const params = {
              type, args, operation: 'get_by_id', context,
            };
            await executeMiddleware(params);

            const hasScope = type.gqltype.extensions?.scope?.get_by_id;
            if (!hasScope) {
              return adapter.getById(type.model, args.id, null);
            }

            const queryArgs = { id: { operator: 'EQ', value: args.id } };
            await executeScope({
              type, args: queryArgs, operation: 'get_by_id', context,
            });
            const results = await adapter.find(type.model, type.gqltype, queryArgs, null);
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
            await executeMiddleware(params);
            await executeScope(params);
            const wantsCount = !!(args.pagination && args.pagination.count);

            const dataPromise = adapter.find(type.model, type.gqltype, args, null);
            const countPromise = wantsCount
              ? adapter.count(type.model, type.gqltype, args, null)
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
          async resolve(parent, args, context) {
            const params = {
              type,
              args,
              operation: 'aggregate',
              context,
            };
            await executeMiddleware(params);
            await executeScope(params);
            return adapter.aggregate(type.model, type.gqltype, args, null);
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

  return new GraphQLSchema({
    query: buildRootQuery('RootQueryType', includedQueryTypes),
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
      fieldEntry.resolve = async (parent, args) => {
        if (!relatedTypeInfo || !relatedTypeInfo.model) {
          throw new Error(`Related type ${relatedType.name} not found or not connected. Make sure it's connected with simfinity.connect() or simfinity.addNoEndpointType().`);
        }
        return adapter.findChildren(
          relatedTypeInfo.model,
          relatedTypeInfo.gqltype,
          connection.storageFieldName,
          parent.id || parent._id,
          args,
          null,
        );
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
        return relatedId ? adapter.getById(relatedTypeInfo.model, relatedId, null) : null;
      };
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
