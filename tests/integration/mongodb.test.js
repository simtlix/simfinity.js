import {
  afterAll, beforeAll, beforeEach, describe, expect, test,
} from 'vitest';
import mongoose from 'mongoose';
import {
  GraphQLEnumType, GraphQLFloat, GraphQLID, GraphQLList, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';
import * as simfinity from '../../packages/mongodb/src/index.js';
import { createContractModelFixtures } from '../contracts/model-fixtures.js';

const mongodbUri = process.env.SIMFINITY_MONGODB_URI;
const describeWithMongoDB = mongodbUri ? describe : describe.skip;

const execute = (schema, source, variableValues, contextValue = {}) => graphql({
  schema,
  source,
  variableValues,
  contextValue,
});

// Identifier positions of every kind: record keys, a reference, a state action, a nested collection,
// a scalar ID and the IDs of embedded objects.
const createIdentifierProbe = (labelType) => {
  const types = {};
  types.State = new GraphQLEnumType({
    name: 'ContractIdProbeState',
    values: { OPEN: { value: 'OPEN' }, CLOSED: { value: 'CLOSED' } },
  });
  types.Tag = new GraphQLObjectType({
    name: 'ContractIdProbeTag',
    fields: { id: { type: GraphQLID }, label: { type: GraphQLString } },
  });
  types.Item = new GraphQLObjectType({
    name: 'ContractIdProbeItem',
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      probe: { type: types.Probe, extensions: { relation: { connectionField: 'probe' } } },
    }),
  });
  types.Probe = new GraphQLObjectType({
    name: 'ContractIdProbe',
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      state: { type: types.State },
      other: { type: GraphQLID },
      label: { type: labelType, extensions: { relation: { connectionField: 'label_id' } } },
      tag: { type: types.Tag, extensions: { relation: { embedded: true } } },
      tags: { type: new GraphQLList(types.Tag), extensions: { relation: { embedded: true } } },
      items: { type: new GraphQLList(types.Item), extensions: { relation: { connectionField: 'probe' } } },
    }),
  });
  types.stateMachine = {
    initialState: types.State.getValue('OPEN'),
    actions: { close: { from: types.State.getValue('OPEN'), to: types.State.getValue('CLOSED') } },
  };
  return types;
};

const expectInvalidId = (result, field, status = 400) => {
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0].path).toEqual([field]);
  expect(result.errors[0].extensions).toMatchObject({ code: 'NOT_VALID_ID', status });
  expect(result.data?.[field] ?? null).toBeNull();
};

describeWithMongoDB('MongoDB GraphQL compatibility contract', () => {
  let schema;
  let fixture;
  let models;
  let probe;
  let previousStrictQuery;

  beforeAll(async () => {
    // Simfinity's own queries must not depend on lax filter casting, so run the contract with the
    // strictest application setting.
    previousStrictQuery = mongoose.get('strictQuery');
    mongoose.set('strictQuery', 'throw');
    await mongoose.connect(mongodbUri);
    await mongoose.connection.db.dropDatabase();

    simfinity.preventCreatingCollection(true);
    fixture = createContractModelFixtures();

    fixture.registrations.forEach((registration) => {
      if (registration.endpoint) {
        simfinity.connect(
          null,
          registration.gqltype,
          registration.simpleEntityEndpointName,
          registration.listEntitiesEndpointName,
          registration.controller,
        );
      } else {
        simfinity.addNoEndpointType(registration.gqltype);
      }
    });
    probe = createIdentifierProbe(fixture.types.ContractLabel);
    simfinity.addNoEndpointType(probe.Tag);
    simfinity.connect(null, probe.Item, 'contractidprobeitem', 'contractidprobeitems');
    simfinity.connect(null, probe.Probe, 'contractidprobe', 'contractidprobes', null, null, probe.stateMachine);

    schema = simfinity.createSchema();
    models = Object.fromEntries(Object.entries(fixture.types).map(([name, gqltype]) => [
      name,
      simfinity.getModel(gqltype),
    ]));
    models.ContractIdProbe = simfinity.getModel(probe.Probe);
    models.ContractIdProbeItem = simfinity.getModel(probe.Item);

    const persistentModels = [...new Set(Object.values(models).filter(Boolean))];
    for (const model of persistentModels) {
      await model.createCollection();
    }
  }, 30000);

  beforeEach(async () => {
    fixture.hookEvents.length = 0;
    const persistentModels = [...new Set(Object.values(models).filter(Boolean))];
    for (const model of persistentModels) {
      await model.deleteMany({});
    }
  });

  afterAll(async () => {
    if (mongodbUri) await mongoose.disconnect();
    mongoose.set('strictQuery', previousStrictQuery);
  });

  test('executes reference and nested create, update, read, and delete operations', async () => {
    const label = await models.ContractLabel.create({ name: 'Premium' });
    const context = { tenant: 'tenant-crud', requestId: 'crud-request' };

    const added = await execute(
      schema,
      `
        mutation AddSerie($input: ContractSerieInput!) {
          addcontractserie(input: $input) {
            id
            tenant
            title
            label { name }
            director { name country }
            seasons { id number year }
          }
        }
      `,
      {
        input: {
          tenant: 'tenant-crud',
          title: 'Original',
          label: { id: label._id.toString() },
          director: { name: 'Director', country: 'AR' },
          categories: ['Drama', 'Drama'],
          seasons: { added: [{ number: 1, year: 2026 }] },
        },
      },
      context,
    );

    expect(added.errors).toBeUndefined();
    expect(added.data.addcontractserie).toMatchObject({
      tenant: 'tenant-crud',
      title: 'Original',
      label: { name: 'Premium' },
      director: { name: 'Director', country: 'AR' },
    });
    expect(added.data.addcontractserie.seasons).toHaveLength(1);

    const serieId = added.data.addcontractserie.id;
    const seasonId = added.data.addcontractserie.seasons[0].id;
    const updated = await execute(
      schema,
      `
        mutation UpdateSerie($input: ContractSerieInputForUpdate!) {
          updatecontractserie(input: $input) {
            id
            title
            label { name }
            director { name country }
            seasons { id number year }
          }
        }
      `,
      {
        input: {
          id: serieId,
          title: 'Updated',
          label: null,
          director: { country: 'UY' },
          seasons: { updated: [{ id: seasonId, number: 2 }] },
        },
      },
      context,
    );

    expect(updated.errors).toBeUndefined();
    expect(updated.data.updatecontractserie).toMatchObject({
      id: serieId,
      title: 'Updated',
      label: null,
      director: { name: 'Director', country: 'UY' },
    });
    expect(updated.data.updatecontractserie.seasons).toEqual([
      expect.objectContaining({ id: seasonId, number: 2, year: 2026 }),
    ]);
    expect((await models.ContractSerie.findById(serieId).lean()).label).toBeUndefined();

    const nestedDeleted = await execute(
      schema,
      `
        mutation DeleteNestedSeason($input: ContractSerieInputForUpdate!) {
          updatecontractserie(input: $input) { id seasons { id } }
        }
      `,
      { input: { id: serieId, seasons: { deleted: [seasonId] } } },
      context,
    );

    expect(nestedDeleted.errors).toBeUndefined();
    expect(nestedDeleted.data.updatecontractserie.seasons).toEqual([]);
    expect(await models.ContractSeason.findById(seasonId)).toBeNull();

    const deleted = await execute(
      schema,
      `
        mutation DeleteSerie($id: ID!) {
          deletecontractserie(id: $id) { id title }
        }
      `,
      { id: serieId },
      context,
    );

    expect(deleted.errors).toBeUndefined();
    expect(deleted.data.deletecontractserie).toMatchObject({ id: serieId, title: 'Updated' });
    expect(await models.ContractSerie.findById(serieId)).toBeNull();

    const savedEvent = fixture.hookEvents.find((event) => (
      event.type === 'ContractSerie' && event.hook === 'onSaved'
    ));
    const updatedEvent = fixture.hookEvents.find((event) => (
      event.type === 'ContractSerie' && event.hook === 'onUpdated'
    ));
    expect(savedEvent).toMatchObject({ context, inTransaction: true });
    expect(updatedEvent).toMatchObject({ context, title: 'Updated', inTransaction: true });
    expect(updatedEvent.session).toBeInstanceOf(mongoose.mongo.ClientSession);
  });

  test('keeps scope filters outside user OR groups', async () => {
    const inputs = [
      { tenant: 'tenant-a', title: 'Alpha' },
      { tenant: 'tenant-a', title: 'Beta' },
      { tenant: 'tenant-a', title: 'Other' },
      { tenant: 'tenant-b', title: 'Alpha' },
    ];

    for (const input of inputs) {
      const result = await execute(
        schema,
        `mutation AddScopedSerie($input: ContractSerieInput!) {
          addcontractserie(input: $input) { id }
        }`,
        { input },
      );
      expect(result.errors).toBeUndefined();
    }

    const result = await execute(
      schema,
      `
        query ScopedSeries {
          contractseries(
            OR: [
              { conditions: [{ field: "title", operator: EQ, value: "Alpha" }] }
              { conditions: [{ field: "title", operator: EQ, value: "Beta" }] }
            ]
            sort: { terms: [{ field: "title", order: ASC }] }
          ) { tenant title }
        }
      `,
      undefined,
      { tenant: 'tenant-a' },
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.contractseries).toEqual([
      { tenant: 'tenant-a', title: 'Alpha' },
      { tenant: 'tenant-a', title: 'Beta' },
    ]);
  });

  test('preserves duplicate roots and duplicate-preserving counts for collection filters', async () => {
    const added = await execute(
      schema,
      `
        mutation AddSeriesWithSeasons($input: ContractSerieInput!) {
          addcontractserie(input: $input) { id }
        }
      `,
      {
        input: {
          tenant: 'tenant-duplicates',
          title: 'Two matching seasons',
          seasons: {
            added: [
              { number: 1, year: 2030 },
              { number: 2, year: 2030 },
            ],
          },
        },
      },
    );
    expect(added.errors).toBeUndefined();

    const context = { tenant: 'tenant-duplicates' };
    const result = await execute(
      schema,
      `
        query DuplicateSeries {
          contractseries(
            seasons: { terms: [{ path: "year", operator: EQ, value: 2030 }] }
            pagination: { page: 1, size: 100, count: true }
          ) { id title }
        }
      `,
      undefined,
      context,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.contractseries).toHaveLength(2);
    expect(result.data.contractseries.map((serie) => serie.id)).toEqual([
      added.data.addcontractserie.id,
      added.data.addcontractserie.id,
    ]);
    expect(context.count).toBe(2);
  });

  test('returns real aggregate groups and facts', async () => {
    const serie = await execute(
      schema,
      `mutation AddAggregateSerie($input: ContractSerieInput!) {
        addcontractserie(input: $input) { id seasons { id } }
      }`,
      {
        input: {
          tenant: 'tenant-aggregate',
          title: 'Aggregate source',
          seasons: { added: [{ number: 1, year: 2026 }] },
        },
      },
    );
    expect(serie.errors).toBeUndefined();
    const seasonId = serie.data.addcontractserie.seasons[0].id;

    const episodes = [
      { title: 'One', kind: 'drama', duration: 30, season: { id: seasonId } },
      { title: 'Two', kind: 'drama', duration: 45, season: { id: seasonId } },
      { title: 'Three', kind: 'comedy', duration: 20, season: { id: seasonId } },
    ];
    for (const input of episodes) {
      const result = await execute(
        schema,
        `mutation AddEpisode($input: ContractEpisodeInput!) {
          addcontractepisode(input: $input) { id }
        }`,
        { input },
      );
      expect(result.errors).toBeUndefined();
    }

    const result = await execute(
      schema,
      `
        query EpisodeAggregates {
          contractepisodes_aggregate(
            aggregation: {
              groupId: "kind"
              facts: [
                { operation: SUM, factName: "duration", path: "duration" }
                { operation: COUNT, factName: "count", path: "id" }
              ]
            }
          ) { groupId facts }
        }
      `,
    );

    expect(result.errors).toBeUndefined();
    expect(result.data.contractepisodes_aggregate).toEqual([
      { groupId: 'comedy', facts: { duration: 20, count: 1 } },
      { groupId: 'drama', facts: { duration: 75, count: 2 } },
    ]);
  });

  test('rolls back a parent write when nested validation fails', async () => {
    const result = await execute(
      schema,
      `mutation AddInvalidSerie($input: ContractSerieInput!) {
        addcontractserie(input: $input) { id }
      }`,
      {
        input: {
          tenant: 'tenant-validation',
          title: 'Must roll back',
          seasons: { added: [{ number: 999, year: 2026 }] },
        },
      },
      { tenant: 'tenant-validation' },
    );

    expect(result.errors?.[0].message).toContain('Season number 999 is invalid');
    expect(await models.ContractSerie.countDocuments({ title: 'Must roll back' })).toBe(0);
    expect(await models.ContractSeason.countDocuments({ number: 999 })).toBe(0);
  });

  describe('malformed identifiers', () => {
    const missingId = () => new mongoose.Types.ObjectId().toString();
    const createProbe = async () => {
      const stored = await models.ContractIdProbe.create({
        name: 'original', state: 'OPEN', tag: { label: 'tag' }, tags: [{ label: 'first' }],
      });
      const item = await models.ContractIdProbeItem.create({ name: 'item', probe: stored._id });
      return { probe: stored, item };
    };
    const storedProbe = (id) => models.ContractIdProbe.findById(id).lean();
    const update = (input) => execute(schema, `mutation($input: ContractIdProbeInputForUpdate!) {
      updatecontractidprobe(input: $input) { id }
    }`, { input });
    const add = (input) => execute(schema, `mutation($input: ContractIdProbeInput!) {
      addcontractidprobe(input: $input) { id }
    }`, { input });

    test.each(['invalid', '12'])('a by-ID query for %s fails with NOT_VALID_ID (400)', async (id) => {
      expectInvalidId(await execute(schema, 'query($id: ID) { contractidprobe(id: $id) { id } }', { id }), 'contractidprobe');
    });

    test('a by-ID query for a well-formed missing ID still returns null', async () => {
      const result = await execute(schema, 'query($id: ID) { contractidprobe(id: $id) { id } }', { id: missingId() });
      expect(result.errors).toBeUndefined();
      expect(result.data.contractidprobe).toBeNull();
    });

    test('update and delete reject a malformed ID and keep 404 for a missing record', async () => {
      expectInvalidId(await update({ id: 'invalid', name: 'changed' }), 'updatecontractidprobe');
      expectInvalidId(await update({ id: missingId(), name: 'changed' }), 'updatecontractidprobe', 404);
      expectInvalidId(await execute(schema, 'mutation { deletecontractidprobe(id: "invalid") { id } }'),
        'deletecontractidprobe');
    });

    test('a state action rejects a malformed ID', async () => {
      expectInvalidId(await execute(schema, 'mutation { close_contractidprobe(input: { id: "invalid" }) { id } }'),
        'close_contractidprobe');
    });

    test('a reference input with a malformed ID writes nothing', async () => {
      expectInvalidId(await add({ name: 'bad reference', label: { id: 'invalid' } }), 'addcontractidprobe');
      expect(await models.ContractIdProbe.countDocuments()).toBe(0);
    });

    test('nested child operations reject a malformed ID and keep the parent unchanged', async () => {
      const { probe: stored } = await createProbe();
      const id = stored._id.toString();
      expectInvalidId(await update({ id, name: 'changed', items: { updated: [{ id: 'invalid', name: 'x' }] } }),
        'updatecontractidprobe');
      expectInvalidId(await update({ id, name: 'changed', items: { deleted: ['invalid'] } }), 'updatecontractidprobe');
      expect((await storedProbe(id)).name).toBe('original');
      expect(await models.ContractIdProbeItem.countDocuments({ probe: stored._id })).toBe(1);
    });

    test('a malformed scalar ID fails with NOT_VALID_ID on create and update', async () => {
      expectInvalidId(await add({ name: 'bad scalar', other: 'invalid' }), 'addcontractidprobe');
      expect(await models.ContractIdProbe.countDocuments()).toBe(0);
      const { probe: stored } = await createProbe();
      expectInvalidId(await update({ id: stored._id.toString(), name: 'changed', other: 'invalid' }),
        'updatecontractidprobe');
      expect((await storedProbe(stored._id)).name).toBe('original');
    });

    test('a malformed embedded ID fails with NOT_VALID_ID and writes nothing', async () => {
      const { probe: stored } = await createProbe();
      const id = stored._id.toString();
      expectInvalidId(await update({ id, name: 'changed', tag: { id: 'invalid', label: 'x' } }), 'updatecontractidprobe');
      expectInvalidId(await update({ id, name: 'changed', tags: [{ id: 'invalid', label: 'x' }] }),
        'updatecontractidprobe');
      const unchanged = await storedProbe(id);
      expect(unchanged.name).toBe('original');
      expect(unchanged.tag.label).toBe('tag');
      expect(unchanged.tags.map(({ label }) => label)).toEqual(['first']);
    });

    test('well-formed IDs in every position still work', async () => {
      const label = await models.ContractLabel.create({ name: 'Probe label' });
      const { probe: stored, item } = await createProbe();
      const id = stored._id.toString();
      const other = missingId();
      const tagId = missingId();
      const result = await execute(schema, `mutation($input: ContractIdProbeInputForUpdate!) {
        updatecontractidprobe(input: $input) { id other label { name } tag { label } items { name } }
      }`, {
        input: {
          id,
          other,
          label: { id: label._id.toString() },
          tag: { id: tagId, label: 'changed' },
          items: { updated: [{ id: item._id.toString(), name: 'renamed' }] },
        },
      });
      expect(result.errors).toBeUndefined();
      expect(result.data.updatecontractidprobe).toEqual({
        id, other, label: { name: 'Probe label' }, tag: { label: 'changed' }, items: [{ name: 'renamed' }],
      });
      expect(String((await storedProbe(id)).tag.id)).toBe(tagId);
      const closed = await execute(schema, `mutation { close_contractidprobe(input: { id: "${id}" }) { state } }`);
      expect(closed.errors).toBeUndefined();
      expect(closed.data.close_contractidprobe.state).toBe('CLOSED');
    });

    test.each([
      ['without an ID', {}],
      ['with a null ID', { id: null }],
      ['with a numeric ID', { id: 12 }],
      ['with a lean document key', { _id: new mongoose.Types.ObjectId() }],
    ])('saveObject rejects a reference %s instead of storing a new identifier', async (_, reference) => {
      await expect(simfinity.saveObject(probe.Probe.name, { name: 'ghost', label: reference }))
        .rejects.toMatchObject({ extensions: { code: 'NOT_VALID_ID', status: 400 } });
      expect(await models.ContractIdProbe.countDocuments()).toBe(0);
    });
  });

  describe('a supplied model whose schema applies toJSON virtuals', () => {
    let virtualsSchema;
    let ShopModel;
    let VisitModel;

    beforeAll(async () => {
      const runtime = simfinity.createRuntime(simfinity.createMongoAdapter());
      runtime.preventCreatingCollection(true);
      const Geo = new GraphQLObjectType({ name: 'ContractVirtualsGeo', fields: { lat: { type: GraphQLFloat } } });
      const Address = new GraphQLObjectType({
        name: 'ContractVirtualsAddress',
        fields: { street: { type: GraphQLString }, geo: { type: Geo, extensions: { relation: { embedded: true } } } },
      });
      const Shop = new GraphQLObjectType({
        name: 'ContractVirtualsShop',
        fields: {
          id: { type: GraphQLID },
          name: { type: GraphQLString },
          main: { type: Address, extensions: { relation: { embedded: true } } },
        },
      });
      const Visit = new GraphQLObjectType({
        name: 'ContractVirtualsVisit',
        fields: {
          id: { type: GraphQLID },
          note: { type: GraphQLString },
          shop: { type: Shop, extensions: { relation: { connectionField: 'shop' } } },
        },
      });
      // With this option, Mongoose renders a stored null nested path as `{}` from its own toJSON.
      ShopModel = mongoose.model('ContractVirtualsShop', new mongoose.Schema({
        name: String,
        main: { street: String, geo: { lat: Number } },
      }, { toJSON: { virtuals: true } }));
      runtime.addNoEndpointType(Geo);
      runtime.addNoEndpointType(Address);
      runtime.connect(ShopModel, Shop, 'contractvirtualsshop', 'contractvirtualsshops');
      runtime.connect(null, Visit, 'contractvirtualsvisit', 'contractvirtualsvisits');
      virtualsSchema = runtime.createSchema();
      VisitModel = runtime.getModel(Visit);
      await ShopModel.createCollection();
      await VisitModel.createCollection();
    });

    test('reads a cleared embedded object as null on every read path', async () => {
      const shop = await ShopModel.create({ name: 'S', main: { street: 'M', geo: { lat: 1 } } });
      await VisitModel.create({ note: 'v', shop: shop._id });
      const id = shop._id.toString();
      const cleared = { street: 'M', geo: null };

      const updated = await execute(virtualsSchema, `mutation($id: ID!) {
        updatecontractvirtualsshop(input: { id: $id, main: { geo: null } }) { main { street geo { lat } } }
      }`, { id });
      expect(updated.errors).toBeUndefined();
      expect(updated.data.updatecontractvirtualsshop.main).toEqual(cleared);
      expect((await ShopModel.collection.findOne({ _id: shop._id })).main).toEqual(cleared);

      const read = await execute(virtualsSchema, `query($id: ID) {
        contractvirtualsshop(id: $id) { main { street geo { lat } } }
        contractvirtualsvisits { shop { main { street geo { lat } } } }
        contractvirtualsshops { main { street geo { lat } } }
      }`, { id });
      expect(read.errors).toBeUndefined();
      expect(read.data).toEqual({
        contractvirtualsshop: { main: cleared },
        contractvirtualsvisits: [{ shop: { main: cleared } }],
        contractvirtualsshops: [{ main: cleared }],
      });
    });
  });
});
