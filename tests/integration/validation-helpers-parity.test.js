import { randomUUID } from 'node:crypto';
import {
  afterAll, beforeAll, describe, expect, test, vi,
} from 'vitest';
import {
  GraphQLID, GraphQLInt, GraphQLList, GraphQLObjectType, GraphQLScalarType, GraphQLString, Kind, graphql,
} from 'graphql';
import mongoose from 'mongoose';
import pg from 'pg';

import { createRuntime, scalars, validators } from '../../packages/core/src/index.js';
import { createMongoAdapter } from '../../packages/mongodb/src/mongo/adapter.js';
import { createPostgres } from '../../packages/postgres/src/index.js';

const mongoUri = process.env.SIMFINITY_MONGODB_URI;
const postgresUri = process.env.SIMFINITY_POSTGRES_URI;

const pad = (number) => String(number).padStart(2, '0');

// An application scalar named Date that keeps strings as sent. Both backends store a field of a type named Date as a
// date (a Mongoose Date path, a timestamptz column), parsing the string with new Date(). Reads print the local
// calendar date, which is the one new Date() read from a slashed value.
const createDateScalar = () => new GraphQLScalarType({
  name: 'Date',
  serialize: (value) => (value instanceof Date
    ? `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`
    : value),
  parseValue: (value) => value,
  parseLiteral: (ast) => (ast.kind === Kind.STRING ? ast.value : undefined),
});

const createTypes = (prefix) => {
  const Post = new GraphQLObjectType({
    name: `${prefix}Post`,
    fields: () => ({
      id: { type: GraphQLID },
      tags: {
        type: new GraphQLList(GraphQLString),
        extensions: { validations: validators.arrayLength('Tags', 5, validators.maxLength('Tag', 3)) },
      },
      birth: { type: GraphQLString, extensions: { validations: validators.dateFormat('Birth', 'YYYY-MM-DD') } },
      bio: { type: GraphQLString, extensions: { validations: validators.stringLength('Bio', 0, null) } },
      delta: { type: GraphQLInt, extensions: { validations: validators.numberRange('Delta', null, 100) } },
      score: { type: scalars.createBoundedIntScalar(`${prefix}Score`, null, 100) },
    }),
  });
  const Visit = new GraphQLObjectType({
    name: `${prefix}Visit`,
    fields: () => ({
      id: { type: GraphQLID },
      when: { type: createDateScalar(), extensions: { validations: validators.dateFormat('When', 'DD/MM/YYYY') } },
    }),
  });
  return { Post, Visit };
};

describe.skipIf(!mongoUri || !postgresUri)('MongoDB/PostgreSQL validation helper parity', () => {
  const namespace = `validation_${randomUUID().replaceAll('-', '')}`;
  const postFields = 'id tags birth bio delta score';
  let pool;
  let backends;

  beforeAll(async () => {
    await mongoose.connect(mongoUri, { dbName: namespace });
    pool = new pg.Pool({ connectionString: postgresUri });
    backends = [
      { name: 'mongodb', api: createRuntime(createMongoAdapter()), prefix: 'ValidationParityMongo' },
      { name: 'postgres', api: createPostgres({ pool, schema: namespace }), prefix: 'ValidationParityPostgres' },
    ];
    // dateFormat('When', 'DD/MM/YYYY') warns once that it does not check that format.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const backend of backends) {
        if (!backend.api.initializeDatabase) backend.api.preventCreatingCollection(true);
        const { Post, Visit } = createTypes(backend.prefix);
        backend.post = `${backend.prefix.charAt(0).toLowerCase()}${backend.prefix.slice(1)}Post`;
        backend.visit = `${backend.prefix.charAt(0).toLowerCase()}${backend.prefix.slice(1)}Visit`;
        backend.api.connect(null, Post, backend.post, `${backend.post}s`);
        backend.api.connect(null, Visit, backend.visit, `${backend.visit}s`);
        backend.schema = backend.api.createSchema();
        if (backend.api.initializeDatabase) await backend.api.initializeDatabase();
        else for (const { model } of backend.api.getRegistrations()) if (model) await model.createCollection();
      }
    } finally {
      warn.mockRestore();
    }
  }, 30000);

  afterAll(async () => {
    if (mongoose.connection.readyState) {
      await mongoose.connection.db.dropDatabase();
      await mongoose.disconnect();
    }
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await pool.end();
    }
  });

  const execute = (backend, source, variableValues) => graphql({ schema: backend.schema, source, variableValues });
  const addPost = (backend, input) => execute(
    backend,
    `mutation($input: ${backend.prefix}PostInput!) { add${backend.post}(input: $input) { ${postFields} } }`,
    { input: { bio: '', ...input } },
  );
  const addVisit = (backend, when) => execute(
    backend,
    `mutation($input: ${backend.prefix}VisitInput!) { add${backend.visit}(input: $input) { id when } }`,
    { input: { when } },
  );
  const list = async (backend, endpoint, fields) => {
    const result = await execute(backend, `{ ${endpoint}s(pagination: { page: 1, size: 100 }) { ${fields} } }`);
    expect(result.errors, backend.name).toBeUndefined();
    return result.data[`${endpoint}s`];
  };
  const expectRejected = async (backend, run, message, endpoint, fields) => {
    const before = await list(backend, endpoint, fields);
    const result = await run();
    expect(result.errors?.[0], backend.name).toMatchObject({ message, extensions: { code: 'VALIDATION_ERROR' } });
    expect(await list(backend, endpoint, fields), backend.name).toEqual(before);
  };

  test('both backends validate list items with a helper result and store nothing invalid', async () => {
    for (const backend of backends) {
      await expectRejected(backend, () => addPost(backend, { tags: ['ok', 'waytoolong'] }),
        'Tag must be at most 3 characters', backend.post, postFields);
      const added = await addPost(backend, { tags: ['ok', 'abc'] });
      expect(added.errors, backend.name).toBeUndefined();
      expect(added.data[`add${backend.post}`].tags, backend.name).toEqual(['ok', 'abc']);
    }
  });

  test('both backends reject impossible YYYY-MM-DD dates and store nothing', async () => {
    for (const backend of backends) {
      for (const birth of ['2024-02-31', '2023-02-29']) {
        await expectRejected(backend, () => addPost(backend, { birth }), 'Birth must be a valid date', backend.post, postFields);
      }
      const added = await addPost(backend, { birth: '2024-02-29' });
      expect(added.errors, backend.name).toBeUndefined();
      expect(added.data[`add${backend.post}`].birth, backend.name).toBe('2024-02-29');
    }
  });

  test('a Date field with a DD/MM/YYYY format keeps its results, and rolled-over dates are rejected', async () => {
    for (const backend of backends) {
      // Rejected before too, as a validation error, never as an internal or filter error from storage.
      await expectRejected(backend, () => addVisit(backend, '31/01/2024'), 'When must be a valid date', backend.visit, 'id when');
      // Stored before as 2024-03-02.
      await expectRejected(backend, () => addVisit(backend, '02/31/2024'), 'When must be a valid date', backend.visit, 'id when');
      for (const [when, stored] of [['12/25/2024', '2024-12-25'], ['01/13/2024', '2024-01-13']]) {
        const added = await addVisit(backend, when);
        expect(added.errors, `${backend.name} ${when}`).toBeUndefined();
        expect(added.data[`add${backend.visit}`].when, `${backend.name} ${when}`).toBe(stored);
      }
    }
  });

  test('both backends treat null bounds as no bound in validators and bounded scalars', async () => {
    for (const backend of backends) {
      const added = await addPost(backend, { bio: 'Hello there', delta: -5, score: -5 });
      expect(added.errors, backend.name).toBeUndefined();
      expect(added.data[`add${backend.post}`], backend.name).toMatchObject({ bio: 'Hello there', delta: -5, score: -5 });
      const rows = await list(backend, backend.post, postFields);
      expect(rows.find((row) => row.id === added.data[`add${backend.post}`].id), backend.name)
        .toMatchObject({ bio: 'Hello there', delta: -5, score: -5 });
      await expectRejected(backend, () => addPost(backend, { delta: 101 }), 'Delta must be at most 100', backend.post, postFields);
    }
  });
});
