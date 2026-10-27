import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLEnumType, GraphQLID, GraphQLInputObjectType, GraphQLList, GraphQLObjectType, GraphQLString, graphql } from 'graphql';
import mongoose from 'mongoose';
import pg from 'pg';
import { createRuntime } from '../../packages/core/src/index.js';
import { createMongoAdapter } from '../../packages/mongodb/src/index.js';
import { createPostgres } from '../../packages/postgres/src/index.js';

const mongoURI = process.env.SIMFINITY_MONGODB_URI;
const postgresURI = process.env.SIMFINITY_POSTGRES_URI;
const modes = ['mongo-off', 'mongo-transactional', 'postgres'];

describe.each(modes)('after-commit on %s', (mode) => {
  const isMongo = mode.startsWith('mongo');
  describe.skipIf(!(isMongo ? mongoURI : postgresURI))('disposable database contract', () => {
    const namespace = `commit_${randomUUID().replaceAll('-', '')}`;
    const parent = {}; const child = {};
    let api; let schema; let connection; let pool; let adapter;
    let Parent; let Child; let parentModel; let childModel;
    let callbackErrors = [];
    const notices = [];
    const context = Object.freeze({ requestId: 'synthetic-143' });
    const run = (source, variableValues, value = context) => graphql({ schema, source, variableValues, contextValue: value });
    const add = (input) => run('mutation($input:CommitDBParentInput!){addparent(input:$input){id name state}}', { input });
    const readParent = async (id) => isMongo
      ? parentModel.collection.findOne({ _id: new mongoose.Types.ObjectId(id) })
      : api.getModel(Parent).findById(id);

    beforeAll(async () => {
      const State = new GraphQLEnumType({ name: 'CommitDBState', values: { DRAFT: { value: 10 }, LIVE: { value: 20 } } });
      Parent = new GraphQLObjectType({ name: 'CommitDBParent', fields: () => ({
        id: { type: GraphQLID }, name: { type: GraphQLString }, state: { type: State },
        children: { type: new GraphQLList(Child), extensions: { relation: { embedded: false, connectionField: 'parentId' } } },
      }) });
      Child = new GraphQLObjectType({ name: 'CommitDBChild', fields: () => ({
        id: { type: GraphQLID }, name: { type: GraphQLString, extensions: { unique: true } },
        parent: { type: Parent, extensions: { relation: { embedded: false, connectionField: 'parentId' } } },
      }) });
      if (isMongo) {
        connection = await mongoose.createConnection(mongoURI, { dbName: namespace, autoCreate: false, autoIndex: false }).asPromise();
        parentModel = connection.model(Parent.name, new mongoose.Schema({ name: String, state: String }));
        childModel = connection.model(Child.name, new mongoose.Schema({ name: { type: String, unique: true }, parentId: mongoose.Schema.Types.ObjectId }));
        adapter = createMongoAdapter({ referentialIntegrity: mode === 'mongo-off' ? 'off' : 'transactional' });
        api = createRuntime(adapter);
      } else {
        // A callback's sessionless read/write must not wait on the connection of its own committed operation.
        pool = new pg.Pool({ connectionString: postgresURI, max: 1 });
        api = createPostgres({ pool, schema: namespace });
      }
      api.connect(parentModel || null, Parent, 'parent', 'parents', parent, null, {
        initialState: State.getValue('DRAFT'), actions: { publish: { from: State.getValue('DRAFT'), to: State.getValue('LIVE') } },
      });
      api.connect(childModel || null, Child, 'child', 'children', child);
      const CustomInput = new GraphQLInputObjectType({ name: 'CommitDBCustom', fields: { name: { type: GraphQLString } } });
      api.registerMutation('custom', '', CustomInput, Parent, async (args, session, ctx) => {
        const record = await api.saveObject(Parent.name, args, session, ctx);
        expect(notices).toEqual([]);
        return record;
      });
      api.registerMutation('rejectedCustom', '', CustomInput, Parent, async (args, session, ctx) => {
        await api.saveObject(Parent.name, args, session, ctx);
        expect(notices).toEqual([]);
        throw new Error('reject registered mutation after save');
      });
      schema = api.createSchema(undefined, undefined, undefined, { transaction: { types: [Parent] } });
      if (isMongo) {
        await parentModel.createCollection(); await childModel.createCollection();
        await childModel.createIndexes();
        await parentModel.init(); await childModel.init(); await adapter.initialize();
      } else await api.initializeDatabase();
    });
    beforeEach(async () => {
      for (const controller of [parent, child]) for (const key of Object.keys(controller)) delete controller[key];
      notices.length = 0; callbackErrors = [];
      api.configureAfterCommit({ onError: (error) => { callbackErrors.push(error); } });
      if (isMongo) { await childModel.deleteMany({}); await parentModel.deleteMany({}); }
      else await pool.query(`TRUNCATE "${namespace}"."CommitDBChild", "${namespace}"."CommitDBParent" CASCADE`);
    });
    afterEach(() => { vi.restoreAllMocks(); expect(callbackErrors).toEqual([]); });
    afterAll(async () => {
      if (connection) { await connection.dropDatabase(); await connection.close(); }
      if (pool) { await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); await pool.end(); }
    });

    it('sees committed parent/children through independent reads before callbacks finish', async () => {
      parent.onSaveCommitted = async (record, args, ctx) => {
        expect(record instanceof mongoose.Document).toBe(false);
        expect(ctx).toBe(context);
        expect((await readParent(String(record._id))).name).toBe('parent');
        expect(args.children.added.map((item) => item.name)).toEqual(['one', 'two']);
        notices.push('parent');
      };
      child.onSaveCommitted = async (record, args, ctx) => {
        expect(ctx).toBe(context);
        const stored = isMongo ? await childModel.collection.findOne({ _id: record._id }) : await api.getModel(Child).findById(record._id);
        expect(stored.name).toBe(args.name);
        notices.push(record.name);
      };
      const result = await add({ name: 'parent', children: { added: [{ name: 'one' }, { name: 'two' }] } });
      expect(result.errors).toBeUndefined();
      expect(notices).toEqual(['one', 'two', 'parent']);
    });

    it('notifies lifecycle helpers only after each owned write is visible independently', async () => {
      const created = await api.saveObject(Parent.name, { name: 'first' }, undefined, context);
      const id = String(created._id);
      parent.onUpdateCommitted = async (record, ctx) => {
        expect(ctx).toBe(context);
        expect((await readParent(id)).name).toBe('second');
        notices.push(['update', record.name]);
      };
      parent.onTransitionCommitted = async (record, action, ctx) => {
        expect(ctx).toBe(context);
        expect(await readParent(id)).not.toBeNull();
        notices.push(['transition', action, record.state]);
      };
      parent.onDeleteCommitted = async (record, ctx) => {
        expect(ctx).toBe(context);
        expect(await readParent(id)).toBeNull();
        notices.push(['delete', record.name]);
      };
      await api.updateObject(Parent.name, { id, name: 'second' }, undefined, context);
      await api.transitionObject(Parent.name, 'publish', { id }, undefined, context);
      await api.deleteObject(Parent.name, { id }, undefined, context);
      await api.deleteObject(Parent.name, { id }, undefined, context);
      expect(notices).toEqual([['update', 'second'], ['transition', 'publish', 20], ['delete', 'second']]);
    });

    it('queues list operations and helpers together, preserving snapshots until the whole list commits', async () => {
      parent.onSaved = async (record, args, session, ctx) => {
        await api.saveObject(Child.name, { name: 'from-hook', parent: { id: String(record._id) } }, session, ctx);
        expect(notices).toEqual([]);
      };
      child.onSaveCommitted = () => notices.push(['child']);
      parent.onSaveCommitted = async (record, args, ctx) => {
        expect(ctx).toBe(context);
        expect((await readParent(String(record._id))).name).toBe('second');
        notices.push(['save', record.name]);
      };
      parent.onUpdateCommitted = (record) => notices.push(['update', record.name]);
      parent.onTransitionCommitted = (record, action) => notices.push(['transition', action, record.state]);
      const result = await run(`mutation { transaction(operations: [
        { addparent: { name: "first" } }, { updateparent: { id: "$0", name: "second" } },
        { publish_parent: { id: "$0" } }
      ]) { id } }`);
      expect(result.errors).toBeUndefined();
      expect(notices).toEqual([['child'], ['save', 'first'], ['update', 'second'], ['transition', 'publish', 20]]);
    });

    it.each([false, true])('discards list writes and callbacks from a failed attempt (retry: %s)', async (retry) => {
      vi.spyOn(Math, 'random').mockReturnValue(0);
      let attempts = 0;
      parent.onSaved = (record) => {
        if (record.name === 'second' && ++attempts === 1) {
          const error = new Error('failed list attempt');
          if (retry) Object.assign(error, { code: '40001', severity: 'ERROR', errorLabels: ['TransientTransactionError'] });
          throw error;
        }
      };
      parent.onSaveCommitted = (record) => notices.push(record.name);
      const result = await run(`mutation { transaction(operations: [
        { addparent: { name: "first" } }, { addparent: { name: "second" } }
      ]) { id } }`);
      if (retry) expect(result.errors).toBeUndefined();
      else expect(result.errors?.[0].message).toBe('failed list attempt');
      expect(notices).toEqual(retry ? ['first', 'second'] : []);
      const rows = isMongo ? await parentModel.find().lean() : await api.getModel(Parent).find({});
      expect(rows.map((row) => row.name).sort()).toEqual(retry ? ['first', 'second'] : []);
    });

    it('discards nested notifications and database writes when a parent lifecycle hook rejects', async () => {
      child.onSaveCommitted = () => notices.push('child');
      parent.onSaveCommitted = () => notices.push('parent');
      parent.onSaved = () => { throw new Error('stop before commit'); };
      expect((await add({ name: 'failed', children: { added: [{ name: 'child' }] } })).errors).toHaveLength(1);
      expect(notices).toEqual([]);
      const rows = isMongo ? await parentModel.find().lean() : await api.getModel(Parent).find({});
      expect(rows).toEqual([]);
    });

    it('discards an earlier added child when a later nested update targets a missing record', async () => {
      const created = await add({ name: 'original' });
      expect(created.errors).toBeUndefined();
      const saved = [];
      child.onSaved = (record) => saved.push(record.name);
      child.onSaveCommitted = () => notices.push('child');
      parent.onUpdateCommitted = () => notices.push('parent');
      const missingId = isMongo ? String(new mongoose.Types.ObjectId()) : randomUUID();
      const result = await run('mutation($input:CommitDBParentInputForUpdate!){updateparent(input:$input){name}}', {
        input: { id: created.data.addparent.id, name: 'rejected', children: {
          added: [{ name: 'earlier' }], updated: [{ id: missingId, name: 'missing' }],
        } },
      });
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].extensions.code).toBe('NOT_VALID_ID');
      expect(saved).toEqual(['earlier']);
      expect(notices).toEqual([]);
      expect((await readParent(created.data.addparent.id)).name).toBe('original');
      const rows = isMongo ? await childModel.find().lean() : await api.getModel(Child).find({});
      expect(rows).toEqual([]);
    });

    it('discards an earlier child notification when the database rejects the second child', async () => {
      const saved = [];
      child.onSaved = (record) => saved.push(record.name);
      child.onSaveCommitted = () => notices.push('child');
      parent.onSaveCommitted = () => notices.push('parent');
      const result = await add({ name: 'rejected', children: { added: [{ name: 'duplicate' }, { name: 'duplicate' }] } });
      expect(result.errors).toHaveLength(1);
      if (isMongo) expect(result.errors[0].originalError.code).toBe(11000);
      else expect(result.errors[0].extensions.code).toBe('DUPLICATE_KEY');
      expect(saved).toEqual(['duplicate']);
      expect(notices).toEqual([]);
      const parents = isMongo ? await parentModel.find().lean() : await api.getModel(Parent).find({});
      const children = isMongo ? await childModel.find().lean() : await api.getModel(Child).find({});
      expect(parents).toEqual([]);
      expect(children).toEqual([]);
    });

    it('retries the transaction but dispatches only the successful attempt', async () => {
      let attempts = 0;
      parent.onSaved = (record) => {
        attempts++;
        if (attempts === 1) throw Object.assign(new Error('synthetic retry'), { code: '40001', severity: 'ERROR', errorLabels: ['TransientTransactionError'] });
        record.attempt = attempts;
      };
      parent.onSaveCommitted = async (record) => { expect(await readParent(String(record._id))).not.toBeNull(); notices.push(record.attempt); };
      child.onSaveCommitted = (record) => notices.push(record.name);
      const result = await add({ name: 'retried', children: { added: [{ name: 'child' }] } });
      expect(result.errors).toBeUndefined();
      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(notices).toEqual(['child', attempts]);
      const rows = isMongo ? await parentModel.find().lean() : await api.getModel(Parent).find({});
      expect(rows).toHaveLength(1);
    });

    it('separates state actions from updates and notifies only actual deletions', async () => {
      const added = await add({ name: 'initial' });
      expect(added.errors).toBeUndefined();
      const id = added.data.addparent.id;
      parent.onUpdateCommitted = async (record) => { expect((await readParent(id)).name).toBe('updated'); notices.push(['update', record.name]); };
      parent.onTransitionCommitted = (record, action, ctx) => { expect(ctx).toBe(context); notices.push(['state', action, record.state]); };
      parent.onDeleteCommitted = async (record) => { expect(await readParent(id)).toBeNull(); notices.push(['delete', record.name]); };
      expect((await run('mutation($input:CommitDBParentInputForUpdate!){updateparent(input:$input){name}}', { input: { id, name: 'updated' } })).errors).toBeUndefined();
      expect((await run('mutation($input:CommitDBParentInputForUpdate!){publish_parent(input:$input){state}}', { input: { id } })).errors).toBeUndefined();
      for (let i = 0; i < 2; i++) expect((await run('mutation($id:ID!){deleteparent(id:$id){id}}', { id })).errors).toBeUndefined();
      expect(notices).toEqual([['update', 'updated'], ['state', 'publish', 20], ['delete', 'updated']]);
    });

    it('keeps committed writes successful when callback/reporter fail and continues the queue', async () => {
      child.onSaveCommitted = () => { throw Object.assign(new Error('private callback'), { code: '40001', severity: 'ERROR', errorLabels: ['TransientTransactionError'] }); };
      parent.onSaveCommitted = () => notices.push('parent');
      api.configureAfterCommit({ onError: () => { throw new Error('reporter'); } });
      const logger = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = await add({ name: 'committed', children: { added: [{ name: 'child' }] } });
      expect(result.errors).toBeUndefined();
      expect((await readParent(result.data.addparent.id)).name).toBe('committed');
      expect(notices).toEqual(['parent']);
      expect(JSON.stringify(logger.mock.calls)).not.toContain('private callback');
    });

    it('keeps child add/update/delete notifications when the parent transitions', async () => {
      const created = await run('mutation {addparent(input:{name:"parent",children:{added:[{name:"keep"},{name:"remove"}]}}){id children{id name}}}');
      expect(created.errors).toBeUndefined();
      const { id, children } = created.data.addparent;
      child.onSaveCommitted = () => notices.push('child-add');
      child.onUpdateCommitted = () => notices.push('child-update');
      child.onDeleteCommitted = () => notices.push('child-delete');
      parent.onUpdateCommitted = () => notices.push('parent-update');
      parent.onTransitionCommitted = (record, action, ctx) => {
        expect(record.state).toBe(20); expect(action).toBe('publish'); expect(ctx).toBe(context);
        notices.push('transition');
      };
      const result = await run('mutation($input:CommitDBParentInputForUpdate!){publish_parent(input:$input){state children{name}}}', {
        input: { id, children: { added: [{ name: 'new' }],
          updated: [{ id: children.find((record) => record.name === 'keep').id, name: 'kept' }],
          deleted: [children.find((record) => record.name === 'remove').id] } },
      });
      expect(result.errors).toBeUndefined();
      expect(result.data.publish_parent.state).toBe('LIVE');
      expect(result.data.publish_parent.children.map((record) => record.name).sort()).toEqual(['kept', 'new']);
      expect(notices).toEqual(['child-add', 'child-update', 'child-delete', 'transition']);
    });

    it('joins registered writes and lets a callback start another transaction', async () => {
      parent.onSaveCommitted = async (record, args, ctx) => {
        expect(ctx).toBe(context);
        await api.saveObject(Child.name, { name: 'followup', parent: { id: String(record._id) } }, undefined, ctx);
        notices.push('parent');
      };
      child.onSaveCommitted = (record) => notices.push(record.name);
      const result = await run('mutation { custom(input:{name:"registered"}) { id name } }');
      expect(result.errors).toBeUndefined();
      expect(notices).toEqual(['followup', 'parent']);
    });

    it('rolls back a registered mutation that rejects after its joined lifecycle write', async () => {
      parent.onSaveCommitted = () => notices.push('parent');
      const saved = [];
      parent.onSaved = (record) => saved.push(record.name);
      const result = await run('mutation { rejectedCustom(input:{name:"rejected"}) { id } }');
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toBe('reject registered mutation after save');
      expect(saved).toEqual(['rejected']);
      expect(notices).toEqual([]);
      const rows = isMongo ? await parentModel.find().lean() : await api.getModel(Parent).find({});
      expect(rows).toEqual([]);
    });

    it.skipIf(isMongo)('joins SQL public transaction ownership without an early dispatch', async () => {
      parent.onSaveCommitted = (record) => notices.push(record.name);
      await api.withTransaction(null, async (session) => {
        await api.saveObject(Parent.name, { name: 'one' }, session, context);
        await api.saveObject(Parent.name, { name: 'two' }, session, context);
        expect(notices).toEqual([]);
      });
      expect(notices).toEqual(['one', 'two']);
    });

    it.skipIf(!isMongo)('does not observe external commit or reuse effects on a later transaction', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      parent.onSaveCommitted = (record) => notices.push(record.name);
      const session = await connection.startSession();
      try {
        session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
        await api.saveObject(Parent.name, { name: 'externally committed' }, session, context);
        expect(notices).toEqual([]);
        await session.commitTransaction();
        session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
        await api.saveObject(Parent.name, { name: 'externally aborted' }, session, context);
        await session.abortTransaction();
        expect(notices).toEqual([]);
        expect(warn).toHaveBeenCalledTimes(1);
        expect((await parentModel.find().lean()).map((record) => record.name)).toEqual(['externally committed']);
      } finally { await session.endSession(); }
    });
  });
});
