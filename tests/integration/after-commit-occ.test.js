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

describe.each(modes)('after-commit with OCC on %s', (mode) => {
  const isMongo = mode.startsWith('mongo');
  describe.skipIf(!(isMongo ? mongoURI : postgresURI))('disposable database contract', () => {
    const namespace = `commitocc_${randomUUID().replaceAll('-', '')}`;
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
      Parent = new GraphQLObjectType({ name: 'CommitDBParent', extensions: { concurrency: { mode: 'optimistic' } }, fields: () => ({
        id: { type: GraphQLID }, name: { type: GraphQLString }, state: { type: State },
        children: { type: new GraphQLList(Child), extensions: { relation: { embedded: false, connectionField: 'parentId' } } },
      }) });
      Child = new GraphQLObjectType({ name: 'CommitDBChild', extensions: { concurrency: { mode: 'optimistic' } }, fields: () => ({
        id: { type: GraphQLID }, name: { type: GraphQLString },
        parent: { type: Parent, extensions: { relation: { embedded: false, connectionField: 'parentId' } } },
      }) });
      if (isMongo) {
        connection = await mongoose.createConnection(mongoURI, { dbName: namespace, autoCreate: false, autoIndex: false }).asPromise();
        parentModel = connection.model(Parent.name, new mongoose.Schema({ name: String, state: String, version: Number }));
        childModel = connection.model(Child.name, new mongoose.Schema({ name: String, parentId: mongoose.Schema.Types.ObjectId, version: Number }));
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
      api.registerMutation('custom', '', new GraphQLInputObjectType({ name: 'CommitDBCustom', fields: { name: { type: GraphQLString } } }), Parent,
        (args, session, ctx) => api.saveObject(Parent.name, args, session, ctx));
      schema = api.createSchema();
      if (isMongo) {
        await parentModel.createCollection(); await childModel.createCollection();
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

    it('dispatches confirmed revisions and skips stale update, transition and delete', async () => {
      parent.onSaveCommitted = (record) => notices.push(['save', record.version]);
      parent.onUpdateCommitted = (record) => notices.push(['update', record.version]);
      parent.onTransitionCommitted = (record, action) => notices.push([action, record.version]);
      parent.onDeleteCommitted = (record) => notices.push(['delete', record.version]);
      const created = await add({ name: 'original' });
      expect(created.errors).toBeUndefined();
      const id = created.data.addparent.id;
      const update = (version) => run('mutation($input:CommitDBParentInputForUpdate!){updateparent(input:$input){version}}', { input: { id, version, name: 'updated' } });
      const transition = (version) => run('mutation($input:CommitDBParentInputForUpdate!){publish_parent(input:$input){version}}', { input: { id, version } });
      const remove = (version) => run(`mutation {deleteparent(id:"${id}",version:${version}){version}}`);
      for (const attempt of [update, transition, remove]) {
        expect((await attempt(2)).errors?.[0].extensions.code).toBe('VERSION_CONFLICT');
        expect(Number((await readParent(id)).version)).toBe(1);
        expect(notices).toEqual([['save', 1]]);
      }
      expect((await update(1)).errors).toBeUndefined();
      expect((await transition(2)).errors).toBeUndefined();
      expect((await remove(3)).errors).toBeUndefined();
      expect(await readParent(id)).toBeNull();
      expect(notices).toEqual([['save', 1], ['update', 2], ['publish', 3], ['delete', 3]]);
    });

    it('discards an earlier added-child notification when a later child has a stale version', async () => {
      const created = await run('mutation {addparent(input:{name:"original",children:{added:[{name:"first"}]}}){id version children{id version}}}');
      expect(created.errors).toBeUndefined();
      const saved = created.data.addparent;
      let addedCalls = 0;
      child.onSaved = () => { addedCalls++; };
      child.onSaveCommitted = (record) => notices.push(['add', record.version]);
      child.onUpdateCommitted = (record) => notices.push(['child-update', record.version]);
      parent.onUpdateCommitted = (record) => notices.push(['parent-update', record.version]);
      const update = (version) => run('mutation($input:CommitDBParentInputForUpdate!){updateparent(input:$input){version children{id name version}}}', {
        input: { id: saved.id, version: 1, name: 'changed', children: { added: [{ name: 'second' }], updated: [{ id: saved.children[0].id, version, name: 'first-updated' }] } },
      });
      expect((await update(2)).errors?.[0].extensions.code).toBe('VERSION_CONFLICT');
      expect(addedCalls).toBe(1);
      expect(notices).toEqual([]);
      expect((await readParent(saved.id)).name).toBe('original');
      const rows = isMongo ? await childModel.find().lean() : await api.getModel(Child).find({});
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('first');
      const result = await update(1);
      expect(result.errors).toBeUndefined();
      expect(result.data.updateparent.children).toHaveLength(2);
      expect(notices).toEqual([['add', 1], ['child-update', 2], ['parent-update', 2]]);
    });

    it('retains the expected revision across retries and dispatches only the committed attempt', async () => {
      const created = await add({ name: 'original' });
      expect(created.errors).toBeUndefined();
      let attempts = 0;
      parent.onUpdated = () => {
        attempts++;
        if (attempts === 1) throw Object.assign(new Error('synthetic retry'), { code: '40001', severity: 'ERROR', errorLabels: ['TransientTransactionError'] });
      };
      parent.onUpdateCommitted = (record) => notices.push(['parent', record.version]);
      child.onSaveCommitted = (record) => notices.push(['child', record.version]);
      const result = await run('mutation($input:CommitDBParentInputForUpdate!){updateparent(input:$input){version children{id version}}}', {
        input: { id: created.data.addparent.id, version: 1, children: { added: [{ name: 'once' }] } },
      });
      expect(result.errors).toBeUndefined();
      expect(attempts).toBe(2);
      expect(result.data.updateparent.version).toBe(2);
      expect(result.data.updateparent.children).toHaveLength(1);
      expect(notices).toEqual([['child', 1], ['parent', 2]]);
    });
  });
});
