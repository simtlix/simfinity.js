import { randomUUID } from 'node:crypto';
import {
  afterAll, afterEach, beforeAll, describe, expect, it, vi,
} from 'vitest';
import {
  GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';
import mongoose from 'mongoose';
import pg from 'pg';

import { createRuntime } from '../../packages/core/src/index.js';
import { createMongoAdapter } from '../../packages/mongodb/src/mongo/adapter.js';
import { createSQLAdapter } from '../../packages/sql/src/adapter.js';
import { postgresPlugin } from '../../packages/postgres/src/index.js';
import { generateMCPTools } from '../../packages/mcp/src/index.js';

const mongoUri = process.env.SIMFINITY_MONGODB_URI;
const postgresUri = process.env.SIMFINITY_POSTGRES_URI;

const SHOPS = 5;
const PER_COLLECTION = 3;

const createFixture = () => {
  const relation = (connectionField) => ({ relation: { embedded: false, connectionField } });
  const Owner = new GraphQLObjectType({
    name: 'McpNestedOwner',
    fields: () => ({ id: { type: GraphQLID }, name: { type: new GraphQLNonNull(GraphQLString) } }),
  });
  const Service = new GraphQLObjectType({
    name: 'McpNestedService',
    fields: () => ({
      id: { type: GraphQLID },
      label: { type: new GraphQLNonNull(GraphQLString) },
      price: { type: GraphQLInt },
      shop: { type: Shop, extensions: relation('shop_id') },
    }),
  });
  const Review = new GraphQLObjectType({
    name: 'McpNestedReview',
    fields: () => ({
      id: { type: GraphQLID },
      text: { type: new GraphQLNonNull(GraphQLString) },
      shop: { type: Shop, extensions: relation('shop_id') },
    }),
  });
  const Shop = new GraphQLObjectType({
    name: 'McpNestedShop',
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: new GraphQLNonNull(GraphQLString) },
      owner: { type: Owner, extensions: relation('owner_id') },
      services: { type: new GraphQLList(Service), extensions: relation('shop_id') },
      reviews: { type: new GraphQLList(Review), extensions: relation('shop_id') },
    }),
  });
  return {
    Owner, Service, Review, Shop,
  };
};

const describeWithDatabases = mongoUri && postgresUri ? describe : describe.skip;

describeWithDatabases('MCP nestedCollections on MongoDB and PostgreSQL', () => {
  const namespace = `mcpnested_${randomUUID().replaceAll('-', '')}`;
  let pool;
  let backends;
  const run = async (backend, source) => {
    const result = await graphql({ schema: backend.schema, source, contextValue: {} });
    expect(result.errors).toBeUndefined();
    return result.data;
  };
  const listArgs = { sort: { terms: [{ field: 'name', order: 'ASC' }] } };
  const reads = (backend) => ({
    find: backend.spies.find.mock.calls.length,
    getById: backend.spies.getById.mock.calls.length,
    getByIds: backend.spies.getByIds.mock.calls.length,
    findChildren: backend.spies.findChildren.mock.calls.length,
  });

  beforeAll(async () => {
    await mongoose.connect(mongoUri, { dbName: namespace });
    pool = new pg.Pool({ connectionString: postgresUri });
    backends = [
      { name: 'mongo', adapter: createMongoAdapter() },
      { name: 'postgres', adapter: createSQLAdapter(postgresPlugin({ pool, schema: namespace })) },
    ].map((backend) => ({ ...backend, api: createRuntime(backend.adapter), fixture: createFixture() }));
    for (const backend of backends) {
      const { api, fixture, adapter } = backend;
      if (backend.name === 'mongo') api.preventCreatingCollection(true);
      api.connect(null, fixture.Owner, 'mcpnestedowner', 'mcpnestedowners');
      api.connect(null, fixture.Service, 'mcpnestedservice', 'mcpnestedservices');
      api.connect(null, fixture.Review, 'mcpnestedreview', 'mcpnestedreviews');
      api.connect(null, fixture.Shop, 'mcpnestedshop', 'mcpnestedshops');
      backend.schema = api.createSchema();
      if (backend.name === 'postgres') await adapter.initialize();
      else for (const { model } of api.getRegistrations()) if (model) await model.createCollection();

      const add = async (type, input) => (await run(backend, `mutation { add${type}(input: ${input}) { id } }`))[`add${type}`].id;
      const owners = [await add('mcpnestedowner', '{ name: "Owner one" }'), await add('mcpnestedowner', '{ name: "Owner two" }')];
      for (let s = 0; s < SHOPS; s += 1) {
        const shop = await add('mcpnestedshop', `{ name: "Shop ${s}", owner: { id: "${owners[s % 2]}" } }`);
        for (let c = 0; c < PER_COLLECTION; c += 1) {
          await add('mcpnestedservice', `{ label: "Cut ${c}", price: ${10 + c}, shop: { id: "${shop}" } }`);
          await add('mcpnestedreview', `{ text: "Review ${s}-${c}", shop: { id: "${shop}" } }`);
        }
      }
      backend.spies = Object.fromEntries(['find', 'getById', 'getByIds', 'findChildren']
        .map((method) => [method, vi.spyOn(adapter, method)]));
    }
  }, 60000);

  afterEach(() => {
    for (const backend of backends || []) {
      for (const spy of Object.values(backend.spies || {})) spy.mockClear();
    }
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (mongoose.connection.readyState) {
      await mongoose.connection.db.dropDatabase();
      await mongoose.disconnect();
    }
    mongoose.deleteModel(/^McpNested/);
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await pool.end();
    }
  });

  it('reads no nested collection with nestedCollections: \'none\' and returns the same parent rows', async () => {
    const results = [];
    for (const backend of backends) {
      const all = await generateMCPTools(backend.schema).callTool('mcpnestedshops', listArgs);
      expect(all.isError).toBe(false);
      expect(reads(backend)).toEqual({
        find: 1, getById: 0, getByIds: 1, findChildren: SHOPS * 2,
      });
      const shops = all.structuredContent.mcpnestedshops;
      expect(shops).toHaveLength(SHOPS);
      for (const shop of shops) {
        expect(shop.services).toHaveLength(PER_COLLECTION);
        expect(shop.reviews).toHaveLength(PER_COLLECTION);
      }
      for (const spy of Object.values(backend.spies)) spy.mockClear();

      const none = await generateMCPTools(backend.schema, { nestedCollections: 'none' }).callTool('mcpnestedshops', listArgs);
      expect(none.isError).toBe(false);
      expect(reads(backend)).toEqual({
        find: 1, getById: 0, getByIds: 1, findChildren: 0,
      });
      expect(none.structuredContent.mcpnestedshops)
        .toEqual(shops.map((shop) => ({ id: shop.id, name: shop.name, owner: shop.owner })));
      expect(Object.keys(none.structuredContent.mcpnestedshops[0])).toEqual(['id', 'name', 'owner']);
      results.push(none.structuredContent.mcpnestedshops);
    }
    const withoutIds = (data) => JSON.parse(JSON.stringify(data, (key, value) => (key === 'id' ? undefined : value)));
    expect(withoutIds(results[1])).toEqual(withoutIds(results[0]));
    expect(withoutIds(results[0])[0]).toEqual({ name: 'Shop 0', owner: { name: 'Owner one' } });
  });

  it('keeps a tool\'s collections when its override is \'all\'', async () => {
    for (const backend of backends) {
      const { callTool } = generateMCPTools(backend.schema, {
        nestedCollections: 'none',
        toolOverrides: { mcpnestedshop: { nestedCollections: 'all' } },
      });
      const listed = await callTool('mcpnestedshops', listArgs);
      expect(backend.spies.findChildren).not.toHaveBeenCalled();
      const [first] = listed.structuredContent.mcpnestedshops;

      const single = await callTool('mcpnestedshop', { id: first.id });
      expect(backend.spies.findChildren).toHaveBeenCalledTimes(2);
      expect(single.structuredContent.mcpnestedshop.services.map(({ label }) => label).sort())
        .toEqual(['Cut 0', 'Cut 1', 'Cut 2']);
    }
  });
});
