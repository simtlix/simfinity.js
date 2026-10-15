import mongoose from 'mongoose';
import { types as nativeTypes } from 'node:util';
import { SimfinityError } from '@simtlix/simfinity-core';

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const BINARY_PROTOTYPES = new Set([Buffer.prototype, Uint8Array.prototype]);
const MAX_LITERAL_BYTES = 8 * 1024 * 1024;
const MAX_LITERAL_VALUES = 100000;
const MAX_LITERAL_STRING_LENGTH = 1048576;
const MAX_QUERY_NODES = 10000;
const MAX_QUERY_DEPTH = 20;
const OBJECT_ID_BYTES = 12;
const NUMBER_BYTES = 8;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;

export const invalidQuery = (message, code = 'INVALID_FILTER_VALUE') => {
  throw new SimfinityError(message, code, 400);
};

export const unsafeQueryKey = (key) =>
  UNSAFE_KEYS.has(key) || key.startsWith('$') || key.startsWith('__sf_') || key.includes('\0');

const queryPrototype = (value) => {
  if (nativeTypes.isProxy(value)) {
    invalidQuery('Proxies are not supported query data');
  }
  return Object.getPrototypeOf(value);
};

export const isPlainQueryObject = (value) => {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const prototype = queryPrototype(value);
  return prototype === Object.prototype || prototype === null;
};

export const queryEntries = (value) => {
  if (!isPlainQueryObject(value)) {
    invalidQuery('Expected a plain query object');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const dataProperties = Reflect.ownKeys(value).every(
    (key) =>
      typeof key === 'string' &&
      descriptors[key].enumerable &&
      Object.hasOwn(descriptors[key], 'value'),
  );
  if (!dataProperties) {
    invalidQuery('Query objects must contain enumerable data properties');
  }
  return Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]);
};

export const assertQueryKeys = (value, allowed) => {
  for (const [key] of queryEntries(value)) {
    if (!allowed.has(key)) {
      invalidQuery('Unsupported query option: ' + key);
    }
  }
};

export const queryArray = (value) => {
  if (!Array.isArray(value) || queryPrototype(value) !== Array.prototype) {
    invalidQuery('Expected an ordinary array');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length.value;
  if (Reflect.ownKeys(descriptors).length !== length + 1) {
    invalidQuery('Arrays require dense data elements');
  }
  return Array.from({ length }, (_, index) => {
    const descriptor = descriptors[index];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      invalidQuery('Arrays require enumerable data elements');
    }
    return descriptor.value;
  });
};

/** Per-query accounting; nothing survives the compilation of one query. */
export class QueryBudget {
  nodes = 0;
  values = 0;
  bytes = 0;
  active = new Set();

  chargeBytes(size) {
    this.bytes += size;
    if (this.bytes > MAX_LITERAL_BYTES) {
      invalidQuery('Server query literal data exceeds 8 MiB', 'FILTER_DEPTH_EXCEEDED');
    }
  }

  countNode() {
    this.nodes++;
    if (this.nodes > MAX_QUERY_NODES) {
      invalidQuery('Server query exceeds its complexity limit', 'FILTER_DEPTH_EXCEEDED');
    }
  }

  visit(value, depth, callback, literal = false) {
    if (literal) {
      this.values++;
    } else {
      this.countNode();
    }
    if (this.values > MAX_LITERAL_VALUES || depth > MAX_QUERY_DEPTH) {
      invalidQuery('Server query exceeds its complexity limit', 'FILTER_DEPTH_EXCEEDED');
    }
    if (this.active.has(value)) {
      invalidQuery('Cyclic query data');
    }
    this.active.add(value);
    try {
      return callback();
    } finally {
      this.active.delete(value);
    }
  }
}

const copyBinary = (value, budget, expectedLength) => {
  if (!value || typeof value !== 'object') {
    invalidQuery('Expected ordinary binary data');
  }
  if (!BINARY_PROTOTYPES.has(queryPrototype(value)) || !nativeTypes.isUint8Array(value)) {
    invalidQuery('Expected ordinary binary data');
  }
  const length = byteLength.call(value);
  if (expectedLength !== undefined && length !== expectedLength) {
    invalidQuery('Invalid ObjectId bytes');
  }
  budget.chargeBytes(length);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== length) {
    invalidQuery('Binary data cannot have custom properties');
  }
  const result = Buffer.alloc(length);
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[index];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      invalidQuery('Binary data requires data elements');
    }
    result[index] = descriptor.value;
  }
  return result;
};

const copyDate = (value, budget) => {
  if (!nativeTypes.isDate(value) || Reflect.ownKeys(value).length) {
    invalidQuery('Expected an ordinary Date');
  }
  const time = Date.prototype.getTime.call(value);
  if (!Number.isFinite(time)) {
    invalidQuery('Invalid Date');
  }
  budget.chargeBytes(NUMBER_BYTES);
  return new Date(time);
};

const copyObjectId = (value, budget) => {
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).length !== 1 ||
    !Object.hasOwn(descriptors.buffer || {}, 'value')
  ) {
    invalidQuery('Expected an ordinary ObjectId');
  }
  return new mongoose.Types.ObjectId(copyBinary(descriptors.buffer.value, budget, OBJECT_ID_BYTES));
};

const copyLiteralObject = (value, budget, depth) => {
  const result = {};
  for (const [key, item] of queryEntries(value)) {
    if (unsafeQueryKey(key) || key.includes('.')) {
      invalidQuery('Unsafe literal key');
    }
    budget.chargeBytes(Buffer.byteLength(key));
    result[key] = copyQueryLiteral(item, budget, depth + 1);
  }
  return result;
};

const copyLiteralArray = (value, budget, depth) => {
  if (value.length > MAX_LITERAL_VALUES) {
    invalidQuery('Server query has too many literal values', 'FILTER_DEPTH_EXCEEDED');
  }
  return queryArray(value).map((item) => copyQueryLiteral(item, budget, depth + 1));
};

const BSON_LITERAL_COPIERS = new Map([
  [Date.prototype, copyDate],
  [mongoose.Types.ObjectId.prototype, copyObjectId],
  [Buffer.prototype, copyBinary],
]);

const copyLiteralValue = (value, budget, depth) => {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string' && value.length <= MAX_LITERAL_STRING_LENGTH) {
    budget.chargeBytes(Buffer.byteLength(value));
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    budget.chargeBytes(NUMBER_BYTES);
    return value;
  }
  if (!value || typeof value !== 'object') return copyLiteralObject(value, budget, depth);

  // Inspect prototypes before array length/BSON properties, without executing proxies.
  const copyBson = BSON_LITERAL_COPIERS.get(queryPrototype(value));
  if (copyBson) return copyBson(value, budget);
  if (Array.isArray(value)) return copyLiteralArray(value, budget, depth);
  return copyLiteralObject(value, budget, depth);
};

export const copyQueryLiteral = (value, budget, depth = 0) =>
  budget.visit(value, depth, () => copyLiteralValue(value, budget, depth), true);
