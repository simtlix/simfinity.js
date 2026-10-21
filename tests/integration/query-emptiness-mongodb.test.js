import {
  afterAll, beforeAll, describe, expect, test,
} from 'vitest';
import mongoose from 'mongoose';
import {
  GraphQLEnumType, GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLScalarType, GraphQLString, graphql,
} from 'graphql';
import * as simfinity from '../../packages/mongodb/src/index.js';
import { createMongoAdapter, createRuntime, createValidatedScalar } from '../../packages/mongodb/src/index.js';
import { MONGO_QUERY_OPERATORS, createMongoQueries } from '../../packages/mongodb/src/mongo/queries.js';
import { createQueryPlan, describeModels } from '../../packages/core/src/index.js';
import {
  createEmptinessTypes, emptinessArgs, emptinessQuery, expectedEmptinessKeys, readMongoEmptinessDocuments,
  registerEmptinessTypes, seedEmptiness, writeMongoEmptinessDocuments,
} from '../helpers/query-emptiness.js';

// #108 part 2a on MongoDB: IS_EMPTY and IS_NOT_EMPTY on the queried record's own fields compile to plain query
// operators inside the existing $match: `$in: [null, ""]` and `$nin` on String fields, `null` and `$ne: null` on other
// scalars, enums and the record identity `_id`, the same `null` without arrays on application scalars, `"p.0":
// { $exists }` on lists, and the member rule under `$or` and `$nor` on embedded objects. The compile tests need no
// database; the row, plan and batching tests run on the disposable replica set and standalone server.

const replicaSetUri = process.env.SIMFINITY_MONGODB_URI;
const standaloneUri = process.env.SIMFINITY_STANDALONE_MONGODB_URI;

const OPERATORS = ['IS_EMPTY', 'IS_NOT_EMPTY'];
const PAGE = [{ $skip: 0 }, { $limit: 100 }];
const { EJSON } = mongoose.mongo.BSON;

const createFixture = (prefix, { adapter = createMongoAdapter(), backend = 'mongodb', preventCreatingCollection = false } = {}) => {
  const types = createEmptinessTypes(prefix, { backend });
  const runtime = createRuntime(adapter);
  if (preventCreatingCollection) runtime.preventCreatingCollection(true);
  registerEmptinessTypes(runtime, types);
  const schema = runtime.createSchema();
  const queries = createMongoQueries({
    getModel: (type) => runtime.getModel(type),
    getRegistrations: () => runtime.getRegistrations(),
  });
  const execute = (source, variableValues, contextValue = {}) => graphql({ schema, source, variableValues, contextValue });
  const run = async (source, variableValues, contextValue = {}) => {
    const result = await execute(source, variableValues, contextValue);
    expect(result.errors, source).toBeUndefined();
    return result.data;
  };
  return {
    adapter, runtime, schema, types, queries, execute, run, model: (name) => runtime.getModel(types[name]),
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
const errorOf = async (body) => {
  try {
    await body();
  } catch (error) {
    return error;
  }
  return null;
};

// The IS_EMPTY form of every path each root accepts, and its IS_NOT_EMPTY complement: the String rule, the null rule
// (also for the record identity, stored as `_id`), the null rule without arrays for the application scalar `meta`, the
// list rule on `p.0`, and the member rule for embedded objects, whose IS_NOT_EMPTY form is the `$nor` of the IS_EMPTY
// one.
const EMPTY_STRING = { $in: [null, ''] };
const NOT_EMPTY_STRING = { $nin: [null, ''] };
const string = (key) => [{ [key]: EMPTY_STRING }, { [key]: NOT_EMPTY_STRING }];
const nullRule = (key) => [{ [key]: null }, { [key]: { $ne: null } }];
// An application scalar keeps what is written, arrays included, and `{ p: null }` also matches an array with a null
// item: its null rule leaves arrays out, so `[null]` is a value, as GraphQL reads it.
const APP_EMPTY = (key) => ({ $and: [{ [key]: null }, { [key]: { $not: { $type: 'array' } } }] });
const appScalar = (key) => [APP_EMPTY(key), { $nor: [APP_EMPTY(key)] }];
const list = (key) => [{ [`${key}.0`]: { $exists: false } }, { [`${key}.0`]: { $exists: true } }];
const object = (form) => [form, { $nor: [form] }];
const DIMS = { $or: [{ dims: null }, { $and: [{ 'dims.w': null }, { 'dims.label': EMPTY_STRING }, { 'dims.tags.0': { $exists: false } }] }] };
const PLAIN = { $or: [{ plain: null }, { $and: [{ 'plain.a': null }, { 'plain.b': EMPTY_STRING }] }] };
// Generated embedded objects have no `_id`, so an embedded `id` member is stored as `<path>.id`.
const IDENT = { $or: [{ ident: null }, { $and: [{ 'ident.id': null }, { 'ident.label': EMPTY_STRING }] }] };
const SIDENT = { $or: [{ sident: null }, { $and: [{ 'sident.id': EMPTY_STRING }, { 'sident.label': EMPTY_STRING }] }] };
const INNER = { $or: [{ 'outer.inner': null }, { $and: [{ 'outer.inner.y': null }, { 'outer.inner.z': EMPTY_STRING }] }] };
const OUTER = { $or: [{ outer: null }, { $and: [{ 'outer.x': EMPTY_STRING }, INNER] }] };
// No stored member: the empty query, which matches every document, stands for the member conjunction, since MongoDB
// rejects an empty $and.
const GHOST = { $or: [{ ghost: null }, {}] };
const ITEM_FORMS = {
  id: nullRule('_id'), note: string('note'), code: string('code'), count: nullRule('count'), kind: nullRule('kind'),
  state: nullRule('state'), ref: nullRule('ref'), at: nullRule('at'), meta: appScalar('meta'), tags: list('tags'),
  dims: object(DIMS), 'dims.w': nullRule('dims.w'), 'dims.label': string('dims.label'), 'dims.tags': list('dims.tags'),
  plain: object(PLAIN), 'plain.a': nullRule('plain.a'), 'plain.b': string('plain.b'),
  ident: object(IDENT), 'ident.id': nullRule('ident.id'), 'ident.label': string('ident.label'),
  sident: object(SIDENT), 'sident.id': string('sident.id'), 'sident.label': string('sident.label'),
  outer: object(OUTER), 'outer.x': string('outer.x'), 'outer.inner': object(INNER), 'outer.inner.y': nullRule('outer.inner.y'),
  'outer.inner.z': string('outer.inner.z'), lines: list('lines'), ghost: object(GHOST), 'odim.w': nullRule('odim.w'),
  'odim.tags': list('odim.tags'), olines: list('olines'),
};
// The record identity takes the null rule, also when it is declared String.
const SID_FORMS = { id: nullRule('_id'), name: string('name') };
const UJSON = { $or: [{ 'udim.dims': null }, { $and: [{ 'udim.dims.a': null }, { 'udim.dims.tags.0': { $exists: false } }] }] };
const UDIM = {
  $or: [{ udim: null }, { $and: [{ 'udim.w': null }, { 'udim.label': EMPTY_STRING }, { 'udim.tags.0': { $exists: false } }, UJSON] }],
};
const META = { $or: [{ 'nest.meta': null }, { $and: [{ 'nest.meta.code': EMPTY_STRING }] }] };
const NEST = { $or: [{ nest: null }, { $and: [{ 'nest.w': null }, META, { 'nest.mlines.0': { $exists: false } }] }] };
const OWNED_FORMS = {
  id: nullRule('_id'), udim: object(UDIM), 'udim.w': nullRule('udim.w'), 'udim.label': string('udim.label'),
  'udim.tags': list('udim.tags'), 'udim.dims': object(UJSON), 'udim.dims.a': nullRule('udim.dims.a'),
  'udim.dims.tags': list('udim.dims.tags'), ulist: list('ulist'), nest: object(NEST), 'nest.w': nullRule('nest.w'),
  'nest.meta': object(META), 'nest.meta.code': string('nest.meta.code'), 'nest.mlines': list('nest.mlines'),
};
const formsOf = (rootKey) => (rootKey === 'item' ? ITEM_FORMS : rootKey === 'sid' ? SID_FORMS : OWNED_FORMS);

// The filters of the operators that existed before emptiness, with their pipelines as 3.9.0 (d57c3e0) builds them for
// this fixture, in extended JSON: they must stay byte-identical.
const HEX = '64b7f0c2a1b2c3d4e5f60718';
const OTHER_HEX = '0123456789abcdef01234567';
const EXISTING_FILTERS = [
  ['EQ on a String', { note: { value: 'n' } }],
  ['NE null', { note: { operator: 'NE', value: null } }],
  ['ranges and lists', {
    count: { operator: 'BTW', value: [1, 3] },
    AND: [{ conditions: [{ field: 'count', operator: 'IN', value: [1, 2] }, { field: 'count', operator: 'NIN', value: [] }, { field: 'count', operator: 'LT', value: 9 }] }],
  }],
  ['an enum, a state and identifiers', { kind: { value: 'ONE' }, state: { value: 'OPEN' }, ref: { value: HEX }, id: { operator: 'NE', value: OTHER_HEX } }],
  ['a DateTime', { at: { operator: 'GTE', value: '2026-01-01T00:00:00.000Z' } }],
  ['text operators on a String list and a validated String', {
    tags: { operator: 'LIKE', value: 'a.b' }, code: { operator: 'ISTARTS_WITH', value: 'c-' }, note: { operator: 'IEQ', value: 'X' },
  }],
  ['embedded terms, an embedded id and an embedded list leaf', {
    dims: { terms: [{ path: 'w', operator: 'GT', value: 1 }, { path: 'label', value: 'L' }, { path: 'tags', operator: 'IN', value: ['t'] }] },
    ident: { terms: [{ path: 'id', value: HEX }] },
    lines: { terms: [{ path: 'qty', operator: 'LTE', value: 3 }] },
  }],
  ['a reference, a collection and a reference inside an embedded object', {
    shop: { terms: [{ path: 'name', value: 'S' }] },
    reviews: { terms: [{ path: 'text', operator: 'ILIKE', value: 'r' }] },
    odim: { terms: [{ path: 'shop.name', operator: 'ENDS_WITH', value: 'p' }] },
  }],
  ['AND and OR groups', {
    AND: [{
      conditions: [{ field: 'outer.inner.z', value: 'Z' }, { field: 'dims', path: 'tags', operator: 'NE', value: 't' }],
      OR: [{ conditions: [{ field: 'count', operator: 'LTE', value: 2 }] }, { conditions: [{ field: 'meta', value: 'x' }] }],
    }],
    OR: [{ conditions: [{ field: 'shop.name', value: 'S' }] }, { conditions: [{ field: 'note', value: null }] }],
  }],
  ['sort and pagination', {
    note: { value: 'n' }, sort: { terms: [{ field: 'shop.name', order: 'ASC' }, { field: 'count', order: 'DESC' }] }, pagination: { page: 2, size: 5 },
  }],
];
const EXISTING_AGGREGATION = { groupId: 'kind', facts: [{ operation: 'SUM', factName: 's', path: 'count' }, { operation: 'COUNT', factName: 'n', path: 'id' }] };
const EXISTING_PIPELINES = JSON.parse(String.raw`{
 "EQ on a String": "[{\"$match\":{\"note\":\"n\"}},{\"$skip\":0},{\"$limit\":100}]",
 "NE null": "[{\"$match\":{\"note\":{\"$ne\":null}}},{\"$skip\":0},{\"$limit\":100}]",
 "ranges and lists": "[{\"$match\":{\"$and\":[{\"count\":{\"$gte\":1,\"$lte\":3}},{\"$and\":[{\"count\":{\"$in\":[1,2]}},{\"count\":{\"$nin\":[]}},{\"count\":{\"$lt\":9}}]}]}},{\"$skip\":0},{\"$limit\":100}]",
 "ranges and lists (count)": "[{\"$match\":{\"$and\":[{\"count\":{\"$gte\":1,\"$lte\":3}},{\"$and\":[{\"count\":{\"$in\":[1,2]}},{\"count\":{\"$nin\":[]}},{\"count\":{\"$lt\":9}}]}]}},{\"$count\":\"size\"}]",
 "ranges and lists (aggregate)": "[{\"$match\":{\"$and\":[{\"count\":{\"$gte\":1,\"$lte\":3}},{\"$and\":[{\"count\":{\"$in\":[1,2]}},{\"count\":{\"$nin\":[]}},{\"count\":{\"$lt\":9}}]}]}},{\"$group\":{\"_id\":\"$kind\",\"fact_0\":{\"$sum\":\"$count\"},\"fact_1\":{\"$sum\":1}}},{\"$project\":{\"_id\":0,\"groupId\":\"$_id\",\"facts\":{\"s\":\"$fact_0\",\"n\":\"$fact_1\"}}},{\"$sort\":{\"groupId\":1}}]",
 "ranges and lists (group)": "{\"$and\":[{\"count\":{\"$in\":[1,2]}},{\"count\":{\"$nin\":[]}},{\"count\":{\"$lt\":9}}]}",
 "an enum, a state and identifiers": "[{\"$match\":{\"kind\":\"one\",\"state\":\"OPEN\",\"ref\":{\"$oid\":\"64b7f0c2a1b2c3d4e5f60718\"},\"_id\":{\"$ne\":{\"$oid\":\"0123456789abcdef01234567\"}}}},{\"$skip\":0},{\"$limit\":100}]",
 "a DateTime": "[{\"$match\":{\"at\":{\"$gte\":{\"$date\":\"2026-01-01T00:00:00Z\"}}}},{\"$skip\":0},{\"$limit\":100}]",
 "text operators on a String list and a validated String": "[{\"$match\":{\"tags\":{\"$regex\":\".*a\\\\.b.*\"},\"code\":{\"$regex\":\"^c-\",\"$options\":\"i\"},\"note\":{\"$regex\":\"^X\\\\z\",\"$options\":\"i\"}}},{\"$skip\":0},{\"$limit\":100}]",
 "embedded terms, an embedded id and an embedded list leaf": "[{\"$match\":{\"dims.w\":{\"$gt\":1},\"dims.label\":\"L\",\"dims.tags\":{\"$in\":[\"t\"]},\"ident.id\":{\"$oid\":\"64b7f0c2a1b2c3d4e5f60718\"},\"lines.qty\":{\"$lte\":3}}},{\"$skip\":0},{\"$limit\":100}]",
 "a reference, a collection and a reference inside an embedded object": "[{\"$lookup\":{\"from\":\"QemPinShop\",\"foreignField\":\"_id\",\"localField\":\"shop\",\"as\":\"__sf_l0\"}},{\"$unwind\":{\"path\":\"$__sf_l0\",\"preserveNullAndEmptyArrays\":true}},{\"$lookup\":{\"from\":\"QemPinReview\",\"foreignField\":\"item\",\"localField\":\"_id\",\"as\":\"__sf_l1\"}},{\"$unwind\":{\"path\":\"$__sf_l1\",\"preserveNullAndEmptyArrays\":true}},{\"$lookup\":{\"from\":\"QemPinShop\",\"foreignField\":\"_id\",\"localField\":\"odim.shop\",\"as\":\"__sf_l2\"}},{\"$unwind\":{\"path\":\"$__sf_l2\",\"preserveNullAndEmptyArrays\":true}},{\"$match\":{\"__sf_l0.name\":\"S\",\"__sf_l1.text\":{\"$regex\":\"r\",\"$options\":\"i\"},\"__sf_l2.name\":{\"$regex\":\"p\\\\z\"}}},{\"$skip\":0},{\"$limit\":100},{\"$unset\":[\"__sf_l0\",\"__sf_l1\",\"__sf_l2\"]}]",
 "a reference, a collection and a reference inside an embedded object (count)": "[{\"$lookup\":{\"from\":\"QemPinShop\",\"foreignField\":\"_id\",\"localField\":\"shop\",\"as\":\"__sf_l0\"}},{\"$unwind\":{\"path\":\"$__sf_l0\",\"preserveNullAndEmptyArrays\":true}},{\"$lookup\":{\"from\":\"QemPinReview\",\"foreignField\":\"item\",\"localField\":\"_id\",\"as\":\"__sf_l1\"}},{\"$unwind\":{\"path\":\"$__sf_l1\",\"preserveNullAndEmptyArrays\":true}},{\"$lookup\":{\"from\":\"QemPinShop\",\"foreignField\":\"_id\",\"localField\":\"odim.shop\",\"as\":\"__sf_l2\"}},{\"$unwind\":{\"path\":\"$__sf_l2\",\"preserveNullAndEmptyArrays\":true}},{\"$match\":{\"__sf_l0.name\":\"S\",\"__sf_l1.text\":{\"$regex\":\"r\",\"$options\":\"i\"},\"__sf_l2.name\":{\"$regex\":\"p\\\\z\"}}},{\"$count\":\"size\"}]",
 "a reference, a collection and a reference inside an embedded object (aggregate)": "[{\"$lookup\":{\"from\":\"QemPinShop\",\"foreignField\":\"_id\",\"localField\":\"shop\",\"as\":\"__sf_l0\"}},{\"$unwind\":{\"path\":\"$__sf_l0\",\"preserveNullAndEmptyArrays\":true}},{\"$lookup\":{\"from\":\"QemPinReview\",\"foreignField\":\"item\",\"localField\":\"_id\",\"as\":\"__sf_l1\"}},{\"$unwind\":{\"path\":\"$__sf_l1\",\"preserveNullAndEmptyArrays\":true}},{\"$lookup\":{\"from\":\"QemPinShop\",\"foreignField\":\"_id\",\"localField\":\"odim.shop\",\"as\":\"__sf_l2\"}},{\"$unwind\":{\"path\":\"$__sf_l2\",\"preserveNullAndEmptyArrays\":true}},{\"$match\":{\"__sf_l0.name\":\"S\",\"__sf_l1.text\":{\"$regex\":\"r\",\"$options\":\"i\"},\"__sf_l2.name\":{\"$regex\":\"p\\\\z\"}}},{\"$group\":{\"_id\":\"$kind\",\"fact_0\":{\"$sum\":\"$count\"},\"fact_1\":{\"$sum\":1}}},{\"$project\":{\"_id\":0,\"groupId\":\"$_id\",\"facts\":{\"s\":\"$fact_0\",\"n\":\"$fact_1\"}}},{\"$sort\":{\"groupId\":1}}]",
 "AND and OR groups": "[{\"$lookup\":{\"from\":\"QemPinShop\",\"foreignField\":\"_id\",\"localField\":\"shop\",\"as\":\"__sf_l0\"}},{\"$unwind\":{\"path\":\"$__sf_l0\",\"preserveNullAndEmptyArrays\":true}},{\"$match\":{\"$and\":[{\"$and\":[{\"outer.inner.z\":\"Z\"},{\"dims.tags\":{\"$ne\":\"t\"}},{\"$or\":[{\"count\":{\"$lte\":2}},{\"meta\":\"x\"}]}]},{\"$or\":[{\"__sf_l0.name\":\"S\"},{\"note\":null}]}]}},{\"$skip\":0},{\"$limit\":100},{\"$unset\":[\"__sf_l0\"]}]",
 "AND and OR groups (count)": "[{\"$lookup\":{\"from\":\"QemPinShop\",\"foreignField\":\"_id\",\"localField\":\"shop\",\"as\":\"__sf_l0\"}},{\"$unwind\":{\"path\":\"$__sf_l0\",\"preserveNullAndEmptyArrays\":true}},{\"$match\":{\"$and\":[{\"$and\":[{\"outer.inner.z\":\"Z\"},{\"dims.tags\":{\"$ne\":\"t\"}},{\"$or\":[{\"count\":{\"$lte\":2}},{\"meta\":\"x\"}]}]},{\"$or\":[{\"__sf_l0.name\":\"S\"},{\"note\":null}]}]}},{\"$count\":\"size\"}]",
 "AND and OR groups (aggregate)": "[{\"$lookup\":{\"from\":\"QemPinShop\",\"foreignField\":\"_id\",\"localField\":\"shop\",\"as\":\"__sf_l0\"}},{\"$unwind\":{\"path\":\"$__sf_l0\",\"preserveNullAndEmptyArrays\":true}},{\"$match\":{\"$and\":[{\"$and\":[{\"outer.inner.z\":\"Z\"},{\"dims.tags\":{\"$ne\":\"t\"}},{\"$or\":[{\"count\":{\"$lte\":2}},{\"meta\":\"x\"}]}]},{\"$or\":[{\"__sf_l0.name\":\"S\"},{\"note\":null}]}]}},{\"$group\":{\"_id\":\"$kind\",\"fact_0\":{\"$sum\":\"$count\"},\"fact_1\":{\"$sum\":1}}},{\"$project\":{\"_id\":0,\"groupId\":\"$_id\",\"facts\":{\"s\":\"$fact_0\",\"n\":\"$fact_1\"}}},{\"$sort\":{\"groupId\":1}}]",
 "AND and OR groups (group)": "{\"$and\":[{\"outer.inner.z\":\"Z\"},{\"dims.tags\":{\"$ne\":\"t\"}},{\"$or\":[{\"count\":{\"$lte\":2}},{\"meta\":\"x\"}]}]}",
 "sort and pagination": "[{\"$match\":{\"note\":\"n\"}},{\"$lookup\":{\"from\":\"QemPinShop\",\"foreignField\":\"_id\",\"localField\":\"shop\",\"as\":\"__sf_l0\"}},{\"$unwind\":{\"path\":\"$__sf_l0\",\"preserveNullAndEmptyArrays\":true}},{\"$sort\":{\"__sf_l0.name\":1,\"count\":-1}},{\"$skip\":5},{\"$limit\":5},{\"$unset\":[\"__sf_l0\"]}]"
}`);

describe('MongoDB emptiness compilation', () => {
  const fixture = createFixture('QemPlan', { preventCreatingCollection: true });
  const { types } = fixture;
  const build = (args, rootKey = 'item', isCount) => fixture.queries.buildQuery(args, types.roots[rootKey].type, isCount);
  const matchOf = async (args, rootKey) => (await build(args, rootKey))[0].$match;

  test('every form of each root has its pinned pipeline, in a field filter, a term and a group condition', async () => {
    for (const [rootKey, root] of Object.entries(types.roots)) {
      const forms = formsOf(rootKey);
      expect(Object.keys(forms).sort(), rootKey).toEqual([...root.paths].sort());
      for (const path of root.paths) {
        for (const [index, operator] of OPERATORS.entries()) {
          const expected = [{ $match: forms[path][index] }, ...PAGE];
          const label = `${rootKey} ${path} ${operator}`;
          expect(await build(emptinessArgs(types, rootKey, path, operator), rootKey), label).toStrictEqual(expected);
          expect(await build(emptinessArgs(types, rootKey, path, operator, 'condition'), rootKey), label).toStrictEqual(expected);
          // A dotted field in a group condition.
          expect(await build({ OR: [{ conditions: [{ field: path, operator }] }] }, rootKey), label).toStrictEqual(expected);
        }
      }
    }
  });

  test('a term or condition whose path is omitted, null or "" tests the field itself, next to sibling terms with paths', async () => {
    for (const path of [undefined, null, '']) {
      expect(await matchOf({ dims: { terms: [{ path, operator: 'IS_EMPTY' }] } })).toStrictEqual(DIMS);
      expect(await matchOf({ AND: [{ conditions: [{ field: 'lines', path, operator: 'IS_NOT_EMPTY', value: null }] }] }))
        .toStrictEqual({ 'lines.0': { $exists: true } });
      expect(await matchOf({ AND: [{ conditions: [{ field: 'note', path, operator: 'IS_EMPTY' }] }] })).toStrictEqual({ note: EMPTY_STRING });
      // A dotted field with an empty path is the dotted path itself.
      expect(await matchOf({ AND: [{ conditions: [{ field: 'outer.inner', path, operator: 'IS_EMPTY' }] }] })).toStrictEqual(INNER);
    }
    expect(await matchOf({
      dims: { terms: [{ operator: 'IS_EMPTY' }, { path: 'w', operator: 'EQ', value: 1 }, { path: '', operator: 'IS_NOT_EMPTY' }, { path: null, operator: 'IS_EMPTY', value: null }] },
    })).toStrictEqual({ $and: [{ $or: DIMS.$or, 'dims.w': 1, $nor: [DIMS] }, { $or: DIMS.$or }] });
    // A scalar field filter ignores a terms array beside its own operator, as it does for other operators.
    expect(await matchOf({ note: { operator: 'IS_NOT_EMPTY', terms: [{ path: 'x', operator: 'EQ', value: 1 }] } })).toStrictEqual({ note: NOT_EMPTY_STRING });
  });

  // Other operators keep what 3.9.0 does with an object filter: an operator beside its terms is left out, and a term
  // whose path is omitted, null or "" fails the path check, with its code and message.
  test('other operators keep their object filter handling (regression pin, passes on 3.9.0)', async () => {
    const besideTerms = [
      { operator: 'EQ', terms: [{ path: 'w', value: 1 }] }, { operator: 'EQ', value: 5, terms: [{ path: 'w', value: 1 }] },
      { operator: 'NE', value: null, terms: [{ path: 'w', value: 1 }] },
    ];
    for (const filter of besideTerms) {
      expect(await build({ dims: filter }), JSON.stringify(filter)).toStrictEqual([{ $match: { 'dims.w': 1 } }, ...PAGE]);
    }
    for (const path of [undefined, null, '']) {
      for (const term of [{ path, operator: 'EQ', value: 1 }, { path, value: 1 }, { path, operator: 'LIKE', value: 'x' }]) {
        const error = await errorOf(() => build({ dims: { terms: [term] } }));
        expect([error?.extensions?.code, error?.message], `${path} ${JSON.stringify(term)}`)
          .toEqual(['INVALID_FILTER_PATH', 'Filter path must be a non-empty string']);
      }
    }
  });

  test('several object conditions in one query keep every $or and $nor clause', async () => {
    expect(await matchOf({
      dims: { terms: [{ operator: 'IS_EMPTY' }] }, plain: { terms: [{ operator: 'IS_EMPTY' }] },
      outer: { terms: [{ operator: 'IS_NOT_EMPTY' }] }, ident: { terms: [{ operator: 'IS_NOT_EMPTY' }] },
    })).toStrictEqual({ $and: [{ $or: DIMS.$or, $nor: [OUTER] }, { $or: PLAIN.$or }, { $nor: [IDENT] }] });
    expect(await matchOf({
      note: { operator: 'IS_EMPTY' },
      AND: [{ conditions: [{ field: 'dims', operator: 'IS_EMPTY' }, { field: 'plain', operator: 'IS_EMPTY' }, { field: 'outer', operator: 'IS_NOT_EMPTY' }] }],
      OR: [{ conditions: [{ field: 'ident', operator: 'IS_EMPTY' }] }, { conditions: [{ field: 'sident', operator: 'IS_NOT_EMPTY' }] }],
    })).toStrictEqual({ $and: [{ note: EMPTY_STRING }, { $and: [DIMS, PLAIN, { $nor: [OUTER] }] }, { $or: [IDENT, { $nor: [SIDENT] }] }] });
  });

  test('counts and aggregates filter with the same $match, before $count and $group', async () => {
    const args = { dims: { terms: [{ operator: 'IS_EMPTY' }] }, note: { operator: 'IS_NOT_EMPTY' } };
    const match = { $match: { $or: DIMS.$or, note: NOT_EMPTY_STRING } };
    expect(await build(args, 'item', true)).toStrictEqual([match, { $count: 'size' }]);
    expect(await fixture.queries.buildAggregationQuery(args, types.Item, EXISTING_AGGREGATION)).toStrictEqual([
      match,
      { $group: { _id: '$kind', fact_0: { $sum: '$count' }, fact_1: { $sum: 1 } } },
      { $project: { _id: 0, groupId: '$_id', facts: { s: '$fact_0', n: '$fact_1' } } },
      { $sort: { groupId: 1 } },
    ]);
  });

  test('the public buildFilterGroupMatch compiles emptiness conditions and adds no lookup', async () => {
    const clauses = [];
    const included = {};
    expect(await fixture.adapter.buildFilterGroupMatch({
      conditions: [{ field: 'ghost', operator: 'IS_EMPTY' }, { field: 'ident', path: 'id', operator: 'IS_NOT_EMPTY' }],
    }, types.Item, clauses, included)).toStrictEqual({ $and: [GHOST, { 'ident.id': { $ne: null } }] });
    expect(clauses).toEqual([]);
    expect(included).toEqual({});
  });

  test('an application scalar without a supported base builds a schema, keeps its EQ pipeline and compiles to the null rule without arrays', async () => {
    expect(fixture.schema.getType('QemPlanJson')).toBeDefined();
    expect(await matchOf({ meta: { value: 'x' } })).toStrictEqual({ meta: 'x' });
    expect(await matchOf({ meta: { operator: 'IS_EMPTY' } })).toStrictEqual(APP_EMPTY('meta'));
    expect(await matchOf({ meta: { operator: 'IS_NOT_EMPTY', value: null } })).toStrictEqual({ $nor: [APP_EMPTY('meta')] });
  });

  test('an application-scalar member and leaf leave arrays out too; built-in bases, enums and the record identity do not', async () => {
    const { Json, Holder } = holderTypes('QemPlanHold');
    const Kind = new GraphQLEnumType({ name: 'QemPlanHoldKind', values: { ONE: { value: 'one' } } });
    const Count = createValidatedScalar('QemPlanHoldCount', 'A validated Int', GraphQLInt, () => {});
    const Stamp = new GraphQLScalarType({ name: 'Date' });
    // The record identity declared as the application scalar is still `_id`, which MongoDB never stores as an array.
    const Entity = new GraphQLObjectType({
      name: 'QemPlanHoldEntity',
      fields: { id: { type: Json }, kind: { type: Kind }, count: { type: Count }, stamp: { type: Stamp } },
    });
    const queries = createMongoQueries({ getModel: () => null, getRegistrations: () => [] });
    const match = async (args, type = Holder) => (await queries.buildQuery(args, type))[0].$match;
    const BAG = { $or: [{ bag: null }, { $and: [{ 'bag.label': EMPTY_STRING }, APP_EMPTY('bag.meta')] }] };
    expect(await match({ bag: { terms: [{ operator: 'IS_EMPTY' }] } })).toStrictEqual(BAG);
    expect(await match({ AND: [{ conditions: [{ field: 'bag', operator: 'IS_NOT_EMPTY' }] }] })).toStrictEqual({ $nor: [BAG] });
    expect(await match({ bag: { terms: [{ path: 'meta', operator: 'IS_EMPTY' }] } })).toStrictEqual(APP_EMPTY('bag.meta'));
    expect(await match({ AND: [{ conditions: [{ field: 'bag.meta', operator: 'IS_NOT_EMPTY' }] }] })).toStrictEqual({ $nor: [APP_EMPTY('bag.meta')] });
    for (const [field, key] of [['id', '_id'], ['kind', 'kind'], ['count', 'count'], ['stamp', 'stamp']]) {
      const [empty, notEmpty] = nullRule(key);
      expect(await match({ [field]: { operator: 'IS_EMPTY' } }, Entity), field).toStrictEqual(empty);
      expect(await match({ [field]: { operator: 'IS_NOT_EMPTY' } }, Entity), field).toStrictEqual(notEmpty);
    }
  });

  test('existing operators keep their pipelines byte for byte (regression pin, passes on 3.9.0)', async () => {
    const pin = createFixture('QemPin', { preventCreatingCollection: true });
    const built = {};
    for (const [label, input] of EXISTING_FILTERS) {
      built[label] = EJSON.stringify(await pin.queries.buildQuery(input, pin.types.Item));
      built[`${label} (count)`] = EJSON.stringify(await pin.queries.buildQuery(input, pin.types.Item, true));
      built[`${label} (aggregate)`] = EJSON.stringify(await pin.queries.buildAggregationQuery(
        { ...input, sort: undefined, pagination: undefined }, pin.types.Item, EXISTING_AGGREGATION,
      ));
      if (input.AND) built[`${label} (group)`] = EJSON.stringify(await pin.queries.buildFilterGroupMatch(input.AND[0], pin.types.Item, [], {}));
    }
    for (const [label, pipeline] of Object.entries(EXISTING_PIPELINES)) expect(built[label], label).toBe(pipeline);
  });
});

// The same inputs through the public buildQuery and buildFilterGroupMatch and through createQueryPlan, on the same
// types: both give the codes of the order of checks (minus rule 0, which only the runtime applies), and the same
// messages wherever the shared description gives them.
describe('MongoDB emptiness codes, compared with createQueryPlan', () => {
  const types = createEmptinessTypes('QemCodes', { backend: 'postgres' });
  simfinity.preventCreatingCollection(true);
  registerEmptinessTypes(simfinity, types);
  simfinity.createSchema();
  const models = describeModels([types.Item, types.Shop, types.Review, types.Sid, ...Object.values(types.owned)]
    .map((gqltype) => ({ gqltype })).concat(types.embedded.map((gqltype) => ({ gqltype, endpoint: false }))));
  const IS_EMPTY = { operator: 'IS_EMPTY' };
  const condition = (field, path, extra = {}) => ({ AND: [{ conditions: [{ field, ...(path === undefined ? {} : { path }), ...IS_EMPTY, ...extra }] }] });
  const nested = (item, depth) => {
    let group = { conditions: [item] };
    for (let level = 0; level < depth; level += 1) group = { AND: [group] };
    return { AND: [group] };
  };
  const besideTerms = (field) => [
    { operator: 'IS_EMPTY' }, { operator: 'IS_NOT_EMPTY', value: null }, { operator: 'IS_EMPTY', terms: [] },
    { operator: 'IS_EMPTY', terms: [{ path: field === 'shop' ? 'name' : 'w', operator: 'EQ', value: 1 }] },
    { operator: 'IS_NOT_EMPTY', terms: [{ operator: 'IS_EMPTY' }] }, { operator: 'IS_EMPTY', value: 1 },
  ].map((value) => [{ [field]: value }, 'MISSING_FILTER_PATH']);
  // Inputs whose message comes from the shared description on both compilers.
  const SHARED = [
    // Rule 3: a value inside a list, before any reference crossing.
    [{ lines: { terms: [{ path: 'qty', ...IS_EMPTY }] } }, 'INVALID_FILTER_PATH'], [condition('reviews', 'text'), 'INVALID_FILTER_PATH'],
    [condition('shop', 'items.note'), 'INVALID_FILTER_PATH'], [{ olines: { terms: [{ path: 'shop', ...IS_EMPTY, value: 'x' }] } }, 'INVALID_FILTER_PATH'],
    [condition('lines.qty', undefined, { value: 1 }), 'INVALID_FILTER_PATH'],
    // Rule 5: the value, before rule 6.
    [{ note: { ...IS_EMPTY, value: 'x' } }, 'INVALID_FILTER_VALUE'], [{ odim: { terms: [{ ...IS_EMPTY, value: 'x' }] } }, 'INVALID_FILTER_VALUE'],
    [condition('shop', undefined, { value: '' }), 'INVALID_FILTER_VALUE'], [{ dims: { terms: [{ ...IS_EMPTY, value: [] }] } }, 'INVALID_FILTER_VALUE'],
    [{ tags: { ...IS_EMPTY, value: [] } }, 'INVALID_FILTER_VALUE'], [{ plain: { terms: [{ path: 'a', ...IS_EMPTY, value: 0 }] } }, 'INVALID_FILTER_VALUE'],
    [{ dims: { terms: [{ ...IS_EMPTY, value: false }] } }, 'INVALID_FILTER_VALUE'], [{ outer: { terms: [{ ...IS_EMPTY, value: {} }] } }, 'INVALID_FILTER_VALUE'],
    [condition('id', undefined, { value: HEX }), 'INVALID_FILTER_VALUE'],
  ];
  // Rule 6 (#108 part 2b): references and collections, crossed, reached, or members, which MongoDB compiles and a plan
  // without reference emptiness rejects.
  const REFERENCES = [
    { shop: { terms: [IS_EMPTY] } }, condition('shop'), condition('shop', 'name'), { reviews: { terms: [IS_EMPTY] } },
    { odim: { terms: [IS_EMPTY] } }, { odim: { terms: [{ path: 'shop', ...IS_EMPTY }] } }, condition('shop', 'items'),
    condition('odim.shop.name'), nested({ field: 'shop', path: 'name', ...IS_EMPTY }, 5),
  ];
  const CODES = [
    // Rule 1: form, syntax, fields and depth.
    [condition('shop.name', 'x'), 'AMBIGUOUS_FILTER_FIELD'], [condition('outer.inner', 'z'), 'AMBIGUOUS_FILTER_FIELD'],
    [{ nope: IS_EMPTY }, 'INVALID_FILTER_FIELD'], [condition('nope'), 'INVALID_FILTER_FIELD'], [condition('dims', 'nope'), 'INVALID_FILTER_FIELD'],
    [{ shop: { terms: [{ path: 'nope', ...IS_EMPTY }] } }, 'INVALID_FILTER_FIELD'], [{ lines: { terms: [{ path: 'nope', ...IS_EMPTY }] } }, 'INVALID_FILTER_FIELD'],
    [condition('ghost', 'label'), 'INVALID_FILTER_FIELD'],
    [{ shop: { terms: [{ path: 'name.x', ...IS_EMPTY }] } }, 'INVALID_FILTER_PATH'], [condition('note', 'x'), 'INVALID_FILTER_PATH'],
    [condition('tags.x'), 'INVALID_FILTER_PATH'], [condition('dims', '.w'), 'INVALID_FILTER_PATH'], [condition('dims.'), 'INVALID_FILTER_PATH'],
    [{ dims: { terms: [{ path: 'w-x', ...IS_EMPTY }] } }, 'INVALID_FILTER_PATH'], [{ dims: { terms: [{ path: 5, ...IS_EMPTY }] } }, 'INVALID_FILTER_PATH'],
    [nested({ field: 'shop', path: 'name', ...IS_EMPTY }, 6), 'FILTER_DEPTH_EXCEEDED'], [nested({ field: 'lines', path: 'qty', ...IS_EMPTY }, 6), 'FILTER_DEPTH_EXCEEDED'],
    // The two forms that only trusted code writes, on embedded, reference and collection fields.
    ...['dims', 'lines', 'odim', 'shop', 'reviews'].flatMap(besideTerms),
    ...SHARED,
  ];
  const mongoOutcome = async (input) => codeOf(() => simfinity.buildQuery(input, types.Item));
  const planOutcome = async (input) => codeOf(() => createQueryPlan(models, types.Item.name, input));

  test('every rejected input gets the same code from buildQuery and createQueryPlan', async () => {
    for (const [input, code] of CODES) {
      expect(await mongoOutcome(input), JSON.stringify(input)).toBe(code);
      expect(await planOutcome(input), JSON.stringify(input)).toBe(code);
    }
  });

  test('rules 3 to 5 give the shared messages', async () => {
    for (const [input] of SHARED) {
      const mongo = await errorOf(() => simfinity.buildQuery(input, types.Item));
      const plan = await errorOf(() => createQueryPlan(models, types.Item.name, input));
      expect([mongo.extensions.code, mongo.message], JSON.stringify(input)).toEqual([plan.extensions.code, plan.message]);
    }
    expect((await errorOf(() => simfinity.buildQuery({ dims: { operator: 'IS_EMPTY' } }, types.Item))).message)
      .toBe('Filter on dims takes IS_EMPTY only in a term; to test the field itself, use a term without a path: dims: { terms: [{ operator: IS_EMPTY }] }');
    expect((await errorOf(() => simfinity.buildQuery({ reviews: { operator: 'IS_NOT_EMPTY', terms: [{ path: 'text', value: 'x' }] } }, types.Item))).message)
      .toBe('Filter on reviews takes IS_NOT_EMPTY only in a term; to test the field itself, use a term without a path: reviews: { terms: [{ operator: IS_NOT_EMPTY }] }');
  });

  test('references and collections are accepted by both, and rejected by a plan without reference emptiness', async () => {
    for (const input of REFERENCES) {
      expect(await mongoOutcome(input), JSON.stringify(input)).toBeNull();
      expect(await planOutcome(input), JSON.stringify(input)).toBeNull();
      if (input.AND?.[0]?.conditions) expect(await codeOf(() => simfinity.buildFilterGroupMatch(input.AND[0], types.Item, [], {})), JSON.stringify(input)).toBeNull();
      const plan = await errorOf(() => createQueryPlan(models, types.Item.name, input, { referenceEmptiness: false }));
      expect(plan?.extensions?.code, JSON.stringify(input)).toBe('UNSUPPORTED_QUERY');
      expect(plan.message, JSON.stringify(input)).toMatch(/: the database adapter does not support emptiness through references and collections$/);
    }
  });

  test('every accepted path is accepted by both, in every form', async () => {
    for (const [rootKey, root] of Object.entries(types.roots)) {
      for (const path of root.paths) {
        for (const operator of OPERATORS) {
          for (const form of ['field', 'condition']) {
            const input = emptinessArgs(types, rootKey, path, operator, form);
            expect(await codeOf(() => simfinity.buildQuery(input, root.type)), `${rootKey} ${path} ${operator} ${form}`).toBeNull();
            expect(await codeOf(() => createQueryPlan(models, root.type.name, input)), `${rootKey} ${path} ${operator} ${form}`).toBeNull();
          }
        }
      }
    }
  });

  test('the public buildFilterGroupMatch gives the codes of the order of checks', async () => {
    const group = (input) => codeOf(() => simfinity.buildFilterGroupMatch(input.AND[0], types.Item, [], {}));
    for (const [input, code] of CODES.filter(([item]) => item.AND && !JSON.stringify(item).includes('"AND":[{"AND"'))) {
      expect(await group(input), JSON.stringify(input)).toBe(code);
    }
    expect(await codeOf(() => simfinity.buildFilterGroupMatch({ conditions: [{ field: 'dims', operator: 'IS_EMPTY' }] }, types.Item, [], {}))).toBeNull();
  });

  // A virtual object field stores nothing, so rule 1 rejects it in every form, before the form checks that a stored
  // object field gets.
  test('a virtual object field gets INVALID_FILTER_FIELD from both, also with an operator on its filter', async () => {
    const Inner = new GraphQLObjectType({ name: 'QemCodesVirtualInner', fields: { a: { type: GraphQLInt }, b: { type: GraphQLString } } });
    const Entity = new GraphQLObjectType({
      name: 'QemCodesVirtual',
      fields: {
        id: { type: GraphQLID },
        dims: { type: Inner, extensions: { relation: { embedded: true } } },
        vobj: { type: Inner, resolve: () => null, extensions: { virtual: true } },
      },
    });
    const virtualModels = describeModels([{ gqltype: Entity }, { gqltype: Inner, endpoint: false }]);
    const queries = createMongoQueries({ getModel: () => null, getRegistrations: () => [] });
    const outcomes = async (input) => [
      await codeOf(() => queries.buildQuery(input, Entity)), await codeOf(() => createQueryPlan(virtualModels, Entity.name, input)),
    ];
    const forms = (field) => [
      { [field]: { operator: 'IS_EMPTY' } }, { [field]: { operator: 'IS_NOT_EMPTY', value: null } },
      { [field]: { operator: 'IS_EMPTY', terms: [{ path: 'a', value: 1 }] } },
      { [field]: { operator: 'IS_NOT_EMPTY', terms: [{ operator: 'IS_EMPTY' }] } },
    ];
    for (const input of [
      ...forms('vobj'), { vobj: { terms: [{ operator: 'IS_EMPTY' }] } }, { vobj: { terms: [{ path: 'a', operator: 'IS_NOT_EMPTY' }] } },
      condition('vobj'), condition('vobj', 'a'),
    ]) {
      expect(await outcomes(input), JSON.stringify(input)).toEqual(['INVALID_FILTER_FIELD', 'INVALID_FILTER_FIELD']);
    }
    for (const input of forms('dims')) expect(await outcomes(input), JSON.stringify(input)).toEqual(['MISSING_FILTER_PATH', 'MISSING_FILTER_PATH']);
    // The runtime gate's message, which the other forms give too.
    for (const input of [{ vobj: { operator: 'IS_EMPTY' } }, { vobj: { terms: [{ operator: 'IS_EMPTY' }] } }]) {
      expect((await errorOf(() => queries.buildQuery(input, Entity))).message, JSON.stringify(input))
        .toBe('Query path vobj uses the virtual field QemCodesVirtual.vobj, which is not stored');
    }
  });
});

// Documents written natively, which generated writes never store, with the paths of the item root that are not empty;
// every other path is empty.
const OBJECT_ID = new mongoose.Types.ObjectId(HEX);
const NATIVE = [
  ['native missing', {}, []],
  ['native null', {
    note: null, code: null, count: null, kind: null, state: null, ref: null, at: null, meta: null, tags: null, dims: null,
    plain: null, ident: null, sident: null, outer: null, lines: null, ghost: null, odim: null, olines: null,
  }, []],
  ['native empty strings', {
    note: '', code: '', dims: { label: '' }, plain: { b: '' }, ident: { label: '' }, sident: { id: '', label: '' }, outer: { x: '', inner: { z: '' } },
  }, []],
  ['native blank strings', { note: ' ', code: ' ', dims: { label: ' ' }, sident: { id: ' ' }, outer: { inner: { z: ' ' } } },
    ['note', 'code', 'dims', 'dims.label', 'sident', 'sident.id', 'outer', 'outer.inner', 'outer.inner.z']],
  ['native empty lists', { tags: [], dims: { tags: [] }, lines: [], olines: [], odim: { tags: [] } }, []],
  ['native null items', { tags: [null], dims: { tags: [null] }, lines: [null], olines: [null], odim: { tags: [null] } },
    ['tags', 'dims', 'dims.tags', 'lines', 'olines', 'odim.tags']],
  ['native empty items', { tags: [''], dims: { tags: [''] }, lines: [{}], olines: [{}] }, ['tags', 'dims', 'dims.tags', 'lines', 'olines']],
  ['native empty objects', { dims: {}, plain: {}, ident: {}, sident: {}, outer: { inner: {} }, ghost: {}, odim: {} }, []],
  ['native null members', {
    dims: { w: null, label: null, tags: null }, plain: { a: null, b: null }, ident: { id: null, label: null },
    sident: { id: null, label: null }, outer: { x: null, inner: { y: null, z: null } }, odim: { w: null, tags: null },
  }, []],
  // A value stored under a virtual member is not read: an object without stored members is always empty.
  ['native values', {
    count: 0, kind: 'one', state: 'OPEN', ref: OBJECT_ID, at: new Date('2026-01-02T03:04:05.000Z'), meta: { any: 1 },
    ident: { id: OBJECT_ID }, plain: { a: 0 }, ghost: { label: 'stored' },
  }, ['count', 'kind', 'state', 'ref', 'at', 'meta', 'ident', 'ident.id', 'plain', 'plain.a']],
  // An application scalar takes the null rule, so "" is a value, and so is an array, also one with null items.
  ['native meta blank', { meta: '' }, ['meta']],
  ['native meta x', { meta: 'x' }, ['meta']],
  ['native meta empty list', { meta: [] }, ['meta']],
  ['native meta null item', { meta: [null] }, ['meta']],
  ['native meta null and value', { meta: [1, null] }, ['meta']],
];
const ITEM_PATHS = Object.keys(ITEM_FORMS);
const NATIVE_CASES = NATIVE.map(([name, document, notEmpty]) => ({
  name, document: { key: name, ...document }, expectEmpty: Object.fromEntries(ITEM_PATHS.map((path) => [path, path !== 'id' && !notEmpty.includes(path)])),
}));
const expectedKeys = (rootKey, path, operator) => [
  ...expectedEmptinessKeys(rootKey, path, operator),
  ...(rootKey === 'item' ? NATIVE_CASES.filter((item) => item.expectEmpty[path] === (operator === 'IS_EMPTY')).map((item) => item.name) : []),
].sort();
const intersection = (lists) => lists.reduce((kept, keys) => kept.filter((key) => keys.includes(key)));
// The item records seeded through generated mutations.
const GENERATED_ITEMS = expectedEmptinessKeys('item', 'id', 'IS_NOT_EMPTY').length;

// A supplied model whose embedded type reaches itself through a list member (accepted: the list rule never reads its
// items) and one that reaches itself through a single member (INVALID_FILTER_OPERATOR). Neither field has a relation,
// so the runtime generates no model for these embedded types; MongoDB reads object fields without one as embedded.
const createForest = (prefix) => {
  const Tree = new GraphQLObjectType({
    name: `${prefix}Tree`,
    fields: () => ({ label: { type: GraphQLString }, children: { type: new GraphQLList(Tree), extensions: { readOnly: true } } }),
  });
  const Node = new GraphQLObjectType({
    name: `${prefix}Node`,
    fields: () => ({ label: { type: GraphQLString }, child: { type: Node, extensions: { readOnly: true } } }),
  });
  const Forest = new GraphQLObjectType({
    name: `${prefix}Forest`,
    fields: {
      id: { type: GraphQLID }, key: { type: new GraphQLNonNull(GraphQLString) },
      tree: { type: Tree, extensions: { relation: { embedded: true } } }, node: { type: Node, extensions: { relation: { embedded: true } } },
    },
  });
  const { Mixed } = mongoose.Schema.Types;
  const model = mongoose.model(`${prefix}Forest`, new mongoose.Schema({ key: String, tree: Mixed, node: Mixed }), `${prefix}Forest`);
  const runtime = createRuntime(createMongoAdapter());
  runtime.addNoEndpointType(Tree);
  runtime.addNoEndpointType(Node);
  const plural = `${prefix.charAt(0).toLowerCase()}${prefix.slice(1)}Forests`;
  runtime.connect(model, Forest, plural.slice(0, -1), plural);
  const schema = runtime.createSchema();
  const execute = (source) => graphql({ schema, source, contextValue: {} });
  const keys = async (filter) => {
    const result = await execute(`{ ${plural}(${filter}, sort: {terms: [{field: "key", order: ASC}]}) { key } }`);
    expect(result.errors, filter).toBeUndefined();
    return result.data[plural].map(({ key }) => key);
  };
  return { model, execute, keys, plural };
};
const FOREST = [
  { key: 'forest missing' }, { key: 'forest empty', tree: { label: '', children: [] } }, { key: 'forest null children', tree: { children: null } },
  { key: 'forest child', tree: { children: [{ label: 'x' }] } }, { key: 'forest null child', tree: { children: [null] } },
  { key: 'forest label', tree: { label: 'L' } },
];

// An application scalar `meta` stored at the root and as a member of the embedded object `bag`.
const holderTypes = (prefix) => {
  const Json = new GraphQLScalarType({ name: `${prefix}Json`, serialize: (value) => value, parseValue: (value) => value });
  const Bag = new GraphQLObjectType({ name: `${prefix}Bag`, fields: { label: { type: GraphQLString }, meta: { type: Json } } });
  const Holder = new GraphQLObjectType({
    name: `${prefix}Holder`,
    fields: {
      id: { type: GraphQLID }, key: { type: new GraphQLNonNull(GraphQLString) }, meta: { type: Json },
      bag: { type: Bag, extensions: { relation: { embedded: true } } },
    },
  });
  return { Json, Bag, Holder };
};
// Holders on a supplied model whose Mixed paths keep what is written, arrays included, as a native write does.
const createHolders = (prefix) => {
  const { Bag, Holder } = holderTypes(prefix);
  const { Mixed } = mongoose.Schema.Types;
  const model = mongoose.model(`${prefix}Holder`, new mongoose.Schema({ key: String, meta: Mixed, bag: Mixed }), `${prefix}Holder`);
  const runtime = createRuntime(createMongoAdapter());
  runtime.addNoEndpointType(Bag);
  const plural = `${prefix.charAt(0).toLowerCase()}${prefix.slice(1)}Holders`;
  runtime.connect(model, Holder, plural.slice(0, -1), plural);
  const schema = runtime.createSchema();
  const rows = async (filter) => {
    const result = await graphql({ schema, source: `{ ${plural}(${filter}, sort: {terms: [{field: "key", order: ASC}]}) { key meta bag { meta } } }`, contextValue: {} });
    expect(result.errors, filter).toBeUndefined();
    return result.data[plural];
  };
  return { model, rows };
};
// Each holder with whether `meta`, `bag` and `bag.meta` are empty.
const HOLDERS = [
  ['holder missing', {}, [true, true, true]],
  ['holder null', { meta: null, bag: null }, [true, true, true]],
  ['holder null members', { bag: { label: null, meta: null } }, [true, true, true]],
  ['holder blank', { meta: '', bag: { label: '', meta: null } }, [false, true, true]],
  ['holder empty list', { meta: [], bag: { meta: [] } }, [false, false, false]],
  ['holder null item', { meta: [null], bag: { meta: [null] } }, [false, false, false]],
  ['holder null and value', { meta: [1, null], bag: { meta: [1, null] } }, [false, false, false]],
  ['holder nested null item', { meta: [[null]], bag: { meta: [[null]] } }, [false, false, false]],
  ['holder empty object', { meta: {}, bag: { meta: {} } }, [false, false, false]],
  ['holder value', { meta: { any: 1 }, bag: { label: 'L' } }, [false, false, true]],
];
const HOLDER_PATHS = ['meta', 'bag', 'bag.meta'];

// Shops and their items, for collection fields read one parent at a time and batched.
const insertShops = async (target) => {
  const ids = Object.fromEntries(['s1', 's2', 's3'].map((key) => [key, new mongoose.Types.ObjectId()]));
  await target.model('Shop').collection.insertMany(Object.entries(ids).map(([key, _id]) => ({ _id, key })));
  await target.model('Item').collection.insertMany([
    { key: 'i1', shop: ids.s1, note: '', dims: { label: 'x' } }, { key: 'i2', shop: ids.s1, note: 'a', dims: {} },
    { key: 'i3', shop: ids.s2, note: null, tags: ['t'] }, { key: 'i4', shop: ids.s2, note: ' ', tags: [] }, { key: 'i5', shop: ids.s3 },
  ]);
};

// Generated models create their collections and indexes in the background; let them finish before the database is
// dropped, so that none is created again afterwards.
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
  ['replica set', replicaSetUri, 'QemRs'],
  ['standalone server', standaloneUri, 'QemSa'],
];
// Generated mutations need transactions, which the standalone server lacks: it gets the documents the replica set
// stored, natively. The replica-set block keeps them; a standalone block that runs without it, in a filtered or
// shuffled run, first seeds a database of its own on the replica set and drops it once the documents are read.
let replicaSetDocuments = null;
const connectTo = async (uri, suffix) => {
  await mongoose.connect(uri, { dbName: `${new URL(uri).pathname.slice(1)}_${suffix}`, monitorCommands: true });
  await mongoose.connection.dropDatabase();
};
const seedReplicaSet = async (fixture) => {
  await seedEmptiness(fixture.schema, fixture.types);
  await writeMongoEmptinessDocuments(fixture.runtime, fixture.types, { item: NATIVE_CASES.map((item) => item.document) });
  replicaSetDocuments = await readMongoEmptinessDocuments(fixture.runtime, fixture.types);
};
const seedOwnReplicaSet = async () => {
  await connectTo(replicaSetUri, 'qem_seed');
  const seeding = createFixture('QemSeed');
  await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
  await seedReplicaSet(seeding);
  await dropDatabase();
  await mongoose.disconnect();
};

describe.each(servers)('MongoDB emptiness on a %s', (label, uri, prefix) => {
  const enabled = !!uri && !!replicaSetUri;
  let fixture;
  let single;
  let batched;
  let forest;
  let holders;

  const keysOf = async (target, rootKey, args) => {
    const { source, variables } = emptinessQuery(target.types, rootKey, args);
    return (await target.run(source, variables))[target.types.roots[rootKey].plural].map(({ key }) => key);
  };
  const errorCode = async (target, rootKey, args) => {
    const { source, variables } = emptinessQuery(target.types, rootKey, args);
    const result = await target.execute(source, variables);
    return result.errors?.[0]?.extensions?.code ?? null;
  };
  // The aggregate commands sent for the collection of `target`'s items while `body` runs.
  const itemAggregates = async (target, body) => {
    const pipelines = [];
    const collection = target.model('Item').collection.collectionName;
    const listener = (event) => {
      if (event.commandName === 'aggregate' && event.command.aggregate === collection) pipelines.push(event.command.pipeline);
    };
    const client = mongoose.connection.getClient();
    client.on('commandStarted', listener);
    try {
      await body();
    } finally {
      client.off('commandStarted', listener);
    }
    return pipelines;
  };

  beforeAll(async () => {
    if (!enabled) return;
    if (label === 'standalone server' && !replicaSetDocuments) await seedOwnReplicaSet();
    await connectTo(uri, 'qem');
    fixture = createFixture(prefix);
    single = createFixture(`${prefix}One`);
    batched = createFixture(`${prefix}Batch`, { adapter: createMongoAdapter({ batchedCollections: true, collectionBatchSize: 2 }) });
    forest = createForest(prefix);
    holders = createHolders(prefix);
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    if (label === 'replica set') await seedReplicaSet(fixture);
    else await writeMongoEmptinessDocuments(fixture.runtime, fixture.types, replicaSetDocuments);
    await insertShops(single);
    await insertShops(batched);
    await forest.model.collection.insertMany(FOREST.map((document) => ({ ...document })));
    await holders.model.collection.insertMany(HOLDERS.map(([key, document]) => ({ key, ...document })));
    await fixture.model('Item').collection.createIndex({ note: 1 });
  }, 60000);

  afterAll(async () => {
    if (!enabled) return;
    await dropDatabase();
    await mongoose.disconnect();
  });

  describe.skipIf(!enabled)('rows', () => {
    test('every path of every root, on generated create and update writes and on native writes', async () => {
      const stored = await fixture.model('Item').collection.countDocuments();
      expect(stored).toBe(GENERATED_ITEMS + NATIVE.length);
      for (const [rootKey, root] of Object.entries(fixture.types.roots)) {
        for (const path of root.paths) {
          for (const operator of OPERATORS) {
            const expected = expectedKeys(rootKey, path, operator);
            expect(await keysOf(fixture, rootKey, emptinessArgs(fixture.types, rootKey, path, operator)), `${rootKey} ${path} ${operator}`).toEqual(expected);
            if (rootKey === 'item') {
              expect(await keysOf(fixture, rootKey, emptinessArgs(fixture.types, rootKey, path, operator, 'condition')), `${path} ${operator}`).toEqual(expected);
            }
          }
        }
      }
    });

    test('IS_NOT_EMPTY returns exactly the records IS_EMPTY does not', async () => {
      const all = await keysOf(fixture, 'item', {});
      for (const path of fixture.types.roots.item.paths) {
        const empty = await keysOf(fixture, 'item', emptinessArgs(fixture.types, 'item', path, 'IS_EMPTY'));
        const notEmpty = await keysOf(fixture, 'item', emptinessArgs(fixture.types, 'item', path, 'IS_NOT_EMPTY'));
        expect([...empty, ...notEmpty].sort(), path).toEqual(all);
      }
    });

    test('several object conditions in one query each apply', async () => {
      const cases = [
        [{ outer: 'IS_EMPTY', ident: 'IS_EMPTY', dims: 'IS_NOT_EMPTY' }],
        [{ ident: 'IS_NOT_EMPTY', plain: 'IS_NOT_EMPTY', outer: 'IS_EMPTY' }],
      ];
      for (const [conditions] of cases) {
        const each = Object.entries(conditions).map(([field, operator]) => expectedKeys('item', field, operator));
        const expected = intersection(each);
        // Each condition narrows the rows, so a dropped $or or $nor would show.
        expect(expected.length).toBeGreaterThan(0);
        for (const keys of each) expect(expected.length).toBeLessThan(keys.length);
        const terms = Object.fromEntries(Object.entries(conditions).map(([field, operator]) => [field, { terms: [{ operator }] }]));
        expect(await keysOf(fixture, 'item', terms), JSON.stringify(conditions)).toEqual(expected);
        const group = { AND: [{ conditions: Object.entries(conditions).map(([field, operator]) => ({ field, operator })) }] };
        expect(await keysOf(fixture, 'item', group), JSON.stringify(conditions)).toEqual(expected);
      }
    });

    test('pagination.count counts the filtered records before paging, and aggregates group them', async () => {
      const { plural } = fixture.types.roots.item;
      const context = {};
      const data = await fixture.run(
        `{ ${plural}(dims: {terms: [{operator: IS_EMPTY}]}, plain: {terms: [{operator: IS_EMPTY}]}, sort: {terms: [{field: "key", order: ASC}]}, pagination: {page: 1, size: 1, count: true}) { key } }`,
        undefined,
        context,
      );
      const expected = intersection([expectedKeys('item', 'dims', 'IS_EMPTY'), expectedKeys('item', 'plain', 'IS_EMPTY')]);
      expect(expected.length).toBeGreaterThan(1);
      expect(data[plural]).toEqual([{ key: expected[0] }]);
      expect(context.count).toBe(expected.length);
      const grouped = await fixture.run(`{ ${plural}_aggregate(outer: {terms: [{path: "inner", operator: IS_NOT_EMPTY}]}, aggregation: {groupId: "key", facts: [{operation: COUNT, factName: "n", path: "id"}]}) { groupId facts } }`);
      expect(grouped[`${plural}_aggregate`]).toEqual(expectedKeys('item', 'outer.inner', 'IS_NOT_EMPTY').map((key) => ({ groupId: key, facts: { n: 1 } })));
    });

    test('an application scalar keeps its EQ rows (regression pin, passes on 3.9.0)', async () => {
      expect(await keysOf(fixture, 'item', { meta: { operator: 'EQ', value: 'x' } })).toEqual(['native meta x']);
      expect(await keysOf(fixture, 'item', { meta: { operator: 'EQ', value: '' } })).toEqual(['native meta blank']);
    });

    test('rejected conditions fail before the query runs', async () => {
      expect(await errorCode(fixture, 'item', { lines: { terms: [{ path: 'qty', operator: 'IS_EMPTY' }] } })).toBe('INVALID_FILTER_PATH');
      expect(await errorCode(fixture, 'item', { note: { operator: 'IS_EMPTY', value: '' } })).toBe('INVALID_FILTER_VALUE');
    });

    // #108 part 2b: the adapter declares reference emptiness, so an object with a reference member and a reference end
    // return rows. No item of this fixture has a shop, and Shop has no find scope.
    const REFERENCE_FILTERS = [
      [{ odim: { terms: [{ operator: 'IS_EMPTY' }] } }, 'IS_EMPTY'],
      [{ AND: [{ conditions: [{ field: 'odim', operator: 'IS_NOT_EMPTY' }] }] }, 'IS_NOT_EMPTY'],
      [{ AND: [{ conditions: [{ field: 'shop', operator: 'IS_NOT_EMPTY' }] }] }, 'IS_NOT_EMPTY'],
      [{ shop: { terms: [{ operator: 'IS_EMPTY' }] } }, 'IS_EMPTY'],
    ];
    test('an object with a reference member and a reference end return rows', async () => {
      const all = await keysOf(fixture, 'item', {});
      // The object is empty when its stored members are: `w`, `tags`, and the `shop` that no item has.
      const odim = intersection([expectedKeys('item', 'odim.w', 'IS_EMPTY'), expectedKeys('item', 'odim.tags', 'IS_EMPTY')]);
      expect(odim.length).toBeGreaterThan(0);
      expect(odim.length).toBeLessThan(all.length);
      const expected = [odim, all.filter((key) => !odim.includes(key)), [], all];
      for (const [index, [args]] of REFERENCE_FILTERS.entries()) expect(await keysOf(fixture, 'item', args), JSON.stringify(args)).toEqual(expected[index]);
    });

    test('an adapter that does not declare reference emptiness keeps UNSUPPORTED_QUERY for them', async () => {
      const adapter = Object.create(createMongoAdapter(), { queryFeatures: { value: { operators: [...MONGO_QUERY_OPERATORS] } } });
      const undeclared = createFixture(`${prefix}Undeclared`, { adapter, preventCreatingCollection: true });
      for (const [args] of REFERENCE_FILTERS) {
        const { source, variables } = emptinessQuery(undeclared.types, 'item', args);
        const error = (await undeclared.execute(source, variables)).errors?.[0];
        expect(error?.extensions?.code, JSON.stringify(args)).toBe('UNSUPPORTED_QUERY');
        expect(error.message, JSON.stringify(args)).toMatch(/: the database adapter does not support emptiness through references and collections$/);
      }
    });

    test('an application scalar is empty only when missing or null, at the root and as a member: an array is a value', async () => {
      for (const [index, path] of HOLDER_PATHS.entries()) {
        for (const operator of OPERATORS) {
          const expected = HOLDERS.filter(([, , empty]) => empty[index] === (operator === 'IS_EMPTY')).map(([key]) => key).sort();
          const filters = [
            path === 'meta' ? `meta: {operator: ${operator}}` : `bag: {terms: [{${path === 'bag' ? '' : 'path: "meta", '}operator: ${operator}}]}`,
            `AND: [{conditions: [{field: "${path}", operator: ${operator}}]}]`,
          ];
          for (const filter of filters) {
            const rows = await holders.rows(filter);
            expect(rows.map(({ key }) => key), filter).toEqual(expected);
            // GraphQL reads null for every empty leaf and a value for every other one.
            if (path !== 'bag') {
              const read = rows.map((row) => (path === 'meta' ? row.meta : row.bag?.meta ?? null));
              expect(read.every((value) => (value === null) === (operator === 'IS_EMPTY')), filter).toBe(true);
            }
          }
        }
      }
    });

    test('a type that reaches itself only through a list member is accepted, and one that does through a single member is not', async () => {
      expect(await forest.keys('tree: {terms: [{operator: IS_EMPTY}]}')).toEqual(['forest empty', 'forest missing', 'forest null children']);
      expect(await forest.keys('tree: {terms: [{operator: IS_NOT_EMPTY}]}')).toEqual(['forest child', 'forest label', 'forest null child']);
      expect(await forest.keys('tree: {terms: [{path: "children", operator: IS_EMPTY}]}')).toEqual(['forest empty', 'forest label', 'forest missing', 'forest null children']);
      expect(await forest.keys('AND: [{conditions: [{field: "tree.children", operator: IS_NOT_EMPTY}]}]')).toEqual(['forest child', 'forest null child']);
      const cycle = await forest.execute(`{ ${forest.plural}(node: {terms: [{operator: IS_EMPTY}]}) { key } }`);
      expect(cycle.errors?.[0]?.extensions?.code).toBe('INVALID_FILTER_OPERATOR');
      expect(await forest.keys('node: {terms: [{path: "child.label", operator: IS_EMPTY}]}')).toEqual(FOREST.map(({ key }) => key).sort());
    });

    test('collection field arguments filter by emptiness, read one parent at a time and batched with $unionWith', async () => {
      const shopsOf = (target) => `${target.types.Shop.name.charAt(0).toLowerCase()}${target.types.Shop.name.slice(1)}s`;
      const source = (target, filter) => `{ ${shopsOf(target)}(sort: {terms: [{field: "key", order: ASC}]}) { key items(${filter}, sort: {terms: [{field: "key", order: ASC}]}) { key } } }`;
      const shops = async (target, filter) => (await target.run(source(target, filter)))[shopsOf(target)];
      const rows = (lists) => lists.map(([key, items]) => ({ key, items: items.map((item) => ({ key: item })) }));
      const cases = [
        ['note: {operator: IS_EMPTY}', [['s1', ['i1']], ['s2', ['i3']], ['s3', ['i5']]]],
        ['dims: {terms: [{operator: IS_NOT_EMPTY}]}', [['s1', ['i1']], ['s2', []], ['s3', []]]],
        ['OR: [{conditions: [{field: "dims", operator: IS_NOT_EMPTY}]}, {conditions: [{field: "tags", operator: IS_NOT_EMPTY}]}]', [['s1', ['i1']], ['s2', ['i3']], ['s3', []]]],
      ];
      for (const [filter, expected] of cases) {
        const oneByOne = await itemAggregates(single, async () => expect(await shops(single, filter), filter).toEqual(rows(expected)));
        expect(oneByOne).toHaveLength(3);
        expect(oneByOne.every((pipeline) => pipeline.every((stage) => !stage.$unionWith))).toBe(true);
        const commands = await itemAggregates(batched, async () => expect(await shops(batched, filter), filter).toEqual(rows(expected)));
        // Three parents in batches of two: one command with a $unionWith stage, and one without.
        expect(commands).toHaveLength(2);
        const [unionWith] = commands[0].filter((stage) => stage.$unionWith).map((stage) => stage.$unionWith);
        expect(unionWith.coll).toBe(batched.model('Item').collection.collectionName);
        expect(unionWith.pipeline[1]).toEqual(commands[0][1]);
      }
      const commands = await itemAggregates(batched, () => shops(batched, 'note: {operator: IS_EMPTY}'));
      expect(commands[0][1]).toEqual({ $match: { note: EMPTY_STRING } });
    });

    test('the String forms read the field index: IS_EMPTY scans null and "", IS_NOT_EMPTY every other key', async () => {
      const bounds = async (args) => {
        const pipeline = await fixture.adapter.buildQuery(args, fixture.types.Item);
        const found = scans(await fixture.model('Item').aggregate(pipeline).explain('queryPlanner'));
        return [...new Set(found.map((scan) => `${scan.stage} ${JSON.stringify(scan.indexBounds ?? null)}`))];
      };
      // Before 8.0, equality with null also matched the deprecated undefined type, so the null interval
      // starts at undefined.
      const { versionArray } = await fixture.model('Item').db.db.admin().serverInfo();
      const undefinedMatchesNull = versionArray[0] < 8;
      const empty = undefinedMatchesNull ? ['[undefined, undefined]', '[null, null]', '["", ""]'] : ['[null, null]', '["", ""]'];
      const notEmpty = [undefinedMatchesNull ? '[MinKey, undefined)' : '[MinKey, null)', '(null, "")', '("", MaxKey]'];
      expect(await bounds({ note: { operator: 'IS_EMPTY' } })).toEqual([`IXSCAN ${JSON.stringify({ note: empty })}`]);
      expect(await bounds({ note: { operator: 'IS_NOT_EMPTY' } })).toEqual([`IXSCAN ${JSON.stringify({ note: notEmpty })}`]);
    });
  });
});
