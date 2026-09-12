import { randomUUID } from 'node:crypto';
import {
  afterAll, beforeAll, describe, expect, it, vi,
} from 'vitest';
import {
  GraphQLID, GraphQLNonNull, GraphQLObjectType, graphql,
} from 'graphql';
import pg from 'pg';
import {
  auth, createPostgres, scalars, validators,
} from '../../packages/postgres/src/index.js';

const uri = process.env.SIMFINITY_POSTGRES_URI;

describe.skipIf(!uri)('PostgreSQL shared helper integration', () => {
  const namespace = `shared_helpers_${randomUUID().replaceAll('-', '')}`;
  const onSaving = vi.fn();
  let api;
  let pool;
  let schema;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: uri });
    api = createPostgres({ pool, schema: namespace });
    const Slug = scalars.createPatternStringScalar(
      'PostgresHelperSlug',
      /^[a-z]+$/,
      'Slug must contain lowercase letters only',
    );
    const Item = new GraphQLObjectType({
      name: 'PostgresHelperItem',
      fields: {
        id: { type: GraphQLID },
        name: {
          type: new GraphQLNonNull(scalars.EmailScalar),
          extensions: { validations: validators.stringLength('Email', 6, 80) },
        },
        slug: { type: new GraphQLNonNull(Slug) },
      },
    });
    api.connect(null, Item, 'postgreshelper', 'postgreshelpers', { onSaving });
    schema = api.createSchema();
    auth.createAuthPlugin({
      Mutation: { addpostgreshelper: auth.requireAuth() },
    }, { defaultPolicy: 'ALLOW' }).onSchemaChange({ schema });
    await api.initializeDatabase();
  });

  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await pool.end();
    }
  });

  const add = (input, contextValue = {}) => graphql({
    schema,
    source: 'mutation($input:PostgresHelperItemInput!){addpostgreshelper(input:$input){id name slug}}',
    variableValues: { input },
    contextValue,
  });

  it('denies an unauthorized generated mutation before running its controller', async () => {
    const result = await add({ name: 'person@example.com', slug: 'valid' });

    expect(result.errors?.[0].extensions.code).toBe('UNAUTHENTICATED');
    expect(onSaving).not.toHaveBeenCalled();
  });

  it('applies shared scalar and field validation for authorized mutations', async () => {
    const invalidScalar = await add(
      { name: 'person@example.com', slug: 'NOT_VALID' },
      { user: { id: 'authorized' } },
    );
    expect(invalidScalar.errors?.[0].message).toContain('Slug must contain lowercase letters only');

    const invalidField = await add(
      { name: 'a@b.c', slug: 'valid' },
      { user: { id: 'authorized' } },
    );
    expect(invalidField.errors?.[0].extensions.code).toBe('VALIDATION_ERROR');
    expect(onSaving).not.toHaveBeenCalled();
  });

  it('allows an authorized mutation and runs the shared runtime controller', async () => {
    const result = await add(
      { name: 'person@example.com', slug: 'valid' },
      { user: { id: 'authorized' } },
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.addpostgreshelper).toMatchObject({
      name: 'person@example.com',
      slug: 'valid',
    });
    expect(onSaving).toHaveBeenCalledOnce();
  });
});
