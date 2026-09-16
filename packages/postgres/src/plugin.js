import { randomUUID } from 'node:crypto';
import { SimfinityError } from '@simtlix/simfinity-core';
import { identifier, generatedName } from './schema/sql.js';
import { describeRelationalSchema } from './schema/describe.js';
import { initializeDatabase } from './schema/initialize.js';
import { compileDatabaseSchema } from './schema/ddl.js';
import { compileQuery } from './query/compiler.js';
import { compileRecord } from './record-statements.js';
import { castId, encodeScalar, decodeScalar, encodeParameter, normalizeDatabaseError } from './codecs.js';

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
    commit: (client) => client.query('COMMIT'),
    rollback: (client) => client.query('ROLLBACK'),
    release: (client) => client.release(),
    isRetryable: (error) => ['40001', '40P01'].includes(error.code),
    normalizeError: normalizeDatabaseError,
  },
});
