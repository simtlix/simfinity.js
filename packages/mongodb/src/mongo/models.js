import {
  GraphQLBoolean,
  GraphQLEnumType,
  GraphQLFloat,
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLString,
} from 'graphql';
import mongoose from 'mongoose';
import { SimfinityError } from '@simtlix/simfinity-core';
import { getFieldStorageName } from '@simtlix/simfinity-core/internal/relation-storage';

const isNonNullOfType = (fieldEntryType, graphQLType) => (
  fieldEntryType instanceof GraphQLNonNull && fieldEntryType.ofType instanceof graphQLType
);

const unwrapNonNull = (type) => (type instanceof GraphQLNonNull ? type.ofType : type);

const getListItemType = (type) => {
  const listType = unwrapNonNull(type);
  if (!(listType instanceof GraphQLList)) return null;
  return unwrapNonNull(listType.ofType);
};

// Follow validated-scalar chains to their storage scalar; a cyclic chain stops where it repeats.
export const resolveStorageScalar = (type) => {
  let base = type;
  const visited = new Set();
  while (base instanceof GraphQLScalarType && base.baseScalarType && !visited.has(base)) {
    visited.add(base);
    base = base.baseScalarType;
  }
  return base;
};

const matchesScalar = (fieldType, target) => resolveStorageScalar(unwrapNonNull(fieldType)) === target;

const getEffectiveTypeName = (type) => (
  type instanceof GraphQLScalarType ? resolveStorageScalar(type).name : type.name
);

const isGraphQLisoDate = (typeName) => (
  typeName === 'DateTime' || typeName === 'Date' || typeName === 'Time'
);

const listItemMatchesScalar = (listType, target) => (
  resolveStorageScalar(getListItemType(listType)) === target
);

const withUnique = (fieldEntry, mongoType) => (fieldEntry.extensions && fieldEntry.extensions.unique
  ? { type: mongoType, unique: true }
  : mongoType);

const isPlainObject = (value) => value != null && Object.getPrototypeOf(value) === Object.prototype;

// Store enum internal values with their own type, so reads can serialize them. A state machine
// persists state names in `state`. State machines are not known when models are generated, so every
// field named `state` keeps accepting names when values are not strings.
const enumStorageType = (enumType, fieldName) => {
  const values = enumType.getValues().map(({ value }) => value);
  if (values.every((value) => typeof value === 'string')) return String;
  // Mixed keeps values by identity only for primitives; others stay String so the write is rejected.
  const primitive = (value) => value === null || ['string', 'number', 'boolean'].includes(typeof value);
  if (!values.every(primitive)) return String;
  if (fieldName === 'state') return mongoose.Schema.Types.Mixed;
  if (values.every((value) => typeof value === 'number')) return Number;
  if (values.every((value) => typeof value === 'boolean')) return Boolean;
  return mongoose.Schema.Types.Mixed;
};

// Mongoose cannot store some fields named like Object.prototype members, because it looks paths up
// on plain objects that inherit those members. An embedded object so named fails to build, the items
// of an embedded list so named come back from the driver as raw BSON buffers whose members read as
// null, and a stored path named `constructor` is dropped from every write. Other scalars, scalar lists and references with
// these names are stored as usual.
const unstorableField = (gqlType, fieldEntryName, reason) => new SimfinityError(
  `${gqlType.name}.${fieldEntryName} cannot be stored on MongoDB: ${reason}`, 'INVALID_MODEL', 400,
);

const assertEmbeddedFieldName = (gqlType, fieldEntryName) => {
  if (fieldEntryName in Object.prototype) {
    throw unstorableField(gqlType, fieldEntryName, 'embedded fields cannot be named like Object.prototype members');
  }
};

// An embedded field whose type is the type being generated, or a type that embeds it on this path,
// would nest without end. The path starts at the type whose model is generated. Sibling and nested
// fields may still embed the same type.
const assertNoEmbeddedCycle = (gqlType, entryType, ancestors, fieldPath) => {
  if (entryType === gqlType) {
    throw new SimfinityError('A type cannot have a field of its same type and embedded', 'INVALID_MODEL', 400);
  }
  if (ancestors.includes(entryType)) throw new SimfinityError(`Embedded cycle at ${fieldPath}`, 'INVALID_MODEL', 400);
};

const generateSchemaDefinition = (gqlType, nested = false, ancestors = [], path = gqlType.name) => {
  const argTypes = gqlType.getFields();
  const schemaArg = {};

  for (const [fieldEntryName, fieldEntry] of Object.entries(argTypes)) {
    const { type } = fieldEntry;

    if (matchesScalar(type, GraphQLID)) {
      schemaArg[fieldEntryName] = mongoose.Schema.Types.ObjectId;
    } else if (matchesScalar(type, GraphQLString)) {
      schemaArg[fieldEntryName] = withUnique(fieldEntry, String);
    } else if (type instanceof GraphQLEnumType || isNonNullOfType(type, GraphQLEnumType)) {
      schemaArg[fieldEntryName] = withUnique(fieldEntry, enumStorageType(unwrapNonNull(type), fieldEntryName));
    } else if (matchesScalar(type, GraphQLInt) || matchesScalar(type, GraphQLFloat)) {
      schemaArg[fieldEntryName] = withUnique(fieldEntry, Number);
    } else if (matchesScalar(type, GraphQLBoolean)) {
      schemaArg[fieldEntryName] = Boolean;
    } else if (type instanceof GraphQLObjectType || isNonNullOfType(type, GraphQLObjectType)) {
      if (fieldEntry.extensions && fieldEntry.extensions.relation) {
        if (!fieldEntry.extensions.relation.embedded) {
          schemaArg[getFieldStorageName(fieldEntryName, fieldEntry)] = mongoose.Schema.Types.ObjectId;
        } else {
          assertEmbeddedFieldName(gqlType, fieldEntryName);
          const entryType = unwrapNonNull(type);
          const fieldPath = `${path}.${fieldEntryName}`;
          assertNoEmbeddedCycle(gqlType, entryType, ancestors, fieldPath);
          const definition = generateSchemaDefinition(entryType, true, [...ancestors, gqlType], fieldPath);
          // A nested object under a `type` key can only be a subdocument; like other embedded objects, it has no _id.
          schemaArg[fieldEntryName] = nested && fieldEntryName === 'type'
            ? new mongoose.Schema(definition, { _id: false })
            : definition;
        }
      }
    } else if (getListItemType(type)) {
      const itemType = getListItemType(type);
      if (fieldEntry.extensions && fieldEntry.extensions.relation) {
        if (fieldEntry.extensions.relation.embedded) {
          assertEmbeddedFieldName(gqlType, fieldEntryName);
          const fieldPath = `${path}.${fieldEntryName}`;
          assertNoEmbeddedCycle(gqlType, itemType, ancestors, fieldPath);
          schemaArg[fieldEntryName] = [generateSchemaDefinition(itemType, true, [...ancestors, gqlType], fieldPath)];
        }
      } else if (listItemMatchesScalar(type, GraphQLID)) {
        schemaArg[fieldEntryName] = [mongoose.Schema.Types.ObjectId];
      } else if (listItemMatchesScalar(type, GraphQLString)) {
        schemaArg[fieldEntryName] = [String];
      } else if (itemType instanceof GraphQLEnumType) {
        schemaArg[fieldEntryName] = [enumStorageType(itemType)];
      } else if (listItemMatchesScalar(type, GraphQLBoolean)) {
        schemaArg[fieldEntryName] = [Boolean];
      } else if (listItemMatchesScalar(type, GraphQLInt) || listItemMatchesScalar(type, GraphQLFloat)) {
        schemaArg[fieldEntryName] = [Number];
      } else if (isGraphQLisoDate(getEffectiveTypeName(itemType))) {
        schemaArg[fieldEntryName] = [Date];
      }
    } else if (isGraphQLisoDate(getEffectiveTypeName(unwrapNonNull(type)))) {
      schemaArg[fieldEntryName] = Date;
    }

    // Whichever stored field takes the `constructor` path, also a reference whose connectionField it is.
    if (Object.hasOwn(schemaArg, 'constructor')) {
      throw unstorableField(gqlType, fieldEntryName, 'Mongoose drops a stored path named constructor');
    }
  }

  // In a nested definition, Mongoose reads a `type` key as the type of the whole embedded path.
  // Declare a field named `type` with an option object; plain objects here already are one.
  if (nested && Object.hasOwn(schemaArg, 'type') && !isPlainObject(schemaArg.type)) {
    schemaArg.type = { type: schemaArg.type };
  }

  return schemaArg;
};

const findObjectIdFields = (schemaDefinition, parentPath = '') => {
  const objectIdFields = [];

  for (const [fieldName, fieldDefinition] of Object.entries(schemaDefinition)) {
    const currentPath = parentPath ? `${parentPath}.${fieldName}` : fieldName;
    // Look through option objects, including those that declare an embedded field named `type`.
    let definition = fieldDefinition;
    if (isPlainObject(definition) && definition.type && !isPlainObject(definition.type)) {
      definition = definition.type;
    }
    if (definition instanceof mongoose.Schema) definition = definition.obj;

    if (definition === mongoose.Schema.Types.ObjectId) {
      objectIdFields.push(currentPath);
    } else if (Array.isArray(definition)) {
      const arrayElement = definition[0];
      if (typeof arrayElement === 'object' && arrayElement !== null) {
        objectIdFields.push(...findObjectIdFields(arrayElement, currentPath));
      }
    } else if (isPlainObject(definition)) {
      objectIdFields.push(...findObjectIdFields(definition, currentPath));
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

export const createMongoModel = (gqlType, onModelCreated, { createCollection = true } = {}) => {
  const schemaDefinition = generateSchemaDefinition(gqlType);
  const schema = createSchemaWithIndexes(schemaDefinition);
  const model = mongoose.model(gqlType.name, schema, gqlType.name);
  if (onModelCreated) {
    onModelCreated(model);
  }
  if (createCollection) {
    // Mongoose already ignores NamespaceExists; report other failures instead of crashing the process.
    Promise.resolve(model.createCollection()).catch((error) => {
      console.warn(`Simfinity could not create MongoDB collection ${model.collection.collectionName}: ${error?.message ?? error}`);
    });
  }
  return model;
};
