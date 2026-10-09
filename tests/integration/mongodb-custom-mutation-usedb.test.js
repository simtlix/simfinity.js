import {
  afterAll, beforeAll, describe, expect, test,
} from 'vitest';
import mongoose from 'mongoose';
import {
  GraphQLID, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';
import { createMongoAdapter, createRuntime } from '../../packages/mongodb/src/index.js';

// Opt in with a disposable replica-set URI. A custom mutation in the default referentialIntegrity
// 'off' mode arrives before the application opens the default mongoose.connection, and its callback
// writes an application model compiled on a useDb() connection of it. A file of its own, since the
// test opens the default connection. afterAll drops every database it uses, whether or not it passed.
const uri = process.env.SIMFINITY_MONGODB_URI;
const dbName = `simfinity_custom_session_usedb_${process.pid}`;
const connectionOptions = {
  dbName, autoCreate: false, autoIndex: false, serverSelectionTimeoutMS: 5000,
};
const connections = [];
const databases = [];

describe.skipIf(!uri)('MongoDB custom mutations and useDb connections of the unopened default connection', () => {
  let bufferTimeoutMS;

  beforeAll(() => {
    bufferTimeoutMS = mongoose.get('bufferTimeoutMS');
    // Requests that wait for the unopened default connection fail fast.
    mongoose.set('bufferTimeoutMS', 5000);
  });

  afterAll(async () => {
    for (const database of databases) await database.dropDatabase().catch(() => {});
    if (mongoose.connection.readyState === 1) await mongoose.connection.dropDatabase().catch(() => {});
    await Promise.all(connections.map((connection) => connection.close()));
    await mongoose.disconnect();
    mongoose.set('bufferTimeoutMS', bufferTimeoutMS);
  });

  test('keeps the default connection for an application model on its useDb connection when the app connects after the request', async () => {
    const connection = await mongoose.createConnection(uri, connectionOptions).asPromise();
    connections.push(connection);
    databases.push(connection);
    const Book = new GraphQLObjectType({
      name: 'CustomSessionUseDbBook', fields: { id: { type: GraphQLID }, title: { type: GraphQLString } },
    });
    const BookModel = connection.model(Book.name, new mongoose.Schema({ title: String }), Book.name);
    await BookModel.createCollection();
    // The application's model lives on a useDb connection of the default one, never on it.
    const auditDb = mongoose.connection.useDb(`${dbName}_audit`);
    databases.push(auditDb);
    const Audit = auditDb.model('CustomSessionUseDbAudit', new mongoose.Schema({ msg: String }));
    expect(mongoose.connection.modelNames()).toEqual([]);

    const runtime = createRuntime(createMongoAdapter());
    runtime.preventCreatingCollection(true);
    runtime.connect(BookModel, Book, 'customsessionusedbbook', 'customsessionusedbbooks');
    runtime.registerMutation('customSessionUseDbAudit', 'Writes an audit record with the session', null, GraphQLString,
      async (_input, session) => {
        await Audit.create([{ msg: 'audited' }], { session });
        return 'audited';
      });
    const schema = runtime.createSchema();

    // The request waits for the default connection, which the app opens a moment later.
    const pending = graphql({ schema, source: 'mutation { customSessionUseDbAudit }', contextValue: {} });
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    expect(mongoose.connection.getClient()).toBeUndefined();
    await mongoose.connect(uri, connectionOptions);

    expect(await pending).toEqual({ data: { customSessionUseDbAudit: 'audited' } });
    expect(await Audit.countDocuments()).toBe(1);
  }, 20000);
});
