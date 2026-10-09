import {
  afterAll, beforeAll, describe, expect, test,
} from 'vitest';
import mongoose from 'mongoose';
import {
  GraphQLID, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';
import { createMongoAdapter, createRuntime } from '../../packages/mongodb/src/index.js';

// Opt in with a disposable replica-set URI. Custom mutations in the default referentialIntegrity
// 'off' mode, while the default mongoose.connection has never been opened. Only the last test
// opens it, on purpose. afterAll drops every database this file uses, useDb children included,
// whether or not the tests passed.
const uri = process.env.SIMFINITY_MONGODB_URI;
const dbName = `simfinity_custom_session_${process.pid}`;
const connectionOptions = {
  dbName, autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 5000,
};
const clients = [];
const databases = [];

const openConnection = async () => {
  const connection = await mongoose.createConnection(uri, connectionOptions).asPromise();
  clients.push(connection);
  databases.push(connection);
  return connection;
};

const useDb = (connection, name) => {
  const child = connection.useDb(name);
  databases.push(child);
  return child;
};

const idTitle = (name) => new GraphQLObjectType({
  name, fields: { id: { type: GraphQLID }, title: { type: GraphQLString } },
});

let counter = 0;

// Two supplied types and a custom mutation that saves one record of each with its session.
const importFixture = async (connectionFor) => {
  counter += 1;
  const prefix = `CustomSession${counter}`;
  const types = [idTitle(`${prefix}Book`), idTitle(`${prefix}Note`)];
  const models = await Promise.all(types.map(async (type, index) => {
    const connection = await connectionFor(index === 0 ? 'book' : 'note');
    const Model = connection.model(type.name, new mongoose.Schema({ title: String }), type.name);
    await Model.createCollection();
    return Model;
  }));
  const runtime = createRuntime(createMongoAdapter());
  runtime.preventCreatingCollection(true);
  types.forEach((type, index) => runtime.connect(models[index], type, type.name.toLowerCase(), `${type.name.toLowerCase()}s`));
  const mutation = `${prefix}Import`;
  runtime.registerMutation(mutation, 'Saves a book and a note', null, GraphQLString, async (_input, session, context) => {
    for (const type of types) await runtime.saveObject(type.name, { title: 'imported' }, session, context);
    if (context.fail) throw new Error('Import failed after both saves');
    return 'imported';
  });
  const schema = runtime.createSchema();
  return {
    mutation,
    run: (contextValue = {}) => graphql({ schema, source: `mutation { ${mutation} }`, contextValue }),
    counts: () => Promise.all(models.map((Model) => Model.countDocuments())),
  };
};

describe.skipIf(!uri)('MongoDB custom mutations while the default connection is unopened', () => {
  let bufferTimeoutMS;

  beforeAll(() => {
    bufferTimeoutMS = mongoose.get('bufferTimeoutMS');
    // Requests that wait for the unopened default connection fail fast.
    mongoose.set('bufferTimeoutMS', 1500);
  });

  afterAll(async () => {
    for (const database of databases) await database.dropDatabase().catch(() => {});
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase().catch(() => {});
    await Promise.all(clients.map((connection) => connection.close()));
    await mongoose.disconnect();
    mongoose.set('bufferTimeoutMS', bufferTimeoutMS);
  });

  test('commits saveObject writes of two types when every model is on one createConnection', async () => {
    const connection = await openConnection();
    const { mutation, run, counts } = await importFixture(async () => connection);
    expect(mongoose.connection.getClient()).toBeUndefined();

    expect(await run()).toEqual({ data: { [mutation]: 'imported' } });
    expect(await counts()).toEqual([1, 1]);
  }, 15000);

  test('rolls back both writes when the custom mutation fails', async () => {
    const connection = await openConnection();
    const { run, counts } = await importFixture(async () => connection);

    const failed = await run({ fail: true });
    expect(failed.errors.map(({ message }) => message)).toEqual(['Import failed after both saves']);
    expect(await counts()).toEqual([0, 0]);
  }, 15000);

  test('shares the custom mutation transaction across models on useDb children of one client', async () => {
    const base = await openConnection();
    const { mutation, run, counts } = await importFixture(async (which) => useDb(base, `${dbName}_${which}`));

    expect(await run()).toEqual({ data: { [mutation]: 'imported' } });
    const failed = await run({ fail: true });
    expect(failed.errors.map(({ message }) => message)).toEqual(['Import failed after both saves']);
    expect(await counts()).toEqual([1, 1]);
  }, 15000);

  test('keeps the default connection when the registered models use two clients', async () => {
    const first = await openConnection();
    const second = await openConnection();
    const { run, counts } = await importFixture(async (which) => (which === 'book' ? first : second));

    const result = await run();
    expect(result.errors.map(({ message }) => message)).toEqual([expect.stringMatching(/buffering timed out/)]);
    expect(await counts()).toEqual([0, 0]);
  }, 15000);

  // Opens the default connection, so it must stay last.
  test('keeps the default connection for a generated model when the app connects after the request', async () => {
    const connection = await openConnection();
    counter += 1;
    const Book = idTitle(`CustomSession${counter}Book`);
    const Log = idTitle(`CustomSession${counter}Log`);
    const BookModel = connection.model(Book.name, new mongoose.Schema({ title: String }), Book.name);
    const runtime = createRuntime(createMongoAdapter());
    runtime.preventCreatingCollection(true);
    runtime.connect(BookModel, Book, Book.name.toLowerCase(), `${Book.name.toLowerCase()}s`);
    runtime.connect(null, Log, Log.name.toLowerCase(), `${Log.name.toLowerCase()}s`);
    const mutation = `CustomSession${counter}Log`;
    runtime.registerMutation(mutation, 'Saves a generated log record', null, GraphQLString, async (_input, session, context) => {
      await runtime.saveObject(Log.name, { title: 'logged' }, session, context);
      return 'logged';
    });
    const schema = runtime.createSchema();

    // Today the request waits for the default connection, which the app opens a moment later.
    const pending = graphql({ schema, source: `mutation { ${mutation} }`, contextValue: {} });
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    expect(mongoose.connection.getClient()).toBeUndefined();
    await mongoose.connect(uri, connectionOptions);

    expect(await pending).toEqual({ data: { [mutation]: 'logged' } });
    expect(await runtime.getModel(Log).countDocuments()).toBe(1);
  }, 15000);
});
