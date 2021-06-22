const graphql = require('graphql');
const mongoose = require('mongoose');

const SimfinityError = require('./errors/simfinity.error');
const InternalServerError = require('./errors/internal-server.error');
const QLOperator = require('./const/QLOperator');
const QLValue = require('./const/QLValue');
const QLSort = require('./const/QLSort');

mongoose.set('useFindAndModify', false);

const {
  GraphQLObjectType, GraphQLString, GraphQLID, GraphQLSchema, GraphQLList,
  GraphQLNonNull, GraphQLInputObjectType, GraphQLScalarType, __Field,
  GraphQLInt, GraphQLEnumType, GraphQLBoolean, GraphQLFloat,
} = graphql;

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

module.exports.use = (middleware) => {
  middlewares.push(middleware);
};

module.exports.buildErrorFormatter = buildErrorFormatter;

module.exports.SimfinityError = SimfinityError;

module.exports.InternalServerError = InternalServerError;

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

const isGraphQLisoDate = (typeName) => typeName === 'DateTime' || typeName === 'Date' || typeName === 'Time';

const createOneToManyInputType = (inputNamePrefix, fieldEntryName,
  inputType, updateInputType) => new GraphQLInputObjectType({
  name: `OneToMany${inputNamePrefix}${fieldEntryName}`,
  fields: () => ({
    added: { type: new GraphQLList(inputType) },
    updated: { type: new GraphQLList(updateInputType) },
    deleted: { type: new GraphQLList(GraphQLID) },
  }),
});

const graphQLListInputType = (dict, fieldEntry, fieldEntryName, inputNamePrefix) => {
  const { ofType } = fieldEntry.type;

  if (ofType instanceof GraphQLObjectType && dict.types[ofType.name].inputType) {
    if (!fieldEntry.extensions || !fieldEntry.extensions.relation
      || !fieldEntry.extensions.relation.embedded) {
      const oneToMany = createOneToManyInputType(inputNamePrefix, fieldEntryName,
        typesDict.types[ofType.name].inputType, typesDictForUpdate.types[ofType.name].inputType);
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
          || isNonNullOfType(fieldEntry.type, GraphQLEnumType)
        ) {
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
            const listInputTypeForAdd = graphQLListInputType(typesDict, fieldEntry, fieldEntryName, 'A');
            const listInputTypeForUpdate = graphQLListInputType(typesDictForUpdate, fieldEntry, fieldEntryName, 'U');
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
        type: createOneToManyInputType('A', fieldEntryName, inputTypeForAdd, inputTypeForUpdate),
        name: fieldEntryName,
      };
    }
  });

  inputTypeForAdd._fields = () => inputTypeForAddFields;

  const inputTypeForUpdateFields = inputTypeForUpdate._fields();

  Object.keys(selfReferenceCollections).forEach((fieldEntryName) => {
    if (Object.prototype.hasOwnProperty.call(selfReferenceCollections, fieldEntryName)) {
      inputTypeForUpdateFields[fieldEntryName] = {
        type: createOneToManyInputType('U', fieldEntryName, inputTypeForAdd, inputTypeForUpdate),
        name: fieldEntryName,
      };
    }
  });

  inputTypeForUpdate._fields = () => inputTypeForUpdateFields;

  return { inputTypeBody: inputTypeForAdd, inputTypeBodyForUpdate: inputTypeForUpdate };
};

const getInputType = (type) => typesDict.types[type.name].inputType;

module.exports.getInputType = getInputType;

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

const iterateonCollectionFields = async (materializedModel, gqltype, objectId, session) => {
  for (const [collectionFieldKey, collectionField] of
    Object.entries(materializedModel.collectionFields)) {
    if (collectionField.added) {
      // eslint-disable-next-line no-use-before-define
      await executeItemFunction(gqltype, collectionFieldKey, objectId, session,
        collectionField.added, operations.SAVE);
    }
    if (collectionField.updated) {
      // eslint-disable-next-line no-use-before-define
      await executeItemFunction(gqltype, collectionFieldKey, objectId, session,
        collectionField.updated, operations.UPDATE);
    }
    if (collectionField.deleted) {
      // eslint-disable-next-line no-use-before-define
      await executeItemFunction(gqltype, collectionFieldKey, objectId, session,
        collectionField.deleted, operations.DELETE);
    }
  }
};

const onDeleteObject = async (Model, gqltype, controller, args, session, linkToParent) => {
  const result = await materializeModel(args, gqltype, linkToParent, 'DELETE', session);
  const deletedObject = new Model(result.modelArgs);

  if (controller && controller.onDelete) {
    await controller.onDelete(deletedObject, session);
  }

  return Model.findByIdAndDelete(args, deletedObject.modelArgs).session(session);
};

const onUpdateSubject = async (Model, gqltype, controller, args, session, linkToParent) => {
  const materializedModel = await materializeModel(args, gqltype, linkToParent, 'UPDATE', session);
  const objectId = args.id;

  if (materializedModel.collectionFields) {
    await iterateonCollectionFields(materializedModel, gqltype, objectId, session);
  }

  let modifiedObject = materializedModel.modelArgs;
  const currentObject = await Model.findById({ _id: objectId }).lean();

  const argTypes = gqltype.getFields();

  Object.entries(argTypes).forEach(([fieldEntryName, fieldEntry]) => {
    if (fieldEntry.extensions && fieldEntry.extensions.relation
      && fieldEntry.extensions.relation.embedded) {
      const oldObjectData = currentObject[fieldEntryName];
      const newObjectData = modifiedObject[fieldEntryName];
      if (newObjectData) {
        if (Array.isArray(oldObjectData) && Array.isArray(newObjectData)) {
          modifiedObject[fieldEntryName] = newObjectData;
        } else {
          modifiedObject[fieldEntryName] = { ...oldObjectData, ...newObjectData };
        }
      }
    }

    if (args[fieldEntryName] === null
      && !(fieldEntry.type instanceof GraphQLNonNull)) {
      modifiedObject = { ...modifiedObject, $unset: { [fieldEntryName]: '' } };
    }
  });

  if (controller && controller.onUpdating) {
    await controller.onUpdating(objectId, modifiedObject, args, session);
  }

  const result = Model.findByIdAndUpdate(
    objectId, modifiedObject, { new: true },
  );

  if (controller && controller.onUpdated) {
    await controller.onUpdated(result, args, session);
  }

  return result;
};

const onStateChanged = async (Model, gqltype, controller, args, session, actionField) => {
  const storedModel = await Model.findById(args.id);
  if (!storedModel) {
    throw new SimfinityError(`${gqltype.name} ${args.id} is not valid`, 'NOT_VALID_ID', 404);
  }
  if (storedModel.state === actionField.from.name) {
    if (actionField.action) {
      await actionField.action(args, session);
    }

    args.state = actionField.to.name;
    let result = await onUpdateSubject(Model, gqltype, controller, args, session);
    result = result.toObject();
    result.state = actionField.to.value;
    return result;
  }
  throw new SimfinityError(`Action is not allowed from state ${storedModel.state}`, 'BAD_REQUEST', 400);
};

const onSaveObject = async (Model, gqltype, controller, args, session, linkToParent) => {
  const materializedModel = await materializeModel(args, gqltype, linkToParent, 'CREATE', session);
  if (typesDict.types[gqltype.name].stateMachine) {
    materializedModel.modelArgs.state = typesDict.types[gqltype.name]
      .stateMachine.initialState.name;
  }

  const newObject = new Model(materializedModel.modelArgs);
  console.log(JSON.stringify(newObject));
  newObject.$session(session);

  if (controller && controller.onSaving) {
    await controller.onSaving(newObject, args, session);
  }

  if (materializedModel.collectionFields) {
    await iterateonCollectionFields(materializedModel, gqltype, newObject._id, session);
  }

  let result = await newObject.save();
  result = result.toObject();
  if (controller && controller.onSaved) {
    await controller.onSaved(result, args, session);
  }
  if (typesDict.types[gqltype.name].stateMachine) {
    result.state = typesDict.types[gqltype.name].stateMachine.initialState.value;
  }
  return result;
};

module.exports.saveObject = async (typeName, args, session) => {
  const type = typesDict.types[typeName];
  return onSaveObject(type.model, type.gqltype, type.controller, args, session);
};

const executeOperation = async (Model, gqltype, controller,
  args, operation, actionField, session) => {
  const mySession = session || await mongoose.startSession();
  await mySession.startTransaction();
  try {
    let newObject = null;
    switch (operation) {
      case operations.SAVE:
        newObject = await onSaveObject(Model, gqltype, controller, args, mySession);
        break;
      case operations.UPDATE:
        newObject = await onUpdateSubject(Model, gqltype, controller, args, mySession);
        break;
      case operations.DELETE:
        newObject = await onDeleteObject(Model, gqltype, controller, args, mySession);
        break;
      case operations.STATE_CHANGED:
        newObject = await onStateChanged(Model, gqltype, controller, args, mySession, actionField);
        break;
    }
    await mySession.commitTransaction();
    mySession.endSession();
    return newObject;
  } catch (error) {
    await mySession.abortTransaction();
    if (error.errorLabels && error.errorLabels.includes('TransientTransactionError')) {
      return executeOperation(Model, gqltype, controller, args, operation, actionField, mySession);
    }
    mySession.endSession();
    throw error;
  }
};

const executeItemFunction = async (gqltype, collectionField, objectId, session,
  collectionFieldsList, operationType) => {
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
          });
      };
      break;
    case operations.UPDATE:
      operationFunction = async (collectionItem) => {
        await onUpdateSubject(typesDict.types[collectionGQLType.name].model, collectionGQLType,
          typesDict.types[collectionGQLType.name].controller, collectionItem, session, (item) => {
            item[connectionField] = objectId;
          });
      };
      break;
    case operations.DELETE:
    // TODO: implement
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
              args.input, operations.SAVE);
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
              args.id, operations.DELETE);
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
              args.input, operations.UPDATE);
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
                    args.input, operations.STATE_CHANGED, actionField);
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
    if (fieldEntry.type === GraphQLID || isNonNullOfTypeForNotScalar(fieldEntry.type, GraphQLID)) {
      schemaArg[fieldEntryName] = mongoose.Schema.Types.ObjectId;
    } else if (fieldEntry.type === GraphQLString
      || isNonNullOfTypeForNotScalar(fieldEntry.type, GraphQLString)) {
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
      || isNonNullOfTypeForNotScalar(fieldEntry.type, GraphQLInt)) {
      if (fieldEntry.extensions && fieldEntry.extensions.unique) {
        schemaArg[fieldEntryName] = { type: Number, unique: true };
      } else {
        schemaArg[fieldEntryName] = Number;
      }
    } else if (fieldEntry.type === GraphQLFloat
      || isNonNullOfTypeForNotScalar(fieldEntry.type, GraphQLFloat)) {
      if (fieldEntry.extensions && fieldEntry.extensions.unique) {
        schemaArg[fieldEntryName] = { type: Number, unique: true };
      } else {
        schemaArg[fieldEntryName] = Number;
      }
    } else if (fieldEntry.type === GraphQLBoolean
      || isNonNullOfTypeForNotScalar(fieldEntry.type, GraphQLBoolean)) {
      schemaArg[fieldEntryName] = Boolean;
    } else if (fieldEntry.type instanceof GraphQLObjectType
      || isNonNullOfType(fieldEntry.type, GraphQLObjectType)) {
      if (fieldEntry.extensions && fieldEntry.extensions.relation) {
        if (!fieldEntry.extensions.relation.embedded) {
          schemaArg[fieldEntry.extensions.relation.connectionField] = mongoose
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
        || fieldEntry.type.ofType instanceof GraphQLEnumType) {
        schemaArg[fieldEntryName] = [String];
      } else if (fieldEntry.type.ofType === GraphQLBoolean) {
        schemaArg[fieldEntryName] = [Boolean];
      } else if (fieldEntry.type.ofType === GraphQLInt || fieldEntry.type.ofType === GraphQLFloat) {
        schemaArg[fieldEntryName] = [Number];
      } else if (isGraphQLisoDate(fieldEntry.type.ofType.name)) {
        schemaArg[fieldEntryName] = [Date];
      }
    } else if (isGraphQLisoDate(fieldEntry.type.name)
    || (fieldEntry.type instanceof GraphQLNonNull && isGraphQLisoDate(fieldEntry.type.ofType.name))) {
      schemaArg[fieldEntryName] = Date;
    }
  }

  return schemaArg;
};

const generateModel = (gqlType, onModelCreated) => {
  const model = mongoose.model(gqlType.name, generateSchemaDefinition(gqlType), gqlType.name);
  if (onModelCreated) {
    onModelCreated(model);
  }
  model.createCollection();
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
    const fieldTypeName = fieldType instanceof GraphQLNonNull ? fieldType.ofType.name : fieldType.name;
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
        const localFieldName = qlField.extensions.relation.connectionField;
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
        const typeName = type instanceof GraphQLNonNull ? type.ofType.name : type.name;
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
            const typeName = pathField.type instanceof GraphQLNonNull ? pathField.type.ofType.name : pathField.type.name;
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
              const pathLocalFieldName = pathField.extensions.relation.connectionField;

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
  console.log('Building Query');
  const aggregateClauses = [];
  const matchesClauses = { $match: {} };
  let addMatch = false;
  let limitClause = { $limit: 100 };
  let skipClause = { $skip: 0 };
  let sortClause = {};
  let addSort = false;

  for (const [key, filterField] of Object.entries(input)) {
    if (Object.prototype.hasOwnProperty.call(input, key) && key !== 'pagination' && key !== 'sort') {
      const qlField = gqltype.getFields()[key];

      const result = await buildQueryTerms(filterField, qlField, key);

      if (result) {
        Object.values(result.aggregateClauses).forEach((aggregate) => {
          aggregateClauses.push(aggregate.lookup);
          aggregateClauses.push(aggregate.unwind);
        });

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
        console.log(sort);
        sortExpressions[sort.field] = sort.order === 'ASC' ? 1 : -1;
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
          resolve(parent, args, context) {
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
            return type.model.findById(args.id);
          },
        };

        const argTypes = type.gqltype.getFields();

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
            const aggregateClauses = await buildQuery(args, type.gqltype);

            if (args.pagination && args.pagination.count) {
              const aggregateClausesForCount = await buildQuery(args, type.gqltype, true);
              const resultCount = await type.model.aggregate(aggregateClausesForCount);
              context.count = resultCount[0] ? resultCount[0].size : 0;
            }

            let result;
            if (aggregateClauses.length === 0) {
              result = type.model.find({});
            } else {
              result = type.model.aggregate(aggregateClauses);
            }
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
module.exports.createSchema = (includedQueryTypes,
  includedMutationTypes, includedCustomMutations) => new GraphQLSchema({
  query: buildRootQuery('RootQueryType', includedQueryTypes),
  mutation: buildMutation('Mutation', includedMutationTypes, includedCustomMutations),
});

module.exports.getModel = (gqltype) => typesDict.types[gqltype.name].model;

module.exports.registerMutation = (name, description, inputModel, outputModel, callback) => {
  registeredMutations[name] = {
    description,
    inputModel,
    outputModel,
    callback,
  };
};

module.exports.connect = (model, gqltype, simpleEntityEndpointName,
  listEntitiesEndpointName, controller, onModelCreated, stateMachine) => {
  waitingInputType[gqltype.name] = {
    model,
    gqltype,
  };
  typesDict.types[gqltype.name] = {
    model: model || generateModel(gqltype, onModelCreated),
    gqltype,
    simpleEntityEndpointName,
    listEntitiesEndpointName,
    endpoint: true,
    controller,
    stateMachine,
  };

  typesDictForUpdate.types[gqltype.name] = { ...typesDict.types[gqltype.name] };
};

module.exports.addNoEndpointType = (gqltype) => {
  waitingInputType[gqltype.name] = {
    gqltype,
  };

  typesDict.types[gqltype.name] = {
    gqltype,
    endpoint: false,
  };

  typesDictForUpdate.types[gqltype.name] = { ...typesDict.types[gqltype.name] };
};
