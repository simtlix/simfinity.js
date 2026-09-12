import { randomUUID } from 'node:crypto';
import { describeModels, createQueryPlan, SimfinityError } from '@simtlix/simfinity-core';
import { describeDatabase } from './schema/describe.js';
import { initializeDatabase } from './schema/initialize.js';
import { compileQuery } from './query/compiler.js';
import { createRecordStore } from './records.js';
import { createTransactions } from './transactions.js';
import { castId, normalizeDatabaseError } from './codecs.js';

export const createPostgresAdapter = (options) => {
  let configured = options ? Object.freeze({ ...options }) : null;
  let prepared = false;
  let ready = false;
  let allowSchemaCreation = true;
  let models; let database; let records;
  const handles = new Map();
  const assertReady = () => {
    if (!ready) throw new SimfinityError('Initialize the PostgreSQL database before executing operations', 'DATABASE_NOT_INITIALIZED', 503);
  };
  const getPool = () => configured.pool;
  const transactions = createTransactions(getPool, assertReady);
  const query = async (text, values, session) => {
    assertReady();
    // Retryable errors must reach withTransaction unchanged, so normalize only at operation boundaries.
    const client = session ? transactions.requireSession(session) : getPool();
    return client.query(text, values);
  };
  const safe = (operation) => async (...args) => {
    try { return await operation(...args); } catch (error) {
      if (['40001', '40P01'].includes(error.code)) throw error;
      throw normalizeDatabaseError(error);
    }
  };
  const nameOf = (model) => {
    assertReady();
    if (!model || handles.get(model.name) !== model || !models.entities.some((item) => item.name === model.name)) throw new SimfinityError('Invalid PostgreSQL model handle', 'INVALID_MODEL', 400);
    return model.name;
  };
  const execute = async (model, gqltype, args, session, mode, extra) => {
    const name = nameOf(model);
    const plan = createQueryPlan(models, name, args, { mode });
    const compiled = compileQuery(models, database, plan, extra);
    const { rows } = await query(compiled.text, compiled.values, session);
    if (mode === 'count') return Number(rows[0]?.size || 0);
    if (mode === 'aggregate') return rows.map((row) => ({
      groupId: row.groupId,
      facts: Object.fromEntries(plan.aggregation.facts.map((fact, index) => {
        const value = row[`fact_${index}`];
        return [fact.factName, value == null ? null : ['SUM', 'COUNT', 'AVG'].includes(fact.operation) ? Number(value) : value];
      })),
    }));
    return records.hydrateRows(name, rows, session);
  };
  const adapter = {
    configure(value) {
      if (configured || prepared) throw new SimfinityError('PostgreSQL configuration is already bound', 'DATABASE_ALREADY_CONFIGURED', 409);
      configured = Object.freeze({ ...value });
    },
    validateRegistration(registration) {
      if (prepared) throw new SimfinityError('Register types before creating the schema', 'SCHEMA_ALREADY_CREATED', 409);
      const model = registration.model;
      if (model && !handles.has(model.name)) throw new SimfinityError('External Mongoose models cannot be used with PostgreSQL', 'INVALID_MODEL', 400);
    },
    prepare(registrations, { createCollection = true } = {}) {
      if (prepared) return;
      if (!configured?.pool?.connect || !configured.pool.query) throw new SimfinityError('Configure a pg.Pool before creating the schema', 'DATABASE_NOT_CONFIGURED', 500);
      models = describeModels(registrations);
      database = describeDatabase(registrations, { schema: configured.schema || 'public' });
      allowSchemaCreation = createCollection;
      records = createRecordStore(models, database, query);
      prepared = true;
    },
    createModel(gqltype, onModelCreated) {
      const model = {
        name: gqltype.name, gqltype,
        findById: (id, { session } = {}) => adapter.getById(model, id, session),
        find: (args = {}, { session } = {}) => adapter.find(model, gqltype, args, session),
        create: (data, { session } = {}) => adapter.withTransaction(session, (transaction) => adapter.saveRecord(model, adapter.newRecord(model, data, transaction), transaction)),
        update: (id, changes, { session } = {}) => adapter.withTransaction(session, (transaction) => adapter.update(model, id, changes, transaction)),
        delete: (id, { session } = {}) => adapter.withTransaction(session, (transaction) => adapter.delete(model, id, transaction)),
      };
      handles.set(model.name, model);
      if (onModelCreated) onModelCreated(model);
      return model;
    },
    castId,
    stateValue: (state) => state.value,
    withTransaction: transactions.withTransaction,
    newRecord(model, data) { nameOf(model); const id = data._id || data.id || randomUUID(); return { ...data, _id: castId(id), id: castId(id) }; },
    toObject(record) { return record == null ? record : { ...record }; },
    saveRecord: safe((model, record, session) => transactions.withTransaction(session, (transaction) => records.create(nameOf(model), record, transaction))),
    getById: safe((model, id, session, options = {}) => transactions.withTransaction(session, (transaction) => records.getById(nameOf(model), id, transaction, options))),
    prepareUpdate(set, unset) { return { ...set, ...(Object.keys(unset).length ? { $unset: { ...unset } } : {}) }; },
    update: safe((model, id, update, session) => records.update(nameOf(model), id, update, session)),
    delete: safe((model, id, session) => records.remove(nameOf(model), id, session)),
    find: safe((model, gqltype, args, session) => transactions.withTransaction(session, (transaction) => execute(model, gqltype, args, transaction, 'find'))),
    count: safe((model, gqltype, args, session) => execute(model, gqltype, args, session, 'count')),
    aggregate: safe((model, gqltype, args, session) => execute(model, gqltype, args, session, 'aggregate')),
    findChildren: safe((model, gqltype, connectionField, parentId, args, session) => {
      const entity = models.entities.find((item) => item.name === nameOf(model));
      const field = entity.fields.find((item) => item.name === connectionField || item.storageName === connectionField);
      if (!field || field.kind !== 'reference') throw new SimfinityError('Invalid inverse connection field', 'INVALID_MODEL', 400);
      return transactions.withTransaction(session, (transaction) => execute(model, gqltype, args, transaction, 'find', { column: field.storageName, id: castId(parentId) }));
    }),
    async initialize(options = {}) {
      if (!prepared) throw new SimfinityError('Create the GraphQL schema before initializing storage', 'SCHEMA_NOT_CREATED', 500);
      ready = false;
      if (!allowSchemaCreation && options.mode && options.mode !== 'validate') throw new SimfinityError('Database creation is disabled; initialize in validate mode', 'DATABASE_CREATION_DISABLED', 409);
      const result = await initializeDatabase(getPool(), database, allowSchemaCreation ? options : { ...options, mode: 'validate' });
      ready = true;
      return result;
    },
    describeDatabase() {
      if (!prepared) throw new SimfinityError('Create the GraphQL schema first', 'SCHEMA_NOT_CREATED', 500);
      return structuredClone(database);
    },
  };
  return adapter;
};
