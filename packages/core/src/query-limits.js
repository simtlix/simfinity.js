import SimfinityError from './errors/simfinity.error.js';

let queryMaxPageSize = 1000;

export const configureQueryLimits = (options = {}) => {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) {
    throw new SimfinityError('Query limit options must be a plain object', 'INVALID_QUERY_LIMITS', 400);
  }
  const { maxPageSize = 1000 } = options;
  if (!Number.isSafeInteger(maxPageSize) || maxPageSize < 1) {
    throw new SimfinityError('maxPageSize must be a positive safe integer', 'INVALID_QUERY_LIMITS', 400);
  }
  queryMaxPageSize = maxPageSize;
};

export const paginationStages = (pagination, withDefault) => {
  if (pagination == null) return withDefault ? [{ $skip: 0 }, { $limit: Math.min(100, queryMaxPageSize) }] : [];
  const { page, size } = pagination;
  const skip = size * (page - 1);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(size) || size < 1
    || size > queryMaxPageSize || !Number.isSafeInteger(skip)) {
    throw new SimfinityError(`Pagination requires positive safe integers and size <= ${queryMaxPageSize}`, 'INVALID_PAGINATION', 400);
  }
  return [{ $skip: skip }, { $limit: size }];
};
