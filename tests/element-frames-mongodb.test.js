import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { GraphQLBoolean, GraphQLID, GraphQLInt, GraphQLList, GraphQLObjectType, GraphQLString } from 'graphql';
import { markStoredIdentity } from '@simtlix/simfinity-core/internal/relation-storage';
import { createMongoAdapter } from '../packages/mongodb/src/mongo/adapter.js';
import { createMongoQueries } from '../packages/mongodb/src/mongo/queries.js';

const embedded = { relation: { embedded: true } };
const reference = { relation: { embedded: false, connectionField: 'providerKey' } };
const Bundle = new GraphQLObjectType({ name: 'ElementMongoBundle', fields: () => ({ quantity: { type: GraphQLInt }, provider: { type: Provider, extensions: reference } }) });
const Line = new GraphQLObjectType({ name: 'ElementMongoLine', fields: () => ({
  id: { type: GraphQLID }, quantity: { type: GraphQLInt }, limit: { type: GraphQLInt }, sku: { type: GraphQLString }, tags: { type: new GraphQLList(GraphQLString) },
  provider: { type: Provider, extensions: reference }, bundles: { type: new GraphQLList(Bundle), extensions: embedded },
}) });
const Shipping = new GraphQLObjectType({ name: 'ElementMongoShipping', fields: {
  limit: { type: GraphQLInt }, lines: { type: new GraphQLList(Line), extensions: embedded },
} });
const Provider = new GraphQLObjectType({ name: 'ElementMongoProvider', fields: () => ({
  id: { type: GraphQLID }, limit: { type: GraphQLInt }, visible: { type: GraphQLBoolean },
  lines: { type: new GraphQLList(Line), extensions: embedded },
  orders: { type: new GraphQLList(Order), extensions: { relation: { embedded: false, connectionField: 'provider' } } },
}) });
const Batch = new GraphQLObjectType({ name: 'ElementMongoBatch', fields: () => ({
  id: { type: GraphQLID }, orders: { type: new GraphQLList(Order), extensions: { relation: { embedded: false, connectionField: 'batch' } } },
}) });
const Order = new GraphQLObjectType({ name: 'ElementMongoOrder', fields: {
  id: { type: GraphQLID }, suite: { type: GraphQLString }, limit: { type: GraphQLInt }, amount: { type: GraphQLInt },
  provider: { type: Provider, extensions: reference }, shipping: { type: Shipping, extensions: embedded },
  batch: { type: Batch, extensions: { relation: { embedded: false, connectionField: 'batchKey' } } },
  lines: { type: new GraphQLList(Line), extensions: embedded },
} });
[Order, Provider, Batch].forEach(markStoredIdentity);
const lineSchema = new mongoose.Schema({ id: String, quantity: Number, limit: Number, sku: String, tags: [String], providerKey: String,
  bundles: [new mongoose.Schema({ quantity: Number, providerKey: String }, { _id: false })] }, { _id: false });
const group = (quantifier, path, conditions, extra = {}) => ({ AND: [{ [quantifier]: [{ path, conditions, ...extra }] }] });
const comparison = (valuePath = '$parent.limit', operator = 'LTE', extra = {}) => ({ field: 'quantity', operator, valuePath, ...extra });
const visible = { visible: { value: true } };

for (const [label, uri] of [['replica', process.env.SIMFINITY_MONGODB_URI], ['standalone', process.env.SIMFINITY_STANDALONE_MONGODB_URI]]) {
  describe.skipIf(!uri)(`MongoDB embedded frames (${label})`, () => {
    let connection;
    let orders;
    let queries;
    let batches;
    let adapter;
    let orderModel;
    beforeAll(async () => {
      connection = await mongoose.createConnection(uri, { dbName: `simfinity_elements_${randomUUID().replaceAll('-', '')}` }).asPromise();
      const OrderModel = connection.model(Order.name, new mongoose.Schema({
        _id: String, suite: String, limit: Number, amount: Number, providerKey: String, batchKey: String,
        lines: [lineSchema], shipping: new mongoose.Schema({ limit: Number, lines: [lineSchema] }, { _id: false }),
      }));
      const ProviderModel = connection.model(Provider.name, new mongoose.Schema({ _id: String, limit: Number, visible: Boolean, lines: [lineSchema] }));
      const BatchModel = connection.model(Batch.name, new mongoose.Schema({ _id: String }));
      batches = BatchModel.collection;
      await batches.insertOne({ _id: 'batch' });
      const models = new Map([[Order, OrderModel], [Provider, ProviderModel], [Batch, BatchModel]]);
      queries = createMongoQueries({ getModel: (type) => models.get(type), getRegistrations: () => [] });
      adapter = createMongoAdapter({ batchedCollections: true });
      adapter.bind({ getModel: (type) => models.get(type), getRegistrations: () => [] });
      orderModel = OrderModel;
      orders = OrderModel.collection;
      await ProviderModel.collection.insertMany([
        { _id: 'visible', limit: 5, visible: true, lines: [{ quantity: 3 }] },
        { _id: 'hidden', limit: 100, visible: false, lines: [{ quantity: 200 }] },
      ]);
      const base = [
        { _id: 'a', lines: [{ quantity: 3 }, { quantity: 8 }] },
        { _id: 'b', lines: [{ quantity: 3 }, { quantity: 12 }] },
        { _id: 'c', lines: [{ quantity: 12 }] }, { _id: 'd', lines: [{ quantity: null }] },
        { _id: 'e', lines: [] }, { _id: 'f', lines: null }, { _id: 'g' }, { _id: 'h', lines: [null] },
        { _id: 'i', lines: [{}] }, { _id: 'j', limit: null, lines: [{ quantity: 3 }] },
        { _id: 'k', lines: [{ quantity: 3 }, { quantity: 3 }] },
      ].map((record) => ({ suite: 'base', limit: 10, amount: 1, batchKey: 'batch', ...record }));
      await orders.insertMany([...base,
        { _id: 'n1', suite: 'nested', limit: 9, shipping: { limit: 5, lines: [
          { quantity: 4, limit: 3, bundles: [{ quantity: 2, providerKey: 'hidden' }, { quantity: 4, providerKey: 'visible' }] },
          { quantity: 1, limit: 5, bundles: [{ quantity: 4, providerKey: 'visible' }] },
        ] } },
        { _id: 'n2', suite: 'nested', limit: 9, shipping: { limit: 5, lines: [{ quantity: 8, limit: 3, bundles: [{ quantity: 4, providerKey: 'hidden' }] }] } },
        { _id: 'n3', suite: 'nested', limit: 9, shipping: { limit: 5, lines: [{ quantity: 1, limit: 5, bundles: [{ quantity: 4, providerKey: 'visible' }, { quantity: 4, providerKey: 'visible' }] }] } },
        { _id: 'x1', suite: 'correlation', limit: 10, lines: [{ id: 'x1', sku: 'A', quantity: 12, tags: ['VIP', 'promo'] }, { id: 'second', sku: 'B', quantity: 3, tags: [] }] },
        { _id: 'x2', suite: 'correlation', limit: 10, lines: [{ id: 'unrelated', sku: 'A', quantity: 3, tags: ['VIP'] }] },
        { _id: 'p1', suite: 'scopes', amount: 20, providerKey: 'hidden', lines: [{ quantity: 6, providerKey: 'hidden' }] },
        { _id: 'p2', suite: 'scopes', amount: 2, providerKey: 'visible', lines: [{ quantity: 3, providerKey: 'visible' }] },
        { _id: 'p3', suite: 'scopes', amount: 30, providerKey: 'hidden', lines: [{ quantity: null, providerKey: 'hidden' }] },
      ]);
    });
    afterAll(async () => { if (connection) { try { await connection.dropDatabase(); } finally { await connection.close(); } } });
    const keys = async (args, suite = 'base') => {
      const pipeline = await queries.buildQuery({ suite: { value: suite }, ...args }, Order);
      return (await orders.aggregate(pipeline).toArray()).map((row) => row._id).sort();
    };

    it.each([
      ['ANY', ['a', 'b', 'k']], ['ALL', ['a', 'e', 'f', 'g', 'h', 'k']],
      ['NONE', ['c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']],
    ])('evaluates %s with null, missing, empty and duplicate elements', async (quantifier, expected) => {
      expect(await keys(group(quantifier, 'lines', [comparison()]))).toEqual(expected);
    });

    it('keeps full-body same-element correlation and legacy independent literals', async () => {
      expect(await keys(group('ANY', 'lines', [{ field: 'sku', value: 'A' }, comparison()]), 'correlation')).toEqual(['x2']);
      expect(await keys({ AND: [{ conditions: [{ field: 'lines.sku', value: 'A' }, { field: 'lines.quantity', operator: 'LTE', value: 10 }] }] }, 'correlation')).toEqual(['x1', 'x2']);
    });

    it('reproduces individual child reads with element frames and per-parent paging', async () => {
      const args = { ...group('ANY', 'lines', [comparison()]), sort: { terms: [{ field: 'id', order: 'ASC' }] }, pagination: { page: 1, size: 2 } };
      const parents = ['batch', 'missing', 'batch'];
      const singles = await Promise.all(parents.map((id) => adapter.findChildren(orderModel, Order, 'batchKey', id, args, null)));
      const batched = await adapter.findChildrenBatch(orderModel, Order, 'batchKey', parents, args, { context: {} });
      const ids = (rows) => rows.map((row) => row._id);
      expect(batched.map(ids)).toEqual(singles.map(ids));
      expect(batched.map(ids)).toEqual([['a', 'b'], [], ['a', 'b']]);
    });

    it('counts single containers and retains the selected outer list element', async () => {
      expect(await keys(group('ALL', 'shipping.lines', [comparison()]), 'nested')).toEqual(['n1', 'n3']);
      expect(await keys(group('ALL', 'shipping.lines', [comparison('$parent.$parent.limit')]), 'nested')).toEqual(['n1', 'n2', 'n3']);
      expect(await keys(group('ANY', 'shipping.lines', [], { ALL: [{ path: 'bundles', conditions: [comparison()] }] }), 'nested')).toEqual(['n1', 'n3']);
      expect(await keys(group('ALL', 'shipping.lines', [], { ALL: [{ path: 'bundles', conditions: [comparison('$parent.$parent.$parent.limit')] }] }), 'nested')).toEqual(['n1', 'n2', 'n3']);
    });

    it('scopes references inside an element and maps hidden targets to null', async () => {
      const scoped = { __scope: { scopes: { provider: visible } } };
      expect(await keys(group('ANY', 'lines', [comparison('provider.limit', 'LTE', scoped)]), 'scopes')).toEqual(['p2']);
      expect(await keys(group('ANY', 'lines', [comparison('provider.limit')]), 'scopes')).toEqual(['p1', 'p2']);
      expect(await keys(group('ANY', 'lines', [comparison('provider.limit', 'EQ', scoped)]), 'scopes')).toEqual(['p3']);
    });

    it('scopes parent-only references separately from local references', async () => {
      const scoped = { __scope: { scopes: { '$parent.provider': visible } } };
      expect(await keys(group('ANY', 'lines', [comparison('$parent.provider.limit', 'LTE', scoped)]), 'scopes')).toEqual(['p2']);
      expect(await keys(group('ANY', 'lines', [comparison('$parent.provider.limit')]), 'scopes')).toEqual(['p1', 'p2']);
    });

    it('retains the scoped reference before an embedded frame', async () => {
      expect(await keys(group('ALL', 'provider.lines', [comparison()], { __scope: { scopes: { provider: visible } } }), 'scopes')).toEqual(['p1', 'p2', 'p3']);
      expect(await keys(group('ALL', 'provider.lines', [comparison()]), 'scopes')).toEqual(['p2']);
    });

    it('does not multiply root aggregate facts by matching elements', async () => {
      const pipeline = await queries.buildAggregationQuery({ suite: { value: 'base' }, ...group('ANY', 'lines', [comparison()]) }, Order,
        { groupId: 'suite', facts: [{ operation: 'SUM', path: 'amount', factName: 'total' }] });
      const rows = await orders.aggregate(pipeline).toArray();
      expect(rows.map((row) => [row.groupId, row.facts.total])).toEqual([['base', 3]]);
    });

    it('preserves the bound aggregate collection row below an element comparison', async () => {
      const input = { AND: [{ conditions: [{ field: 'orders.lines.quantity', operator: 'LTE', valuePath: 'orders.limit' }] }] };
      const pipeline = await queries.buildAggregationQuery(input, Batch,
        { groupId: 'orders.id', facts: [{ operation: 'SUM', path: 'orders.amount', factName: 'total' }] });
      const rows = await batches.aggregate(pipeline).toArray();
      expect(rows.map((row) => [row.groupId, row.facts.total]).sort()).toEqual([['a', 1], ['b', 1], ['k', 1]]);
    });

    it.each([
      ['ANY', ['a', 'b', 'c', 'd', 'i', 'j', 'k']],
      ['ALL', ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k']],
      ['NONE', ['e', 'f', 'g', 'h']],
    ])('keeps empty-body %s membership', async (quantifier, expected) => {
      expect(await keys(group(quantifier, 'lines', []))).toEqual(expected);
    });

    it('keeps implicit NE as the complement of existential EQ', async () => {
      expect(await keys({ AND: [{ conditions: [{ field: 'lines.quantity', operator: 'NE', valuePath: 'lines.limit' }] }] }))
        .toEqual(['a', 'b', 'c', 'e', 'f', 'g', 'h', 'j', 'k']);
      expect(await keys(group('ANY', 'lines', [comparison('limit', 'NE')]))).toEqual(['a', 'b', 'c', 'j', 'k']);
    });

    it('keeps missing single objects nullable when comparing with their container', async () => {
      expect(await keys({ shipping: { terms: [{ path: 'limit', valuePath: '$parent.limit' }] } })).toEqual(['j']);
    });

    it('executes a registered collection below an embedded element', async () => {
      expect(await keys(group('ANY', 'lines', [], { ANY: [{ path: 'provider.orders', conditions: [{ field: 'amount', operator: 'LTE', value: 10 }] }] }), 'scopes')).toEqual(['p2']);
    });

    it('isolates multiplying legacy prefixes inside an embedded frame', async () => {
      const conditions = [{ field: 'bundles.provider.orders.amount', operator: 'LTE', value: 10 }];
      expect(await keys(group('ANY', 'shipping.lines', conditions), 'nested')).toEqual(['n1', 'n3']);
      expect(await keys(group('ALL', 'shipping.lines', conditions), 'nested')).toEqual(['n1', 'n3']);
    });

    it('negates a whole element body instead of individual expanded reference rows', async () => {
      const conditions = [{ field: 'bundles.provider.limit', operator: 'LTE', value: 10 }];
      expect(await keys(group('ALL', 'shipping.lines', conditions), 'nested')).toEqual(['n1', 'n3']);
    });

    it('keeps supplied embedded String IDs when subdocument _id is disabled', async () => {
      expect(await keys(group('ANY', 'lines', [{ field: 'id', value: 'x1' }]), 'correlation')).toEqual(['x1']);
      expect(await keys(group('ANY', 'lines', [{ field: 'id', valuePath: '$parent.id' }]), 'correlation')).toEqual(['x1']);
    });

    it('applies scalar-list membership, case-insensitive literals and emptiness locally', async () => {
      expect(await keys(group('ANY', 'lines', [{ field: 'tags', operator: 'CONTAINS_ALL', value: ['VIP', 'promo'] }]), 'correlation')).toEqual(['x1']);
      expect(await keys(group('ANY', 'lines', [{ field: 'sku', operator: 'IIN', value: ['a'] }]), 'correlation')).toEqual(['x1', 'x2']);
      expect(await keys(group('ANY', 'lines', [{ field: 'tags', operator: 'IS_EMPTY' }]), 'correlation')).toEqual(['x1']);
    });
  });
}
