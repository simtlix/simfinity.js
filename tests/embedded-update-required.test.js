import { describe, expect, test } from 'vitest';
import {
  GraphQLFloat, GraphQLID, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';

import { createRuntime } from '../packages/core/src/index.js';

const clone = (value) => JSON.parse(JSON.stringify(value));

const createMemoryAdapter = () => {
  const records = new Map();
  let nextId = 1;
  return {
    bind() {},
    prepare() {},
    createModel: (gqltype) => ({ name: gqltype.name }),
    castId: (value) => String(value),
    withTransaction: async (session, body) => body(session || {}),
    newRecord: (Model, data) => ({ ...clone(data), _id: String(nextId++) }),
    async saveRecord(Model, record) {
      records.set(`${Model.name}:${record._id}`, record);
      return record;
    },
    toObject: (record) => clone(record),
    async getById(Model, id) {
      const record = records.get(`${Model.name}:${id}`);
      return record ? clone(record) : null;
    },
    prepareUpdate: (set, unset) => ({ ...set, $unset: unset }),
    async update(Model, id, update) {
      const current = records.get(`${Model.name}:${id}`);
      if (!current) return null;
      const { $unset: unset, ...set } = clone(update);
      for (const key of Object.keys(unset)) delete current[key];
      Object.assign(current, set);
      return clone(current);
    },
    async find(Model) {
      return [...records.entries()]
        .filter(([key]) => key.startsWith(`${Model.name}:`))
        .map(([, record]) => clone(record));
    },
    async count() {
      return records.size;
    },
    async aggregate() {
      return [];
    },
    async findChildren() {
      return [];
    },
    getRecord: (Model, id) => clone(records.get(`${Model}:${id}`)),
    setRecord: (Model, id, data) => records.set(`${Model}:${id}`, { ...clone(data), _id: id }),
  };
};

const buildShopSchema = () => {
  const adapter = createMemoryAdapter();
  const runtime = createRuntime(adapter);
  const GeoType = new GraphQLObjectType({
    name: 'RequiredUpdateGeo',
    fields: {
      lat: { type: new GraphQLNonNull(GraphQLFloat) },
      lng: { type: new GraphQLNonNull(GraphQLFloat) },
      aliases: { type: new GraphQLList(GraphQLString) },
    },
  });
  const PersonType = new GraphQLObjectType({
    name: 'RequiredUpdatePerson',
    fields: {
      id: { type: GraphQLID },
      name: { type: GraphQLString },
    },
  });
  const AddressType = new GraphQLObjectType({
    name: 'RequiredUpdateAddress',
    fields: {
      street: { type: new GraphQLNonNull(GraphQLString) },
      city: { type: GraphQLString },
      phones: { type: new GraphQLList(GraphQLString) },
      geo: { type: GeoType, extensions: { relation: { embedded: true } } },
      owner: {
        type: new GraphQLNonNull(PersonType),
        extensions: { relation: { embedded: false, connectionField: 'ownerId' } },
      },
    },
  });
  const TagType = new GraphQLObjectType({
    name: 'RequiredUpdateTag',
    fields: {
      id: { type: new GraphQLNonNull(GraphQLString) },
      label: { type: new GraphQLNonNull(GraphQLString) },
      stamp: { type: new GraphQLNonNull(GraphQLString), extensions: { readOnly: true } },
    },
  });
  const ShopType = new GraphQLObjectType({
    name: 'RequiredUpdateShop',
    fields: {
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      addresses: {
        type: new GraphQLList(AddressType),
        extensions: { relation: { embedded: true } },
      },
      main: { type: AddressType, extensions: { relation: { embedded: true } } },
      tags: {
        type: new GraphQLList(TagType),
        extensions: { relation: { embedded: true } },
      },
    },
  });
  runtime.addNoEndpointType(GeoType);
  runtime.addNoEndpointType(AddressType);
  runtime.addNoEndpointType(TagType);
  runtime.connect(null, PersonType, 'requiredUpdatePerson', 'requiredUpdatePersons');
  runtime.connect(null, ShopType, 'requiredUpdateShop', 'requiredUpdateShops');
  const schema = runtime.createSchema();
  const execute = (source, variableValues) => graphql({ schema, source, variableValues });
  return { adapter, execute };
};

const updateShop = 'mutation($input: RequiredUpdateShopInputForUpdate!) { updaterequiredUpdateShop(input: $input) { id } }';

const setup = async (input = () => ({})) => {
  const shop = buildShopSchema();
  const person = await shop.execute('mutation { addrequiredUpdatePerson(input: { name: "Owner" }) { id } }');
  const ownerId = person.data.addrequiredUpdatePerson.id;
  const added = await shop.execute(
    'mutation($input: RequiredUpdateShopInput!) { addrequiredUpdateShop(input: $input) { id } }',
    { input: { name: 'Shop', addresses: [{ street: 'A', city: 'X', owner: { id: ownerId } }], ...input(ownerId) } },
  );
  expect(added.errors).toBeUndefined();
  const id = added.data.addrequiredUpdateShop.id;
  const stored = () => shop.adapter.getRecord('RequiredUpdateShop', id);
  return { ...shop, id, ownerId, stored };
};

const expectRequiredValue = (result, fieldName) => {
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0].message).toBe(`Required value ${fieldName} is missing`);
  expect(result.errors[0].extensions).toMatchObject({ code: 'REQUIRED_VALUE', status: 400 });
};

describe('update validation of required embedded members', () => {
  test('rejects replacement list items that omit a required member', async () => {
    const shop = await setup(() => ({}));
    const before = shop.stored();

    const result = await shop.execute(updateShop, {
      input: { id: shop.id, addresses: [{ city: 'Y', owner: { id: shop.ownerId } }] },
    });

    expectRequiredValue(result, 'street');
    expect(shop.stored()).toEqual(before);
  });

  test('rejects an object patch that creates an incomplete embedded value', async () => {
    const shop = await setup(() => ({}));

    const result = await shop.execute(updateShop, { input: { id: shop.id, main: { city: 'Z' } } });

    expectRequiredValue(result, 'street');
    expect(shop.stored().main).toBeUndefined();
  });

  test('merges partial object patches onto complete stored values', async () => {
    const shop = await setup((ownerId) => ({
      main: { street: 'M', city: 'C', geo: { lat: 1, lng: 2 }, owner: { id: ownerId } },
    }));

    const result = await shop.execute(updateShop, { input: { id: shop.id, main: { city: 'Z' } } });

    expect(result.errors).toBeUndefined();
    expect(shop.stored().main).toEqual({
      street: 'M', city: 'Z', geo: { lat: 1, lng: 2 }, ownerId: shop.ownerId, phones: [],
    });
  });

  test('rejects nested embedded objects replaced by a shallow patch without required members', async () => {
    const shop = await setup((ownerId) => ({
      main: { street: 'M', geo: { lat: 1, lng: 2 }, owner: { id: ownerId } },
    }));

    const partial = await shop.execute(updateShop, { input: { id: shop.id, main: { geo: { lat: 5 } } } });
    const complete = await shop.execute(updateShop, {
      input: { id: shop.id, main: { geo: { lat: 5, lng: 6 } } },
    });

    expectRequiredValue(partial, 'lng');
    expect(complete.errors).toBeUndefined();
    expect(shop.stored().main.geo).toEqual({ lat: 5, lng: 6, aliases: [] });
  });

  test('checks required references inside embedded values by their connection field', async () => {
    const shop = await setup((ownerId) => ({ main: { street: 'M', owner: { id: ownerId } } }));

    const missingOwner = await shop.execute(updateShop, {
      input: { id: shop.id, addresses: [{ street: 'B' }] },
    });
    const storedOwner = await shop.execute(updateShop, { input: { id: shop.id, main: { street: 'N' } } });
    const replaced = await shop.execute(updateShop, {
      input: { id: shop.id, addresses: [{ street: 'B', owner: { id: shop.ownerId } }] },
    });

    expectRequiredValue(missingOwner, 'owner');
    expect(storedOwner.errors).toBeUndefined();
    expect(replaced.errors).toBeUndefined();
    expect(shop.stored().addresses).toEqual([{ street: 'B', ownerId: shop.ownerId, phones: [] }]);
  });

  test('writes omitted list members of written embedded values as empty lists', async () => {
    const shop = await setup(() => ({}));

    const result = await shop.execute(updateShop, {
      input: {
        id: shop.id,
        main: { street: 'M', owner: { id: shop.ownerId }, geo: { lat: 1, lng: 2 } },
        addresses: [{ street: 'B', owner: { id: shop.ownerId }, phones: ['1'] }],
      },
    });

    expect(result.errors).toBeUndefined();
    expect(shop.stored().main).toEqual({
      street: 'M', ownerId: shop.ownerId, phones: [], geo: { lat: 1, lng: 2, aliases: [] },
    });
    expect(shop.stored().addresses).toEqual([{ street: 'B', ownerId: shop.ownerId, phones: ['1'] }]);
  });

  test('does not recheck stored nested embedded values that a patch keeps', async () => {
    const shop = await setup(() => ({}));
    // MongoDB materializes an omitted nested object that has list members as `{ aliases: [] }`.
    shop.adapter.setRecord('RequiredUpdateShop', shop.id, {
      ...shop.stored(), main: { street: 'M', ownerId: shop.ownerId, geo: { aliases: [] } },
    });

    const sibling = await shop.execute(updateShop, { input: { id: shop.id, main: { city: 'Z' } } });
    const nested = await shop.execute(updateShop, { input: { id: shop.id, main: { geo: { lat: 1 } } } });

    expect(sibling.errors).toBeUndefined();
    expect(shop.stored().main).toEqual({
      street: 'M', city: 'Z', ownerId: shop.ownerId, phones: [], geo: { aliases: [] },
    });
    expectRequiredValue(nested, 'lng');
  });

  test('does not require id or readOnly members that generated inputs cannot supply', async () => {
    const shop = await setup(() => ({ tags: [{ label: 'first' }] }));

    const result = await shop.execute(updateShop, { input: { id: shop.id, tags: [{ label: 'second' }] } });

    expect(result.errors).toBeUndefined();
    expect(shop.stored().tags).toEqual([{ label: 'second' }]);
  });

  test('keeps NOT_VALID_ID for a missing record before checking embedded values', async () => {
    const shop = buildShopSchema();

    const result = await shop.execute(updateShop, { input: { id: '404', main: { city: 'Z' } } });

    expect(result.errors[0].extensions.code).toBe('NOT_VALID_ID');
  });
});
