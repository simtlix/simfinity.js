import { randomUUID } from 'node:crypto';
import {
  afterAll, beforeAll, describe, expect, it, vi,
} from 'vitest';
import {
  GraphQLID, GraphQLInt, GraphQLList, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';
import mongoose from 'mongoose';
import pg from 'pg';

import { createRuntime } from '../../packages/core/src/index.js';
import { createMongoAdapter } from '../../packages/mongodb/src/mongo/adapter.js';
import { createSQLAdapter } from '../../packages/sql/src/adapter.js';
import { postgresPlugin } from '../../packages/postgres/src/index.js';

// Core's batched collection loader (#165) with the records the bundled adapters return: a test-only
// findChildrenBatch reads each parent with the adapter's own findChildren, so the loader's handling
// of raw parent IDs (ObjectId instances, UUID strings) and its check of each record's stored parent
// are exercised against real data, whatever batching the adapters themselves implement.

const mongoUri = process.env.SIMFINITY_MONGODB_URI;
const postgresUri = process.env.SIMFINITY_POSTGRES_URI;
const describeWithDatabases = mongoUri && postgresUri ? describe : describe.skip;

const createTypes = () => {
  const Book = new GraphQLObjectType({
    name: 'CBCoreBook',
    fields: () => ({
      id: { type: GraphQLID },
      title: { type: GraphQLString },
      year: { type: GraphQLInt },
      // Stored under another name, so the loader must find the parent under the storage name.
      writer: { type: Author, extensions: { relation: { connectionField: 'writer_id' } } },
    }),
  });
  const Author = new GraphQLObjectType({
    name: 'CBCoreAuthor',
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      books: { type: new GraphQLList(Book), extensions: { relation: { connectionField: 'writer_id' } } },
    }),
  });
  return { Author, Book };
};

const sources = [
  ['unsorted', '{ cbcoreauthors(sort: { terms: [{ field: "name", order: ASC }] }) { name books { title year } } }'],
  ['sorted and paged', '{ cbcoreauthors(sort: { terms: [{ field: "name", order: ASC }] }) { name books(sort: { terms: [{ field: "year", order: DESC }, { field: "title", order: ASC }] }, pagination: { page: 1, size: 2 }) { title year } } }'],
];

describeWithDatabases('core collection batching with MongoDB and PostgreSQL records (#165)', () => {
  const namespace = `cbcore_${randomUUID().replaceAll('-', '')}`;
  let pool;
  const backends = [];

  beforeAll(async () => {
    await mongoose.connect(mongoUri, { dbName: namespace });
    pool = new pg.Pool({ connectionString: postgresUri });
    for (const name of ['mongo', 'postgres']) {
      const adapter = name === 'mongo' ? createMongoAdapter() : createSQLAdapter(postgresPlugin({ pool, schema: namespace }));
      const runtime = createRuntime(adapter);
      const types = createTypes();
      if (name === 'mongo') runtime.preventCreatingCollection(true);
      runtime.connect(null, types.Book, 'cbcorebook', 'cbcorebooks');
      runtime.connect(null, types.Author, 'cbcoreauthor', 'cbcoreauthors');
      const schema = runtime.createSchema();
      if (name === 'postgres') await adapter.initialize();
      else for (const { model } of runtime.getRegistrations()) if (model) await model.createCollection();
      const run = async (source) => {
        const result = await graphql({ schema, source, contextValue: {} });
        expect(result.errors).toBeUndefined();
        return result.data;
      };
      for (let author = 0; author < 20; author += 1) {
        const { addcbcoreauthor: { id } } = await run(`mutation { addcbcoreauthor(input: { name: "Author ${String(author).padStart(2, '0')}" }) { id } }`);
        for (let book = 0; book < author % 4; book += 1) {
          await run(`mutation { addcbcorebook(input: { title: "Book ${author}-${book}", year: ${2000 + ((author + book) % 5)}, writer: { id: "${id}" } }) { id } }`);
        }
      }
      backends.push({ name, adapter, schema });
    }
  }, 120000);

  afterAll(async () => {
    vi.restoreAllMocks();
    if (mongoose.connection.readyState) {
      await mongoose.connection.db.dropDatabase();
      await mongoose.disconnect();
    }
    mongoose.deleteModel(/^CBCore/);
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await pool.end();
    }
  });

  // Replaces the adapter's batching members for one call of `body`, then restores them.
  const withTestBatch = async (adapter, batch, body) => {
    const saved = ['findChildrenBatch', 'batchesChildren'].map((key) => [key, Object.getOwnPropertyDescriptor(adapter, key)]);
    const findChildren = adapter.findChildren.bind(adapter);
    Object.assign(adapter, {
      findChildrenBatch: vi.fn((model, type, field, parentIds, args) => batch(
        parentIds.map((parentId) => findChildren(model, type, field, parentId, structuredClone(args), null)),
      )),
      batchesChildren: () => true,
    });
    const fallback = vi.spyOn(adapter, 'findChildren');
    try {
      return await body(adapter.findChildrenBatch, fallback);
    } finally {
      fallback.mockRestore();
      for (const [key, descriptor] of saved) {
        if (descriptor) Object.defineProperty(adapter, key, descriptor);
        else delete adapter[key];
      }
    }
  };

  // The per-parent result, with batching turned off.
  const perParent = async (backend, source) => {
    const saved = Object.getOwnPropertyDescriptor(backend.adapter, 'findChildrenBatch');
    backend.adapter.findChildrenBatch = undefined;
    try {
      return await graphql({ schema: backend.schema, source, contextValue: {} });
    } finally {
      if (saved) Object.defineProperty(backend.adapter, 'findChildrenBatch', saved);
      else delete backend.adapter.findChildrenBatch;
    }
  };

  it.each(sources)('accepts the bundled adapters\' records and raw parent IDs in one batch (%s)', async (label, source) => {
    for (const backend of backends) {
      const expected = await perParent(backend, source);
      expect(expected.errors).toBeUndefined();
      const warn = vi.spyOn(console, 'warn');
      await withTestBatch(backend.adapter, (reads) => Promise.all(reads), async (batch, fallback) => {
        const result = await graphql({ schema: backend.schema, source, contextValue: {} });
        expect(result).toEqual(expected);
        expect(batch).toHaveBeenCalledTimes(1);
        const [, , field, parentIds, , options] = batch.mock.calls[0];
        expect(field).toBe('writer_id');
        expect(parentIds).toHaveLength(20);
        if (backend.name === 'mongo') expect(parentIds.every((id) => id instanceof mongoose.Types.ObjectId)).toBe(true);
        else expect(parentIds.every((id) => typeof id === 'string')).toBe(true);
        expect(options).toEqual({ context: {} });
        // No fallback: the loader recognized every record's stored parent.
        expect(fallback).not.toHaveBeenCalled();
      });
      expect(warn).not.toHaveBeenCalled();
      warn.mockRestore();
    }
  });

  it('reads per field when a batch hands parents the records of other parents', async () => {
    const [, source] = sources[0];
    for (const backend of backends) {
      const expected = await perParent(backend, source);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const rotate = async (reads) => {
        const lists = await Promise.all(reads);
        return lists.map((_, index) => lists[(index + 1) % lists.length]);
      };
      await withTestBatch(backend.adapter, rotate, async (batch, fallback) => {
        const result = await graphql({ schema: backend.schema, source, contextValue: {} });
        expect(result).toEqual(expected);
        expect(batch).toHaveBeenCalledTimes(1);
        expect(fallback).toHaveBeenCalledTimes(20);
      });
      expect(warn.mock.calls.filter(([message]) => message.includes('findChildrenBatch'))).toHaveLength(1);
      warn.mockRestore();
    }
  });
});
