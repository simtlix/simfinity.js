import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import pg from 'pg';
import { graphql } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRuntime } from '../../packages/core/src/index.js';
import { createMongoAdapter } from '../../packages/mongodb/src/mongo/adapter.js';
import { createPostgres } from '../../packages/postgres/src/index.js';
import { generateMCPTools } from '../../packages/mcp/src/index.js';
import { buildClientDescriptor } from '../../packages/descriptor/src/index.js';
import { elementFixture, elementGroup, elementInputs } from '../helpers/element-frames.js';

const sort = { terms: [{ field: 'key', order: 'ASC' }] };
const filter = 'AND:[{ANY:[{path:"lines",conditions:[{field:"quantity",operator:LTE,valuePath:"$parent.limit"}]}]}]';
const uri = process.env.SIMFINITY_MONGODB_URI;
const pgUri = process.env.SIMFINITY_POSTGRES_URI;
describe.skipIf(!uri || !pgUri)('embedded element public API parity', () => {
  const namespace = `element_api_${randomUUID().replaceAll('-', '')}`;
  const backends = [];
  let pool;
  beforeAll(async () => {
    await mongoose.connect(uri, { dbName: namespace });
    pool = new pg.Pool({ connectionString: pgUri });
    for (const batchedCollections of [false, true]) for (const engine of ['mongo', 'postgres']) {
      const schemaName = `${namespace}_${batchedCollections}`;
      const api = engine === 'mongo' ? createRuntime(createMongoAdapter({ batchedCollections })) : createPostgres({ pool, schema: schemaName, batchedCollections });
      const backend = { api, engine, schemaName, fixtures: [], records: [], batchedCollections };
      backends.push(backend);
      if (engine === 'mongo') api.preventCreatingCollection(true);
      for (const owned of [false, true]) {
        const index = Number(owned);
        const fixture = elementFixture(`ElementApi${index}${batchedCollections}`, owned);
        fixture.Provider.extensions.scope = { find: ({ args, context }) => { if (context.visibleOnly) args.visible = { value: true }; } };
        const ownScope = ({ args, context }) => { if (context.elementScope) args.AND = [...(args.AND ?? []), ...elementGroup().AND]; };
        fixture.Order.extensions.scope = { find: ownScope, aggregate: ownScope, get_by_id: ownScope };
        fixture.embedded.forEach((type) => api.addNoEndpointType(type));
        api.connect(null, fixture.Order, `item${index}`, `items${index}`);
        api.connect(null, fixture.Provider, `provider${index}`, `providers${index}`);
        api.connect(null, fixture.Batch, `batch${index}`, `batches${index}`);
        api.registerView(`matching${index}`, { type: fixture.Order, description: 'Orders with a quantity within their own limit', where: () => elementGroup().AND });
        backend.fixtures.push(fixture);
      }
      api.use(async ({ args, context }, next) => { if (context.cloneFilters && args.AND) args.AND = structuredClone(args.AND); await next(); });
      backend.schema = api.createSchema();
      if (engine === 'postgres') await api.initializeDatabase();
      else for (const { model } of api.getRegistrations()) if (model) await model.createCollection();
      for (const [index, fixture] of backend.fixtures.entries()) {
        const batch = await api.getModel(fixture.Batch).create({ key: 'batch' });
        await api.getModel(fixture.Batch).create({ key: 'empty' });
        const ids = {};
        for (const input of elementInputs()) {
          const record = await api.getModel(fixture.Order).create({ ...input, batchKey: batch.id ?? batch._id });
          ids[input.key] = String(record.id ?? record._id);
        }
        for (const [key, visible, limit, quantity] of [['p1', false, 100, 6], ['p2', true, 5, 3], ['p3', false, 100, null]]) {
          const provider = await api.getModel(fixture.Provider).create({ key, visible, limit });
          await api.getModel(fixture.Order).create({ key, suite: 'scopes', providerKey: provider.id ?? provider._id, lines: [{ quantity, ...(index ? { providerKey: provider.id ?? provider._id } : {}) }] });
        }
        backend.records.push(ids);
      }
    }
  }, 30000);
  afterAll(async () => {
    if (mongoose.connection.readyState) { try { await mongoose.connection.db.dropDatabase(); } finally { await mongoose.disconnect(); } }
    if (pool) { try { for (const schema of new Set(backends.filter((item) => item.engine === 'postgres').map((item) => item.schemaName))) await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`); } finally { await pool.end(); } }
  });
  const run = async (backend, source, context = {}, variableValues) => {
    const result = await graphql({ schema: backend.schema, source, contextValue: context, variableValues });
    expect(result.errors, `${backend.engine}, batching=${backend.batchedCollections}: ${JSON.stringify(result.errors)}`).toBeUndefined();
    return JSON.parse(JSON.stringify(result.data));
  };
  for (const index of [0, 1]) {
    it(`lists/counts/pages without trimming returned embedded arrays (${index})`, async () => {
      for (const b of backends) {
        const context = {};
        expect(await run(b, `{items${index}(suite:{value:"base"},${filter},sort:{terms:[{field:"key",order:ASC}]},pagination:{page:2,size:1,count:true}){key lines{quantity}}}`, context))
          .toEqual({ [`items${index}`]: [{ key: 'b', lines: [{ quantity: 3 }, { quantity: 12 }] }] });
        expect(context.count).toBe(3);
      }
    });
    it(`uses nested structural parents and same-element conditions (${index})`, async () => {
      for (const b of backends) {
        expect(await run(b, `{items${index}(suite:{value:"nested"},AND:[{ANY:[{path:"shipping.lines",ALL:[{path:"bundles",conditions:[{field:"quantity",operator:LTE,valuePath:"$parent.limit"}]}]}]}],sort:{terms:[{field:"key",order:ASC}]}){key}}`))
          .toEqual({ [`items${index}`]: [{ key: 'n1' }, { key: 'n3' }] });
        expect(await run(b, `{items${index}(suite:{value:"correlation"},AND:[{ANY:[{path:"lines",conditions:[{field:"sku",value:"A"},{field:"quantity",operator:LTE,valuePath:"$parent.limit"}]}]}]){key}}`))
          .toEqual({ [`items${index}`]: [{ key: 'x2' }] });
      }
    });
    it(`filters selected collection arguments in each child root (${index})`, async () => {
      for (const b of backends) expect(await run(b, `{batches${index}(sort:{terms:[{field:"key",order:ASC}]}){key orders(suite:{value:"base"},${filter},sort:{terms:[{field:"key",order:ASC}]},pagination:{page:2,size:1}){key lines{quantity}}}}`))
        .toEqual({ [`batches${index}`]: [{ key: 'batch', orders: [{ key: 'b', lines: [{ quantity: 3 }, { quantity: 12 }] }] }, { key: 'empty', orders: [] }] });
    });
    it(`shares view/count/MCP semantics and preserves middleware copies (${index})`, async () => {
      for (const b of backends) {
        const context = { cloneFilters: true };
        expect(await run(b, `{matching${index}(suite:{value:"base"},sort:{terms:[{field:"key",order:ASC}]},pagination:{page:1,size:1,count:true}){key}}`, context))
          .toEqual({ [`matching${index}`]: [{ key: 'a' }] });
        expect(context.count).toBe(3);
        const { callTool } = generateMCPTools(b.schema, { context: {} });
        const result = await callTool(`items${index}`, { suite: { value: 'base' }, ...elementGroup(), sort, pagination: { page: 1, size: 2, count: true } });
        expect(result.isError, JSON.stringify(result)).toBe(false);
        expect(result.structuredContent[`items${index}`].map((row) => row.key)).toEqual(['a', 'b']);
        expect(result.structuredContent.totalCount).toBe(3);
      }
    });
    it(`preserves aggregate facts and registered aggregate collection rows (${index})`, async () => {
      for (const b of backends) {
        expect(await run(b, `{items${index}_aggregate(suite:{value:"base"},${filter},aggregation:{groupId:"suite",facts:[{operation:SUM,path:"amount",factName:"total"}]}){groupId facts}}`))
          .toEqual({ [`items${index}_aggregate`]: [{ groupId: 'base', facts: { total: 3 } }] });
        const data = await run(b, `{batches${index}_aggregate(AND:[{conditions:[{field:"orders.suite",value:"base"},{field:"orders.lines.quantity",operator:LTE,valuePath:"orders.limit"}]}],aggregation:{groupId:"orders.key",facts:[{operation:SUM,path:"orders.amount",factName:"total"}]}){groupId facts}}`);
        expect(data[`batches${index}_aggregate`]).toEqual(['a', 'b', 'k'].map((groupId) => ({ groupId, facts: { total: 1 } })));
      }
    });
    it(`applies scopes to parent references and trusted scopes to record reads (${index})`, async () => {
      for (const b of backends) {
        const source = `{items${index}(suite:{value:"scopes"},AND:[{ANY:[{path:"lines",conditions:[{field:"quantity",operator:LTE,valuePath:"$parent.provider.limit"}]}]}],sort:{terms:[{field:"key",order:ASC}]}){key}}`;
        expect(await run(b, source, { visibleOnly: true, cloneFilters: true })).toEqual({ [`items${index}`]: [{ key: 'p2' }] });
        expect(await run(b, source)).toEqual({ [`items${index}`]: [{ key: 'p1' }, { key: 'p2' }] });
        expect(await run(b, `{items${index}(suite:{value:"base"},sort:{terms:[{field:"key",order:ASC}]}){key}}`, { elementScope: true }))
          .toEqual({ [`items${index}`]: ['a', 'b', 'k'].map((key) => ({ key })) });
        expect(await run(b, `query($id:ID!){item${index}(id:$id){key}}`, { elementScope: true }, { id: b.records[index].a })).toEqual({ [`item${index}`]: { key: 'a' } });
        const hidden = await graphql({ schema: b.schema, source: `query($id:ID!){item${index}(id:$id){key}}`, contextValue: { elementScope: true }, variableValues: { id: b.records[index].c } });
        expect(hidden.errors).toBeUndefined();
        expect(hidden.data?.[`item${index}`]).toBeNull();
      }
    });
    it(`rejects root, selection-owner and entity-crossing parents (${index})`, async () => {
      for (const b of backends) for (const source of [
        `{items${index}(limit:{valuePath:"$parent.limit"}){key}}`,
        `{batches${index}{orders(limit:{valuePath:"$parent.limit"}){key}}}`,
        `{items${index}(AND:[{ANY:[{path:"provider",conditions:[{field:"limit",valuePath:"$parent.limit"}]}]}]){key}}`,
        `{items${index}(AND:[{ANY:[{path:"lines",conditions:[{field:"quantity",valuePath:"$root.limit"}]}]}]){key}}`,
      ]) {
        const result = await graphql({ schema: b.schema, source, contextValue: {} });
        expect(result.errors?.[0]?.extensions?.code, JSON.stringify(result)).toBe('INVALID_FILTER_PATH');
      }
    });
  }
  it('keeps the descriptor format and exposes no embedded selection arguments', () => {
    for (const b of backends) {
      const descriptor = buildClientDescriptor(b.schema);
      expect(descriptor.formatVersion).toBe(1);
      for (const name of ['QLFilter', 'QLTypeFilter', 'QLFilterCondition']) expect(descriptor.types[name].fields.find((field) => field.name === 'valuePath').type).toBe('String');
      for (const fixture of b.fixtures) expect(b.schema.getType(fixture.Order.name).getFields().lines.args).toEqual([]);
    }
  });
});
