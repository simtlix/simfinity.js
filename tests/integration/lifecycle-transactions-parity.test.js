// #151 §8 "Both disposable engines": the lifecycle helpers (updateObject, deleteObject, transitionObject)
// and the generated transaction field on real databases: MongoDB with referentialIntegrity 'off' and
// 'transactional', and PostgreSQL. Every test builds its own runtime and types. MongoDB fixtures share one
// database and PostgreSQL fixtures get one schema each; both are dropped at the end. The assertions read
// stored documents and rows, versions, and the code, status, message and position of errors; never timing.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  GraphQLEnumType, GraphQLID, GraphQLInt, GraphQLList, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';
import mongoose from 'mongoose';
import pg from 'pg';
import { buildErrorFormatter, createRuntime } from '../../packages/core/src/index.js';
import { createMongoAdapter } from '../../packages/mongodb/src/mongo/adapter.js';
import { createSQLAdapter } from '../../packages/sql/src/adapter.js';
import { postgresPlugin } from '../../packages/postgres/src/index.js';

const mongoUri = process.env.SIMFINITY_MONGODB_URI;
const postgresUri = process.env.SIMFINITY_POSTGRES_URI;
const namespace = `ltparity_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const OPTIMISTIC = { mode: 'optimistic' };
const STRING_KEY = 'pass the ID as a string, for example String(record._id)';
// The options a session supplied to MongoDB's transactional integrity mode must carry.
const transactionOptions = { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } };
// A serialization failure that the PostgreSQL server raises, as the adapter suites inject it. It is a
// stand-in for a native one: the server raises 40001 from a statement of a hook, whatever the rows hold,
// so the retry cases check the adapter's retries and the position of the final error, not PostgreSQL's
// own conflict detection. Native write conflicts are covered at root level by
// tests/integration/optimistic-concurrency-parity.test.js, whose races use tests/helpers/controlled-race.js.
const RAISE_40001 = 'DO $$ BEGIN RAISE EXCEPTION \'serialization failure\' USING ERRCODE = \'40001\'; END $$';
const RETRY_EXCEEDED = { code: 'TRANSACTION_RETRY_EXCEEDED', status: 409, message: 'Concurrent write could not be completed' };
const UNPOSITIONED = { operationIndex: undefined, operation: undefined };
// Each test builds a runtime and, on PostgreSQL, a schema, and some retry up to six attempts, so the
// vitest default of 5 s is too tight under load. The hooks open and drop the databases.
const TEST_TIMEOUT = 30000;
const HOOK_TIMEOUT = 60000;
const schemas = [];
const models = [];
let pool;
let sequence = 0;

const backends = [
  { name: 'mongo', enabled: !!mongoUri },
  { name: 'mongo-transactional', enabled: !!mongoUri },
  { name: 'postgres', enabled: !!postgresUri },
];

beforeAll(async () => {
  // Independent from the other suites' databases, which own their own cleanup.
  if (mongoUri) await mongoose.connect(mongoUri, { dbName: `${new URL(mongoUri).pathname.slice(1)}_lt_parity` });
  if (postgresUri) pool = new pg.Pool({ connectionString: postgresUri, max: 6 });
}, HOOK_TIMEOUT);
afterAll(async () => {
  for (const Model of models) mongoose.deleteModel(Model.modelName);
  if (mongoUri) {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
  if (pool) {
    for (const schema of schemas) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    await pool.end();
  }
}, HOOK_TIMEOUT);

const ok = (result) => {
  expect(result.errors).toBeUndefined();
  return Object.values(result.data)[0];
};
// The single error of a GraphQL result: its code, status and message, and the operation it names.
const failure = (result) => {
  expect(result.errors).toHaveLength(1);
  const [error] = result.errors;
  const extensions = error.originalError?.extensions ?? error.extensions;
  return {
    code: extensions?.code,
    status: extensions?.status,
    message: error.message,
    operationIndex: extensions?.operationIndex,
    operation: extensions?.operation,
  };
};
// The extensions a client receives for the single error of a result, through the error formatter, without
// the timestamp it adds.
const formatted = (result) => {
  const { timestamp, ...extensions } = buildErrorFormatter()(result.errors[0]).extensions;
  expect(typeof timestamp).toBe('string');
  return extensions;
};
// The code, status and message a helper call rejects with.
const rejection = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return { code: error.extensions?.code, status: error.extensions?.status, message: error.message };
  }
  throw new Error('Expected a rejection');
};
const invalidKey = (path) => ({ code: 'INVALID_INPUT', status: 400, message: `Invalid input at ${path}: ${STRING_KEY}` });
const conflict = (type, id) => ({ code: 'VERSION_CONFLICT', status: 409, message: `${type.name} ${id} was modified by another operation` });
const idOf = (record) => String(record._id ?? record.id);
const oid = (id) => new mongoose.Types.ObjectId(id);

// Tag (unprotected), Child (protected) and Parent (protected, with a state machine whose `close` action
// goes from OPEN to CLOSED, a reference to a Tag and a collection of Children). Every hook and the action
// add their name to `events` and their arguments to `calls`; `hooks` lets a test act inside them. Every
// global middleware run adds `middleware <operation> <role>`. `transaction` adds the generated field,
// for every type; without it the schema is the one the helpers run on.
const fixture = async (backend, { transaction = false } = {}) => {
  const sql = backend.name === 'postgres';
  const prefix = `LtParity${sequence++}`;
  const dbSchema = `${namespace}_${sequence}`;
  const driverHooks = {};
  const plugin = sql ? postgresPlugin({ pool, schema: dbSchema }) : null;
  const adapter = sql
    ? createSQLAdapter({
      ...plugin,
      driver: {
        ...plugin.driver,
        async commit(client) {
          await driverHooks.beforeCommit?.(client);
          return plugin.driver.commit(client);
        },
      },
    })
    : createMongoAdapter({ referentialIntegrity: backend.name === 'mongo-transactional' ? 'transactional' : 'off' });
  const runtime = createRuntime(adapter);
  const hooks = {};
  const events = [];
  const calls = [];
  const note = async (name, params) => {
    events.push(name);
    calls.push({ name, ...params });
    return hooks[name]?.(params);
  };
  const controller = (role) => ({
    onSaving: (record, args, session, context) => note(`${role}.onSaving`, { record, args, session, context }),
    onSaved: (record, args, session, context) => note(`${role}.onSaved`, { record, args, session, context }),
    onUpdating: (id, changes, session, context) => note(`${role}.onUpdating`, { id, changes, session, context }),
    onUpdated: (record, session, context) => note(`${role}.onUpdated`, { record, session, context }),
    onDelete: (record, session, context) => note(`${role}.onDelete`, { record, session, context }),
  });
  const State = new GraphQLEnumType({ name: `${prefix}State`, values: { OPEN: {}, CLOSED: {} } });
  const Tag = new GraphQLObjectType({
    name: `${prefix}Tag`, fields: { id: { type: GraphQLID }, label: { type: GraphQLString } },
  });
  const Child = new GraphQLObjectType({
    name: `${prefix}Child`,
    extensions: { concurrency: OPTIMISTIC },
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      amount: { type: GraphQLInt },
      parent: { type: Parent, extensions: { relation: { connectionField: 'parent' } } },
    }),
  });
  const Parent = new GraphQLObjectType({
    name: `${prefix}Parent`,
    extensions: { concurrency: OPTIMISTIC },
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      state: { type: State },
      tag: { type: Tag, extensions: { relation: { connectionField: 'tag' } } },
      children: { type: new GraphQLList(Child), extensions: { relation: { connectionField: 'parent' } } },
    }),
  });
  const types = { tag: Tag, child: Child, parent: Parent };
  const roleOf = (gqltype) => Object.keys(types).find((role) => types[role] === gqltype);
  runtime.use(async (params, next) => {
    events.push(`middleware ${params.operation} ${roleOf(params.type.gqltype)}`);
    await next();
  });
  if (!sql) runtime.preventCreatingCollection(true);
  runtime.connect(null, Tag, 'tag', 'tags', controller('tag'));
  runtime.connect(null, Child, 'child', 'children', controller('child'));
  runtime.connect(null, Parent, 'parent', 'parents', controller('parent'), null, {
    initialState: { name: 'OPEN', value: 'OPEN' },
    actions: {
      close: {
        from: { name: 'OPEN', value: 'OPEN' },
        to: { name: 'CLOSED', value: 'CLOSED' },
        action: (args, session) => note('parent.close', { args, session }),
      },
    },
  });
  const schema = runtime.createSchema(null, null, null,
    transaction ? { transaction: { types: [Parent, Child, Tag] } } : undefined);
  if (sql) {
    schemas.push(dbSchema);
    await adapter.initialize();
  } else {
    for (const { model } of runtime.getRegistrations()) {
      if (model && !models.includes(model)) {
        models.push(model);
        await model.createCollection();
        await model.init();
      }
    }
    await adapter.initialize();
  }
  const model = Object.fromEntries(Object.entries(types).map(([role, type]) => [role, runtime.getModel(type)]));
  const run = (source, variableValues, context = {}) => graphql({
    schema, source, variableValues, contextValue: context,
  });
  const transact = (operations, selection = 'id') => run(
    `mutation($operations: [TransactionOperation!]!) { transaction(operations: $operations) { ${selection} } }`,
    { operations },
  );
  const addTag = async (label) => ok(await run(
    `mutation($input: ${Tag.name}Input!) { addtag(input: $input) { id label } }`, { input: { label } },
  ));
  const addParent = async (input = {}) => ok(await run(
    `mutation($input: ${Parent.name}Input!) { addparent(input: $input) { id version state children { id name version } } }`,
    { input: { name: 'seeded', ...input } },
  ));
  // A stored document or row, as the database holds it.
  const raw = async (role, id) => (sql
    ? (await pool.query(`SELECT * FROM "${dbSchema}"."${types[role].name}" WHERE id = $1`, [id])).rows[0] ?? null
    : model[role].collection.findOne({ _id: oid(id) }));
  // How many stored tags carry `label`.
  const countTags = async (label) => (sql
    ? (await pool.query(`SELECT count(*)::int AS count FROM "${dbSchema}"."${Tag.name}" WHERE label = $1`, [label])).rows[0].count
    : model.tag.collection.countDocuments({ label }));
  // Every table of the fixture's schema, or every collection of its models, as stored. Called after
  // seed(), so every type has stored data, which a comparison of two dumps must not miss.
  const dump = async () => {
    const stored = {};
    if (sql) {
      const { rows: tables } = await pool.query(
        'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name', [dbSchema],
      );
      for (const { table_name: table } of tables) {
        const { rows } = await pool.query(`SELECT row_to_json(t)::text AS row FROM "${dbSchema}"."${table}" t ORDER BY 1`);
        stored[table] = rows.map(({ row }) => row);
      }
    } else {
      for (const Model of Object.values(model)) {
        stored[Model.modelName] = (await Model.collection.find({}).sort({ _id: 1 }).toArray())
          .map((document) => mongoose.mongo.BSON.EJSON.stringify(document));
      }
    }
    for (const type of Object.values(types)) expect(stored[type.name]?.length, type.name).toBeGreaterThan(0);
    return stored;
  };
  // A linked tag, a spare tag and a parent with two children, `first` and `second`, all at version 1.
  const seed = async () => {
    const tag = await addTag('linked');
    const spare = await addTag('spare');
    const parent = await addParent({
      tag: { id: tag.id }, children: { added: [{ name: 'first', amount: 1 }, { name: 'second', amount: 2 }] },
    });
    const child = (name) => parent.children.find((entry) => entry.name === name);
    events.length = 0;
    calls.length = 0;
    return {
      tag, spare, parent, first: child('first'), second: child('second'),
    };
  };
  return {
    ...backend,
    sql,
    adapter,
    runtime,
    schema,
    driverHooks,
    hooks,
    events,
    calls,
    model,
    Tag,
    Child,
    Parent,
    run,
    transact,
    addTag,
    addParent,
    raw,
    countTags,
    dump,
    seed,
    missing: () => (sql ? randomUUID() : String(new mongoose.Types.ObjectId())),
  };
};

// Replaces the commit of every MongoDB session started from now on: `commit(real)` runs instead, where
// `real` commits. The adapter starts its sessions on the default connection, as the adapter suites spy it.
const interceptCommits = (commit) => {
  const startSession = mongoose.connection.startSession.bind(mongoose.connection);
  return vi.spyOn(mongoose.connection, 'startSession').mockImplementation(async (...args) => {
    const session = await startSession(...args);
    const real = session.commitTransaction.bind(session);
    session.commitTransaction = (...commitArgs) => commit(() => real(...commitArgs));
    return session;
  });
};
// A commit whose outcome the driver could not learn.
const lostCommit = () => {
  const error = new mongoose.mongo.MongoServerError({ message: 'Lost commit response' });
  error.addErrorLabel('UnknownTransactionCommitResult');
  return error;
};

// A conflict in the operation that updates the tag `tagId`, on the attempts `conflictsOn(attempt)`
// selects; the attempts are counted by the add of a tag that each list starts with. On MongoDB, a
// WriteConflict from another transaction's uncommitted write to that tag, released once an attempt should
// not conflict; on PostgreSQL, a serialization failure (40001) that the server raises in the update's hook.
const injectConflict = async (f, tagId, conflictsOn) => {
  let attempt = 0;
  let blocker = null;
  if (!f.sql) {
    blocker = await mongoose.startSession();
    blocker.startTransaction();
    await f.model.tag.collection.updateOne({ _id: oid(tagId) }, { $set: { label: 'blocking' } }, { session: blocker });
  }
  f.hooks['tag.onSaving'] = async () => {
    attempt++;
    if (blocker?.inTransaction() && !conflictsOn(attempt)) await blocker.abortTransaction();
  };
  f.hooks['tag.onUpdating'] = async ({ session }) => {
    if (f.sql && conflictsOn(attempt)) await session.query(RAISE_40001);
  };
  return {
    attempts: () => attempt,
    async release() {
      if (!blocker) return;
      if (blocker.inTransaction()) await blocker.abortTransaction();
      await blocker.endSession();
    },
  };
};

// A commit that fails on every attempt that reaches it: on MongoDB, with an unknown outcome, which the
// adapter retries alone; on PostgreSQL, with a serialization failure (40001) that the server raises.
const failCommits = (f) => {
  let commits = 0;
  let spy = null;
  if (f.sql) {
    f.driverHooks.beforeCommit = async (client) => {
      commits++;
      await client.query(RAISE_40001);
    };
  } else {
    spy = interceptCommits(async () => {
      commits++;
      throw lostCommit();
    });
  }
  return {
    commits: () => commits,
    restore() {
      spy?.mockRestore();
      delete f.driverHooks.beforeCommit;
    },
  };
};

for (const backend of backends) {
  describe.skipIf(!backend.enabled)(`lifecycle helpers parity: ${backend.name}`, { timeout: TEST_TIMEOUT }, () => {
    test('a helper with an external session writes in the caller transaction, which an early input error leaves usable', async () => {
      const f = await fixture(backend);
      const { parent, first, spare } = await f.seed();
      const context = { request: 'external' };
      let caller;
      const results = await f.adapter.withTransaction(null, async (session) => {
        caller = session;
        const updated = await f.runtime.updateObject(f.Parent.name, { id: parent.id, version: 1, name: 'renamed' }, session, context);
        // Nothing is committed before the caller's transaction is.
        expect((await f.raw('parent', parent.id)).name).toBe('seeded');
        expect(await rejection(f.runtime.updateObject(f.Parent.name, { id: { $ne: null }, version: 2 }, session, context)))
          .toEqual(invalidKey('input.id'));
        const closed = await f.runtime.transitionObject(f.Parent.name, 'close', { id: parent.id, version: 2 }, session, context);
        const child = await f.runtime.deleteObject(f.Child.name, { id: first.id, version: 1 }, session, context);
        const tag = await f.runtime.deleteObject(f.Tag.name, { id: spare.id }, session, context);
        return {
          updated, closed, child, tag,
        };
      });
      expect([results.updated.name, results.updated.version]).toEqual(['renamed', 2]);
      expect([results.closed.state, results.closed.version]).toEqual(['CLOSED', 3]);
      expect([idOf(results.child), results.child.version]).toEqual([first.id, 1]);
      expect([idOf(results.tag), results.tag.label]).toEqual([spare.id, 'spare']);
      expect(f.events).toEqual([
        'parent.onUpdating', 'parent.onUpdated', 'parent.close', 'parent.onUpdating', 'parent.onUpdated',
        'child.onDelete', 'tag.onDelete',
      ]);
      expect(f.calls.every((call) => call.session === caller)).toBe(true);
      // Every hook receives the caller's context; only the action's callback, `(args, session)`, takes none.
      expect(f.calls.map((call) => call.name)).toEqual(f.events);
      for (const call of f.calls) {
        expect(call.context, call.name).toBe(call.name === 'parent.close' ? undefined : context);
      }
      const stored = await f.raw('parent', parent.id);
      expect([stored.name, stored.state, Number(stored.version)]).toEqual(['renamed', 'CLOSED', 3]);
      expect(await f.raw('child', first.id)).toBeNull();
      expect(await f.raw('tag', spare.id)).toBeNull();
    });

    test('a late failure inside the caller transaction rolls back everything the caller wrote', async () => {
      const f = await fixture(backend);
      const {
        parent, first, second, spare,
      } = await f.seed();
      const before = await f.dump();
      let saved;
      await expect(f.adapter.withTransaction(null, async (session) => {
        saved = await f.runtime.saveObject(f.Tag.name, { label: 'saved' }, session);
        await f.runtime.updateObject(f.Parent.name, {
          id: parent.id,
          version: 1,
          name: 'changed',
          children: {
            added: [{ name: 'third', amount: 3 }],
            updated: [{ id: first.id, version: 1, name: 'changed' }],
            deleted: [{ id: second.id, version: 1 }],
          },
        }, session);
        await f.runtime.transitionObject(f.Parent.name, 'close', { id: parent.id, version: 2 }, session);
        await f.runtime.deleteObject(f.Tag.name, { id: spare.id }, session);
        throw new Error('late failure');
      })).rejects.toThrow('late failure');
      // Every write ran before the failure.
      expect(f.events).toEqual(expect.arrayContaining([
        'tag.onSaved', 'child.onSaved', 'child.onUpdated', 'child.onDelete', 'parent.onUpdated', 'parent.close', 'tag.onDelete',
      ]));
      expect(await f.raw('tag', idOf(saved))).toBeNull();
      expect(await f.dump()).toEqual(before);
    });

    test('nested and state hooks run with the helper input, and the nested writes are stored', async () => {
      const f = await fixture(backend);
      const { parent, first, second } = await f.seed();
      const context = { request: 'nested' };
      const updated = await f.runtime.updateObject(f.Parent.name, {
        id: parent.id,
        version: 1,
        name: 'nested',
        children: {
          added: [{ name: 'third', amount: 3 }],
          updated: [{ id: first.id, version: 1, amount: 10 }],
          deleted: [{ id: second.id, version: 1 }],
        },
      }, undefined, context);
      expect([updated.name, updated.version]).toEqual(['nested', 2]);
      // The root record skips global middleware, as saveObject does; nested entries keep theirs.
      expect(f.events).toEqual([
        'parent.onUpdating',
        'middleware save child', 'child.onSaving', 'child.onSaved',
        'middleware update child', 'child.onUpdating', 'child.onUpdated',
        'middleware delete child', 'child.onDelete',
        'parent.onUpdated',
      ]);
      expect(new Set(f.calls.map((call) => call.session)).size).toBe(1);
      expect(f.calls.every((call) => call.context === context)).toBe(true);
      expect(f.calls.find((call) => call.name === 'child.onDelete').record.version).toBe(1);
      const storedFirst = await f.raw('child', first.id);
      expect([storedFirst.amount, Number(storedFirst.version)]).toEqual([10, 2]);
      expect(await f.raw('child', second.id)).toBeNull();
      const read = ok(await f.run(`{ parent(id: "${parent.id}") { name version children { name version parent { id } } } }`));
      expect(read.children.sort((a, b) => a.name.localeCompare(b.name))).toEqual([
        { name: 'first', version: 2, parent: { id: parent.id } },
        { name: 'third', version: 1, parent: { id: parent.id } },
      ]);
      expect(Number((await f.raw('parent', parent.id)).version)).toBe(2);

      f.events.length = 0;
      f.calls.length = 0;
      const closed = await f.runtime.transitionObject(f.Parent.name, 'close', { id: parent.id, version: 2 }, undefined, context);
      expect([closed.state, closed.version]).toEqual(['CLOSED', 3]);
      expect(f.events).toEqual(['parent.close', 'parent.onUpdating', 'parent.onUpdated']);
      expect(f.calls[0].args).toMatchObject({ id: parent.id, version: 2 });
      expect(f.calls[0].session).toBe(f.calls[1].session);
      const stored = await f.raw('parent', parent.id);
      expect([stored.state, Number(stored.version)]).toEqual(['CLOSED', 3]);
      expect(await rejection(f.runtime.transitionObject(f.Parent.name, 'close', { id: parent.id, version: 3 })))
        .toEqual({ code: 'BAD_REQUEST', status: 400, message: 'Action is not allowed from state CLOSED' });
      expect(Number((await f.raw('parent', parent.id)).version)).toBe(3);
    });

    test('an OCC conflict keeps the stored version', async () => {
      const f = await fixture(backend);
      const { parent, first } = await f.seed();
      await f.runtime.updateObject(f.Parent.name, { id: parent.id, version: 1, name: 'current' });
      expect(await rejection(f.runtime.updateObject(f.Parent.name, { id: parent.id, version: 1, name: 'stale' })))
        .toEqual(conflict(f.Parent, parent.id));
      expect(await rejection(f.runtime.transitionObject(f.Parent.name, 'close', { id: parent.id, version: 1 })))
        .toEqual(conflict(f.Parent, parent.id));
      expect(await rejection(f.runtime.deleteObject(f.Parent.name, { id: parent.id, version: 1 })))
        .toEqual(conflict(f.Parent, parent.id));
      // A stale child rolls back the parent's write.
      expect(await rejection(f.runtime.updateObject(f.Parent.name, {
        id: parent.id, version: 2, name: 'stale child', children: { updated: [{ id: first.id, version: 2, amount: 9 }] },
      }))).toEqual(conflict(f.Child, first.id));
      const stored = await f.raw('parent', parent.id);
      expect([stored.name, stored.state, Number(stored.version)]).toEqual(['current', 'OPEN', 2]);
      const storedFirst = await f.raw('child', first.id);
      expect([storedFirst.amount, Number(storedFirst.version)]).toEqual([1, 1]);
    });

    test('D1: { $ne: null } in a record key gives INVALID_INPUT and changes no document', async () => {
      const f = await fixture(backend);
      const { parent } = await f.seed();
      // With integrity off, MongoDB's by-ID reads hand the key to the driver uncast, where this selector
      // matches a stored record: the helpers must refuse it before any read.
      if (backend.name === 'mongo') expect(await f.adapter.getById(f.model.tag, { $ne: null })).not.toBeNull();
      const before = await f.dump();
      const key = { $ne: null };
      const calls = [
        ['input.id', () => f.runtime.updateObject(f.Parent.name, { id: key, version: 1, name: 'any' })],
        ['input.id', () => f.runtime.updateObject(f.Tag.name, { id: key, label: 'any' })],
        ['input.id', () => f.runtime.transitionObject(f.Parent.name, 'close', { id: key, version: 1 })],
        ['input.id', () => f.runtime.deleteObject(f.Parent.name, { id: key, version: 1 })],
        ['input.id', () => f.runtime.deleteObject(f.Tag.name, { id: key })],
        ['input.children.updated[0].id', () => f.runtime.updateObject(f.Parent.name, {
          id: parent.id, version: 1, children: { updated: [{ id: key, version: 1, name: 'any' }] },
        })],
        ['input.children.deleted[0].id', () => f.runtime.updateObject(f.Parent.name, {
          id: parent.id, version: 1, children: { deleted: [{ id: key, version: 1 }] },
        })],
        ['input.tag.id', () => f.runtime.updateObject(f.Parent.name, { id: parent.id, version: 1, tag: { id: key } })],
      ];
      for (const [path, call] of calls) expect(await rejection(call())).toEqual(invalidKey(path));
      expect(f.events).toEqual([]);
      expect(await f.dump()).toEqual(before);
    });

    if (backend.name === 'mongo-transactional') {
      test.each([
        ['a reference to a missing record', (f, { parent }) => (session) => f.runtime.updateObject(
          f.Parent.name, { id: parent.id, version: 1, tag: { id: f.missing() } }, session,
        )],
        ['a delete of a referenced record', (f, { parent }) => (session) => f.runtime.deleteObject(
          f.Parent.name, { id: parent.id, version: 1 }, session,
        )],
      ])('a protected write that fails inside a supplied session aborts it: %s', async (_, writeOf) => {
        const f = await fixture(backend);
        const seeded = await f.seed();
        const write = writeOf(f, seeded);
        const before = await f.dump();
        const session = await mongoose.startSession();
        try {
          session.startTransaction(transactionOptions);
          const earlier = await f.runtime.saveObject(f.Tag.name, { label: 'earlier' }, session);
          expect(await rejection(write(session))).toMatchObject({ code: 'REFERENCE_CONSTRAINT_VIOLATION', status: 409 });
          expect(session.inTransaction()).toBe(false);
          await expect(session.commitTransaction()).rejects.toThrow();
          expect(await f.raw('tag', idOf(earlier))).toBeNull();
        } finally {
          await session.endSession();
        }
        expect(await f.dump()).toEqual(before);
      });
    }
  });

  describe.skipIf(!backend.enabled)(`transaction parity: ${backend.name}`, { timeout: TEST_TIMEOUT }, () => {
    test('an add, references, an update, an action and deletes commit together', async () => {
      const f = await fixture(backend, { transaction: true });
      const { first, spare } = await f.seed();
      const result = await f.transact([
        { addtag: { label: 'new' } },
        { addparent: { name: 'created', tag: { id: '$0' }, children: { added: [{ name: 'nested', amount: 1 }] } } },
        { addchild: { name: 'linked', amount: 2, parent: { id: '$1' } } },
        { updateparent: { id: '$1', version: 1, name: 'updated' } },
        { close_parent: { id: '$1', version: 2 } },
        { deletechild: { id: first.id, version: 1 } },
        { deletetag: { id: spare.id } },
      ], 'id addtag { id label } addparent { id version tag { id } } addchild { id parent { id } } '
        + 'updateparent { id name version } close_parent { id state version } deletechild { id name } deletetag { id label }');
      const items = ok(result);
      const [tag, parent, child] = items.map((item) => item.id);
      // Each result sets only the field of its own operation.
      expect(items.map((item) => Object.keys(item).filter((key) => key !== 'id' && item[key] !== null))).toEqual([
        ['addtag'], ['addparent'], ['addchild'], ['updateparent'], ['close_parent'], ['deletechild'], ['deletetag'],
      ]);
      expect(items[0].addtag).toEqual({ id: tag, label: 'new' });
      expect(items[1].addparent).toEqual({ id: parent, version: 1, tag: { id: tag } });
      expect(items[2].addchild).toEqual({ id: child, parent: { id: parent } });
      expect(items[3]).toMatchObject({ id: parent, updateparent: { id: parent, name: 'updated', version: 2 } });
      expect(items[4]).toMatchObject({ id: parent, close_parent: { id: parent, state: 'CLOSED', version: 3 } });
      expect(items[5]).toMatchObject({ id: first.id, deletechild: { id: first.id, name: 'first' } });
      expect(items[6]).toMatchObject({ id: spare.id, deletetag: { id: spare.id, label: 'spare' } });
      const stored = await f.raw('parent', parent);
      expect([stored.name, stored.state, Number(stored.version)]).toEqual(['updated', 'CLOSED', 3]);
      expect((await f.raw('tag', tag)).label).toBe('new');
      expect(Number((await f.raw('child', child)).version)).toBe(1);
      expect(await f.raw('child', first.id)).toBeNull();
      expect(await f.raw('tag', spare.id)).toBeNull();
      const read = ok(await f.run(`{ parent(id: "${parent}") { tag { id } children { name parent { id } } } }`));
      expect(read.tag).toEqual({ id: tag });
      expect(read.children.map(({ name }) => name).sort()).toEqual(['linked', 'nested']);
      expect(read.children.every((entry) => entry.parent.id === parent)).toBe(true);
    });

    test('a late failure leaves every table and collection unchanged', async () => {
      const f = await fixture(backend, { transaction: true });
      const {
        parent, first, second, spare,
      } = await f.seed();
      const before = await f.dump();
      const missing = f.missing();
      const result = await f.transact([
        { addtag: { label: 'new' } },
        { addparent: { name: 'new', tag: { id: '$0' }, children: { added: [{ name: 'new child' }] } } },
        { addchild: { name: 'linked', parent: { id: '$1' } } },
        {
          updateparent: {
            id: parent.id,
            version: 1,
            name: 'changed',
            children: { updated: [{ id: first.id, version: 1, amount: 5 }], deleted: [{ id: second.id, version: 1 }] },
          },
        },
        { close_parent: { id: parent.id, version: 2 } },
        { deletetag: { id: spare.id } },
        { updatetag: { id: missing, label: 'missing' } },
      ]);
      expect(failure(result)).toEqual({
        code: 'NOT_VALID_ID', status: 404, message: `${f.Tag.name} ${missing} is not valid`, operationIndex: 6, operation: 'updatetag',
      });
      expect(result.data).toEqual({ transaction: null });
      // Every earlier operation wrote before the failure.
      expect(f.events).toEqual(expect.arrayContaining([
        'tag.onSaved', 'parent.onSaved', 'child.onSaved', 'child.onUpdated', 'child.onDelete', 'parent.close', 'tag.onDelete',
      ]));
      expect(await f.dump()).toEqual(before);
    });

    test('a version conflict at index 2 keeps the original versions', async () => {
      const f = await fixture(backend, { transaction: true });
      const one = await f.addParent();
      const two = await f.addParent();
      const three = await f.addParent();
      // Another writer advanced the third record.
      ok(await f.run(`mutation { updateparent(input: { id: "${three.id}", version: 1, name: "outside" }) { version } }`));
      f.events.length = 0;
      const result = await f.transact([
        { updateparent: { id: one.id, version: 1, name: 'one' } },
        { close_parent: { id: two.id, version: 1 } },
        { updateparent: { id: three.id, version: 1, name: 'three' } },
      ]);
      expect(failure(result)).toEqual({ ...conflict(f.Parent, three.id), operationIndex: 2, operation: 'updateparent' });
      expect(f.events.filter((event) => event === 'parent.onUpdated')).toHaveLength(2);
      const stored = await Promise.all([one, two, three].map(({ id }) => f.raw('parent', id)));
      expect(stored.map((row) => [row.name, row.state, Number(row.version)])).toEqual([
        ['seeded', 'OPEN', 1], ['seeded', 'OPEN', 1], ['outside', 'OPEN', 2],
      ]);
    });

    // The delete of a record that an earlier operation of the list references. PostgreSQL's foreign key
    // and MongoDB's transactional integrity refuse it at the delete, so the error names that operation
    // and nothing is stored. MongoDB with referentialIntegrity 'off' checks no references (an intentional
    // difference, see docs/compatibility.md): the list commits and the parent keeps a reference to a tag
    // that no longer exists.
    test('a delete of a record that an earlier operation references', async () => {
      const f = await fixture(backend, { transaction: true });
      await f.seed();
      const before = await f.dump();
      const result = await f.transact([
        { addtag: { label: 'doomed' } },
        { addparent: { name: 'dangling', tag: { id: '$0' } } },
        { deletetag: { id: '$0' } },
      ]);
      if (backend.name === 'mongo') {
        const [tag, parent] = ok(result).map((item) => item.id);
        expect(await f.raw('tag', tag)).toBeNull();
        expect(String((await f.raw('parent', parent)).tag)).toBe(tag);
        expect(await f.countTags('doomed')).toBe(0);
        return;
      }
      expect(failure(result)).toEqual({
        code: 'REFERENCE_CONSTRAINT_VIOLATION',
        status: 409,
        message: 'Reference constraint violated',
        operationIndex: 2,
        operation: 'deletetag',
      });
      expect(result.data).toEqual({ transaction: null });
      expect(await f.dump()).toEqual(before);
    });

    test('a delete of a missing record returns null and the list continues', async () => {
      const f = await fixture(backend, { transaction: true });
      const result = await f.transact([
        { deleteparent: { id: f.missing(), version: 1 } },
        { deletetag: { id: f.missing() } },
        { deletechild: { id: f.missing(), version: 1 } },
        { addtag: { label: 'after' } },
        { updatetag: { id: '$3', label: 'after deletes' } },
      ], 'id deleteparent { id } deletetag { id } deletechild { id } addtag { id label } updatetag { id label }');
      const items = ok(result);
      const empty = {
        id: null, deleteparent: null, deletetag: null, deletechild: null, addtag: null, updatetag: null,
      };
      const tag = items[3].id;
      expect(items).toEqual([
        empty, empty, empty,
        { ...empty, id: tag, addtag: { id: tag, label: 'after' } },
        { ...empty, id: tag, updatetag: { id: tag, label: 'after deletes' } },
      ]);
      expect((await f.raw('tag', tag)).label).toBe('after deletes');
    });
  });

  describe.skipIf(!backend.enabled)(`transaction retries and commit errors: ${backend.name}`, { timeout: TEST_TIMEOUT }, () => {
    test('an operation conflict is retried with the whole list', async () => {
      const f = await fixture(backend, { transaction: true });
      const { tag } = await f.seed();
      const injected = await injectConflict(f, tag.id, (attempt) => attempt === 1);
      let result;
      try {
        result = await f.transact([
          { addtag: { label: 'retried' } },
          { updatetag: { id: tag.id, label: 'changed' } },
        ], 'id addtag { label } updatetag { label }');
      } finally {
        await injected.release();
      }
      const items = ok(result);
      expect(items.map((item) => item.addtag ?? item.updatetag)).toEqual([{ label: 'retried' }, { label: 'changed' }]);
      expect(injected.attempts()).toBe(2);
      expect(f.events.filter((event) => event === 'tag.onSaved')).toHaveLength(2);
      // The first attempt's add was rolled back: only the retry's tag is stored.
      expect(await f.countTags('retried')).toBe(1);
      expect((await f.raw('tag', items[0].id)).label).toBe('retried');
      expect((await f.raw('tag', tag.id)).label).toBe('changed');
    });

    test('an operation conflict on every attempt keeps its operation', async () => {
      const f = await fixture(backend, { transaction: true });
      const { tag } = await f.seed();
      const before = await f.dump();
      const injected = await injectConflict(f, tag.id, () => true);
      let result;
      try {
        result = await f.transact([
          { addtag: { label: 'never' } },
          { updatetag: { id: tag.id, label: 'never' } },
        ]);
      } finally {
        await injected.release();
      }
      expect(failure(result)).toEqual({ ...RETRY_EXCEEDED, operationIndex: 1, operation: 'updatetag' });
      expect(formatted(result)).toEqual({
        code: RETRY_EXCEEDED.code, status: RETRY_EXCEEDED.status, operationIndex: 1, operation: 'updatetag',
      });
      expect(result.errors[0].originalError.getCause()).toMatchObject({ code: f.sql ? '40001' : 112 });
      expect(injected.attempts()).toBe(6);
      expect(await f.dump()).toEqual(before);
    });

    test('a commit failure is not positioned, even after an operation failed in an earlier attempt', async () => {
      const f = await fixture(backend, { transaction: true });
      const { tag } = await f.seed();
      const before = await f.dump();
      const injected = await injectConflict(f, tag.id, (attempt) => attempt === 1);
      const commits = failCommits(f);
      let result;
      try {
        result = await f.transact([
          { addtag: { label: 'uncommitted' } },
          { updatetag: { id: tag.id, label: 'uncommitted' } },
        ]);
      } finally {
        commits.restore();
        await injected.release();
      }
      // MongoDB retries an unknown commit outcome alone and then reports it as is; PostgreSQL retries
      // the whole list after each confirmed abort and normalizes the last one.
      expect(failure(result)).toEqual(f.sql
        ? { ...RETRY_EXCEEDED, ...UNPOSITIONED }
        : {
          code: undefined, status: undefined, message: 'Lost commit response', ...UNPOSITIONED,
        });
      // A client gets the driver error as an unexpected one, as from a root, and no position either way.
      expect(formatted(result)).toEqual(f.sql
        ? { code: RETRY_EXCEEDED.code, status: RETRY_EXCEEDED.status }
        : { code: 'INTERNAL_SERVER_ERROR', status: 500 });
      expect([injected.attempts(), commits.commits()]).toEqual(f.sql ? [6, 5] : [2, 6]);
      expect(result.data).toEqual({ transaction: null });
      expect(await f.dump()).toEqual(before);
    });

    if (backend.name !== 'postgres') {
      test('an uncertain commit that succeeded repeats only the commit', async () => {
        const f = await fixture(backend, { transaction: true });
        await f.seed();
        let commits = 0;
        const spy = interceptCommits(async (commit) => {
          commits++;
          await commit();
          if (commits === 1) throw lostCommit();
        });
        let result;
        try {
          result = await f.transact([
            { addtag: { label: 'once' } },
            { addparent: { name: 'once', tag: { id: '$0' }, children: { added: [{ name: 'once' }] } } },
          ]);
        } finally {
          spy.mockRestore();
        }
        const [tag, parent] = ok(result).map((item) => item.id);
        expect(commits).toBe(2);
        expect(f.events.filter((event) => event.endsWith('.onSaved'))).toEqual(['tag.onSaved', 'child.onSaved', 'parent.onSaved']);
        expect(await f.model.tag.countDocuments({ label: 'once' })).toBe(1);
        expect(await f.model.parent.countDocuments({ name: 'once' })).toBe(1);
        expect(await f.model.child.countDocuments({ name: 'once' })).toBe(1);
        expect(String((await f.raw('parent', parent)).tag)).toBe(tag);
      });
    }
  });
}
