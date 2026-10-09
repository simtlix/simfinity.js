// Collections of children whose only writable field is the back-reference (#161), on real databases:
// the schema validates, children are created with their own add mutation, and the parent's
// collection input keeps `updated` and `deleted`.
import { randomUUID } from 'node:crypto';
import {
  afterAll, beforeAll, describe, expect, test, vi,
} from 'vitest';
import {
  GraphQLID, GraphQLList, GraphQLObjectType, GraphQLString, graphql, validateSchema,
} from 'graphql';
import mongoose from 'mongoose';
import pg from 'pg';

import { createRuntime } from '../../packages/core/src/index.js';
import { createMongoAdapter } from '../../packages/mongodb/src/mongo/adapter.js';
import { createPostgres } from '../../packages/postgres/src/index.js';

const ref = (connectionField) => ({
  relation: { embedded: false, ...(connectionField ? { connectionField } : {}) },
});

const backends = [
  {
    name: 'mongodb',
    prefix: 'Eim',
    uri: process.env.SIMFINITY_MONGODB_URI,
    async open(namespace) { await mongoose.connect(this.uri, { dbName: namespace }); },
    create() {
      const api = createRuntime(createMongoAdapter());
      api.preventCreatingCollection(true);
      return api;
    },
    async initialize(api) {
      for (const { model } of api.getRegistrations()) if (model) await model.createCollection();
    },
    async close() {
      if (mongoose.connection.readyState) {
        await mongoose.connection.db.dropDatabase();
        await mongoose.disconnect();
      }
    },
  },
  {
    name: 'postgres',
    prefix: 'Eip',
    uri: process.env.SIMFINITY_POSTGRES_URI,
    async open(namespace) {
      this.namespace = namespace;
      this.pool = new pg.Pool({ connectionString: this.uri });
    },
    create() { return createPostgres({ pool: this.pool, schema: this.namespace }); },
    initialize: (api) => api.initializeDatabase(),
    async close() {
      if (!this.pool) return;
      await this.pool.query(`DROP SCHEMA IF EXISTS "${this.namespace}" CASCADE`);
      await this.pool.end();
    },
  },
];

describe.each(backends)('collections without `added` on $name', (backend) => {
  const p = backend.prefix;
  let schema;
  const run = async (source) => {
    const result = await graphql({ schema, source, contextValue: {} });
    expect(result.errors).toBeUndefined();
    return result.data;
  };

  beforeAll(async () => {
    if (!backend.uri) return;
    await backend.open(`empty_inputs_${randomUUID().replaceAll('-', '').slice(0, 16)}`);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = backend.create();
    const Author = new GraphQLObjectType({
      name: `${p}IntAuthor`,
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        books: { type: new GraphQLList(Book), extensions: ref('author') },
      }),
    });
    const Book = new GraphQLObjectType({
      name: `${p}IntBook`,
      fields: () => ({ id: { type: GraphQLID }, author: { type: Author, extensions: ref() } }),
    });
    api.connect(null, Author, 'author', 'authors');
    api.connect(null, Book, 'book', 'books');
    schema = api.createSchema();
    await backend.initialize(api);
    vi.restoreAllMocks();
  });
  afterAll(() => backend.close());

  test.skipIf(!backend.uri)('creates children with their own mutation, and updates and deletes them through the parent', async () => {
    expect(validateSchema(schema)).toEqual([]);
    expect(Object.keys(schema.getType(`OneToMany${p}IntAuthorUbooks`).getFields())).toEqual(['updated', 'deleted']);
    const { addauthor: author } = await run('mutation { addauthor(input: { name: "Ann" }) { id } }');
    const { addbook: book } = await run(`mutation { addbook(input: { author: { id: "${author.id}" } }) { id } }`);
    const books = `{ author(id: "${author.id}") { books { id author { id } } } }`;
    expect((await run(books)).author.books).toEqual([{ id: book.id, author: { id: author.id } }]);
    await run(`mutation { updateauthor(input: { id: "${author.id}", name: "Bea",
      books: { updated: [{ id: "${book.id}" }] } }) { id } }`);
    expect((await run(books)).author.books).toEqual([{ id: book.id, author: { id: author.id } }]);
    await run(`mutation { updateauthor(input: { id: "${author.id}", books: { deleted: ["${book.id}"] } }) { id } }`);
    expect((await run(books)).author.books).toEqual([]);
    expect((await run('{ books { id } }')).books).toEqual([]);
  });
});
