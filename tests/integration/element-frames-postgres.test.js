import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgres } from '../../packages/postgres/src/index.js';
import { describeModels } from '../../packages/core/src/metadata.js';
import { createQueryPlan } from '../../packages/core/src/query-plan.js';
import { compileChildrenQuery, compileQuery } from '../../packages/postgres/src/query/compiler.js';
import { describeDatabase } from '../../packages/postgres/src/schema/describe.js';
import { elementFixture, elementGroup, elementInputs } from '../helpers/element-frames.js';

for (const owned of [false, true]) describe.skipIf(!process.env.SIMFINITY_POSTGRES_URI)(`real PostgreSQL embedded frames (${owned ? 'owned' : 'JSONB'})`, () => {
  const fixture = elementFixture(`ElementReal${owned}`, owned);
  const namespace = `elements_${randomUUID().replaceAll('-', '')}`;
  const models = describeModels(fixture.registrations);
  const database = describeDatabase(fixture.registrations, { schema: namespace });
  let pool; let api; let batch;
  const execute = async (statement) => (await pool.query(statement.text, statement.values)).rows;
  const plan = (args, entity = fixture.Order.name, options) => createQueryPlan(models, entity, args, options);
  const keys = async (args, suite = 'base') => (await execute(compileQuery(models, database, plan({ suite: { value: suite }, ...args, sort: { terms: [{ field: 'key', order: 'ASC' }] } })))).map((row) => row.key);
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: process.env.SIMFINITY_POSTGRES_URI });
    api = createPostgres({ pool, schema: namespace });
    fixture.embedded.forEach((type) => api.addNoEndpointType(type));
    for (const { gqltype } of fixture.registrations) api.connect(null, gqltype, gqltype.name.toLowerCase(), `${gqltype.name.toLowerCase()}s`);
    api.createSchema();
    await api.initializeDatabase();
    batch = await api.getModel(fixture.Batch).create({ key: 'batch' });
    const providers = await Promise.all([
      { key: 'visible', limit: 5, visible: true, lines: [{ quantity: 3 }] },
      { key: 'hidden', limit: 100, visible: false, lines: [{ quantity: 200 }] },
    ].map((input) => api.getModel(fixture.Provider).create(input)));
    const [visible, hidden] = providers.map((record) => record.id);
    for (const input of elementInputs()) {
      if (owned) for (const line of input.shipping?.lines ?? []) for (const bundle of line.bundles ?? []) bundle.providerKey = bundle.quantity === 2 || input.key === 'n2' ? hidden : visible;
      await api.getModel(fixture.Order).create({ ...input, batchKey: batch.id });
    }
    for (const [key, amount, quantity, providerKey] of [['p1', 20, 6, hidden], ['p2', 2, 3, visible], ['p3', 30, null, hidden]]) {
      await api.getModel(fixture.Order).create({ key, suite: 'scopes', amount, providerKey, lines: [{ quantity, ...(owned ? { providerKey } : {}) }] });
    }
  }, 30000);
  afterAll(async () => { if (pool) { try { await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); } finally { await pool.end(); } } });
  it.each([['ANY', ['a', 'b', 'k']], ['ALL', ['a', 'e', 'f', 'g', 'h', 'k']], ['NONE', ['c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']]])('%s handles null/empty lists and duplicate objects', async (quantifier, expected) => {
    expect(await keys(elementGroup(quantifier))).toEqual(expected);
  });
  it.each([['ANY', ['a', 'b', 'c', 'd', 'i', 'j', 'k']], ['ALL', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k']], ['NONE', ['e', 'f', 'g', 'h']]])('empty %s body tests membership', async (quantifier, expected) => {
    expect(await keys(elementGroup(quantifier, 'lines', []))).toEqual(expected);
  });
  it('binds both conditions to the same element while preserving legacy literals', async () => {
    expect(await keys(elementGroup('ANY', 'lines', [{ field: 'sku', value: 'A' }, { field: 'quantity', operator: 'LTE', valuePath: '$parent.limit' }]), 'correlation')).toEqual(['x2']);
    expect(await keys({ AND: [{ conditions: [{ field: 'lines.sku', value: 'A' }, { field: 'lines.quantity', operator: 'LTE', value: 10 }] }] }, 'correlation')).toEqual(['x1', 'x2']);
  });
  it('retains the selected outer element and intermediate single containers', async () => {
    expect(await keys(elementGroup('ALL', 'shipping.lines'), 'nested')).toEqual(['n1', 'n3']);
    expect(await keys(elementGroup('ALL', 'shipping.lines', [{ field: 'quantity', operator: 'LTE', valuePath: '$parent.$parent.limit' }]), 'nested')).toEqual(['n1', 'n2', 'n3']);
    expect(await keys(elementGroup('ANY', 'shipping.lines', [], { ALL: [{ path: 'bundles', conditions: [{ field: 'quantity', operator: 'LTE', valuePath: '$parent.limit' }] }] }), 'nested')).toEqual(['n1', 'n3']);
  });
  it('uses null operands for absent single objects without requiring their existence', async () => {
    expect(await keys({ shipping: { terms: [{ path: 'limit', valuePath: '$parent.limit' }] } })).toEqual(['j']);
  });
  it('preserves local scalar-list operators and embedded IDs', async () => {
    expect(await keys(elementGroup('ANY', 'lines', [{ field: 'tags', operator: 'CONTAINS_ALL', value: ['VIP', 'promo'] }]), 'correlation')).toEqual(['x1']);
    expect(await keys(elementGroup('ANY', 'lines', [{ field: 'sku', operator: 'IIN', value: ['a'] }]), 'correlation')).toEqual(['x1', 'x2']);
    expect(await keys(elementGroup('ANY', 'lines', [{ field: 'id', valuePath: '$parent.key' }]), 'correlation')).toEqual(['x1']);
  });
  it('compares dates across JSONB/native layouts and enum internal values', async () => {
    expect(await keys(elementGroup('ANY', 'lines', [{ field: 'at', valuePath: '$parent.at' }]), 'typed')).toEqual(['t1']);
    expect(await keys(elementGroup('ANY', 'lines', [{ field: 'at', operator: 'LT', valuePath: '$parent.at' }]), 'typed')).toEqual(['t2']);
    expect(await keys(elementGroup('ANY', 'lines', [{ field: 'kind', valuePath: '$parent.kind' }]), 'typed')).toEqual(['t1']);
  });
  it('does not multiply root aggregate facts', async () => {
    const input = { suite: { value: 'base' }, ...elementGroup(), aggregation: { groupId: 'suite', facts: [{ operation: 'SUM', path: 'amount', factName: 'total' }] } };
    expect(await execute(compileQuery(models, database, plan(input, fixture.Order.name, { mode: 'aggregate' })))).toEqual([{ groupId: 'base', fact_0: '3' }]);
  });
  it('keeps an already-bound aggregate collection row', async () => {
    const input = { AND: [{ conditions: [{ field: 'orders.lines.quantity', operator: 'LTE', valuePath: 'orders.limit' }] }], aggregation: { groupId: 'orders.key', facts: [{ operation: 'SUM', path: 'orders.amount', factName: 'total' }] } };
    const rows = await execute(compileQuery(models, database, plan(input, fixture.Batch.name, { mode: 'aggregate' })));
    expect(rows.map((row) => [row.groupId, row.fact_0])).toEqual([['a', '1'], ['b', '1'], ['k', '1'], ['x1', '0'], ['x2', '0']]);
  });
  it('keeps implicit NE distinct from local ANY NE', async () => {
    expect(await keys({ AND: [{ conditions: [{ field: 'lines.quantity', operator: 'NE', valuePath: 'lines.limit' }] }] })).toEqual(['a', 'b', 'c', 'e', 'f', 'g', 'h', 'j', 'k']);
    expect(await keys(elementGroup('ANY', 'lines', [{ field: 'quantity', operator: 'NE', valuePath: 'limit' }]))).toEqual(['a', 'b', 'c', 'j', 'k']);
  });
  it('retains structural parents across owned and JSONB storage', async () => {
    expect(await keys(elementGroup('ANY', 'shipping.lines', [], { ANY: [{ path: 'metrics', conditions: [{ field: 'quantity', operator: 'LTE', valuePath: '$parent.limit' }] }] }), 'nested')).toEqual(['n1']);
  });
  it('applies target scopes to parent-only references and nullable hidden operands', async () => {
    const scope = { visible: { value: true } };
    const condition = { field: 'quantity', operator: 'LTE', valuePath: '$parent.provider.limit', __scope: { scopes: { '$parent.provider': scope } } };
    expect(await keys(elementGroup('ANY', 'lines', [condition]), 'scopes')).toEqual(['p2']);
    expect(await keys(elementGroup('ANY', 'lines', [{ ...condition, operator: 'EQ' }]), 'scopes')).toEqual(['p3']);
    expect(await keys(elementGroup('ANY', 'lines', [{ field: condition.field, operator: condition.operator, valuePath: condition.valuePath }]), 'scopes')).toEqual(['p1', 'p2']);
    const group = { path: 'provider.lines', conditions: [{ field: 'quantity', operator: 'LTE', valuePath: '$parent.limit' }], __scope: { scopes: { provider: scope } } };
    expect(await keys({ AND: [{ ALL: [group] }] }, 'scopes')).toEqual(['p1', 'p2', 'p3']);
    expect(await keys({ AND: [{ ALL: [{ path: group.path, conditions: group.conditions }] }] }, 'scopes')).toEqual(['p2']);
  });
  if (owned) {
    it('scopes references in an element and traverses a registered child collection', async () => {
      const scoped = { field: 'quantity', operator: 'LTE', valuePath: 'provider.limit', __scope: { scopes: { provider: { visible: { value: true } } } } };
      expect(await keys(elementGroup('ANY', 'lines', [scoped]), 'scopes')).toEqual(['p2']);
      expect(await keys(elementGroup('ANY', 'lines', [], { ANY: [{ path: 'provider.orders', conditions: [{ field: 'amount', operator: 'LTE', value: 10 }] }] }), 'scopes')).toEqual(['p2']);
    });
    it('negates the complete body when a reference prefix multiplies witnesses', async () => {
      for (const path of ['bundles.provider.limit', 'bundles.provider.orders.amount']) {
        expect(await keys(elementGroup('ALL', 'shipping.lines', [{ field: path, operator: 'LTE', value: 10 }]), 'nested')).toEqual(['n1', 'n3']);
      }
    });
  }

  it('reproduces each individual child page in a batch', async () => {
    const planned = plan({ ...elementGroup(), sort: { terms: [{ field: 'key', order: 'ASC' }] }, pagination: { page: 1, size: 2 } });
    const parents = [batch.id, randomUUID(), batch.id];
    const single = await Promise.all(parents.map((id) => execute(compileQuery(models, database, planned, { column: 'batchKey', id }))));
    const compiled = compileChildrenQuery(models, database, planned, { column: 'batchKey', ids: parents });
    const rows = await execute(compiled);
    const results = parents.map((_, index) => rows.filter((row) => row[compiled.parentColumn] === index + 1).map((row) => row.key));
    expect(results).toEqual(single.map((records) => records.map((row) => row.key)));
    expect(results).toEqual([['a', 'b'], [], ['a', 'b']]);
  });
});
