import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import mongoose from 'mongoose';
import { GraphQLID, GraphQLInt, GraphQLList, GraphQLObjectType, GraphQLString } from 'graphql';
import { createMongoAdapter, createRuntime } from '../../packages/mongodb/src/index.js';
import { createMongoQueries } from '../../packages/mongodb/src/mongo/queries.js';
import {
  REFERENCE_SHAPES, createReferenceEmptinessTypes, registerReferenceEmptinessTypes,
  readMongoEmptinessDocuments, writeMongoEmptinessDocuments,
} from '../helpers/query-emptiness.js';
import { COLLECTION_AGGREGATES, COLLECTION_ANCHOR_ROWS, COLLECTION_CASES, collectionOracle, seedCollectionFrames } from '../helpers/collection-frames.js';

const PAGE = [{ $skip: 0 }, { $limit: 100 }];
const condition = (field = 'reviews.rating', value = 4, operator = 'GTE') => ({ field, value, operator });
const args = (...conditions) => ({ AND: [{ conditions }] });
const exists = (alias, yes = true) => ({ [`${alias}.0`]: { $exists: yes } });
const lookup = (from, localField, foreignField, as, stages = []) => ({ $lookup: {
  from, localField, foreignField, pipeline: [...stages, { $limit: 1 }, { $project: { _id: 1 } }], as,
} });
const plain = (from, localField, as, extra = {}) => [
  { $lookup: { from, foreignField: '_id', localField, as, ...extra } },
  { $unwind: { path: `$${as}`, preserveNullAndEmptyArrays: true } },
];
const find = (stages, match, aliases) => [...stages, { $match: match }, ...PAGE, ...(aliases.length ? [{ $unset: aliases }] : [])];
const fixture = (prefix, offline = false) => {
  const adapter = createMongoAdapter({ batchedCollections: true, collectionBatchSize: 2 });
  const runtime = createRuntime(adapter);
  if (offline) runtime.preventCreatingCollection(true);
  const types = createReferenceEmptinessTypes(prefix, { backend: 'mongodb' });
  for (const { type } of Object.values(types.roots)) {
    for (const operation of ['find', 'aggregate', 'get_by_id']) {
      const original = type.extensions.scope[operation];
      type.extensions.scope[operation] = async (params) => { await original(params); await params.context?.trustedScope?.(params); };
    }
  }
  registerReferenceEmptinessTypes(runtime, types);
  const schema = runtime.createSchema();
  const queries = createMongoQueries({ getModel: (type) => runtime.getModel(type), getRegistrations: () => runtime.getRegistrations() });
  runtime.use(async (params, next) => { await params.context?.middleware?.(params); await next(); });
  return { adapter, runtime, types, schema, queries, model: (key) => runtime.getModel(types.roots[key].type) };
};

// A scoped single reference followed by an embedded-list vector reference. Fixed target IDs
// make the nonmatching target the first index candidate, exposing an incorrect vector LIMIT 1.
const vectorFixture = (prefix, offline = false) => {
  const Target = new GraphQLObjectType({ name: `${prefix}Target`, extensions: { scope: { find: ({ args: input, context }) => { if (context?.restrictVector) input.name = { value: 'good' }; } } }, fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
  const Line = new GraphQLObjectType({ name: `${prefix}Line`, fields: { shop: { type: Target, extensions: { relation: { connectionField: 'shop' } } } } });
  const Pro = new GraphQLObjectType({
    name: `${prefix}Pro`, extensions: { scope: { find: ({ args: input }) => { input.name = { value: 'admitted' }; } } },
    fields: { id: { type: GraphQLID }, name: { type: GraphQLString }, lines: { type: new GraphQLList(Line), extensions: { relation: { embedded: true } } } },
  });
  const Product = new GraphQLObjectType({ name: `${prefix}Product`, fields: { id: { type: GraphQLID }, pro: { type: Pro, extensions: { relation: { connectionField: 'pro' } } } } });
  const Root = new GraphQLObjectType({ name: `${prefix}Root`, fields: { id: { type: GraphQLID }, products: { type: new GraphQLList(Product), extensions: { relation: { connectionField: 'root' } } } } });
  const adapter = createMongoAdapter();
  const runtime = createRuntime(adapter);
  if (offline) runtime.preventCreatingCollection(true);
  runtime.addNoEndpointType(Line);
  for (const type of [Target, Pro, Product, Root]) runtime.connect(null, type, type.name.toLowerCase(), `${type.name.toLowerCase()}s`);
  const schema = runtime.createSchema();
  const queries = createMongoQueries({ getModel: (type) => runtime.getModel(type), getRegistrations: () => runtime.getRegistrations() });
  return { Root, Product, Pro, Target, runtime, adapter, queries, schema };
};

// Correction-round fixture: persisted generated models, with vector witnesses on children and
// before a collection. Separate target records distinguish complete-body correlation from
// independent predicates, and distinct prefix targets expose root multiplication.
const correctionFixture = (prefix) => {
  const scope = ({ args: input, context }) => {
    if (context?.hideFailingChild) input.visible = { value: 1 };
    if (context?.scopeWitness) input.AND = [{ conditions: [{ field: 'lines.shop.name', value: 'bad' }] }];
  };
  const Target = new GraphQLObjectType({ name: `${prefix}Target`, extensions: { scope: { find() {} } }, fields: () => ({
    id: { type: GraphQLID }, key: { type: GraphQLString }, name: { type: GraphQLString }, tone: { type: GraphQLString },
    children: { type: new GraphQLList(Leaf), extensions: { relation: { connectionField: 'shop' } } },
  }) });
  const Line = new GraphQLObjectType({ name: `${prefix}Line`, fields: { shop: { type: Target, extensions: { relation: { connectionField: 'shop' } } } } });
  const Pro = new GraphQLObjectType({ name: `${prefix}Pro`, extensions: { scope: { find: ({ args: input }) => { input.name = { value: 'admitted' }; } } }, fields: {
    id: { type: GraphQLID }, name: { type: GraphQLString }, lines: { type: new GraphQLList(Line), extensions: { relation: { embedded: true } } },
  } });
  const Child = new GraphQLObjectType({ name: `${prefix}Child`, extensions: { scope: { find: scope } }, fields: () => ({
    id: { type: GraphQLID }, key: { type: GraphQLString }, visible: { type: GraphQLInt },
    root: { type: Root, extensions: { relation: { connectionField: 'root' } } },
    pro: { type: Pro, extensions: { relation: { connectionField: 'pro' } } },
    lines: { type: new GraphQLList(Line), extensions: { relation: { embedded: true } } },
  }) });
  const Leaf = new GraphQLObjectType({ name: `${prefix}Leaf`, fields: {
    id: { type: GraphQLID }, name: { type: GraphQLString }, tone: { type: GraphQLString },
    shop: { type: Target, extensions: { relation: { connectionField: 'shop' } } },
  } });
  const Root = new GraphQLObjectType({ name: `${prefix}Root`, fields: {
    id: { type: GraphQLID }, key: { type: GraphQLString }, lines: { type: new GraphQLList(Line), extensions: { relation: { embedded: true } } },
    one: { type: Child, extensions: { relation: { connectionField: 'one' } } },
    children: { type: new GraphQLList(Child), extensions: { relation: { connectionField: 'root' } } },
  } });
  const adapter = createMongoAdapter();
  const runtime = createRuntime(adapter);
  runtime.addNoEndpointType(Line);
  for (const type of [Target, Pro, Child, Leaf, Root]) runtime.connect(null, type, type.name.toLowerCase(), `${type.name.toLowerCase()}s`);
  const schema = runtime.createSchema();
  const model = (type) => runtime.getModel(type);
  const id = (n) => new mongoose.Types.ObjectId(n.toString(16).padStart(24, '0'));
  const seed = async () => {
    await model(Target).collection.insertMany([
      { _id: id(1), key: 'bad', name: 'bad', tone: 'red' }, { _id: id(2), key: 'good', name: 'good', tone: 'blue' },
      { _id: id(3), key: 'goodRed', name: 'good', tone: 'red' }, { _id: id(4), key: 'null', name: null, tone: null },
      { _id: id(5), key: 'left', name: 'left' }, { _id: id(6), key: 'right', name: 'right' }, { _id: id(7), key: 'zero', name: 'zero' },
    ]);
    await model(Pro).collection.insertMany([
      { _id: id(20), name: 'admitted', lines: [{ shop: id(1) }, { shop: id(2) }] },
      { _id: id(21), name: 'denied', lines: [{ shop: id(2) }] },
    ]);
    await model(Root).collection.insertMany([
      ...['mixed', 'fail', 'both', 'empty', 'missing', 'null', 'split', 'compound', 'scopedGood', 'scopedBad'].map((key, index) => ({ _id: id(100 + index), key, ...(key === 'mixed' ? { one: id(200) } : key === 'fail' ? { one: id(201) } : {}) })),
      { _id: id(120), key: 'prefixZero', lines: [{ shop: id(7) }] },
      { _id: id(121), key: 'prefixOne', lines: [{ shop: id(5) }, { shop: id(7) }] },
      { _id: id(122), key: 'prefixTwo', lines: [{ shop: id(5) }, { shop: id(6) }] },
      { _id: id(123), key: 'prefixMissing', lines: [{}] }, { _id: id(124), key: 'prefixEmpty', lines: [] },
    ]);
    const mixed = [{ shop: id(1) }, { shop: id(2) }];
    await model(Child).collection.insertMany([
      { _id: id(200), key: 'mixed', root: id(100), visible: 1, lines: mixed },
      { _id: id(201), key: 'fail', root: id(101), visible: 0, lines: [{ shop: id(1) }] },
      { _id: id(202), key: 'bothGood', root: id(102), visible: 1, lines: mixed }, { _id: id(203), key: 'bothBad', root: id(102), visible: 0, lines: [{ shop: id(1) }] },
      { _id: id(204), key: 'missing', root: id(104), visible: 1, lines: [{}] },
      { _id: id(205), key: 'null', root: id(105), visible: 1, lines: [{ shop: id(4) }] },
      { _id: id(206), key: 'split', root: id(106), visible: 1, lines: mixed },
      { _id: id(207), key: 'compound', root: id(107), visible: 1, lines: [{ shop: id(3) }, { shop: id(2) }] },
      { _id: id(208), key: 'scopedGood', root: id(108), visible: 1, pro: id(20) }, { _id: id(209), key: 'scopedBad', root: id(109), visible: 1, pro: id(21) },
    ]);
    await model(Leaf).collection.insertMany([{ _id: id(300), name: 'good', tone: 'blue', shop: id(5) }, { _id: id(301), name: 'good', tone: 'red', shop: id(6) }]);
  };
  const run = (input, context = {}, type = Root) => schema.getQueryType().getFields()[`${type.name.toLowerCase()}s`].resolve(null, structuredClone(input), context);
  const keys = async (input, context, type) => (await run(input, context, type)).map((row) => row.key).sort();
  return { Root, Child, Target, adapter, model, seed, run, keys };
};

describe('MongoDB collection frame compiled forms', () => {
  const f = fixture('QcfPlan', true);
  const build = (input, root = 'product', count) => f.adapter.buildQuery(input, f.types.roots[root].type, count);
  const from = (type) => `QcfPlan${type}`;
  const review = (alias = '__sf_q0', stages = [{ $match: { rating: { $gte: 4 } } }], local = '_id') => lookup(from('Review'), local, 'productId', alias, stages);

  test('shorthand, explicit group and quantified filter compile to the same single frame', async () => {
    const expected = find([review()], exists('__sf_q0'), ['__sf_q0']);
    for (const input of [args(condition()), { reviews: { terms: [{ path: 'rating', value: 4, operator: 'GTE' }] } },
      { AND: [{ ANY: [{ path: 'reviews', conditions: [condition('rating')] }] }] },
      { reviews: { quantifier: 'ANY', terms: [{ path: 'rating', value: 4, operator: 'GTE' }] } }]) {
      expect(await build(input)).toStrictEqual(expected);
    }
  });
  test.each([
    { quantifier: 'NONE', terms: [{ operator: 'IS_NOT_EMPTY' }] },
    { quantifier: 'ANY', terms: [{ operator: 'EQ', value: 1 }] },
    { quantifier: 'ANY', terms: [{ path: '' }] },
  ])('pin: direct buildQuery rejects a path-less quantified term: %j', async (reviews) => {
    await expect(build({ reviews })).rejects.toMatchObject({
      message: 'Relationship terms require a path',
      extensions: { code: 'INVALID_FILTER_PATH', status: 400 },
    });
  });
  test.each(['ANY', 'NONE', 'ALL'])('%s predicates and where:null forms', async (quantifier) => {
    const match = { rating: { $gte: 4 } };
    const body = quantifier === 'ALL' ? { $nor: [match] } : match;
    expect(await build({ AND: [{ [quantifier]: [{ path: 'reviews', conditions: [condition('rating')] }] }] }))
      .toStrictEqual(find([review('__sf_q0', [{ $match: body }])], exists('__sf_q0', quantifier === 'ANY'), ['__sf_q0']));
    const empty = await build({ reviews: { quantifier } });
    expect(empty).toStrictEqual(quantifier === 'ALL' ? [{ $match: {} }, ...PAGE] : find([review('__sf_q0', [])], exists('__sf_q0', quantifier === 'ANY'), ['__sf_q0']));
  });
  test.each(['ANY', 'NONE', 'ALL'])('%s puts its element scope outside the body and its negation', async (quantifier) => {
    const group = { path: 'reviews', conditions: [condition('rating')], __scope: { scopes: { reviews: { author: { operator: 'NE', value: 'hidden' } } } } };
    const body = { rating: { $gte: 4 } };
    expect(await build({ AND: [{ [quantifier]: [group] }] })).toStrictEqual(find([
      review('__sf_q0', [{ $match: { author: { $ne: 'hidden' } } }, { $match: quantifier === 'ALL' ? { $nor: [body] } : body }]),
    ], exists('__sf_q0', quantifier === 'ANY'), ['__sf_q0']));
  });
  test('OR branches and an ALL-alone sibling keep independent frames and compact alias order', async () => {
    expect(await build({ OR: [args(condition()).AND[0], args(condition('reviews.author', 'x', 'EQ')).AND[0]] })).toStrictEqual(find([
      review(), review('__sf_q1', [{ $match: { author: 'x' } }]),
    ], { $or: [exists('__sf_q0'), exists('__sf_q1')] }, ['__sf_q0', '__sf_q1']));
    expect(await build({ AND: [{ ALL: [{ path: 'shop' }] }, args(condition()).AND[0]] })).toStrictEqual(find([
      review(),
    ], { $and: [{}, exists('__sf_q0')] }, ['__sf_q0']));
  });
  test('ALL alone remains a true OR branch', async () => {
    expect(await build({ OR: [{ ALL: [{ path: 'reviews' }] }, { conditions: [condition('name', 'x', 'EQ')] }] }))
      .toStrictEqual([{ $match: { $or: [{}, { name: 'x' }] } }, ...PAGE]);
  });
  test('pin: vacuous vector-prefix ALL preserves the next emptiness sibling alias', async () => {
    const pipeline = await build({ AND: [
      { ALL: [{ path: 'olines.shop.products', __implicit: true }] },
      { conditions: [{ field: 'reviews', operator: 'IS_EMPTY' }] },
    ] });
    expect(pipeline.filter((stage) => stage.$lookup).map((stage) => stage.$lookup.as)).toEqual(['__sf_q0']);
    expect(pipeline.at(-1)).toEqual({ $unset: ['__sf_q0'] });
  });
  test('nested frames share serials and keep lookups inside the child pipeline', async () => {
    const inner = review('__sf_q1', [{ $match: { rating: { $gte: 5 } } }]);
    expect(await build(args(condition('products.reviews.rating', 5)), 'shop')).toStrictEqual(find([
      lookup(from('Product'), '_id', 'shop', '__sf_q0', [inner, { $match: exists('__sf_q1') }]),
    ], exists('__sf_q0'), ['__sf_q0']));
  });
  test('references before frames use plain and scoped crossings with an inner collection guard', async () => {
    const group = { path: 'shop.products', conditions: [condition('stock', 5, 'EQ')] };
    const body = [{ $match: { shop: { $ne: null } } }, { $match: { stock: 5 } }];
    expect(await build({ AND: [{ ANY: [group] }] })).toStrictEqual(find([
      ...plain(from('Shop'), 'shop', '__sf_l0'), lookup(from('Product'), '__sf_l0._id', 'shop', '__sf_q0', body),
    ], exists('__sf_q0'), ['__sf_l0', '__sf_q0']));
    const marked = structuredClone(group);
    marked.__scope = { scopes: { shop: { name: { operator: 'NE', value: 'S2' } }, 'shop.products': null } };
    expect(await build({ AND: [{ ANY: [marked] }] })).toStrictEqual(find([
      ...plain(from('Shop'), 'shop', '__sf_j0', { pipeline: [{ $match: { name: { $ne: 'S2' } } }, { $limit: 1 }] }),
      lookup(from('Product'), '__sf_j0._id', 'shop', '__sf_q0', body),
    ], exists('__sf_q0'), ['__sf_j0', '__sf_q0']));
  });
  test('references inside frames use their own scoped/plain aliases, and reference frames have no guard', async () => {
    for (const scoped of [false, true]) {
      const c = condition('pro.name', 'P2', 'EQ');
      if (scoped) c.__scope = { scopes: { pro: { name: { operator: 'NE', value: 'P2' } } } };
      const alias = scoped ? '__sf_j0' : '__sf_l0';
      const inner = [...plain(from('Pro'), 'pro', alias, scoped ? { pipeline: [{ $match: { name: { $ne: 'P2' } } }, { $limit: 1 }] } : {}), { $match: { [`${alias}.name`]: 'P2' } }];
      expect(await build({ AND: [{ ANY: [{ path: 'products', conditions: [c] }] }] }, 'shop'))
        .toStrictEqual(find([lookup(from('Product'), '_id', 'shop', '__sf_q0', inner)], exists('__sf_q0'), ['__sf_q0']));
    }
    expect(await build({ shop: { quantifier: 'ANY' } })).toStrictEqual(find([lookup(from('Shop'), 'shop', '_id', '__sf_q0')], exists('__sf_q0'), ['__sf_q0']));
  });
  test('frames never share across groups and preserve compilation order and 2b forms', async () => {
    const input = { AND: [{ ANY: [{ path: 'reviews' }], ALL: [{ path: 'reviews', conditions: [condition('rating')] }], NONE: [{ path: 'shop' }] }, { conditions: [condition('reviews', undefined, 'IS_EMPTY')] }] };
    delete input.AND[1].conditions[0].value;
    const pipeline = await build(input);
    expect(pipeline.filter((s) => s.$lookup).map((s) => s.$lookup.as)).toEqual(['__sf_q0', '__sf_q1', '__sf_q2', '__sf_q3']);
    expect(pipeline.at(-1)).toEqual({ $unset: ['__sf_q0', '__sf_q1', '__sf_q2', '__sf_q3'] });
    expect(pipeline[3]).toStrictEqual(review('__sf_q3', []));
    expect(pipeline[4].$match.$and.at(-1)).toEqual({ $or: [{ _id: null }, exists('__sf_q3', false)] });
  });
  test('aggregate J context survives AND recursion and anchored frames use a guarded legacy alias', async () => {
    const expression = { groupId: 'reviews.author', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }] };
    const pipeline = await f.queries.buildAggregationQuery(args(condition('reviews.rating', 5)), f.types.Product, expression);
    expect(pipeline.slice(0, 3)).toStrictEqual([
      { $lookup: { from: from('Review'), foreignField: 'productId', localField: '_id', as: '__sf_l0' } },
      { $unwind: { path: '$__sf_l0', preserveNullAndEmptyArrays: true } }, { $match: { '__sf_l0.rating': { $gte: 5 } } },
    ]);
    const anchored = await f.queries.buildAggregationQuery(args(condition('products.reviews.rating', 1)), f.types.Shop, { ...expression, groupId: 'products.key' });
    expect(anchored.slice(0, 4)).toStrictEqual([
      { $lookup: { from: from('Product'), foreignField: 'shop', localField: '_id', as: '__sf_l0' } },
      { $unwind: { path: '$__sf_l0', preserveNullAndEmptyArrays: true } },
      review('__sf_q0', [{ $match: { productId: { $ne: null } } }, { $match: { rating: { $gte: 1 } } }], '__sf_l0._id'),
      { $match: exists('__sf_q0') },
    ]);
    const through = await f.queries.buildAggregationQuery({}, f.types.Product, { ...expression, groupId: 'shop.products.key' });
    expect(through[2].$lookup).toMatchObject({ localField: '__sf_l0._id', foreignField: 'shop', pipeline: [{ $match: { shop: { $ne: null } } }] });
  });
  test('pin: J-only aggregate shorthand keeps the complete legacy AND pipeline', async () => {
    const expression = { groupId: 'key', facts: [
      { operation: 'COUNT', factName: 'n', path: 'reviews.id' },
      { operation: 'SUM', factName: 'rating', path: 'reviews.rating' },
    ] };
    const shorthand = { reviews: { terms: [{ path: 'rating', operator: 'GTE', value: 5 }] } };
    const expected = [
      { $lookup: { from: from('Review'), foreignField: 'productId', localField: '_id', as: '__sf_l0' } },
      { $unwind: { path: '$__sf_l0', preserveNullAndEmptyArrays: true } },
      { $match: { '__sf_l0.rating': { $gte: 5 } } },
      { $group: { _id: '$key', fact_0: { $sum: 1 }, fact_1: { $sum: '$__sf_l0.rating' } } },
      { $project: { _id: 0, groupId: '$_id', facts: { n: '$fact_0', rating: '$fact_1' } } },
      { $sort: { groupId: 1 } },
    ];
    const pipeline = await f.queries.buildAggregationQuery(shorthand, f.types.Product, expression);
    expect(pipeline).toStrictEqual(expected);
    expect(pipeline).toStrictEqual(await f.queries.buildAggregationQuery(args(condition('reviews.rating', 5)), f.types.Product, expression));
  });
  test('explicit ALL on aggregate J keeps a nested frame rather than legacy joins in its body', async () => {
    const pipeline = await f.queries.buildAggregationQuery({ AND: [{ ALL: [{ path: 'products', conditions: [condition('reviews.rating', 5)] }] }] }, f.types.Shop, {
      groupId: 'products.reviews.author', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }],
    });
    expect(pipeline.slice(0, 2)).toStrictEqual([
      lookup(from('Product'), '_id', 'shop', '__sf_q0', [
        review('__sf_q1', [{ $match: { rating: { $gte: 5 } } }]),
        { $match: { $nor: [exists('__sf_q1')] } },
      ]),
      { $match: exists('__sf_q0', false) },
    ]);
    expect(pipeline.slice(2, 6)).toStrictEqual([
      { $lookup: { from: from('Product'), foreignField: 'shop', localField: '_id', as: '__sf_l0' } },
      { $unwind: { path: '$__sf_l0', preserveNullAndEmptyArrays: true } },
      { $lookup: { from: from('Review'), foreignField: 'productId', localField: '__sf_l0._id', as: '__sf_l1', pipeline: [{ $match: { productId: { $ne: null } } }] } },
      { $unwind: { path: '$__sf_l1', preserveNullAndEmptyArrays: true } },
    ]);
  });
  test('a frame after an aggregate reference chain shares each legacy anchor lookup', async () => {
    const pipeline = await f.queries.buildAggregationQuery(args(condition('products.pro.shop.products.name', 'Ka', 'EQ')), f.types.Shop, {
      groupId: 'products.key', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }],
    });
    expect(pipeline.slice(0, 8)).toStrictEqual([
      { $lookup: { from: from('Product'), foreignField: 'shop', localField: '_id', as: '__sf_l0' } },
      { $unwind: { path: '$__sf_l0', preserveNullAndEmptyArrays: true } },
      ...plain(from('Pro'), '__sf_l0.pro', '__sf_l1'), ...plain(from('Shop'), '__sf_l1.shop', '__sf_l2'),
      lookup(from('Product'), '__sf_l2._id', 'shop', '__sf_q0', [{ $match: { shop: { $ne: null } } }, { $match: { name: 'Ka' } }]),
      { $match: exists('__sf_q0') },
    ]);
  });
  test.each([false, true])('direct sort rejects collections in count=%s', async (count) => {
    await expect(build({ sort: { terms: [{ field: 'reviews.rating', order: 'ASC' }] } }, 'product', count)).rejects.toMatchObject({ extensions: { code: 'INVALID_FILTER_PATH' } });
  });
  test('embedded object and embedded-list frames guard null correlation keys', async () => {
    const Kid = new GraphQLObjectType({ name: 'QcfKid', fields: { id: { type: GraphQLID }, n: { type: GraphQLInt } } });
    const Meta = new GraphQLObjectType({ name: 'QcfMeta', fields: { kids: { type: new GraphQLList(Kid), extensions: { relation: { embedded: false, connectionField: 'owner' } } } } });
    const Box = new GraphQLObjectType({ name: 'QcfBox', fields: { meta: { type: Meta, extensions: { relation: { embedded: true } } }, lines: { type: new GraphQLList(Meta), extensions: { relation: { embedded: true } } } } });
    const queries = createMongoQueries({ getModel: (type) => ({ collection: { collectionName: type.name } }), getRegistrations: () => [] });
    for (const parent of ['meta', 'lines']) {
      expect(await queries.buildQuery(args(condition(`${parent}.kids.n`, 1, 'EQ')), Box)).toStrictEqual(find([
        lookup('QcfKid', `${parent}._id`, 'owner', '__sf_q0', [{ $match: { owner: { $ne: null } } }, { $match: { n: 1 } }]),
      ], exists('__sf_q0'), ['__sf_q0']));
    }
  });
  test('markers fail closed for missing, unfilled and relation-free frame positions', async () => {
    for (const marker of [{}, { scopes: {} }, { scopes: { reviews: undefined } }]) {
      await expect(build({ AND: [{ ANY: [{ path: 'reviews', __scope: marker }] }] })).rejects.toMatchObject({ extensions: { code: 'DETACHED_CLIENT_FILTER' } });
    }
    for (const [path, scopes] of [['rating', {}], ['product.name', {}]]) {
      await expect(build({ AND: [{ ANY: [{ path: 'reviews', conditions: [{ field: path, value: path === 'rating' ? 1 : 'Ka', __scope: { scopes } }] }] }] }))
        .rejects.toMatchObject({ extensions: { code: 'DETACHED_CLIENT_FILTER' } });
    }
  });
  test('R27: a null-scope vector crossing after a scoped reference keeps all index candidates', async () => {
    const v = vectorFixture('QcfVectorPlan', true);
    const input = { AND: [{ ANY: [{ path: 'products', conditions: [{ field: 'pro.lines.shop.name', value: 'good', __scope: { scopes: { pro: { name: { value: 'admitted' } }, 'pro.lines.shop': null } } }] }] }] };
    expect(await v.queries.buildQuery(input, v.Root)).toStrictEqual(find([
      lookup('QcfVectorPlanProduct', '_id', 'root', '__sf_q0', [
        ...plain('QcfVectorPlanPro', 'pro', '__sf_j0', { pipeline: [{ $match: { name: 'admitted' } }, { $limit: 1 }] }),
        ...plain('QcfVectorPlanTarget', '__sf_j0.lines.shop', '__sf_j1'),
        { $match: { '__sf_j1.name': 'good' } },
      ]),
    ], exists('__sf_q0'), ['__sf_q0']));
  });
  test('R27: direct compiler rejects a non-null vector target scope after a scoped reference', async () => {
    const v = vectorFixture('QcfVectorReject', true);
    const input = { AND: [{ ANY: [{ path: 'products', conditions: [{ field: 'pro.lines.shop.name', value: 'good', __scope: { scopes: { pro: { name: { value: 'admitted' } }, 'pro.lines.shop': { name: { value: 'good' } } } } }] }] }] };
    await expect(v.queries.buildQuery(input, v.Root)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN_FILTER_PATH', status: 403 } });
  });
  test('R27: a non-null vector target scope rejects list, count and aggregate before database reads', async () => {
    const v = vectorFixture('QcfVectorGate', true);
    const input = { AND: [{ ANY: [{ path: 'products', conditions: [{ field: 'pro.lines.shop.name', value: 'good' }] }] }] };
    const reads = [];
    for (const method of ['find', 'count', 'aggregate']) v.adapter[method] = async () => { reads.push(method); return method === 'count' ? 0 : []; };
    const fields = v.schema.getQueryType().getFields();
    const root = `${v.Root.name.toLowerCase()}s`;
    for (const [name, extra] of [[root, {}], [root, { pagination: { page: 1, size: 10, count: true } }], [`${root}_aggregate`, { aggregation: { groupId: 'id', facts: [{ factName: 'n', operation: 'COUNT', path: 'id' }] } }]]) {
      await expect(fields[name].resolve(null, { ...structuredClone(input), ...extra }, { restrictVector: true }))
        .rejects.toMatchObject({ extensions: { code: 'FORBIDDEN_FILTER_PATH', status: 403 } });
      expect(reads).toEqual([]);
    }
  });
  test('pin: a missing target model fails before emitting a frame', async () => {
    const queries = createMongoQueries({ getModel: (type) => type === f.types.Review ? null : f.runtime.getModel(type), getRegistrations: () => [] });
    await expect(queries.buildQuery(args(condition()), f.types.Product)).rejects.toMatchObject({ extensions: { code: 'INVALID_FILTER_PATH' } });
  });
});

const servers = [['replica set', process.env.SIMFINITY_MONGODB_URI, 'QcfRs'], ['standalone', process.env.SIMFINITY_STANDALONE_MONGODB_URI, 'QcfSs']];
let stored;
describe.each(servers)('MongoDB collection frames on %s', (label, uri, prefix) => {
  let f;
  let vector;
  let correction;
  const enabled = !!uri && !!process.env.SIMFINITY_MONGODB_URI;
  const invoke = async (input, shape, root, site = 'find', context = {}) => {
    const descriptor = f.types.roots[root];
    const field = f.schema.getQueryType().getFields()[`${descriptor.plural}${site === 'aggregate' ? '_aggregate' : ''}`];
    context.shape = shape;
    return field.resolve(null, structuredClone(input), context);
  };
  beforeAll(async () => {
    if (!enabled) return;
    await mongoose.connect(uri, { dbName: `${new URL(uri).pathname.slice(1)}_collection_frames`, monitorCommands: true });
    await mongoose.connection.dropDatabase();
    f = fixture(prefix);
    vector = vectorFixture(`${prefix}Vector`);
    correction = correctionFixture(`${prefix}Correction`);
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    if (label === 'replica set') {
      await seedCollectionFrames(f.schema, f.types);
      stored = await readMongoEmptinessDocuments(f.runtime, f.types);
    } else await writeMongoEmptinessDocuments(f.runtime, f.types, stored);
    await f.model('product').collection.createIndex({ name: 1 });
    await correction.seed();
  }, 60000);
  afterAll(async () => {
    if (!enabled) return;
    await Promise.allSettled(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });
  describe.skipIf(!enabled)('rows', () => {
    test.each(COLLECTION_CASES.map((item) => ({ ...item, name: `${['ALL alone', 'ALL alone AND neutral', 'reference inside frame EQ', 'ALL reference shop alone', 'ALL reference pro alone'].includes(item.name) ? 'pin: ' : ''}${item.name}` })))('$name for every scope shape, list/count/aggregate', async (item) => {
      for (const shape of REFERENCE_SHAPES) {
        if (item.forbidden?.includes(shape)) {
          await expect(invoke(item.args, shape, item.root)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN_FILTER_PATH' } });
          continue;
        }
        const expected = item.rows[shape] ?? collectionOracle(shape)(item);
        const rows = await invoke(item.args, shape, item.root);
        expect(rows.map((r) => r.key).sort(), `${item.name} ${shape}`).toEqual(expected);
        const countContext = {};
        await invoke({ ...item.args, pagination: { page: 1, size: 100, count: true } }, shape, item.root, 'find', countContext);
        expect(countContext.count, `${item.name} ${shape} count`).toBe(expected.length);
        const aggregated = await invoke({ ...item.args, aggregation: { groupId: 'key', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }] } }, shape, item.root, 'aggregate');
        expect(aggregated.map((r) => r.groupId).sort(), `${item.name} ${shape} aggregate`).toEqual(expected);
        expect(aggregated.every((r) => r.facts.n === 1)).toBe(true);
      }
    }, 60000);
    test.each(COLLECTION_AGGREGATES.map((item) => ({ ...item, name: `${item.filter === 'rating1' ? '' : 'pin: '}${item.name}` })))('$name retains legacy aggregate row cardinality', async (item) => {
      const filters = { rating1: args(condition('reviews.rating', 1)), rating5: args(condition('reviews.rating', 5)), twoGroups: { AND: [args(condition()).AND[0], args(condition('reviews.author', 'x', 'EQ')).AND[0]] } };
      for (const shape of REFERENCE_SHAPES) {
        const input = { ...(filters[item.filter] ?? {}), aggregation: { groupId: item.groupId, facts: item.facts } };
        if (item.forbidden?.includes(shape)) { await expect(invoke(input, shape, 'product', 'aggregate')).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN_FILTER_PATH' } }); continue; }
        const rows = await invoke(input, shape, 'product', 'aggregate');
        expect(rows.map((r) => [r.groupId, ...item.facts.map((fact) => r.facts[fact.factName])]).sort((a, b) => String(a[0] ?? '').localeCompare(String(b[0] ?? ''))), shape).toEqual(item.rowsByShape[shape]);
      }
    });
    test('anchored nested and reference-chain aggregates keep one count per anchor', async () => {
      for (const shape of REFERENCE_SHAPES) {
        for (const [key, input] of [
          ['reviewsPerProduct', { ...args(condition('products.reviews.rating', 1)), aggregation: { groupId: 'products.key', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }] } }],
          ['referenceChain', { ...args(condition('products.pro.shop.products.name', 'Ka', 'EQ')), aggregation: { groupId: 'products.key', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }] } }],
        ]) {
          const rows = await invoke(input, shape, 'shop', 'aggregate');
          expect(rows.map((r) => [r.groupId, r.facts.n]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0), `${key} ${shape}`).toEqual(COLLECTION_ANCHOR_ROWS[key][shape]);
        }
      }
    });
    test('explicit ALL on J remains per record for every scope shape', async () => {
      const input = { aggregation: { groupId: 'products.reviews.author', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }] }, AND: [{ ALL: [{ path: 'products', conditions: [condition('reviews.rating', 5)] }] }] };
      for (const shape of REFERENCE_SHAPES) {
        const pending = invoke(input, shape, 'shop', 'aggregate');
        if (COLLECTION_ANCHOR_ROWS.universalProducts.forbidden.includes(shape)) await expect(pending).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN_FILTER_PATH' } });
        else expect((await pending).map((row) => [row.groupId, row.facts.n])).toEqual(COLLECTION_ANCHOR_ROWS.universalProducts[shape].length ? [['hidden', 1], ['x', 1]] : []);
      }
    });
    test('a trusted by-ID null-leaf frame excludes a record with no actual children', async () => {
      const product = await f.model('product').findOne({ key: 'C' }).lean();
      const field = f.schema.getQueryType().getFields()[f.types.roots.product.single];
      const trustedScope = ({ type, operation, args: query }) => {
        if (type.gqltype === f.types.Product && operation === 'get_by_id') query.reviews = { terms: [{ path: 'author', value: null }] };
      };
      expect(await field.resolve(null, { id: String(product._id) }, { shape: 'admin', trustedScope })).toBeNull();
    });
    test('every product parity row keeps its scope and membership on collection fields, batched and individual', async () => {
      const shops = await f.model('shop').find().lean();
      const products = await f.model('product').find().lean();
      const field = f.types.Shop.getFields().products;
      const batching = f.adapter.batchesChildren;
      try {
        for (const batched of [false, true]) {
          f.adapter.batchesChildren = batched ? batching : () => false;
          for (const item of COLLECTION_CASES.filter((entry) => entry.root === 'product' && !entry.forbidden)) {
            for (const shape of REFERENCE_SHAPES) {
              const context = { shape };
              const expected = item.rows[shape] ?? collectionOracle(shape)(item);
              const rows = await Promise.all(shops.map((shop) => field.resolve(shop, structuredClone(item.args), context)));
              expect(rows.map((found) => found.map((r) => r.key).sort()), `${item.name} ${shape} batch=${batched}`).toEqual(shops.map((shop) => products.filter((product) => String(product.shop) === String(shop._id) && expected.includes(product.key)).map((product) => product.key).sort()));
            }
          }
        }
      } finally { f.adapter.batchesChildren = batching; }
    }, 60000);
    test('R27: scoped base and null-scope vector reference retain a later matching target', async () => {
      const id = (n) => new mongoose.Types.ObjectId(n.toString(16).padStart(24, '0'));
      await vector.runtime.getModel(vector.Target).collection.insertMany([{ _id: id(1), name: 'bad' }, { _id: id(2), name: 'good' }]);
      await vector.runtime.getModel(vector.Pro).collection.insertMany([
        { _id: id(20), name: 'admitted', lines: [{ shop: id(1) }, { shop: id(2) }] },
        { _id: id(21), name: 'denied', lines: [{ shop: id(2) }] },
      ]);
      await vector.runtime.getModel(vector.Product).collection.insertMany([{ _id: id(30), pro: id(20), root: id(10) }, { _id: id(31), pro: id(21), root: id(11) }]);
      await vector.runtime.getModel(vector.Root).collection.insertMany([{ _id: id(10) }, { _id: id(11) }]);
      const field = vector.schema.getQueryType().getFields()[`${vector.Root.name.toLowerCase()}s`];
      const rows = await field.resolve(null, { AND: [{ ANY: [{ path: 'products', conditions: [{ field: 'pro.lines.shop.name', value: 'good' }] }] }] }, {});
      expect(rows.map((r) => String(r._id))).toEqual([String(id(10))]);
    });
    test('mixed trusted terms preserve client-frame scopes while separate groups get independent frames', async () => {
      const input = { reviews: { terms: [{ path: 'rating', operator: 'GTE', value: 4 }] } };
      const append = (separate) => ({ args: query, type, operation }) => {
        if (type.gqltype !== f.types.Product || operation !== 'find') return;
        if (separate) query.AND = [...(query.AND ?? []), { conditions: [condition('reviews.author', 'hidden', 'EQ')] }];
        else query.reviews.terms.push({ path: 'author', operator: 'EQ', value: 'hidden' });
      };
      expect((await invoke(input, 'NE', 'product', 'find', { middleware: append(false) })).map((r) => r.key)).toEqual([]);
      expect((await invoke(input, 'NE', 'product', 'find', { middleware: append(true) })).map((r) => r.key).sort()).toEqual(['E']);
    });
    test('trusted query and by-ID scopes compile frames with stored semantics', async () => {
      const trustedScope = ({ type, args: query, operation }) => {
        if (type.gqltype === f.types.Product && ['find', 'get_by_id'].includes(operation)) {
          query.reviews = { terms: [{ path: 'author', value: 'hidden' }] };
        }
      };
      expect((await invoke({}, 'NE', 'product', 'find', { trustedScope })).map((r) => r.key).sort()).toEqual(['D', 'E', 'c']);
      const product = await f.model('product').findOne({ key: 'D' }).lean();
      const field = f.schema.getQueryType().getFields()[f.types.roots.product.single];
      const found = await field.resolve(null, { id: String(product._id) }, { shape: 'NE', trustedScope });
      expect(found.key).toBe('D');
      expect((await invoke(args(condition('reviews.author', 'hidden', 'EQ')), 'NE', 'product')).map((r) => r.key)).toEqual([]);
    });
    test('batched union branches reproduce individual reads with frames', async () => {
      const parents = (await f.model('shop').find().lean()).map((r) => r._id);
      const input = args(condition('reviews.rating', 1));
      const Model = f.model('product');
      const singles = await Promise.all(parents.map((id) => f.adapter.findChildren(Model, f.types.Product, 'shop', id, input)));
      expect(JSON.stringify(await f.adapter.buildQuery(input, f.types.Product))).toContain('__sf_q0');
      const batch = await f.adapter.findChildrenBatch(Model, f.types.Product, 'shop', parents, input);
      expect(batch.map((rows) => rows.map((r) => r.key).sort())).toEqual(singles.map((rows) => rows.map((r) => r.key).sort()));
      expect(batch.flat().map((r) => r.key).sort()).toEqual(['D', 'E', 'Ka', 'c']);
    });
    describe('phase3 fix1 Mongo vector frame truth and cardinality', () => {
      const rootKeys = ['mixed', 'fail', 'both', 'empty', 'missing', 'null', 'split', 'compound'];
      const frame = (quantifier, conditions, path = 'children', keys = rootKeys) => ({ key: { operator: 'IN', value: keys }, AND: [{ [quantifier]: [{ path, conditions }] }] });
      test.each([
        ['ANY', 'good', ['both', 'compound', 'mixed', 'split']], ['NONE', 'good', ['empty', 'fail', 'missing', 'null']],
        ['ALL', 'good', ['compound', 'empty', 'mixed', 'split']],
        ['ANY', null, ['missing', 'null']], ['NONE', null, ['both', 'compound', 'empty', 'fail', 'mixed', 'split']], ['ALL', null, ['empty', 'missing', 'null']],
      ])('%s evaluates one positive vector body per actual child for EQ %s', async (quantifier, value, expected) => {
        expect(await correction.keys(frame(quantifier, [{ field: 'lines.shop.name', value }]))).toEqual(expected);
      });
      test('ALL preserves same-target conjunction across the complete body', async () => {
        const input = frame('ALL', [{ field: 'lines.shop.name', value: 'good' }, { field: 'lines.shop.tone', value: 'red' }]);
        expect(await correction.keys(input)).toEqual(['compound', 'empty']);
        const pipeline = await correction.adapter.buildQuery(input, correction.Root);
        const child = pipeline.find((stage) => stage.$lookup).$lookup;
        expect(child.pipeline).toEqual([
          lookup(correction.model(correction.Child).collection.collectionName, '_id', '_id', '__sf_q1', [
            ...plain(correction.model(correction.Target).collection.collectionName, 'lines.shop', '__sf_l0'),
            { $match: { $and: [{ '__sf_l0.name': 'good' }, { '__sf_l0.tone': 'red' }] } },
          ]),
          { $match: exists('__sf_q1', false) }, { $limit: 1 }, { $project: { _id: 1 } },
        ]);
      });
      test('ALL over a reference frame also evaluates its child body once', async () => {
        expect(await correction.keys(frame('ALL', [{ field: 'lines.shop.name', value: 'good' }], 'one', ['mixed', 'fail']))).toEqual(['mixed']);
      });
      test.each(['ANY', 'NONE', 'ALL'])('%s preserves the R27 restricted prefix and null vector-target scope', async (quantifier) => {
        const input = frame(quantifier, [{ field: 'pro.lines.shop.name', value: 'good' }], 'children', ['scopedGood', 'scopedBad']);
        expect(await correction.keys(input)).toEqual(quantifier === 'NONE' ? ['scopedBad'] : ['scopedGood']);
      });
      test('ALL keeps target scope admission outside the positive body witness', async () => {
        const input = frame('ALL', [{ field: 'lines.shop.name', value: 'good' }], 'children', ['both']);
        expect(await correction.keys(input, { hideFailingChild: true })).toEqual(['both']);
        expect(await correction.keys(input)).toEqual([]);
      });
      test('pin: ALL admits independent complete scope and body vector witnesses', async () => {
        const input = frame('ALL', [{ field: 'lines.shop.name', value: 'good' }], 'children', ['mixed']);
        expect(await correction.keys(input, { scopeWitness: true })).toEqual(['mixed']);
      });
      test('pin: the positive ordinary child predicate still finds its later target', async () => {
        expect(await correction.keys({ key: { value: 'mixed' }, AND: [{ conditions: [{ field: 'lines.shop.name', value: 'good' }] }] }, {}, correction.Child)).toEqual(['mixed']);
      });
      test('a vector prefix with zero, one and two matching targets remains one list/count/page predicate', async () => {
        for (const [key, expected] of [['prefixZero', []], ['prefixOne', ['prefixOne']], ['prefixTwo', ['prefixTwo']]]) {
          const input = { key: { value: key }, AND: [{ conditions: [{ field: 'lines.shop.children.name', value: 'good' }] }] };
          expect(await correction.keys(input), key).toEqual(expected);
          const context = {};
          await correction.run({ ...input, pagination: { page: 1, size: 1, count: true } }, context);
          expect(context.count, key).toBe(expected.length);
          expect(await correction.keys({ ...input, pagination: { page: 2, size: 1 } }), key).toEqual([]);
        }
      });
      test('the isolated prefix retains complete same-child conditions and OR branch placement', async () => {
        const input = { key: { value: 'prefixTwo' }, OR: [{ conditions: [{ field: 'lines.shop.children.name', value: 'good' }] }, { conditions: [{ field: 'key', value: 'never' }] }] };
        expect(await correction.keys(input)).toEqual(['prefixTwo']);
        const compound = { key: { value: 'prefixTwo' }, AND: [{ conditions: [{ field: 'lines.shop.children.name', value: 'good' }, { field: 'lines.shop.children.tone', value: 'red' }] }] };
        expect(await correction.keys(compound)).toEqual(['prefixTwo']);
      });
      test.each(['ANY', 'NONE', 'ALL'])('direct normalized %s preserves prefix polarity and empty-prefix vacuity', async (quantifier) => {
        const input = { key: { operator: 'IN', value: ['prefixZero', 'prefixOne', 'prefixTwo', 'prefixMissing', 'prefixEmpty'] }, AND: [{ [quantifier]: [{ path: 'lines.shop.children', __implicit: true, conditions: [{ field: 'name', value: quantifier === 'ALL' ? 'missing' : 'good' }] }] }] };
        const pipeline = await correction.adapter.buildQuery(input, correction.Root);
        expect((await correction.model(correction.Root).aggregate(pipeline)).map((row) => row.key).sort()).toEqual(quantifier === 'ANY' ? ['prefixOne', 'prefixTwo'] : ['prefixEmpty', 'prefixMissing', 'prefixZero']);
        const wrapper = pipeline.find((stage) => stage.$lookup).$lookup;
        expect(wrapper).toMatchObject({ from: correction.model(correction.Root).collection.collectionName, localField: '_id', foreignField: '_id', as: '__sf_q0' });
        expect(pipeline.some((stage) => stage.$unwind)).toBe(false);
        expect(wrapper.pipeline.some((stage) => stage.$unwind)).toBe(true);
        expect(wrapper.pipeline.slice(-3)).toEqual([
          { $match: quantifier === 'ALL' ? { $nor: [exists('__sf_q1', false)] } : exists('__sf_q1') },
          { $limit: 1 }, { $project: { _id: 1 } },
        ]);
        expect(pipeline.at(-1)).toEqual({ $unset: ['__sf_q0'] });
      });
      test('pin: vector-only joins preserve their two-root multiplicity', async () => {
        const input = { key: { value: 'prefixTwo' }, AND: [{ conditions: [{ field: 'lines.shop.name', operator: 'IN', value: ['left', 'right'] }] }] };
        expect(await correction.keys(input)).toEqual(['prefixTwo', 'prefixTwo']);
        const context = {};
        await correction.run({ ...input, pagination: { page: 1, size: 1, count: true } }, context);
        expect(context.count).toBe(2);
      });
    });
    test('explain uses connection indexes for shorthand, reference, anchored and nested frames without collection scans', async () => {
      const probes = [
        ['product', args(condition()), null, ['productId_1']],
        ['product', args(condition('shop.products.name', 'Ka', 'EQ')), null, ['_id_', 'shop_1']],
        ['shop', args(condition('products.reviews.rating', 1)), null, ['shop_1', 'productId_1']],
        ['shop', args(condition('products.reviews.rating', 1)), { groupId: 'products.key', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }] }, ['shop_1', 'productId_1']],
      ];
      for (const [root, input, aggregation, expected] of probes) {
        const type = f.types.roots[root].type;
        const candidate = await f.model(root).findOne({ key: root === 'product' ? 'Ka' : 'S1' }).lean();
        input.id = { value: String(candidate._id) };
        const pipeline = aggregation ? await f.queries.buildAggregationQuery(input, type, aggregation) : await f.adapter.buildQuery(input, type);
        const explain = await f.model(root).aggregate(pipeline).hint({ _id: 1 }).explain('executionStats');
        const indexes = new Set();
        const rootIndexes = new Set();
        let scans = 0;
        const walk = (node) => {
          if (!node || typeof node !== 'object') return;
          if (node.stage === 'COLLSCAN') scans += 1;
          if (Array.isArray(node.indexesUsed)) { for (const index of node.indexesUsed) indexes.add(index); scans += node.collectionScans ?? 0; }
          for (const value of Object.values(node)) if (value && typeof value === 'object') walk(value);
        };
        walk(explain);
        const rootWalk = (node) => {
          if (!node || typeof node !== 'object') return;
          if (node.stage === 'IXSCAN') rootIndexes.add(node.indexName);
          for (const [key, value] of Object.entries(node)) if (key !== '$lookup' && value && typeof value === 'object') rootWalk(value);
        };
        rootWalk(explain);
        expect([...rootIndexes]).toContain('_id_');
        expect([...indexes], JSON.stringify(pipeline)).toEqual(expect.arrayContaining(expected));
        expect(scans).toBe(0);
        expect(JSON.stringify(pipeline)).toContain('__sf_q0');
      }
    });
  });
});
