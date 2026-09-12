import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GraphQLList, GraphQLObjectType, GraphQLString, graphql } from 'graphql';
import pg from 'pg';
import { createPostgres, initializeDatabase } from '../../packages/postgres/src/index.js';

const uri = process.env.SIMFINITY_POSTGRES_URI;
const fixture = () => new GraphQLObjectType({ name: 'OptionsItem', fields: {
  id: { type: GraphQLString }, bucket: { type: GraphQLString }, text: { type: GraphQLString }, tags: { type: new GraphQLList(GraphQLString) },
} });
describe.skipIf(!uri)('PostgreSQL storage options and scalar edge cases', () => {
  const namespace = `options_${randomUUID().replaceAll('-', '')}`;
  const disabled = `${namespace}_disabled`;
  let pool; let api; let Item; let schema;
  const execute = (source, variableValues) => graphql({ schema, source, variableValues });
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: uri });
    api = createPostgres({ pool, schema: namespace });
    Item = fixture(); api.connect(null, Item, 'item', 'items'); schema = api.createSchema();
    await api.initializeDatabase();
  });
  afterAll(async () => { if (pool) { for (const name of [namespace, disabled]) await pool.query(`DROP SCHEMA IF EXISTS "${name}" CASCADE`); await pool.end(); } });

  it('can require validation without creating any database objects', async () => {
    const reader = createPostgres({ pool, schema: disabled });
    reader.preventCreatingCollection(true);
    reader.connect(null, fixture(), 'item', 'items');
    const readSchema = reader.createSchema();
    await expect(reader.initializeDatabase()).rejects.toMatchObject({ extensions: { code: 'SCHEMA_MISMATCH' } });
    expect((await pool.query('SELECT 1 FROM pg_namespace WHERE nspname = $1', [disabled])).rows).toEqual([]);
    await expect(reader.initializeDatabase({ mode: 'create' })).rejects.toMatchObject({ extensions: { code: 'DATABASE_CREATION_DISABLED' } });
    await initializeDatabase(pool, reader.describeDatabase());
    expect(await reader.initializeDatabase()).toEqual({ mode: 'validate', created: [] });
    expect((await graphql({ schema: readSchema, source: '{items{id}}' })).errors).toBeUndefined();
  });

  it('supports String-declared UUID identities and ID MIN/MAX facts', async () => {
    const first = await api.getModel(Item).create({ bucket: 'ids', text: 'First' });
    const second = await api.getModel(Item).create({ bucket: 'ids', text: 'Second' });
    const read = await execute('query($id:ID){item(id:$id){id text}}', { id: first.id });
    expect(read.errors).toBeUndefined();
    expect(read.data.item).toEqual({ id: first.id, text: 'First' });
    const aggregate = await execute('{items_aggregate(bucket:{value:"ids"},aggregation:{groupId:"bucket",facts:[{operation:MIN,factName:"first",path:"id"},{operation:MAX,factName:"last",path:"id"}]}){facts}}');
    expect(aggregate.errors).toBeUndefined();
    const sorted = [first.id, second.id].sort();
    expect(aggregate.data.items_aggregate).toEqual([{ facts: { first: sorted[0], last: sorted[1] } }]);
  });

  it('uses binary text ordering and detects a change to ICU column collation', async () => {
    for (const text of ['a', 'B', 'z', 'Z', 'á', 'Ä']) await api.getModel(Item).create({ bucket: 'text', text, tags: [text] });
    const assertOrder = async () => {
      const result = await execute('{items(bucket:{value:"text"},sort:{terms:[{field:"text",order:ASC}]}){text}}');
      expect(result.errors).toBeUndefined();
      expect(result.data.items.map(({ text }) => text)).toEqual(['B', 'Z', 'a', 'z', 'Ä', 'á']);
      const filtered = await execute('{items(bucket:{value:"text"},text:{operator:LT,value:"B"}){text}}');
      expect(filtered.errors).toBeUndefined();
      expect(filtered.data.items).toEqual([]);
      const array = await execute('{items(bucket:{value:"text"},sort:{terms:[{field:"tags",order:ASC}]}){text}}');
      expect(array.errors).toBeUndefined();
      expect(array.data.items).toEqual(result.data.items);
    };
    await assertOrder();
    await pool.query(`CREATE COLLATION "${namespace}".language_order (provider = icu, locale = 'en-US')`);
    await pool.query(`ALTER TABLE "${namespace}"."OptionsItem" ALTER COLUMN text TYPE text COLLATE "${namespace}".language_order`);
    await assertOrder();
    await expect(api.initializeDatabase({ mode: 'validate' })).rejects.toMatchObject({ extensions: { code: 'SCHEMA_MISMATCH' } });
    await pool.query(`ALTER TABLE "${namespace}"."OptionsItem" ALTER COLUMN text TYPE text COLLATE "pg_catalog"."C"`);
    await api.initializeDatabase({ mode: 'validate' });
  });
});
