import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GraphQLID, GraphQLObjectType, GraphQLString, graphql } from 'graphql';
import pg from 'pg';
import { createSQL } from '../../packages/sql/src/index.js';
import { createPostgres, postgresPlugin } from '../../packages/postgres/src/index.js';

const uri = process.env.SIMFINITY_POSTGRES_URI;
describe.skipIf(!uri)('SQL PostgreSQL entry point', () => {
  it('shares PostgreSQL storage and lifecycle behavior with the facade', async () => {
    const pool = new pg.Pool({ connectionString: uri });
    const namespace = `sql_entry_${randomUUID().replaceAll('-', '')}`;
    try {
      const Item = new GraphQLObjectType({ name: 'SQLEntryItem', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
      const runtime = createSQL({ plugin: postgresPlugin({ pool, schema: namespace }) });
      const facade = createPostgres({ pool, schema: namespace });
      for (const api of [runtime, facade]) { api.connect(null, Item, 'item', 'items'); api.createSchema(); }
      expect(runtime.describeDatabase()).toEqual(facade.describeDatabase());
      await runtime.initializeDatabase();
      await facade.initializeDatabase({ mode: 'validate' });
      const added = await runtime.getModel(Item).create({ name: 'shared' });
      expect(await facade.getModel(Item).findById(added.id)).toMatchObject({ name: 'shared' });
      await facade.getModel(Item).update(added.id, { name: 'updated' });
      const result = await graphql({ schema: runtime.createSchema(), source: '{items{name}}' });
      expect(result.errors).toBeUndefined();
      expect(result.data.items).toEqual([{ name: 'updated' }]);
      await runtime.getModel(Item).delete(added.id);
      expect(await facade.getModel(Item).findById(added.id)).toBeNull();
      expect((await pool.query('SELECT 1 AS alive')).rows[0].alive).toBe(1);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await pool.end();
    }
  });
});
