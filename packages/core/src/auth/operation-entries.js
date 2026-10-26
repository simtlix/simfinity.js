import { ForbiddenError } from './errors.js';

// Internal, and never exported from the package or its auth subpath. The authorization entries of the
// generated mutation roots (#151): each auth plugin instance that wraps a root records an entry on
// it, and the generated transaction field runs the entries of each operation's root, so the operation
// gets the checks a direct call to that root gets in the same schema.
//
// Entries live on the root field's extensions.simfinityMutation object, which keeps its identity in
// schema copies, including copies that rebuild the Mutation type. The key is a registered symbol, so
// a plugin from another copy of core records entries this copy finds. Each entry is
// `{ protocol: 1, isDeferred(schema), run(parent, args, ctx, info) }`: isDeferred is the instance's
// own test for a schema only other instances processed, and run applies the rules of one permission
// key, or the default policy, rejecting with ForbiddenError on a denial and with any error a rule
// throws.
//
// An entry belongs to a pair: an instance and the `Type.field` permission key it wrapped the root
// under, in whatever type the field sat, since a field wrapped where its type is not the mutation root
// keeps that wrapper when the type is the root of another schema. Recording a pair again replaces its
// entry and makes it the latest, as wrapping a field again makes that wrapper the outermost.
// authorizeOperation runs every entry of the marker, the latest first. For a generated schema and its
// copies that equals the wrappers a direct call runs, outermost first, so the first denial is the one
// a direct call reports. When several keys reach one marker (an alias of a root, a copy that renames
// the Mutation type), it runs the checks of all of them: never fewer than a direct call to any of
// them.

export const OPERATION_EVALUATORS = Symbol.for('simfinity.auth.operationEvaluators');
export const OPERATION_ENTRY_PROTOCOL = 1;

// The operations of the generated roots a transaction runs; registered mutations, marked
// custom_mutation, never are operations.
const GENERATED_OPERATIONS = new Set(['save', 'update', 'delete', 'state_changed']);

// Whether a field is a generated mutation root, by its extensions.simfinityMutation marker.
export const isGeneratedMutationRoot = (field) => {
  const marker = field?.extensions?.simfinityMutation;
  return marker !== null && typeof marker === 'object' && GENERATED_OPERATIONS.has(marker.operation);
};

// The entries Map of a generated root, created on first use in a non-enumerable property that cannot
// be replaced. Anything else under the key is an error, never overwritten.
const entriesOf = (field) => {
  const marker = field.extensions.simfinityMutation;
  if (!Object.hasOwn(marker, OPERATION_EVALUATORS)) {
    Object.defineProperty(marker, OPERATION_EVALUATORS, { value: new Map() });
  }
  const entries = marker[OPERATION_EVALUATORS];
  if (!(entries instanceof Map)) throw new TypeError('The authorization entries of a generated mutation root are not a Map');
  return entries;
};

// The Map key of a pair, or undefined. Keys of another core copy may have another shape.
const findPair = (entries, instanceToken, permissionKey) => {
  for (const pair of entries.keys()) {
    if (pair?.instance === instanceToken && pair?.permissionKey === permissionKey) return pair;
  }
  return undefined;
};

// Records the entry of the instance `instanceToken` for the root under `permissionKey`, replacing
// that pair's earlier entry and making it the latest.
export const recordOperationEntry = (field, instanceToken, permissionKey, entry) => {
  const entries = entriesOf(field);
  const pair = findPair(entries, instanceToken, permissionKey);
  if (pair !== undefined) entries.delete(pair);
  entries.set(Object.freeze({ instance: instanceToken, permissionKey }), entry);
};

// Whether the pair has an entry on the root.
export const hasOperationEntry = (field, instanceToken, permissionKey) => {
  const entries = field.extensions.simfinityMutation[OPERATION_EVALUATORS];
  return entries instanceof Map && findPair(entries, instanceToken, permissionKey) !== undefined;
};

/**
 * Applies to an operation on the generated root `rootField` the checks a direct call to that root gets
 * in `info.schema`: every entry on the root runs once, the latest first, unless its instance defers
 * in that schema. The rules see `info` with the root's field name and return type; the root is a
 * field of the same Mutation type as the field that runs the operation, `info.parentType`. The path,
 * field nodes and operation stay the caller's. Fails closed: an entry of an unknown protocol, deferred
 * or not, denies with ForbiddenError before any entry runs. A root with no entries passes, as a root
 * no instance wrapped does when called directly.
 * @returns {Promise<void>}
 */
export const authorizeOperation = async (rootField, parent, args, ctx, info) => {
  const marker = rootField.extensions?.simfinityMutation;
  if (marker === null || typeof marker !== 'object' || !Object.hasOwn(marker, OPERATION_EVALUATORS)) return;
  const key = `${info.parentType.name}.${rootField.name}`;
  const entries = marker[OPERATION_EVALUATORS];
  if (!(entries instanceof Map)) throw new ForbiddenError(`Access denied to ${key}`);
  const latestFirst = [...entries.values()].reverse();
  if (latestFirst.some((entry) => entry?.protocol !== OPERATION_ENTRY_PROTOCOL)) {
    throw new ForbiddenError(`Access denied to ${key}`);
  }
  // Permissions must see the identity of the root, just as when it is called directly.
  const operationInfo = {
    ...info, fieldName: rootField.name, parentType: info.parentType, returnType: rootField.type,
  };
  for (const entry of latestFirst) {
    if (entry.isDeferred(info.schema)) continue;
    await entry.run(parent, args, ctx, operationInfo);
  }
};
