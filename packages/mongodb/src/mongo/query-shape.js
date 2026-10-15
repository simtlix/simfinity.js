import { assertQueryKeys, invalidQuery, queryEntries } from './query-values.js';

const WINDOW_KEYS = new Set(['skip', 'limit', 'unbounded']);

export const parseWindow = (window, operation) => {
  assertQueryKeys(window, WINDOW_KEYS);
  if (window.unbounded === true) {
    if (Object.keys(window).length !== 1) {
      invalidQuery('Unbounded window cannot contain paging');
    }
    if (operation === 'page') {
      invalidQuery('Page requires a finite window', 'INVALID_PAGINATION');
    }
    return {};
  }
  const { skip = 0, limit } = window;
  const validSkip = Number.isSafeInteger(skip) && skip >= 0;
  const validLimit = Number.isSafeInteger(limit) && limit >= 1;
  if (Object.hasOwn(window, 'unbounded') || !validSkip || !validLimit) {
    invalidQuery('Window requires a positive limit and nonnegative skip', 'INVALID_PAGINATION');
  }
  return { skip, limit };
};

const overlapsPath = (left, right) =>
  left === right || left.startsWith(right + '.') || right.startsWith(left + '.');

const nextProjectionMode = (mode, path, include) => {
  if (path === '_id') return mode;
  if (mode !== undefined && mode !== include) {
    invalidQuery('Cannot mix inclusion and exclusion projection');
  }
  return include;
};

export const parseSort = (value, resolve) => {
  const result = {};
  const pairs = queryEntries(value);
  if (!pairs.length) {
    invalidQuery('Sort must not be empty', 'INVALID_SORT');
  }
  for (const [name, order] of pairs) {
    if (order !== 1 && order !== -1) {
      invalidQuery('Sort requires 1 or -1', 'INVALID_SORT');
    }
    const field = resolve(name);
    if (field.structured) {
      invalidQuery('Sort requires a scalar or explicitly dynamic field', 'INVALID_SORT');
    }
    if (Object.hasOwn(result, field.mongoPath)) {
      invalidQuery('Duplicate resolved sort field', 'INVALID_SORT');
    }
    result[field.mongoPath] = order;
  }
  return result;
};

export const parseProjection = (value, resolve) => {
  const result = {};
  let mode;
  for (const [name, include] of queryEntries(value)) {
    if (include !== 0 && include !== 1) {
      invalidQuery('Projection requires 0 or 1');
    }
    const resolved = resolve(name).mongoPath;
    if (Object.keys(result).some((key) => overlapsPath(key, resolved))) {
      invalidQuery('Overlapping projection paths');
    }
    mode = nextProjectionMode(mode, resolved, include);
    result[resolved] = include;
  }
  if (!Object.keys(result).length) {
    invalidQuery('Projection must not be empty');
  }
  return result;
};
