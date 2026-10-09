import {
  afterAll, beforeAll, beforeEach, describe, expect, test, vi,
} from 'vitest';
import mongoose from 'mongoose';
import {
  GraphQLFloat, GraphQLID, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLSchema, GraphQLString, graphql,
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

  describe('objects that hold no data', () => {
    afterAll(() => mongoose.deleteModel(/^MongoIdsAbsent/));

    test('reads absent and list-default-only objects that miss a required member as null', async () => {
      const embedded = (type) => ({ type, extensions: { relation: { embedded: true } } });
      const Geo = new GraphQLObjectType({
        name: 'MongoIdsAbsentGeo',
        fields: { lat: { type: new GraphQLNonNull(GraphQLFloat) }, aliases: { type: new GraphQLList(GraphQLString) } },
      });
      const Address = new GraphQLObjectType({
        name: 'MongoIdsAbsentAddress',
        fields: {
          street: { type: new GraphQLNonNull(GraphQLString) }, phones: { type: new GraphQLList(GraphQLString) }, geo: embedded(Geo),
        },
      });
      const Note = new GraphQLObjectType({ name: 'MongoIdsAbsentNote', fields: { text: { type: GraphQLString } } });
      const Shop = new GraphQLObjectType({
        name: 'MongoIdsAbsentShop',
        fields: {
          id: { type: GraphQLID }, name: { type: GraphQLString }, main: embedded(Address), note: embedded(Note),
        },
      });
      const runtime = createRuntime(createMongoAdapter());
      runtime.preventCreatingCollection(true);
      runtime.addNoEndpointType(Geo);
      runtime.addNoEndpointType(Address);
      runtime.addNoEndpointType(Note);
      runtime.connect(null, Shop, 'mongoIdsAbsentShop', 'mongoIdsAbsentShops');
      runtime.createSchema();
      const Model = runtime.getModel(Shop);
      const stored = [
        {},
        { main: { phones: [], geo: { aliases: [] } } },
        { main: { street: 'M', phones: [], geo: { aliases: [] } } },
        { main: { street: 'M', phones: ['1'], geo: { lat: 1 } }, note: { text: 't' } },
      ];
      // Generated reads need a database. These read hydrated documents, as reads by ID return, and
      // plain values, as list reads return, through the same types.
      const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: 'MongoIdsAbsentQuery',
          fields: {
            hydrated: { type: new GraphQLList(Shop), resolve: () => stored.map((value) => Model.hydrate(value)) },
            plain: { type: new GraphQLList(Shop), resolve: () => stored },
          },
        }),
      });
      const selection = 'main { street phones geo { lat } } note { text }';

      const result = await graphql({ schema, source: `{ hydrated { ${selection} } plain { ${selection} } }` });
      const withoutRequired = await graphql({ schema, source: '{ hydrated { main { phones } } }' });

      expect(result.errors).toBeUndefined();
      const complete = { main: { street: 'M', phones: ['1'], geo: { lat: 1 } }, note: { text: 't' } };
      expect(result.data.hydrated).toEqual([
        // A hydrated document renders an absent nested path as an object; one that needs no member is kept.
        { main: null, note: { text: null } },
        { main: null, note: { text: null } },
        { main: { street: 'M', phones: [], geo: null }, note: { text: null } },
        complete,
      ]);
      expect(result.data.plain).toEqual([
        { main: null, note: null },
        { main: null, note: null },
        { main: { street: 'M', phones: [], geo: null }, note: null },
        complete,
      ]);
      expect(withoutRequired).toEqual({
        data: { hydrated: [{ main: null }, { main: null }, { main: { phones: [] } }, { main: { phones: ['1'] } }] },
      });
    });

    const embedded = (type) => ({ type, extensions: { relation: { embedded: true } } });
    // Reads hydrated documents, as reads by ID return, and plain values, as list reads return.
    const readHydratedAndPlain = (Model, Type, stored, selection) => graphql({
      schema: new GraphQLSchema({
        query: new GraphQLObjectType({
          name: `${Type.name}Query`,
          fields: {
            hydrated: { type: new GraphQLList(Type), resolve: () => stored.map((value) => Model.hydrate(value)) },
            plain: { type: new GraphQLList(Type), resolve: () => stored },
          },
        }),
      }),
      source: `{ hydrated { ${selection} } plain { ${selection} } }`,
    });

    test('never runs schema getters of members, and keeps hydrated objects whose schema declares one', async () => {
      const getterCalls = [];
      const secret = {
        type: String,
        get(value) {
          getterCalls.push(value);
          throw new Error('secret getter');
        },
      };
      // `secret` comes first, so a rule that read members through their getters would reach it first.
      const Details = new GraphQLObjectType({
        name: 'MongoIdsAbsentGetterDetails', fields: { secret: { type: GraphQLString }, visible: { type: GraphQLString } },
      });
      const Secured = new GraphQLObjectType({
        name: 'MongoIdsAbsentGetterSecured',
        fields: {
          secret: { type: GraphQLString }, code: { type: new GraphQLNonNull(GraphQLString) }, visible: { type: GraphQLString },
        },
      });
      const Shop = new GraphQLObjectType({
        name: 'MongoIdsAbsentGetterShop',
        fields: {
          id: { type: GraphQLID },
          name: { type: GraphQLString },
          details: embedded(Details),
          secured: embedded(Secured),
          sub: embedded(Secured),
        },
      });
      // `secured` is a nested path, `sub` a single nested subdocument.
      const Model = mongoose.model('MongoIdsAbsentGetterShop', new mongoose.Schema({
        name: String,
        details: { secret, visible: String },
        secured: { secret, code: String, visible: String },
        sub: new mongoose.Schema({ secret, code: String, visible: String }, { _id: false }),
      }));
      const runtime = createRuntime(createMongoAdapter());
      runtime.preventCreatingCollection(true);
      runtime.addNoEndpointType(Details);
      runtime.addNoEndpointType(Secured);
      runtime.connect(Model, Shop, 'mongoIdsAbsentGetterShop', 'mongoIdsAbsentGetterShops');
      runtime.createSchema();
      const stored = [
        {
          details: { visible: 'ok', secret: 's' }, secured: { code: 'c', secret: 's' }, sub: { code: 'c', secret: 's' },
        },
        { details: {}, secured: { secret: 's' }, sub: { secret: 's' } },
        { details: {}, secured: {}, sub: {} },
      ];

      const result = await readHydratedAndPlain(Model, Shop, stored, 'details { visible } secured { visible } sub { visible }');

      // Details has no required member, so it is never read. Secured declares a getter, so hydrated
      // objects are kept unread, as 3.5.8 rendered them; plain ones are read from their data, where
      // `secret` holds data. Only the last one holds no data and misses `code`.
      const expected = [
        { details: { visible: 'ok' }, secured: { visible: null }, sub: { visible: null } },
        { details: { visible: null }, secured: { visible: null }, sub: { visible: null } },
      ];
      expect(result).toEqual({
        data: {
          hydrated: [...expected, { details: { visible: null }, secured: { visible: null }, sub: { visible: null } }],
          plain: [...expected, { details: { visible: null }, secured: null, sub: null }],
        },
      });
      expect(getterCalls).toEqual([]);
    });

    test('reads the stored `_id` of a subdocument as the `id` it holds', async () => {
      const Part = new GraphQLObjectType({
        name: 'MongoIdsAbsentPart', fields: { id: { type: GraphQLID }, name: { type: new GraphQLNonNull(GraphQLString) } },
      });
      const Root = new GraphQLObjectType({
        name: 'MongoIdsAbsentRoot', fields: { id: { type: GraphQLID }, name: { type: GraphQLString }, part: embedded(Part) },
      });
      const Model = mongoose.model('MongoIdsAbsentRoot', new mongoose.Schema({
        name: String, part: new mongoose.Schema({ name: String }),
      }));
      const runtime = createRuntime(createMongoAdapter());
      runtime.preventCreatingCollection(true);
      // An entity also embedded in Root, so its generated resolver reads `id` from `_id`.
      runtime.connect(null, Part, 'mongoIdsAbsentPart', 'mongoIdsAbsentParts');
      runtime.connect(Model, Root, 'mongoIdsAbsentRoot', 'mongoIdsAbsentRoots');
      runtime.createSchema();
      const partId = new mongoose.Types.ObjectId();

      const result = await readHydratedAndPlain(Model, Root, [{ part: { _id: partId } }], 'part { id }');

      const expected = [{ part: { id: partId.toHexString() } }];
      expect(result).toEqual({ data: { hydrated: expected, plain: expected } });
    });

    test('keeps hydrated objects whose required member a getter, a virtual, a method or an alias supplies, as 3.5.8 did', async () => {
      const calls = [];
      const track = (name, value) => {
        calls.push(name);
        return value;
      };
      const codeByGetter = { type: String, get: (value) => track('getter', value ?? 'default') };
      const Coded = new GraphQLObjectType({
        name: 'MongoIdsAbsentCoded', fields: { code: { type: new GraphQLNonNull(GraphQLString) }, other: { type: GraphQLString } },
      });
      const members = ['getter', 'getterSub', 'virtual', 'virtualSub', 'methodSub', 'alias', 'aliasSub', 'aliasOutside'];
      const Root = new GraphQLObjectType({
        name: 'MongoIdsAbsentCodedRoot',
        fields: { id: { type: GraphQLID }, ...Object.fromEntries(members.map((member) => [member, embedded(Coded)])) },
      });
      const virtualSub = new mongoose.Schema({ other: String }, { _id: false });
      virtualSub.virtual('code').get(() => track('virtual', 'virtual'));
      // GraphQL's default resolver calls a subdocument method named like a member.
      const methodSub = new mongoose.Schema({ other: String }, { _id: false });
      methodSub.methods.code = () => track('method', 'method');
      // Nested paths and single nested subdocuments of each kind.
      const schema = new mongoose.Schema({
        getter: { code: codeByGetter, other: String },
        getterSub: new mongoose.Schema({ code: codeByGetter, other: String }, { _id: false }),
        virtual: { other: String },
        virtualSub,
        methodSub,
        // An alias stores its value under its own path, `c`, which the GraphQL type does not declare.
        alias: { c: { type: String, alias: 'alias.code' }, other: String },
        aliasSub: new mongoose.Schema({ c: { type: String, alias: 'code' }, other: String }, { _id: false }),
        // One declared outside the nested path where it stores its value.
        aliasOutside: { c: { type: String, alias: 'outsideCode' }, other: String },
      });
      schema.virtual('virtual.code').get(() => track('virtual', 'virtual'));
      const Model = mongoose.model('MongoIdsAbsentCodedRoot', schema);
      const runtime = createRuntime(createMongoAdapter());
      runtime.preventCreatingCollection(true);
      runtime.addNoEndpointType(Coded);
      runtime.connect(Model, Root, 'mongoIdsAbsentCodedRoot', 'mongoIdsAbsentCodedRoots');
      runtime.createSchema();
      const stored = [{
        getter: {}, getterSub: {}, virtual: {}, virtualSub: {}, methodSub: {}, alias: { c: 'a' }, aliasSub: { c: 'b' }, aliasOutside: { c: 'o' },
      }];
      const nulls = (names) => Object.fromEntries(names.map((member) => [member, null]));

      // `aliasOutside` renders no `code`.
      const coded = members.slice(0, -1);
      const withCode = await readHydratedAndPlain(Model, Root, stored, coded.map((member) => `${member} { code }`).join(' '));
      const readCalls = calls.splice(0);
      const withoutCode = await readHydratedAndPlain(Model, Root, stored, members.map((member) => `${member} { other }`).join(' '));

      expect(withCode).toEqual({
        data: {
          hydrated: [{
            getter: { code: 'default' },
            getterSub: { code: 'default' },
            virtual: { code: 'virtual' },
            virtualSub: { code: 'virtual' },
            methodSub: { code: 'method' },
            alias: { code: 'a' },
            aliasSub: { code: 'b' },
          }],
          // Plain values, as list reads return, render no getter, virtual or alias: they hold no data.
          plain: [nulls(coded)],
        },
      });
      // Only the selected members ran theirs.
      expect(readCalls.sort()).toEqual(['getter', 'getter', 'method', 'virtual', 'virtual']);
      expect(withoutCode).toEqual({
        data: {
          hydrated: [Object.fromEntries(members.map((member) => [member, { other: null }]))],
          plain: [nulls(members)],
        },
      });
      expect(calls).toEqual([]);
    });

    test('looks for getters, virtuals and aliases at any depth of an embedded object', async () => {
      const calls = [];
      const Item = new GraphQLObjectType({ name: 'MongoIdsAbsentDeepItem', fields: { x: { type: GraphQLString } } });
      const Inner = new GraphQLObjectType({ name: 'MongoIdsAbsentDeepInner', fields: { y: { type: GraphQLString } } });
      const Holder = new GraphQLObjectType({
        name: 'MongoIdsAbsentDeepHolder',
        fields: {
          code: { type: new GraphQLNonNull(GraphQLString) },
          items: { type: new GraphQLList(Item), extensions: { relation: { embedded: true } } },
          inner: embedded(Inner),
        },
      });
      const Root = new GraphQLObjectType({
        name: 'MongoIdsAbsentDeepRoot',
        fields: {
          id: { type: GraphQLID },
          inItems: embedded(Holder),
          inSub: embedded(Holder),
          inScalars: embedded(Holder),
          plainHolder: embedded(Holder),
        },
      });
      const item = (x) => new mongoose.Schema({ x }, { _id: false });
      const inner = (withVirtual) => {
        const innerSchema = new mongoose.Schema({ y: String }, { _id: false });
        if (withVirtual) innerSchema.virtual('z').get(() => calls.push('virtual'));
        return innerSchema;
      };
      const Model = mongoose.model('MongoIdsAbsentDeepRoot', new mongoose.Schema({
        // A getter in the items of a document array, a virtual of a subdocument, and a getter of the
        // items of a scalar list that the GraphQL type does not declare.
        inItems: { code: String, items: [item({ type: String, get: (value) => calls.push('getter') && value })], inner: inner(false) },
        inSub: { code: String, items: [item(String)], inner: inner(true) },
        inScalars: {
          code: String, items: [item(String)], inner: inner(false), tags: [{ type: String, get: (value) => calls.push('getter') && value }],
        },
        plainHolder: { code: String, items: [item(String)], inner: inner(false) },
      }));
      const runtime = createRuntime(createMongoAdapter());
      runtime.preventCreatingCollection(true);
      for (const type of [Item, Inner, Holder]) runtime.addNoEndpointType(type);
      runtime.connect(Model, Root, 'mongoIdsAbsentDeepRoot', 'mongoIdsAbsentDeepRoots');
      runtime.createSchema();
      const members = ['inItems', 'inSub', 'inScalars', 'plainHolder'];
      const stored = [Object.fromEntries(members.map((member) => [member, {}]))];

      const result = await readHydratedAndPlain(Model, Root, stored, members.map((member) => `${member} { items { x } inner { y } }`).join(' '));

      const kept = { items: [], inner: null };
      expect(result).toEqual({
        data: {
          hydrated: [{
            inItems: kept, inSub: kept, inScalars: kept, plainHolder: null,
          }],
          plain: [Object.fromEntries(members.map((member) => [member, null]))],
        },
      });
      expect(calls).toEqual([]);
    });

    test('reads a Mongoose map by its stored entries, so hydrated and plain reads agree', async () => {
      const calls = [];
      const Meta = new GraphQLObjectType({
        name: 'MongoIdsAbsentMeta', fields: { code: { type: new GraphQLNonNull(GraphQLString) }, other: { type: GraphQLString } },
      });
      const Root = new GraphQLObjectType({
        name: 'MongoIdsAbsentMetaRoot', fields: { id: { type: GraphQLID }, meta: embedded(Meta), metaGetter: embedded(Meta) },
      });
      const Model = mongoose.model('MongoIdsAbsentMetaRoot', new mongoose.Schema({
        meta: { type: Map, of: String },
        metaGetter: { type: Map, of: { type: String, get: (value) => calls.push(value) && value } },
      }));
      const runtime = createRuntime(createMongoAdapter());
      runtime.preventCreatingCollection(true);
      runtime.addNoEndpointType(Meta);
      runtime.connect(Model, Root, 'mongoIdsAbsentMetaRoot', 'mongoIdsAbsentMetaRoots');
      runtime.createSchema();
      const stored = [{ meta: {}, metaGetter: {} }, { meta: { other: 'x' }, metaGetter: { other: 'y' } }];

      const result = await readHydratedAndPlain(Model, Root, stored, 'meta { other } metaGetter { other }');

      // An empty map holds no data and misses `code`. A map whose values have a getter is kept on
      // hydrated reads, and a hydrated map renders no entry as a member, both as on 3.5.8.
      expect(result).toEqual({
        data: {
          hydrated: [{ meta: null, metaGetter: { other: null } }, { meta: { other: null }, metaGetter: { other: null } }],
          plain: [{ meta: null, metaGetter: null }, { meta: { other: 'x' }, metaGetter: { other: 'y' } }],
        },
      });
      expect(calls).toEqual([]);
    });

    test('reads objects of generated models, which declare no getter, virtual or alias, by their stored data', async () => {
      const Item = new GraphQLObjectType({ name: 'MongoIdsAbsentGenItem', fields: { x: { type: GraphQLString } } });
      const Kind = new GraphQLObjectType({ name: 'MongoIdsAbsentGenKind', fields: { name: { type: GraphQLString } } });
      const Address = new GraphQLObjectType({
        name: 'MongoIdsAbsentGenAddress',
        fields: {
          street: { type: new GraphQLNonNull(GraphQLString) },
          // Mongoose gives the items of an embedded list an `_id` and its automatic `id` virtual.
          items: { type: new GraphQLList(Item), extensions: { relation: { embedded: true } } },
          // A single nested subdocument.
          type: embedded(Kind),
        },
      });
      const Shop = new GraphQLObjectType({
        name: 'MongoIdsAbsentGenShop', fields: { id: { type: GraphQLID }, main: embedded(Address) },
      });
      const runtime = createRuntime(createMongoAdapter());
      runtime.preventCreatingCollection(true);
      for (const type of [Item, Kind, Address]) runtime.addNoEndpointType(type);
      runtime.connect(null, Shop, 'mongoIdsAbsentGenShop', 'mongoIdsAbsentGenShops');
      runtime.createSchema();
      const Model = runtime.getModel(Shop);
      const stored = [{}, { main: { items: [] } }, { main: { items: [], type: {} } }, { main: { street: 'M', items: [{ x: '1' }] } }];

      const result = await readHydratedAndPlain(Model, Shop, stored, 'main { items { x } type { name } }');

      const expected = [{ main: null }, { main: null }, { main: null }, { main: { items: [{ x: '1' }], type: null } }];
      expect(result).toEqual({ data: { hydrated: expected, plain: expected } });
    });
  });
});
