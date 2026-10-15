import mongoose from 'mongoose';
import { types as nativeTypes } from 'node:util';
import { SimfinityError } from '@simtlix/simfinity-core';

const fail = (message, code = 'INVALID_FILTER_VALUE') => { throw new SimfinityError(message, code, 400); };
const unsafe = (key) => ['__proto__', 'prototype', 'constructor'].includes(key) || key.startsWith('$') || key.startsWith('__sf_') || key.includes('\0');
const prototype = (value) => {
  if (nativeTypes.isProxy(value)) fail('Proxies are not supported query data');
  return Object.getPrototypeOf(value);
};
const plain = (value) => value && typeof value === 'object' && [Object.prototype, null].includes(prototype(value));
const entries = (value) => {
  if (!plain(value)) fail('Expected a plain query object');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !descriptors[key].enumerable || !Object.hasOwn(descriptors[key], 'value'))) fail('Query objects must contain enumerable data properties');
  return Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]);
};
const keysOnly = (value, allowed) => {
  for (const [key] of entries(value)) if (!allowed.includes(key)) fail('Unsupported query option: ' + key);
};
const denseArray = (value) => {
  if (!Array.isArray(value) || prototype(value) !== Array.prototype) fail('Expected an ordinary array');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const length = descriptors.length.value;
  if (Reflect.ownKeys(descriptors).length !== length + 1) fail('Arrays require dense data elements');
  const result = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[index];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('Arrays require enumerable data elements');
    result.push(descriptor.value);
  }
  return result;
};
const byteLength = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength').get;
const copyBytes = (value, charge, expectedLength) => {
  if (!value || typeof value !== 'object') fail('Expected ordinary binary data');
  const proto = prototype(value);
  if (![Buffer.prototype, Uint8Array.prototype].includes(proto) || !nativeTypes.isUint8Array(value)) fail('Expected ordinary binary data');
  const length = byteLength.call(value);
  if (expectedLength !== undefined && length !== expectedLength) fail('Invalid ObjectId bytes');
  charge(length);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== length) fail('Binary data cannot have custom properties');
  const result = Buffer.alloc(length);
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[index];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) fail('Binary data requires data elements');
    result[index] = descriptor.value;
  }
  return result;
};
const types = new Set(['string', 'number', 'double', 'int', 'long', 'decimal', 'date', 'objectId', 'bool', 'object', 'array', 'null', 'binData']);
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Accept only escaped literal patterns. Anchors keep Mongo's regex semantics (including $).
const literalRegex = (pattern, flags = '') => {
  if (typeof pattern !== 'string' || pattern.length > 4096 || pattern.includes('\0') || !['', 'i'].includes(flags)) fail('Only literal regex patterns without NUL and the i flag are supported');
  let start = false, end = false, literal = '';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];
    if (char === '^' && index === 0) start = true;
    else if (char === '$' && index === pattern.length - 1) end = true;
    else if (char === '\\') {
      const escaped = pattern[++index];
      if (!escaped || !'.*+?^${}()|[]\\'.includes(escaped)) fail('Unsupported regex escape');
      literal += escaped;
    } else {
      if ('.*+?^${}()|[]'.includes(char)) fail('Only escaped literal regex patterns are supported');
      literal += char;
    }
  }
  return { pattern: (start ? '^' : '') + escapeRegex(literal) + (end ? '$' : ''), flags };
};

/** Private parser: reconstruct a bounded semantic plan, never forward the caller's filter. */
export const parseServerQuery = (query, operation, resolve) => {
  keysOnly(query, ['dialect', 'filter', 'sort', 'window', 'projection']);
  if (query.dialect !== 'mongodb') fail('Unsupported query dialect', 'UNSUPPORTED_CAPABILITY');
  let nodes = 0;
  let values = 0;
  let bytes = 0;
  const charge = (size) => { bytes += size; if (bytes > 8 * 1024 * 1024) fail('Server query literal data exceeds 8 MiB', 'FILTER_DEPTH_EXCEEDED'); };
  const active = new Set();
  const enter = (value, depth, callback, data = false) => {
    if ((data ? ++values > 100000 : ++nodes > 10000) || depth > 20) fail('Server query exceeds its complexity limit', 'FILTER_DEPTH_EXCEEDED');
    if (active.has(value)) fail('Cyclic query data');
    active.add(value);
    try { return callback(); } finally { active.delete(value); }
  };
  const literal = (value, depth = 0) => enter(value, depth, () => {
    if (value === null || typeof value === 'boolean') return value;
    if (typeof value === 'string' && value.length <= 1048576) { charge(Buffer.byteLength(value)); return value; }
    if (typeof value === 'number' && Number.isFinite(value)) { charge(8); return value; }
    if (value && typeof value === 'object') {
      const proto = prototype(value);
      if (proto === Date.prototype) {
        if (!nativeTypes.isDate(value) || Reflect.ownKeys(value).length) fail('Expected an ordinary Date');
        const time = Date.prototype.getTime.call(value);
        if (!Number.isFinite(time)) fail('Invalid Date');
        charge(8); return new Date(time);
      }
      if (proto === mongoose.Types.ObjectId.prototype) {
        const descriptors = Object.getOwnPropertyDescriptors(value);
        if (Reflect.ownKeys(descriptors).length !== 1 || !Object.hasOwn(descriptors.buffer || {}, 'value')) fail('Expected an ordinary ObjectId');
        return new mongoose.Types.ObjectId(copyBytes(descriptors.buffer.value, charge, 12));
      }
      if (proto === Buffer.prototype) return copyBytes(value, charge);
    }
    if (Array.isArray(value)) {
      if (value.length > 100000) fail('Server query has too many literal values', 'FILTER_DEPTH_EXCEEDED');
      return denseArray(value).map((item) => literal(item, depth + 1));
    }
    const result = {};
    for (const [key, item] of entries(value)) {
      if (unsafe(key) || key.includes('.')) fail('Unsafe literal key');
      charge(Buffer.byteLength(key));
      result[key] = literal(item, depth + 1);
    }
    return result;
  }, true);
  const path = (name) => {
    if (++nodes > 10000) fail('Server query exceeds its complexity limit', 'FILTER_DEPTH_EXCEEDED');
    if (typeof name !== 'string' || !name || name.length > 1024 || name.split('.').some((part) => !part || unsafe(part) || !/^[A-Za-z0-9_]+$/.test(part))) fail('Invalid query path', 'INVALID_FILTER_PATH');
    return resolve(name);
  };
  const fieldLiteral = (value, field) => {
    const copied = literal(value);
    const inspect = (item, name) => {
      if (!path(name).structured || item === null) return;
      if (Array.isArray(item)) { item.forEach((entry) => inspect(entry, name)); return; }
      if (plain(item)) for (const [key, child] of entries(item)) inspect(child, name + '.' + key);
    };
    inspect(copied, field);
    return copied;
  };
  const operators = (value, field, depth) => enter(value, depth, () => {
    const result = [];
    const pairs = entries(value);
    if (!pairs.length) fail('Empty field operator object');
    for (const [operator, operand] of pairs) {
      if (['$eq', '$ne', '$lt', '$lte', '$gt', '$gte'].includes(operator)) result.push({ operator, value: fieldLiteral(operand, field) });
      else if (['$in', '$nin', '$all'].includes(operator)) {
        if (!Array.isArray(operand)) fail(operator + ' requires an array');
        result.push({ operator, value: fieldLiteral(operand, field) });
      } else if (operator === '$exists') {
        if (typeof operand !== 'boolean') fail('$exists requires a boolean');
        result.push({ operator, value: operand });
      } else if (operator === '$size') {
        if (!Number.isSafeInteger(operand) || operand < 0 || operand > 2147483647) fail('$size requires an integer from 0 through 2147483647');
        result.push({ operator, value: operand });
      } else if (operator === '$type') {
        if (!types.has(operand)) fail('Unsupported BSON type');
        result.push({ operator, value: operand });
      } else if (operator === '$regex') result.push({ operator, value: literalRegex(operand, value.$options) });
      else if (operator === '$options') {
        if (!Object.hasOwn(value, '$regex')) fail('$options requires $regex');
      } else if (operator === '$not') result.push({ operator, terms: operators(operand, field, depth + 1) });
      else if (operator === '$elemMatch') {
        const members = entries(operand);
        const scalar = members.length > 0 && members.every(([key]) => key.startsWith('$') && !['$and', '$or', '$nor'].includes(key));
        result.push(scalar
          ? { operator, terms: operators(operand, field, depth + 1) }
          : { operator, predicate: document(operand, field + '.', depth + 1), prefix: path(field).mongoPath + '.' });
      } else fail('Unsupported filter operator: ' + operator, 'INVALID_FILTER_OPERATOR');
    }
    return result;
  });
  const document = (value, prefix = '', depth = 0) => enter(value, depth, () => {
    const terms = [];
    for (const [key, operand] of entries(value)) {
      if (['$and', '$or', '$nor'].includes(key)) {
        const members = denseArray(operand);
        if (!members.length) fail(key + ' requires a nonempty array');
        terms.push({ kind: key, terms: members.map((item) => document(item, prefix, depth + 1)) });
      } else {
        const field = prefix + key;
        const resolved = path(field);
        const isOperators = plain(operand) && entries(operand).some(([name]) => name.startsWith('$'));
        terms.push({ kind: 'field', path: resolved.mongoPath, terms: isOperators ? operators(operand, field, depth + 1) : [{ operator: '$eq', value: fieldLiteral(operand, field) }] });
      }
    }
    return { kind: '$and', terms };
  });
  const where = document(Object.hasOwn(query, 'filter') ? query.filter : {});
  const plan = { operation, where, sort: null, projection: null, window: null };
  if (operation === 'count') {
    if (query.sort !== undefined || query.projection !== undefined || query.window !== undefined) fail('Count does not accept sort, projection or window');
    return plan;
  }
  keysOnly(query.window, ['skip', 'limit', 'unbounded']);
  if (query.window.unbounded === true) {
    if (Object.keys(query.window).length !== 1) fail('Unbounded window cannot contain paging');
    if (operation === 'page') fail('Page requires a finite window', 'INVALID_PAGINATION');
    plan.window = {};
  } else {
    const { skip = 0, limit } = query.window;
    if (Object.hasOwn(query.window, 'unbounded') || !Number.isSafeInteger(skip) || skip < 0 || !Number.isSafeInteger(limit) || limit < 1) fail('Window requires a positive limit and nonnegative skip', 'INVALID_PAGINATION');
    plan.window = { skip, limit };
  }
  if (query.sort !== undefined) {
    plan.sort = {};
    const pairs = entries(query.sort);
    if (!pairs.length) fail('Sort must not be empty', 'INVALID_SORT');
    for (const [name, order] of pairs) {
      if (order !== 1 && order !== -1) fail('Sort requires 1 or -1', 'INVALID_SORT');
      const field = path(name);
      if (field.structured) fail('Sort requires a scalar or explicitly dynamic field', 'INVALID_SORT');
      const resolved = field.mongoPath;
      if (Object.hasOwn(plan.sort, resolved)) fail('Duplicate resolved sort field', 'INVALID_SORT');
      plan.sort[resolved] = order;
    }
  }
  if (query.projection !== undefined) {
    plan.projection = {};
    let mode;
    for (const [name, include] of entries(query.projection)) {
      if (include !== 0 && include !== 1) fail('Projection requires 0 or 1');
      const resolved = path(name).mongoPath;
      if (Object.keys(plan.projection).some((key) => key === resolved || key.startsWith(resolved + '.') || resolved.startsWith(key + '.'))) fail('Overlapping projection paths');
      if (resolved !== '_id') {
        if (mode !== undefined && mode !== include) fail('Cannot mix inclusion and exclusion projection');
        mode = include;
      }
      plan.projection[resolved] = include;
    }
    if (!Object.keys(plan.projection).length) fail('Projection must not be empty');
  }
  return plan;
};

const lowerOperators = (terms) => {
  const result = {};
  for (const term of terms) {
    if (term.operator === '$regex') {
      result.$regex = term.value.pattern;
      if (term.value.flags) result.$options = term.value.flags;
    } else result[term.operator] = term.predicate ? lowerServerPredicate(term.predicate, term.prefix)
      : term.terms ? lowerOperators(term.terms) : term.value;
  }
  return result;
};
export const lowerServerPredicate = (node, prefix = '') => {
  if (node.kind === 'field') return { [node.path.slice(prefix.length)]: lowerOperators(node.terms) };
  if (!node.terms.length) return {};
  if (node.kind === '$and' && node.terms.length === 1) return lowerServerPredicate(node.terms[0], prefix);
  return { [node.kind]: node.terms.map((term) => lowerServerPredicate(term, prefix)) };
};
