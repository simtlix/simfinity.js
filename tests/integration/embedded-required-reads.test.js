import { randomUUID } from 'node:crypto';
import {
  afterAll, beforeAll, describe, expect, test,
} from 'vitest';
import {
  GraphQLFloat, GraphQLID, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';
import mongoose from 'mongoose';
import pg from 'pg';

import { createRuntime } from '../../packages/core/src/index.js';
import { createMongoAdapter } from '../../packages/mongodb/src/mongo/adapter.js';
import { createPostgres } from '../../packages/postgres/src/index.js';

const mongoUri = process.env.SIMFINITY_MONGODB_URI;
const postgresUri = process.env.SIMFINITY_POSTGRES_URI;

const embedded = (type) => ({ type, extensions: { relation: { embedded: true } } });

// Store embeds an object without list members; Shop embeds one with a scalar list and a nested
// object that has its own list, which MongoDB materializes as list defaults.
const createTypes = () => {
  const Plain = new GraphQLObjectType({
    name: 'DataLessPlain',
    fields: { street: { type: new GraphQLNonNull(GraphQLString) }, city: { type: GraphQLString } },
  });
  const Store = new GraphQLObjectType({
    name: 'DataLessStore',
    fields: { id: { type: GraphQLID }, name: { type: GraphQLString }, main: embedded(Plain) },
  });
  const Geo = new GraphQLObjectType({
    name: 'DataLessGeo',
    fields: {
      lat: { type: new GraphQLNonNull(GraphQLFloat) },
      lng: { type: new GraphQLNonNull(GraphQLFloat) },
      aliases: { type: new GraphQLList(GraphQLString) },
    },
  });
  const Address = new GraphQLObjectType({
    name: 'DataLessAddress',
    fields: {
      street: { type: new GraphQLNonNull(GraphQLString) },
      city: { type: GraphQLString },
      phones: { type: new GraphQLList(GraphQLString) },
      geo: embedded(Geo),
    },
  });
  const Shop = new GraphQLObjectType({
    name: 'DataLessShop',
    fields: { id: { type: GraphQLID }, name: { type: GraphQLString }, main: embedded(Address) },
  });
  return {
    Plain, Store, Geo, Address, Shop,
  };
};

describe.skipIf(!mongoUri || !postgresUri)('MongoDB reads data-less embedded objects that miss a required member as null', () => {
  const namespace = `dataless_${randomUUID().replaceAll('-', '')}`;
  let pool;
  const backends = [];

  const execute = (backend, source, variableValues) => graphql({ schema: backend.schema, source, variableValues });
  // The mutation response, then the by-ID and list reads of the same record, with no errors.
  const readAll = async (backend, entity, id, selection, mutationResult) => {
    const byId = await execute(backend, `query($id: ID) { dataLess${entity}(id: $id) { ${selection} } }`, { id });
    const list = await execute(backend, `{ dataLess${entity}s(pagination: { page: 1, size: 50 }) { id ${selection} } }`);
    for (const result of [mutationResult, byId, list]) expect(result.errors, backend.name).toBeUndefined();
    return [
      Object.values(mutationResult.data)[0].main,
      byId.data[`dataLess${entity}`].main,
      list.data[`dataLess${entity}s`].find((row) => row.id === id).main,
    ];
  };
  const rawMain = async (backend, type, id) => {
    const raw = await backend.api.getModel(type).collection.findOne({ _id: new mongoose.Types.ObjectId(id) });
    return raw.main;
  };

  beforeAll(async () => {
    await mongoose.connect(mongoUri, { dbName: namespace });
    pool = new pg.Pool({ connectionString: postgresUri });
    for (const [name, api] of [['mongodb', createRuntime(createMongoAdapter())], ['postgres', createPostgres({ pool, schema: namespace })]]) {
      if (!api.initializeDatabase) api.preventCreatingCollection(true);
      const types = createTypes();
      api.addNoEndpointType(types.Plain);
      api.addNoEndpointType(types.Geo);
      api.addNoEndpointType(types.Address);
      api.connect(null, types.Store, 'dataLessStore', 'dataLessStores');
      api.connect(null, types.Shop, 'dataLessShop', 'dataLessShops');
      const schema = api.createSchema();
      if (api.initializeDatabase) await api.initializeDatabase();
      else for (const { model } of api.getRegistrations()) if (model) await model.createCollection();
      backends.push({
        name, api, schema, types,
      });
    }
  }, 30000);

  afterAll(async () => {
    if (mongoose.connection.readyState) {
      await mongoose.connection.db.dropDatabase();
      await mongoose.disconnect();
    }
    mongoose.deleteModel(/^DataLess/);
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await pool.end();
    }
  });

  test.each([
    ['without list members', 'Store', 'main: { street: "S", city: "C" }'],
    ['with list members', 'Shop', 'main: { street: "S", city: "C", phones: ["1"], geo: { lat: 1, lng: 2, aliases: ["a"] } }'],
  ])('every backend reads an object %s cleared with null as null on every read path', async (label, entity, main) => {
    const selections = ['main { street city }', 'main { city }'];
    const results = [];
    for (const backend of backends) {
      const added = await execute(backend, `mutation { addDataLess${entity}: adddataLess${entity}(input: { name: "n", ${main} }) { id } }`);
      expect(added.errors, backend.name).toBeUndefined();
      const { id } = added.data[`addDataLess${entity}`];
      const reads = [];
      for (const selection of selections) {
        const cleared = await execute(backend, `mutation($id: ID!) {
          updatedataLess${entity}(input: { id: $id, main: null }) { ${selection} }
        }`, { id });
        reads.push(await readAll(backend, entity, id, selection, cleared));
      }
      if (backend.name === 'mongodb') expect(await rawMain(backend, backend.types[entity], id)).toBeUndefined();
      results.push(reads);
    }

    // Also when the selection names no required member.
    expect(results[0]).toEqual([[null, null, null], [null, null, null]]);
    expect(results[1]).toEqual(results[0]);
  });

  test('MongoDB reads an omitted object stored with its list defaults as null, which PostgreSQL rejects', async () => {
    const [mongodb, postgres] = backends;
    const selection = 'main { street city phones geo { lat } }';
    const add = (backend) => execute(backend, `mutation { adddataLessShop(input: { name: "omitted" }) { id ${selection} } }`);

    const added = await add(mongodb);

    const { id } = added.data.adddataLessShop;
    // Storage is unchanged: Mongoose stores the omitted object with its list defaults.
    expect(await rawMain(mongodb, mongodb.types.Shop, id)).toEqual({ phones: [], geo: { aliases: [] } });
    expect(await readAll(mongodb, 'Shop', id, selection, added)).toEqual([null, null, null]);
    const rejected = await add(postgres);
    expect(rejected.errors?.[0]).toMatchObject({
      message: 'Required value street is missing', extensions: { code: 'REQUIRED_VALUE' },
    });
  });

  test('MongoDB reads an omitted nested object stored with its list defaults as null, which PostgreSQL rejects', async () => {
    const [mongodb, postgres] = backends;
    const selection = 'main { street city phones geo { lat } }';
    const add = (backend) => execute(backend, `mutation { adddataLessShop(input: { name: "nested", main: { street: "M" } }) { id ${selection} } }`);

    const added = await add(mongodb);

    const { id } = added.data.adddataLessShop;
    expect(await rawMain(mongodb, mongodb.types.Shop, id)).toEqual({ street: 'M', phones: [], geo: { aliases: [] } });
    const expected = {
      street: 'M', city: null, phones: [], geo: null,
    };
    expect(await readAll(mongodb, 'Shop', id, selection, added)).toEqual([expected, expected, expected]);
    const rejected = await add(postgres);
    expect(rejected.errors?.[0]).toMatchObject({
      message: 'Required value lat is missing', extensions: { code: 'REQUIRED_VALUE' },
    });
  });
});

// Objects that hold data the read rule must find where MongoDB stores it, and objects that a create
// stores without a member it wrote, since Mongoose minimizes the empty object written for it.
describe.skipIf(!mongoUri)('MongoDB reads of embedded objects whose data the read rule must find', () => {
  const namespace = `datakept_${randomUUID().replaceAll('-', '')}`;
  let schema;
  let runtime;

  const run = async (source) => {
    const result = await graphql({ schema, source, contextValue: {} });
    expect(result.errors).toBeUndefined();
    return result.data;
  };
  const rawOf = async (type, id) => runtime.getModel(type).collection.findOne({ _id: new mongoose.Types.ObjectId(id) });
  // The mutation response, then the by-ID and list reads of the same record.
  const readAll = async (endpoint, id, field, selection, added) => {
    const byId = await run(`{ ${endpoint}(id: "${id}") { ${field} { ${selection} } } }`);
    const list = await run(`{ ${endpoint}s { id ${field} { ${selection} } } }`);
    return [added[field], byId[endpoint][field], list[`${endpoint}s`].find((row) => row.id === id)[field]];
  };

  const types = {};
  beforeAll(async () => {
    await mongoose.connect(mongoUri, { dbName: namespace });
    types.Owner = new GraphQLObjectType({
      name: 'DataKeptOwner', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } },
    });
    // Its only data is a required reference, stored under its connectionField.
    types.Assignment = new GraphQLObjectType({
      name: 'DataKeptAssignment',
      fields: {
        owner: { type: new GraphQLNonNull(types.Owner), extensions: { relation: { connectionField: 'ownerId' } } },
        note: { type: GraphQLString },
      },
    });
    types.Desk = new GraphQLObjectType({
      name: 'DataKeptDesk',
      fields: { id: { type: GraphQLID }, name: { type: GraphQLString }, assignment: embedded(types.Assignment) },
    });
    types.Geo = new GraphQLObjectType({ name: 'DataKeptGeo', fields: { lat: { type: GraphQLFloat } } });
    types.Address = new GraphQLObjectType({
      name: 'DataKeptAddress',
      fields: {
        geo: embedded(new GraphQLNonNull(types.Geo)),
        tags: { type: new GraphQLList(GraphQLString) },
        note: { type: GraphQLString },
      },
    });
    const shop = (name) => new GraphQLObjectType({
      name, fields: { id: { type: GraphQLID }, name: { type: GraphQLString }, main: embedded(types.Address) },
    });
    types.Shop = shop('DataKeptShop');
    types.SuppliedShop = shop('DataKeptSuppliedShop');
    const suppliedModel = mongoose.model('DataKeptSuppliedShop', new mongoose.Schema({
      name: String,
      main: { geo: new mongoose.Schema({ lat: Number }, { _id: false }), tags: [String], note: String },
    }), 'DataKeptSuppliedShop');

    runtime = createRuntime(createMongoAdapter());
    runtime.preventCreatingCollection(true);
    runtime.connect(null, types.Owner, 'dataKeptOwner', 'dataKeptOwners');
    for (const type of [types.Assignment, types.Geo, types.Address]) runtime.addNoEndpointType(type);
    runtime.connect(null, types.Desk, 'dataKeptDesk', 'dataKeptDesks');
    runtime.connect(null, types.Shop, 'dataKeptShop', 'dataKeptShops');
    runtime.connect(suppliedModel, types.SuppliedShop, 'dataKeptSuppliedShop', 'dataKeptSuppliedShops');
    schema = runtime.createSchema();
    for (const { model } of runtime.getRegistrations()) if (model) await model.createCollection();
  }, 30000);

  afterAll(async () => {
    if (mongoose.connection.readyState) {
      await mongoose.connection.db.dropDatabase();
      await mongoose.disconnect();
    }
    mongoose.deleteModel(/^DataKept/);
  });

  test('keeps an object whose only data is a reference stored under its connectionField', async () => {
    const { adddataKeptOwner: owner } = await run('mutation { adddataKeptOwner(input: { name: "o" }) { id } }');
    const { adddataKeptDesk: added } = await run(`mutation {
      adddataKeptDesk(input: { name: "d", assignment: { owner: { id: "${owner.id}" } } }) { id assignment { owner { id } note } }
    }`);

    expect(await rawOf(types.Desk, added.id)).toMatchObject({ assignment: { ownerId: new mongoose.Types.ObjectId(owner.id) } });
    const expected = { owner: { id: owner.id }, note: null };
    expect(await readAll('dataKeptDesk', added.id, 'assignment', 'owner { id } note', added))
      .toEqual([expected, expected, expected]);
  });

  test.each([
    // A generated model renders the absent nested path as {} on by-ID reads.
    ['a generated model', 'dataKeptShop', 'Shop', { tags: [] }],
    ['a supplied model with a single nested schema', 'dataKeptSuppliedShop', 'SuppliedShop', null],
  ])('a create with %s stores an empty object written for a required embedded member as absent', async (label, endpoint, type, byId) => {
    const added = (await run(`mutation {
      add${endpoint}(input: { name: "m", main: { geo: {}, tags: [] } }) { id main { tags } }
    }`))[`add${endpoint}`];

    // Mongoose minimizes `geo: {}` away, so the stored object holds no data and misses `geo`, as an
    // omitted one would: it reads as null.
    expect((await rawOf(types[type], added.id)).main).toEqual({ tags: [] });
    expect(await readAll(endpoint, added.id, 'main', 'tags', added)).toEqual([null, byId, null]);

    // An update stores the empty object, so the record reads back as written.
    const updated = (await run(`mutation {
      update${endpoint}(input: { id: "${added.id}", main: { geo: {}, tags: [] } }) { main { tags } }
    }`))[`update${endpoint}`];
    expect((await rawOf(types[type], added.id)).main).toEqual({ geo: {}, tags: [] });
    expect(await readAll(endpoint, added.id, 'main', 'tags', updated)).toEqual([{ tags: [] }, { tags: [] }, { tags: [] }]);
  });
});

// The read rule reads stored data: it runs no schema getter of a supplied model, and counts the `_id`
// of a subdocument as the `id` it holds. The records are existing ones, written natively.
describe.skipIf(!mongoUri)('MongoDB reads of supplied-model embedded objects by their stored data', () => {
  const namespace = `datastored_${randomUUID().replaceAll('-', '')}`;
  const getterCalls = [];
  const models = {};
  let schema;

  const run = (source) => graphql({ schema, source, contextValue: {} });
  // The by-ID and list reads of the same record, with no errors.
  const readBoth = async (endpoint, id, selection) => {
    const byId = await run(`{ ${endpoint}(id: "${id}") { ${selection} } }`);
    const list = await run(`{ ${endpoint}s { id ${selection} } }`);
    expect([byId.errors, list.errors]).toEqual([undefined, undefined]);
    const { id: listedId, ...listed } = list.data[`${endpoint}s`].find((row) => row.id === id);
    expect(listedId).toBe(id);
    return [byId.data[endpoint], listed];
  };

  beforeAll(async () => {
    await mongoose.connect(mongoUri, { dbName: namespace });
    const secret = {
      type: String,
      get(value) {
        getterCalls.push(value);
        throw new Error('secret getter');
      },
    };
    // `secret` comes first, so a rule that read members through their getters would reach it first.
    const Details = new GraphQLObjectType({
      name: 'DataStoredDetails', fields: { secret: { type: GraphQLString }, visible: { type: GraphQLString } },
    });
    const Secured = new GraphQLObjectType({
      name: 'DataStoredSecured',
      fields: {
        secret: { type: GraphQLString }, code: { type: new GraphQLNonNull(GraphQLString) }, visible: { type: GraphQLString },
      },
    });
    const Shop = new GraphQLObjectType({
      name: 'DataStoredShop',
      fields: {
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        details: embedded(Details),
        secured: embedded(Secured),
        sub: embedded(Secured),
      },
    });
    // `secured` is a nested path, `sub` a single nested subdocument.
    models.Shop = mongoose.model('DataStoredShop', new mongoose.Schema({
      name: String,
      details: { secret, visible: String },
      secured: { secret, code: String, visible: String },
      sub: new mongoose.Schema({ secret, code: String, visible: String }, { _id: false }),
    }), 'DataStoredShop');
    // An entity that a supplied model also embeds as a subdocument with its own `_id`.
    const Part = new GraphQLObjectType({
      name: 'DataStoredPart', fields: { id: { type: GraphQLID }, name: { type: new GraphQLNonNull(GraphQLString) } },
    });
    const Root = new GraphQLObjectType({
      name: 'DataStoredRoot', fields: { id: { type: GraphQLID }, name: { type: GraphQLString }, part: embedded(Part) },
    });
    models.Root = mongoose.model('DataStoredRoot', new mongoose.Schema({
      name: String, part: new mongoose.Schema({ name: String }),
    }), 'DataStoredRoot');

    const runtime = createRuntime(createMongoAdapter());
    runtime.preventCreatingCollection(true);
    runtime.addNoEndpointType(Details);
    runtime.addNoEndpointType(Secured);
    runtime.connect(models.Shop, Shop, 'dataStoredShop', 'dataStoredShops');
    runtime.connect(null, Part, 'dataStoredPart', 'dataStoredParts');
    runtime.connect(models.Root, Root, 'dataStoredRoot', 'dataStoredRoots');
    schema = runtime.createSchema();
    for (const { model } of runtime.getRegistrations()) if (model) await model.createCollection();
  }, 30000);

  afterAll(async () => {
    if (mongoose.connection.readyState) {
      await mongoose.connection.db.dropDatabase();
      await mongoose.disconnect();
    }
    mongoose.deleteModel(/^DataStored/);
  });

  test('reads an object whose type has no required member that counts without running getters of unselected members', async () => {
    getterCalls.length = 0;
    const { insertedId } = await models.Shop.collection.insertOne({ name: 's', details: { visible: 'ok', secret: 's' } });
    const id = insertedId.toHexString();

    const reads = await readBoth('dataStoredShop', id, 'details { visible }');
    const updated = await run(`mutation { updatedataStoredShop(input: { id: "${id}", name: "u" }) { details { visible } } }`);

    expect(reads).toEqual([{ details: { visible: 'ok' } }, { details: { visible: 'ok' } }]);
    expect(updated).toEqual({ data: { updatedataStoredShop: { details: { visible: 'ok' } } } });
    expect(getterCalls).toEqual([]);
  });

  test('reads an object whose type has a required member that counts without running getters, keeping hydrated ones whose schema declares one', async () => {
    getterCalls.length = 0;
    const { insertedIds } = await models.Shop.collection.insertMany([
      { name: 'kept', secured: { code: 'c', secret: 's' }, sub: { code: 'c', secret: 's' } },
      { name: 'empty', secured: {}, sub: {} },
    ]);
    const [kept, empty] = [insertedIds[0], insertedIds[1]].map((id) => id.toHexString());

    const keptReads = await readBoth('dataStoredShop', kept, 'secured { visible } sub { visible }');
    const emptyReads = await readBoth('dataStoredShop', empty, 'secured { visible } sub { visible }');

    const keptRead = { secured: { visible: null }, sub: { visible: null } };
    expect(keptReads).toEqual([keptRead, keptRead]);
    // They hold no data and miss `code`. Their schema declares a getter, so by-ID reads keep them
    // unread, as 3.5.8 did; list reads, which return the stored data, read them as null (#157).
    expect(emptyReads).toEqual([keptRead, { secured: null, sub: null }]);
    expect(getterCalls).toEqual([]);
  });

  test('keeps an embedded entity whose only stored data is its `_id`', async () => {
    const partId = new mongoose.Types.ObjectId();
    const { insertedId } = await models.Root.collection.insertOne({ name: 'r', part: { _id: partId } });

    const reads = await readBoth('dataStoredRoot', insertedId.toHexString(), 'part { id }');

    // The generated resolver of the entity reads `_id`, on list and by-ID reads alike.
    const expected = { part: { id: partId.toHexString() } };
    expect(reads).toEqual([expected, expected]);
  });
});

// Objects of supplied models whose required member a getter, a virtual or an alias renders: reads of
// hydrated documents (by ID, through a reference and in update responses) keep them unread, as 3.5.8
// rendered them, and run no getter of an unselected member. Maps and generated models are read by
// their stored data on every read path. The records are existing ones, written natively.
describe.skipIf(!mongoUri)('MongoDB reads of supplied-model embedded objects that the schema renders', () => {
  const namespace = `datarendered_${randomUUID().replaceAll('-', '')}`;
  const calls = [];
  const members = ['getter', 'getterSub', 'virtual', 'virtualSub', 'alias', 'aliasSub'];
  const models = {};
  let schema;
  let runtime;

  const run = async (source) => {
    const result = await graphql({ schema, source, contextValue: {} });
    expect(result.errors).toBeUndefined();
    return result.data;
  };
  // The by-ID, reference, update-response and list reads of the same record.
  const readAll = async (id, selection) => {
    const { insertedId: linkId } = await models.Link.collection.insertOne({ name: 'l', rootId: new mongoose.Types.ObjectId(id) });
    const byId = await run(`{ dataRenderedRoot(id: "${id}") { ${selection} } }`);
    const reference = await run(`{ dataRenderedLink(id: "${linkId.toHexString()}") { root { ${selection} } } }`);
    const updated = await run(`mutation { updatedataRenderedRoot(input: { id: "${id}", name: "u" }) { ${selection} } }`);
    const list = await run(`{ dataRenderedRoots { id ${selection} } }`);
    const { id: listedId, ...listed } = list.dataRenderedRoots.find((row) => row.id === id);
    expect(listedId).toBe(id);
    return [byId.dataRenderedRoot, reference.dataRenderedLink.root, updated.updatedataRenderedRoot, listed];
  };
  const insert = async (document) => (await models.Root.collection.insertOne({ name: 'r', ...document })).insertedId.toHexString();

  beforeAll(async () => {
    await mongoose.connect(mongoUri, { dbName: namespace });
    const track = (name, value) => {
      calls.push(name);
      return value;
    };
    const codeByGetter = { type: String, get: (value) => track('getter', value ?? 'default') };
    const Coded = new GraphQLObjectType({
      name: 'DataRenderedCoded', fields: { code: { type: new GraphQLNonNull(GraphQLString) }, other: { type: GraphQLString } },
    });
    const Root = new GraphQLObjectType({
      name: 'DataRenderedRoot',
      fields: {
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        ...Object.fromEntries(members.map((member) => [member, embedded(Coded)])),
        meta: embedded(Coded),
      },
    });
    const Link = new GraphQLObjectType({
      name: 'DataRenderedLink',
      fields: {
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        root: { type: Root, extensions: { relation: { connectionField: 'rootId' } } },
      },
    });
    const virtualSub = new mongoose.Schema({ other: String }, { _id: false });
    virtualSub.virtual('code').get(() => track('virtual', 'virtual'));
    // Nested paths and single nested subdocuments of each kind.
    const rootSchema = new mongoose.Schema({
      name: String,
      getter: { code: codeByGetter, other: String },
      getterSub: new mongoose.Schema({ code: codeByGetter, other: String }, { _id: false }),
      virtual: { other: String },
      virtualSub,
      // An alias stores its value under its own path, `c`.
      alias: { c: { type: String, alias: 'alias.code' }, other: String },
      aliasSub: new mongoose.Schema({ c: { type: String, alias: 'code' }, other: String }, { _id: false }),
      meta: { type: Map, of: String },
    });
    rootSchema.virtual('virtual.code').get(() => track('virtual', 'virtual'));
    models.Root = mongoose.model('DataRenderedRoot', rootSchema, 'DataRenderedRoot');

    // A generated model whose embedded object has an embedded list, whose items Mongoose gives an
    // `_id` and its automatic `id` virtual.
    const Item = new GraphQLObjectType({ name: 'DataRenderedItem', fields: { x: { type: GraphQLString } } });
    const Address = new GraphQLObjectType({
      name: 'DataRenderedAddress',
      fields: {
        street: { type: new GraphQLNonNull(GraphQLString) },
        items: { type: new GraphQLList(Item), extensions: { relation: { embedded: true } } },
      },
    });
    const Shop = new GraphQLObjectType({
      name: 'DataRenderedShop', fields: { id: { type: GraphQLID }, name: { type: GraphQLString }, main: embedded(Address) },
    });

    runtime = createRuntime(createMongoAdapter());
    runtime.preventCreatingCollection(true);
    for (const type of [Coded, Item, Address]) runtime.addNoEndpointType(type);
    runtime.connect(models.Root, Root, 'dataRenderedRoot', 'dataRenderedRoots');
    runtime.connect(null, Link, 'dataRenderedLink', 'dataRenderedLinks');
    runtime.connect(null, Shop, 'dataRenderedShop', 'dataRenderedShops');
    schema = runtime.createSchema();
    models.Link = runtime.getModel(Link);
    models.Shop = runtime.getModel(Shop);
    for (const { model } of runtime.getRegistrations()) if (model) await model.createCollection();
  }, 30000);

  afterAll(async () => {
    if (mongoose.connection.readyState) {
      await mongoose.connection.db.dropDatabase();
      await mongoose.disconnect();
    }
    mongoose.deleteModel(/^DataRendered/);
  });

  test('keeps hydrated objects whose required member a getter, a virtual or an alias supplies, as 3.5.8 did', async () => {
    const id = await insert({
      getter: {}, getterSub: {}, virtual: {}, virtualSub: {}, alias: { c: 'a' }, aliasSub: { c: 'b' },
    });
    const rendered = {
      getter: { code: 'default' },
      getterSub: { code: 'default' },
      virtual: { code: 'virtual' },
      virtualSub: { code: 'virtual' },
      alias: { code: 'a' },
      aliasSub: { code: 'b' },
    };
    const nulls = Object.fromEntries(members.map((member) => [member, null]));

    calls.length = 0;
    const withCode = await readAll(id, members.map((member) => `${member} { code }`).join(' '));
    const selectedCalls = calls.splice(0);
    const withoutCode = await readAll(id, members.map((member) => `${member} { other }`).join(' '));

    // List reads return the stored data, which renders no getter, virtual or alias: those objects
    // hold no data and miss `code` (#157).
    expect(withCode).toEqual([rendered, rendered, rendered, nulls]);
    const others = Object.fromEntries(members.map((member) => [member, { other: null }]));
    expect(withoutCode).toEqual([others, others, others, nulls]);
    // Getters and virtuals run only for the members a query selects.
    expect([...new Set(selectedCalls)].sort()).toEqual(['getter', 'virtual']);
    expect(calls).toEqual([]);
  });

  test('reads an empty Mongoose map as null on by-ID, reference, update and list reads', async () => {
    const empty = await insert({ meta: {} });
    const held = await insert({ meta: { other: 'x' } });

    expect(await readAll(empty, 'meta { other }')).toEqual([{ meta: null }, { meta: null }, { meta: null }, { meta: null }]);
    // A hydrated map renders no entry as a member, as on 3.5.8; list reads return its stored entries.
    const kept = { meta: { other: null } };
    expect(await readAll(held, 'meta { other }')).toEqual([kept, kept, kept, { meta: { other: 'x' } }]);
  });

  test('reads data-less objects of a generated model with an embedded list as null', async () => {
    const { insertedIds } = await models.Shop.collection.insertMany([{ name: 'absent' }, { name: 'empty', main: { items: [] } }]);

    for (const id of Object.values(insertedIds).map((value) => value.toHexString())) {
      const byId = await run(`{ dataRenderedShop(id: "${id}") { main { street items { x } } } }`);
      const list = await run('{ dataRenderedShops { id main { street items { x } } } }');
      expect([byId.dataRenderedShop.main, list.dataRenderedShops.find((row) => row.id === id).main]).toEqual([null, null]);
    }
  });
});
