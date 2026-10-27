import {
  afterAll, beforeAll, describe, expect, test,
} from 'vitest';
import mongoose from 'mongoose';
import {
  GraphQLBoolean, GraphQLEnumType, GraphQLID, GraphQLInt, GraphQLList, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';
import { createMongoAdapter, createRuntime, createValidatedScalar } from '../../packages/mongodb/src/index.js';
import QLOperator from '../../packages/mongodb/src/const/QLOperator.js';
import { createMongoQueries } from '../../packages/mongodb/src/mongo/queries.js';

// #108 part 1 on MongoDB: the literal text operators ILIKE, STARTS_WITH, ISTARTS_WITH, ENDS_WITH,
// IENDS_WITH and IEQ compile to escaped regular expressions, anchored with `^` and `\z`, with the `i`
// option for the case-insensitive ones, wherever LIKE compiles; the operators of 3.7.0 keep their
// pipelines. The compile tests need no database; the row, plan and case folding tests run on the
// disposable replica set and standalone server.

const replicaSetUri = process.env.SIMFINITY_MONGODB_URI;
const standaloneUri = process.env.SIMFINITY_STANDALONE_MONGODB_URI;

const LEGACY = ['EQ', 'NE', 'LT', 'LTE', 'GT', 'GTE', 'BTW', 'IN', 'NIN', 'LIKE'];
const TEXT = ['ILIKE', 'STARTS_WITH', 'ISTARTS_WITH', 'ENDS_WITH', 'IENDS_WITH', 'IEQ'];
// The emptiness operators (#108, part 2a), which take no value; query-emptiness-mongodb.test.js tests them.
const EMPTINESS = ['IS_EMPTY', 'IS_NOT_EMPTY'];
// The list operators (#108, part 4), which take an array; list-operators-mongodb.test.js tests them.
const LIST = ['CONTAINS_ALL', 'IIN'];
// The operators that match every non-null string for an empty value.
const OPEN_ENDED = ['ILIKE', 'STARTS_WITH', 'ISTARTS_WITH', 'ENDS_WITH', 'IENDS_WITH'];

// Each runtime binds its own types, so every fixture gets its own type names and collections.
const createTypes = (prefix) => {
  const contextScope = (key) => async ({ args, context }) => context?.[key]?.(args);
  const Code = createValidatedScalar(`${prefix}Code`, 'An upper-case code', GraphQLString, (value) => {
    if (!/^[A-Z]{2}-\d+$/.test(value)) throw new Error('Invalid code');
  });
  const Kind = new GraphQLEnumType({ name: `${prefix}Kind`, values: { ONE: { value: 'one' }, TWO: { value: 'two' } } });
  const Dims = new GraphQLObjectType({
    name: `${prefix}Dims`,
    fields: { label: { type: GraphQLString }, codes: { type: new GraphQLList(GraphQLString) }, w: { type: GraphQLInt } },
  });
  const Line = new GraphQLObjectType({
    name: `${prefix}Line`,
    fields: () => ({
      sku: { type: GraphQLString },
      qty: { type: GraphQLInt },
      shop: { type: Shop, extensions: { relation: { embedded: false } } },
    }),
  });
  const Shop = new GraphQLObjectType({
    name: `${prefix}Shop`,
    extensions: { scope: { find: contextScope('shopScope') } },
    fields: () => ({
      id: { type: GraphQLID },
      key: { type: GraphQLString },
      name: { type: GraphQLString },
      state: { type: GraphQLString },
      products: { type: new GraphQLList(Product), extensions: { relation: { connectionField: 'shop' } } },
    }),
  });
  const Review = new GraphQLObjectType({
    name: `${prefix}Review`,
    fields: () => ({
      id: { type: GraphQLID },
      author: { type: GraphQLString },
      rating: { type: GraphQLInt },
      product: { type: Product, extensions: { relation: { connectionField: 'product' } } },
    }),
  });
  const Product = new GraphQLObjectType({
    name: `${prefix}Product`,
    extensions: {
      scope: {
        find: contextScope('productScope'),
        get_by_id: contextScope('productByIdScope'),
        aggregate: contextScope('productAggregateScope'),
      },
    },
    fields: () => ({
      id: { type: GraphQLID },
      key: { type: GraphQLString },
      name: { type: GraphQLString },
      code: { type: Code },
      tags: { type: new GraphQLList(GraphQLString) },
      stock: { type: GraphQLInt },
      active: { type: GraphQLBoolean },
      kind: { type: Kind },
      dims: { type: Dims, extensions: { relation: { embedded: true } } },
      lines: { type: new GraphQLList(Line), extensions: { relation: { embedded: true } } },
      shop: { type: Shop, extensions: { relation: { connectionField: 'shop' } } },
      reviews: { type: new GraphQLList(Review), extensions: { relation: { connectionField: 'product' } } },
    }),
  });
  const Word = new GraphQLObjectType({
    name: `${prefix}Word`,
    fields: { id: { type: GraphQLID }, text: { type: GraphQLString } },
  });
  return {
    Dims, Line, Shop, Review, Product, Word,
  };
};

const createFixture = (prefix, { adapter = createMongoAdapter(), preventCreatingCollection = false } = {}) => {
  const types = createTypes(prefix);
  const runtime = createRuntime(adapter);
  if (preventCreatingCollection) runtime.preventCreatingCollection(true);
  const lower = prefix.toLowerCase();
  runtime.addNoEndpointType(types.Dims);
  runtime.addNoEndpointType(types.Line);
  runtime.connect(null, types.Shop, `${lower}shop`, `${lower}shops`);
  runtime.connect(null, types.Product, `${lower}product`, `${lower}products`);
  runtime.connect(null, types.Review, `${lower}review`, `${lower}reviews`);
  runtime.connect(null, types.Word, `${lower}word`, `${lower}words`);
  // The request context decides what each test's middleware adds.
  runtime.use(async (params, next) => {
    await params.context?.middleware?.(params);
    await next();
  });
  const schema = runtime.createSchema();
  const queries = createMongoQueries({
    getModel: (type) => runtime.getModel(type),
    getRegistrations: () => runtime.getRegistrations(),
  });
  const execute = (source, variableValues, contextValue = {}) => graphql({
    schema, source, variableValues, contextValue,
  });
  const run = async (source, variableValues, contextValue = {}) => {
    const result = await execute(source, variableValues, contextValue);
    expect(result.errors).toBeUndefined();
    return result.data;
  };
  return {
    adapter, runtime, schema, types, queries, execute, run, lower,
    model: (name) => runtime.getModel(types[name]),
    products: `${lower}products`,
    shops: `${lower}shops`,
  };
};

const codeOf = async (body) => {
  try {
    await body();
  } catch (error) {
    return error.extensions?.code ?? error.message;
  }
  return null;
};

describe('MongoDB text operator compilation', () => {
  const fixture = createFixture('QtmPlan', { preventCreatingCollection: true });
  const { Product } = fixture.types;
  const build = (args, isCount) => fixture.queries.buildQuery(args, Product, isCount);
  const matchOf = async (args) => (await build(args))[0].$match;
  const page = [{ $skip: 0 }, { $limit: 100 }];
  const shopLookup = [
    {
      $lookup: {
        from: 'QtmPlanShop', foreignField: '_id', localField: 'shop', as: '__sf_l0',
      },
    },
    { $unwind: { path: '$__sf_l0', preserveNullAndEmptyArrays: true } },
  ];

  describe('operators of 3.7.0', () => {
    test('every operator keeps its pipeline in a group', async () => {
      expect(await build({
        AND: [{
          conditions: [
            { field: 'stock', value: 1 },
            { field: 'stock', operator: 'NE', value: null },
            { field: 'stock', operator: 'LT', value: 9 },
            { field: 'stock', operator: 'LTE', value: 9 },
            { field: 'stock', operator: 'GT', value: 0 },
            { field: 'stock', operator: 'GTE', value: 0 },
            { field: 'stock', operator: 'BTW', value: [0, 9] },
            { field: 'stock', operator: 'IN', value: [1, 2] },
            { field: 'stock', operator: 'NIN', value: [] },
            { field: 'name', operator: 'LIKE', value: 'a.b' },
            { field: 'name', operator: 'EQ', value: '' },
          ],
        }],
      })).toEqual([
        {
          $match: {
            $and: [
              { stock: 1 },
              { stock: { $ne: null } },
              { stock: { $lt: 9 } },
              { stock: { $lte: 9 } },
              { stock: { $gt: 0 } },
              { stock: { $gte: 0 } },
              { stock: { $gte: 0, $lte: 9 } },
              { stock: { $in: [1, 2] } },
              { stock: { $nin: [] } },
              { name: { $regex: '.*a\\.b.*' } },
              { name: '' },
            ],
          },
        },
        ...page,
      ]);
    });

    test('reference and embedded paths keep their forms while collections use frames', async () => {
      expect(await build({
        shop: { terms: [{ path: 'name', operator: 'LIKE', value: 'North' }] },
        reviews: { terms: [{ path: 'author', value: null }] },
        lines: { terms: [{ path: 'sku', operator: 'LIKE', value: '(x)' }, { path: 'qty', operator: 'GT', value: 1 }] },
        tags: { operator: 'LIKE', value: '' },
        sort: { terms: [{ field: 'shop.name', order: 'DESC' }] },
      })).toEqual([
        ...shopLookup,
        {
          $lookup: {
            from: 'QtmPlanReview', foreignField: 'product', localField: '_id', as: '__sf_q0',
            pipeline: [{ $match: { author: null } }, { $limit: 1 }, { $project: { _id: 1 } }],
          },
        },
        {
          $match: {
            $and: [{
              '__sf_l0.name': { $regex: '.*North.*' },
              'lines.sku': { $regex: '.*\\(x\\).*' },
              'lines.qty': { $gt: 1 },
              tags: { $regex: '.*.*' },
            }, { '__sf_q0.0': { $exists: true } }],
          },
        },
        { $sort: { '__sf_l0.name': -1 } },
        ...page,
        { $unset: ['__sf_l0', '__sf_q0'] },
      ]);
    });

    test('identifiers keep their casts', async () => {
      const hex = '64b7f0c2a1b2c3d4e5f60718';
      expect(await build({ id: { operator: 'IN', value: [hex] }, shop: { terms: [{ path: 'id', value: hex }] } })).toEqual([
        ...shopLookup,
        { $match: { _id: { $in: [new mongoose.Types.ObjectId(hex)] }, '__sf_l0._id': new mongoose.Types.ObjectId(hex) } },
        ...page,
        { $unset: ['__sf_l0'] },
      ]);
    });

    test('counts and aggregates keep their pipelines', async () => {
      expect(await build({ name: { operator: 'LIKE', value: 'x' }, pagination: { page: 2, size: 5, count: true } }, true))
        .toEqual([{ $match: { name: { $regex: '.*x.*' } } }, { $count: 'size' }]);
      expect(await fixture.queries.buildAggregationQuery({
        tags: { operator: 'LIKE', value: 'r' },
        OR: [
          { conditions: [{ field: 'dims.label', operator: 'LIKE', value: 's' }] },
          { conditions: [{ field: 'stock', operator: 'IN', value: [1] }] },
        ],
      }, Product, { groupId: 'shop.name', facts: [{ operation: 'SUM', factName: 'stock', path: 'stock' }] })).toEqual([
        {
          $match: {
            $and: [
              { tags: { $regex: '.*r.*' } },
              { $or: [{ 'dims.label': { $regex: '.*s.*' } }, { stock: { $in: [1] } }] },
            ],
          },
        },
        ...shopLookup,
        { $group: { _id: '$__sf_l0.name', fact_0: { $sum: '$stock' } } },
        { $project: { _id: 0, groupId: '$_id', facts: { stock: '$fact_0' } } },
        { $sort: { groupId: 1 } },
      ]);
    });

    test('invalid values keep their errors', async () => {
      for (const args of [
        { stock: { operator: 'LIKE', value: 'a' } },
        { name: { operator: 'LIKE', value: 3 } },
        { name: { operator: 'LIKE', value: null } },
        { name: { operator: 'GT', value: null } },
        { name: { operator: 'IN', value: 'a' } },
      ]) {
        expect(await codeOf(() => build(args))).toBe('INVALID_FILTER_VALUE');
      }
      expect(await codeOf(() => build({ name: { operator: 'NOPE', value: 'a' } }))).toBe('INVALID_FILTER_OPERATOR');
    });
  });

  describe('text operators', () => {
    test('compile to escaped regexes, anchored by ^ and \\z, with the i option to ignore case', async () => {
      const value = 'a.b';
      const expected = {
        ILIKE: { $regex: 'a\\.b', $options: 'i' },
        STARTS_WITH: { $regex: '^a\\.b' },
        ISTARTS_WITH: { $regex: '^a\\.b', $options: 'i' },
        ENDS_WITH: { $regex: 'a\\.b\\z' },
        IENDS_WITH: { $regex: 'a\\.b\\z', $options: 'i' },
        IEQ: { $regex: '^a\\.b\\z', $options: 'i' },
      };
      for (const operator of TEXT) {
        expect(await build({ name: { operator, value } })).toEqual([{ $match: { name: expected[operator] } }, ...page]);
      }
    });

    test('escape every regex metacharacter, so values never become syntax', async () => {
      const value = '.*+?^${}()|[]\\/%_-#\n';
      const escaped = '\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\/%_-#\n';
      expect(await matchOf({ name: { operator: 'ILIKE', value } })).toEqual({ name: { $regex: escaped, $options: 'i' } });
      expect(await matchOf({ name: { operator: 'IEQ', value } })).toEqual({ name: { $regex: `^${escaped}\\z`, $options: 'i' } });
      expect(await matchOf({ name: { operator: 'STARTS_WITH', value: '(?i)' } })).toEqual({ name: { $regex: '^\\(\\?i\\)' } });
    });

    test('compile the empty value', async () => {
      expect(await matchOf({ name: { operator: 'ILIKE', value: '' } })).toEqual({ name: { $regex: '', $options: 'i' } });
      expect(await matchOf({ name: { operator: 'STARTS_WITH', value: '' } })).toEqual({ name: { $regex: '^' } });
      expect(await matchOf({ name: { operator: 'ENDS_WITH', value: '' } })).toEqual({ name: { $regex: '\\z' } });
      expect(await matchOf({ name: { operator: 'IEQ', value: '' } })).toEqual({ name: { $regex: '^\\z', $options: 'i' } });
    });

    test('compile wherever LIKE compiles', async () => {
      const prefix = { $regex: '^ab', $options: 'i' };
      // Scalar lists, embedded objects, embedded scalar lists and embedded lists keep the stored path.
      expect(await matchOf({ tags: { operator: 'ISTARTS_WITH', value: 'ab' } })).toEqual({ tags: prefix });
      expect(await matchOf({ dims: { terms: [{ path: 'label', operator: 'ISTARTS_WITH', value: 'ab' }] } })).toEqual({ 'dims.label': prefix });
      expect(await matchOf({ dims: { terms: [{ path: 'codes', operator: 'ISTARTS_WITH', value: 'ab' }] } })).toEqual({ 'dims.codes': prefix });
      expect(await matchOf({
        lines: { terms: [{ path: 'sku', operator: 'ISTARTS_WITH', value: 'ab' }, { path: 'qty', operator: 'LT', value: 2 }] },
      })).toEqual({ 'lines.sku': prefix, 'lines.qty': { $lt: 2 } });
      // References, references inside embedded lists and collections read the joined document.
      expect(await build({ shop: { terms: [{ path: 'name', operator: 'ISTARTS_WITH', value: 'ab' }] } })).toEqual([
        ...shopLookup, { $match: { '__sf_l0.name': prefix } }, ...page, { $unset: ['__sf_l0'] },
      ]);
      expect(await build({ lines: { terms: [{ path: 'shop.name', operator: 'ISTARTS_WITH', value: 'ab' }] } })).toEqual([
        {
          $lookup: {
            from: 'QtmPlanShop', foreignField: '_id', localField: 'lines.shop', as: '__sf_l0',
          },
        },
        { $unwind: { path: '$__sf_l0', preserveNullAndEmptyArrays: true } },
        { $match: { '__sf_l0.name': prefix } },
        ...page,
        { $unset: ['__sf_l0'] },
      ]);
      const collectionPipeline = await build({ reviews: { terms: [{ path: 'author', operator: 'ISTARTS_WITH', value: 'ab' }] } });
      expect(collectionPipeline[0]).toStrictEqual({
        $lookup: {
          from: 'QtmPlanReview', localField: '_id', foreignField: 'product',
          pipeline: [{ $match: { author: prefix } }, { $limit: 1 }, { $project: { _id: 1 } }], as: '__sf_q0',
        },
      });
      // Group conditions, by field and path or by a dotted field, and nested groups.
      expect(await build({
        AND: [{
          conditions: [
            { field: 'shop', path: 'name', operator: 'IEQ', value: 'x' },
            { field: 'dims.label', operator: 'ENDS_WITH', value: 'y' },
          ],
          OR: [
            { conditions: [{ field: 'name', operator: 'ILIKE', value: 'z' }] },
            { AND: [{ conditions: [{ field: 'tags', operator: 'STARTS_WITH', value: 'w' }] }] },
          ],
        }],
      })).toEqual([
        ...shopLookup,
        {
          $match: {
            $and: [
              { '__sf_l0.name': { $regex: '^x\\z', $options: 'i' } },
              { 'dims.label': { $regex: 'y\\z' } },
              { $or: [{ name: { $regex: 'z', $options: 'i' } }, { tags: { $regex: '^w' } }] },
            ],
          },
        },
        ...page,
        { $unset: ['__sf_l0'] },
      ]);
      // Counts and aggregate filters.
      expect(await build({ name: { operator: 'IENDS_WITH', value: 'q' }, pagination: { page: 1, size: 5, count: true } }, true))
        .toEqual([{ $match: { name: { $regex: 'q\\z', $options: 'i' } } }, { $count: 'size' }]);
      expect((await fixture.queries.buildAggregationQuery(
        { name: { operator: 'STARTS_WITH', value: 'q' } },
        Product,
        { groupId: 'kind', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }] },
      ))[0]).toEqual({ $match: { name: { $regex: '^q' } } });
      // The native group API.
      expect(await fixture.adapter.buildFilterGroupMatch({ conditions: [{ field: 'name', operator: 'IEQ', value: 'q' }] }, Product, [], {}))
        .toEqual({ name: { $regex: '^q\\z', $options: 'i' } });
    });

    test('accept validated String scalars without running their checks, as LIKE does', async () => {
      expect(await matchOf({ code: { operator: 'STARTS_WITH', value: 'ab' } })).toEqual({ code: { $regex: '^ab' } });
    });

    test('reject anything but a string without U+0000 on a String field, before compiling', async () => {
      const invalid = [
        ['name', null], ['name', 5], ['name', true], ['name', ['a']], ['name', { a: 1 }], ['name', undefined],
        ['name', 'a\u0000b'], ['stock', '1'], ['active', 'true'], ['kind', 'ONE'], ['id', '64b7f0c2a1b2c3d4e5f60718'],
      ];
      for (const operator of TEXT) {
        for (const [field, value] of invalid) {
          expect(await codeOf(() => build({ [field]: { operator, value } })), `${operator} ${field} ${String(value)}`)
            .toBe('INVALID_FILTER_VALUE');
        }
        expect(await codeOf(() => build({ shop: { terms: [{ path: 'id', operator, value: 'a' }] } }))).toBe('INVALID_FILTER_VALUE');
        expect(await codeOf(() => build({ OR: [{ conditions: [{ field: 'lines.qty', operator, value: '1' }] }] }))).toBe('INVALID_FILTER_VALUE');
      }
      await expect(build({ shop: { terms: [{ path: 'name', operator: 'ILIKE', value: null }] } }))
        .rejects.toThrow('ILIKE requires a non-null string value on shop.name');
      await expect(build({ stock: { operator: 'IEQ', value: '1' } })).rejects.toThrow('IEQ requires a String field on stock');
    });

    test('reject a value whose pattern is longer than MongoDB accepts with INVALID_FILTER_VALUE, as LIKE does', async () => {
      // MongoDB accepts patterns of at most 32,764 UTF-8 bytes. Escaping adds a byte to each metacharacter, and the
      // operators add their anchors: ^ (1 byte), \z (2 bytes), and .* twice for LIKE.
      const longest = { ILIKE: 32764, STARTS_WITH: 32763, ISTARTS_WITH: 32763, ENDS_WITH: 32762, IENDS_WITH: 32762, IEQ: 32761, LIKE: 32760 };
      for (const [operator, length] of Object.entries(longest)) {
        const { $regex } = (await matchOf({ name: { operator, value: 'a'.repeat(length) } })).name;
        expect(Buffer.byteLength($regex), operator).toBe(32764);
        expect(await codeOf(() => build({ name: { operator, value: 'a'.repeat(length + 1) } })), operator).toBe('INVALID_FILTER_VALUE');
      }
      expect((await matchOf({ name: { operator: 'ILIKE', value: '.'.repeat(16382) } })).name.$regex).toHaveLength(32764);
      expect((await matchOf({ name: { operator: 'ILIKE', value: '\u00e9'.repeat(16382) } })).name.$regex).toHaveLength(16382);
      for (const value of ['.'.repeat(16383), '\u00e9'.repeat(16383), '\u20ac'.repeat(10922), '\u{1F600}'.repeat(8192)]) {
        expect(await codeOf(() => build({ name: { operator: 'ILIKE', value } }))).toBe('INVALID_FILTER_VALUE');
      }
      await expect(build({ shop: { terms: [{ path: 'name', operator: 'IEQ', value: 'a'.repeat(32762) }] } }))
        .rejects.toThrow('IEQ value on shop.name is too long: MongoDB accepts regular expressions of at most 32764 bytes, and this one has 32765');
      await expect(build({ OR: [{ conditions: [{ field: 'tags', operator: 'LIKE', value: '.'.repeat(16381) }] }] }))
        .rejects.toThrow('LIKE value on tags is too long');
    });

    test('keep path errors ahead of value errors', async () => {
      expect(await codeOf(() => build({ shop: { terms: [{ path: 'nope', operator: 'ILIKE', value: null }] } }))).toBe('INVALID_FILTER_FIELD');
      expect(await codeOf(() => build({ shop: { operator: 'ILIKE', value: 'a' } }))).toBe('MISSING_FILTER_PATH');
    });
  });

  describe('queryFeatures', () => {
    test('the adapter declares every QLOperator value, listed explicitly, and reference emptiness', () => {
      for (const adapter of [fixture.adapter, createMongoAdapter({ batchedCollections: true })]) {
        expect(adapter.queryFeatures).toEqual({ operators: [...LEGACY, ...TEXT, ...EMPTINESS, ...LIST], referenceEmptiness: true, quantifiers: true });
        expect(Object.isFrozen(adapter.queryFeatures)).toBe(true);
        expect(Object.isFrozen(adapter.queryFeatures.operators)).toBe(true);
      }
      // A QLOperator value added later fails here until the compiler and the declaration list it.
      expect(QLOperator.getValues().map((entry) => entry.value).sort()).toEqual([...fixture.adapter.queryFeatures.operators].sort());
    });

    test('every declared operator compiles on a String leaf or list', async () => {
      for (const operator of fixture.adapter.queryFeatures.operators) {
        // CONTAINS_ALL takes a list leaf.
        const field = operator === 'CONTAINS_ALL' ? 'tags' : 'name';
        const value = ['IN', 'NIN', 'BTW', ...LIST].includes(operator) ? ['a', 'b'] : EMPTINESS.includes(operator) ? undefined : 'a';
        expect(await matchOf({ [field]: { operator, value } })).toHaveProperty(field);
      }
    });

    test('a copy of the adapter without the declaration gets only the operators of 3.7.0', async () => {
      const copy = createFixture('QtmUndeclared', {
        adapter: { ...createMongoAdapter(), queryFeatures: undefined },
        preventCreatingCollection: true,
      });
      for (const operator of [...TEXT, ...EMPTINESS, ...LIST]) {
        const value = EMPTINESS.includes(operator) ? '' : LIST.includes(operator) ? ', value: ["a"]' : ', value: "a"';
        const result = await copy.execute(`{ ${copy.products}(name: {operator: ${operator}${value}}) { key } }`);
        expect(result.errors?.[0].extensions.code).toBe('UNSUPPORTED_QUERY');
      }
    });
  });
});

// Shops, products, reviews and words, stored as the generated models store them.
const SHOPS = [
  { key: 's1', name: 'North Shop', state: 'OPEN' },
  { key: 's2', name: 'south shop', state: 'Closed' },
  { key: 's3', name: 'Shop (East)', state: 'open' },
];
const PRODUCTS = [
  {
    key: 'p01', name: 'Palermo', code: 'AB-1', tags: ['Red', 'blue'], stock: 1, active: true, kind: 'one',
    dims: { label: 'Small.Box', codes: ['AB-1', 'x'] }, lines: [{ sku: 'AB-1', qty: 1, shop: 's1' }, { sku: 'cd-2', qty: 5 }], shop: 's1',
  },
  {
    key: 'p02', name: 'palermo viejo', code: 'CD-2', tags: ['RED'], stock: 2, kind: 'two',
    dims: { label: 'small*box', codes: ['ab-2'] }, lines: [{ sku: 'ab-3', qty: 2, shop: 's2' }], shop: 's2',
  },
  {
    key: 'p03', name: 'PALERMO SOHO', tags: [null, 'green'], stock: 3, kind: 'one', dims: null, lines: [null, { sku: 'X.Y', qty: 3 }], shop: 's3',
  },
  { key: 'p04', name: 'Villa Palermo', tags: [], lines: [] },
  { key: 'p05', name: '100% cotton' },
  { key: 'p06', name: 'snake_case', tags: ['re', 'darker'] },
  { key: 'p07', name: 'a.b*c+d?' },
  { key: 'p08', name: 'axb' },
  { key: 'p09', name: '^(caret)$' },
  { key: 'p10', name: '[set]{1}|\\x' },
  { key: 'p11', name: 'Café' },
  { key: 'p12', name: 'CAFÉ' },
  { key: 'p13', name: 'cafe' },
  { key: 'p14', name: 'end\n' },
  { key: 'p15', name: 'first\nsecond' },
  { key: 'p16', name: '' },
  { key: 'p17', name: null },
  { key: 'p18' },
];
const REVIEWS = [
  { author: 'Ana', rating: 5, product: 'p01' },
  { author: 'bob', rating: 3, product: 'p01' },
  { author: 'ANABEL', rating: 4, product: 'p02' },
  { author: 'Hidden Ana', rating: 1, product: 'p03' },
];
const NON_NULL_NAMES = PRODUCTS.filter((product) => typeof product.name === 'string').map((product) => product.key);

// Case folding on MongoDB: [stored, searched, whether they match, note]. IEQ is checked in both
// directions and ILIKE from the searched form. The regex `i` option applies the Unicode simple case
// folding of the server's PCRE2 build, never a length-changing, Turkic or locale-dependent folding.
// PostgreSQL gives the same answers through caseFoldExpression, except on the rows noted `postgres`,
// the limitations that #108 accepts; the shared parity test pins them on both backends.
const FOLDING = [
  ['A', 'a', true],
  ['\u00C9', '\u00E9', true], // É, é
  ['\u03A3', '\u03C3', true], // Σ, σ
  ['\u1E9E', '\u00DF', true], // ẞ, ß
  ['\u212A', 'k', true], // Kelvin sign
  ['\u212A', 'K', true],
  ['\u212B', '\u00E5', true], // Angstrom sign, å
  ['\u2126', '\u03C9', true], // Ohm sign, ω
  ['\u01C5', '\u01C6', true], // ǅ, ǆ
  ['\u01C5', '\u01C4', true], // ǅ, Ǆ
  ['\u01C8', '\u01C9', true], // ǈ, ǉ
  ['\u13A0', '\uAB70', true], // Cherokee
  ['\uFF21', '\uFF41', true], // fullwidth A, a
  ['\u{10400}', '\u{10428}', true], // Deseret, outside the Basic Multilingual Plane
  ['\uA7C0', '\uA7C1', true], // Unicode 14
  ['\u2C2F', '\u2C5F', true], // Unicode 14
  // The sigmas match each other wherever they are.
  ['\u039F\u0394\u039F\u03A3', '\u03BF\u03B4\u03BF\u03C2', true], // ΟΔΟΣ, οδος
  ['\u03A3', '\u03C2', true], // Σ, final ς
  ['\u03C3', '\u03C2', true], // σ, ς
  ['\u039F\u0394\u039F\u03A3', '\u03BF\u03B4\u03BF\u03C3', true], // ΟΔΟΣ, οδοσ
  // The lowercase variants that ICU lower() keeps, which PostgreSQL's case fold maps to their usual letters.
  ['\u00B5', '\u03BC', true], // micro sign, μ
  ['\u00B5', '\u039C', true], // micro sign, Μ
  ['\u017F', 's', true], // long s
  ['\u017F', 'S', true],
  ['\u0345', '\u03B9', true], // combining ypogegrammeni, ι
  ['\u03D0', '\u03B2', true], // ϐ, β
  ['\u03D1', '\u03B8', true], // ϑ, θ
  ['\u03D5', '\u03C6', true], // ϕ, φ
  ['\u03D6', '\u03C0', true], // ϖ, π
  ['\u03F0', '\u03BA', true], // ϰ, κ
  ['\u03F1', '\u03C1', true], // ϱ, ρ
  ['\u03F5', '\u03B5', true], // ϵ, ε
  ['\u1E9B', '\u1E61', true], // ẛ, ṡ
  ['\u1FBE', '\u03B9', true], // prosgegrammeni, ι
  ['\u1C80', '\u0432', true], // the Cyrillic variants U+1C80 to U+1C88
  ['\u1C81', '\u0434', true],
  ['\u1C82', '\u043E', true],
  ['\u1C83', '\u0441', true],
  ['\u1C84', '\u0442', true],
  ['\u1C85', '\u0442', true],
  ['\u1C86', '\u044A', true],
  ['\u1C87', '\u0463', true],
  ['\u1C88', '\uA64B', true],
  // The accepted limitations: foldings that ICU lower() applies and MongoDB does not.
  ['\u0130', 'i\u0307', false, 'postgres'], // ICU lowers İ to i followed by U+0307 COMBINING DOT ABOVE
  ['\uA7DC', '\u019B', false, 'postgres'], // Unicode 16, newer than the server's PCRE2 tables
  // Neither backend applies length-changing or Turkic foldings, apart from ICU's lowering of İ.
  ['\u0130', 'i', false, 'postgres'], // İ, which ILIKE "i" finds on PostgreSQL, in i followed by U+0307
  ['\u0130stanbul', 'istanbul', false],
  ['\u00DF', 'ss', false], // ß
  ['\u1E9E', 'ss', false], // ẞ
  ['\uFB01', 'fi', false], // ligature ﬁ
  ['\uFB05', '\uFB06', false], // ligatures ﬅ, ﬆ
  ['\u0131', 'I', false], // dotless ı
  ['\u0131', 'i', false],
  ['\u0390', '\u1FD3', false], // ΐ and its Greek Extended twin, unified only by full case folding
];

const insertData = async (fixture) => {
  const ids = {};
  const Shop = fixture.model('Shop');
  const Product = fixture.model('Product');
  const shopDocs = SHOPS.map((shop) => {
    ids[shop.key] = new mongoose.Types.ObjectId();
    return { _id: ids[shop.key], ...shop };
  });
  await Shop.collection.insertMany(shopDocs);
  const productDocs = PRODUCTS.map(({ shop, lines, ...product }) => {
    ids[product.key] = new mongoose.Types.ObjectId();
    const doc = { _id: ids[product.key], ...product };
    if (shop) doc.shop = ids[shop];
    if (lines) doc.lines = lines.map((line) => (line && line.shop ? { ...line, shop: ids[line.shop] } : line));
    return doc;
  });
  await Product.collection.insertMany(productDocs);
  await fixture.model('Review').collection.insertMany(REVIEWS.map((review) => ({ ...review, product: ids[review.product] })));
  const words = [...new Set(FOLDING.flatMap(([stored, searched]) => [stored, searched]))];
  await fixture.model('Word').collection.insertMany(words.map((text) => ({ text })));
  return ids;
};

// Generated models create their collections and indexes in the background; let them finish before
// the database is dropped, so that none is created again afterwards.
const dropDatabase = async () => {
  await Promise.allSettled(mongoose.modelNames().map((name) => mongoose.model(name).init()));
  await mongoose.connection.dropDatabase();
};

const scans = (explain) => {
  const found = [];
  const walk = (node) => {
    if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      if (node.stage === 'IXSCAN' || node.stage === 'COLLSCAN') found.push(node);
      Object.values(node).forEach(walk);
    }
  };
  walk(explain);
  return found;
};

const servers = [
  ['replica set', replicaSetUri, 'QtmRs'],
  ['standalone server', standaloneUri, 'QtmSa'],
];

describe.each(servers)('MongoDB text operators on a %s', (_label, uri, prefix) => {
  let fixture;
  let batched;
  let ids;

  const withValue = (filter) => `query($v: QLValue) { ${fixture.products}(${filter}, sort: {terms: [{field: "key", order: ASC}]}) { key } }`;
  const keys = async (filter, value, context) => {
    const source = filter.includes('$v') ? withValue(filter)
      : `{ ${fixture.products}(${filter}, sort: {terms: [{field: "key", order: ASC}]}) { key } }`;
    const data = await fixture.run(source, filter.includes('$v') ? { v: value } : undefined, context);
    return data[fixture.products].map(({ key }) => key);
  };
  const on = (field, operator) => `${field}: {operator: ${operator}, value: $v}`;
  const term = (field, path, operator) => `${field}: {terms: [{path: "${path}", operator: ${operator}, value: $v}]}`;

  beforeAll(async () => {
    if (!uri) return;
    const dbName = `${new URL(uri).pathname.slice(1)}_qtm`;
    await mongoose.connect(uri, { dbName });
    await mongoose.connection.dropDatabase();
    fixture = createFixture(prefix);
    batched = createFixture(`${prefix}Batch`, { adapter: createMongoAdapter({ batchedCollections: true, collectionBatchSize: 2 }) });
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    ids = await insertData(fixture);
    await insertData(batched);
    await fixture.model('Product').collection.createIndex({ name: 1 });
  }, 30000);

  afterAll(async () => {
    if (!uri) return;
    await dropDatabase();
    await mongoose.disconnect();
  });

  describe.skipIf(!uri)('rows', () => {
    test('each operator on a root String field', async () => {
      expect(await keys(on('name', 'ILIKE'), 'palermo')).toEqual(['p01', 'p02', 'p03', 'p04']);
      expect(await keys(on('name', 'ILIKE'), 'ALERM')).toEqual(['p01', 'p02', 'p03', 'p04']);
      expect(await keys(on('name', 'STARTS_WITH'), 'Palermo')).toEqual(['p01']);
      expect(await keys(on('name', 'ISTARTS_WITH'), 'palermo')).toEqual(['p01', 'p02', 'p03']);
      expect(await keys(on('name', 'ENDS_WITH'), 'Palermo')).toEqual(['p01', 'p04']);
      expect(await keys(on('name', 'IENDS_WITH'), 'PALERMO')).toEqual(['p01', 'p04']);
      expect(await keys(on('name', 'IEQ'), 'palermo')).toEqual(['p01']);
      // LIKE stays case-sensitive.
      expect(await keys(on('name', 'LIKE'), 'Palermo')).toEqual(['p01', 'p04']);
    });

    test('values are literal: regex metacharacters, % and _ match themselves', async () => {
      const cases = [
        ['ILIKE', '%', ['p05']],
        ['ILIKE', '_', ['p06']],
        ['ILIKE', '.', ['p07']],
        ['ILIKE', '.*', []],
        ['STARTS_WITH', 'a.b', ['p07']],
        ['ILIKE', '*C+D?', ['p07']],
        ['ENDS_WITH', 'd?', ['p07']],
        ['IEQ', 'A.B*C+D?', ['p07']],
        ['IEQ', 'a.b', []],
        ['ISTARTS_WITH', '^(', ['p09']],
        ['ENDS_WITH', ')$', ['p09']],
        ['IEQ', '^(CARET)$', ['p09']],
        ['ILIKE', '[set]{1}|', ['p10']],
        ['STARTS_WITH', '[', ['p10']],
        ['ENDS_WITH', '|\\x', ['p10']],
        ['IENDS_WITH', '\\X', ['p10']],
        ['ILIKE', '\\', ['p10']],
        ['ISTARTS_WITH', '(?i)', []],
      ];
      for (const [operator, value, expected] of cases) {
        expect(await keys(on('name', operator), value), `${operator} ${JSON.stringify(value)}`).toEqual(expected);
      }
    });

    test('an empty value matches every non-null string, and IEQ only the empty string', async () => {
      for (const operator of OPEN_ENDED) expect(await keys(on('name', operator), ''), operator).toEqual(NON_NULL_NAMES);
      expect(await keys(on('name', 'LIKE'), '')).toEqual(NON_NULL_NAMES);
      expect(await keys(on('name', 'IEQ'), '')).toEqual(['p16']);
    });

    test('\\z anchors at the very end, and ^ at the very start, without multiline matching', async () => {
      const cases = [
        ['ENDS_WITH', 'end', []],
        ['ENDS_WITH', 'end\n', ['p14']],
        ['ENDS_WITH', '\n', ['p14']],
        ['IENDS_WITH', 'END\n', ['p14']],
        ['IEQ', 'END', []],
        ['IEQ', 'END\n', ['p14']],
        ['ENDS_WITH', 'second', ['p15']],
        ['ENDS_WITH', 'first', []],
        ['STARTS_WITH', 'second', []],
        ['ISTARTS_WITH', 'FIRST\nS', ['p15']],
        ['ILIKE', 'T\nS', ['p15']],
      ];
      for (const [operator, value, expected] of cases) {
        expect(await keys(on('name', operator), value), `${operator} ${JSON.stringify(value)}`).toEqual(expected);
      }
    });

    test('case variants and accents', async () => {
      expect(await keys(on('name', 'ILIKE'), 'café')).toEqual(['p11', 'p12']);
      expect(await keys(on('name', 'IEQ'), 'CAFE')).toEqual(['p13']);
      expect(await keys(on('name', 'STARTS_WITH'), 'Caf')).toEqual(['p11']);
      expect(await keys(on('name', 'ISTARTS_WITH'), 'CAF')).toEqual(['p11', 'p12', 'p13']);
      expect(await keys(on('name', 'IENDS_WITH'), 'É')).toEqual(['p11', 'p12']);
      expect(await keys(on('name', 'ENDS_WITH'), 'é')).toEqual(['p11']);
    });

    test('String lists match when some element matches', async () => {
      expect(await keys(on('tags', 'ILIKE'), 're')).toEqual(['p01', 'p02', 'p03', 'p06']);
      expect(await keys(on('tags', 'STARTS_WITH'), 're')).toEqual(['p06']);
      expect(await keys(on('tags', 'IEQ'), 'red')).toEqual(['p01', 'p02']);
      expect(await keys(on('tags', 'ENDS_WITH'), 'en')).toEqual(['p03']);
      expect(await keys(on('tags', 'IENDS_WITH'), 'UE')).toEqual(['p01']);
      // Null elements, empty and missing lists never match.
      expect(await keys(on('tags', 'ISTARTS_WITH'), '')).toEqual(['p01', 'p02', 'p03', 'p06']);
      expect(await keys(on('tags', 'IEQ'), '')).toEqual([]);
    });

    test('embedded objects, their scalar lists and embedded lists', async () => {
      expect(await keys(term('dims', 'label', 'ILIKE'), 'small')).toEqual(['p01', 'p02']);
      expect(await keys(term('dims', 'label', 'STARTS_WITH'), 'small')).toEqual(['p02']);
      expect(await keys(term('dims', 'label', 'IEQ'), 'SMALL.BOX')).toEqual(['p01']);
      expect(await keys(term('dims', 'label', 'ENDS_WITH'), '*box')).toEqual(['p02']);
      expect(await keys(term('dims', 'label', 'IENDS_WITH'), '.BOX')).toEqual(['p01']);
      expect(await keys(term('dims', 'codes', 'ISTARTS_WITH'), 'ab-')).toEqual(['p01', 'p02']);
      expect(await keys(term('dims', 'codes', 'STARTS_WITH'), 'AB-')).toEqual(['p01']);
      expect(await keys(term('dims', 'codes', 'IEQ'), 'X')).toEqual(['p01']);
      expect(await keys(term('lines', 'sku', 'ISTARTS_WITH'), 'ab')).toEqual(['p01', 'p02']);
      expect(await keys(term('lines', 'sku', 'STARTS_WITH'), 'ab')).toEqual(['p02']);
      expect(await keys(term('lines', 'sku', 'ENDS_WITH'), '.Y')).toEqual(['p03']);
      expect(await keys(term('lines', 'sku', 'IEQ'), 'CD-2')).toEqual(['p01']);
      // Terms on an embedded list stay uncorrelated, as for every operator of 3.7.0: cd-2 has qty 5.
      expect(await keys('lines: {terms: [{path: "sku", operator: ISTARTS_WITH, value: $v}, {path: "qty", operator: LT, value: 2}]}', 'cd'))
        .toEqual(['p01']);
    });

    test('references, references inside embedded lists and collections', async () => {
      expect(await keys(term('shop', 'name', 'IENDS_WITH'), 'SHOP')).toEqual(['p01', 'p02']);
      expect(await keys(term('shop', 'name', 'ISTARTS_WITH'), 'shop (')).toEqual(['p03']);
      expect(await keys(term('shop', 'name', 'STARTS_WITH'), 'Shop')).toEqual(['p03']);
      expect(await keys(term('shop', 'name', 'ILIKE'), 'SHOP')).toEqual(['p01', 'p02', 'p03']);
      expect(await keys(term('shop', 'name', 'IEQ'), 'north shop')).toEqual(['p01']);
      expect(await keys(term('lines', 'shop.name', 'ISTARTS_WITH'), 'north')).toEqual(['p01']);
      expect(await keys(term('lines', 'shop.name', 'IENDS_WITH'), 'SOUTH SHOP')).toEqual(['p02']);
      expect(await keys(term('reviews', 'author', 'ISTARTS_WITH'), 'ana')).toEqual(['p01', 'p02']);
      expect(await keys(term('reviews', 'author', 'ILIKE'), 'ana')).toEqual(['p01', 'p02', 'p03']);
      expect(await keys(term('reviews', 'author', 'IEQ'), 'ana')).toEqual(['p01']);
      expect(await keys(term('reviews', 'author', 'ENDS_WITH'), 'Ana')).toEqual(['p01', 'p03']);
      // A collection frame keeps each matching parent once.
      expect(await keys(term('reviews', 'author', 'ISTARTS_WITH'), '')).toEqual(['p01', 'p02', 'p03']);
    });

    test('AND and OR groups', async () => {
      expect(await keys('OR: [{conditions: [{field: "name", operator: IEQ, value: "cafe"}]}, {conditions: [{field: "shop.name", operator: ISTARTS_WITH, value: $v}]}]', 'south'))
        .toEqual(['p02', 'p13']);
      expect(await keys('AND: [{conditions: [{field: "name", operator: ILIKE, value: $v}, {field: "tags", operator: IEQ, value: "red"}]}]', 'palermo'))
        .toEqual(['p01', 'p02']);
      expect(await keys('AND: [{OR: [{AND: [{conditions: [{field: "lines", path: "sku", operator: IENDS_WITH, value: $v}]}]}, {conditions: [{field: "dims.label", operator: ISTARTS_WITH, value: "SMALL"}]}]}]', '-2'))
        .toEqual(['p01', 'p02']);
    });

    test('pagination.count counts the filtered rows before paging', async () => {
      const context = {};
      const data = await fixture.run(
        `{ ${fixture.products}(name: {operator: ILIKE, value: "palermo"}, sort: {terms: [{field: "key", order: ASC}]}, pagination: {page: 1, size: 2, count: true}) { key } }`,
        undefined,
        context,
      );
      expect(data[fixture.products]).toEqual([{ key: 'p01' }, { key: 'p02' }]);
      expect(context.count).toBe(4);
      const counted = {};
      await fixture.run(`{ ${fixture.products}(reviews: {terms: [{path: "author", operator: ISTARTS_WITH, value: ""}]}, pagination: {page: 1, size: 1, count: true}) { key } }`, undefined, counted);
      expect(counted.count).toBe(3);
    });

    test('aggregate filters', async () => {
      const data = await fixture.run(`{ ${fixture.products}_aggregate(name: {operator: ISTARTS_WITH, value: "palermo"}, aggregation: {groupId: "shop.name", facts: [{operation: SUM, factName: "stock", path: "stock"}]}) { groupId facts } }`);
      expect(data[`${fixture.products}_aggregate`]).toEqual([
        { groupId: 'North Shop', facts: { stock: 1 } },
        { groupId: 'Shop (East)', facts: { stock: 3 } },
        { groupId: 'south shop', facts: { stock: 2 } },
      ]);
      const grouped = await fixture.run(`{ ${fixture.products}_aggregate(AND: [{conditions: [{field: "tags", operator: IEQ, value: "RED"}]}], aggregation: {groupId: "shop.name", facts: [{operation: COUNT, factName: "n", path: "id"}]}) { groupId facts } }`);
      expect(grouped[`${fixture.products}_aggregate`]).toEqual([
        { groupId: 'North Shop', facts: { n: 1 } },
        { groupId: 'south shop', facts: { n: 1 } },
      ]);
    });

    test('collection field arguments, read one parent at a time and batched', async () => {
      const source = (target) => `{ ${target.shops}(sort: {terms: [{field: "key", order: ASC}]}) { key products(name: {operator: ISTARTS_WITH, value: "PALERMO"}, sort: {terms: [{field: "key", order: ASC}]}) { key } } }`;
      const expected = [
        { key: 's1', products: [{ key: 'p01' }] },
        { key: 's2', products: [{ key: 'p02' }] },
        { key: 's3', products: [{ key: 'p03' }] },
      ];
      expect((await fixture.run(source(fixture)))[fixture.shops]).toEqual(expected);
      expect((await batched.run(source(batched)))[batched.shops]).toEqual(expected);
      const grouped = (target) => `{ ${target.shops}(sort: {terms: [{field: "key", order: ASC}]}) { key products(OR: [{conditions: [{field: "name", operator: IENDS_WITH, value: "VIEJO"}]}, {conditions: [{field: "tags", operator: STARTS_WITH, value: "Re"}]}]) { key } } }`;
      const groupedRows = [{ key: 's1', products: [{ key: 'p01' }] }, { key: 's2', products: [{ key: 'p02' }] }, { key: 's3', products: [] }];
      expect((await fixture.run(grouped(fixture)))[fixture.shops]).toEqual(groupedRows);
      expect((await batched.run(grouped(batched)))[batched.shops]).toEqual(groupedRows);
    });

    test('find, get_by_id and aggregate scopes, joined scopes and middleware add text conditions', async () => {
      const productScope = (args) => {
        args.AND = [...(args.AND ?? []), { conditions: [{ field: 'name', operator: 'ISTARTS_WITH', value: 'palermo' }] }];
      };
      expect(await keys(on('tags', 'IEQ'), 'red', { productScope })).toEqual(['p01', 'p02']);
      expect(await keys(on('name', 'ILIKE'), '', { productScope })).toEqual(['p01', 'p02', 'p03']);

      // The Shop scope is joined below the client's shop path.
      const shopScope = (args) => { args.state = { operator: 'IEQ', value: 'open' }; };
      expect(await keys(term('shop', 'name', 'ILIKE'), 'shop')).toEqual(['p01', 'p02', 'p03']);
      expect(await keys(term('shop', 'name', 'ILIKE'), 'shop', { shopScope })).toEqual(['p01', 'p03']);
      expect((await fixture.run(`{ ${fixture.shops}(sort: {terms: [{field: "key", order: ASC}]}) { key } }`, undefined, { shopScope }))[fixture.shops])
        .toEqual([{ key: 's1' }, { key: 's3' }]);

      const productByIdScope = (args) => { args.name = { operator: 'IENDS_WITH', value: 'PALERMO' }; };
      const byId = async (key) => (await fixture.run(`query($id: ID!) { ${fixture.lower}product(id: $id) { key } }`, { id: ids[key].toString() }, { productByIdScope }))[`${fixture.lower}product`];
      expect(await byId('p01')).toEqual({ key: 'p01' });
      expect(await byId('p02')).toBeNull();

      const productAggregateScope = (args) => {
        args.AND = [...(args.AND ?? []), { conditions: [{ field: 'name', operator: 'IEQ', value: 'PALERMO' }] }];
      };
      const aggregate = await fixture.run(`{ ${fixture.products}_aggregate(aggregation: {groupId: "shop.name", facts: [{operation: SUM, factName: "stock", path: "stock"}]}) { groupId facts } }`, undefined, { productAggregateScope });
      expect(aggregate[`${fixture.products}_aggregate`]).toEqual([{ groupId: 'North Shop', facts: { stock: 1 } }]);

      const middleware = (params) => {
        if (params.operation === 'find' && params.type?.gqltype === fixture.types.Product) params.args.code = { operator: 'STARTS_WITH', value: 'CD' };
      };
      expect(await keys(on('name', 'ILIKE'), '', { middleware })).toEqual(['p02']);
    });

    test('validated String scalars filter by their base scalar, without their checks', async () => {
      expect(await keys(on('code', 'STARTS_WITH'), 'ab')).toEqual([]);
      expect(await keys(on('code', 'ISTARTS_WITH'), 'ab')).toEqual(['p01']);
      expect(await keys(on('code', 'IENDS_WITH'), '-2')).toEqual(['p02']);
    });

    test('invalid values and fields fail with INVALID_FILTER_VALUE', async () => {
      const failures = [
        ['name: {operator: ILIKE, value: $v}', null],
        ['name: {operator: STARTS_WITH, value: $v}', 5],
        ['name: {operator: IEQ, value: $v}', ['a']],
        ['name: {operator: ISTARTS_WITH, value: $v}', 'a\u0000'],
        ['stock: {operator: ILIKE, value: $v}', '1'],
        ['kind: {operator: IEQ, value: $v}', 'ONE'],
        ['active: {operator: ISTARTS_WITH, value: $v}', 't'],
        ['id: {operator: IEQ, value: $v}', '64b7f0c2a1b2c3d4e5f60718'],
        ['shop: {terms: [{path: "id", operator: ENDS_WITH, value: $v}]}', '1'],
        ['AND: [{conditions: [{field: "lines.qty", operator: IENDS_WITH, value: $v}]}]', '1'],
      ];
      for (const [filter, value] of failures) {
        const result = await fixture.execute(withValue(filter), { v: value });
        expect(result.errors?.[0].extensions.code, filter).toBe('INVALID_FILTER_VALUE');
      }
    });

    test('the longest pattern the server accepts runs, and a longer value fails with INVALID_FILTER_VALUE, not a server error', async () => {
      for (const [operator, length] of [['ILIKE', 32764], ['IEQ', 32761], ['LIKE', 32760]]) {
        expect(await keys(on('name', operator), 'a'.repeat(length)), operator).toEqual([]);
        const result = await fixture.execute(withValue(on('name', operator)), { v: 'a'.repeat(length + 1) });
        expect(result.errors?.[0].extensions.code, operator).toBe('INVALID_FILTER_VALUE');
      }
      expect(await keys(on('tags', 'ILIKE'), '\u00e9'.repeat(16382))).toEqual([]);
      const tags = await fixture.execute(withValue(on('tags', 'ILIKE')), { v: '\u00e9'.repeat(16383) });
      expect(tags.errors?.[0].extensions.code).toBe('INVALID_FILTER_VALUE');
    });

    test('STARTS_WITH reads a prefix range of the field index; the other operators read the whole index', async () => {
      const bounds = async (operator, value) => {
        const pipeline = await fixture.adapter.buildQuery({ name: { operator, value } }, fixture.types.Product);
        const found = scans(await fixture.model('Product').aggregate(pipeline).explain('queryPlanner'));
        expect(found.length).toBeGreaterThan(0);
        return [...new Set(found.map((scan) => `${scan.stage} ${JSON.stringify(scan.indexBounds ?? null)}`))];
      };
      expect(await bounds('STARTS_WITH', 'Pal')).toEqual([`IXSCAN ${JSON.stringify({ name: ['["Pal", "Pam")', '[/^Pal/, /^Pal/]'] })}`]);
      expect(await bounds('STARTS_WITH', 'a.b')).toEqual([`IXSCAN ${JSON.stringify({ name: ['["a.b", "a.c")', '[/^a\\.b/, /^a\\.b/]'] })}`]);
      expect(await bounds('ISTARTS_WITH', 'pal')).toEqual([`IXSCAN ${JSON.stringify({ name: ['["", {})', '[/^pal/i, /^pal/i]'] })}`]);
      expect(await bounds('IEQ', 'pal')).toEqual([`IXSCAN ${JSON.stringify({ name: ['["", {})', '[/^pal\\z/i, /^pal\\z/i]'] })}`]);
      expect(await bounds('ILIKE', 'pal')).toEqual([`IXSCAN ${JSON.stringify({ name: ['["", {})', '[/pal/i, /pal/i]'] })}`]);
      expect(await bounds('ENDS_WITH', 'mo')).toEqual([`IXSCAN ${JSON.stringify({ name: ['["", {})', '[/mo\\z/, /mo\\z/]'] })}`]);
    });
  });

  describe.skipIf(!uri)('case folding', () => {
    const words = async (operator, value) => (await fixture.run(
      `query($v: QLValue) { ${fixture.lower}words(text: {operator: ${operator}, value: $v}) { text } }`,
      { v: value },
    ))[`${fixture.lower}words`].map(({ text }) => text);
    const cp = (text) => [...text].map((char) => `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`).join(' ');

    test.each(FOLDING.map(([stored, searched, folds, note]) => [cp(stored), cp(searched), folds, note ?? '', stored, searched]))(
      '%s and %s: %s %s',
      async (_stored, _searched, folds, _note, stored, searched) => {
        expect((await words('IEQ', searched)).includes(stored)).toBe(folds);
        expect((await words('IEQ', stored)).includes(searched)).toBe(folds);
        expect((await words('ILIKE', searched)).includes(stored)).toBe(folds);
      },
    );

    // PostgreSQL finds İstanbul from "i": ICU lowers İ to i followed by U+0307.
    test('"i" finds neither İstanbul nor a dotted capital I', async () => {
      expect(await words('ISTARTS_WITH', 'i')).not.toContain('\u0130stanbul');
      expect(await words('ILIKE', 'i')).not.toContain('\u0130');
      expect((await words('ISTARTS_WITH', '\u0130')).sort()).toEqual(['\u0130', '\u0130stanbul']);
    });

    // PostgreSQL returns the same words, as the parity suite checks.
    test('a final sigma folds with the other sigmas inside words', async () => {
      expect((await words('IEQ', '\u039F\u0394\u039F\u03A3')).sort())
        .toEqual(['\u039F\u0394\u039F\u03A3', '\u03BF\u03B4\u03BF\u03C2', '\u03BF\u03B4\u03BF\u03C3'].sort());
      expect((await words('IENDS_WITH', '\u03A3')).sort())
        .toEqual(['\u039F\u0394\u039F\u03A3', '\u03BF\u03B4\u03BF\u03C2', '\u03BF\u03B4\u03BF\u03C3', '\u03A3', '\u03C3', '\u03C2'].sort());
    });
  });
});
