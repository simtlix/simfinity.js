// The emptiness operators IS_EMPTY and IS_NOT_EMPTY (#108, part 2a) through generated MCP tools on both backends:
// list, counted list and aggregate calls accept them with the value omitted or null and in terms and group
// conditions without a path, and return the rows the cases of tests/helpers/query-emptiness.js expect; the adapter
// receives no `value` key; the tool schemas and descriptions state the rules; an SDK client that validates tool
// input and output runs them; and rejected conditions come back as tool errors with the codes of the runtime gate,
// before the adapter runs. Conditions through references and collections (#108, part 2b) return rows with both bundled
// adapters, which declare referenceEmptiness: a reference-emptiness call on the fixture of reference emptiness reads a
// record that the target's find scope hides as a missing one, and the adapter receives the filled client scope marker.
// An adapter that declares the operators without referenceEmptiness gets UNSUPPORTED_QUERY tool errors.
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
  EMPTINESS_CASES, REFERENCE_CASES, createEmptinessTypes, createReferenceEmptinessTypes, expectedEmptinessKeys, expectedReferenceRows,
  registerEmptinessTypes, registerReferenceEmptinessTypes, seedEmptiness, seedReferenceEmptiness,
} from '../helpers/query-emptiness.js';

const mongoUri = process.env.SIMFINITY_MONGODB_URI;
const postgresUri = process.env.SIMFINITY_POSTGRES_URI;
const OPERATORS = ['IS_EMPTY', 'IS_NOT_EMPTY'];
const NOT_SUPPORTED = 'the database adapter does not support emptiness through references and collections';
const IN_LIST = 'emptiness of a value inside a list is not defined';
const NO_VALUE = 'IS_EMPTY and IS_NOT_EMPTY take no value, and a term or group condition without path applies them to the field itself: an embedded object or list, or a reference or collection where the database adapter supports it';
// The item and sid cases; the owned roots are left out.
const CASES = EMPTINESS_CASES.filter((item) => item.root !== 'owned');
const byKey = { sort: { terms: [{ field: 'key', order: 'ASC' }] } };
const keysOf = (result, field) => {
  expect(result.isError, result.content[0].text).toBe(false);
  return result.structuredContent[field].map((row) => row.key);
};
const firstError = (result) => JSON.parse(result.content[0].text).errors[0];
const intersection = (lists) => lists.reduce((kept, keys) => kept.filter((key) => keys.includes(key)));
const expected = (path, operator, rootKey = 'item') => expectedEmptinessKeys(rootKey, path, operator, CASES);
const aggregation = { groupId: 'key', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }] };
const referenceRows = (name, shape) => expectedReferenceRows(REFERENCE_CASES.find((item) => item.name === name), shape);
// Conditions that 2a rejected under rule 6: a path that crosses or ends at a reference, one that ends at a collection,
// and an object with a reference member, with what an adapter that does not declare referenceEmptiness says of each.
const REFERENCE_CONDITIONS = [
  [{ shop: { terms: [{ path: 'name', operator: 'IS_EMPTY' }] } }, 'IS_EMPTY on shop.name crosses the reference shop'],
  [{ shop: { terms: [{ operator: 'IS_NOT_EMPTY' }] } }, 'IS_NOT_EMPTY on shop ends at the reference shop'],
  [{ reviews: { terms: [{ operator: 'IS_EMPTY' }] } }, 'IS_EMPTY on reviews ends at the collection reviews'],
  [{ odim: { terms: [{ operator: 'IS_EMPTY' }] } }, 'IS_EMPTY on odim reads the reference member odim.shop'],
];

// Each backend's adapter, wrapped so that `reads` receives the arguments of every find, count and aggregate call.
const recording = (adapter, reads) => ({
  ...adapter,
  find: (model, type, args, ...rest) => { reads.push(args); return adapter.find(model, type, args, ...rest); },
  count: (model, type, args, ...rest) => { reads.push(args); return adapter.count(model, type, args, ...rest); },
  aggregate: (model, type, args, ...rest) => { reads.push(args); return adapter.aggregate(model, type, args, ...rest); },
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
        legacy: () => createRuntime({ ...createMongoAdapter(), queryFeatures: undefined }),
        undeclared: () => createRuntime({ ...createMongoAdapter(), queryFeatures: { operators: createMongoAdapter().queryFeatures.operators } }),
        async initialize() { for (const { model } of api.getRegistrations()) if (model) await model.createCollection(); },
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
        legacy: () => createRuntime(createSQLAdapter({ ...postgresPlugin({ pool, schema: `${namespace}_l` }), queryFeatures: undefined })),
        undeclared: () => createRuntime(createSQLAdapter({
          ...postgresPlugin({ pool, schema: `${namespace}_u` }), queryFeatures: { operators: postgresPlugin().queryFeatures.operators },
        })),
        initialize: () => adapter.initialize(),
        async close() { await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); await pool.end(); },
      };
    },
  },
];

for (const backend of backends) {
  describe.skipIf(!backend.uri)(`MCP tools with emptiness operators on ${backend.name}`, () => {
    const namespace = `qz_mcp_${randomUUID().replaceAll('-', '')}`;
    const reads = [];
    let database; let schema; let tools; let callTool;

    beforeAll(async () => {
      database = await backend.create(namespace, reads);
      const types = createEmptinessTypes('Qz', { backend: backend.backend });
      registerEmptinessTypes(database.api, types);
      // The fixture of reference emptiness, whose scopes read the context's shape.
      const referenceTypes = createReferenceEmptinessTypes('Qm', { backend: backend.backend });
      registerReferenceEmptinessTypes(database.api, referenceTypes);
      schema = database.api.createSchema();
      await database.initialize();
      const execute = (source, variableValues) => graphql({ schema, source, variableValues, contextValue: {} });
      await seedEmptiness(execute, types, CASES);
      await seedReferenceEmptiness(execute, referenceTypes);
      ({ tools, callTool } = generateMCPTools(schema, { context: () => ({}) }));
    }, 60000);
    afterAll(async () => { await database?.close(); });

    it('publishes both operators in the operator enum of the list and aggregate tools, and states their rules', () => {
      for (const name of ['qzItems', 'qzItems_aggregate']) {
        const { description, inputSchema: { $defs, properties } } = tools.find((tool) => tool.name === name);
        expect($defs.QLOperator.enum.slice(-4, -2), name).toEqual(OPERATORS);
        expect(description, name).toContain(`IEQ, IS_EMPTY, IS_NOT_EMPTY; ${NO_VALUE})`);
        expect($defs.QLOperator.description, name).toContain('IS_EMPTY and IS_NOT_EMPTY take no value (omit it or pass null), and every record matches exactly one of them');
        expect($defs.QLOperator.description, name).toContain('a path that continues inside an embedded list or a collection fails with INVALID_FILTER_PATH');
        for (const def of ['QLFilter', 'QLTypeFilter', 'QLFilterCondition']) {
          expect($defs[def].properties.value.description, `${name} ${def}`).toContain('Omit it, or pass null, for IS_EMPTY and IS_NOT_EMPTY.');
          // Neither the value nor the path is required.
          expect($defs[def].required ?? [], `${name} ${def}`).not.toEqual(expect.arrayContaining(['value']));
          expect($defs[def].required ?? [], `${name} ${def}`).not.toEqual(expect.arrayContaining(['path']));
        }
        expect($defs.QLTypeFilter.description, name).toContain('With IS_EMPTY or IS_NOT_EMPTY, omit the path to test the embedded object or embedded list itself.');
        expect(properties.note.description, name).toBe('Filter on `note` using { operator, value }; IS_EMPTY and IS_NOT_EMPTY take no value.');
        expect(properties.dims.description, name).toContain('a term { operator: IS_EMPTY } or { operator: IS_NOT_EMPTY } without path tests the field itself');
      }
    });

    it('returns the rows of omitted and null values, of terms without a path and of group conditions without one', async () => {
      const cases = [
        [{ note: { operator: 'IS_EMPTY' } }, expected('note', 'IS_EMPTY')],
        [{ note: { operator: 'IS_NOT_EMPTY', value: null } }, expected('note', 'IS_NOT_EMPTY')],
        [{ tags: { operator: 'IS_EMPTY' } }, expected('tags', 'IS_EMPTY')],
        [{ dims: { terms: [{ operator: 'IS_EMPTY' }] } }, expected('dims', 'IS_EMPTY')],
        [{ dims: { terms: [{ path: '', operator: 'IS_NOT_EMPTY' }] } }, expected('dims', 'IS_NOT_EMPTY')],
        [{ lines: { terms: [{ path: null, operator: 'IS_EMPTY', value: null }] } }, expected('lines', 'IS_EMPTY')],
        [{ outer: { terms: [{ path: 'inner.z', operator: 'IS_NOT_EMPTY' }] } }, expected('outer.inner.z', 'IS_NOT_EMPTY')],
        [{ dims: { terms: [{ operator: 'IS_NOT_EMPTY' }, { path: 'w', operator: 'IS_EMPTY' }] } }, intersection([expected('dims', 'IS_NOT_EMPTY'), expected('dims.w', 'IS_EMPTY')])],
        [{ AND: [{ conditions: [{ field: 'plain', operator: 'IS_NOT_EMPTY' }] }] }, expected('plain', 'IS_NOT_EMPTY')],
        [{ OR: [{ conditions: [{ field: 'outer.inner', operator: 'IS_EMPTY', value: null }] }] }, expected('outer.inner', 'IS_EMPTY')],
        [{ AND: [{ conditions: [{ field: 'ident', path: 'id', operator: 'IS_NOT_EMPTY' }] }] }, expected('ident.id', 'IS_NOT_EMPTY')],
      ];
      for (const [args, rows] of cases) {
        expect(rows.length, JSON.stringify(args)).toBeGreaterThan(0);
        expect(keysOf(await callTool('qzItems', { ...args, ...byKey }), 'qzItems'), JSON.stringify(args)).toEqual(rows);
      }
      // The record identity declared String.
      expect(keysOf(await callTool('qzSids', { id: { operator: 'IS_EMPTY' }, ...byKey }), 'qzSids')).toEqual([]);
      expect(keysOf(await callTool('qzSids', { id: { operator: 'IS_NOT_EMPTY' }, ...byKey }), 'qzSids')).toEqual(expected('id', 'IS_NOT_EMPTY', 'sid'));
    });

    it('passes the conditions to the adapter without a value key, and without a path where the call has none', async () => {
      reads.length = 0;
      await callTool('qzItems', { note: { operator: 'IS_EMPTY' }, dims: { terms: [{ operator: 'IS_NOT_EMPTY' }] }, AND: [{ conditions: [{ field: 'outer', operator: 'IS_EMPTY' }] }] });
      expect(reads).toHaveLength(1);
      const [args] = reads;
      expect(args.note).toStrictEqual({ operator: 'IS_EMPTY' });
      expect(args.dims).toStrictEqual({ terms: [{ operator: 'IS_NOT_EMPTY' }] });
      expect(args.AND).toStrictEqual([{ conditions: [{ field: 'outer', operator: 'IS_EMPTY' }] }]);
    });

    it('counts and pages an emptiness condition, and filters an aggregate call with one', async () => {
      const rows = expected('dims', 'IS_EMPTY');
      expect(rows.length).toBeGreaterThan(3);
      const page = await callTool('qzItems', { dims: { terms: [{ operator: 'IS_EMPTY' }] }, ...byKey, pagination: { page: 2, size: 2, count: true } });
      expect(keysOf(page, 'qzItems')).toEqual(rows.slice(2, 4));
      expect(page.structuredContent.totalCount).toBe(rows.length);
      expect(page._meta).toEqual({ count: rows.length });
      const result = await callTool('qzItems_aggregate', {
        note: { operator: 'IS_NOT_EMPTY' },
        AND: [{ conditions: [{ field: 'lines', operator: 'IS_NOT_EMPTY' }] }],
        aggregation: { groupId: 'key', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }] },
      });
      expect(result.isError, result.content[0].text).toBe(false);
      const groups = intersection([expected('note', 'IS_NOT_EMPTY'), expected('lines', 'IS_NOT_EMPTY')]);
      expect(groups.length).toBeGreaterThan(1);
      expect([...result.structuredContent.qzItems_aggregate].sort((a, b) => (a.groupId < b.groupId ? -1 : 1)))
        .toEqual(groups.map((key) => ({ groupId: key, facts: { n: 1 } })));
    });

    it('returns INVALID_FILTER_VALUE and INVALID_FILTER_PATH tool errors before the adapter runs', async () => {
      const REJECTED = [
        [{ note: { operator: 'IS_EMPTY', value: 'x' } }, 'INVALID_FILTER_VALUE', 'IS_EMPTY takes no value on note: omit it or pass null'],
        [{ count: { operator: 'IS_NOT_EMPTY', value: 0 } }, 'INVALID_FILTER_VALUE', 'IS_NOT_EMPTY takes no value on count: omit it or pass null'],
        [{ dims: { terms: [{ operator: 'IS_EMPTY', value: '' }] } }, 'INVALID_FILTER_VALUE', 'IS_EMPTY takes no value on dims: omit it or pass null'],
        [{ AND: [{ conditions: [{ field: 'tags', operator: 'IS_EMPTY', value: [] }] }] }, 'INVALID_FILTER_VALUE', 'IS_EMPTY takes no value on tags: omit it or pass null'],
        // A path that continues inside an embedded list or a collection.
        [{ lines: { terms: [{ path: 'qty', operator: 'IS_EMPTY' }] } }, 'INVALID_FILTER_PATH', IN_LIST],
        [{ reviews: { terms: [{ path: 'text', operator: 'IS_NOT_EMPTY' }] } }, 'INVALID_FILTER_PATH', 'The shorthand excludes them; use an explicit group'],
      ];
      reads.length = 0;
      for (const [args, code, wording] of REJECTED) {
        for (const [name, extra] of [['qzItems', {}], ['qzItems_aggregate', { aggregation }]]) {
          const result = await callTool(name, { ...args, ...extra });
          expect(result.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
          const error = firstError(result);
          expect(error.extensions?.code, `${name} ${JSON.stringify(args)}`).toBe(code);
          expect(error.message, `${name} ${JSON.stringify(args)}`).toContain(wording);
        }
      }
      expect(reads).toEqual([]);
    });

    it('returns the rows of conditions through references and collections, which the bundled adapter declares, from list and aggregate tools', async () => {
      // No item of this fixture has a shop, a review or an `odim.shop`.
      const items = CASES.filter((item) => item.root === 'item').map((item) => item.name).sort();
      const rows = [items, [], items, intersection([expected('odim.w', 'IS_EMPTY'), expected('odim.tags', 'IS_EMPTY')])];
      for (const [index, [args]] of REFERENCE_CONDITIONS.entries()) {
        expect(keysOf(await callTool('qzItems', { ...args, ...byKey }), 'qzItems'), JSON.stringify(args)).toEqual(rows[index]);
        const result = await callTool('qzItems_aggregate', { ...args, aggregation });
        expect(result.isError, result.content[0].text).toBe(false);
        expect(result.structuredContent.qzItems_aggregate.map((group) => group.groupId).sort(), JSON.stringify(args)).toEqual(rows[index]);
      }
      expect(rows[3].length).toBeGreaterThan(0);
    });

    it('returns UNSUPPORTED_QUERY tool errors for conditions through references and collections when the adapter declares the operators without referenceEmptiness', async () => {
      const api = database.undeclared();
      api.preventCreatingCollection(true);
      registerEmptinessTypes(api, createEmptinessTypes('QzUndeclared', { backend: backend.backend }));
      const undeclared = generateMCPTools(api.createSchema(), { context: () => ({}) });
      for (const [args, wording] of REFERENCE_CONDITIONS) {
        for (const [name, extra] of [['qzUndeclaredItems', {}], ['qzUndeclaredItems_aggregate', { aggregation }]]) {
          const result = await undeclared.callTool(name, { ...args, ...extra });
          expect(result.isError, `${name} ${JSON.stringify(args)}`).toBe(true);
          expect(firstError(result).extensions?.code, `${name} ${JSON.stringify(args)}`).toBe('UNSUPPORTED_QUERY');
          expect(firstError(result).message, `${name} ${JSON.stringify(args)}`).toBe(`${wording}: ${NOT_SUPPORTED}`);
        }
      }
    });

    it('reads a record that the target\'s find scope hides as missing in reference-emptiness calls, and passes the filled marker to the adapter', async () => {
      const restricted = generateMCPTools(schema, { context: () => ({ shape: 'NE' }) });
      const shopEmpty = { shop: { terms: [{ operator: 'IS_EMPTY' }] }, ...byKey };
      // S2, c's shop, is hidden under NE; an admin reads the stored shops.
      reads.length = 0;
      expect(keysOf(await restricted.callTool('qmProducts', shopEmpty), 'qmProducts')).toEqual(referenceRows('shop IS_EMPTY', 'NE'));
      // The tool's own read; the others read the nested collections of its rows.
      expect(reads.filter((args) => Object.hasOwn(args, 'shop')).map((args) => args.shop)).toEqual([{
        terms: [{ operator: 'IS_EMPTY', __scope: { id: 0, scopes: { shop: { AND: [{ conditions: [{ field: 'name', operator: 'NE', value: 'S2' }] }] } } } }],
      }]);
      expect(keysOf(await callTool('qmProducts', shopEmpty), 'qmProducts')).toEqual(referenceRows('shop IS_EMPTY', 'admin'));
      expect(referenceRows('shop IS_EMPTY', 'NE')).not.toEqual(referenceRows('shop IS_EMPTY', 'admin'));
      // A group condition through a hidden Pro on a counted page, and a collection whose hidden reviews read as missing
      // in an aggregate.
      const chain = referenceRows('pro.shop IS_EMPTY', 'NE');
      const page = await restricted.callTool('qmProducts', {
        AND: [{ conditions: [{ field: 'pro', path: 'shop', operator: 'IS_EMPTY' }] }], ...byKey, pagination: { page: 1, size: 2, count: true },
      });
      expect(keysOf(page, 'qmProducts')).toEqual(chain.slice(0, 2));
      expect(page.structuredContent.totalCount).toBe(chain.length);
      const grouped = await restricted.callTool('qmProducts_aggregate', { reviews: { terms: [{ operator: 'IS_EMPTY' }] }, aggregation });
      expect(grouped.isError, grouped.content[0].text).toBe(false);
      expect(grouped.structuredContent.qmProducts_aggregate.map((group) => group.groupId).sort()).toEqual(referenceRows('reviews IS_EMPTY', 'NE'));
    });

    it('returns UNSUPPORTED_QUERY tool errors for an adapter that does not declare the operators', async () => {
      const api = database.legacy();
      api.preventCreatingCollection(true);
      registerEmptinessTypes(api, createEmptinessTypes('QzLegacy', { backend: backend.backend }));
      const legacy = generateMCPTools(api.createSchema(), { context: () => ({}) });
      for (const operator of OPERATORS) {
        for (const args of [{ note: { operator } }, { dims: { terms: [{ operator }] } }, { AND: [{ conditions: [{ field: 'lines', operator }] }] }]) {
          const result = await legacy.callTool('qzLegacyItems', args);
          expect(result.isError, JSON.stringify(args)).toBe(true);
          expect(firstError(result).extensions?.code, JSON.stringify(args)).toBe('UNSUPPORTED_QUERY');
          expect(firstError(result).message, JSON.stringify(args)).toContain(`The database adapter does not support the ${operator} filter operator`);
        }
      }
    });

    it('runs IS_EMPTY and IS_NOT_EMPTY calls from an SDK client that validates tool input and output', async () => {
      const server = await createMCPServer(schema, { context: () => ({}), nestedCollections: 'none' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: 'qz-mcp-client', version: '1.0.0' });
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      try {
        const { tools: listed } = await client.listTools();
        expect(listed.find((tool) => tool.name === 'qzItems').inputSchema.$defs.QLOperator.enum).toEqual(expect.arrayContaining(OPERATORS));
        const empty = await client.callTool({ name: 'qzItems', arguments: { outer: { terms: [{ operator: 'IS_EMPTY' }] }, ...byKey } });
        expect(keysOf(empty, 'qzItems')).toEqual(expected('outer', 'IS_EMPTY'));
        const notEmpty = await client.callTool({ name: 'qzItems', arguments: { AND: [{ conditions: [{ field: 'tags', operator: 'IS_NOT_EMPTY', value: null }] }], ...byKey } });
        expect(keysOf(notEmpty, 'qzItems')).toEqual(expected('tags', 'IS_NOT_EMPTY'));
      } finally {
        await client.close();
        await server.close();
      }
    });
  });
}
