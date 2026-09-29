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
    } else if (getListItemType(type)) {
      const itemType = getListItemType(type);
      if (fieldEntry.extensions && fieldEntry.extensions.relation) {
        if (fieldEntry.extensions.relation.embedded) {
          if (itemType === gqlType) {
            throw new Error('A type cannot have a field of its same type and embedded');
          }
          schemaArg[fieldEntryName] = [generateSchemaDefinition(itemType)];
        }
      } else if (listItemMatchesScalar(type, GraphQLID)) {
        schemaArg[fieldEntryName] = [mongoose.Schema.Types.ObjectId];
      } else if (listItemMatchesScalar(type, GraphQLString) || itemType instanceof GraphQLEnumType) {
        schemaArg[fieldEntryName] = [String];
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
