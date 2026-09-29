import {
  afterAll, beforeAll, beforeEach, describe, expect, test,
} from 'vitest';
import mongoose from 'mongoose';
import {
  graphql, GraphQLID, GraphQLInt, GraphQLList, GraphQLObjectType, GraphQLScalarType, GraphQLString,
} from 'graphql';
import {
  auth, createMongoAdapter, createRuntime, createValidatedScalar, SimfinityError,
} from '../packages/mongodb/src/index.js';
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
});
