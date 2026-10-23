import SimfinityError from './errors/simfinity.error.js';

let queryMaxPageSize = 1000;
let queryMaxReferenceFrames = 10;
let queryMaxFrameNesting = 3;

const isPositiveSafeInteger = (value) => Number.isSafeInteger(value) && value >= 1;

// Process-wide. Each omitted option takes its default again, and every option is checked before any
// is assigned, so a call that fails keeps every current limit. `maxReferenceFrames` caps, per resolver
// call, the client's compiled frames and scoped joins; `maxFrameNesting` caps nested frame chains.
export const configureQueryLimits = (options = {}) => {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) {
    throw new SimfinityError('Query limit options must be a plain object', 'INVALID_QUERY_LIMITS', 400);
  }
  const { maxPageSize = 1000, maxReferenceFrames = 10, maxFrameNesting = 3 } = options;
  if (!isPositiveSafeInteger(maxPageSize)) {
    throw new SimfinityError('maxPageSize must be a positive safe integer', 'INVALID_QUERY_LIMITS', 400);
  }
  if (!isPositiveSafeInteger(maxReferenceFrames)) {
    throw new SimfinityError('maxReferenceFrames must be a positive safe integer', 'INVALID_QUERY_LIMITS', 400);
  }
  if (!isPositiveSafeInteger(maxFrameNesting)) {
    throw new SimfinityError('maxFrameNesting must be a positive safe integer', 'INVALID_QUERY_LIMITS', 400);
  }
  queryMaxPageSize = maxPageSize;
  queryMaxReferenceFrames = maxReferenceFrames;
  queryMaxFrameNesting = maxFrameNesting;
};

export const getQueryMaxPageSize = () => queryMaxPageSize;

export const getQueryMaxReferenceFrames = () => queryMaxReferenceFrames;

export const getQueryMaxFrameNesting = () => queryMaxFrameNesting;

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
