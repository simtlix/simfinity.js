import { randomUUID } from 'node:crypto';
import {
  afterAll, beforeAll, describe, expect, test, vi,
} from 'vitest';
import {
  GraphQLID, GraphQLList, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';
import mongoose from 'mongoose';
import pg from 'pg';

import { buildErrorFormatter, createRuntime, InternalServerError } from '../../packages/core/src/index.js';
import { createMongoAdapter } from '../../packages/mongodb/src/mongo/adapter.js';
import { createPostgres } from '../../packages/postgres/src/index.js';
import { createContractModelFixtures } from '../contracts/model-fixtures.js';

const mongoUri = process.env.SIMFINITY_MONGODB_URI;
const postgresUri = process.env.SIMFINITY_POSTGRES_URI;

// A supporting type that is both a reference target (an entity) and an embedded list item.
const createBadgeTypes = () => {
  const Badge = new GraphQLObjectType({
    name: 'IdParityBadge',
    fields: { id: { type: GraphQLID }, label: { type: GraphQLString } },
  });
  const Holder = new GraphQLObjectType({
    name: 'IdParityHolder',
    fields: {
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      featured: { type: Badge, extensions: { relation: { embedded: false, connectionField: 'featuredId' } } },
      badges: { type: new GraphQLList(Badge), extensions: { relation: { embedded: true } } },
    },
  });
  return { Badge, Holder };
};

describe.skipIf(!mongoUri || !postgresUri)('MongoDB/PostgreSQL entity id parity', () => {
  const namespace = `ids_${randomUUID().replaceAll('-', '')}`;
  let pool;
  let backends;

  const run = async (backend, source, variableValues) => {
    const result = await graphql({
      schema: backend.schema, source, variableValues, contextValue: {},
    });
    expect(result.errors, backend.name).toBeUndefined();
    return result.data;
  };
  // MongoDB stores references as ObjectIds; PostgreSQL takes the identifier as is.
  const storedId = (backend, id) => (backend.name === 'mongodb' ? new mongoose.Types.ObjectId(id) : id);

  beforeAll(async () => {
    await mongoose.connect(mongoUri, { dbName: namespace });
    pool = new pg.Pool({ connectionString: postgresUri });
    backends = [
      { name: 'mongodb', api: createRuntime(createMongoAdapter()) },
      { name: 'postgres', api: createPostgres({ pool, schema: namespace }) },
    ];
    for (const backend of backends) {
      backend.fixture = createContractModelFixtures();
      backend.badgeTypes = createBadgeTypes();
      if (!backend.api.initializeDatabase) backend.api.preventCreatingCollection(true);
      for (const registration of backend.fixture.registrations) {
        if (registration.endpoint) {
          backend.api.connect(null, registration.gqltype, registration.simpleEntityEndpointName,
            registration.listEntitiesEndpointName);
        } else {
          backend.api.addNoEndpointType(registration.gqltype);
        }
      }
      backend.api.addNoEndpointType(backend.badgeTypes.Badge);
      backend.api.connect(null, backend.badgeTypes.Holder, 'idParityHolder', 'idParityHolders');
      const { types } = backend.fixture;
      // ContractEpisode is left out of the query allowlist; mutations stay unrestricted.
      backend.schema = backend.api.createSchema([
        types.ContractSerie, types.ContractSeason, types.ContractStar, types.ContractAssignment,
        backend.badgeTypes.Holder,
      ]);
      if (backend.api.initializeDatabase) await backend.api.initializeDatabase();
      else for (const { model } of backend.api.getRegistrations()) if (model) await model.createCollection();
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

  test('referenced no-endpoint types and allowlist-excluded types resolve their stored id', async () => {
    for (const backend of backends) {
      const { types } = backend.fixture;
      const label = await backend.api.getModel(types.ContractLabel).create({ name: `L-${backend.name}` });
      const labelId = String(label._id);
      const added = await run(backend, `mutation($input: ContractSerieInput!) {
        addcontractserie(input: $input) { id label { id name } }
      }`, { input: { tenant: 'a', title: 'S', label: { id: labelId } } });
      const serieId = added.addcontractserie.id;
      const note = await backend.api.getModel(types.ContractNote).create({ text: 'n', serie_id: storedId(backend, serieId) });
      const season = await run(backend, `mutation { addcontractseason(input: { number: 1, serie: { id: "${serieId}" } }) { id } }`);
      const seasonId = season.addcontractseason.id;
      const episode = await run(backend, `mutation {
        addcontractepisode(input: { title: "E", kind: "k", duration: 1, season: { id: "${seasonId}" } }) { id title }
      }`);
      const episodeId = episode.addcontractepisode.id;
      const read = await run(backend, `{
        contractserie(id: "${serieId}") { label { id name } notes { id text } seasons { id episodes { id title } } }
      }`);
      const list = await run(backend, '{ contractseasons { id episodes { id } } }');

      expect(added.addcontractserie.label, backend.name).toEqual({ id: labelId, name: `L-${backend.name}` });
      expect(episodeId, backend.name).toEqual(expect.any(String));
      expect(read.contractserie, backend.name).toEqual({
        label: { id: labelId, name: `L-${backend.name}` },
        notes: [{ id: String(note._id), text: 'n' }],
        seasons: [{ id: seasonId, episodes: [{ id: episodeId, title: 'E' }] }],
      });
      expect(list.contractseasons, backend.name).toEqual([{ id: seasonId, episodes: [{ id: episodeId }] }]);
      if (backend.name === 'mongodb') {
        const stored = await backend.api.getModel(types.ContractEpisode).collection.findOne({});
        expect(String(stored._id)).toBe(episodeId);
      }
    }
  });

  test('an entity type embedded as a list item shows the identity its backend stores for the copy', async () => {
    const fields = 'id featured { id label } badges { id label }';
    for (const backend of backends) {
      const { Badge, Holder } = backend.badgeTypes;
      const badge = await backend.api.getModel(Badge).create({ label: 'gold' });
      const badgeId = String(badge._id);
      const added = await run(backend, `mutation($input: IdParityHolderInput!) { addidParityHolder(input: $input) { ${fields} } }`, {
        input: { name: 'H', featured: { id: badgeId }, badges: [{ label: 'b1' }] },
      });
      const holder = added.addidParityHolder;
      await run(backend, 'mutation { addidParityHolder(input: { name: "Other", badges: [{ label: "b2" }] }) { id } }');
      const byId = await run(backend, `query($id: ID) { idParityHolder(id: $id) { ${fields} } }`, { id: holder.id });
      const list = await run(backend, `{ idParityHolders { ${fields} } }`);

      expect(holder.featured, backend.name).toEqual({ id: badgeId, label: 'gold' });
      expect(byId.idParityHolder, backend.name).toEqual(holder);
      expect(list.idParityHolders.find((row) => row.id === holder.id), backend.name).toEqual(holder);
      const [copy] = holder.badges;
      if (backend.name === 'mongodb') {
        // Embedded list subdocuments get an automatic _id, which the entity id resolver reads first,
        // and filters on the copy's id match that same value.
        const raw = await backend.api.getModel(Holder).collection.findOne({ _id: new mongoose.Types.ObjectId(holder.id) });
        expect(copy).toEqual({ id: String(raw.badges[0]._id), label: 'b1' });
        expect(copy.id).not.toBe(badgeId);
        const filtered = await run(backend, `query($id: QLValue) {
          idParityHolders(badges: { terms: [{ path: "id", operator: EQ, value: $id }] }) { id }
        }`, { id: copy.id });
        expect(filtered.idParityHolders).toEqual([{ id: holder.id }]);
      } else {
        // PostgreSQL stores embedded copies without an identity of their own.
        expect(copy).toEqual({ id: null, label: 'b1' });
      }
    }
  });

  test('a stored MongoDB reference no ObjectId can hold fails its field as an internal error', async () => {
    const backend = backends.find(({ name }) => name === 'mongodb');
    const { Badge, Holder } = backend.badgeTypes;
    const badge = await backend.api.getModel(Badge).create({ label: 'silver' });
    const tag = `legacy-${randomUUID()}`;
    // Written outside Simfinity: the reference is neither an ObjectId nor its hex form.
    const { insertedId } = await backend.api.getModel(Holder).collection.insertOne({ name: tag, featuredId: 'legacy-key' });
    await backend.api.getModel(Holder).collection.insertOne({ name: tag, featuredId: badge._id });

    // With a context object references are read in batches; without one, each is read by ID.
    for (const contextValue of [{}, undefined]) {
      const callback = vi.fn();
      const read = (source, variableValues) => graphql({
        schema: backend.schema, source, variableValues, contextValue,
      });

      const list = await read(`query($tag: QLValue) {
        idParityHolders(name: { operator: EQ, value: $tag }) { name featured { label } }
      }`, { tag });
      const byId = await read('query($id: ID) { idParityHolder(id: $id) { name featured { label } } }', { id: String(insertedId) });

      const rows = list.data.idParityHolders;
      const legacyRow = rows.findIndex((row) => row.featured === null);
      expect(rows).toHaveLength(2);
      expect(rows[1 - legacyRow]).toEqual({ name: tag, featured: { label: 'silver' } });
      expect(list.errors.map(buildErrorFormatter(callback)).map(({ path, extensions }) => [path, extensions.code]))
        .toEqual([[['idParityHolders', legacyRow, 'featured'], 'INTERNAL_SERVER_ERROR']]);
      const [[classified]] = callback.mock.calls;
      expect(classified).toBeInstanceOf(InternalServerError);
      expect(classified.getCause().extensions).toMatchObject({ code: 'NOT_VALID_ID', status: 400 });
      // A by-ID read hydrates the document, and Mongoose leaves a reference it cannot cast unset.
      expect(byId).toEqual({ data: { idParityHolder: { name: tag, featured: null } } });
    }
  });
});
