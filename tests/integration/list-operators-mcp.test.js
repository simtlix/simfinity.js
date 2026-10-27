// The list operators CONTAINS_ALL and IIN (#108, part 4) through generated MCP tools on both backends: the list and
// aggregate tools publish both names last in their operator enum and state their rules; list, counted list and
// aggregate calls accept them in field filters, relation terms, group conditions and quantified groups, and return the
// rows of the spec's parity section (the cases of tests/helpers/list-operators.js) in every scope shape a row names;
// rejected conditions come back as tool errors with the codes and messages of the runtime gate, before the adapter
// runs; an adapter that declares no queryFeatures answers UNSUPPORTED_QUERY without an adapter call; and an SDK client
// that validates tool input and output runs them. The release before part 4 rejects both names in the QLOperator enum,
// so every test here fails there.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { graphql } from 'graphql';
import mongoose from 'mongoose';
import pg from 'pg';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createRuntime } from '../../packages/core/src/index.js';
import { createMongoAdapter } from '../../packages/mongodb/src/mongo/adapter.js';
import { postgresPlugin } from '../../packages/postgres/src/index.js';
import { createSQLAdapter } from '../../packages/sql/src/adapter.js';
import { createMCPServer, generateMCPTools } from '../../packages/mcp/src/index.js';
import {
  createListOperatorTypes, LIST_OPERATOR_CASES, listOperatorArgs, registerListOperatorTypes, seedListOperators,
} from '../helpers/list-operators.js';

const mongoUri = process.env.SIMFINITY_MONGODB_URI;
const postgresUri = process.env.SIMFINITY_POSTGRES_URI;
const OPERATORS = ['CONTAINS_ALL', 'IIN'];
const VALUE = 'Filter value. Accepts a scalar, or an array for the IN, NIN, IIN, BTW and CONTAINS_ALL operators. Omit it, or pass null, for IS_EMPTY and IS_NOT_EMPTY.';
const SHORTHAND = 'The shorthand excludes them; use an explicit group';
const byKey = { sort: { terms: [{ field: 'key', order: 'ASC' }] } };
const counted = { ...byKey, pagination: { page: 1, size: 100, count: true } };
const aggregation = (groupId) => ({ aggregation: { groupId, facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }] } });
const firstError = (result) => JSON.parse(result.content[0].text).errors[0];
// A tool result as one line: its keys and, for a counted call, its total; or its error's code and message.
const outcomeOf = (result, field) => {
  if (result.isError) {
    const error = firstError(result);
    return `${error.extensions?.code}: ${error.message}`;
  }
  const keys = result.structuredContent[field].map((row) => row.key).join(' ');
  return result.structuredContent.totalCount === undefined ? keys : `${keys}, count ${result.structuredContent.totalCount}`;
};
const groupsOf = (result, field) => {
  if (result.isError) {
    const error = firstError(result);
    return `${error.extensions?.code}: ${error.message}`;
  }
  return result.structuredContent[field].map((group) => `${group.groupId} ${group.facts.n}`).sort().join(', ');
};
const contextOf = (shape) => (shape === 'admin' ? {} : { scopes: [shape] });
// The runtime's 403 for a scoped reference inside an embedded list inside a frame, with each backend's type names.
const forbidden = (prefix) => `FORBIDDEN_FILTER_PATH: Query path reviews.item.parts.shop enters ${prefix}Shop, whose find scope restricts the relation ${prefix}Part.shop inside a list`;
// The rows that test CONTAINS_ALL or IIN; the IN twin passes before part 4 and stays in the parity suite.
const CASES = LIST_OPERATOR_CASES.filter((item) => !item.guard);
// The surfaces of a row: its own arguments (a field filter or relation term, an explicit group or a quantified field
// filter), then a single condition as a group condition.
const surfaces = (item) => [
  ['as written', item.args],
  ...(item.condition ? [['as a group condition', { AND: [{ conditions: [{ ...item.condition }] }] }]] : []),
];
// The adapter methods that read records.
const READS = ['find', 'count', 'aggregate', 'getById', 'getByIds', 'findChildren', 'findChildrenBatch'];

// Each backend's adapter, wrapped so that `reads` receives the name of every read method called.
const recording = (adapter, reads) => ({
  ...adapter,
  ...Object.fromEntries(READS.filter((method) => typeof adapter[method] === 'function').map((method) => [method, (...inputs) => {
    reads.push(method);
    return adapter[method](...inputs);
  }])),
});
// A copy of an adapter without queryFeatures, which must reject both names before any read.
const withoutFeatures = (adapter, reads) => ({
  ...adapter,
  queryFeatures: undefined,
  ...Object.fromEntries(READS.filter((method) => typeof adapter[method] === 'function').map((method) => [method, () => {
    reads.push(method);
    throw new Error(`Unexpected ${method} on an adapter without queryFeatures`);
  }])),
});

const backends = [
  {
    name: 'MongoDB',
    uri: mongoUri,
    backend: 'mongodb',
    async create(namespace, reads) {
      await mongoose.connect(mongoUri, { dbName: namespace });
      const api = createRuntime(recording(createMongoAdapter(), reads));
      api.preventCreatingCollection(true);
      return {
        api,
        // Rejected before the adapter runs, so it needs no storage.
        legacy: (legacyReads) => createRuntime(withoutFeatures(createMongoAdapter(), legacyReads)),
        async initialize() { for (const { model } of api.getRegistrations()) if (model) { await model.createCollection(); await model.init(); } },
        async close() {
          if (mongoose.connection.readyState) {
            await Promise.allSettled(mongoose.modelNames().map((name) => mongoose.model(name).init()));
            await mongoose.connection.db.dropDatabase();
            await mongoose.disconnect();
          }
        },
      };
    },
  },
  {
    name: 'PostgreSQL',
    uri: postgresUri,
    backend: 'postgres',
    async create(namespace, reads) {
      const pool = new pg.Pool({ connectionString: postgresUri });
      const adapter = createSQLAdapter(postgresPlugin({ pool, schema: namespace }));
      const api = createRuntime(recording(adapter, reads));
      return {
        api,
        legacy: (legacyReads) => createRuntime(withoutFeatures(createSQLAdapter(postgresPlugin({ pool, schema: `${namespace}_l` })), legacyReads)),
        initialize: () => adapter.initialize(),
        async close() { await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); await pool.end(); },
      };
    },
  },
];

for (const backend of backends) {
  describe.skipIf(!backend.uri)(`MCP tools with list operators on ${backend.name}`, () => {
    const namespace = `ql_mcp_${randomUUID().replaceAll('-', '')}`;
    const reads = [];
    const tools = {};
    let database; let schema; let types; let seeded; let list; let aggregate;
    // The tools of one scope shape, made once.
    const toolsOf = (shape) => {
      tools[shape] ??= generateMCPTools(schema, { context: () => contextOf(shape) });
      return tools[shape];
    };
    const call = (shape, name, args) => toolsOf(shape).callTool(name, listOperatorArgs(args, seeded));

    beforeAll(async () => {
      database = await backend.create(namespace, reads);
      types = createListOperatorTypes(null, { backend: backend.backend, scopes: true });
      registerListOperatorTypes(database.api, types);
      schema = database.api.createSchema();
      await database.initialize();
      seeded = await seedListOperators((source, variableValues) => graphql({ schema, source, variableValues, contextValue: {} }), backend.backend);
      list = types.roots.item.plural;
      aggregate = `${list}_aggregate`;
    }, 120000);
    afterAll(async () => { await database?.close(); });

    it('publishes CONTAINS_ALL and IIN last in the operator enum of the list and aggregate tools, and states their rules', () => {
      for (const name of [list, aggregate]) {
        const { description, inputSchema: { $defs } } = toolsOf('admin').tools.find((tool) => tool.name === name);
        expect($defs.QLOperator.enum.slice(-2), name).toEqual(OPERATORS);
        expect(description, name).toContain('operators: EQ, NE, LT, LTE, GT, GTE, IN, NIN, IIN, CONTAINS_ALL, BTW, ');
        expect($defs.QLOperator.description, name).toContain('IIN (value in list, ignoring case), CONTAINS_ALL (list holds every listed value), ');
        expect($defs.QLOperator.description, name).toContain('IIN takes an array of strings and applies to String fields and String lists');
        expect($defs.QLOperator.description, name).toContain('through a collection or through a reference inside an embedded list with INVALID_FILTER_PATH');
        for (const def of ['QLFilter', 'QLTypeFilter', 'QLFilterCondition']) expect($defs[def].properties.value.description, `${name} ${def}`).toBe(VALUE);
      }
    });

    // Every row in every scope shape it names, on its own arguments and as a group condition, listed and counted; the
    // 403 shapes give FORBIDDEN_FILTER_PATH with no adapter read.
    it.each(CASES.map((item) => [`${item.bullet}: ${item.name}`, item]))('returns the rows of %s from the list tool, listed and counted, in every scope shape', async (label, item) => {
      const observed = [];
      const expected = [];
      for (const shape of [...Object.keys(item.rows), ...(item.forbidden ?? [])]) {
        for (const [surface, args] of surfaces(item)) {
          const line = `${shape} ${surface}`;
          if (item.forbidden?.includes(shape)) {
            reads.length = 0;
            for (const [read, rest] of [['listed', byKey], ['counted', counted]]) {
              observed.push(`${line} ${read}: ${outcomeOf(await call(shape, list, { ...args, ...rest }), list)}`);
              expected.push(`${line} ${read}: ${forbidden(types.prefix)}`);
            }
            observed.push(`${line} reads: ${reads.join(', ')}`);
            expected.push(`${line} reads: `);
            continue;
          }
          const keys = item.rows[shape].join(' ');
          observed.push(`${line} listed: ${outcomeOf(await call(shape, list, { ...args, ...byKey }), list)}`);
          expected.push(`${line} listed: ${keys}`);
          observed.push(`${line} counted: ${outcomeOf(await call(shape, list, { ...args, ...counted }), list)}`);
          expected.push(`${line} counted: ${keys}, count ${item.counts?.[shape] ?? item.rows[shape].length}`);
        }
      }
      expect(observed).toEqual(expected);
    }, 60000);

    // Grouped by key, each record of a row is one group, in the admin shape; the multiplying join through parts.shop is
    // left to the lists.
    it.each(CASES.filter((item) => item.rows.admin && new Set(item.rows.admin).size === item.rows.admin.length).map((item) => [`${item.bullet}: ${item.name}`, item]))(
      'returns the rows of %s from the aggregate tool',
      async (label, item) => {
        const observed = [];
        const expected = [];
        for (const [surface, args] of surfaces(item)) {
          observed.push(`${surface}: ${groupsOf(await call('admin', aggregate, { ...args, ...aggregation('key') }), aggregate)}`);
          expected.push(`${surface}: ${item.rows.admin.map((key) => `${key} 1`).join(', ')}`);
        }
        expect(observed).toEqual(expected);
      },
      60000,
    );

    it('filters the joined reviews of the J prefix reviews with IIN, filters by CONTAINS_ALL on the record\'s own list, and cuts an IIN shorthand below the J prefix items, from the aggregate tools', async () => {
      const shops = `${types.roots.shop.plural}_aggregate`;
      expect(groupsOf(await call('admin', aggregate, {
        AND: [{ conditions: [{ field: 'reviews.author', operator: 'IIN', value: ['ANA', 'bob'] }] }], ...aggregation('reviews.author'),
      }), aggregate)).toBe('ANA 1, Ana 1, bob 1');
      expect(groupsOf(await call('admin', aggregate, { tags: { operator: 'CONTAINS_ALL', value: ['A', 'B'] }, ...aggregation('reviews.author') }), aggregate))
        .toBe('Ana 1, bob 1, null 1');
      expect(groupsOf(await call('admin', shops, {
        AND: [{ conditions: [{ field: 'items.reviews.author', operator: 'IIN', value: ['ana'] }] }], ...aggregation('items.name'),
      }), shops)).toBe('TWO 1, one 1');
    });

    it('returns INVALID_FILTER_PATH, INVALID_FILTER_OPERATOR and INVALID_FILTER_VALUE tool errors before the adapter runs', async () => {
      const REJECTED = [
        [{ reviews: { terms: [{ path: 'tags', operator: 'CONTAINS_ALL', value: ['x'] }] } }, 'INVALID_FILTER_PATH', SHORTHAND],
        [{ parts: { terms: [{ path: 'shop.tags', operator: 'CONTAINS_ALL', value: ['a'] }] } }, 'INVALID_FILTER_PATH',
          'CONTAINS_ALL cannot cross the reference parts.shop inside an embedded list, which joins one referenced record per row; combine EQ conditions on the path instead'],
        [{ name: { operator: 'CONTAINS_ALL', value: ['a'] } }, 'INVALID_FILTER_OPERATOR', 'CONTAINS_ALL requires a list field, or a field reached through an embedded list; name is not one'],
        [{ tags: { operator: 'CONTAINS_ALL', value: [] } }, 'INVALID_FILTER_VALUE', 'CONTAINS_ALL requires a non-empty list'],
        [{ ranks: { operator: 'IIN', value: ['1'] } }, 'INVALID_FILTER_VALUE', 'IIN requires a String field on ranks'],
        [{ kinds: { operator: 'IIN', value: ['one_v'] } }, 'INVALID_FILTER_VALUE', 'IIN requires a String field on kinds'],
        [{ name: { operator: 'IIN', value: ['a\u0000'] } }, 'INVALID_FILTER_VALUE', 'IIN values cannot contain U+0000 on name'],
      ];
      reads.length = 0;
      for (const [args, code, message] of REJECTED) {
        for (const [name, extra] of [[list, {}], [aggregate, aggregation('key')]]) {
          const result = await call('admin', name, { ...args, ...extra });
          expect(result.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
          const error = firstError(result);
          expect(error.extensions?.code, `${name} ${JSON.stringify(args)}`).toBe(code);
          expect(error.message, `${name} ${JSON.stringify(args)}`).toBe(message);
        }
      }
      // The shorthand's exclusion holds on the J prefix of an aggregate too.
      const joined = await call('admin', aggregate, { AND: [{ conditions: [{ field: 'reviews.tags', operator: 'CONTAINS_ALL', value: ['x'] }] }], ...aggregation('reviews.author') });
      expect(groupsOf(joined, aggregate)).toBe(`INVALID_FILTER_PATH: ${SHORTHAND}`);
      expect(reads).toEqual([]);
    });

    it('returns UNSUPPORTED_QUERY tool errors without an adapter call for an adapter that declares no queryFeatures', async () => {
      const legacyReads = [];
      const api = database.legacy(legacyReads);
      api.preventCreatingCollection(true);
      // Distinct names keep the live fixture's Mongoose models.
      const legacyTypes = createListOperatorTypes(`${types.prefix}Legacy`, { backend: backend.backend });
      registerListOperatorTypes(api, legacyTypes);
      const legacy = generateMCPTools(api.createSchema(), { context: () => ({}) });
      const name = legacyTypes.roots.item.plural;
      const type = legacyTypes.Item.name;
      const observed = [];
      const expected = [];
      for (const [operator, value] of [['CONTAINS_ALL', ['A']], ['IIN', ['a']]]) {
        for (const [args, path] of [
          [{ tags: { operator, value } }, 'tags'],
          [{ shop: { terms: [{ path: 'tags', operator, value }] } }, 'shop.tags'],
          [{ AND: [{ conditions: [{ field: 'tags', operator, value }] }] }, 'tags'],
        ]) {
          for (const [tool, extra] of [[name, {}], [`${name}_aggregate`, aggregation('key')]]) {
            observed.push(`${tool} ${JSON.stringify(args)}: ${outcomeOf(await legacy.callTool(tool, { ...args, ...extra }), tool)}`);
            expected.push(`${tool} ${JSON.stringify(args)}: UNSUPPORTED_QUERY: The database adapter does not support the ${operator} filter operator, used on ${type}.${path}`);
          }
        }
      }
      expect(observed).toEqual(expected);
      expect(legacyReads).toEqual([]);
    });

    it('runs CONTAINS_ALL and IIN calls from an SDK client that validates tool input and output', async () => {
      const server = await createMCPServer(schema, { context: () => ({}), nestedCollections: 'none' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'ql-mcp-client', version: '1.0.0' });
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const { tools: listed } = await client.listTools();
        expect(listed.find((tool) => tool.name === list).inputSchema.$defs.QLOperator.enum.slice(-2)).toEqual(OPERATORS);
        const all = await client.callTool({ name: list, arguments: { tags: { operator: 'CONTAINS_ALL', value: ['A', 'B'] }, ...byKey } });
        expect(outcomeOf(all, list)).toBe('I1 I3');
        const folded = await client.callTool({ name: list, arguments: { AND: [{ conditions: [{ field: 'name', operator: 'IIN', value: ['ONE', 'two'] }] }], ...byKey } });
        expect(outcomeOf(folded, list)).toBe('I1 I2');
      } finally {
        await client.close();
        await server.close();
      }
    });
  });
}
