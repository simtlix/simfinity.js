import {
  afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi,
} from 'vitest';
import mongoose from 'mongoose';
import {
  GraphQLEnumType,
  GraphQLID,
  GraphQLInt,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLString,
  GraphQLUnionType,
  graphql,
} from 'graphql';
import { createMongoAdapter, createRuntime } from '../../packages/mongodb/src/index.js';

// Virtual fields (#109) on MongoDB: a field declared with `extensions.virtual` gets no path, no `[]`
// default and no index in generated models, on entities and embedded types, and no entry in the
// transactional integrity registry, so documents written with or without it look the same.

const replicaSetUri = process.env.SIMFINITY_MONGODB_URI;
const standaloneUri = process.env.SIMFINITY_STANDALONE_MONGODB_URI;
const withReplicaSet = replicaSetUri ? describe : describe.skip;
const withStandalone = standaloneUri ? describe : describe.skip;

const virtualField = (type, resolve, { args, virtual = true } = {}) => ({
  type, args, resolve, extensions: { virtual },
});

// Every virtual field and member of the fixture. No stored field has one of these names.
const VIRTUAL_NAMES = new Set([
  'score', 'level', 'ownerRef', 'keywords', 'tagIds', 'busyRanges', 'stats', 'raw', 'named', 'tagged',
  'topBooking', 'recentBookings', 'nearby', 'formatted', 'lines', 'pin', 'landmark', 'codes', 'badge', 'caption',
]);

// One model, with or without its virtual fields, so that their only effect can be compared.
// `scalarOnly` keeps the virtual fields that Simfinity 3.7.0 can build as stored fields (scalars,
// enums, scalar lists and embedded members), so the model checks also run against it.
const buildTypes = (prefix, { virtual = true, scalarOnly = false, state } = {}) => {
  const only = (fields) => (virtual ? fields : {});
  const unlessScalarOnly = (fields) => (scalarOnly ? {} : fields);
  const types = {};
  const modelOf = (name) => state.runtime.getModel(types[name]);
  types.Range = new GraphQLObjectType({
    name: `${prefix}Range`, fields: { start: { type: GraphQLString }, end: { type: GraphQLString } },
  });
  types.Stats = new GraphQLObjectType({ name: `${prefix}Stats`, fields: { visits: { type: GraphQLInt } } });
  types.JSON = new GraphQLScalarType({ name: `${prefix}JSON`, serialize: (value) => value });
  types.Named = new GraphQLInterfaceType({ name: `${prefix}Named`, fields: { label: { type: GraphQLString } } });
  types.Tag = new GraphQLObjectType({
    name: `${prefix}Tag`, interfaces: [types.Named], fields: { label: { type: GraphQLString } }, isTypeOf: () => true,
  });
  types.TagUnion = new GraphQLUnionType({ name: `${prefix}TagUnion`, types: [types.Tag], resolveType: () => `${prefix}Tag` });
  types.Level = new GraphQLEnumType({ name: `${prefix}Level`, values: { LOW: { value: 1 }, HIGH: { value: 2 } } });
  types.Address = new GraphQLObjectType({
    name: `${prefix}Address`,
    fields: () => ({
      street: { type: GraphQLString },
      ownerId: { type: GraphQLID },
      ...only({
        formatted: virtualField(new GraphQLNonNull(GraphQLString), (address) => `${address.street ?? 'unknown'} (formatted)`),
        lines: virtualField(new GraphQLList(GraphQLString), (address) => [address.street]),
        pin: virtualField(GraphQLID, () => null),
        ...unlessScalarOnly({ landmark: virtualField(types.Booking, () => null) }),
      }),
    }),
  });
  types.Item = new GraphQLObjectType({
    name: `${prefix}Item`,
    fields: () => ({
      label: { type: GraphQLString },
      ...only({
        codes: virtualField(new GraphQLList(GraphQLID), () => []),
        badge: virtualField(new GraphQLNonNull(GraphQLString), (item) => `#${item.label}`),
      }),
    }),
  });
  types.Booking = new GraphQLObjectType({
    name: `${prefix}Booking`,
    fields: () => ({
      id: { type: GraphQLID },
      when: { type: GraphQLString },
      shop: { type: types.Shop, extensions: { relation: { connectionField: 'shop' } } },
      ...only({
        caption: virtualField(GraphQLString, (booking, args) => `${booking.when}@${args.locale}`, {
          args: { locale: { type: new GraphQLNonNull(GraphQLString) } },
        }),
      }),
    }),
  });
  types.Shop = new GraphQLObjectType({
    name: `${prefix}Shop`,
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      address: { type: types.Address, extensions: { relation: { embedded: true } } },
      items: { type: new GraphQLList(types.Item), extensions: { relation: { embedded: true } } },
      bookings: { type: new GraphQLList(types.Booking), extensions: { relation: { connectionField: 'shop' } } },
      ...only({
        score: virtualField(new GraphQLNonNull(GraphQLInt), () => 42),
        level: virtualField(types.Level, () => 2),
        // The resolver receives the hydrated record.
        ownerRef: virtualField(GraphQLID, (shop) => String(shop._id)),
        keywords: virtualField(new GraphQLList(GraphQLString), (shop) => [shop.name]),
        tagIds: virtualField(new GraphQLList(GraphQLID), () => []),
        ...unlessScalarOnly({
          busyRanges: virtualField(
            new GraphQLList(new GraphQLNonNull(types.Range)),
            (shop, args) => [{ start: `${args.date}T10`, end: `${args.date}T11${args.professionalId ? `/${args.professionalId}` : ''}` }],
            { args: { date: { type: new GraphQLNonNull(GraphQLString) }, professionalId: { type: GraphQLID } } },
          ),
          stats: virtualField(types.Stats, () => ({ visits: 3 }), { virtual: { mcp: 'select' } }),
          raw: virtualField(types.JSON, (shop, args, context) => ({ tenant: context.tenant ?? null }), { virtual: { mcp: false } }),
          named: virtualField(types.Named, () => ({ label: 'named' })),
          tagged: virtualField(new GraphQLList(types.TagUnion), () => [{ label: 'tagged' }]),
          // Registered entity results without relation: read natively by the resolver.
          topBooking: virtualField(types.Booking, (shop) => modelOf('Booking').findOne({ shop: shop._id })),
          recentBookings: virtualField(new GraphQLList(types.Booking), (shop) => modelOf('Booking').find({ shop: shop._id })),
          // The embedded type, as the result of a virtual field.
          nearby: virtualField(types.Address, () => ({ street: 'Next door' })),
        }),
      }),
    }),
  });
  return types;
};

const createFixture = (prefix, {
  virtual = true, scalarOnly = false, adapterOptions, models = {}, controllers = {}, middlewares = [],
} = {}) => {
  const state = {};
  const types = buildTypes(prefix, { virtual, scalarOnly, state });
  const adapter = createMongoAdapter(adapterOptions);
  const runtime = createRuntime(adapter);
  state.runtime = runtime;
  const lower = prefix.toLowerCase();
  runtime.connect(models.Shop ?? null, types.Shop, `${lower}shop`, `${lower}shops`, controllers.Shop ?? null);
  runtime.connect(models.Booking ?? null, types.Booking, `${lower}booking`, `${lower}bookings`);
  runtime.addNoEndpointType(types.Address);
  runtime.addNoEndpointType(types.Item);
  for (const middleware of middlewares) runtime.use(middleware);
  const schema = runtime.createSchema();
  const run = async (source, variableValues, contextValue = {}) => {
    const result = await graphql({
      schema, source, variableValues, contextValue,
    });
    expect(result.errors).toBeUndefined();
    return result.data;
  };
  const model = (name) => runtime.getModel(types[name]);
  const add = async (input, selection = 'id') => (await run(
    `mutation($input: ${prefix}ShopInput!) { add${lower}shop(input: $input) { ${selection} } }`, { input },
  ))[`add${lower}shop`];
  const update = async (input, selection = 'id') => (await run(
    `mutation($input: ${prefix}ShopInputForUpdate!) { update${lower}shop(input: $input) { ${selection} } }`, { input },
  ))[`update${lower}shop`];
  const raw = (name, id) => model(name).collection.findOne({ _id: new mongoose.Types.ObjectId(id) });
  return {
    adapter, runtime, schema, types, run, model, add, update, raw, lower,
  };
};

// Stored ObjectIds compare by type only, so documents of two fixtures can be compared.
const normalize = (value) => {
  if (value?._bsontype === 'ObjectId') return 'ObjectId';
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
  }
  return value;
};

// Every key of a document or command, at any depth, by its own name.
const keyNames = (value) => {
  if (Array.isArray(value)) return value.flatMap(keyNames);
  if (!value || typeof value !== 'object' || value._bsontype || value instanceof Date) return [];
  return Object.entries(value).flatMap(([key, item]) => [key, ...keyNames(item)]);
};
const virtualKeysOf = (value) => keyNames(value).filter((key) => VIRTUAL_NAMES.has(key));

const embeddedPaths = (Model, path) => Object.keys(Model.schema.path(path).schema.paths).sort();
const indexNames = async (Model) => {
  await Model.init();
  return (await Model.collection.indexes()).map(({ name }) => name).sort();
};

// Paths and indexes of a generated Shop model, and of its embedded members, without virtual fields.
const STORED_SHOP_PATHS = ['__v', '_id', 'address.ownerId', 'address.street', 'id', 'items', 'name'];
const STORED_ITEM_PATHS = ['_id', 'label'];
const STORED_SHOP_INDEXES = [{ id: 1 }, { 'address.ownerId': 1 }];
const STORED_SHOP_SERVER_INDEXES = ['_id_', 'address.ownerId_1', 'id_1'];

const expectStoredModel = async (fixture) => {
  const Shop = fixture.model('Shop');
  expect(Object.keys(Shop.schema.paths).sort()).toEqual(STORED_SHOP_PATHS);
  expect(embeddedPaths(Shop, 'items')).toEqual(STORED_ITEM_PATHS);
  expect(Shop.schema.indexes().map(([fields]) => fields)).toEqual(STORED_SHOP_INDEXES);
  expect(await indexNames(Shop)).toEqual(STORED_SHOP_SERVER_INDEXES);
  const Booking = fixture.model('Booking');
  expect(Object.keys(Booking.schema.paths).sort()).toEqual(['__v', '_id', 'id', 'shop', 'when']);
  expect(await indexNames(Booking)).toEqual(['_id_', 'id_1', 'shop_1']);
};

const SHOP_INPUT = (ownerId) => ({
  name: 'Main', address: { street: 'Elm', ownerId }, items: [{ label: 'a' }, { label: 'b' }],
  bookings: { added: [{ when: '2026-10-18' }] },
});

// Generated models create their collections and indexes in the background; let them finish before
// the database is dropped, so that none is created again afterwards.
const dropDatabase = async () => {
  await Promise.allSettled(mongoose.modelNames().map((name) => mongoose.model(name).init()));
  await mongoose.connection.dropDatabase();
};

const commandLog = () => {
  const commands = [];
  // The command as sent, as plain BSON values.
  const { BSON } = mongoose.mongo;
  const listener = (event) => commands.push({
    commandName: event.commandName, command: BSON.deserialize(BSON.serialize(event.command)),
  });
  return {
    start: () => mongoose.connection.getClient().on('commandStarted', listener),
    stop: () => mongoose.connection.getClient().off('commandStarted', listener),
    clear: () => { commands.length = 0; },
    of: (name, collection) => commands
      .filter((event) => event.commandName === name && event.command[name] === collection)
      .map((event) => event.command),
  };
};

withStandalone('virtual fields on a standalone MongoDB server', () => {
  let fixture;
  let plain;

  beforeAll(async () => {
    const dbName = `${new URL(standaloneUri).pathname.slice(1)}_vf`;
    await mongoose.connect(standaloneUri, { dbName });
    await mongoose.connection.dropDatabase();
    fixture = createFixture('VfmSa');
    plain = createFixture('VfmSaPlain', { virtual: false });
  }, 30000);

  afterAll(async () => {
    await dropDatabase();
    await mongoose.disconnect();
  });

  test('generated models build no path, default or index for virtual fields', async () => {
    await expectStoredModel(fixture);
    await expectStoredModel(plain);
  });

  test('a generated model stores nothing for virtual fields, whatever a native write passes', async () => {
    const ownerId = new mongoose.Types.ObjectId();
    const stored = {
      name: 'Native', address: { street: 'Elm', ownerId }, items: [{ label: 'a' }],
    };
    const virtualValues = {
      score: 5, level: 1, ownerRef: ownerId, keywords: ['k'], tagIds: [ownerId], busyRanges: [{ start: 's' }],
      stats: { visits: 1 }, topBooking: ownerId,
    };
    const created = await fixture.model('Shop').create({
      ...stored,
      ...virtualValues,
      address: { ...stored.address, formatted: 'f', lines: ['l'], pin: ownerId },
      items: [{ label: 'a', codes: [ownerId], badge: 'b' }],
    });
    const reference = await plain.model('Shop').create(stored);
    const document = await fixture.raw('Shop', created._id);
    expect(virtualKeysOf(document)).toEqual([]);
    expect(normalize(document)).toEqual(normalize(await plain.raw('Shop', reference._id)));
    expect(normalize(document)).toEqual({
      _id: 'ObjectId', name: 'Native', address: { street: 'Elm', ownerId: 'ObjectId' },
      items: [{ label: 'a', _id: 'ObjectId' }], __v: 0,
    });
  });

  test('generated queries resolve virtual fields from hydrated records', async () => {
    const shop = await fixture.model('Shop').create({ name: 'Read', address: { street: 'Oak' }, items: [{ label: 'x' }] });
    const booking = await fixture.model('Booking').create({ when: '2026-10-19', shop: shop._id });
    const id = shop._id.toString();
    const data = await fixture.run(`query($id: ID!) {
      vfmsashop(id: $id) {
        id score level ownerRef keywords tagIds raw
        busyRanges(date: "2026-10-20", professionalId: "p1") { start end }
        address { street formatted lines pin } items { label codes badge }
        topBooking { id when caption(locale: "es") shop { id name } }
        bookings { id caption(locale: "en") }
      }
      vfmsashops { id score ownerRef }
    }`, { id }, { tenant: 't1' });
    expect(data.vfmsashop).toEqual({
      id,
      score: 42,
      level: 'HIGH',
      ownerRef: id,
      keywords: ['Read'],
      tagIds: [],
      raw: { tenant: 't1' },
      busyRanges: [{ start: '2026-10-20T10', end: '2026-10-20T11/p1' }],
      address: { street: 'Oak', formatted: 'Oak (formatted)', lines: ['Oak'], pin: null },
      items: [{ label: 'x', codes: [], badge: '#x' }],
      topBooking: { id: booking._id.toString(), when: '2026-10-19', caption: '2026-10-19@es', shop: { id, name: 'Read' } },
      bookings: [{ id: booking._id.toString(), caption: '2026-10-19@en' }],
    });
    expect(data.vfmsashops).toContainEqual({ id, score: 42, ownerRef: id });
  });

  test('transactional mode accepts virtual fields without relation, and startup still requires a replica set', async () => {
    const protectedFixture = createFixture('VfmSaTx', { adapterOptions: { referentialIntegrity: 'transactional' } });
    await expect(protectedFixture.adapter.initialize()).rejects.toMatchObject({ extensions: { code: 'MONGO_TRANSACTIONS_REQUIRED' } });
  });
});

// A MongoDB connectionField may be a dotted path into an embedded value. Such a path must not end at,
// or pass through, a virtual member: the reference would store its link, and get an index, there.
describe.each(['off', 'transactional'])('dotted connectionField aliases on MongoDB (%s integrity)', (referentialIntegrity) => {
  const build = (name, keyField, connectionField = 'meta.key') => {
    const Target = new GraphQLObjectType({ name: `${name}Target`, fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
    const Meta = new GraphQLObjectType({ name: `${name}Meta`, fields: { label: { type: GraphQLString }, key: keyField } });
    const Owner = new GraphQLObjectType({
      name: `${name}Owner`,
      fields: {
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        meta: { type: Meta, extensions: { relation: { embedded: true } } },
        owner: { type: Target, extensions: { relation: { connectionField } } },
      },
    });
    const runtime = createRuntime(createMongoAdapter({ referentialIntegrity }));
    runtime.preventCreatingCollection(true);
    runtime.connect(null, Target, `${name.toLowerCase()}target`, `${name.toLowerCase()}targets`);
    runtime.connect(null, Owner, `${name.toLowerCase()}owner`, `${name.toLowerCase()}owners`);
    runtime.addNoEndpointType(Meta);
    return { runtime, Owner };
  };
  const prefix = referentialIntegrity === 'off' ? 'VfmDot' : 'VfmDotTx';

  test('createSchema rejects a dotted connectionField that ends at a virtual member, before building any model', () => {
    const { runtime, Owner } = build(`${prefix}Virtual`, virtualField(GraphQLID, () => null));
    let thrown;
    try {
      runtime.createSchema();
    } catch (error) {
      thrown = error;
    }
    expect(thrown?.extensions).toMatchObject({ code: 'INVALID_MODEL', status: 400 });
    expect(thrown.message).toContain(`${prefix}VirtualOwner.owner uses the virtual field ${prefix}VirtualMeta.key as its connectionField (through meta.key)`);
    expect(mongoose.modelNames()).not.toContain(Owner.name);
  });

  test('createSchema rejects a non-string connectionField that names a virtual member, before building any model', () => {
    const { runtime, Owner } = build(`${prefix}Boxed`, virtualField(GraphQLID, () => null), ['meta.key']);
    expect(() => runtime.createSchema()).toThrow(`${prefix}BoxedOwner.owner uses the virtual field ${prefix}BoxedMeta.key as its connectionField (through meta.key)`);
    expect(mongoose.modelNames()).not.toContain(Owner.name);
  });

  test('a dotted connectionField that ends at a stored member still builds its path and index', () => {
    const { runtime, Owner } = build(`${prefix}Stored`, { type: GraphQLID });
    runtime.createSchema();
    const schema = runtime.getModel(Owner).schema;
    expect(schema.path('meta.key')?.instance).toBe('ObjectId');
    expect(schema.indexes()).toContainEqual([{ 'meta.key': 1 }, expect.anything()]);
  });
});

withReplicaSet('virtual fields on a MongoDB replica set', () => {
  const log = commandLog();
  let warn;

  beforeAll(async () => {
    const dbName = `${new URL(replicaSetUri).pathname.slice(1)}_vf`;
    await mongoose.connect(replicaSetUri, { dbName, monitorCommands: true });
    await mongoose.connection.dropDatabase();
    log.start();
  }, 30000);

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    log.clear();
  });

  afterEach(() => {
    warn.mockRestore();
  });

  afterAll(async () => {
    log.stop();
    await dropDatabase();
    await mongoose.disconnect();
  });

  describe('default mode', () => {
    test('scalar, enum, scalar list and embedded member virtual fields get no path, default or index', async () => {
      const fixture = createFixture('VfmScalar', { scalarOnly: true });
      const plain = createFixture('VfmScalarPlain', { virtual: false });
      await expectStoredModel(fixture);
      await expectStoredModel(plain);
      for (const path of ['score', 'level', 'ownerRef', 'keywords', 'tagIds', 'address.formatted', 'address.lines', 'address.pin']) {
        expect(fixture.model('Shop').schema.path(path), path).toBeUndefined();
      }
      for (const path of ['codes', 'badge']) {
        expect(fixture.model('Shop').schema.path('items').schema.path(path), path).toBeUndefined();
      }
      expect(fixture.model('Booking').schema.path('caption')).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    });

    test('object, entity, custom scalar, interface and union virtual fields build without relation and add nothing', async () => {
      const fixture = createFixture('VfmFull');
      await expectStoredModel(fixture);
      expect(fixture.model('Shop').schema.path('address.landmark')).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    });

    test('creates and updates store the same documents as the type without its virtual fields', async () => {
      const fixture = createFixture('VfmWrite');
      const plain = createFixture('VfmWritePlain', { virtual: false });
      const ownerId = new mongoose.Types.ObjectId().toString();
      const written = await fixture.add(SHOP_INPUT(ownerId), 'id score address { formatted } items { badge }');
      const reference = await plain.add(SHOP_INPUT(ownerId));
      // A non-null virtual field needs no input and resolves in the mutation result.
      expect(written).toMatchObject({ score: 42, address: { formatted: 'Elm (formatted)' }, items: [{ badge: '#a' }, { badge: '#b' }] });

      const expectSameDocuments = async () => {
        const shop = await fixture.raw('Shop', written.id);
        expect(virtualKeysOf(shop)).toEqual([]);
        expect(normalize(shop)).toEqual(normalize(await plain.raw('Shop', reference.id)));
        const bookings = await fixture.model('Booking').collection.find({ shop: shop._id }).toArray();
        const plainBookings = await plain.model('Booking').collection
          .find({ shop: new mongoose.Types.ObjectId(reference.id) }).toArray();
        expect(normalize(bookings)).toEqual(normalize(plainBookings));
        return shop;
      };
      expect(normalize(await expectSameDocuments())).toEqual({
        _id: 'ObjectId',
        name: 'Main',
        address: { street: 'Elm', ownerId: 'ObjectId' },
        items: [{ label: 'a', _id: 'ObjectId' }, { label: 'b', _id: 'ObjectId' }],
        __v: 0,
      });

      const change = { name: 'Renamed', address: { street: 'Oak' }, items: [{ label: 'c' }] };
      const updated = await fixture.update({ id: written.id, ...change }, 'score address { street formatted }');
      await plain.update({ id: reference.id, ...change });
      expect(updated).toEqual({ score: 42, address: { street: 'Oak', formatted: 'Oak (formatted)' } });
      await expectSameDocuments();
    });

    test('values that middleware or a controller sets for virtual fields are never written', async () => {
      const objectId = new mongoose.Types.ObjectId().toString();
      const fillVirtualValues = (params, next) => {
        const input = params.args?.input;
        if (params.type?.gqltype?.name === 'VfmHookShop' && ['save', 'update'].includes(params.operation) && input) {
          // Explicit nulls on update would unset a stored field.
          Object.assign(input, params.operation === 'save'
            ? { score: 7, level: 1, ownerRef: objectId, keywords: ['k'], tagIds: [objectId], busyRanges: [{ start: 's' }] }
            : { score: null, level: null, ownerRef: null, keywords: null, tagIds: null, busyRanges: null });
          if (input.address) Object.assign(input.address, { formatted: 'f', lines: ['l'], pin: objectId });
          for (const item of input.items ?? []) Object.assign(item, { codes: [objectId], badge: 'b' });
        }
        return next();
      };
      const controller = {
        onSaving(doc) {
          // Mongoose's strict mode keeps a generated model from storing members it has no path for.
          Object.assign(doc, { score: 9, keywords: ['c'], stats: { visits: 1 } });
        },
      };
      const fixture = createFixture('VfmHook', { middlewares: [fillVirtualValues], controllers: { Shop: controller } });
      const { id } = await fixture.add({ name: 'Hooked', address: { street: 'Elm' }, items: [{ label: 'a' }] });
      const [insert] = log.of('insert', 'VfmHookShop');
      expect(virtualKeysOf(insert.documents)).toEqual([]);
      expect(virtualKeysOf(await fixture.raw('Shop', id))).toEqual([]);

      log.clear();
      const updated = await fixture.update({ id, name: 'Rehooked', address: { street: 'Oak' }, items: [{ label: 'b' }] },
        'score keywords address { formatted }');
      expect(updated).toEqual({ score: 42, keywords: ['Rehooked'], address: { formatted: 'Oak (formatted)' } });
      const [write] = log.of('findAndModify', 'VfmHookShop');
      expect(Object.keys(write.update).sort()).toEqual(['$set']);
      expect(virtualKeysOf(write.update)).toEqual([]);
      // Generated updates also set the stored `id` path, as without virtual fields.
      expect(normalize(await fixture.raw('Shop', id))).toEqual({
        _id: 'ObjectId', id: 'ObjectId', name: 'Rehooked', address: { street: 'Oak' },
        items: [{ label: 'b', _id: 'ObjectId' }], __v: 0,
      });
    });

    test('generated queries resolve virtual fields under by-ID, list, reference and collection reads', async () => {
      const fixture = createFixture('VfmRead');
      const { id } = await fixture.add(SHOP_INPUT(new mongoose.Types.ObjectId().toString()));
      const [booking] = await fixture.model('Booking').find({ shop: id });
      const bookingId = booking._id.toString();
      const data = await fixture.run(`query($id: ID!, $bookingId: ID!) {
        vfmreadshop(id: $id) {
          id score level ownerRef keywords tagIds raw
          busyRanges(date: "2026-10-20") { start end }
          stats { visits } named { label } tagged { ... on VfmReadTag { label } }
          nearby { street formatted ownerId }
          address { street formatted lines pin landmark { id } }
          items { label codes badge }
          topBooking { id when caption(locale: "es") shop { id ownerRef } }
          recentBookings { id }
          bookings { id caption(locale: "en") shop { id score } }
        }
        vfmreadshops { id score ownerRef busyRanges(date: "2026-10-21") { start } }
        vfmreadbooking(id: $bookingId) { caption(locale: "pt") shop { id ownerRef keywords } }
      }`, { id, bookingId }, { tenant: 't1' });
      expect(data.vfmreadshop).toEqual({
        id,
        score: 42,
        level: 'HIGH',
        ownerRef: id,
        keywords: ['Main'],
        tagIds: [],
        raw: { tenant: 't1' },
        busyRanges: [{ start: '2026-10-20T10', end: '2026-10-20T11' }],
        stats: { visits: 3 },
        named: { label: 'named' },
        tagged: [{ label: 'tagged' }],
        nearby: { street: 'Next door', formatted: 'Next door (formatted)', ownerId: null },
        address: { street: 'Elm', formatted: 'Elm (formatted)', lines: ['Elm'], pin: null, landmark: null },
        items: [{ label: 'a', codes: [], badge: '#a' }, { label: 'b', codes: [], badge: '#b' }],
        topBooking: { id: bookingId, when: '2026-10-18', caption: '2026-10-18@es', shop: { id, ownerRef: id } },
        recentBookings: [{ id: bookingId }],
        bookings: [{ id: bookingId, caption: '2026-10-18@en', shop: { id, score: 42 } }],
      });
      expect(data.vfmreadshops).toEqual([{
        id, score: 42, ownerRef: id, busyRanges: [{ start: '2026-10-21T10' }],
      }]);
      expect(data.vfmreadbooking).toEqual({ caption: '2026-10-18@pt', shop: { id, ownerRef: id, keywords: ['Main'] } });
    });

    test('a non-null virtual member does not change how an absent embedded object reads', async () => {
      const fixture = createFixture('VfmAbsent');
      const plain = createFixture('VfmAbsentPlain', { virtual: false });
      const selection = 'address { street ownerId } items { label }';
      const { id } = await fixture.add({ name: 'No address' });
      const { id: plainId } = await plain.add({ name: 'No address' });
      const read = await fixture.run(`query($id: ID!) { vfmabsentshop(id: $id) { ${selection} address { formatted } } }`, { id });
      const plainRead = await plain.run(`query($id: ID!) { vfmabsentplainshop(id: $id) { ${selection} } }`, { id: plainId });
      const { formatted, ...address } = read.vfmabsentshop.address;
      expect({ ...read.vfmabsentshop, address }).toEqual(plainRead.vfmabsentplainshop);
      expect(formatted).toBe('unknown (formatted)');
      expect(normalize(await fixture.raw('Shop', id))).toEqual(normalize(await plain.raw('Shop', plainId)));
    });

    test('native query builds reject paths through virtual fields', async () => {
      const fixture = createFixture('VfmNative', { scalarOnly: true });
      const { Shop } = fixture.types;
      const rejection = (path, field) => ({
        message: `Query path ${path} uses the virtual field ${field}, which is not stored`,
        extensions: { code: 'INVALID_FILTER_FIELD', status: 400 },
      });
      const rejects = (args, path, field = `VfmNativeShop.${path}`) => expect(fixture.adapter.buildQuery(args, Shop))
        .rejects.toMatchObject(rejection(path, field));
      await rejects({ score: { operator: 'EQ', value: 42 } }, 'score');
      await rejects({ keywords: { operator: 'IN', value: ['a'] } }, 'keywords');
      await rejects({ address: { terms: [{ path: 'formatted', operator: 'EQ', value: 'x' }] } },
        'address.formatted', 'VfmNativeAddress.formatted');
      await rejects({ sort: { terms: [{ field: 'level', order: 'ASC' }] } }, 'level');
      await rejects({ AND: [{ conditions: [{ field: 'items', path: 'badge', operator: 'EQ', value: 'x' }] }] },
        'items.badge', 'VfmNativeItem.badge');
      await expect(fixture.adapter.buildFilterGroupMatch(
        { conditions: [{ field: 'tagIds', operator: 'EQ', value: 'x' }] }, Shop, [], {},
      )).rejects.toMatchObject(rejection('tagIds', 'VfmNativeShop.tagIds'));
      await expect(fixture.adapter.aggregate(fixture.model('Shop'), Shop, {
        aggregation: { groupId: 'ownerRef', facts: [{ operation: 'COUNT', factName: 'shops', path: 'id' }] },
      })).rejects.toMatchObject(rejection('ownerRef', 'VfmNativeShop.ownerRef'));
      // Stored fields keep compiling.
      expect(await fixture.adapter.buildQuery({ name: { operator: 'EQ', value: 'x' } }, Shop))
        .toEqual([{ $match: { name: 'x' } }, { $skip: 0 }, { $limit: 100 }]);
    });

    test('an embedded type whose members are all virtual stores nothing, rather than becoming a Mixed path', async () => {
      const resolved = vi.fn((value) => `read ${Object.keys(value).join(',')}`);
      const Meta = new GraphQLObjectType({
        name: 'VfmAllMeta',
        fields: {
          a: virtualField(GraphQLString, resolved),
          b: virtualField(new GraphQLNonNull(GraphQLString), () => 'b'),
        },
      });
      const Shop = new GraphQLObjectType({
        name: 'VfmAllShop',
        fields: {
          id: { type: GraphQLID },
          name: { type: GraphQLString },
          meta: { type: Meta, extensions: { relation: { embedded: true } } },
          metas: { type: new GraphQLList(Meta), extensions: { relation: { embedded: true } } },
        },
      });
      const runtime = createRuntime(createMongoAdapter());
      runtime.connect(null, Shop, 'vfmallshop', 'vfmallshops', {
        onSaving(doc) {
          // Values of virtual members, and other keys, that a controller assigns.
          Object.assign(doc, { meta: { a: 'from controller', b: 'x', junk: 1 }, metas: [{ b: 'y', other: 3 }] });
        },
      });
      runtime.addNoEndpointType(Meta);
      const schema = runtime.createSchema();
      const Model = runtime.getModel(Shop);
      // Strict subdocuments without paths; list items keep their _id, as other embedded list items do.
      expect(Model.schema.path('meta').instance).toBe('Embedded');
      expect(Object.keys(Model.schema.path('meta').schema.paths)).toEqual([]);
      expect(Model.schema.path('metas').$isMongooseDocumentArray).toBe(true);
      expect(Object.keys(Model.schema.path('metas').schema.paths)).toEqual(['_id']);
      expect(Model.schema.indexes().map(([fields]) => fields)).toEqual([{ id: 1 }]);

      log.clear();
      const created = await graphql({ schema, source: 'mutation { addvfmallshop(input: { name: "g" }) { id metas { a b } } }', contextValue: {} });
      expect(created.errors).toBeUndefined();
      const [insert] = log.of('insert', 'VfmAllShop');
      expect(keyNames(insert.documents).filter((key) => ['a', 'b', 'junk', 'other'].includes(key))).toEqual([]);
      const { id } = created.data.addvfmallshop;
      expect(normalize(await Model.collection.findOne({ _id: new mongoose.Types.ObjectId(id) })))
        .toEqual({ _id: 'ObjectId', name: 'g', metas: [{ _id: 'ObjectId' }], __v: 0 });
      // The members still resolve, from the stored item.
      expect(created.data.addvfmallshop.metas).toEqual([{ a: 'read _id', b: 'b' }]);

      const native = await Model.create({ name: 'n', meta: { a: 'n', junk: 2 }, metas: [{ b: 'y', other: 3 }] });
      expect(normalize(await Model.collection.findOne({ _id: native._id })))
        .toEqual({ _id: 'ObjectId', name: 'n', metas: [{ _id: 'ObjectId' }], __v: 0 });
    });

    test('leftover values of fields that became virtual: a model $unset sends nothing, a driver $unset removes them', async () => {
      const fixture = createFixture('VfmLeft');
      const Shop = fixture.model('Shop');
      const { insertedId } = await Shop.collection.insertOne({
        name: 'Legacy', busyRanges: [{ start: 'stored' }], score: 3, address: { street: 'Elm', formatted: 'stale', lines: ['old'] },
      });
      const stored = async () => normalize(await Shop.collection.findOne({ _id: insertedId }));

      // Mongoose strict mode drops the $unset of a path the generated model does not declare.
      log.clear();
      expect(await Shop.updateMany({}, { $unset: { busyRanges: '', 'address.formatted': '' } })).toEqual({ acknowledged: false });
      expect(log.of('update', 'VfmLeftShop')).toEqual([]);
      expect((await stored()).busyRanges).toEqual([{ start: 'stored' }]);

      // A generated update of the embedded parent rewrites it without the keys of its virtual members.
      await fixture.update({ id: insertedId.toString(), address: { street: 'Oak' } });
      expect((await stored()).address).toEqual({ street: 'Oak' });
      expect((await stored()).score).toBe(3);

      // A driver-level update, or strict: false, removes the rest.
      expect(await Shop.collection.updateMany({}, { $unset: { busyRanges: '' } })).toMatchObject({ modifiedCount: 1 });
      expect(await Shop.updateMany({}, { $unset: { score: '' } }, { strict: false })).toMatchObject({ modifiedCount: 1 });
      expect(await stored()).toEqual({
        _id: 'ObjectId', id: 'ObjectId', name: 'Legacy', address: { street: 'Oak' },
      });
    });

    test('a supplied model keeps its own paths: legacy values stay stored and are neither read nor written', async () => {
      // An application model that still declares paths for fields that are now virtual.
      const Supplied = mongoose.model('VfmSupplied', new mongoose.Schema({
        name: String,
        address: { street: String, ownerId: mongoose.Schema.Types.ObjectId },
        items: [{ label: String }],
        score: Number,
        keywords: [String],
      }), 'VfmSupplied');
      const fixture = createFixture('VfmSup', { models: { Shop: Supplied } });
      expect(fixture.model('Shop')).toBe(Supplied);
      const { insertedId } = await Supplied.collection.insertOne({ name: 'Legacy', score: 3, keywords: ['old'] });
      const id = insertedId.toString();
      const read = await fixture.run('query($id: ID!) { vfmsupshop(id: $id) { score keywords busyRanges(date: "d") { start } } }', { id });
      expect(read.vfmsupshop).toEqual({ score: 42, keywords: ['Legacy'], busyRanges: [{ start: 'dT10' }] });

      log.clear();
      expect(await fixture.update({ id, name: 'Renamed' }, 'score keywords')).toEqual({ score: 42, keywords: ['Renamed'] });
      const [write] = log.of('findAndModify', 'VfmSupplied');
      expect(write.update).toEqual({ $set: { name: 'Renamed' } });
      expect(normalize(await fixture.raw('Shop', id))).toEqual({
        _id: 'ObjectId', name: 'Renamed', score: 3, keywords: ['old'],
      });

      // Generated writes set nothing for virtual fields; the supplied model still applies its own
      // defaults, such as `[]` for an array path.
      const created = await fixture.add({ name: 'New', bookings: { added: [{ when: '2026-10-22' }] } }, 'id score');
      expect(created.score).toBe(42);
      expect(normalize(await fixture.raw('Shop', created.id))).toEqual({
        _id: 'ObjectId', name: 'New', items: [], keywords: [], __v: 0,
      });
      expect(await fixture.model('Booking').countDocuments({ shop: created.id })).toBe(1);
    });
  });

  describe('transactional reference integrity', () => {
    let fixture;
    let audit;

    beforeAll(async () => {
      log.clear();
      // A supplied model on the protected registry, without paths for virtual fields.
      const SuppliedBooking = mongoose.model('VfmTxBooking', new mongoose.Schema({
        when: String, shop: { type: mongoose.Schema.Types.ObjectId, index: true },
      }), 'VfmTxBooking');
      fixture = createFixture('VfmTx', {
        adapterOptions: { referentialIntegrity: 'transactional' }, models: { Booking: SuppliedBooking },
      });
      await fixture.adapter.initialize();
      audit = Object.fromEntries(['VfmTxShop', 'VfmTxBooking']
        .map((collection) => [collection, log.of('find', collection).map(({ projection }) => projection)]));
    }, 30000);

    test('createSchema() and initialize() accept virtual fields without relation, and the audit reads no virtual path', () => {
      // Startup audit: one read per protected collection, with _id and the reference paths only.
      expect(audit).toEqual({
        VfmTxShop: [{ _id: 1, _simfinityReferenceLock: 1 }],
        VfmTxBooking: [{ _id: 1, shop: 1, _simfinityReferenceLock: 1 }],
      });
      expect(fixture.model('Shop').schema.path('topBooking')).toBeUndefined();
      expect(fixture.model('Shop').schema.path('address.landmark')).toBeUndefined();
    });

    test('generated models build no path, default or index for virtual fields', async () => {
      const Shop = fixture.model('Shop');
      // The integrity lock path is added at initialization and never selected.
      expect(Object.keys(Shop.schema.paths).sort()).toEqual([...STORED_SHOP_PATHS, '_simfinityReferenceLock'].sort());
      expect(embeddedPaths(Shop, 'items')).toEqual(STORED_ITEM_PATHS);
      expect(Shop.schema.indexes().map(([fields]) => fields)).toEqual(STORED_SHOP_INDEXES);
      expect(await indexNames(Shop)).toEqual(STORED_SHOP_SERVER_INDEXES);
    });

    test('protected writes check only stored references and store nothing for virtual fields', async () => {
      const written = await fixture.add(SHOP_INPUT(new mongoose.Types.ObjectId().toString()),
        'id score topBooking { id caption(locale: "es") } bookings { id }');
      expect(written.score).toBe(42);
      expect(written.topBooking).toEqual({ id: written.bookings[0].id, caption: '2026-10-18@es' });
      // Post-image checks read _id and the reference paths of each written document.
      expect(log.of('find', 'VfmTxShop').map(({ projection }) => projection)).toContainEqual({ _id: 1 });
      expect(log.of('find', 'VfmTxBooking').map(({ projection }) => projection)).toContainEqual({ _id: 1, shop: 1 });
      for (const command of [...log.of('find', 'VfmTxShop'), ...log.of('find', 'VfmTxBooking')]) {
        expect(virtualKeysOf(command.projection ?? {})).toEqual([]);
      }
      expect(normalize(await fixture.raw('Shop', written.id))).toEqual({
        _id: 'ObjectId',
        name: 'Main',
        address: { street: 'Elm', ownerId: 'ObjectId' },
        items: [{ label: 'a', _id: 'ObjectId' }, { label: 'b', _id: 'ObjectId' }],
        __v: 0,
        // Written when the new booking's reference locked its shop.
        _simfinityReferenceLock: 'ObjectId',
      });

      log.clear();
      const updated = await fixture.update({ id: written.id, name: 'Renamed', address: { street: 'Oak' } },
        'name score address { formatted }');
      expect(updated).toEqual({ name: 'Renamed', score: 42, address: { formatted: 'Oak (formatted)' } });
      const [write] = log.of('findAndModify', 'VfmTxShop');
      expect(virtualKeysOf(write.update)).toEqual([]);
      expect(virtualKeysOf(await fixture.raw('Shop', written.id))).toEqual([]);

      // Deleting a booking checks no shop path: the virtual topBooking and address.landmark are
      // not references.
      log.clear();
      const bookingId = written.bookings[0].id;
      const deleted = await fixture.run(`mutation { deletevfmtxbooking(id: "${bookingId}") { id } }`);
      expect(deleted.deletevfmtxbooking).toEqual({ id: bookingId });
      expect(log.of('find', 'VfmTxShop')).toEqual([]);

      // Deleting the shop checks the stored booking reference only.
      await fixture.update({ id: written.id, bookings: { added: [{ when: '2026-10-23' }] } });
      log.clear();
      const blocked = await graphql({
        schema: fixture.schema, source: `mutation { deletevfmtxshop(id: "${written.id}") { id } }`,
      });
      expect(blocked.errors?.[0].extensions).toMatchObject({ code: 'REFERENCE_CONSTRAINT_VIOLATION', status: 409 });
      expect(log.of('find', 'VfmTxBooking').map(({ filter }) => Object.keys(filter))).toEqual([['shop']]);
    });
  });
});
