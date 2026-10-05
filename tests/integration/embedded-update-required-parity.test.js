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
import { createContractModelFixtures } from '../contracts/model-fixtures.js';

const mongoUri = process.env.SIMFINITY_MONGODB_URI;
const postgresUri = process.env.SIMFINITY_POSTGRES_URI;

const createListTypes = () => {
  const ListItem = new GraphQLObjectType({
    name: 'RequiredUpdateListItem',
    fields: {
      label: { type: GraphQLString },
      tags: { type: new GraphQLNonNull(new GraphQLList(GraphQLString)) },
    },
  });
  const ListOuter = new GraphQLObjectType({
    name: 'RequiredUpdateListOuter',
    fields: {
      note: { type: GraphQLString },
      inner: { type: ListItem, extensions: { relation: { embedded: true } } },
    },
  });
  const ListRoot = new GraphQLObjectType({
    name: 'RequiredUpdateListRoot',
    fields: {
      id: { type: GraphQLID },
      items: { type: new GraphQLList(ListItem), extensions: { relation: { embedded: true } } },
      main: { type: ListItem, extensions: { relation: { embedded: true } } },
      outer: { type: ListOuter, extensions: { relation: { embedded: true } } },
    },
  });
  return { ListItem, ListOuter, ListRoot };
};

const createShopTypes = () => {
  const Geo = new GraphQLObjectType({
    name: 'RequiredUpdateGeo',
    fields: {
      lat: { type: new GraphQLNonNull(GraphQLFloat) },
      lng: { type: new GraphQLNonNull(GraphQLFloat) },
      aliases: { type: new GraphQLList(GraphQLString) },
    },
  });
  const Address = new GraphQLObjectType({
    name: 'RequiredUpdateAddress',
    fields: {
      street: { type: new GraphQLNonNull(GraphQLString) },
      city: { type: GraphQLString },
      geo: { type: Geo, extensions: { relation: { embedded: true } } },
    },
  });
  const Shop = new GraphQLObjectType({
    name: 'RequiredUpdateShop',
    fields: {
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      main: { type: Address, extensions: { relation: { embedded: true } } },
    },
  });
  return { Geo, Address, Shop };
};

// A nullable reference and a scalar list make PostgreSQL store the embedded tree in owned tables.
const createClearTypes = (prefix) => {
  const Geo = new GraphQLObjectType({
    name: `${prefix}Geo`,
    fields: {
      lat: { type: new GraphQLNonNull(GraphQLFloat) },
      lng: { type: new GraphQLNonNull(GraphQLFloat) },
      aliases: { type: new GraphQLList(GraphQLString) },
    },
  });
  const Person = new GraphQLObjectType({
    name: `${prefix}Person`,
    fields: { id: { type: GraphQLID }, name: { type: GraphQLString } },
  });
  const Address = new GraphQLObjectType({
    name: `${prefix}Address`,
    fields: {
      street: { type: new GraphQLNonNull(GraphQLString) },
      city: { type: GraphQLString },
      phones: { type: new GraphQLList(GraphQLString) },
      geo: { type: Geo, extensions: { relation: { embedded: true } } },
      reviewer: { type: Person, extensions: { relation: { embedded: false, connectionField: 'reviewerId' } } },
    },
  });
  const Shop = new GraphQLObjectType({
    name: `${prefix}Shop`,
    fields: {
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      main: { type: Address, extensions: { relation: { embedded: true } } },
    },
  });
  return {
    Geo, Person, Address, Shop,
  };
};

const registerClearTypes = (api, prefix) => {
  const types = createClearTypes(prefix);
  const endpoint = `${prefix.charAt(0).toLowerCase()}${prefix.slice(1)}`;
  api.addNoEndpointType(types.Geo);
  api.addNoEndpointType(types.Address);
  api.connect(null, types.Person, `${endpoint}Person`, `${endpoint}Persons`);
  api.connect(null, types.Shop, `${endpoint}Shop`, `${endpoint}Shops`);
  return { prefix, endpoint, types };
};

describe.skipIf(!mongoUri || !postgresUri)('MongoDB/PostgreSQL required embedded update parity', () => {
  const namespace = `required_${randomUUID().replaceAll('-', '')}`;
  const fields = 'id director { name country } credits { role star { name } }';
  const listFields = 'id items { label tags } main { label tags } outer { note inner { label tags } }';
  let pool;
  let backends;
  let clearBackends;

  const execute = (backend, source, variableValues) => graphql({ schema: backend.schema, source, variableValues });
  const update = (backend, input) => execute(
    backend,
    `mutation($input: ContractSerieInputForUpdate!) { updatecontractserie(input: $input) { ${fields} } }`,
    { input },
  );
  const read = async (backend, id) => {
    const result = await execute(backend, `query($id: ID) { contractserie(id: $id) { ${fields} } }`, { id });
    expect(result.errors).toBeUndefined();
    return result.data.contractserie;
  };
  const updateListRoot = (backend, input) => execute(
    backend,
    'mutation($input: RequiredUpdateListRootInputForUpdate!) { updaterequiredUpdateListRoot(input: $input) { id } }',
    { input },
  );
  // Paginated lists read stored documents directly, so they expose members the update omitted.
  const listRoot = async (backend, id) => {
    const result = await execute(
      backend,
      `{ requiredUpdateListRoots(pagination: { page: 1, size: 50 }) { ${listFields} } }`,
    );
    expect(result.errors).toBeUndefined();
    return result.data.requiredUpdateListRoots.find((row) => row.id === id);
  };

  beforeAll(async () => {
    await mongoose.connect(mongoUri, { dbName: namespace });
    pool = new pg.Pool({ connectionString: postgresUri });
    backends = [
      { name: 'mongodb', api: createRuntime(createMongoAdapter()), fixture: createContractModelFixtures() },
      { name: 'postgres', api: createPostgres({ pool, schema: namespace }), fixture: createContractModelFixtures() },
    ];
    for (const backend of backends) {
      if (!backend.api.initializeDatabase) backend.api.preventCreatingCollection(true);
      const { ListItem, ListOuter, ListRoot } = createListTypes();
      backend.api.addNoEndpointType(ListItem);
      backend.api.addNoEndpointType(ListOuter);
      backend.api.connect(null, ListRoot, 'requiredUpdateListRoot', 'requiredUpdateListRoots');
      backend.shopTypes = createShopTypes();
      backend.api.addNoEndpointType(backend.shopTypes.Geo);
      backend.api.addNoEndpointType(backend.shopTypes.Address);
      backend.api.connect(null, backend.shopTypes.Shop, 'requiredUpdateShop', 'requiredUpdateShops');
      backend.clear = registerClearTypes(backend.api, backend.name === 'mongodb' ? 'ClearMongo' : 'ClearPostgres');
      for (const registration of backend.fixture.registrations) {
        if (registration.endpoint) {
          backend.api.connect(null, registration.gqltype, registration.simpleEntityEndpointName,
            registration.listEntitiesEndpointName, registration.controller);
        } else {
          backend.api.addNoEndpointType(registration.gqltype);
        }
      }
      backend.schema = backend.api.createSchema();
      if (backend.api.initializeDatabase) await backend.api.initializeDatabase();
      else for (const { model } of backend.api.getRegistrations()) if (model) await model.createCollection();
      const star = await backend.api.getModel(backend.fixture.types.ContractStar).create({ name: 'Lead' });
      backend.starId = String(star._id);
    }

    // Transactional reference integrity validates and writes the same updates in a transaction.
    const transactionalAdapter = createMongoAdapter({ referentialIntegrity: 'transactional' });
    const transactional = { name: 'mongodb-transactional', api: createRuntime(transactionalAdapter) };
    transactional.api.preventCreatingCollection(true);
    transactional.clear = registerClearTypes(transactional.api, 'ClearMongoTx');
    transactional.schema = transactional.api.createSchema();
    for (const { model } of transactional.api.getRegistrations()) if (model) await model.createCollection();
    await transactionalAdapter.initialize();
    clearBackends = [backends[0], transactional, backends[1]];
    for (const backend of clearBackends) {
      const reviewer = await backend.api.getModel(backend.clear.types.Person).create({ name: 'R' });
      backend.reviewerId = String(reviewer._id);
    }
  }, 30000);

  afterAll(async () => {
    if (mongoose.connection.readyState) {
      await mongoose.connection.db.dropDatabase();
      await mongoose.disconnect();
    }
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await pool.end();
    }
  });

  const addSerie = async (backend, input) => {
    const result = await execute(
      backend,
      'mutation($input: ContractSerieInput!) { addcontractserie(input: $input) { id } }',
      { input: { tenant: 'a', title: 'Serie', ...input } },
    );
    expect(result.errors).toBeUndefined();
    return result.data.addcontractserie.id;
  };

  test('both backends reject incomplete embedded values and keep stored data', async () => {
    for (const backend of backends) {
      const id = await addSerie(backend, { credits: [{ role: 'First', star: { id: backend.starId } }] });
      const before = await read(backend, id);

      const director = await update(backend, { id, director: { country: 'UY' } });
      const credits = await update(backend, { id, credits: [{ role: 'Only' }] });

      expect(director.errors?.[0]).toMatchObject({
        message: 'Required value name is missing', extensions: { code: 'REQUIRED_VALUE' },
      });
      expect(credits.errors?.[0]).toMatchObject({
        message: 'Required value star is missing', extensions: { code: 'REQUIRED_VALUE' },
      });
      expect(await read(backend, id)).toEqual(before);
    }
  });

  test('both backends store omitted required list members as empty lists', async () => {
    const results = [];
    for (const backend of backends) {
      const added = await execute(backend, `mutation {
        addrequiredUpdateListRoot(input: { outer: { note: "n", inner: { label: "i", tags: ["t"] } } }) { id }
      }`);
      expect(added.errors, backend.name).toBeUndefined();
      const id = added.data.addrequiredUpdateListRoot.id;

      const cleared = await updateListRoot(backend, { id, main: null });
      const replaced = await updateListRoot(backend, {
        id, items: [{ label: 'x' }], main: { label: 'y' }, outer: { inner: { label: 'j' } },
      });

      expect(cleared.errors, backend.name).toBeUndefined();
      expect(replaced.errors, backend.name).toBeUndefined();
      const { id: storedId, ...stored } = await listRoot(backend, id);
      expect(storedId).toBe(id);
      results.push(stored);
    }

    expect(results[0]).toEqual({
      items: [{ label: 'x', tags: [] }],
      main: { label: 'y', tags: [] },
      outer: { note: 'n', inner: { label: 'j', tags: [] } },
    });
    expect(results[1]).toEqual(results[0]);
  });

  test('both backends merge partial patches onto complete stored embedded values', async () => {
    const results = [];
    for (const backend of backends) {
      const id = await addSerie(backend, { director: { name: 'Ada', country: 'AR' } });
      const patched = await update(backend, { id, director: { country: 'UY' } });
      const replaced = await update(backend, {
        id, credits: [{ role: 'Only', star: { id: backend.starId } }],
      });
      expect(patched.errors).toBeUndefined();
      expect(replaced.errors).toBeUndefined();
      const { id: storedId, ...stored } = await read(backend, id);
      expect(storedId).toBe(id);
      results.push(stored);
    }

    expect(results[0]).toEqual({
      director: { name: 'Ada', country: 'UY' }, credits: [{ role: 'Only', star: { name: 'Lead' } }],
    });
    expect(results[1]).toEqual(results[0]);
  });

  test('MongoDB patches records whose omitted nested object was materialized from list defaults', async () => {
    const [backend] = backends;
    const added = await execute(backend, 'mutation { addrequiredUpdateShop(input: { name: "S", main: { street: "M" } }) { id } }');
    expect(added.errors).toBeUndefined();
    const id = added.data.addrequiredUpdateShop.id;
    const Shop = backend.api.getModel(backend.shopTypes.Shop);
    const raw = async () => Shop.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });
    expect((await raw()).main).toEqual({ street: 'M', geo: { aliases: [] } });

    const sibling = await execute(backend, `mutation($id: ID!) {
      updaterequiredUpdateShop(input: { id: $id, main: { city: "Z" } }) { main { street city } }
    }`, { id });
    const nested = await execute(backend, `mutation($id: ID!) {
      updaterequiredUpdateShop(input: { id: $id, main: { geo: { lat: 1 } } }) { id }
    }`, { id });

    expect(sibling.errors).toBeUndefined();
    expect(sibling.data.updaterequiredUpdateShop.main).toEqual({ street: 'M', city: 'Z' });
    expect(nested.errors?.[0]).toMatchObject({
      message: 'Required value lng is missing', extensions: { code: 'REQUIRED_VALUE', status: 400 },
    });
    expect((await raw()).main).toEqual({ street: 'M', city: 'Z', geo: { aliases: [] } });
  });

  test('every backend clears nullable members of a singular embedded patch on every read path', async () => {
    const mainFields = 'main { street city phones geo { lat lng aliases } reviewer { name } }';
    const patches = [{ city: null }, { phones: null }, { reviewer: null }, { geo: null }, { city: 'Y' }];
    const results = [];
    for (const backend of clearBackends) {
      const { prefix, endpoint, types } = backend.clear;
      const added = await execute(backend, `mutation($input: ${prefix}ShopInput!) { add${endpoint}Shop(input: $input) { id } }`, {
        input: {
          name: 'S',
          main: {
            street: 'M', city: 'C', phones: ['1'], geo: { lat: 1, lng: 2 }, reviewer: { id: backend.reviewerId },
          },
        },
      });
      expect(added.errors, backend.name).toBeUndefined();
      const id = added.data[`add${endpoint}Shop`].id;
      const steps = [];
      for (const main of patches) {
        const updated = await execute(backend, `mutation($input: ${prefix}ShopInputForUpdate!) {
          update${endpoint}Shop(input: $input) { ${mainFields} }
        }`, { input: { id, main } });
        const byId = await execute(backend, `query($id: ID) { ${endpoint}Shop(id: $id) { ${mainFields} } }`, { id });
        const list = await execute(backend, `{ ${endpoint}Shops(pagination: { page: 1, size: 50 }) { id ${mainFields} } }`);
        const label = `${backend.name} ${JSON.stringify(main)}`;
        for (const result of [updated, byId, list]) expect(result.errors, label).toBeUndefined();
        const reads = [
          updated.data[`update${endpoint}Shop`].main,
          byId.data[`${endpoint}Shop`].main,
          list.data[`${endpoint}Shops`].find((row) => row.id === id).main,
        ];
        expect(reads[1], label).toEqual(reads[0]);
        expect(reads[2], label).toEqual(reads[0]);
        steps.push(reads[0]);
      }
      if (backend.name.startsWith('mongodb')) {
        const Shop = backend.api.getModel(types.Shop);
        const raw = await Shop.collection.findOne({ _id: new mongoose.Types.ObjectId(id) });
        expect(raw.main, backend.name).toEqual({
          street: 'M', city: 'Y', phones: [], geo: null, reviewerId: null,
        });
      }
      results.push(steps);
    }

    const geo = { lat: 1, lng: 2, aliases: [] };
    const reviewer = { name: 'R' };
    expect(results[0]).toEqual([
      {
        street: 'M', city: null, phones: ['1'], geo, reviewer,
      },
      {
        street: 'M', city: null, phones: [], geo, reviewer,
      },
      {
        street: 'M', city: null, phones: [], geo, reviewer: null,
      },
      {
        street: 'M', city: null, phones: [], geo: null, reviewer: null,
      },
      {
        street: 'M', city: 'Y', phones: [], geo: null, reviewer: null,
      },
    ]);
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
  });
});
