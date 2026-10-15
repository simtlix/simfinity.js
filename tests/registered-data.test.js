import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  GraphQLFloat,
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLObjectType,
  GraphQLString,
} from 'graphql';
import { createRuntime } from '../packages/core/src/index.js';
import { createMongoAdapter } from '../packages/mongodb/src/mongo/adapter.js';
import { observeMongoCursor } from '../packages/mongodb/src/mongo/cursor.js';

const uri = process.env.SIMFINITY_TEST_MONGODB_URI;
describe.skipIf(!uri)('registered data operations on MongoDB', () => {
  let connection, Model, runtime, other, transaction;
  const events = [],
    hooks = [];
  const typeName = 'RegisteredDataItem';
  beforeAll(async () => {
    connection = await mongoose
      .createConnection(uri, { dbName: 'simfinity_registered_data_tests' })
      .asPromise();
    Model = connection.model(
      typeName,
      new mongoose.Schema(
        {
          _id: String,
          tenant: String,
          title: String,
          version: Number,
          ratio: Number,
          data: mongoose.Schema.Types.Mixed,
        },
        { versionKey: false },
      ),
    );
    await Model.deleteMany({});
    const type = new GraphQLObjectType({
      name: typeName,
      fields: {
        id: { type: GraphQLID },
        tenant: { type: GraphQLString },
        title: { type: GraphQLString },
        version: { type: GraphQLInt },
        ratio: { type: GraphQLFloat },
      },
      extensions: {
        scope: {
          find({ args, context }) {
            if (context?.tenant) args.tenant = { operator: 'EQ', value: context.tenant };
            if (context?.pageScope) args.pagination = { page: 1, size: 1 };
          },
        },
      },
    });
    const adapter = createMongoAdapter();
    transaction = vi.fn((...args) => adapter.withTransaction(...args));
    runtime = createRuntime({ ...adapter, withTransaction: transaction });
    runtime.preventCreatingCollection(true);
    runtime.connect(Model, type, 'registeredDataItem', 'registeredDataItems', {
      onSaving() {
        hooks.push('save');
      },
      onUpdating() {
        hooks.push('update');
      },
    });
    runtime.use(async ({ type: registered, operation }, next) => {
      events.push([registered.gqltype.name, operation]);
      await next();
    });
    runtime.createSchema();
  });
  beforeEach(async () => {
    await Model.deleteMany({});
    await Model.insertMany([
      { _id: 'a', tenant: 'one', title: 'A', version: 1 },
      { _id: 'b', tenant: 'two', title: 'B', version: 2 },
      { _id: 'c', tenant: 'one', title: 'C', version: 3 },
    ]);
    events.length = 0;
    hooks.length = 0;
    transaction.mockClear();
  });
  afterAll(async () => {
    await connection?.dropDatabase();
    await connection?.close();
    await other?.close();
  });
  test('generated lifecycle preserves scalar identity, null, same-session rollback and CAS', async () => {
    const session = await connection.startSession();
    session.startTransaction();
    const result = await runtime.execute(
      typeName,
      'save',
      { input: { tenant: 'one', title: null, version: 1 } },
      { session, storage: { id: 'string-key', nulls: 'preserve' } },
    );
    expect(result._id).toBe('string-key');
    expect(result.title).toBeNull();
    expect(await Model.findById('string-key')).toBeNull();
    const changed = await runtime.execute(
      typeName,
      'update',
      { input: { id: 'string-key', title: null } },
      {
        session,
        storage: {
          filter: { tenant: 'one', version: 1 },
          increments: { version: 1 },
          nulls: 'preserve',
        },
      },
    );
    expect(changed.version).toBe(2);
    expect(changed.title).toBeNull();
    await expect(
      runtime.execute(
        typeName,
        'update',
        { input: { id: 'string-key', title: 'wrong' } },
        { session, storage: { filter: { version: 1 } } },
      ),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_VALID_ID' } });
    expect(
      await runtime.execute(
        typeName,
        'delete',
        { id: 'string-key' },
        { session, storage: { filter: { version: 1 } } },
      ),
    ).toBeNull();
    await session.abortTransaction();
    await session.endSession();
    expect(await Model.findById('string-key')).toBeNull();
    expect(hooks).toEqual(expect.arrayContaining(['save', 'update']));
  });
  test.each(['update', 'delete'])(
    'malformed conditional filters reject before %s transactions, controllers or writes',
    async (operation) => {
      const id = 'invalid-filter-' + operation;
      await Model.create({ _id: id, tenant: 'one', title: 'before', version: 1 });
      transaction.mockClear();
      const hookCount = hooks.length;
      const update = vi.spyOn(Model.collection, 'findOneAndUpdate');
      const remove = vi.spyOn(Model.collection, 'findOneAndDelete');
      try {
        for (const filter of [
          null,
          false,
          0,
          '',
          true,
          1,
          'version',
          NaN,
          1n,
          Symbol('filter'),
          () => ({}),
          [],
        ]) {
          const args = operation === 'update' ? { input: { id, title: 'after' } } : { id };
          await expect(
            runtime.execute(typeName, operation, args, { storage: { filter } }),
          ).rejects.toMatchObject({ extensions: { code: 'INVALID_STORAGE_OPERATION' } });
        }
        expect(transaction).not.toHaveBeenCalled();
        expect(hooks).toHaveLength(hookCount);
        expect(update).not.toHaveBeenCalled();
        expect(remove).not.toHaveBeenCalled();
        expect(await Model.collection.findOne({ _id: id })).toMatchObject({
          title: 'before',
          version: 1,
        });
      } finally {
        update.mockRestore();
        remove.mockRestore();
        await Model.deleteOne({ _id: id });
      }
    },
  );
  test('conditional writes preserve omitted and undefined filters, empty predicates and full CAS', async () => {
    for (const storage of [{}, { filter: undefined }, { filter: {} }]) {
      await Model.create({ _id: 'filter-control', title: 'before', version: 1 });
      try {
        expect(
          (
            await runtime.execute(
              typeName,
              'update',
              { input: { id: 'filter-control', title: 'after' } },
              { storage },
            )
          ).title,
        ).toBe('after');
        expect(
          (await runtime.execute(typeName, 'delete', { id: 'filter-control' }, { storage }))._id,
        ).toBe('filter-control');
      } finally {
        await Model.deleteOne({ _id: 'filter-control' });
      }
    }
    await Model.create({ _id: 'filter-control', tenant: 'one', title: 'before', version: 1 });
    try {
      const args = { input: { id: 'filter-control', title: 'after' } };
      await expect(
        runtime.execute(typeName, 'update', args, {
          storage: { filter: { tenant: 'other', version: 1 } },
        }),
      ).rejects.toMatchObject({ extensions: { code: 'NOT_VALID_ID' } });
      expect(
        await runtime.execute(
          typeName,
          'delete',
          { id: 'filter-control' },
          { storage: { filter: { tenant: 'one', version: 2 } } },
        ),
      ).toBeNull();
      expect(
        (
          await runtime.execute(typeName, 'update', args, {
            storage: { filter: { tenant: 'one', version: 1 }, increments: { version: 1 } },
          })
        ).version,
      ).toBe(2);
      expect(
        (
          await runtime.execute(
            typeName,
            'delete',
            { id: 'filter-control' },
            { storage: { filter: { tenant: 'one', version: 2 } } },
          )
        )._id,
      ).toBe('filter-control');
    } finally {
      await Model.deleteOne({ _id: 'filter-control' });
    }
  });
  test('generated queries retain scope and observed by-ID reads', async () => {
    const context = { tenant: 'one' };
    const rows = await runtime.execute(
      typeName,
      'find',
      { version: { operator: 'GTE', value: 1 } },
      { context },
    );
    expect(rows.map((row) => row._id).sort()).toEqual(['a', 'c']);
    expect(await runtime.execute(typeName, 'count', {}, { context })).toBe(2);
    const detailObserver = { beforeFetch: vi.fn(), onRows: vi.fn() };
    expect(
      (
        await runtime.execute(
          typeName,
          'get_by_id',
          { id: 'a' },
          { observer: detailObserver, readOptions: { maxTimeMS: 1000, timeoutMS: 1000 } },
        )
      )._id,
    ).toBe('a');
    expect(detailObserver.beforeFetch).toHaveBeenCalledTimes(1);
    expect(detailObserver.onRows).toHaveBeenCalledTimes(1);
  });
  test('preserve null retains embedded nullable lists while legacy update retains empty-list semantics', async () => {
    const Embedded = new GraphQLObjectType({
      name: 'DataNullEmbedded',
      fields: { tags: { type: new GraphQLList(GraphQLString) } },
    });
    const Type = new GraphQLObjectType({
      name: 'DataNullOwner',
      fields: {
        id: { type: GraphQLID },
        settings: { type: Embedded, extensions: { relation: { embedded: true } } },
      },
    });
    const Owner = connection.model(
      'DataNullOwner',
      new mongoose.Schema({ _id: String, settings: { tags: [String] } }, { versionKey: false }),
    );
    const instance = createRuntime(createMongoAdapter());
    instance.preventCreatingCollection(true);
    instance.addNoEndpointType(Embedded);
    instance.connect(Owner, Type, 'nullOwner', 'nullOwners');
    instance.createSchema();
    await instance.execute(
      'DataNullOwner',
      'save',
      { input: { settings: { tags: ['before'] } } },
      { storage: { id: 'one', nulls: 'preserve' } },
    );
    await instance.execute(
      'DataNullOwner',
      'update',
      { input: { id: 'one', settings: { tags: null } } },
      { storage: { nulls: 'preserve' } },
    );
    expect((await Owner.collection.findOne({ _id: 'one' })).settings.tags).toBeNull();
    await instance.execute('DataNullOwner', 'update', {
      input: { id: 'one', settings: { tags: null } },
    });
    expect((await Owner.collection.findOne({ _id: 'one' })).settings.tags).toEqual([]);
  });
  test('integer increments reject fractional deltas and cannot commit out-of-range results in an adopted transaction', async () => {
    await Model.create({ _id: 'integer', tenant: 'one', version: 1, ratio: 1 });
    await expect(
      runtime.execute(
        typeName,
        'update',
        { input: { id: 'integer' } },
        { storage: { increments: { version: 0.5 } } },
      ),
    ).rejects.toThrow();
    expect((await Model.findById('integer')).version).toBe(1);
    const fractional = await runtime.execute(
      typeName,
      'update',
      { input: { id: 'integer' } },
      { storage: { increments: { ratio: 0.5 } } },
    );
    expect(fractional.ratio).toBe(1.5);
    await Model.updateOne({ _id: 'integer' }, { $set: { ratio: Number.MAX_VALUE } });
    await expect(
      runtime.execute(
        typeName,
        'update',
        { input: { id: 'integer' } },
        { storage: { increments: { ratio: 1e308 } } },
      ),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_VALID_ID' } });
    expect((await Model.findById('integer')).ratio).toBe(Number.MAX_VALUE);
    await expect(
      runtime.execute(
        typeName,
        'update',
        { input: { id: 'integer' } },
        { storage: { increments: { version: 2147483648 } } },
      ),
    ).rejects.toThrow();
    await Model.updateOne({ _id: 'integer' }, { $set: { version: 1.5 } });
    await expect(
      runtime.execute(
        typeName,
        'update',
        { input: { id: 'integer' } },
        { storage: { increments: { version: 1 } } },
      ),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_VALID_ID' } });
    expect((await Model.findById('integer')).version).toBe(1.5);
    await Model.updateOne({ _id: 'integer' }, { $set: { version: -2147483648 } });
    await expect(
      runtime.execute(
        typeName,
        'update',
        { input: { id: 'integer' } },
        { storage: { increments: { version: -1 } } },
      ),
    ).rejects.toMatchObject({ extensions: { code: 'NOT_VALID_ID' } });
    expect((await Model.findById('integer')).version).toBe(-2147483648);
    await Model.updateOne({ _id: 'integer' }, { $set: { version: 2147483647 } });
    const session = await connection.startSession();
    session.startTransaction();
    try {
      await expect(
        runtime.execute(
          typeName,
          'update',
          { input: { id: 'integer' } },
          { session, storage: { increments: { version: 1 } } },
        ),
      ).rejects.toThrow();
      await session.commitTransaction();
      expect((await Model.findById('integer')).version).toBe(2147483647);
    } finally {
      if (session.inTransaction()) await session.abortTransaction();
      await session.endSession();
    }
  });
  test('Float increments atomically reject rounded overflow while retaining missing-field and CAS semantics', async () => {
    const delta = 1.5 * 2 ** 971;
    const old = Number.MAX_VALUE - delta;
    expect(Number.isFinite(old)).toBe(true);
    expect(old + delta).toBe(Infinity);
    await Model.insertMany([
      { _id: 'float-positive', ratio: old },
      { _id: 'float-negative', ratio: -old },
      { _id: 'float-missing', version: 1 },
    ]);
    await Model.collection.insertMany([
      { _id: 'float-string', ratio: 'invalid' },
      { _id: 'float-null', ratio: null },
    ]);
    const session = await connection.startSession();
    session.startTransaction();
    try {
      for (const [id, amount] of [
        ['float-positive', delta],
        ['float-negative', -delta],
        ['float-string', 1],
        ['float-null', 1],
      ]) {
        await expect(
          runtime.execute(
            typeName,
            'update',
            { input: { id } },
            { session, storage: { increments: { ratio: amount } } },
          ),
        ).rejects.toMatchObject({ extensions: { code: 'NOT_VALID_ID' } });
        expect(session.inTransaction()).toBe(true);
      }
      await expect(
        runtime.execute(
          typeName,
          'update',
          { input: { id: 'float-missing' } },
          { session, storage: { filter: { version: 0 }, increments: { ratio: 0.5 } } },
        ),
      ).rejects.toMatchObject({ extensions: { code: 'NOT_VALID_ID' } });
      const changed = await runtime.execute(
        typeName,
        'update',
        { input: { id: 'float-missing' } },
        { session, storage: { filter: { version: 1 }, increments: { ratio: 0.5 } } },
      );
      expect(changed.ratio).toBe(0.5);
      await session.commitTransaction();
      expect((await Model.collection.findOne({ _id: 'float-positive' })).ratio).toBe(old);
      expect((await Model.collection.findOne({ _id: 'float-negative' })).ratio).toBe(-old);
      expect((await Model.collection.findOne({ _id: 'float-string' })).ratio).toBe('invalid');
      expect((await Model.collection.findOne({ _id: 'float-null' })).ratio).toBeNull();
      expect((await Model.findById('float-missing')).ratio).toBe(0.5);
    } finally {
      if (session.inTransaction()) await session.abortTransaction();
      await session.endSession();
    }
  });
  test('rejects inactive and foreign-client sessions before any operation', async () => {
    const inactive = await connection.startSession();
    await expect(
      runtime.execute(typeName, 'find', {}, { session: inactive }),
    ).rejects.toMatchObject({ extensions: { code: 'ACTIVE_TRANSACTION_REQUIRED' } });
    await inactive.endSession();
    other = await mongoose.createConnection(uri).asPromise();
    const foreign = await other.startSession();
    foreign.startTransaction();
    await expect(runtime.execute(typeName, 'find', {}, { session: foreign })).rejects.toMatchObject(
      { extensions: { code: 'INVALID_SESSION' } },
    );
    await foreign.abortTransaction();
    await foreign.endSession();
  });
});

test('cursor observation charges empty physical batches and closes after a budget error', async () => {
  const cursor = {
    _initialize: vi.fn(async () => {}),
    getMore: vi.fn(async () => {}),
    readBufferedDocuments: () => [],
    close: vi.fn(async () => {}),
    async next() {
      await this._initialize();
      await this.getMore();
      await this.getMore();
      return null;
    },
  };
  let count = 0;
  observeMongoCursor(cursor, {
    beforeFetch() {
      if (++count > 2) throw new Error('budget');
    },
  });
  await expect(cursor.toArray()).rejects.toThrow('budget');
  expect(count).toBe(3);
  expect(cursor.getMore).toBeTypeOf('function');
  expect(cursor.close).toBeTypeOf('function');
});

test('observer tracking failures cannot suppress native cursor cleanup', async () => {
  const close = vi.fn(async () => {});
  const cursor = {
    _initialize: vi.fn(),
    getMore: vi.fn(),
    readBufferedDocuments: () => [],
    next: vi.fn(async () => null),
    close,
  };
  const failure = new Error('tracking failed');
  observeMongoCursor(cursor, {
    track() {
      throw failure;
    },
  });
  await expect(cursor.toArray()).rejects.toBe(failure);
  expect(close).toHaveBeenCalled();
  close.mockClear();
  await expect(cursor.close()).resolves.toBeUndefined();
  expect(close).toHaveBeenCalledTimes(1);
});

test.each([new Error('read failed'), undefined])(
  'cursor cleanup preserves the original rejection: %s',
  async (reason) => {
    const cleanupError = new Error('close failed');
    const close = vi.fn(async () => {
      throw cleanupError;
    });
    const cursor = {
      _initialize: vi.fn(),
      getMore: vi.fn(),
      readBufferedDocuments: () => [],
      next: vi.fn(async () => {
        throw reason;
      }),
      close,
    };
    observeMongoCursor(cursor, {});
    await expect(cursor.toArray()).rejects.toBe(reason);
    expect(close).toHaveBeenCalled();
  },
);

test('cursor cleanup propagates close failure after a successful read', async () => {
  const failure = new Error('close failed');
  const cursor = {
    _initialize: vi.fn(),
    getMore: vi.fn(),
    readBufferedDocuments: () => [],
    next: vi.fn(async () => null),
    close: vi.fn(async () => {
      throw failure;
    }),
  };
  observeMongoCursor(cursor, {});
  await expect(cursor.toArray()).rejects.toBe(failure);
});

test('early iterator return closes the cursor without consuming another batch', async () => {
  const next = vi.fn(async () => ({ id: 'first' }));
  const close = vi.fn(async () => {});
  const cursor = {
    _initialize: vi.fn(),
    getMore: vi.fn(),
    readBufferedDocuments: () => [],
    next,
    close,
  };
  observeMongoCursor(cursor, {});
  for await (const row of cursor) {
    expect(row.id).toBe('first');
    break;
  }
  expect(next).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalledTimes(1);
});
