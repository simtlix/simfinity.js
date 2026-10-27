import {
  GraphQLID, getNamedType, isEnumType, isInputObjectType, isListType, isNonNullType,
} from 'graphql';
import SimfinityError from './errors/simfinity.error.js';
import { RecordVersionRef } from './record-version.js';

// Internal, and never exported from the package. The typed walk that validates the inputs of the
// lifecycle helpers and of the generated transaction (#151) and builds the snapshots they work on.
// It is pure: it reads the value and its GraphQL input type, calls no scalar function and no hook,
// and never changes what it is given. Every container, list and plain-data scalar of the result is
// new, so no two positions of a snapshot share an object and a hook that rewrites one cannot change
// another, a retry or the caller's input.

// Programmatic callers get the whole check; a transaction's operations arrive already coerced by
// GraphQL, so they only get the scalar and record-key rules; a copy of a snapshot gets no check.
const MODES = ['programmatic', 'coerced', 'copy'];

const UNKNOWN_FIELD = 'unknown field';
const STATE_FIELD = 'state changes only through transitionObject';
const EXPECTED_OBJECT = 'expected a plain object';
const EXPECTED_LIST = 'expected a list';
const EXPECTED_DENSE_LIST = 'expected a dense list';
const ACCESSOR = 'accessor property';
const HIDDEN_PROPERTY = 'non-enumerable or symbol-keyed property';
const CYCLE = 'cycle';
const UNSUPPORTED_SCALAR = 'unsupported scalar value';
const STRING_KEY = 'pass the ID as a string, for example String(record._id)';
const PRIMITIVE_KEY = 'pass the ID as a primitive value';
const NESTED_TOO_DEEPLY = 'input is nested too deeply';

const requiredValueError = (path) => new SimfinityError(`Required value ${path} is missing`, 'REQUIRED_VALUE', 400);

// The message names the path and the rule, never a value.
const invalidInputError = (path, reason) => new SimfinityError(`Invalid input at ${path}: ${reason}`,
  'INVALID_INPUT', 400);

// How many containers one scalar value may nest. Past it the copy would recurse without a bound: a JSON
// value of a few thousand nested arrays is a client's to send, and it must be refused as input, not
// crash with a stack overflow.
const MAX_SCALAR_DEPTH = 256;

// How many input objects and lists an input may nest, the top-level input object included. Past it the walk
// would recurse without a bound and end in a stack overflow, a 500 where GraphQL's own roots give a 400.
// Scalar values inside count on their own, against MAX_SCALAR_DEPTH.
const MAX_INPUT_DEPTH = 256;

const intrinsicGetTime = Date.prototype.getTime;

// The time of a real Date, read with the intrinsic so that nothing the caller put on the value runs, or
// undefined when the value is not one (an object that only has the Date prototype, a Proxy of a Date).
const dateTime = (value) => {
  try {
    return intrinsicGetTime.call(value);
  } catch {
    return undefined;
  }
};

const isPrimitive = (value) => ['string', 'number', 'boolean', 'bigint'].includes(typeof value);

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

// Every copied property is an own data property, even `__proto__`, which assignment would turn into a
// change of prototype.
const defineData = (target, key, value) => Object.defineProperty(target, key,
  { value, writable: true, enumerable: true, configurable: true });

// The keys the walk visits: with checks, every own key, so that a symbol key is seen and rejected;
// without them, the enumerable string keys.
const ownKeysOf = (source, checked) => (checked ? Reflect.ownKeys(source) : Object.keys(source));

// The value of an own property, read from its descriptor so that a getter is never run. Only an
// enumerable data property qualifies. The caller has already refused symbol keys.
const dataProperty = (source, key, path) => {
  const descriptor = Object.getOwnPropertyDescriptor(source, key);
  // A key that was reported and then has no descriptor (a Proxy, or a property that caller code removed
  // while the walk was running) is as hidden as one that is not enumerable.
  if (descriptor === undefined) throw invalidInputError(path, HIDDEN_PROPERTY);
  if (!('value' in descriptor)) throw invalidInputError(path, ACCESSOR);
  if (!descriptor.enumerable) throw invalidInputError(path, HIDDEN_PROPERTY);
  return descriptor.value;
};

// The items of a list, in order. With checks the list must be dense and made of enumerable data
// properties; without them it is read as it is.
const listItems = (list, path, checked) => {
  const items = [];
  for (let index = 0; index < list.length; index += 1) {
    if (!checked) {
      items.push(list[index]);
    } else if (Object.hasOwn(list, index)) {
      items.push(dataProperty(list, index, `${path}[${index}]`));
    } else {
      throw invalidInputError(path, EXPECTED_DENSE_LIST);
    }
  }
  return items;
};

// Cycles are looked for along the path from the root to the value being copied, so an object that two
// positions share without containing itself is not one. `state.depth` counts the input objects and lists
// entered, and the one past MAX_INPUT_DEPTH is refused at its own path.
const enter = (source, path, state) => {
  if (state.ancestors.has(source)) throw invalidInputError(path, CYCLE);
  if (state.depth >= MAX_INPUT_DEPTH) throw invalidInputError(path, NESTED_TOO_DEEPLY);
  state.ancestors.add(source);
  state.depth += 1;
};

const leave = (source, state) => {
  state.ancestors.delete(source);
  state.depth -= 1;
};

// A scalar value as plain data: primitives as they are, `Date` by time, and arrays and objects with
// the Object or a null prototype deeply. `shared` maps the objects already copied within this one
// value, so a reference it repeats stays shared in the copy; a position never shares with another.
// Each copied object keeps its source's prototype and is never frozen. Anything else (a function, a
// symbol, an instance of another class such as ObjectId, Buffer or Map) is unsupported, and so is a
// value nested in more than MAX_SCALAR_DEPTH containers. `depth` counts the containers above the value.
const copyData = (value, path, state, shared, depth = 0) => {
  if (typeof value === 'function' || typeof value === 'symbol') {
    if (state.checkValues) throw invalidInputError(path, UNSUPPORTED_SCALAR);
    return value;
  }
  if (value === null || typeof value !== 'object') return value;
  const isList = Array.isArray(value);
  const time = !isList && Object.getPrototypeOf(value) === Date.prototype ? dateTime(value) : undefined;
  const isDate = time !== undefined;
  if (!isList && !isDate && !isPlainObject(value)) {
    if (state.checkValues) throw invalidInputError(path, UNSUPPORTED_SCALAR);
    return value;
  }
  if (state.ancestors.has(value)) throw invalidInputError(path, CYCLE);
  if (shared.has(value)) return shared.get(value);
  let copy;
  if (isDate) {
    copy = new Date(time);
  } else {
    if (depth >= MAX_SCALAR_DEPTH) throw invalidInputError(path, UNSUPPORTED_SCALAR);
    state.ancestors.add(value);
    if (isList) {
      copy = listItems(value, path, state.checkValues)
        .map((item, index) => copyData(item, `${path}[${index}]`, state, shared, depth + 1));
    } else {
      copy = Object.create(Object.getPrototypeOf(value));
      for (const key of ownKeysOf(value, state.checkValues)) {
        if (typeof key === 'symbol') throw invalidInputError(path, HIDDEN_PROPERTY);
        const keyPath = `${path}.${key}`;
        const item = state.checkValues ? dataProperty(value, key, keyPath) : value[key];
        defineData(copy, key, copyData(item, keyPath, state, shared, depth + 1));
      }
    }
    state.ancestors.delete(value);
  }
  shared.set(value, copy);
  return copy;
};

// A record key: where the declared type is ID, and for IdInputType.id, only a string; where it is
// another scalar, any primitive. Plain objects, arrays, dates and class instances such as ObjectId are
// refused, because on a database that casts nothing an `id` of { $ne: null } would select a record (D1).
const assertRecordKey = (value, kind, path) => {
  const accepted = kind === 'string' ? typeof value === 'string' : isPrimitive(value);
  if (!accepted) throw invalidInputError(path, kind === 'string' ? STRING_KEY : PRIMITIVE_KEY);
};

const keyKind = (declaredType, isIdInput = false) => (
  isIdInput || getNamedType(declaredType) === GraphQLID ? 'string' : 'primitive'
);

const walkScalar = (value, path, state, position) => {
  if (state.checkValues && position.key !== undefined) assertRecordKey(value, position.key, path);
  return copyData(value, path, state, new Map());
};

// The matched internal value is kept by identity. The test is membership under SameValueZero, which is
// what `includes` uses; it is not parseValue, and only programmatic input needs it, as GraphQL has
// already checked a transaction's.
const walkEnum = (value, type, path, state) => {
  if (state.checkShape && !type.getValues().map((entry) => entry.value).includes(value)) {
    throw invalidInputError(path, `not a value of enum ${type.name}`);
  }
  return value;
};

const walkList = (value, type, path, state, position) => {
  if (!Array.isArray(value)) {
    if (state.checkShape) throw invalidInputError(path, EXPECTED_LIST);
    return walkValue(value, type.ofType, path, state, position);
  }
  enter(value, path, state);
  // walkValue turns an `undefined` item into `null`, which executeItemFunction skips.
  const items = listItems(value, path, state.checkShape)
    .map((item, index) => walkValue(item, type.ofType, `${path}[${index}]`, state, position));
  leave(value, state);
  return items;
};

const walkObject = (value, type, path, state, position) => {
  if (state.checkShape && !isPlainObject(value)) throw invalidInputError(path, EXPECTED_OBJECT);
  // Only a coerced or copied value can get here without being an object, and GraphQL does not
  // produce one: it is copied as plain data.
  if (typeof value !== 'object' || Array.isArray(value)) return copyData(value, path, state, new Map());
  enter(value, path, state);
  const fields = type.getFields();
  const isCollection = state.collectionInputTypes?.has(type) === true;
  // The top-level id of an update, a transition or a delete is required whatever its declared type,
  // and it is a record key.
  const isTopLevelId = (key) => key === 'id' && position.topLevel === true && state.requireId;
  const copy = {};
  for (const key of ownKeysOf(value, state.checkShape)) {
    if (typeof key === 'symbol') throw invalidInputError(path, HIDDEN_PROPERTY);
    const fieldPath = `${path}.${key}`;
    const item = state.checkShape ? dataProperty(value, key, fieldPath) : value[key];
    // An own `undefined` is an omitted field, as GraphQL never delivers one.
    if (item === undefined) continue;
    const field = Object.hasOwn(fields, key) ? fields[key] : undefined;
    if (field === undefined) {
      if (state.checkShape) {
        const managedState = position.topLevel && state.stateManaged && key === 'state';
        throw invalidInputError(fieldPath, managedState ? STATE_FIELD : UNKNOWN_FIELD);
      }
      // GraphQL leaves no undeclared field in a coerced input, so there is no rule to apply: the
      // value is kept as plain data.
      defineData(copy, key, walkScalar(item, fieldPath, state, {}));
      continue;
    }
    const fieldPosition = {};
    if (key === 'id' && (isTopLevelId(key) || position.idIsKey || type === state.idInputType
      || type === state.recordVersionRef)) {
      fieldPosition.key = keyKind(field.type, type === state.idInputType);
    }
    if (isCollection && key === 'updated') fieldPosition.idIsKey = true;
    if (isCollection && key === 'deleted') fieldPosition.key = keyKind(field.type);
    if (item === null && isTopLevelId(key)) throw requiredValueError(fieldPath);
    defineData(copy, key, walkValue(item, field.type, fieldPath, state, fieldPosition));
  }
  leave(value, state);
  for (const [name, field] of Object.entries(fields)) {
    const required = (state.checkShape && isNonNullType(field.type)) || isTopLevelId(name);
    if (required && !Object.hasOwn(copy, name)) throw requiredValueError(`${path}.${name}`);
  }
  return copy;
};

const walkValue = (value, type, path, state, position) => {
  if (isNonNullType(type)) {
    if (state.checkShape && (value === null || value === undefined)) throw requiredValueError(path);
    return walkValue(value, type.ofType, path, state, position);
  }
  if (value === null || value === undefined) return null;
  if (isListType(type)) return walkList(value, type, path, state, position);
  if (isInputObjectType(type)) return walkObject(value, type, path, state, position);
  if (isEnumType(type)) return walkEnum(value, type, path, state);
  return walkScalar(value, path, state, position);
};

const createWalkState = ({
  mode = 'programmatic', topLevelId = false, stateManaged = false, collectionInputTypes, idInputType,
  recordVersionRef = RecordVersionRef,
}) => {
  if (!MODES.includes(mode)) throw new TypeError(`Unknown input walk mode: ${typeof mode === 'string' ? mode : typeof mode}`);
  return {
    // Containers, lists, fields, nullability and enums.
    checkShape: mode === 'programmatic',
    // Scalars and record keys.
    checkValues: mode !== 'copy',
    requireId: topLevelId === true && mode !== 'copy',
    stateManaged: stateManaged === true,
    collectionInputTypes,
    idInputType,
    recordVersionRef,
    ancestors: new Set(),
    depth: 0,
  };
};

/**
 * Validates `value` against an input object type and returns a snapshot of it.
 *
 * `options.mode` is 'programmatic' (the default: the structure rules and the scalar rules, for the
 * lifecycle helpers), 'coerced' (the scalar rules and the record keys only, for the operations of a
 * transaction, which GraphQL has already coerced) or 'copy' (no check, a type-directed copy of an
 * existing snapshot for one attempt). `path` names the root in errors (default `input`). `topLevelId`
 * makes the top-level `id` required and a record key. `collectionInputTypes` is the set of generated
 * collection inputs (`added`, `updated`, `deleted`), `idInputType` the input of a single reference and
 * `recordVersionRef` the input of a versioned delete (default: Simfinity's own), which the walk knows
 * by identity to find their record keys. With `stateManaged`, an undeclared top-level `state` says that
 * state changes only through transitionObject; elsewhere it is an unknown field.
 *
 * Input objects and lists may nest 256 levels, the top-level input included, in every mode; the next one
 * is refused with `input is nested too deeply`.
 *
 * A missing or null value throws REQUIRED_VALUE (400) and any other violation INVALID_INPUT (400), both
 * naming a path such as `input.lines.added[1].price` and never a value. The value is never changed.
 * The result has new, extensible, plain containers; dates and plain data are copied and enum values
 * are kept by identity.
 */
export const snapshotOperationInput = (value, inputType, options = {}) => {
  const state = createWalkState(options);
  const path = options.path ?? 'input';
  if (!isInputObjectType(isNonNullType(inputType) ? inputType.ofType : inputType)) {
    throw new TypeError('snapshotOperationInput needs an input object type');
  }
  if (value === undefined || value === null) {
    if (state.checkValues) throw requiredValueError(path);
    return value;
  }
  return walkValue(value, inputType, path, state, { topLevel: true });
};

/**
 * The target of `deleteObject`: a plain object with `id` and, on a protected type only, `version`. The
 * id is a record key and must be a string, as the `ID` of the delete root is (D1). Any other key,
 * including `version` on a type that is not protected, is an unknown field. A missing id, or a missing
 * version on a protected type, throws REQUIRED_VALUE; a version that is present but invalid is left for
 * the OCC check inside the attempt. Returns `{ id }` or `{ id, version }`, which are new objects.
 */
export const readDeleteTarget = (value, { protectedType, path = 'input' } = {}) => {
  if (value === undefined || value === null) throw requiredValueError(path);
  if (!isPlainObject(value)) throw invalidInputError(path, EXPECTED_OBJECT);
  const state = createWalkState({});
  let id;
  let version;
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key === 'symbol') throw invalidInputError(path, HIDDEN_PROPERTY);
    const keyPath = `${path}.${key}`;
    const item = dataProperty(value, key, keyPath);
    if (item === undefined) continue;
    if (key !== 'id' && !(key === 'version' && protectedType)) throw invalidInputError(keyPath, UNKNOWN_FIELD);
    if (item === null) throw requiredValueError(keyPath);
    if (key === 'id') {
      assertRecordKey(item, 'string', keyPath);
      id = item;
    } else {
      version = copyData(item, keyPath, state, new Map());
    }
  }
  if (id === undefined) throw requiredValueError(`${path}.id`);
  if (!protectedType) return { id };
  if (version === undefined) throw requiredValueError(`${path}.version`);
  return { id, version };
};
