import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { GraphQLID, GraphQLInt, GraphQLInterfaceType, GraphQLList, GraphQLObjectType, GraphQLString, GraphQLUnionType } from 'graphql';
import { describeModels } from '../packages/core/src/metadata.js';
import { REFERENCE_SCOPES, REFERENCE_SHAPES, createReferenceEmptinessTypes } from './helpers/query-emptiness.js';
import { createContractModelFixtures } from './contracts/model-fixtures.js';
import { COLLECTION_AGGREGATES, COLLECTION_ANCHOR_ROWS, COLLECTION_CASES, COLLECTION_DATA, collectionAggregateOracle, collectionOracle, createEvaluator, referenceStore } from './helpers/collection-frames.js';
import * as limits from '../packages/core/src/query-limits.js';
import * as emptiness from '../packages/core/src/query-emptiness.js';
import { resolveQueryFeatures } from '../packages/core/src/query-operators.js';
import { collectQueryOperators, collectQueryPathEntries, createQueryPlan, resolveModelPath } from '../packages/core/src/query-plan.js';

const errorOf = (body) => {
  try {
    body();
  } catch (error) {
    return error;
  }
  return null;
};

describe('collection frames: limits', () => {
  afterEach(() => limits.configureQueryLimits());

  it('defaults nesting to 3, accepts positive safe integers, and resets omitted options', () => {
    limits.configureQueryLimits();
    expect(limits.getQueryMaxFrameNesting()).toBe(3);
    for (const maxFrameNesting of [1, 4, Number.MAX_SAFE_INTEGER]) {
      limits.configureQueryLimits({ maxPageSize: 17, maxReferenceFrames: 8, maxFrameNesting });
      expect([limits.getQueryMaxPageSize(), limits.getQueryMaxReferenceFrames(), limits.getQueryMaxFrameNesting()])
        .toEqual([17, 8, maxFrameNesting]);
    }
    limits.configureQueryLimits({ maxPageSize: 12 });
    expect([limits.getQueryMaxPageSize(), limits.getQueryMaxReferenceFrames(), limits.getQueryMaxFrameNesting()])
      .toEqual([12, 10, 3]);
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '3', null, true, {}, []])('rejects invalid maxFrameNesting %j before changing any limits', (maxFrameNesting) => {
    limits.configureQueryLimits({ maxPageSize: 7, maxReferenceFrames: 2, maxFrameNesting: 1 });
    const error = errorOf(() => limits.configureQueryLimits({ maxPageSize: 19, maxReferenceFrames: 6, maxFrameNesting }));
    expect(error?.extensions).toMatchObject({ code: 'INVALID_QUERY_LIMITS', status: 400 });
    expect(error?.message).toBe('maxFrameNesting must be a positive safe integer');
    expect([limits.getQueryMaxPageSize(), limits.getQueryMaxReferenceFrames(), limits.getQueryMaxFrameNesting()])
      .toEqual([7, 2, 1]);
  });

  it.each([{ maxPageSize: 0 }, { maxReferenceFrames: 0 }])('keeps the nesting limit when another option fails: %j', (invalid) => {
    limits.configureQueryLimits({ maxPageSize: 7, maxReferenceFrames: 2, maxFrameNesting: 1 });
    const error = errorOf(() => limits.configureQueryLimits({ maxFrameNesting: 5, ...invalid }));
    expect(error?.extensions).toMatchObject({ code: 'INVALID_QUERY_LIMITS', status: 400 });
    expect([limits.getQueryMaxPageSize(), limits.getQueryMaxReferenceFrames(), limits.getQueryMaxFrameNesting()])
      .toEqual([7, 2, 1]);
  });
});

describe('collection frames: features', () => {
  it.each([undefined, null, { operators: ['EQ'] }])('disables quantifiers without a declaration: %j', (declaration) => {
    expect(resolveQueryFeatures(declaration).quantifiers).toBe(false);
  });

  it.each([false, null, undefined])('normalizes quantifiers %j to false', (quantifiers) => {
    expect(resolveQueryFeatures({ operators: ['EQ'], quantifiers })).toEqual({
      operators: new Set(['EQ']), referenceEmptiness: false, quantifiers: false,
    });
  });

  it('enables quantifiers only with reference emptiness and retains known operators', () => {
    expect(resolveQueryFeatures({ operators: ['EQ', 'FUTURE', 'IS_EMPTY'], referenceEmptiness: true, quantifiers: true })).toEqual({
      operators: new Set(['EQ', 'IS_EMPTY']), referenceEmptiness: true, quantifiers: true,
    });
  });

  it.each(['true', 1, 0, '', {}, [], [true], () => true])('rejects non-boolean quantifiers %j', (quantifiers) => {
    const error = errorOf(() => resolveQueryFeatures({ operators: ['EQ'], referenceEmptiness: true, quantifiers }));
    expect(error?.extensions).toMatchObject({ code: 'INVALID_QUERY_FEATURES', status: 500 });
    expect(error?.message).toBe('DatabaseAdapter queryFeatures quantifiers must be a boolean');
  });

  it.each([false, null, undefined])('rejects quantifiers with referenceEmptiness %j', (referenceEmptiness) => {
    const error = errorOf(() => resolveQueryFeatures({ operators: ['EQ'], referenceEmptiness, quantifiers: true }));
    expect(error?.extensions).toMatchObject({ code: 'INVALID_QUERY_FEATURES', status: 500 });
  });
});

describe('collection frames: enum and step classifiers', () => {
  it('exposes the ANY, ALL and NONE enum values and internal quantifier names', async () => {
    const modulePath = '../packages/core/src/const/QLQuantifier.js';
    const { default: QLQuantifier, QUANTIFIERS, QUANTIFIED_LISTS } = await import(/* @vite-ignore */ modulePath);
    expect(QLQuantifier.name).toBe('QLQuantifier');
    expect(QLQuantifier.getValues().map(({ name, value }) => [name, value]))
      .toEqual([['ANY', 'ANY'], ['ALL', 'ALL'], ['NONE', 'NONE']]);
    expect(QUANTIFIERS).toEqual(new Set(['ANY', 'ALL', 'NONE']));
    expect(QUANTIFIED_LISTS).toEqual(['ANY', 'ALL', 'NONE']);
  });

  it('exports the GraphQL classifier with the shared relation and embedded-list rules', () => {
    const child = new GraphQLObjectType({ name: 'FrameClassifiedChild', fields: { id: { type: GraphQLID } } });
    expect(emptiness.graphqlStep('reviews', { type: new GraphQLList(child), extensions: { relation: { connectionField: 'product' } } }))
      .toMatchObject({ name: 'reviews', kind: 'collection', target: 'FrameClassifiedChild', connectionField: 'product' });
    expect(emptiness.graphqlStep('shop', { type: child, extensions: { relation: {} } }))
      .toMatchObject({ name: 'shop', kind: 'reference', target: 'FrameClassifiedChild' });
    expect(emptiness.graphqlStep('lines', { type: new GraphQLList(child) })).toMatchObject({ name: 'lines', kind: 'embeddedList', node: child });
    expect(emptiness.graphqlStep('name', { type: GraphQLString })).toEqual({ name: 'name', kind: 'scalar', string: true });
  });

  it('exports the model classifier and keeps inferred references scalar', () => {
    expect(emptiness.modelStep({ name: 'reviews', kind: 'collection', target: 'Review', connectionField: 'productId' }))
      .toEqual({ name: 'reviews', kind: 'collection', target: 'Review', connectionField: 'productId' });
    expect(emptiness.modelStep({ name: 'shop', kind: 'reference', target: 'Shop' }))
      .toEqual({ name: 'shop', kind: 'reference', target: 'Shop' });
    expect(emptiness.modelStep({ name: 'owner', kind: 'reference', target: 'Shop', inferred: true, scalar: 'ID' }))
      .toEqual({ name: 'owner', kind: 'scalar', string: false });
    expect(emptiness.modelStep({ name: 'lines', kind: 'embedded', list: true, fields: [] }))
      .toEqual({ name: 'lines', kind: 'embeddedList', node: [] });
  });
});


describe('collection frames: collectors', () => {
  it.each(['ANY', 'ALL', 'NONE'])('reads a %s path and its conditions in their respective frames', (quantifier) => {
    const condition = { field: 'author', path: 'name', operator: 'NE', value: 'x' };
    const group = { path: 'shop.reviews', conditions: [condition] };
    const args = { AND: [{ [quantifier]: [group] }] };
    const frame = { path: 'shop.reviews', type: quantifier, construct: group };
    const paths = collectQueryPathEntries(args);
    expect(paths).toEqual([
      { segments: ['shop', 'reviews'], relative: ['shop', 'reviews'], use: 'filter', group: null, container: group, frames: [], operator: null, construct: group, quantifier },
      { segments: ['shop', 'reviews', 'author', 'name'], relative: ['author', 'name'], use: 'filter', group, container: group, frames: [frame], operator: 'NE', construct: condition },
    ]);
    expect(paths[0].construct).toBe(group);
    expect(paths[1].frames[0].construct).toBe(group);
    expect(paths[1].container).toBe(group);
    const operators = collectQueryOperators(args);
    expect(operators).toHaveLength(2);
    expect(operators[0]).toMatchObject({ path: 'shop.reviews', relative: ['shop', 'reviews'], frames: [], form: 'quantified', operator: null, construct: group, depth: 1, use: 'filter' });
    expect(operators[1]).toMatchObject({ path: 'shop.reviews.author.name', relative: ['author', 'name'], frames: [frame], field: 'author', rawPath: 'name', form: 'condition', construct: condition, value: 'x', hasValue: true, ambiguous: false, depth: 1 });
  });

  it('keeps terms under a quantifier filter relative to its element and retains their constructs', () => {
    const term = { path: 'episodes.duration', operator: 'GT', value: 20 };
    const filter = { quantifier: 'ALL', terms: [term] };
    const args = { seasons: filter };
    const frame = { path: 'seasons', type: 'ALL', construct: filter };
    expect(collectQueryPathEntries(args)).toEqual([
      { segments: ['seasons'], relative: ['seasons'], use: 'filter', group: null, container: filter, frames: [], operator: null, construct: filter, quantifier: 'ALL' },
      { segments: ['seasons', 'episodes', 'duration'], relative: ['episodes', 'duration'], use: 'filter', group: null, container: filter, frames: [frame], operator: 'GT', construct: term },
    ]);
    expect(collectQueryOperators(args)).toMatchObject([
      { form: 'quantified', path: 'seasons', relative: ['seasons'], construct: filter, container: filter, frames: [], depth: 0 },
      { form: 'term', path: 'seasons.episodes.duration', relative: ['episodes', 'duration'], construct: term, container: filter, frames: [frame], field: 'seasons', rawPath: 'episodes.duration', value: 20, hasValue: true, depth: 0 },
    ]);
  });

  it.each([{ quantifier: 'ANY' }, { quantifier: 'NONE', terms: [] }])('reads the named field even with no quantified terms: %j', (filter) => {
    const paths = collectQueryPathEntries({ reviews: filter });
    expect(paths).toHaveLength(1);
    expect(paths[0]).toMatchObject({ segments: ['reviews'], relative: ['reviews'], construct: filter, container: filter, frames: [], use: 'filter' });
    expect(collectQueryOperators({ reviews: filter })).toMatchObject([{ form: 'quantified', path: 'reviews', construct: filter }]);
  });

  it('still exposes a path-less quantified term at the named field for validation', () => {
    const term = { operator: 'IS_EMPTY' };
    const filter = { quantifier: 'ANY', terms: [term] };
    expect(collectQueryPathEntries({ reviews: filter }).map(({ segments, relative, construct, frames }) => ({ segments, relative, construct, frames }))).toEqual([
      { segments: ['reviews'], relative: ['reviews'], construct: filter, frames: [] },
      { segments: ['reviews'], relative: [], construct: term, frames: [{ path: 'reviews', type: 'ANY', construct: filter }] },
    ]);
    expect(collectQueryOperators({ reviews: filter })[1]).toMatchObject({ path: 'reviews', relative: [], rawPath: undefined, field: 'reviews', construct: term });
  });

  it('walks nested quantified paths and ordinary groups with absolute prefixes', () => {
    const condition = { field: 'rating', operator: 'GTE', value: 4 };
    const branch = { conditions: [condition] };
    const inner = { path: 'reviews', OR: [branch] };
    const outer = { path: 'shop.products', NONE: [inner] };
    const paths = collectQueryPathEntries({ AND: [{ ALL: [outer] }] });
    expect(paths.map(({ segments, relative, frames, container }) => ({ segments, relative, frames, container }))).toEqual([
      { segments: ['shop', 'products'], relative: ['shop', 'products'], frames: [], container: outer },
      { segments: ['shop', 'products', 'reviews'], relative: ['reviews'], frames: [{ path: 'shop.products', type: 'ALL', construct: outer }], container: inner },
      { segments: ['shop', 'products', 'reviews', 'rating'], relative: ['rating'], frames: [{ path: 'shop.products', type: 'ALL', construct: outer }, { path: 'reviews', type: 'NONE', construct: inner }], container: branch },
    ]);
    expect(collectQueryOperators({ AND: [{ ALL: [outer] }] }).map(({ path, depth }) => [path, depth])).toEqual([
      ['shop.products', 1], ['shop.products.reviews', 2], ['shop.products.reviews.rating', 3],
    ]);
  });

  it('gates a shared group once per frame, including separate constructs on the same path', () => {
    const condition = { field: 'author.name', value: 'x' };
    const shared = { conditions: [condition] };
    const left = { path: 'reviews', AND: [shared, shared] };
    const right = { path: 'reviews', AND: [shared] };
    const other = { path: 'products', AND: [shared] };
    const args = { AND: [{ ANY: [left, right, other] }] };
    for (const collect of [collectQueryPathEntries, collectQueryOperators]) {
      const entries = collect(args).filter(({ construct }) => construct === condition);
      expect(entries.map(({ segments }) => segments)).toEqual([
        ['reviews', 'author', 'name'], ['reviews', 'author', 'name'], ['products', 'author', 'name'],
      ]);
      expect(entries.map(({ frames }) => frames[0].construct)).toEqual([left, right, other]);
    }
  });

  it('distinguishes a group reused under different quantifiers on the same path', () => {
    const condition = { field: 'name', value: 'x' };
    const shared = { path: 'reviews', conditions: [condition] };
    for (const collect of [collectQueryPathEntries, collectQueryOperators]) {
      const entries = collect({ AND: [{ ANY: [shared], NONE: [shared] }] });
      expect(entries.filter(({ construct }) => construct === shared).map(({ quantifier }) => quantifier)).toEqual(['ANY', 'NONE']);
      expect(entries.filter(({ construct }) => construct === condition).map(({ frames }) => frames[0].type)).toEqual(['ANY', 'NONE']);
    }
  });

  it('distinguishes one aliased frame construct reached at different absolute paths', () => {
    const condition = { field: 'name', value: 'x' };
    const shared = { path: 'children', conditions: [condition] };
    const outer = { path: 'products', ANY: [shared] };
    for (const collect of [collectQueryPathEntries, collectQueryOperators]) {
      expect(collect({ AND: [{ ANY: [shared, outer] }] }).filter(({ construct }) => construct === condition).map(({ segments }) => segments)).toEqual([
        ['children', 'name'], ['products', 'children', 'name'],
      ]);
    }
  });

  it('measures the deepest occurrence separately in each frame and terminates logical and quantified cycles', () => {
    const condition = { field: 'name', value: 'x' };
    const shared = { conditions: [condition] };
    const left = { path: 'reviews', AND: [shared, { AND: [{ OR: [shared] }] }] };
    const right = { path: 'products', OR: [shared] };
    expect(collectQueryOperators({ AND: [{ ALL: [left, right] }] }).filter(({ construct }) => construct === condition).map(({ path, depth }) => [path, depth]))
      .toEqual([['reviews.name', 4], ['products.name', 2]]);
    const cycle = { path: 'children', conditions: [condition] };
    cycle.AND = [cycle];
    cycle.ANY = [cycle];
    for (const collect of [collectQueryPathEntries, collectQueryOperators]) {
      expect(collect({ AND: [{ ANY: [cycle] }] }).map(({ segments }) => segments)).toEqual([['children'], ['children', 'name']]);
    }
  });

  it('adds no group-depth level for generated implicit groups', () => {
    const condition = { field: 'rating', value: 4 };
    const frame = { path: 'reviews', __implicit: true, conditions: [condition] };
    const args = { AND: [{ __implicit: true, ANY: [frame] }] };
    expect(collectQueryOperators(args).map(({ depth }) => depth)).toEqual([-1, -1]);
    const explicit = { path: 'products', ANY: [frame] };
    expect(collectQueryOperators({ AND: [{ ALL: [explicit] }] }).map(({ depth }) => depth)).toEqual([1, 1, 1]);
  });

  it.each(['XOR', 'condition', 'quantifier', 'applicationField'])('rejects unknown own group key %s in both collectors', (key) => {
    const group = { conditions: [], [key]: [] };
    for (const collect of [collectQueryPathEntries, collectQueryOperators]) {
      const error = errorOf(() => collect({ AND: [group] }));
      expect(error?.extensions).toMatchObject({ code: 'INVALID_FILTER_VALUE', status: 400 });
      expect(error?.message).toBe(`Unknown filter group key: ${key}`);
    }
  });

  it('rejects path on plain groups, ignores their reserved markers, and treats top-level keys as fields', () => {
    for (const collect of [collectQueryPathEntries, collectQueryOperators]) {
      expect(errorOf(() => collect({ OR: [{ path: 'reviews' }] }))?.extensions.code).toBe('INVALID_FILTER_VALUE');
      expect(collect({ AND: [{ __scope: { id: 'unused' }, __anchor: ['ignored'], __implicit: true }] })).toEqual([]);
      expect(collect({ applicationField: { value: 1 }, aggregation: { value: 2 } }).map(({ segments }) => segments))
        .toEqual([['applicationField'], ['aggregation']]);
    }
  });

  it('pin: treats top-level quantifier names as application fields', () => {
    const args = { ANY: { value: 'one' }, ALL: { terms: [{ path: 'name', value: 'all' }] }, NONE: { operator: 'IS_EMPTY' } };
    for (const collect of [collectQueryPathEntries, collectQueryOperators]) {
      expect(collect(args).map(({ segments, operator, construct }) => ({ segments, operator, construct }))).toEqual([
        { segments: ['ANY'], operator: 'EQ', construct: null },
        { segments: ['ALL', 'name'], operator: 'EQ', construct: args.ALL.terms[0] },
        { segments: ['NONE'], operator: 'IS_EMPTY', construct: null },
      ]);
    }
  });

  it('labels sort, aggregate groupId and facts without treating them as operators', () => {
    const args = { name: { value: 'x' }, sort: { terms: [{ field: 'created', order: 'ASC' }] }, aggregation: { groupId: 'category.name', facts: [{ path: 'price' }] } };
    expect(collectQueryPathEntries(args).map(({ segments, relative, use, container, frames }) => ({ segments, relative, use, container, frames }))).toEqual([
      { segments: ['name'], relative: ['name'], use: 'filter', container: args.name, frames: [] },
      { segments: ['aggregation'], relative: ['aggregation'], use: 'filter', container: args.aggregation, frames: [] },
      { segments: ['created'], relative: ['created'], use: 'sort', container: null, frames: [] },
    ]);
    expect(collectQueryPathEntries(args, 'aggregate').map(({ segments, use }) => [segments, use])).toEqual([
      [['name'], 'filter'], [['category', 'name'], 'groupId'], [['price'], 'fact'],
    ]);
    expect(collectQueryOperators(args, 'aggregate').map(({ path, use }) => [path, use])).toEqual([['name', 'filter']]);
  });

  it('expands emptiness members inside a frame with relative and absolute paths, and never reads an implicit id for a quantified path', () => {
    const Detail = new GraphQLObjectType({ name: 'CfCollectorDetail', fields: { label: { type: GraphQLString } } });
    const Review = new GraphQLObjectType({ name: 'CfCollectorReview', fields: { id: { type: GraphQLID }, detail: { type: Detail, extensions: { relation: { embedded: true } } } } });
    const Product = new GraphQLObjectType({ name: 'CfCollectorProduct', fields: { reviews: { type: new GraphQLList(Review), extensions: { relation: { embedded: false, connectionField: 'product' } } } } });
    const condition = { field: 'detail', operator: 'IS_EMPTY' };
    const group = { path: 'reviews', conditions: [condition] };
    const entries = collectQueryPathEntries({ AND: [{ ALL: [group] }] }, 'find', { gqltype: Product, expandMembers: true });
    expect(entries.map(({ segments, relative, member }) => [segments, relative, Boolean(member)])).toEqual([
      [['reviews'], ['reviews'], false], [['reviews', 'detail'], ['detail'], false], [['reviews', 'detail', 'label'], ['detail', 'label'], true],
    ]);
    expect(entries[2]).toMatchObject({ construct: condition, group, container: group, frames: [{ path: 'reviews', type: 'ALL', construct: group }], use: 'filter', operator: 'IS_EMPTY' });
  });
});


// The module import stays lazy so the pre-implementation baseline reports the absent helper
// per case while retaining all earlier contract tests.
let frames;
beforeAll(async () => {
  try {
    const modulePath = '../packages/core/src/query-frames.js';
    frames = await import(/* @vite-ignore */ modulePath);
  } catch {
    frames = {};
  }
});
const frameTypes = createReferenceEmptinessTypes('Cf');
const frameModels = describeModels([frameTypes.Shop, frameTypes.Pro, frameTypes.Product, frameTypes.Review,
  ...frameTypes.embedded].map((gqltype) => ({ gqltype })));
const plainFrameModels = { entities: frameModels.entities.map((entity) => Object.fromEntries(Object.entries(entity).filter(([key]) => key !== 'gqltype'))) };
const contexts = [
  ['GraphQL', { gqltype: frameTypes.Product }],
  ['models', { models: plainFrameModels, entity: frameTypes.Product.name }],
];
const enabled = { quantifiers: true, referenceEmptiness: true, operation: 'find' };
const condition = (field, operator = 'EQ', value = 'x') => ({ field, operator, value });
const grouped = (...conditions) => ({ AND: [{ conditions }] });
const implicit = (path, conditions, extra = {}) => ({ path, conditions, __implicit: true, ...extra });
const synthetic = (...groups) => ({ __implicit: true, ANY: groups });
const marked = (item, scopes, id = 9) => ({ ...item, __scope: { id, scopes } });
const frameInterface = new GraphQLInterfaceType({ name: 'CfAbstract', fields: { name: { type: GraphQLString } } });
const frameUnionMember = new GraphQLObjectType({ name: 'CfUnionMember', fields: { name: { type: GraphQLString } } });
const frameUnion = new GraphQLUnionType({ name: 'CfUnion', types: [frameUnionMember] });
const recursive = new GraphQLObjectType({
  name: 'CfCategory',
  fields: () => ({
    id: { type: GraphQLID }, name: { type: GraphQLString }, n: { type: GraphQLInt },
    tags: { type: new GraphQLList(GraphQLString) }, abstract: { type: frameInterface }, union: { type: frameUnion },
    children: { type: new GraphQLList(recursive), extensions: { relation: { connectionField: 'parent' } } },
    parent: { type: recursive, extensions: { relation: {} } },
    lines: { type: new GraphQLList(recursive), extensions: { relation: { embedded: true } } },
    detail: { type: recursive, extensions: { relation: { embedded: true } } },
  }),
});
const treeContext = { ...enabled, gqltype: recursive };

describe.each(contexts)('collection frames: validator (%s)', (label, shape) => {
  const ctx = { ...enabled, ...shape };
  afterEach(() => limits.configureQueryLimits());
  const rejects = (args, code, override = {}) => {
    const error = errorOf(() => frames.validateQuantifiedGroups(args, { ...ctx, ...override }));
    expect(error?.extensions).toMatchObject({ code, status: 400 });
  };
  it.each([
    [{ AND: [{ mystery: [] }] }, 'INVALID_FILTER_VALUE'],
    [{ AND: [{ path: 'reviews' }] }, 'INVALID_FILTER_VALUE'],
    [{ AND: [{ conditions: {} }] }, 'INVALID_FILTER_VALUE'],
    [{ AND: [{ ANY: [null] }] }, 'INVALID_FILTER_VALUE'],
    [{ AND: [{ ANY: [{}] }] }, 'INVALID_FILTER_PATH'],
    [{ reviews: { quantifier: 'ANY', terms: [{ operator: 'EQ', value: 1 }] } }, 'INVALID_FILTER_PATH'],
    [{ reviews: { quantifier: 'NONE', terms: [{ operator: 'IS_NOT_EMPTY' }] } }, 'INVALID_FILTER_PATH'],
    [{ reviews: { quantifier: 'ANY', terms: [{ path: '' }] } }, 'INVALID_FILTER_PATH'],
    [{ reviews: {} }, 'MISSING_FILTER_PATH'],
    [{ reviews: { terms: [] } }, 'MISSING_FILTER_PATH'],
    [grouped(condition('missing')), 'INVALID_FILTER_FIELD'],
    [grouped(condition('name.foo')), 'INVALID_FILTER_PATH'],
    [grouped(condition('reviews..rating')), 'INVALID_FILTER_PATH'],
    [grouped({ ...condition('reviews.rating'), path: 'x' }), 'AMBIGUOUS_FILTER_FIELD'],
    [grouped(condition('shop', 'UNKNOWN')), 'MISSING_FILTER_PATH'],
    [grouped(condition('shop.products', 'UNKNOWN')), 'INVALID_FILTER_PATH'],
    [grouped(condition('name', 'UNKNOWN')), 'INVALID_FILTER_OPERATOR'],
    [grouped(condition('reviews.author', 'IS_EMPTY', null)), 'INVALID_FILTER_PATH'],
    [grouped(condition('reviews.author', 'CONTAINS_ALL', ['x'])), 'INVALID_FILTER_PATH'],
    [{ AND: [{ ANY: [{ path: 'reviews.product.reviews' }] }] }, 'INVALID_FILTER_PATH'],
    [{ AND: [{ ANY: [{ path: 'name' }] }] }, 'INVALID_FILTER_PATH'],
    [{ AND: [{ ANY: [{ path: 'odim' }] }] }, 'INVALID_FILTER_PATH'],
    [{ AND: [{ ANY: [{ path: 'olines' }] }] }, 'UNSUPPORTED_QUERY'],
    [grouped(condition('name', 'EQ', [])), 'INVALID_FILTER_VALUE'],
    [grouped(condition('name', 'BTW', [1])), 'INVALID_FILTER_VALUE'],
    [grouped(condition('stock', 'IEQ', '1')), 'INVALID_FILTER_VALUE'],
    [grouped(condition('shop', 'IS_EMPTY', 1)), 'INVALID_FILTER_VALUE'],
  ])('rejects %j with %s', (args, code) => rejects(args, code));
  it.each([
    { reviews: { quantifier: 'ANY' } },
    { reviews: { quantifier: 'ALL', terms: [] } },
    { shop: { quantifier: 'NONE', terms: [{ path: 'name', operator: 'EQ', value: 'x' }] } },
    { AND: [{ ANY: [{ path: 'reviews', conditions: [condition('author', 'IS_EMPTY', null)] }] }] },
    { AND: [{ __scope: { irrelevant: true }, conditions: [condition('name')] }] },
    { reviews: { terms: [{ operator: 'IS_NOT_EMPTY' }] } },
  ])('accepts %j', (args) => expect(() => frames.validateQuantifiedGroups(args, ctx)).not.toThrow());
  it.each(['ANY', 'ALL', 'NONE'])('gates explicit %s and field quantifiers', (quantifier) => {
    rejects({ AND: [{ [quantifier]: [{ path: 'reviews' }] }] }, 'UNSUPPORTED_QUERY', { quantifiers: false });
    rejects({ reviews: { quantifier } }, 'UNSUPPORTED_QUERY', { quantifiers: false });
  });
  it('orders shape, path, object-end, operator, permanent path, value and feature errors', () => {
    rejects({ AND: [{ ANY: [{}], typo: [] }] }, 'INVALID_FILTER_VALUE', { quantifiers: false });
    rejects({ reviews: { quantifier: 'ANY', terms: [{ operator: 'UNKNOWN' }] } }, 'INVALID_FILTER_PATH', { quantifiers: false });
    rejects(grouped(condition('name', 'UNKNOWN', [])), 'INVALID_FILTER_OPERATOR');
    rejects(grouped(condition('reviews.author', 'CONTAINS_ALL', null)), 'INVALID_FILTER_PATH');
    rejects({ reviews: { quantifier: 'ANY', terms: [{ path: 'rating', operator: 'EQ', value: [] }] } }, 'INVALID_FILTER_VALUE', { quantifiers: false });
    rejects(grouped(condition('shop', 'IS_EMPTY', 1)), 'UNSUPPORTED_QUERY', { operators: new Set(['EQ']) });
  });
  it('validates filled markers last and ignores a plain-group marker', () => {
    const args = grouped(marked(condition('reviews.rating', 'GTE', 4), { reviews: null }));
    expect(() => frames.validateQuantifiedGroups(args, ctx)).not.toThrow();
    const bad = grouped({ ...condition('reviews.rating', 'GTE', []), __scope: {} });
    rejects(bad, 'INVALID_FILTER_VALUE');
    const error = errorOf(() => frames.validateQuantifiedGroups(grouped({ ...condition('reviews.rating', 'GTE', 4), __scope: {} }), ctx));
    expect(error?.extensions).toMatchObject({ code: 'DETACHED_CLIENT_FILTER', status: 500 });
  });
});

describe('collection frames: validator nesting and rewritten forms', () => {
  afterEach(() => limits.configureQueryLimits());
  const nested = (count) => (count ? { ANY: [{ path: 'children', ...nested(count - 1) }] } : { conditions: [condition('name')] });
  it.each([3, 4])('checks shorthand, explicit and mixed frame chains of %s', (count) => {
    const inputs = [grouped(condition(`${'children.'.repeat(count)}name`)), { AND: [nested(count)] },
      { AND: [{ ANY: [{ path: 'children', conditions: [condition(`${'children.'.repeat(count - 1)}name`)] }] }] }];
    for (const args of inputs) {
      const error = errorOf(() => frames.validateQuantifiedGroups(args, treeContext));
      if (count === 3) expect(error).toBeNull();
      else expect(error?.extensions.code).toBe('FILTER_DEPTH_EXCEEDED');
    }
  });
  it('counts empty logical groups for depth and explicit groups as levels', () => {
    limits.configureQueryLimits({ maxFrameNesting: 20 });
    let deep = {};
    for (let index = 0; index < 7; index++) deep = { AND: [deep] };
    expect(errorOf(() => frames.validateQuantifiedGroups(deep, treeContext))?.extensions.code).toBe('FILTER_DEPTH_EXCEEDED');
  });
  it('accepts shorthand and implicit paths crossing embedded lists but rejects an explicit equivalent', () => {
    const args = grouped(condition('lines.children.name'));
    expect(() => frames.validateQuantifiedGroups(args, treeContext)).not.toThrow();
    const output = frames.frameCollectionPaths(args, treeContext);
    expect(output).toEqual({ AND: [{ conditions: [], ANY: [implicit('lines.children', [condition('name')])] }] });
    expect(() => frames.validateQuantifiedGroups(output, treeContext)).not.toThrow();
    expect(errorOf(() => frames.validateQuantifiedGroups({ AND: [{ ANY: [{ path: 'lines.children' }] }] }, treeContext))?.extensions.code).toBe('INVALID_FILTER_PATH');
  });
  it('revalidates output without letting implicit nesting bypass the limit', () => {
    const args = grouped(condition('children.children.children.children.name'));
    limits.configureQueryLimits({ maxFrameNesting: 4 });
    const output = frames.frameCollectionPaths(args, treeContext);
    expect(() => frames.validateQuantifiedGroups(output, treeContext)).not.toThrow();
    limits.configureQueryLimits();
    expect(errorOf(() => frames.validateQuantifiedGroups(output, treeContext))?.extensions.code).toBe('FILTER_DEPTH_EXCEEDED');
  });
  it('ignores J for explicit frames on a repeated type', () => {
    const args = { AND: [{ ANY: [{ path: 'children', conditions: [condition('children.name')] }] }] };
    expect(frames.frameCollectionPaths(args, { ...treeContext, J: new Set(['children', 'children.children']) }))
      .toEqual({ AND: [{ ANY: [{ path: 'children', conditions: [], ANY: [implicit('children', [condition('name')])] }] }] });
  });
});

describe('collection frames: rewrite', () => {
  const ctx = { ...enabled, gqltype: frameTypes.Product };
  it.each([
    [grouped(condition('reviews.rating', 'GTE', 4)), { AND: [{ conditions: [], ANY: [implicit('reviews', [condition('rating', 'GTE', 4)])] }] }],
    [grouped({ field: 'reviews', path: 'rating', operator: 'GTE', value: 4 }), { AND: [{ conditions: [], ANY: [implicit('reviews', [condition('rating', 'GTE', 4)])] }] }],
    [{ reviews: { terms: [{ path: 'rating', operator: 'GTE', value: 4 }] } }, { AND: [synthetic(implicit('reviews', [condition('rating', 'GTE', 4)]))] }],
    [{ shop: { terms: [{ path: 'products.name', operator: 'EQ', value: 'a' }, { path: 'name', operator: 'EQ', value: 's' }] } },
      { shop: { terms: [{ path: 'name', operator: 'EQ', value: 's' }] }, AND: [synthetic(implicit('shop.products', [condition('name', 'EQ', 'a')]))] }],
    [{ reviews: { quantifier: 'ALL', terms: [{ path: 'rating', operator: 'GTE', value: 4 }] } },
      { AND: [{ __implicit: true, ALL: [{ path: 'reviews', conditions: [condition('rating', 'GTE', 4)] }] }] }],
    [{ reviews: { quantifier: 'ANY' } }, { AND: [{ __implicit: true, ANY: [{ path: 'reviews', conditions: [] }] }] }],
  ])('rewrites %j exactly once', (input, expected) => {
    const snapshot = structuredClone(input);
    const output = frames.frameCollectionPaths(input, ctx);
    expect(output).toEqual(expected);
    expect(input).toEqual(snapshot);
    expect(frames.frameCollectionPaths(output, ctx)).toEqual(expected);
    expect(() => frames.validateQuantifiedGroups(output, ctx)).not.toThrow();
  });
  it('correlates conditions and terms per group and separates nested logical groups and OR branches', () => {
    const a = condition('reviews.rating', 'GTE', 4);
    const b = condition('reviews.author', 'EQ', 'x');
    const one = implicit('reviews', [condition('rating', 'GTE', 4), condition('author', 'EQ', 'x')]);
    expect(frames.frameCollectionPaths(grouped(a, b), ctx)).toEqual({ AND: [{ conditions: [], ANY: [one] }] });
    expect(frames.frameCollectionPaths({ reviews: { terms: [{ path: 'rating', operator: 'GTE', value: 4 }, { path: 'author', operator: 'EQ', value: 'x' }] } }, ctx))
      .toEqual({ AND: [synthetic(one)] });
    const split = { conditions: [a], AND: [{ conditions: [b] }], OR: [{ conditions: [a] }, { conditions: [b] }] };
    expect(frames.frameCollectionPaths({ AND: [split] }, ctx)).toEqual({ AND: [{
      conditions: [], AND: [{ conditions: [], ANY: [implicit('reviews', [condition('author', 'EQ', 'x')])] }],
      OR: [{ conditions: [], ANY: [implicit('reviews', [condition('rating', 'GTE', 4)])] }, { conditions: [], ANY: [implicit('reviews', [condition('author', 'EQ', 'x')])] }],
      ANY: [implicit('reviews', [condition('rating', 'GTE', 4)])],
    }] });
  });
  it('nests longer prefixes inside the same witness and expands quantifier filters before cutting', () => {
    const input = grouped(condition('children.n', 'EQ', 2020), condition('children.children.name', 'EQ', 'a'));
    const expected = { AND: [{ conditions: [], ANY: [implicit('children', [condition('n', 'EQ', 2020)], { ANY: [implicit('children', [condition('name', 'EQ', 'a')])] })] }] };
    expect(frames.frameCollectionPaths(input, treeContext)).toEqual(expected);
    expect(frames.frameCollectionPaths({ children: { quantifier: 'ALL', terms: [{ path: 'children.n', operator: 'GT', value: 20 }] } }, treeContext))
      .toEqual({ AND: [{ __implicit: true, ALL: [{ path: 'children', conditions: [], ANY: [implicit('children', [condition('n', 'GT', 20)])] }] }] });
    expect(frames.frameCollectionPaths({ shop: { quantifier: 'NONE', terms: [{ path: 'products.stock', operator: 'EQ', value: 5 }] } }, ctx))
      .toEqual({ AND: [{ __implicit: true, NONE: [{ path: 'shop', conditions: [], ANY: [implicit('products', [condition('stock', 'EQ', 5)])] }] }] });
  });
  it('splits markers, strips unrelated union keys and takes the first marked prefix values', () => {
    const scope = { AND: [{ conditions: [condition('name')] }] };
    const input = grouped(condition('reviews.rating', 'GTE', 4), marked(condition('reviews.product.name'), { reviews: null, 'reviews.product': scope, unrelated: scope }));
    const expected = { AND: [{ conditions: [], ANY: [implicit('reviews', [condition('rating', 'GTE', 4), marked(condition('product.name'), { product: scope })], { __scope: { scopes: { reviews: null } } })] }] };
    expect(frames.frameCollectionPaths(input, ctx)).toEqual(expected);
    expect(frames.frameCollectionPaths(expected, ctx)).toEqual(expected);
    const nested = grouped(marked(condition('children.children.name'), { children: null, 'children.children': scope, unrelated: null }));
    expect(frames.frameCollectionPaths(nested, treeContext)).toEqual({ AND: [{ conditions: [], ANY: [implicit('children', [], {
      __scope: { scopes: { children: null } }, ANY: [implicit('children', [condition('name')], { __scope: { scopes: { children: scope } } })],
    })] }] });
  });
  it('keeps quantified filter and term markers on their own frames', () => {
    const input = { reviews: marked({ quantifier: 'ALL', terms: [marked({ path: 'product.name', operator: 'EQ', value: 'x' }, { product: null })] }, { reviews: null }) };
    expect(frames.frameCollectionPaths(input, ctx)).toEqual({ AND: [{ __implicit: true, ALL: [marked({ path: 'reviews', conditions: [marked(condition('product.name'), { product: null })] }, { reviews: null })] }] });
  });
  it('keeps 2b collection ends and returns the input unchanged without quantifiers', () => {
    const input = { reviews: { terms: [{ operator: 'IS_EMPTY' }] }, AND: [{ conditions: [condition('reviews', 'IS_NOT_EMPTY', null)] }] };
    expect(frames.frameCollectionPaths(input, ctx)).toEqual(input);
    expect(frames.frameCollectionPaths(grouped(condition('reviews.rating', 'GTE', 4)), { ...ctx, quantifiers: false }))
      .toEqual(grouped(condition('reviews.rating', 'GTE', 4)));
  });
});

describe('collection frames: J and crossing keys', () => {
  const ctx = { ...enabled, gqltype: frameTypes.Product, operation: 'aggregate', J: new Set(['reviews']) };
  it('gathers all collection prefixes only from fully resolvable aggregate paths', () => {
    expect(frames.aggregateJoinPrefixes({ groupId: 'children.children.n', facts: [{ path: 'children.parent.children.name' }, { path: 'missing.children' }] }, treeContext))
      .toEqual(new Set(['children', 'children.children', 'children.parent.children']));
    expect(frames.aggregateJoinPrefixes({ groupId: 'children.missing', facts: [{ path: null }] }, treeContext)).toEqual(new Set());
    expect(frames.aggregateJoinPrefixes(null, treeContext)).toEqual(new Set());
  });
  it('keeps top-frame J predicates and anchors later frames after intervening references', () => {
    const leaf = condition('reviews.author');
    expect(frames.frameCollectionPaths(grouped(leaf), ctx)).toEqual(grouped(leaf));
    const input = grouped(marked(condition('reviews.product.reviews.rating', 'GTE', 5), { reviews: null, 'reviews.product.reviews': null }));
    const expected = { AND: [{ conditions: [], ANY: [implicit('reviews', [condition('rating', 'GTE', 5)], {
      __anchor: ['reviews', 'product'], __scope: { scopes: { reviews: null, 'reviews.product.reviews': null } },
    })] }] };
    const output = frames.frameCollectionPaths(input, ctx);
    expect(output).toEqual(expected);
    expect(frames.frameCollectionPaths(output, ctx)).toEqual(expected);
    expect(() => frames.validateQuantifiedGroups(output, ctx)).not.toThrow();
    expect(frames.frameCollectionPaths(grouped(leaf), { ...ctx, J: new Set() })).not.toEqual(grouped(leaf));
  });
  it.each(contexts)('crossing keys are the single references actually crossed (%s)', (name, shape) => {
    expect(frames.crossingKeys(['shop', 'products', 'pro', 'shop', 'name'], shape)).toEqual(['shop', 'shop.products.pro', 'shop.products.pro.shop']);
    expect(frames.crossingKeys(['shop'], shape)).toEqual([]);
    expect(frames.crossingKeys(['olines', 'shop', 'name'], shape)).toEqual(['olines.shop']);
  });
});

describe('collection frames: units', () => {
  const ctx = { ...enabled, gqltype: frameTypes.Product };
  const count = (args, override = {}) => frames.frameUnits(args, { ...ctx, ...override }).count;
  it('counts unmarked shorthand per group and nested prefix, separately from explicit and field frames', () => {
    expect(count(grouped(condition('reviews.rating', 'GTE', 4), condition('reviews.author')))).toBe(1);
    expect(count({ reviews: { terms: [{ path: 'rating', operator: 'EQ', value: 4 }, { path: 'author', operator: 'EQ', value: 'x' }] } })).toBe(1);
    expect(count({ AND: [{ conditions: [condition('reviews.rating', 'GTE', 4)], ANY: [{ path: 'reviews' }] }] })).toBe(2);
    expect(count({ AND: [{ ANY: [{ path: 'reviews' }, { path: 'reviews' }] }] })).toBe(2);
    expect(count({ reviews: { quantifier: 'ANY' }, AND: [{ conditions: [condition('reviews.author')] }] })).toBe(2);
    expect(frames.frameUnits(grouped(condition('children.children.name')), treeContext).count).toBe(2);
  });
  it('dedupes reference joins shared by a frame and distinguishes nested frames', () => {
    const args = { AND: [{ ANY: [{ path: 'reviews', conditions: [condition('product.shop.name'), condition('product.shop.state')], AND: [{ conditions: [condition('product.shop.name')] }] }] }] };
    expect(count(args)).toBe(3);
    expect(count({ AND: [{ ANY: [{ path: 'reviews', conditions: [condition('product.name')] }, { path: 'reviews', conditions: [condition('product.name')] }] }] })).toBe(4);
    expect(count(grouped(condition('shop.products.name')))).toBe(2);
  });
  it('preserves 2b kind/path dedupe but keeps frame and join kinds separate', () => {
    expect(count(grouped(condition('shop', 'IS_EMPTY', null), condition('shop', 'IS_NOT_EMPTY', null)))).toBe(1);
    expect(count(grouped(condition('shop.products', 'IS_EMPTY', null), condition('shop.products', 'IS_NOT_EMPTY', null)))).toBe(2);
    expect(count(grouped(condition('shop', 'IS_EMPTY', null), condition('shop.name', 'IS_EMPTY', null)))).toBe(2);
  });
  it('does not count legacy joins or aggregate anchor segments and keeps stable unique unit strings', () => {
    expect(count(grouped(condition('shop.name')))).toBe(0);
    const args = grouped(condition('reviews.product.reviews.rating', 'GTE', 5));
    expect(count(args, { J: new Set(['reviews']), operation: 'aggregate' })).toBe(1);
    const units = frames.frameUnits(args, ctx);
    expect(units.count).toBe(units.units.length);
    expect(new Set(units.units).size).toBe(units.count);
    expect(frames.frameUnits(args, ctx)).toEqual(units);
  });
  it('is independent of markers and supported by model descriptions', () => {
    const args = grouped(condition('shop.products.pro.name'));
    expect(count(args)).toBe(3);
    expect(count(grouped(marked(condition('shop.products.pro.name'), { shop: null, 'shop.products': null, 'shop.products.pro': null })))).toBe(3);
    expect(frames.frameUnits(args, { ...enabled, models: plainFrameModels, entity: frameTypes.Product.name }).count).toBe(3);
  });
});


describe('collection frames: validator edge order and sort', () => {
  const ctx = { ...enabled, gqltype: frameTypes.Product };
  afterEach(() => limits.configureQueryLimits());
  it.each(['ANY', 'ALL', 'NONE'])('gates a non-null empty %s list but accepts null', (type) => {
    expect(errorOf(() => frames.validateQuantifiedGroups({ AND: [{ [type]: [] }] }, { ...ctx, quantifiers: false }))?.extensions.code).toBe('UNSUPPORTED_QUERY');
    expect(() => frames.validateQuantifiedGroups({ AND: [{ [type]: null }] }, { ...ctx, quantifiers: false })).not.toThrow();
  });
  it('rejects CONTAINS_ALL on a non-list own field and gives the permanent shorthand reason through collections', () => {
    expect(errorOf(() => frames.validateQuantifiedGroups(grouped(condition('name', 'CONTAINS_ALL', ['x'])), ctx))?.extensions.code).toBe('INVALID_FILTER_OPERATOR');
    expect(errorOf(() => frames.validateQuantifiedGroups(grouped(condition('name', 'CONTAINS_ALL', ['x'])), ctx))?.message)
      .toBe('CONTAINS_ALL requires a list field, or a field reached through an embedded list; name is not one');
    for (const operator of ['IS_EMPTY', 'IS_NOT_EMPTY', 'CONTAINS_ALL']) {
      const error = errorOf(() => frames.validateQuantifiedGroups(grouped(condition('reviews.author', operator, null)), ctx));
      expect(error?.extensions.code).toBe('INVALID_FILTER_PATH');
      expect(error?.message).toContain('shorthand excludes them; use an explicit group');
    }
  });
  it.each(['find', 'count'])('checks sort shape then path then collection before scalar end in %s mode', (operation) => {
    const check = (sort) => errorOf(() => frames.validateQuantifiedGroups({ sort }, { ...ctx, operation }));
    expect(check({ terms: [{ field: 'reviews..rating', order: 'INVALID' }] })?.extensions.code).toBe('INVALID_SORT');
    expect(check({ terms: [{ field: 'reviews..rating', order: 'ASC' }] })?.extensions.code).toBe('INVALID_FILTER_PATH');
    expect(check({ terms: [{ field: 'reviews', order: 'ASC' }] })?.message).toContain('collection');
    expect(check({ terms: [{ field: 'shop', order: 'ASC' }] })?.extensions.code).toBe('INVALID_FILTER_PATH');
    expect(check({ terms: [{ field: 'olines.shop.name', order: 'ASC' }] })).toBeNull();
  });
  it('leaves aggregate result-key sort paths exempt from schema resolution', () => {
    expect(() => frames.validateQuantifiedGroups({ sort: { terms: [{ field: 'total', order: 'DESC' }] } }, { ...ctx, operation: 'aggregate' })).not.toThrow();
  });
  it('resolves and rewrites collection paths across embedded lists from model descriptions', () => {
    const modelCtx = { ...enabled, models: plainFrameModels, entity: frameTypes.Product.name };
    const args = grouped(condition('olines.shop.products.name'));
    const output = frames.frameCollectionPaths(args, modelCtx);
    expect(output).toEqual({ AND: [{ conditions: [], ANY: [implicit('olines.shop.products', [condition('name')])] }] });
    expect(() => frames.validateQuantifiedGroups(output, modelCtx)).not.toThrow();
    expect(errorOf(() => frames.validateQuantifiedGroups({ AND: [{ ANY: [{ path: 'olines.shop.products' }] }] }, modelCtx))?.extensions.code).toBe('INVALID_FILTER_PATH');
  });
  it('validates implicit markers inside frames with J empty', () => {
    const inner = implicit('children.parent.children', [condition('name')], { __scope: { scopes: { children: null, 'children.parent': null, 'children.parent.children': null } } });
    const args = { AND: [{ ANY: [{ path: 'children', ANY: [inner] }] }] };
    expect(() => frames.validateQuantifiedGroups(args, { ...treeContext, J: new Set(['children']) })).not.toThrow();
  });
  it('counts a 2b reference-end frame toward nesting', () => {
    limits.configureQueryLimits({ maxFrameNesting: 1 });
    const args = { AND: [{ ANY: [{ path: 'reviews', conditions: [condition('product', 'IS_EMPTY', null)] }] }] };
    expect(errorOf(() => frames.validateQuantifiedGroups(args, ctx))?.extensions.code).toBe('FILTER_DEPTH_EXCEEDED');
  });
});

describe('collection frames: units scope chains', () => {
  const ctx = { ...enabled, gqltype: frameTypes.Product };
  it('shares a containing-frame reference join across separate shorthand groups', () => {
    const args = { AND: [{ conditions: [condition('shop.products.name')] }, { conditions: [condition('shop.products.stock', 'EQ', 5)] }] };
    expect(frames.frameUnits(args, ctx).count).toBe(3);
  });
  it('dedupes 2b pairs inside one frame and separates the same paths in different frames', () => {
    const inner = [condition('product', 'IS_EMPTY', null), condition('product', 'IS_NOT_EMPTY', null)];
    expect(frames.frameUnits({ AND: [{ ANY: [{ path: 'reviews', conditions: inner }] }] }, ctx).count).toBe(2);
    expect(frames.frameUnits({ AND: [{ ANY: [{ path: 'reviews', conditions: inner }, { path: 'reviews', conditions: inner }] }] }, ctx).count).toBe(4);
  });
  it('never descends into filled scope queries', () => {
    const args = grouped(marked(condition('reviews.author'), { reviews: { AND: [{ ANY: [{ path: 'product.shop.products.reviews' }] }] } }));
    expect(frames.frameUnits(args, ctx).count).toBe(1);
  });
  it('drops anchor-reference union keys instead of turning legacy joins into scoped joins', () => {
    const args = grouped(marked(condition('reviews.product.reviews.author'), { reviews: null, 'reviews.product': null, 'reviews.product.reviews': null }));
    const output = frames.frameCollectionPaths(args, { ...ctx, J: new Set(['reviews']) });
    expect(output.AND[0].ANY[0].__scope.scopes).toEqual({ reviews: null, 'reviews.product.reviews': null });
  });
});

describe('collection frames: internal exports and import order', () => {
  it.each(['operators', 'plan', 'frames', 'core'])('initializes from the %s entry in a fresh process', (first) => {
    const fixture = fileURLToPath(new URL('./fixtures/collection-frames-import-order.js', import.meta.url));
    const result = spawnSync(process.execPath, [fixture, first], { encoding: 'utf8', timeout: 15000 });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(result.stdout.trim()).toBe('collection frame imports passed');
  });
});


describe('collection frames: rewrite aliases', () => {
  it('preserves one logical group in one frame and distinct groups across frame and quantifier contexts', () => {
    const shared = { conditions: [condition('children.name')] };
    const explicit = { path: 'children', AND: [shared] };
    const input = { AND: [shared, shared, { ANY: [explicit], NONE: [explicit] }] };
    const output = frames.frameCollectionPaths(input, treeContext);
    expect(output.AND[0]).toBe(output.AND[1]);
    const any = output.AND[2].ANY[0];
    const none = output.AND[2].NONE[0];
    expect(any).not.toBe(none);
    expect(any.AND[0]).not.toBe(output.AND[0]);
    expect(any.AND[0]).not.toBe(none.AND[0]);
    expect(frames.frameUnits(input, treeContext).count).toBe(5);
    const repeated = frames.frameCollectionPaths(output, treeContext);
    expect(repeated).toEqual(output);
    expect(repeated.AND[0]).toBe(repeated.AND[1]);
  });
  it('rejects cycles in validation and terminates a direct rewrite cycle without mutating it', () => {
    const cycle = { conditions: [condition('name')] };
    cycle.AND = [cycle];
    expect(errorOf(() => frames.validateQuantifiedGroups({ AND: [cycle] }, treeContext))?.extensions.code).toBe('FILTER_DEPTH_EXCEEDED');
    const output = frames.frameCollectionPaths({ AND: [cycle] }, treeContext);
    expect(output.AND[0]).not.toBe(cycle);
    expect(output.AND[0].AND[0]).toBe(output.AND[0]);
    expect(cycle.AND[0]).toBe(cycle);
  });
});


describe('collection frames: remaining validator and rewrite contracts', () => {
  it.each(['tags', 'abstract', 'union'])('rejects an explicit frame ending at %s before the capability gate', (path) => {
    expect(errorOf(() => frames.validateQuantifiedGroups({ AND: [{ ANY: [{ path }] }] }, { ...treeContext, quantifiers: false }))?.extensions.code).toBe('INVALID_FILTER_PATH');
  });
  it('uses the first marked member for the shared prefix and retains operand extensions', () => {
    const first = marked(condition('children.name'), { children: null, unrelated: null }, 7);
    const second = marked({ ...condition('children.n', 'EQ', 1), valuePath: 'other', customOperand: 2 }, { children: { different: true } }, 8);
    expect(frames.frameCollectionPaths(grouped(first, second), treeContext)).toEqual({ AND: [{ conditions: [], ANY: [implicit('children', [condition('name'), { ...condition('n', 'EQ', 1), valuePath: 'other', customOperand: 2 }], { __scope: { scopes: { children: null } } })] }] });
  });
  it('rejects non-null J scopes on marked aggregate anchors after all value errors', () => {
    const ctx = { ...enabled, gqltype: frameTypes.Product, operation: 'aggregate', J: new Set(['reviews']) };
    const bad = implicit('reviews', [condition('rating', 'GTE', 4)], {
      __anchor: ['reviews', 'product'], __scope: { scopes: { reviews: { AND: [] }, 'reviews.product.reviews': null } },
    });
    expect(errorOf(() => frames.validateQuantifiedGroups({ AND: [{ ANY: [bad] }] }, ctx))?.extensions).toMatchObject({ code: 'DETACHED_CLIENT_FILTER', status: 500 });
    const invalidValue = { ...bad, conditions: [condition('rating', 'GTE', [])] };
    expect(errorOf(() => frames.validateQuantifiedGroups({ AND: [{ ANY: [invalidValue] }] }, ctx))?.extensions.code).toBe('INVALID_FILTER_VALUE');
  });
});

describe('collection frames: pending runtime markers', () => {
  const ctx = { ...enabled, gqltype: frameTypes.Product };
  it.each([undefined, null, false, 'other'])('requires filled markers by default and with accidental option %j', (scopeMarkers) => {
    const args = grouped({ ...condition('reviews.author'), __scope: { id: 1 } });
    expect(errorOf(() => frames.validateQuantifiedGroups(args, { ...ctx, scopeMarkers }))?.extensions).toMatchObject({ code: 'DETACHED_CLIENT_FILTER', status: 500 });
  });
  it('lets the runtime validate before fill only with the literal pending mode', () => {
    const args = grouped({ ...condition('reviews.author'), __scope: { id: 1 } });
    expect(() => frames.validateQuantifiedGroups(args, { ...ctx, scopeMarkers: 'pending' })).not.toThrow();
  });
  it('keeps every path and value gate active with pending markers', () => {
    const pending = { ...ctx, scopeMarkers: 'pending' };
    expect(errorOf(() => frames.validateQuantifiedGroups(grouped({ ...condition('reviews.missing'), __scope: { id: 1 } }), pending))?.extensions.code).toBe('INVALID_FILTER_FIELD');
    expect(errorOf(() => frames.validateQuantifiedGroups(grouped({ ...condition('reviews.author', 'EQ', []), __scope: { id: 1 } }), pending))?.extensions.code).toBe('INVALID_FILTER_VALUE');
    expect(errorOf(() => frames.validateQuantifiedGroups({ reviews: { quantifier: 'ANY', terms: [{ operator: 'IS_EMPTY' }] } }, pending))?.extensions.code).toBe('INVALID_FILTER_PATH');
  });
});


// Phase 1 correction: explicit compatibility boundaries and adversarial scope unions.
const fixValue = new GraphQLObjectType({ name: 'CfFixValue', fields: { name: { type: GraphQLString } } });
const fixNode = new GraphQLObjectType({
  name: 'CfFixNode',
  fields: () => ({
    id: { type: GraphQLID }, name: { type: GraphQLString },
    parent: { type: fixNode, extensions: { relation: {} } },
    children: { type: new GraphQLList(fixNode), extensions: { relation: { connectionField: 'parent' } } },
    values: { type: new GraphQLList(fixValue), extensions: { relation: { embedded: true } } },
  }),
});
const fixModels = describeModels([{ gqltype: fixNode }, { gqltype: fixValue, endpoint: false }]);
const fixModelOnly = { entities: fixModels.entities.map((entity) => Object.fromEntries(Object.entries(entity).filter(([key]) => key !== 'gqltype'))) };
const fixContexts = [['GraphQL', { gqltype: fixNode }], ['models', { models: fixModelOnly, entity: fixNode.name }]];

const ordinaryCarriers = [
  ['EQ', {}], ['LIKE', {}], ['IEQ', { value: [] }], ['FUTURE', {}],
];
const objectTerms = [['shop', 'name', 'x'], ['odim', 'w', 1], ['reviews', 'rating', 4]];

describe('collection frames: phase1 fix1 baseline pins', () => {
  it.each(ordinaryCarriers)('pin: direct planning ignores %s carrier operator/value beside actual object terms', (operator, operand) => {
    for (const [field, path, value] of objectTerms) {
      const args = { [field]: { operator, ...operand, terms: [{ path, operator: 'EQ', value }] } };
      expect(createQueryPlan(frameModels, frameTypes.Product.name, args, { operators: ['EQ'], referenceEmptiness: true }).where)
        .toEqual({ kind: 'predicate', path: [field, path], operator: 'EQ', value });
    }
  });
  it('pin: direct planning keeps long legacy collection paths with a declared legacy operator', () => {
    const path = 'children.children.children.children.name';
    expect(createQueryPlan(fixModels, fixNode.name, grouped(condition(path)), { operators: ['EQ'], referenceEmptiness: false }).where)
      .toEqual({ kind: 'predicate', path: path.split('.'), operator: 'EQ', value: 'x' });
  });
});

describe.each(fixContexts)('collection frames: phase1 fix1 F1 nesting (%s)', (label, shape) => {
  afterEach(() => limits.configureQueryLimits());
  it.each(['find', 'count'])('counts shorthand only when quantifiers compile frames in %s', (operation) => {
    for (const [limit, count] of [[3, 4], [1, 2]]) {
      limits.configureQueryLimits({ maxFrameNesting: limit });
      const rest = `${'children.'.repeat(count - 1)}name`;
      const inputs = [grouped(condition(`children.${rest}`)), grouped({ ...condition('children'), path: rest }),
        { children: { terms: [{ path: rest, operator: 'EQ', value: 'x' }] } }];
      for (const args of inputs) {
        const disabled = { ...shape, operation, quantifiers: false, referenceEmptiness: false };
        expect(() => frames.validateQuantifiedGroups(args, disabled)).not.toThrow();
        expect(frames.frameCollectionPaths(args, disabled)).toBe(args);
        expect(frames.frameUnits(args, disabled)).toEqual({ count: 0, units: [] });
        expect(errorOf(() => frames.validateQuantifiedGroups(args, { ...disabled, quantifiers: true, referenceEmptiness: true }))?.extensions.code).toBe('FILTER_DEPTH_EXCEEDED');
      }
    }
  });
  it('keeps implicit and 2b frame nesting and all predicate checks active without quantifiers', () => {
    limits.configureQueryLimits({ maxFrameNesting: 1 });
    const ctx = { ...shape, operation: 'find', quantifiers: false, referenceEmptiness: true };
    const nested = { AND: [synthetic(implicit('children', [], { ANY: [implicit('children', [condition('name')])] }))] };
    expect(errorOf(() => frames.validateQuantifiedGroups(nested, ctx))?.extensions.code).toBe('FILTER_DEPTH_EXCEEDED');
    const emptiness = { AND: [synthetic(implicit('children', [condition('parent', 'IS_EMPTY', null)]))] };
    expect(errorOf(() => frames.validateQuantifiedGroups(emptiness, ctx))?.extensions.code).toBe('FILTER_DEPTH_EXCEEDED');
    expect(errorOf(() => frames.validateQuantifiedGroups(grouped(condition('missing')), ctx))?.extensions.code).toBe('INVALID_FILTER_FIELD');
    expect(errorOf(() => frames.validateQuantifiedGroups(grouped(condition('name', 'EQ', [])), ctx))?.extensions.code).toBe('INVALID_FILTER_VALUE');
    expect(errorOf(() => frames.validateQuantifiedGroups({ AND: [{ ANY: [{ path: 'children' }] }] }, ctx))?.extensions.code).toBe('UNSUPPORTED_QUERY');
  });
});

describe.each(contexts)('collection frames: phase1 fix1 F2 sorts (%s)', (label, shape) => {
  for (const quantifiers of [true, false]) {
    it.each(['find', 'count'])('rejects the first reached collection before descendants in %s, quantifiers=' + quantifiers, (operation) => {
      const ctx = { ...enabled, ...shape, quantifiers, operation };
      for (const [field, collection] of [
        ['reviews.missing', 'CfProduct.reviews'], ['reviews.author.bad', 'CfProduct.reviews'],
        ['reviews.rating', 'CfProduct.reviews'], ['reviews', 'CfProduct.reviews'],
        ['shop.products.missing', 'CfShop.products'],
      ]) {
        const error = errorOf(() => frames.validateQuantifiedGroups({ sort: { terms: [{ field, order: 'ASC' }] } }, ctx));
        expect(error?.extensions).toMatchObject({ code: 'INVALID_FILTER_PATH', status: 400 });
        expect(error?.message).toBe(`Sort path ${field} crosses the collection ${collection}; a record has no single value there`);
      }
    });
  }
  it('keeps whole-sort shape, full-path syntax and earlier prefix failures ahead of collection checks', () => {
    const ctx = { ...enabled, ...shape };
    const check = (terms) => errorOf(() => frames.validateQuantifiedGroups({ sort: { terms } }, ctx));
    expect(check([{ field: 'reviews.missing', order: 'ASC' }, { field: 'name', order: 'BAD' }])?.extensions.code).toBe('INVALID_SORT');
    const syntax = check([{ field: 'reviews..missing', order: 'ASC' }]);
    expect(syntax?.extensions.code).toBe('INVALID_FILTER_PATH');
    expect(syntax?.message).toBe('Invalid sort path');
    const missing = check([{ field: 'missing.reviews.name', order: 'ASC' }]);
    expect(missing?.extensions.code).toBe('INVALID_FILTER_FIELD');
    expect(missing?.message).toBe('Unknown field missing');
    expect(check([{ field: 'name.reviews', order: 'ASC' }])?.message).toBe('Field name cannot be traversed');
    expect(check([{ field: 'shop.name', order: 'ASC' }, { field: 'olines.shop.name', order: 'DESC' }])).toBeNull();
    expect(() => frames.validateQuantifiedGroups({ sort: { terms: [{ field: 'reviews.missing', order: 'ASC' }] } }, { ...ctx, operation: 'aggregate' })).not.toThrow();
  });
});

describe.each(contexts)('collection frames: phase1 fix1 F3 carriers (%s)', (label, shape) => {
  it.each([true, false])('ignores ordinary object carrier semantics while keeping inspection rows, quantifiers=%s', (quantifiers) => {
    const ctx = { ...enabled, ...shape, quantifiers, operators: new Set(['EQ']) };
    for (const [operator, operand] of ordinaryCarriers) for (const [field, path, value] of objectTerms) {
      const args = { [field]: { operator, ...operand, terms: [{ path, operator: 'EQ', value }] } };
      expect(() => frames.validateQuantifiedGroups(args, ctx)).not.toThrow();
      expect(collectQueryOperators(args).map((entry) => [entry.form, entry.operator, entry.path]))
        .toEqual([['beside-terms', operator, field], ['term', 'EQ', `${field}.${path}`]]);
    }
  });
  it('keeps scalar carriers, actual terms, missing terms and own emptiness operators validated', () => {
    const ctx = { ...enabled, ...shape, operators: new Set(['EQ']) };
    const check = (args) => errorOf(() => frames.validateQuantifiedGroups(args, ctx))?.extensions.code;
    expect(check({ name: { operator: 'EQ', terms: [] } })).toBe('INVALID_FILTER_VALUE');
    expect(check({ name: { operator: 'FUTURE', terms: [] } })).toBe('INVALID_FILTER_OPERATOR');
    expect(check({ shop: { operator: 'EQ', terms: [{ path: 'missing', value: 'x' }] } })).toBe('INVALID_FILTER_FIELD');
    expect(check({ shop: { operator: 'FUTURE', terms: [{ path: 'name', operator: 'FUTURE', value: 'x' }] } })).toBe('INVALID_FILTER_OPERATOR');
    expect(check({ shop: { operator: 'IEQ', terms: [{ path: 'name', value: [] }] } })).toBe('INVALID_FILTER_VALUE');
    expect(check({ shop: { operator: 'EQ', terms: [] } })).toBe('MISSING_FILTER_PATH');
    expect(check({ shop: { operator: 'EQ' } })).toBe('MISSING_FILTER_PATH');
    for (const operator of ['IS_EMPTY', 'IS_NOT_EMPTY']) expect(check({ shop: { operator, terms: [{ path: 'name', value: 'x' }] } })).toBe('MISSING_FILTER_PATH');
    expect(() => frames.validateQuantifiedGroups({ shop: { terms: [{ operator: 'IS_EMPTY' }] } }, { ...ctx, operators: new Set(['EQ', 'IS_EMPTY']) })).not.toThrow();
  });
});

describe.each(contexts)('collection frames: phase1 fix1 F4 residual marker keys (%s)', (label, shape) => {
  const ctx = { ...enabled, ...shape };
  const prove = (input, expected, override = {}) => {
    const current = { ...ctx, ...override };
    const before = structuredClone(input);
    expect(() => frames.validateQuantifiedGroups(input, current)).not.toThrow();
    const output = frames.frameCollectionPaths(input, current);
    expect(output).toEqual(expected);
    expect(() => frames.validateQuantifiedGroups(output, current)).not.toThrow();
    expect(input).toEqual(before);
    expect(frames.frameCollectionPaths(output, current)).toEqual(expected);
  };
  it('drops a same-prefix union key from a scalar rest while retaining its frame marker', () => {
    prove(grouped(marked(condition('reviews.rating', 'GTE', 4), { reviews: null, 'reviews.product': null })),
      { AND: [{ conditions: [], ANY: [implicit('reviews', [condition('rating', 'GTE', 4)], { __scope: { scopes: { reviews: null } } })] }] });
  });
  it('retains only actual residual references and isolates scalar and reference members in one bucket', () => {
    const scope = { reviews: null, 'reviews.product': null, 'reviews.product.shop': null };
    const rating = marked(condition('reviews.rating', 'GTE', 4), scope);
    const name = marked(condition('reviews.product.name'), scope);
    prove(grouped(rating, name), { AND: [{ conditions: [], ANY: [implicit('reviews', [condition('rating', 'GTE', 4), marked(condition('product.name'), { product: null })], { __scope: { scopes: { reviews: null } } })] }] });
    prove(grouped(name), { AND: [{ conditions: [], ANY: [implicit('reviews', [marked(condition('product.name'), { product: null })], { __scope: { scopes: { reviews: null } } })] }] });
  });
  it('keeps later collection keys through nested cuts and drops stale keys at the scalar leaf', () => {
    const args = grouped(marked(condition('shop.products.reviews.rating', 'GTE', 4), {
      shop: null, 'shop.products': null, 'shop.products.reviews': null, 'shop.products.reviews.product': null,
    }));
    prove(args, { AND: [{ conditions: [], ANY: [implicit('shop.products', [], {
      __scope: { scopes: { shop: null, 'shop.products': null } },
      ANY: [implicit('reviews', [condition('rating', 'GTE', 4)], { __scope: { scopes: { reviews: null } } })],
    })] }] });
  });
  it('keeps aggregate anchor/J keys while dropping an unrelated residual union key', () => {
    const args = grouped(marked(condition('reviews.product.reviews.rating', 'GTE', 5), {
      reviews: null, 'reviews.product.reviews': null, 'reviews.product.reviews.product': null,
    }));
    prove(args, { AND: [{ conditions: [], ANY: [implicit('reviews', [condition('rating', 'GTE', 5)], {
      __anchor: ['reviews', 'product'], __scope: { scopes: { reviews: null, 'reviews.product.reviews': null } },
    })] }] }, { operation: 'aggregate', J: new Set(['reviews']) });
  });
  it('filters the legitimate union of one aliased term separately at each occurrence', () => {
    const term = marked({ path: 'rating', operator: 'GTE', value: 4 }, {
      reviews: null, 'reviews.product': null, 'reviews.product.reviews': null,
    });
    const args = { reviews: { terms: [term] }, 'reviews.product.reviews': { terms: [term] } };
    prove(args, { AND: [synthetic(
      implicit('reviews', [condition('rating', 'GTE', 4)], { __scope: { scopes: { reviews: null } } }),
      implicit('reviews', [], { __scope: { scopes: { reviews: null } }, ANY: [implicit('product.reviews', [condition('rating', 'GTE', 4)], { __scope: { scopes: { product: null, 'product.reviews': null } } })] }),
    )] });
    expect(args.reviews.terms[0]).toBe(args['reviews.product.reviews'].terms[0]);
  });
});


describe('collection frames: plan', () => {
  const pred = (path, operator = 'EQ', value = 'x') => ({ kind: 'predicate', path: path.split('.'), operator, value });
  const frame = (path, where = null, quantifier = 'ANY', extra = {}) => ({ kind: 'quantified', quantifier, path: path.split('.'), where, scope: null, ...extra });
  const plan = (args, options) => createQueryPlan(frameModels, 'CfProduct', args, options).where;
  const rating = { field: 'rating', operator: 'GTE', value: 4 };
  it.each([
    { reviews: { terms: [{ path: 'rating', operator: 'GTE', value: 4 }] } },
    { AND: [{ conditions: [{ field: 'reviews', path: 'rating', operator: 'GTE', value: 4 }] }] },
    { AND: [{ conditions: [{ field: 'reviews.rating', operator: 'GTE', value: 4 }] }] },
  ])('correlates shorthand in each surface %j', (args) => {
    expect(plan(args)).toEqual(frame('reviews', pred('rating', 'GTE', 4)));
  });
  it.each(['ANY', 'ALL', 'NONE'])('plans %s lists and quantifier field filters', (quantifier) => {
    const expected = frame('reviews', pred('rating', 'GTE', 4), quantifier);
    expect(plan({ AND: [{ [quantifier]: [{ path: 'reviews', conditions: [rating] }] }] })).toEqual(expected);
    expect(plan({ reviews: { quantifier, terms: [{ path: 'rating', operator: 'GTE', value: 4 }] } })).toEqual(expected);
  });
  it('keeps nested frames inside a quantified field filter', () => {
    expect(plan({ shop: { quantifier: 'NONE', terms: [{ path: 'products.stock', value: 5 }] } }))
      .toEqual(frame('shop', frame('products', pred('stock', 'EQ', 5)), 'NONE'));
  });
  it('keeps correlation within a group and separates adjacent groups', () => {
    const a = { field: 'reviews.rating', operator: 'GTE', value: 4 };
    const b = { field: 'reviews.author', value: 'x' };
    expect(plan({ AND: [{ conditions: [a, b] }] })).toEqual(frame('reviews', { kind: 'and', terms: [pred('rating', 'GTE', 4), pred('author')] }));
    expect(plan({ AND: [{ conditions: [a] }, { conditions: [b] }] }))
      .toEqual({ kind: 'and', terms: [frame('reviews', pred('rating', 'GTE', 4)), frame('reviews', pred('author'))] });
  });
  it('orders conditions, ANY, ALL, NONE, AND and OR', () => {
    expect(plan({ AND: [{ conditions: [{ field: 'name', value: 'first' }], ANY: [{ path: 'reviews' }], ALL: [{ path: 'shop' }], NONE: [{ path: 'pro' }], AND: [{ conditions: [{ field: 'stock', value: 5 }] }], OR: [{ conditions: [{ field: 'key', value: 'a' }] }, { conditions: [{ field: 'key', value: 'b' }] }] }] }))
      .toEqual({ kind: 'and', terms: [pred('name', 'EQ', 'first'), frame('reviews'), frame('shop', null, 'ALL'), frame('pro', null, 'NONE'), pred('stock', 'EQ', 5), { kind: 'or', terms: [pred('key', 'EQ', 'a'), pred('key', 'EQ', 'b')] }] });
  });
  it('lifts the frame scope and inner reference joins relative to their elements', () => {
    const condition = marked({ field: 'product.shop.name', value: 'S1' }, { product: null, 'product.shop': { state: { value: 'OPEN' } } });
    const group = marked({ path: 'shop.products', ANY: [{ path: 'reviews', conditions: [condition] }] }, { shop: { name: { value: 'S1' } }, 'shop.products': { stock: { operator: 'GT', value: 0 } } });
    expect(plan({ AND: [{ ANY: [group] }] })).toEqual(frame('shop.products', frame('reviews', { ...pred('product.shop.name', 'EQ', 'S1'), joins: { product: null, 'product.shop': pred('state', 'EQ', 'OPEN') } }), 'ANY', { scope: pred('stock', 'GT', 0), joins: { shop: pred('name', 'EQ', 'S1') } }));
  });
  it('passes quantifiers into target scope plans and keeps trusted crossings plain', () => {
    const group = marked({ path: 'shop' }, { shop: { products: { terms: [{ path: 'stock', value: 5 }] } } });
    expect(plan({ AND: [{ ANY: [group] }] })).toEqual(frame('shop', null, 'ANY', { scope: frame('products', pred('stock', 'EQ', 5)) }));
    expect(plan({ AND: [{ ANY: [{ path: 'reviews', conditions: [{ field: 'product.shop.name', value: 'S1' }] }] }] }))
      .toEqual(frame('reviews', pred('product.shop.name', 'EQ', 'S1')));
  });
  it('retains 2b predicates and relative scopes inside a frame', () => {
    const condition = marked({ field: 'product.shop', operator: 'IS_EMPTY' }, { product: null, 'product.shop': { state: { value: 'OPEN' } } });
    expect(plan({ AND: [{ ANY: [{ path: 'reviews', conditions: [condition] }] }] }))
      .toEqual(frame('reviews', { ...pred('product.shop', 'IS_EMPTY', null), scopes: { product: null, 'product.shop': pred('state', 'EQ', 'OPEN') } }));
  });
  it('anchors a frame after aggregate J joins and drops null anchor keys', () => {
    const condition = marked({ field: 'reviews.product.reviews.rating', operator: 'GTE', value: 4 }, { reviews: null, 'reviews.product.reviews': { author: { value: 'x' } } });
    expect(plan({ aggregation: { groupId: 'reviews.author', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }] }, AND: [{ conditions: [condition] }] }, { mode: 'aggregate' }))
      .toEqual(frame('reviews', pred('rating', 'GTE', 4), 'ANY', { anchor: ['reviews', 'product'], scope: pred('author') }));
  });
  it('keeps J predicates legacy in groups but resets J inside explicit frames', () => {
    const aggregation = { groupId: 'reviews.author', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }] };
    expect(plan({ aggregation, AND: [{ conditions: [{ field: 'reviews.rating', operator: 'GTE', value: 4 }] }] }, { mode: 'aggregate' })).toEqual(pred('reviews.rating', 'GTE', 4));
    expect(plan({ aggregation, AND: [{ ALL: [{ path: 'shop', conditions: [{ field: 'products.stock', value: 5 }] }] }] }, { mode: 'aggregate' })).toEqual(frame('shop', frame('products', pred('stock', 'EQ', 5)), 'ALL'));
  });
  it.each([
    marked({ path: 'shop.products' }, { 'shop.products': null }),
    marked({ path: 'shop.products' }, { shop: null }),
    marked({ path: 'shop' }, { shop: undefined }),
    { path: 'reviews', __scope: { id: 1 } },
    { path: 'reviews', __scope: { id: 1, scopes: [] } },
  ])('fails closed for missing crossing or end markers %j', (group) => {
    expect(errorOf(() => plan({ AND: [{ ANY: [group] }] }))?.extensions).toMatchObject({ code: 'DETACHED_CLIENT_FILTER', status: 500 });
  });
  it.each([
    marked({ field: 'product.shop.name', value: 'x' }, { product: null }),
    marked({ field: 'rating', value: 1 }, {}),
    marked({ field: 'product.shop.name', value: 'x' }, { product: null, 'product.shop': undefined }),
  ])('fails closed for invalid inner predicate markers %j', (condition) => {
    expect(errorOf(() => plan({ AND: [{ ANY: [{ path: 'reviews', conditions: [condition] }] }] }))?.extensions).toMatchObject({ code: 'DETACHED_CLIENT_FILTER', status: 500 });
  });
  it('rejects non-null J keys in an anchored marker', () => {
    const args = { aggregation: { groupId: 'reviews.author', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }] }, AND: [{ conditions: [marked({ field: 'reviews.product.reviews.rating', value: 4 }, { reviews: { author: { value: 'x' } }, 'reviews.product.reviews': null })] }] };
    expect(errorOf(() => plan(args, { mode: 'aggregate' }))?.extensions).toMatchObject({ code: 'DETACHED_CLIENT_FILTER', status: 500 });
  });
  it('does not add depth for synthetic groups', () => {
    let group = { conditions: [{ field: 'reviews.rating', value: 4 }] };
    for (let i = 0; i < 5; i++) group = { AND: [group] };
    expect(plan({ AND: [group] })).toEqual(frame('reviews', pred('rating', 'EQ', 4)));
  });
  it.each(['ANY', 'ALL', 'NONE'])('rejects new %s forms when quantifiers are disabled', (quantifier) => {
    for (const args of [{ reviews: { quantifier } }, { AND: [{ [quantifier]: [{ path: 'reviews' }] }] }]) {
      expect(errorOf(() => plan(args, { quantifiers: false }))?.extensions?.code).toBe('UNSUPPORTED_QUERY');
    }
  });
  it.each(['ANY', 'ALL', 'NONE'])('rejects implicit %s forms when the planner has not declared quantifiers', (quantifier) => {
    for (const options of [{ quantifiers: false }, { operators: ['EQ', 'GTE'] }]) {
      for (const rows of [[{ __implicit: true, path: 'reviews', conditions: [rating] }], []]) {
        const args = { AND: [{ __implicit: true, [quantifier]: rows }] };
        const error = errorOf(() => plan(args, options));
        expect(error?.extensions).toMatchObject({ code: 'UNSUPPORTED_QUERY', status: 400 });
        expect(error?.message).toBe('Quantified groups are not supported by this query compiler');
      }
    }
  });
  it.each([
    { quantifier: 'NONE', terms: [{ operator: 'IS_NOT_EMPTY' }] },
    { quantifier: 'ANY', terms: [{ operator: 'EQ', value: 1 }] },
    { quantifier: 'ANY', terms: [{ path: '' }] },
  ])('rejects path-less quantified terms before planning %j', (reviews) => {
    const error = errorOf(() => plan({ reviews }));
    expect(error?.extensions).toMatchObject({ code: 'INVALID_FILTER_PATH', status: 400 });
    expect(error?.message).toBe('Relationship terms require a path');
  });
  it('pin: keeps operators-only plans legacy and ignored carrier operators', () => {
    const operators = ['EQ', 'NE', 'GTE'];
    const args = { reviews: { operator: 'UNKNOWN_IGNORED', terms: [{ path: 'rating', operator: 'GTE', value: 4 }] } };
    expect(plan(args, { operators })).toEqual(pred('reviews.rating', 'GTE', 4));
    expect(plan(args, { quantifiers: false })).toEqual(pred('reviews.rating', 'GTE', 4));
  });
  it.each(['find', 'count'])('rejects a collection sort in %s mode', (mode) => {
    const error = errorOf(() => createQueryPlan(frameModels, 'CfProduct', { sort: { terms: [{ field: 'reviews.rating', order: 'ASC' }] } }, { mode }));
    expect(error?.extensions).toMatchObject({ code: 'INVALID_FILTER_PATH', status: 400 });
    expect(error?.message).toBe('Sort path reviews.rating crosses the collection CfProduct.reviews; a record has no single value there');
  });
  it('pin: exempts aggregate result sorts and omits valid count sorts', () => {
    const aggregation = { groupId: 'name', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }] };
    expect(createQueryPlan(frameModels, 'CfProduct', { aggregation, sort: { terms: [{ field: 'facts.n', order: 'DESC' }] } }, { mode: 'aggregate' }).sort).toEqual([{ path: ['facts', 'n'], order: 'DESC' }]);
    expect(createQueryPlan(frameModels, 'CfProduct', { sort: { terms: [{ field: 'name', order: 'ASC' }] } }, { mode: 'count' }).sort).toEqual([]);
  });
  it('adds optional per-type find scopes without changing fixture fields', async () => {
    const find = ({ args }) => { args.name = { operator: 'NE', value: 'hidden' }; };
    const fixtures = createContractModelFixtures({ scopes: { ContractStar: find } });
    const args = {};
    await fixtures.types.ContractStar.extensions.scope.find({ args });
    expect(args).toEqual({ name: { operator: 'NE', value: 'hidden' } });
    expect(Object.keys(fixtures.types.ContractStar.getFields())).toEqual(['id', 'name', 'assignments']);
  });
});


describe('collection frames: plan rows and independent oracle', () => {
  const entities = { product: 'CfProduct', shop: 'CfShop', review: 'CfReview', pro: 'CfPro' };
  const scopeOf = (target, shape) => {
    const type = target.slice(2).toLowerCase();
    const restriction = REFERENCE_SCOPES[shape][type];
    return restriction ? { AND: [{ conditions: [{ ...restriction }] }] } : null;
  };
  const markedArgs = (item, shape) => {
    const args = structuredClone(item.args);
    for (const entry of collectQueryOperators(args)) {
      if (!entry.construct) continue;
      let entity = entities[item.root];
      for (const frame of entry.frames) entity = resolveModelPath(frameModels, entity, frame.path).at(-1).target;
      const steps = resolveModelPath(frameModels, entity, entry.relative);
      if (entry.form !== 'quantified' && !entry.emptiness && !entry.frames.length && !steps.some((step) => step.kind === 'collection')) continue;
      const scopes = {};
      for (const [index, step] of steps.entries()) if (['reference', 'collection'].includes(step.kind) && !step.inferred) {
        scopes[entry.relative.slice(0, index + 1).join('.')] = scopeOf(step.target, shape);
      }
      if (Object.keys(scopes).length) entry.construct.__scope = { id: 1, scopes };
    }
    const own = scopeOf(entities[item.root], shape);
    if (own) args.AND = [...(args.AND ?? []), ...own.AND];
    return args;
  };
  for (const item of COLLECTION_CASES) it.each(REFERENCE_SHAPES.filter((shape) => !item.forbidden?.includes(shape)))(`${item.name}: %s`, (shape) => {
    // This assertion makes every new row test fail first for the absent frame representation.
    const trusted = createQueryPlan(frameModels, entities[item.root], item.args).where;
    expect(JSON.stringify(trusted)).toContain('"kind":"quantified"');
    expect(collectionOracle(shape)(item)).toEqual(item.rows[shape]);
    const plan = createQueryPlan(frameModels, entities[item.root], markedArgs(item, shape));
    const store = referenceStore('Cf', { records: COLLECTION_DATA })(frameModels);
    const evaluate = createEvaluator(frameModels, store);
    expect(store[entities[item.root]].filter((record) => evaluate(entities[item.root], record, plan.where)).map((record) => record.key).sort()).toEqual(item.rows[shape]);
  });
});


describe('collection frames: plan aggregate fixture rows', () => {
  for (const item of COLLECTION_AGGREGATES) it(`${item.filter === 'rating1' ? '' : 'pin: '}${item.name} on the extended seed`, () => {
    const conditions = item.filter === 'rating1' ? [{ field: 'reviews.rating', operator: 'GTE', value: 1 }]
      : item.filter === 'rating5' ? [{ field: 'reviews.rating', operator: 'GTE', value: 5 }] : [];
    const args = { aggregation: { groupId: item.groupId, facts: item.facts }, AND: [{ conditions }] };
    if (item.filter === 'twoGroups') args.AND = [{ conditions: [{ field: 'reviews.rating', operator: 'GTE', value: 4 }] }, { conditions: [{ field: 'reviews.author', value: 'x' }] }];
    const plan = createQueryPlan(frameModels, 'CfProduct', args, { mode: 'aggregate' });
    if (item.filter === 'rating1') expect(plan.where.kind).toBe('quantified');
    else if (item.filter) expect(JSON.stringify(plan.where)).not.toContain('quantified');
    for (const shape of REFERENCE_SHAPES.filter((value) => !item.forbidden?.includes(value))) {
      expect(collectionAggregateOracle(item, COLLECTION_DATA, shape), shape).toEqual(item.rowsByShape[shape]);
    }
  });
});

describe('collection frames: plan defensive and equivalent forms', () => {
  it.each([1, false, 'x', [], new Date(0)])('rejects a malformed frame scope value %j', (value) => {
    const args = { AND: [{ ANY: [marked({ path: 'reviews' }, { reviews: value })] }] };
    expect(errorOf(() => createQueryPlan(frameModels, 'CfProduct', args))?.extensions).toMatchObject({ code: 'DETACHED_CLIENT_FILTER', status: 500 });
  });
  it('explicitly enables quantifiers beside an operator declaration', () => {
    expect(createQueryPlan(frameModels, 'CfProduct', { reviews: { terms: [{ path: 'rating', value: 5 }] } }, { operators: ['EQ'], referenceEmptiness: true, quantifiers: true }).where)
      .toMatchObject({ kind: 'quantified', where: { path: ['rating'] } });
  });
  it('plans the same shorthand on models without GraphQL objects', () => {
    expect(createQueryPlan(plainFrameModels, 'CfProduct', { shop: { terms: [{ path: 'products.reviews.rating', value: 5 }] } }).where)
      .toMatchObject({ kind: 'quantified', path: ['shop', 'products'], where: { kind: 'quantified', path: ['reviews'], where: { path: ['rating'] } } });
  });
  it('keeps ALL null-safe and accepts a child whose author is null under NE', () => {
    const data = { ...COLLECTION_DATA, review: [...COLLECTION_DATA.review, { key: 'c:null:null', rating: null, author: null, product: 'c' }] };
    const item = COLLECTION_CASES.find((entry) => entry.name === 'ALL author NE x');
    const plan = createQueryPlan(frameModels, 'CfProduct', item.args);
    expect(plan.where.kind).toBe('quantified');
    const store = referenceStore('Cf', { records: data })(frameModels);
    const evaluate = createEvaluator(frameModels, store);
    expect(store.CfProduct.filter((record) => evaluate('CfProduct', record, plan.where)).map((record) => record.key).sort()).toEqual(['C', 'F', 'c']);
    expect(collectionOracle('admin', data)(item)).toEqual(['C', 'F', 'c']);
  });
  it('matches reference emptiness and ANY/NONE on the extended seed', () => {
    const store = referenceStore('Cf', { records: COLLECTION_DATA })(frameModels);
    const evaluate = createEvaluator(frameModels, store);
    for (const path of ['reviews', 'shop', 'pro']) for (const [quantifier, operator] of [['ANY', 'IS_NOT_EMPTY'], ['NONE', 'IS_EMPTY']]) {
      const frame = createQueryPlan(frameModels, 'CfProduct', { AND: [{ [quantifier]: [{ path }] }] });
      expect(frame.where.kind).toBe('quantified');
      const empty = createQueryPlan(frameModels, 'CfProduct', { AND: [{ conditions: [{ field: path, operator }] }] });
      const rows = (plan) => store.CfProduct.filter((record) => evaluate('CfProduct', record, plan.where)).map((record) => record.key).sort();
      expect(rows(frame)).toEqual(rows(empty));
    }
  });
});


describe('collection frames: plan depth compatibility', () => {
  it('pin: preserves the legacy zero-based depth boundary', () => {
    let group = { conditions: [{ field: 'name', value: 'x' }] };
    for (let i = 0; i < 5; i++) group = { AND: [group] };
    expect(createQueryPlan(frameModels, 'CfProduct', { AND: [group] }).where).toEqual({ kind: 'predicate', path: ['name'], operator: 'EQ', value: 'x' });
  });
});

describe('collection frames: plan aggregate anchors', () => {
  const facts = [{ operation: 'COUNT', factName: 'n', path: 'id' }];
  it('preserves the per-product ALL frame when both prefixes are in J', () => {
    const args = { aggregation: { groupId: 'products.reviews.author', facts }, AND: [{ ALL: [{ path: 'products', conditions: [{ field: 'reviews.rating', operator: 'GTE', value: 5 }] }] }] };
    const plan = createQueryPlan(frameModels, 'CfShop', args, { mode: 'aggregate' });
    expect(plan.where).toMatchObject({ kind: 'quantified', quantifier: 'ALL', path: ['products'], where: { kind: 'quantified', quantifier: 'ANY', path: ['reviews'], where: { path: ['rating'] } } });
    const store = referenceStore('Cf', { records: COLLECTION_DATA })(frameModels);
    const evaluate = createEvaluator(frameModels, store);
    expect(store.CfShop.filter((record) => evaluate('CfShop', record, plan.where)).map((record) => record.key)).toEqual(['S3']);
  });
  it('anchors reviews on each product joined for grouping', () => {
    const args = { aggregation: { groupId: 'products.key', facts }, AND: [{ conditions: [{ field: 'products.reviews.rating', operator: 'GTE', value: 1 }] }] };
    const plan = createQueryPlan(frameModels, 'CfShop', args, { mode: 'aggregate' });
    expect(plan.where).toMatchObject({ kind: 'quantified', anchor: ['products'], path: ['reviews'], where: { path: ['rating'] } });
    const visibleProducts = COLLECTION_DATA.product.filter((product) => product.shop && COLLECTION_DATA.review.some((review) => review.product === product.key && review.rating != null && review.rating >= 1));
    expect(visibleProducts.map((product) => [product.key, 1]).sort()).toEqual([['D', 1], ['E', 1], ['Ka', 1], ['c', 1]]);
  });
  it('keeps references between J and a later collection in the anchor', () => {
    const args = { aggregation: { groupId: 'products.key', facts }, AND: [{ conditions: [{ field: 'products.pro.shop.products.name', value: 'Ka' }] }] };
    expect(createQueryPlan(frameModels, 'CfShop', args, { mode: 'aggregate' }).where)
      .toMatchObject({ kind: 'quantified', anchor: ['products', 'pro', 'shop'], path: ['products'], where: { path: ['name'] } });
    const rows = (restricted) => COLLECTION_DATA.product.filter((product) => product.shop).filter((product) => {
      const pro = COLLECTION_DATA.pro.find((entry) => entry.key === product.pro);
      return pro && (!restricted || pro.name !== 'P2') && COLLECTION_DATA.product.some((candidate) => candidate.shop === pro.shop && candidate.name === 'Ka');
    }).map((product) => [product.key, 1]).sort();
    // F has P2, so it participates in this extended-seed aggregate too.
    expect(rows(false)).toEqual(COLLECTION_ANCHOR_ROWS.referenceChain.admin);
    expect(rows(true)).toEqual(COLLECTION_ANCHOR_ROWS.referenceChain.proOnly);
  });
});

describe('collection frames: plan contract fixtures and paging', () => {
  it.each(['ANY', 'ALL', 'NONE'])('keeps %s seasons correlated with ANY episodes', (quantifier) => {
    const models = describeModels(createContractModelFixtures().registrations);
    const args = { seasons: { quantifier, terms: [{ path: 'episodes.duration', operator: 'GT', value: 20 }] } };
    expect(createQueryPlan(models, 'ContractSerie', args).where).toMatchObject({ kind: 'quantified', quantifier, path: ['seasons'], where: { kind: 'quantified', quantifier: 'ANY', path: ['episodes'], where: { path: ['duration'], operator: 'GT', value: 20 } } });
  });
  it('uses scoped star joins inside assignment frames', () => {
    const models = describeModels(createContractModelFixtures().registrations);
    const args = { assignments: { terms: [marked({ path: 'star.name', value: 'visible' }, { assignments: null, 'assignments.star': { name: { operator: 'NE', value: 'hidden' } } })] } };
    expect(createQueryPlan(models, 'ContractSerie', args).where).toMatchObject({ kind: 'quantified', path: ['assignments'], where: { kind: 'predicate', path: ['star', 'name'], joins: { star: { kind: 'predicate', path: ['name'], operator: 'NE', value: 'hidden' } } } });
  });
  it('keeps one row per root for counts and a sorted page', () => {
    const item = COLLECTION_CASES.find((entry) => entry.name === 'duplication: rating');
    const args = { ...item.args, sort: { terms: [{ field: 'key', order: 'ASC' }] }, pagination: { page: 1, size: 3, count: true } };
    const plan = createQueryPlan(frameModels, 'CfProduct', args);
    expect(plan.where.kind).toBe('quantified');
    const rows = collectionOracle()(item);
    expect(rows.length).toBe(4);
    expect(rows.slice(plan.pagination.offset, plan.pagination.offset + plan.pagination.limit)).toEqual(['D', 'E', 'Ka']);
    const count = createQueryPlan(frameModels, 'CfProduct', args, { mode: 'count' });
    expect(count.where).toEqual(plan.where);
    expect(count.pagination).toBeNull();
    expect(count.sort).toEqual([]);
  });
  it('rejects a quantified form by default with an explicit compiler operator list', () => {
    const args = { reviews: { quantifier: 'ANY' } };
    expect(errorOf(() => createQueryPlan(frameModels, 'CfProduct', args, { operators: ['EQ'], referenceEmptiness: true }))?.extensions?.code).toBe('UNSUPPORTED_QUERY');
  });
});


describe('phase5 L3-1 direct scalar collection rewrite', () => {
  it.each(contexts)('frames only actual scalar carriers with default EQ and ignored terms (%s)', (label, shape) => {
    const ctx = { ...enabled, ...shape };
    for (const carrier of [{ operator: 'GTE', value: 4 }, { value: 4, terms: [] },
      { value: 4, terms: [{ path: 'invalid..ignored', operator: 'FUTURE' }], __scope: { forged: true }, path: 'ignored' }]) {
      const input = { 'reviews.rating': carrier };
      const before = structuredClone(input);
      const expected = { AND: [synthetic(implicit('reviews', [condition('rating', carrier.operator ?? 'EQ', 4)]))] };
      expect(() => frames.validateQuantifiedGroups(input, ctx)).not.toThrow();
      const output = frames.frameCollectionPaths(input, ctx);
      expect(output).toEqual(expected);
      expect(() => frames.validateQuantifiedGroups(output, ctx)).not.toThrow();
      expect(frames.frameCollectionPaths(output, ctx)).toEqual(expected);
      expect(frames.frameUnits(input, ctx).count).toBe(1);
      expect(input).toEqual(before);
      expect(input['reviews.rating']).toBe(carrier);
    }
  });
  it('frames a scalar-list leaf from its actual carrier and never its ignored terms', () => {
    const input = { 'children.tags': { value: 'x', terms: [{ path: 'ignored', operator: 'FUTURE' }] } };
    const expected = { AND: [synthetic(implicit('children', [condition('tags')]))] };
    expect(frames.frameCollectionPaths(input, treeContext)).toEqual(expected);
    expect(frames.frameCollectionPaths(expected, treeContext)).toEqual(expected);
    expect(frames.frameUnits(input, treeContext).count).toBe(1);
  });
  it.each(contexts)('keeps scalar entries, relation terms and AND groups independent (%s)', (label, shape) => {
    const ctx = { ...enabled, ...shape };
    const input = {
      'reviews.rating': { operator: 'GTE', value: 4 }, 'reviews.author': { value: 'x' },
      reviews: { terms: [{ path: 'author', operator: 'EQ', value: 'hidden' }] },
      AND: [{ conditions: [condition('reviews.rating', 'GTE', 5)] }],
    };
    const expected = { AND: [
      { conditions: [], ANY: [implicit('reviews', [condition('rating', 'GTE', 5)])] },
      synthetic(implicit('reviews', [condition('rating', 'GTE', 4)])),
      synthetic(implicit('reviews', [condition('author')])),
      synthetic(implicit('reviews', [condition('author', 'EQ', 'hidden')])),
    ] };
    expect(frames.frameCollectionPaths(input, ctx)).toEqual(expected);
    expect(frames.frameCollectionPaths(expected, ctx)).toEqual(expected);
    expect(frames.frameUnits(input, ctx).count).toBe(4);
  });
  it.each(contexts)('keeps all-J and reference-only carrier objects and anchors the next collection (%s)', (label, shape) => {
    const ctx = { ...enabled, ...shape, J: new Set(['reviews']), operation: 'aggregate' };
    const joined = { value: 'x', terms: [{ path: 'ignored' }] };
    const reference = { value: 'S1' };
    const input = { 'reviews.author': joined, 'shop.name': reference, 'reviews.product.reviews.rating': { operator: 'GTE', value: 4 } };
    const expected = { 'reviews.author': joined, 'shop.name': reference, AND: [synthetic(implicit('reviews', [condition('rating', 'GTE', 4)], { __anchor: ['reviews', 'product'] }))] };
    const output = frames.frameCollectionPaths(input, ctx);
    expect(output).toEqual(expected);
    expect(output['reviews.author']).toBe(joined);
    expect(output['shop.name']).toBe(reference);
    expect(frames.frameCollectionPaths(output, ctx)).toEqual(expected);
    expect(frames.frameUnits(input, ctx).count).toBe(1);
    expect(frames.frameCollectionPaths(input, { ...ctx, quantifiers: false })).toBe(input);
  });
  it('counts nested direct-key frames and enforces the same nesting boundary before and after rewrite', () => {
    const input = { 'children.children.name': { value: 'x' } };
    expect(frames.frameCollectionPaths(input, treeContext)).toEqual({ AND: [synthetic(implicit('children', [], { ANY: [implicit('children', [condition('name')])] }))] });
    expect(frames.frameUnits(input, treeContext).count).toBe(2);
    const deep = { 'children.children.children.children.name': { value: 'x' } };
    const output = frames.frameCollectionPaths(deep, treeContext);
    for (const args of [deep, output]) expect(errorOf(() => frames.validateQuantifiedGroups(args, treeContext))?.extensions.code).toBe('FILTER_DEPTH_EXCEEDED');
  });
});
