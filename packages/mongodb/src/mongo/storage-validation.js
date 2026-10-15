import { SimfinityError } from '@simtlix/simfinity-core';

const UNSAFE_PATH_PARTS = new Set(['__proto__', 'prototype', 'constructor']);
const OPEN_SCHEMA_TYPES = new Set(['Mixed', 'Map', 'Array']);
const FILTER_GROUPS = new Set(['$and', '$or', '$nor']);
const EXECUTABLE_EXPRESSIONS = new Set(['$function', '$accumulator']);
const UPDATE_OPERATORS = new Set([
  '$set',
  '$unset',
  '$inc',
  '$max',
  '$min',
  '$setOnInsert',
  '$push',
  '$pull',
  '$addToSet',
  '$pop',
  '$currentDate',
  '$mul',
]);
const UPDATE_STAGES = new Set(['$set', '$addFields', '$unset']);
const FORBIDDEN_PROJECTION_STAGES = new Set([
  '$out',
  '$merge',
  '$unionWith',
  '$documents',
  '$changeStream',
  ...EXECUTABLE_EXPRESSIONS,
]);

export const invalidStorage = (message) =>
  new SimfinityError(message, 'INVALID_STORAGE_OPERATION', 400);

const assertObject = (value, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw invalidStorage(`${name} must be an object`);
  }
};

const assertPath = (Model, path) => {
  if (
    typeof path !== 'string' ||
    !path ||
    path.split('.').some((part) => UNSAFE_PATH_PARTS.has(part))
  ) {
    throw invalidStorage('Invalid storage field');
  }
  if (Model.schema.path(path)) {
    return;
  }
  const parts = path.split('.');
  while (parts.length > 1) {
    parts.pop();
    if (OPEN_SCHEMA_TYPES.has(Model.schema.path(parts.join('.'))?.instance)) {
      return;
    }
  }
  throw invalidStorage(`Unregistered storage field: ${path}`);
};

export const assertStorageDocument = (Model, document) => {
  assertObject(document, 'document');
  for (const path of Object.keys(document)) {
    assertPath(Model, path);
  }
};

const assertExpression = (Model, value) => {
  if (typeof value === 'string' && value.startsWith('$') && !value.startsWith('$$')) {
    assertPath(Model, value.slice(1));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((part) => assertExpression(Model, part));
    return;
  }
  if (!value || typeof value !== 'object') {
    return;
  }
  for (const [key, part] of Object.entries(value)) {
    if (EXECUTABLE_EXPRESSIONS.has(key)) {
      throw invalidStorage('Server JavaScript is not supported');
    }
    if (key !== '$literal') {
      assertExpression(Model, part);
    }
  }
};

export const assertStorageFilter = (Model, filter) => {
  assertObject(filter, 'filter');
  for (const [key, value] of Object.entries(filter)) {
    if (FILTER_GROUPS.has(key)) {
      if (!Array.isArray(value) || !value.length) {
        throw invalidStorage('Filter groups must be nonempty arrays');
      }
      value.forEach((part) => assertStorageFilter(Model, part));
      continue;
    }
    if (key === '$expr') {
      assertExpression(Model, value);
      continue;
    }
    assertPath(Model, key);
  }
};

const assertUpdateStage = (Model, stage) => {
  const keys = Object.keys(stage);
  const operator = keys[0];
  if (keys.length !== 1 || !UPDATE_STAGES.has(operator)) {
    throw invalidStorage('Unsupported update pipeline stage');
  }
  if (operator === '$unset') {
    for (const path of [stage.$unset].flat()) {
      assertPath(Model, path);
    }
    return;
  }
  assertStorageDocument(Model, stage[operator]);
  assertExpression(Model, stage[operator]);
};

const assertUpdate = (Model, update) => {
  if (Array.isArray(update)) {
    if (!update.length) {
      throw invalidStorage('Empty update pipeline');
    }
    update.forEach((stage) => assertUpdateStage(Model, stage));
    return;
  }
  assertObject(update, 'update');
  if (!Object.keys(update).length) {
    throw invalidStorage('Empty update');
  }
  for (const [operator, fields] of Object.entries(update)) {
    if (!UPDATE_OPERATORS.has(operator)) {
      throw invalidStorage(`Unsupported update operator: ${operator}`);
    }
    assertStorageDocument(Model, fields);
  }
};

export const assertFilteredUpdate = (Model, request) => {
  assertStorageFilter(Model, request.filter);
  assertUpdate(Model, request.update);
};
export const assertReplacement = (Model, request) => {
  assertStorageFilter(Model, request.filter);
  assertStorageDocument(Model, request.replacement);
};
export const assertDeletion = (Model, request) => assertStorageFilter(Model, request.filter);
const BULK_VALIDATORS = {
  insertOne: (Model, request) => assertStorageDocument(Model, request.document),
  updateOne: assertFilteredUpdate,
  updateMany: assertFilteredUpdate,
  replaceOne: assertReplacement,
  deleteOne: assertDeletion,
  deleteMany: assertDeletion,
};
const assertBatch = (value, name) => {
  if (!Array.isArray(value) || !value.length) {
    throw invalidStorage(`${name} must be a nonempty array`);
  }
};
export const assertBulkWrite = (Model, request) => {
  assertBatch(request.operations, 'operations');
  for (const operation of request.operations) {
    const keys = Object.keys(operation);
    const name = keys[0];
    if (keys.length !== 1 || !Object.hasOwn(BULK_VALIDATORS, name)) {
      throw invalidStorage('Unsupported bulk operation');
    }
    BULK_VALIDATORS[name](Model, operation[name]);
  }
};
export const assertInsertMany = (Model, request) => {
  assertBatch(request.documents, 'documents');
  request.documents.forEach((document) => assertStorageDocument(Model, document));
};
const inspectProjection = (value) => {
  if (!value || typeof value !== 'object') {
    return;
  }
  for (const [key, part] of Object.entries(value)) {
    if (FORBIDDEN_PROJECTION_STAGES.has(key)) {
      throw invalidStorage(`Unsupported projection stage: ${key}`);
    }
    inspectProjection(part);
  }
};
export const assertStoragePipeline = (pipeline) => {
  if (!Array.isArray(pipeline)) {
    throw invalidStorage('pipeline must be an array');
  }
  inspectProjection(pipeline);
};
