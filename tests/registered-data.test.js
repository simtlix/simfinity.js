import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import mongoose from 'mongoose';
import { GraphQLFloat, GraphQLID, GraphQLInt, GraphQLList, GraphQLObjectType, GraphQLString } from 'graphql';
import { createRuntime } from '../packages/core/src/index.js';
import { createMongoAdapter } from '../packages/mongodb/src/mongo/adapter.js';
import { observeMongoCursor } from '../packages/mongodb/src/mongo/cursor.js';

const uri = process.env.SIMFINITY_TEST_MONGODB_URI;
describe.skipIf(!uri)('registered data operations on MongoDB', () => {
  let connection, Model, runtime, other, transaction;
  const events = [], hooks = [];
  const typeName = 'RegisteredDataItem';
  beforeAll(async () => {
    connection = await mongoose.createConnection(uri, { dbName: 'simfinity_registered_data_tests' }).asPromise();
    Model = connection.model(typeName, new mongoose.Schema({ _id: String, tenant: String, title: String, version: Number, ratio: Number, data: mongoose.Schema.Types.Mixed }, { versionKey: false }));
    await Model.deleteMany({});
    const type = new GraphQLObjectType({ name: typeName, fields: { id: { type: GraphQLID }, tenant: { type: GraphQLString }, title: { type: GraphQLString }, version: { type: GraphQLInt }, ratio: { type: GraphQLFloat } },
      extensions: { scope: { find({ args, context }) { if (context?.tenant) args.tenant = { operator: 'EQ', value: context.tenant }; if (context?.pageScope) args.pagination = { page: 1, size: 1 }; } } } });
    const adapter = createMongoAdapter();
    transaction = vi.fn((...args) => adapter.withTransaction(...args));
    runtime = createRuntime({ ...adapter, withTransaction: transaction });
    runtime.preventCreatingCollection(true);
    runtime.connect(Model, type, 'registeredDataItem', 'registeredDataItems', { onSaving() { hooks.push('save'); }, onUpdating() { hooks.push('update'); } });
    runtime.use(async ({ type: registered, operation }, next) => { events.push([registered.gqltype.name, operation]); await next(); });
    runtime.createSchema();
  });
  afterAll(async () => { await connection?.dropDatabase(); await connection?.close(); await other?.close(); });
  test('generated lifecycle preserves scalar identity, null, same-session rollback and CAS', async () => {
    const session = await connection.startSession(); session.startTransaction();
    const result = await runtime.execute(typeName, 'save', { input: { tenant: 'one', title: null, version: 1 } }, { session, storage: { id: 'string-key', nulls: 'preserve' } });
    expect(result._id).toBe('string-key'); expect(result.title).toBeNull();
    expect(await Model.findById('string-key')).toBeNull();
    const changed = await runtime.execute(typeName, 'update', { input: { id: 'string-key', title: null } }, { session, storage: { filter: { tenant: 'one', version: 1 }, increments: { version: 1 }, nulls: 'preserve' } });
    expect(changed.version).toBe(2); expect(changed.title).toBeNull();
    await expect(runtime.execute(typeName, 'update', { input: { id: 'string-key', title: 'wrong' } }, { session, storage: { filter: { version: 1 } } })).rejects.toMatchObject({ extensions: { code: 'NOT_VALID_ID' } });
    expect(await runtime.execute(typeName, 'delete', { id: 'string-key' }, { session, storage: { filter: { version: 1 } } })).toBeNull();
    await session.abortTransaction(); await session.endSession();
    expect(await Model.findById('string-key')).toBeNull();
    expect(hooks).toEqual(expect.arrayContaining(['save', 'update']));
  });
  test.each(['update', 'delete'])('malformed conditional filters reject before %s transactions, controllers or writes', async (operation) => {
    const id = 'invalid-filter-' + operation;
    await Model.create({ _id: id, tenant: 'one', title: 'before', version: 1 });
    transaction.mockClear();
    const hookCount = hooks.length;
    const update = vi.spyOn(Model.collection, 'findOneAndUpdate');
    const remove = vi.spyOn(Model.collection, 'findOneAndDelete');
    try {
      for (const filter of [null, false, 0, '', true, 1, 'version', NaN, 1n, Symbol('filter'), () => ({}), []]) {
        const args = operation === 'update' ? { input: { id, title: 'after' } } : { id };
        await expect(runtime.execute(typeName, operation, args, { storage: { filter } })).rejects.toMatchObject({ extensions: { code: 'INVALID_STORAGE_OPERATION' } });
      }
      expect(transaction).not.toHaveBeenCalled(); expect(hooks).toHaveLength(hookCount);
      expect(update).not.toHaveBeenCalled(); expect(remove).not.toHaveBeenCalled();
      expect(await Model.collection.findOne({ _id: id })).toMatchObject({ title: 'before', version: 1 });
    } finally { update.mockRestore(); remove.mockRestore(); await Model.deleteOne({ _id: id }); }
  });
  test('conditional writes preserve omitted and undefined filters, empty predicates and full CAS', async () => {
    for (const storage of [{}, { filter: undefined }, { filter: {} }]) {
      await Model.create({ _id: 'filter-control', title: 'before', version: 1 });
      try {
        expect((await runtime.execute(typeName, 'update', { input: { id: 'filter-control', title: 'after' } }, { storage })).title).toBe('after');
        expect((await runtime.execute(typeName, 'delete', { id: 'filter-control' }, { storage }))._id).toBe('filter-control');
      } finally { await Model.deleteOne({ _id: 'filter-control' }); }
    }
    await Model.create({ _id: 'filter-control', tenant: 'one', title: 'before', version: 1 });
    try {
      const args = { input: { id: 'filter-control', title: 'after' } };
      await expect(runtime.execute(typeName, 'update', args, { storage: { filter: { tenant: 'other', version: 1 } } })).rejects.toMatchObject({ extensions: { code: 'NOT_VALID_ID' } });
      expect(await runtime.execute(typeName, 'delete', { id: 'filter-control' }, { storage: { filter: { tenant: 'one', version: 2 } } })).toBeNull();
      expect((await runtime.execute(typeName, 'update', args, { storage: { filter: { tenant: 'one', version: 1 }, increments: { version: 1 } } })).version).toBe(2);
      expect((await runtime.execute(typeName, 'delete', { id: 'filter-control' }, { storage: { filter: { tenant: 'one', version: 2 } } }))._id).toBe('filter-control');
    } finally { await Model.deleteOne({ _id: 'filter-control' }); }
  });
  test('compiler queries and trusted projections retain scope and stream batches', async () => {
    await Model.insertMany([{ _id: 'a', tenant: 'one', title: 'A', version: 1 }, { _id: 'b', tenant: 'two', title: 'B', version: 2 }, { _id: 'c', tenant: 'one', title: 'C', version: 3 }]);
    const context = { tenant: 'one' };
    const rows = await runtime.execute(typeName, 'find', { version: { operator: 'GTE', value: 1 } }, { context });
    expect(rows.map((row) => row._id).sort()).toEqual(['a', 'c']);
    expect(await runtime.execute(typeName, 'count', {}, { context })).toBe(2);
    const detailObserver = { beforeFetch: vi.fn(), onRows: vi.fn() };
    expect((await runtime.execute(typeName, 'get_by_id', { id: 'a' }, { observer: detailObserver, readOptions: { maxTimeMS: 1000, timeoutMS: 1000 } }))._id).toBe('a');
    expect(detailObserver.beforeFetch).toHaveBeenCalledTimes(1);
    expect(detailObserver.onRows).toHaveBeenCalledTimes(1);
    const observer = { beforeFetch: vi.fn(), onRows: vi.fn() };
    const cursor = await runtime.executeStorage(typeName, { backend: 'mongodb', operation: 'stream', pipeline: [{ $sort: { _id: 1 } }, { $project: { title: 1 } }], options: { batchSize: 1 } }, { context, observer });
    const output = []; for await (const row of cursor) output.push(row._id);
    expect(output).toEqual(['a', 'c']); expect(observer.beforeFetch.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(observer.onRows.mock.calls.flatMap(([batch]) => batch).length).toBe(2);
    expect(events).toContainEqual([typeName, 'storage.stream']);
    await expect(runtime.executeStorage(typeName, { backend: 'mongodb', operation: 'aggregate', pipeline: [{ $unionWith: 'other' }] })).rejects.toMatchObject({ extensions: { code: 'INVALID_STORAGE_OPERATION' } });
  });
  test('explicit atomic primitives preserve matched counts, expressions and adopted transactions', async () => {
    const session = await connection.startSession(); session.startTransaction();
    const update = await runtime.executeStorage(typeName, { backend: 'mongodb', operation: 'updateOne', filter: { _id: 'a', version: 1 }, update: { $inc: { version: 1 }, $set: { title: null } } }, { session });
    expect(update.matchedCount).toBe(1);
    const missed = await runtime.executeStorage(typeName, { backend: 'mongodb', operation: 'updateOne', filter: { _id: 'a', version: 1 }, update: { $inc: { version: 1 } } }, { session });
    expect(missed.matchedCount).toBe(0);
    const claimed = await runtime.executeStorage(typeName, { backend: 'mongodb', operation: 'findOneAndUpdate', filter: { _id: 'a', version: 2 }, update: [{ $set: { version: { $add: ['$version', 1] } } }], options: { returnDocument: 'after' } }, { session });
    expect(claimed.version).toBe(3); expect(claimed.title).toBeNull();
    await session.abortTransaction(); await session.endSession();
    expect((await Model.findById('a')).version).toBe(1);
    await expect(runtime.executeStorage(typeName, { backend: 'mongodb', operation: 'updateOne', filter: { secret: 1 }, update: { $set: { title: 'bad' } } })).rejects.toThrow('Unregistered storage field');
    await expect(runtime.execute(typeName, 'save', { input: { unknown: true } })).rejects.toThrow();
    await expect(runtime.execute('Missing', 'find')).rejects.toMatchObject({ extensions: { code: 'UNREGISTERED_ENTITY' } });
  });
  test('bulk, replacement, upsert, concurrent claims and failed middleware preserve owner boundaries', async () => {
    const capability = (request) => runtime.executeStorage(typeName, { backend: 'mongodb', ...request });
    await capability({ operation: 'insertMany', documents: [{ _id: 'claim', tenant: 'one', version: 0 }] });
    const results = await Promise.all([1, 2].map(() => capability({ operation: 'findOneAndUpdate', filter: { _id: 'claim', version: 0 }, update: { $inc: { version: 1 } }, options: { returnDocument: 'after' } })));
    expect(results.filter(Boolean)).toHaveLength(1);
    const bulk = await capability({ operation: 'bulkWrite', operations: [{ updateOne: { filter: { _id: 'claim', version: 1 }, update: { $set: { title: null } } } }, { updateOne: { filter: { _id: 'claim', version: 0 }, update: { $inc: { version: 1 } } } }] });
    expect(bulk.matchedCount).toBe(1);
    const replaced = await capability({ operation: 'replaceOne', filter: { _id: 'claim', version: 1 }, replacement: { _id: 'claim', tenant: 'one', version: 9, title: null } });
    expect(replaced.matchedCount).toBe(1);
    const upsert = await capability({ operation: 'updateOne', filter: { _id: 'counter' }, update: { $max: { version: 3 }, $setOnInsert: { tenant: 'one' } }, options: { upsert: true } });
    expect(upsert.upsertedCount).toBe(1);
    const removed = await capability({ operation: 'findOneAndDelete', filter: { _id: 'claim', version: 9 } });
    expect(removed.title).toBeNull();
    expect((await capability({ operation: 'deleteMany', filter: { _id: 'counter' } })).deletedCount).toBe(1);
    await expect(capability({ operation: 'find', options: { upsert: true } })).rejects.toThrow('Unsupported MongoDB option');
    await expect(capability({ operation: 'find', options: { session: {} } })).rejects.toThrow('Unsupported MongoDB option');
    const denied = createRuntime(createMongoAdapter()); denied.preventCreatingCollection(true);
    const DeniedType = new GraphQLObjectType({ name: 'DeniedStorageItem', fields: { id: { type: GraphQLID }, title: { type: GraphQLString } } });
    denied.connect(Model, DeniedType, 'deniedItem', 'deniedItems'); denied.createSchema();
    denied.use(() => { throw new Error('denied'); });
    await expect(denied.executeStorage('DeniedStorageItem', { backend: 'mongodb', operation: 'deleteMany', filter: {} })).rejects.toThrow('denied');
    expect(await Model.countDocuments({ _id: 'a' })).toBe(1);
    const protectedRuntime = createRuntime(createMongoAdapter({ referentialIntegrity: 'transactional' }));
    protectedRuntime.preventCreatingCollection(true);
    const ProtectedType = new GraphQLObjectType({ name: 'ProtectedStorageItem', fields: { id: { type: GraphQLID }, title: { type: GraphQLString } } });
    protectedRuntime.connect(Model, ProtectedType, 'protectedItem', 'protectedItems'); protectedRuntime.createSchema();
    await expect(protectedRuntime.executeStorage('ProtectedStorageItem', { backend: 'mongodb', operation: 'deleteMany', filter: {} })).rejects.toMatchObject({ extensions: { code: 'UNSUPPORTED_CAPABILITY' } });
    await expect(runtime.executeStorage(typeName, { backend: 'other', operation: 'deleteMany', filter: {} })).rejects.toMatchObject({ extensions: { code: 'UNSUPPORTED_CAPABILITY' } });
  });
  test('storage filters and projections see all scoped rows before explicit pagination', async () => {
    await Model.insertMany(Array.from({ length: 101 }, (_, index) => ({ _id: 'page-' + String(index).padStart(3, '0'), tenant: 'large', version: index })));
    await Model.create({ _id: 'page-outside', tenant: 'other', version: 999 });
    const read = (request) => runtime.executeStorage(typeName, { backend: 'mongodb', ...request }, { context: { tenant: 'large' } });
    expect(await read({ operation: 'find', options: { limit: 200 } })).toHaveLength(101);
    expect(await read({ operation: 'find', filter: { _id: 'page-100' } })).toHaveLength(1);
    expect(await read({ operation: 'aggregate', pipeline: [{ $count: 'total' }] })).toEqual([{ total: 101 }]);
    const cursor = await read({ operation: 'stream', pipeline: [], options: { batchSize: 7 } });
    const rows = []; for await (const row of cursor) rows.push(row);
    expect(rows).toHaveLength(101);
    const page = await read({ operation: 'find', filter: { version: { $gte: 95 } }, options: { sort: { version: -1 }, skip: 1, limit: 2 } });
    expect(page.map((row) => row.version)).toEqual([99, 98]);
    const projected = await read({ operation: 'aggregate', pipeline: [{ $match: { version: { $gte: 95 } } }], options: { sort: { version: -1 }, skip: 1, limit: 2 } });
    expect(projected.map((row) => row.version)).toEqual([99, 98]);
    await expect(runtime.executeStorage(typeName, { backend: 'mongodb', operation: 'find' }, { context: { pageScope: true } })).rejects.toMatchObject({ extensions: { code: 'INVALID_SCOPE' } });
  });
  test('preserve null retains embedded nullable lists while legacy update retains empty-list semantics', async () => {
    const Embedded = new GraphQLObjectType({ name: 'DataNullEmbedded', fields: { tags: { type: new GraphQLList(GraphQLString) } } });
    const Type = new GraphQLObjectType({ name: 'DataNullOwner', fields: { id: { type: GraphQLID }, settings: { type: Embedded, extensions: { relation: { embedded: true } } } } });
    const Owner = connection.model('DataNullOwner', new mongoose.Schema({ _id: String, settings: { tags: [String] } }, { versionKey: false }));
    const instance = createRuntime(createMongoAdapter()); instance.preventCreatingCollection(true);
    instance.addNoEndpointType(Embedded); instance.connect(Owner, Type, 'nullOwner', 'nullOwners'); instance.createSchema();
    await instance.execute('DataNullOwner', 'save', { input: { settings: { tags: ['before'] } } }, { storage: { id: 'one', nulls: 'preserve' } });
    await instance.execute('DataNullOwner', 'update', { input: { id: 'one', settings: { tags: null } } }, { storage: { nulls: 'preserve' } });
    expect((await Owner.collection.findOne({ _id: 'one' })).settings.tags).toBeNull();
    await instance.execute('DataNullOwner', 'update', { input: { id: 'one', settings: { tags: null } } });
    expect((await Owner.collection.findOne({ _id: 'one' })).settings.tags).toEqual([]);
  });
  test('integer increments reject fractional deltas and cannot commit out-of-range results in an adopted transaction', async () => {
    await Model.create({ _id: 'integer', tenant: 'one', version: 1, ratio: 1 });
    await expect(runtime.execute(typeName, 'update', { input: { id: 'integer' } }, { storage: { increments: { version: 0.5 } } })).rejects.toThrow();
    expect((await Model.findById('integer')).version).toBe(1);
    const fractional = await runtime.execute(typeName, 'update', { input: { id: 'integer' } }, { storage: { increments: { ratio: 0.5 } } });
    expect(fractional.ratio).toBe(1.5);
    await Model.updateOne({ _id: 'integer' }, { $set: { ratio: Number.MAX_VALUE } });
    await expect(runtime.execute(typeName, 'update', { input: { id: 'integer' } }, { storage: { increments: { ratio: 1e308 } } })).rejects.toMatchObject({ extensions: { code: 'NOT_VALID_ID' } });
    expect((await Model.findById('integer')).ratio).toBe(Number.MAX_VALUE);
    await expect(runtime.execute(typeName, 'update', { input: { id: 'integer' } }, { storage: { increments: { version: 2147483648 } } })).rejects.toThrow();
    await Model.updateOne({ _id: 'integer' }, { $set: { version: 1.5 } });
    await expect(runtime.execute(typeName, 'update', { input: { id: 'integer' } }, { storage: { increments: { version: 1 } } })).rejects.toMatchObject({ extensions: { code: 'NOT_VALID_ID' } });
    expect((await Model.findById('integer')).version).toBe(1.5);
    await Model.updateOne({ _id: 'integer' }, { $set: { version: -2147483648 } });
    await expect(runtime.execute(typeName, 'update', { input: { id: 'integer' } }, { storage: { increments: { version: -1 } } })).rejects.toMatchObject({ extensions: { code: 'NOT_VALID_ID' } });
    expect((await Model.findById('integer')).version).toBe(-2147483648);
    await Model.updateOne({ _id: 'integer' }, { $set: { version: 2147483647 } });
    const session = await connection.startSession(); session.startTransaction();
    try {
      await expect(runtime.execute(typeName, 'update', { input: { id: 'integer' } }, { session, storage: { increments: { version: 1 } } })).rejects.toThrow();
      await session.commitTransaction();
      expect((await Model.findById('integer')).version).toBe(2147483647);
    } finally { if (session.inTransaction()) await session.abortTransaction(); await session.endSession(); }
  });
  test('Float increments atomically reject rounded overflow while retaining missing-field and CAS semantics', async () => {
    const delta = 1.5 * 2 ** 971;
    const old = Number.MAX_VALUE - delta;
    expect(Number.isFinite(old)).toBe(true);
    expect(old + delta).toBe(Infinity);
    await Model.insertMany([{ _id: 'float-positive', ratio: old }, { _id: 'float-negative', ratio: -old }, { _id: 'float-missing', version: 1 }]);
    await Model.collection.insertMany([{ _id: 'float-string', ratio: 'invalid' }, { _id: 'float-null', ratio: null }]);
    const session = await connection.startSession(); session.startTransaction();
    try {
      for (const [id, amount] of [['float-positive', delta], ['float-negative', -delta], ['float-string', 1], ['float-null', 1]]) {
        await expect(runtime.execute(typeName, 'update', { input: { id } }, { session, storage: { increments: { ratio: amount } } })).rejects.toMatchObject({ extensions: { code: 'NOT_VALID_ID' } });
        expect(session.inTransaction()).toBe(true);
      }
      await expect(runtime.execute(typeName, 'update', { input: { id: 'float-missing' } }, { session, storage: { filter: { version: 0 }, increments: { ratio: 0.5 } } })).rejects.toMatchObject({ extensions: { code: 'NOT_VALID_ID' } });
      const changed = await runtime.execute(typeName, 'update', { input: { id: 'float-missing' } }, { session, storage: { filter: { version: 1 }, increments: { ratio: 0.5 } } });
      expect(changed.ratio).toBe(0.5);
      await session.commitTransaction();
      expect((await Model.collection.findOne({ _id: 'float-positive' })).ratio).toBe(old);
      expect((await Model.collection.findOne({ _id: 'float-negative' })).ratio).toBe(-old);
      expect((await Model.collection.findOne({ _id: 'float-string' })).ratio).toBe('invalid');
      expect((await Model.collection.findOne({ _id: 'float-null' })).ratio).toBeNull();
      expect((await Model.findById('float-missing')).ratio).toBe(0.5);
    } finally { if (session.inTransaction()) await session.abortTransaction(); await session.endSession(); }
  });
  test('spread-decorated adapters retain storage capabilities and caller transaction policy', async () => {
    const base = createMongoAdapter();
    const storageDelegate = base.executeStorage;
    const policy = vi.fn((...args) => base.withTransaction(...args));
    const decorated = { ...base, withTransaction: policy };
    const instance = createRuntime(decorated); instance.preventCreatingCollection(true);
    const Type = new GraphQLObjectType({ name: 'DecoratedStorageItem', fields: { id: { type: GraphQLID }, tenant: { type: GraphQLString }, title: { type: GraphQLString } },
      extensions: { scope: { find({ args, context }) { args.tenant = { operator: 'EQ', value: context.tenant }; } } } });
    instance.connect(Model, Type, 'decoratedItem', 'decoratedItems'); instance.createSchema();
    const session = await connection.startSession(); session.startTransaction();
    try {
      await instance.execute('DecoratedStorageItem', 'save', { input: { tenant: 'decorated', title: 'before' } }, { session, storage: { id: 'decorated' } });
      const changed = await instance.executeStorage('DecoratedStorageItem', { backend: 'mongodb', operation: 'updateOne', filter: { _id: 'decorated', title: 'before' }, update: { $set: { title: 'after' } } }, { session });
      expect(changed.matchedCount).toBe(1);
      const rows = await instance.executeStorage('DecoratedStorageItem', { backend: 'mongodb', operation: 'find' }, { session, context: { tenant: 'decorated' } });
      expect(rows.map((row) => row.title)).toEqual(['after']);
      expect(base.executeStorage).toBe(storageDelegate);
      expect(decorated.executeStorage).toBe(storageDelegate);
      expect(policy).toHaveBeenCalledTimes(1);
      expect(policy.mock.calls[0][0]).toBe(session);
      expect(session.inTransaction()).toBe(true);
      await session.abortTransaction();
      expect(await Model.findById('decorated')).toBeNull();
    } finally { if (session.inTransaction()) await session.abortTransaction(); await session.endSession(); }
  });
  test('rejects inactive and foreign-client sessions before any operation', async () => {
    const inactive = await connection.startSession();
    await expect(runtime.execute(typeName, 'find', {}, { session: inactive })).rejects.toMatchObject({ extensions: { code: 'ACTIVE_TRANSACTION_REQUIRED' } });
    await inactive.endSession();
    other = await mongoose.createConnection(uri).asPromise();
    const foreign = await other.startSession(); foreign.startTransaction();
    await expect(runtime.execute(typeName, 'find', {}, { session: foreign })).rejects.toMatchObject({ extensions: { code: 'INVALID_SESSION' } });
    await foreign.abortTransaction(); await foreign.endSession();
  });
});

test('cursor observation charges empty physical batches and closes after a budget error', async () => {
  const cursor = { _initialize: vi.fn(async () => {}), getMore: vi.fn(async () => {}), readBufferedDocuments: () => [], close: vi.fn(async () => {}), async next() { await this._initialize(); await this.getMore(); await this.getMore(); return null; } };
  let count = 0;
  observeMongoCursor(cursor, { beforeFetch() { if (++count > 2) throw new Error('budget'); } });
  await expect(cursor.toArray()).rejects.toThrow('budget');
  expect(count).toBe(3); expect(cursor.getMore).toBeTypeOf('function'); expect(cursor.close).toBeTypeOf('function');
});

test('observer tracking failures cannot suppress native cursor cleanup', async () => {
  const close = vi.fn(async () => {});
  const cursor = { _initialize: vi.fn(), getMore: vi.fn(), readBufferedDocuments: () => [], next: vi.fn(async () => null), close };
  const failure = new Error('tracking failed');
  observeMongoCursor(cursor, { track() { throw failure; } });
  await expect(cursor.toArray()).rejects.toBe(failure);
  expect(close).toHaveBeenCalled();
  close.mockClear();
  await expect(cursor.close()).resolves.toBeUndefined();
  expect(close).toHaveBeenCalledTimes(1);
});

test('storage delegate rejects an adapter that has not been bound to a runtime', async () => {
  const adapter = createMongoAdapter();
  expect(adapter.executeStorage).toBeTypeOf('function');
  await expect(adapter.executeStorage()).rejects.toMatchObject({ message: 'MongoDB adapter must be bound to a runtime before storage operations', extensions: { code: 'ADAPTER_NOT_BOUND' } });
});
