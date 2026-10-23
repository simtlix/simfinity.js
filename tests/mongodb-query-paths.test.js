import {
  afterAll, beforeAll, beforeEach, describe, expect, test, vi,
} from 'vitest';
import mongoose from 'mongoose';
import {
  graphql, GraphQLID, GraphQLInt, GraphQLInterfaceType, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLScalarType,
  GraphQLString, GraphQLUnionType,
} from 'graphql';
import {
  auth, createMongoAdapter, createRuntime, createValidatedScalar, SimfinityError,
} from '../packages/mongodb/src/index.js';
import { markStoredIdentity } from '@simtlix/simfinity-core/internal/relation-storage';
import { createMongoQueries } from '../packages/mongodb/src/mongo/queries.js';
import { createQueryPlan, describeModels } from '../packages/core/src/index.js';

const idField = { type: GraphQLID };
const AddressType = new GraphQLObjectType({
  name: 'QueryPathAddress',
  fields: { id: idField, name: { type: GraphQLString } },
});
const UserType = new GraphQLObjectType({
  name: 'QueryPathUser',
  fields: {
    id: idField,
    name: { type: GraphQLString },
    address: { type: AddressType, extensions: { relation: { embedded: false } } },
  },
});
const MetaType = new GraphQLObjectType({
  name: 'QueryPathMeta',
  fields: {
    label: { type: GraphQLString },
    ref: { type: UserType, extensions: { relation: { embedded: false } } },
  },
});
const GhostType = new GraphQLObjectType({
  name: 'QueryPathGhost',
  fields: { id: idField, name: { type: GraphQLString } },
});
const ChildType = new GraphQLObjectType({
  name: 'QueryPathChild',
  fields: { id: idField, n: { type: GraphQLInt } },
});
const DateTime = new GraphQLScalarType({ name: 'DateTime' });
const EmailScalar = createValidatedScalar('QueryPathEmail', 'Email', GraphQLString, () => {});
const CorporateEmail = createValidatedScalar('QueryPathCorporate', 'Corporate email', EmailScalar, () => {});
const FutureDate = createValidatedScalar('QueryPathFuture', 'Future date', DateTime, () => {});
const ChainedDate = createValidatedScalar('QueryPathChained', 'Chained date', FutureDate, () => {});
const StrictEmail = createValidatedScalar('QueryPathStrictEmail', 'Email', GraphQLString, (value) => {
  if (!String(value).includes('@')) throw new Error('Invalid email');
});
const StrictCorporate = createValidatedScalar('QueryPathStrictCorporate', 'Corporate email', StrictEmail, () => {});
const NoteType = new GraphQLObjectType({
  name: 'QueryPathNote',
  fields: {
    id: idField,
    title: { type: GraphQLString },
    price: { type: GraphQLInt },
    workEmail: { type: CorporateEmail },
    due: { type: ChainedDate },
    strictWork: { type: StrictCorporate },
    owner: { type: UserType, extensions: { relation: { embedded: false } } },
    owner_address: { type: AddressType, extensions: { relation: { embedded: false } } },
    valueOf: { type: AddressType, extensions: { relation: { embedded: false } } },
    meta: { type: MetaType, extensions: { relation: { embedded: true } } },
    ghost: { type: GhostType, extensions: { relation: { embedded: false } } },
    children: {
      type: new GraphQLList(ChildType),
      extensions: { relation: { embedded: false, connectionField: 'noteKey' } },
    },
  },
});
const modelFor = (collectionName) => ({ collection: { collectionName } });
const models = new Map([
  [NoteType, modelFor('notes')],
  [UserType, modelFor('users')],
  [AddressType, modelFor('addresses')],
  [ChildType, modelFor('children')],
]);
const queries = createMongoQueries({
  getModel: (type) => models.get(type) ?? null,
  getRegistrations: () => [],
});

const lookups = (pipeline) => pipeline.filter((stage) => stage.$lookup).map((stage) => stage.$lookup);
const PAGE = [{ $skip: 0 }, { $limit: 100 }];
// A frame of reference and collection emptiness (#108 part 2b) without a scope, as trusted constructs read it.
const frame = (from, localField, foreignField, alias, stages = []) => ({
  $lookup: {
    from, localField, foreignField, pipeline: [...stages, { $limit: 1 }, { $project: { _id: 1 } }], as: alias,
  },
});
const none = (alias) => ({ [`${alias}.0`]: { $exists: false } });
const matchOf = (pipeline) => pipeline.find((stage) => stage.$match)?.$match;
const groupOf = (pipeline) => pipeline.find((stage) => stage.$group).$group;
const aggregate = (aggregation, input = {}) => queries.buildAggregationQuery(input, NoteType, aggregation);
const count = { operation: 'COUNT', factName: 'n', path: 'id' };

const expectRejection = async (promise, code) => {
  const error = await promise.then(() => null, (caught) => caught);
  expect(error).toBeInstanceOf(SimfinityError);
  expect(error.extensions).toMatchObject({ code, status: 400 });
};

describe('MongoDB relation lookup aliases', () => {
  test('joins relations under reserved aliases and restores stored rows', async () => {
    const pipeline = await queries.buildQuery({
      owner: { terms: [{ path: 'name', value: 'Ann' }] },
      sort: { terms: [{ field: 'owner.name', order: 'ASC' }] },
    }, NoteType);

    expect(lookups(pipeline)).toEqual([{
      from: 'users', foreignField: '_id', localField: 'owner', as: '__sf_l0',
    }]);
    expect(matchOf(pipeline)).toEqual({ '__sf_l0.name': 'Ann' });
    expect(pipeline.find((stage) => stage.$sort)).toEqual({ $sort: { '__sf_l0.name': 1 } });
    expect(pipeline.at(-1)).toEqual({ $unset: ['__sf_l0'] });
  });

  test('keeps distinct lookups for relation paths whose old aliases collided', async () => {
    for (const input of [
      {
        owner: { terms: [{ path: 'address.name', value: 'OwnerStreet' }] },
        owner_address: { terms: [{ path: 'name', value: 'NoteStreet' }] },
      },
      {
        owner_address: { terms: [{ path: 'name', value: 'NoteStreet' }] },
        owner: { terms: [{ path: 'address.name', value: 'OwnerStreet' }] },
      },
    ]) {
      const pipeline = await queries.buildQuery(input, NoteType);
      const joined = lookups(pipeline);
      const aliasOf = (localField) => joined.find((lookup) => lookup.localField === localField)?.as;
      const ownerAlias = aliasOf('owner');
      const nestedAlias = aliasOf(`${ownerAlias}.address`);
      const directAlias = aliasOf('owner_address');

      expect(joined).toHaveLength(3);
      expect(new Set([ownerAlias, nestedAlias, directAlias]).size).toBe(3);
      expect([ownerAlias, nestedAlias, directAlias].every((alias) => /^__sf_l\d+$/.test(alias))).toBe(true);
      expect(matchOf(pipeline)).toEqual({
        [`${nestedAlias}.name`]: 'OwnerStreet',
        [`${directAlias}.name`]: 'NoteStreet',
      });
    }
  });

  test('adds a lookup for relations named like Object.prototype members', async () => {
    const pipeline = await queries.buildQuery({ valueOf: { terms: [{ path: 'name', value: 'AR' }] } }, NoteType);

    expect(lookups(pipeline)).toEqual([{
      from: 'addresses', foreignField: '_id', localField: 'valueOf', as: '__sf_l0',
    }]);
    expect(matchOf(pipeline)).toEqual({ '__sf_l0.name': 'AR' });
  });

  test('shares aliases across AND/OR groups, flat filters and sorts', async () => {
    const pipeline = await queries.buildQuery({
      owner: { terms: [{ path: 'name', value: 'Ann' }] },
      OR: [
        { conditions: [{ field: 'owner', path: 'address.name', value: 'Main' }] },
        { conditions: [{ field: 'title', value: 'n1' }] },
      ],
      sort: { terms: [{ field: 'owner.address.name', order: 'DESC' }] },
    }, NoteType);

    expect(lookups(pipeline).map((lookup) => [lookup.as, lookup.localField])).toEqual([
      ['__sf_l0', 'owner'],
      ['__sf_l1', '__sf_l0.address'],
    ]);
    expect(pipeline.at(-1)).toEqual({ $unset: ['__sf_l0', '__sf_l1'] });
  });

  test('omits the cleanup stage for counts and lookup-free queries', async () => {
    const counted = await queries.buildQuery({ owner: { terms: [{ path: 'name', value: 'Ann' }] } }, NoteType, true);
    expect(counted.at(-1)).toEqual({ $count: 'size' });
    expect(counted.some((stage) => stage.$unset)).toBe(false);

    const plain = await queries.buildQuery({ title: { value: 'n1' } }, NoteType);
    expect(plain.some((stage) => stage.$unset)).toBe(false);
  });
});

describe('MongoDB aggregation paths and facts', () => {
  test('resolves group and fact paths through the shared lookup allocator', async () => {
    const pipeline = await aggregate({
      groupId: 'meta.ref.name',
      facts: [
        { operation: 'COUNT', factName: 'count', path: 'children.id' },
        { operation: 'SUM', factName: 'sum', path: 'children.n' },
        { operation: 'MAX', factName: 'top', path: 'owner.address.name' },
      ],
    }, { meta: { terms: [{ path: 'ref.name', value: 'Ann' }] } });

    expect(lookups(pipeline).map((lookup) => [lookup.as, lookup.localField])).toEqual([
      ['__sf_l0', 'meta.ref'],
      ['__sf_l1', '_id'],
      ['__sf_l2', 'owner'],
      ['__sf_l3', '__sf_l2.address'],
    ]);
    expect(groupOf(pipeline)).toEqual({
      _id: '$__sf_l0.name',
      fact_0: { $sum: 1 },
      fact_1: { $sum: '$__sf_l1.n' },
      fact_2: { $max: '$__sf_l3.name' },
    });
    expect(pipeline.find((stage) => stage.$project).$project).toEqual({
      _id: 0,
      groupId: '$_id',
      facts: { count: '$fact_0', sum: '$fact_1', top: '$fact_2' },
    });
  });

  test('keeps the group key when a fact is named _id and sorts by fact names', async () => {
    const pipeline = await aggregate({
      groupId: 'title',
      facts: [{ operation: 'SUM', factName: '_id', path: 'price' }],
    }, { sort: { terms: [{ field: '_id', order: 'DESC' }] } });

    expect(groupOf(pipeline)).toEqual({ _id: '$title', fact_0: { $sum: '$price' } });
    expect(pipeline.find((stage) => stage.$project).$project.facts).toEqual({ _id: '$fact_0' });
    expect(pipeline.find((stage) => stage.$sort)).toEqual({ $sort: { 'facts._id': -1 } });
  });

  test.each([
    ['owner', 'INVALID_FILTER_PATH'],
    ['meta', 'INVALID_FILTER_PATH'],
    ['meta.ref', 'INVALID_FILTER_PATH'],
    ['children', 'INVALID_FILTER_PATH'],
    ['title.price', 'INVALID_FILTER_PATH'],
    ['ghost.name', 'INVALID_FILTER_PATH'],
    ['a..b', 'INVALID_FILTER_PATH'],
    ['nope', 'INVALID_FILTER_FIELD'],
    ['constructor', 'INVALID_FILTER_FIELD'],
    ['owner.nope', 'INVALID_FILTER_FIELD'],
  ])('rejects the group path %s with %s', async (groupId, code) => {
    await expectRejection(aggregate({ groupId, facts: [count] }), code);
  });

  test.each([
    ['owner', 'INVALID_FILTER_PATH'],
    ['meta', 'INVALID_FILTER_PATH'],
    ['price.n', 'INVALID_FILTER_PATH'],
    ['nope', 'INVALID_FILTER_FIELD'],
  ])('rejects the fact path %s with %s', async (path, code) => {
    await expectRejection(aggregate({ groupId: 'title', facts: [{ operation: 'MAX', factName: 'm', path }] }), code);
    await expectRejection(aggregate({ groupId: 'title', facts: [{ operation: 'COUNT', factName: 'm', path }] }), code);
  });

  test.each([
    'a.b', '$x', '', '1st', 'avg-rating', '__proto__', 'constructor', 'prototype', 42, undefined,
  ])('rejects the fact name %j', async (factName) => {
    await expectRejection(
      aggregate({ groupId: 'title', facts: [{ operation: 'SUM', factName, path: 'price' }] }),
      'INVALID_FILTER_VALUE',
    );
  });

  test('rejects duplicate fact names, unknown operations and incomplete expressions', async () => {
    await expectRejection(aggregate({
      groupId: 'title',
      facts: [
        { operation: 'SUM', factName: 't', path: 'price' },
        { operation: 'COUNT', factName: 't', path: 'id' },
      ],
    }), 'INVALID_FILTER_VALUE');
    for (const operation of ['MEDIAN', 'constructor', undefined]) {
      await expectRejection(aggregate({ groupId: 'title', facts: [{ operation, factName: 't', path: 'price' }] }), 'INVALID_FILTER_VALUE');
    }
    await expectRejection(aggregate({ groupId: 'title', facts: [null] }), 'INVALID_FILTER_VALUE');
    await expectRejection(aggregate({ groupId: 'title', facts: [] }), 'INVALID_FILTER_VALUE');
    await expectRejection(aggregate({ facts: [count] }), 'INVALID_FILTER_VALUE');
    await expectRejection(aggregate(undefined), 'INVALID_FILTER_VALUE');
  });
});

describe('MongoDB filters on chained validated scalars', () => {
  test('uses the root storage scalar for LIKE and date filters', async () => {
    expect(matchOf(await queries.buildQuery({ workEmail: { operator: 'LIKE', value: '@acme' } }, NoteType)))
      .toEqual({ workEmail: { $regex: '.*@acme.*' } });
    expect(matchOf(await queries.buildQuery({ due: { value: '2030-01-01T00:00:00.000Z' } }, NoteType)))
      .toEqual({ due: new Date('2030-01-01T00:00:00.000Z') });
  });

  test('parses range filter values with the root storage scalar', async () => {
    expect(matchOf(await queries.buildQuery({ strictWork: { operator: 'GT', value: 'm' } }, NoteType)))
      .toEqual({ strictWork: { $gt: 'm' } });
  });
});

describe('MongoDB embedded id paths', () => {
  const hex = '0123456789abcdef01234567';
  const otherHex = '76543210fedcba9876543210';
  const objectId = (value) => new mongoose.Types.ObjectId(value);
  // Embedded-only: reads return the declared `id` member.
  const LineType = new GraphQLObjectType({
    name: 'QueryPathLine',
    fields: { id: idField, sku: { type: GraphQLString } },
  });
  // An entity type (a runtime marked it with stored identity): reads return the stored `_id` when there is one.
  const PartType = new GraphQLObjectType({
    name: 'QueryPathPart',
    fields: { id: idField, sku: { type: GraphQLString } },
  });
  markStoredIdentity(PartType);
  const OrderType = new GraphQLObjectType({
    name: 'QueryPathOrder',
    fields: {
      id: idField,
      line: { type: LineType, extensions: { relation: { embedded: true } } },
      lines: { type: new GraphQLList(LineType), extensions: { relation: { embedded: true } } },
      part: { type: PartType, extensions: { relation: { embedded: true } } },
      parts: { type: new GraphQLList(PartType), extensions: { relation: { embedded: true } } },
      meta: { type: MetaType, extensions: { relation: { embedded: true } } },
    },
  });
  const { ObjectId } = mongoose.Schema.Types;
  // Same shape as a generated model: singular embedded objects are nested paths without `_id`, and
  // embedded list items are subdocuments with Mongoose's automatic `_id` beside the declared `id`.
  const generatedSchema = new mongoose.Schema({
    line: { id: ObjectId, sku: String },
    lines: [{ id: ObjectId, sku: String }],
    part: { id: ObjectId, sku: String },
    parts: [{ id: ObjectId, sku: String }],
    meta: { label: String, ref: ObjectId },
  });
  // A supplied model whose subdocument schemas store only `_id`, read through Mongoose's `id` virtual.
  const suppliedSchema = new mongoose.Schema({
    line: new mongoose.Schema({ sku: String }),
    lines: [new mongoose.Schema({ sku: String })],
    part: new mongoose.Schema({ sku: String }),
    parts: [new mongoose.Schema({ sku: String })],
  });
  markStoredIdentity(OrderType);
  const registrations = [
    { gqltype: OrderType, endpoint: true },
    { gqltype: PartType, endpoint: true },
    { gqltype: LineType, endpoint: false },
  ];
  const queriesFor = (schema) => {
    const orderModel = { collection: { collectionName: 'orders' }, schema };
    const byType = new Map([[OrderType, orderModel], [UserType, modelFor('users')]]);
    return createMongoQueries({ getModel: (type) => byType.get(type) ?? null, getRegistrations: () => registrations });
  };
  const generated = queriesFor(generatedSchema);
  const supplied = queriesFor(suppliedSchema);
  const schemaLess = queriesFor(undefined);
  const term = (path, operator, value) => ({ terms: [{ path, operator, value }] });

  test('filters embedded-only objects by their declared id on a generated model', async () => {
    expect(matchOf(await generated.buildQuery({ line: term('id', 'EQ', hex) }, OrderType)))
      .toEqual({ 'line.id': objectId(hex) });
    expect(matchOf(await generated.buildQuery({ lines: term('id', 'IN', [hex, otherHex]) }, OrderType)))
      .toEqual({ 'lines.id': { $in: [objectId(hex), objectId(otherHex)] } });
    // NE used to compare the absent `line._id`, so it matched every record.
    expect(matchOf(await generated.buildQuery({ line: term('id', 'NE', hex) }, OrderType)))
      .toEqual({ 'line.id': { $ne: objectId(hex) } });
    expect(matchOf(await generated.buildQuery({ OR: [
      { conditions: [{ field: 'line', path: 'id', value: hex }] },
      { conditions: [{ field: 'lines.id', operator: 'NIN', value: [otherHex] }] },
    ] }, OrderType))).toEqual({ $or: [{ 'line.id': objectId(hex) }, { 'lines.id': { $nin: [objectId(otherHex)] } }] });
  });

  test('sorts and groups by declared embedded ids while root and joined ids stay _id', async () => {
    const sorted = await generated.buildQuery({ sort: { terms: [
      { field: 'line.id', order: 'ASC' }, { field: 'lines.id', order: 'DESC' },
      { field: 'id', order: 'ASC' }, { field: 'meta.ref.id', order: 'ASC' },
    ] } }, OrderType);
    expect(sorted.find((stage) => stage.$sort)).toEqual({ $sort: {
      'line.id': 1, 'lines.id': -1, _id: 1, '__sf_l0._id': 1,
    } });

    const grouped = await generated.buildAggregationQuery({}, OrderType, {
      groupId: 'lines.id',
      facts: [{ operation: 'MIN', factName: 'first', path: 'line.id' }, { operation: 'COUNT', factName: 'n', path: 'id' }],
    });
    expect(groupOf(grouped)).toEqual({ _id: '$lines.id', fact_0: { $min: '$line.id' }, fact_1: { $sum: 1 } });
  });

  test('keeps the stored subdocument _id for entity types embedded as lists', async () => {
    // The entity id resolver returns `parent._id ?? parent.id`: list items have `_id`, nested objects do not.
    expect(matchOf(await generated.buildQuery({ parts: term('id', 'EQ', hex) }, OrderType)))
      .toEqual({ 'parts._id': objectId(hex) });
    expect(matchOf(await generated.buildQuery({ part: term('id', 'NE', hex) }, OrderType)))
      .toEqual({ 'part.id': { $ne: objectId(hex) } });
    const grouped = await generated.buildAggregationQuery({}, OrderType, {
      groupId: 'parts.id', facts: [{ operation: 'MAX', factName: 'last', path: 'part.id' }],
    });
    expect(groupOf(grouped)).toEqual({ _id: '$parts._id', fact_0: { $max: '$part.id' } });
  });

  test('keeps _id for supplied subdocument schemas that declare no id path', async () => {
    expect(matchOf(await supplied.buildQuery({
      line: term('id', 'EQ', hex), lines: term('id', 'IN', [hex]), part: term('id', 'EQ', hex), parts: term('id', 'NE', hex),
    }, OrderType))).toEqual({
      'line._id': objectId(hex),
      'lines._id': { $in: [objectId(hex)] },
      'part._id': objectId(hex),
      'parts._id': { $ne: objectId(hex) },
    });
  });

  test('uses the declared id and casts ObjectId values when the model has no schema', async () => {
    const pipeline = await schemaLess.buildQuery({
      line: term('id', 'EQ', hex), parts: term('id', 'IN', [hex]), sort: { terms: [{ field: 'lines.id', order: 'ASC' }] },
    }, OrderType);
    expect(matchOf(pipeline)).toEqual({ 'line.id': objectId(hex), 'parts.id': { $in: [objectId(hex)] } });
    expect(pipeline.find((stage) => stage.$sort)).toEqual({ $sort: { 'lines.id': 1 } });
  });

  test('resolves the id members that emptiness conditions read as the other operators do', async () => {
    const emptyString = { $in: [null, ''] };
    const form = (field, key) => ({ $or: [{ [field]: null }, { $and: [{ [`${field}.${key}`]: null }, { [`${field}.sku`]: emptyString }] }] });
    const objects = { line: { terms: [{ operator: 'IS_EMPTY' }] }, part: { terms: [{ path: '', operator: 'IS_EMPTY' }] } };
    // Generated nested objects have no `_id`: the declared member, also for an entity type.
    for (const built of [generated, schemaLess]) {
      expect(matchOf(await built.buildQuery(objects, OrderType))).toEqual({ $and: [{ $or: form('line', 'id').$or }, { $or: form('part', 'id').$or }] });
      expect(matchOf(await built.buildQuery({ line: term('id', 'IS_NOT_EMPTY') }, OrderType))).toEqual({ 'line.id': { $ne: null } });
    }
    // A supplied subdocument schema with an automatic `_id` stores one, so the object is never empty: a known
    // difference from PostgreSQL.
    expect(matchOf(await supplied.buildQuery(objects, OrderType))).toEqual({ $and: [{ $or: form('line', '_id').$or }, { $or: form('part', '_id').$or }] });
    expect(matchOf(await supplied.buildQuery({ part: term('id', 'IS_EMPTY') }, OrderType))).toEqual({ 'part._id': null });
    // Lists are never read inside, and the root identity is `_id`.
    expect(matchOf(await supplied.buildQuery({ parts: { terms: [{ operator: 'IS_EMPTY' }] }, id: { operator: 'IS_NOT_EMPTY' } }, OrderType)))
      .toEqual({ 'parts.0': { $exists: false }, _id: { $ne: null } });
    // A reference member reads its target through a frame; without a client scope marker it reads stored data.
    const meta = { $or: [{ meta: null }, { $and: [{ 'meta.label': emptyString }, none('__sf_q0')] }] };
    expect(await generated.buildQuery({ meta: { terms: [{ operator: 'IS_EMPTY' }] } }, OrderType)).toStrictEqual([
      frame('users', 'meta.ref', '_id', '__sf_q0'), { $match: meta }, ...PAGE, { $unset: ['__sf_q0'] },
    ]);
    expect(matchOf(await generated.buildQuery({ meta: term('label', 'IS_EMPTY') }, OrderType))).toEqual({ 'meta.label': emptyString });
  });

  test.each([
    ['generated', 'bad'],
    ['generated', 12],
    ['schema-less', 12],
    ['schema-less', 'aaaaaaaaaaaa'],
  ])('rejects a malformed embedded id on a %s model: %j', async (name, value) => {
    const built = name === 'generated' ? generated : schemaLess;
    await expectRejection(built.buildQuery({ line: term('id', 'EQ', value) }, OrderType), 'INVALID_FILTER_VALUE');
  });
});

describe('MongoDB fields named like query controls', () => {
  const CollisionType = new GraphQLObjectType({
    name: 'QueryPathCollision',
    fields: {
      id: idField,
      key: { type: GraphQLString },
      conditions: { type: GraphQLString },
      aggregation: { type: GraphQLInt },
    },
  });
  const collisionQueries = createMongoQueries({
    getModel: (type) => (type === CollisionType ? modelFor('collisions') : null), getRegistrations: () => [],
  });

  test('filters a field named aggregation on find and count, and keeps the expression on aggregate', async () => {
    const filter = { aggregation: { operator: 'GT', value: 5 } };
    expect(matchOf(await collisionQueries.buildQuery(filter, CollisionType))).toEqual({ aggregation: { $gt: 5 } });
    expect(await collisionQueries.buildQuery(filter, CollisionType, true))
      .toEqual([{ $match: { aggregation: { $gt: 5 } } }, { $count: 'size' }]);

    const expression = { groupId: 'key', facts: [{ operation: 'SUM', factName: 'total', path: 'aggregation' }] };
    const grouped = await collisionQueries.buildAggregationQuery({
      aggregation: expression,
      AND: [{ conditions: [{ field: 'aggregation', operator: 'LT', value: 9 }] }],
    }, CollisionType, expression);
    expect(matchOf(grouped)).toEqual({ aggregation: { $lt: 9 } });
    expect(groupOf(grouped)).toEqual({ _id: '$key', fact_0: { $sum: '$aggregation' } });
  });

  test('filters a top-level field named conditions and keeps conditions a group list inside groups', async () => {
    expect(matchOf(await collisionQueries.buildQuery({ conditions: { value: 'c1' } }, CollisionType)))
      .toEqual({ conditions: 'c1' });
    await expectRejection(collisionQueries.buildQuery({ AND: [{ conditions: {} }] }, CollisionType), 'INVALID_FILTER_VALUE');
    await expectRejection(collisionQueries.buildQuery({ AND: {} }, CollisionType), 'INVALID_FILTER_VALUE');
  });

  test('rejects aggregation and conditions on find for types without those fields', async () => {
    await expectRejection(queries.buildQuery({ aggregation: { groupId: 'title', facts: [count] } }, NoteType), 'INVALID_FILTER_FIELD');
    await expectRejection(queries.buildQuery({ conditions: 'x' }, NoteType), 'INVALID_FILTER_FIELD');
    // Aggregate queries still read `aggregation` as the expression.
    expect(groupOf(await aggregate({ groupId: 'title', facts: [count] }, { aggregation: { groupId: 'title', facts: [count] } })))
      .toEqual({ _id: '$title', fact_0: { $sum: 1 } });
  });
});

describe('MongoDB filters on NonNull object fields', () => {
  const NnAuthorType = new GraphQLObjectType({
    name: 'QueryPathNnAuthor',
    fields: { id: idField, name: { type: GraphQLString } },
  });
  const NnMetaType = new GraphQLObjectType({ name: 'QueryPathNnMeta', fields: { label: { type: GraphQLString } } });
  const NnReviewType = new GraphQLObjectType({
    name: 'QueryPathNnReview',
    fields: { id: idField, stars: { type: GraphQLInt } },
  });
  const NnBookType = new GraphQLObjectType({
    name: 'QueryPathNnBook',
    fields: {
      id: idField,
      pages: { type: new GraphQLNonNull(GraphQLInt) },
      author: { type: new GraphQLNonNull(NnAuthorType), extensions: { relation: { embedded: false } } },
      meta: { type: new GraphQLNonNull(NnMetaType), extensions: { relation: { embedded: true } } },
      reviews: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(NnReviewType))),
        extensions: { relation: { embedded: false, connectionField: 'bookKey' } },
      },
    },
  });
  const nnModels = new Map([
    [NnBookType, modelFor('books')], [NnAuthorType, modelFor('authors')], [NnReviewType, modelFor('reviews')],
  ]);
  const nnQueries = createMongoQueries({ getModel: (type) => nnModels.get(type) ?? null, getRegistrations: () => [] });
  const authorLookup = [
    { $lookup: { from: 'authors', foreignField: '_id', localField: 'author', as: '__sf_l0' } },
    { $unwind: { path: '$__sf_l0', preserveNullAndEmptyArrays: true } },
  ];

  test('rejects a NonNull object condition without a path and a path on a NonNull scalar condition', async () => {
    for (const field of ['author', 'meta', 'reviews']) {
      await expectRejection(nnQueries.buildFilterGroupMatch({ conditions: [{ field, value: 'x' }] }, NnBookType, [], {}),
        'MISSING_FILTER_PATH');
    }
    await expectRejection(nnQueries.buildFilterGroupMatch({ conditions: [{ field: 'pages', path: 'x', value: 1 }] },
      NnBookType, [], {}), 'INVALID_FILTER_PATH');
  });

  test('resolves NonNull reference, embedded and list collection conditions through their paths', async () => {
    const clauses = [];
    const included = {};
    const match = await nnQueries.buildFilterGroupMatch({
      conditions: [
        { field: 'author.name', value: 'Ann' },
        { field: 'meta', path: 'label', value: 'x' },
        { field: 'reviews.stars', operator: 'GTE', value: 4 },
      ],
    }, NnBookType, clauses, included);
    expect(match).toEqual({ $and: [{ '__sf_l0.name': 'Ann' }, { 'meta.label': 'x' }, { '__sf_q0.0': { $exists: true } }] });
    expect(clauses).toEqual([...authorLookup, frame('reviews', '_id', 'bookKey', '__sf_q0', [{ $match: { stars: { $gte: 4 } } }])]);
    expect(included).toEqual({ __sf_l0: true, __sf_q0: true });
  });

  test('tests NonNull fields themselves with the emptiness operators, and their references and collections through frames', async () => {
    expect(matchOf(await nnQueries.buildQuery({ meta: { terms: [{ operator: 'IS_EMPTY' }] }, pages: { operator: 'IS_NOT_EMPTY' } }, NnBookType)))
      .toEqual({ $or: [{ meta: null }, { $and: [{ 'meta.label': { $in: [null, ''] } }] }], pages: { $ne: null } });
    expect(await nnQueries.buildFilterGroupMatch({ conditions: [{ field: 'meta', operator: 'IS_NOT_EMPTY' }] }, NnBookType, [], {}))
      .toEqual({ $nor: [{ $or: [{ meta: null }, { $and: [{ 'meta.label': { $in: [null, ''] } }] }] }] });
    // A reference is empty when no record it points to exists; a collection, when no child points to the record. A
    // collection frame also tests its local key, since $lookup matches a missing one with every child whose
    // connection field is null.
    const forms = {
      author: [frame('authors', 'author', '_id', '__sf_q0'), none('__sf_q0')],
      reviews: [frame('reviews', '_id', 'bookKey', '__sf_q0'), { $or: [{ _id: null }, none('__sf_q0')] }],
    };
    for (const [field, [lookup, empty]] of Object.entries(forms)) {
      const clauses = [];
      const included = {};
      expect(await nnQueries.buildFilterGroupMatch({ conditions: [{ field, operator: 'IS_EMPTY' }] }, NnBookType, clauses, included)).toStrictEqual(empty);
      expect(clauses).toStrictEqual([lookup]);
      expect(included).toEqual({ __sf_q0: true });
      expect(await nnQueries.buildQuery({ [field]: { terms: [{ operator: 'IS_NOT_EMPTY' }] } }, NnBookType)).toStrictEqual([
        lookup, { $match: { $nor: [empty] } }, ...PAGE, { $unset: ['__sf_q0'] },
      ]);
      // Only trusted code writes an operator on the object filter itself.
      await expectRejection(nnQueries.buildQuery({ [field]: { operator: 'IS_EMPTY' } }, NnBookType), 'MISSING_FILTER_PATH');
    }
  });

  test('requires terms on flat NonNull object filters and resolves their paths', async () => {
    await expectRejection(nnQueries.buildQuery({ meta: { value: 'x' } }, NnBookType), 'MISSING_FILTER_PATH');
    const pipeline = await nnQueries.buildQuery({
      author: { terms: [{ path: 'name', value: 'Ann' }] },
      meta: { terms: [{ path: 'label', value: 'x' }] },
      reviews: { terms: [{ path: 'stars', operator: 'GTE', value: 4 }] },
    }, NnBookType);
    expect(lookups(pipeline)).toEqual([authorLookup[0].$lookup, frame('reviews', '_id', 'bookKey', '__sf_q0', [{ $match: { stars: { $gte: 4 } } }]).$lookup]);
    expect(matchOf(pipeline)).toEqual({ $and: [{ '__sf_l0.name': 'Ann', 'meta.label': 'x' }, { '__sf_q0.0': { $exists: true } }] });
  });
});

describe('MongoDB emptiness paths', () => {
  const emptyString = { $in: [null, ''] };
  // Types that describeModels rejects, which MongoDB's default mode still serves.
  const Shape = new GraphQLInterfaceType({ name: 'QueryPathShape', fields: { label: { type: GraphQLString } } });
  const Circle = new GraphQLObjectType({ name: 'QueryPathCircle', interfaces: [Shape], fields: { label: { type: GraphQLString } } });
  const Either = new GraphQLUnionType({ name: 'QueryPathEither', types: [Circle] });
  const embedded = { relation: { embedded: true } };
  const WithShape = new GraphQLObjectType({ name: 'QueryPathWithShape', fields: { label: { type: GraphQLString }, shape: { type: Shape } } });
  const WithChildren = new GraphQLObjectType({
    name: 'QueryPathWithChildren',
    fields: { title: { type: GraphQLString }, children: { type: new GraphQLList(ChildType), extensions: { relation: { embedded: false, connectionField: 'holderKey' } } } },
  });
  const Node = new GraphQLObjectType({
    name: 'QueryPathNode', fields: () => ({ label: { type: GraphQLString }, child: { type: Node, extensions: { ...embedded, readOnly: true } } }),
  });
  const Tree = new GraphQLObjectType({
    name: 'QueryPathTree', fields: () => ({ label: { type: GraphQLString }, children: { type: new GraphQLList(Tree), extensions: embedded } }),
  });
  const Loose = new GraphQLObjectType({ name: 'QueryPathLoose', fields: { a: { type: GraphQLInt } } });
  const HolderType = new GraphQLObjectType({
    name: 'QueryPathHolder',
    fields: {
      id: idField,
      shape: { type: Shape },
      shapes: { type: new GraphQLList(Shape) },
      either: { type: new GraphQLList(Either) },
      withShape: { type: WithShape, extensions: embedded },
      withChildren: { type: WithChildren, extensions: embedded },
      node: { type: Node, extensions: embedded },
      tree: { type: Tree, extensions: embedded },
      // An object field without a relation is read as embedded.
      loose: { type: Loose },
      virtualLabel: { type: GraphQLString, resolve: () => 'v', extensions: { virtual: true } },
    },
  });
  const holderQueries = createMongoQueries({ getModel: (type) => (type === HolderType ? modelFor('holders') : null), getRegistrations: () => [] });
  const holder = (path, operator = 'IS_EMPTY') => holderQueries.buildQuery({ AND: [{ conditions: [{ field: path, operator }] }] }, HolderType);

  test.each([
    // An interface or union field, on the path or among the members (rule 3).
    ['shape', 'INVALID_FILTER_PATH'], ['shapes', 'INVALID_FILTER_PATH'], ['either', 'INVALID_FILTER_PATH'],
    ['withShape', 'INVALID_FILTER_PATH'],
    // Inside a list.
    ['tree.children.label', 'INVALID_FILTER_PATH'],
    // Re-entry through a single embedded member (rule 4).
    ['node', 'INVALID_FILTER_OPERATOR'], ['node.child', 'INVALID_FILTER_OPERATOR'],
    // A collection member and a collection end whose target has no model here, as resolveQueryPath rejects it.
    ['withChildren', 'INVALID_FILTER_PATH'], ['withChildren.children', 'INVALID_FILTER_PATH'],
  ])('rejects %s with %s', async (path, code) => {
    await expectRejection(holder(path), code);
    await expectRejection(holder(path, 'IS_NOT_EMPTY'), code);
  });

  // QLTypeFilterExpression also gives interface and union lists terms. An emptiness term there tests the field itself
  // or a path through it, which rules 3 and 1 reject with the runtime gate's codes and messages.
  test.each(['shapes', 'either'])('rejects emptiness terms on the %s list as the gate does', async (field) => {
    const rejection = (filter) => holderQueries.buildQuery({ [field]: filter }, HolderType).then(() => null, (caught) => caught);
    const outcome = async (filter) => {
      const error = await rejection(filter);
      expect(error, JSON.stringify(filter)).toBeInstanceOf(SimfinityError);
      return [error.extensions.code, error.message];
    };
    for (const operator of ['IS_EMPTY', 'IS_NOT_EMPTY']) {
      const itself = ['INVALID_FILTER_PATH', `${operator} cannot test ${field}: ${field} is an interface or union field, whose emptiness is not defined`];
      const through = ['INVALID_FILTER_PATH', `Field ${field} cannot be traversed`];
      for (const path of [undefined, null, '']) expect(await outcome({ terms: [{ path, operator }] })).toEqual(itself);
      expect(await outcome({ terms: [{ path: 'label', operator }] })).toEqual(through);
      // Every emptiness term is checked, after the terms of other operators too.
      expect(await outcome({ terms: [{ path: 'label', operator: 'EQ', value: 'x' }, { path: 'label', operator, value: null }] })).toEqual(through);
      // An operator beside the terms comes first, as the gate reads it.
      expect(await outcome({ operator, terms: [{ path: 'label', operator: 'IS_EMPTY' }] })).toEqual(itself);
    }
    // Other operators keep reading the filter as a value.
    expect(await outcome({ terms: [{ path: 'label', value: 'x' }] })).toEqual(['INVALID_FILTER_VALUE', `Expected a scalar value for ${field}`]);
  });

  test.each(['shape', 'shapes', 'either'])('pin: compiles the actual ordinary abstract %s carrier and ignores ordinary terms', async (field) => {
    for (const [filter, expected] of [
      [{ value: null }, null],
      [{ value: null, terms: [] }, null],
      [{ value: null, terms: [{ path: 'label', value: 'ignored' }] }, null],
      [{ operator: 'NE', value: null, terms: [{ path: 'missing.path', operator: 'UNKNOWN' }] }, { $ne: null }],
      [{ operator: 'IN', value: [], terms: [] }, { $in: [] }],
    ]) expect(await holderQueries.buildQuery({ [field]: filter }, HolderType)).toEqual([{ $match: { [field]: expected } }, ...PAGE]);
    for (const [filter, message] of [
      [{ terms: [] }, `Expected a scalar value for ${field}`],
      [{ terms: [{ path: 'label', value: 'ignored' }] }, `Expected a scalar value for ${field}`],
      [{ value: 'x', terms: [] }, `Invalid value for ${field}`],
    ]) {
      const error = await holderQueries.buildQuery({ [field]: filter }, HolderType).then(() => null, (caught) => caught);
      expect(error?.extensions).toMatchObject({ code: 'INVALID_FILTER_VALUE', status: 400 });
      expect(error?.message).toBe(message);
    }
    // Ignored ordinary terms never hide an emptiness term, even when the actual carrier has no value.
    const error = await holderQueries.buildQuery({ [field]: { terms: [{ path: 'ignored', value: 1 }, { operator: 'IS_EMPTY' }] } }, HolderType).then(() => null, (caught) => caught);
    expect(error?.message).toBe(`IS_EMPTY cannot test ${field}: ${field} is an interface or union field, whose emptiness is not defined`);
  });

  // Paths that other operators already reject with the same code.
  test.each([
    ['virtualLabel', 'INVALID_FILTER_FIELD'], ['nope', 'INVALID_FILTER_FIELD'], ['loose.b', 'INVALID_FILTER_FIELD'],
    ['shape.label', 'INVALID_FILTER_PATH'], ['withChildren.children.n', 'INVALID_FILTER_PATH'],
  ])('keeps %s rejected with %s (regression pin, passes on 3.9.0)', async (path, code) => {
    await expectRejection(holder(path), code);
    await expectRejection(holder(path, 'IS_NOT_EMPTY'), code);
  });

  test('accepts leaves next to those members, lists that reach their own type, and object fields without a relation', async () => {
    expect(matchOf(await holder('withShape.label'))).toEqual({ 'withShape.label': emptyString });
    expect(matchOf(await holder('withChildren.title', 'IS_NOT_EMPTY'))).toEqual({ 'withChildren.title': { $nin: [null, ''] } });
    expect(matchOf(await holder('node.child.child.label'))).toEqual({ 'node.child.child.label': emptyString });
    const tree = { $or: [{ tree: null }, { $and: [{ 'tree.label': emptyString }, { 'tree.children.0': { $exists: false } }] }] };
    expect(matchOf(await holder('tree'))).toEqual(tree);
    expect(matchOf(await holder('tree', 'IS_NOT_EMPTY'))).toEqual({ $nor: [tree] });
    expect(matchOf(await holder('loose'))).toEqual({ $or: [{ loose: null }, { $and: [{ 'loose.a': null }] }] });
  });

  // Without a client scope marker, from a direct call, references and collections read stored data: crossings share the
  // lookup aliases of the other operators, and ends and members are frames.
  test('compiles references and collections with stored semantics, crossed, reached or as members', async () => {
    const userJoin = [
      { $lookup: { from: 'users', foreignField: '_id', localField: 'owner', as: '__sf_l0' } },
      { $unwind: { path: '$__sf_l0', preserveNullAndEmptyArrays: true } },
    ];
    // `[stages, IS_EMPTY form, IS_NOT_EMPTY form]`; the IS_NOT_EMPTY form of a reference, a collection or an object is the
    // $nor of its IS_EMPTY form.
    const cases = {
      owner: [[frame('users', 'owner', '_id', '__sf_q0')], none('__sf_q0')],
      'owner.name': [userJoin, { '__sf_l0.name': emptyString }, { '__sf_l0.name': { $nin: [null, ''] } }],
      // The joined `_id` is the record identity, so it takes the null rule.
      'owner.id': [userJoin, { '__sf_l0._id': null }, { '__sf_l0._id': { $ne: null } }],
      'owner.address': [[...userJoin, frame('addresses', '__sf_l0.address', '_id', '__sf_q0')], none('__sf_q0')],
      'owner.address.name': [[
        ...userJoin,
        { $lookup: { from: 'addresses', foreignField: '_id', localField: '__sf_l0.address', as: '__sf_l1' } },
        { $unwind: { path: '$__sf_l1', preserveNullAndEmptyArrays: true } },
      ], { '__sf_l1.name': emptyString }, { '__sf_l1.name': { $nin: [null, ''] } }],
      children: [[frame('children', '_id', 'noteKey', '__sf_q0')], { $or: [{ _id: null }, none('__sf_q0')] }],
      meta: [[frame('users', 'meta.ref', '_id', '__sf_q0')], { $or: [{ meta: null }, { $and: [{ 'meta.label': emptyString }, none('__sf_q0')] }] }],
      'meta.ref': [[frame('users', 'meta.ref', '_id', '__sf_q0')], none('__sf_q0')],
      valueOf: [[frame('addresses', 'valueOf', '_id', '__sf_q0')], none('__sf_q0')],
    };
    for (const [path, [stages, empty, notEmpty = { $nor: [empty] }]] of Object.entries(cases)) {
      const [head, ...rest] = path.split('.');
      for (const [operator, match] of [['IS_EMPTY', empty], ['IS_NOT_EMPTY', notEmpty]]) {
        const clauses = [];
        const included = {};
        const built = await queries.buildFilterGroupMatch({ conditions: [{ field: head, path: rest.join('.'), operator }] }, NoteType, clauses, included);
        expect(built, `${path} ${operator}`).toStrictEqual(match);
        expect(clauses, `${path} ${operator}`).toStrictEqual(stages);
        expect(Object.keys(included), `${path} ${operator}`).toEqual(stages.filter((stage) => stage.$lookup).map((stage) => stage.$lookup.as));
        // The same term in a field filter, with the stages before the $match and their aliases unset at the end.
        const term = { ...(rest.length ? { path: rest.join('.') } : {}), operator };
        expect(await queries.buildQuery({ [head]: { terms: [term] } }, NoteType), `${path} ${operator}`)
          .toStrictEqual([...stages, { $match: match }, ...PAGE, { $unset: Object.keys(included) }]);
      }
    }
  });

  // The joined `_id` is the target's identity whatever its declared scalar: an application scalar keeps the plain null
  // form there, as at the root, and an embedded `id` member of the target follows the target's schema.
  test('reads the identity and embedded id members of a joined target from its own schema', async () => {
    const Json = new GraphQLScalarType({ name: 'QueryPathIdJson', serialize: (value) => value, parseValue: (value) => value });
    const Tag = new GraphQLObjectType({ name: 'QueryPathIdTag', fields: { id: idField, label: { type: GraphQLString } } });
    const Target = new GraphQLObjectType({
      name: 'QueryPathIdTarget', fields: { id: { type: Json }, tag: { type: Tag, extensions: { relation: { embedded: true } } } },
    });
    const Source = new GraphQLObjectType({
      name: 'QueryPathIdSource', fields: { id: idField, target: { type: Target, extensions: { relation: { embedded: false } } } },
    });
    // The target's subdocument schema stores only `_id`, so its `tag.id` is `tag._id`.
    const targetModel = { collection: { collectionName: 'targets' }, schema: new mongoose.Schema({ tag: new mongoose.Schema({ label: String }) }) };
    const built = createMongoQueries({
      getModel: (type) => (type === Source ? modelFor('sources') : type === Target ? targetModel : null), getRegistrations: () => [],
    });
    const join = [
      { $lookup: { from: 'targets', foreignField: '_id', localField: 'target', as: '__sf_l0' } },
      { $unwind: { path: '$__sf_l0', preserveNullAndEmptyArrays: true } },
    ];
    const match = async (path, operator) => {
      const pipeline = await built.buildQuery({ AND: [{ conditions: [{ field: path, operator }] }] }, Source);
      expect(pipeline.slice(0, 2), path).toStrictEqual(join);
      return pipeline[2].$match;
    };
    expect(await match('target.id', 'IS_EMPTY')).toStrictEqual({ '__sf_l0._id': null });
    expect(await match('target.id', 'IS_NOT_EMPTY')).toStrictEqual({ '__sf_l0._id': { $ne: null } });
    expect(await match('target.tag.id', 'IS_EMPTY')).toStrictEqual({ '__sf_l0.tag._id': null });
    expect(await match('target.tag', 'IS_EMPTY'))
      .toStrictEqual({ $or: [{ '__sf_l0.tag': null }, { $and: [{ '__sf_l0.tag._id': null }, { '__sf_l0.tag.label': emptyString }] }] });
  });

  // As resolveQueryPath rejects other operators there, before any lookup is added.
  test.each([
    ['ghost', 'queries'], ['ghost.name', 'queries'], ['withChildren', 'holder'], ['withChildren.children', 'holder'],
  ])('rejects %s, whose related model is not available, with INVALID_FILTER_PATH and no lookup', async (path, on) => {
    const [built, type] = on === 'queries' ? [queries, NoteType] : [holderQueries, HolderType];
    const [head, ...rest] = path.split('.');
    for (const operator of ['IS_EMPTY', 'IS_NOT_EMPTY']) {
      const clauses = [];
      const included = {};
      const error = await built.buildFilterGroupMatch({ conditions: [{ field: head, path: rest.join('.'), operator }] }, type, clauses, included)
        .then(() => null, (caught) => caught);
      expect([error?.extensions?.code, error?.message]).toEqual(['INVALID_FILTER_PATH', `Related model is not available for ${path}`]);
      expect(clauses).toEqual([]);
      expect(included).toEqual({});
      await expectRejection(built.buildQuery({ [head]: { terms: [{ ...(rest.length ? { path: rest.join('.') } : {}), operator }] } }, type), 'INVALID_FILTER_PATH');
    }
  });

  test('keeps the code of other operators on a relation whose model is not available (regression pin, passes on 3.10.0)', async () => {
    await expectRejection(queries.buildQuery({ ghost: { terms: [{ path: 'name', value: 'x' }] } }, NoteType), 'INVALID_FILTER_PATH');
  });

  // A collection member inside an embedded type, which only a supplied model reaches (describeModels rejects it): a
  // frame on the embedded object's `_id`, as legacy paths join it, with the null guard.
  test('compiles a collection member inside an embedded type as a frame on the object _id', async () => {
    const supplied = createMongoQueries({
      getModel: (type) => (type === HolderType ? modelFor('holders') : type === ChildType ? modelFor('children') : null), getRegistrations: () => [],
    });
    const lookup = frame('children', 'withChildren._id', 'holderKey', '__sf_q0');
    const member = { $or: [{ 'withChildren._id': null }, none('__sf_q0')] };
    const object = { $or: [{ withChildren: null }, { $and: [{ 'withChildren.title': emptyString }, member] }] };
    for (const [path, empty] of [['withChildren', object], ['withChildren.children', member]]) {
      expect(await supplied.buildQuery({ AND: [{ conditions: [{ field: path, operator: 'IS_EMPTY' }] }] }, HolderType)).toStrictEqual([
        lookup, { $match: empty }, ...PAGE, { $unset: ['__sf_q0'] },
      ]);
      expect(matchOf(await supplied.buildQuery({ AND: [{ conditions: [{ field: path, operator: 'IS_NOT_EMPTY' }] }] }, HolderType)))
        .toStrictEqual({ $nor: [empty] });
    }
  });

  test('compiles String scalars by their base scalar, and other scalars by the null rule', async () => {
    expect(matchOf(await queries.buildQuery({
      workEmail: { operator: 'IS_EMPTY' }, strictWork: { operator: 'IS_NOT_EMPTY' }, due: { operator: 'IS_EMPTY' }, price: { operator: 'IS_NOT_EMPTY' },
    }, NoteType))).toEqual({ workEmail: emptyString, strictWork: { $nin: [null, ''] }, due: null, price: { $ne: null } });
  });
});

const mongoUri = process.env.SIMFINITY_TEST_MONGODB_URI;

describe.skipIf(!mongoUri)('MongoDB relation queries against a database', () => {
  const suffix = `${process.pid}_${Date.now()}`;
  const ownerId = new mongoose.Types.ObjectId();
  const otherId = new mongoose.Types.ObjectId();
  let connection;
  let adapter;
  let schema;
  let Users;
  let Notes;
  let DbUserType;
  let DbNoteType;

  beforeAll(async () => {
    connection = await mongoose.createConnection(mongoUri).asPromise();
    DbUserType = new GraphQLObjectType({
      name: 'QueryPathDbUser',
      fields: { id: idField, name: { type: GraphQLString }, secret: { type: GraphQLString } },
    });
    DbNoteType = new GraphQLObjectType({
      name: 'QueryPathDbNote',
      fields: () => ({
        id: idField,
        title: { type: GraphQLString },
        price: { type: GraphQLInt },
        owner: { type: DbUserType, extensions: { relation: { embedded: false } } },
      }),
    });
    Users = connection.model(`query_path_users_${suffix}`, new mongoose.Schema({ name: String, secret: String }));
    Notes = connection.model(`query_path_notes_${suffix}`, new mongoose.Schema({
      title: String, price: Number, owner: mongoose.Schema.Types.ObjectId,
    }));
    await Promise.all([Users.createCollection(), Notes.createCollection()]);

    adapter = createMongoAdapter();
    const runtime = createRuntime(adapter);
    runtime.preventCreatingCollection(true);
    runtime.connect(Users, DbUserType, 'queryPathDbUser', 'queryPathDbUsers');
    runtime.connect(Notes, DbNoteType, 'queryPathDbNote', 'queryPathDbNotes');
    schema = runtime.createSchema();
    auth.createAuthPlugin({ QueryPathDbNote: { title: auth.isOwner('owner') } }, { defaultPolicy: 'ALLOW' })
      .onSchemaChange({ schema });
  });

  beforeEach(async () => {
    await Promise.all([Users.deleteMany({}), Notes.deleteMany({})]);
    await Users.create([
      { _id: ownerId, name: 'Ann', secret: 'ann-hash' },
      { _id: otherId, name: 'Bob', secret: 'bob-hash' },
    ]);
    await Notes.create([
      { title: 'A', price: 10, owner: ownerId },
      { title: 'A', price: 20, owner: otherId },
      { title: 'B', price: 10, owner: ownerId },
    ]);
  });

  afterAll(async () => {
    if (!connection) return;
    await Promise.all([Users, Notes].filter(Boolean).map((model) => model.collection.drop().catch(() => {})));
    await connection.close();
  });

  const execute = (source) => graphql({
    schema, source, contextValue: { user: { id: ownerId.toString() } },
  });

  test('returns stored references from relation filters and sorts', async () => {
    const rows = await adapter.find(Notes, DbNoteType, {
      owner: { terms: [{ path: 'name', value: 'Ann' }] },
      sort: { terms: [{ field: 'owner.name', order: 'ASC' }, { field: 'title', order: 'ASC' }] },
    }, null);

    expect(rows.map((row) => row.title)).toEqual(['A', 'B']);
    for (const row of rows) {
      expect(row.owner).toBeInstanceOf(mongoose.Types.ObjectId);
      expect(row.owner.equals(ownerId)).toBe(true);
      expect(Object.keys(row).some((key) => key.startsWith('__sf_'))).toBe(false);
    }
  });

  test('keeps isOwner on the relation field passing for relation-filtered and sorted rows', async () => {
    const filtered = await execute(`{
      queryPathDbNotes(owner: {terms: [{path: "id", value: "${ownerId}"}]}, sort: {terms: [{field: "id", order: ASC}]}) {
        title owner { name }
      }
    }`);
    expect(filtered.errors).toBeUndefined();
    expect(filtered.data.queryPathDbNotes).toEqual([
      { title: 'A', owner: { name: 'Ann' } },
      { title: 'B', owner: { name: 'Ann' } },
    ]);

    const sorted = await execute(`{
      queryPathDbNotes(price: {value: 10}, sort: {terms: [{field: "owner.name", order: DESC}, {field: "id", order: ASC}]}) {
        title
      }
    }`);
    expect(sorted.errors).toBeUndefined();
    expect(sorted.data.queryPathDbNotes).toEqual([{ title: 'A' }, { title: 'B' }]);

    const foreign = await execute('{queryPathDbNotes(owner: {terms: [{path: "name", value: "Bob"}]}) { title }}');
    expect(foreign.errors?.[0]?.message).toBe('Access denied to QueryPathDbNote.title');
  });

  test('groups through relations without exposing whole joined documents', async () => {
    const grouped = await execute(`{
      queryPathDbNotes_aggregate(aggregation: {groupId: "owner.name", facts: [
        {operation: COUNT, factName: "n", path: "id"},
        {operation: SUM, factName: "_id", path: "price"}
      ]}) { groupId facts }
    }`);
    expect(grouped.errors).toBeUndefined();
    expect(grouped.data.queryPathDbNotes_aggregate).toEqual([
      { groupId: 'Ann', facts: { n: 2, _id: 20 } },
      { groupId: 'Bob', facts: { n: 1, _id: 20 } },
    ]);

    const byTitle = await execute(`{
      queryPathDbNotes_aggregate(aggregation: {groupId: "title", facts: [{operation: SUM, factName: "_id", path: "price"}]}) {
        groupId facts
      }
    }`);
    // isOwner on title needs a parent, so title cannot become a group key.
    expect(byTitle.errors?.[0]?.message).toBe('Access denied to QueryPathDbNote.title');
    expect(byTitle.data?.queryPathDbNotes_aggregate ?? null).toBeNull();

    for (const aggregation of [
      '{groupId: "owner", facts: [{operation: COUNT, factName: "n", path: "id"}]}',
      '{groupId: "price", facts: [{operation: MAX, factName: "m", path: "owner"}]}',
    ]) {
      const leaked = await execute(`{queryPathDbNotes_aggregate(aggregation: ${aggregation}) { groupId facts }}`);
      expect(leaked.data?.queryPathDbNotes_aggregate ?? null).toBeNull();
      expect(leaked.errors?.[0]?.extensions).toMatchObject({ status: 400 });
      expect(JSON.stringify(leaked)).not.toContain('hash');
    }
  });

  describe('a relation-free type that another runtime connects', () => {
    let Holders;
    let sharedSchema;

    beforeAll(async () => {
      const SharedTag = new GraphQLObjectType({
        name: 'QueryPathSharedTag',
        fields: { id: idField, name: { type: GraphQLString } },
      });
      const SharedHolder = new GraphQLObjectType({
        name: 'QueryPathSharedHolder',
        fields: {
          id: idField,
          name: { type: GraphQLString },
          tags: { type: new GraphQLList(SharedTag), extensions: { relation: { embedded: true } } },
        },
      });
      // Same shape as a generated model: list items are subdocuments with an automatic `_id` beside `id`.
      Holders = connection.model(`query_path_shared_holders_${suffix}`, new mongoose.Schema({
        name: String, tags: [{ id: mongoose.Schema.Types.ObjectId, name: String }],
      }));
      const Tags = connection.model(`query_path_shared_tags_${suffix}`, new mongoose.Schema({ name: String }));
      await Holders.createCollection();

      // Runtime A embeds the type as a list. Runtime B connects the same type object, so the entity id
      // resolver it installs, which reads the subdocument `_id`, also serves runtime A's reads.
      const runtimeA = createRuntime(createMongoAdapter());
      runtimeA.preventCreatingCollection(true);
      runtimeA.addNoEndpointType(SharedTag);
      runtimeA.connect(Holders, SharedHolder, 'queryPathSharedHolder', 'queryPathSharedHolders');
      sharedSchema = runtimeA.createSchema();
      const runtimeB = createRuntime(createMongoAdapter());
      runtimeB.preventCreatingCollection(true);
      runtimeB.connect(Tags, SharedTag, 'queryPathSharedTag', 'queryPathSharedTags');
      runtimeB.createSchema();
    });

    afterAll(async () => {
      await Holders?.collection.drop().catch(() => {});
    });

    test('filters embedded list items by the id that reads show', async () => {
      const declaredId = new mongoose.Types.ObjectId().toString();
      await Holders.create([
        { name: 'h', tags: [{ id: declaredId, name: 't' }] },
        { name: 'other', tags: [{ id: new mongoose.Types.ObjectId(), name: 'u' }] },
      ]);
      const run = (source) => graphql({ schema: sharedSchema, source, contextValue: {} });

      const listed = await run('{ queryPathSharedHolders(name: {value: "h"}) { tags { id } } }');
      expect(listed.errors).toBeUndefined();
      const shown = listed.data.queryPathSharedHolders[0].tags[0].id;
      expect(shown).not.toBe(declaredId);

      for (const value of [shown, declaredId]) {
        const filtered = await run(`{
          queryPathSharedHolders(tags: {terms: [{path: "id", operator: EQ, value: "${value}"}]}) { name tags { id } }
        }`);
        expect(filtered.errors).toBeUndefined();
        expect(filtered.data.queryPathSharedHolders).toEqual(value === shown ? [{ name: 'h', tags: [{ id: shown }] }] : []);
      }
    });
  });

  describe('a read-only collection without a connectionField', () => {
    let Owners;
    let Things;
    let fallbackSchema;

    beforeAll(async () => {
      const Thing = new GraphQLObjectType({
        name: 'QueryPathFallbackThing',
        fields: { id: idField, label: { type: GraphQLString } },
      });
      const Owner = new GraphQLObjectType({
        name: 'QueryPathFallbackOwner',
        fields: {
          id: idField,
          label: { type: GraphQLString },
          things: { type: new GraphQLList(Thing), extensions: { readOnly: true, relation: { embedded: false } } },
        },
      });
      // Children store their owner under the collection's field name.
      Things = connection.model(`query_path_fallback_things_${suffix}`, new mongoose.Schema({
        label: String, things: mongoose.Schema.Types.ObjectId,
      }));
      Owners = connection.model(`query_path_fallback_owners_${suffix}`, new mongoose.Schema({ label: String }));
      await Promise.all([Things.createCollection(), Owners.createCollection()]);

      const runtime = createRuntime(createMongoAdapter());
      runtime.preventCreatingCollection(true);
      runtime.connect(Things, Thing, 'queryPathFallbackThing', 'queryPathFallbackThings');
      runtime.connect(Owners, Owner, 'queryPathFallbackOwner', 'queryPathFallbackOwners');
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        fallbackSchema = runtime.createSchema();
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(
          /^Configuration issue: QueryPathFallbackOwner\.things requires a child connectionField/,
        ));
      } finally {
        warn.mockRestore();
      }
    });

    afterAll(async () => {
      await Promise.all([Things, Owners].filter(Boolean).map((model) => model.collection.drop().catch(() => {})));
    });

    test('reads and filters children stored under the field name', async () => {
      const [first, second] = await Owners.create([{ label: 'a' }, { label: 'b' }]);
      await Things.create([{ label: 'x', things: first._id }, { label: 'y', things: second._id }]);
      const run = (source) => graphql({ schema: fallbackSchema, source, contextValue: {} });

      const read = await run('{ queryPathFallbackOwners(sort: {terms: [{field: "label", order: ASC}]}) { label things { label } } }');
      expect(read.errors).toBeUndefined();
      expect(read.data.queryPathFallbackOwners).toEqual([
        { label: 'a', things: [{ label: 'x' }] },
        { label: 'b', things: [{ label: 'y' }] },
      ]);

      const filtered = await run('{ queryPathFallbackOwners(things: {terms: [{path: "label", value: "x"}]}) { label } }');
      expect(filtered.errors).toBeUndefined();
      expect(filtered.data.queryPathFallbackOwners).toEqual([{ label: 'a' }]);
    });
  });
});


describe('phase3 shared gate compatibility', () => {
  test.each([
    ['price', 'GT', 1], ['owner.name', 'EQ', 'Ann'], ['owner.address.name', 'NE', 'Office'],
  ])('pin: retains the ordinary root marker diagnostic for %s', async (field, operator, value) => {
    const message = `${operator} on ${field} carries a client scope marker, but is not an emptiness condition; only the runtime writes and fills client scope markers (docs/guide/middleware.md)`;
    for (const marker of [null, { id: 0 }, { id: 0, scopes: {} }, { scopes: { owner: null } }]) {
      const error = await queries.buildQuery({ AND: [{ conditions: [{ field, operator, value, __scope: marker }] }] }, NoteType).then(() => null, (caught) => caught);
      expect(error?.extensions).toMatchObject({ code: 'DETACHED_CLIENT_FILTER', status: 500 });
      expect(error?.message).toBe(message);
    }
  });
  test('pin: retains full virtual paths for group and object-filter diagnostics', async () => {
    const Inner = new GraphQLObjectType({ name: 'GateVirtualInner', fields: {
      w: { type: GraphQLInt }, ghost: { type: GraphQLString, resolve: () => 'v', extensions: { virtual: true } },
    } });
    const Root = new GraphQLObjectType({ name: 'GateVirtualRoot', fields: {
      id: idField, dims: { type: Inner, extensions: { relation: { embedded: true } } },
      vobj: { type: Inner, resolve: () => null, extensions: { virtual: true } },
    } });
    const compiler = createMongoQueries({ getModel: () => modelFor('virtuals'), getRegistrations: () => [] });
    for (const [input, path, owner, field] of [
      [{ AND: [{ conditions: [{ field: 'vobj.w', operator: 'IS_EMPTY' }] }] }, 'vobj.w', Root.name, 'vobj'],
      [{ AND: [{ conditions: [{ field: 'dims.ghost', operator: 'IS_EMPTY' }] }] }, 'dims.ghost', Inner.name, 'ghost'],
      [{ vobj: { terms: [{ path: 'w', operator: 'IS_EMPTY' }] } }, 'vobj.w', Root.name, 'vobj'],
      [{ vobj: { terms: [{ path: 'w', value: 1 }] } }, 'vobj.w', Root.name, 'vobj'],
      [{ vobj: { operator: 'IS_EMPTY', terms: [{ path: 'w', operator: 'IS_EMPTY' }] } }, 'vobj', Root.name, 'vobj'],
    ]) {
      const error = await compiler.buildQuery(input, Root).then(() => null, (caught) => caught);
      expect(error?.extensions).toMatchObject({ code: 'INVALID_FILTER_FIELD', status: 400 });
      expect(error?.message).toBe(`Query path ${path} uses the virtual field ${owner}.${field}, which is not stored`);
    }
  });
});

describe('phase3 round2 native value validation', () => {
  const fixture = ({ cast = false } = {}) => {
    const counts = { coerce: 0, reject: 0, validated: 0, cast: 0 };
    const parsed = { parsed: true };
    const stored = { stored: true };
    const Coerce = new GraphQLScalarType({ name: 'GateCoerce', serialize: (value) => value, parseValue: () => { counts.coerce++; return parsed; } });
    const Reject = new GraphQLScalarType({ name: 'GateReject', serialize: (value) => value, parseValue: () => { counts.reject++; throw new Error('Custom value rejected'); } });
    const Validated = new GraphQLScalarType({ name: 'GateValidated', serialize: (value) => value, parseValue: () => { counts.validated++; throw new Error('Custom validation must not run'); } });
    Validated.baseScalarType = GraphQLString;
    const Shop = new GraphQLObjectType({ name: 'GateValueShop', fields: {
      id: idField, name: { type: GraphQLString }, coerce: { type: Coerce }, reject: { type: Reject }, validated: { type: Validated },
    } });
    const Product = new GraphQLObjectType({ name: 'GateValueProduct', fields: {
      id: idField, shop: { type: Shop, extensions: { relation: { embedded: false } } },
    } });
    const model = { ...modelFor('shops'), ...(cast ? { schema: { path: (path) => path === 'coerce' ? {
      instance: 'Mixed', cast: (value) => { counts.cast++; expect(value).toBe(parsed); return stored; },
    } : undefined } } : {}) };
    const compiler = createMongoQueries({ getModel: (type) => type === Shop ? model : modelFor('products'), getRegistrations: () => [] });
    const run = (field, value, marked = false, operator = 'EQ') => compiler.buildFilterGroupMatch({ conditions: [{
      field: 'shop', path: field, operator, value, ...(marked ? { __scope: { id: 0 } } : {}),
    }] }, Product, [], {});
    const runConditions = (conditions) => compiler.buildFilterGroupMatch({ conditions }, Product, [], {});
    return { counts, parsed, stored, run, runConditions };
  };
  const failure = (promise) => promise.then(() => null, (error) => error);
  test.each([true, false])('pin: preserves GraphQL and model text diagnostics with quantifiers=%s', async (quantifiers) => {
    const f = fixture();
    const error = await failure(f.run('name', null, false, 'ILIKE'));
    expect(error?.extensions).toMatchObject({ code: 'INVALID_FILTER_VALUE', status: 400 });
    expect(error?.message).toBe('ILIKE requires a non-null string value on shop.name');
    const Shop = new GraphQLObjectType({ name: 'GateTextShop', fields: { name: { type: GraphQLString } } });
    const Product = new GraphQLObjectType({ name: 'GateTextProduct', fields: { shop: { type: Shop, extensions: { relation: { embedded: false } } } } });
    const metadata = describeModels([{ gqltype: Product }, { gqltype: Shop }]);
    expect(() => createQueryPlan(metadata, Product.name, { shop: { terms: [{ path: 'name', operator: 'ILIKE', value: null }] } }, { quantifiers, referenceEmptiness: true }))
      .toThrow('Expected a scalar filter value');
  });
  test('pin: rejects native String values before ordinary root markers', async () => {
    const error = await failure(fixture().run('name', 5, true));
    expect(error?.extensions).toMatchObject({ code: 'INVALID_FILTER_VALUE', status: 400 });
    expect(error?.message).toBe('Invalid value for __sf_l0.name');
  });
  test('pin: runs a rejecting custom scalar once before an ordinary root marker', async () => {
    const f = fixture();
    const error = await failure(f.run('reject', 5, true));
    expect(error?.extensions).toMatchObject({ code: 'INVALID_FILTER_VALUE', status: 400 });
    expect(error?.message).toBe('Invalid value for __sf_l0.reject');
    expect(f.counts).toEqual({ coerce: 0, reject: 1, validated: 0, cast: 0 });
  });
  test('pin: parses a coercing custom scalar once on a doomed marked query', async () => {
    const f = fixture();
    const error = await failure(f.run('coerce', 5, true));
    expect(error?.extensions).toMatchObject({ code: 'DETACHED_CLIENT_FILTER', status: 500 });
    expect(error?.message).toContain('EQ on shop.coerce carries a client scope marker, but is not an emptiness condition');
    expect(f.counts).toEqual({ coerce: 1, reject: 0, validated: 0, cast: 0 });
  });
  test.each([false, true])('pin: preserves native failure ordering beside a root marker, markerFirst=%s', async (markerFirst) => {
    const conditions = [
      { field: 'shop', path: 'name', value: 5 },
      { field: 'shop', path: 'name', value: 'x', __scope: { id: 0 } },
    ];
    if (markerFirst) conditions.reverse();
    const error = await failure(fixture().runConditions(conditions));
    expect(error?.extensions).toMatchObject(markerFirst
      ? { code: 'DETACHED_CLIENT_FILTER', status: 500 }
      : { code: 'INVALID_FILTER_VALUE', status: 400 });
    if (!markerFirst) expect(error?.message).toBe('Invalid value for __sf_l0.name');
  });
  test('pin: parses preceding custom conditions once before rejecting an ordinary root marker', async () => {
    const f = fixture({ cast: true });
    const error = await failure(f.runConditions([
      { field: 'shop', path: 'coerce', value: 5 },
      { field: 'shop', path: 'name', value: 'x', __scope: { id: 0 } },
    ]));
    expect(error?.extensions).toMatchObject({ code: 'DETACHED_CLIENT_FILTER', status: 500 });
    expect(f.counts).toEqual({ coerce: 1, reject: 0, validated: 0, cast: 1 });
  });
  test('pin: preserves accepted custom coercion identity with exactly one parse', async () => {
    const f = fixture();
    expect((await f.run('coerce', 5))['__sf_l0.coerce']).toBe(f.parsed);
    expect(f.counts).toEqual({ coerce: 1, reject: 0, validated: 0, cast: 0 });
  });
  test('pin: keeps validated base scalar filters free of custom validation', async () => {
    const f = fixture();
    expect(await f.run('validated', 'x')).toEqual({ '__sf_l0.validated': 'x' });
    expect(await f.run('validated', 'x', false, 'IEQ')).toEqual({ '__sf_l0.validated': { $regex: '^x\\z', $options: 'i' } });
    expect(f.counts).toEqual({ coerce: 0, reject: 0, validated: 0, cast: 0 });
  });
  test.each([false, true])('pin: casts a custom scalar exactly once, preserving native identity, marked=%s', async (marked) => {
    const f = fixture({ cast: true });
    if (marked) expect((await failure(f.run('coerce', 5, true)))?.extensions).toMatchObject({ code: 'DETACHED_CLIENT_FILTER', status: 500 });
    else expect((await f.run('coerce', 5))['__sf_l0.coerce']).toBe(f.stored);
    expect(f.counts).toEqual({ coerce: 1, reject: 0, validated: 0, cast: 1 });
  });
});
