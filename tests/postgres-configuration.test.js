import { describe, expect, it, vi } from 'vitest';
import { GraphQLID, GraphQLObjectType, GraphQLString, graphql } from 'graphql';
import { createPostgres } from '../packages/postgres/src/index.js';

describe('PostgreSQL instance configuration', () => {
  it('binds a snapshot of the pool and schema and rejects reconfiguration and late registration', () => {
    const original = { connect: vi.fn(), query: vi.fn() };
    const options = { pool: original, schema: 'original' };
    const api = createPostgres(options);
    options.schema = 'changed';
    options.pool = null;
    const Item = new GraphQLObjectType({ name: 'ConfigurationItem', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
    api.connect(null, Item, 'item', 'items');
    api.createSchema();
    expect(api.describeDatabase().schema).toBe('original');
    expect(() => api.configure({ pool: original })).toThrow('already bound');
    expect(() => api.addNoEndpointType(new GraphQLObjectType({ name: 'LateItem', fields: { name: { type: GraphQLString } } }))).toThrow('before creating');
    expect(api.getRegistrations()).toHaveLength(1);
  });

  it('rejects operations before initialization without opening a connection', async () => {
    const pool = { connect: vi.fn(), query: vi.fn() };
    const api = createPostgres();
    api.configure({ pool });
    api.connect(null, new GraphQLObjectType({ name: 'UninitializedItem', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } }), 'item', 'items');
    const result = await graphql({ schema: api.createSchema(), source: '{items{id}}' });
    expect(result.errors?.[0].extensions.code).toBe('DATABASE_NOT_INITIALIZED');
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });
});
