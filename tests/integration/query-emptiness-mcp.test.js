// The emptiness operators IS_EMPTY and IS_NOT_EMPTY (#108, part 2a) through generated MCP tools on both backends:
// list, counted list and aggregate calls accept them with the value omitted or null and in terms and group
// conditions without a path, and return the rows the cases of tests/helpers/query-emptiness.js expect; the adapter
// receives no `value` key; the tool schemas and descriptions state the rules; an SDK client that validates tool
// input and output runs them; and rejected conditions come back as tool errors with the codes of the runtime gate,
// before the adapter runs.
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
  EMPTINESS_CASES, createEmptinessTypes, expectedEmptinessKeys, registerEmptinessTypes, seedEmptiness,
} from '../helpers/query-emptiness.js';

const mongoUri = process.env.SIMFINITY_MONGODB_URI;
const postgresUri = process.env.SIMFINITY_POSTGRES_URI;
const OPERATORS = ['IS_EMPTY', 'IS_NOT_EMPTY'];
const LATER = 'emptiness through references and collections arrives with reference emptiness (#108)';
const IN_LIST = 'emptiness of a value inside a list is not defined';
const NO_VALUE = 'IS_EMPTY and IS_NOT_EMPTY take no value, and a term or group condition without path applies them to an embedded object or list itself';
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
      schema = database.api.createSchema();
      await database.initialize();
      await seedEmptiness((source, variableValues) => graphql({ schema, source, variableValues, contextValue: {} }), types, CASES);
      ({ tools, callTool } = generateMCPTools(schema, { context: () => ({}) }));
    }, 60000);
    afterAll(async () => { await database?.close(); });

    it('publishes both operators in the operator enum of the list and aggregate tools, and states their rules', () => {
      for (const name of ['qzItems', 'qzItems_aggregate']) {
        const { description, inputSchema: { $defs, properties } } = tools.find((tool) => tool.name === name);
        expect($defs.QLOperator.enum.slice(-2), name).toEqual(OPERATORS);
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

    it('returns INVALID_FILTER_VALUE, INVALID_FILTER_PATH and UNSUPPORTED_QUERY tool errors before the adapter runs', async () => {
      const aggregation = { groupId: 'key', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }] };
      const REJECTED = [
        [{ note: { operator: 'IS_EMPTY', value: 'x' } }, 'INVALID_FILTER_VALUE', 'IS_EMPTY takes no value on note: omit it or pass null'],
        [{ count: { operator: 'IS_NOT_EMPTY', value: 0 } }, 'INVALID_FILTER_VALUE', 'IS_NOT_EMPTY takes no value on count: omit it or pass null'],
        [{ dims: { terms: [{ operator: 'IS_EMPTY', value: '' }] } }, 'INVALID_FILTER_VALUE', 'IS_EMPTY takes no value on dims: omit it or pass null'],
        [{ AND: [{ conditions: [{ field: 'tags', operator: 'IS_EMPTY', value: [] }] }] }, 'INVALID_FILTER_VALUE', 'IS_EMPTY takes no value on tags: omit it or pass null'],
        // A path that continues inside an embedded list or a collection.
        [{ lines: { terms: [{ path: 'qty', operator: 'IS_EMPTY' }] } }, 'INVALID_FILTER_PATH', IN_LIST],
        [{ reviews: { terms: [{ path: 'text', operator: 'IS_NOT_EMPTY' }] } }, 'INVALID_FILTER_PATH', IN_LIST],
        // A path that crosses or ends at a reference, a path that ends at a collection, and an object with a
        // reference member.
        [{ shop: { terms: [{ path: 'name', operator: 'IS_EMPTY' }] } }, 'UNSUPPORTED_QUERY', LATER],
        [{ shop: { terms: [{ operator: 'IS_NOT_EMPTY' }] } }, 'UNSUPPORTED_QUERY', LATER],
        [{ reviews: { terms: [{ operator: 'IS_EMPTY' }] } }, 'UNSUPPORTED_QUERY', LATER],
        [{ odim: { terms: [{ operator: 'IS_EMPTY' }] } }, 'UNSUPPORTED_QUERY', LATER],
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
