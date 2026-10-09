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
