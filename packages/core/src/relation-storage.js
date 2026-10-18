import { GraphQLList, GraphQLNonNull } from 'graphql';
import SimfinityError from './errors/simfinity.error.js';

// Internal helpers that decide where a relation stores its link and which types keep a stored
// identity. They are shared by the core runtime and the MongoDB adapter through the
// `./internal/relation-storage` subpath, which is not public API.

const unwrapNonNull = (type) => (type instanceof GraphQLNonNull ? type.ofType : type);

export const getListShape = (type) => {
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

// A relation's connectionField is a field of the record that stores the link: the reference's own
// type, or a collection's item type. It is a field name, never a path into an embedded value, which
// would put the link inside another value: MongoDB would store it in that value's member and read it
// back as missing, and PostgreSQL would name a column after the whole path. A link that belongs to an
// embedded value is declared there, as a reference of the embedded type. Throws INVALID_MODEL (400)
// for a connectionField that is not a string, or that contains a dot; an omitted or empty one keeps
// its existing meaning.
export const assertPlainConnectionField = (typeName, fieldName, field) => {
  const relation = field?.extensions?.relation;
  if (!relation || relation.embedded) return;
  const { connectionField } = relation;
  if (connectionField === undefined || connectionField === null || connectionField === '') return;
  const name = `${typeName}.${fieldName}`;
  const listShape = getListShape(field.type);
  const holder = listShape ? listShape.itemType.name : typeName;
  if (typeof connectionField !== 'string') {
    throw new SimfinityError(`${name} extensions.relation.connectionField must be the name of a field of ${holder}`,
      'INVALID_MODEL', 400);
  }
  if (connectionField.includes('.')) {
    throw new SimfinityError(`${name} extensions.relation.connectionField ${connectionField} must name a field of ${holder}, `
      + 'not a path into an embedded value'
      + (listShape ? '' : '; declare a reference that belongs to an embedded value inside the embedded type'),
    'INVALID_MODEL', 400);
  }
};

export const getFieldStorageName = (fieldName, field) => {
  const relation = field.extensions?.relation;
  return relation && !relation.embedded && !getListShape(field.type)
    ? relation.connectionField || fieldName
    : fieldName;
};

// Entity types, which keep their own stored identity. The generated id resolver lives on the type
// object, which runtimes may share, so the identity rule is per type object, not per runtime
// registration: a store path for `id` follows the resolver any runtime installed on the type.
const storedIdentityTypes = new WeakSet();

export const markStoredIdentity = (gqltype) => {
  storedIdentityTypes.add(gqltype);
};

export const hasStoredIdentity = (gqltype) => storedIdentityTypes.has(gqltype);

export const normalizeConnectionField = (childType, declaredFieldName) => {
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
