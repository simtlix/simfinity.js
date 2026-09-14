import {
  afterEach, beforeAll, beforeEach, describe, expect, test, vi,
} from 'vitest';
import mongoose from 'mongoose';
import {
  GraphQLID, GraphQLList, GraphQLObjectType, GraphQLString,
} from 'graphql';
import * as simfinity from '../packages/mongodb/src/index.js';

const parentController = {};
const childController = {};
const Child = new GraphQLObjectType({
  name: 'TransactionChild',
  fields: { id: { type: GraphQLID }, name: { type: GraphQLString } },
});
const Parent = new GraphQLObjectType({
  name: 'TransactionParent',
  fields: {
    id: { type: GraphQLID },
    name: { type: GraphQLString },
    children: {
      type: new GraphQLList(Child),
      extensions: { relation: { embedded: false, connectionField: 'parentId' } },
    },
  },
});
const parentId = '507f1f77bcf86cd799439011';
const childId = '507f1f77bcf86cd799439012';
const context = { requestId: 'transaction-test' };

const labeledError = (...labels) => {
  const error = new Error(labels.join(', '));
  error.errorLabels = labels;
  return error;
};

// Session state follows the driver's Core API: a commit attempt ends the active
// transaction locally even when its result is unknown and commit must be retried.
const createSession = () => {
  let active = false;
  return {
    inTransaction: () => active,
    startTransaction: vi.fn(() => {
      if (active) throw new Error('Transaction already in progress');
      active = true;
    }),
    commitTransaction: vi.fn(async () => { active = false; }),
    abortTransaction: vi.fn(async () => { active = false; }),
    endSession: vi.fn(async () => {}),
  };
};

describe('Mutation transactions', () => {
  let schema;
  let ParentModel;
  let ChildModel;
  let session;
  let customCallback;

  beforeAll(() => {
    simfinity.preventCreatingCollection(true);
    simfinity.connect(null, Child, 'transactionchild', 'transactionchildren', childController);
    simfinity.connect(null, Parent, 'transactionparent', 'transactionparents', parentController);
    simfinity.registerMutation('transactionCustom', 'Transaction regression', null, GraphQLString,
      (...args) => customCallback(...args));
    schema = simfinity.createSchema();
    ParentModel = simfinity.getModel(Parent);
    ChildModel = simfinity.getModel(Child);
  });

  beforeEach(() => {
    session = createSession();
    vi.spyOn(mongoose, 'startSession').mockResolvedValue(session);
    vi.spyOn(mongoose.connection, 'startSession').mockResolvedValue(session);
    customCallback = vi.fn(async () => 'done');
    for (const key of Object.keys(parentController)) delete parentController[key];
    for (const key of Object.keys(childController)) delete childController[key];
  });

  afterEach(() => vi.restoreAllMocks());

  const mutate = (name, input) => schema.getMutationType().getFields()[name]
    .resolve(null, { input }, context);

  test('executes the lazy parent update before children and passes the document to onUpdated', async () => {
    const events = [];
    const updated = new ParentModel({ _id: parentId, name: 'Updated' });
    // Keep the real Mongoose Query so awaiting it is required to execute the write.
    vi.spyOn(ParentModel.Query.prototype, 'exec').mockImplementation(async function () {
      expect(this.getOptions().session).toBe(session);
      events.push('parent-write');
      return updated;
    });
    vi.spyOn(ChildModel.prototype, 'save').mockImplementation(async function () {
      expect(this.$session()).toBe(session);
      events.push('child-write');
      return this;
    });
    parentController.onUpdated = async (document, receivedSession, receivedContext) => {
      expect(document instanceof mongoose.Document).toBe(true);
      expect(document).toBe(updated);
      expect(document.name).toBe('Updated');
      expect(receivedSession).toBe(session);
      expect(receivedContext).toBe(context);
      events.push('onUpdated');
    };

    const result = await mutate('updatetransactionparent', {
      id: parentId, name: 'Updated', children: { added: [{ name: 'Child' }] },
    });
    expect(result).toBe(updated);
    expect(events).toEqual(['parent-write', 'child-write', 'onUpdated']);
    expect(session.commitTransaction).toHaveBeenCalledOnce();
  });

  test.each(['added', 'updated', 'deleted'])('rejects a missing parent before %s child writes or onUpdated', async (operation) => {
    vi.spyOn(ParentModel.Query.prototype, 'exec').mockResolvedValue(null);
    const childSave = vi.spyOn(ChildModel.prototype, 'save').mockImplementation(async function () { return this; });
    const childQuery = vi.spyOn(ChildModel.Query.prototype, 'exec').mockResolvedValue(null);
    parentController.onUpdated = vi.fn();
    const child = operation === 'deleted' ? childId : { id: childId, name: 'Changed' };

    await expect(mutate('updatetransactionparent', {
      id: parentId, children: { [operation]: [child] },
    })).rejects.toMatchObject({ extensions: { code: 'NOT_VALID_ID', status: 404 } });
    expect(childSave).not.toHaveBeenCalled();
    expect(childQuery).not.toHaveBeenCalled();
    expect(parentController.onUpdated).not.toHaveBeenCalled();
    expect(session.commitTransaction).not.toHaveBeenCalled();
  });

  test('direct saveObject owns a transaction and awaits session cleanup', async () => {
    let cleanedUp = false;
    vi.spyOn(ParentModel.prototype, 'save').mockImplementation(async function () {
      expect(this.$session()).toBe(session);
      expect(session.inTransaction()).toBe(true);
      return this;
    });
    session.endSession.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      cleanedUp = true;
    });
    const result = await simfinity.saveObject(Parent.name, { name: 'Saved' });
    expect(result.name).toBe('Saved');
    expect(session.commitTransaction).toHaveBeenCalledOnce();
    expect(cleanedUp).toBe(true);
  });

  test('saveObject borrows an active caller transaction without owning its lifecycle', async () => {
    session.startTransaction();
    vi.spyOn(ParentModel.prototype, 'save').mockImplementation(async function () { return this; });
    const result = await simfinity.saveObject(Parent.name, { name: 'Borrowed' }, session, context);
    expect(result.name).toBe('Borrowed');
    expect(mongoose.startSession).not.toHaveBeenCalled();
    expect(session.startTransaction).toHaveBeenCalledOnce();
    expect(session.commitTransaction).not.toHaveBeenCalled();
    expect(session.abortTransaction).not.toHaveBeenCalled();
    expect(session.endSession).not.toHaveBeenCalled();
    expect(session.inTransaction()).toBe(true);
  });

  test('a borrowed transaction failure is left to its caller without retry or abort', async () => {
    session.startTransaction();
    const failure = labeledError('TransientTransactionError');
    const save = vi.spyOn(ParentModel.prototype, 'save').mockRejectedValue(failure);
    await expect(simfinity.saveObject(Parent.name, { name: 'Borrowed' }, session)).rejects.toBe(failure);
    expect(save).toHaveBeenCalledOnce();
    expect(session.abortTransaction).not.toHaveBeenCalled();
    expect(session.endSession).not.toHaveBeenCalled();
    expect(session.inTransaction()).toBe(true);
  });

  test('rejects an inactive caller session before writing', async () => {
    const save = vi.spyOn(ParentModel.prototype, 'save').mockImplementation(async function () { return this; });
    await expect(simfinity.saveObject(Parent.name, { name: 'Unsafe' }, session))
      .rejects.toMatchObject({ extensions: { code: 'ACTIVE_TRANSACTION_REQUIRED' } });
    expect(save).not.toHaveBeenCalled();
    expect(session.endSession).not.toHaveBeenCalled();
  });

  test('preserves a hook error when abort and session cleanup both fail', async () => {
    const failure = new Error('Original hook error');
    customCallback.mockRejectedValue(failure);
    session.abortTransaction.mockRejectedValue(new Error('Abort failed'));
    session.endSession.mockRejectedValue(new Error('Cleanup failed'));
    await expect(mutate('transactionCustom')).rejects.toBe(failure);
    expect(session.endSession).toHaveBeenCalledOnce();
  });

  test('bounds transient transaction retries and returns the primary failure', async () => {
    const failure = labeledError('TransientTransactionError');
    customCallback.mockRejectedValue(failure);
    await expect(mutate('transactionCustom')).rejects.toBe(failure);
    expect(customCallback).toHaveBeenCalledTimes(6);
    expect(session.abortTransaction).toHaveBeenCalledTimes(6);
    expect(session.endSession).toHaveBeenCalledOnce();
  });

  test('does not retry a transient failure when abort itself fails', async () => {
    const failure = labeledError('TransientTransactionError');
    customCallback.mockRejectedValue(failure);
    session.abortTransaction.mockRejectedValue(new Error('Abort failed'));
    await expect(mutate('transactionCustom')).rejects.toBe(failure);
    expect(customCallback).toHaveBeenCalledOnce();
    expect(session.endSession).toHaveBeenCalledOnce();
  });

  test('surfaces an awaited cleanup error after a successful commit', async () => {
    const failure = new Error('Cleanup failed');
    session.endSession.mockRejectedValue(failure);
    await expect(mutate('transactionCustom')).rejects.toBe(failure);
    expect(session.commitTransaction).toHaveBeenCalledOnce();
    expect(customCallback).toHaveBeenCalledOnce();
  });

  test('retries a transient body failure in a new transaction', async () => {
    customCallback.mockRejectedValueOnce(labeledError('TransientTransactionError'));
    await expect(mutate('transactionCustom')).resolves.toBe('done');
    expect(customCallback).toHaveBeenCalledTimes(2);
    expect(session.startTransaction).toHaveBeenCalledTimes(2);
    expect(session.commitTransaction).toHaveBeenCalledOnce();
  });

  test('retries an unknown commit result without repeating writes or aborting', async () => {
    const commit = session.commitTransaction.getMockImplementation();
    session.commitTransaction.mockImplementationOnce(async () => {
      await commit();
      throw labeledError('UnknownTransactionCommitResult', 'TransientTransactionError');
    });
    await expect(mutate('transactionCustom')).resolves.toBe('done');
    expect(customCallback).toHaveBeenCalledOnce();
    expect(session.commitTransaction).toHaveBeenCalledTimes(2);
    expect(session.abortTransaction).not.toHaveBeenCalled();
  });

  test('bounds uncertain commit retries without replaying the transaction', async () => {
    const failure = labeledError('UnknownTransactionCommitResult');
    session.commitTransaction.mockRejectedValue(failure);
    await expect(mutate('transactionCustom')).rejects.toBe(failure);
    expect(customCallback).toHaveBeenCalledOnce();
    expect(session.commitTransaction).toHaveBeenCalledTimes(6);
    expect(session.abortTransaction).not.toHaveBeenCalled();
    expect(session.endSession).toHaveBeenCalledOnce();
  });

  test.each([{ code: 50 }, { writeConcernError: { code: 50 } }])('does not retry an expired commit (%j)', async (details) => {
    const failure = Object.assign(labeledError('UnknownTransactionCommitResult'), details);
    session.commitTransaction.mockRejectedValue(failure);
    await expect(mutate('transactionCustom')).rejects.toBe(failure);
    expect(customCallback).toHaveBeenCalledOnce();
    expect(session.commitTransaction).toHaveBeenCalledOnce();
    expect(session.abortTransaction).not.toHaveBeenCalled();
  });

  test('retries a definitively transient commit failure as a new transaction', async () => {
    const commit = session.commitTransaction.getMockImplementation();
    session.commitTransaction.mockImplementationOnce(async () => {
      await commit();
      throw labeledError('TransientTransactionError');
    });
    await expect(mutate('transactionCustom')).resolves.toBe('done');
    expect(customCallback).toHaveBeenCalledTimes(2);
    expect(session.startTransaction).toHaveBeenCalledTimes(2);
    expect(session.abortTransaction).not.toHaveBeenCalled();
  });
});
