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

describe.skipIf(!mongoUri || !postgresUri)('MongoDB/PostgreSQL required embedded update parity', () => {
  const namespace = `required_${randomUUID().replaceAll('-', '')}`;
  const fields = 'id director { name country } credits { role star { name } }';
  const listFields = 'id items { label tags } main { label tags } outer { note inner { label tags } }';
  let pool;
  let backends;

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
});
