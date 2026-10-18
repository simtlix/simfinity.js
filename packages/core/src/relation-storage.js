import { GraphQLList, GraphQLNonNull } from 'graphql';

// Internal helpers that decide where a relation stores its link, which types keep a stored
// identity and which fields store nothing (virtual fields). They are shared by the core runtime and
// the other packages through the `./internal/relation-storage` subpath, which is not public API.
// isVirtualField and virtualFieldOptions are also public, as root exports of the core package, for
// custom adapters that build storage from GraphQL fields.

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

export const VIRTUAL_MCP_MODES = Object.freeze(['tool', 'select', false]);
const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

// A virtual field (`extensions.virtual`) is resolved by its own resolver and stored nowhere: it has
// no storage, no generated input and no query path. Only `true` and a plain options object with
// known options declare one, and this returns its normalized options, `{ mcp }`, with `mcp`
// defaulting to 'tool'; it returns null for any other field. createSchema() and describeModels()
// reject other `virtual` values with INVALID_MODEL, so in their schemas a field with
// `extensions.virtual` is always virtual.
export const virtualFieldOptions = (field) => {
  const virtual = field?.extensions?.virtual;
  if (virtual === true) return { mcp: 'tool' };
  if (!isPlainObject(virtual) || Object.keys(virtual).some((key) => key !== 'mcp')) return null;
  if (virtual.mcp !== undefined && !VIRTUAL_MCP_MODES.includes(virtual.mcp)) return null;
  return { mcp: virtual.mcp ?? 'tool' };
};

export const isVirtualField = (field) => virtualFieldOptions(field) !== null;

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
