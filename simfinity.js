const graphql = require('graphql')
const mongoose = require('mongoose')
mongoose.set('useFindAndModify', false)

const {
  GraphQLObjectType, GraphQLString, GraphQLID, GraphQLSchema, GraphQLList,
  GraphQLNonNull, GraphQLInputObjectType, GraphQLScalarType, Kind,
  GraphQLInt, GraphQLEnumType, GraphQLBoolean, GraphQLFloat
} = graphql

const operations = {
  SAVE: 'save',
  UPDATE: 'update',
  DELETE: 'delete',
  STATE_CHANGED: 'state_changed'
}

class SimfinityError extends Error {
  constructor (message, code, status) {
    super(message)
    this.extensions = {
      code: code,
      status: status,
      timestamp: new Date().toUTCString()
    }
    this.getCode = () => this.extensions.code
    this.getStatus = () => this.extensions.status
    this.getTimestamp = () => this.extensions.timestamp
  }
}

class InternalServerError extends SimfinityError {
  constructor (message, cause) {
    super(message, 'INTERNAL_SERVER_ERROR')
    this.cause = cause
    this.getCause = () => this.cause
  }
}

const buildErrorFormatter = (callback) => {
  const formatError = function (err) {
    let result = null
    if (err instanceof SimfinityError) {
      result = err
    } else {
      result = new InternalServerError(err.message, err)
    }

    if (callback) {
      const formattedError = callback(result)
      return formattedError || result
    }
    return result
  }
  return formatError
}

module.exports.buildErrorFormatter = buildErrorFormatter

module.exports.SimfinityError = SimfinityError

module.exports.InternalServerError = InternalServerError

/* Schema defines data on the Graph like object types(book type), relation between
these object types and describes how it can reach into the graph to interact with
the data to retrieve or mutate the data */
const QLFilter = new GraphQLInputObjectType({
  name: 'QLFilter',
  fields: () => ({
    operator: { type: QLOperator },
    value: { type: QLValue }
  })
})

const QLValue = new GraphQLScalarType({
  name: 'QLValue',
  serialize: parseQLValue,
  parseValue: parseQLValue,
  parseLiteral (ast) {
    if (ast.kind === Kind.INT) {
      return parseInt(ast.value, 10)
    } else if (ast.kind === Kind.FLOAT) {
      return parseFloat(ast.value)
    } else if (ast.kind === Kind.BOOLEAN) {
      return ast.value === 'true' || ast.value === true
    } else if (ast.kind === Kind.STRING) {
      return ast.value
    } else if (ast.kind === Kind.LIST) {
      const values = []
      ast.values.forEach(value => {
        if (value.kind === Kind.INT) {
          values.push(parseInt(value.value, 10))
        } else if (value.kind === Kind.FLOAT) {
          values.push(parseFloat(value.value))
        } else if (value.kind === Kind.BOOLEAN) {
          values.push(value.value === 'true' || value.value === true)
        } else if (value.kind === Kind.STRING) {
          values.push(value.value)
        }
      })
      return values
    }
    return null
  }
})

function parseQLValue (value) {
  return value
}

const QLTypeFilter = new GraphQLInputObjectType({
  name: 'QLTypeFilter',
  fields: () => ({
    operator: { type: QLOperator },
    value: { type: QLValue },
    path: { type: GraphQLString }
  })
})

const IdInputType = new GraphQLInputObjectType({
  name: 'IdInputType',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLString) }
  })
})

const QLTypeFilterExpression = new GraphQLInputObjectType({
  name: 'QLTypeFilterExpression',
  fields: () => ({
    terms: { type: new GraphQLList(QLTypeFilter) }
  })
})

const QLPagination = new GraphQLInputObjectType({
  name: 'QLPagination',
  fields: () => ({
    page: { type: new GraphQLNonNull(GraphQLInt) },
    size: { type: new GraphQLNonNull(GraphQLInt) }
  })
})

const QLSortExpression = new GraphQLInputObjectType({
  name: 'QLSortExpression',
  fields: () => ({
    terms: { type: new GraphQLList(QLSort) }
  })
})

const QLSort = new GraphQLInputObjectType({
  name: 'QLSort',
  fields: () => ({
    field: { type: new GraphQLNonNull(GraphQLString) },
    order: { type: new GraphQLNonNull(QLSortOrder) }
  })
})

const QLSortOrder = new GraphQLEnumType({
  name: 'QLSortOrder',
  values: {
    DESC: {
      value: 'DESC'
    },
    ASC: {
      value: 'ASC'
    }
  }
})

const QLOperator = new GraphQLEnumType({
  name: 'QLOperator',
  values: {
    EQ: {
      value: 'EQ'
    },
    LT: {
      value: 'LT'
    },
    GT: {
      value: 'GT'
    },
    LTE: {
      value: 'LTE'
    },
    GTE: {
      value: 'GTE'
    },
    BTW: {
      value: 'BTW'
    },
    NE: {
      value: 'NE'
    },
    IN: {
      value: 'IN'
    },
    NIN: {
      value: 'NIN'
    },
    LIKE: {
      value: 'LIKE'
    }
  }
})

const isNonNullOfType = function (fieldEntryType, graphQLType) {
  let isOfType = false
  if (fieldEntryType instanceof GraphQLNonNull) {
    isOfType = fieldEntryType.ofType instanceof graphQLType
  }
  return isOfType
}

const isNonNullOfTypeForNotScalar = function (fieldEntryType, graphQLType) {
  let isOfType = false
  if (fieldEntryType instanceof GraphQLNonNull) {
    isOfType = fieldEntryType.ofType === graphQLType
  }
  return isOfType
}

const buildInputType = function (gqltype) {
  const argTypes = gqltype.getFields()

  const fieldsArgs = {}
  const fieldsArgForUpdate = {}

  const selfReferenceCollections = {}

  for (const fieldEntryName in argTypes) {
    const fieldEntry = argTypes[fieldEntryName]
    const fieldArg = {}
    const fieldArgForUpdate = {}

    if (fieldEntry.extensions && fieldEntry.extensions.readOnly) {
      continue
    }

    const hasStateMachine = !!typesDict.types[gqltype.name].stateMachine
    const doesEstateFieldExistButIsManagedByStateMachine = !!(fieldEntryName === 'state' && hasStateMachine)
    if (doesEstateFieldExistButIsManagedByStateMachine) {
      // state field should not be controlled by the insert or update
      continue
    }

    if (fieldEntry.type instanceof GraphQLScalarType || fieldEntry.type instanceof GraphQLEnumType ||
      isNonNullOfType(fieldEntry.type, GraphQLScalarType) || isNonNullOfType(fieldEntry.type, GraphQLEnumType)
    ) {
      if (fieldEntryName !== 'id') {
        fieldArg.type = fieldEntry.type
      }
      fieldArgForUpdate.type = fieldEntry.type instanceof GraphQLNonNull ? fieldEntry.type.ofType : fieldEntry.type
      if (fieldEntry.type === GraphQLID) {
        fieldArgForUpdate.type = new GraphQLNonNull(GraphQLID)
      }
    } else if (fieldEntry.type instanceof GraphQLObjectType || isNonNullOfType(fieldEntry.type, GraphQLObjectType)) {
      if (fieldEntry.extensions && fieldEntry.extensions.relation) {
        const fieldEntryName = fieldEntry.type instanceof GraphQLNonNull ? fieldEntry.type.ofType.name : fieldEntry.type.name
        if (!fieldEntry.extensions.relation.embedded) {
          fieldArg.type = fieldEntry.type instanceof GraphQLNonNull ? new GraphQLNonNull(IdInputType) : IdInputType
          fieldArgForUpdate.type = IdInputType
        } else if (typesDict.types[fieldEntryName].inputType && typesDictForUpdate.types[fieldEntryName].inputType) {
          fieldArg.type = typesDict.types[fieldEntryName].inputType
          fieldArgForUpdate.type = typesDictForUpdate.types[fieldEntryName].inputType
        } else {
          return null
        }
      } else {
        console.warn('Configuration issue: Field ' + fieldEntryName + ' does not define extensions.relation')
      }
    } else if (fieldEntry.type instanceof GraphQLList) {
      if (fieldEntry.type.ofType === gqltype) {
        selfReferenceCollections[fieldEntryName] = fieldEntry
      } else {
        const listInputTypeForAdd = graphQLListInputType(typesDict, fieldEntry, fieldEntryName, 'A')
        const listInputTypeForUpdate = graphQLListInputType(typesDictForUpdate, fieldEntry, fieldEntryName, 'U')
        if (listInputTypeForAdd && listInputTypeForUpdate) {
          fieldArg.type = listInputTypeForAdd
          fieldArgForUpdate.type = listInputTypeForUpdate
        } else {
          return null
        }
      }
    }

    fieldArg.description = fieldEntry.description
    fieldArgForUpdate.description = fieldEntry.description

    if (fieldArg.type) {
      fieldsArgs[fieldEntryName] = fieldArg
    }

    if (fieldArgForUpdate.type) {
      fieldsArgForUpdate[fieldEntryName] = fieldArgForUpdate
    }
  }

  const inputTypeBody = {
    name: gqltype.name + 'Input',
    fields: fieldsArgs
  }

  const inputTypeBodyForUpdate = {
    name: gqltype.name + 'InputForUpdate',
    fields: fieldsArgForUpdate
  }

  const inputTypeForAdd = new GraphQLInputObjectType(inputTypeBody)
  const inputTypeForUpdate = new GraphQLInputObjectType(inputTypeBodyForUpdate)

  const inputTypeForAddFields = inputTypeForAdd._fields()

  for (const fieldEntryName in selfReferenceCollections) {
    if (Object.prototype.hasOwnProperty.call(selfReferenceCollections, fieldEntryName)) {
      inputTypeForAddFields[fieldEntryName] = {
        type: createOneToManyInputType('A', fieldEntryName, inputTypeForAdd, inputTypeForUpdate),
        name: fieldEntryName
      }
    }
  }

  inputTypeForAdd._fields = () => inputTypeForAddFields

  const inputTypeForUpdateFields = inputTypeForUpdate._fields()

  for (const fieldEntryName in selfReferenceCollections) {
    if (Object.prototype.hasOwnProperty.call(selfReferenceCollections, fieldEntryName)) {
      inputTypeForUpdateFields[fieldEntryName] = {
        type: createOneToManyInputType('U', fieldEntryName, inputTypeForAdd, inputTypeForUpdate),
        name: fieldEntryName
      }
    }
  }

  inputTypeForUpdate._fields = () => inputTypeForUpdateFields

  return { inputTypeBody: inputTypeForAdd, inputTypeBodyForUpdate: inputTypeForUpdate }
}

const getInputType = function (type) {
  return typesDict.types[type.name].inputType
}
module.exports.getInputType = getInputType

const createOneToManyInputType = function (inputNamePrefix, fieldEntryName, inputType, updateInputType) {
  return new GraphQLInputObjectType({
    name: 'OneToMany' + inputNamePrefix + fieldEntryName,
    fields: () => ({
      added: { type: new GraphQLList(inputType) },
      updated: { type: new GraphQLList(updateInputType) },
      deleted: { type: new GraphQLList(GraphQLID) }
    })
  })
}

const graphQLListInputType = function (dict, fieldEntry, fieldEntryName, inputNamePrefix) {
  const ofType = fieldEntry.type.ofType

  if (ofType instanceof GraphQLObjectType && dict.types[ofType.name].inputType) {
    if (!fieldEntry.extensions || !fieldEntry.extensions.relation || !fieldEntry.extensions.relation.embedded) {
      const oneToMany = createOneToManyInputType(inputNamePrefix, fieldEntryName, typesDict.types[ofType.name].inputType, typesDictForUpdate.types[ofType.name].inputType)
      return oneToMany
    } else if (fieldEntry.extensions && fieldEntry.extensions.relation && fieldEntry.extensions.relation.embedded) {
      return new GraphQLList(dict.types[ofType.name].inputType)
    }
  } else if (ofType instanceof GraphQLScalarType || ofType instanceof GraphQLEnumType) {
    return new GraphQLList(ofType)
  } else {
    return null
  }
}

const buildPendingInputTypes = function (waitingInputType) {
  const stillWaitingInputType = {}
  let isThereAtLeastOneWaiting = false

  for (const pendingInputTypeName in waitingInputType) {
    const gqltype = waitingInputType[pendingInputTypeName].gqltype

    if (typesDict.types[gqltype.name].inputType) {
      continue
    }

    const buildInputTypeResult = buildInputType(gqltype)

    if (buildInputTypeResult && buildInputTypeResult.inputTypeBody && buildInputTypeResult.inputTypeBodyForUpdate) {
      typesDict.types[gqltype.name].inputType = buildInputTypeResult.inputTypeBody
      typesDictForUpdate.types[gqltype.name].inputType = buildInputTypeResult.inputTypeBodyForUpdate
    } else {
      stillWaitingInputType[pendingInputTypeName] = waitingInputType[pendingInputTypeName]
      isThereAtLeastOneWaiting = true
    }
  }

  if (isThereAtLeastOneWaiting) {
    buildPendingInputTypes(stillWaitingInputType)
  }
}

const buildRootQuery = function (name, includedTypes) {
  const rootQueryArgs = {}
  rootQueryArgs.name = name
  rootQueryArgs.fields = {}

  for (const entry in typesDict.types) {
    const type = typesDict.types[entry]

    if (shouldNotBeIncludedInSchema(includedTypes, type.gqltype)) {
      continue
    }

    const wasAddedAsNoEnpointType = !type.simpleEntityEndpointName
    if (wasAddedAsNoEnpointType) {
      continue
    }

    // Fixing resolve method in order to be compliant with Mongo _id field
    if (type.gqltype.getFields().id && !type.gqltype.getFields().id.resolve) {
      type.gqltype.getFields().id.resolve = parent => parent._id
    }

    rootQueryArgs.fields[type.simpleEntityEndpointName] = {
      type: type.gqltype,
      args: { id: { type: GraphQLID } },
      resolve (parent, args) {
        /* Here we define how to get data from database source
        this will return the type with id passed in argument
        by the user */
        return type.model.findById(args.id)
      }
    }

    const argTypes = type.gqltype.getFields()

    const argsObject = {}

    for (const fieldEntryName in argTypes) {
      const fieldEntry = argTypes[fieldEntryName]
      argsObject[fieldEntryName] = {}

      if (fieldEntry.type instanceof GraphQLScalarType || isNonNullOfType(fieldEntry.type, GraphQLScalarType) ||
        fieldEntry.type instanceof GraphQLEnumType || isNonNullOfType(fieldEntry.type, GraphQLEnumType)) {
        argsObject[fieldEntryName].type = QLFilter
      } else if (fieldEntry.type instanceof GraphQLObjectType || fieldEntry.type instanceof GraphQLList || isNonNullOfType(fieldEntry.type, GraphQLObjectType)) {
        argsObject[fieldEntryName].type = QLTypeFilterExpression
      }
    }

    argsObject.pagination = {}
    argsObject.pagination.type = QLPagination

    argsObject.sort = {}
    argsObject.sort.type = QLSortExpression

    rootQueryArgs.fields[type.listEntitiesEndpointName] = {
      type: new GraphQLList(type.gqltype),
      args: argsObject,
      async resolve (parent, args) {
        const aggregateClauses = await buildQuery(args, type.gqltype)
        let result
        if (aggregateClauses.length === 0) {
          result = type.model.find({})
        } else {
          result = type.model.aggregate(aggregateClauses)
        }
        return result
      }
    }
  }

  return new GraphQLObjectType(rootQueryArgs)
}

const isEmpty = value => !value && value !== false && value !== 0

const materializeModel = async function (args, gqltype, linkToParent, operation, session) {
  if (!args) {
    return null
  }

  const argTypes = gqltype.getFields()

  const modelArgs = {}
  const collectionFields = {}

  for (const fieldEntryName in argTypes) {
    const fieldEntry = argTypes[fieldEntryName]

    if (fieldEntry.extensions && fieldEntry.extensions.validations && fieldEntry.extensions.validations[operation]) {
      for (const validator of fieldEntry.extensions.validations[operation]) {
        await validator.validate(gqltype.name, fieldEntryName, args[fieldEntryName], session)
      }
    }

    if (isEmpty(args[fieldEntryName])) {
      continue
    }

    if (fieldEntry.type instanceof GraphQLScalarType || fieldEntry.type instanceof GraphQLEnumType ||
      isNonNullOfType(fieldEntry.type, GraphQLScalarType) || isNonNullOfType(fieldEntry.type, GraphQLEnumType)) {
      modelArgs[fieldEntryName] = args[fieldEntryName]
    } else if (fieldEntry.type instanceof GraphQLObjectType || isNonNullOfType(fieldEntry.type, GraphQLObjectType)) {
      if (fieldEntry.extensions && fieldEntry.extensions.relation) {
        if (!fieldEntry.extensions.relation.embedded) {
          modelArgs[fieldEntry.extensions.relation.connectionField] = new mongoose.Types.ObjectId(args[fieldEntryName].id)
        } else {
          const fieldType = fieldEntry.type instanceof GraphQLNonNull ? fieldEntry.type.ofType : fieldEntry.type
          modelArgs[fieldEntryName] = (await materializeModel(args[fieldEntryName], fieldType, null, operation, session)).modelArgs
        }
      } else {
        console.warn('Configuration issue: Field ' + fieldEntryName + ' does not define extensions.relation')
      }
    } else if (fieldEntry.type instanceof GraphQLList) {
      const ofType = fieldEntry.type.ofType
      if (ofType instanceof GraphQLObjectType && fieldEntry.extensions && fieldEntry.extensions.relation) {
        if (!fieldEntry.extensions.relation.embedded) {
          collectionFields[fieldEntryName] = args[fieldEntryName]
        } else if (fieldEntry.extensions.relation.embedded) {
          const collectionEntries = []

          for (const element of args[fieldEntryName]) {
            const collectionEntry = (await materializeModel(element, ofType, null, operation, session)).modelArgs
            if (collectionEntry) {
              collectionEntries.push(collectionEntry)
            }
          }
          modelArgs[fieldEntryName] = collectionEntries
        }
      } else if (ofType instanceof GraphQLScalarType || ofType instanceof GraphQLEnumType) {
        modelArgs[fieldEntryName] = args[fieldEntryName]
      }
    }
  }
  if (linkToParent) {
    linkToParent(modelArgs)
  }

  if (gqltype.extensions && gqltype.extensions.validations && gqltype.extensions.validations[operation]) {
    for (const validator of gqltype.extensions.validations[operation]) {
      await validator.validate(gqltype.name, args, modelArgs, session)
    }
  }

  return { modelArgs: modelArgs, collectionFields: collectionFields }
}

const executeRegisteredMutation = async function (args, callback, session) {
  session = session || await mongoose.startSession()
  await session.startTransaction()
  try {
    const newObject = await callback(args, session)
    await session.commitTransaction()
    session.endSession()
    return newObject
  } catch (error) {
    await session.abortTransaction()
    if (error.errorLabels && error.errorLabels.includes('TransientTransactionError')) {
      return executeRegisteredMutation(args, callback, session)
    } else {
      session.endSession()
      throw error
    }
  }
}

const executeOperation = async function (Model, gqltype, controller, args, operation, actionField, session) {
  session = session || await mongoose.startSession()
  await session.startTransaction()
  try {
    let newObject = null
    switch (operation) {
      case operations.SAVE:
        newObject = await onSaveObject(Model, gqltype, controller, args, session)
        break
      case operations.UPDATE:
        newObject = await onUpdateSubject(Model, gqltype, controller, args, session)
        break
      case operations.DELETE:
        newObject = await onDeleteObject(Model, gqltype, controller, args, session)
        break
      case operations.STATE_CHANGED:
        newObject = await onStateChanged(Model, gqltype, controller, args, session, actionField)
        break
    }
    await session.commitTransaction()
    session.endSession()
    return newObject
  } catch (error) {
    await session.abortTransaction()
    if (error.errorLabels && error.errorLabels.includes('TransientTransactionError')) {
      return executeOperation(Model, gqltype, controller, args, operation, actionField, session)
    } else {
      session.endSession()
      throw error
    }
  }
}

const onDeleteObject = async function (Model, gqltype, controller, args, session, linkToParent) {
  const result = await materializeModel(args, gqltype, linkToParent, 'DELETE', session)
  const deletedObject = new Model(result.modelArgs)

  if (controller && controller.onDelete) {
    await controller.onDelete(deletedObject, session)
  }

  return Model.findByIdAndDelete(args, deletedObject.modelArgs).session(session)
}

const onStateChanged = async function (Model, gqltype, controller, args, session, actionField) {
  const storedModel = await Model.findById(args.id)
  if (!storedModel) {
    throw new SimfinityError(`${gqltype.name} ${args.id} is not valid`, 'NOT_VALID_ID', 404)
  }
  if (storedModel.state === actionField.from.name) {
    if (actionField.action) {
      await actionField.action(args, session)
    }

    args.state = actionField.to.name
    let result = await onUpdateSubject(Model, gqltype, controller, args, session)
    result = result.toObject()
    result.state = actionField.to.value
    return result
  } else {
    throw new SimfinityError('Action is not allowed from state ' + storedModel.state, 'BAD_REQUEST', 400)
  }
}

const onUpdateSubject = async function (Model, gqltype, controller, args, session, linkToParent) {
  const materializedModel = await materializeModel(args, gqltype, linkToParent, 'UPDATE', session)
  const objectId = args.id

  if (materializedModel.collectionFields) {
    await iterateonCollectionFields(materializedModel, gqltype, objectId, session)
  }

  let modifiedObject = materializedModel.modelArgs
  const currentObject = await Model.findById({ _id: objectId }).lean()

  const argTypes = gqltype.getFields()

  for (const fieldEntryName in argTypes) {
    const fieldEntry = argTypes[fieldEntryName]
    if (fieldEntry.extensions && fieldEntry.extensions.relation && fieldEntry.extensions.relation.embedded) {
      const oldObjectData = currentObject[fieldEntryName]
      const newObjectData = modifiedObject[fieldEntryName]
      if (newObjectData) {
        if (Array.isArray(oldObjectData) && Array.isArray(newObjectData)) {
          modifiedObject[fieldEntryName] = newObjectData
        } else {
          modifiedObject[fieldEntryName] = { ...oldObjectData, ...newObjectData }
        }
      }
    }

    if (args[fieldEntryName] === null && !(argTypes[fieldEntryName].type instanceof GraphQLNonNull)) {
      modifiedObject = { ...modifiedObject, $unset: { [fieldEntryName]: '' } }
    }
  }

  if (controller && controller.onUpdating) {
    await controller.onUpdating(objectId, modifiedObject, args, session)
  }

  const result = Model.findByIdAndUpdate(
    objectId, modifiedObject, { new: true }
  )

  if (controller && controller.onUpdated) {
    await controller.onUpdated(result, args, session)
  }

  return result
}

module.exports.saveObject = async (typeName, args, session) => {
  const type = typesDict.types[typeName]
  return onSaveObject(type.model, type.gqltype, type.controller, args, session)
}

const onSaveObject = async function (Model, gqltype, controller, args, session, linkToParent) {
  const materializedModel = await materializeModel(args, gqltype, linkToParent, 'CREATE', session)
  if (typesDict.types[gqltype.name].stateMachine) {
    materializedModel.modelArgs.state = typesDict.types[gqltype.name].stateMachine.initialState.name
  }

  const newObject = new Model(materializedModel.modelArgs)
  console.log(JSON.stringify(newObject))
  newObject.$session(session)

  if (controller && controller.onSaving) {
    await controller.onSaving(newObject, args, session)
  }

  if (materializedModel.collectionFields) {
    await iterateonCollectionFields(materializedModel, gqltype, newObject._id, session)
  }

  let result = await newObject.save()
  result = result.toObject()
  if (controller && controller.onSaved) {
    await controller.onSaved(result, args, session)
  }
  if (typesDict.types[gqltype.name].stateMachine) {
    result.state = typesDict.types[gqltype.name].stateMachine.initialState.value
  }
  return result
}

const iterateonCollectionFields = async function (materializedModel, gqltype, objectId, session) {
  for (const collectionField in materializedModel.collectionFields) {
    if (materializedModel.collectionFields[collectionField].added) {
      await executeItemFunction(gqltype, collectionField, objectId, session, materializedModel.collectionFields[collectionField].added, operations.SAVE)
    }
    if (materializedModel.collectionFields[collectionField].updated) {
      await executeItemFunction(gqltype, collectionField, objectId, session, materializedModel.collectionFields[collectionField].updated, operations.UPDATE)
    }
    if (materializedModel.collectionFields[collectionField].deleted) {
      await executeItemFunction(gqltype, collectionField, objectId, session, materializedModel.collectionFields[collectionField].deleted, operations.DELETE)
    }
  }
}

const executeItemFunction = async function (gqltype, collectionField, objectId, session, collectionFieldsList, operationType) {
  const argTypes = gqltype.getFields()
  const collectionGQLType = argTypes[collectionField].type.ofType
  const connectionField = argTypes[collectionField].extensions.relation.connectionField

  let operationFunction = async function () {}

  switch (operationType) {
    case operations.SAVE:
      operationFunction = async collectionItem => {
        await onSaveObject(typesDict.types[collectionGQLType.name].model, collectionGQLType, typesDict.types[collectionGQLType.name].controller, collectionItem, session, (item) => {
          item[connectionField] = objectId
        })
      }
      break
    case operations.UPDATE:
      operationFunction = async collectionItem => {
        await onUpdateSubject(typesDict.types[collectionGQLType.name].model, collectionGQLType, typesDict.types[collectionGQLType.name].controller, collectionItem, session, (item) => {
          item[connectionField] = objectId
        })
      }
      break
    case operations.DELETE:
    // TODO: implement
  }

  for (const element of collectionFieldsList) {
    await operationFunction(element)
  }
}

const buildMutation = function (name, includedMutationTypes, includedCustomMutations) {
  const rootQueryArgs = {}
  rootQueryArgs.name = name
  rootQueryArgs.fields = {}

  buildPendingInputTypes(waitingInputType)

  for (const entry in typesDict.types) {
    const type = typesDict.types[entry]

    if (shouldNotBeIncludedInSchema(includedMutationTypes, type.gqltype)) {
      continue
    }

    if (type.endpoint) {
      const argsObject = { input: { type: new GraphQLNonNull(type.inputType) } }

      rootQueryArgs.fields['add' + type.simpleEntityEndpointName] = {
        type: type.gqltype,
        args: argsObject,
        async resolve (parent, args) {
          return executeOperation(type.model, type.gqltype, type.controller, args.input, operations.SAVE)
        }
      }
      rootQueryArgs.fields['delete' + type.simpleEntityEndpointName] = {
        type: type.gqltype,
        args: { id: { type: new GraphQLNonNull(GraphQLID) } },
        async resolve (parent, args) {
          return executeOperation(type.model, type.gqltype, type.controller, args.id, operations.DELETE)
        }
      }
    }
  }

  for (const entry in typesDictForUpdate.types) {
    const type = typesDictForUpdate.types[entry]

    if (shouldNotBeIncludedInSchema(includedMutationTypes, type.gqltype)) {
      continue
    }

    if (type.endpoint) {
      const argsObject = { input: { type: new GraphQLNonNull(type.inputType) } }
      rootQueryArgs.fields['update' + type.simpleEntityEndpointName] = {
        type: type.gqltype,
        args: argsObject,
        async resolve (parent, args) {
          return executeOperation(type.model, type.gqltype, type.controller, args.input, operations.UPDATE)
        }
      }
      if (type.stateMachine) {
        for (const actionName in type.stateMachine.actions) {
          if ({}.hasOwnProperty.call(type.stateMachine.actions, actionName)) {
            const actionField = type.stateMachine.actions[actionName]
            rootQueryArgs.fields[actionName + '_' + type.simpleEntityEndpointName] = {
              type: type.gqltype,
              description: actionField.description,
              args: argsObject,
              async resolve (parent, args) {
                return executeOperation(type.model, type.gqltype, type.controller, args.input, operations.STATE_CHANGED, actionField)
              }
            }
          }
        }
      }
    }
  }

  for (const entry in registeredMutations) {
    if (shouldNotBeIncludedInSchema(includedCustomMutations, entry)) {
      continue
    }

    const registeredMutation = registeredMutations[entry]

    const argsObject = registeredMutation.inputModel ? { input: { type: new GraphQLNonNull(registeredMutation.inputModel) } } : null
    rootQueryArgs.fields[entry] = {
      type: registeredMutation.outputModel,
      description: registeredMutation.description,
      args: argsObject,
      async resolve (parent, args) {
        return executeRegisteredMutation(args.input, registeredMutation.callback)
      }
    }
  }

  return new GraphQLObjectType(rootQueryArgs)
}

const generateSchemaDefinition = function (gqlType) {
  const argTypes = gqlType.getFields()

  const schemaArg = {}

  for (const fieldEntryName in argTypes) {
    const fieldEntry = argTypes[fieldEntryName]

    if (fieldEntry.type === GraphQLID || isNonNullOfTypeForNotScalar(fieldEntry.type, GraphQLID)) {
      schemaArg[fieldEntryName] = mongoose.Schema.Types.ObjectId
    } else if (fieldEntry.type === GraphQLString || isNonNullOfTypeForNotScalar(fieldEntry.type, GraphQLString)) {
      schemaArg[fieldEntryName] = String
    } else if (fieldEntry.type instanceof GraphQLEnumType || isNonNullOfType(fieldEntry.type, GraphQLEnumType)) {
      schemaArg[fieldEntryName] = String
    } else if (fieldEntry.type === GraphQLInt || isNonNullOfTypeForNotScalar(fieldEntry.type, GraphQLInt)) {
      schemaArg[fieldEntryName] = Number
    } else if (fieldEntry.type === GraphQLFloat || isNonNullOfTypeForNotScalar(fieldEntry.type, GraphQLFloat)) {
      schemaArg[fieldEntryName] = Number
    } else if (fieldEntry.type === GraphQLBoolean || isNonNullOfTypeForNotScalar(fieldEntry.type, GraphQLBoolean)) {
      schemaArg[fieldEntryName] = Boolean
    } else if (fieldEntry.type instanceof GraphQLObjectType || isNonNullOfType(fieldEntry.type, GraphQLObjectType)) {
      if (fieldEntry.extensions && fieldEntry.extensions.relation) {
        if (!fieldEntry.extensions.relation.embedded) {
          schemaArg[fieldEntry.extensions.relation.connectionField] = mongoose.Schema.Types.ObjectId
        } else {
          let entryType = fieldEntry.type
          if (entryType instanceof GraphQLNonNull) {
            entryType = entryType.ofType
          }
          if (entryType !== gqlType) {
            schemaArg[fieldEntryName] = generateSchemaDefinition(entryType)
          } else {
            throw new Error('A type cannot have a field of its same type and embedded')
          }
        }
      }
    } else if (fieldEntry.type instanceof GraphQLList) {
      if (fieldEntry.extensions && fieldEntry.extensions.relation) {
        if (fieldEntry.extensions.relation.embedded) {
          const entryType = fieldEntry.type.ofType
          if (entryType !== gqlType) {
            schemaArg[fieldEntryName] = [generateSchemaDefinition(entryType)]
          } else {
            throw new Error('A type cannot have a field of its same type and embedded')
          }
        }
      }
    }
  }

  return schemaArg
}

const generateModel = function (gqlType, onModelCreated) {
  const model = mongoose.model(gqlType.name, generateSchemaDefinition(gqlType), gqlType.name)
  if (onModelCreated) {
    onModelCreated(model)
  }
  model.createCollection()
  return model
}

const typesDict = { types: {} }
const waitingInputType = {}
const typesDictForUpdate = { types: {} }

/* Creating a new GraphQL Schema, with options query which defines query
we will allow users to use when they are making request. */
module.exports.createSchema = function (includedQueryTypes, includedMutationTypes, includedCustomMutations) {
  return new GraphQLSchema({
    query: buildRootQuery('RootQueryType', includedQueryTypes),
    mutation: buildMutation('Mutation', includedMutationTypes, includedCustomMutations)
  })
}

module.exports.getModel = gqltype => typesDict.types[gqltype.name].model

const registeredMutations = {}
module.exports.registerMutation = function (name, description, inputModel, outputModel, callback) {
  registeredMutations[name] = {
    description,
    inputModel,
    outputModel,
    callback
  }
}

module.exports.connect = function (model, gqltype, simpleEntityEndpointName, listEntitiesEndpointName, controller, onModelCreated, stateMachine) {
  waitingInputType[gqltype.name] = {
    model: model,
    gqltype: gqltype
  }
  typesDict.types[gqltype.name] = {
    model: model || generateModel(gqltype, onModelCreated),
    gqltype: gqltype,
    simpleEntityEndpointName: simpleEntityEndpointName,
    listEntitiesEndpointName: listEntitiesEndpointName,
    endpoint: true,
    controller: controller,
    stateMachine: stateMachine
  }

  typesDictForUpdate.types[gqltype.name] = { ...typesDict.types[gqltype.name] }
}

module.exports.addNoEndpointType = function (gqltype) {
  waitingInputType[gqltype.name] = {
    gqltype: gqltype
  }

  typesDict.types[gqltype.name] = {
    gqltype: gqltype,
    endpoint: false
  }

  typesDictForUpdate.types[gqltype.name] = { ...typesDict.types[gqltype.name] }
}

const buildQuery = async function (input, gqltype) {
  console.log('Building Query')
  const aggregateClauses = []
  const matchesClauses = { $match: {} }
  let addMatch = false
  let limitClause = {}
  let skipClause = {}
  let addPagination = false
  let sortClause = {}
  let addSort = false

  for (const key in input) {
    if (Object.prototype.hasOwnProperty.call(input, key) && key !== 'pagination' && key !== 'sort') {
      const filterField = input[key]
      const qlField = gqltype.getFields()[key]

      const result = await buildQueryTerms(filterField, qlField, key)

      if (result) {
        for (const aggregate in result.aggregateClauses) {
          aggregateClauses.push(result.aggregateClauses[aggregate].lookup)
          aggregateClauses.push(result.aggregateClauses[aggregate].unwind)
        }

        for (const match in result.matchesClauses) {
          if (Object.prototype.hasOwnProperty.call(result.matchesClauses, match)) {
            const matchClause = result.matchesClauses[match]
            for (const key in matchClause) {
              if (Object.prototype.hasOwnProperty.call(matchClause, key)) {
                const value = matchClause[key]
                matchesClauses.$match[key] = value
                addMatch = true
              }
            }
          }
        }
      }
    } else if (key === 'pagination') {
      if (input[key].page && input[key].size) {
        const skip = input[key].size * (input[key].page - 1)
        limitClause = { $limit: input[key].size + skip }
        skipClause = { $skip: skip }
        addPagination = true
      }
    } else if (key === 'sort') {
      const sortExpressions = {}
      input[key].terms.forEach(function (sort) {
        console.log(sort)
        sort.order === 'ASC' ? sort.order = 1 : sort.order = -1
        sortExpressions[sort.field] = sort.order
      })
      sortClause = { $sort: sortExpressions }
      addSort = true
    }
  }

  if (addMatch) {
    aggregateClauses.push(matchesClauses)
  }

  if (addSort) {
    aggregateClauses.push(sortClause)
  }

  if (addPagination) {
    aggregateClauses.push(limitClause)
    aggregateClauses.push(skipClause)
  }

  console.log(JSON.stringify(aggregateClauses))
  return aggregateClauses
}
const buildMatchesClause = function (fieldname, operator, value) {
  const matches = {}
  if (operator === QLOperator.getValue('EQ').value || !operator) {
    let fixedValue = value
    if (fieldname.endsWith('_id')) {
      fixedValue = new mongoose.Types.ObjectId(value)
    };
    matches[fieldname] = fixedValue
  } else if (operator === QLOperator.getValue('LT').value) {
    matches[fieldname] = { $lt: value }
  } else if (operator === QLOperator.getValue('GT').value) {
    matches[fieldname] = { $gt: value }
  } else if (operator === QLOperator.getValue('LTE').value) {
    matches[fieldname] = { $lte: value }
  } else if (operator === QLOperator.getValue('GTE').value) {
    matches[fieldname] = { $gte: value }
  } else if (operator === QLOperator.getValue('NE').value) {
    matches[fieldname] = { $ne: value }
  } else if (operator === QLOperator.getValue('BTW').value) {
    matches[fieldname] = { $gte: value[0], $lte: value[1] }
  } else if (operator === QLOperator.getValue('IN').value) {
    let fixedArray = value
    if (value && fieldname.endsWith('_id')) {
      fixedArray = []
      for (const element of value) {
        fixedArray.push(new mongoose.Types.ObjectId(element))
      }
    }
    matches[fieldname] = { $in: fixedArray }
  } else if (operator === QLOperator.getValue('NIN').value) {
    let fixedArray = value
    if (value && fieldname.endsWith('_id')) {
      fixedArray = []
      for (const element of value) {
        fixedArray.push(new mongoose.Types.ObjectId(element))
      }
    }
    matches[fieldname] = { $nin: fixedArray }
  } else if (operator === QLOperator.getValue('LIKE').value) {
    matches[fieldname] = { $regex: '.*' + value + '.*' }
  }

  return matches
}

const buildQueryTerms = async function (filterField, qlField, fieldName) {
  const aggregateClauses = {}
  const matchesClauses = {}

  if (qlField.type instanceof GraphQLScalarType || isNonNullOfType(qlField.type, GraphQLScalarType)) {
    if (qlField.type.name === 'DateTime') {
      if (Array.isArray(filterField.value)) {
        filterField.value = filterField.value.map(value => value && new Date(value))
      } else {
        filterField.value = filterField.value && new Date(filterField.value)
      }
    }
    matchesClauses[fieldName] = buildMatchesClause(fieldName === 'id' ? '_id' : fieldName, filterField.operator, filterField.value)
  } else if (qlField.type instanceof GraphQLObjectType || qlField.type instanceof GraphQLList || isNonNullOfType(qlField.type, GraphQLObjectType)) {
    let fieldType = qlField.type

    if (fieldType instanceof GraphQLList || fieldType instanceof GraphQLNonNull) {
      fieldType = qlField.type.ofType
    }

    filterField.terms.forEach(term => {
      if (qlField.extensions && qlField.extensions.relation && !qlField.extensions.relation.embedded) {
        const model = typesDict.types[fieldType.name].model
        const collectionName = model.collection.collectionName
        const localFieldName = qlField.extensions.relation.connectionField
        if (!aggregateClauses[fieldName]) {
          let lookup = {}

          if (qlField.type instanceof GraphQLList) {
            lookup = {
              $lookup: {
                from: collectionName,
                foreignField: localFieldName,
                localField: '_id',
                as: fieldName
              }
            }
          } else {
            lookup = {
              $lookup: {
                from: collectionName,
                foreignField: '_id',
                localField: localFieldName,
                as: fieldName
              }
            }
          }

          aggregateClauses[fieldName] = {
            lookup: lookup,
            unwind: { $unwind: { path: '$' + fieldName, preserveNullAndEmptyArrays: true } }
          }
        }
      }

      if (term.path.indexOf('.') < 0) {
        if (fieldType.getFields()[term.path].type.name === 'DateTime') {
          if (Array.isArray(term.value)) {
            term.value = term.value.map(value => value && new Date(value))
          } else {
            term.value = term.value && new Date(term.value)
          }
        }
        matchesClauses[fieldName] = buildMatchesClause(fieldName + '.' + (fieldType.getFields()[term.path].name === 'id' ? '_id' : term.path), term.operator, term.value)
      } else {
        let currentGQLPathFieldType = qlField.type
        if (currentGQLPathFieldType instanceof GraphQLList || currentGQLPathFieldType instanceof GraphQLNonNull) {
          currentGQLPathFieldType = currentGQLPathFieldType.ofType
        }
        let aliasPath = fieldName
        let embeddedPath = ''

        term.path.split('.').forEach((pathFieldName) => {
          const pathField = currentGQLPathFieldType.getFields()[pathFieldName]
          if (pathField.type instanceof GraphQLScalarType || isNonNullOfType(pathField.type, GraphQLScalarType)) {
            if (pathField.type.name === 'DateTime') {
              if (Array.isArray(term.value)) {
                term.value = term.value.map(value => value && new Date(value))
              } else {
                term.value = term.value && new Date(term.value)
              }
            }
            matchesClauses[aliasPath + '_' + pathFieldName] = buildMatchesClause(aliasPath + (embeddedPath !== '' ? '.' + embeddedPath + '.' : '.') + (pathFieldName === 'id' ? '_id' : pathFieldName), term.operator, term.value)
            embeddedPath = ''
          } else if (pathField.type instanceof GraphQLObjectType || pathField.type instanceof GraphQLList || isNonNullOfType(pathField.type, GraphQLObjectType)) {
            let pathFieldType = pathField.type
            if (pathField.type instanceof GraphQLList || pathField.type instanceof GraphQLNonNull) {
              pathFieldType = pathField.type.ofType
            }
            currentGQLPathFieldType = pathFieldType
            if (pathField.extensions && pathField.extensions.relation && !pathField.extensions.relation.embedded) {
              const currentPath = aliasPath + (embeddedPath !== '' ? '.' + embeddedPath : '')
              aliasPath += (embeddedPath !== '' ? '_' + embeddedPath + '_' : '_') + pathFieldName

              embeddedPath = ''

              const pathModel = typesDict.types[pathFieldType.name].model
              const fieldPathCollectionName = pathModel.collection.collectionName
              const pathLocalFieldName = pathField.extensions.relation.connectionField

              if (!aggregateClauses[aliasPath]) {
                let lookup = {}
                if (pathField.type instanceof GraphQLList) {
                  lookup = {
                    $lookup: {
                      from: fieldPathCollectionName,
                      foreignField: pathLocalFieldName,
                      localField: currentPath + '.' + '_id',
                      as: aliasPath
                    }
                  }
                } else {
                  lookup = {
                    $lookup: {
                      from: fieldPathCollectionName,
                      foreignField: '_id',
                      localField: currentPath + '.' + pathLocalFieldName,
                      as: aliasPath
                    }
                  }
                }

                aggregateClauses[aliasPath] = {
                  lookup: lookup,
                  unwind: { $unwind: { path: '$' + aliasPath, preserveNullAndEmptyArrays: true } }
                }
              }
            } else {
              if (embeddedPath === '') {
                embeddedPath += pathFieldName
              } else {
                embeddedPath += '.' + pathFieldName
              }
            }
          }
        })
      }
    })
  }
  return { aggregateClauses: aggregateClauses, matchesClauses: matchesClauses }
}
const shouldNotBeIncludedInSchema = function (includedTypes, type) {
  return includedTypes && !includedTypes.includes(type)
}
