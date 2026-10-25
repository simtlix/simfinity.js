import { readFileSync } from 'node:fs';

import { afterEach, describe, expect, it } from 'vitest';
import {
  GraphQLID, GraphQLList, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';

import { createQueryPlan, createRuntime, describeModels, resolveModelPath } from '../packages/core/src/index.js';
import { collectQueryOperators, collectQueryPathEntries } from '../packages/core/src/query-plan.js';
import {
  REFERENCE_CASES, REFERENCE_DATA, REFERENCE_SCOPES, REFERENCE_SHAPES, createEmptinessTypes,
  createReferenceEmptinessTypes, expectedReferenceRows, referenceCaseArgs, referenceQuery, registerReferenceEmptinessTypes,
  seedReferenceEmptiness, writeMongoDanglingReference,
} from './helpers/query-emptiness.js';

import { referenceOracle as oracle } from './helpers/collection-frames.js';

// Preserve the pre-frame collector contract while the collection-frame suite checks new metadata.
const legacyEntries = (entries) => entries.map((entry) => {
  const legacy = { ...entry };
  for (const key of ['use', 'container', 'frames', 'relative', 'quantifier']) delete legacy[key];
  return legacy;
});

// #108 part 2b: IS_EMPTY and IS_NOT_EMPTY through references and at references and collections. This file holds the
// core pieces that need no runtime marker and no database: the shapes and their scope paths, the adapter feature, the
// limit option, what the collectors return for the marker, how createQueryPlan lifts a filled marker into `scopes`, and
// the shared fixture with its expected rows. The runtime marker is tested in reference-emptiness-runtime.test.js, and
// each backend's forms with that backend.

// Loaded on use, so that each test fails on its own where a module lacks a name.
const OPERATORS_MODULE = '@simtlix/simfinity-core/internal/query-operators';
const loadOperators = () => import(/* @vite-ignore */ OPERATORS_MODULE);
const LIMITS_MODULE = '../packages/core/src/query-limits.js';
const loadLimits = () => import(/* @vite-ignore */ LIMITS_MODULE);

const errorOf = (body) => {
  try {
    body();
  } catch (error) {
    return error;
  }
  return null;
};
const codeOf = (body) => {
  const error = errorOf(body);
  return error ? error.extensions?.code ?? error.message : null;
};
const outcomeOf = (body) => {
  const error = errorOf(body);
  return error ? [error.extensions?.code, error.extensions?.status, error.message] : null;
};

const ALL = [
  'EQ', 'LT', 'GT', 'LTE', 'GTE', 'BTW', 'NE', 'IN', 'NIN', 'LIKE', 'ILIKE', 'STARTS_WITH', 'ISTARTS_WITH', 'ENDS_WITH',
  'IENDS_WITH', 'IEQ', 'IS_EMPTY', 'IS_NOT_EMPTY',
];
const NOT_SUPPORTED = 'the database adapter does not support emptiness through references and collections';

const types = createReferenceEmptinessTypes('Qs', { backend: 'postgres' });
const registrations = [types.Shop, types.Pro, types.Product, types.Review].map((gqltype) => ({ gqltype }))
  .concat(types.embedded.map((gqltype) => ({ gqltype, endpoint: false })));
const models = describeModels(registrations);
// The same description without GraphQL types, as a hand-built description may come.
const untypedModels = { entities: models.entities.map((entity) => Object.fromEntries(Object.entries(entity).filter(([key]) => key !== 'gqltype'))) };
const typeOf = { product: types.Product, review: types.Review, shop: types.Shop };
const entityOf = { product: 'QsProduct', review: 'QsReview', shop: 'QsShop' };

const STRING = { rule: 'string' };
const NULL = { rule: 'null' };
const LIST = { rule: 'list' };
const ref = (target) => ({ rule: 'reference', target });
const coll = (target, connectionField) => ({ rule: 'collection', target, connectionField });
const object = (members) => ({ rule: 'object', members: Object.entries(members).map(([name, shape]) => ({ name, shape })) });
// A shape whose path crosses the given single references, each `path:Target`.
const through = (shape, ...crossings) => ({
  ...shape,
  crossings: crossings.map((crossing) => {
    const [path, target] = crossing.split(':');
    return { path, target };
  }),
});
const ODIM = object({ w: NULL, shop: ref('QsShop') });

// Every row of spec section 1 on the fixture, with its shape: references and collections at the end, leaves and ends
// through single references, the record identity after a reference (Shop declares `id: String`), and members.
const SHAPES = [
  ['product', 'shop', ref('QsShop')],
  ['product', 'shop.id', through(NULL, 'shop:QsShop')],
  ['product', 'shop.name', through(STRING, 'shop:QsShop')],
  ['product', 'shop.state', through(STRING, 'shop:QsShop')],
  ['product', 'shop.minStock', through(NULL, 'shop:QsShop')],
  ['product', 'shop.products', through(coll('QsProduct', 'shop'), 'shop:QsShop')],
  // The collection reads the child's storage column, productId, not the declared name, product.
  ['product', 'reviews', coll('QsReview', 'productId')],
  ['product', 'pro', ref('QsPro')],
  ['product', 'pro.id', through(NULL, 'pro:QsPro')],
  ['product', 'pro.name', through(STRING, 'pro:QsPro')],
  ['product', 'pro.shop', through(ref('QsShop'), 'pro:QsPro')],
  ['product', 'pro.shop.id', through(NULL, 'pro:QsPro', 'pro.shop:QsShop')],
  ['product', 'pro.shop.state', through(STRING, 'pro:QsPro', 'pro.shop:QsShop')],
  ['product', 'pro.shop.products', through(coll('QsProduct', 'shop'), 'pro:QsPro', 'pro.shop:QsShop')],
  ['product', 'odim', ODIM],
  ['product', 'odim.shop', ref('QsShop')],
  ['product', 'odim.shop.id', through(NULL, 'odim.shop:QsShop')],
  ['product', 'odim.shop.state', through(STRING, 'odim.shop:QsShop')],
  ['review', 'product', ref('QsProduct')],
  ['review', 'product.shop', through(ref('QsShop'), 'product:QsProduct')],
  ['review', 'product.shop.state', through(STRING, 'product:QsProduct', 'product.shop:QsShop')],
  ['review', 'product.odim', through(ODIM, 'product:QsProduct')],
  ['review', 'product.reviews', through(coll('QsReview', 'productId'), 'product:QsProduct')],
  ['shop', 'products', coll('QsProduct', 'shop')],
];
// The record's own fields keep their 2a shapes, without crossings; the root identity is declared String on Shop.
const OWN_SHAPES = [
  ['product', 'odim.w', NULL], ['product', 'olines', LIST], ['product', 'id', NULL], ['product', 'name', STRING], ['shop', 'id', NULL],
];
// The permanent rules keep their codes.
const PERMANENT = [
  ['product', 'olines.shop', 'INVALID_FILTER_PATH'], ['product', 'olines.qty', 'INVALID_FILTER_PATH'],
  ['product', 'reviews.rating', 'INVALID_FILTER_PATH'], ['product', 'shop.products.name', 'INVALID_FILTER_PATH'],
  ['product', 'pro.shop.products.stock', 'INVALID_FILTER_PATH'], ['product', 'shop.nope', 'INVALID_FILTER_FIELD'],
  ['product', 'pro.name.x', 'INVALID_FILTER_PATH'], ['shop', 'products.shop', 'INVALID_FILTER_PATH'],
];

// Types that describeModels rejects or that need no entity: a collection member inside an embedded type (MongoDB's
// default mode), with and without a declared connectionField, and a reference member one level down.
const Child = new GraphQLObjectType({
  name: 'QsChild',
  fields: () => ({ id: { type: GraphQLID }, parent: { type: Holder, extensions: { relation: { embedded: false, connectionField: 'parentRef' } } } }),
});
const Box = new GraphQLObjectType({
  name: 'QsBox',
  fields: () => ({
    title: { type: GraphQLString },
    // Declares the GraphQL name of Child.parent, which stores itself as parentRef.
    children: { type: new GraphQLList(Child), extensions: { relation: { embedded: false, connectionField: 'parent' } } },
    // No connectionField: the collection reads through its own field name.
    loose: { type: new GraphQLList(Child), extensions: { relation: { embedded: false } } },
  }),
});
const Deep = new GraphQLObjectType({ name: 'QsDeep', fields: () => ({ owner: { type: Child, extensions: { relation: { embedded: false } } }, n: { type: GraphQLString } }) });
const Mid = new GraphQLObjectType({ name: 'QsMid', fields: () => ({ x: { type: GraphQLString }, deep: { type: Deep, extensions: { relation: { embedded: true } } } }) });
const Holder = new GraphQLObjectType({
  name: 'QsHolder',
  fields: () => ({
    id: { type: GraphQLID },
    box: { type: Box, extensions: { relation: { embedded: true } } },
    mid: { type: Mid, extensions: { relation: { embedded: true } } },
  }),
});

// The 2a fixture, whose Item has embedded `id` members and whose Review references Item.
const fixture2a = createEmptinessTypes('Qt', { backend: 'postgres' });

describe('shapes of reference and collection emptiness', () => {
  it.each(SHAPES)('describes %s %s from GraphQL types and from model descriptions alike', async (root, path, shape) => {
    const { describeEmptiness, describeModelEmptiness } = await loadOperators();
    for (const operator of ['IS_EMPTY', 'IS_NOT_EMPTY']) {
      expect(describeEmptiness(typeOf[root], path.split('.'), { operator })).toEqual(shape);
      expect(describeEmptiness(typeOf[root], path, { operator, value: null, referenceEmptiness: true })).toEqual(shape);
      expect(describeModelEmptiness(resolveModelPath(models, entityOf[root], path), { operator })).toEqual(shape);
    }
  });

  it.each(OWN_SHAPES)('keeps the 2a shape of %s %s (regression pin, passes on 3.10.0)', async (root, path, shape) => {
    const { describeEmptiness, describeModelEmptiness } = await loadOperators();
    for (const referenceEmptiness of [undefined, true, false]) {
      expect(describeEmptiness(typeOf[root], path.split('.'), { operator: 'IS_EMPTY', referenceEmptiness })).toEqual(shape);
      expect(describeModelEmptiness(resolveModelPath(models, entityOf[root], path), { operator: 'IS_NOT_EMPTY', referenceEmptiness })).toEqual(shape);
    }
  });

  it.each(PERMANENT)('keeps the permanent code of %s %s (regression pin, passes on 3.10.0)', async (root, path, code) => {
    const { describeEmptiness, describeModelEmptiness } = await loadOperators();
    for (const referenceEmptiness of [true, false]) {
      expect(codeOf(() => describeEmptiness(typeOf[root], path.split('.'), { operator: 'IS_EMPTY', referenceEmptiness }))).toBe(code);
      if (code !== 'INVALID_FILTER_FIELD') {
        const steps = errorOf(() => resolveModelPath(models, entityOf[root], path)) ?? resolveModelPath(models, entityOf[root], path);
        if (Array.isArray(steps)) expect(codeOf(() => describeModelEmptiness(steps, { operator: 'IS_EMPTY', referenceEmptiness }))).toBe(code);
      }
    }
  });

  it('applies the value rule to references and collections, after rule 3 (regression pin, passes on 3.10.0)', async () => {
    const { describeEmptiness } = await loadOperators();
    for (const path of ['shop', 'reviews', 'odim', 'pro.shop', 'shop.state']) {
      for (const value of ['', 'x', 0, false, [], {}]) {
        expect(codeOf(() => describeEmptiness(types.Product, path.split('.'), { operator: 'IS_EMPTY', value })), `${path} ${JSON.stringify(value)}`).toBe('INVALID_FILTER_VALUE');
      }
    }
    expect(codeOf(() => describeEmptiness(types.Product, ['olines', 'shop'], { operator: 'IS_EMPTY', value: 'x' }))).toBe('INVALID_FILTER_PATH');
  });

  it('keeps an embedded id member under its declared scalar after a reference, and the null rule for the identity there', async () => {
    const { describeEmptiness, describeModelEmptiness } = await loadOperators();
    const models2a = describeModels([fixture2a.Item, fixture2a.Shop, fixture2a.Review, fixture2a.Sid, ...Object.values(fixture2a.owned)]
      .map((gqltype) => ({ gqltype })).concat(fixture2a.embedded.map((gqltype) => ({ gqltype, endpoint: false }))));
    const item = 'item:QtItem';
    for (const [path, shape] of [
      ['item.id', through(NULL, item)], ['item.sident', through(object({ id: STRING, label: STRING }), item)],
      ['item.sident.id', through(STRING, item)], ['item.ident.id', through(NULL, item)], ['item.note', through(STRING, item)],
      ['item.shop.id', through(NULL, item, 'item.shop:QtShop')],
    ]) {
      expect(describeEmptiness(fixture2a.Review, path.split('.'), { operator: 'IS_EMPTY' }), path).toEqual(shape);
      expect(describeModelEmptiness(resolveModelPath(models2a, 'QtReview', path), { operator: 'IS_EMPTY' }), path).toEqual(shape);
    }
  });

  it('describes a collection member inside an embedded type with the storage column of its connectionField', async () => {
    const { describeEmptiness } = await loadOperators();
    const box = object({ title: STRING, children: coll('QsChild', 'parentRef'), loose: coll('QsChild', 'loose') });
    expect(describeEmptiness(Holder, ['box'], { operator: 'IS_EMPTY' })).toEqual(box);
    expect(describeEmptiness(Holder, ['box', 'children'], { operator: 'IS_NOT_EMPTY' })).toEqual(coll('QsChild', 'parentRef'));
    expect(describeEmptiness(Holder, ['mid'], { operator: 'IS_EMPTY' })).toEqual(object({ x: STRING, deep: object({ owner: ref('QsChild'), n: STRING }) }));
    expect(codeOf(() => describeEmptiness(Holder, ['box', 'children', 'id'], { operator: 'IS_EMPTY' }))).toBe('INVALID_FILTER_PATH');
  });

  it('keeps rule 6 as UNSUPPORTED_QUERY, reworded, when the caller does not support reference emptiness', async () => {
    const { describeEmptiness, describeModelEmptiness } = await loadOperators();
    const message = (root, path, operator = 'IS_EMPTY') => errorOf(() => describeEmptiness(typeOf[root], path.split('.'), { operator, path, referenceEmptiness: false }));
    for (const [root, path, text] of [
      ['product', 'shop', 'IS_EMPTY on shop ends at the reference shop'],
      ['product', 'shop.state', 'IS_EMPTY on shop.state crosses the reference shop'],
      ['product', 'pro.shop.id', 'IS_EMPTY on pro.shop.id crosses the reference pro'],
      ['product', 'reviews', 'IS_EMPTY on reviews ends at the collection reviews'],
      ['product', 'odim', 'IS_EMPTY on odim reads the reference member odim.shop'],
      ['shop', 'products', 'IS_EMPTY on products ends at the collection products'],
    ]) {
      expect(message(root, path)).toMatchObject({ message: `${text}: ${NOT_SUPPORTED}`, extensions: { code: 'UNSUPPORTED_QUERY', status: 400 } });
      const steps = resolveModelPath(models, entityOf[root], path);
      expect(errorOf(() => describeModelEmptiness(steps, { operator: 'IS_EMPTY', path, referenceEmptiness: false })).message).toBe(`${text}: ${NOT_SUPPORTED}`);
    }
    expect(errorOf(() => describeEmptiness(Holder, ['box'], { operator: 'IS_NOT_EMPTY', referenceEmptiness: false })).message)
      .toBe(`IS_NOT_EMPTY on box reads the collection member box.children: ${NOT_SUPPORTED}`);
    // The value still comes first, and own fields are unaffected.
    expect(codeOf(() => describeEmptiness(types.Product, ['shop'], { operator: 'IS_EMPTY', value: 'x', referenceEmptiness: false }))).toBe('INVALID_FILTER_VALUE');
    expect(describeEmptiness(types.Product, ['odim', 'w'], { operator: 'IS_EMPTY', referenceEmptiness: false })).toEqual(NULL);
  });
});

describe('emptinessScopePaths', () => {
  const scopePathsOf = async (root, path) => {
    const { describeEmptiness, emptinessScopePaths } = await loadOperators();
    return emptinessScopePaths(describeEmptiness(typeOf[root], path.split('.'), { operator: 'IS_EMPTY' }), path);
  };

  it('lists the crossings as joins and the ends and members as frames, from the queried type', async () => {
    for (const [root, path, joins, frames] of [
      ['product', 'shop', [], ['shop']],
      ['product', 'shop.id', ['shop'], []],
      ['product', 'shop.state', ['shop'], []],
      ['product', 'shop.products', ['shop'], ['shop.products']],
      ['product', 'reviews', [], ['reviews']],
      ['product', 'pro.shop', ['pro'], ['pro.shop']],
      ['product', 'pro.shop.state', ['pro', 'pro.shop'], []],
      ['product', 'pro.shop.products', ['pro', 'pro.shop'], ['pro.shop.products']],
      ['product', 'odim', [], ['odim.shop']],
      ['product', 'odim.shop', [], ['odim.shop']],
      ['product', 'odim.shop.state', ['odim.shop'], []],
      ['review', 'product.odim', ['product'], ['product.odim.shop']],
      ['product', 'odim.w', [], []],
      ['product', 'stock', [], []],
    ]) {
      expect(await scopePathsOf(root, path), `${root} ${path}`).toEqual({ joins, frames });
    }
  });

  it('lists members at any depth, takes the path as an array or a string, and never reads anything else', async () => {
    const { describeEmptiness, emptinessScopePaths } = await loadOperators();
    const holder = (path) => describeEmptiness(Holder, path.split('.'), { operator: 'IS_EMPTY' });
    expect(emptinessScopePaths(holder('box'), ['box'])).toEqual({ joins: [], frames: ['box.children', 'box.loose'] });
    expect(emptinessScopePaths(holder('mid'), 'mid')).toEqual({ joins: [], frames: ['mid.deep.owner'] });
    expect(emptinessScopePaths({ rule: 'string' }, 'note')).toEqual({ joins: [], frames: [] });
    expect(emptinessScopePaths(null, 'note')).toEqual({ joins: [], frames: [] });
  });

  it('names the target type of each join and frame', async () => {
    const { describeEmptiness, emptinessScopeTargets } = await loadOperators();
    const targetsOf = (root, path) => emptinessScopeTargets(describeEmptiness(typeOf[root], path.split('.'), { operator: 'IS_EMPTY' }), path);
    expect(targetsOf('product', 'pro.shop')).toEqual({ pro: 'QsPro', 'pro.shop': 'QsShop' });
    expect(targetsOf('product', 'pro.shop.state')).toEqual({ pro: 'QsPro', 'pro.shop': 'QsShop' });
    expect(targetsOf('product', 'odim')).toEqual({ 'odim.shop': 'QsShop' });
    expect(targetsOf('product', 'reviews')).toEqual({ reviews: 'QsReview' });
    expect(targetsOf('review', 'product.odim')).toEqual({ product: 'QsProduct', 'product.odim.shop': 'QsShop' });
    expect(Object.keys(targetsOf('product', 'shop.products'))).toEqual(['shop', 'shop.products']);
    expect(targetsOf('product', 'stock')).toEqual({});
  });

  it('gives what the reference frame limit counts: distinct joins and frames per path', async () => {
    const count = async (paths) => {
      const pairs = new Set();
      for (const path of paths) {
        const { joins, frames } = await scopePathsOf('product', path);
        for (const join of joins) pairs.add(`join:${join}`);
        for (const frame of frames) pairs.add(`frame:${frame}`);
      }
      return pairs.size;
    };
    expect(await count(['shop', 'shop.state'])).toBe(2);
    expect(await count(['shop.state', 'shop.name'])).toBe(1);
    expect(await count(['pro.shop', 'pro.shop.state'])).toBe(3);
    expect(await count(['odim', 'odim.shop', 'odim.shop.state'])).toBe(2);
  });
});

describe('queryFeatures.referenceEmptiness', () => {
  const adapter = {
    bind() {},
    prepare() {},
    createModel: (gqltype) => ({ name: gqltype.name }),
    castId: String,
    withTransaction: async (session, body) => body(session || {}),
    getById: async () => null,
    find: async () => [],
    count: async () => 0,
    aggregate: async () => [],
    findChildren: async () => [],
  };

  it('reads it as a boolean next to the operators, false without a declaration', async () => {
    const { resolveQueryFeatures } = await loadOperators();
    expect(resolveQueryFeatures(undefined).referenceEmptiness).toBe(false);
    expect(resolveQueryFeatures(null).referenceEmptiness).toBe(false);
    for (const [declared, expected] of [[true, true], [false, false], [undefined, false], [null, false]]) {
      const features = resolveQueryFeatures({ operators: ['IS_EMPTY', 'BAD'], referenceEmptiness: declared });
      expect(features.referenceEmptiness, String(declared)).toBe(expected);
      expect([...features.operators]).toEqual(['IS_EMPTY']);
    }
    expect(resolveQueryFeatures({ operators: [] }).referenceEmptiness).toBe(false);
  });

  it('rejects any other value with INVALID_QUERY_FEATURES (500), in createRuntime too', async () => {
    const { resolveQueryFeatures } = await loadOperators();
    for (const value of ['true', 1, 0, '', {}, [], [true], () => true]) {
      expect(outcomeOf(() => resolveQueryFeatures({ operators: ['EQ'], referenceEmptiness: value })), String(value))
        .toEqual(['INVALID_QUERY_FEATURES', 500, 'DatabaseAdapter queryFeatures referenceEmptiness must be a boolean']);
      expect(codeOf(() => createRuntime({ ...adapter, queryFeatures: { operators: ['EQ'], referenceEmptiness: value } }))).toBe('INVALID_QUERY_FEATURES');
    }
    // The operators are checked first, and other members are still left for later features.
    expect(errorOf(() => resolveQueryFeatures({ operators: 'EQ', referenceEmptiness: 'x' })).message)
      .toBe('DatabaseAdapter queryFeatures operators must be an array of operator names');
    expect(resolveQueryFeatures({ operators: ['EQ'], valuePath: 'x', referenceEmptiness: true }).referenceEmptiness).toBe(true);
    expect(() => createRuntime({ ...adapter, queryFeatures: { operators: ['EQ'], referenceEmptiness: true } })).not.toThrow();
  });

  // The packed TypeScript check in scripts/test-packages.js compiles the declaration; this reads its text without
  // packing, so that the type admits every value createRuntime accepts, under exactOptionalPropertyTypes as well.
  it('declares null and undefined in QueryFeatures, as createRuntime accepts them', () => {
    for (const referenceEmptiness of [null, undefined]) {
      expect(() => createRuntime({ ...adapter, queryFeatures: { operators: ['EQ'], referenceEmptiness } }), String(referenceEmptiness)).not.toThrow();
    }
    const declarations = readFileSync(new URL('../packages/core/types/index.d.ts', import.meta.url), 'utf8');
    const features = declarations.match(/^export interface QueryFeatures \{\n([\s\S]*?)^\}/m)?.[1];
    expect(features).toBeTypeOf('string');
    expect(features.match(/^ {2}referenceEmptiness\?: .*$/gm)).toEqual(['  referenceEmptiness?: boolean | null | undefined;']);
  });
});

describe('configureQueryLimits({ maxReferenceFrames })', () => {
  afterEach(async () => (await loadLimits()).configureQueryLimits());

  it('defaults to 10, takes a positive safe integer, and restores the default when a later call omits it', async () => {
    const { configureQueryLimits, getQueryMaxPageSize, getQueryMaxReferenceFrames } = await loadLimits();
    configureQueryLimits();
    expect(getQueryMaxReferenceFrames()).toBe(10);
    configureQueryLimits({ maxReferenceFrames: 3 });
    expect([getQueryMaxReferenceFrames(), getQueryMaxPageSize()]).toEqual([3, 1000]);
    configureQueryLimits({ maxReferenceFrames: 1, maxPageSize: 7 });
    expect([getQueryMaxReferenceFrames(), getQueryMaxPageSize()]).toEqual([1, 7]);
    configureQueryLimits({ maxReferenceFrames: Number.MAX_SAFE_INTEGER });
    expect(getQueryMaxReferenceFrames()).toBe(Number.MAX_SAFE_INTEGER);
    configureQueryLimits({ maxPageSize: 50 });
    expect([getQueryMaxReferenceFrames(), getQueryMaxPageSize()]).toEqual([10, 50]);
    configureQueryLimits({});
    expect([getQueryMaxReferenceFrames(), getQueryMaxPageSize()]).toEqual([10, 1000]);
  });

  it('rejects anything else with INVALID_QUERY_LIMITS (400) and keeps both limits', async () => {
    const { configureQueryLimits, getQueryMaxPageSize, getQueryMaxReferenceFrames } = await loadLimits();
    configureQueryLimits({ maxPageSize: 20, maxReferenceFrames: 4 });
    for (const value of [0, -1, 1.5, '10', null, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, 10n, true]) {
      expect(outcomeOf(() => configureQueryLimits({ maxPageSize: 30, maxReferenceFrames: value })), String(value))
        .toEqual(['INVALID_QUERY_LIMITS', 400, 'maxReferenceFrames must be a positive safe integer']);
      expect([getQueryMaxPageSize(), getQueryMaxReferenceFrames()], String(value)).toEqual([20, 4]);
    }
    // A bad maxPageSize keeps maxReferenceFrames too.
    expect(codeOf(() => configureQueryLimits({ maxPageSize: 0, maxReferenceFrames: 6 }))).toBe('INVALID_QUERY_LIMITS');
    expect([getQueryMaxPageSize(), getQueryMaxReferenceFrames()]).toEqual([20, 4]);
  });
});

describe('collectors for the client scope marker', () => {
  it('gives each condition the term or group condition that holds it, and whether it is an emptiness condition', () => {
    const term = { path: 'shop', operator: 'IS_EMPTY' };
    const pathless = { operator: 'IS_NOT_EMPTY' };
    const legacy = { path: 'name', value: 'S1' };
    const condition = { field: 'pro', path: 'shop.state', operator: 'IS_EMPTY' };
    const nestedCondition = { field: 'shop', operator: 'EQ', value: null };
    const args = {
      stock: { operator: 'IS_EMPTY' },
      pro: { terms: [term, legacy] },
      shop: { operator: 'IS_EMPTY', terms: [pathless] },
      AND: [{ conditions: [condition], OR: [{ conditions: [nestedCondition] }] }],
      sort: { terms: [{ field: 'shop.name', order: 'ASC' }] },
    };
    expect(collectQueryOperators(args).map(({
      path, form, construct, emptiness,
    }) => ({
      path, form, construct, emptiness,
    }))).toEqual([
      {
        path: 'stock', form: 'filter', construct: null, emptiness: true,
      },
      {
        path: 'pro.shop', form: 'term', construct: term, emptiness: true,
      },
      {
        path: 'pro.name', form: 'term', construct: legacy, emptiness: false,
      },
      {
        path: 'shop', form: 'beside-terms', construct: null, emptiness: true,
      },
      {
        path: 'shop', form: 'term', construct: pathless, emptiness: true,
      },
      {
        path: 'pro.shop.state', form: 'condition', construct: condition, emptiness: true,
      },
      {
        path: 'shop', form: 'condition', construct: nestedCondition, emptiness: false,
      },
    ]);
    // The constructs are the argument objects themselves, never copies.
    const entries = collectQueryOperators(args);
    expect(entries[1].construct).toBe(term);
    expect(entries[5].construct).toBe(condition);
    expect(collectQueryOperators({ aggregation: { operator: 'IS_EMPTY' } }, 'aggregate')).toEqual([]);
  });

  it('pin: gives each path entry its operator and construct, members included', () => {
    const term = { path: 'shop', operator: 'IS_EMPTY' };
    const legacy = { path: 'name', value: 'S1' };
    const pathless = { operator: 'IS_EMPTY' };
    const condition = { field: 'odim', operator: 'IS_NOT_EMPTY' };
    const legacyCondition = { field: 'shop', path: 'name', operator: 'NE', value: 'x' };
    const args = {
      stock: { operator: 'LT', value: 3 },
      pro: { terms: [term, legacy] },
      shop: { terms: [pathless] },
      AND: [{ conditions: [condition, legacyCondition] }],
      sort: { terms: [{ field: 'shop.name', order: 'ASC' }] },
    };
    const group = args.AND[0];
    const entries = collectQueryPathEntries(args, 'find', { gqltype: types.Product, expandMembers: true });
    expect(legacyEntries(entries)).toEqual([
      {
        segments: ['stock'], group: null, operator: 'LT', construct: null,
      },
      {
        segments: ['pro', 'shop'], group: null, operator: 'IS_EMPTY', construct: term,
      },
      {
        segments: ['pro', 'name'], group: null, operator: 'EQ', construct: legacy,
      },
      {
        segments: ['shop'], group: null, operator: 'IS_EMPTY', construct: pathless,
      },
      {
        segments: ['odim'], group, operator: 'IS_NOT_EMPTY', construct: condition,
      },
      {
        segments: ['odim', 'w'], group, operator: 'IS_NOT_EMPTY', construct: condition, member: true,
      },
      {
        segments: ['odim', 'shop'], group, operator: 'IS_NOT_EMPTY', construct: condition, member: true,
      },
      {
        segments: ['shop', 'name'], group, operator: 'NE', construct: legacyCondition,
      },
      {
        segments: ['shop', 'name'], group: null, operator: null, construct: null,
      },
    ]);
    expect(entries[1].construct).toBe(term);
    expect(entries[5].construct).toBe(condition);
    expect(legacyEntries(collectQueryPathEntries({ aggregation: { groupId: 'shop.name', facts: [{ path: 'stock' }] } }, 'aggregate'))).toEqual([
      {
        segments: ['shop', 'name'], group: null, operator: null, construct: null,
      },
      {
        segments: ['stock'], group: null, operator: null, construct: null,
      },
    ]);
  });
});

describe('createQueryPlan with reference emptiness', () => {
  const plan = (input, options) => createQueryPlan(models, 'QsProduct', input, options);
  const predicate = (path, operator, extra = {}) => ({
    kind: 'predicate', path: path.split('.'), operator, value: null, ...extra,
  });
  const condition = (field, path, operator, value) => ({
    field, ...(path ? { path } : {}), operator, ...(value === undefined ? {} : { value }),
  });
  const scopeOf = (field, operator, value) => ({ AND: [{ conditions: [condition(field, null, operator, value)] }] });
  const marked = (construct, scopes, id = 0) => ({ ...construct, __scope: { id, scopes } });

  it('plans emptiness through references with stored semantics, without scopes, by default', () => {
    const result = plan({
      shop: { terms: [{ operator: 'IS_EMPTY' }, { path: 'state', operator: 'IS_NOT_EMPTY' }] },
      pro: { terms: [{ path: 'shop.id', operator: 'IS_EMPTY' }] },
      AND: [{ conditions: [condition('odim', null, 'IS_EMPTY'), condition('reviews', '', 'IS_NOT_EMPTY'), condition('shop', 'products', 'IS_EMPTY')] }],
    });
    expect(result.where).toEqual({
      kind: 'and',
      terms: [
        predicate('shop', 'IS_EMPTY'), predicate('shop.state', 'IS_NOT_EMPTY'), predicate('pro.shop.id', 'IS_EMPTY'),
        { kind: 'and', terms: [predicate('odim', 'IS_EMPTY'), predicate('reviews', 'IS_NOT_EMPTY'), predicate('shop.products', 'IS_EMPTY')] },
      ],
    });
    expect(createQueryPlan(untypedModels, 'QsProduct', { shop: { terms: [{ operator: 'IS_EMPTY' }] } }).where).toEqual(predicate('shop', 'IS_EMPTY'));
  });

  it('defaults referenceEmptiness to true without operators and to false with them, as the adapters declare it', () => {
    const input = { shop: { terms: [{ path: 'state', operator: 'IS_EMPTY' }] } };
    const rejected = ['UNSUPPORTED_QUERY', 400, `IS_EMPTY on shop.state crosses the reference shop: ${NOT_SUPPORTED}`];
    expect(plan(input).where).toEqual(predicate('shop.state', 'IS_EMPTY'));
    expect(outcomeOf(() => plan(input, { operators: ALL }))).toEqual(rejected);
    expect(outcomeOf(() => plan(input, { referenceEmptiness: false }))).toEqual(rejected);
    expect(outcomeOf(() => plan(input, { operators: ALL, referenceEmptiness: null }))).toEqual(rejected);
    expect(plan(input, { operators: ALL, referenceEmptiness: true }).where).toEqual(predicate('shop.state', 'IS_EMPTY'));
    expect(outcomeOf(() => createQueryPlan(untypedModels, 'QsProduct', input, { operators: ALL }))).toEqual(rejected);
    // Own fields plan either way.
    expect(plan({ odim: { terms: [{ path: 'w', operator: 'IS_EMPTY' }] } }, { operators: ALL }).where).toEqual(predicate('odim.w', 'IS_EMPTY'));
  });

  it('lifts a filled marker into scopes, one key per join and frame, each planned on its target type', () => {
    const shopScope = scopeOf('name', 'NE', 'S2');
    const proScope = { name: { operator: 'EQ', value: 'P1' } };
    const result = plan({
      pro: { terms: [marked({ path: 'shop.state', operator: 'IS_EMPTY' }, { pro: proScope, 'pro.shop': null })] },
      shop: { terms: [marked({ operator: 'IS_NOT_EMPTY' }, { shop: shopScope }, 1)] },
      AND: [{
        conditions: [
          marked(condition('odim', null, 'IS_EMPTY'), { 'odim.shop': scopeOf('state', 'EQ', 'OPEN') }, 2),
          marked(condition('reviews', null, 'IS_NOT_EMPTY'), { reviews: scopeOf('author', 'NE', 'hidden') }, 3),
          marked(condition('shop', 'products', 'IS_EMPTY'), { shop: null, 'shop.products': null }, 4),
        ],
      }],
    });
    expect(result.where).toEqual({
      kind: 'and',
      terms: [
        predicate('pro.shop.state', 'IS_EMPTY', { scopes: { pro: { kind: 'predicate', path: ['name'], operator: 'EQ', value: 'P1' }, 'pro.shop': null } }),
        predicate('shop', 'IS_NOT_EMPTY', { scopes: { shop: { kind: 'predicate', path: ['name'], operator: 'NE', value: 'S2' } } }),
        {
          kind: 'and',
          terms: [
            predicate('odim', 'IS_EMPTY', { scopes: { 'odim.shop': { kind: 'predicate', path: ['state'], operator: 'EQ', value: 'OPEN' } } }),
            predicate('reviews', 'IS_NOT_EMPTY', { scopes: { reviews: { kind: 'predicate', path: ['author'], operator: 'NE', value: 'hidden' } } }),
            predicate('shop.products', 'IS_EMPTY', { scopes: { shop: null, 'shop.products': null } }),
          ],
        },
      ],
    });
    expect(Object.keys(result.where.terms[0])).toEqual(['kind', 'path', 'operator', 'value', 'scopes']);
    expect(Object.keys(result.where.terms[0].scopes)).toEqual(['pro', 'pro.shop']);
  });

  it('lifts only the keys of each position, plans scopes as trusted arguments, and gives the same plan without GraphQL types', () => {
    // A marker aliased at two positions holds the union of their keys.
    const scopes = { shop: scopeOf('name', 'NE', 'S2'), pro: null, 'pro.shop': scopeOf('state', 'EQ', 'OPEN') };
    // A scope's own emptiness through references and its sort and pagination are trusted: planned without scopes.
    const shopScope = {
      AND: [{ conditions: [condition('products', null, 'IS_NOT_EMPTY'), condition('name', null, 'IS_NOT_EMPTY')] }],
      sort: { terms: [{ field: 'name', order: 'ASC' }] },
      pagination: { page: 1, size: 5 },
    };
    const input = {
      shop: { terms: [marked({ operator: 'IS_EMPTY' }, scopes)] },
      pro: { terms: [marked({ path: 'shop', operator: 'IS_EMPTY' }, scopes)] },
      AND: [{ conditions: [marked(condition('shop', 'state', 'IS_EMPTY'), { shop: shopScope })] }],
    };
    const expected = {
      kind: 'and',
      terms: [
        predicate('shop', 'IS_EMPTY', { scopes: { shop: { kind: 'predicate', path: ['name'], operator: 'NE', value: 'S2' } } }),
        predicate('pro.shop', 'IS_EMPTY', { scopes: { pro: null, 'pro.shop': { kind: 'predicate', path: ['state'], operator: 'EQ', value: 'OPEN' } } }),
        predicate('shop.state', 'IS_EMPTY', {
          scopes: { shop: { kind: 'and', terms: [predicate('products', 'IS_NOT_EMPTY'), predicate('name', 'IS_NOT_EMPTY')] } },
        }),
      ],
    };
    expect(plan(input).where).toEqual(expected);
    expect(createQueryPlan(untypedModels, 'QsProduct', input).where).toEqual(expected);
    expect(plan(input, { operators: ALL, referenceEmptiness: true }).where).toEqual(expected);
    // The compiler's operators apply inside scopes too.
    const operators = ALL.filter((operator) => operator !== 'NE');
    expect(outcomeOf(() => plan(input, { operators, referenceEmptiness: true })))
      .toEqual(['UNSUPPORTED_QUERY', 400, 'The NE filter operator is not supported by this query compiler']);
  });

  it('plans a marker on a scope from Review through two references', () => {
    const input = { product: { terms: [marked({ path: 'shop.state', operator: 'IS_EMPTY' }, { product: null, 'product.shop': scopeOf('state', 'EQ', 'OPEN') })] } };
    expect(createQueryPlan(models, 'QsReview', input).where).toEqual(predicate('product.shop.state', 'IS_EMPTY', {
      scopes: { product: null, 'product.shop': { kind: 'predicate', path: ['state'], operator: 'EQ', value: 'OPEN' } },
    }));
  });

  it('reads the operators once, so a one-time iterable applies inside scopes as an array does', () => {
    const once = (names) => (function* oneTime() { yield* names; }());
    const input = {
      shop: { terms: [marked({ operator: 'IS_EMPTY' }, { shop: scopeOf('name', 'NE', 'S2') })] },
      pro: { terms: [marked({ path: 'shop.state', operator: 'IS_NOT_EMPTY' }, { pro: { name: { operator: 'EQ', value: 'P1' } }, 'pro.shop': null }, 1)] },
    };
    const expected = {
      kind: 'and',
      terms: [
        predicate('shop', 'IS_EMPTY', { scopes: { shop: { kind: 'predicate', path: ['name'], operator: 'NE', value: 'S2' } } }),
        predicate('pro.shop.state', 'IS_NOT_EMPTY', { scopes: { pro: { kind: 'predicate', path: ['name'], operator: 'EQ', value: 'P1' }, 'pro.shop': null } }),
      ],
    };
    expect(plan(input, { operators: ALL, referenceEmptiness: true }).where).toEqual(expected);
    expect(plan(input, { operators: once(ALL), referenceEmptiness: true }).where).toEqual(expected);
    // The names the iterable leaves out are still rejected inside scopes.
    expect(outcomeOf(() => plan(input, { operators: once(ALL.filter((operator) => operator !== 'NE')), referenceEmptiness: true })))
      .toEqual(['UNSUPPORTED_QUERY', 400, 'The NE filter operator is not supported by this query compiler']);
  });

  it('plans each lifted scope as a find on its target, also in count and aggregate modes', () => {
    const shopNE = { kind: 'predicate', path: ['name'], operator: 'NE', value: 'S2' };
    const input = {
      shop: { terms: [marked({ operator: 'IS_EMPTY' }, { shop: { ...scopeOf('name', 'NE', 'S2'), sort: { terms: [{ field: 'name', order: 'ASC' }] } } })] },
      AND: [{ conditions: [marked(condition('pro', 'shop', 'IS_NOT_EMPTY'), { pro: null, 'pro.shop': scopeOf('name', 'NE', 'S2') }, 1)] }],
    };
    const aggregation = { groupId: 'name', facts: [{ operation: 'COUNT', factName: 'n', path: 'stock' }] };
    const expected = {
      kind: 'and',
      terms: [
        predicate('shop', 'IS_EMPTY', { scopes: { shop: shopNE } }),
        predicate('pro.shop', 'IS_NOT_EMPTY', { scopes: { pro: null, 'pro.shop': shopNE } }),
      ],
    };
    expect(plan(input).where).toEqual(expected);
    expect(plan(input, { mode: 'count' }).where).toEqual(expected);
    // A scope holds no aggregation: planned in the query's aggregate mode, it would be rejected.
    const aggregate = plan({ ...input, aggregation }, { mode: 'aggregate' });
    expect(aggregate.where).toEqual(expected);
    expect(aggregate.aggregation).toEqual({ groupId: ['name'], facts: [{ operation: 'COUNT', factName: 'n', path: ['stock'] }] });
    // Lifted scopes are always planned as finds, so their collection sorts fail in every outer mode.
    const sortedScope = { shop: { terms: [marked({ operator: 'IS_EMPTY' }, { shop: { sort: { terms: [{ field: 'products', order: 'ASC' }] } } })] } };
    const sortRejected = ['INVALID_FILTER_PATH', 400, 'Sort path products crosses the collection QsShop.products; a record has no single value there'];
    expect(outcomeOf(() => plan(sortedScope))).toEqual(sortRejected);
    expect(outcomeOf(() => plan(sortedScope, { mode: 'count' }))).toEqual(sortRejected);
    expect(outcomeOf(() => plan({ ...sortedScope, aggregation }, { mode: 'aggregate' }))).toEqual(sortRejected);
  });

  it('fails closed with DETACHED_CLIENT_FILTER (500) on a marker it cannot honor', () => {
    const detached = (input) => {
      const outcome = outcomeOf(() => plan(input));
      expect(outcome?.slice(0, 2), JSON.stringify(input)).toEqual(['DETACHED_CLIENT_FILTER', 500]);
      return outcome[2];
    };
    const shopTerm = (scope) => ({ shop: { terms: [{ operator: 'IS_EMPTY', __scope: scope }] } });
    const suffix = '; only the runtime writes and fills client scope markers (docs/guide/middleware.md)';
    expect(detached(shopTerm({ id: 0 }))).toBe(`IS_EMPTY on shop carries a client scope marker whose scopes are not filled${suffix}`);
    for (const scope of [{ id: 0, scopes: null }, { id: 0, scopes: [] }, { id: 0, scopes: 'x' }, null, undefined, 0]) detached(shopTerm(scope));
    expect(detached(shopTerm({ id: 0, scopes: { pro: null } }))).toBe(`IS_EMPTY on shop carries a client scope marker without the scope of shop${suffix}`);
    detached(shopTerm({ id: 0, scopes: { shop: undefined } }));
    expect(detached({ pro: { terms: [{ path: 'shop.state', operator: 'IS_EMPTY', __scope: { id: 0, scopes: { pro: null } } }] } }))
      .toBe(`IS_EMPTY on pro.shop.state carries a client scope marker without the scope of pro.shop${suffix}`);
    detached({ AND: [{ conditions: [{ ...condition('odim', null, 'IS_EMPTY'), __scope: { id: 0, scopes: { odim: null } } }] }] });
    // A marker on a construct that reads no reference or collection, or on another operator.
    expect(detached({ odim: { terms: [{ path: 'w', operator: 'IS_EMPTY', __scope: { id: 0, scopes: {} } }] } }))
      .toBe(`IS_EMPTY on odim.w carries a client scope marker, but reads no reference or collection${suffix}`);
    expect(detached({ shop: { terms: [{ path: 'name', operator: 'EQ', value: 'S1', __scope: { id: 0, scopes: { shop: null } } }] } }))
      .toBe(`EQ on shop.name carries a client scope marker, but is not an emptiness condition${suffix}`);
    detached({ AND: [{ conditions: [{ ...condition('shop', 'name', 'NE', null), __scope: { id: 0 } }] }] });
  });

  it('gives the 400 codes of the order of checks before the marker check, and never reads a marker elsewhere', () => {
    const unfilled = { id: 0 };
    expect(codeOf(() => plan({ shop: { terms: [{ operator: 'IS_EMPTY', value: 'x', __scope: unfilled }] } }))).toBe('INVALID_FILTER_VALUE');
    expect(codeOf(() => plan({ olines: { terms: [{ path: 'shop', operator: 'IS_EMPTY', __scope: unfilled }] } }))).toBe('INVALID_FILTER_PATH');
    expect(codeOf(() => plan({ shop: { terms: [{ operator: 'IS_EMPTY', __scope: unfilled }] } }, { operators: ['EQ'] }))).toBe('UNSUPPORTED_QUERY');
    expect(codeOf(() => plan({ shop: { terms: [{ operator: 'IS_EMPTY', __scope: unfilled }] } }, { referenceEmptiness: false }))).toBe('UNSUPPORTED_QUERY');
    expect(codeOf(() => plan({ shop: { terms: [{ path: 'name', operator: 'BAD', __scope: unfilled }] } }))).toBe('INVALID_FILTER_OPERATOR');
    // Field filters, groups and values hold no marker.
    expect(plan({ stock: { operator: 'IS_EMPTY', __scope: unfilled } }).where).toEqual(predicate('stock', 'IS_EMPTY'));
    expect(plan({ AND: [{ __scope: unfilled, conditions: [condition('shop', null, 'IS_EMPTY')] }] }).where).toEqual(predicate('shop', 'IS_EMPTY'));
    expect(plan({ name: { operator: 'EQ', value: { __scope: unfilled } } }).where).toEqual({
      kind: 'predicate', path: ['name'], operator: 'EQ', value: { __scope: unfilled },
    });
  });
});

// The independent oracle now lives with the shared collection-frame helpers; its default data
// remains the frozen 2b seed, so every REFERENCE_CASES row keeps its original meaning.
describe('the reference emptiness fixture', () => {
  it('lists every shape, scope and case once (helper check, passes on 3.10.0)', () => {
    expect(REFERENCE_SHAPES).toEqual(['admin', 'NE', 'EQ', 'proOnly', 'shopNE', 'shopEQ']);
    expect(REFERENCE_SCOPES.NE).toEqual({
      shop: { field: 'name', operator: 'NE', value: 'S2' }, review: { field: 'author', operator: 'NE', value: 'hidden' }, pro: { field: 'name', operator: 'NE', value: 'P2' },
    });
    expect(REFERENCE_SCOPES.EQ).toEqual({
      shop: { field: 'state', operator: 'EQ', value: 'OPEN' }, review: { field: 'author', operator: 'EQ', value: 'x' }, pro: { field: 'name', operator: 'EQ', value: 'P1' },
    });
    expect(REFERENCE_SCOPES.proOnly).toEqual({ pro: { field: 'name', operator: 'NE', value: 'P2' } });
    // The Shop condition of NE or EQ alone, with the Review root, Product and Pro unscoped.
    expect(REFERENCE_SCOPES.shopNE).toEqual({ shop: REFERENCE_SCOPES.NE.shop });
    expect(REFERENCE_SCOPES.shopEQ).toEqual({ shop: REFERENCE_SCOPES.EQ.shop });
    expect(new Set(REFERENCE_CASES.map((item) => item.name)).size).toBe(REFERENCE_CASES.length);
    expect(REFERENCE_CASES.length).toBe(47);
    for (const item of REFERENCE_CASES) {
      expect(Object.keys(item.rows), item.name).toEqual(REFERENCE_SHAPES);
      for (const shape of REFERENCE_SHAPES) expect([...item.rows[shape]], item.name).toEqual([...item.rows[shape]].sort());
    }
    // The rows the spec and the probe (map-probe.md section 1) state.
    const find = (name) => REFERENCE_CASES.find((item) => item.name === name);
    const rows = (name) => find(name).rows;
    expect(rows('shop IS_EMPTY')).toEqual({
      admin: ['C'], NE: ['C', 'c'], EQ: ['C', 'D', 'c'], proOnly: ['C'], shopNE: ['C', 'c'], shopEQ: ['C', 'D', 'c'],
    });
    expect(rows('shop.state IS_EMPTY')).toEqual({
      admin: ['C', 'D'], NE: ['C', 'D', 'c'], EQ: ['C', 'D', 'c'], proOnly: ['C', 'D'], shopNE: ['C', 'D', 'c'], shopEQ: ['C', 'D', 'c'],
    });
    expect(rows('reviews IS_EMPTY')).toEqual({
      admin: ['C'], NE: ['C', 'c'], EQ: ['C', 'c'], proOnly: ['C'], shopNE: ['C'], shopEQ: ['C'],
    });
    expect(rows('odim IS_EMPTY')).toEqual({
      admin: ['E'], NE: ['C', 'E'], EQ: ['C', 'D', 'E'], proOnly: ['E'], shopNE: ['C', 'E'], shopEQ: ['C', 'D', 'E'],
    });
    expect(rows('pro.shop IS_EMPTY')).toEqual({
      admin: ['D', 'E'], NE: ['C', 'D', 'E', 'c'], EQ: ['C', 'D', 'E', 'c'], proOnly: ['D', 'E', 'c'], shopNE: ['C', 'D', 'E'], shopEQ: ['C', 'D', 'E'],
    });
    expect(rows('gap 5: OR [legacy shop.id EQ S1, shop IS_EMPTY]')).toEqual({
      admin: ['C', 'E', 'Ka'],
      NE: ['C', 'E', 'Ka', 'c'],
      EQ: ['C', 'D', 'E', 'Ka', 'c'],
      proOnly: ['C', 'E', 'Ka'],
      shopNE: ['C', 'E', 'Ka', 'c'],
      shopEQ: ['C', 'D', 'E', 'Ka', 'c'],
    });
    expect(rows('OR [legacy shop.name EQ "S2", shop IS_NOT_EMPTY]')).toMatchObject({ admin: ['D', 'E', 'Ka', 'c'], NE: ['D', 'E', 'Ka'], EQ: ['E', 'Ka'] });
    expect(rows('sort shop.name beside shop IS_EMPTY')).toMatchObject({ NE: ['C'], EQ: [] });
    // The probe's two hops from Review read the Shop scope with the root unscoped: its NE and EQ callers are shopNE and
    // shopEQ here. A trusted construct reads the stored shops, so the unscoped Product hop never makes the Shop hop
    // trusted.
    expect(rows('review: product.shop IS_EMPTY')).toMatchObject({ admin: [], shopNE: ['c:1:hidden'], shopEQ: ['D:1:x', 'D:5:hidden', 'c:1:hidden'] });
    expect(rows('review: product.shop.state IS_EMPTY')).toMatchObject({
      admin: ['D:1:x', 'D:5:hidden'], shopNE: ['D:1:x', 'D:5:hidden', 'c:1:hidden'], shopEQ: ['D:1:x', 'D:5:hidden', 'c:1:hidden'],
    });
    expect(find('review: product.shop IS_EMPTY').trusted).toMatchObject({ shopNE: [], shopEQ: [] });
    expect(find('review: product.shop.state IS_EMPTY').trusted).toMatchObject({ shopNE: ['D:1:x', 'D:5:hidden'], shopEQ: ['D:1:x', 'D:5:hidden'] });
    // The same order from Product: an unscoped Pro hop, then the scoped Shop hop.
    expect(find('pro.shop.state IS_EMPTY')).toMatchObject({ rows: { shopNE: ['C', 'D', 'E'], shopEQ: ['C', 'D', 'E'] }, trusted: { shopNE: ['D', 'E'], shopEQ: ['D', 'E'] } });
  });

  it('gives every case the rows that the definitions give (helper check, passes on 3.10.0)', () => {
    for (const shape of REFERENCE_SHAPES) {
      const rowsOf = oracle(shape);
      const withDangling = oracle(shape, { dangling: true });
      for (const item of REFERENCE_CASES) {
        expect(rowsOf(item), `${item.name} ${shape}`).toEqual(expectedReferenceRows(item, shape));
        expect(withDangling(item), `${item.name} ${shape} dangling`).toEqual(expectedReferenceRows(item, shape, { dangling: true }));
        if (item.trusted) {
          expect(rowsOf(item, { trusted: true }), `${item.name} ${shape} trusted`).toEqual(expectedReferenceRows(item, shape, { trusted: true }));
          expect(withDangling(item, { trusted: true }), `${item.name} ${shape} trusted dangling`)
            .toEqual(expectedReferenceRows(item, shape, { trusted: true, dangling: true }));
        }
      }
    }
  });

  it('writes the arguments of each case as a term, a group condition or the case\'s own arguments (helper check, passes on 3.10.0)', () => {
    const find = (name) => REFERENCE_CASES.find((item) => item.name === name);
    expect(referenceCaseArgs(find('pro.shop.state IS_EMPTY'))).toEqual({ pro: { terms: [{ path: 'shop.state', operator: 'IS_EMPTY' }] } });
    expect(referenceCaseArgs(find('shop IS_NOT_EMPTY'))).toEqual({ shop: { terms: [{ operator: 'IS_NOT_EMPTY' }] } });
    expect(referenceCaseArgs(find('review: product.shop IS_EMPTY'), {}, 'condition')).toEqual({ AND: [{ conditions: [{ field: 'product', path: 'shop', operator: 'IS_EMPTY' }] }] });
    expect(referenceCaseArgs(find('odim IS_EMPTY'), {}, 'condition')).toEqual({ AND: [{ conditions: [{ field: 'odim', operator: 'IS_EMPTY' }] }] });
    const gap = find('gap 5: OR [legacy shop.id EQ S1, shop IS_EMPTY]');
    expect(referenceCaseArgs(gap, { S1: 'id-1' }).OR[0].conditions[0]).toEqual({ field: 'shop', path: 'id', operator: 'EQ', value: 'id-1' });
    expect(() => referenceCaseArgs(gap, {})).toThrow('No id for S1');
    expect(find('pro.shop IS_EMPTY beside a trusted pro.shop IS_NOT_EMPTY').scopeArgs).toEqual({ AND: [{ conditions: [{ field: 'pro', path: 'shop', operator: 'IS_NOT_EMPTY' }] }] });
    expect(expectedReferenceRows(find('shop IS_EMPTY'), 'EQ', { dangling: true })).toEqual(['C', 'D', 'Dg', 'c']);
    expect(expectedReferenceRows(find('sort shop.name beside shop IS_EMPTY'), 'EQ', { dangling: true })).toEqual([]);
    expect(() => expectedReferenceRows(gap, 'NE', { trusted: true })).toThrow('has no trusted rows');
  });

  it('applies the shape\'s scope through the context, then the scopes given for the type (helper check, passes on 3.10.0)', () => {
    const calls = [];
    const scoped = createReferenceEmptinessTypes('Qu', { scopes: { product: { find: ({ args, operation }) => calls.push([operation, { ...args }]) } } });
    const run = (type, operation, shape, args = {}) => {
      type.extensions.scope[operation]({ type, args, operation, context: shape === undefined ? {} : { shape } });
      return args;
    };
    expect(run(scoped.Shop, 'find', 'NE')).toEqual({ AND: [{ conditions: [{ field: 'name', operator: 'NE', value: 'S2' }] }] });
    expect(run(scoped.Review, 'aggregate', 'EQ', { AND: [{ conditions: [] }] })).toEqual({
      AND: [{ conditions: [] }, { conditions: [{ field: 'author', operator: 'EQ', value: 'x' }] }],
    });
    expect(run(scoped.Pro, 'find', 'proOnly')).toEqual({ AND: [{ conditions: [{ field: 'name', operator: 'NE', value: 'P2' }] }] });
    expect(run(scoped.Shop, 'find', 'proOnly')).toEqual({});
    expect(run(scoped.Shop, 'aggregate', 'shopEQ')).toEqual({ AND: [{ conditions: [{ field: 'state', operator: 'EQ', value: 'OPEN' }] }] });
    for (const type of [scoped.Review, scoped.Pro]) expect(run(type, 'find', 'shopNE'), type.name).toEqual({});
    expect(run(scoped.Shop, 'find', undefined)).toEqual({});
    expect(run(scoped.Shop, 'get_by_id', 'EQ')).toEqual({});
    expect(run(scoped.Product, 'find', 'EQ', { name: { operator: 'EQ', value: 'Ka' } })).toEqual({ name: { operator: 'EQ', value: 'Ka' } });
    expect(calls).toEqual([['find', { name: { operator: 'EQ', value: 'Ka' } }]]);
    expect(() => run(scoped.Shop, 'find', 'BAD')).toThrow('Unknown reference emptiness shape BAD');
    expect(() => createReferenceEmptinessTypes('Qv', { scopes: { item: {} } })).toThrow('Unknown reference emptiness type keys: item');
    expect(Object.keys(scoped.roots)).toEqual(['shop', 'pro', 'product', 'review']);
    expect(scoped.roots.product).toMatchObject({ single: 'quProduct', plural: 'quProducts', type: scoped.Product });
  });

  it('seeds every record through generated mutations, with references stored under their storage names (helper check, passes on 3.10.0)', async () => {
    const records = new Map();
    let next = 0;
    const tableOf = (Model) => {
      if (!records.has(Model.name)) records.set(Model.name, new Map());
      return records.get(Model.name);
    };
    const copy = (record) => (record ? structuredClone(record) : null);
    const runtime = createRuntime({
      prepare() {},
      createModel: (gqltype) => ({ name: gqltype.name }),
      castId: String,
      withTransaction: async (session, body) => body(session || {}),
      newRecord: (Model, data) => ({ ...data, _id: String(next += 1) }),
      async saveRecord(Model, record) {
        tableOf(Model).set(record._id, copy(record));
        return copy(record);
      },
      toObject: (record) => ({ ...record }),
      getById: async (Model, id) => copy(tableOf(Model).get(String(id))),
      find: async (Model) => [...tableOf(Model).values()].map(copy),
      count: async (Model) => tableOf(Model).size,
      aggregate: async () => [],
      findChildren: async () => [],
    });
    const seededTypes = createReferenceEmptinessTypes('Qm', { backend: 'mongodb' });
    registerReferenceEmptinessTypes(runtime, seededTypes);
    const schema = runtime.createSchema();
    const ids = await seedReferenceEmptiness(schema, seededTypes);
    expect(Object.keys(ids)).toEqual(Object.values(REFERENCE_DATA).flat().map((record) => record.key));
    const stored = (typeName) => Object.fromEntries([...records.get(typeName).values()].map((record) => [record.key, record]));
    const products = stored('QmProduct');
    expect(products.Ka).toMatchObject({ shop: ids.S1, pro: ids.P1, odim: { w: 1 }, olines: [{ qty: 1, shop: ids.S1 }, { qty: 9 }] });
    expect(products.C).toMatchObject({ pro: ids.P3, odim: { shop: ids.S2 } });
    expect(products.C.shop ?? null).toBeNull();
    expect(products.E.pro ?? null).toBeNull();
    expect(stored('QmReview')['D:5:hidden']).toMatchObject({ productId: ids.D, author: 'hidden', rating: 5 });
    expect(stored('QmReview')['D:5:hidden']).not.toHaveProperty('product');
    expect(stored('QmPro').P4.shop ?? null).toBeNull();
    expect(stored('QmShop').S3).toMatchObject({ name: 'S3', minStock: 1 });
    const { source, variables } = referenceQuery(seededTypes, 'product', { shop: { terms: [{ path: 'name', operator: 'EQ', value: 'S1' }] } }, 'key shop { key }');
    expect(source).toBe('query($shop:QLTypeFilterExpression){qmProducts(shop:$shop,sort:{terms:[{field:"key",order:ASC}]}){key shop { key }}}');
    const result = await graphql({ schema, source, variableValues: variables, contextValue: { shape: 'admin' } });
    expect(result.errors).toBeUndefined();
    expect(result.data.qmProducts.map(({ key }) => key).sort()).toEqual(REFERENCE_DATA.product.map((record) => record.key).sort());
    expect(referenceQuery(seededTypes, 'review', { AND: [], sort: { terms: [{ field: 'key', order: 'DESC' }] }, pagination: { page: 1, size: 2 } }).source)
      .toBe('query($AND:[QLFilterGroup],$sort:QLSortExpression,$pagination:QLPagination){qmReviews(AND:$AND,sort:$sort,pagination:$pagination){key}}');
  });

  it('writes the dangling MongoDB product natively, as given (helper check, passes on 3.10.0)', async () => {
    const inserted = [];
    const api = { getModel: (type) => ({ collection: { insertMany: async (documents) => { inserted.push([type.name, documents]); } } }) };
    const document = await writeMongoDanglingReference(api, types, { id: 'missing' });
    expect(document).toEqual({
      key: 'Dg', name: 'Dg', stock: 1, shop: 'missing', pro: 'missing', odim: { shop: 'missing' }, olines: [{ qty: 1, shop: 'missing' }],
    });
    expect(inserted).toEqual([['QsProduct', [document]]]);
    const generated = await writeMongoDanglingReference(api, types);
    expect(generated.shop.constructor.name).toBe('ObjectId');
    expect(generated.pro).toBe(generated.shop);
  });
});
