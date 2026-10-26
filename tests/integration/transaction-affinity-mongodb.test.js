// Model affinity of the generated transaction field (#151, section 4.7) against a real replica set. The
// adapter's check decides on the connections of the models: useDb() databases of one client share a
// session and commit together; another client is refused before any session opens. Opt in with
// SIMFINITY_MONGODB_URI, a disposable replica set; every database the suite uses is dropped afterwards.
import { randomUUID } from 'node:crypto';
import {
  afterAll, beforeAll, describe, expect, test, vi,
} from 'vitest';
import mongoose from 'mongoose';
import {
  GraphQLID, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';
import { createMongoAdapter, createRuntime } from '../../packages/mongodb/src/index.js';

const uri = process.env.SIMFINITY_MONGODB_URI;
const withMongo = uri ? describe : describe.skip;
const base = `simfinity_lt_affinity_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const options = (dbName) => ({
  dbName, autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 5000,
});
const SOURCE = 'mutation Run($operations: [TransactionOperation!]!) { transaction(operations: $operations) { id } }';

withMongo('MongoDB transaction model affinity', () => {
  const connections = [];
  // Every database the suite writes, dropped by afterAll whether or not a test passed.
  const databases = [];
  let counter = 0;
  let bufferTimeoutMS;

  const open = async (dbName) => {
    const connection = await mongoose.createConnection(uri, options(dbName)).asPromise();
    connections.push(connection);
    databases.push(connection);
    return connection;
  };
  const useDb = (parent, name) => {
    const child = parent.useDb(`${base}_${name}`);
    databases.push(child);
    return child;
  };

  // A runtime in `mode` with a Shop stored through `shopConnection` and a Log through `logConnection`,
  // and the schema whose transaction field covers both.
  const fixture = (mode, shopConnection, logConnection) => {
    counter += 1;
    const adapter = createMongoAdapter({ referentialIntegrity: mode });
    const runtime = createRuntime(adapter);
    runtime.preventCreatingCollection(true);
    const Shop = new GraphQLObjectType({ name: `AffinityShop${counter}`, fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
    const Log = new GraphQLObjectType({ name: `AffinityLog${counter}`, fields: { id: { type: GraphQLID }, message: { type: GraphQLString } } });
    const modelOn = (connection, type, field) => connection.model(
      type.name, new mongoose.Schema({ [field]: String }, { autoCreate: false, autoIndex: false }), type.name,
    );
    const ShopModel = modelOn(shopConnection, Shop, 'name');
    const LogModel = modelOn(logConnection, Log, 'message');
    runtime.connect(ShopModel, Shop, `affinityshop${counter}`, `affinityshops${counter}`);
    runtime.connect(LogModel, Log, `affinitylog${counter}`, `affinitylogs${counter}`);
    const schema = runtime.createSchema(null, null, null, { transaction: { types: [Shop, Log] } });
    return {
      adapter, schema, ShopModel, LogModel, shop: `addaffinityshop${counter}`, log: `addaffinitylog${counter}`, updateLog: `updateaffinitylog${counter}`,
      run: (operations) => graphql({ schema, source: SOURCE, variableValues: { operations }, contextValue: {} }),
      create: async () => {
        await ShopModel.createCollection();
        await LogModel.createCollection();
      },
      counts: async () => [await ShopModel.countDocuments(), await LogModel.countDocuments()],
    };
  };

  beforeAll(() => {
    bufferTimeoutMS = mongoose.get('bufferTimeoutMS');
    // A request that waits for a connection that never opens fails fast.
    mongoose.set('bufferTimeoutMS', 5000);
  });

  afterAll(async () => {
    // A database of a connection that never opened has nothing to drop, and its drop would only wait.
    for (const database of databases) if (database.readyState === 1) await database.dropDatabase().catch(() => {});
    await Promise.all(connections.map((connection) => connection.close()));
    await mongoose.disconnect();
    mongoose.set('bufferTimeoutMS', bufferTimeoutMS);
  }, 30000);

  test('a transaction over two useDb databases of one client commits both writes', async () => {
    const shops = await open(base);
    const logs = useDb(shops, 'logs');
    const f = fixture('off', shops, logs);
    await f.create();
    const check = vi.spyOn(f.adapter, 'assertTransactionModels');

    const result = await f.run([{ [f.shop]: { name: 'kept' } }, { [f.log]: { message: 'written with it' } }]);

    expect(result.errors).toBeUndefined();
    expect(result.data.transaction).toHaveLength(2);
    expect(shops.getClient()).toBe(logs.getClient());
    expect(shops.db.databaseName).not.toBe(logs.db.databaseName);
    expect(check).toHaveBeenCalledOnce();
    expect(check.mock.results).toEqual([{ type: 'return', value: undefined }]);
    expect(await f.counts()).toEqual([1, 1]);
    expect(await f.ShopModel.findOne().lean()).toMatchObject({ name: 'kept' });
    expect(await f.LogModel.findOne().lean()).toMatchObject({ message: 'written with it' });
  }, 20000);

  test('a failure in the last operation rolls back the writes of both databases', async () => {
    const shops = await open(`${base}_rollback`);
    const logs = useDb(shops, 'rollback_logs');
    const f = fixture('off', shops, logs);
    await f.create();

    const result = await f.run([
      { [f.shop]: { name: 'rolled back' } },
      { [f.log]: { message: 'rolled back' } },
      { [f.updateLog]: { id: new mongoose.Types.ObjectId().toString(), message: 'missing' } },
    ]);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].extensions ?? result.errors[0].originalError?.extensions).toMatchObject({ code: 'NOT_VALID_ID' });
    expect(await f.counts()).toEqual([0, 0]);
  }, 20000);

  test('models on another client are refused before any session opens, naming the types and no address', async () => {
    const shops = await open(`${base}_clients`);
    const other = await open(`${base}_clients_other`);
    expect(shops.getClient()).not.toBe(other.getClient());
    const f = fixture('off', shops, other);
    await f.create();
    const check = vi.spyOn(f.adapter, 'assertTransactionModels');
    const transaction = vi.spyOn(f.adapter, 'withTransaction');
    const sessions = [shops, other].map((connection) => vi.spyOn(connection, 'startSession'));

    const result = await f.run([{ [f.shop]: { name: 'refused' } }, { [f.log]: { message: 'refused' } }]);

    expect(result.errors).toHaveLength(1);
    const [error] = result.errors;
    expect(error.originalError?.extensions ?? error.extensions).toMatchObject({ code: 'TRANSACTION_UNSUPPORTED', status: 500 });
    expect(error.message).toBe(`Types AffinityLog${counter}, AffinityShop${counter} cannot share one database transaction`);
    const serialized = JSON.stringify(result);
    for (const detail of [uri, new URL(uri).host, new URL(uri).port, '127.0.0.1']) expect(serialized).not.toContain(detail);
    expect(check).toHaveBeenCalledOnce();
    expect(transaction).not.toHaveBeenCalled();
    for (const session of sessions) expect(session).not.toHaveBeenCalled();
    expect(await f.counts()).toEqual([0, 0]);
  }, 20000);

  test('useDb databases of a default connection that is not open yet pass, and the transaction waits for the connection', async () => {
    expect(mongoose.connection.getClient()).toBeUndefined();
    const shops = useDb(mongoose.connection, 'default_shops');
    const logs = useDb(mongoose.connection, 'default_logs');
    const f = fixture('off', shops, logs);
    const check = f.adapter.assertTransactionModels;
    const clientsAtCheck = [];
    let connected;
    // The connection opens once the check has run, so that the check sees databases with no client.
    f.adapter.assertTransactionModels = function checkBeforeConnecting(models) {
      clientsAtCheck.push(...models.map((model) => model.db.getClient()));
      const result = check.call(this, models);
      connected = mongoose.connect(uri, options(`${base}_default`));
      return result;
    };

    const result = await f.run([{ [f.shop]: { name: 'waited' } }, { [f.log]: { message: 'waited' } }]);
    await connected;

    expect(clientsAtCheck).toEqual([undefined, undefined]);
    expect(result.errors).toBeUndefined();
    expect(result.data.transaction).toHaveLength(2);
    expect(shops.getClient()).toBe(mongoose.connection.getClient());
    expect(logs.getClient()).toBe(mongoose.connection.getClient());
    expect(await f.counts()).toEqual([1, 1]);
  }, 20000);

  test('referentialIntegrity transactional commits a transaction over two protected types of one connection', async () => {
    const connection = await open(`${base}_transactional`);
    const f = fixture('transactional', connection, connection);
    await f.create();
    await f.adapter.initialize();
    const check = vi.spyOn(f.adapter, 'assertTransactionModels');

    const result = await f.run([{ [f.shop]: { name: 'protected' } }, { [f.log]: { message: 'protected' } }]);

    expect(result.errors).toBeUndefined();
    expect(result.data.transaction).toHaveLength(2);
    expect(check).toHaveBeenCalledOnce();
    expect(await f.counts()).toEqual([1, 1]);
  }, 20000);
});
