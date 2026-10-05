import { GraphQLList, GraphQLNonNull } from 'graphql';

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
