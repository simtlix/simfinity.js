import { randomUUID } from 'node:crypto';
import { SimfinityError } from '@simtlix/simfinity-core';
import { identifier, generatedName } from './schema/sql.js';
import { describeRelationalSchema } from './schema/describe.js';
import { initializeDatabase } from './schema/initialize.js';
import { compileDatabaseSchema } from './schema/ddl.js';
import { compileQuery } from './query/compiler.js';
import { compileRecord } from './record-statements.js';
import { castId, encodeScalar, decodeScalar, encodeParameter, isRetryableDatabaseError, normalizeDatabaseError } from './codecs.js';

export const postgresPlugin = (options) => ({
  apiVersion: 1,
  name: 'postgres',
  displayName: 'PostgreSQL',
  defaultSchema: 'public',
  options: options || null,
  capabilities: ['transactions', 'foreignKeys', 'deferredForeignKeys', 'embeddedValues', 'ownedRecords', 'scalarLists', 'uniqueValues', 'nullableUnique'],
  naming: { validateIdentifier: identifier, generatedName },
  describeSchema: describeRelationalSchema,
  initialize: (configuration, description, initialization) => initializeDatabase(configuration.pool, description, initialization),
  compileSchema: compileDatabaseSchema,
  compileQuery,
  compileRecord,
  values: { createId: randomUUID, castId, encodeScalar, decodeScalar, encodeEmbedded: JSON.stringify },
  driver: {
    assertConfiguration(configuration) {
      if (!configuration?.pool?.connect || !configuration.pool.query) throw new SimfinityError('Configure a pg.Pool before creating the schema', 'DATABASE_NOT_CONFIGURED', 500);
    },
    query: (configuration, statement, client) => (client || configuration.pool).query(statement.text, statement.values?.map(encodeParameter)),
    acquire: (configuration) => configuration.pool.connect(),
    begin: (client) => client.query('BEGIN ISOLATION LEVEL REPEATABLE READ'),
    // PostgreSQL answers COMMIT with ROLLBACK, and no error, when a statement in the transaction failed
    // and was caught; nothing was stored, so the operation must fail. A result without a command, from a
    // pool wrapper that does not pass pg's through, resolves as before.
    commit: async (client) => {
      const result = await client.query('COMMIT');
      if (result?.command !== 'ROLLBACK') return;
      const error = new SimfinityError('Transaction was rolled back because one of its statements failed', 'DATABASE_ERROR', 500);
      // The same shape as every other PostgreSQL DATABASE_ERROR: a non-enumerable cause, without SQL.
      Object.defineProperty(error, 'cause', { value: new Error('COMMIT reported ROLLBACK'), writable: true, configurable: true, enumerable: false });
      error.getCause = () => error.cause;
      throw error;
    },
    rollback: (client) => client.query('ROLLBACK'),
    // A release error makes pg-pool destroy a connection whose transaction may still be open.
    release: (client, error) => client.release(error),
    isRetryable: isRetryableDatabaseError,
    normalizeError: normalizeDatabaseError,
  },
});
