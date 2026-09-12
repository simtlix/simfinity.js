import {
  afterAll, beforeAll, beforeEach, describe, expect, test,
} from 'vitest';
import mongoose from 'mongoose';
import { graphql } from 'graphql';
import * as simfinity from '../../src/index.js';
import { createContractModelFixtures } from '../contracts/model-fixtures.js';

const mongodbUri = process.env.SIMFINITY_MONGODB_URI;
const describeWithMongoDB = mongodbUri ? describe : describe.skip;

const execute = (schema, source, variableValues, contextValue = {}) => graphql({
  schema,
  source,
  variableValues,
  contextValue,
});

describeWithMongoDB('MongoDB GraphQL compatibility contract', () => {
  let schema;
  let fixture;
  let models;

  beforeAll(async () => {
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

    schema = simfinity.createSchema();
    models = Object.fromEntries(Object.entries(fixture.types).map(([name, gqltype]) => [
      name,
      simfinity.getModel(gqltype),
    ]));

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
});
