import { describeModels, createQueryPlan, SimfinityError } from '@simtlix/simfinity-core';
import { planRelationalSchema } from './schema/plan.js';
import { bindPlugin, assertCapabilities } from './plugin.js';
import { createRecordStore } from './records.js';
import { createTransactions } from './transactions.js';
import { callDriver, isRetryableFailure, normalizeFailure } from './errors.js';

export const createSQLAdapter = (sourcePlugin) => {
  const plugin = bindPlugin(sourcePlugin);
  const { castId, createId } = plugin.values;
  const { driver } = plugin;
  const options = plugin.options;
  let configured = options ? Object.freeze({ ...options }) : null;
  let prepared = false;
  let ready = false;
  let initializations = 0;
  let allowSchemaCreation = true;
  let models; let database; let records;
  const handles = new Map();
  const assertReady = () => {
    if (!ready) throw new SimfinityError(`Initialize the ${plugin.displayName} database before executing operations`, 'DATABASE_NOT_INITIALIZED', 503);
  };
  const getConfiguration = () => configured;
  const transactions = createTransactions(getConfiguration, assertReady, plugin);
  const query = async (statement, session) => {
    assertReady();
    // Retryable errors must reach withTransaction unchanged, so normalize only at operation boundaries.
    const client = session ? transactions.requireSession(session) : undefined;
    return callDriver(() => driver.query(configured, statement, client));
  };
  const safe = (operation) => async (...args) => {
    try { return await operation(...args); } catch (error) {
      if (isRetryableFailure(driver, error)) throw error;
      throw normalizeFailure(driver, error);
    }
  };
  const nameOf = (model) => {
    assertReady();
    if (!model || handles.get(model.name) !== model || !models.entities.some((item) => item.name === model.name)) throw new SimfinityError(`Invalid ${plugin.displayName} model handle`, 'INVALID_MODEL', 400);
    return model.name;
  };
  const execute = async (model, gqltype, args, session, mode, extra) => {
    const name = nameOf(model);
    const plan = createQueryPlan(models, name, args, { mode });
    const compiled = plugin.compileQuery(models, database, plan, extra);
    const { rows } = await query(compiled, session);
    if (mode === 'count') return Number(rows[0]?.size || 0);
    const decodeAggregate = (value, field) => Array.isArray(value) ? value.map((item) => decodeAggregate(item, field)) : plugin.values.decodeScalar(field, value);
    if (mode === 'aggregate') return rows.map((row) => ({
      groupId: decodeAggregate(row.groupId, compiled.aggregateFields[0]),
      facts: Object.fromEntries(plan.aggregation.facts.map((fact, index) => {
        const value = row[`fact_${index}`];
        return [fact.factName, value == null ? null : ['SUM', 'COUNT', 'AVG'].includes(fact.operation) ? Number(value) : decodeAggregate(value, compiled.aggregateFields[index + 1])];
      })),
    }));
    return records.hydrateRows(name, rows, session);
  };
  const adapter = {
    configure(value) {
      if (configured || prepared) throw new SimfinityError(`${plugin.displayName} configuration is already bound`, 'DATABASE_ALREADY_CONFIGURED', 409);
      configured = Object.freeze({ ...value });
    },
    validateRegistration(registration) {
      if (prepared) throw new SimfinityError('Register types before creating the schema', 'SCHEMA_ALREADY_CREATED', 409);
      const model = registration.model;
      if (model && !handles.has(model.name)) throw new SimfinityError(`External Mongoose models cannot be used with ${plugin.displayName}`, 'INVALID_MODEL', 400);
    },
    prepare(registrations, { createCollection = true } = {}) {
      if (prepared) return;
      driver.assertConfiguration(configured);
      models = describeModels(registrations);
      for (const registration of registrations.filter((item) => item.stateMachine)) {
        const state = models.entities.find((item) => item.name === registration.gqltype.name)?.fields.find((item) => item.name === 'state');
        if (!state) continue;
        // State columns hold enum internal values, which aggregates map back to state names.
        if (state.scalar !== 'Enum') throw new SimfinityError(`State machine field ${registration.gqltype.name}.state must be a GraphQL enum on SQL backends`, 'INVALID_MODEL', 400);
        state.stateNames = state.enumValues.map(({ name, value }) => ({ value: String(value), name }));
      }
      const plan = planRelationalSchema(models, { schema: configured?.schema || plugin.defaultSchema, naming: plugin.naming });
      assertCapabilities(plugin, plan);
      database = plugin.describeSchema(plan);
      allowSchemaCreation = createCollection;
      records = createRecordStore(models, database, query, plugin);
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
    newRecord(model, data) { nameOf(model); const id = data._id ?? data.id ?? createId(); return { ...data, _id: castId(id), id: castId(id) }; },
    toObject(record) { return record == null ? record : { ...record }; },
    saveRecord: safe((model, record, session) => transactions.withTransaction(session, (transaction) => records.create(nameOf(model), record, transaction))),
    getById: safe((model, id, session, options = {}) => transactions.withTransaction(session, (transaction) => records.getById(nameOf(model), id, transaction, options))),
    // One transaction reads the rows by ID and hydrates them, owned records included, as getById does.
    getByIds: safe((model, ids) => {
      nameOf(model);
      if (!ids.length) return [];
      const args = { id: { operator: 'IN', value: ids }, pagination: { page: 1, size: ids.length } };
      return transactions.withTransaction(null, (transaction) => execute(model, model.gqltype, args, transaction, 'find'));
    }),
    prepareUpdate(set, unset) { return { ...set, ...(Object.keys(unset).length ? { $unset: { ...unset } } : {}) }; },
    update: safe((model, id, update, session) => records.update(nameOf(model), id, update, session)),
    delete: safe((model, id, session) => records.remove(nameOf(model), id, session)),
    find: safe((model, gqltype, args, session, { requiredId } = {}) => transactions.withTransaction(session, (transaction) => execute(model, gqltype, args, transaction, 'find', requiredId == null ? null : { column: 'id', id: castId(requiredId) }))),
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
      // Requests rejected before storage is touched keep the current readiness.
      if (!allowSchemaCreation && options.mode && options.mode !== 'validate') throw new SimfinityError('Database creation is disabled; initialize in validate mode', 'DATABASE_CREATION_DISABLED', 409);
      const effective = allowSchemaCreation ? options : { ...options, mode: 'validate' };
      if (effective.mode !== undefined && !['create', 'validate'].includes(effective.mode)) throw new SimfinityError(`Unknown initialization mode: ${effective.mode}`, 'INVALID_INITIALIZATION_MODE', 400);
      // A ready runtime keeps serving while it is initialized again. The most recently started
      // initialization decides readiness, and any failure of it marks storage unavailable.
      const attempt = ++initializations;
      try {
        const result = await plugin.initialize(configured, database, effective);
        if (attempt === initializations) ready = true;
        return result;
      } catch (error) {
        if (attempt === initializations) ready = false;
        throw error;
      }
    },
    describeDatabase() {
      if (!prepared) throw new SimfinityError('Create the GraphQL schema first', 'SCHEMA_NOT_CREATED', 500);
      return structuredClone(database);
    },
    /** DDL of the bound plugin for this runtime's schema, for review or export; storage is untouched. */
    compileDatabaseSchema() {
      return plugin.compileSchema(adapter.describeDatabase());
    },
  };
  return adapter;
};
