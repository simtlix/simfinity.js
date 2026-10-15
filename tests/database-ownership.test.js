import { expect, test } from 'vitest';
import { GraphQLID, GraphQLInt, GraphQLObjectType, GraphQLString } from 'graphql';
import { createRuntime } from '../packages/core/src/index.js';
import { createMongoAdapter } from '../packages/mongodb/src/mongo/adapter.js';
import { openMongoDatabase, mongoId } from '../packages/mongodb/src/mongo/database.js';
import { MongoTransactionPolicy } from '../packages/mongodb/src/mongo/transaction-policy.js';

const uri = process.env.SIMFINITY_TEST_MONGODB_URI;
test.skipIf(!uri)('owned databases isolate lifecycle and declarative models preserve adopted rollback', async () => {
  const dbName = `simfinity_ownership_${process.pid}_${Date.now()}`;
  const first = await openMongoDatabase(uri, { dbName });
  const second = await openMongoDatabase(uri, { dbName });
  try {
    await second.database.createCollection('OwnedItem');
    const type = new GraphQLObjectType({ name: 'OwnedItem', fields: {
      id: { type: GraphQLID }, title: { type: GraphQLString }, version: { type: GraphQLInt },
    } });
    const runtime = createRuntime(createMongoAdapter({ database: second.database, models: {
      OwnedItem: { collection: 'OwnedItem', fields: { _id: 'objectId', title: 'string', version: 'number' }, strict: 'throw' },
    } }));
    runtime.preventCreatingCollection(true);
    runtime.connect(null, type, 'ownedItem', 'ownedItems');
    runtime.createSchema();
    await first.close();
    const id = String(mongoId());
    const policy = new MongoTransactionPolicy(() => second.database.client);
    const save = session => runtime.execute('OwnedItem', 'save', { input: { title: null, version: 1 } }, {
      session, storage: { id, nulls: 'preserve' },
    });
    await expect(policy.runOwned(async session => {
      await save(session);
      throw new Error('rollback');
    })).rejects.toThrow('rollback');
    expect(await second.database.collection('OwnedItem').countDocuments()).toBe(0);
    await policy.runOwned(save);
    const row = await runtime.execute('OwnedItem', 'get_by_id', { id });
    expect(String(row._id)).toBe(id);
    expect(row.title).toBeNull();
    expect(row.__v).toBeUndefined();
    const foreign = await openMongoDatabase(uri, { dbName });
    const session = foreign.database.client.startSession();
    session.startTransaction();
    try {
      await expect(policy.runAdopted(session, () => {})).rejects.toThrow('another client');
    } finally {
      await session.abortTransaction();
      await session.endSession();
      await foreign.close();
    }
  } finally {
    await second.database.dropDatabase();
    await second.close();
    await first.close();
  }
});
