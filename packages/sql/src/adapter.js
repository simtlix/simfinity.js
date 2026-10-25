import { describeModels, createQueryPlan, SimfinityError } from '@simtlix/simfinity-core';
import { assertVersionInput } from '@simtlix/simfinity-core/internal/record-version';
import { planRelationalSchema } from './schema/plan.js';
import { locateVirtualFields } from './schema/virtual.js';
import { bindPlugin, assertCapabilities } from './plugin.js';
import { createRecordStore } from './records.js';
import { createTransactions } from './transactions.js';
import { callDriver, isRetryableFailure, normalizeFailure } from './errors.js';

// Distinct parents per batched children statement, whatever the runtime's maximum page size, so one statement's
// cost, and its text when it repeats a per-parent statement for each parent, stays within the range of the per-parent
// statements it replaces.
const CHILDREN_BATCH_SIZE = 100;

export const createSQLAdapter = (sourcePlugin) => {
  const plugin = bindPlugin(sourcePlugin);
  const { castId, createId } = plugin.values;
  const { driver } = plugin;
  const options = plugin.options;
  // The operators the plugin's compileQuery compiles, and whether it compiles emptiness through references and
  // collections and quantified collection/reference frames. Plans reject the others with UNSUPPORTED_QUERY, also for reads that do not go through the runtime,
  // such as model.find(). createQueryPlan defaults both flags to false when `operators` is given, so each flag
  // is passed explicitly.
  const { operators, referenceEmptiness = false, quantifiers = false } = plugin.queryFeatures;
  let configured = options ? Object.freeze({ ...options }) : null;
  let prepared = false;
  let ready = false;
  let initializations = 0;
  let allowSchemaCreation = true;
  let models; let database; let records;
  // Where virtual fields would hold storage; passed to plugin.initialize only when there are any.
  let virtualFields = [];
  // Entities whose rows hydrate from owned child tables; reading one takes several statements.
  let snapshotEntities = new Set();
  const handles = new Map();
  const assertReady = () => {
    if (!ready) throw new SimfinityError(`Initialize the ${plugin.displayName} database before executing operations`, 'DATABASE_NOT_INITIALIZED', 503);
  };
  const getConfiguration = () => configured;
  const transactions = createTransactions(getConfiguration, assertReady, plugin);
  const query = async (statement, session) => {
    assertReady();
    // Retryable errors must reach withTransaction unchanged, so normalize only at operation boundaries.
    const client = session ? transactions.clientOf(session) : undefined;
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
    const plan = createQueryPlan(models, name, args, { mode, operators, referenceEmptiness, quantifiers });
    const compiled = plugin.compileQuery(models, database, plan, extra, configured);
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
  // With `singleStatementReads`, a sessionless read that one statement answers runs on one connection
  // without a transaction. Reads of entities with owned tables, locking reads and reads in a session keep
  // withTransaction. The raw name only routes; the body still validates the model, so errors keep their order.
  const singleStatementReads = plugin.capabilities.includes('singleStatementReads');
  const read = (name, session, body, lock = false) => (singleStatementReads && !session && !lock && !snapshotEntities.has(name)
    ? transactions.withConnection(body)
    : transactions.withTransaction(session, body));
  const inverseField = (entity, connectionField) => {
    const field = entity.fields.find((item) => item.name === connectionField || item.storageName === connectionField);
    if (!field || field.kind !== 'reference') throw new SimfinityError('Invalid inverse connection field', 'INVALID_MODEL', 400);
    return field;
  };
  const findChildren = safe((model, gqltype, connectionField, parentId, args, session) => {
    const entity = models.entities.find((item) => item.name === nameOf(model));
    const field = inverseField(entity, connectionField);
    return read(entity.name, session, (transaction) => execute(model, gqltype, args, transaction, 'find', { column: field.storageName, id: castId(parentId) }));
  });
  // Statements a children statement asks to run before it, in its transaction. A plugin bug, not a database error, so
  // it is a plain error: the runtime reports it once and reads each parent alone.
  const setupOf = (statement) => {
    const setup = statement?.setup ?? [];
    if (!Array.isArray(setup) || setup.some((item) => typeof item?.text !== 'string')) throw new TypeError(`${plugin.displayName} compileChildrenQuery returned setup that is not a list of statements`);
    return setup;
  };
  // The children of many parents for one set of arguments, read as findChildren reads each of them: one statement
  // per CHILDREN_BATCH_SIZE distinct parents, each running every parent's find statement as compileQuery compiles
  // it, then one hydration of every child, which loads the owned rows of all of them with one statement per owned
  // table. Like findChildren, it runs on one connection without a transaction when the type has no owned tables,
  // and otherwise in one repeatable-read transaction. A statement with `setup` statements, such as settings that last
  // until the end of a transaction, always runs in one transaction, right after its setup. Invalid IDs, models and
  // arguments fail before a connection is taken. It resolves to one fresh list per entry of parentIds, in order;
  // duplicate IDs share their records.
  const findChildrenBatch = safe(async (model, gqltype, connectionField, parentIds, args) => {
    const name = nameOf(model);
    const field = inverseField(models.entities.find((item) => item.name === name), connectionField);
    const keys = parentIds.map((id) => castId(id));
    const ids = [...new Set(keys)];
    if (!ids.length) return [];
    const plan = createQueryPlan(models, name, args, { mode: 'find', operators, referenceEmptiness, quantifiers });
    const chunks = [];
    for (let start = 0; start < ids.length; start += CHILDREN_BATCH_SIZE) {
      const chunk = ids.slice(start, start + CHILDREN_BATCH_SIZE);
      const statement = plugin.compileChildrenQuery(models, database, plan, { column: field.storageName, ids: chunk }, configured);
      chunks.push({ start, size: chunk.length, statement, setup: setupOf(statement) });
    }
    const body = async (connection) => {
      const rows = [];
      const owners = [];
      for (const { start, size, statement, setup } of chunks) {
        for (const item of setup) await query(item, connection);
        const result = await query(statement, connection);
        for (const row of result.rows) {
          const position = Number(row[statement.parentColumn]);
          if (!Number.isSafeInteger(position) || position < 1 || position > size) throw new SimfinityError(`${plugin.displayName} returned a child row without its parent`, 'DATABASE_ERROR', 500);
          owners.push(start + position - 1);
          rows.push(row);
        }
      }
      // Hydration keeps only the entity's fields, so the parent position column does not reach the records.
      const hydrated = await records.hydrateRows(name, rows, connection);
      const byParent = ids.map(() => []);
      hydrated.forEach((record, index) => byParent[owners[index]].push(record));
      return byParent;
    };
    const lists = await (chunks.some((chunk) => chunk.setup.length) ? transactions.withTransaction(null, body) : read(name, null, body));
    const byId = new Map(ids.map((id, index) => [id, lists[index]]));
    return keys.map((key) => [...byId.get(key)]);
  });
  // Batched reads reproduce this adapter's own findChildren. A copy or an override whose findChildren is another
  // function reads each parent with it.
  function batchesChildren() {
    return this?.findChildren === findChildren;
  }
  const adapter = {
    // What the runtime may send: the plugin's queryFeatures, or the operators of 3.7.0 for a plugin without them.
    queryFeatures: plugin.queryFeatures,
    writeFeatures: Object.freeze({ optimisticConcurrency: true }),
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
      database = plugin.describeSchema(plan, configured);
      virtualFields = locateVirtualFields(models, plan);
      allowSchemaCreation = createCollection;
      snapshotEntities = new Set(database.tables.filter((table) => table.ownership).map((table) => table.ownership.ownerTable));
      records = createRecordStore(models, database, query, plugin, { multiRowInserts: configured?.multiRowInserts });
      prepared = true;
      // Batched collection reads are opt-in: only `batchedCollections: true`, with a plugin whose compileChildrenQuery
      // is paired with its compileQuery, defines these members. Otherwise the adapter has neither, so the runtime
      // reads each collection field with findChildren, at once, as 3.6.0 did. The configuration cannot change once
      // prepared.
      if (configured?.batchedCollections === true && plugin.compileChildrenQuery) {
        adapter.findChildrenBatch = findChildrenBatch;
        adapter.batchesChildren = batchesChildren;
      }
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
      if (models.entities.find((entity) => entity.name === gqltype.name)?.fields.some((field) => field.version)) {
        const handleVersion = (version) => {
          if (version == null) throw new SimfinityError(`${gqltype.name} is protected by optimistic concurrency: pass changes.version, or { version: false } for a write that must not advance it, such as a value a hook keeps up to date`, 'REQUIRED_VALUE', 400);
          return assertVersionInput(version);
        };
        model.create = (data, { session } = {}) => adapter.withTransaction(session, (transaction) => adapter.saveRecord(model, adapter.newRecord(model, { ...data, version: 1 }, transaction), transaction));
        model.update = async (id, changes, { session, version: mode } = {}) => {
          // Destructure once before retries: a getter or a caller-owned object must not change the precondition.
          const { version, ...rest } = changes;
          if (mode === false) return adapter.withTransaction(session, (transaction) => adapter.update(model, id, rest, transaction));
          const expectedVersion = handleVersion(version);
          return adapter.withTransaction(session, (transaction) => adapter.update(model, id, rest, transaction, { expectedVersion }));
        };
        model.delete = async (id, { session, version } = {}) => {
          if (version === false) return adapter.withTransaction(session, (transaction) => adapter.delete(model, id, transaction));
          const expectedVersion = handleVersion(version);
          return adapter.withTransaction(session, (transaction) => adapter.delete(model, id, transaction, { expectedVersion }));
        };
      }
      handles.set(model.name, model);
      if (onModelCreated) onModelCreated(model);
      return model;
    },
    castId,
    stateValue: (state) => state.value,
    withTransaction: transactions.withTransaction,
    enqueueAfterCommit: transactions.enqueueAfterCommit,
    newRecord(model, data) { nameOf(model); const id = data._id ?? data.id ?? createId(); return { ...data, _id: castId(id), id: castId(id) }; },
    toObject(record) { return record == null ? record : { ...record }; },
    saveRecord: safe((model, record, session) => transactions.withTransaction(session, (transaction) => records.create(nameOf(model), record, transaction))),
    getById: safe((model, id, session, options = {}) => read(model?.name, session, (transaction) => records.getById(nameOf(model), id, transaction, options), options.lock)),
    // A read by ID runs no hooks and changes nothing, so the runtime may skip one whose result it does not use.
    readByIdIsInert: () => true,
    // One transaction reads the rows by ID and hydrates them, owned records included, as getById does.
    getByIds: safe((model, ids) => {
      const name = nameOf(model);
      if (!ids.length) return [];
      const args = { id: { operator: 'IN', value: ids }, pagination: { page: 1, size: ids.length } };
      return read(name, null, (transaction) => execute(model, model.gqltype, args, transaction, 'find'));
    }),
    prepareUpdate(set, unset) { return { ...set, ...(Object.keys(unset).length ? { $unset: { ...unset } } : {}) }; },
    update: safe((model, id, update, session, options) => options?.expectedVersion === undefined
      ? records.update(nameOf(model), id, update, session) : records.update(nameOf(model), id, update, session, options)),
    delete: safe((model, id, session, options) => options?.expectedVersion === undefined
      ? records.remove(nameOf(model), id, session) : records.remove(nameOf(model), id, session, options)),
    find: safe((model, gqltype, args, session, { requiredId } = {}) => read(model?.name, session, (transaction) => execute(model, gqltype, args, transaction, 'find', requiredId == null ? null : { column: 'id', id: castId(requiredId) }))),
    count: safe((model, gqltype, args, session) => execute(model, gqltype, args, session, 'count')),
    aggregate: safe((model, gqltype, args, session) => execute(model, gqltype, args, session, 'aggregate')),
    findChildren,
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
        // Plugins without virtual fields keep receiving three arguments; the context lets one name a virtual
        // field whose earlier storage is still in the database when it reports SCHEMA_MISMATCH.
        const result = await (virtualFields.length
          ? plugin.initialize(configured, database, effective, { virtualFields: structuredClone(virtualFields) })
          : plugin.initialize(configured, database, effective));
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
