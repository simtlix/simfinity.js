import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import mongoose from 'mongoose';
import { graphql, GraphQLEnumType, GraphQLID, GraphQLInt, GraphQLList, GraphQLObjectType, GraphQLScalarType, GraphQLSchema, GraphQLString } from 'graphql';
import * as simfinity from '../packages/mongodb/src/index.js';
import QLValue from '../packages/mongodb/src/const/QLValue.js';

const profileType = new GraphQLObjectType({
  name: 'CorrectProfile',
  fields: { name: { type: GraphQLString }, age: { type: GraphQLInt } },
});
const authorType = new GraphQLObjectType({
  name: 'CorrectAuthor',
  fields: { id: { type: GraphQLID }, name: { type: GraphQLString }, age: { type: GraphQLInt } },
});
const lineType = new GraphQLObjectType({
  name: 'CorrectLine', fields: { id: { type: GraphQLID }, sku: { type: GraphQLString } },
});
const bookType = new GraphQLObjectType({
  name: 'CorrectBook',
  fields: {
    id: { type: GraphQLID }, title: { type: GraphQLString },
    profile: { type: profileType, extensions: { relation: { embedded: true } } },
    author: { type: authorType, extensions: { relation: { connectionField: 'authorId' } } },
    line: { type: lineType, extensions: { relation: { embedded: true } } },
    lines: { type: new GraphQLList(lineType), extensions: { relation: { embedded: true } } },
    coauthors: { type: new GraphQLList(authorType), extensions: { relation: { embedded: true } } },
  },
});
const stringIdType = new GraphQLObjectType({
  name: 'CorrectStringId', fields: { id: { type: GraphQLID }, title: { type: GraphQLString } },
});
const numericIdType = new GraphQLObjectType({
  name: 'CorrectNumericId', fields: { id: { type: GraphQLID }, title: { type: GraphQLString } },
});
const looseType = new GraphQLObjectType({
  name: 'CorrectLoose', fields: { id: { type: GraphQLID }, title: { type: GraphQLString }, ownerId: { type: GraphQLID } },
});
const collisionType = new GraphQLObjectType({
  name: 'CorrectCollision',
  fields: {
    id: { type: GraphQLID }, key: { type: GraphQLString }, conditions: { type: GraphQLString }, aggregation: { type: GraphQLInt },
  },
});
const match = (pipeline) => pipeline.find((stage) => stage.$match).$match;
const oid = '111111111111111111111111';
const enumType = new GraphQLEnumType({ name: 'QueryStoredEnum', values: { ACTIVE: { value: 7 }, INACTIVE: { value: 9 } } });
const typedFilters = new GraphQLObjectType({ name: 'QueryTypedValues', fields: {
  status: { type: enumType },
  email: { type: simfinity.scalars.EmailScalar },
  age: { type: simfinity.scalars.PositiveIntScalar },
  date: { type: new GraphQLScalarType({ name: 'DateTime', serialize: (value) => value }) },
} });
const stateType = new GraphQLObjectType({ name: 'QueryStoredState', fields: {
  title: { type: GraphQLString }, state: { type: enumType },
} });
let literalSchema;

beforeAll(() => {
  simfinity.preventCreatingCollection(true);
  simfinity.addNoEndpointType(profileType);
  simfinity.addNoEndpointType(lineType);
  simfinity.connect(null, authorType, 'correctAuthor', 'correctAuthors');
  simfinity.connect(null, bookType, 'correctBook', 'correctBooks');
  simfinity.connect(mongoose.model('CorrectStringIdModel', new mongoose.Schema({ _id: String, title: String })),
    stringIdType, 'correctStringId', 'correctStringIds');
  simfinity.connect(mongoose.model('CorrectNumericIdModel', new mongoose.Schema({ _id: Number, title: String })),
    numericIdType, 'correctNumericId', 'correctNumericIds');
  // A supplied non-strict model that declares no path for ownerId.
  simfinity.connect(mongoose.model('CorrectLooseModel', new mongoose.Schema({ title: String }, { strict: false })),
    looseType, 'correctLoose', 'correctLooses');
  simfinity.connect(null, collisionType, 'correctCollision', 'correctCollisions');
  simfinity.connect(null, typedFilters, 'queryTypedValue', 'queryTypedValues');
  simfinity.connect(null, stateType, 'queryStoredState', 'queryStoredStates', null, null,
    { initialState: { name: 'ACTIVE', value: 7 }, actions: {} });
  simfinity.createSchema();
  literalSchema = new GraphQLSchema({ query: new GraphQLObjectType({ name: 'QueryLiteralBoundary', fields: {
    filter: { type: GraphQLString, args: { value: { type: QLValue }, operator: { type: GraphQLString } },
      resolve: async (parent, args) => JSON.stringify(await simfinity.buildQuery({ title: args }, bookType)) },
  } }) });
});

afterEach(() => simfinity.configureQueryLimits?.({ maxPageSize: 1000 }));

describe('query correctness', () => {
  it.each([['profile', 'profile'], ['author', '__sf_l0']])('preserves every %s term, including repeated leaves beside OR', async (field, prefix) => {
    const pipeline = await simfinity.buildQuery({
      [field]: { terms: [
        { path: 'name', value: 'Alice' },
        { path: 'age', operator: 'GTE', value: 18 },
        { path: 'age', operator: 'LTE', value: 30 },
      ] },
      OR: [{ conditions: [{ field: 'title', value: 'A' }] }, { conditions: [{ field: 'title', value: 'B' }] }],
    }, bookType);
    const serialized = JSON.stringify(match(pipeline));
    expect(serialized).toContain(`"${prefix}.name":"Alice"`);
    expect(serialized).toContain('"$gte":18');
    expect(serialized).toContain('"$lte":30');
    expect(serialized).toContain('"$or"');
  });

  it.each(['EQ', 'NE', 'GT', 'GTE', 'LT', 'LTE'])('casts ObjectId for %s using the stored path', async (operator) => {
    const condition = match(await simfinity.buildQuery({ id: { operator, value: oid } }, bookType))._id;
    const value = operator === 'EQ' ? condition : Object.values(condition)[0];
    expect(value).toBeInstanceOf(mongoose.Types.ObjectId);
    expect(value.toHexString()).toBe(oid);
  });

  it.each(['EQ', 'NE', 'IN', 'NIN', 'BTW'])('preserves supplied string IDs for %s', async (operator) => {
    const value = ['IN', 'NIN', 'BTW'].includes(operator) ? ['record-a', 'record-z'] : 'record-a';
    const result = match(await simfinity.buildQuery({ id: { operator, value } }, stringIdType));
    expect(JSON.stringify(result)).toContain('record-a');
  });

  it('sorts root and referenced ids by _id and keeps embedded paths dotted', async () => {
    const pipeline = await simfinity.buildQuery({ sort: { terms: [
      { field: 'id', order: 'ASC' }, { field: 'author.id', order: 'DESC' },
      { field: 'author.name', order: 'ASC' }, { field: 'profile.age', order: 'ASC' },
      { field: 'line.id', order: 'ASC' }, { field: 'lines.id', order: 'DESC' },
    ] } }, bookType);
    expect(pipeline.find((stage) => stage.$sort)).toEqual({ $sort: {
      _id: 1, '__sf_l0._id': -1, '__sf_l0.name': 1, 'profile.age': 1, 'line.id': 1, 'lines.id': -1,
    } });
    expect(pipeline.filter((stage) => stage.$lookup)).toHaveLength(1);
  });

  it('filters embedded-only ids by the declared member that reads return', async () => {
    const result = match(await simfinity.buildQuery({
      line: { terms: [{ path: 'id', value: oid }] },
      lines: { terms: [{ path: 'id', operator: 'NE', value: oid }] },
    }, bookType));
    expect(result).toEqual({ 'line.id': new mongoose.Types.ObjectId(oid), 'lines.id': { $ne: new mongoose.Types.ObjectId(oid) } });
  });

  it('keeps the stored subdocument _id for an entity type embedded as a list', async () => {
    // Entity ids read `_id` first, and generated embedded list items store one beside the declared `id`.
    const pipeline = await simfinity.buildQuery({
      coauthors: { terms: [{ path: 'id', value: oid }] },
      sort: { terms: [{ field: 'coauthors.id', order: 'ASC' }] },
    }, bookType);
    expect(match(pipeline)).toEqual({ 'coauthors._id': new mongoose.Types.ObjectId(oid) });
    expect(pipeline.find((stage) => stage.$sort)).toEqual({ $sort: { 'coauthors._id': 1 } });
  });

  it.each([12, 0, 'aaaaaaaaaaaa', 'invalid'])('rejects %j for a GraphQLID field without a schema path instead of minting an ObjectId', async (value) => {
    await expect(simfinity.buildQuery({ ownerId: { value } }, looseType)).rejects.toMatchObject({ extensions: { code: 'INVALID_FILTER_VALUE', status: 400 } });
  });

  it('casts an ObjectId value for a GraphQLID field without a schema path', async () => {
    const hex = 'abcdefabcdef0123456789ab';
    const result = match(await simfinity.buildQuery({ ownerId: { operator: 'IN', value: [hex, hex.toUpperCase()] } }, looseType));
    expect(result.ownerId.$in.map((value) => value instanceof mongoose.Types.ObjectId && value.toHexString())).toEqual([hex, hex]);
  });

  it('filters fields named conditions and aggregation on list and count queries', async () => {
    expect(match(await simfinity.buildQuery({ conditions: { value: 'c1' } }, collisionType))).toEqual({ conditions: 'c1' });
    for (const isCount of [false, true]) {
      const pipeline = await simfinity.buildQuery({ aggregation: { operator: 'GT', value: 5 }, pagination: { page: 1, size: 10, count: true } }, collisionType, isCount);
      expect(match(pipeline)).toEqual({ aggregation: { $gt: 5 } });
    }
    expect(match(await simfinity.buildQuery({ AND: [{ conditions: [{ field: 'aggregation', operator: 'LTE', value: 5 }] }] }, collisionType)))
      .toEqual({ aggregation: { $lte: 5 } });
  });

  it.each([
    { aggregation: { operator: 'GT', value: 5 } },
    { conditions: [{ field: 'title', value: 'A' }] },
    { conditions: 'A' },
  ])('rejects query-control names that are not fields of the type: %j', async (input) => {
    await expect(simfinity.buildQuery(input, bookType)).rejects.toMatchObject({ extensions: { code: 'INVALID_FILTER_FIELD', status: 400 } });
  });

  it('uses a supplied numeric _id schema and casts both range endpoints', async () => {
    const result = match(await simfinity.buildQuery({ id: { operator: 'BTW', value: ['12', '30'] } }, numericIdType));
    expect(result).toEqual({ _id: { $gte: 12, $lte: 30 } });
  });

  it.each([
    { title: { operator: 'BOGUS', value: 'a' } },
    { title: { operator: 'EQ', value: { $ne: null } } },
    { title: { operator: 'IN', value: 'a' } },
    { title: { operator: 'BTW', value: ['a'] } },
    { title: { operator: 'LIKE', value: 12 } },
    { title: { operator: 'IN', value: ['a', null] } },
    { title: { operator: 'IN', value: [{ value: 'a' }] } },
    { AND: [null] },
    { OR: [{ conditions: [null] }] },
    { OR: [{ conditions: [{ field: 'title', path: 'name', value: 'a' }] }] },
    { AND: { conditions: [{ field: 'title', value: 'a' }] } },
    { profile: { terms: [{ path: 'missing', value: 'a' }] } },
    { profile: { terms: [{ path: 'age.name', value: 'a' }] } },
    { missing: { value: 'a' } },
    { sort: { terms: [{ field: 'missing', order: 'ASC' }] } },
    { sort: { terms: [] } },
    { sort: { terms: [{ field: 'title', order: 'SIDEWAYS' }] } },
  ])('rejects unsupported filter or sort input: %j', async (input) => {
    await expect(simfinity.buildQuery(input, bookType)).rejects.toMatchObject({ extensions: { status: 400 } });
  });

  it('rejects Boolean input for a numeric identifier', async () => {
    await expect(simfinity.buildQuery({ id: { value: true } }, numericIdType)).rejects.toMatchObject({ extensions: { code: 'INVALID_FILTER_VALUE' } });
  });

  it.each([
    ['EQ', '{unexpected:"value"}', { unexpected: 'value' }],
    ['IN', '["A",null]', ['A', null]],
    ['NIN', '[{unexpected:"value"}]', [{ unexpected: 'value' }]],
    ['IN', '[["A"]]', [['A']]],
  ])('rejects unsupported %s literal and variable values consistently', async (operator, literal, value) => {
    const inline = await graphql({ schema: literalSchema, source: `{filter(operator:"${operator}",value:${literal})}` });
    const variable = await graphql({ schema: literalSchema, source: `query($v:QLValue){filter(operator:"${operator}",value:$v)}`, variableValues: { v: value } });
    expect(inline.errors?.length).toBeGreaterThan(0);
    expect(variable.errors?.length).toBeGreaterThan(0);
  });

  it.each(['EQ', 'NE'])('preserves explicit null for %s in literals and variables', async (operator) => {
    const inline = await graphql({ schema: literalSchema, source: `{filter(operator:"${operator}",value:null)}` });
    const variable = await graphql({ schema: literalSchema, source: `query($v:QLValue){filter(operator:"${operator}",value:$v)}`, variableValues: { v: null } });
    expect(inline.errors).toBeUndefined();
    expect(variable).toEqual(inline);
  });

  it('compares enum storage values, dates and custom scalar search fragments', async () => {
    expect(match(await simfinity.buildQuery({ status: { value: 'ACTIVE' } }, typedFilters))).toEqual({ status: 7 });
    expect(match(await simfinity.buildQuery({ email: { operator: 'LIKE', value: '@example.com' } }, typedFilters))).toEqual({ email: { $regex: '.*@example\\.com.*' } });
    expect(match(await simfinity.buildQuery({ age: { operator: 'GTE', value: 0 } }, typedFilters))).toEqual({ age: { $gte: 0 } });
    const input = { date: { operator: 'BTW', value: ['2025-01-01', '2025-12-31'] } };
    expect(match(await simfinity.buildQuery(input, typedFilters))).toEqual({ date: { $gte: new Date('2025-01-01'), $lte: new Date('2025-12-31') } });
    expect(input.date.value).toEqual(['2025-01-01', '2025-12-31']);
    await expect(simfinity.buildQuery({ date: { value: 'invalid' } }, typedFilters)).rejects.toMatchObject({ extensions: { code: 'INVALID_FILTER_VALUE' } });
  });

  it('preserves state-machine state names instead of ordinary enum storage values', async () => {
    expect(match(await simfinity.buildQuery({ state: { value: 'ACTIVE' } }, stateType))).toEqual({ state: 'ACTIVE' });
  });

  it('accepts declared enum internal values as well as public names', async () => {
    expect(match(await simfinity.buildQuery({ status: { value: 7 } }, typedFilters))).toEqual({ status: 7 });
    expect(match(await simfinity.buildQuery({ state: { value: 7 } }, stateType))).toEqual({ state: 'ACTIVE' });
  });

  it.each([
    { page: 0, size: 10 }, { page: -1, size: 10 }, { page: 1, size: 0 },
    { page: 1, size: -1 }, { page: 1, size: 1001 }, { page: 1.5, size: 10 },
    { page: Number.MAX_SAFE_INTEGER, size: 1000 },
  ])('rejects invalid pagination: %j', async (pagination) => {
    await expect(simfinity.buildQuery({ pagination }, bookType)).rejects.toMatchObject({ extensions: { code: 'INVALID_PAGINATION', status: 400 } });
  });

  it('supports a configurable cap below and above the list default', async () => {
    expect(simfinity.configureQueryLimits).toBeTypeOf('function');
    simfinity.configureQueryLimits({ maxPageSize: 5 });
    expect((await simfinity.buildQuery({}, bookType)).at(-1)).toEqual({ $limit: 5 });
    await expect(simfinity.buildQuery({ pagination: { page: 1, size: 6 } }, bookType)).rejects.toMatchObject({ extensions: { code: 'INVALID_PAGINATION' } });
    simfinity.configureQueryLimits({ maxPageSize: 2000 });
    expect((await simfinity.buildQuery({}, bookType)).at(-1)).toEqual({ $limit: 100 });
    expect((await simfinity.buildQuery({ pagination: { page: 2, size: 2000 } }, bookType)).slice(-2)).toEqual([{ $skip: 2000 }, { $limit: 2000 }]);
    expect(() => simfinity.configureQueryLimits({ maxPageSize: 0 })).toThrow();
  });

  it.each([null, [], 'invalid', 42, true, new Date('2025-01-01')].map((value) => [value]))('rejects invalid query-limit options: %j', (options) => {
    expect(() => simfinity.configureQueryLimits(options)).toThrow(expect.objectContaining({ extensions: expect.objectContaining({ code: 'INVALID_QUERY_LIMITS', status: 400 }) }));
  });

  it('accepts empty query-limit options and the largest safe integer cap', async () => {
    simfinity.configureQueryLimits({ maxPageSize: Number.MAX_SAFE_INTEGER });
    expect((await simfinity.buildQuery({ pagination: { page: 1, size: Number.MAX_SAFE_INTEGER } }, bookType)).at(-1)).toEqual({ $limit: Number.MAX_SAFE_INTEGER });
    simfinity.configureQueryLimits({});
    await expect(simfinity.buildQuery({ pagination: { page: 1, size: 1001 } }, bookType)).rejects.toMatchObject({ extensions: { code: 'INVALID_PAGINATION' } });
  });
});
