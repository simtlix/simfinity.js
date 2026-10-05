import {
  beforeAll, beforeEach, describe, expect, test, vi,
} from 'vitest';
import mongoose from 'mongoose';
import {
  GraphQLID, GraphQLList, GraphQLObjectType, GraphQLString,
} from 'graphql';
import { createMongoAdapter, createRuntime } from '../packages/mongodb/src/index.js';
import { mapIdCastError } from '../packages/mongodb/src/mongo/ids.js';

const invalidId = { message: 'Invalid identifier', extensions: { code: 'NOT_VALID_ID', status: 400 } };
const objectIdHex = '507f1f77bcf86cd799439011';
// A supplied Number key whose setter maps the client's ID to the stored key.
const setKey = vi.fn((value) => (typeof value === 'string' ? value.replace(/^item-/, '') : value));
// Casts a query's filter as Mongoose does when the query runs.
const castFilter = (query) => query.cast(query.model);
const thrown = (operation) => {
  try {
    operation();
  } catch (error) {
    return error;
  }
  return undefined;
};

const build = () => {
  const adapter = createMongoAdapter();
  const runtime = createRuntime(adapter);
  runtime.preventCreatingCollection(true);
  const Tag = new GraphQLObjectType({
    name: 'MongoIdsTag',
    fields: { id: { type: GraphQLID }, label: { type: GraphQLString } },
  });
  const Child = new GraphQLObjectType({
    name: 'MongoIdsChild',
    fields: { id: { type: GraphQLID }, name: { type: GraphQLString } },
  });
  const Record = new GraphQLObjectType({
    name: 'MongoIdsRecord',
    fields: () => ({
      id: { type: GraphQLID },
      other: { type: GraphQLID },
      others: { type: new GraphQLList(GraphQLID) },
      count: { type: GraphQLString },
      tag: { type: Tag, extensions: { relation: { embedded: true } } },
      tags: { type: new GraphQLList(Tag), extensions: { relation: { embedded: true } } },
      children: { type: new GraphQLList(Child), extensions: { relation: { connectionField: 'owner' } } },
    }),
  });
  const StringKeyed = new GraphQLObjectType({
    name: 'MongoIdsStringKeyed',
    fields: { id: { type: GraphQLID }, title: { type: GraphQLString } },
  });
  const NumberKeyed = new GraphQLObjectType({
    name: 'MongoIdsNumberKeyed',
    fields: { id: { type: GraphQLID }, title: { type: GraphQLString } },
  });
  const SetterKeyed = new GraphQLObjectType({
    name: 'MongoIdsSetterKeyed',
    fields: { id: { type: GraphQLID }, title: { type: GraphQLString } },
  });
  runtime.addNoEndpointType(Tag);
  runtime.connect(null, Child, 'mongoIdsChild', 'mongoIdsChildren');
  runtime.connect(null, Record, 'mongoIdsRecord', 'mongoIdsRecords');
  runtime.connect(mongoose.model('MongoIdsStringKeyed', new mongoose.Schema({ _id: String, title: String })),
    StringKeyed, 'mongoIdsStringKeyed', 'mongoIdsStringKeyeds');
  runtime.connect(mongoose.model('MongoIdsNumberKeyed', new mongoose.Schema({ _id: Number, title: String })),
    NumberKeyed, 'mongoIdsNumberKeyed', 'mongoIdsNumberKeyeds');
  runtime.connect(mongoose.model('MongoIdsSetterKeyed', new mongoose.Schema({
    _id: { type: Number, set: setKey }, title: String,
  })), SetterKeyed, 'mongoIdsSetterKeyed', 'mongoIdsSetterKeyeds');
  runtime.createSchema();
  return {
    adapter,
    Record: runtime.getModel(Record),
    Child: runtime.getModel(Child),
    StringKeyed: runtime.getModel(StringKeyed),
    NumberKeyed: runtime.getModel(NumberKeyed),
    SetterKeyed: runtime.getModel(SetterKeyed),
    types: { Record, Child },
  };
};

describe('MongoDB identifier casts', () => {
  let fixture;

  beforeAll(() => {
    fixture = build();
  });

  test('castId accepts only an ObjectId or its hex form', () => {
    const { castId } = fixture.adapter;
    const id = new mongoose.Types.ObjectId(objectIdHex);
    expect(castId(id).toHexString()).toBe(objectIdHex);
    expect(castId(objectIdHex).toHexString()).toBe(objectIdHex);
    expect(castId(objectIdHex.toUpperCase()).toHexString()).toBe(objectIdHex);
    // An ObjectId from another bson copy carries the same tag and bytes.
    const foreign = { _bsontype: 'ObjectId', id: Buffer.from(id.id), toHexString: () => objectIdHex };
    expect(castId(foreign).toHexString()).toBe(objectIdHex);
    expect(castId(foreign)).toBeInstanceOf(mongoose.Types.ObjectId);
  });

  test.each([
    ['undefined', undefined],
    ['null', null],
    ['zero', 0],
    ['a number', 12],
    ['an empty string', ''],
    ['a 12-character string', 'aaaaaaaaaaaa'],
    ['a malformed string', 'invalid'],
    ['an object', {}],
    ['a 12-byte buffer', Buffer.alloc(12)],
    ['a spoofed ObjectId', { _bsontype: 'ObjectId', toHexString: () => 'zz' }],
  ])('castId rejects %s without minting an identifier', (_, value) => {
    expect(thrown(() => fixture.adapter.castId(value))).toMatchObject(invalidId);
  });

  test('getById, update and delete reject a malformed ID with NOT_VALID_ID when the query runs', async () => {
    for (const query of [
      () => fixture.adapter.getById(fixture.Record, 'invalid'),
      () => fixture.adapter.getById(fixture.Record, 'invalid', null, { plain: true }),
      () => fixture.adapter.getById(fixture.Record, objectIdHex, null, { requiredId: 'invalid' }),
      () => fixture.adapter.update(fixture.Record, 'invalid', { other: null }),
      () => fixture.adapter.delete(fixture.Record, 'invalid'),
      () => fixture.adapter.getById(fixture.NumberKeyed, 'abc'),
    ]) {
      await expect(query()).rejects.toMatchObject(invalidId);
      await expect(query().exec()).rejects.toMatchObject(invalidId);
    }
  });

  test('passes the raw ID to the query, which casts it with the model key type', () => {
    const queries = [
      [fixture.adapter.getById(fixture.Record, objectIdHex), { _id: new mongoose.Types.ObjectId(objectIdHex) }],
      [fixture.adapter.getById(fixture.StringKeyed, 'record-a'), { _id: 'record-a' }],
      [fixture.adapter.update(fixture.StringKeyed, 'record-a', { title: 'B' }), { _id: 'record-a' }],
      [fixture.adapter.delete(fixture.StringKeyed, 'record-a'), { _id: 'record-a' }],
      [fixture.adapter.getById(fixture.NumberKeyed, '12'), { _id: 12 }],
      [fixture.adapter.update(fixture.NumberKeyed, '12', { title: 'B' }), { _id: 12 }],
      [fixture.adapter.delete(fixture.NumberKeyed, '12'), { _id: 12 }],
    ];
    for (const [query, filter] of queries) {
      expect(query.getFilter()).toEqual({ _id: String(filter._id) });
      expect(castFilter(query)).toEqual(filter);
    }
    // A missing ID is passed through unchanged and matches nothing instead of failing.
    expect(fixture.adapter.getById(fixture.Record, undefined).getFilter()._id).toBeUndefined();
  });

  describe('a supplied key with a setter', () => {
    beforeEach(() => setKey.mockClear());

    test('getById, update and delete leave the setter to the query, which runs it once', () => {
      const queries = [
        fixture.adapter.getById(fixture.SetterKeyed, 'item-12'),
        fixture.adapter.getById(fixture.SetterKeyed, 'item-12', null, { plain: true }),
        fixture.adapter.update(fixture.SetterKeyed, 'item-12', { title: 'B' }),
        fixture.adapter.delete(fixture.SetterKeyed, 'item-12'),
      ];
      expect(setKey).not.toHaveBeenCalled();
      for (const query of queries) {
        expect(query.getFilter()).toEqual({ _id: 'item-12' });
        setKey.mockClear();
        expect(castFilter(query)).toEqual({ _id: 12 });
        expect(setKey).toHaveBeenCalledTimes(1);
        expect(setKey.mock.calls[0][0]).toBe('item-12');
      }
    });

    test('a guarded read leaves both keys to the query', () => {
      const query = fixture.adapter.getById(fixture.SetterKeyed, 'item-12', null, { requiredId: 12 });
      expect(query.getFilter()).toEqual({ $and: [{ _id: 12 }, { _id: 'item-12' }] });
      expect(castFilter(query)).toEqual({ $and: [{ _id: 12 }, { _id: 12 }] });
    });

    test.each([
      ['getById', (adapter, Model, id) => adapter.getById(Model, id)],
      ['update', (adapter, Model, id) => adapter.update(Model, id, { title: 'B' })],
      ['delete', (adapter, Model, id) => adapter.delete(Model, id)],
    ])('%s rejects a value the key cannot hold after its setter with NOT_VALID_ID', async (_, run) => {
      await expect(run(fixture.adapter, fixture.SetterKeyed, 'item-abc')).rejects.toMatchObject(invalidId);
      expect(setKey).toHaveBeenCalledTimes(1);
      expect(setKey.mock.calls[0][0]).toBe('item-abc');
    });
  });

  test('getById, update and delete stay chainable Queries that keep the session and lean option', () => {
    const session = { id: 'supplied session' };
    const queries = [
      fixture.adapter.getById(fixture.Record, objectIdHex, session, { plain: true }),
      fixture.adapter.update(fixture.Record, objectIdHex, { count: 'x' }, session),
      fixture.adapter.delete(fixture.Record, objectIdHex, session),
    ];
    for (const query of queries) {
      expect(query).toBeInstanceOf(mongoose.Query);
      expect(query.getOptions().session).toBe(session);
      expect(query.select('count').lean()).toBe(query);
      expect(query.mongooseOptions().lean).toBe(true);
    }
  });

  test('find rejects a malformed required ID', async () => {
    await expect(fixture.adapter.find(fixture.Record, fixture.types.Record, {}, null, { requiredId: 'bad' }))
      .rejects.toMatchObject(invalidId);
  });

  test('findChildren returns no children for a parent key the connection path cannot cast', async () => {
    await expect(fixture.adapter.findChildren(fixture.Child, fixture.types.Child, 'owner', 'record-a', {}, null))
      .resolves.toEqual([]);
  });

  test.each([
    ['a scalar ID', { other: 'invalid' }],
    ['a scalar ID list', { others: ['invalid'] }],
    ['an embedded object ID', { tag: { id: 'invalid' } }],
    ['an embedded list ID', { tags: [{ id: 'invalid' }] }],
  ])('a create with a malformed %s fails with NOT_VALID_ID', async (_, data) => {
    const record = fixture.adapter.newRecord(fixture.Record, data, null);
    await expect(fixture.adapter.saveRecord(fixture.Record, record)).rejects.toMatchObject(invalidId);
  });

  test.each([
    ['a scalar ID', { other: 'invalid' }],
    ['a scalar ID list', { $set: { others: ['invalid'] } }],
    ['an embedded object ID', { tag: { id: 'invalid', label: 'x' } }],
    ['an embedded list ID', { tags: [{ id: 'invalid' }] }],
  ])('an update with a malformed %s fails with NOT_VALID_ID', async (_, update) => {
    await expect(fixture.adapter.update(fixture.Record, objectIdHex, update)).rejects.toMatchObject(invalidId);
  });

  test('keeps other cast and validation failures', async () => {
    const mixed = await new fixture.Record({ other: 'invalid', tags: 'not a list of tags' }).validate()
      .catch((error) => error);
    expect(mixed.name).toBe('ValidationError');
    expect(mapIdCastError(mixed)).toBe(mixed);
    const NumberModel = fixture.NumberKeyed;
    const numberCast = await NumberModel.findByIdAndUpdate(1, { $set: { _id: 'abc' } })
      .catch((error) => error);
    expect(numberCast.name).toBe('CastError');
    expect(mapIdCastError(numberCast)).toBe(numberCast);
    // Only the query's own key cast is a malformed identifier, not a key in the update document.
    await expect(fixture.adapter.update(NumberModel, 1, { $set: { _id: 'abc' } }))
      .rejects.toMatchObject({ name: 'CastError', path: '_id' });
    const failure = new Error('driver failure');
    expect(mapIdCastError(failure)).toBe(failure);
  });

  test('keeps a cast failure of a filter that query middleware adds on another path', async () => {
    const schema = new mongoose.Schema({ title: String, rank: Number });
    schema.pre('findOne', function addRank() { this.where({ rank: 'not a number' }); });
    const Model = mongoose.model('MongoIdsRankGuarded', schema);
    await expect(fixture.adapter.getById(Model, objectIdHex))
      .rejects.toMatchObject({ name: 'CastError', path: 'rank' });
  });
});

describe('MongoDB embedded null hydration', () => {
  const Model = mongoose.model('MongoIdsHydration', new mongoose.Schema({
    main: { street: String, geo: { lat: Number, aliases: [String] } },
  }));
  const { readEmbeddedValue } = createMongoAdapter();

  test('reads an explicitly stored null as null', () => {
    const document = Model.hydrate({ main: { street: 'M', geo: null } });
    expect(document.main.geo).not.toBeNull();
    expect(readEmbeddedValue(document.main.geo)).toBeNull();
    expect(readEmbeddedValue(Model.hydrate({ main: null }).main)).toBeNull();
  });

  test('keeps materialized objects for absent values and plain values unchanged', () => {
    const legacy = Model.hydrate({});
    expect(readEmbeddedValue(legacy.main)).toBe(legacy.main);
    const stored = Model.hydrate({ main: { street: 'M', geo: { lat: 1 } } });
    expect(readEmbeddedValue(stored.main.geo)).toBe(stored.main.geo);
    const plain = { street: 'M' };
    expect(readEmbeddedValue(plain)).toBe(plain);
    expect(readEmbeddedValue(null)).toBeNull();
    expect(readEmbeddedValue(undefined)).toBeUndefined();
  });

  test('reads a stored null as null when the schema applies toJSON virtuals', () => {
    const VirtualsModel = mongoose.model('MongoIdsHydrationVirtuals', new mongoose.Schema({
      main: { street: String, geo: { lat: Number } },
    }, { toJSON: { virtuals: true } }));
    const cleared = VirtualsModel.hydrate({ main: { street: 'M', geo: null } });
    // With the option, the nested path's own toJSON renders the stored null as an object.
    expect(cleared.main.geo.toJSON()).toEqual({});
    expect(readEmbeddedValue(cleared.main.geo)).toBeNull();

    const legacy = VirtualsModel.hydrate({ main: { street: 'M' } });
    expect(readEmbeddedValue(legacy.main.geo)).toBe(legacy.main.geo);
    const stored = VirtualsModel.hydrate({ main: { street: 'M', geo: { lat: 1 } } });
    expect(readEmbeddedValue(stored.main.geo)).toBe(stored.main.geo);
    expect(readEmbeddedValue(stored.main)).toBe(stored.main);
  });
});
