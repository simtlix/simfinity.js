import { randomUUID } from 'node:crypto';
import {
  afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';
import {
  GraphQLEnumType, GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';
import { describeModels } from '@simtlix/simfinity-core';
import { createRecordStore } from '../packages/sql/src/records.js';
import { createTransactions } from '../packages/sql/src/transactions.js';
import { createSQL } from '../packages/sql/src/index.js';
import { planRelationalSchema } from '../packages/sql/src/schema/plan.js';
import { createPostgres, postgresPlugin } from '../packages/postgres/src/index.js';
import { castId, decodeScalar, encodeScalar } from '../packages/postgres/src/codecs.js';
import { describeDatabase } from '../packages/postgres/src/schema/describe.js';
import { compileDatabaseSchema } from '../packages/postgres/src/schema/ddl.js';
import { bindPlugin, assertCapabilities } from '../packages/sql/src/plugin.js';

const stubPlugin = () => ({
  apiVersion: 1, name: 'recording', displayName: 'Recording', defaultSchema: 'main', options: null,
  capabilities: ['transactions'],
  naming: { validateIdentifier() {}, generatedName: (...parts) => parts.join('_') },
  describeSchema() {}, initialize() {}, compileSchema() {}, compileQuery() {}, compileRecord() {},
  values: { createId() {}, castId() {}, encodeScalar() {}, decodeScalar() {}, encodeEmbedded() {} },
  driver: { assertConfiguration() {}, query() {}, acquire() {}, begin() {}, commit() {}, rollback() {}, release() {}, isRetryable() {}, normalizeError() {} },
});

// Owned transactions wait Math.random() times the backoff before each retry; zero keeps retry tests immediate.
beforeEach(() => { vi.spyOn(Math, 'random').mockReturnValue(0); });
afterEach(() => { vi.restoreAllMocks(); });

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
  // A failed driver call that the plugin does not map is masked; the driver error stays available as its cause.
  const unknownOutcome = await unknown.withTransaction(null, body).catch((error) => error);
  expect(unknownOutcome).toMatchObject({ message: 'Database operation failed', extensions: { code: 'DATABASE_ERROR', status: 500 } });
  expect(unknownOutcome.getCause().message).toBe('unknown commit');
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

it.each([
  ['default connectionField', 'ZeroDefault', undefined, 'author'],
  ['aliased connectionField', 'ZeroAliased', 'authorId', 'authorId'],
])('resolves a single reference to a zero identifier: %s', async (label, prefix, connectionField, column) => {
  const plugin = stubPlugin();
  plugin.options = {};
  plugin.capabilities = ['transactions', 'foreignKeys', 'deferredForeignKeys'];
  plugin.describeSchema = (plan) => plan;
  let next = 0;
  plugin.values = { ...plugin.values, createId: () => next++, castId: Number, encodeScalar: (field, value) => value, decodeScalar: (field, value) => value };
  plugin.compileRecord = (description, operation) => ({ text: operation.kind, values: [operation] });
  plugin.compileQuery = (models, description, plan) => ({ text: 'query', values: [plan] });
  plugin.driver.acquire = async () => ({});
  plugin.driver.normalizeError = (error) => error;
  const stored = new Map();
  const statements = [];
  plugin.driver.query = async (configuration, { text, values: [operation] }) => {
    statements.push(text);
    if (text === 'query') {
      // Batched reference reads select the related rows with one `id IN (...)` plan.
      expect(operation.where).toMatchObject({ kind: 'predicate', path: ['id'], operator: 'IN' });
      const ids = operation.where.value.map(Number);
      return { rows: (stored.get(operation.entity) || []).filter((record) => ids.includes(record.id)) };
    }
    const rows = stored.get(operation.table.name) || [];
    stored.set(operation.table.name, rows);
    if (text === 'insert') { rows.push(operation.data); return { rows: [operation.data] }; }
    if (text === 'selectById') return { rows: rows.filter((record) => record.id === operation.id) };
    throw new Error(`Unexpected statement ${text}`);
  };
  const runtime = createSQL({ plugin });
  const Author = new GraphQLObjectType({ name: `${prefix}Author`, fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
  const Book = new GraphQLObjectType({
    name: `${prefix}Book`,
    fields: {
      id: { type: GraphQLID },
      title: { type: GraphQLString },
      author: { type: Author, extensions: { relation: { embedded: false, ...(connectionField ? { connectionField } : {}) } } },
    },
  });
  runtime.connect(null, Author, 'zeroAuthor', 'zeroAuthors');
  runtime.connect(null, Book, 'zeroBook', 'zeroBooks');
  const schema = runtime.createSchema();
  await runtime.initializeDatabase();
  expect((await runtime.getModel(Author).create({ name: 'Zero' })).id).toBe(0);
  const added = await graphql({ schema, source: 'mutation { addzeroBook(input: { title: "T", author: { id: "0" } }) { id } }' });
  expect(added.errors).toBeUndefined();
  expect(stored.get(Book.name)).toEqual([expect.objectContaining({ id: 1, [column]: 0 })]);
  const source = `{ zeroBook(id: "${added.data.addzeroBook.id}") { id author { id name } } }`;

  // Without a context object each reference is read by ID; with one, references are read in batches.
  for (const [contextValue, batchRead] of [[undefined, false], [{}, true]]) {
    statements.length = 0;
    const result = await graphql({ schema, source, contextValue });
    expect(result.errors).toBeUndefined();
    expect(result.data.zeroBook).toEqual({ id: '1', author: { id: '0', name: 'Zero' } });
    expect(statements.includes('query')).toBe(batchRead);
  }
});

describe('SQL records with fields named like Object.prototype members', () => {
  // The real PostgreSQL value codecs over an in-memory table store. Embedded values are stored as JSON
  // text and parsed on reads, as pg returns jsonb, so absent keys are absent from ordinary objects.
  const fixture = () => {
    const Person = new GraphQLObjectType({ name: 'ProtoPerson', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
    const Spec = new GraphQLObjectType({ name: 'ProtoSpec', fields: { label: { type: GraphQLString }, constructor: { type: GraphQLString } } });
    const Meta = new GraphQLObjectType({ name: 'ProtoMeta', fields: { name: { type: GraphQLString }, length: { type: GraphQLInt } } });
    const Member = new GraphQLObjectType({ name: 'ProtoMember', fields: {
      person: { type: Person, extensions: { relation: { embedded: false } } }, toString: { type: GraphQLString },
    } });
    const Team = new GraphQLObjectType({ name: 'ProtoTeam', fields: {
      id: { type: GraphQLID }, name: { type: GraphQLString }, constructor: { type: GraphQLString }, toString: { type: GraphQLString },
      spec: { type: Spec, extensions: { relation: { embedded: true } } },
      valueOf: { type: Meta, extensions: { relation: { embedded: true } } },
      members: { type: new GraphQLList(Member), extensions: { relation: { embedded: true } } },
    } });
    const models = describeModels([{ gqltype: Person }, { gqltype: Team }]);
    const database = planRelationalSchema(models, { schema: 'main', naming: { validateIdentifier() {}, generatedName: (...parts) => parts.join('_') } });
    const tables = new Map(database.tables.map((table) => [table.name, []]));
    const read = (table, row) => {
      const result = { ...row };
      for (const column of table.columns) if (column.scalar === 'Embedded' && typeof result[column.name] === 'string') result[column.name] = JSON.parse(result[column.name]);
      return result;
    };
    const query = async ({ text, values: [operation] }) => {
      const { table } = operation;
      const rows = tables.get(table.name);
      if (text === 'insert') { rows.push({ ...operation.data }); return { rows: [read(table, operation.data)] }; }
      if (text === 'selectById') return { rows: rows.filter((row) => row.id === operation.id).map((row) => read(table, row)) };
      if (text === 'selectOwned') return { rows: rows.filter((row) => operation.ids.includes(row.__owner_id)).map((row) => read(table, row)) };
      if (text === 'update') {
        const row = rows.find((item) => item.id === operation.id);
        Object.assign(row, operation.data);
        return { rows: [read(table, row)] };
      }
      if (text === 'deleteOwned') tables.set(table.name, rows.filter((row) => row.__owner_id !== operation.ownerId));
      return { rows: [] };
    };
    const plugin = stubPlugin();
    plugin.values = { createId: randomUUID, castId, encodeScalar, decodeScalar, encodeEmbedded: JSON.stringify };
    plugin.compileRecord = (description, operation) => ({ text: operation.kind, values: [operation] });
    return { store: createRecordStore(models, database, query, bindPlugin(plugin)), tables };
  };

  it('stores absent prototype-named fields as missing at the root, in JSON values and in owned tables', async () => {
    const { store, tables } = fixture();
    const id = randomUUID();
    const created = await store.create('ProtoTeam', { _id: id, id, name: 'team', spec: { label: 'a' }, members: [{ person: null }] });
    const [row] = tables.get('ProtoTeam');
    expect([row.constructor, row.toString, row.valueOf, row.__field_valueOf_present]).toEqual([null, null, null, false]);
    expect(row.spec).toBe('{"label":"a"}');
    const [member] = tables.get('ProtoTeam_members');
    expect([member.person, member.toString, member.__field_toString_present]).toEqual([null, null, false]);
    expect([created.constructor, created.toString]).toEqual([null, null]);
    expect(Object.hasOwn(created.members[0], 'toString')).toBe(false);
  });

  it('never encodes inherited members into embedded values written by a create or an update', async () => {
    const { store, tables } = fixture();
    const id = randomUUID();
    await store.create('ProtoTeam', { _id: id, id, name: 'team', spec: { label: 'a', constructor: 'kept' } });
    expect(tables.get('ProtoTeam')[0].spec).toBe('{"label":"a","constructor":"kept"}');
    // Values inherited from other prototypes, such as class getters, are still read.
    class MetaValue { get name() { return 'from getter'; } }
    await store.update('ProtoTeam', id, { spec: { label: 'b' }, valueOf: new MetaValue() });
    const [row] = tables.get('ProtoTeam');
    expect([row.spec, row.valueOf, row.__field_valueOf_present]).toEqual(['{"label":"b"}', '{"name":"from getter"}', true]);
  });

  it('reads absent prototype-named keys as absent, never as the inherited member', async () => {
    const { store, tables } = fixture();
    const id = randomUUID();
    tables.get('ProtoTeam').push({
      id, name: 'legacy', constructor: null, toString: null, spec: '{"label":"z"}', __field_spec_present: true,
      valueOf: null, __field_valueOf_present: false, __members_state: 'missing',
    });
    const team = await store.getById('ProtoTeam', id);
    expect(team.spec).toEqual({ label: 'z' });
    expect(Object.hasOwn(team.spec, 'constructor')).toBe(false);
    expect(Object.hasOwn(team, 'valueOf')).toBe(false);
    // A projection object inherits members too; only the fields it names are kept.
    const projected = await store.getById('ProtoTeam', id, null, { projection: { spec: 1 } });
    expect(Object.keys(projected).sort()).toEqual(['_id', 'id', 'spec']);
  });
});

describe('SQL state machine fields', () => {
  const machine = {
    initialState: { name: 'OPEN', value: 'OPEN' },
    actions: { close: { from: { name: 'OPEN', value: 'OPEN' }, to: { name: 'CLOSED', value: 'CLOSED' } } },
  };
  const recordingRuntime = () => {
    const plugin = stubPlugin();
    plugin.options = {};
    plugin.capabilities = postgresPlugin().capabilities;
    plugin.describeSchema = (plan) => plan;
    plugin.initialize = async () => ({ mode: 'validate', created: [] });
    plugin.compileQuery = vi.fn(() => ({ text: 'query', values: [] }));
    plugin.driver = { ...plugin.driver, query: async () => ({ rows: [] }), isRetryable: () => false, normalizeError: (error) => error };
    return { plugin, runtime: createSQL({ plugin }) };
  };
  const ticket = (name, state) => new GraphQLObjectType({ name, fields: { id: { type: GraphQLID }, title: { type: GraphQLString }, ...(state ? { state: { type: state } } : {}) } });
  const Meta = new GraphQLObjectType({ name: 'TicketStateMeta', fields: { label: { type: GraphQLString } } });

  it.each([
    ['String', GraphQLString],
    ['NonNull(String)', new GraphQLNonNull(GraphQLString)],
    ['List(String)', new GraphQLList(GraphQLString)],
    ['Int', GraphQLInt],
    ['embedded object', Meta],
  ])('rejects a %s state field with INVALID_MODEL when the schema is created', (label, type) => {
    const { plugin, runtime } = recordingRuntime();
    const name = `Ticket${label.replace(/\W/g, '')}`;
    const Ticket = new GraphQLObjectType({ name, fields: { id: { type: GraphQLID }, state: { type, ...(type === Meta ? { extensions: { relation: { embedded: true } } } : {}) } } });
    runtime.connect(null, Ticket, `ticket${label.replace(/\W/g, '')}`, `tickets${label.replace(/\W/g, '')}`, null, null, machine);
    expect(() => runtime.createSchema()).toThrow(expect.objectContaining({
      message: `State machine field ${name}.state must be a GraphQL enum on SQL backends`,
      extensions: expect.objectContaining({ code: 'INVALID_MODEL', status: 400 }),
    }));
    expect(plugin.compileQuery).not.toHaveBeenCalled();
  });

  it.each([
    ['an enum', (State) => State],
    ['a required enum', (State) => new GraphQLNonNull(State)],
    ['an enum list', (State) => new GraphQLList(State)],
  ])('maps the stored values of %s state field back to its names', async (label, wrap) => {
    const { plugin, runtime } = recordingRuntime();
    const prefix = label.replace(/\W/g, '');
    const State = new GraphQLEnumType({ name: `${prefix}State`, values: { OPEN: { value: 'CLOSED' }, CLOSED: { value: 2 } } });
    const Ticket = ticket(`${prefix}Ticket`, wrap(State));
    const states = {
      initialState: { name: 'OPEN', value: 'CLOSED' },
      actions: { close: { from: { name: 'OPEN', value: 'CLOSED' }, to: { name: 'CLOSED', value: 2 } } },
    };
    runtime.connect(null, Ticket, `ticket${prefix}`, `tickets${prefix}`, null, null, states);
    runtime.createSchema();
    await runtime.initializeDatabase();
    await runtime.getModel(Ticket).find();
    const [models] = plugin.compileQuery.mock.calls[0];
    const state = models.entities.find((entity) => entity.name === Ticket.name).fields.find((field) => field.name === 'state');
    expect(state.stateNames).toEqual([{ value: 'CLOSED', name: 'OPEN' }, { value: '2', name: 'CLOSED' }]);
  });
});

describe('SQL runtime DDL export', () => {
  const Shop = () => new GraphQLObjectType({ name: 'ExportShop', fields: { id: { type: GraphQLID }, name: { type: GraphQLString, extensions: { unique: true } } } });

  it('compiles the bound plugin DDL for the runtime schema without touching storage', () => {
    const plugin = stubPlugin();
    plugin.options = {};
    plugin.capabilities = postgresPlugin().capabilities;
    plugin.describeSchema = (plan) => ({ ...plan, described: true });
    plugin.compileSchema = vi.fn(() => ['CREATE TABLE shop']);
    plugin.initialize = vi.fn();
    const runtime = createSQL({ plugin });
    runtime.connect(null, Shop(), 'shop', 'shops');
    expect(() => runtime.compileDatabaseSchema()).toThrow(expect.objectContaining({ extensions: expect.objectContaining({ code: 'SCHEMA_NOT_CREATED' }) }));
    runtime.createSchema();
    expect(runtime.compileDatabaseSchema()).toEqual(['CREATE TABLE shop']);
    expect(plugin.compileSchema).toHaveBeenCalledOnce();
    const [description] = plugin.compileSchema.mock.calls[0];
    expect(description).toEqual(runtime.describeDatabase());
    expect(description).toMatchObject({ schema: 'main', described: true });
    expect(plugin.initialize).not.toHaveBeenCalled();
  });

  it('exports PostgreSQL DDL for the configured schema rather than public', () => {
    const pool = { connect: vi.fn(), query: vi.fn() };
    const runtime = createSQL({ plugin: postgresPlugin({ pool, schema: 'exported' }) });
    runtime.connect(null, Shop(), 'shop', 'shops');
    runtime.createSchema();
    const ddl = runtime.compileDatabaseSchema();
    expect(ddl).toEqual(compileDatabaseSchema(describeDatabase(runtime.getRegistrations(), { schema: 'exported' })));
    expect(ddl[0]).toContain('"exported"');
    expect(ddl.join('\n')).not.toContain('"public"');
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  const uri = process.env.SIMFINITY_POSTGRES_URI;
  it.skipIf(!uri)('validates PostgreSQL storage created from the exported DDL in an empty schema', async () => {
    const { default: pg } = await import('pg');
    const pool = new pg.Pool({ connectionString: uri });
    const schema = `export_${randomUUID().replaceAll('-', '')}`;
    try {
      const runtime = createSQL({ plugin: postgresPlugin({ pool, schema }) });
      const Owner = new GraphQLObjectType({ name: 'ExportOwner', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
      const Contact = new GraphQLObjectType({ name: 'ExportContact', fields: {
        owner: { type: Owner, extensions: { relation: { embedded: false } } }, email: { type: GraphQLString, extensions: { unique: true } },
      } });
      const State = new GraphQLEnumType({ name: 'ExportState', values: { OPEN: { value: 'OPEN' }, DONE: { value: 'DONE' } } });
      const Order = new GraphQLObjectType({ name: 'ExportOrder', fields: {
        id: { type: GraphQLID }, code: { type: new GraphQLNonNull(GraphQLString), extensions: { unique: true } },
        owner: { type: Owner, extensions: { relation: { embedded: false } } }, state: { type: State },
        tags: { type: new GraphQLList(GraphQLString) }, relatedIds: { type: new GraphQLList(GraphQLID) },
        contacts: { type: new GraphQLList(Contact), extensions: { relation: { embedded: true } } },
      } });
      runtime.connect(null, Owner, 'exportOwner', 'exportOwners');
      runtime.addNoEndpointType(Contact);
      runtime.connect(null, Order, 'exportOrder', 'exportOrders', null, null, {
        initialState: { name: 'OPEN', value: 'OPEN' }, actions: { finish: { from: { name: 'OPEN', value: 'OPEN' }, to: { name: 'DONE', value: 'DONE' } } },
      });
      runtime.createSchema();
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const statement of runtime.compileDatabaseSchema()) await client.query(statement);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
      expect(await runtime.initializeDatabase({ mode: 'validate' })).toEqual({ mode: 'validate', created: [] });
      expect(await runtime.initializeDatabase({ mode: 'create' })).toEqual({ mode: 'create', created: [] });
      const owner = await runtime.getModel(Owner).create({ name: 'Owner' });
      const order = await runtime.getModel(Order).create({ code: 'A1', owner: owner.id, state: 'OPEN', contacts: [{ owner: owner.id, email: 'a@example.com' }] });
      expect((await runtime.getModel(Order).findById(order.id)).contacts).toEqual([expect.objectContaining({ email: 'a@example.com' })]);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await pool.end();
    }
  });
});
