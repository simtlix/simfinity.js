import { getNamedType, isEnumType } from 'graphql';
import { SimfinityError } from '@simtlix/simfinity-core';

export const storageTypes = { ID: 'uuid', String: 'text', Enum: 'text', Int: 'integer', Float: 'double precision', Boolean: 'boolean', DateTime: 'timestamp with time zone' };
export const invalidValue = (message) => { throw new SimfinityError(message, 'INVALID_FILTER_VALUE', 400); };
export const castId = (value) => {
  const id = typeof value === 'object' && value ? value._id || value.id : value;
  if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new SimfinityError('Expected a UUID identifier', 'NOT_VALID_ID', 400);
  }
  return id.toLowerCase();
};

export const encodeScalar = (field, value) => {
  if (value == null) return null;
  if (field.kind === 'reference' || field.scalar === 'ID') return castId(value);
  switch (field.scalar) {
    case 'Enum': {
      const encoded = String(value);
      if (!field.values.includes(encoded)) invalidValue(`Invalid enum value for ${field.name}`);
      return encoded;
    }
    case 'String': if (typeof value !== 'string') invalidValue(`Expected a string for ${field.name}`); break;
    case 'Boolean': if (typeof value !== 'boolean') invalidValue(`Expected a boolean for ${field.name}`); break;
    case 'Int': if (!Number.isInteger(value) || value < -2147483648 || value > 2147483647) invalidValue(`Expected a 32-bit integer for ${field.name}`); break;
    case 'Float': if (typeof value !== 'number' || !Number.isFinite(value)) invalidValue(`Expected a finite number for ${field.name}`); break;
    case 'DateTime': {
      const date = value instanceof Date ? value : typeof value === 'string' ? new Date(value) : null;
      if (!date || !Number.isFinite(date.getTime())) invalidValue(`Invalid date for ${field.name}`);
      return date;
    }
    default: invalidValue(`Unsupported scalar for ${field.name}`);
  }
  return value;
};

export const decodeScalar = (field, value, gqlField) => {
  if (value == null) return value;
  if (field.scalar === 'Enum' && gqlField) {
    const type = getNamedType(gqlField.type);
    if (isEnumType(type)) return type.getValues().find((item) => String(item.value) === value)?.value ?? value;
  }
  if (field.scalar === 'DateTime') return value instanceof Date ? value : new Date(value);
  return value;
};

const databaseErrors = {
  '23503': ['Reference constraint violated', 'REFERENCE_CONSTRAINT_VIOLATION', 409],
  '23505': ['Unique value already exists', 'DUPLICATE_KEY', 409],
  '23502': ['A required value is missing', 'REQUIRED_VALUE', 400],
  '23514': ['A value violates the generated schema', 'INVALID_VALUE', 400],
  '22P02': ['Invalid stored value', 'INVALID_VALUE', 400],
  '22003': ['Numeric value is out of range', 'INVALID_VALUE', 400],
  // Values PostgreSQL cannot store: longer than a sized column, a timestamp or date outside its range
  // (including generated make_date calls), and text or JSON with NUL (U+0000) or a character the
  // server encoding lacks. Index row size limits (54000) stay a DATABASE_ERROR.
  '22001': ['Value is too long', 'INVALID_VALUE', 400],
  '22008': ['Date or time value is out of range', 'INVALID_VALUE', 400],
  '22021': ['Text contains a character the database cannot store', 'INVALID_VALUE', 400],
  '22P05': ['Text contains a character the database cannot store', 'INVALID_VALUE', 400],
  '40001': ['Concurrent write could not be completed', 'TRANSACTION_RETRY_EXCEEDED', 409],
  '40P01': ['Concurrent write could not be completed', 'TRANSACTION_RETRY_EXCEEDED', 409],
};

/** Serialization failures and deadlocks: confirmed aborts that are safe to retry. */
export const isRetryableDatabaseError = (error) => ['40001', '40P01'].includes(error?.code);

// An error the server reported, as node-postgres exposes it: a five-character SQLSTATE and a severity.
// An application error that only has a `code`, such as ECONNREFUSED or a domain code, is not one.
export const isPostgresError = (error) => typeof error?.code === 'string' && /^[0-9A-Z]{5}$/.test(error.code) && typeof error.severity === 'string';

/** Maps PostgreSQL errors (and exhausted retries) without SQL details; returns every other value unchanged. */
export const normalizeDatabaseError = (error) => {
  if (error instanceof SimfinityError || !(isPostgresError(error) || isRetryableDatabaseError(error))) return error;
  const normalized = new SimfinityError(...(databaseErrors[error.code] || ['Database operation failed', 'DATABASE_ERROR', 500]));
  // Kept for server logging, but non-enumerable as on a native Error, so serializing or spreading the
  // client-facing error never copies the driver's detail, table or constraint.
  Object.defineProperty(normalized, 'cause', { value: error, writable: true, configurable: true, enumerable: false });
  normalized.getCause = () => normalized.cause;
  return normalized;
};

/** pg's local Date formatting truncates historical offset seconds; use UTC per parameter. */
export const encodeParameter = (value) => {
  if (Array.isArray(value)) return value.map(encodeParameter);
  if (!(value instanceof Date)) return value;
  const year = value.getUTCFullYear();
  const iso = value.toISOString();
  const rest = iso.slice(iso.indexOf('-', iso.startsWith('-') || iso.startsWith('+') ? 1 : 0));
  return `${String(year <= 0 ? 1 - year : year).padStart(4, '0')}${rest.slice(0, -1)}+00:00${year <= 0 ? ' BC' : ''}`;
};
