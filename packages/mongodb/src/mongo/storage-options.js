import { GraphQLInt, GraphQLFloat, getNullableType } from 'graphql';
import { SimfinityError } from '@simtlix/simfinity-core';
import {
  assertStorageDocument,
  assertStorageFilter,
  invalidStorage,
} from './storage-validation.js';

const STORAGE_OPTIONS = new Set(['filter', 'increments', 'nulls', 'id']);
const MUTATIONS = new Set(['save', 'update', 'delete']);
const NUMERIC_SCHEMA_TYPES = new Set(['Number', 'Decimal128']);
const NUMERIC_SCALARS = new Set([GraphQLInt, GraphQLFloat]);
const INT_MIN = -(2 ** 31);
const INT_MAX = 2 ** 31 - 1;

export const validateMongoSession = (Model, session) => {
  if (session.client !== Model.db.getClient()) {
    throw new SimfinityError('Session belongs to another MongoDB client', 'INVALID_SESSION', 400);
  }
  if (!session.inTransaction()) {
    throw new SimfinityError(
      'A supplied session must have an active transaction',
      'ACTIVE_TRANSACTION_REQUIRED',
      400,
    );
  }
};

const incrementScalar = (Model, gqltype, path, amount) => {
  const field = gqltype.getFields()[path];
  const numericStorage = NUMERIC_SCHEMA_TYPES.has(Model.schema.path(path)?.instance);
  const finiteAmount = typeof amount === 'number' && Number.isFinite(amount);
  if (!field || field.extensions?.readOnly || !numericStorage || !finiteAmount) {
    throw invalidStorage(
      'Increments require registered writable numeric fields and finite amounts',
    );
  }
  if (field.extensions?.validations) {
    throw invalidStorage('Fields with validators require a generated absolute update');
  }
  const scalar = getNullableType(field.type);
  if (!NUMERIC_SCALARS.has(scalar)) {
    throw invalidStorage('Increments require built-in Int or Float fields');
  }
  try {
    scalar.parseValue(amount);
  } catch {
    throw invalidStorage('Increment does not match its declared numeric scalar');
  }
  return scalar;
};

// Reject invalid results in the atomic predicate, before an adopted transaction
// could commit them. Missing numeric fields start at zero; null does not.
const incrementGuard = (path, amount, scalar) => {
  const integer = scalar === GraphQLInt;
  const min = integer ? INT_MIN : -Number.MAX_VALUE;
  const max = integer ? INT_MAX : Number.MAX_VALUE;
  const range = {
    $type: 'number',
    $gte: integer ? Math.max(min, min - amount) : min,
    $lte: integer ? Math.min(max, max - amount) : max,
  };
  const storedValue = '$' + path;
  // Expression $mod retains fractions; query $mod truncates doubles. Float
  // bounds test Mongo's actual addition because subtraction can round.
  const result = integer
    ? { $eq: [{ $mod: [storedValue, 1] }, 0] }
    : {
        $let: {
          vars: { sum: { $add: [storedValue, amount] } },
          in: { $and: [{ $gte: ['$$sum', min] }, { $lte: ['$$sum', max] }] },
        },
      };
  const numeric = {
    $and: [{ [path]: range }, { $expr: { $cond: [{ $isNumber: storedValue }, result, false] } }],
  };
  return { $or: [{ [path]: { $exists: false } }, numeric] };
};

const incrementGuards = (Model, gqltype, operation, increments) => {
  if (!increments) {
    return [];
  }
  if (operation !== 'update') {
    throw invalidStorage('Increments require update');
  }
  if (gqltype.extensions?.validations) {
    throw invalidStorage('Types with validators require a generated absolute update');
  }
  assertStorageDocument(Model, increments);
  return Object.entries(increments).map(([path, amount]) =>
    incrementGuard(path, amount, incrementScalar(Model, gqltype, path, amount)),
  );
};

const validateMutationOptions = (Model, operation, storage) => {
  for (const name of Object.keys(storage)) {
    if (!STORAGE_OPTIONS.has(name)) {
      throw invalidStorage(`Unknown storage option: ${name}`);
    }
  }
  if (storage.nulls !== undefined && storage.nulls !== 'preserve') {
    throw invalidStorage('Only preserve null semantics are supported');
  }
  if (!MUTATIONS.has(operation)) {
    throw invalidStorage('Storage options require a mutation');
  }
  if (storage.id !== undefined && operation !== 'save') {
    throw invalidStorage('A storage identity is only supported on save');
  }
  if (storage.filter === undefined) {
    return;
  }
  if (operation === 'save') {
    throw invalidStorage('Save does not accept a conditional filter');
  }
  assertStorageFilter(Model, storage.filter);
};

export const validateStorageOptions = (Model, gqltype, operation, storage, integrity) => {
  if (integrity.enabled) {
    throw new SimfinityError(
      'Storage options cannot bypass transactional reference integrity',
      'UNSUPPORTED_CAPABILITY',
      400,
    );
  }
  validateMutationOptions(Model, operation, storage);
  const guards = incrementGuards(Model, gqltype, operation, storage.increments);
  if (!guards.length) {
    return storage;
  }
  const predicates = storage.filter === undefined ? guards : [storage.filter, ...guards];
  return { ...storage, filter: { $and: predicates } };
};
