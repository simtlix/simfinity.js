import { GraphQLObjectType, GraphQLScalarType } from 'graphql';
import { SimfinityError } from '@simtlix/simfinity-core';
import { getFieldStorageName, getListShape } from '@simtlix/simfinity-core/internal/relation-storage';

const filterError = (message, code) => new SimfinityError(message, code, 400);

const DYNAMIC_STORAGE_TYPES = new Set(['Mixed', 'Map']);
const appendPath = (prefix, leaf) => prefix ? `${prefix}.${leaf}` : leaf;

export const assertStoredPath = (model, path, allowNested = false) => {
  const stored = model?.schema.path(path);
  if (!stored && !(allowNested && model?.schema.nested[path])) {
    throw filterError('Query field has no registered storage path', 'INVALID_FILTER_PATH');
  }
};

export const serverFieldName = (fields, part) => {
  if (Object.hasOwn(fields, part)) return part;
  return Object.keys(fields).find((key) => (
    fields[key].extensions?.relation && getFieldStorageName(key, fields[key]) === part
  ));
};

const referenceLeaf = ({ field, name, model, schemaPath, mongoPath, parts, index }) => {
  if (index !== parts.length - 1 || getListShape(field.type)) {
    throw filterError('Server queries cannot traverse nonembedded relations', 'INVALID_FILTER_PATH');
  }
  const leaf = getFieldStorageName(name, field);
  assertStoredPath(model, appendPath(schemaPath, leaf));
  return { mongoPath: appendPath(mongoPath, leaf) };
};

const dynamicLeaf = ({ fieldType, model, schemaPath, part, mongoPath, parts, index }) => {
  const storage = model?.schema.path(appendPath(schemaPath, part));
  const item = storage?.caster || storage;
  if (!(fieldType instanceof GraphQLScalarType) || !DYNAMIC_STORAGE_TYPES.has(item?.instance)) {
    throw filterError('Dynamic query paths require a scalar with registered Mixed or Map storage', 'INVALID_FILTER_PATH');
  }
  return { mongoPath: [mongoPath, ...parts.slice(index)].filter(Boolean).join('.') };
};

const structuredLeaf = ({ model, schemaPath, part, mongoPath }) => {
  assertStoredPath(model, appendPath(schemaPath, part), true);
  return { mongoPath: appendPath(mongoPath, part), structured: true };
};

export const resolveServerLeaf = (path) => {
  const relation = path.field.extensions?.relation;
  if (relation && !relation.embedded) return referenceLeaf(path);
  if (path.field.extensions?.queryPaths?.dynamic === true) return dynamicLeaf(path);
  if (path.index === path.parts.length - 1 && path.fieldType instanceof GraphQLObjectType) {
    return structuredLeaf(path);
  }
  return null;
};
