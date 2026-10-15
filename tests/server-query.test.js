import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import mongoose from 'mongoose';
import { GraphQLID, GraphQLObjectType, GraphQLString } from 'graphql';
import { createRuntime, QLValue } from '../packages/core/src/index.js';
import { createMongoAdapter } from '../packages/mongodb/src/mongo/adapter.js';

const uri = process.env.SIMFINITY_TEST_MONGODB_URI;
describe.skipIf(!uri)('registered ordinary server queries', () => {
  let connection, Model, runtime;
  const events = [];
  const oid = new mongoose.Types.ObjectId('507f1f77bcf86cd799439011');
  const query = (filter = {}, extra = {}) => ({ dialect: 'mongodb', filter, window: { unbounded: true }, ...extra });
  const run = (filter, extra, options = {}) => runtime.execute('ServerItem', 'find', {}, { context: { tenant: 'one' }, query: query(filter, extra), ...options });
  beforeAll(async () => {
    connection = await mongoose.createConnection(uri, { dbName: 'simfinity_server_query_tests' }).asPromise();
    Model = connection.model('ServerItem', new mongoose.Schema({ _id: String, tenant: String, name: String, sort: String, data: mongoose.Schema.Types.Mixed, opaque: mongoose.Schema.Types.Mixed, hidden: String, computed: String }, { versionKey: false }));
    const type = new GraphQLObjectType({ name: 'ServerItem', fields: {
      id: { type: GraphQLID }, tenant: { type: GraphQLString }, name: { type: GraphQLString }, sort: { type: GraphQLString },
      data: { type: QLValue, extensions: { queryPaths: { dynamic: true } } }, opaque: { type: QLValue },
      hidden: { type: GraphQLString, extensions: { queryable: false } }, computed: { type: GraphQLString, resolve: () => 'computed' },
    }, extensions: { scope: { find({ args, context }) { args.tenant = { value: context.tenant }; if (context.pageScope) args.pagination = { page: 1, size: 1 }; } } } });
    const base = createMongoAdapter();
    runtime = createRuntime({ ...base, withTransaction: (...args) => base.withTransaction(...args), executeStorage() { throw new Error('Ordinary query used storage escape hatch'); } });
    runtime.preventCreatingCollection(true); runtime.connect(Model, type, 'serverItem', 'serverItems'); runtime.createSchema();
    runtime.use(async (params, next) => { events.push(params); if (params.context?.change) params.query = query(params.context.change); await next(); });
    await Model.deleteMany({});
    await Model.collection.insertMany([
      { _id: 'missing', tenant: 'one', name: 'A+B', sort: 'stored', data: {} },
      { _id: 'null', tenant: 'one', name: 'a+b', data: { v: null, list: [], links: [] } },
      { _id: 'empty', tenant: 'one', name: 'prefix A+B tail', data: { v: '', list: ['a', 'b'], file: { fileId: 'x', name: 'n' }, date: new Date('2026-01-01'), oid, links: [{ type: 'Wiki', id: 'wrong' }, { type: 'Other', id: 'x' }] } },
      { _id: 'array', tenant: 'one', name: 'A+B\n', data: { v: [], list: ['a'], file: { name: 'n', fileId: 'x' }, links: [{ type: 'Wiki', id: 'x' }], '507f1f77bcf86cd799439011': { amount: 10 }, amount: 5, currency: 'USD' } },
      { _id: 'other', tenant: 'two', name: 'A+B', data: { v: 1, links: [{ type: 'Wiki', id: 'x' }] } },
    ]);
  });
  afterAll(async () => { await connection?.dropDatabase(); await connection?.close(); });

  test('supported predicates preserve exact Mongo stored-value semantics', async () => {
    const filters = [
      {}, { 'data.v': null }, { 'data.v': { $exists: false } }, { 'data.v': { $ne: null } },
      { 'data.v': { $in: [null, ''] } }, { 'data.v': { $nin: [null, ''] } }, { 'data.v': { $in: [] } }, { 'data.v': { $nin: [] } },
      { 'data.list': { $all: ['a', 'b'] } }, { 'data.list': { $all: [] } }, { 'data.list': { $size: 0 } },
      { $or: [{ 'data.v': { $exists: false } }, { 'data.v': null }, { 'data.v': '' }, { 'data.v': { $size: 0 } }] },
      { $and: [{ 'data.v': { $exists: true } }, { 'data.v': { $nin: [null, ''] } }, { 'data.v': { $not: { $size: 0 } } }] },
      { 'data.file': { fileId: 'x', name: 'n' } }, { 'data.file': { $eq: { name: 'n', fileId: 'x' } } },
      { 'data.file': { $ne: { fileId: 'x', name: 'n' } } }, { 'data.list': ['a', 'b'] },
      { 'data.oid': oid }, { 'data.oid': oid.toHexString() }, { 'data.date': new Date('2026-01-01') }, { 'data.date': '2026-01-01' },
      { 'data.links': { $elemMatch: { type: 'Wiki', id: 'x' } } }, { 'data.links': { $elemMatch: {} } },
      { 'data.links': { $elemMatch: { $or: [{ type: 'Wiki' }, { type: { $exists: false }, kind: 'Wiki' }], id: 'x' } } },
      { 'data.list': { $elemMatch: { $eq: 'a', $ne: 'b' } } },
      { $nor: [{ 'data.currency': 'USD', 'data.amount': { $gte: 5, $lte: 7 } }] },
      { 'data.links.0': { $exists: true } }, { 'data.507f1f77bcf86cd799439011.amount': { $gt: 9 } },
      { name: { $regex: '^A\\+B$', $options: 'i' } }, { name: { $regex: '^A\\+B', $options: 'i' } }, { name: { $regex: 'A\\+B', $options: 'i' } },
      { name: { $regex: '^A\\+B' } }, { name: { $type: 'string' } }, { 'data.list': { $type: 'string' } },
      { sort: 'stored' }, { _id: { $in: ['missing', 'empty'] } },
    ];
    for (const filter of filters) {
      const expected = await Model.collection.find({ $and: [{ tenant: 'one' }, filter] }).sort({ _id: 1 }).toArray();
      const actual = await run(filter, { sort: { _id: 1 } });
      expect(actual.map((row) => row._id), JSON.stringify(filter)).toEqual(expected.map((row) => row._id));
    }
    const collation = { locale: 'en', strength: 2 };
    expect((await run({ name: 'a+b' }, {}, { readOptions: { collation } })).map((row) => row._id).sort()).toEqual(['missing', 'null']);
  });

  test('scope, middleware and input immutability are retained', async () => {
    const filter = Object.freeze({ $or: Object.freeze([{ tenant: 'two' }, { _id: 'missing' }]) });
    expect((await run(filter)).map((row) => row._id)).toEqual(['missing']);
    const changed = await run({}, {}, { context: { tenant: 'one', change: { _id: 'array' } } });
    expect(changed.map((row) => row._id)).toEqual(['array']);
    expect(events.at(-1).type.gqltype.name).toBe('ServerItem'); expect(events.at(-1).operation).toBe('find');
    expect(events.at(-1).query.filter).toEqual({ _id: 'array' });
    await expect(run({}, {}, { context: { tenant: 'one', change: { hidden: 'x' } } })).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN_FILTER_PATH' } });
    await expect(run({}, {}, { context: { tenant: 'one', pageScope: true } })).rejects.toMatchObject({ extensions: { code: 'INVALID_SCOPE' } });
  });

  test('rejects unsupported paths, syntax and values before database work', async () => {
    const aggregate = vi.spyOn(Model.collection, 'aggregate');
    const getter = {}; Object.defineProperty(getter, 'name', { enumerable: true, get() { throw Error('getter ran'); } });
    const cycle = {}; cycle.self = cycle;
    const filters = [{ unknown: 1 }, { 'opaque.x': 1 }, { 'name.x': 1 }, { hidden: 1 }, { computed: 1 },
      { 'data.__proto__.x': 1 }, { 'data.$x': 1 }, { 'data.__sf_l0': 1 }, { 'data..x': 1 },
      { $expr: { $eq: [1, 1] } }, { $where: 'true' }, { name: { $regex: 'a+' } }, { name: { $regex: 'a', $options: 'm' } },
      { name: { $options: 'i' } }, { name: { $type: 'javascript' } }, { name: undefined }, { name: NaN },
      { name: { $exists: 1 } }, { name: { $size: -1 } }, { name: { $in: [undefined] } },
      { data: cycle }, { data: { fn() {} } }, getter, { $and: [] }, { name: { $eq: { $where: 'true' } } },
    ];
    try {
      for (const filter of filters) await expect(run(filter)).rejects.toBeInstanceOf(Error);
      for (const extra of [{ window: undefined }, { window: { limit: 0 } }, { projection: { unknown: 1 } }, { projection: { name: 1, data: 0 } }, { sort: { unknown: 1 } }, { sort: { name: 2 } }]) await expect(run({}, extra)).rejects.toBeInstanceOf(Error);
      await expect(run({}, {}, { readOptions: { session: {} } })).rejects.toThrow();
      await expect(runtime.execute('ServerItem', 'find', { name: { value: 'a' } }, { query: query() })).rejects.toThrow();
      expect(aggregate).not.toHaveBeenCalled();
    } finally { aggregate.mockRestore(); }
  });

  test('rejects polymorphic query arrays without calling custom behavior or Mongo', async () => {
    const invoked = vi.fn();
    class InjectedArray extends Array {
      map() { invoked(); return [{ kind: 'field', path: '$expr', terms: [{ operator: '$eq', value: [1, 1] }] }]; }
    }
    const accessor = ['missing']; Object.defineProperty(accessor, 'map', { get() { invoked(); return Array.prototype.map; } });
    const sparse = Array(1);
    const proxy = new Proxy(['missing'], { getPrototypeOf() { invoked(); return Array.prototype; }, get() { invoked(); return 1; } });
    const element = ['missing']; Object.defineProperty(element, '0', { get() { invoked(); return 'missing'; } });
    const aggregate = vi.spyOn(Model.collection, 'aggregate');
    try {
      for (const filter of [{ $and: new InjectedArray({ name: 'safe' }) }, { _id: { $in: new InjectedArray('missing') } }, { _id: { $in: accessor } }, { _id: { $in: sparse } }, { _id: { $in: element } }, { _id: { $in: proxy } }, { $and: proxy }]) {
        await expect(run(filter)).rejects.toMatchObject({ extensions: { code: 'INVALID_FILTER_VALUE' } });
      }
      expect(invoked).not.toHaveBeenCalled(); expect(aggregate).not.toHaveBeenCalled();
    } finally { aggregate.mockRestore(); }
    expect((await run({ $and: [{ _id: { $in: Object.freeze(['missing']) } }] })).map((row) => row._id)).toEqual(['missing']);
  });

  test('rejects special literal overrides without invoking them and preserves ordinary BSON literals', async () => {
    const invoked = vi.fn(() => { throw Error('custom literal behavior invoked'); });
    const date = new Date('2026-01-01'); Object.defineProperty(date, 'getTime', { get: invoked });
    const id = new mongoose.Types.ObjectId(); Object.defineProperty(id, 'toHexString', { get: invoked });
    const idBuffer = new mongoose.Types.ObjectId(); Object.defineProperty(idBuffer, 'buffer', { get: invoked });
    const binary = Buffer.from([1, 2]); Object.defineProperty(binary, 'length', { get: invoked });
    const method = new mongoose.Types.ObjectId(); method.toHexString = invoked;
    const idBytes = new mongoose.Types.ObjectId(); Object.defineProperty(idBytes.buffer, 'valueOf', { get: invoked });
    const binaryMethod = Buffer.from([1, 2]); binaryMethod[Symbol.iterator] = invoked;
    class CustomDate extends Date { getTime() { return invoked(); } }
    const proxy = new Proxy(new Date(), { getPrototypeOf: invoked });
    const aggregate = vi.spyOn(Model.collection, 'aggregate');
    try {
      for (const value of [date, id, idBuffer, idBytes, binary, binaryMethod, method, new CustomDate(), proxy]) {
        await expect(run({ 'data.value': value })).rejects.toMatchObject({ extensions: { code: 'INVALID_FILTER_VALUE' } });
      }
      expect(invoked).not.toHaveBeenCalled(); expect(aggregate).not.toHaveBeenCalled();
    } finally { aggregate.mockRestore(); }
    await Model.collection.insertOne({ _id: 'literal-control', tenant: 'one', data: { date: new Date('2026-01-01'), oid, binary: Buffer.from([1, 2]) } });
    try {
      expect((await run({ _id: 'literal-control', 'data.date': new Date('2026-01-01'), 'data.oid': new mongoose.Types.ObjectId(oid.buffer), 'data.binary': Buffer.from([1, 2]) })).map((row) => row._id)).toEqual(['literal-control']);
    } finally { await Model.collection.deleteOne({ _id: 'literal-control' }); }
  });

  test('rejects embedded NUL regex before Mongo but permits ordinary NUL string equality', async () => {
    const aggregate = vi.spyOn(Model.collection, 'aggregate');
    try {
      await expect(run({ name: { $regex: 'A\0B' } })).rejects.toMatchObject({ extensions: { code: 'INVALID_FILTER_VALUE' } });
      expect(aggregate).not.toHaveBeenCalled();
    } finally { aggregate.mockRestore(); }
    await Model.collection.insertOne({ _id: 'nul-control', tenant: 'one', name: 'A\0B' });
    try { expect((await run({ name: 'A\0B' })).map((row) => row._id)).toEqual(['nul-control']); }
    finally { await Model.collection.deleteOne({ _id: 'nul-control' }); }
  });

  test('$size rejects values outside signed int32 before physical access and accepts both bounds', async () => {
    const aggregate = vi.spyOn(Model.collection, 'aggregate');
    try {
      for (const value of [2147483648, Number.MAX_SAFE_INTEGER, -1, 0.5]) {
        await expect(run({ 'data.list': { $size: value } })).rejects.toMatchObject({ extensions: { code: 'INVALID_FILTER_VALUE' } });
      }
      expect(aggregate).not.toHaveBeenCalled();
      expect((await run({ 'data.list': { $size: 0 } })).map((row) => row._id)).toEqual(['null']);
      expect(await run({ 'data.list': { $size: 2147483647 } })).toEqual([]);
      expect(aggregate).toHaveBeenCalledTimes(2);
    } finally { aggregate.mockRestore(); }
  });

  test('complete compiled paging, projection, count and a single observed stream exceed 100 rows', async () => {
    await Model.insertMany(Array.from({ length: 201 }, (_, i) => ({ _id: 'page-' + String(i).padStart(3, '0'), tenant: 'one', name: 'page' })));
    const filter = { name: 'page' };
    expect(await run(filter, { window: { limit: 200 } })).toHaveLength(200);
    expect(await run({ _id: 'page-200' })).toHaveLength(1);
    expect(await run(filter, { sort: { _id: -1 }, window: { skip: 1, limit: 2 }, projection: { _id: 1 } })).toEqual([{ _id: 'page-199' }, { _id: 'page-198' }]);
    expect(await runtime.execute('ServerItem', 'count', {}, { context: { tenant: 'one' }, query: { dialect: 'mongodb', filter } })).toBe(201);
    const observer = { beforeFetch: vi.fn(), onRows: vi.fn() };
    const aggregate = vi.spyOn(Model.collection, 'aggregate');
    try {
      const cursor = await runtime.execute('ServerItem', 'stream', {}, { context: { tenant: 'one' }, query: query(filter, { sort: { _id: 1 }, projection: { _id: 1 } }), observer, readOptions: { batchSize: 13, maxTimeMS: 5000, timeoutMS: 5000 } });
      const rows = []; for await (const row of cursor) rows.push(row);
      expect(rows).toHaveLength(201); expect(rows.at(-1)).toEqual({ _id: 'page-200' });
      expect(aggregate).toHaveBeenCalledTimes(1); expect(observer.beforeFetch.mock.calls.length).toBeGreaterThan(1);
      expect(observer.onRows.mock.calls.flatMap(([batch]) => batch)).toHaveLength(201);
    } finally { aggregate.mockRestore(); }
  });

  test('adopted sessions and observer failures preserve caller ownership and cleanup', async () => {
    const session = await connection.startSession(); session.startTransaction();
    try {
      await Model.create([{ _id: 'session', tenant: 'one', name: 'pending' }], { session });
      expect(await run({ _id: 'session' }, {}, { session })).toHaveLength(1);
      expect(await run({ _id: 'session' })).toHaveLength(0);
      const cursor = await runtime.execute('ServerItem', 'stream', {}, { context: { tenant: 'one' }, session, query: query(), observer: { onRows() { throw Error('budget'); } } });
      await expect(cursor.toArray()).rejects.toThrow('budget'); expect(cursor.closed).toBe(true);
      expect(session.inTransaction()).toBe(true);
      await session.abortTransaction(); expect(await run({ _id: 'session' })).toHaveLength(0);
      await expect(run({}, {}, { session })).rejects.toMatchObject({ extensions: { code: 'ACTIVE_TRANSACTION_REQUIRED' } });
    } finally { if (session.inTransaction()) await session.abortTransaction(); await session.endSession(); }
  });

  test('page selects items and total together before paging in one command', async () => {
    const aggregate = vi.spyOn(Model.collection, 'aggregate');
    const onRows = vi.fn();
    try {
      const result = await runtime.execute('ServerItem', 'page', {}, { context: { tenant: 'one' }, query: query({ name: 'page' }, { sort: { _id: -1 }, window: { skip: 199, limit: 5 }, projection: { _id: 1 } }), observer: { onRows } });
      expect(result).toEqual({ items: [{ _id: 'page-001' }, { _id: 'page-000' }], totalCount: 201 });
      expect(aggregate).toHaveBeenCalledTimes(1);
      expect(onRows.mock.calls[0][0][0].items).toHaveLength(2);
      const empty = await runtime.execute('ServerItem', 'page', {}, { context: { tenant: 'one' }, query: query({ tenant: 'two' }, { window: { limit: 10 } }) });
      expect(empty).toEqual({ items: [], totalCount: 0 });
      await expect(runtime.execute('ServerItem', 'page', {}, { context: { tenant: 'one' }, query: query() })).rejects.toMatchObject({ extensions: { code: 'INVALID_PAGINATION' } });
    } finally { aggregate.mockRestore(); }
  });

  test('bounded membership supports 50001 authorized candidates independently of logical complexity', async () => {
    const ids = Array.from({ length: 50000 }, (_, index) => 'absent-' + index);
    ids.push('page-200');
    expect((await run({ _id: { $in: ids } })).map((row) => row._id)).toEqual(['page-200']);
    await expect(run({ _id: { $in: Array(100001).fill('absent') } })).rejects.toMatchObject({ extensions: { code: 'FILTER_DEPTH_EXCEEDED' } });
  });

  test('declared storage, embedded fields and reference aliases do not grant dynamic or related traversal', async () => {
    const Target = new GraphQLObjectType({ name: 'ServerTarget', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
    const Embedded = new GraphQLObjectType({ name: 'ServerEmbedded', fields: { name: { type: GraphQLString }, secret: { type: GraphQLString, extensions: { queryable: false } } } });
    const Type = new GraphQLObjectType({ name: 'ServerPaths', fields: { id: { type: GraphQLID },
      embedded: { type: Embedded, extensions: { relation: { embedded: true } } },
      related: { type: Target, extensions: { relation: { connectionField: 'related_id' } } },
      badDynamic: { type: GraphQLString, extensions: { queryPaths: { dynamic: true } } },
      ghost: { type: GraphQLString, extensions: { queryable: true } },
    } });
    const model = connection.model('ServerPaths', new mongoose.Schema({ _id: String, embedded: { name: String, secret: String }, related_id: String, badDynamic: String }));
    const target = connection.model('ServerTarget', new mongoose.Schema({ _id: String, name: String }));
    const instance = createRuntime(createMongoAdapter()); instance.preventCreatingCollection(true);
    instance.addNoEndpointType(Embedded); instance.connect(target, Target, 'serverTarget', 'serverTargets'); instance.connect(model, Type, 'serverPaths', 'serverPathsList'); instance.createSchema();
    await model.create({ _id: 'owned', embedded: { name: 'local' }, related_id: 'target' });
    const read = (filter) => instance.execute('ServerPaths', 'find', {}, { query: query(filter) });
    expect(await read({ 'embedded.name': 'local', related_id: 'target' })).toHaveLength(1);
    expect(await read({ embedded: { name: 'local' } })).toHaveLength(1);
    for (const filter of [{ 'related.name': 'target' }, { 'embedded.secret': 'x' }, { embedded: { secret: 'x' } }, { embedded: { unknown: 'x' } }, { 'embedded.unknown': 'x' }, { 'badDynamic.x': 'x' }, { ghost: 'x' }]) await expect(read(filter)).rejects.toBeInstanceOf(Error);
  });

  test('normal hooks run and observed hook bypass rejects', async () => {
    const hook = vi.fn(); const schema = new mongoose.Schema({ _id: String, name: String }); schema.pre('aggregate', function () { hook(); });
    const model = connection.model('ServerHook', schema);
    const type = new GraphQLObjectType({ name: 'ServerHook', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
    const instance = createRuntime(createMongoAdapter()); instance.preventCreatingCollection(true); instance.connect(model, type, 'serverHook', 'serverHooks'); instance.createSchema();
    await instance.execute('ServerHook', 'find', {}, { query: query() }); expect(hook).toHaveBeenCalledTimes(1);
    await expect(instance.execute('ServerHook', 'stream', {}, { query: query() })).rejects.toMatchObject({ extensions: { code: 'UNSUPPORTED_CAPABILITY' } });
    expect(hook).toHaveBeenCalledTimes(1);
    const base = createMongoAdapter();
    const unsupported = createRuntime({ ...base, compileServerQuery: undefined }); unsupported.preventCreatingCollection(true);
    const Unsupported = new GraphQLObjectType({ name: 'ServerUnsupported', fields: { id: { type: GraphQLID } } });
    unsupported.connect(Model, Unsupported, 'serverUnsupported', 'serverUnsupporteds'); unsupported.createSchema();
    await expect(unsupported.execute('ServerUnsupported', 'find', {}, { query: query() })).rejects.toMatchObject({ extensions: { code: 'UNSUPPORTED_CAPABILITY' } });
  });
});
