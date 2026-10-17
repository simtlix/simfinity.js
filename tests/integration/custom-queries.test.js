import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  GraphQLBoolean, GraphQLID, GraphQLInputObjectType, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';
import mongoose from 'mongoose';
import pg from 'pg';
import { createRuntime, SimfinityError } from '../../packages/core/src/index.js';
import { createMongoAdapter } from '../../packages/mongodb/src/mongo/adapter.js';
import { createSQLAdapter } from '../../packages/sql/src/adapter.js';
import { postgresPlugin } from '../../packages/postgres/src/index.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

// Fail immediately if execution ends before its checkpoint; always release the checkpoint in a
// finally block, so a failed assertion does not leave a transaction waiting for the test timeout.
const reached = (checkpoint, execution) => Promise.race([
  checkpoint.promise,
  execution.then((result) => { throw new Error(`Query ended before its checkpoint: ${JSON.stringify(result)}`); }),
]);

for (const [backend, uri] of [
  ['mongo', process.env.SIMFINITY_MONGODB_URI],
  ['postgres', process.env.SIMFINITY_POSTGRES_URI],
]) {
  describe.skipIf(!uri)(`${backend} registered custom query reads`, () => {
    const namespace = `custom_queries_${randomUUID().replaceAll('-', '')}`;
    const prefix = backend === 'mongo' ? 'CqMongo' : 'CqPostgres';
    let pool; let adapter; let runtime; let schema; let flatModel; let ownedModel; let flatId; let ownedId;
    let storageReady = false;
    const statements = [];
    const commands = [];
    const hooks = [];
    const onCommand = (event) => commands.push(event);
    const inputType = `${prefix}ReadInput`;
    const selection = 'first second marker actor lines';
    const execute = (source, variableValues, contextValue = {}) => graphql({ schema, source, variableValues, contextValue });
    const query = (transactional, input, context = {}) => execute(
      `query($input:${inputType}!){read${transactional ? 'Transactional' : 'Plain'}(input:$input){${selection}}}`,
      { input }, context,
    );
    const read = (model, id, session) => backend === 'mongo'
      ? model.findById(id).session(session)
      : model.findById(id, { session });
    const assertClosed = (session) => {
      expect(session.inTransaction()).toBe(false);
      if (backend === 'mongo') expect(session.hasEnded).toBe(true);
    };
    const resetLogs = () => { statements.length = 0; commands.length = 0; hooks.length = 0; };

    beforeAll(async () => {
      const Flat = new GraphQLObjectType({
        name: `${prefix}Flat`, fields: { id: { type: GraphQLID }, name: { type: GraphQLString } },
      });
      const Line = new GraphQLObjectType({
        name: `${prefix}Line`,
        fields: {
          label: { type: GraphQLString },
          target: { type: Flat, extensions: { relation: { embedded: false } } },
        },
      });
      const Owned = new GraphQLObjectType({
        name: `${prefix}Owned`,
        fields: {
          id: { type: GraphQLID }, name: { type: GraphQLString },
          lines: { type: new GraphQLList(Line), extensions: { relation: { embedded: true } } },
        },
      });
      if (backend === 'mongo') {
        adapter = createMongoAdapter();
        const withReadHook = (definition) => {
          const definitionSchema = new mongoose.Schema(definition);
          definitionSchema.pre('findOne', function () { hooks.push(this.getOptions().session ?? null); });
          return definitionSchema;
        };
        flatModel = mongoose.model(Flat.name, withReadHook({ name: String }));
        ownedModel = mongoose.model(Owned.name, withReadHook({
          name: String, lines: [{ label: String, target: { type: mongoose.Schema.Types.ObjectId, ref: Flat.name } }],
        }));
      } else {
        pool = new pg.Pool({ connectionString: uri });
        pool.on('connect', (client) => {
          const nativeQuery = client.query.bind(client);
          client.query = (...args) => {
            statements.push({ client, text: typeof args[0] === 'string' ? args[0] : args[0].text });
            return nativeQuery(...args);
          };
        });
        adapter = createSQLAdapter(postgresPlugin({ pool, schema: namespace }));
      }
      runtime = createRuntime(adapter);
      if (backend === 'mongo') runtime.preventCreatingCollection(true);
      runtime.connect(flatModel, Flat, 'flat', 'flats');
      runtime.addNoEndpointType(Line);
      runtime.connect(ownedModel, Owned, 'owned', 'owneds');
      const Input = new GraphQLInputObjectType({
        name: inputType,
        fields: {
          id: { type: new GraphQLNonNull(GraphQLID) }, marker: { type: GraphQLString }, owned: { type: GraphQLBoolean },
        },
      });
      const Output = new GraphQLObjectType({
        name: `${prefix}ReadResult`,
        fields: {
          first: { type: GraphQLString }, second: { type: GraphQLString }, marker: { type: GraphQLString },
          actor: { type: GraphQLString }, lines: { type: new GraphQLList(GraphQLString) },
        },
      });
      const callback = async (input, session, context) => {
        context.calls.push({ input, session, context, active: session?.inTransaction() ?? false });
        const model = input.owned ? ownedModel : flatModel;
        const first = await read(model, input.id, session);
        if (context.afterFirstRead) await context.afterFirstRead(input, session);
        if (input.marker === 'reject') throw new SimfinityError('Custom read rejected', 'CUSTOM_READ_REJECTED', 400);
        const second = await read(model, input.id, session);
        return { first: first.name, second: second.name, marker: input.marker, actor: context.user.name, lines: (second.lines || []).map((line) => line.label) };
      };
      runtime.registerQuery('readTransactional', 'Two native reads in one transaction', Input, Output, callback, { transactional: true });
      runtime.registerQuery('readPlain', 'Two native reads without a custom-query transaction', Input, Output, callback);
      schema = runtime.createSchema();
      if (backend === 'mongo') {
        await mongoose.connect(uri, { dbName: namespace, monitorCommands: true });
        mongoose.connection.getClient().on('commandStarted', onCommand);
        await Promise.all([flatModel, ownedModel].map(async (model) => { await model.createCollection(); await model.init(); }));
      } else {
        flatModel = runtime.getModel(Flat);
        ownedModel = runtime.getModel(Owned);
        await adapter.initialize();
      }
      storageReady = true;
    }, 30000);

    beforeEach(async () => {
      const flat = await flatModel.create({ name: 'before' });
      flatId = String(flat.id);
      const owned = await ownedModel.create({ name: 'before', lines: [{ label: 'retained', target: flatId }] });
      ownedId = String(owned.id);
      resetLogs();
    });

    afterAll(async () => {
      if (backend === 'mongo') {
        if (mongoose.connection.readyState) {
          mongoose.connection.getClient().off('commandStarted', onCommand);
          await mongoose.connection.dropDatabase();
          await mongoose.disconnect();
        }
        for (const name of [`${prefix}Flat`, `${prefix}Owned`]) if (mongoose.models[name]) mongoose.deleteModel(name);
      }
      if (pool) {
        if (storageReady) await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
        await pool.end();
      }
    });

    it.each([true, false])('passes input/context and preserves repeated native reads (transactional: %s)', async (transactional) => {
      const input = { id: flatId, marker: 'unchanged' };
      const context = { calls: [], user: { name: 'reader' } };
      const result = await query(transactional, input, context);
      expect(result.errors).toBeUndefined();
      expect(result.data[`read${transactional ? 'Transactional' : 'Plain'}`]).toEqual({
        first: 'before', second: 'before', marker: 'unchanged', actor: 'reader', lines: [],
      });
      expect(input).toEqual({ id: flatId, marker: 'unchanged' });
      expect(context.calls).toHaveLength(1);
      expect(context.calls[0].input).toEqual(input);
      expect(context.calls[0].context).toBe(context);
      expect(context.calls[0].active).toBe(transactional);
      const { session } = context.calls[0];
      if (transactional) assertClosed(session);
      else expect(session).toBeNull();
      if (backend === 'mongo') {
        expect(hooks).toEqual([session, session]);
        const reads = commands.filter((event) => event.commandName === 'find');
        expect(reads).toHaveLength(2);
        expect(reads.map((event) => event.command.autocommit)).toEqual(transactional ? [false, false] : [undefined, undefined]);
        expect(commands.filter((event) => event.commandName === 'commitTransaction')).toHaveLength(transactional ? 1 : 0);
      } else {
        expect(statements.map(({ text }) => text.split(' ')[0])).toEqual(transactional ? ['BEGIN', 'SELECT', 'SELECT', 'COMMIT'] : ['SELECT', 'SELECT']);
        if (transactional) expect(new Set(statements.map(({ client }) => client)).size).toBe(1);
      }
    });

    it('keeps native owned-record read transactions when the custom query is nontransactional', async () => {
      const context = { calls: [], user: { name: 'reader' } };
      const result = await query(false, { id: ownedId, owned: true }, context);
      expect(result.errors).toBeUndefined();
      expect(result.data.readPlain).toMatchObject({ first: 'before', second: 'before', lines: ['retained'] });
      expect(context.calls[0].session).toBeNull();
      if (backend === 'mongo') {
        expect(hooks).toEqual([null, null]);
        expect(commands.filter((event) => event.commandName === 'find')).toHaveLength(2);
        expect(commands.some((event) => event.command.autocommit === false)).toBe(false);
      } else {
        expect(statements.map(({ text }) => text.split(' ')[0])).toEqual([
          'BEGIN', 'SELECT', 'SELECT', 'COMMIT', 'BEGIN', 'SELECT', 'SELECT', 'COMMIT',
        ]);
      }
    });

    it.each([true, false])('retains backend read visibility across an external commit (transactional: %s)', async (transactional) => {
      const started = deferred();
      const resume = deferred();
      const context = {
        calls: [], user: { name: 'reader' },
        afterFirstRead: async () => { started.resolve(); await resume.promise; },
      };
      const execution = query(transactional, { id: flatId }, context);
      try {
        await reached(started, execution);
        // The test's independent writer commits between the reads. The registered query only reads.
        if (backend === 'mongo') await flatModel.updateOne({ _id: flatId }, { $set: { name: 'after' } });
        else await flatModel.update(flatId, { name: 'after' });
      } finally { resume.resolve(); await execution; }
      const result = await execution;
      expect(result.errors).toBeUndefined();
      expect(result.data[`read${transactional ? 'Transactional' : 'Plain'}`]).toMatchObject({ first: 'before', second: transactional ? 'before' : 'after' });
      if (transactional) assertClosed(context.calls[0].session);
    });

    it('runs sibling query roots in independent sessions and releases the failed root without aborting the other', async () => {
      const bothStarted = deferred();
      const resume = deferred();
      let arrivals = 0;
      const context = {
        calls: [], user: { name: 'reader' },
        afterFirstRead: async () => { if (++arrivals === 2) bothStarted.resolve(); await resume.promise; },
      };
      const execution = execute(`query($id:ID!){
        failed:readTransactional(input:{id:$id,marker:"reject"}){${selection}}
        succeeded:readTransactional(input:{id:$id,marker:"ok"}){${selection}}
      }`, { id: flatId }, context);
      try {
        await reached(bothStarted, execution);
        expect(context.calls).toHaveLength(2);
        expect(context.calls[0].session).not.toBe(context.calls[1].session);
        expect(context.calls.every(({ session }) => session.inTransaction())).toBe(true);
      } finally { resume.resolve(); await execution; }
      const result = await execution;
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toMatchObject({ path: ['failed'], extensions: { code: 'CUSTOM_READ_REJECTED' } });
      expect(result.data.failed).toBeNull();
      expect(result.data.succeeded).toMatchObject({ first: 'before', second: 'before', marker: 'ok' });
      context.calls.forEach(({ session }) => assertClosed(session));
      if (backend === 'mongo') {
        expect(commands.filter((event) => event.commandName === 'abortTransaction')).toHaveLength(1);
        expect(commands.filter((event) => event.commandName === 'commitTransaction')).toHaveLength(1);
      } else {
        expect(statements.filter(({ text }) => text === 'ROLLBACK')).toHaveLength(1);
        expect(statements.filter(({ text }) => text === 'COMMIT')).toHaveLength(1);
      }
      const next = await query(true, { id: flatId }, { calls: [], user: { name: 'next' } });
      expect(next.errors).toBeUndefined();
      expect(next.data.readTransactional.second).toBe('before');
    });
  });
}
