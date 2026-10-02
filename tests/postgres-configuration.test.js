import { describe, expect, it, vi } from 'vitest';
import {
  GraphQLID, GraphQLList, GraphQLObjectType, GraphQLString, graphql, printSchema,
} from 'graphql';
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

const libraryTypes = (prefix) => {
  const Author = new GraphQLObjectType({
    name: `${prefix}Author`,
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      books: { type: new GraphQLList(Book), extensions: { relation: { embedded: false, connectionField: 'author' } } },
    }),
  });
  const Book = new GraphQLObjectType({
    name: `${prefix}Book`,
    fields: () => ({
      id: { type: GraphQLID },
      title: { type: GraphQLString },
      author: { type: Author, extensions: { relation: { embedded: false, connectionField: 'author' } } },
    }),
  });
  return { Author, Book };
};
const instance = (schema) => createPostgres({ pool: { connect: vi.fn(), query: vi.fn() }, schema });
const registerLibrary = (api, { Author, Book }) => {
  api.connect(null, Author, 'author', 'authors');
  api.connect(null, Book, 'book', 'books');
};

describe('PostgreSQL instances and GraphQL types', () => {
  it('rejects types whose relations another instance resolves', () => {
    const types = libraryTypes('TenantShared');
    const first = instance('tenant_a');
    registerLibrary(first, types);
    first.createSchema();
    const second = instance('tenant_b');

    expect(() => second.connect(null, types.Author, 'author', 'authors'))
      .toThrow(expect.objectContaining({ extensions: expect.objectContaining({ code: 'TYPE_BOUND_TO_OTHER_RUNTIME' }) }));
    expect(second.getRegistrations()).toHaveLength(0);
  });

  it('builds identical schemas for instances with their own type objects', () => {
    const schemas = ['tenant_a', 'tenant_b'].map((name) => {
      const api = instance(name);
      registerLibrary(api, libraryTypes('TenantOwn'));
      return api.createSchema();
    });

    expect(printSchema(schemas[1])).toBe(printSchema(schemas[0]));
  });
});
