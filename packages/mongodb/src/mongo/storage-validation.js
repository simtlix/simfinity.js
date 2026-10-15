import { SimfinityError } from '@simtlix/simfinity-core';

const UNSAFE_PATH_PARTS = new Set(['__proto__', 'prototype', 'constructor']);
const OPEN_SCHEMA_TYPES = new Set(['Mixed', 'Map', 'Array']);
const FILTER_GROUPS = new Set(['$and', '$or', '$nor']);
const EXECUTABLE_EXPRESSIONS = new Set(['$function', '$accumulator']);
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
