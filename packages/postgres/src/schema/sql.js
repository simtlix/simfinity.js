import { createHash } from 'node:crypto';
import { SimfinityError } from '@simtlix/simfinity-core';

export const invalid = (message) => {
  throw new SimfinityError(message, 'INVALID_DATABASE_SCHEMA', 400);
};

export const identifier = (value) => {
  if (typeof value !== 'string' || !value.length || value.includes('\0') || Buffer.byteLength(value) > 63) {
    invalid(`Invalid PostgreSQL identifier: ${String(value)}`);
  }
  return `"${value.replaceAll('"', '""')}"`;
};
export const literal = (value) => `'${String(value).replaceAll('\'', '\'\'')}'`;
export const qualified = (schema, table) => `${identifier(schema)}.${identifier(table)}`;
export const columnsSQL = (columns) => columns.map(identifier).join(', ');
export const generatedName = (...parts) => {
  const name = parts.join('__');
  if (Buffer.byteLength(name) <= 63) return name;
  const hash = createHash('sha256').update(name).digest('hex').slice(0, 12);
  let prefix = name;
  while (Buffer.byteLength(prefix) > 50) prefix = prefix.slice(0, -1);
  return `${prefix}_${hash}`;
};
