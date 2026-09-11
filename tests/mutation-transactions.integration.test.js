import {
  afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi,
} from 'vitest';
import mongoose from 'mongoose';
import {
  GraphQLEnumType, GraphQLID, GraphQLList, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';
import * as simfinity from '../src/index.js';

// Opt in with a disposable replica-set URI. Only this suite's three collections
// in its own per-process database are cleared; no shared database is dropped.
const uri = process.env.SIMFINITY_TEST_MONGODB_URI;
const parentController = {};
const childController = {};
const State = new GraphQLEnumType({
  name: 'MongoTransactionState',
  values: { DRAFT: { value: 10 }, ACTIVE: { value: 20 } },
});
const Parent = new GraphQLObjectType({
  name: 'MongoTransactionParent',
  fields: () => ({
    id: { type: GraphQLID },
    name: { type: GraphQLString },
    state: { type: State },
    children: {
      type: new GraphQLList(Child),
      extensions: { relation: { embedded: false, connectionField: 'parentId' } },
    },
  }),
});
const Child = new GraphQLObjectType({
  name: 'MongoTransactionChild',
  fields: () => ({
    id: { type: GraphQLID },
    name: { type: GraphQLString },
    parent: {
      type: Parent,
      extensions: { relation: { embedded: false, connectionField: 'parentId' } },
    },
  }),
});
const CustomConnectionType = new GraphQLObjectType({
  name: 'MongoTransactionCustomConnection',
  fields: { id: { type: GraphQLID }, name: { type: GraphQLString } },
});

const transientError = () => {
  const error = new mongoose.mongo.MongoServerError({ message: 'Injected transient transaction error' });
  error.addErrorLabel('TransientTransactionError');
  return error;
};

describe.skipIf(!uri)('Mutation transactions against a MongoDB replica set', () => {
  let schema;
  let ParentModel;
  let ChildModel;
  let customConnection;
  let CustomConnectionModel;
  let customCallback;
  const transition = { from: State.getValue('DRAFT'), to: State.getValue('ACTIVE') };

  beforeAll(async () => {
    const options = {
      dbName: `simfinity_fix04_transactions_${process.pid}`,
      autoCreate: false,
      autoIndex: false,
      serverSelectionTimeoutMS: 5000,
    };
    await mongoose.connect(uri, options);
    customConnection = await mongoose.createConnection(uri, options).asPromise();
    CustomConnectionModel = customConnection.model(CustomConnectionType.name,
      new mongoose.Schema({ name: String }), CustomConnectionType.name);
    simfinity.preventCreatingCollection(true);
    simfinity.connect(null, Child, 'mongotransactionchild', 'mongotransactionchildren', childController);
    simfinity.connect(null, Parent, 'mongotransactionparent', 'mongotransactionparents', parentController, null, {
      initialState: State.getValue('DRAFT'), actions: { activate: transition },
    });
    simfinity.connect(CustomConnectionModel, CustomConnectionType, 'mongocustomconnection', 'mongocustomconnections');
    simfinity.registerMutation('mongoTransactionCustom', 'Transaction integration regression', null, GraphQLString,
      (...args) => customCallback(...args));
    schema = simfinity.createSchema();
    ParentModel = simfinity.getModel(Parent);
    ChildModel = simfinity.getModel(Child);
    await ParentModel.createCollection();
    await ChildModel.createCollection();
    await CustomConnectionModel.createCollection();
  });

  beforeEach(async () => {
    await ParentModel.deleteMany({});
    await ChildModel.deleteMany({});
    await CustomConnectionModel.deleteMany({});
    for (const key of Object.keys(parentController)) delete parentController[key];
    for (const key of Object.keys(childController)) delete childController[key];
    delete transition.action;
    customCallback = async () => 'done';
  });

  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => {
    if (ParentModel) await ParentModel.deleteMany({});
    if (ChildModel) await ChildModel.deleteMany({});
    if (CustomConnectionModel) await CustomConnectionModel.deleteMany({});
    if (customConnection) await customConnection.close();
    await mongoose.disconnect();
  });

  const mutate = (name, input, context = {}) => schema.getMutationType().getFields()[name]
    .resolve(null, { input }, context);

  const seedFamily = async () => {
    const parent = await ParentModel.create({ name: 'Before', state: 'DRAFT' });
    const child = await ChildModel.create({ name: 'Existing child', parentId: parent._id });
    return { parent, child };
  };

  test('onUpdated sees the persisted parent and children in the same session before commit', async () => {
    const { parent } = await seedFamily();
    const context = { requestId: 'real-mongo' };
    childController.onSaving = async (_doc, _args, session) => {
      expect((await ParentModel.findById(parent._id).session(session)).name).toBe('After');
    };
    parentController.onUpdated = async (doc, session, receivedContext) => {
      expect(doc instanceof mongoose.Document).toBe(true);
      expect(doc.name).toBe('After');
      expect(receivedContext).toBe(context);
      expect((await ParentModel.findById(parent._id).session(session)).name).toBe('After');
      expect(await ChildModel.countDocuments({ parentId: parent._id }).session(session)).toBe(2);
      expect((await ParentModel.findById(parent._id)).name).toBe('Before');
    };
    const result = await mutate('updatemongotransactionparent', {
      id: String(parent._id), name: 'After', children: { added: [{ name: 'Added child' }] },
    }, context);
    expect(result.name).toBe('After');
    expect((await ParentModel.findById(parent._id)).name).toBe('After');
    expect(await ChildModel.countDocuments({ parentId: parent._id })).toBe(2);
  });

  test('a missing parent cannot add, modify, or delete children', async () => {
    const { parent, child } = await seedFamily();
    const missingId = String(new mongoose.Types.ObjectId());
    for (const children of [
      { added: [{ name: 'Orphan' }] },
      { updated: [{ id: String(child._id), name: 'Changed' }] },
      { deleted: [String(child._id)] },
    ]) {
      await expect(mutate('updatemongotransactionparent', { id: missingId, children }))
        .rejects.toMatchObject({ extensions: { code: 'NOT_VALID_ID' } });
      const stored = await ChildModel.findById(child._id);
      expect(stored.name).toBe('Existing child');
      expect(String(stored.parentId)).toBe(String(parent._id));
      expect(await ChildModel.countDocuments({})).toBe(1);
    }
  });

  test('a parent write failure prevents child hooks and persistence', async () => {
    const { parent } = await seedFamily();
    const childHook = vi.fn();
    childController.onSaving = childHook;
    parentController.onUpdating = async (_id, changes) => { changes._id = new mongoose.Types.ObjectId(); };
    await expect(mutate('updatemongotransactionparent', {
      id: String(parent._id), name: 'Must fail', children: { added: [{ name: 'No child write' }] },
    })).rejects.toMatchObject({ code: 66 });
    expect(childHook).not.toHaveBeenCalled();
    expect((await ParentModel.findById(parent._id)).name).toBe('Before');
    expect(await ChildModel.countDocuments({})).toBe(1);
  });

  test('rolls back parent updates and every child operation when onUpdated fails', async () => {
    const { parent, child } = await seedFamily();
    const removed = await ChildModel.create({ name: 'Keep me', parentId: parent._id });
    const failure = new Error('Post-update hook failed');
    parentController.onUpdated = async () => { throw failure; };
    await expect(mutate('updatemongotransactionparent', {
      id: String(parent._id), name: 'Uncommitted', children: {
        added: [{ name: 'Uncommitted child' }],
        updated: [{ id: String(child._id), name: 'Uncommitted update' }],
        deleted: [String(removed._id)],
      },
    })).rejects.toBe(failure);
    expect((await ParentModel.findById(parent._id)).name).toBe('Before');
    expect((await ChildModel.findById(child._id)).name).toBe('Existing child');
    expect((await ChildModel.findById(removed._id)).name).toBe('Keep me');
    expect(await ChildModel.countDocuments({})).toBe(2);
  });

  test('direct saveObject rolls back its persisted parent and children on a child failure', async () => {
    const failure = new Error('Child failed after insert');
    childController.onSaved = async () => { throw failure; };
    await expect(simfinity.saveObject(Parent.name, {
      name: 'Uncommitted parent', children: { added: [{ name: 'Uncommitted child' }] },
    })).rejects.toBe(failure);
    expect(await ParentModel.countDocuments({})).toBe(0);
    expect(await ChildModel.countDocuments({})).toBe(0);
  });

  test('direct saveObject uses the registered model connection for its owned session', async () => {
    const saved = await simfinity.saveObject(CustomConnectionType.name, { name: 'Custom connection' });
    expect((await CustomConnectionModel.findById(saved._id)).name).toBe('Custom connection');
    const updated = await mutate('updatemongocustomconnection', { id: String(saved._id), name: 'Updated on custom connection' });
    expect(updated.name).toBe('Updated on custom connection');
    expect((await CustomConnectionModel.findById(saved._id)).name).toBe('Updated on custom connection');
  });

  test('a caller can abort saveObject and its nested writes after a successful return', async () => {
    const session = await mongoose.startSession();
    try {
      session.startTransaction();
      await simfinity.saveObject(Parent.name, {
        name: 'Caller-owned', children: { added: [{ name: 'Child' }] },
      }, session);
      expect(session.inTransaction()).toBe(true);
      expect(await ParentModel.countDocuments({}).session(session)).toBe(1);
      expect(await ParentModel.countDocuments({})).toBe(0);
      await session.abortTransaction();
      expect(await ParentModel.countDocuments({})).toBe(0);
      expect(await ChildModel.countDocuments({})).toBe(0);
    } finally {
      await session.endSession();
    }
  });

  test('custom mutations share one transaction with programmatic saves and roll everything back', async () => {
    const failure = new Error('Custom mutation failed');
    customCallback = async (_input, session, context) => {
      await simfinity.saveObject(Parent.name, {
        name: 'Custom mutation', children: { added: [{ name: 'Child' }] },
      }, session, context);
      expect(session.inTransaction()).toBe(true);
      throw failure;
    };
    await expect(mutate('mongoTransactionCustom')).rejects.toBe(failure);
    expect(await ParentModel.countDocuments({})).toBe(0);
    expect(await ChildModel.countDocuments({})).toBe(0);
  });

  test('a successful custom mutation commits nested programmatic saves once', async () => {
    let hooks = 0;
    parentController.onSaved = async () => { hooks++; };
    customCallback = async (_input, session, context) => {
      const saved = await simfinity.saveObject(Parent.name, {
        name: 'Custom success', children: { added: [{ name: 'Child' }] },
      }, session, context);
      expect(await ParentModel.countDocuments({})).toBe(0);
      return saved.name;
    };
    const result = await graphql({ schema, source: 'mutation { mongoTransactionCustom }' });
    expect(result.errors).toBeUndefined();
    expect(result.data.mongoTransactionCustom).toBe('Custom success');
    expect(hooks).toBe(1);
    expect(await ParentModel.countDocuments({})).toBe(1);
    expect(await ChildModel.countDocuments({})).toBe(1);
  });

  test('a transient hook failure rolls back the first attempt and persists only its retry', async () => {
    let attempts = 0;
    parentController.onSaved = async () => {
      attempts++;
      if (attempts === 1) throw transientError();
    };
    const result = await simfinity.saveObject(Parent.name, {
      name: 'Retry', children: { added: [{ name: 'Child' }] },
    });
    expect(attempts).toBe(2);
    expect(await ParentModel.countDocuments({})).toBe(1);
    expect(await ChildModel.countDocuments({ parentId: result._id })).toBe(1);
  });

  test('an uncertain successful commit retries the real commit without repeating hooks or writes', async () => {
    let hooks = 0;
    let commits = 0;
    const startSession = mongoose.connection.startSession.bind(mongoose.connection);
    vi.spyOn(mongoose.connection, 'startSession').mockImplementation(async () => {
      const session = await startSession();
      const commit = session.commitTransaction.bind(session);
      session.commitTransaction = async () => {
        commits++;
        await commit();
        if (commits === 1) {
          const error = new mongoose.mongo.MongoServerError({ message: 'Lost successful commit response' });
          error.addErrorLabel('UnknownTransactionCommitResult');
          throw error;
        }
      };
      return session;
    });
    parentController.onSaved = async () => { hooks++; };
    const result = await simfinity.saveObject(Parent.name, {
      name: 'Committed once', children: { added: [{ name: 'Child' }] },
    });
    expect(commits).toBe(2);
    expect(hooks).toBe(1);
    expect(await ParentModel.countDocuments({})).toBe(1);
    expect(await ChildModel.countDocuments({ parentId: result._id })).toBe(1);
  });

  test('state actions return the enum value and update hooks receive the stored document', async () => {
    const { parent } = await seedFamily();
    parentController.onUpdated = async (doc, session) => {
      expect(doc instanceof mongoose.Document).toBe(true);
      expect(doc.state).toBe('ACTIVE');
      expect((await ParentModel.findById(parent._id).session(session)).state).toBe('ACTIVE');
    };
    const result = await graphql({
      schema,
      source: `mutation { activate_mongotransactionparent(input: { id: "${parent._id}" }) { id state } }`,
    });
    expect(result.errors).toBeUndefined();
    expect(result.data.activate_mongotransactionparent.state).toBe('ACTIVE');
    expect((await ParentModel.findById(parent._id)).state).toBe('ACTIVE');
  });

  test('state action and parent writes roll back when its update hook fails', async () => {
    const { parent, child } = await seedFamily();
    const failure = new Error('State hook failed');
    transition.action = async (_args, session) => {
      await ChildModel.updateOne({ _id: child._id }, { name: 'State side effect' }).session(session);
    };
    parentController.onUpdated = async () => { throw failure; };
    await expect(mutate('activate_mongotransactionparent', { id: String(parent._id) })).rejects.toBe(failure);
    expect((await ParentModel.findById(parent._id)).state).toBe('DRAFT');
    expect((await ChildModel.findById(child._id)).name).toBe('Existing child');
  });

  test('a transient state hook failure retries from the original persisted state', async () => {
    const { parent, child } = await seedFamily();
    let attempts = 0;
    transition.action = async (_args, session) => {
      expect((await ChildModel.findById(child._id).session(session)).name).toBe('Existing child');
      await ChildModel.updateOne({ _id: child._id }, { name: 'Transitioned' }).session(session);
    };
    parentController.onUpdated = async () => {
      attempts++;
      if (attempts === 1) throw transientError();
    };
    const result = await mutate('activate_mongotransactionparent', { id: String(parent._id) });
    expect(result.state).toBe(20);
    expect(attempts).toBe(2);
    expect((await ParentModel.findById(parent._id)).state).toBe('ACTIVE');
    expect((await ChildModel.findById(child._id)).name).toBe('Transitioned');
    await expect(mutate('activate_mongotransactionparent', { id: String(parent._id) }))
      .rejects.toMatchObject({ extensions: { code: 'BAD_REQUEST' } });
  });
});
