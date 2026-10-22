import {
  GraphQLError, GraphQLID, GraphQLInputObjectType, GraphQLNonNull, GraphQLScalarType, Kind, getNamedType, isObjectType,
} from 'graphql';
import SimfinityError from './errors/simfinity.error.js';
import { getFieldStorageName, getListShape } from './relation-storage.js';

// Everything about declarative optimistic concurrency (`extensions.concurrency`) that does not depend
// on a runtime: the RecordVersion scalar, the version field Simfinity injects into a protected type,
// how version values are read and checked, the errors that report them and the collision rules that
// createSchema() and describeModels() share. The scalar and its maximum are public root exports of the
// core package; the rest reaches the adapters through the `./internal/record-version` subpath, which
// is not public API.

/** The highest version. A record at it cannot be updated again, because its version cannot advance. */
export const MAX_RECORD_VERSION = Number.MAX_SAFE_INTEGER;

const RANGE = `an integer from 1 to ${MAX_RECORD_VERSION}`;

const isVersionNumber = (value) => Number.isSafeInteger(value) && value >= 1;

// A stored or serialized version as a number: a safe integer from 1 to MAX_RECORD_VERSION, given as a
// number or as a bigint (a PostgreSQL driver may return one for a bigint column). Null for anything else.
const asVersion = (value) => {
  if (typeof value === 'bigint') return value >= 1n && value <= BigInt(MAX_RECORD_VERSION) ? Number(value) : null;
  return isVersionNumber(value) ? value : null;
};

// The value as an error message shows it. A string is quoted; a value that cannot be converted to
// text, such as an object without a prototype, shows its type.
const show = (value) => {
  try {
    return typeof value === 'string' ? JSON.stringify(value) : String(value);
  } catch {
    return typeof value;
  }
};

export const RecordVersion = new GraphQLScalarType({
  name: 'RecordVersion',
  description: 'Revision of a record with optimistic concurrency. Send it back unchanged in updates and deletes; Simfinity advances it.',
  serialize(value) {
    const version = asVersion(value);
    if (version === null) throw new GraphQLError(`RecordVersion cannot represent ${show(value)}`);
    return version;
  },
  // Input is a JSON number only: a string, a float or a bigint is never a version a client read.
  parseValue(value) {
    if (!isVersionNumber(value)) throw new TypeError(`RecordVersion must be ${RANGE}`);
    return value;
  },
  parseLiteral(ast) {
    // An IntValue beyond the safe integers rounds to an unsafe number, so the same check rejects it.
    const version = ast.kind === Kind.INT ? Number(ast.value) : Number.NaN;
    if (!isVersionNumber(version)) throw new GraphQLError(`RecordVersion must be ${RANGE}`, { nodes: ast });
    return version;
  },
});

/** A record of a protected collection, named by its ID and the version the client read. */
export const RecordVersionRef = new GraphQLInputObjectType({
  name: 'RecordVersionRef',
  fields: {
    id: { type: new GraphQLNonNull(GraphQLID) },
    version: { type: new GraphQLNonNull(RecordVersion) },
  },
});

// The marker of the injected field. Symbol.for gives every copy of the core code the same key, and a
// null-prototype extensions object keeps it through toConfig() copies and extensions spreads.
export const RECORD_VERSION_FIELD = Symbol.for('simfinity.recordVersionField');
// Invalid raw storage values survive native hydration without mutating returned records.
// Weak keys also support frozen documents and do not keep query results alive.
const retainedVersions = new WeakMap();
// Undefined clears metadata when a later query reuses the same result object.
export const retainStoredVersion = (record, value) => {
  if (value === undefined) retainedVersions.delete(record);
  else retainedVersions.set(record, value);
};
export const retainedStoredVersion = (record) => retainedVersions.get(record);

/** Whether a field is the version field that Simfinity injected into a protected type. */
export const isVersionField = (field) => field?.extensions?.[RECORD_VERSION_FIELD] === true;

const VERSION_FIELD_TYPE = new GraphQLNonNull(RecordVersion);

/**
 * The graphql-js field object that createSchema() puts into a protected type's `getFields()` map, with
 * `resolve` as its resolver. `readOnly: true` keeps it out of the create input and `queryable: false`
 * out of filters, sorts and aggregations; the marker tells it from an application field.
 */
export const createVersionFieldConfig = (resolve) => ({
  name: 'version',
  description: 'Revision of this record. Send it back unchanged in updates and deletes; Simfinity advances it.',
  type: VERSION_FIELD_TYPE,
  args: [],
  resolve,
  deprecationReason: undefined,
  extensions: Object.assign(Object.create(null), { readOnly: true, queryable: false, [RECORD_VERSION_FIELD]: true }),
  astNode: undefined,
});

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/**
 * Whether the type declares optimistic concurrency. `extensions.concurrency` is either absent or a plain
 * object whose only key is `mode`, with the value 'optimistic'; any other value throws INVALID_MODEL
 * (400), whatever the key (own, hidden or a symbol) that makes it so.
 */
export const concurrencyDeclared = (gqltype) => {
  const declaration = gqltype.extensions?.concurrency;
  if (declaration === undefined) return false;
  const keys = isPlainObject(declaration) ? Reflect.ownKeys(declaration) : [];
  if (keys.length !== 1 || keys[0] !== 'mode' || declaration.mode !== 'optimistic') {
    throw new SimfinityError(`${gqltype.name} extensions.concurrency must be { mode: 'optimistic' }`, 'INVALID_MODEL', 400);
  }
  return true;
};

/**
 * A stored version as a number. A missing or null one is 1 (a MongoDB document written before the type
 * was protected); anything but a safe integer from 1 to MAX_RECORD_VERSION, given as a number or a
 * bigint, throws DATABASE_ERROR (500): the stored data is wrong, not the request.
 */
export const readStoredVersion = (value, { typeName, id } = {}) => {
  if (value === undefined || value === null) return 1;
  const version = asVersion(value);
  if (version === null) {
    const record = [typeName ?? 'Record', id].filter((part) => part !== undefined && part !== null).join(' ');
    throw new SimfinityError(`${record} stores an invalid version`, 'DATABASE_ERROR', 500);
  }
  return version;
};

/**
 * Checks a version that did not come through GraphQL coercion (middleware, saveObject(), a programmatic
 * caller): a missing or null one throws REQUIRED_VALUE and one that is not a number from 1 to
 * MAX_RECORD_VERSION throws INVALID_VERSION, both 400. Returns the version.
 */
export const assertVersionInput = (value) => {
  if (value === undefined || value === null) throw new SimfinityError('Required value version is missing', 'REQUIRED_VALUE', 400);
  if (!isVersionNumber(value)) throw new SimfinityError(`Invalid value for version: expected ${RANGE}`, 'INVALID_VERSION', 400);
  return value;
};

// None of these messages carries the stored version or other data of the record.
export const versionConflictError = (typeName, id) => new SimfinityError(
  `${typeName} ${id} was modified by another operation`, 'VERSION_CONFLICT', 409,
);

export const versionExhaustedError = (typeName, id) => new SimfinityError(
  `${typeName} ${id} has reached the maximum version`, 'VERSION_EXHAUSTED', 409,
);

/** `hook` is the name of the hook that set the managed field, such as 'onUpdating'. */
export const versionManagedError = (typeName, hook) => new SimfinityError(
  `${typeName}.version is managed by Simfinity; ${hook} cannot set it`, 'VERSION_MANAGED', 500,
);

export const unadvancedVersionError = (typeName, id) => new SimfinityError(
  `${typeName} ${id} was written without advancing its version`, 'DATABASE_ERROR', 500,
);

export const unexpectedDeleteError = (typeName, id) => new SimfinityError(
  `${typeName} ${id} was deleted at another version`, 'DATABASE_ERROR', 500,
);

/**
 * Whether the type is protected: it declares the extension, whose shape this checks (INVALID_MODEL), or
 * already carries the injected field. describeModels() and the checks of createSchema() ask this, since
 * they run before the field is injected.
 */
export const isProtectedType = (gqltype) => concurrencyDeclared(gqltype) || Object.values(gqltype.getFields()).some(isVersionField);

/**
 * The INVALID_MODEL message for a protected type used as an embedded value at `path`, such as
 * `Pedido.items`: an embedded value's changes belong to the revision of the record that embeds it.
 */
export const versionEmbeddedMisuse = (typeName, path) => `${typeName} declares optimistic concurrency, so it cannot be embedded (${path})`;

const collisionPrefix = (typeName) => `${typeName} declares optimistic concurrency, so Simfinity adds its version field, but`;

/**
 * For a type that declares optimistic concurrency: the INVALID_MODEL message for the first field that
 * would collide with the version field, or null. That is a field named `version` that Simfinity did not
 * add, or a reference stored under `version` (`connectionField: 'version'`). The injected field itself
 * is never a collision. A field named `version` typed RecordVersion is almost always the injected field
 * copied without its marker, as a spread of its extensions passed to a graphql-js constructor does, so
 * the message says how to keep it.
 */
export const versionFieldCollision = (gqltype) => {
  for (const [name, field] of Object.entries(gqltype.getFields())) {
    if (isVersionField(field)) continue;
    if (name === 'version') {
      const copied = getNamedType(field.type) === RecordVersion
        ? '. It is typed RecordVersion, so it was probably copied from a protected type without its marker: keep '
          + 'the field\'s extensions object as it is, for example with toConfig()'
        : '';
      return `${collisionPrefix(gqltype.name)} ${gqltype.name} already has a field named version; rename that field${copied}`;
    }
    if (getFieldStorageName(name, field) === 'version') {
      return `${collisionPrefix(gqltype.name)} ${gqltype.name}.${name} uses version as its connectionField; choose another one`;
    }
  }
  return null;
};

/**
 * For a collection (a list relation that is not embedded) of `ownerType.fieldName` whose item type
 * declares optimistic concurrency: the INVALID_MODEL message when the collection links its items through
 * `version`, by its connectionField or, without one, by its own field name; otherwise null. The link
 * would resolve to the injected version field instead of a field of the application.
 */
export const versionConnectionCollision = (ownerType, fieldName, field) => {
  const relation = field.extensions?.relation;
  const itemType = getListShape(field.type)?.itemType;
  if (!relation || relation.embedded || !isObjectType(itemType)) return null;
  if ((relation.connectionField || fieldName) !== 'version' || !isProtectedType(itemType)) return null;
  return `${collisionPrefix(itemType.name)} ${ownerType.name}.${fieldName} links its items through version; use another connectionField`;
};

/**
 * The INVALID_MODEL message for the first field of the type that is typed RecordVersion (the instance
 * this module exports, single or list, required or not) without being the injected version field, or
 * null. Only the managed field may use the scalar in a type; a registered mutation or custom query may
 * still use it in its own input and output types.
 */
export const recordVersionFieldMisuse = (gqltype) => {
  for (const [name, field] of Object.entries(gqltype.getFields())) {
    if (getNamedType(field.type) === RecordVersion && !isVersionField(field)) {
      return `${gqltype.name}.${name} uses RecordVersion, which only the managed version field may use`;
    }
  }
  return null;
};
