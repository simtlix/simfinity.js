// The literal text operators (#108, part 1) through generated MCP tools on both backends: list, counted list and
// aggregate calls return the rows that the same GraphQL filters return (the cases of tests/helpers/query-text-operators.js),
// an SDK client that validates tool input and output runs them, and invalid values come back as INVALID_FILTER_VALUE
// tool errors. Collection frames (#108, part 3) return each parent once, support a NONE counted list and an ANY
// aggregate, and fail before reads when the same real adapter does not declare quantifiers.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { graphql, GraphQLID, GraphQLInt, GraphQLList, GraphQLObjectType, GraphQLString } from 'graphql';
import mongoose from 'mongoose';
import pg from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRuntime } from '../../packages/core/src/index.js';
import { createMongoAdapter } from '../../packages/mongodb/src/mongo/adapter.js';
import { createPostgres, postgresPlugin } from '../../packages/postgres/src/index.js';
import { createSQLAdapter } from '../../packages/sql/src/adapter.js';
import { createMCPServer, generateMCPTools } from '../../packages/mcp/src/index.js';
import { createTextOperatorFixture, registerTextOperatorFixture, seedTextOperatorFixture } from '../helpers/query-text-operators.js';

const mongoUri = process.env.SIMFINITY_MONGODB_URI;
const postgresUri = process.env.SIMFINITY_POSTGRES_URI;
const TEXT = ['ILIKE', 'STARTS_WITH', 'ISTARTS_WITH', 'ENDS_WITH', 'IENDS_WITH', 'IEQ'];
const byKey = { sort: { terms: [{ field: 'key', order: 'ASC' }] } };
const keysOf = (result, field) => {
  expect(result.isError, result.content[0].text).toBe(false);
  return result.structuredContent[field].map((row) => row.key);
};
const firstError = (result) => JSON.parse(result.content[0].text).errors[0];

const undeclaredTools = (adapter) => {
  const queryFeatures = { ...adapter.queryFeatures };
  delete queryFeatures.quantifiers;
  const reads = [];
  const rejectRead = (method) => () => { reads.push(method); throw new Error(`Unexpected ${method} on undeclared adapter`); };
  const api = createRuntime({
    ...adapter,
    queryFeatures,
    find: rejectRead('find'),
    count: rejectRead('count'),
    aggregate: rejectRead('aggregate'),
  });
  api.preventCreatingCollection(true);
  // Distinct names avoid replacing the live fixture's Mongoose models. Rejection needs no stored rows.
  const Review = new GraphQLObjectType({
    name: 'QtMcpUndeclaredReview',
    fields: () => ({
      id: { type: GraphQLID },
      author: { type: GraphQLString },
      item: { type: Item, extensions: { relation: { embedded: false, connectionField: 'item' } } },
    }),
  });
  const Item = new GraphQLObjectType({
    name: 'QtMcpUndeclaredItem',
    fields: {
      id: { type: GraphQLID },
      rank: { type: GraphQLInt },
      reviews: { type: new GraphQLList(Review), extensions: { relation: { embedded: false, connectionField: 'item' } } },
    },
  });
  api.connect(null, Item, 'qtMcpUndeclaredItem', 'qtMcpUndeclaredItems');
  api.connect(null, Review, 'qtMcpUndeclaredReview', 'qtMcpUndeclaredReviews');
  return { reads, ...generateMCPTools(api.createSchema(), { context: () => ({}) }) };
};

const backends = [
  {
    name: 'MongoDB',
    uri: mongoUri,
    async create(namespace) {
      await mongoose.connect(mongoUri, { dbName: namespace });
      const api = createRuntime(createMongoAdapter());
      api.preventCreatingCollection(true);
      return {
        api,
        undeclared: () => undeclaredTools(createMongoAdapter()),
        async initialize() { for (const { model } of api.getRegistrations()) if (model) await model.createCollection(); },
        async close() { if (mongoose.connection.readyState) { await mongoose.connection.db.dropDatabase(); await mongoose.disconnect(); } },
      };
    },
  },
  {
    name: 'PostgreSQL',
    uri: postgresUri,
    async create(namespace) {
      const pool = new pg.Pool({ connectionString: postgresUri });
      const api = createPostgres({ pool, schema: namespace });
      return {
        api,
        undeclared: () => undeclaredTools(createSQLAdapter(postgresPlugin({ pool, schema: namespace }))),
        initialize: () => api.initializeDatabase(),
        async close() { await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); await pool.end(); },
      };
    },
  },
];

for (const backend of backends) {
  describe.skipIf(!backend.uri)(`MCP tools with text operators on ${backend.name}`, () => {
    const namespace = `qt_mcp_${randomUUID().replaceAll('-', '')}`;
    let database; let schema; let tools; let callTool;

    beforeAll(async () => {
      database = await backend.create(namespace);
      registerTextOperatorFixture(database.api, createTextOperatorFixture());
      schema = database.api.createSchema();
      await database.initialize();
      await seedTextOperatorFixture((source, variableValues) => graphql({ schema, source, variableValues, contextValue: {} }));
      ({ tools, callTool } = generateMCPTools(schema, { context: () => ({}) }));
    }, 60000);
    afterAll(async () => { await database?.close(); });

    it('publishes every text operator in the operator enum of the list and aggregate tools', () => {
      for (const name of ['qtItems', 'qtItems_aggregate']) {
        expect(tools.find((tool) => tool.name === name).inputSchema.$defs.QLOperator.enum, name).toEqual(expect.arrayContaining(TEXT));
      }
    });

    it('returns the rows of field filters, relation terms and groups with text conditions', async () => {
      const cases = [
        [{ name: { operator: 'ILIKE', value: 'palermo' } }, ['A', 'B']],
        [{ name: { operator: 'STARTS_WITH', value: 'PALERMO' } }, ['B']],
        [{ name: { operator: 'ISTARTS_WITH', value: '100%' } }, ['C']],
        [{ name: { operator: 'ENDS_WITH', value: 'a\n' } }, ['E']],
        [{ name: { operator: 'IENDS_WITH', value: 'HOLLYWOOD' } }, ['B']],
        [{ name: { operator: 'IEQ', value: 'palermo soho' } }, ['A']],
        [{ tags: { operator: 'IEQ', value: 'red' } }, ['A', 'B']],
        [{ shop: { terms: [{ path: 'name', operator: 'ILIKE', value: 'open' }] } }, ['A', 'C']],
        [{ dims: { terms: [{ path: 'label', operator: 'ISTARTS_WITH', value: 'large' }] } }, ['A']],
        [{ OR: [{ conditions: [{ field: 'name', operator: 'IEQ', value: 'palermo soho' }] }, { conditions: [{ field: 'tags', operator: 'ENDS_WITH', value: '%' }] }] }, ['A', 'C']],
      ];
      for (const [args, expected] of cases) {
        expect(keysOf(await callTool('qtItems', { ...args, ...byKey }), 'qtItems'), JSON.stringify(args)).toEqual(expected);
      }
    });

    it('counts and pages a text condition, and returns each matching parent once as GraphQL does', async () => {
      const page = await callTool('qtItems', { name: { operator: 'ISTARTS_WITH', value: 'palermo' }, ...byKey, pagination: { page: 2, size: 1, count: true } });
      expect(keysOf(page, 'qtItems')).toEqual(['B']);
      expect(page.structuredContent.totalCount).toBe(2);
      expect(page._meta).toEqual({ count: 2 });
      const repeated = await callTool('qtItems', { reviews: { terms: [{ path: 'author', operator: 'ILIKE', value: '' }] }, ...byKey, pagination: { page: 1, size: 10, count: true } });
      expect(keysOf(repeated, 'qtItems')).toEqual(['A', 'B']);
      expect(repeated.structuredContent.totalCount).toBe(2);
    });

    it('runs a NONE collection field filter with counted pagination through the list tool', async () => {
      const result = await callTool('qtItems', {
        reviews: { quantifier: 'NONE', terms: [{ path: 'author', operator: 'ISTARTS_WITH', value: 'ana' }] },
        ...byKey,
        pagination: { page: 1, size: 10, count: true },
      });
      expect(keysOf(result, 'qtItems')).toEqual(['C', 'D', 'E', 'F', 'G', 'H']);
      expect(result.structuredContent.totalCount).toBe(6);
      expect(result._meta).toEqual({ count: 6 });
    });

    it('runs an ANY collection group through the aggregate tool without multiplying roots', async () => {
      const result = await callTool('qtItems_aggregate', {
        AND: [{ ANY: [{ path: 'reviews', conditions: [{ field: 'author', operator: 'ILIKE', value: '' }] }] }],
        aggregation: { groupId: 'rank', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }] },
        sort: { terms: [{ field: 'groupId', order: 'ASC' }] },
      });
      expect(result.isError, result.content[0].text).toBe(false);
      expect(result.structuredContent.qtItems_aggregate).toEqual([{ groupId: 1, facts: { n: 1 } }, { groupId: 2, facts: { n: 1 } }]);
    });

    it('filters an aggregate call with a text condition', async () => {
      const result = await callTool('qtItems_aggregate', {
        name: { operator: 'ILIKE', value: 'PALERMO' },
        aggregation: { groupId: 'rank', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }] },
        sort: { terms: [{ field: 'groupId', order: 'ASC' }] },
      });
      expect(result.isError, result.content[0].text).toBe(false);
      expect(result.structuredContent.qtItems_aggregate).toEqual([{ groupId: 1, facts: { n: 1 } }, { groupId: 2, facts: { n: 1 } }]);
    });

    it('returns UNSUPPORTED_QUERY before list, count or aggregate reads on an adapter without quantifiers', async () => {
      const undeclared = database.undeclared();
      for (const [name, args] of [
        ['qtMcpUndeclaredItems', {
          reviews: { quantifier: 'NONE', terms: [{ path: 'author', operator: 'ISTARTS_WITH', value: 'ana' }] },
          pagination: { page: 1, size: 10, count: true },
        }],
        ['qtMcpUndeclaredItems_aggregate', {
          AND: [{ ANY: [{ path: 'reviews', conditions: [{ field: 'author', operator: 'ILIKE', value: '' }] }] }],
          aggregation: { groupId: 'rank', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }] },
        }],
      ]) {
        const result = await undeclared.callTool(name, args);
        expect(result.isError, name).toBe(true);
        expect(firstError(result).extensions?.code, name).toBe('UNSUPPORTED_QUERY');
      }
      expect(undeclared.reads).toEqual([]);
    });

    it('returns INVALID_FILTER_VALUE tool errors for invalid text values', async () => {
      for (const operator of TEXT) {
        for (const args of [{ name: { operator, value: 'a\u0000' } }, { rank: { operator, value: '1' } }, { name: { operator, value: null } }]) {
          const result = await callTool('qtItems', args);
          expect(result.isError, `${operator} ${JSON.stringify(args)}`).toBe(true);
          expect(firstError(result).extensions.code, `${operator} ${JSON.stringify(args)}`).toBe('INVALID_FILTER_VALUE');
        }
      }
    });

    it('runs an ILIKE call from an SDK client that validates tool input and output', async () => {
      const server = await createMCPServer(schema, { context: () => ({}), nestedCollections: 'none' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'qt-mcp-client', version: '1.0.0' });
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const { tools: listed } = await client.listTools();
        expect(listed.find((tool) => tool.name === 'qtItems').inputSchema.$defs.QLOperator.enum).toEqual(expect.arrayContaining(TEXT));
        const result = await client.callTool({ name: 'qtItems', arguments: { name: { operator: 'ILIKE', value: 'PALERMO' }, ...byKey } });
        expect(keysOf(result, 'qtItems')).toEqual(['A', 'B']);
      } finally {
        await client.close();
        await server.close();
      }
    });
  });
}
