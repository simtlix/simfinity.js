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

// Custom JSON scalar type for aggregation results
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

// Adding 'extensions' field into instronspection query
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
// End of adding 'extensions' field to instrospection query

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

/* Schema defines data on the Graph like object types(book type), relation between
these object types and describes how it can reach into the graph to interact with
the data to retrieve or mutate the data */
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

function createValidatedScalar(name, description, baseScalarType, validate) {
  if (!baseScalarType) {
    throw new Error('baseScalarType is required');
  }

  // Validate that baseScalarType is a valid GraphQL scalar type
  if (!(baseScalarType instanceof GraphQLScalarType)) {
    throw new Error('baseScalarType must be a valid GraphQL scalar type');
  }

  // Check if it's one of the standard GraphQL scalar types
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
    ID: Kind.STRING, // IDs are represented as strings in AST
  };

  // Try to infer the kind from the baseScalarType name
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

  // If a gqltype is provided, create a new input type for 'added'
  // that excludes the field named after the gqltype.
  if (connectionField) {
    const fieldToExclude = connectionField;
    inputTypeForAdd = createTypeWithExcludedField(inputNamePrefix, inputType, fieldToExclude);
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
            const listInputTypeForAdd = graphQLListInputType(typesDict, fieldEntry, fieldEntryName, 'A', fieldEntry.extensions?.relation?.connectionField);
            const listInputTypeForUpdate = graphQLListInputType(typesDictForUpdate, fieldEntry, fieldEntryName, 'U', fieldEntry.extensions?.relation?.connectionField);
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

const executeRegisteredMutation = async (args, callback, session) => {
  const mySession = session || await mongoose.startSession();
  await mySession.startTransaction();
  try {
    const newObject = await callback(args, mySession);
    await mySession.commitTransaction();
    mySession.endSession();
    return newObject;
  } catch (error) {
    await mySession.abortTransaction();
    if (error.errorLabels && error.errorLabels.includes('TransientTransactionError')) {
      return executeRegisteredMutation(args, callback, mySession);
    }
    mySession.endSession();
    throw error;
  }
};

const iterateonCollectionFields = async (materializedModel, gqltype, objectId, session, context) => {
  for (const [collectionFieldKey, collectionField] of
    Object.entries(materializedModel.collectionFields)) {
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

const onDeleteObject = async (Model, gqltype, controller, args, session, context) => {
  const deletedObject = await Model.findById({ _id: args }).session(session).lean();

  if (controller && controller.onDelete) {
    await controller.onDelete(deletedObject, session, context);
  }

  return Model.findByIdAndDelete({ _id: args }).session(session);
};

const onDeleteSubject = async (Model, controller, id, session, context) => {
  const currentObject = await Model.findById({ _id: id }).session(session).lean();

  if (controller && controller.onDelete) {
    await controller.onDelete(currentObject, session, context);
  }

  return Model.findByIdAndDelete({ _id: id }).session(session);
};

const onUpdateSubject = async (Model, gqltype, controller, args, session, linkToParent, context) => {
  const materializedModel = await materializeModel(args, gqltype, linkToParent, 'UPDATE', session);
  const objectId = args.id;

  const currentObject = await Model.findById({ _id: objectId }).lean();

  const argTypes = gqltype.getFields();

  Object.entries(argTypes).forEach(([fieldEntryName, fieldEntry]) => {
    if (fieldEntry.extensions && fieldEntry.extensions.relation
      && fieldEntry.extensions.relation.embedded) {
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

    if (args[fieldEntryName] === null
      && !(fieldEntry.type instanceof GraphQLNonNull)) {
      materializedModel.modelArgs = { ...materializedModel.modelArgs, $unset: { [fieldEntryName]: '' } };
    }
  });

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
  const storedModel = await Model.findById(args.id);
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

const executeOperation = async (Model, gqltype, controller,
  args, operation, actionField, session, context) => {
  const mySession = session || await mongoose.startSession();
  await mySession.startTransaction();
  try {
    let newObject = null;
    switch (operation) {
      case operations.SAVE:
        newObject = await onSaveObject(Model, gqltype, controller, args, mySession, null, context);
        break;
      case operations.UPDATE:
        newObject = await onUpdateSubject(Model, gqltype, controller, args, mySession, null, context);
        break;
      case operations.DELETE:
        newObject = await onDeleteObject(Model, gqltype, controller, args, mySession, context);
        break;
      case operations.STATE_CHANGED:
        newObject = await onStateChanged(Model, gqltype, controller, args, mySession, actionField, context);
        break;
    }
    await mySession.commitTransaction();
    mySession.endSession();
    return newObject;
  } catch (error) {
    await mySession.abortTransaction();
    if (error.errorLabels && error.errorLabels.includes('TransientTransactionError')) {
      return executeOperation(Model, gqltype, controller, args, operation, actionField, mySession, context);
    }
    mySession.endSession();
    throw error;
  }
};

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
        await onDeleteSubject(typesDict.types[collectionGQLType.name].model,
          typesDict.types[collectionGQLType.name].controller, collectionItem, session, context);
      };
  }

  for (const element of collectionFieldsList) {
    await operationFunction(element);
  }
};

const shouldNotBeIncludedInSchema = (includedTypes,
  type) => includedTypes && !includedTypes.includes(type);

const excecuteMiddleware = (context) => {
  const buildNext = (middlewaresParam) => {
    if (!middlewaresParam) {
      return () => {};
    }
    const next = () => {
      const middleware = middlewaresParam[0];
      if (middleware) {
        middleware(context, buildNext(middlewaresParam.slice(1)));
      }
    };
    return next;
  };

  const middleware = buildNext(middlewares);
  middleware();
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

  // Call the scope function with the same params as middleware
  const result = await scopeFunction({ type, args, operation, context });
  
  // For get_by_id, the scope function returns additional filters to merge
  // For find and aggregate, it modifies args in place
  return result;
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

            excecuteMiddleware(params);
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

            excecuteMiddleware(params);
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

            excecuteMiddleware(params);
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

                  excecuteMiddleware(params);
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
          excecuteMiddleware(params);
          return executeRegisteredMutation(args.input, registeredMutation.callback);
        },
      };
    }
  }

  return new GraphQLObjectType(rootQueryArgs);
};

const generateSchemaDefinition = (gqlType) => {
  const argTypes = gqlType.getFields();

  const schemaArg = {};

  for (const [fieldEntryName, fieldEntry] of Object.entries(argTypes)) {
    // Helper function to get the base scalar type for custom validated scalars
    const getBaseScalarType = (scalarType) => scalarType.baseScalarType || scalarType;

    // Helper function to check if a type is a custom validated scalar
    const isCustomValidatedScalar = (type) => type instanceof GraphQLScalarType && type.baseScalarType;

    if (fieldEntry.type === GraphQLID || isNonNullOfTypeForNotScalar(fieldEntry.type, GraphQLID)) {
      schemaArg[fieldEntryName] = mongoose.Schema.Types.ObjectId;
    } else if (fieldEntry.type === GraphQLString
      || isNonNullOfTypeForNotScalar(fieldEntry.type, GraphQLString)
      || (isCustomValidatedScalar(fieldEntry.type) && getBaseScalarType(fieldEntry.type) === GraphQLString)
      || (isNonNullOfType(fieldEntry.type, GraphQLScalarType) && isCustomValidatedScalar(fieldEntry.type.ofType) && getBaseScalarType(fieldEntry.type.ofType) === GraphQLString)) {
      if (fieldEntry.extensions && fieldEntry.extensions.unique) {
        schemaArg[fieldEntryName] = { type: String, unique: true };
      } else {
        schemaArg[fieldEntryName] = String;
      }
    } else if (fieldEntry.type instanceof GraphQLEnumType
      || isNonNullOfType(fieldEntry.type, GraphQLEnumType)) {
      if (fieldEntry.extensions && fieldEntry.extensions.unique) {
        schemaArg[fieldEntryName] = { type: String, unique: true };
      } else {
        schemaArg[fieldEntryName] = String;
      }
    } else if (fieldEntry.type === GraphQLInt
      || isNonNullOfTypeForNotScalar(fieldEntry.type, GraphQLInt)
      || (isCustomValidatedScalar(fieldEntry.type) && getBaseScalarType(fieldEntry.type) === GraphQLInt)
      || (isNonNullOfType(fieldEntry.type, GraphQLScalarType) && isCustomValidatedScalar(fieldEntry.type.ofType) && getBaseScalarType(fieldEntry.type.ofType) === GraphQLInt)) {
      if (fieldEntry.extensions && fieldEntry.extensions.unique) {
        schemaArg[fieldEntryName] = { type: Number, unique: true };
      } else {
        schemaArg[fieldEntryName] = Number;
      }
    } else if (fieldEntry.type === GraphQLFloat
      || isNonNullOfTypeForNotScalar(fieldEntry.type, GraphQLFloat)
      || (isCustomValidatedScalar(fieldEntry.type) && getBaseScalarType(fieldEntry.type) === GraphQLFloat)
      || (isNonNullOfType(fieldEntry.type, GraphQLScalarType) && isCustomValidatedScalar(fieldEntry.type.ofType) && getBaseScalarType(fieldEntry.type.ofType) === GraphQLFloat)) {
      if (fieldEntry.extensions && fieldEntry.extensions.unique) {
        schemaArg[fieldEntryName] = { type: Number, unique: true };
      } else {
        schemaArg[fieldEntryName] = Number;
      }
    } else if (fieldEntry.type === GraphQLBoolean
      || isNonNullOfTypeForNotScalar(fieldEntry.type, GraphQLBoolean)
      || (isCustomValidatedScalar(fieldEntry.type) && getBaseScalarType(fieldEntry.type) === GraphQLBoolean)
      || (isNonNullOfType(fieldEntry.type, GraphQLScalarType) && isCustomValidatedScalar(fieldEntry.type.ofType) && getBaseScalarType(fieldEntry.type.ofType) === GraphQLBoolean)) {
      schemaArg[fieldEntryName] = Boolean;
    } else if (fieldEntry.type instanceof GraphQLObjectType
      || isNonNullOfType(fieldEntry.type, GraphQLObjectType)) {
      if (fieldEntry.extensions && fieldEntry.extensions.relation) {
        if (!fieldEntry.extensions.relation.embedded) {
          schemaArg[fieldEntry.extensions.relation.connectionField ? fieldEntry.extensions.relation.connectionField : fieldEntry.name] = mongoose
            .Schema.Types.ObjectId;
        } else {
          let entryType = fieldEntry.type;
          if (entryType instanceof GraphQLNonNull) {
            entryType = entryType.ofType;
          }
          if (entryType !== gqlType) {
            schemaArg[fieldEntryName] = generateSchemaDefinition(entryType);
          } else {
            throw new Error('A type cannot have a field of its same type and embedded');
          }
        }
      }
    } else if (fieldEntry.type instanceof GraphQLList) {
      if (fieldEntry.extensions && fieldEntry.extensions.relation) {
        if (fieldEntry.extensions.relation.embedded) {
          const entryType = fieldEntry.type.ofType;
          if (entryType !== gqlType) {
            schemaArg[fieldEntryName] = [generateSchemaDefinition(entryType)];
          } else {
            throw new Error('A type cannot have a field of its same type and embedded');
          }
        }
      } else if (fieldEntry.type.ofType === GraphQLString
        || fieldEntry.type.ofType instanceof GraphQLEnumType
        || (isCustomValidatedScalar(fieldEntry.type.ofType) && getBaseScalarType(fieldEntry.type.ofType) === GraphQLString)) {
        schemaArg[fieldEntryName] = [String];
      } else if (fieldEntry.type.ofType === GraphQLBoolean
        || (isCustomValidatedScalar(fieldEntry.type.ofType) && getBaseScalarType(fieldEntry.type.ofType) === GraphQLBoolean)) {
        schemaArg[fieldEntryName] = [Boolean];
      } else if (fieldEntry.type.ofType === GraphQLInt || fieldEntry.type.ofType === GraphQLFloat
        || (isCustomValidatedScalar(fieldEntry.type.ofType) && (getBaseScalarType(fieldEntry.type.ofType) === GraphQLInt || getBaseScalarType(fieldEntry.type.ofType) === GraphQLFloat))) {
        schemaArg[fieldEntryName] = [Number];
      } else if (isGraphQLisoDate(getEffectiveTypeName(fieldEntry.type.ofType))) {
        schemaArg[fieldEntryName] = [Date];
      }
    } else if (isGraphQLisoDate(getEffectiveTypeName(fieldEntry.type))
    || (fieldEntry.type instanceof GraphQLNonNull && isGraphQLisoDate(getEffectiveTypeName(fieldEntry.type.ofType)))) {
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
      // Direct ObjectId field
      objectIdFields.push(currentPath);
    } else if (typeof fieldDefinition === 'object' && fieldDefinition !== null) {
      if (Array.isArray(fieldDefinition)) {
        // Array field - check if it's an array of objects
        const arrayElement = fieldDefinition[0];
        if (typeof arrayElement === 'object' && arrayElement !== null) {
          // Array of embedded objects - recursively check for ObjectId fields
          const nestedObjectIdFields = findObjectIdFields(arrayElement, currentPath);
          objectIdFields.push(...nestedObjectIdFields);
        }
      } else if (fieldDefinition.type === mongoose.Schema.Types.ObjectId) {
        // Object with ObjectId type
        objectIdFields.push(currentPath);
      } else if (typeof fieldDefinition === 'object' && !fieldDefinition.type) {
        // Embedded object - recursively check for ObjectId fields
        const nestedObjectIdFields = findObjectIdFields(fieldDefinition, currentPath);
        objectIdFields.push(...nestedObjectIdFields);
      }
    }
  }
  
  return objectIdFields;
};

const createSchemaWithIndexes = (schemaDefinition) => {
  const schema = new mongoose.Schema(schemaDefinition);
  
  // Find all ObjectId fields in the schema
  const objectIdFields = findObjectIdFields(schemaDefinition);
  
  // Create indexes for all ObjectId fields
  objectIdFields.forEach(fieldPath => {
    schema.index({ [fieldPath]: 1 });
  });
  
  return schema;
};

const generateModel = (gqlType, onModelCreated) => {
  const schemaDefinition = generateSchemaDefinition(gqlType);
  const schema = createSchemaWithIndexes(schemaDefinition);
  const model = mongoose.model(gqlType.name, schema, gqlType.name);
  if (onModelCreated) {
    onModelCreated(model);
  }
  if (!preventCollectionCreation) {
    model.createCollection();
  }
  return model;
};

const generateModelWithoutCollection = (gqlType, onModelCreated) => {
  const schemaDefinition = generateSchemaDefinition(gqlType);
  const schema = createSchemaWithIndexes(schemaDefinition);
  const model = mongoose.model(gqlType.name, schema, gqlType.name);
  if (onModelCreated) {
    onModelCreated(model);
  }
  // Never create collection for no-endpoint types
  return model;
};

const buildMatchesClause = (fieldname, operator, value) => {
  const matches = {};
  if (operator === QLOperator.getValue('EQ').value || !operator) {
    let fixedValue = value;
    if (fieldname.endsWith('_id')) {
      fixedValue = new mongoose.Types.ObjectId(value);
    }
    matches[fieldname] = fixedValue;
  } else if (operator === QLOperator.getValue('LT').value) {
    matches[fieldname] = { $lt: value };
  } else if (operator === QLOperator.getValue('GT').value) {
    matches[fieldname] = { $gt: value };
  } else if (operator === QLOperator.getValue('LTE').value) {
    matches[fieldname] = { $lte: value };
  } else if (operator === QLOperator.getValue('GTE').value) {
    matches[fieldname] = { $gte: value };
  } else if (operator === QLOperator.getValue('NE').value) {
    matches[fieldname] = { $ne: value };
  } else if (operator === QLOperator.getValue('BTW').value) {
    matches[fieldname] = { $gte: value[0], $lte: value[1] };
  } else if (operator === QLOperator.getValue('IN').value) {
    let fixedArray = value;
    if (value && fieldname.endsWith('_id')) {
      fixedArray = [];
      value.forEach((element) => {
        fixedArray.push(new mongoose.Types.ObjectId(element));
      });
    }
    matches[fieldname] = { $in: fixedArray };
  } else if (operator === QLOperator.getValue('NIN').value) {
    let fixedArray = value;
    if (value && fieldname.endsWith('_id')) {
      fixedArray = [];
      value.forEach((element) => {
        fixedArray.push(new mongoose.Types.ObjectId(element));
      });
    }
    matches[fieldname] = { $nin: fixedArray };
  } else if (operator === QLOperator.getValue('LIKE').value) {
    matches[fieldname] = { $regex: `.*${value}.*` };
  }

  return matches;
};

const buildAggregationsForSort = (filterField, qlField, fieldName) => {
  const aggregateClauses = {};

  let fieldType = qlField.type;
  if (qlField.type instanceof GraphQLList) {
    fieldType = qlField.type.ofType;
  }
  if (fieldType instanceof GraphQLObjectType
    || isNonNullOfType(fieldType, GraphQLObjectType)) {
    if (fieldType instanceof GraphQLNonNull) {
      fieldType = qlField.type.ofType;
    }
    filterField.terms.forEach((term) => {
      if (qlField.extensions && qlField.extensions.relation
        && !qlField.extensions.relation.embedded) {
        const { model } = typesDict.types[fieldType.name];
        const { collectionName } = model.collection;
        const localFieldName = qlField.extensions?.relation?.connectionField || fieldName;
        if (!aggregateClauses[fieldName]) {
          let lookup = {};

          if (qlField.type instanceof GraphQLList) {
            lookup = {
              $lookup: {
                from: collectionName,
                foreignField: localFieldName,
                localField: '_id',
                as: fieldName,
              },
            };
          } else {
            lookup = {
              $lookup: {
                from: collectionName,
                foreignField: '_id',
                localField: localFieldName,
                as: fieldName,
              },
            };
          }

          aggregateClauses[fieldName] = {
            lookup,
            unwind: { $unwind: { path: `$${fieldName}`, preserveNullAndEmptyArrays: true } },
          };
        }
      }

      let currentGQLPathFieldType = qlField.type;
      if (currentGQLPathFieldType instanceof GraphQLList
        || currentGQLPathFieldType instanceof GraphQLNonNull) {
        currentGQLPathFieldType = currentGQLPathFieldType.ofType;
      }
      let aliasPath = fieldName;
      let embeddedPath = '';

      term.path.split('.').forEach((pathFieldName) => {
        const pathField = currentGQLPathFieldType.getFields()[pathFieldName];
        if (pathField.type instanceof GraphQLObjectType
          || pathField.type instanceof GraphQLList
          || isNonNullOfType(pathField.type, GraphQLObjectType)) {
          let pathFieldType = pathField.type;
          if (pathField.type instanceof GraphQLList || pathField.type instanceof GraphQLNonNull) {
            pathFieldType = pathField.type.ofType;
          }
          currentGQLPathFieldType = pathFieldType;
          if (pathField.extensions && pathField.extensions.relation
            && !pathField.extensions.relation.embedded) {
            const currentPath = aliasPath + (embeddedPath !== '' ? `.${embeddedPath}` : '');
            aliasPath += (embeddedPath !== '' ? `_${embeddedPath}_` : '_') + pathFieldName;

            embeddedPath = '';

            const pathModel = typesDict.types[pathFieldType.name].model;
            const fieldPathCollectionName = pathModel.collection.collectionName;
            const pathLocalFieldName = pathField.extensions?.relation?.connectionField || pathFieldName;

            if (!aggregateClauses[aliasPath]) {
              let lookup = {};
              if (pathField.type instanceof GraphQLList) {
                lookup = {
                  $lookup: {
                    from: fieldPathCollectionName,
                    foreignField: pathLocalFieldName,
                    localField: `${currentPath}._id`,
                    as: aliasPath,
                  },
                };
              } else {
                lookup = {
                  $lookup: {
                    from: fieldPathCollectionName,
                    foreignField: '_id',
                    localField: `${currentPath}.${pathLocalFieldName}`,
                    as: aliasPath,
                  },
                };
              }

              aggregateClauses[aliasPath] = {
                lookup,
                unwind: { $unwind: { path: `$${aliasPath}`, preserveNullAndEmptyArrays: true } },
              };
            }
          } else if (embeddedPath === '') {
            embeddedPath += pathFieldName;
          } else {
            embeddedPath += `.${pathFieldName}`;
          }
        }
      });
    });
  }
  return aggregateClauses;
};

const buildQueryTerms = async (filterField, qlField, fieldName) => {
  const aggregateClauses = {};
  const matchesClauses = {};

  let fieldType = qlField.type;
  if (qlField.type instanceof GraphQLList) {
    fieldType = qlField.type.ofType;
  }
  if (fieldType instanceof GraphQLScalarType
    || isNonNullOfType(fieldType, GraphQLScalarType)
    || fieldType instanceof GraphQLEnumType
    || isNonNullOfType(fieldType, GraphQLEnumType)) {
    const fieldTypeName = fieldType instanceof GraphQLNonNull ? getEffectiveTypeName(fieldType.ofType) : getEffectiveTypeName(fieldType);
    if (isGraphQLisoDate(fieldTypeName)) {
      if (Array.isArray(filterField.value)) {
        filterField.value = filterField.value.map((value) => value && new Date(value));
      } else {
        filterField.value = filterField.value && new Date(filterField.value);
      }
    }
    matchesClauses[fieldName] = buildMatchesClause(fieldName === 'id' ? '_id' : fieldName, filterField.operator, filterField.value);
  } else if (fieldType instanceof GraphQLObjectType
    || isNonNullOfType(fieldType, GraphQLObjectType)) {
    if (fieldType instanceof GraphQLNonNull) {
      fieldType = qlField.type.ofType;
    }

    filterField.terms.forEach((term) => {
      if (qlField.extensions && qlField.extensions.relation
        && !qlField.extensions.relation.embedded) {
        const { model } = typesDict.types[fieldType.name];
        const { collectionName } = model.collection;
        const localFieldName = qlField.extensions?.relation?.connectionField || fieldName;
        if (!aggregateClauses[fieldName]) {
          let lookup = {};

          if (qlField.type instanceof GraphQLList) {
            lookup = {
              $lookup: {
                from: collectionName,
                foreignField: localFieldName,
                localField: '_id',
                as: fieldName,
              },
            };
          } else {
            lookup = {
              $lookup: {
                from: collectionName,
                foreignField: '_id',
                localField: localFieldName,
                as: fieldName,
              },
            };
          }

          aggregateClauses[fieldName] = {
            lookup,
            unwind: { $unwind: { path: `$${fieldName}`, preserveNullAndEmptyArrays: true } },
          };
        }
      }

      if (term.path.indexOf('.') < 0) {
        const { type } = fieldType.getFields()[term.path];
        const typeName = type instanceof GraphQLNonNull ? getEffectiveTypeName(type.ofType) : getEffectiveTypeName(type);
        if (isGraphQLisoDate(typeName)) {
          if (Array.isArray(term.value)) {
            term.value = term.value.map((value) => value && new Date(value));
          } else {
            term.value = term.value && new Date(term.value);
          }
        }
        matchesClauses[fieldName] = buildMatchesClause(`${fieldName}.${fieldType.getFields()[term.path].name === 'id' ? '_id' : term.path}`, term.operator, term.value);
      } else {
        let currentGQLPathFieldType = qlField.type;
        if (currentGQLPathFieldType instanceof GraphQLList
          || currentGQLPathFieldType instanceof GraphQLNonNull) {
          currentGQLPathFieldType = currentGQLPathFieldType.ofType;
        }
        let aliasPath = fieldName;
        let embeddedPath = '';

        term.path.split('.').forEach((pathFieldName) => {
          const pathField = currentGQLPathFieldType.getFields()[pathFieldName];
          if (pathField.type instanceof GraphQLScalarType
            || isNonNullOfType(pathField.type, GraphQLScalarType)) {
            const typeName = pathField.type instanceof GraphQLNonNull ? getEffectiveTypeName(pathField.type.ofType) : getEffectiveTypeName(pathField.type);
            if (isGraphQLisoDate(typeName)) {
              if (Array.isArray(term.value)) {
                term.value = term.value.map((value) => value && new Date(value));
              } else {
                term.value = term.value && new Date(term.value);
              }
            }
            matchesClauses[`${aliasPath}_${pathFieldName}`] = buildMatchesClause(aliasPath + (embeddedPath !== '' ? `.${embeddedPath}.` : '.') + (pathFieldName === 'id' ? '_id' : pathFieldName), term.operator, term.value);
            embeddedPath = '';
          } else if (pathField.type instanceof GraphQLObjectType
            || pathField.type instanceof GraphQLList
            || isNonNullOfType(pathField.type, GraphQLObjectType)) {
            let pathFieldType = pathField.type;
            if (pathField.type instanceof GraphQLList || pathField.type instanceof GraphQLNonNull) {
              pathFieldType = pathField.type.ofType;
            }
            currentGQLPathFieldType = pathFieldType;
            if (pathField.extensions && pathField.extensions.relation
              && !pathField.extensions.relation.embedded) {
              const currentPath = aliasPath + (embeddedPath !== '' ? `.${embeddedPath}` : '');
              aliasPath += (embeddedPath !== '' ? `_${embeddedPath}_` : '_') + pathFieldName;

              embeddedPath = '';

              const pathModel = typesDict.types[pathFieldType.name].model;
              const fieldPathCollectionName = pathModel.collection.collectionName;
              const pathLocalFieldName = pathField.extensions?.relation?.connectionField || pathFieldName;

              if (!aggregateClauses[aliasPath]) {
                let lookup = {};
                if (pathField.type instanceof GraphQLList) {
                  lookup = {
                    $lookup: {
                      from: fieldPathCollectionName,
                      foreignField: pathLocalFieldName,
                      localField: `${currentPath}._id`,
                      as: aliasPath,
                    },
                  };
                } else {
                  lookup = {
                    $lookup: {
                      from: fieldPathCollectionName,
                      foreignField: '_id',
                      localField: `${currentPath}.${pathLocalFieldName}`,
                      as: aliasPath,
                    },
                  };
                }

                aggregateClauses[aliasPath] = {
                  lookup,
                  unwind: { $unwind: { path: `$${aliasPath}`, preserveNullAndEmptyArrays: true } },
                };
              }
            } else if (embeddedPath === '') {
              embeddedPath += pathFieldName;
            } else {
              embeddedPath += `.${pathFieldName}`;
            }
          }
        });
      }
    });
  }
  return { aggregateClauses, matchesClauses };
};

const buildQuery = async (input, gqltype, isCount) => {
  const aggregateClauses = [];
  const matchesClauses = { $match: {} };
  let addMatch = false;
  let limitClause = { $limit: 100 };
  let skipClause = { $skip: 0 };
  let sortClause = {};
  let addSort = false;
  const aggregationsIncluded = {};

  for (const [key, filterField] of Object.entries(input)) {
    if (Object.prototype.hasOwnProperty.call(input, key) && key !== 'pagination' && key !== 'sort') {
      const qlField = gqltype.getFields()[key];

      const result = await buildQueryTerms(filterField, qlField, key);

      if (result) {
        for (const [prop, aggregate] of Object.entries(result.aggregateClauses)) {
          aggregateClauses.push(aggregate.lookup);
          aggregateClauses.push(aggregate.unwind);
          aggregationsIncluded[prop] = true;
        }

        for (const [matchClauseKey, matchClause] of Object.entries(result.matchesClauses)) {
          if (Object.prototype.hasOwnProperty.call(result.matchesClauses, matchClauseKey)) {
            for (const [matchKey, match] of Object.entries(matchClause)) {
              if (Object.prototype.hasOwnProperty.call(matchClause, matchKey)) {
                matchesClauses.$match[matchKey] = match;
                addMatch = true;
              }
            }
          }
        }
      }
    } else if (key === 'pagination') {
      if (filterField.page && filterField.size) {
        const skip = filterField.size * (filterField.page - 1);
        limitClause = { $limit: filterField.size + skip };
        skipClause = { $skip: skip };
      }
    } else if (key === 'sort') {
      const sortExpressions = {};
      filterField.terms.forEach((sort) => {
        let fixedSortField = sort.field;

        if (sort.field.indexOf('.') >= 0) {
          const sortParts = sort.field.split('.');
           
          fixedSortField = sortParts[0];
           
          for (let i = 1; i < sortParts.length - 1; i++) {
            fixedSortField += `_${sortParts[i]}`;
          }
          fixedSortField += `.${sortParts[sortParts.length - 1]}`;
          const qlField = gqltype.getFields()[sortParts[0]];
          const path = sort.field.slice(sort.field.indexOf('.') + 1);
          const aggreagtionsForSort = buildAggregationsForSort({ terms: [{ path }] }, qlField, sortParts[0]);
          for (const [prop, aggregate] of Object.entries(aggreagtionsForSort)) {
            if (!aggregationsIncluded[prop]) {
              aggregateClauses.push(aggregate.lookup);
              aggregateClauses.push(aggregate.unwind);
            }
          }
        }

        sortExpressions[fixedSortField] = sort.order === 'ASC' ? 1 : -1;
      });
      sortClause = { $sort: sortExpressions };
      addSort = true;
    }
  }

  if (addMatch) {
    aggregateClauses.push(matchesClauses);
  }

  if (addSort && !isCount) {
    aggregateClauses.push(sortClause);
  }

  if (!isCount) {
    aggregateClauses.push(limitClause);
    aggregateClauses.push(skipClause);
  }

  if (isCount) {
    aggregateClauses.push({ $count: 'size' });
  }

  return aggregateClauses;
};

const buildFieldPath = (gqltype, fieldPath) => {
  // This function resolves a field path (e.g., "category" or "country.name") 
  // and returns the MongoDB field path and any necessary lookups
  const pathParts = fieldPath.split('.');
  const aggregateClauses = [];
  let currentPath = '';
  let currentGQLType = gqltype;
  
  for (let i = 0; i < pathParts.length; i++) {
    const part = pathParts[i];
    const field = currentGQLType.getFields()[part];
    
    if (!field) {
      throw new Error(`Field ${part} not found in type ${currentGQLType.name}`);
    }
    
    let fieldType = field.type;
    if (fieldType instanceof GraphQLNonNull || fieldType instanceof GraphQLList) {
      fieldType = fieldType.ofType;
    }
    
    // If it's an object type with non-embedded relation, we need a lookup
    if ((fieldType instanceof GraphQLObjectType) && 
        field.extensions && field.extensions.relation && 
        !field.extensions.relation.embedded) {
      
      const relatedModel = typesDict.types[fieldType.name].model;
      const collectionName = relatedModel.collection.collectionName;
      const connectionField = field.extensions.relation.connectionField || part;
      
      const lookupAlias = currentPath ? `${currentPath}_${part}` : part;
      const localField = currentPath ? `${currentPath}.${connectionField}` : connectionField;
      
      aggregateClauses.push({
        $lookup: {
          from: collectionName,
          foreignField: '_id',
          localField,
          as: lookupAlias,
        },
      });
      
      aggregateClauses.push({
        $unwind: { path: `$${lookupAlias}`, preserveNullAndEmptyArrays: true },
      });
      
      currentPath = lookupAlias;
      currentGQLType = fieldType;
    } else if (fieldType instanceof GraphQLObjectType && 
               field.extensions && field.extensions.relation && 
               field.extensions.relation.embedded) {
      // Embedded object - just append to path
      currentPath = currentPath ? `${currentPath}.${part}` : part;
      currentGQLType = fieldType;
    } else {
      // Scalar field - final part of path
      if (part === 'id') {
        currentPath = currentPath ? `${currentPath}._id` : '_id';
      } else {
        currentPath = currentPath ? `${currentPath}.${part}` : part;
      }
    }
  }
  
  return { mongoPath: currentPath, lookups: aggregateClauses };
};

const buildAggregationQuery = async (input, gqltype, aggregationExpression) => {
  const aggregateClauses = [];
  const matchesClauses = { $match: {} };
  let addMatch = false;
  const aggregationsIncluded = {};
  const sortTerms = []; // Store multiple sort terms
  let limitClause = null;
  let skipClause = null;
  
  // Build filter and lookup clauses (similar to buildQuery)
  for (const [key, filterField] of Object.entries(input)) {
    if (Object.prototype.hasOwnProperty.call(input, key) && key !== 'pagination' && key !== 'sort' && key !== 'aggregation') {
      const qlField = gqltype.getFields()[key];
      
      const result = await buildQueryTerms(filterField, qlField, key);
      
      if (result) {
        for (const [prop, aggregate] of Object.entries(result.aggregateClauses)) {
          aggregateClauses.push(aggregate.lookup);
          aggregateClauses.push(aggregate.unwind);
          aggregationsIncluded[prop] = true;
        }
        
        for (const [matchClauseKey, matchClause] of Object.entries(result.matchesClauses)) {
          if (Object.prototype.hasOwnProperty.call(result.matchesClauses, matchClauseKey)) {
            for (const [matchKey, match] of Object.entries(matchClause)) {
              if (Object.prototype.hasOwnProperty.call(matchClause, matchKey)) {
                matchesClauses.$match[matchKey] = match;
                addMatch = true;
              }
            }
          }
        }
      }
    } else if (key === 'sort' && filterField && filterField.terms && filterField.terms.length > 0) {
      // Extract all sort terms
      filterField.terms.forEach(sortTerm => {
        sortTerms.push({
          field: sortTerm.field || 'groupId',
          direction: sortTerm.order === 'ASC' ? 1 : -1,
        });
      });
    } else if (key === 'pagination' && filterField) {
      // Handle pagination (ignore count parameter)
      if (filterField.page && filterField.size) {
        const skip = filterField.size * (filterField.page - 1);
        limitClause = { $limit: filterField.size + skip };
        skipClause = { $skip: skip };
      }
    }
  }
  
  if (addMatch) {
    aggregateClauses.push(matchesClauses);
  }
  
  // Now build the aggregation with $group
  const { groupId, facts } = aggregationExpression;
  
  // Resolve the groupId field path
  const groupIdPath = buildFieldPath(gqltype, groupId);
  
  // Add any lookups needed for the groupId field
  groupIdPath.lookups.forEach(lookup => {
    const lookupKey = Object.keys(lookup)[0];
    const lookupAlias = lookup[lookupKey].as;
    if (!aggregationsIncluded[lookupAlias]) {
      aggregateClauses.push(lookup);
      // Check if next item is an unwind for this lookup
      const unwindItem = groupIdPath.lookups[groupIdPath.lookups.indexOf(lookup) + 1];
      if (unwindItem && unwindItem.$unwind) {
        aggregateClauses.push(unwindItem);
      }
      aggregationsIncluded[lookupAlias] = true;
    }
  });
  
  // Build the $group stage
  const groupStage = {
    $group: {
      _id: `$${groupIdPath.mongoPath}`,
    },
  };
  
  // Add aggregation operations for each fact
  facts.forEach(fact => {
    const { operation, factName, path } = fact;
    const factPath = buildFieldPath(gqltype, path);
    
    // Add any lookups needed for the fact field
    factPath.lookups.forEach(lookup => {
      const lookupKey = Object.keys(lookup)[0];
      const lookupAlias = lookup[lookupKey].as;
      if (!aggregationsIncluded[lookupAlias]) {
        aggregateClauses.push(lookup);
        // Check if next item is an unwind for this lookup
        const unwindItem = factPath.lookups[factPath.lookups.indexOf(lookup) + 1];
        if (unwindItem && unwindItem.$unwind) {
          aggregateClauses.push(unwindItem);
        }
        aggregationsIncluded[lookupAlias] = true;
      }
    });
    
    // Map GraphQL operations to MongoDB aggregation operators
    let mongoOperation;
    switch (operation) {
      case 'SUM':
        mongoOperation = { $sum: `$${factPath.mongoPath}` };
        break;
      case 'COUNT':
        mongoOperation = { $sum: 1 };
        break;
      case 'AVG':
        mongoOperation = { $avg: `$${factPath.mongoPath}` };
        break;
      case 'MIN':
        mongoOperation = { $min: `$${factPath.mongoPath}` };
        break;
      case 'MAX':
        mongoOperation = { $max: `$${factPath.mongoPath}` };
        break;
      default:
        throw new Error(`Unknown aggregation operation: ${operation}`);
    }
    
    groupStage.$group[factName] = mongoOperation;
  });
  
  aggregateClauses.push(groupStage);
  
  // Add a final projection stage to format the output
  aggregateClauses.push({
    $project: {
      _id: 0,
      groupId: '$_id',
      facts: Object.fromEntries(facts.map(fact => [fact.factName, `$${fact.factName}`])),
    },
  });
  
  // Build sort object from multiple sort terms
  if (sortTerms.length > 0) {
    const sortObject = {};
    const factNames = facts.map(fact => fact.factName);
    
    sortTerms.forEach(sortTerm => {
      let sortFieldPath = 'groupId';
      
      if (sortTerm.field !== 'groupId') {
        // Check if the field is one of the fact names
        if (factNames.includes(sortTerm.field)) {
          sortFieldPath = `facts.${sortTerm.field}`;
        }
        // If not found, default to groupId (already set)
      }
      
      sortObject[sortFieldPath] = sortTerm.direction;
    });
    
    // Add sort stage with all sort fields
    aggregateClauses.push({
      $sort: sortObject,
    });
  } else {
    // Default sort by groupId ascending if no sort terms provided
    aggregateClauses.push({
      $sort: { groupId: 1 },
    });
  }
  
  // Add pagination if provided
  if (limitClause) {
    aggregateClauses.push(limitClause);
  }
  if (skipClause) {
    aggregateClauses.push(skipClause);
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
        // Fixing resolve method in order to be compliant with Mongo _id field
        if (type.gqltype.getFields().id && !type.gqltype.getFields().id.resolve) {
          type.gqltype.getFields().id.resolve = (parent) => parent._id;
        }

        rootQueryArgs.fields[type.simpleEntityEndpointName] = {
          type: type.gqltype,
          args: { id: { type: GraphQLID } },
          async resolve(parent, args, context) {
            /* Here we define how to get data from database source
            this will return the type with id passed in argument
            by the user */
            const params = {
              type,
              args,
              operation: 'get_by_id',
              context,
            };
            excecuteMiddleware(params);
            
            // Check if scope is defined for get_by_id
            const hasScope = type.gqltype.extensions && type.gqltype.extensions.scope && type.gqltype.extensions.scope.get_by_id;
            
            if (hasScope) {
              // Build query args with id filter - scope function will modify this
              const queryArgs = {
                id: { operator: 'EQ', value: args.id },
              };
              
              // Create temporary params with queryArgs for scope function
              const scopeParams = {
                type,
                args: queryArgs,
                operation: 'get_by_id',
                context,
              };
              
              // Execute scope which will modify queryArgs in place
              await executeScope(scopeParams);
              
              // Build aggregation pipeline from the combined filters
              const aggregateClauses = await buildQuery(queryArgs, type.gqltype);
              
              // Execute the query and get the first result
              let result;
              if (aggregateClauses.length === 0) {
                result = await type.model.findOne({ _id: args.id });
              } else {
                const results = await type.model.aggregate(aggregateClauses);
                result = results.length > 0 ? results[0] : null;
              }
              
              return result;
            } else {
              // No scope defined, use the original findById
              return await type.model.findById(args.id);
            }
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
            excecuteMiddleware(params);
            await executeScope(params);
            const aggregateClauses = await buildQuery(args, type.gqltype);
            if (args.pagination && args.pagination.count) {
              const aggregateClausesForCount = await buildQuery(args, type.gqltype, true);
              const resultCount = await type.model.aggregate(aggregateClausesForCount);
              context.count = resultCount[0] ? resultCount[0].size : 0;
            }

            let result;
            if (aggregateClauses.length === 0) {
              result = await type.model.find({});
            } else {
              result = await type.model.aggregate(aggregateClauses);
            }
            return result;
          },
        };

        // Add aggregate endpoint
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
            excecuteMiddleware(params);
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

/* Creating a new GraphQL Schema, with options query which defines query
we will allow users to use when they are making request. */
export const createSchema = (includedQueryTypes,
  includedMutationTypes, includedCustomMutations) => {
  
  // Generate models for all registered types now that all types are available
  Object.values(typesDict.types).forEach(typeInfo => {
    if (typeInfo.gqltype && !typeInfo.model) {
      if (typeInfo.endpoint) {
        // Generate model with collection for endpoint types (types registered with connect)
        typeInfo.model = generateModel(typeInfo.gqltype, typeInfo.onModelCreated);
      } else if (typeInfo.needsModel) {
        // Generate model without collection for no-endpoint types that need models (addNoEndpointType)
        typeInfo.model = generateModelWithoutCollection(typeInfo.gqltype, null);
      }
    }
  });

  // Also update the typesDictForUpdate with the generated models
  Object.keys(typesDict.types).forEach(typeName => {
    if (typesDictForUpdate.types[typeName]) {
      typesDictForUpdate.types[typeName].model = typesDict.types[typeName].model;
    }
  });

  // Auto-generate resolvers for all registered types now that all types are available
  Object.values(typesDict.types).forEach(typeInfo => {
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
  // If it's already a GraphQL type object, get by its name
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
    // Skip if resolve method already exists
    if (!fieldEntry.resolve) {
      // Check if field has relation extension
      if (fieldEntry.extensions && fieldEntry.extensions.relation) {
        const { relation } = fieldEntry.extensions;

        // Only generate resolvers for non-embedded relationships
        if (!relation.embedded) {
          if (fieldEntry.type instanceof GraphQLList) {
            // Collection field - generate resolve for one-to-many relationship
            //This is a one-to-many resolver that will return a list of related objects. Also this one allows to filter the related objects as is in the find endpoint.
            const relatedType = fieldEntry.type.ofType;
            const connectionField = relation.connectionField || fieldName;
            const relatedTypeInfo = typesDict.types[relatedType.name];
            const argsObject = createArgsForQuery(relatedTypeInfo.gqltype.getFields());
            
            delete argsObject[connectionField];
            const argsArray = Object.entries(argsObject);
            

            const graphqlArgs = formatArgs(argsArray);

            fieldEntry.args = graphqlArgs;

            fieldEntry.resolve = async (parent, args) => {
              // Lazy lookup of the related model
              
              if (!relatedTypeInfo || !relatedTypeInfo.model) {
                throw new Error(`Related type ${relatedType.name} not found or not connected. Make sure it's connected with simfinity.connect() or simfinity.addNoEndpointType().`);
              }
              
              args[connectionField] = {
                  terms: [{
                  path: 'id',
                  operator: 'EQ',
                  value: parent.id || parent._id,
                }],
              };
            

              const aggregateClauses = await buildQuery(args, relatedTypeInfo.gqltype);
              
              return await relatedTypeInfo.model.aggregate(aggregateClauses);
            };
          } else if (fieldEntry.type instanceof GraphQLObjectType
                     || (fieldEntry.type instanceof GraphQLNonNull && fieldEntry.type.ofType instanceof GraphQLObjectType)) {
            // Single object field - generate resolve for one-to-one relationship
            const relatedType = fieldEntry.type instanceof GraphQLNonNull ? fieldEntry.type.ofType : fieldEntry.type;
            const connectionField = relation.connectionField || fieldName;

            fieldEntry.resolve = async (parent) => {
              // Lazy lookup of the related model
              const relatedTypeInfo = typesDict.types[relatedType.name];
              if (!relatedTypeInfo || !relatedTypeInfo.model) {
                throw new Error(`Related type ${relatedType.name} not found or not connected. Make sure it's connected with simfinity.connect() or simfinity.addNoEndpointType().`);
              }
              const relatedId = parent[connectionField] || parent[fieldName];
              return relatedId ? await relatedTypeInfo.model.findById(relatedId) : null;
            };
          }
        }
      }
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
    model: model, // Will be generated later in createSchema if not provided
    gqltype,
    simpleEntityEndpointName,
    listEntitiesEndpointName,
    endpoint: true,
    controller,
    stateMachine,
    onModelCreated, // Store the callback for later use
  };

  typesDictForUpdate.types[gqltype.name] = { ...typesDict.types[gqltype.name] };
};

export const addNoEndpointType = (gqltype) => {
  waitingInputType[gqltype.name] = {
    gqltype,
  };

  // Check if this type has relationship fields that might need a model
  const fields = gqltype.getFields();
  let needsModel = false;

  for (const [, fieldEntry] of Object.entries(fields)) {
    if (fieldEntry.extensions && fieldEntry.extensions.relation
        && (fieldEntry.type instanceof GraphQLObjectType || fieldEntry.type instanceof GraphQLList
            || (fieldEntry.type instanceof GraphQLNonNull && fieldEntry.type.ofType instanceof GraphQLObjectType))) {
      needsModel = true;
      break;
    }
  }

  typesDict.types[gqltype.name] = {
    gqltype,
    endpoint: false,
    // Model will be generated later in createSchema if needed
    model: null,
    needsModel, // Store whether this type needs a model
  };

  typesDictForUpdate.types[gqltype.name] = { ...typesDict.types[gqltype.name] };
};

export { createValidatedScalar };

export { default as validators } from './validators.js';
export { default as scalars } from './scalars.js';
export { default as plugins } from './plugins.js';
export { default as auth } from './auth/index.js';

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