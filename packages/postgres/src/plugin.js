import { randomUUID } from 'node:crypto';
import { SimfinityError } from '@simtlix/simfinity-core';
import { identifier, generatedName } from './schema/sql.js';
import { describeRelationalSchema } from './schema/describe.js';
import { initializeDatabase } from './schema/initialize.js';
import { compileDatabaseSchema } from './schema/ddl.js';
import { compileChildrenQuery, compileQuery } from './query/compiler.js';
import { markCaseFoldFailure } from './query/case-fold.js';
import { compileRecord, compileRecordBatch, MAX_RECORD_BATCH_VALUES } from './record-statements.js';
import { castId, encodeScalar, decodeScalar, encodeParameter, isRetryableDatabaseError, normalizeDatabaseError } from './codecs.js';

export const postgresPlugin = (options) => ({
  apiVersion: 1,
  name: 'postgres',
  displayName: 'PostgreSQL',
  defaultSchema: 'public',
  options: options || null,
  // singleStatementReads: one statement reads one snapshot at any isolation level, so a read without owned
  // tables needs no repeatable-read transaction.
  capabilities: ['transactions', 'foreignKeys', 'deferredForeignKeys', 'embeddedValues', 'ownedRecords', 'scalarLists', 'uniqueValues', 'nullableUnique', 'singleStatementReads'],
  // Every filter operator compileQuery and compileChildrenQuery compile, listed one by one so that a later
  // QLOperator value is rejected until the compiler supports it, and emptiness through references and collections
  // (#108 part 2b): the scoped joins and frames of client constructs, and stored semantics for the others. The
  // declaration names the compileQuery it describes, so a copy of this plugin with another compileQuery compiles the
  // operators of 3.7.0, without reference emptiness, until it declares its own.
  queryFeatures: {
    operators: ['EQ', 'NE', 'LT', 'LTE', 'GT', 'GTE', 'BTW', 'IN', 'NIN', 'LIKE', 'ILIKE', 'STARTS_WITH', 'ISTARTS_WITH', 'ENDS_WITH', 'IENDS_WITH', 'IEQ', 'IS_EMPTY', 'IS_NOT_EMPTY'],
    referenceEmptiness: true,
    compileQuery,
  },
  naming: { validateIdentifier: identifier, generatedName },
  // The runtime passes its bound configuration: createPostgres(options) or configure(value).
  describeSchema: (plan, configuration) => describeRelationalSchema(plan, { refreshTriggers: configuration?.refreshTriggers, ownerIndexes: configuration?.ownerIndexes }),
  // `context.virtualFields` locates virtual fields, so that SCHEMA_MISMATCH can name one whose earlier storage is left.
  initialize: (configuration, description, initialization, context) => initializeDatabase(configuration.pool, description, initialization, context),
  compileSchema: compileDatabaseSchema,
  compileQuery,
  // Optional member: the find statements of many parents in one statement, for findChildrenBatch, which the SQL
  // adapter defines only with `batchedCollections: true`. Each statement carries setup that turns JIT off for its
  // transaction, and the compileQuery it reproduces, so a copy of this plugin with another compileQuery reads each
  // parent alone.
  compileChildrenQuery,
  compileRecord,
  compileRecordBatch,
  maxRecordBatchValues: MAX_RECORD_BATCH_VALUES,
  values: { createId: randomUUID, castId, encodeScalar, decodeScalar, encodeEmbedded: JSON.stringify },
  driver: {
    assertConfiguration(configuration) {
      if (!configuration?.pool?.connect || !configuration.pool.query) throw new SimfinityError('Configure a pg.Pool before creating the schema', 'DATABASE_NOT_CONFIGURED', 500);
    },
    // The error of a statement that folds case is marked, unchanged, so that normalizeError reports a database that
    // cannot evaluate the fold as UNSUPPORTED_QUERY.
    query: async (configuration, statement, client) => {
      try {
        return await (client || configuration.pool).query(statement.text, statement.values?.map(encodeParameter));
      } catch (error) {
        throw markCaseFoldFailure(statement, error);
      }
    },
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
