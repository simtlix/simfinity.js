import mongoose from 'mongoose';
import { SimfinityError } from '@simtlix/simfinity-core';

// Identifier casts shared by the adapter, the query builder and the integrity layer. A malformed
// identifier is the client's error, so it becomes NOT_VALID_ID (400) instead of a driver error, and
// the message never echoes the value.

export const invalidId = () => new SimfinityError('Invalid identifier', 'NOT_VALID_ID', 400);

// Names also match a CastError or BSONError from another mongoose or bson copy used by a supplied model.
const isCastFailure = (error) => error?.name === 'CastError' || error?.name === 'BSONError';

// Accepts only an ObjectId or its 24-character hex form, so a missing or numeric value never mints a
// new identifier.
export const castObjectId = (value) => {
  try {
    if (mongoose.isObjectIdOrHexString(value)) return new mongoose.Types.ObjectId(value);
  } catch {
    // Fall through: an ObjectId-like value that does not convert is malformed.
  }
  throw invalidId();
};

// Casts with the model's own path type, as Mongoose would at query time, so supplied models with a
// String or Number key keep working. Mongoose matches nothing for null or undefined.
export const castPathValue = (schemaType, value) => {
  if (value == null || !schemaType) return value;
  try {
    return schemaType.cast(value);
  } catch (error) {
    if (isCastFailure(error)) throw invalidId();
    throw error;
  }
};

export const castModelId = (Model, value) => castPathValue(Model.schema.path('_id'), value);

// A write that fails only because ObjectId values do not cast: an ObjectId CastError, an embedded or
// array cast wrapping one, or a ValidationError made only of such casts. Any other failure keeps its
// own error.
const isObjectIdCastFailure = (error) => {
  if (error?.name === 'CastError') {
    if (error.kind === 'ObjectId') return true;
    const wraps = error.kind === 'embedded' || error.kind === 'Array' || /^\[.*\]$/.test(error.kind ?? '');
    return wraps && isObjectIdCastFailure(error.reason);
  }
  if (error?.name === 'ValidationError') {
    const nested = Object.values(error.errors ?? {});
    return nested.length > 0 && nested.every(isObjectIdCastFailure);
  }
  return false;
};

export const mapIdCastError = (error) => (isObjectIdCastFailure(error) ? invalidId() : error);
