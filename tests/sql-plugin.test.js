import { describe, expect, it, vi } from 'vitest';
import { GraphQLID, GraphQLObjectType, GraphQLString } from 'graphql';
import { describeModels } from '@simtlix/simfinity-core';
import { createRecordStore } from '../packages/sql/src/records.js';
import { createTransactions } from '../packages/sql/src/transactions.js';
import { createSQL } from '../packages/sql/src/index.js';
import { createPostgres, postgresPlugin } from '../packages/postgres/src/index.js';
import { bindPlugin, assertCapabilities } from '../packages/sql/src/plugin.js';

const stubPlugin = () => ({
  apiVersion: 1, name: 'recording', displayName: 'Recording', defaultSchema: 'main', options: null,
  capabilities: ['transactions'],
  naming: { validateIdentifier() {}, generatedName: (...parts) => parts.join('_') },
  describeSchema() {}, initialize() {}, compileSchema() {}, compileQuery() {}, compileRecord() {},
  values: { createId() {}, castId() {}, encodeScalar() {}, decodeScalar() {}, encodeEmbedded() {} },
  driver: { assertConfiguration() {}, query() {}, acquire() {}, begin() {}, commit() {}, rollback() {}, release() {}, isRetryable() {}, normalizeError() {} },
});

describe('SQL plugin binding', () => {
  it('rejects missing and malformed plugins eagerly', () => {
    for (const plugin of [undefined, null, {}, { ...stubPlugin(), compileRecord: null }]) {
      expect(() => bindPlugin(plugin)).toThrow(expect.objectContaining({ extensions: expect.objectContaining({ code: 'INVALID_SQL_PLUGIN' }) }));
    }
  });
  it('rejects an incompatible contract version', () => {
    expect(() => bindPlugin({ ...stubPlugin(), apiVersion: 2 })).toThrow(expect.objectContaining({ extensions: expect.objectContaining({ code: 'UNSUPPORTED_SQL_PLUGIN_VERSION' }) }));
  });
  it('snapshots nested methods, options and capabilities', () => {
    const plugin = stubPlugin();
    plugin.options = { schema: 'original', pool: {} };
    const bound = bindPlugin(plugin);
    const method = bound.driver.query;
    plugin.driver.query = () => 'changed';
    plugin.options.schema = 'changed';
    plugin.capabilities.push('foreignKeys');
    expect(bound.driver.query).toBe(method);
    expect(bound.options.schema).toBe('original');
    expect(bound.options.pool).toBe(plugin.options.pool);
    expect(bound.capabilities).toEqual(['transactions']);
  });
});

it('rejects missing required guarantees before compilation or I/O', () => {
  const plugin = bindPlugin(stubPlugin());
  expect(() => assertCapabilities(plugin, { requirements: ['foreignKeys'] })).toThrow('foreignKeys');
  expect(() => assertCapabilities({ ...plugin, capabilities: [] }, { requirements: [] })).toThrow('transactions');
});

it('delegates create/read/update/delete and nested ownership with non-UUID identifiers', async () => {
  const Contact = new GraphQLObjectType({ name: 'RecordingContact', fields: { target: { type: GraphQLID }, label: { type: GraphQLString } } });
  const Item = new GraphQLObjectType({ name: 'RecordingItem', fields: { id: { type: GraphQLID }, title: { type: GraphQLString }, contact: { type: Contact, extensions: { relation: { embedded: true } } } } });
  const models = describeModels([{ gqltype: Item, endpoint: true }]);
  const fields = models.entities[0].fields;
  // Physical storage is supplied by the recording plugin; no PostgreSQL types or casts.
  const root = { name: 'RecordingItem', columns: [{ name: 'id' }, { name: 'title' }], primaryKey: { columns: ['id'] } };
  const owned = { name: 'contact', columns: [{ name: '__id' }, { name: 'target' }, { name: 'label' }], primaryKey: { columns: ['__id'] }, ownership: { ownerTable: root.name, field: 'contact', stateColumn: 'contact_state' } };
  expect(fields.find((field) => field.name === 'contact').kind).toBe('embedded');
  const rows = new Map([[root.name, []], [owned.name, []]]);
  const operations = [];
  let sequence = 0;
  const plugin = stubPlugin();
  plugin.values = { createId: () => `owned-${++sequence}`, castId: (value) => value, encodeScalar: (field, value) => value, decodeScalar: (field, value) => value, encodeEmbedded: (value) => value };
  plugin.compileRecord = (database, operation) => { operations.push(operation.kind); return { text: operation.kind, values: [operation] }; };
  const query = async ({ text, values: [operation] }) => {
    const current = rows.get(operation.table.name);
    if (text === 'insert') { current.push({ ...operation.data }); return { rows: [{ ...operation.data }] }; }
    if (text === 'selectOwned') return { rows: current.filter((row) => operation.ids.includes(row.__owner_id)) };
    if (text === 'selectById') return { rows: current.filter((row) => row.id === operation.id) };
    if (text === 'update') { const row = current.find((value) => value.id === operation.id); Object.assign(row, operation.data); return { rows: [row] }; }
    if (text === 'deleteOwned') rows.set(operation.table.name, current.filter((row) => row.__owner_id !== operation.ownerId));
    if (text === 'deleteById') rows.set(operation.table.name, current.filter((row) => row.id !== operation.id));
    return { rows: [] };
  };
  const store = createRecordStore(models, { schema: 'recording', tables: [root, owned] }, query, bindPlugin(plugin));
  const record = { id: 'item-one', title: 'before', contact: { target: 'target-one', label: 'first' } };
  expect(await store.create(root.name, record)).toMatchObject(record);
  expect(await store.getById(root.name, 'item-one')).toMatchObject(record);
  expect(await store.update(root.name, 'item-one', { title: 'after', contact: { target: 'target-two', label: 'second' } })).toMatchObject({ title: 'after', contact: { target: 'target-two', label: 'second' } });
  expect(await store.remove(root.name, 'item-one')).toMatchObject({ title: 'after' });
  expect(await store.getById(root.name, 'item-one')).toBeNull();
  expect(operations).toEqual(expect.arrayContaining(['insert', 'selectById', 'selectOwned', 'update', 'deleteOwned', 'deleteById']));
});

it('uses plugin transactions, retries only classified aborts and rejects foreign sessions', async () => {
  const plugin = stubPlugin();
  const events = [];
  plugin.driver = {
    ...plugin.driver,
    acquire: async () => ({}),
    begin: async () => events.push('begin'), commit: async () => events.push('commit'),
    rollback: async () => events.push('rollback'), release: async () => events.push('release'),
    query: async (configuration, statement) => ({ rows: [statement] }),
    isRetryable: (error) => error.message === 'confirmed abort', normalizeError: (error) => error,
  };
  const first = createTransactions(() => ({}), () => {}, bindPlugin(plugin));
  const second = createTransactions(() => ({}), () => {}, bindPlugin(plugin));
  let attempts = 0;
  await first.withTransaction(null, async (session) => {
    attempts++;
    expect(() => second.requireSession(session)).toThrow('active transaction');
    expect((await session.query('native', ['opaque'])).rows[0]).toEqual({ text: 'native', values: ['opaque'] });
    if (attempts === 1) throw new Error('confirmed abort');
  });
  expect(events).toEqual(['begin', 'rollback', 'release', 'begin', 'commit', 'release']);
  const body = vi.fn(() => { throw new Error('unknown outcome'); });
  await expect(first.withTransaction(null, body)).rejects.toThrow('unknown outcome');
  expect(body).toHaveBeenCalledTimes(1);
});

it('keeps runtime configuration isolated and rejects reconfiguration', () => {
  const pool = { connect: vi.fn(), query: vi.fn() };
  const plugin = postgresPlugin();
  const first = createSQL({ plugin });
  const second = createSQL({ plugin });
  first.configure({ pool, schema: 'first' });
  second.configure({ pool, schema: 'second' });
  const Item = new GraphQLObjectType({ name: 'IsolatedItem', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
  for (const runtime of [first, second]) { runtime.connect(null, Item, 'item', 'items'); runtime.createSchema(); }
  expect(first.describeDatabase().schema).toBe('first');
  expect(second.describeDatabase().schema).toBe('second');
  expect(() => first.configure({ pool })).toThrow('already bound');
  expect(pool.connect).not.toHaveBeenCalled();
});

it('preserves PostgreSQL facade metadata and initialization with the SQL entry point', async () => {
  const pool = { connect: vi.fn(), query: vi.fn() };
  const options = { pool, schema: 'equivalent' };
  const old = createPostgres(options);
  const current = createSQL({ plugin: postgresPlugin(options) });
  const Item = new GraphQLObjectType({ name: 'EquivalentItem', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
  for (const runtime of [old, current]) { runtime.connect(null, Item, 'item', 'items'); runtime.createSchema(); }
  expect(current.describeDatabase()).toEqual(old.describeDatabase());
  await expect(current.getModel(Item).findById('not-a-uuid')).rejects.toThrow('Initialize');
  expect(pool.connect).not.toHaveBeenCalled();
});

it('checks capabilities before physical compilation and initialization', () => {
  const plugin = stubPlugin();
  plugin.options = {};
  plugin.capabilities = [];
  plugin.describeSchema = vi.fn();
  plugin.initialize = vi.fn();
  const runtime = createSQL({ plugin });
  runtime.connect(null, new GraphQLObjectType({ name: 'MissingCapability', fields: { id: { type: GraphQLID } } }), 'item', 'items');
  expect(() => runtime.createSchema()).toThrow('transactions');
  expect(plugin.describeSchema).not.toHaveBeenCalled();
  expect(plugin.initialize).not.toHaveBeenCalled();
});

it('executes the public runtime through a non-PostgreSQL driver and query compiler', async () => {
  const plugin = stubPlugin();
  const configuration = { connection: 'opaque-connection' };
  plugin.options = configuration;
  plugin.describeSchema = (plan) => plan;
  plugin.initialize = vi.fn(async () => ({ initialized: true }));
  plugin.values = { createId: () => 'record-one', castId: (value) => value, encodeScalar: (field, value) => value, decodeScalar: (field, value) => value, encodeEmbedded: (value) => value };
  const stored = [];
  plugin.compileRecord = (description, operation) => ({ text: operation.kind, values: [operation] });
  plugin.compileQuery = vi.fn(() => ({ text: 'read-all', values: [] }));
  const client = { native: 'connection' };
  plugin.driver.acquire = vi.fn(async () => client);
  plugin.driver.normalizeError = (error) => error;
  plugin.driver.query = vi.fn(async (boundConfiguration, statement, boundClient) => {
    expect(boundConfiguration).toEqual(configuration);
    expect(boundClient).toBe(client);
    const operation = statement.values[0];
    if (statement.text === 'insert') stored.push(operation.data);
    if (statement.text === 'selectById') return { rows: stored.filter((record) => record.id === operation.id) };
    return { rows: stored };
  });
  const runtime = createSQL({ plugin });
  const Item = new GraphQLObjectType({ name: 'NativeRecordingItem', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
  runtime.connect(null, Item, 'item', 'items');
  runtime.createSchema();
  expect(await runtime.initializeDatabase()).toEqual({ initialized: true });
  expect(plugin.initialize).toHaveBeenCalledWith(configuration, expect.objectContaining({ schema: 'main' }), {});
  const model = runtime.getModel(Item);
  expect(await model.create({ name: 'recorded' })).toEqual({ id: 'record-one', _id: 'record-one', name: 'recorded' });
  expect(await model.find()).toEqual([{ id: 'record-one', _id: 'record-one', name: 'recorded' }]);
  expect(plugin.compileQuery).toHaveBeenCalledOnce();
  expect(plugin.driver.acquire).toHaveBeenCalledTimes(2);
});

it('never replays an unknown commit outcome and bounds confirmed abort retries', async () => {
  const plugin = stubPlugin();
  plugin.driver.acquire = async () => ({});
  plugin.driver.normalizeError = (error) => error;
  plugin.driver.commit = () => { throw new Error('unknown commit'); };
  plugin.driver.release = vi.fn();
  const body = vi.fn(async () => 'result');
  const unknown = createTransactions(() => ({}), () => {}, bindPlugin(plugin));
  await expect(unknown.withTransaction(null, body)).rejects.toThrow('unknown commit');
  expect(body).toHaveBeenCalledOnce();
  expect(plugin.driver.release).toHaveBeenCalledOnce();
  plugin.driver.commit = () => {};
  plugin.driver.isRetryable = (error) => error.message === 'aborted';
  const retrying = createTransactions(() => ({}), () => {}, bindPlugin(plugin));
  const abortedBody = vi.fn(() => { throw new Error('aborted'); });
  await expect(retrying.withTransaction(null, abortedBody)).rejects.toThrow('aborted');
  expect(abortedBody).toHaveBeenCalledTimes(6);
});

it.each([
  ['explicit id zero', { id: 0 }, 42, false],
  ['explicit _id zero', { _id: 0 }, 42, false],
  ['generated zero', {}, 0, true],
])('preserves numeric identifiers through the recording runtime: %s', async (label, input, generated, generates) => {
  const plugin = stubPlugin();
  plugin.options = {};
  plugin.describeSchema = (plan) => plan;
  plugin.values = { ...plugin.values, createId: vi.fn(() => generated), castId: Number, encodeScalar: (field, value) => value, decodeScalar: (field, value) => value };
  plugin.compileRecord = (description, operation) => ({ text: operation.kind, values: [operation] });
  plugin.driver.acquire = async () => ({});
  plugin.driver.normalizeError = (error) => error;
  const stored = [];
  plugin.driver.query = async (configuration, { text, values: [operation] }) => {
    if (text === 'insert') { stored.push(operation.data); return { rows: [operation.data] }; }
    return { rows: stored.filter((record) => record.id === operation.id) };
  };
  const runtime = createSQL({ plugin });
  const Item = new GraphQLObjectType({ name: 'NumericRecordingItem', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
  runtime.connect(null, Item, 'item', 'items');
  runtime.createSchema();
  await runtime.initializeDatabase();
  const model = runtime.getModel(Item);
  expect(await model.create({ ...input, name: label })).toEqual({ id: 0, _id: 0, name: label });
  expect(await model.findById(0)).toEqual({ id: 0, _id: 0, name: label });
  expect(plugin.values.createId).toHaveBeenCalledTimes(generates ? 1 : 0);

  const models = describeModels([{ gqltype: Item, endpoint: true }]);
  const store = createRecordStore(models, runtime.describeDatabase(), (statement) => plugin.driver.query({}, statement), plugin);
  expect(await store.create(Item.name, { _id: 0, name: 'direct record' })).toEqual({ id: 0, _id: 0, name: 'direct record' });
});
