import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GraphQLEnumType, GraphQLID, GraphQLInputObjectType, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, graphql } from 'graphql';
import pg from 'pg';
import { createPostgres, SimfinityError } from '../../packages/postgres/src/index.js';

const uri = process.env.SIMFINITY_POSTGRES_URI;
describe.skipIf(!uri)('PostgreSQL mutation lifecycle', () => {
  const namespace = `lifecycle_${randomUUID().replaceAll('-', '')}`;
  let pool; let api; let schema; let Item; let stateActions;
  // Connections come from the real pool unless a test replaces how the runtime acquires them.
  let acquire = null;
  const execute = (source, variableValues, contextValue = {}) => graphql({ schema, source, variableValues, contextValue });
  const add = (input, context) => execute('mutation($input:LifecycleItemInput!){additem(input:$input){id name tags state}}', { input }, context);
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: uri });
    api = createPostgres({ pool: { connect: () => (acquire ? acquire() : pool.connect()), query: (...args) => pool.query(...args) }, schema: namespace });
    const State = new GraphQLEnumType({ name: 'LifecycleState', values: { DRAFT: { value: 'PUBLISHED' }, PUBLISHED: { value: 'FINAL' }, DONE: { value: 'CLOSED' } } });
    Item = new GraphQLObjectType({ name: 'LifecycleItem', fields: {
      id: { type: GraphQLID }, name: { type: new GraphQLNonNull(GraphQLString), extensions: { unique: true } },
      tags: { type: new GraphQLList(GraphQLString) }, state: { type: State },
    } });
    const controller = {
      async onSaving(record, args, session, context) {
        if (context?.ownQuery) await pool.query(context.ownQuery);
        if (context && 'throwValue' in context) throw context.throwValue;
        if (context?.events) context.events.push({ hook: 'saving', id: record._id, name: args.name, tags: [...(args.tags || [])], session, active: session?.inTransaction() });
      },
      async onSaved(record, args, session, context) {
        if (context?.failure === 'saved') throw new SimfinityError('Saved hook rejected', 'HOOK_REJECTED', 400);
        // Application code that tolerates a failed statement, such as an optional audit insert.
        if (context?.swallow) await session.query('SELECT 1/0').catch(() => {});
        if (context?.retry && context.events.length === 1) {
          args.name = 'changed by failed attempt';
          args.tags.push('changed by failed attempt');
          throw Object.assign(new Error('serialization failure'), { code: '40001' });
        }
      },
      onUpdated(record, session, context) {
        if (context?.failure === 'updated') throw new SimfinityError('Updated hook rejected', 'HOOK_REJECTED', 400);
      },
    };
    api.connect(null, Item, 'item', 'items', controller, null, {
      initialState: { name: 'DRAFT', value: 'PUBLISHED' },
      actions: {
        publish: { from: { name: 'DRAFT', value: 'PUBLISHED' }, to: { name: 'PUBLISHED', value: 'FINAL' }, action: () => { stateActions++; } },
        finish: { from: { name: 'PUBLISHED', value: 'FINAL' }, to: { name: 'DONE', value: 'CLOSED' } },
      },
    });
    const CustomInput = new GraphQLInputObjectType({ name: 'LifecycleCustomInput', fields: { name: { type: new GraphQLNonNull(GraphQLString) } } });
    api.registerMutation('customItem', 'Custom transactional item', CustomInput, Item, async (args, session, context) => {
      const record = await api.saveObject(Item.name, args, session, context);
      if (context.failure === 'custom') throw new SimfinityError('Custom mutation rejected', 'CUSTOM_REJECTED', 400);
      if (context.failure === 'domain') throw Object.assign(new Error('Custom domain failure'), { code: 'CUSTOM_DOMAIN' });
      return record;
    });
    schema = api.createSchema();
    await api.initializeDatabase();
  });
  beforeEach(async () => { await pool.query(`TRUNCATE "${namespace}"."LifecycleItem"`); stateActions = 0; acquire = null; });
  afterAll(async () => { if (pool) { await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); await pool.end(); } });

  it('rolls back generated writes when saved or updated hooks reject', async () => {
    const failed = await add({ name: 'Rejected' }, { failure: 'saved' });
    expect(failed.errors?.[0].extensions.code).toBe('HOOK_REJECTED');
    expect(await api.getModel(Item).find()).toEqual([]);
    const added = await add({ name: 'Original' });
    const id = added.data.additem.id;
    const updated = await execute('mutation($input:LifecycleItemInputForUpdate!){updateitem(input:$input){name}}', { input: { id, name: 'Rejected update' } }, { failure: 'updated' });
    expect(updated.errors?.[0].extensions.code).toBe('HOOK_REJECTED');
    expect((await api.getModel(Item).findById(id)).name).toBe('Original');
  });

  it('runs registered mutations and saveObject in one owned transaction', async () => {
    const context = { failure: 'custom', events: [] };
    const failed = await execute('mutation{customItem(input:{name:"Custom"}){id}}', undefined, context);
    expect(failed.errors?.[0].extensions.code).toBe('CUSTOM_REJECTED');
    expect(context.events[0]).toMatchObject({ active: true, name: 'Custom' });
    expect(context.events[0].session.inTransaction()).toBe(false);
    expect(await api.getModel(Item).find()).toEqual([]);
    const succeeded = await execute('mutation{customItem(input:{name:"Custom"}){name state}}');
    expect(succeeded.errors).toBeUndefined();
    expect(succeeded.data.customItem).toEqual({ name: 'Custom', state: 'DRAFT' });
  });

  it('joins supplied sessions without committing or releasing them and rejects foreign/expired handles', async () => {
    let captured;
    await expect(api.withTransaction(null, async (session) => {
      captured = session;
      const first = await session.query('SELECT txid_current() AS id');
      await api.withTransaction(session, async (same) => {
        expect(same).toBe(session);
        expect((await same.query('SELECT txid_current() AS id')).rows).toEqual(first.rows);
        await api.saveObject(Item.name, { name: 'Caller owned' }, same);
      });
      expect(session.inTransaction()).toBe(true);
      expect((await api.getModel(Item).find({}, { session }))).toHaveLength(1);
      expect(await api.getModel(Item).find()).toEqual([]);
      throw new Error('Caller rollback');
    })).rejects.toThrow('Caller rollback');
    expect(await api.getModel(Item).find()).toEqual([]);
    expect(captured.inTransaction()).toBe(false);
    await expect(api.getModel(Item).find({}, { session: captured })).rejects.toMatchObject({ extensions: { code: 'INVALID_SESSION' } });
    await expect(api.withTransaction({ client: pool, inTransaction: () => true }, () => {})).rejects.toMatchObject({ extensions: { code: 'INVALID_SESSION' } });
  });

  it('starts retry attempts with fresh input and rolls back the failed attempt', async () => {
    const context = { retry: true, events: [] };
    const result = await add({ name: 'Retry', tags: ['original'] }, context);
    expect(result.errors).toBeUndefined();
    expect(result.data.additem).toMatchObject({ name: 'Retry', tags: ['original'] });
    expect(context.events.map(({ name, tags }) => ({ name, tags }))).toEqual([{ name: 'Retry', tags: ['original'] }, { name: 'Retry', tags: ['original'] }]);
    expect(context.events[0].id).not.toBe(context.events[1].id);
    expect(context.events.every(({ session }) => !session.inTransaction())).toBe(true);
    expect(await api.getModel(Item).find()).toHaveLength(1);
  });

  it('allows only one concurrent transition from the same state', async () => {
    const added = await add({ name: 'Stateful' });
    const id = added.data.additem.id;
    const publish = () => execute('mutation($input:LifecycleItemInputForUpdate!){publish_item(input:$input){id state}}', { input: { id } });
    const results = await Promise.all([publish(), publish()]);
    expect(results.filter((result) => !result.errors)).toHaveLength(1);
    expect(results.find((result) => result.errors).errors[0].extensions.code).toBe('BAD_REQUEST');
    expect(stateActions).toBe(1);
    expect((await api.getModel(Item).findById(id)).state).toBe('FINAL');
    const read = await execute('query($id:ID){item(id:$id){state}}', { id });
    expect(read.data.item.state).toBe('PUBLISHED');
  });

  it('keeps internal state storage while filters prefer overlapping member names', async () => {
    const result = await add({ name: 'Overlapping state' });
    expect(result.errors).toBeUndefined();
    const filtered = await execute('{items(state:{value:"PUBLISHED"}){name state}}');
    expect(filtered.errors).toBeUndefined();
    expect(filtered.data.items).toEqual([]);
    expect((await execute('{items(state:{value:"DRAFT"}){name state}}')).data.items).toEqual([{ name: 'Overlapping state', state: 'DRAFT' }]);
    expect((await api.getModel(Item).findById(result.data.additem.id)).state).toBe('PUBLISHED');
    const denied = await execute('mutation($input:LifecycleItemInputForUpdate!){finish_item(input:$input){state}}', { input: { id: result.data.additem.id } });
    expect(denied.errors?.[0].extensions.code).toBe('BAD_REQUEST');
  });

  it('reports database errors without SQL or constraint details', async () => {
    expect((await add({ name: 'Unique' })).errors).toBeUndefined();
    const duplicate = await add({ name: 'Unique' });
    expect(duplicate.errors?.[0].extensions.code).toBe('DUPLICATE_KEY');
    expect(duplicate.errors[0].message).toBe('Unique value already exists');
    await expect(api.getModel(Item).findById('invalid')).rejects.toMatchObject({ extensions: { code: 'NOT_VALID_ID' } });
    await expect(api.withTransaction(null, (session) => session.query('SELECT missing_column FROM nonexistent_private_table'))).rejects.toMatchObject({ message: 'Database operation failed', extensions: { code: 'DATABASE_ERROR' } });
    // The driver error stays available to server logging, never to clients.
    const cause = duplicate.errors[0].originalError.getCause();
    expect(cause).toMatchObject({ code: '23505', severity: 'ERROR', table: 'LifecycleItem' });
    for (const serialized of [JSON.stringify(duplicate.errors[0]), JSON.stringify(duplicate.errors[0].originalError), JSON.stringify({ ...duplicate.errors[0].originalError })]) {
      for (const detail of ['LifecycleItem', cause.constraint, cause.detail]) expect(serialized).not.toContain(detail);
    }
    // PostgreSQL errors from the native client or the application's own pool are mapped as well.
    const native = await api.withTransaction(null, (session) => session.client.query('SELECT missing_column FROM nonexistent_private_table')).catch((error) => error);
    expect(native).toMatchObject({ message: 'Database operation failed', extensions: { code: 'DATABASE_ERROR', status: 500 } });
    expect(native.getCause().code).toBe('42P01');
    const own = await add({ name: 'Own pool' }, { ownQuery: 'SELECT 1/0' });
    expect(own.errors?.[0].extensions).toMatchObject({ code: 'DATABASE_ERROR', status: 500 });
    expect(own.errors[0].originalError.getCause().code).toBe('22012');
    expect(await api.getModel(Item).find()).toHaveLength(1);
  });

  it('propagates application errors unchanged, whether or not they carry a code, and rolls back', async () => {
    class DomainError extends Error { code = 'PAYMENT_DECLINED'; }
    const failures = [
      new DomainError('Card declined'),
      Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:8443'), { code: 'ECONNREFUSED', errno: -111, syscall: 'connect' }),
      // Shaped like a SQLSTATE but without a severity, so not a PostgreSQL error.
      Object.assign(new Error('Already registered'), { code: '23505' }),
    ];
    for (const failure of failures) {
      const added = await add({ name: 'Declined' }, { throwValue: failure });
      expect(added.errors?.[0].originalError).toBe(failure);
      expect(added.errors[0].message).toBe(failure.message);
      await expect(api.withTransaction(null, async (session) => {
        await session.query(`INSERT INTO "${namespace}"."LifecycleItem" (id, name, state) VALUES ($1, 'Raw', 'PUBLISHED')`, [randomUUID()]);
        throw failure;
      })).rejects.toBe(failure);
    }
    const custom = await execute('mutation{customItem(input:{name:"Custom"}){id}}', undefined, { failure: 'domain' });
    expect(custom.errors?.[0].message).toBe('Custom domain failure');
    expect(custom.errors[0].originalError.code).toBe('CUSTOM_DOMAIN');
    const thrownNull = await add({ name: 'Null' }, { throwValue: null });
    expect(thrownNull.errors?.[0].message).toBe('Unexpected error value: null');
    expect(await api.getModel(Item).find()).toEqual([]);
  });

  it('gives a session statement error to the callback unchanged so a savepoint can recover', async () => {
    await api.getModel(Item).create({ name: 'Taken' });
    const seen = [];
    await api.withTransaction(null, async (session) => {
      await session.query('SAVEPOINT before_insert');
      const error = await session.query(`INSERT INTO "${namespace}"."LifecycleItem" (id, name, state) VALUES ($1, 'Taken', 'PUBLISHED')`, [randomUUID()]).catch((caught) => caught);
      seen.push(error);
      await session.query('ROLLBACK TO SAVEPOINT before_insert');
      await session.query(`INSERT INTO "${namespace}"."LifecycleItem" (id, name, state) VALUES ($1, 'Second', 'PUBLISHED')`, [randomUUID()]);
    });
    expect(seen[0]).toBeInstanceOf(pg.DatabaseError);
    expect(seen[0]).toMatchObject({ code: '23505', severity: 'ERROR' });
    expect((await api.getModel(Item).find()).map((item) => item.name).sort()).toEqual(['Second', 'Taken']);
  });

  it('fails instead of reporting success when a caught statement error made PostgreSQL roll back the commit', async () => {
    const added = await add({ name: 'Ghost' }, { swallow: true });
    expect(added.data?.additem ?? null).toBeNull();
    expect(added.errors?.[0]).toMatchObject({ message: 'Transaction was rolled back because one of its statements failed', extensions: { code: 'DATABASE_ERROR', status: 500 } });
    // The same shape as other PostgreSQL database errors: a cause for server logging, never serialized.
    expect(added.errors[0].originalError.getCause()).toMatchObject({ message: 'COMMIT reported ROLLBACK' });
    expect(JSON.stringify(added.errors[0])).not.toContain('COMMIT reported ROLLBACK');
    expect(await api.getModel(Item).find()).toEqual([]);
    const body = vi.fn(async (session) => {
      await session.query(`INSERT INTO "${namespace}"."LifecycleItem" (id, name, state) VALUES ($1, 'Raw', 'PUBLISHED')`, [randomUUID()]);
      await session.query('SELECT 1/0').catch(() => {});
      return 'committed';
    });
    const error = await api.withTransaction(null, body).catch((caught) => caught);
    expect(error).toMatchObject({ message: 'Transaction was rolled back because one of its statements failed', extensions: { code: 'DATABASE_ERROR', status: 500 } });
    expect(error.getCause()).toBe(error.cause);
    expect(error.getCause()).toMatchObject({ message: 'COMMIT reported ROLLBACK' });
    expect(body).toHaveBeenCalledOnce();
    expect(await api.getModel(Item).find()).toEqual([]);
    // A later operation gets a clean connection.
    expect((await add({ name: 'After' })).errors).toBeUndefined();
  });

  it('masks connections that cannot be acquired, keeping the driver error as the cause', async () => {
    const missing = new URL(uri);
    missing.pathname = `/simfinity_missing_${randomUUID().replaceAll('-', '')}`;
    const pools = [new pg.Pool({ connectionString: 'postgresql://postgres:x@127.0.0.1:1/x', connectionTimeoutMillis: 2000 }), new pg.Pool({ connectionString: missing.href })];
    try {
      for (const [failing, expected] of [[pools[0], { code: 'ECONNREFUSED' }], [pools[1], { code: '3D000', severity: 'FATAL' }]]) {
        acquire = () => failing.connect();
        for (const result of [await add({ name: 'Unreachable' }), await execute('{items{name}}')]) {
          expect(result.errors?.[0]).toMatchObject({ message: 'Database operation failed', extensions: { code: 'DATABASE_ERROR', status: 500 } });
          expect(result.errors[0].originalError.getCause()).toMatchObject(expected);
          expect(JSON.stringify(result.errors[0])).not.toMatch(/127\.0\.0\.1|simfinity_missing/);
        }
        const error = await api.withTransaction(null, async () => 'never').catch((caught) => caught);
        expect(error).toMatchObject({ extensions: { code: 'DATABASE_ERROR' } });
        expect(error.getCause()).toMatchObject(expected);
      }
    } finally {
      acquire = null;
      await Promise.all(pools.map((item) => item.end()));
    }
  });

  it('marks storage unavailable after a failed revalidation', async () => {
    await pool.query(`ALTER TABLE "${namespace}"."LifecycleItem" ALTER COLUMN name DROP NOT NULL`);
    await expect(api.initializeDatabase({ mode: 'validate' })).rejects.toBeDefined();
    expect((await execute('{items{name}}')).errors?.[0].extensions.code).toBe('DATABASE_NOT_INITIALIZED');
    await pool.query(`ALTER TABLE "${namespace}"."LifecycleItem" ALTER COLUMN name SET NOT NULL`);
    await api.initializeDatabase({ mode: 'validate' });
  });
});
