// #98 §15: observable parity on real MongoDB (both integrity modes) and PostgreSQL.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import {
  GraphQLEnumType, GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';
import mongoose from 'mongoose';
import pg from 'pg';
import { auth, createRuntime, SimfinityError } from '../../packages/core/src/index.js';
import { createMongoAdapter } from '../../packages/mongodb/src/mongo/adapter.js';
import { createSQLAdapter } from '../../packages/sql/src/adapter.js';
import { postgresPlugin } from '../../packages/postgres/src/index.js';

import { createControlledRace } from '../helpers/controlled-race.js';

const MAX = 9007199254740991;

const mongoUri = process.env.SIMFINITY_MONGODB_URI;
const postgresUri = process.env.SIMFINITY_POSTGRES_URI;
const namespace = `ocparity_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const schemas = [];
const models = [];
let pool;
let sequence = 0;
const code = (result) => result.errors?.[0]?.extensions?.code;
const ok = (result) => {
  expect(result.errors).toBeUndefined();
  return Object.values(result.data)[0];
};
const denied = () => { throw new SimfinityError('Not allowed', 'FORBIDDEN', 403); };
const backends = [
  { name: 'mongo', enabled: !!mongoUri },
  { name: 'mongo-transactional', enabled: !!mongoUri },
  { name: 'postgres', enabled: !!postgresUri },
];
beforeAll(async () => {
  if (mongoUri) {
    // Independent from the base contract and adapter suites, which own their own cleanup.
    const dbName = `${new URL(mongoUri).pathname.slice(1)}_oc_parity`;
    await mongoose.connect(mongoUri, { dbName });
  }
  if (postgresUri) pool = new pg.Pool({ connectionString: postgresUri, max: 6 });
});
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
});

const fixture = async (backend, { scoped = false, protectedType = true, protectedParent = true, supplied = false, alias = false, configureSchema } = {}) => {
  const sql = backend.name === 'postgres';
  const prefix = `OcParity${sequence++}`;
  const dbSchema = `${namespace}_${sequence}`;
  const statements = [];
  const plugin = sql ? postgresPlugin({ pool, schema: dbSchema }) : null;
  const adapter = sql ? createSQLAdapter({ ...plugin, driver: { ...plugin.driver, query(...args) {
    statements.push(args[1]);
    return plugin.driver.query(...args);
  } } })
    : createMongoAdapter({ referentialIntegrity: backend.name === 'mongo-transactional' ? 'transactional' : 'off' });
  const runtime = createRuntime(adapter);
  const hooks = {};
  const events = [];
  const scopes = [];
  const calls = [];
  const note = async (name, ...args) => {
    events.push({ name, args });
    return hooks[name]?.(...args);
  };
  const scope = (operation) => (params) => {
    scopes.push(operation);
    if (!params.context?.tenant) throw new SimfinityError('Tenant required', 'UNAUTHORIZED', 401);
    params.args.tenant = { operator: 'EQ', value: params.context.tenant };
  };
  const extensions = (type) => ({
    ...(protectedType && (type === 'child' || protectedParent) ? { concurrency: { mode: 'optimistic' } } : {}),
    ...(scoped ? { scope: { get_by_id: scope('get_by_id'), find: scope('find') } } : {}),
    validations: { UPDATE: [{ validate: (_name, args, materialized) => note(`${type}.validate`, args, materialized) }] },
  });
  const State = new GraphQLEnumType({ name: `${prefix}State`, values: { OPEN: {}, CLOSED: {} } });
  const Detail = new GraphQLObjectType({ name: `${prefix}Detail`, fields: {
    label: { type: new GraphQLNonNull(GraphQLString) }, note: { type: GraphQLString },
  } });
  const Child = new GraphQLObjectType({ name: `${prefix}Child`, extensions: extensions('child'), fields: () => ({
    id: { type: GraphQLID }, name: { type: GraphQLString }, tenant: { type: GraphQLString }, amount: { type: GraphQLInt },
    parent: { type: Parent, extensions: { relation: { connectionField: 'parent' } } },
  }) });
  const Parent = new GraphQLObjectType({ name: `${prefix}Parent`, extensions: extensions('parent'), fields: () => ({
    id: { type: GraphQLID }, name: { type: GraphQLString }, tenant: { type: GraphQLString }, state: { type: State }, total: { type: GraphQLInt },
    detail: { type: Detail, extensions: { relation: { embedded: true } } },
    details: { type: new GraphQLList(Detail), extensions: { relation: { embedded: true } } },
    children: { type: new GraphQLList(Child), extensions: { relation: { connectionField: 'parent' } } },
  }) });
  const controller = (type) => Object.fromEntries(['onSaving', 'onSaved', 'onUpdating', 'onUpdated', 'onDelete'].map((hook) => [hook, (...args) => note(`${type}.${hook}`, ...args)]));
  if (!sql) runtime.preventCreatingCollection(true);
  runtime.addNoEndpointType(Detail);
  let suppliedModel;
  if (supplied) {
    const detail = new mongoose.Schema({ label: String, note: String }, { _id: false });
    const schema = new mongoose.Schema({ name: { type: String, get: (value) => value?.toUpperCase() }, tenant: String, state: String, total: Number, detail, details: [detail], version: Number }, { timestamps: true });
    schema.pre('findOneAndUpdate', function () { calls.push('findOneAndUpdate'); });
    schema.pre('findOneAndDelete', function () { calls.push('findOneAndDelete'); });
    schema.static('findByIdAndUpdate', function (...args) { calls.push('findByIdAndUpdate'); return mongoose.Model.findByIdAndUpdate.apply(this, args); });
    configureSchema?.(schema);
    suppliedModel = mongoose.model(Parent.name, schema);
  }
  if (alias) {
    const Alias = new GraphQLObjectType({ name: `${prefix}Alias`, fields: { id: { type: GraphQLID }, name: { type: GraphQLString }, version: { type: GraphQLInt }, versionKind: { type: GraphQLString, resolve: (record) => typeof record.version, extensions: { virtual: true } } } });
    runtime.connect(suppliedModel, Alias, 'alias', 'aliases');
  }
  runtime.connect(null, Child, 'child', 'children', controller('child'));
  runtime.connect(suppliedModel ?? null, Parent, 'parent', 'parents', controller('parent'), null, {
    initialState: { name: 'OPEN', value: 'OPEN' },
    actions: { close: { from: { name: 'OPEN', value: 'OPEN' }, to: { name: 'CLOSED', value: 'CLOSED' }, action: (...args) => note('action', ...args) } },
  });
  const schema = runtime.createSchema();
  if (sql) { schemas.push(dbSchema); await adapter.initialize(); }
  else {
    for (const { model } of runtime.getRegistrations()) if (model && !models.includes(model)) {
      models.push(model); await model.createCollection(); await model.init();
    }
    await adapter.initialize();
  }
  const model = runtime.getModel(Parent);
  const childModel = runtime.getModel(Child);
  const run = (source, context = { tenant: 'A' }, variableValues) => graphql({ schema, source, contextValue: context, variableValues });
  const selection = protectedType ? `id name state ${protectedParent ? 'version' : ''} total detail { label note } children { id name version amount }` : 'id name state';
  const add = (input = {}, context) => run(`mutation($input: ${Parent.name}Input!) { addparent(input: $input) { ${selection} } }`, context, { input: { name: 'original', tenant: 'A', total: 0, ...input } });
  const update = (input, context, fields = selection) => run(`mutation($input: ${Parent.name}InputForUpdate!) { updateparent(input: $input) { ${fields} } }`, context, { input });
  const remove = (id, version, context) => run(`mutation { deleteparent(id: "${id}"${protectedType ? `, version: ${version}` : ''}) { id name${protectedType ? ' version' : ''} } }`, context);
  const transition = (id, version, context) => run(`mutation { close_parent(input: { id: "${id}"${protectedType ? `, version: ${version}` : ''} }) { ${selection} } }`, context);
  const read = (id, context) => run(`{ parent(id: "${id}") { ${selection} } }`, context);
  const raw = async (id, child = false) => sql
    ? (await pool.query(`SELECT * FROM "${dbSchema}"."${child ? Child.name : Parent.name}" WHERE id = $1`, [id])).rows[0] ?? null
    : (child ? childModel : model).collection.findOne({ _id: new mongoose.Types.ObjectId(id) });
  const set = async (id, values, child = false) => {
    if (sql) {
      const entries = Object.entries(values);
      await pool.query(`UPDATE "${dbSchema}"."${child ? Child.name : Parent.name}" SET ${entries.map(([key], index) => `"${key}" = $${index + 2}`).join(', ')} WHERE id = $1`, [id, ...entries.map(([, value]) => value)]);
    } else await (child ? childModel : model).collection.updateOne({ _id: new mongoose.Types.ObjectId(id) }, { $set: values });
  };
  return { ...backend, sql, dbSchema, adapter, runtime, schema, Parent, Child, model, childModel, hooks, events, scopes, calls, statements, run, add, update, remove, transition, read, raw, set, missing: () => sql ? randomUUID() : String(new mongoose.Types.ObjectId()) };
};

for (const backend of backends) describe.skipIf(!backend.enabled)(`optimistic concurrency parity: ${backend.name}`, () => {
  test('1: create, read, update, state action and version-only update advance exactly once', async () => {
    const f = await fixture(backend, { supplied: backend.name !== 'postgres' });
    const created = ok(await f.add({ detail: { label: 'embedded', note: 'clean' } }));
    expect(created.version).toBe(1);
    expect(ok(await f.read(created.id)).version).toBe(1);
    expect(ok(await f.update({ id: created.id, version: 1, name: 'edited' })).version).toBe(2);
    expect(ok(await f.transition(created.id, 2))).toMatchObject({ version: 3, state: 'CLOSED', detail: { label: 'embedded', note: 'clean' } });
    expect(ok(await f.update({ id: created.id, version: 3 })).version).toBe(4);
    expect(Number((await f.raw(created.id)).version)).toBe(4);
  });

  test('3: missing, malformed and stale versions leave data and revision unchanged', async () => {
    const f = await fixture(backend);
    const created = ok(await f.add());
    for (const input of [{}, { version: null }, { version: '1' }, { version: 0 }, { version: 1.5 }, { version: MAX + 1 }]) {
      const result = await f.update({ id: created.id, name: 'rejected', ...input });
      expect(result.errors).toHaveLength(1);
    }
    expect(code(await f.update({ id: created.id, version: 2, name: 'stale' }))).toBe('VERSION_CONFLICT');
    expect(await f.raw(created.id)).toMatchObject({ name: 'original' });
    expect(Number((await f.raw(created.id)).version)).toBe(1);
  });

  test('4: delete checks the revision and preserves missing-ID outcomes', async () => {
    const f = await fixture(backend);
    const created = ok(await f.add());
    expect(code(await f.remove(created.id, 2))).toBe('VERSION_CONFLICT');
    expect(await f.raw(created.id)).not.toBeNull();
    expect(ok(await f.remove(created.id, 1))).toMatchObject({ id: created.id, version: 1 });
    expect(await f.raw(created.id)).toBeNull();
    expect(ok(await f.remove(f.missing(), 1))).toBeNull();
  });

  test('5,7: protected nested updates/deletes advance once and stale children roll back parent writes', async () => {
    const f = await fixture(backend);
    const parent = ok(await f.add({ children: { added: [{ name: 'child', tenant: 'A', amount: 3 }] } }));
    const child = parent.children[0];
    expect(child.version).toBe(1);
    const updated = ok(await f.update({ id: parent.id, version: 1, children: { updated: [{ id: child.id, version: 1, name: 'changed' }] } }));
    expect(updated).toMatchObject({ version: 2, children: [{ id: child.id, version: 2, name: 'changed' }] });
    for (const key of ['updated', 'deleted']) {
      f.events.length = 0;
      expect(code(await f.update({ id: parent.id, version: 2, name: 'rolled back', children: { [key]: [{ id: child.id, version: 1 }] } }))).toBe('VERSION_CONFLICT');
      expect(f.events.some((event) => event.name === 'parent.onUpdating')).toBe(true);
      expect(f.events.some((event) => event.name.startsWith('child.'))).toBe(false);
      expect(ok(await f.read(parent.id))).toMatchObject({ name: 'original', version: 2, children: [{ name: 'changed', version: 2 }] });
    }
    expect(ok(await f.update({ id: parent.id, version: 2, children: { deleted: [{ id: child.id, version: 2 }] } }))).toMatchObject({ version: 3, children: [] });
  });

  test('7: an unprotected parent requires revisions for its protected child edits and deletes', async () => {
    const f = await fixture(backend, { protectedParent: false });
    const parent = ok(await f.add({ children: { added: [{ name: 'child' }] } }));
    expect(parent).not.toHaveProperty('version');
    const child = parent.children[0];
    expect(ok(await f.update({ id: parent.id, children: { updated: [{ id: child.id, version: 1, name: 'edited' }] } })).children[0]).toMatchObject({ version: 2, name: 'edited' });
    expect(code(await f.update({ id: parent.id, name: 'rolled back', children: { deleted: [{ id: child.id, version: 1 }] } }))).toBe('VERSION_CONFLICT');
    expect((await f.raw(parent.id)).name).toBe('original');
    expect(ok(await f.update({ id: parent.id, children: { deleted: [{ id: child.id, version: 2 }] } })).children).toEqual([]);
  });

  test('5,7: saveObject initializes protected nested additions and supplied rollback removes them', async () => {
    const f = await fixture(backend);
    const input = { name: 'saved', tenant: 'A', version: 90, children: { added: [{ name: 'nested', version: 90 }] } };
    const saved = await f.runtime.saveObject(f.Parent.name, input, null, { tenant: 'A' });
    expect(saved.version).toBe(1);
    expect(ok(await f.read(String(saved.id ?? saved._id)))).toMatchObject({ version: 1, children: [{ version: 1 }] });
    let rolled;
    let rolledChild;
    await expect(f.adapter.withTransaction(null, async (session) => {
      rolled = await f.runtime.saveObject(f.Parent.name, input, session, { tenant: 'A' });
      expect(rolled.version).toBe(1);
      const children = await f.adapter.findChildren(f.childModel, f.Child, 'parent', String(rolled.id ?? rolled._id), {}, session);
      expect(children).toHaveLength(1);
      expect(children[0].version).toBe(1);
      rolledChild = String(children[0].id ?? children[0]._id);
      throw new Error('rollback supplied');
    })).rejects.toThrow('rollback supplied');
    expect(await f.raw(String(rolled.id ?? rolled._id))).toBeNull();
    expect(await f.raw(rolledChild, true)).toBeNull();
  });

  test('6: a retry keeps the submitted child/record version after an outside write', async () => {
    const f = await fixture(backend);
    const parent = ok(await f.add({ children: { added: [{ name: 'child' }] } }));
    let attempts = 0;
    f.hooks['parent.onUpdating'] = async () => {
      if (attempts++ !== 0) return;
      if (f.sql) {
        await f.set(parent.children[0].id, { version: 2, name: 'outside' }, true);
        throw Object.assign(new Error('retry transaction'), { code: '40001' });
      }
      await f.set(parent.id, { version: 2, name: 'outside' });
    };
    const result = await f.update({ id: parent.id, version: 1, name: 'loser', ...(f.sql ? { children: { updated: [{ id: parent.children[0].id, version: 1, name: 'loser' }] } } : {}) });
    expect(code(result)).toBe('VERSION_CONFLICT');
    expect(attempts).toBe(f.sql ? 2 : 1);
    expect(await f.raw(f.sql ? parent.children[0].id : parent.id, f.sql)).toMatchObject({ name: 'outside' });
    expect(Number((await f.raw(f.sql ? parent.children[0].id : parent.id, f.sql)).version)).toBe(2);
    if (f.sql) expect(Number((await f.raw(parent.id)).version)).toBe(1);
  });

  test('8: hooks receive managed values, validators/actions retain input, and success skips the visibility scope', async () => {
    const f = await fixture(backend, { scoped: true });
    let saving;
    let saved;
    let changed;
    let validated;
    let action;
    f.hooks['parent.onSaving'] = (record, args) => { saving = [record.version, args.version]; };
    f.hooks['parent.onSaved'] = (record) => { saved = record.version; };
    const parent = ok(await f.add());
    expect(saving).toEqual([1, undefined]);
    expect(saved).toBe(1);
    f.scopes.length = 0;
    f.hooks['parent.onUpdating'] = (_id, changes) => { changed = { ...changes }; };
    f.hooks['parent.validate'] = (args) => { validated = args.version; };
    f.hooks.action = (args) => { action = args.version; };
    expect(ok(await f.transition(parent.id, 1)).version).toBe(2);
    expect(action).toBe(1);
    expect(validated).toBe(1);
    expect(changed).not.toHaveProperty('version');
    expect(f.scopes.filter((operation) => operation === 'get_by_id')).toEqual([]);
    expect(f.events.findLast((event) => event.name === 'parent.onUpdated').args[0].version).toBe(2);
    let deleted;
    f.hooks['parent.onDelete'] = (record) => { deleted = record; };
    ok(await f.remove(parent.id, 2));
    expect(deleted.version).toBe(2);
  });

  test('8: tenant ownership hooks hide stale, current and exhausted versions, including throwing tenantScope', async () => {
    const f = await fixture(backend, { scoped: true });
    f.hooks['parent.onUpdating'] = async (id, _changes, session, context) => {
      const record = await f.adapter.getById(f.model, id, session);
      if (record && !context.writeOnly && record.tenant !== context.tenant) denied();
    };
    f.hooks['parent.onDelete'] = (record, _session, context) => { if (record && !context.writeOnly && record.tenant !== context.tenant) denied(); };
    f.hooks['child.onUpdating'] = (_id, _changes, _session, context) => { if (!context.writeOnly) denied(); };
    f.hooks['child.onDelete'] = (_record, _session, context) => { if (!context.writeOnly) denied(); };
    for (const context of [{ tenant: 'B' }, {}]) {
      for (const [stored, sent] of [[5, 4], [5, 5], [MAX, MAX]]) {
        const parent = ok(await f.add({ children: { added: [{ name: 'child', tenant: 'A' }] } }));
        await f.set(parent.id, { version: stored });
        await f.set(parent.children[0].id, { version: stored }, true);
        for (const operation of [() => f.update({ id: parent.id, version: sent, name: 'forbidden' }, context), () => f.remove(parent.id, sent, context), () => f.transition(parent.id, sent, context)]) {
          expect(code(await operation())).toBe('FORBIDDEN');
        }
        await f.set(parent.id, { state: 'CLOSED' });
        expect(code(await f.transition(parent.id, sent, context))).toBe('BAD_REQUEST');
        // An allowed parent reaches the hidden child's ownership hook.
        await f.set(parent.id, { tenant: context.tenant ?? 'anonymous', version: 1 });
        const allowParent = f.hooks['parent.onUpdating'];
        f.hooks['parent.onUpdating'] = () => {};
        for (const key of ['updated', 'deleted']) expect(code(await f.update({ id: parent.id, version: 1, children: { [key]: [{ id: parent.children[0].id, version: sent }] } }, context))).toBe('FORBIDDEN');
        f.hooks['parent.onUpdating'] = allowParent;
        expect(Number((await f.raw(parent.id)).version)).toBe(1);
      }
    }
  });

  test('8: hidden embedded-list validation is identical for all versions', async () => {
    const f = await fixture(backend, { scoped: true });
    const parent = ok(await f.add());
    for (const [stored, sent] of [[5, 4], [5, 5], [MAX, MAX]]) {
      await f.set(parent.id, { version: stored });
      expect(code(await f.update({ id: parent.id, version: sent, details: [{ note: 'missing label' }] }, { tenant: 'B' }))).toBe('REQUIRED_VALUE');
      expect(Number((await f.raw(parent.id)).version)).toBe(stored);
    }
  });

  test('8: write-only callers learn conflicts after hooks; readers and unscoped callers fail early', async () => {
    for (const scoped of [true, false]) {
      const f = await fixture(backend, { scoped });
      const parent = ok(await f.add());
      if (scoped) {
        f.events.length = 0;
        expect(ok(await f.update({ id: parent.id, version: 1 }, { tenant: 'B', writeOnly: true })).version).toBe(2);
        f.events.length = 0;
        expect(code(await f.update({ id: parent.id, version: 1 }, { tenant: 'B', writeOnly: true }))).toBe('VERSION_CONFLICT');
        expect(f.events.map((event) => event.name)).toContain('parent.onUpdating');
      } else await f.set(parent.id, { version: 2 });
      f.events.length = 0;
      expect(code(await f.update({ id: parent.id, version: 1 }))).toBe('VERSION_CONFLICT');
      expect(f.events).toEqual([]);
      const missing = f.missing();
      expect(code(await f.update({ id: missing, version: 1 }))).toBe('NOT_VALID_ID');
      expect(code(await f.transition(missing, 1))).toBe('NOT_VALID_ID');
      expect(ok(await f.remove(missing, 1))).toBeNull();
      for (const key of ['updated', 'deleted']) {
        expect(code(await f.update({ id: parent.id, version: 2, children: { [key]: [{ id: missing, version: 1 }] } }))).toBe('NOT_VALID_ID');
        expect(Number((await f.raw(parent.id)).version)).toBe(2);
      }
    }
  });

  test('8: get_by_id/find scopes and an auth field rule protect version reads', async () => {
    const f = await fixture(backend, { scoped: true });
    const parent = ok(await f.add());
    expect(ok(await f.read(parent.id, { tenant: 'B' }))).toBeNull();
    expect(ok(await f.run('{ parents { id version } }', { tenant: 'B' }))).toEqual([]);
    expect(ok(await f.read(parent.id)).version).toBe(1);
    auth.createAuthPlugin({ [f.Parent.name]: { version: auth.requireAuth() } }, { defaultPolicy: 'ALLOW' }).onSchemaChange({ schema: f.schema });
    const result = await f.read(parent.id);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].path).toEqual(['parent', 'version']);
    expect(code(result)).toBe('UNAUTHENTICATED');
  });

  test('8: derived order totals share the parent revision after nested line hooks', async () => {
    const f = await fixture(backend);
    const recompute = async (record, session) => {
      const id = String(record.id ?? record._id);
      const lines = await f.adapter.findChildren(f.childModel, f.Child, 'parent', id, {}, session);
      const total = lines.reduce((sum, line) => sum + line.amount, 0);
      if (f.sql) await f.model.update(id, { total }, { session, version: false });
      else await f.model.updateOne({ _id: id }, { $set: { total } }, { session });
      record.total = total;
    };
    f.hooks['parent.onSaved'] = (record, _args, session) => recompute(record, session);
    f.hooks['parent.onUpdated'] = recompute;
    const parent = ok(await f.add({ children: { added: [{ name: 'one', amount: 3 }, { name: 'two', amount: 4 }] } }));
    expect(parent).toMatchObject({ version: 1, total: 7 });
    expect(f.events.map((event) => event.name).filter((name) => name.endsWith('onSaved'))).toEqual(['child.onSaved', 'child.onSaved', 'parent.onSaved']);
    f.events.length = 0;
    const updated = ok(await f.update({ id: parent.id, version: 1, children: { updated: [{ id: parent.children[0].id, version: 1, amount: 8 }] } }));
    expect(updated).toMatchObject({ version: 2, total: 12 });
    expect(f.events.map((event) => event.name).filter((name) => /onUpdating|onUpdated/.test(name))).toEqual(['parent.onUpdating', 'child.onUpdating', 'child.onUpdated', 'parent.onUpdated']);
    expect(Number((await f.raw(parent.id)).version)).toBe(2);
    expect((await f.raw(parent.id)).total).toBe(12);
  });

  test.each([2147483648, MAX - 1])('10: stored %s reads and advances exactly, without GraphQL Int truncation', async (version) => {
    const f = await fixture(backend);
    const parent = ok(await f.add());
    await f.set(parent.id, { version });
    expect(ok(await f.read(parent.id)).version).toBe(version);
    expect(ok(await f.update({ id: parent.id, version })).version).toBe(version + 1);
    expect(Number((await f.raw(parent.id)).version)).toBe(version + 1);
  });

  test('10: exhaustion rejects update, action and nested update unchanged; maximum delete succeeds', async () => {
    const f = await fixture(backend);
    const parent = ok(await f.add({ children: { added: [{ name: 'child' }] } }));
    await f.set(parent.id, { version: MAX });
    for (const result of [await f.update({ id: parent.id, version: MAX }), await f.transition(parent.id, MAX)]) expect(code(result)).toBe('VERSION_EXHAUSTED');
    expect(Number((await f.raw(parent.id)).version)).toBe(MAX);
    await f.set(parent.id, { version: 1 });
    await f.set(parent.children[0].id, { version: MAX }, true);
    expect(code(await f.update({ id: parent.id, version: 1, children: { updated: [{ id: parent.children[0].id, version: MAX }] } }))).toBe('VERSION_EXHAUSTED');
    expect(Number((await f.raw(parent.id)).version)).toBe(1);
    expect(Number((await f.raw(parent.children[0].id, true)).version)).toBe(MAX);
    ok(await f.update({ id: parent.id, version: 1, children: { deleted: [{ id: parent.children[0].id, version: MAX }] } }));
    await f.set(parent.id, { version: MAX });
    expect(ok(await f.remove(parent.id, MAX)).version).toBe(MAX);
  });

  test('pin: 9 unprotected writes preserve adapter call arity and have no managed version', async () => {
    const f = await fixture(backend, { protectedType: false });
    const parent = ok(await f.add());
    const spy = vi.spyOn(f.adapter, 'update');
    const mongoWrite = f.sql ? null : vi.spyOn(f.model.collection, 'findOneAndUpdate');
    try {
      expect(ok(await f.update({ id: parent.id, name: 'plain' })).name).toBe('plain');
      expect(spy.mock.calls[0]).toHaveLength(4);
      expect(await f.raw(parent.id)).not.toHaveProperty('version');
      if (f.sql) expect(f.statements.find((statement) => statement.text.startsWith('UPDATE '))).toEqual({
        text: `UPDATE "${f.dbSchema}"."${f.Parent.name}" SET "name" = $2::text WHERE id = $1::uuid RETURNING *`, values: [parent.id, 'plain'],
      });
      else expect(mongoWrite.mock.calls[0][1]).toEqual({ $set: { id: new mongoose.Types.ObjectId(parent.id), name: 'plain' } });
      if (!f.sql) {
        const result = await f.adapter.withTransaction(null, (session) => f.adapter.update(f.model, parent.id, [{ $set: { name: 'pipeline' } }], session));
        expect(result.name).toBe('pipeline');
        expect(mongoWrite.mock.calls[1][1]).toEqual([{ $set: { name: 'pipeline' } }]);
      }
      expect(ok(await f.remove(parent.id))).toMatchObject({ id: parent.id });
    } finally { spy.mockRestore(); mongoWrite?.mockRestore(); }
  });
});

for (const backend of backends) describe.skipIf(!backend.enabled)(`optimistic concurrency engines: ${backend.name}`, () => {
  test.each(backend.name === 'postgres' ? ['locked winner'] : ['committed winner', 'uncommitted winner'])('2: two writers, one version: %s', async (design) => {
    const f = await fixture(backend);
    const parent = ok(await f.add());
    const race = createControlledRace();
    const ready = race.gate('winner hook');
    const bArrived = design === 'committed winner' ? race.gate('loser hook') : null;
    const aWrote = design === 'uncommitted winner' ? race.gate('winner write') : null;
    const conflict = design === 'uncommitted winner' ? race.gate('native conflict') : null;
    const winnerDone = race.gate('winner completion');
    let bSession;
    let held = false;
    let blockingObserved = false;
    let nativeConflict;
    const original = f.adapter.update;
    const spy = vi.spyOn(f.adapter, 'update').mockImplementation(async (...args) => {
      try { return await original(...args); }
      catch (error) {
        if (!f.sql && args[3] === bSession && !held) {
          held = true;
          nativeConflict = error;
          conflict?.resolve();
          await winnerDone.wait();
        }
        throw error;
      }
    });
    f.hooks['parent.onUpdating'] = async (_id, changes, session) => {
      if (changes.name === 'winner') {
        if (f.sql) {
          const pid = (await session.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          ready.resolve();
          for (let poll = 0; poll < 1000; poll++) {
            race.check();
            const waiting = await pool.query('SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))', [pid]);
            if (waiting.rowCount) { blockingObserved = true; break; }
          }
          expect(blockingObserved).toBe(true);
        } else {
          ready.resolve();
          if (design === 'committed winner') await bArrived.wait();
        }
      } else {
        bSession = session;
        bArrived?.resolve();
        await (design === 'committed winner' ? winnerDone.wait() : aWrote.wait());
      }
    };
    f.hooks['parent.onUpdated'] = async (record) => {
      if (record.name === 'winner' && design === 'uncommitted winner') {
        aWrote.resolve();
        await conflict.wait();
      }
    };
    try {
      const winner = race.start(() => f.update({ id: parent.id, version: 1, name: 'winner' }).finally(() => winnerDone.resolve()));
      await ready.wait();
      const loser = race.start(() => f.update({ id: parent.id, version: 1, name: 'loser' }));
      const [won, lost] = await race.wait(Promise.all([winner, loser]));
      expect(ok(won)).toMatchObject({ name: 'winner', version: 2 });
      expect(code(lost)).toBe('VERSION_CONFLICT');
      expect(ok(await f.read(parent.id))).toMatchObject({ name: 'winner', version: 2 });
      expect(f.events.filter((event) => event.name === 'parent.onUpdated')).toHaveLength(1);
      expect(f.events.filter((event) => event.name === 'parent.onUpdating' && event.args[1].name === 'loser')).toHaveLength(f.sql ? 0 : 1);
      if (!f.sql) expect(nativeConflict).toMatchObject({ code: 112 });
    } finally {
      await race.finish();
      spy.mockRestore();
    }
  }, 20000);

  if (backend.name !== 'postgres') {
    test('8: supplied Mongoose middleware, timestamps, __v and inert-read detection survive protection', async () => {
      const f = await fixture(backend, { supplied: true });
      expect(f.adapter.readByIdIsInert(f.model)).toBe(false);
      const parent = ok(await f.add());
      const before = await f.raw(parent.id);
      expect(before.__v).toBe(0);
      ok(await f.update({ id: parent.id, version: 1 }));
      const after = await f.raw(parent.id);
      expect(after.__v).toBe(0);
      expect(after.createdAt).toEqual(before.createdAt);
      expect(after.updatedAt).toBeInstanceOf(Date);
      expect(f.calls).toEqual(['findOneAndUpdate']);
      ok(await f.remove(parent.id, 2));
      expect(f.calls).toEqual(['findOneAndUpdate', 'findOneAndDelete']);
    });

    test.each(['post middleware', 'query transform', 'public id transform'])('10 R31: same-record %s conversion retains invalid raw versions', async (conversion) => {
      const f = await fixture(backend, { supplied: true, configureSchema(schema) {
        if (conversion === 'post middleware') schema.post('findOne', function (record) {
          if (record instanceof mongoose.Document) return mongoose.overwriteMiddlewareResult(record.toObject());
        });
        else schema.pre('findOne', function () { this.transform((record) => {
          if (record == null) return record;
          const plain = record.toObject();
          if (conversion === 'public id transform') { plain.id = String(plain._id); delete plain._id; }
          return plain;
        }); });
      } });
      const id = new mongoose.Types.ObjectId();
      await f.model.collection.insertOne({ _id: id, name: 'stored', version: '2' });
      const native = await f.model.findById(id);
      expect(native.version).toBe(2);
      expect(native).not.toBeInstanceOf(mongoose.Document);
      expect(ok(await f.run(`{ parent(id: "${id}") { name } }`))).toEqual({ name: native.name });
      const result = await f.run(`{ parent(id: "${id}") { name version } }`);
      expect(code(result)).toBe('DATABASE_ERROR');
      expect(result.errors[0].path).toEqual(['parent', 'version']);
    });

    test('pin: R31 replacement with another identity does not inherit a captured invalid version', async () => {
      const replacementId = new mongoose.Types.ObjectId();
      const f = await fixture(backend, { supplied: true, configureSchema(schema) {
        schema.post('findOne', function () {
          return mongoose.overwriteMiddlewareResult(Object.freeze({ _id: replacementId, name: 'replacement', version: 4 }));
        });
      } });
      const id = new mongoose.Types.ObjectId();
      await f.model.collection.insertOne({ _id: id, name: 'stored', version: '2' });
      expect(ok(await f.run(`{ parent(id: "${id}") { id name version } }`))).toEqual({ id: String(replacementId), name: 'replacement', version: 4 });
    });

    test('10 R31: a result whose identity changes does not retain the original raw version', async () => {
      const replacementId = new mongoose.Types.ObjectId();
      const f = await fixture(backend, { supplied: true, configureSchema(schema) {
        schema.post('findOne', function (record) {
          record._id = replacementId;
          record.version = 4;
        });
      } });
      const id = new mongoose.Types.ObjectId();
      await f.model.collection.insertOne({ _id: id, name: 'stored', version: '2' });
      expect(ok(await f.run(`{ parent(id: "${id}") { id version } }`))).toEqual({ id: String(replacementId), version: 4 });
    });

    test.each(['single', 'batch'])('10 R31: reused %s result refreshes metadata after stored version repair', async (kind) => {
      const cached = {};
      const f = await fixture(backend, { supplied: true, configureSchema(schema) {
        if (kind === 'single') schema.post('findOne', function (record) {
          Object.assign(cached, record.toObject());
          return mongoose.overwriteMiddlewareResult(cached);
        });
      } });
      const id = new mongoose.Types.ObjectId();
      await f.model.collection.insertOne({ _id: id, name: 'stored', version: '2' });
      const read = async () => kind === 'single' ? f.adapter.getById(f.model, id) : (await f.adapter.getByIds(f.model, [id]).transform((records) => {
        Object.assign(cached, records[0].toObject());
        return [cached];
      }))[0];
      const resolve = f.Parent.getFields().version.resolve;
      expect(await read()).toBe(cached);
      expect(() => resolve(cached, {}, {}, {})).toThrow(expect.objectContaining({ extensions: expect.objectContaining({ code: 'DATABASE_ERROR' }) }));
      await f.model.collection.updateOne({ _id: id }, { $set: { version: 2 } });
      expect(await read()).toBe(cached);
      expect(resolve(cached, {}, {}, {})).toBe(2);
      await f.model.collection.updateOne({ _id: id }, { $set: { version: '3' } });
      expect(await read()).toBe(cached);
      expect(() => resolve(cached, {}, {}, {})).toThrow(expect.objectContaining({ extensions: expect.objectContaining({ code: 'DATABASE_ERROR' }) }));
    });

    test('10 R31: non-extensible records retain identity and selection-local managed errors', async () => {
      let hydrated;
      const f = await fixture(backend, { supplied: true, alias: backend.name === 'mongo', configureSchema(schema) {
        schema.post('init', function (record) { hydrated = record; Object.preventExtensions(record); });
      } });
      const id = new mongoose.Types.ObjectId();
      await f.model.collection.insertOne({ _id: id, name: 'stored', version: '2' });
      const native = await f.model.findById(id);
      expect(native.version).toBe(2);
      expect(native.name).toBe('STORED');
      const result = await f.adapter.getById(f.model, id);
      expect(result).toBe(hydrated);
      expect(Object.isExtensible(result)).toBe(false);
      expect(result.version).toBe(2);
      expect(ok(await f.run(`{ parent(id: "${id}") { name } }`))).toEqual({ name: 'STORED' });
      if (backend.name === 'mongo') expect(ok(await f.run(`{ alias(id: "${id}") { name version versionKind } }`))).toEqual({ name: 'STORED', version: 2, versionKind: 'number' });
      const selected = await f.run(`{ parent(id: "${id}") { version } }`);
      expect(code(selected)).toBe('DATABASE_ERROR');
      expect(selected.errors[0].path).toEqual(['parent', 'version']);
      auth.createAuthPlugin({ [f.Parent.name]: { version: auth.requireAuth() } }, { defaultPolicy: 'ALLOW' }).onSchemaChange({ schema: f.schema });
      const unauthorized = await f.run(`{ parent(id: "${id}") { version } }`);
      expect(code(unauthorized)).toBe('UNAUTHENTICATED');
      expect(unauthorized.errors[0].path).toEqual(['parent', 'version']);
    });

    test('10 R31: reordered batched result conversions associate only the matching stored record', async () => {
      const f = await fixture(backend, { supplied: true });
      const invalid = new mongoose.Types.ObjectId();
      const valid = new mongoose.Types.ObjectId();
      const fabricated = new mongoose.Types.ObjectId();
      await f.model.collection.insertMany([{ _id: invalid, name: 'bad', version: '2' }, { _id: valid, name: 'good', version: 3 }]);
      const rows = await f.adapter.getByIds(f.model, [invalid, valid]).transform((records) => [
        ...records.map((record) => Object.freeze(record.toObject())).reverse(),
        Object.freeze({ _id: fabricated, name: 'fabricated', version: 4 }),
      ]);
      const resolve = f.Parent.getFields().version.resolve;
      expect(rows.map((row) => row.name)).toEqual(['good', 'bad', 'fabricated']);
      expect(resolve(rows[0], {}, {}, {})).toBe(3);
      expect(() => resolve(rows[1], {}, {}, {})).toThrow(expect.objectContaining({ extensions: expect.objectContaining({ code: 'DATABASE_ERROR' }) }));
      expect(resolve(rows[2], {}, {}, {})).toBe(4);
      expect(rows.every((row) => Object.isFrozen(row))).toBe(true);
    });

    test.each(['single', 'batch'])('10 R31: original projected %s results retain invalid raw versions', async (kind) => {
      let hydrated;
      const f = await fixture(backend, { supplied: true, configureSchema(schema) {
        schema.post('init', function (record) { hydrated = record; });
      } });
      const id = new mongoose.Types.ObjectId();
      await f.model.collection.insertOne({ _id: id, name: 'stored', version: '2' });
      const projection = { _id: 0, name: 1, version: 1 };
      const query = kind === 'single'
        ? f.adapter.getById(f.model, id, undefined, { projection })
        : f.adapter.getByIds(f.model, [id]).select(projection);
      expect(query).toBeInstanceOf(mongoose.Query);
      const result = await query;
      const record = kind === 'single' ? result : result[0];
      expect(record).toBe(hydrated);
      expect(record).toBeInstanceOf(mongoose.Document);
      expect(record._id).toBeUndefined();
      expect(record.id).toBeNull();
      expect(record.name).toBe('STORED');
      expect(record.version).toBe(2);
      expect(() => f.Parent.getFields().version.resolve(record, {}, {}, {})).toThrow(
        expect.objectContaining({ extensions: expect.objectContaining({ code: 'DATABASE_ERROR' }) }),
      );
    });

    test('10: unsupported protected query overrides fail explicitly before losing raw versions', async () => {
      const f = await fixture(backend);
      const override = vi.spyOn(f.model, 'findById').mockReturnValue(Promise.resolve({ version: 2 }));
      try {
        expect(() => f.adapter.getById(f.model, f.missing())).toThrow(expect.objectContaining({ extensions: expect.objectContaining({ code: 'DATABASE_ERROR' }) }));
      } finally { override.mockRestore(); }
    });

    test('pin: protected reads retain supplied sessions, projections and native document values', async () => {
      const f = await fixture(backend, { supplied: true });
      const session = await mongoose.startSession();
      session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
      const id = new mongoose.Types.ObjectId();
      try {
        await f.model.collection.insertOne({ _id: id, name: 'native', tenant: 'secret', version: '2' }, { session });
        const record = await f.adapter.getById(f.model, id, session, { projection: { name: 1, version: 1 } });
        expect(record).toBeInstanceOf(mongoose.Document);
        expect(record.$session()).toBe(session);
        expect(record.name).toBe('NATIVE');
        expect(record.tenant).toBeUndefined();
        expect(record.version).toBe(2);
        expect(Object.keys(record.toObject())).not.toContain('tenant');
        expect(await f.model.collection.findOne({ _id: id })).toBeNull();
      } finally { await session.abortTransaction(); await session.endSession(); }
    });

    if (backend.name === 'mongo') test('pin: shared supplied-model aliases retain native hydration when a protected field rejects corruption', async () => {
      const f = await fixture(backend, { supplied: true, alias: true });
      const id = new mongoose.Types.ObjectId();
      await f.model.collection.insertOne({ _id: id, name: 'original', version: '2' });
      expect(ok(await f.run(`{ alias(id: "${id}") { name version versionKind } }`))).toEqual({ name: 'ORIGINAL', version: 2, versionKind: 'number' });
      // The public native model continues to use its Number cast, independently of the managed field.
      expect((await f.model.findById(id)).version).toBe(2);
    });

    test.each([false, true])('10: raw invalid versions survive hydration and batched references (supplied model %s)', async (supplied) => {
      const f = await fixture(backend, { supplied });
      const parent = ok(await f.add({ children: { added: [{ name: 'child' }] } }));
      for (const version of ['2', true, mongoose.mongo.Decimal128.fromString('2'), NaN]) {
        await f.set(parent.id, { version });
        const hydrated = await f.adapter.getById(f.model, parent.id);
        expect(hydrated).toBeInstanceOf(mongoose.Document);
        expect(hydrated.name).toBe(supplied ? 'ORIGINAL' : 'original');
        const native = await f.model.findById(parent.id);
        if (version === '2') expect(native.version).toBe(2);
        expect(ok(await f.run(`{ parent(id: "${parent.id}") { name } }`))).toEqual({ name: supplied ? 'ORIGINAL' : 'original' });
        expect(code(await f.run('{ parents { version } }'))).toBe('DATABASE_ERROR');
        const one = await f.read(parent.id);
        expect(code(one)).toBe('DATABASE_ERROR');
        expect(one.errors[0].path).toEqual(['parent', 'version']);
        const reference = await f.run(`{ child(id: "${parent.children[0].id}") { parent { version } } }`);
        expect(code(reference)).toBe('DATABASE_ERROR');
        expect(reference.errors[0].path).toEqual(['child', 'parent', 'version']);
      }
    });

    test('10: legacy missing/null versions normalize in reads, writes and onDelete; strings are corrupt', async () => {
      const f = await fixture(backend);
      for (const version of [undefined, null, '2']) {
        const id = new mongoose.Types.ObjectId();
        await f.model.collection.insertOne({ _id: id, name: 'legacy', tenant: 'A', ...(version === undefined ? {} : { version }) });
        const read = await f.read(String(id));
        if (version === '2') {
          expect(read.errors).toHaveLength(1);
          expect(read.errors[0].path).toEqual(['parent', 'version']);
          expect(code(await f.update({ id: String(id), version: 2 }))).toBe('DATABASE_ERROR');
          expect((await f.raw(String(id))).version).toBe('2');
        } else {
          expect(ok(read).version).toBe(1);
          const stored = await f.raw(String(id));
          if (version === null) expect(stored).toHaveProperty('version', null);
          else expect(stored).not.toHaveProperty('version');
          expect(ok(await f.update({ id: String(id), version: 1 })).version).toBe(2);
          await f.model.collection.updateOne({ _id: id }, version === null ? { $set: { version: null } } : { $unset: { version: '' } });
          let observed;
          f.hooks['parent.onDelete'] = (record) => { observed = record.version; };
          expect(ok(await f.remove(String(id), 1)).version).toBe(1);
          expect(observed).toBe(1);
        }
      }
    });

    test('10 R25: the documented inspection query exactly matches managed decoding of stored BSON', async () => {
      const f = await fixture(backend);
      const { Double, Int32, Long, Decimal128 } = mongoose.mongo;
      const cases = [
        ['missing', undefined, false], ['null', null, false], ['int-one', new Int32(1), false],
        ['double-two', new Double(2), false], ['long-two', Long.fromString('2'), false],
        ['wide', Long.fromString('2147483648'), false], ['max-minus-one', Long.fromString('9007199254740990'), false],
        ['max', Long.fromString('9007199254740991'), false], ['double-max', new Double(MAX), false],
        ['zero', 0, true], ['negative', -1, true], ['fraction', new Double(1.5), true], ['string', '2', true],
        ['nan', new Double(NaN), true], ['infinity', new Double(Infinity), true], ['negative-infinity', new Double(-Infinity), true],
        ['unsafe-double', new Double(9007199254740992), true], ['unsafe-long', Long.fromString('9007199254740992'), true],
        ['long-max', Long.fromString('9223372036854775807'), true], ['decimal', Decimal128.fromString('2'), true],
        ['decimal-fraction', Decimal128.fromString('1.5'), true], ['boolean', true, true], ['array', [2], true], ['object', { value: 2 }, true],
      ];
      await f.model.collection.insertMany(cases.map(([name, version]) => ({ name, ...(version === undefined ? {} : { version }) })));
      const stored = await f.model.collection.find({}).toArray();
      // This is the published recipe, executed against actual stored values with default BSON decoding.
      const invalid = await f.model.collection.find({ $expr: { $cond: [
        { $in: [{ $type: '$version' }, ['double', 'int', 'long']] },
        { $or: [{ $lt: ['$version', 1] }, { $gt: ['$version', 9007199254740991] }, { $ne: ['$version', { $trunc: ['$version', 0] }] }] },
        { $ne: [{ $ifNull: ['$version', null] }, null] },
      ] } }).toArray();
      const expected = cases.filter(([, , rejected]) => rejected).map(([name]) => name).sort();
      expect(invalid.map((row) => row.name).sort()).toEqual(expected);
      // Lazy import: baseline lacks this module; the missing managed field is the intended RED first.
      expect(f.Parent.getFields()).toHaveProperty('version');
      const { readStoredVersion } = await import('../../packages/core/src/record-version.js');
      const rejected = [];
      for (const row of stored) {
        try { readStoredVersion(row.version); }
        catch (error) { expect(error.extensions.code).toBe('DATABASE_ERROR'); rejected.push(row.name); }
      }
      expect(rejected.sort()).toEqual(expected);
      expect(stored.find((row) => row.name === 'decimal').version).toBeInstanceOf(Decimal128);
      expect(stored.find((row) => row.name === 'long-two').version).toBe(2);
    });

    if (backend.name === 'mongo-transactional') test.each(['update', 'delete'])(
      '5: readable caller early %s conflict preserves the supplied session and earlier writes', async (operation) => {
        const f = await fixture(backend, { scoped: true });
        const parent = ok(await f.add());
        await f.set(parent.id, { version: 2 });
        f.events.length = 0;
        const session = await mongoose.startSession();
        session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
        try {
          const marker = new mongoose.Types.ObjectId();
          await f.model.collection.insertOne({ _id: marker, name: 'earlier', version: 1 }, { session });
          const withTransaction = f.adapter.withTransaction;
          const supplied = vi.spyOn(f.adapter, 'withTransaction').mockImplementation((_session, callback, ...rest) => withTransaction(session, callback, ...rest));
          try {
            const result = operation === 'update'
              ? await f.update({ id: parent.id, version: 1, name: 'rejected' })
              : await f.remove(parent.id, 1);
            expect(code(result)).toBe('VERSION_CONFLICT');
            expect(f.events).toEqual([]);
          } finally { supplied.mockRestore(); }
          expect(session.inTransaction()).toBe(true);
          expect(await f.model.collection.findOne({ _id: marker }, { session })).toMatchObject({ name: 'earlier', version: 1 });
          expect(await f.raw(String(marker))).toBeNull();
          expect(await f.raw(parent.id)).toMatchObject({ name: 'original', version: 2 });
        } finally { if (session.inTransaction()) await session.abortTransaction(); await session.endSession(); }
      },
    );

    if (backend.name === 'mongo-transactional') test('5: hidden caller adapter conflict aborts the supplied session and earlier writes', async () => {
      const f = await fixture(backend, { scoped: true });
      const parent = ok(await f.add({ children: { added: [{ tenant: 'A', name: 'child' }] } }));
      await f.set(parent.children[0].id, { version: 2 }, true);
      const session = await mongoose.startSession();
      session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
      try {
        const marker = new mongoose.Types.ObjectId();
        await f.model.collection.insertOne({ _id: marker, name: 'earlier', version: 1 }, { session });
        const withTransaction = f.adapter.withTransaction;
        const supplied = vi.spyOn(f.adapter, 'withTransaction').mockImplementation((_session, callback, ...rest) => withTransaction(session, callback, ...rest));
        try {
          expect(code(await f.update({ id: parent.id, version: 1, children: { updated: [{ id: parent.children[0].id, version: 1 }] } }, { tenant: 'B', writeOnly: true }))).toBe('VERSION_CONFLICT');
          expect(f.events.some((event) => event.name === 'child.onUpdating')).toBe(true);
        } finally { supplied.mockRestore(); }
        expect(session.inTransaction()).toBe(false);
        expect(await f.raw(String(marker))).toBeNull();
      } finally { if (session.inTransaction()) await session.abortTransaction(); await session.endSession(); }
    });
  }
});

describe.skipIf(!postgresUri)('optimistic concurrency PostgreSQL parity paths', () => {
  const backend = backends[2];
  test('5,7: handle create/update/delete, derived bypass, exhaustion and supplied rollback', async () => {
    const f = await fixture(backend);
    const created = await f.model.create({ name: 'handle', version: 99 });
    expect(created.version).toBe(1);
    expect(await f.model.update(created.id, { version: 1, name: 'changed' })).toMatchObject({ name: 'changed', version: 2 });
    expect(await f.model.update(created.id, { total: 7 }, { version: false })).toMatchObject({ total: 7, version: 2 });
    await expect(f.adapter.withTransaction(null, async (session) => {
      expect(await f.model.update(created.id, { version: 2, name: 'rolled back' }, { session })).toMatchObject({ version: 3 });
      throw new Error('rollback handle');
    })).rejects.toThrow('rollback handle');
    expect(await f.model.findById(created.id)).toMatchObject({ name: 'changed', version: 2 });
    await f.set(created.id, { version: MAX });
    await expect(f.model.update(created.id, { version: MAX })).rejects.toMatchObject({ extensions: { code: 'VERSION_EXHAUSTED' } });
    expect(Number((await f.raw(created.id)).version)).toBe(MAX);
    expect(await f.model.delete(created.id, { version: MAX })).toMatchObject({ version: MAX });
    const bypass = await f.model.create({ name: 'bypass' });
    expect(await f.model.delete(bypass.id, { version: false })).toMatchObject({ version: 1 });
  });

  test('7: synchronized handle race commits one revision', async () => {
    const f = await fixture(backend);
    const parent = await f.model.create({ name: 'original' });
    expect(parent.version).toBe(1);
    let arrivals = 0;
    const race = createControlledRace();
    const both = race.gate('both handle writes');
    const original = f.adapter.getById;
    // Handle updates reach the same adapter without a core pre-read; hold each owned transaction
    // before its conditional write so both callers carry the same submitted version.
    const update = f.adapter.update;
    const spy = vi.spyOn(f.adapter, 'update').mockImplementation(async (...args) => {
      if (++arrivals <= 2) { if (arrivals === 2) both.resolve(); await both.wait(); }
      return update(...args);
    });
    try {
      const results = await race.wait(Promise.allSettled(['one', 'two'].map((name) => race.start(() => f.model.update(parent.id, { name, version: 1 })))));
      const winners = results.filter((result) => result.status === 'fulfilled');
      expect(winners).toHaveLength(1);
      expect(results.find((result) => result.status === 'rejected').reason.extensions.code).toBe('VERSION_CONFLICT');
      expect(await original(f.model, parent.id)).toMatchObject({ version: 2, name: winners[0].value.name });
    } finally { await race.finish(); spy.mockRestore(); }
  }, 20000);

  test('10: existing rows require the exact ALTER and then read as version one', async () => {
    const f = await fixture(backend);
    const parent = await f.model.create({ name: 'existing' });
    expect(parent.version).toBe(1);
    const target = `"${f.dbSchema}"."${f.Parent.name}"`;
    await pool.query(`ALTER TABLE ${target} DROP COLUMN "version"`);
    const alter = `ALTER TABLE ${target} ADD COLUMN "version" bigint NOT NULL DEFAULT 1;`;
    for (const mode of ['create', 'validate']) {
      await expect(f.adapter.initialize({ mode })).rejects.toMatchObject({ extensions: { code: 'SCHEMA_MISMATCH' }, message: expect.stringContaining(alter) });
    }
    await pool.query(alter);
    await f.adapter.initialize({ mode: 'validate' });
    expect(ok(await f.read(parent.id))).toMatchObject({ name: 'existing', version: 1 });
  });

  test.each(['create', 'validate'])('10: leftover version explains startup refusal, even at equal column count (%s)', async (mode) => {
    const f = await fixture(backend, { protectedType: false });
    const target = `"${f.dbSchema}"."${f.Parent.name}"`;
    await pool.query(`ALTER TABLE ${target} ADD COLUMN "version" bigint NOT NULL DEFAULT 1`);
    for (const equalCount of [false, true]) {
      if (equalCount) await pool.query(`ALTER TABLE ${target} DROP COLUMN "name"`);
      await expect(f.adapter.initialize({ mode })).rejects.toMatchObject({ extensions: { code: 'SCHEMA_MISMATCH' }, message: expect.stringContaining('while the column exists, instances without it cannot start') });
      await expect(f.adapter.initialize({ mode })).rejects.toThrow(`ALTER TABLE ${target} DROP COLUMN "version";`);
    }
  });
});
