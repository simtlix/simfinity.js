import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import mongoose from 'mongoose';
import {
  GraphQLBoolean, GraphQLEnumType, GraphQLFloat, GraphQLID, GraphQLInt, GraphQLList, GraphQLObjectType,
  GraphQLScalarType, GraphQLString,
} from 'graphql';
import { markStoredIdentity } from '@simtlix/simfinity-core/internal/relation-storage';
import { createMongoQueries } from '../packages/mongodb/src/mongo/queries.js';
import { createMongoAdapter } from '../packages/mongodb/src/index.js';

const Kind = new GraphQLEnumType({ name: 'ComparisonMongoKind', values: { LOW: { value: 1 }, HIGH: { value: 2 } } });
const DateTime = new GraphQLScalarType({ name: 'DateTime' });
const Dims = new GraphQLObjectType({
  name: 'ComparisonMongoDims',
  fields: { width: { type: GraphQLInt }, height: { type: GraphQLInt }, tags: { type: new GraphQLList(GraphQLString) } },
});
const Shop = new GraphQLObjectType({
  name: 'ComparisonMongoShop',
  fields: () => ({
    id: { type: GraphQLID }, min: { type: GraphQLInt }, max: { type: GraphQLFloat }, visible: { type: GraphQLBoolean },
    name: { type: GraphQLString }, needle: { type: GraphQLString },
    products: { type: new GraphQLList(Product), extensions: { relation: { embedded: false, connectionField: 'shop' } } },
  }),
});
const Review = new GraphQLObjectType({
  name: 'ComparisonMongoReview',
  fields: () => ({
    id: { type: GraphQLID }, rating: { type: GraphQLInt }, maxRating: { type: GraphQLInt },
    name: { type: GraphQLString }, needle: { type: GraphQLString },
    product: { type: Product, extensions: { relation: { embedded: false } } },
    shop: { type: Shop, extensions: { relation: { embedded: false } } },
    visible: { type: GraphQLBoolean },
    replies: { type: new GraphQLList(Reply), extensions: { relation: { embedded: false, connectionField: 'review' } } },
  }),
});
const Reply = new GraphQLObjectType({
  name: 'ComparisonMongoReply',
  fields: () => ({
    id: { type: GraphQLID }, rating: { type: GraphQLInt },
    review: { type: Review, extensions: { relation: { embedded: false } } },
  }),
});
const Product = new GraphQLObjectType({
  name: 'ComparisonMongoProduct',
  fields: () => ({
    id: { type: GraphQLID }, stock: { type: GraphQLInt }, reorder: { type: GraphQLFloat },
    name: { type: GraphQLString }, needle: { type: GraphQLString }, tags: { type: new GraphQLList(GraphQLString) },
    active: { type: GraphQLBoolean }, enabled: { type: GraphQLBoolean },
    kind: { type: Kind }, state: { type: Kind }, due: { type: DateTime }, started: { type: DateTime }, dueDates: { type: new GraphQLList(DateTime) },
    shop: { type: Shop, extensions: { relation: { embedded: false } } },
    otherShop: { type: Shop, extensions: { relation: { embedded: false } } },
    dims: { type: Dims, extensions: { relation: { embedded: true } } },
    lines: { type: new GraphQLList(Dims), extensions: { relation: { embedded: true } } },
    reviews: { type: new GraphQLList(Review), extensions: { relation: { embedded: false, connectionField: 'product' } } },
    otherReviews: { type: new GraphQLList(Review), extensions: { relation: { embedded: false, connectionField: 'product' } } },
  }),
});
for (const type of [Product, Shop, Review, Reply]) markStoredIdentity(type);
const { ObjectId, Mixed } = mongoose.Schema.Types;
const productSchema = new mongoose.Schema({
  stock: Number, reorder: Number, name: String, needle: String, tags: [String], active: Boolean, enabled: Boolean,
  kind: Number, state: Mixed, due: Date, started: Date, shop: ObjectId, otherShop: ObjectId,
  dims: { width: Number, height: Number, tags: [String] }, lines: [{ width: Number, height: Number }],
});
const models = new Map([
  [Product, { collection: { collectionName: 'comparison_products' }, schema: productSchema }],
  [Shop, { collection: { collectionName: 'comparison_shops' }, schema: new mongoose.Schema({ min: Number, max: Number, visible: Boolean }) }],
  [Review, { collection: { collectionName: 'comparison_reviews' }, schema: new mongoose.Schema({ product: ObjectId, shop: ObjectId, rating: Number, maxRating: Number, visible: Boolean }) }],
  [Reply, { collection: { collectionName: 'comparison_replies' }, schema: new mongoose.Schema({ review: ObjectId, rating: Number }) }],
]);
const queriesFor = (map = models, registrations = [{ gqltype: Product, stateMachine: {} }]) => createMongoQueries({
  getModel: (type) => map.get(type), getRegistrations: () => registrations,
});
const queries = queriesFor();
const comparison = (field, operator, valuePath, extra = {}) => ({ AND: [{ conditions: [{ field, operator, valuePath, ...extra }] }] });
const matchOf = (pipeline) => pipeline.find((stage) => stage.$match)?.$match;
const reject = async (promise, code) => expect(promise).rejects.toMatchObject({ extensions: { code } });

describe('MongoDB field comparison compilation', () => {
  test('declares the feature and emits a field expression instead of casting an omitted literal', async () => {
    expect(createMongoAdapter().queryFeatures.valuePath).toBe(true);
    const pipeline = await queries.buildQuery({ stock: { operator: 'LTE', valuePath: 'reorder' } }, Product);
    expect(matchOf(pipeline)).toHaveProperty('$expr');
    expect(JSON.stringify(matchOf(pipeline))).toContain('$stock');
    expect(JSON.stringify(matchOf(pipeline))).toContain('$reorder');
  });

  test('keeps relation term operands relative to the relation target and group operands relative to their root', async () => {
    const terms = await queries.buildQuery({ shop: { terms: [{ path: 'min', operator: 'LT', valuePath: 'max' }] } }, Product);
    expect(JSON.stringify(matchOf(terms))).toContain('$__sf_l0.min');
    expect(JSON.stringify(matchOf(terms))).toContain('$__sf_l0.max');
    const group = await queries.buildQuery(comparison('shop.min', 'LT', 'reorder'), Product);
    expect(JSON.stringify(matchOf(group))).toContain('$reorder');
  });

  test('uses isolated scoped joins for both operand paths and rejects incomplete metadata', async () => {
    const marker = { id: 'comparison', scopes: { shop: { visible: { value: true } }, otherShop: null } };
    const pipeline = await queries.buildQuery(comparison('shop.min', 'LT', 'otherShop.max', { __scope: marker }), Product);
    const joins = pipeline.filter((stage) => stage.$lookup).map((stage) => stage.$lookup);
    expect(joins).toHaveLength(2);
    expect(joins[0].pipeline).toContainEqual({ $match: { visible: true } });
    await reject(queries.buildQuery(comparison('shop.min', 'LT', 'otherShop.max', { __scope: { scopes: { shop: null } } }), Product), 'DETACHED_CLIENT_FILTER');
  });

  test('binds one collection witness and allocates outer reference values after their joins', async () => {
    const same = await queries.buildQuery(comparison('reviews.rating', 'LT', 'reviews.maxRating'), Product);
    expect(same.filter((stage) => stage.$lookup)).toHaveLength(1);
    const frame = same.find((stage) => stage.$lookup).$lookup;
    expect(JSON.stringify(frame.pipeline)).toContain('$rating');
    expect(JSON.stringify(frame.pipeline)).toContain('$maxRating');
    const outer = await queries.buildQuery(comparison('reviews.rating', 'LT', 'shop.min'), Product);
    const lookups = outer.filter((stage) => stage.$lookup).map((stage) => stage.$lookup);
    expect(lookups[0].from).toBe('comparison_shops');
    expect(lookups[1].from).toBe('comparison_reviews');
    expect(Object.values(lookups[1].let)).toContain('$__sf_l0.min');
    expect(JSON.stringify(lookups[1].pipeline)).toContain('$$');
  });

  test('keeps aggregate J operands on the same joined row', async () => {
    const pipeline = await queries.buildAggregationQuery(comparison('reviews.rating', 'LT', 'reviews.maxRating'), Product, {
      groupId: 'reviews.id', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }],
    });
    expect(pipeline.filter((stage) => stage.$lookup)).toHaveLength(1);
    expect(JSON.stringify(matchOf(pipeline))).toContain('$__sf_l0.rating');
    expect(JSON.stringify(matchOf(pipeline))).toContain('$__sf_l0.maxRating');
  });

  test('rejects incompatible physical identity representations', async () => {
    const stringShop = { collection: { collectionName: 'comparison_string_shops' }, schema: new mongoose.Schema({ _id: String, min: Number, max: Number }) };
    await reject(queriesFor(new Map([...models, [Shop, stringShop]])).buildQuery(comparison('id', 'EQ', 'shop.id'), Product), 'INVALID_FILTER_VALUE');
  });

  test('rejects enum storage whose casting aliases distinct members', async () => {
    const enumProduct = { ...models.get(Product), schema: new mongoose.Schema({ kind: Boolean, state: Mixed }) };
    await reject(queriesFor(new Map([...models, [Product, enumProduct]])).buildQuery(comparison('kind', 'EQ', 'state'), Product), 'UNSUPPORTED_QUERY');
  });

  test.each([
    ['stock', 'LT', 'tags', 'INVALID_FILTER_PATH'],
    ['tags', 'LIKE', 'name', 'INVALID_FILTER_OPERATOR'],
    ['stock', 'IN', 'reorder', 'INVALID_FILTER_OPERATOR'],
    ['stock', 'EQ', 'name', 'INVALID_FILTER_VALUE'],
    ['lines.width', 'LT', 'stock', 'UNSUPPORTED_QUERY'],
    ['stock', 'LT', 'reviews.rating', 'INVALID_FILTER_PATH'],
    ['reviews.rating', 'LT', 'otherReviews.rating', 'INVALID_FILTER_PATH'],
  ])('rejects %s %s %s with %s', async (field, operator, valuePath, code) => {
    await reject(queries.buildQuery(comparison(field, operator, valuePath), Product), code);
  });
});

describe('MongoDB ordered String comparisons and command collation', () => {
  const modelWithCollation = (type, collation) => {
    const existing = models.get(type);
    const schema = existing.schema.clone();
    schema.options.collation = collation;
    return { ...existing, schema };
  };
  const withRootCollation = (collation) => queriesFor(new Map([...models, [Product, modelWithCollation(Product, collation)]]));

  test.each(['LT', 'LTE', 'GT', 'GTE'])('compiles %s on String operands without consulting command collation', async (operator) => {
    const supplied = withRootCollation({ locale: 'en', strength: 2 });
    const input = comparison('name', operator, 'needle');
    const plain = await queries.buildQuery(input, Product);
    expect(await supplied.buildQuery(input, Product)).toEqual(plain);
    expect(await supplied.buildFilterGroupMatch(input.AND[0], Product, [], {})).toEqual(matchOf(plain));
    const aggregation = { groupId: 'id', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }] };
    expect(await supplied.buildAggregationQuery(input, Product, aggregation))
      .toEqual(await queries.buildAggregationQuery(input, Product, aggregation));
  });

  test('allows ordered Strings with explicit simple collation and leaves literal collation alone', async () => {
    const simple = withRootCollation({ locale: 'simple' });
    expect(matchOf(await simple.buildQuery(comparison('name', 'LT', 'needle'), Product))).toHaveProperty('$expr');
    const collated = withRootCollation({ locale: 'en', strength: 2 });
    expect(matchOf(await collated.buildQuery({ name: { operator: 'LT', value: 'a' } }, Product))).toEqual({ name: { $lt: 'a' } });
    for (const operator of ['EQ', 'NE', 'LIKE', 'STARTS_WITH', 'ENDS_WITH']) {
      expect(matchOf(await collated.buildQuery(comparison('name', operator, 'needle'), Product))).toHaveProperty('$expr');
    }
    expect(matchOf(await collated.buildQuery(comparison('tags', 'EQ', 'needle'), Product))).toHaveProperty('$expr');
    expect(matchOf(await collated.buildQuery(comparison('kind', 'EQ', 'state'), Product))).toHaveProperty('$expr');
  });

  test('compiles scopes and outer operands with any model collation', async () => {
    const collated = withRootCollation({ locale: 'en', strength: 2 });
    const inputs = [
      comparison('reviews.name', 'LT', 'needle'),
      comparison('stock', 'LT', 'shop.min', {
        __scope: { id: 'comparison', scopes: { shop: { name: { operator: 'LT', valuePath: 'needle' } } } },
      }),
      { AND: [{ ANY: [{ path: 'reviews', conditions: [{
        field: 'rating', operator: 'LT', valuePath: 'shop.min',
        __scope: { id: 'nested-comparison', scopes: { shop: { name: { operator: 'LT', valuePath: 'needle' } } } },
      }] }] }] },
    ];
    for (const input of inputs) {
      expect(await collated.buildQuery(input, Product)).toEqual(await queries.buildQuery(input, Product));
    }
  });

  test('compiles ordered Strings with an offline supplied model and no collation metadata', async () => {
    const isolated = new mongoose.Mongoose();
    const model = isolated.model('ComparisonOfflineCollation', productSchema.clone());
    const supplied = queriesFor(new Map([...models, [Product, model]]));
    expect(await supplied.buildQuery(comparison('name', 'LT', 'needle'), Product))
      .toEqual(await queries.buildQuery(comparison('name', 'LT', 'needle'), Product));
  });
});

describe.each([
  ['replica set', process.env.SIMFINITY_MONGODB_URI],
  ['standalone', process.env.SIMFINITY_STANDALONE_MONGODB_URI],
])('MongoDB comparison results on a %s', (_backend, uri) => {
  describe.skipIf(!uri)('stored rows', () => {
    let connection;
    let collection;
    const id = (suffix) => new mongoose.Types.ObjectId(`0000000000000000000000${suffix}`);
    beforeAll(async () => {
      connection = await mongoose.createConnection(uri, { dbName: `field_comparisons_${randomUUID().replaceAll('-', '')}` }).asPromise();
      collection = connection.collection('comparison_products');
      await connection.dropDatabase();
      await collection.insertMany([
        { _id: id('01'), stock: 1, reorder: 2, name: 'A😀.$', needle: '😀.', tags: ['😀.', null], kind: 1, state: 'LOW', due: new Date('2030-01-01'), started: new Date('2029-01-01'), shop: id('11') },
        { _id: id('02'), stock: 3, reorder: 2, name: '', needle: '', tags: [], kind: 2, state: 'LOW', shop: id('12') },
        { _id: id('03'), stock: null, reorder: null, name: null, needle: null, tags: null, kind: null, state: null },
        { _id: id('04'), name: 'ab', needle: 'longer', tags: ['x'], shop: id('11') },
        { _id: id('05'), stock: 2, reorder: null, name: 'A😀.$', needle: '.$', tags: ['.$'] },
      ]);
      await connection.collection('comparison_shops').insertMany([
        { _id: id('11'), min: 2, max: 5, visible: true }, { _id: id('12'), min: 10, max: 20, visible: false },
      ]);
      await connection.collection('comparison_reviews').insertMany([
        { _id: id('21'), product: id('01'), rating: 1, maxRating: 2, visible: true },
        { _id: id('22'), product: id('01'), rating: 8, maxRating: 1, visible: true },
        { _id: id('23'), product: id('02'), rating: 3, maxRating: 2, visible: false },
        { _id: id('24'), product: id('03'), rating: null },
      ]);
      await connection.collection('comparison_replies').insertMany([{ _id: id('31'), review: id('21'), rating: 0 }]);
    });
    afterAll(async () => { if (connection) { await connection.dropDatabase(); await connection.close(); } });
    const keys = async (input) => (await collection.aggregate(await queries.buildQuery(input, Product)).toArray()).map((row) => row._id.toString().slice(-2)).sort();

    test('normalizes both scalar nulls, complements EQ, and guards ordered nulls', async () => {
      expect(await keys(comparison('stock', 'LT', 'reorder'))).toEqual(['01']);
      expect(await keys(comparison('stock', 'EQ', 'reorder'))).toEqual(['03', '04']);
      expect(await keys(comparison('stock', 'NE', 'reorder'))).toEqual(['01', '02', '05']);
      expect(await keys(comparison('stock', 'GT', 'reorder'))).toEqual(['02']);
    });

    test('uses null-safe scalar-list membership and its complement', async () => {
      expect(await keys(comparison('tags', 'EQ', 'needle'))).toEqual(['01', '03', '05']);
      expect(await keys(comparison('tags', 'NE', 'needle'))).toEqual(['02', '04']);
    });

    test('compares literal Unicode text with safe null and shorter-string guards', async () => {
      expect(await keys(comparison('name', 'LIKE', 'needle'))).toEqual(['01', '02', '05']);
      expect(await keys(comparison('name', 'STARTS_WITH', 'needle'))).toEqual(['02']);
      expect(await keys(comparison('name', 'ENDS_WITH', 'needle'))).toEqual(['02', '05']);
    });

    test('normalizes state names and enum internal values to semantic members', async () => {
      expect(await keys(comparison('kind', 'EQ', 'state'))).toEqual(['01', '03', '04', '05']);
      expect(await keys(comparison('due', 'GT', 'started'))).toEqual(['01']);
    });

    test('reads scoped missing references as null and preserves one root per witness', async () => {
      const marker = { id: 'comparison', scopes: { shop: { visible: { value: true } } } };
      expect(await keys(comparison('stock', 'LT', 'shop.min', { __scope: marker }))).toEqual(['01']);
      expect(await keys(comparison('reviews.rating', 'LT', 'reviews.maxRating'))).toEqual(['01']);
      expect(await keys(comparison('reviews.rating', 'LT', 'stock'))).toEqual([]);
      expect(await keys(comparison('reviews.rating', 'LT', 'shop.min'))).toEqual(['01', '02']);
    });

    test('passes outer bindings through nested frames without alias capture', async () => {
      expect(await keys(comparison('reviews.replies.rating', 'LT', 'stock'))).toEqual(['01']);
    });

    test('keeps ALL and NONE two-valued when a comparison has null operands', async () => {
      const group = { path: 'reviews', conditions: [{ field: 'rating', operator: 'LT', valuePath: 'maxRating' }] };
      expect(await keys({ AND: [{ ANY: [group] }] })).toEqual(['01']);
      expect(await keys({ AND: [{ ALL: [group] }] })).toEqual(['04', '05']);
      expect(await keys({ AND: [{ NONE: [group] }] })).toEqual(['02', '03', '04', '05']);
    });

    test('keeps child scopes and outer scopes in their owning pipelines', async () => {
      expect(await keys(comparison('reviews.rating', 'LTE', 'stock', { __scope: { id: 'comparison', scopes: { reviews: { visible: { value: true } } } } })))
        .toEqual(['01']);
      expect(await keys(comparison('reviews.rating', 'LT', 'shop.min', { __scope: { id: 'comparison', scopes: { reviews: null, shop: { visible: { value: true } } } } })))
        .toEqual(['01']);
    });

    test('keeps aggregate J row identities when a reference before J is scoped', async () => {
      const marker = { id: 'comparison', scopes: { shop: { visible: { value: true } }, 'shop.products': null } };
      const input = comparison('shop.products.stock', 'LT', 'shop.products.reorder', { __scope: marker });
      const pipeline = await queries.buildAggregationQuery(input, Product, {
        groupId: 'shop.products.id', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }],
      });
      const rows = await collection.aggregate(pipeline).toArray();
      expect(rows.map((row) => [row.groupId.toString().slice(-2), row.facts.n])).toEqual([['01', 2]]);
      const hidden = await collection.aggregate(await queries.buildAggregationQuery({
        stock: { value: 3 },
        ...comparison('shop.products.stock', 'EQ', 'shop.products.reorder', { __scope: marker }),
      }, Product, {
        groupId: 'shop.products.id', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }],
      })).toArray();
      // Both operands become null when the scoped Shop is hidden, while J still owns its row.
      expect(hidden.map((row) => [row.groupId.toString().slice(-2), row.facts.n])).toEqual([['02', 1]]);
    });

    test('checks scoped references before an aggregate anchor without multiplying J rows', async () => {
      const marker = { id: 'comparison', scopes: { shop: { visible: { value: true } }, 'shop.products': null, 'shop.products.reviews': null } };
      const input = comparison('shop.products.reviews.rating', 'LTE', 'stock', { __scope: marker });
      const pipeline = await queries.buildAggregationQuery(input, Product, {
        groupId: 'shop.products.id', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }],
      });
      const rows = await collection.aggregate(pipeline).toArray();
      expect(rows.map((row) => [row.groupId.toString().slice(-2), row.facts.n])).toEqual([['01', 1]]);
    });

    test('batched child comparisons reproduce individual reads including outer bindings', async () => {
      const model = connection.model('ComparisonMongoStoredProduct', productSchema.clone(), 'comparison_products');
      const registered = new Map([...models, [Product, model]]);
      const adapter = createMongoAdapter({ batchedCollections: true });
      adapter.bind({ getModel: (type) => registered.get(type), getRegistrations: () => [{ gqltype: Product, model }] });
      const args = comparison('reviews.rating', 'LT', 'shop.min');
      const parents = [id('11'), id('12')];
      const singles = await Promise.all(parents.map((parent) => adapter.findChildren(model, Product, 'shop', parent, args)));
      const batched = await adapter.findChildrenBatch(model, Product, 'shop', parents, args);
      expect(batched.map((rows) => rows.map((row) => row._id.toString()))).toEqual(singles.map((rows) => rows.map((row) => row._id.toString())));
      expect(batched.map((rows) => rows.map((row) => row._id.toString().slice(-2)))).toEqual([['01'], ['02']]);
    });

    test('normalizes supplied temporal strings and scalar-list items to instants', async () => {
      const temporalRows = connection.collection('comparison_temporals');
      await temporalRows.insertOne({ due: '2030-01-01T00:00:00.000Z', started: '2029-12-31T21:00:00.000-03:00', dueDates: ['2029-12-31T21:00:00.000-03:00'] });
      const supplied = queriesFor(new Map([...models, [Product, {
        collection: { collectionName: 'comparison_temporals' }, schema: new mongoose.Schema({ due: String, started: String, dueDates: [String] }),
      }]]));
      for (const field of ['due', 'dueDates']) {
        const rows = await temporalRows.aggregate(await supplied.buildQuery(comparison(field, 'EQ', 'started'), Product)).toArray();
        expect(rows).toHaveLength(1);
      }
    });

    test('compares supplied String identities through their actual model paths', async () => {
      const products = await connection.createCollection('comparison_string_products', { collation: { locale: 'en', strength: 2 } });
      await products.insertMany([{ _id: 'p1', shop: 'p1' }, { _id: 'p2', shop: 's2' }, { _id: 'A', shop: 'a' }]);
      await connection.collection('comparison_string_shops').insertMany([{ _id: 'p1' }, { _id: 's2' }, { _id: 'a' }]);
      const supplied = queriesFor(new Map([...models,
        [Product, { collection: { collectionName: 'comparison_string_products' }, schema: new mongoose.Schema({ _id: String, shop: String }) }],
        [Shop, { collection: { collectionName: 'comparison_string_shops' }, schema: new mongoose.Schema({ _id: String }) }],
      ]));
      const rows = await products.aggregate(await supplied.buildQuery(comparison('id', 'EQ', 'shop.id'), Product)).toArray();
      expect(rows.map((row) => row._id)).toEqual(['p1']);
    });

    test('normalizes case-distinct enum values and dollar text under a supplied collation', async () => {
      const enumType = new GraphQLEnumType({ name: 'ComparisonMongoCollatedKind', values: { UPPER: { value: 'A' }, LOWER: { value: 'a' }, DOLLAR: { value: '$A' } } });
      const type = new GraphQLObjectType({ name: 'ComparisonMongoCollatedEnum', fields: { kind: { type: enumType }, state: { type: enumType } } });
      const rows = await connection.createCollection('comparison_collated_enums', { collation: { locale: 'en', strength: 2 } });
      await rows.insertMany([{ kind: 'A', state: 'LOWER' }, { kind: 'a', state: 'LOWER' }, { kind: '$A', state: 'DOLLAR' }]);
      const supplied = queriesFor(new Map([[type, {
        collection: { collectionName: 'comparison_collated_enums' },
        schema: new mongoose.Schema({ kind: String, state: String }, { collation: { locale: 'en', strength: 2 } }),
      }]]), [{ gqltype: type, stateMachine: {} }]);
      const matches = await rows.aggregate(await supplied.buildQuery(comparison('kind', 'EQ', 'state'), type)).toArray();
      expect(matches.map((row) => row.kind)).toEqual(['a', '$A']);
    });

    test('keeps exact strings, list membership and suffixes case-sensitive under a supplied collation', async () => {
      const collatedRows = await connection.createCollection('comparison_collated', { collation: { locale: 'en', strength: 2 } });
      await collatedRows.insertMany([
        { name: 'A', needle: 'a', tags: ['A'] }, { name: 'Ba', needle: 'a', tags: ['a'] },
      ]);
      const supplied = queriesFor(new Map([...models, [Product, {
        collection: { collectionName: 'comparison_collated' },
        schema: new mongoose.Schema({ name: String, needle: String, tags: [String] }, { collation: { locale: 'en', strength: 2 } }),
      }]]));
      for (const [field, operator, want] of [['name', 'EQ', []], ['tags', 'EQ', ['Ba']], ['name', 'ENDS_WITH', ['Ba']]]) {
        const rows = await collatedRows.aggregate(await supplied.buildQuery(comparison(field, operator, 'needle'), Product)).toArray();
        expect(rows.map((row) => row.name)).toEqual(want);
      }
    });

    test.each(['collection', 'schema', 'override', 'remove-null', 'remove-undefined'])('uses effective %s collation across adapter reads while equality stays exact', async (source) => {
      const collation = { locale: 'en', strength: 2 };
      const native = ['collection', 'remove-null', 'remove-undefined'].includes(source);
      const overridden = source === 'override' || source.startsWith('remove-');
      const collectionName = `comparison_collation_${source.replaceAll('-', '_')}`;
      await connection.createCollection(collectionName, { collation: native ? collation : { locale: 'simple' } });
      const schema = productSchema.clone();
      if (source !== 'collection') schema.options.collation = source === 'schema' ? collation : { locale: 'simple' };
      const model = connection.model(`ComparisonCollation_${source}`, schema, collectionName);
      if (overridden) {
        const aggregate = model.aggregate;
        model.aggregate = function aggregateWithCollation(...args) {
          return aggregate.apply(this, args).collation(source === 'override' ? collation : (source === 'remove-null' ? null : undefined));
        };
      }
      await model.collection.insertMany([
        { _id: id('41'), name: 'A', needle: 'a', stock: 1, shop: id('11') },
        { _id: id('42'), name: 'Z', needle: 'a', stock: 1, shop: id('12') },
        { _id: id('43'), name: null, needle: 'a', shop: id('11') },
        { _id: id('44'), name: 'A', shop: id('12') },
      ]);
      const registered = new Map([...models, [Product, model]]);
      const adapter = createMongoAdapter({ batchedCollections: true });
      adapter.bind({ getModel: (type) => registered.get(type), getRegistrations: () => [{ gqltype: Product, model }] });
      const ids = (rows) => rows.map((row) => row._id.toString().slice(-2)).sort();
      const aggregation = { groupId: 'id', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }] };
      for (const [operator, want] of [
        ['LT', []], ['LTE', ['41']], ['GT', ['42']], ['GTE', ['41', '42']],
        ['EQ', []], ['NE', ['41', '42', '43', '44']],
      ]) {
        const args = comparison('name', operator, 'needle');
        expect(ids(await adapter.find(model, Product, args))).toEqual(want);
        expect(await adapter.count(model, Product, args)).toBe(want.length);
        const grouped = await adapter.aggregate(model, Product, { ...args, aggregation });
        expect(grouped.map((row) => row.groupId.toString().slice(-2)).sort()).toEqual(want);
        expect(grouped.every((row) => row.facts.n === 1)).toBe(true);
        const parents = [id('11'), id('12')];
        const singles = await Promise.all(parents.map((parent) => adapter.findChildren(model, Product, 'shop', parent, args)));
        expect(singles.map(ids)).toEqual([want.filter((key) => ['41', '43'].includes(key)), want.filter((key) => ['42', '44'].includes(key))]);
        if (!overridden) {
          expect((await adapter.findChildrenBatch(model, Product, 'shop', parents, args)).map(ids)).toEqual(singles.map(ids));
        }
      }
      // A literal and a field comparison in the same command retain their own equality semantics.
      expect(ids(await adapter.find(model, Product, { name: { value: 'a' }, ...comparison('name', 'LTE', 'needle') }))).toEqual(['41']);
    });

    test.each([
      ['case', { locale: 'en', strength: 2 }, 'A', 'a', ['LTE', 'GTE']],
      ['accent', { locale: 'en', strength: 1 }, 'é', 'e', ['LTE', 'GTE']],
      ['numeric', { locale: 'en', numericOrdering: true }, '10', '2', ['GT', 'GTE']],
      ['simple', { locale: 'simple' }, 'A', 'a', ['LT', 'LTE']],
    ])('respects %s ordering and exact equality when executing the same pipeline', async (label, collation, name, needle, matches) => {
      const rows = await connection.createCollection(`comparison_order_${label}`, { collation });
      await rows.insertOne({ name, needle });
      for (const operator of ['LT', 'LTE', 'GT', 'GTE', 'EQ', 'NE']) {
        const pipeline = await queries.buildQuery(comparison('name', operator, 'needle'), Product);
        expect(await rows.aggregate(pipeline).toArray()).toHaveLength(matches.includes(operator) || operator === 'NE' ? 1 : 0);
      }
    });

    test('lets a declared simple command override a native non-simple default without changing options', async () => {
      await connection.createCollection('comparison_declared_simple', { collation: { locale: 'en', strength: 2 } });
      const schema = productSchema.clone();
      schema.options.collation = { locale: 'simple' };
      const model = connection.model('ComparisonDeclaredSimple', schema, 'comparison_declared_simple');
      await model.collection.insertMany([
        { name: 'A', needle: 'a', shop: id('11') }, { name: 'Z', needle: 'a', shop: id('12') },
      ]);
      const registered = new Map([...models, [Product, model]]);
      const supplied = queriesFor(registered);
      const args = comparison('name', 'LT', 'needle');
      const pipeline = await supplied.buildQuery(args, Product);
      // Raw-driver execution uses its own options, independently of the Mongoose schema.
      const direct = await model.collection.aggregate(pipeline, { collation: { locale: 'simple' } }).toArray();
      expect(direct.map((row) => row.name)).toEqual(['A', 'Z']);
      expect(await model.collection.aggregate(pipeline).toArray()).toEqual([]);
      const adapter = createMongoAdapter({ batchedCollections: true });
      adapter.bind({ getModel: (type) => registered.get(type), getRegistrations: () => [{ gqltype: Product, model }] });
      expect((await adapter.find(model, Product, args)).map((row) => row.name)).toEqual(['A', 'Z']);
      expect(await adapter.count(model, Product, args)).toBe(2);
      const children = await adapter.findChildrenBatch(model, Product, 'shop', [id('11'), id('12')], args);
      expect(children.map((rows) => rows.map((row) => row.name))).toEqual([['A'], ['Z']]);
      expect(schema.options.collation).toEqual({ locale: 'simple' });
    });

    test.each(['simple', 'collated'])('uses the %s root collation in scopes, outer operands and aggregate joins', async (mode) => {
      const simple = { locale: 'simple' };
      const collated = { locale: 'en', strength: 2 };
      const rootName = `comparison_scope_root_${mode}`;
      const shopName = `comparison_scope_shop_${mode}`;
      const reviewName = `comparison_scope_review_${mode}`;
      await connection.createCollection(rootName, { collation: mode === 'simple' ? simple : collated });
      await connection.createCollection(shopName, { collation: mode === 'simple' ? collated : simple });
      await connection.createCollection(reviewName, { collation: mode === 'simple' ? collated : simple });
      const shopSchema = new mongoose.Schema({ name: String, needle: String, min: Number }, { collation: mode === 'simple' ? collated : simple });
      const shopModel = connection.model(`ComparisonScopeShop_${mode}`, shopSchema, shopName);
      const model = connection.model(`ComparisonScopeRoot_${mode}`, productSchema.clone(), rootName);
      const reviewModel = connection.model(`ComparisonScopeReview_${mode}`, new mongoose.Schema({ product: ObjectId, shop: ObjectId, rating: Number, name: String, needle: String }), reviewName);
      await model.collection.insertOne({ _id: id('01'), stock: 1, needle: 'a', shop: id('11') });
      await shopModel.collection.insertOne({ _id: id('11'), name: 'Z', needle: 'a', min: 2 });
      await reviewModel.collection.insertOne({ _id: id('21'), product: id('01'), shop: id('11'), rating: 1, name: 'A', needle: 'a' });
      const registered = new Map([...models, [Product, model], [Shop, shopModel], [Review, reviewModel]]);
      const supplied = queriesFor(registered);
      const inputs = [
        comparison('stock', 'LT', 'shop.min', {
          __scope: { id: 'comparison', scopes: { shop: { name: { operator: 'LT', valuePath: 'needle' } } } },
        }),
        comparison('reviews.name', 'LT', 'needle'),
        { AND: [{ ANY: [{ path: 'reviews', conditions: [{
          field: 'rating', operator: 'LT', valuePath: 'shop.min',
          __scope: { id: 'nested-comparison', scopes: { shop: { name: { operator: 'LT', valuePath: 'needle' } } } },
        }] }] }] },
      ];
      for (const input of inputs) {
        const rows = await model.aggregate(await supplied.buildQuery(input, Product));
        expect(rows.map((row) => row._id.toString().slice(-2))).toEqual(mode === 'simple' ? ['01'] : []);
      }
      const aggregate = await model.aggregate(await supplied.buildAggregationQuery(comparison('reviews.name', 'LT', 'reviews.needle'), Product, {
        groupId: 'reviews.id', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }],
      }));
      expect(aggregate.map((row) => row.groupId.toString().slice(-2))).toEqual(mode === 'simple' ? ['21'] : []);
    });

    test('compiles before collection creation and uses its eventual collation without metadata reads', async () => {
      const schema = productSchema.clone();
      schema.options.autoCreate = false;
      schema.options.autoIndex = false;
      const model = connection.model('ComparisonChangedCollation', schema, 'comparison_changed_collation');
      const supplied = queriesFor(new Map([...models, [Product, model]]));
      const args = comparison('name', 'LTE', 'needle');
      const pipeline = await supplied.buildQuery(args, Product);
      await connection.createCollection('comparison_changed_collation', { collation: { locale: 'en', strength: 2 } });
      await model.collection.insertOne({ name: 'A', needle: 'a' });
      // Make metadata access fail so this also covers applications without listCollections privileges.
      const original = connection.db.listCollections;
      connection.db.listCollections = () => { throw new Error('Collection metadata is unavailable'); };
      try {
        expect(await supplied.buildQuery(args, Product)).toEqual(pipeline);
        expect((await model.aggregate(pipeline)).map((row) => row.name)).toEqual(['A']);
      } finally {
        connection.db.listCollections = original;
      }
    });
  });
});
