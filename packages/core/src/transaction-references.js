import {
  GraphQLID, GraphQLNonNull, GraphQLObjectType, getNamedType, isInputObjectType,
} from 'graphql';
import SimfinityError from './errors/simfinity.error.js';
import { getListShape, normalizeConnectionField } from './relation-storage.js';

// Internal, and never exported from the package. The references of the generated transaction (#151,
// spec section 4.3): an operation names the ID of an earlier operation's result with a `$K` token in one
// of four ID positions. planReferences() checks every token once, before the transaction, and
// resolveReferences() writes the IDs into each attempt's copy of the operations.
//
// The positions are found by walking each operation's value along its GraphQL input types, with the
// object type that generated them for the relation metadata (extensions.relation). Strings are never
// scanned: a value outside the four positions keeps its text, `$` included. The positions are:
//   1. the `id` of an update, action or delete operation;
//   2. the `id` of a single (non-embedded) reference field, an IdInputType;
//   3. the `id` of a nested `updated` entry and each nested `deleted` entry;
//   4. a non-list ID field of a child type that is the connectionField of collection fields, whose
//      expected type is the type declaring those collections.

const SAVE = 'save';
const DELETE = 'delete';
// `$K`, with K = 0 or [1-9][0-9]*.
const TOKEN = /^\$(0|[1-9][0-9]*)$/;
// The expected type of a position that collections declared on two or more types claim (item 4).
const AMBIGUOUS = Symbol('ambiguous inverse reference');

const unwrapNonNull = (type) => (type instanceof GraphQLNonNull ? type.ofType : type);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// `parent.name` for a field and `parent[n]` for a list item.
const childPath = (path, step) => (typeof step === 'number' ? `${path}[${step}]` : `${path}.${step}`);

// Names the operation and the path; the message never holds the value.
const referenceError = (operationIndex, operation, path, reason) => {
  const error = new SimfinityError(`Invalid reference at ${path}: ${reason}`, 'INVALID_OPERATION_REFERENCE', 400);
  error.extensions.operationIndex = operationIndex;
  error.extensions.operation = operation;
  return error;
};

// Item 4, for the types registered in a runtime: child type -> field name -> the types declaring a
// collection of that child whose connectionField (aliases included, through normalizeConnectionField)
// is that field. Only a non-list ID field counts. A collection without a connectionField, or whose
// connectionField names no field of the child, adds nothing.
const inverseReferences = (registry) => {
  const index = new Map();
  for (const declaring of registry.registeredTypes()) {
    for (const field of Object.values(declaring.getFields())) {
      const relation = field.extensions?.relation;
      const listShape = getListShape(field.type);
      if (!relation || relation.embedded || !listShape || !(listShape.itemType instanceof GraphQLObjectType)
        || typeof relation.connectionField !== 'string' || relation.connectionField === '') continue;
      const child = listShape.itemType;
      const { graphqlFieldName } = normalizeConnectionField(child, relation.connectionField);
      if (!graphqlFieldName || unwrapNonNull(child.getFields()[graphqlFieldName].type) !== GraphQLID) continue;
      if (!index.has(child)) index.set(child, new Map());
      const fields = index.get(child);
      if (!fields.has(graphqlFieldName)) fields.set(graphqlFieldName, new Set());
      fields.get(graphqlFieldName).add(declaring);
    }
  }
  return index;
};

/**
 * Plans the references of a transaction's operations.
 *
 * `operations` is the snapshot of the operation list, after the input walk: an array of `{ [key]: value }`
 * items. `transactionState` is the state of the schema's transaction field (`operations`: key -> `{ type,
 * operation, ... }`, where `type.gqltype` and `type.inputType` are the registered type and the input of
 * the root). `registry` is `{ registeredTypes: () => GraphQLObjectType[] }`, the types registered in the
 * runtime, over which the collections of item 4 are counted.
 *
 * Checks every token in an eligible position and throws INVALID_OPERATION_REFERENCE (400) for the first
 * failure, in operation order, with `extensions.operationIndex` and `extensions.operation` and a message
 * naming the path, such as `operations[2].updatepedido.items.updated[0].id`. The reasons are: malformed
 * reference; operation K does not precede it; operation K does not exist; operation K is a delete;
 * operation K writes <Type>, expected <Type>; ambiguous inverse reference. When every check passes, a
 * value starting with `$$` loses one `$` in `operations`, in place (a failed plan leaves `operations` as
 * it was), and the plan lists the tokens.
 *
 * Returns a frozen array of frozen positions `{ index, path, source, location }`: the operation holding
 * the token, its path, K, and the steps from `operations[index]` to the token, for resolveReferences().
 * The tokens stay in `operations`; each attempt's copy of it has them resolved.
 */
export const planReferences = (operations, transactionState, registry) => {
  const sourceKeys = operations.map((item) => Object.keys(item)[0]);
  const positions = [];
  const escapes = [];
  let owners = null;
  let current = null;

  // The expected type of a non-list ID field of `child` (item 4): the single type declaring the
  // collections that use it, AMBIGUOUS when two or more do, or undefined when none does.
  const inverseOwner = (child, fieldName) => {
    owners ??= inverseReferences(registry);
    const declaring = owners.get(child)?.get(fieldName);
    if (declaring === undefined) return undefined;
    return declaring.size === 1 ? [...declaring][0] : AMBIGUOUS;
  };

  // `parent[step]`, found at `parentPath` and `parentLocation`, is a record key of an eligible position
  // that expects a record of type `expected`.
  const reference = (parent, step, parentPath, parentLocation, expected) => {
    const value = parent[step];
    if (typeof value !== 'string' || !value.startsWith('$')) return;
    if (value.startsWith('$$')) {
      escapes.push({ parent, step, literal: value.slice(1) });
      return;
    }
    const path = childPath(parentPath, step);
    const fail = (reason) => referenceError(current.index, current.key, path, reason);
    const match = TOKEN.exec(value);
    if (!match) throw fail('malformed reference');
    const [, digits] = match;
    const source = Number(digits);
    if (source >= operations.length) throw fail(`operation ${digits} does not exist`);
    if (source >= current.index) throw fail(`operation ${digits} does not precede it`);
    const written = transactionState.operations.get(sourceKeys[source]);
    if (written.operation === DELETE) throw fail(`operation ${digits} is a delete`);
    if (expected === AMBIGUOUS) throw fail('ambiguous inverse reference');
    if (written.type.gqltype !== expected) {
      throw fail(`operation ${digits} writes ${written.type.gqltype.name}, expected ${expected.name}`);
    }
    positions.push(Object.freeze({
      index: current.index, path, source, location: Object.freeze([...parentLocation, step]),
    }));
  };

  // A record of `gqltype` as `inputType` writes it. Its `id` is a position when `idIsPosition`, which
  // holds for the update input of an operation or of a nested `updated` entry.
  const planObject = (value, inputType, gqltype, path, location, idIsPosition) => {
    const inputFields = inputType.getFields();
    const fields = gqltype.getFields();
    for (const name of Object.keys(value)) {
      if (value[name] === null || value[name] === undefined) continue;
      if (name === 'id') {
        if (idIsPosition) reference(value, name, path, location, gqltype);
      } else if (Object.hasOwn(fields, name) && Object.hasOwn(inputFields, name)) {
        planField(value, name, fields[name], inputFields[name], gqltype, path, location);
      }
    }
  };

  // `value[name]` against the field of `owner` that generated its input: a single reference, an embedded
  // value, a referenced collection, or a non-list ID that is some collection's connectionField.
  const planField = (value, name, field, inputField, owner, path, location) => {
    const relation = field.extensions?.relation;
    const listShape = getListShape(field.type);
    const input = getNamedType(inputField.type);
    const item = value[name];
    const fieldPath = childPath(path, name);
    const fieldLocation = [...location, name];
    if (listShape) {
      if (!(listShape.itemType instanceof GraphQLObjectType) || !isInputObjectType(input)) return;
      if (!relation?.embedded) {
        if (isObject(item)) planCollection(item, input, listShape.itemType, fieldPath, fieldLocation);
      } else if (Array.isArray(item)) {
        item.forEach((embedded, position) => {
          if (!isObject(embedded)) return;
          planObject(embedded, input, listShape.itemType, childPath(fieldPath, position), [...fieldLocation, position], false);
        });
      }
      return;
    }
    const named = unwrapNonNull(field.type);
    if (named instanceof GraphQLObjectType) {
      if (!relation || !isObject(item) || !isInputObjectType(input)) return;
      if (relation.embedded) planObject(item, input, named, fieldPath, fieldLocation, false);
      else reference(item, 'id', fieldPath, fieldLocation, named);
    } else if (named === GraphQLID && typeof item === 'string' && item.startsWith('$')) {
      // Only a value that could be a token or an escape needs to know whether the field is claimed.
      const expected = inverseOwner(owner, name);
      if (expected !== undefined) reference(value, name, path, location, expected);
    }
  };

  // The `added`, `updated` and `deleted` entries of a referenced collection's input, whose items are
  // records of `itemType`. A null entry writes nothing.
  const planCollection = (value, collectionInput, itemType, path, location) => {
    const inputFields = collectionInput.getFields();
    for (const key of ['added', 'updated']) {
      const itemInput = Object.hasOwn(inputFields, key) ? getNamedType(inputFields[key].type) : undefined;
      if (!isInputObjectType(itemInput) || !Array.isArray(value[key])) continue;
      value[key].forEach((entry, position) => {
        if (!isObject(entry)) return;
        planObject(entry, itemInput, itemType, childPath(childPath(path, key), position),
          [...location, key, position], key === 'updated');
      });
    }
    if (!Object.hasOwn(inputFields, 'deleted') || !Array.isArray(value.deleted)) return;
    // A protected item is deleted at a version: `{ id, version }`; otherwise the entry is the ID.
    const versioned = isInputObjectType(getNamedType(inputFields.deleted.type));
    const deletedPath = childPath(path, 'deleted');
    const deletedLocation = [...location, 'deleted'];
    value.deleted.forEach((entry, position) => {
      if (!versioned) {
        reference(value.deleted, position, deletedPath, deletedLocation, itemType);
      } else if (isObject(entry)) {
        reference(entry, 'id', childPath(deletedPath, position), [...deletedLocation, position], itemType);
      }
    });
  };

  operations.forEach((item, index) => {
    const key = sourceKeys[index];
    if (key === undefined) return;
    const entry = transactionState.operations.get(key);
    if (entry === undefined) throw new TypeError(`Unknown transaction operation ${key}`);
    const value = item[key];
    if (!isObject(value)) return;
    current = { index, key };
    const path = `operations[${index}].${key}`;
    const { gqltype, inputType } = entry.type;
    if (entry.operation === DELETE) reference(value, 'id', path, [key], gqltype);
    else if (inputType) planObject(value, inputType, gqltype, path, [key], entry.operation !== SAVE);
  });

  for (const { parent, step, literal } of escapes) parent[step] = literal;
  return Object.freeze(positions);
};

// The ID of a result as a client would send it back, serialized like the ID scalar: a string for a
// string, an integer or an object such as an ObjectId.
const serializeResultId = (result, source) => {
  if (result === undefined || result === null || result.id === undefined || result.id === null) {
    throw new Error(`The result of operation ${source} has no ID to reference`);
  }
  return GraphQLID.serialize(result.id);
};

/**
 * Writes the IDs of results into the tokens of one attempt's copy of the operations, in place.
 *
 * `attemptOperations` is the attempt's copy of the planned snapshot, `referencePlan` what planReferences
 * returned for it, and `attemptResults` an array indexed by operation index, filled as the attempt runs,
 * whose entries are `{ id }`: the stored ID of that operation's record, as the adapter returned it
 * (a string, an integer or an ObjectId). Each position gets its source's ID serialized like the ID scalar,
 * overwriting what the position holds, so the IDs of a rolled-back attempt are never kept: the next
 * attempt starts from a new copy and its own results.
 *
 * Without `operationIndex`, every position whose source already has a result is written and the others
 * keep their tokens. With it, only the positions of that operation are written, and a missing result is
 * an error; an attempt calls it with the index of the operation about to run, right before authorizing it.
 */
export const resolveReferences = (attemptOperations, referencePlan, attemptResults, operationIndex = undefined) => {
  for (const position of referencePlan) {
    if (operationIndex !== undefined && position.index !== operationIndex) continue;
    const result = attemptResults[position.source];
    if (operationIndex === undefined && (result === undefined || result === null)) continue;
    const id = serializeResultId(result, position.source);
    let holder = attemptOperations[position.index];
    for (const step of position.location.slice(0, -1)) holder = holder?.[step];
    if (!isObject(holder) && !Array.isArray(holder)) {
      throw new Error(`The copy of operation ${position.index} has no value at ${position.path}`);
    }
    holder[position.location.at(-1)] = id;
  }
};
