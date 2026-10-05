import {
  afterAll, beforeAll, beforeEach, describe, expect, test, vi,
} from 'vitest';
import mongoose from 'mongoose';
import {
  graphql, GraphQLID, GraphQLInt, GraphQLList, GraphQLObjectType, GraphQLScalarType, GraphQLString,
} from 'graphql';
import {
  auth, createMongoAdapter, createRuntime, createValidatedScalar, SimfinityError,
} from '../packages/mongodb/src/index.js';
import { markStoredIdentity } from '@simtlix/simfinity-core/internal/relation-storage';
import { createMongoQueries } from '../packages/mongodb/src/mongo/queries.js';

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
