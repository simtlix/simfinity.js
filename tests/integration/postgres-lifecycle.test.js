import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { GraphQLEnumType, GraphQLID, GraphQLInputObjectType, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, graphql } from 'graphql';
import pg from 'pg';
import { createPostgres, SimfinityError } from '../../packages/postgres/src/index.js';

const uri = process.env.SIMFINITY_POSTGRES_URI;
describe.skipIf(!uri)('PostgreSQL mutation lifecycle', () => {
  const namespace = `lifecycle_${randomUUID().replaceAll('-', '')}`;
  let pool; let api; let schema; let Item; let stateActions;
  const execute = (source, variableValues, contextValue = {}) => graphql({ schema, source, variableValues, contextValue });
  const add = (input, context) => execute('mutation($input:LifecycleItemInput!){additem(input:$input){id name tags state}}', { input }, context);
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: uri });
    api = createPostgres({ pool, schema: namespace });
    const State = new GraphQLEnumType({ name: 'LifecycleState', values: { DRAFT: { value: 'PUBLISHED' }, PUBLISHED: { value: 'FINAL' }, DONE: { value: 'CLOSED' } } });
    Item = new GraphQLObjectType({ name: 'LifecycleItem', fields: {
      id: { type: GraphQLID }, name: { type: new GraphQLNonNull(GraphQLString), extensions: { unique: true } },
      tags: { type: new GraphQLList(GraphQLString) }, state: { type: State },
    } });
    const controller = {
      onSaving(record, args, session, context) {
        if (context?.events) context.events.push({ hook: 'saving', id: record._id, name: args.name, tags: [...(args.tags || [])], session, active: session?.inTransaction() });
      },
      onSaved(record, args, session, context) {
        if (context?.failure === 'saved') throw new SimfinityError('Saved hook rejected', 'HOOK_REJECTED', 400);
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
      return record;
    });
    schema = api.createSchema();
    await api.initializeDatabase();
  });
  beforeEach(async () => { await pool.query(`TRUNCATE "${namespace}"."LifecycleItem"`); stateActions = 0; });
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

  it('uses enum internal values consistently when they overlap another state name', async () => {
    const result = await add({ name: 'Overlapping state' });
    expect(result.errors).toBeUndefined();
    const filtered = await execute('{items(state:{value:"PUBLISHED"}){name state}}');
    expect(filtered.errors).toBeUndefined();
    expect(filtered.data.items).toEqual([{ name: 'Overlapping state', state: 'DRAFT' }]);
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
  });

  it('marks storage unavailable after a failed revalidation', async () => {
    await pool.query(`ALTER TABLE "${namespace}"."LifecycleItem" ALTER COLUMN name DROP NOT NULL`);
    await expect(api.initializeDatabase({ mode: 'validate' })).rejects.toBeDefined();
    expect((await execute('{items{name}}')).errors?.[0].extensions.code).toBe('DATABASE_NOT_INITIALIZED');
    await pool.query(`ALTER TABLE "${namespace}"."LifecycleItem" ALTER COLUMN name SET NOT NULL`);
    await api.initializeDatabase({ mode: 'validate' });
  });
});
