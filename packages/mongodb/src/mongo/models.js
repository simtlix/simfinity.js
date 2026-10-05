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

const generateSchemaDefinition = (gqlType, nested = false) => {
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
          const entryType = unwrapNonNull(type);
          if (entryType === gqlType) {
            throw new Error('A type cannot have a field of its same type and embedded');
          }
          const definition = generateSchemaDefinition(entryType, true);
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
          if (itemType === gqlType) {
            throw new Error('A type cannot have a field of its same type and embedded');
          }
          schemaArg[fieldEntryName] = [generateSchemaDefinition(itemType, true)];
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
