import SimfinityError from './errors/simfinity.error.js';
import { getListShape, isVirtualField, VIRTUAL_MCP_MODES } from './relation-storage.js';

// Internal checks of virtual field declarations (`extensions.virtual`), shared by createSchema() and
// describeModels(). A virtual field is resolved by its own resolver and stored nowhere, so every
// setting or use that needs storage, a generated input or a query path is rejected.

const invalid = (message) => {
  throw new SimfinityError(message, 'INVALID_MODEL', 400);
};

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

// Settings that describe storage, writes or the query language, which a virtual field has none of.
// `readOnly: true` and `queryable: false` restate what virtual implies, so they are allowed.
const CONFLICTING_SETTINGS = [
  ['relation', (value) => !!value, 'extensions.relation'],
  ['unique', (value) => value === true, 'unique: true'],
  ['validations', (value) => !!value, 'extensions.validations'],
  ['queryable', (value) => value === true, 'queryable: true'],
  ['readOnly', (value) => value === false, 'readOnly: false'],
];

/**
 * The settings of a field's extensions that a virtual field cannot declare, as its INVALID_MODEL message
 * names them (such as 'extensions.relation'), in the order they are checked. Empty when it could be virtual.
 */
export const virtualConflicts = (extensions = {}) => CONFLICTING_SETTINGS
  .filter(([key, conflicts]) => conflicts(extensions[key])).map(([, , setting]) => setting);

const ownField = (type, name) => {
  const fields = typeof type?.getFields === 'function' ? type.getFields() : null;
  return fields && typeof name === 'string' && Object.hasOwn(fields, name) ? fields[name] : undefined;
};

/**
 * Checks the `extensions.virtual` declaration of `typeName.fieldName` and returns whether the field is
 * virtual. `hasOwnResolver()` tells whether the field has its own resolver; it is called only for a
 * field that declares `virtual`. Throws INVALID_MODEL (400), naming the type and field, for a value
 * other than `true` or a plain options object, an unknown option, an `mcp` option other than 'tool',
 * 'select' or false, a missing resolver, a conflicting setting, and an identity field (`id` or `_id`).
 */
export const assertVirtualDeclaration = (typeName, fieldName, field, hasOwnResolver) => {
  const extensions = field.extensions || {};
  const { virtual } = extensions;
  if (virtual === undefined) return false;
  const name = `${typeName}.${fieldName}`;
  if (virtual !== true) {
    if (!isPlainObject(virtual)) invalid(`${name} extensions.virtual must be true or an options object such as { mcp: 'select' }`);
    const unknown = Object.keys(virtual).find((key) => key !== 'mcp');
    if (unknown !== undefined) invalid(`${name} extensions.virtual has the unknown option ${unknown}; its only option is mcp`);
    if (virtual.mcp !== undefined && !VIRTUAL_MCP_MODES.includes(virtual.mcp)) {
      invalid(`${name} extensions.virtual.mcp must be 'tool', 'select' or false`);
    }
  }
  if (!hasOwnResolver()) invalid(`${name} is virtual, so it requires its own resolve function`);
  const [setting] = virtualConflicts(extensions);
  if (setting) invalid(`${name} is virtual, which is never stored, so it cannot declare ${setting}`);
  if (fieldName === 'id' || fieldName === '_id') invalid(`${name} is the identity field, so it cannot be virtual`);
  return true;
};

/**
 * A reference stores its link under its connectionField, on its own type, and a collection reads its
 * items by their type's connectionField. Throws INVALID_MODEL (400) when that field is virtual.
 */
export const assertVirtualConnection = (type, fieldName, field) => {
  const relation = field.extensions?.relation;
  if (!relation || relation.embedded || typeof relation.connectionField !== 'string' || !relation.connectionField) return;
  const listShape = getListShape(field.type);
  const holder = listShape ? listShape.itemType : type;
  if (isVirtualField(ownField(holder, relation.connectionField))) {
    invalid(`${type.name}.${fieldName} uses the virtual field ${holder.name}.${relation.connectionField} as its `
      + 'connectionField; a virtual field is never stored');
  }
};

/** Throws INVALID_MODEL (400) when an entry of the type's `extensions.indexes` names a virtual field. */
export const assertVirtualIndexes = (type) => {
  const indexes = type.extensions?.indexes;
  if (!Array.isArray(indexes)) return;
  for (const index of indexes) {
    for (const name of Array.isArray(index?.fields) ? index.fields : []) {
      if (isVirtualField(ownField(type, name))) {
        invalid(`An index of ${type.name} names the virtual field ${type.name}.${name}, which is never stored`);
      }
    }
  }
};

/** Throws INVALID_MODEL (400) when the `state` field of a type with a state machine is virtual. */
export const assertVirtualStateField = (type, stateMachine) => {
  if (stateMachine && isVirtualField(ownField(type, 'state'))) {
    invalid(`${type.name}.state holds the state of its state machine, so it cannot be virtual`);
  }
};
