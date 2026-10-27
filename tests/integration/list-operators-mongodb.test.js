import {
  afterAll, beforeAll, describe, expect, test,
} from 'vitest';
import mongoose from 'mongoose';
import {
  GraphQLID, GraphQLInterfaceType, GraphQLList, GraphQLObjectType, GraphQLString, GraphQLUnionType, graphql,
} from 'graphql';
import { createMongoAdapter, createRuntime, SimfinityError } from '../../packages/mongodb/src/index.js';
import { createMongoQueries } from '../../packages/mongodb/src/mongo/queries.js';
import {
  LIST_OPERATOR_DATES, createListOperatorTypes, registerListOperatorTypes, seedListOperators,
} from '../helpers/list-operators.js';

// #108 part 4 on MongoDB: CONTAINS_ALL compiles to $all with each value cast as IN casts its elements, and IIN to $in
// of anchored, escaped, case-insensitive BSON regular expressions, one per value, each within the server's
// 32,764-byte limit (spec 5.1). MongoDB trusts core for every path, leaf and value rule, so every public build
// validates first. The compile tests need no database; the byte limits, the rows that show how the server reads both
// forms and the index plans run on the disposable replica set and standalone server, and the hand-built implicit groups,
// those that cross a collection before their end included, on the replica set. The rows of both backends on the list
// operator fixture are in list-operators-parity.test.js.

const replicaSetUri = process.env.SIMFINITY_MONGODB_URI;
const standaloneUri = process.env.SIMFINITY_STANDALONE_MONGODB_URI;

const { BSONRegExp } = mongoose.mongo;
const PAGE = [{ $skip: 0 }, { $limit: 100 }];
const { d1, d2 } = LIST_OPERATOR_DATES;
const HEX = ['64b7f0c2a1b2c3d4e5f60718', '64b7f0c2a1b2c3d4e5f60719'];
const COUNT_BY_NAME = { groupId: 'name', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }] };

// Each runtime binds its own types, and Mongoose keeps one model per name, so every fixture gets its own prefix.
const createFixture = (prefix, { preventCreatingCollection = false, scopes = false, adapter = createMongoAdapter() } = {}) => {
  const runtime = createRuntime(adapter);
  if (preventCreatingCollection) runtime.preventCreatingCollection(true);
  const types = createListOperatorTypes(prefix, { backend: 'mongodb', scopes });
  registerListOperatorTypes(runtime, types);
  const schema = runtime.createSchema();
  const queries = createMongoQueries({
    getModel: (type) => runtime.getModel(type),
    getRegistrations: () => runtime.getRegistrations(),
  });
  const execute = (source, variableValues, contextValue = {}) => graphql({
    schema, source, variableValues, contextValue,
  });
  return {
    adapter, runtime, types, queries, execute,
    model: (key) => runtime.getModel(types.roots[key].type),
    items: types.roots.item.plural,
  };
};

// A condition as a field filter (a term below its first segment when the field is dotted), as a group, and as a
// one-condition AND.
const fieldFilter = ({ field, operator, value }) => {
  const [head, ...rest] = field.split('.');
  return rest.length ? { [head]: { terms: [{ path: rest.join('.'), operator, value }] } } : { [head]: { operator, value } };
};
const groupOf = (...conditions) => ({ conditions });
const inGroup = (...conditions) => ({ AND: [groupOf(...conditions)] });

// A rejection's class, code, status and message, or null when the build succeeds.
const rejection = (promise) => promise.then(() => null, (error) => ({
  simfinity: error instanceof SimfinityError, code: error.extensions?.code, status: error.extensions?.status, message: error.message,
}));
const invalid = (code, message) => ({
  simfinity: true, code, status: 400, message,
});
const NON_LIST = (path) => invalid('INVALID_FILTER_OPERATOR', `CONTAINS_ALL requires a list field, or a field reached through an embedded list; ${path} is not one`);
const SHORTHAND = invalid('INVALID_FILTER_PATH', 'The shorthand excludes them; use an explicit group');
const TOO_LONG = (path) => invalid('INVALID_FILTER_VALUE', `IIN value on ${path} is too long: MongoDB accepts regular expressions of at most 32764 bytes, and this one has 32765`);

const isPlainObject = (value) => value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
// The value under every `key` of a pipeline replaced by `replace(value)`; ObjectId, Date and BSON regular expression
// instances are values, never walked.
const replaceAt = (node, key, replace) => {
  if (Array.isArray(node)) return node.map((item) => replaceAt(item, key, replace));
  if (!isPlainObject(node)) return node;
  return Object.fromEntries(Object.entries(node).map(([name, value]) => [name, name === key ? replace(value) : replaceAt(value, key, replace)]));
};
// IEQ's case-insensitive exact match, `{ $regex, $options: 'i' }`, replaced by IIN's $in of one BSON regular expression
// per pattern.
const regexToIn = (node, patterns) => {
  if (Array.isArray(node)) return node.map((item) => regexToIn(item, patterns));
  if (!isPlainObject(node)) return node;
  if (Object.keys(node).length === 2 && typeof node.$regex === 'string' && node.$options === 'i') {
    return { $in: patterns.map((pattern) => new BSONRegExp(pattern, 'i')) };
  }
  return Object.fromEntries(Object.entries(node).map(([name, value]) => [name, regexToIn(value, patterns)]));
};

describe('MongoDB list operator compilation', () => {
  const fixture = createFixture('QlmPlan', { preventCreatingCollection: true });
  const { Item, Label } = fixture.types;
  const build = (args, isCount) => fixture.queries.buildQuery(args, Item, isCount);
  const matchOf = async (args) => (await build(args))[0].$match;
  const aggregate = (args, expression = COUNT_BY_NAME) => fixture.queries.buildAggregationQuery(args, Item, expression);
  // The native group API, with its public signature: the $match and the lookups it appends.
  const native = async (group) => {
    const clauses = [];
    const match = await fixture.adapter.buildFilterGroupMatch(group, Item, clauses, {});
    return { match, clauses };
  };
  // What every surface compiles for one condition: the field filter, the group condition, the count, the aggregate
  // filter and the native group API.
  const surfaces = async (condition) => ({
    field: await build(fieldFilter(condition)),
    group: await build(inGroup(condition)),
    count: await build(inGroup(condition), true),
    aggregate: await aggregate(fieldFilter(condition)),
    native: await native(groupOf(condition)),
  });
  const plainLookup = (from, localField, as = '__sf_l0') => [
    { $lookup: { from, foreignField: '_id', localField, as } },
    { $unwind: { path: `$${as}`, preserveNullAndEmptyArrays: true } },
  ];
  // A collection frame on Item.reviews.
  const reviewsFrame = (pipeline, exists) => [
    {
      $lookup: {
        from: 'QlmPlanReview', localField: '_id', foreignField: 'item',
        pipeline: [...pipeline, { $limit: 1 }, { $project: { _id: 1 } }], as: '__sf_q0',
      },
    },
    { $match: { '__sf_q0.0': { $exists: exists } } },
    ...PAGE,
    { $unset: ['__sf_q0'] },
  ];

  describe('CONTAINS_ALL', () => {
    test('compiles to $all with the values cast as IN casts them, in order and with duplicates', async () => {
      expect(await build({ tags: { operator: 'CONTAINS_ALL', value: ['A', 'B'] } }))
        .toStrictEqual([{ $match: { tags: { $all: ['A', 'B'] } } }, ...PAGE]);
      expect(await matchOf({ tags: { operator: 'CONTAINS_ALL', value: ['B', 'A', 'A'] } })).toStrictEqual({ tags: { $all: ['B', 'A', 'A'] } });
      // An uncast hex string would match no stored ObjectId.
      const ids = (await matchOf({ ids: { operator: 'CONTAINS_ALL', value: [HEX[0]] } })).ids.$all;
      expect(ids).toEqual([new mongoose.Types.ObjectId(HEX[0])]);
      expect(ids[0]).toBeInstanceOf(mongoose.Types.ObjectId);
      // Enum names and values both cast to the stored values.
      expect(await matchOf({ kinds: { operator: 'CONTAINS_ALL', value: ['ONE', 'TWO'] } })).toStrictEqual({ kinds: { $all: ['one_v', 'two_v'] } });
      expect(await matchOf({ kinds: { operator: 'CONTAINS_ALL', value: ['one_v'] } })).toStrictEqual({ kinds: { $all: ['one_v'] } });
      expect(await matchOf({ ats: { operator: 'CONTAINS_ALL', value: [d1, d2] } })).toStrictEqual({ ats: { $all: [new Date(d1), new Date(d2)] } });
      // Inherited from IN: a number on a date leaf is read as epoch milliseconds (PostgreSQL rejects it).
      expect(await matchOf({ ats: { operator: 'CONTAINS_ALL', value: [Date.parse(d1)] } })).toStrictEqual({ ats: { $all: [new Date(d1)] } });
      // Values across the items of an embedded list.
      expect(await build({ lines: { terms: [{ path: 'sku', operator: 'CONTAINS_ALL', value: ['A', 'B'] }] } }))
        .toStrictEqual([{ $match: { 'lines.sku': { $all: ['A', 'B'] } } }, ...PAGE]);
      // A reference, then an embedded list of the target.
      expect(await build({ shop: { terms: [{ path: 'slines.sku', operator: 'CONTAINS_ALL', value: ['A', 'B'] }] } })).toStrictEqual([
        ...plainLookup('QlmPlanShop', 'shop'),
        { $match: { '__sf_l0.slines.sku': { $all: ['A', 'B'] } } },
        ...PAGE,
        { $unset: ['__sf_l0'] },
      ]);
    });

    test('values stay data: $-leading strings are compared, never read as operators', async () => {
      expect(await matchOf({ tags: { operator: 'CONTAINS_ALL', value: ['$x', '$where', '$ne'] } }))
        .toStrictEqual({ tags: { $all: ['$x', '$where', '$ne'] } });
    });

    // [field, the leaf in the $match, two values]
    const LIST_LEAVES = [
      ['tags', 'tags', ['A', 'B']],
      ['emails', 'emails', ['Ana@x.io', 'bob@y.io']],
      ['ids', 'ids', HEX],
      ['ranks', 'ranks', [1, 2]],
      ['scores', 'scores', [1.5, 2]],
      ['flags', 'flags', [true, false]],
      ['kinds', 'kinds', ['ONE', 'TWO']],
      ['ats', 'ats', [d1, d2]],
      ['dims.codes', 'dims.codes', ['A', 'B']],
      ['box.tags', 'box.tags', ['p', 'q']],
      ['lines.sku', 'lines.sku', ['A', 'B']],
      ['lines.qty', 'lines.qty', [1, 2]],
      ['lines.at', 'lines.at', [d1, d2]],
      ['lines.id', 'lines.id', HEX],
      ['lines.notes', 'lines.notes', ['n1', 'n2']],
      ['lines.subs.code', 'lines.subs.code', ['c1', 'c3']],
      ['lines.subs.notes', 'lines.subs.notes', ['n1', 'n2']],
      ['parts.sku', 'parts.sku', ['A', 'B']],
      ['parts.at', 'parts.at', [d1, d2]],
      ['parts.codes', 'parts.codes', ['x', 'y']],
      ['parts.subs.code', 'parts.subs.code', ['c1', 'c2']],
      ['shop.tags', '__sf_l0.tags', ['a', 'b']],
      ['shop.slines.sku', '__sf_l0.slines.sku', ['A', 'B']],
      ['box.shop.tags', '__sf_l0.tags', ['a', 'b']],
    ];

    test.each(LIST_LEAVES)('compiles wherever EQ compiles on a list leaf: %s, in every surface', async (field, leaf, values) => {
      // One value: EQ's pipeline with $all of the value EQ has.
      expect(await surfaces({ field, operator: 'CONTAINS_ALL', value: [values[0]] }))
        .toEqual(replaceAt(await surfaces({ field, operator: 'EQ', value: values[0] }), leaf, (value) => ({ $all: [value] })));
      // Two values: IN's pipeline with $all of the values IN has.
      expect(await surfaces({ field, operator: 'CONTAINS_ALL', value: values }))
        .toEqual(replaceAt(await surfaces({ field, operator: 'IN', value: values }), leaf, ({ $in }) => ({ $all: $in })));
    });

    // [field, a value that IN cannot cast, MongoDB's message]
    const CAST_FAILURES = [
      ['ranks', 1.5, 'Invalid value for ranks'],
      ['ranks', 'x', 'Invalid value for ranks'],
      ['ats', 'not-a-date', 'Invalid value for ats'],
      ['lines.at', 'bad', 'Invalid value for lines.at'],
      ['kinds', 'FOUR', 'Invalid value for kinds'],
      ['tags', 5, 'Invalid value for tags'],
      ['lines.qty', 'x', 'Invalid value for lines.qty'],
      ['scores', 'x', 'Invalid value for scores'],
      ['flags', 1, 'Invalid value for flags'],
      // Inherited from IN: PostgreSQL reports a malformed identifier as NOT_VALID_ID.
      ['ids', 'not-an-id', 'Invalid value for ids'],
      ['lines.id', 'not-an-id', 'Invalid value for lines.id'],
    ];

    test.each(CAST_FAILURES)('fails to cast %s %j as IN does, with INVALID_FILTER_VALUE', async (field, item, message) => {
      const condition = { field, operator: 'CONTAINS_ALL', value: [item] };
      expect(await rejection(build(fieldFilter(condition)))).toEqual(invalid('INVALID_FILTER_VALUE', message));
      expect(await rejection(build(inGroup(condition)))).toEqual(invalid('INVALID_FILTER_VALUE', message));
      expect(await rejection(build(fieldFilter({ ...condition, operator: 'IN' })))).toEqual(invalid('INVALID_FILTER_VALUE', message));
    });
  });

  describe('IIN', () => {
    test('compiles to $in of anchored, escaped BSON regular expressions with the i option, one per value', async () => {
      expect(await build({ name: { operator: 'IIN', value: ['ana', 'B.x'] } }))
        .toStrictEqual([{ $match: { name: { $in: [new BSONRegExp('^ana\\z', 'i'), new BSONRegExp('^B\\.x\\z', 'i')] } } }, ...PAGE]);
      const patterns = (await matchOf({ name: { operator: 'IIN', value: ['ana', 'B.x', 'ana'] } })).name.$in;
      for (const pattern of patterns) {
        expect(pattern).toBeInstanceOf(BSONRegExp);
        expect(pattern).not.toBeInstanceOf(RegExp);
        expect(pattern.options).toBe('i');
      }
      // Duplicates are kept, and values are neither folded nor cast.
      expect(patterns.map(({ pattern }) => pattern)).toEqual(['^ana\\z', '^B\\.x\\z', '^ana\\z']);
      // The empty list matches nothing.
      expect(await build({ tags: { operator: 'IIN', value: [] } })).toStrictEqual([{ $match: { tags: { $in: [] } } }, ...PAGE]);
    });

    test('escapes every regular expression metacharacter, so values never become syntax', async () => {
      const value = '.*+?^${}()|[]\\/%_-#\n';
      const escaped = '\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\/%_-#\n';
      expect(await matchOf({ name: { operator: 'IIN', value: [value, '(?i)', '$x', ''] } })).toStrictEqual({
        name: {
          $in: [
            new BSONRegExp(`^${escaped}\\z`, 'i'), new BSONRegExp('^\\(\\?i\\)\\z', 'i'), new BSONRegExp('^\\$x\\z', 'i'), new BSONRegExp('^\\z', 'i'),
          ],
        },
      });
    });

    // String fields and String lists, validated String scalars included.
    const STRING_LEAVES = [
      'name', 'tags', 'emails', 'dims.label', 'dims.codes', 'box.label', 'box.tags', 'lines.sku', 'lines.notes', 'lines.subs.code',
      'lines.subs.notes', 'parts.sku', 'parts.codes', 'parts.subs.code', 'shop.name', 'shop.tags', 'shop.slines.sku', 'box.shop.tags',
      // A reference inside an embedded list keeps the multiplying join of IN, and a collection is an implicit ANY frame.
      'parts.shop.name', 'reviews.author',
    ];

    test.each(STRING_LEAVES)('compiles wherever IEQ compiles: %s, in every surface', async (field) => {
      // One value: IEQ's pipeline with $in of IEQ's pattern.
      expect(await surfaces({ field, operator: 'IIN', value: ['a'] }))
        .toStrictEqual(regexToIn(await surfaces({ field, operator: 'IEQ', value: 'a' }), ['^a\\z']));
      // Two values: one pattern each, in order.
      expect(await surfaces({ field, operator: 'IIN', value: ['a', 'B.x'] }))
        .toStrictEqual(regexToIn(await surfaces({ field, operator: 'IEQ', value: 'a' }), ['^a\\z', '^B\\.x\\z']));
    });

    test('compiles beside CONTAINS_ALL in group conditions by field and path, in OR branches and in nested groups', async () => {
      expect(await build({
        AND: [{
          conditions: [
            { field: 'shop', path: 'name', operator: 'IIN', value: ['x'] },
            { field: 'dims.codes', operator: 'CONTAINS_ALL', value: ['A'] },
          ],
          OR: [
            { conditions: [{ field: 'name', operator: 'IIN', value: ['z'] }] },
            { AND: [{ conditions: [{ field: 'box.tags', operator: 'CONTAINS_ALL', value: ['p', 'q'] }] }] },
          ],
        }],
      })).toStrictEqual([
        ...plainLookup('QlmPlanShop', 'shop'),
        {
          $match: {
            $and: [
              { '__sf_l0.name': { $in: [new BSONRegExp('^x\\z', 'i')] } },
              { 'dims.codes': { $all: ['A'] } },
              { $or: [{ name: { $in: [new BSONRegExp('^z\\z', 'i')] } }, { 'box.tags': { $all: ['p', 'q'] } }] },
            ],
          },
        },
        ...PAGE,
        { $unset: ['__sf_l0'] },
      ]);
    });

    test('a record identity declared String compiles IIN on _id, which a generated ObjectId key never matches', async () => {
      expect(await fixture.queries.buildQuery({ id: { operator: 'IIN', value: ['abc'] } }, Label))
        .toStrictEqual([{ $match: { _id: { $in: [new BSONRegExp('^abc\\z', 'i')] } } }, ...PAGE]);
      expect(await fixture.queries.buildQuery({ id: { operator: 'IIN', value: [] } }, Label)).toStrictEqual([{ $match: { _id: { $in: [] } } }, ...PAGE]);
      expect(await build({ label: { terms: [{ path: 'id', operator: 'IIN', value: ['abc'] }] } })).toStrictEqual([
        ...plainLookup('QlmPlanLabel', 'label'),
        { $match: { '__sf_l0._id': { $in: [new BSONRegExp('^abc\\z', 'i')] } } },
        ...PAGE,
        { $unset: ['__sf_l0'] },
      ]);
    });

    test('pin: a record identity declared String compiles IEQ on _id', async () => {
      expect(await fixture.queries.buildQuery({ id: { operator: 'IEQ', value: 'abc' } }, Label))
        .toStrictEqual([{ $match: { _id: { $regex: '^abc\\z', $options: 'i' } } }, ...PAGE]);
      expect(await build({ label: { terms: [{ path: 'id', operator: 'IEQ', value: 'abc' }] } })).toStrictEqual([
        ...plainLookup('QlmPlanLabel', 'label'),
        { $match: { '__sf_l0._id': { $regex: '^abc\\z', $options: 'i' } } },
        ...PAGE,
        { $unset: ['__sf_l0'] },
      ]);
    });

    test('applies MongoDB\'s 32,764-byte limit to each compiled pattern, which is exactly the pattern sent', async () => {
      // ^ and \z add three bytes to the escaped value.
      const [longest] = (await matchOf({ name: { operator: 'IIN', value: ['a'.repeat(32761)] } })).name.$in;
      expect(longest).toBeInstanceOf(BSONRegExp);
      expect(Buffer.byteLength(longest.pattern)).toBe(32764);
      expect(await rejection(build({ name: { operator: 'IIN', value: ['a'.repeat(32762)] } }))).toEqual(TOO_LONG('name'));
      // Each value on its own: two 20,000-character values compile, and a long value fails beside a short one.
      expect((await matchOf({ name: { operator: 'IIN', value: ['a'.repeat(20000), 'b'.repeat(20000)] } })).name.$in.map(({ pattern }) => Buffer.byteLength(pattern)))
        .toEqual([20003, 20003]);
      expect(await rejection(build({ name: { operator: 'IIN', value: ['ok', 'a'.repeat(32762)] } }))).toEqual(TOO_LONG('name'));
      // escapeRegex leaves / alone, and a BSON regular expression sends it as it is (a RegExp would send \/).
      const [slashes] = (await matchOf({ name: { operator: 'IIN', value: ['/'.repeat(32761)] } })).name.$in;
      expect(slashes.pattern).toBe(`^${'/'.repeat(32761)}\\z`);
      // Escaping adds a byte to each metacharacter, and the limit counts UTF-8 bytes.
      expect(Buffer.byteLength((await matchOf({ name: { operator: 'IIN', value: ['.'.repeat(16380)] } })).name.$in[0].pattern)).toBe(32763);
      expect(Buffer.byteLength((await matchOf({ name: { operator: 'IIN', value: ['é'.repeat(16380)] } })).name.$in[0].pattern)).toBe(32763);
      expect(await rejection(build({ shop: { terms: [{ path: 'name', operator: 'IIN', value: ['.'.repeat(16381)] }] } }))).toEqual(TOO_LONG('shop.name'));
      expect(await rejection(build({ OR: [{ conditions: [{ field: 'tags', operator: 'IIN', value: ['é'.repeat(16381)] }] }] }))).toEqual(TOO_LONG('tags'));
    });
  });

  describe('frames', () => {
    test('an ALL frame negates $all inside its sub-pipeline, and a quantified field filter compiles alike', async () => {
      const expected = reviewsFrame([{ $match: { $nor: [{ tags: { $all: ['x'] } }] } }], false);
      expect(await build({ AND: [{ ALL: [{ path: 'reviews', conditions: [{ field: 'tags', operator: 'CONTAINS_ALL', value: ['x'] }] }] }] }))
        .toStrictEqual(expected);
      expect(await build({ reviews: { quantifier: 'ALL', terms: [{ path: 'tags', operator: 'CONTAINS_ALL', value: ['x'] }] } })).toStrictEqual(expected);
      expect(await build({ AND: [{ ANY: [{ path: 'reviews', conditions: [{ field: 'tags', operator: 'CONTAINS_ALL', value: ['x', 'y'] }] }] }] }))
        .toStrictEqual(reviewsFrame([{ $match: { tags: { $all: ['x', 'y'] } } }], true));
    });

    test('IIN through a collection is an implicit ANY frame, also as a shorthand term', async () => {
      const expected = reviewsFrame([{ $match: { author: { $in: [new BSONRegExp('^ana\\z', 'i')] } } }], true);
      expect(await build(inGroup({ field: 'reviews.author', operator: 'IIN', value: ['ana'] }))).toStrictEqual(expected);
      expect(await build({ reviews: { terms: [{ path: 'author', operator: 'IIN', value: ['ana'] }] } })).toStrictEqual(expected);
      expect(await build({ AND: [{ ALL: [{ path: 'reviews', conditions: [{ field: 'author', operator: 'IIN', value: ['ana', 'bob'] }] }] }] }))
        .toStrictEqual(reviewsFrame([{ $match: { $nor: [{ author: { $in: [new BSONRegExp('^ana\\z', 'i'), new BSONRegExp('^bob\\z', 'i')] } }] } }], false));
    });

    test.each(['ANY', 'ALL'])('scoped joins inside %s frames apply the target scope before CONTAINS_ALL and IIN read the joined record', async (quantifier) => {
      // The marker of a client condition inside a reviews frame: item is crossed plainly, item.shop through its scope.
      const marked = (condition) => ({
        AND: [{
          [quantifier]: [{
            path: 'reviews',
            conditions: [{ ...condition, __scope: { scopes: { item: null, 'item.shop': { name: { operator: 'NE', value: 'beta' } } } } }],
          }],
        }],
      });
      const expected = (match) => reviewsFrame([
        ...plainLookup('QlmPlanItem', 'item'),
        {
          $lookup: {
            from: 'QlmPlanShop', localField: '__sf_l0.shop', foreignField: '_id',
            pipeline: [{ $match: { name: { $ne: 'beta' } } }, { $limit: 1 }], as: '__sf_j0',
          },
        },
        { $unwind: { path: '$__sf_j0', preserveNullAndEmptyArrays: true } },
        { $match: quantifier === 'ALL' ? { $nor: [match] } : match },
      ], quantifier === 'ANY');
      expect(await build(marked({ field: 'item.shop.tags', operator: 'CONTAINS_ALL', value: ['a'] })))
        .toStrictEqual(expected({ '__sf_j0.tags': { $all: ['a'] } }));
      expect(await build(marked({ field: 'item.shop.name', operator: 'IIN', value: ['BETA'] })))
        .toStrictEqual(expected({ '__sf_j0.name': { $in: [new BSONRegExp('^BETA\\z', 'i')] } }));
    });

    test('a scoped reference inside an embedded list inside a frame fails closed with IIN, before any lookup', async () => {
      const args = {
        AND: [{
          ANY: [{
            path: 'reviews',
            conditions: [{
              field: 'item.parts.shop.name', operator: 'IIN', value: ['alpha'],
              __scope: { scopes: { item: null, 'item.parts.shop': { name: { operator: 'NE', value: 'beta' } } } },
            }],
          }],
        }],
      };
      expect(await rejection(build(args))).toEqual({
        simfinity: true, code: 'FORBIDDEN_FILTER_PATH', status: 403, message: 'A reference inside an embedded list cannot apply a target scope',
      });
    });
  });

  describe('direct calls validate before compiling', () => {
    // Every rejection comes from core's shared validator, which each public build runs first: core's messages, never
    // MongoDB's own (`CONTAINS_ALL does not accept null elements`), prove that it ran before the compiler.
    const REJECTIONS = [
      [{ field: 'name', operator: 'CONTAINS_ALL', value: ['x'] }, NON_LIST('name')],
      [{ field: 'id', operator: 'CONTAINS_ALL', value: ['x'] }, NON_LIST('id')],
      [{ field: 'dims.label', operator: 'CONTAINS_ALL', value: ['x'] }, NON_LIST('dims.label')],
      [{ field: 'shop.name', operator: 'CONTAINS_ALL', value: ['x'] }, NON_LIST('shop.name')],
      [{ field: 'parts.shop.tags', operator: 'CONTAINS_ALL', value: ['a'] }, invalid('INVALID_FILTER_PATH', 'CONTAINS_ALL cannot cross the reference parts.shop inside an embedded list, which joins one referenced record per row; combine EQ conditions on the path instead')],
      [{ field: 'tags', operator: 'CONTAINS_ALL', value: [] }, invalid('INVALID_FILTER_VALUE', 'CONTAINS_ALL requires a non-empty list')],
      [{ field: 'tags', operator: 'CONTAINS_ALL', value: [null] }, invalid('INVALID_FILTER_VALUE', 'Filter lists require non-null scalar elements')],
      [{ field: 'tags', operator: 'CONTAINS_ALL', value: [{}] }, invalid('INVALID_FILTER_VALUE', 'Filter lists require non-null scalar elements')],
      [{ field: 'tags', operator: 'CONTAINS_ALL', value: [{ $ne: null }] }, invalid('INVALID_FILTER_VALUE', 'Filter lists require non-null scalar elements')],
      [{ field: 'tags', operator: 'CONTAINS_ALL', value: 'x' }, invalid('INVALID_FILTER_VALUE', 'CONTAINS_ALL requires an array value')],
      [{ field: 'kinds', operator: 'IIN', value: ['a'] }, invalid('INVALID_FILTER_VALUE', 'IIN requires a String field on kinds')],
      [{ field: 'id', operator: 'IIN', value: ['a'] }, invalid('INVALID_FILTER_VALUE', 'IIN requires a String field on id')],
    ];

    test.each(REJECTIONS.map(([condition, expected]) => [`${condition.field} ${condition.operator} ${JSON.stringify(condition.value)}`, condition, expected]))(
      'rejects %s in buildQuery, buildAggregationQuery and buildFilterGroupMatch',
      async (_name, condition, expected) => {
        expect(await rejection(build(fieldFilter(condition))), 'field filter').toEqual(expected);
        expect(await rejection(aggregate(fieldFilter(condition))), 'aggregate field filter').toEqual(expected);
        expect(await rejection(build(inGroup(condition))), 'group condition').toEqual(expected);
        expect(await rejection(aggregate(inGroup(condition))), 'aggregate group condition').toEqual(expected);
        expect(await rejection(native(groupOf(condition))), 'buildFilterGroupMatch').toEqual(expected);
      },
    );

    test('rejects CONTAINS_ALL on a scalar inside a frame body, which compileFrame compiles without validating again', async () => {
      const frame = { ANY: [{ path: 'reviews', conditions: [{ field: 'author', operator: 'CONTAINS_ALL', value: ['x'] }] }] };
      expect(await rejection(build({ AND: [frame] }))).toEqual(NON_LIST('author'));
      expect(await rejection(aggregate({ AND: [frame] }))).toEqual(NON_LIST('author'));
      expect(await rejection(native(frame))).toEqual(NON_LIST('author'));
    });

    test('guard: CONTAINS_ALL through a collection keeps the shorthand\'s INVALID_FILTER_PATH, also on an aggregate J prefix', async () => {
      const condition = { field: 'reviews.tags', operator: 'CONTAINS_ALL', value: ['x'] };
      const joined = { groupId: 'reviews.author', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }] };
      for (const args of [fieldFilter(condition), inGroup(condition)]) {
        expect(await rejection(build(args))).toEqual(SHORTHAND);
        expect(await rejection(aggregate(args, joined))).toEqual(SHORTHAND);
      }
      expect(await rejection(native(groupOf(condition)))).toEqual(SHORTHAND);
    });
  });

  // A group that trusted code writes by hand with __implicit, whatever its operators, must end, after any anchor, at a
  // collection, or at a reference without crossing a list (spec 1.3 and 2.4, maintainer answer 4 as revised). On
  // 7f12322 the EQ and IN groups below compiled: an empty $lookup of the embedded type's model for lines, parts and box,
  // which matched nothing under ANY and everything under ALL and NONE, and a reference frame below a list for
  // parts.shop and reviews.item.
  describe('hand-built implicit groups', () => {
    const IMPLICIT_END = invalid('INVALID_FILTER_PATH', 'An implicit quantified path must end at a collection, or at a reference without crossing a list');
    const implicitGroup = (quantifier, path, condition) => ({ [quantifier]: [{ __implicit: true, path, conditions: [condition] }] });
    const nativeInto = async (group, clauses) => fixture.adapter.buildFilterGroupMatch(group, Item, clauses, {});
    // Per path, a scalar leaf of the element for EQ, IN and IIN and a list leaf for CONTAINS_ALL, each valid on its own:
    // embedded lists, a single embedded object, a reference after an embedded list and one after a collection.
    const REJECTED = [
      ['lines', 'sku', 'notes'], ['parts', 'sku', 'codes'], ['box', 'label', 'tags'], ['parts.shop', 'name', 'tags'], ['reviews.item', 'name', 'tags'],
    ].flatMap(([path, scalar, list]) => [
      { field: scalar, operator: 'EQ', value: 'a' }, { field: scalar, operator: 'IN', value: ['a'] },
      { field: list, operator: 'CONTAINS_ALL', value: ['a'] }, { field: scalar, operator: 'IIN', value: ['a'] },
    ].map((condition) => [`${path}, with ${condition.field} ${condition.operator}`, path, condition]));
    // A reference frame on Item.shop.
    const shopFrame = (match) => [
      {
        $lookup: {
          from: 'QlmPlanShop', localField: 'shop', foreignField: '_id',
          pipeline: [{ $match: match }, { $limit: 1 }, { $project: { _id: 1 } }], as: '__sf_q0',
        },
      },
      { $match: { '__sf_q0.0': { $exists: true } } },
      ...PAGE,
      { $unset: ['__sf_q0'] },
    ];
    // The group the rewrite writes for parts.shop.items: the item looked up again by _id, the shops of its parts joined,
    // then their items as a collection frame (the shape tests/integration/collection-frames-mongodb.test.js pins for
    // lines.shop.children).
    const partsShopItemsFrame = (match) => [
      {
        $lookup: {
          from: 'QlmPlanItem', localField: '_id', foreignField: '_id',
          pipeline: [
            ...plainLookup('QlmPlanShop', 'parts.shop'),
            {
              $lookup: {
                from: 'QlmPlanItem', localField: '__sf_l0._id', foreignField: 'shop',
                pipeline: [{ $match: { shop: { $ne: null } } }, { $match: match }, { $limit: 1 }, { $project: { _id: 1 } }], as: '__sf_q1',
              },
            },
            { $match: { '__sf_q1.0': { $exists: true } } },
            { $limit: 1 },
            { $project: { _id: 1 } },
          ],
          as: '__sf_q0',
        },
      },
      { $match: { '__sf_q0.0': { $exists: true } } },
      ...PAGE,
      { $unset: ['__sf_q0'] },
    ];

    describe('buildQuery, buildAggregationQuery and buildFilterGroupMatch reject a hand-built implicit group that does not end at a collection or at a reference without crossing a list, with no pipeline', () => {
      test.each(REJECTED)('over %s', async (_name, path, condition) => {
        for (const quantifier of ['ANY', 'ALL', 'NONE']) {
          const group = implicitGroup(quantifier, path, condition);
          expect(await rejection(build({ AND: [group] })), `${quantifier} find`).toEqual(IMPLICIT_END);
          expect(await rejection(build({ AND: [group] }, true)), `${quantifier} count`).toEqual(IMPLICIT_END);
          expect(await rejection(aggregate({ AND: [group] })), `${quantifier} aggregate`).toEqual(IMPLICIT_END);
          // The native group API appends no lookup either.
          const clauses = [];
          expect(await rejection(nativeInto(group, clauses)), `${quantifier} buildFilterGroupMatch`).toEqual(IMPLICIT_END);
          expect(clauses, `${quantifier} buildFilterGroupMatch`).toEqual([]);
        }
      });
    });

    test('guard: a hand-built implicit group over shop compiles as the explicit ANY group over shop', async () => {
      for (const [condition, match] of [
        [{ field: 'name', operator: 'EQ', value: 'Alpha' }, { name: 'Alpha' }],
        [{ field: 'name', operator: 'IN', value: ['Alpha'] }, { name: { $in: ['Alpha'] } }],
      ]) {
        const pipeline = await build({ AND: [implicitGroup('ANY', 'shop', condition)] });
        expect(pipeline, condition.operator).toStrictEqual(await build({ AND: [{ ANY: [{ path: 'shop', conditions: [condition] }] }] }));
        expect(pipeline, condition.operator).toStrictEqual(shopFrame(match));
      }
    });

    test('compiles CONTAINS_ALL and IIN in a hand-built implicit group over shop as the explicit ANY group over shop', async () => {
      for (const [condition, match] of [
        [{ field: 'tags', operator: 'CONTAINS_ALL', value: ['a'] }, { tags: { $all: ['a'] } }],
        [{ field: 'name', operator: 'IIN', value: ['alpha'] }, { name: { $in: [new BSONRegExp('^alpha\\z', 'i')] } }],
      ]) {
        const pipeline = await build({ AND: [implicitGroup('ANY', 'shop', condition)] });
        expect(pipeline, condition.operator).toStrictEqual(await build({ AND: [{ ANY: [{ path: 'shop', conditions: [condition] }] }] }));
        expect(pipeline, condition.operator).toStrictEqual(shopFrame(match));
      }
    });

    test('guard: the implicit group the rewrite writes for parts.shop.items compiles', async () => {
      expect(await build({ parts: { terms: [{ path: 'shop.items.name', operator: 'EQ', value: 'one' }] } })).toStrictEqual(partsShopItemsFrame({ name: 'one' }));
    });

    test('compiles IIN through parts.shop.items as the implicit group the rewrite writes', async () => {
      expect(await build({ parts: { terms: [{ path: 'shop.items.name', operator: 'IIN', value: ['ONE'] }] } }))
        .toStrictEqual(partsShopItemsFrame({ name: { $in: [new BSONRegExp('^ONE\\z', 'i')] } }));
    });
  });

  // A hand-built anchor is valid only in exactly the shape the rewrite (cutAt) writes: (i) in an aggregate, (ii) on a
  // group at the root, (iii) a non-empty array of single path segments, (iv) whose steps cross at least one collection,
  // every one a join prefix of the aggregate, with any embedded lists, embedded objects and references between, (v)
  // followed by exactly one step, a collection (spec 1.3 and 2.4, maintainer answer 6 as revised). On 7f12322 the EQ
  // and IN groups below compiled or failed with another error: a root $lookup and $unwind of the reviews for ['reviews']
  // in a find, which read an item once per review, a frame $lookup on parts.shop or box.shop for the embedded anchors
  // and the Sets, the relations crossed after a join prefix joined into the rows before $group, and Invalid filter path
  // for the dotted element.
  describe('hand-built anchors', () => {
    const { Shop } = fixture.types;
    const ANCHOR = invalid('INVALID_FILTER_PATH', 'An implicit quantified anchor must name the aggregate\'s join prefixes');
    const groupedBy = (groupId) => ({ groupId, facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }] });
    // Per type a group ends at, a String field for EQ, IN and IIN and a list for CONTAINS_ALL, each valid on its own.
    const END_FIELDS = { Item: ['name', 'tags'], Shop: ['name', 'tags'], Review: ['author', 'tags'] };
    const SHOP_BY_ITEMS = { type: Shop, groupId: 'items.name' };
    const ITEM_BY_AUTHOR = { type: Item, groupId: 'reviews.author' };
    const ITEM_BY_SHOP_ITEMS = { type: Item, groupId: 'parts.shop.items.name' };
    // [name, row]: the queried type, the aggregation whose join prefixes leave only the named condition failing, the
    // explicit ANY frames around the group, outermost first, a fresh anchor, the path after it and the type it ends at.
    // Condition (i) cannot fail alone here, since the builds derive J only in aggregates; core's validator rows pin it.
    const ANCHORS = [
      // (ii) The frame-relative anchor items is a root join prefix, so only the enclosing frames fail.
      ['(ii) [items] reviews inside ANY items, then ANY shop, on Shop grouped by items.name', {
        ...SHOP_BY_ITEMS, frames: ['items', 'shop'], anchor: () => ['items'], path: 'reviews', end: 'Review',
      }],
      // (iii) An empty anchor, a dotted element, the rewrite's own anchor as a Set, and, before the path rule, a Set
      // whose bare path also crosses a list before its reference end.
      ['(iii) [] items on Shop grouped by items.name', { ...SHOP_BY_ITEMS, anchor: () => [], path: 'items', end: 'Item' }],
      ['(iii) [items.parts, shop] items on Shop grouped by items.name', {
        ...SHOP_BY_ITEMS, anchor: () => ['items.parts', 'shop'], path: 'items', end: 'Item',
      }],
      ['(iii) Set [parts, shop, items] reviews on Item grouped by parts.shop.items.name', {
        ...ITEM_BY_SHOP_ITEMS, anchor: () => new Set(['parts', 'shop', 'items']), path: 'reviews', end: 'Review',
      }],
      ['(iii) before the path rule: Set [parts] parts.shop on Item grouped by reviews.author', {
        ...ITEM_BY_AUTHOR, anchor: () => new Set(['parts']), path: 'parts.shop', end: 'Shop',
      }],
      // (iv) A join prefix, then a collection outside J; an anchor that crosses no collection.
      ['(iv) [items, reviews, item] reviews on Shop grouped by items.name', {
        ...SHOP_BY_ITEMS, anchor: () => ['items', 'reviews', 'item'], path: 'reviews', end: 'Review',
      }],
      ['(iv) [parts, shop] items on Item grouped by reviews.author', { ...ITEM_BY_AUTHOR, anchor: () => ['parts', 'shop'], path: 'items', end: 'Item' }],
      // (v) A reference after the anchor, and more than one step after it.
      ['(v) [items] shop on Shop grouped by items.name', { ...SHOP_BY_ITEMS, anchor: () => ['items'], path: 'shop', end: 'Shop' }],
      ['(v) [items] shop.items on Shop grouped by items.name', { ...SHOP_BY_ITEMS, anchor: () => ['items'], path: 'shop.items', end: 'Item' }],
      ['(v) [items] reviews.item.reviews on Shop grouped by items.name', {
        ...SHOP_BY_ITEMS, anchor: () => ['items'], path: 'reviews.item.reviews', end: 'Review',
      }],
      ['(v) [items] parts.shop.items on Shop grouped by items.name', {
        ...SHOP_BY_ITEMS, anchor: () => ['items'], path: 'parts.shop.items', end: 'Item',
      }],
      ['(v) [reviews] item on Item grouped by reviews.author', { ...ITEM_BY_AUTHOR, anchor: () => ['reviews'], path: 'item', end: 'Item' }],
      // The first version's rows: embedded anchors that cross no collection, and a Set.
      ['[parts] shop on Item grouped by reviews.author', { ...ITEM_BY_AUTHOR, anchor: () => ['parts'], path: 'shop', end: 'Shop' }],
      ['[box] shop on Item grouped by reviews.author', { ...ITEM_BY_AUTHOR, anchor: () => ['box'], path: 'shop', end: 'Shop' }],
      ['Set [parts] shop on Item grouped by reviews.author', { ...ITEM_BY_AUTHOR, anchor: () => new Set(['parts']), path: 'shop', end: 'Shop' }],
    ];
    const ROWS = ANCHORS.flatMap(([name, row]) => {
      const [scalar, list] = END_FIELDS[row.end];
      return [
        { field: scalar, operator: 'EQ', value: 'a' }, { field: scalar, operator: 'IN', value: ['a'] },
        { field: scalar, operator: 'IIN', value: ['a'] }, { field: list, operator: 'CONTAINS_ALL', value: ['a'] },
      ].map((condition) => [`${name}, with ${condition.field} ${condition.operator}`, row, condition]);
    });

    describe('buildQuery, its count, buildAggregationQuery and buildFilterGroupMatch reject a hand-built implicit anchor that is not in the shape the rewrite writes, with no pipeline', () => {
      test.each(ROWS)('%s', async (_name, {
        type, groupId, frames = [], anchor, path,
      }, condition) => {
        for (const quantifier of ['ANY', 'ALL', 'NONE']) {
          // The group inside the row's frames, with a fresh anchor and condition per build.
          const group = () => frames.reduceRight((inner, frame) => ({ ANY: [{ path: frame, ...inner }] }), {
            [quantifier]: [{ __implicit: true, __anchor: anchor(), path, conditions: [{ ...condition }] }],
          });
          expect(await rejection(fixture.queries.buildQuery({ AND: [group()] }, type)), `${quantifier} find`).toEqual(ANCHOR);
          expect(await rejection(fixture.queries.buildQuery({ AND: [group()] }, type, true)), `${quantifier} count`).toEqual(ANCHOR);
          expect(await rejection(fixture.queries.buildAggregationQuery({ AND: [group()] }, type, COUNT_BY_NAME)), `${quantifier} aggregate by name`)
            .toEqual(ANCHOR);
          expect(await rejection(fixture.queries.buildAggregationQuery({ AND: [group()] }, type, groupedBy(groupId))), `${quantifier} aggregate by ${groupId}`)
            .toEqual(ANCHOR);
          // The native group API, which validates as a find, appends no lookup either.
          const clauses = [];
          expect(await rejection(fixture.adapter.buildFilterGroupMatch(group(), type, clauses, {})), `${quantifier} buildFilterGroupMatch`).toEqual(ANCHOR);
          expect(clauses, `${quantifier} buildFilterGroupMatch`).toEqual([]);
        }
      });
    });

    // cutAt writes as anchor every step before the first collection outside J, embedded lists and references included:
    // grouped by items.name, the shorthand items.parts.shop.items.name on Shop becomes the group
    // { __anchor: ['items', 'parts', 'shop'], path: 'items' }, and grouped by parts.shop.items.name,
    // parts.shop.items.reviews.author on Item becomes { __anchor: ['parts', 'shop', 'items'], path: 'reviews' }.
    test('guard: hand-built copies of the anchors the rewrite writes through an embedded list compile as their shorthands', async () => {
      const byItemName = groupedBy('items.name');
      const byShopItemName = groupedBy('parts.shop.items.name');
      for (const [operator, value] of [['EQ', 'one'], ['IN', ['one']]]) {
        const copy = (anchor, path, field) => ({ AND: [{ ANY: [{ __implicit: true, __anchor: anchor, path, conditions: [{ field, operator, value }] }] }] });
        const shorthand = (field) => ({ AND: [{ conditions: [{ field, operator, value }] }] });
        expect(await fixture.queries.buildAggregationQuery(copy(['items', 'parts', 'shop'], 'items', 'name'), Shop, byItemName), `${operator} on Shop`)
          .toStrictEqual(await fixture.queries.buildAggregationQuery(shorthand('items.parts.shop.items.name'), Shop, byItemName));
        expect(await fixture.queries.buildAggregationQuery(copy(['parts', 'shop', 'items'], 'reviews', 'author'), Item, byShopItemName), `${operator} on Item`)
          .toStrictEqual(await fixture.queries.buildAggregationQuery(shorthand('parts.shop.items.reviews.author'), Item, byShopItemName));
      }
    });
  });

  // A collection that a hand-built implicit group crosses before its end multiplies the group's prefix, as an embedded
  // list does, so the group compiles inside the self-correlated prefix witness, as PostgreSQL isolates every list prefix
  // (spec 5.1, maintainer answer 5). On 7f12322 the crossed collection was joined into the row stream at the root. Every
  // group that crosses no collection before its end, every explicit group, every shorthand and the anchored frame keep
  // the pipelines that 7f12322 gives with this fixture, which the literals below hold.
  describe('a collection crossed before the end', () => {
    const { Shop } = fixture.types;
    const ana = (field) => ({ field, operator: 'EQ', value: 'Ana' });
    const implicitGroup = (quantifier, path, condition) => ({ AND: [{ [quantifier]: [{ __implicit: true, path, conditions: [condition] }] }] });
    const explicitGroup = (quantifier, path, condition) => ({ AND: [{ [quantifier]: [{ path, conditions: [condition] }] }] });
    // A plain join of a reference or a collection, unwound with its nulls kept.
    const join = (from, localField, foreignField, as) => [
      { $lookup: { from, foreignField, localField, as } },
      { $unwind: { path: `$${as}`, preserveNullAndEmptyArrays: true } },
    ];
    // A frame or witness $lookup, whose sub-pipeline keeps at most one _id, and the test of its result.
    const lookup = (from, localField, foreignField, pipeline, as) => ({
      $lookup: { from, localField, foreignField, pipeline: [...pipeline, { $limit: 1 }, { $project: { _id: 1 } }], as },
    });
    const found = (as, exists) => ({ $match: { [`${as}.0`]: { $exists: exists } } });
    // A frame's body: ALL looks for an element that fails it.
    const body = (quantifier, match) => ({ $match: quantifier === 'ALL' ? { $nor: [match] } : match });
    const notNull = (field) => ({ $match: { [field]: { $ne: null } } });
    // A frame over the queried type's own field, as __sf_q0.
    const frame = (quantifier, from, localField, foreignField, match, before = []) => [
      lookup(from, localField, foreignField, [...before, body(quantifier, match)], '__sf_q0'), found('__sf_q0', quantifier === 'ANY'),
    ];
    // The self-correlated witness of the queried collection: its prefix joined, then the frame over the end as __sf_q1,
    // which tests ANY for NONE; ALL looks for a prefix element whose ALL test fails, an empty prefix included.
    const witness = (from, quantifier, prefix, end) => {
      const positive = quantifier === 'NONE' ? 'ANY' : quantifier;
      const tested = { '__sf_q1.0': { $exists: positive === 'ANY' } };
      return [
        lookup(from, '_id', '_id', [...prefix, end(positive), { $match: quantifier === 'ALL' ? { $nor: [tested] } : tested }], '__sf_q0'),
        found('__sf_q0', quantifier === 'ANY'),
      ];
    };
    const listed = (stages, unset = ['__sf_q0']) => [...stages, ...PAGE, { $unset: unset }];
    const counted = (stages) => [...stages, { $count: 'size' }];
    const partsShopItems = (quantifier) => witness('QlmPlanItem', quantifier, join('QlmPlanShop', 'parts.shop', '_id', '__sf_l0'), (positive) => lookup(
      'QlmPlanItem', '__sf_l0._id', 'shop', [notNull('shop'), body(positive, { name: 'Ana' })], '__sf_q1',
    ));

    test.each(['ANY', 'ALL', 'NONE'])('isolates a collection that a hand-built implicit group crosses before its end in the prefix witness, under %s', async (quantifier) => {
      // Item's reviews, then each review's item, then that item's reviews.
      const reviewed = witness('QlmPlanItem', quantifier, [
        ...join('QlmPlanReview', '_id', 'item', '__sf_l0'), ...join('QlmPlanItem', '__sf_l0.item', '_id', '__sf_l1'),
      ], (positive) => lookup('QlmPlanReview', '__sf_l1._id', 'item', [notNull('item'), body(positive, { author: 'Ana' })], '__sf_q1'));
      const itemArgs = implicitGroup(quantifier, 'reviews.item.reviews', ana('author'));
      expect(await build(itemArgs), 'Item find').toStrictEqual(listed(reviewed));
      expect(await build(itemArgs, true), 'Item count').toStrictEqual(counted(reviewed));
      // Shop's items, then their reviews.
      const shopped = witness('QlmPlanShop', quantifier, join('QlmPlanItem', '_id', 'shop', '__sf_l0'), (positive) => lookup(
        'QlmPlanReview', '__sf_l0._id', 'item', [notNull('item'), body(positive, { author: 'Ana' })], '__sf_q1',
      ));
      const shopArgs = implicitGroup(quantifier, 'items.reviews', ana('author'));
      expect(await fixture.queries.buildQuery(shopArgs, Shop), 'Shop find').toStrictEqual(listed(shopped));
      expect(await fixture.queries.buildQuery(shopArgs, Shop, true), 'Shop count').toStrictEqual(counted(shopped));
      // No root stage unwinds the crossed collection.
      expect((await build(itemArgs)).filter((stage) => stage.$unwind), 'Item root').toEqual([]);
      expect((await fixture.queries.buildQuery(shopArgs, Shop)).filter((stage) => stage.$unwind), 'Shop root').toEqual([]);
    });

    test.each(['ANY', 'ALL', 'NONE'])('guard: groups that cross no collection before their end keep their pipelines, under %s', async (quantifier) => {
      const onShop = (args) => fixture.queries.buildQuery(args, Shop);
      const shopFrame = listed(frame(quantifier, 'QlmPlanShop', 'shop', '_id', { name: 'Ana' }));
      const reviewsFrame = listed(frame(quantifier, 'QlmPlanReview', '_id', 'item', { author: 'Ana' }));
      const itemsFrame = listed(frame(quantifier, 'QlmPlanItem', '_id', 'shop', { name: 'Ana' }));
      expect(await build(implicitGroup(quantifier, 'shop', ana('name'))), 'implicit shop').toStrictEqual(shopFrame);
      expect(await build(implicitGroup(quantifier, 'reviews', ana('author'))), 'implicit reviews').toStrictEqual(reviewsFrame);
      expect(await build(implicitGroup(quantifier, 'parts.shop.items', ana('name'))), 'implicit parts.shop.items').toStrictEqual(listed(partsShopItems(quantifier)));
      expect(await build(implicitGroup(quantifier, 'shop.items', ana('name'))), 'implicit shop.items').toStrictEqual(listed([
        ...join('QlmPlanShop', 'shop', '_id', '__sf_l0'),
        ...frame(quantifier, 'QlmPlanItem', '__sf_l0._id', 'shop', { name: 'Ana' }, [notNull('shop')]),
      ], ['__sf_l0', '__sf_q0']));
      expect(await onShop(implicitGroup(quantifier, 'items', ana('name'))), 'implicit items on Shop').toStrictEqual(itemsFrame);
      expect(await build(explicitGroup(quantifier, 'shop', ana('name'))), 'explicit shop').toStrictEqual(shopFrame);
      expect(await build(explicitGroup(quantifier, 'reviews', ana('author'))), 'explicit reviews').toStrictEqual(reviewsFrame);
      expect(await onShop(explicitGroup(quantifier, 'items', ana('name'))), 'explicit items on Shop').toStrictEqual(itemsFrame);
    });

    test('guard: shorthands through collections and the anchored frame keep their pipelines', async () => {
      expect(await build(inGroup(ana('reviews.item.reviews.author'))), 'reviews.item.reviews.author').toStrictEqual(listed([
        lookup('QlmPlanReview', '_id', 'item', [
          ...join('QlmPlanItem', 'item', '_id', '__sf_l0'),
          lookup('QlmPlanReview', '__sf_l0._id', 'item', [notNull('item'), { $match: { author: 'Ana' } }], '__sf_q1'), found('__sf_q1', true),
        ], '__sf_q0'),
        found('__sf_q0', true),
      ]));
      expect(await build(inGroup(ana('parts.shop.items.name'))), 'parts.shop.items.name').toStrictEqual(listed(partsShopItems('ANY')));
      expect(await build(inGroup(ana('reviews.item.shop.items.name'))), 'reviews.item.shop.items.name').toStrictEqual(listed([
        lookup('QlmPlanReview', '_id', 'item', [
          ...join('QlmPlanItem', 'item', '_id', '__sf_l0'), ...join('QlmPlanShop', '__sf_l0.shop', '_id', '__sf_l1'),
          lookup('QlmPlanItem', '__sf_l1._id', 'shop', [notNull('shop'), { $match: { name: 'Ana' } }], '__sf_q1'), found('__sf_q1', true),
        ], '__sf_q0'),
        found('__sf_q0', true),
      ]));
      expect(await fixture.queries.buildQuery(inGroup(ana('items.reviews.author')), Shop), 'items.reviews.author on Shop').toStrictEqual(listed([
        lookup('QlmPlanItem', '_id', 'shop', [
          lookup('QlmPlanReview', '_id', 'item', [{ $match: { author: 'Ana' } }], '__sf_q1'), found('__sf_q1', true),
        ], '__sf_q0'),
        found('__sf_q0', true),
      ]));
      // The anchored frame of 9.3: grouped by items.name, items is the join prefix and stays in the rows, and the group
      // that the rewrite writes, { __anchor: ['items'], path: 'reviews' }, compiles alike when trusted code writes it.
      const byItemName = { groupId: 'items.name', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }] };
      const anchored = [
        ...join('QlmPlanItem', '_id', 'shop', '__sf_l0'),
        lookup('QlmPlanReview', '__sf_l0._id', 'item', [notNull('item'), { $match: { author: 'Ana' } }], '__sf_q0'), found('__sf_q0', true),
        { $group: { _id: '$__sf_l0.name', fact_0: { $sum: 1 } } },
        { $project: { _id: 0, groupId: '$_id', facts: { n: '$fact_0' } } },
        { $sort: { groupId: 1 } },
      ];
      expect(await fixture.queries.buildAggregationQuery(inGroup(ana('items.reviews.author')), Shop, byItemName), 'anchored shorthand').toStrictEqual(anchored);
      expect(await fixture.queries.buildAggregationQuery({
        AND: [{ ANY: [{ __implicit: true, __anchor: ['items'], path: 'reviews', conditions: [ana('author')] }] }],
      }, Shop, byItemName), 'anchored by hand').toStrictEqual(anchored);
    });
  });

  describe('interface and union carriers', () => {
    // Fields that describeModels rejects and MongoDB's GraphQL contexts still read (tests/mongodb-query-paths.test.js).
    const Shape = new GraphQLInterfaceType({ name: 'QlmShape', fields: { label: { type: GraphQLString } } });
    const Circle = new GraphQLObjectType({ name: 'QlmCircle', interfaces: [Shape], fields: { label: { type: GraphQLString } } });
    const Either = new GraphQLUnionType({ name: 'QlmEither', types: [Circle] });
    const Holder = new GraphQLObjectType({
      name: 'QlmHolder',
      fields: {
        id: { type: GraphQLID }, shape: { type: Shape }, shapes: { type: new GraphQLList(Shape) }, either: { type: new GraphQLList(Either) },
      },
    });
    const holders = createMongoQueries({
      getModel: (type) => (type === Holder ? { collection: { collectionName: 'holders' } } : null),
      getRegistrations: () => [],
    });

    test.each(['shape', 'shapes', 'either'])('%s is no list for CONTAINS_ALL, with or without a value, and no String field for IIN', async (field) => {
      // Without a value, the leaf rule comes before the abstract carrier's own value check.
      for (const filter of [{ operator: 'CONTAINS_ALL', value: ['x'] }, { operator: 'CONTAINS_ALL' }]) {
        expect(await rejection(holders.buildQuery({ [field]: filter }, Holder))).toEqual(NON_LIST(field));
        expect(await rejection(holders.buildQuery(inGroup({ field, ...filter }), Holder))).toEqual(NON_LIST(field));
      }
      expect(await rejection(holders.buildQuery({ [field]: { operator: 'IIN', value: ['x'] } }, Holder)))
        .toEqual(invalid('INVALID_FILTER_VALUE', `IIN requires a String field on ${field}`));
    });
  });
});

// Items stored as the generated models store them: the rows show how the server reads both forms, and the long names
// reach the server's pattern limit.
const ITEMS = [
  { key: 'k01', name: 'one', tags: ['A', 'B', 'C'] },
  { key: 'k02', name: 'TWO', tags: ['A'] },
  { key: 'k03', name: 'three', tags: ['B', 'A'] },
  { key: 'k04', tags: [] },
  { key: 'k05', name: null, tags: null },
  { key: 'k06', name: 'B.x', tags: ['A', 'A', '$x'] },
  { key: 'k07', name: 'Bax', tags: ['a', 'b', null] },
  { key: 'k08', name: 'A'.repeat(32761) },
  { key: 'k09', name: '/'.repeat(32761) },
  { key: 'k10', name: 'C'.repeat(20000) },
  { key: 'k11', name: 'd'.repeat(20000) },
];
const STRING_NAMES = ITEMS.filter(({ name }) => typeof name === 'string').length;

// Generated models create their collections and indexes in the background; let them finish before the database is
// dropped, so that none is created again afterwards.
const dropDatabase = async () => {
  await Promise.allSettled(mongoose.modelNames().map((name) => mongoose.model(name).init()));
  await mongoose.connection.dropDatabase();
};

// The walker of the existing explain tests, limited to the subtrees under `key`: the winning plan, or the execution
// statistics.
const scans = (explain, key) => {
  const found = [];
  const walk = (node, inside) => {
    if (Array.isArray(node)) node.forEach((item) => walk(item, inside));
    else if (node && typeof node === 'object') {
      if (inside && (node.stage === 'IXSCAN' || node.stage === 'COLLSCAN')) found.push(node);
      for (const [name, value] of Object.entries(node)) walk(value, inside || name === key);
    }
  };
  walk(explain, false);
  return found;
};

const servers = [
  ['replica set', replicaSetUri, 'QlmRs'],
  ['standalone server', standaloneUri, 'QlmSa'],
];

describe.each(servers)('MongoDB list operators on a %s', (_label, uri, prefix) => {
  let fixture;

  const withValue = (filter) => `query($v: QLValue) { ${fixture.items}(${filter}, sort: {terms: [{field: "key", order: ASC}]}) { key } }`;
  const on = (field, operator) => `${field}: {operator: ${operator}, value: $v}`;
  const keys = async (filter, value) => {
    const result = await fixture.execute(withValue(filter), { v: value });
    expect(result.errors).toBeUndefined();
    return result.data[fixture.items].map(({ key }) => key);
  };
  const explain = async (args, verbosity) => {
    const pipeline = await fixture.adapter.buildQuery(args, fixture.types.Item);
    return fixture.model('item').aggregate(pipeline).explain(verbosity);
  };

  beforeAll(async () => {
    if (!uri) return;
    await mongoose.connect(uri, { dbName: `${new URL(uri).pathname.slice(1)}_qlm` });
    await mongoose.connection.dropDatabase();
    fixture = createFixture(prefix);
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    const items = fixture.model('item').collection;
    await items.insertMany(ITEMS.map((item) => ({ ...item })));
    await items.createIndex({ tags: 1 });
    await items.createIndex({ name: 1 });
  }, 30000);

  afterAll(async () => {
    if (!uri) return;
    await dropDatabase();
    await mongoose.disconnect();
  });

  describe.skipIf(!uri)('rows', () => {
    test('CONTAINS_ALL matches lists that hold every value, case-sensitively, whatever their order and duplicates', async () => {
      expect(await keys(on('tags', 'CONTAINS_ALL'), ['A', 'B'])).toEqual(['k01', 'k03']);
      expect(await keys(on('tags', 'CONTAINS_ALL'), ['A', 'A'])).toEqual(['k01', 'k02', 'k03', 'k06']);
      expect(await keys(on('tags', 'CONTAINS_ALL'), ['b', 'a'])).toEqual(['k07']);
      expect(await keys(on('tags', 'CONTAINS_ALL'), ['$x'])).toEqual(['k06']);
    });

    test('IIN matches some value ignoring case, literally', async () => {
      expect(await keys(on('name', 'IIN'), ['ONE', 'two'])).toEqual(['k01', 'k02']);
      expect(await keys(on('name', 'IIN'), ['b.x'])).toEqual(['k06']);
      expect(await keys(on('name', 'IIN'), [])).toEqual([]);
      expect(await keys(on('tags', 'IIN'), ['$X'])).toEqual(['k06']);
      expect(await keys(on('tags', 'IIN'), ['c', 'B'])).toEqual(['k01', 'k03', 'k07']);
    });

    test('the longest IIN pattern runs on the server, and a longer value fails with INVALID_FILTER_VALUE, not a server error', async () => {
      expect(await keys(on('name', 'IIN'), ['a'.repeat(32761)])).toEqual(['k08']);
      // A RegExp would send \/ for each slash, 65,525 bytes, which the server rejects (Location51091).
      expect(await keys(on('name', 'IIN'), ['/'.repeat(32761)])).toEqual(['k09']);
      // The limit applies to each pattern, not to their sum.
      expect(await keys(on('name', 'IIN'), ['c'.repeat(20000), 'D'.repeat(20000)])).toEqual(['k10', 'k11']);
      const result = await fixture.execute(withValue(on('name', 'IIN')), { v: ['a'.repeat(32762)] });
      expect(result.errors?.[0].extensions.code).toBe('INVALID_FILTER_VALUE');
      expect(result.errors?.[0].message).toBe('IIN value on name is too long: MongoDB accepts regular expressions of at most 32764 bytes, and this one has 32765');
    });

    test('CONTAINS_ALL reads one value\'s point bounds of a multikey index; IIN reads the whole index and examines every string key', async () => {
      // The planner bounds one of the values, whichever it ranks first, and filters the other after FETCH.
      const contained = scans(await explain({ tags: { operator: 'CONTAINS_ALL', value: ['A', 'B'] } }, 'queryPlanner'), 'winningPlan');
      expect(contained.map(({ stage }) => stage)).toEqual(['IXSCAN']);
      expect([{ tags: ['["A", "A"]'] }, { tags: ['["B", "B"]'] }]).toContainEqual(contained[0].indexBounds);
      const folded = scans(await explain({ name: { operator: 'IIN', value: ['one'] } }, 'queryPlanner'), 'winningPlan');
      expect(folded.map((scan) => `${scan.stage} ${JSON.stringify(scan.indexBounds)}`))
        .toEqual([`IXSCAN ${JSON.stringify({ name: ['["", {})', '[/^one\\z/i, /^one\\z/i]'] })}`]);
      const executed = scans(await explain({ name: { operator: 'IIN', value: ['one'] } }, 'executionStats'), 'executionStats');
      expect(executed.map(({ stage }) => stage)).toEqual(['IXSCAN']);
      expect(executed[0].keysExamined).toBeGreaterThanOrEqual(STRING_NAMES);
    });
  });
});

// Hand-built implicit groups on the list operator fixture: a trusted find scope that writes one over an embedded list
// fails the read before the adapter, one over reviews.item.reviews reads each item once, and the group the rewrite
// writes for parts.shop.items reads its rows.
describe.skipIf(!replicaSetUri)('hand-built implicit groups on the replica set', () => {
  // The group that Item's find scope appends when the request context asks for it; on 7f12322 it compiled to the ANY of
  // an empty $lookup, and the read returned no rows and no error.
  const LINES = { ANY: [{ __implicit: true, path: 'lines', conditions: [{ field: 'sku', operator: 'EQ', value: 'A' }] }] };
  const reads = [];
  let fixture;

  const read = (filter, contextValue) => fixture.execute(`{ ${fixture.items}(${filter}sort: {terms: [{field: "key", order: ASC}]}) { key } }`, {}, contextValue);
  const keys = async (filter) => {
    const result = await read(`${filter}, `);
    expect(result.errors).toBeUndefined();
    return result.data[fixture.items].map(({ key }) => key);
  };
  // The keys in order and pagination.count of a list query whose find scope appends `group`.
  const scoped = async (group) => {
    const context = { group };
    const result = await read('pagination: {page: 1, size: 100, count: true}, ', context);
    expect(result.errors).toBeUndefined();
    return { keys: result.data[fixture.items].map(({ key }) => key), count: context.count };
  };

  beforeAll(async () => {
    await mongoose.connect(replicaSetUri, { dbName: `${new URL(replicaSetUri).pathname.slice(1)}_qlmi` });
    await mongoose.connection.dropDatabase();
    // A spread copy of the bundled adapter whose reads record their method and forward.
    const adapter = createMongoAdapter();
    const record = (method) => (...args) => {
      reads.push(method);
      return adapter[method](...args);
    };
    fixture = createFixture(null, {
      adapter: {
        ...adapter, find: record('find'), count: record('count'), aggregate: record('aggregate'),
      },
      scopes: {
        item: {
          find: ({ args, context }) => {
            const groups = [...(context?.implicitLines ? [LINES] : []), ...(context?.group ? [context.group] : [])];
            if (groups.length) args.AND = [...(Array.isArray(args.AND) ? args.AND : []), ...structuredClone(groups)];
          },
        },
      },
    });
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    await seedListOperators(fixture.execute, 'mongodb');
  }, 60000);

  afterAll(async () => {
    await dropDatabase();
    await mongoose.disconnect();
  });

  test('a find scope that writes a hand-built implicit group over an embedded list fails the read with INVALID_FILTER_PATH and no rows', async () => {
    // Without the group, the same read reaches the adapter and returns every item.
    let first = reads.length;
    const control = await read('');
    expect(control.errors).toBeUndefined();
    expect(control.data[fixture.items]).toHaveLength(8);
    expect(reads.slice(first)).toEqual(['find']);
    first = reads.length;
    const result = await read('', { implicitLines: true });
    expect(result.errors?.map((error) => ({ code: error.extensions?.code, status: error.extensions?.status, message: error.message }))).toEqual([{
      code: 'INVALID_FILTER_PATH', status: 400, message: 'An implicit quantified path must end at a collection, or at a reference without crossing a list',
    }]);
    expect(result.data?.[fixture.items] ?? null).toBeNull();
    expect(reads.slice(first)).toEqual([]);
  });

  test('guard: the implicit group the rewrite writes for parts.shop.items reads the items with a part at the shop of the item named one', async () => {
    expect(await keys('parts: { terms: [{ path: "shop.items.name", operator: EQ, value: "one" }] }')).toEqual(['I1', 'I3', 'I6']);
  });

  test('reads IIN through parts.shop.items as the implicit group the rewrite writes', async () => {
    expect(await keys('parts: { terms: [{ path: "shop.items.name", operator: IIN, value: ["ONE"] }] }')).toEqual(['I1', 'I3', 'I6']);
  });

  // Each review's item is the item itself, so the group holds for an item with a review whose author or tags match. On
  // 7f12322 MongoDB joined the reviews into the row stream, and EQ read I1 once per review.
  test('reads a hand-built implicit group over reviews.item.reviews once per item', async () => {
    const group = (condition) => ({ ANY: [{ __implicit: true, path: 'reviews.item.reviews', conditions: [condition] }] });
    expect(await scoped(group({ field: 'author', operator: 'EQ', value: 'Ana' })), 'EQ').toEqual({ keys: ['I1'], count: 1 });
    expect(await scoped(group({ field: 'author', operator: 'IIN', value: ['ana', 'BOB'] })), 'IIN').toEqual({ keys: ['I1', 'I2'], count: 2 });
    expect(await scoped(group({ field: 'tags', operator: 'CONTAINS_ALL', value: ['x'] })), 'CONTAINS_ALL').toEqual({ keys: ['I1', 'I2', 'I6'], count: 3 });
  });
});

// A collection that a hand-built implicit group crosses before its end, on a seed of its own: S1 has C1, with reviews by
// Ana and by Bob, and C2, with none; S2 has C3 and C4, each with one review by Ana; S3 has C5, with none; S4 has no item.
// Ana's reviews are tagged x and y, Bob's y only. A Shop find scope appends the group that the request context names
// (spec 9.5, maintainer answer 5). On 7f12322 MongoDB joined the items into the row stream: ANY read S2 once per
// passing item, and ALL and NONE passed S1 through C2, its item without reviews.
describe.skipIf(!replicaSetUri)('a collection crossed before the end on the replica set', () => {
  const CONDITIONS = [
    { field: 'author', operator: 'EQ', value: 'Ana' }, { field: 'author', operator: 'IIN', value: ['ana'] },
    { field: 'tags', operator: 'CONTAINS_ALL', value: ['x', 'y'] },
  ];
  // PostgreSQL's rows, and those of the explicit nested groups on both backends.
  const EXPECTED = {
    ANY: { keys: ['S1', 'S2'], count: 2 }, ALL: { keys: ['S2', 'S3', 'S4'], count: 3 }, NONE: { keys: ['S3', 'S4'], count: 2 },
  };
  const implicitGroup = (quantifier, condition) => ({ [quantifier]: [{ __implicit: true, path: 'items.reviews', conditions: [condition] }] });
  // ANY items then ANY reviews, ALL then ALL, and NONE then ANY.
  const explicitGroups = (quantifier, condition) => ({
    [quantifier]: [{ path: 'items', [quantifier === 'NONE' ? 'ANY' : quantifier]: [{ path: 'reviews', conditions: [condition] }] }],
  });
  let fixture;

  // The keys in order and pagination.count of the shop list query whose find scope appends `group`.
  const scoped = async (group) => {
    const context = { group };
    const shops = fixture.types.roots.shop.plural;
    const result = await fixture.execute(`{ ${shops}(sort: {terms: [{field: "key", order: ASC}]}, pagination: {page: 1, size: 100, count: true}) { key } }`, {}, context);
    expect(result.errors).toBeUndefined();
    return { keys: result.data[shops].map(({ key }) => key), count: context.count };
  };

  beforeAll(async () => {
    await mongoose.connect(replicaSetUri, { dbName: `${new URL(replicaSetUri).pathname.slice(1)}_qlmx` });
    await mongoose.connection.dropDatabase();
    fixture = createFixture('QlmX', {
      scopes: {
        shop: {
          find: ({ args, context }) => {
            if (context?.group) args.AND = [...(Array.isArray(args.AND) ? args.AND : []), structuredClone(context.group)];
          },
        },
      },
    });
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    // Generated mutations only, references by id.
    const ids = {};
    const add = async (typeKey, input) => {
      const { type, single } = fixture.types.roots[typeKey];
      const result = await fixture.execute(`mutation($input: ${type.name}Input!) { add${single}(input: $input) { id } }`, { input });
      if (result.errors) throw new Error(`add${single} ${JSON.stringify(input)}: ${JSON.stringify(result.errors)}`);
      ids[input.key] = result.data[`add${single}`].id;
    };
    for (const key of ['S1', 'S2', 'S3', 'S4']) await add('shop', { key });
    for (const [key, shop] of [['C1', 'S1'], ['C2', 'S1'], ['C3', 'S2'], ['C4', 'S2'], ['C5', 'S3']]) await add('item', { key, shop: { id: ids[shop] } });
    for (const [key, item, author, tags] of [['W1', 'C1', 'Ana', ['x', 'y']], ['W2', 'C1', 'Bob', ['y']], ['W3', 'C3', 'Ana', ['x', 'y']], ['W4', 'C4', 'Ana', ['x', 'y']]]) {
      await add('review', {
        key, author, tags, item: { id: ids[item] },
      });
    }
  }, 60000);

  afterAll(async () => {
    await dropDatabase();
    await mongoose.disconnect();
  });

  test('reads a hand-built implicit group over items.reviews once per shop, as the explicit nested groups do', async () => {
    for (const condition of CONDITIONS) {
      for (const quantifier of ['ANY', 'ALL', 'NONE']) {
        const label = `${quantifier} ${condition.field} ${condition.operator}`;
        expect(await scoped(implicitGroup(quantifier, condition)), `implicit ${label}`).toEqual(EXPECTED[quantifier]);
        expect(await scoped(explicitGroups(quantifier, condition)), `explicit ${label}`).toEqual(EXPECTED[quantifier]);
      }
    }
  });

  test('guard: the explicit nested groups over items and reviews read the crossed-collection rows', async () => {
    for (const quantifier of ['ANY', 'ALL', 'NONE']) {
      expect(await scoped(explicitGroups(quantifier, CONDITIONS[0])), quantifier).toEqual(EXPECTED[quantifier]);
    }
  });
});
