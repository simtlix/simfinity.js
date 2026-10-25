// Named views on MongoDB and PostgreSQL. A view returns exactly the rows and count of the generated list called with the
// same client arguments and the view's where groups sent as client AND groups, for callers of every tenant, with and
// without the shop scope; the item scope isolates tenants; a reference whose target the shop scope hides reads as
// missing; errors keep the list's codes; and GraphQL, MCP and in-process execute serve the same rows and count, and
// move together when the registered where changes.
import { randomUUID } from 'node:crypto';
import {
  afterAll, beforeAll, describe, expect, it,
} from 'vitest';
import { execute, graphql, parse } from 'graphql';
import mongoose from 'mongoose';
import pg from 'pg';
import { auth, createRuntime, SimfinityError } from '../../packages/core/src/index.js';
import { generateMCPTools } from '../../packages/mcp/src/index.js';
import { createMongoAdapter } from '../../packages/mongodb/src/mongo/adapter.js';
import { createPostgres } from '../../packages/postgres/src/index.js';
import { createNamedViewTypes, registerNamedViewFixture, seedNamedViews } from '../helpers/named-views.js';

const BY_KEY = { terms: [{ field: 'key', order: 'ASC' }] };
const PAGE = { page: 1, size: 10, count: true };
const SELECTION = 'id key name stock tenant shop { key }';
// The GraphQL type of each argument the suite sends, as a variable: the generated list arguments and the view params.
const ARGUMENT_TYPES = {
  key: 'QLFilter',
  name: 'QLFilter',
  stock: 'QLFilter',
  shop: 'QLTypeFilterExpression',
  AND: '[QLFilterGroup]',
  OR: '[QLFilterGroup]',
  sort: 'QLSortExpression',
  pagination: 'QLPagination',
  minStock: 'Int',
  shopId: 'ID!',
};
// A query on one root field that passes each argument as a variable, sorted by key unless the arguments sort.
const operation = (field, args) => {
  const variables = args.sort ? args : { ...args, sort: BY_KEY };
  const names = Object.keys(variables);
  const declared = names.map((name) => `$${name}:${ARGUMENT_TYPES[name]}`).join(',');
  const passed = names.map((name) => `${name}:$${name}`).join(',');
  return { field, source: `query(${declared}){${field}(${passed}){${SELECTION}}}`, variables };
};
// The generated list with the client arguments, and the groups appended to its AND, as a view appends its where.
const listSource = (args, groups) => operation('nvItems', { ...args, AND: [...(args.AND ?? []), ...groups] });
// A view with its params and the client arguments.
const viewSource = (view, params, args) => operation(view, { ...params, ...args });

const stockGroup = (minStock) => ({ conditions: [{ field: 'stock', operator: 'GTE', value: minStock }] });
const shopGroup = (shopId) => ({ conditions: [{ field: 'shop', path: 'id', operator: 'EQ', value: shopId }] });
const ORPHAN_GROUP = { conditions: [{ field: 'shop', operator: 'IS_EMPTY' }] };
const CONTEXTS = [{ tenant: 'a' }, { tenant: 'a', openOnly: true }, { tenant: 'b' }, { tenant: 'c' }];

// The client arguments that each view is compared with the list under.
const A_CASES = [
  ['no client filter', {}],
  ['own-field filter', { name: { operator: 'ILIKE', value: 'item' } }],
  ['reference term', { shop: { terms: [{ path: 'name', operator: 'ISTARTS_WITH', value: 's' }] } }],
  ['groups', { OR: [{ conditions: [{ field: 'stock', operator: 'EQ', value: 0 }] }, { conditions: [{ field: 'key', operator: 'EQ', value: 'A' }] }] }],
  ['emptiness', { AND: [{ conditions: [{ field: 'shop', operator: 'IS_NOT_EMPTY' }] }] }],
  ['sorted counted page', { sort: { terms: [{ field: 'stock', order: 'DESC' }] }, pagination: { page: 1, size: 2, count: true } }],
];
// With stocks 5, 0, 3 and 9, minStock 1 and 3 select the same items; minStock 4 leaves C out.
const P_CASES = [['default', {}], ['minStock 3', { minStock: 3 }], ['minStock 4', { minStock: 4 }]];

for (const [backend, uri] of [
  ['mongo', process.env.SIMFINITY_MONGODB_URI],
  ['postgres', process.env.SIMFINITY_POSTGRES_URI],
]) {
  describe.skipIf(!uri)(`${backend} named views`, () => {
    const namespace = `named_views_${randomUUID().replaceAll('-', '')}`;
    let pool; let runtime; let schema; let whereRef; let ids;
    // What middleware receives on each call: the payload's type is the registration, named by its GraphQL type.
    const payloads = [];
    let storageReady = false;

    // Runs an operation with a copy of the context, and returns its result with the count the runtime reported in it.
    const run = async ({ source, variables }, context) => {
      const contextValue = { ...context };
      const result = await graphql({ schema, source, variableValues: variables, contextValue });
      return { ...result, count: contextValue.count };
    };
    // The keys and count of an operation that succeeds.
    const rows = async (built, context) => {
      const result = await run(built, context);
      expect(result.errors).toBeUndefined();
      return { keys: result.data[built.field].map((row) => row.key), count: result.count };
    };
    // A view returns, in every context, the rows and count of the list with the groups sent as client AND groups.
    const expectViewEqualsList = async (view, params, args, groups) => {
      for (const context of CONTEXTS) {
        const expected = await run(listSource(args, groups), context);
        const actual = await run(viewSource(view, params, args), context);
        expect(expected.errors, JSON.stringify(context)).toBeUndefined();
        expect(actual.errors, JSON.stringify(context)).toBeUndefined();
        expect(actual.data[view], JSON.stringify(context)).toEqual(expected.data.nvItems);
        expect(actual.count, JSON.stringify(context)).toBe(expected.count);
      }
    };
    // Replaces a view's registered where for the length of `body`.
    const withWhere = async (view, where, body) => {
      const original = whereRef[view];
      whereRef[view] = where;
      try { await body(); } finally { whereRef[view] = original; }
    };

    beforeAll(async () => {
      if (backend === 'mongo') await mongoose.connect(uri, { dbName: namespace });
      else pool = new pg.Pool({ connectionString: uri });
      runtime = backend === 'mongo' ? createRuntime(createMongoAdapter()) : createPostgres({ pool, schema: namespace });
      if (backend === 'mongo') runtime.preventCreatingCollection(true);
      runtime.use((params, next) => {
        payloads.push({
          entry: params.entry, operation: params.operation, type: params.type?.gqltype?.name, args: structuredClone(params.args),
        });
        if (params.context?.deny) throw new SimfinityError('Operation denied', 'FORBIDDEN', 403);
        return next();
      });
      whereRef = registerNamedViewFixture(runtime, createNamedViewTypes());
      schema = runtime.createSchema();
      if (backend === 'mongo') {
        for (const { model } of runtime.getRegistrations()) await model.createCollection();
      } else {
        await runtime.initializeDatabase();
      }
      storageReady = true;
      ids = await seedNamedViews((source, variableValues) => graphql({
        schema, source, variableValues, contextValue: {},
      }));
    }, 60000);

    afterAll(async () => {
      if (backend === 'mongo' && mongoose.connection.readyState) {
        // Generated models build their indexes in the background; let them finish, so that none recreates a collection.
        await Promise.allSettled(mongoose.modelNames().map((name) => mongoose.model(name).init()));
        await mongoose.connection.dropDatabase();
        await mongoose.disconnect();
      }
      if (pool) {
        if (storageReady) await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
        await pool.end();
      }
    });

    for (const [aLabel, a] of A_CASES) {
      for (const [pLabel, p] of P_CASES) {
        it(`openItems(${pLabel}) with ${aLabel} equals the list with the where groups sent as client AND groups`, async () => {
          await expectViewEqualsList('openItems', p, a, [stockGroup(p.minStock ?? 1)]);
        });
      }
    }

    for (const [aLabel, a] of A_CASES) {
      it(`orphanItems with ${aLabel} equals the list with the IS_EMPTY group`, async () => {
        await expectViewEqualsList('orphanItems', {}, a, [ORPHAN_GROUP]);
      });
    }

    it('isolates tenants through the base scope', async () => {
      const page = { pagination: PAGE };
      // minStock 0 widens the view to B, and still reads only the caller's tenant.
      expect(await rows(viewSource('openItems', {}, page), { tenant: 'a' })).toEqual({ keys: ['A', 'C'], count: 2 });
      expect(await rows(viewSource('openItems', { minStock: 0 }, page), { tenant: 'a' })).toEqual({ keys: ['A', 'B', 'C'], count: 3 });
      expect(await rows(viewSource('openItems', {}, page), { tenant: 'b' })).toEqual({ keys: ['D'], count: 1 });
      // S1 holds A of tenant a and D of tenant b.
      expect(await rows(viewSource('shopItems', { shopId: ids.S1 }, page), { tenant: 'a' })).toEqual({ keys: ['A'], count: 1 });
      expect(await rows(viewSource('shopItems', { shopId: ids.S1 }, page), { tenant: 'b' })).toEqual({ keys: ['D'], count: 1 });
      for (const params of [{}, { minStock: 0 }]) {
        expect(await rows(viewSource('openItems', params, page), { tenant: 'c' })).toEqual({ keys: [], count: 0 });
      }
    });

    it('fails a where with a plain condition at depth 6 with FILTER_DEPTH_EXCEEDED on both backends', async () => {
      // Groups in args.AND are at depth 0, so the innermost group is at depth 6.
      let group = { conditions: [{ field: 'stock', operator: 'EQ', value: 1 }] };
      for (let level = 0; level < 6; level += 1) group = { AND: [group] };
      await withWhere('openItems', () => [group], async () => {
        const view = await run(viewSource('openItems', {}, {}), { tenant: 'a' });
        expect(view.errors[0].extensions).toMatchObject({ code: 'FILTER_DEPTH_EXCEEDED', status: 400 });
        expect(view.data.openItems).toBeNull();
        const list = await run(listSource({}, [group]), { tenant: 'a' });
        // Separate requests can fail in different seconds; their semantic error fields must still agree.
      expect(list.errors[0].extensions).toEqual({
        ...view.errors[0].extensions, timestamp: expect.any(String),
      });
      });
    });

    it('rejects a misspelled where group key with INVALID_VIEW', async () => {
      await withWhere('openItems', () => [{ condition: [{ field: 'stock', operator: 'GT', value: 0 }] }], async () => {
        const result = await run(viewSource('openItems', {}, { pagination: PAGE }), { tenant: 'a' });
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].extensions).toMatchObject({ code: 'INVALID_VIEW', status: 500 });
        expect(result.data.openItems).toBeNull();
        expect(result.count).toBeUndefined();
      });
    });

    it('rejects cyclic where groups with INVALID_VIEW', async () => {
      const group = {};
      group.AND = [group];
      await withWhere('openItems', () => [group], async () => {
        const result = await run(viewSource('openItems', {}, { pagination: PAGE }), { tenant: 'a' });
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0].extensions).toMatchObject({ code: 'INVALID_VIEW', status: 500 });
        expect(result.data.openItems).toBeNull();
        expect(result.count).toBeUndefined();
      });
    });

    it('reads a hidden reference as missing', async () => {
      const page = { pagination: PAGE };
      expect(await rows(viewSource('shopItems', { shopId: ids.S2 }, page), { tenant: 'a' })).toEqual({ keys: ['B'], count: 1 });
      expect(await rows(viewSource('shopItems', { shopId: ids.S2 }, page), { tenant: 'a', openOnly: true })).toEqual({ keys: [], count: 0 });
      expect(await rows(listSource(page, [shopGroup(ids.S2)]), { tenant: 'a', openOnly: true })).toEqual({ keys: [], count: 0 });
    });

    it('answers orphanItems through the shop scope', async () => {
      const page = { pagination: PAGE };
      // B's shop, S2, is CLOSED: the shop scope hides it, so B reads as an item without a shop.
      for (const [context, keys] of [[{ tenant: 'a' }, ['C']], [{ tenant: 'a', openOnly: true }, ['B', 'C']]]) {
        const expected = { keys, count: keys.length };
        expect(await rows(viewSource('orphanItems', {}, page), context), JSON.stringify(context)).toEqual(expected);
        expect(await rows(listSource(page, [ORPHAN_GROUP]), context), JSON.stringify(context)).toEqual(expected);
      }
    });

    it('fails a malformed param value with the backend code', async () => {
      const code = { mongo: 'INVALID_FILTER_VALUE', postgres: 'NOT_VALID_ID' }[backend];
      const view = await run(viewSource('shopItems', { shopId: 'not-an-id' }, {}), { tenant: 'a' });
      expect(view.errors[0].extensions.code).toBe(code);
      expect(view.data.shopItems).toBeNull();
      const list = await run(listSource({}, [shopGroup('not-an-id')]), { tenant: 'a' });
      // Separate requests can fail in different seconds; their semantic error fields must still agree.
      expect(list.errors[0].extensions).toEqual({
        ...view.errors[0].extensions, timestamp: expect.any(String),
      });
    });

    it('rejects the view when middleware rejects the list', async () => {
      for (const field of ['nvItems', 'openItems']) {
        const result = await run(operation(field, {}), { tenant: 'a', deny: true });
        expect(result.errors[0].message, field).toBe('Operation denied');
        expect(result.errors[0].extensions, field).toMatchObject({ code: 'FORBIDDEN', status: 403 });
        expect(result.data[field], field).toBeNull();
      }
    });

    it('gives middleware the view name as entry and the client arguments, without the params and before the where', async () => {
      const filter = { name: { operator: 'ILIKE', value: 'item' } };
      // The shop field's get_by_id reads call middleware too; only the find payloads are compared.
      const finds = () => payloads.filter((payload) => payload.operation === 'find');

      payloads.length = 0;
      expect(await rows(viewSource('openItems', { minStock: 2 }, filter), { tenant: 'a' })).toEqual({ keys: ['A'], count: undefined });
      // Exactly the client's arguments: no minStock, and no AND group with the where's stock condition.
      expect(finds()).toEqual([{
        entry: 'openItems', operation: 'find', type: 'NvItem', args: { ...filter, sort: BY_KEY },
      }]);

      // The generated list sends no entry, and its client AND groups reach middleware.
      payloads.length = 0;
      expect(await rows(listSource(filter, [stockGroup(2)]), { tenant: 'a' })).toEqual({ keys: ['A'], count: undefined });
      expect(finds()).toEqual([{
        entry: undefined, operation: 'find', type: 'NvItem', args: { ...filter, AND: [stockGroup(2)], sort: BY_KEY },
      }]);
    });

    it('serves the same rows and count to GraphQL, MCP and in-process execute, and moves together when where changes', async () => {
      const plugin = auth.createAuthPlugin({
        RootQueryType: { openItems: auth.allow(), nvItems: auth.allow() },
        NvItem: { '*': auth.allow() },
        NvShop: { '*': auth.allow() },
      }, { defaultPolicy: 'DENY' });
      // A second schema keeps the DENY root rules off the shared schema's root. The NvItem and NvShop field objects are
      // shared, and the plugin wraps their resolvers in place, so their allow() wrappers also reach the shared schema:
      // that is why this test is declared last.
      const authorized = runtime.createSchema();
      plugin.onSchemaChange({ schema: authorized });
      const { callTool } = generateMCPTools(authorized, { schemaPlugins: [plugin], context: (extra) => extra });

      // The keys and count, or the first error code, of one operation through each entry point, for tenant a.
      const readOf = (field, result, count) => (result.errors ? result.errors[0].extensions.code : { keys: result.data[field].map((row) => row.key), count });
      const entries = async ({ field, source, variables }) => {
        const viaGraphql = { tenant: 'a' };
        const viaExecute = { tenant: 'a' };
        const graphqlResult = await graphql({ schema: authorized, source, variableValues: variables, contextValue: viaGraphql });
        const executeResult = await execute({ schema: authorized, document: parse(source), variableValues: variables, contextValue: viaExecute });
        const response = await callTool(field, variables, { tenant: 'a' });
        return {
          graphql: readOf(field, graphqlResult, viaGraphql.count),
          mcp: response.isError
            ? JSON.parse(response.content[0].text).errors[0].extensions.code
            : readOf(field, { data: response.structuredContent }, response.structuredContent.totalCount),
          execute: readOf(field, executeResult, viaExecute.count),
        };
      };
      const all = (value) => ({ graphql: value, mcp: value, execute: value });
      const page = { pagination: PAGE };

      expect(await entries(viewSource('openItems', {}, page))).toEqual(all({ keys: ['A', 'C'], count: 2 }));
      expect(await entries(listSource(page, [stockGroup(1)]))).toEqual(all({ keys: ['A', 'C'], count: 2 }));
      await withWhere('openItems', () => [stockGroup(4)], async () => {
        expect(await entries(viewSource('openItems', {}, page))).toEqual(all({ keys: ['A'], count: 1 }));
        expect(await entries(listSource(page, [stockGroup(4)]))).toEqual(all({ keys: ['A'], count: 1 }));
      });
      // A view without a RootQueryType rule stays denied under DENY.
      expect(await entries(viewSource('shopItems', { shopId: ids.S1 }, page))).toEqual(all('FORBIDDEN'));
    });
  });
}
