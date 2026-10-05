import { beforeAll, describe, expect, test } from 'vitest';
import mongoose from 'mongoose';
import {
  GraphQLID, GraphQLList, GraphQLObjectType, GraphQLString,
} from 'graphql';
import { createMongoAdapter, createRuntime } from '../packages/mongodb/src/index.js';
import { mapIdCastError } from '../packages/mongodb/src/mongo/ids.js';

const invalidId = { message: 'Invalid identifier', extensions: { code: 'NOT_VALID_ID', status: 400 } };
const objectIdHex = '507f1f77bcf86cd799439011';
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
  runtime.addNoEndpointType(Tag);
  runtime.connect(null, Child, 'mongoIdsChild', 'mongoIdsChildren');
  runtime.connect(null, Record, 'mongoIdsRecord', 'mongoIdsRecords');
  runtime.connect(mongoose.model('MongoIdsStringKeyed', new mongoose.Schema({ _id: String, title: String })),
    StringKeyed, 'mongoIdsStringKeyed', 'mongoIdsStringKeyeds');
  runtime.connect(mongoose.model('MongoIdsNumberKeyed', new mongoose.Schema({ _id: Number, title: String })),
    NumberKeyed, 'mongoIdsNumberKeyed', 'mongoIdsNumberKeyeds');
  runtime.createSchema();
  return {
    adapter,
    Record: runtime.getModel(Record),
    Child: runtime.getModel(Child),
    StringKeyed: runtime.getModel(StringKeyed),
    NumberKeyed: runtime.getModel(NumberKeyed),
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

  test('getById, update and delete reject a malformed ID before building a query', () => {
    for (const read of [
      () => fixture.adapter.getById(fixture.Record, 'invalid'),
      () => fixture.adapter.getById(fixture.Record, objectIdHex, null, { requiredId: 'invalid' }),
      () => fixture.adapter.update(fixture.Record, 'invalid', { other: null }),
      () => fixture.adapter.delete(fixture.Record, 'invalid'),
    ]) {
      expect(thrown(read)).toMatchObject(invalidId);
    }
  });

  test('casts IDs with the model key type, so supplied String and Number keys keep working', () => {
    expect(fixture.adapter.getById(fixture.Record, objectIdHex).getFilter())
      .toEqual({ _id: new mongoose.Types.ObjectId(objectIdHex) });
    expect(fixture.adapter.getById(fixture.StringKeyed, 'record-a').getFilter()).toEqual({ _id: 'record-a' });
    expect(fixture.adapter.update(fixture.StringKeyed, 'record-a', { title: 'B' }).getFilter()).toEqual({ _id: 'record-a' });
    expect(fixture.adapter.delete(fixture.StringKeyed, 'record-a').getFilter()).toEqual({ _id: 'record-a' });
    expect(fixture.adapter.getById(fixture.NumberKeyed, '12').getFilter()).toEqual({ _id: 12 });
    expect(thrown(() => fixture.adapter.getById(fixture.NumberKeyed, 'abc'))).toMatchObject(invalidId);
    // A missing ID is passed through unchanged and matches nothing instead of failing.
    expect(fixture.adapter.getById(fixture.Record, undefined).getFilter()._id).toBeUndefined();
  });

  test('the default-mode update stays a chainable Query', () => {
    const query = fixture.adapter.update(fixture.Record, objectIdHex, { count: 'x' });
    expect(query).toBeInstanceOf(mongoose.Query);
    expect(query.select('count').lean()).toBe(query);
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
    const failure = new Error('driver failure');
    expect(mapIdCastError(failure)).toBe(failure);
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
