import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import mongoose from 'mongoose';
import { GraphQLID, GraphQLInt, GraphQLObjectType, GraphQLString } from 'graphql';
import { createRuntime } from '../packages/core/src/index.js';
import { createMongoAdapter } from '../packages/mongodb/src/mongo/adapter.js';
import { observeMongoCursor } from '../packages/mongodb/src/mongo/cursor.js';

const uri = process.env.SIMFINITY_TEST_MONGODB_URI;
describe.skipIf(!uri)('registered data operations on MongoDB', () => {
  let connection, Model, runtime, other;
  const events = [], hooks = [];
  const typeName = 'RegisteredDataItem';
  beforeAll(async () => {
    connection = await mongoose.createConnection(uri, { dbName: 'simfinity_registered_data_tests' }).asPromise();
    Model = connection.model(typeName, new mongoose.Schema({ _id: String, tenant: String, title: String, version: Number, data: mongoose.Schema.Types.Mixed }, { versionKey: false }));
    await Model.deleteMany({});
    const type = new GraphQLObjectType({ name: typeName, fields: { id: { type: GraphQLID }, tenant: { type: GraphQLString }, title: { type: GraphQLString }, version: { type: GraphQLInt } },
      extensions: { scope: { find({ args, context }) { if (context?.tenant) args.tenant = { operator: 'EQ', value: context.tenant }; } } } });
    runtime = createRuntime(createMongoAdapter());
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
