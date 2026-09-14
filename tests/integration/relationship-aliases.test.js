import { randomUUID } from 'node:crypto';
import {
  afterAll, beforeAll, describe, expect, it,
} from 'vitest';
import {
  GraphQLID,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  graphql,
  printSchema,
} from 'graphql';
import mongoose from 'mongoose';
import pg from 'pg';

import { createPostgres } from '../../packages/postgres/src/index.js';
import { createRuntime } from '../../packages/core/src/index.js';
import { createMongoAdapter } from '../../packages/mongodb/src/mongo/adapter.js';

const mongoUri = process.env.SIMFINITY_MONGODB_URI;
const postgresUri = process.env.SIMFINITY_POSTGRES_URI;

const createFixture = () => {
  const AliasParent = new GraphQLObjectType({
    name: 'AliasParent',
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: new GraphQLNonNull(GraphQLString) },
      storageChildren: {
        type: new GraphQLList(StorageAliasChild),
        extensions: { relation: { connectionField: 'parent_id' } },
      },
      namedChildren: {
        type: new GraphQLList(NamedAliasChild),
        extensions: { relation: { connectionField: 'parent' } },
      },
      privateChildren: {
        type: new GraphQLList(PrivateAliasChild),
        extensions: { relation: { connectionField: 'owner_private_id' } },
      },
    }),
  });
  const StorageAliasChild = new GraphQLObjectType({
    name: 'StorageAliasChild',
    fields: () => ({
      id: { type: GraphQLID },
      label: { type: new GraphQLNonNull(GraphQLString) },
      parent: {
        type: new GraphQLNonNull(AliasParent),
        extensions: { relation: { connectionField: 'parent_id' } },
      },
    }),
  });
  const NamedAliasChild = new GraphQLObjectType({
    name: 'NamedAliasChild',
    fields: () => ({
      id: { type: GraphQLID },
      label: { type: new GraphQLNonNull(GraphQLString) },
      parent: {
        type: new GraphQLNonNull(AliasParent),
        extensions: { relation: { connectionField: 'parent_id' } },
      },
    }),
  });
  const PrivateAliasChild = new GraphQLObjectType({
    name: 'PrivateAliasChild',
    fields: () => ({
      id: { type: GraphQLID },
      label: { type: new GraphQLNonNull(GraphQLString) },
    }),
  });
  return {
    AliasParent,
    StorageAliasChild,
    NamedAliasChild,
    PrivateAliasChild,
  };
};

const registerFixture = (api, fixture) => {
  api.connect(null, fixture.AliasParent, 'aliasParent', 'aliasParents');
  api.connect(null, fixture.StorageAliasChild, 'storageAliasChild', 'storageAliasChildren');
  api.connect(null, fixture.NamedAliasChild, 'namedAliasChild', 'namedAliasChildren');
  api.connect(null, fixture.PrivateAliasChild, 'privateAliasChild', 'privateAliasChildren');
};

const execute = (backend, source, variableValues) => graphql({
  schema: backend.schema,
  source,
  variableValues,
});

const describeWithDatabases = mongoUri && postgresUri ? describe : describe.skip;

describeWithDatabases('relationship connection field aliases', () => {
  const namespace = `aliases_${randomUUID().replaceAll('-', '')}`;
  let pool;
  let backends;

  beforeAll(async () => {
    await mongoose.connect(mongoUri, { dbName: namespace });
    pool = new pg.Pool({ connectionString: postgresUri });
    backends = [
      { name: 'mongo', api: createRuntime(createMongoAdapter()), fixture: createFixture() },
      {
        name: 'postgres',
        api: createPostgres({ pool, schema: namespace }),
        fixture: createFixture(),
      },
    ];

    for (const backend of backends) {
      if (backend.name === 'mongo') backend.api.preventCreatingCollection(true);
      registerFixture(backend.api, backend.fixture);
      backend.schema = backend.api.createSchema();
      if (backend.name === 'postgres') await backend.api.initializeDatabase();
      else {
        for (const { model } of backend.api.getRegistrations()) {
          if (model) await model.createCollection();
        }
      }
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

  it('supports GraphQL names, storage aliases, and private connection fields', async () => {
    for (const backend of backends) {
      const sdl = printSchema(backend.schema);
      expect(sdl).toContain('AliasParentAStorageAliasChildInputForParent_id');
      expect(sdl).toContain('AliasParentANamedAliasChildInputForParent');
      expect(sdl).toContain('AliasParentAPrivateAliasChildInputForOwner_private_id');

      const added = await execute(
        backend,
        `mutation AddAliasParent($input: AliasParentInput!) {
          addaliasParent(input: $input) {
            id
            storageChildren { id label parent { id } }
            namedChildren { id label parent { id } }
            privateChildren { id label }
          }
        }`,
        {
          input: {
            name: `${backend.name}-parent`,
            storageChildren: { added: [{ label: 'storage-before' }] },
            namedChildren: { added: [{ label: 'named-before' }] },
            privateChildren: { added: [{ label: 'private-before' }] },
          },
        },
      );

      expect(added.errors).toBeUndefined();
      const parent = added.data.addaliasParent;
      expect(parent.storageChildren).toHaveLength(1);
      expect(parent.namedChildren).toHaveLength(1);
      expect(parent.privateChildren).toHaveLength(1);
      expect(parent.storageChildren[0].parent.id).toBe(parent.id);
      expect(parent.namedChildren[0].parent.id).toBe(parent.id);

      const updated = await execute(
        backend,
        `mutation UpdateAliasParent($input: AliasParentInputForUpdate!) {
          updatealiasParent(input: $input) {
            storageChildren { id label }
            namedChildren { id label }
            privateChildren { id label }
          }
        }`,
        {
          input: {
            id: parent.id,
            storageChildren: {
              updated: [{ id: parent.storageChildren[0].id, label: 'storage-after' }],
            },
            namedChildren: {
              updated: [{ id: parent.namedChildren[0].id, label: 'named-after' }],
            },
            privateChildren: {
              updated: [{ id: parent.privateChildren[0].id, label: 'private-after' }],
            },
          },
        },
      );

      expect(updated.errors).toBeUndefined();
      expect(updated.data.updatealiasParent).toEqual({
        storageChildren: [{ id: parent.storageChildren[0].id, label: 'storage-after' }],
        namedChildren: [{ id: parent.namedChildren[0].id, label: 'named-after' }],
        privateChildren: [{ id: parent.privateChildren[0].id, label: 'private-after' }],
      });

      const read = await execute(
        backend,
        `query ReadAliasParent($id: ID) {
          aliasParent(id: $id) {
            storageChildren(label: { value: "storage-after" }) { id label parent { id } }
            namedChildren(label: { value: "named-after" }) { id label parent { id } }
            privateChildren(label: { value: "private-after" }) { id label }
          }
        }`,
        { id: parent.id },
      );

      expect(read.errors).toBeUndefined();
      expect(read.data.aliasParent).toEqual({
        storageChildren: [{
          id: parent.storageChildren[0].id,
          label: 'storage-after',
          parent: { id: parent.id },
        }],
        namedChildren: [{
          id: parent.namedChildren[0].id,
          label: 'named-after',
          parent: { id: parent.id },
        }],
        privateChildren: [{
          id: parent.privateChildren[0].id,
          label: 'private-after',
        }],
      });

      const filtered = await execute(
        backend,
        `query FilterAliasParents {
          aliasParents(namedChildren: {
            terms: [{ path: "label", value: "named-after" }]
          }) { id }
        }`,
      );
      expect(filtered.errors).toBeUndefined();
      expect(filtered.data.aliasParents).toEqual([{ id: parent.id }]);

      const aggregate = await execute(
        backend,
        `query AggregateAliasParents {
          aliasParents_aggregate(aggregation: {
            groupId: "name"
            facts: [{ operation: COUNT, factName: "namedCount", path: "namedChildren.id" }]
          }) { groupId facts }
        }`,
      );
      expect(aggregate.errors).toBeUndefined();
      expect(aggregate.data.aliasParents_aggregate).toEqual([{
        groupId: `${backend.name}-parent`,
        facts: { namedCount: 1 },
      }]);
    }
  });
});
