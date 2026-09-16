import { SimfinityError } from '@simtlix/simfinity-core';
import { identifier as q, qualified } from './schema/sql.js';

/** operation.table is the physical table metadata returned by describeSchema. */
export const compileRecord = (database, operation) => {
  const { kind, table: storage, id, data } = operation;
  const target = qualified(database.schema, storage.name);
  if (kind === 'selectById') return { text: `SELECT * FROM ${target} WHERE id = $1::uuid${operation.lock ? ' FOR UPDATE' : ''}`, values: [id] };
  if (kind === 'selectOwned') return { text: `SELECT * FROM ${target} WHERE "__owner_id" = ANY ($1::uuid[])${operation.ordered ? ' ORDER BY "__position"' : ''}`, values: [operation.ids] };
  if (kind === 'deleteById') return { text: `DELETE FROM ${target} WHERE id = $1::uuid`, values: [id] };
  if (kind === 'deleteOwned') return { text: `DELETE FROM ${target} WHERE "__owner_id" = $1::uuid`, values: [operation.ownerId] };
  if (kind === 'insert') {
    const entries = Object.entries(data);
    const placeholders = entries.map(([name], index) => `$${index + 1}::${storage.columns.find((column) => column.name === name).type}`);
    return { text: `INSERT INTO ${target} (${entries.map(([name]) => q(name)).join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING *`, values: entries.map(([, value]) => value) };
  }
  if (kind === 'update') {
    const entries = Object.entries(data);
    return { text: `UPDATE ${target} SET ${entries.map(([key], index) => `${q(key)} = $${index + 2}::${storage.columns.find((column) => column.name === key).type}`).join(', ')} WHERE id = $1::uuid RETURNING *`, values: [id, ...entries.map(([, value]) => value)] };
  }
  throw new SimfinityError(`Unknown record operation ${kind}`, 'INVALID_RECORD_OPERATION', 400);
};
