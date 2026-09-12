import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GraphQLBoolean, GraphQLEnumType, GraphQLFloat, GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLScalarType, GraphQLString, graphql, printSchema } from 'graphql';
import mongoose from 'mongoose';
import pg from 'pg';
import { createRuntime, createValidatedScalar } from '../../packages/core/src/index.js';
import { createMongoAdapter } from '../../src/mongo/adapter.js';
import { createPostgres } from '../../packages/postgres/src/index.js';
import { createContractModelFixtures } from '../contracts/model-fixtures.js';

const mongoUri = process.env.SIMFINITY_MONGODB_URI;
const postgresUri = process.env.SIMFINITY_POSTGRES_URI;
const typedFixture = () => {
  const DateTime = new GraphQLScalarType({ name: 'DateTime', serialize: (value) => new Date(value).toISOString(), parseValue: (value) => new Date(value), parseLiteral: (node) => new Date(node.value) });
  const Kind = new GraphQLEnumType({ name: 'ParityKind', values: { ONE: { value: 'one' }, TWO: { value: 'two' } } });
  const Detail = new GraphQLObjectType({ name: 'ParityDetail', fields: { number: { type: GraphQLInt }, text: { type: GraphQLString } } });
  const Item = new GraphQLObjectType({ name: 'ParityItem', fields: {
    id: { type: GraphQLID }, key: { type: new GraphQLNonNull(GraphQLString) },
    number: { type: GraphQLInt }, score: { type: GraphQLFloat }, enabled: { type: GraphQLBoolean },
    date: { type: DateTime }, dates: { type: new GraphQLList(new GraphQLNonNull(DateTime)) }, kind: { type: Kind },
    checked: { type: createValidatedScalar('Checked', 'Checked string', GraphQLString, () => {}) },
    tags: { type: new GraphQLList(GraphQLString) },
    detail: { type: Detail, extensions: { relation: { embedded: true } } },
    entries: { type: new GraphQLList(Detail), extensions: { relation: { embedded: true } } },
  } });
  return { Item, Detail };
};

describe.skipIf(!mongoUri || !postgresUri)('MongoDB/PostgreSQL GraphQL parity', () => {
  const namespace = `parity_${randomUUID().replaceAll('-', '')}`;
  let pool; let backends;
  const execute = (backend, source, variableValues, contextValue = {}) => graphql({ schema: backend.schema, source, variableValues, contextValue });
  const assertParity = async (source, variableValues) => {
    const results = await Promise.all(backends.map((backend) => execute(backend, source, variableValues)));
    for (const result of results) expect(result.errors).toBeUndefined();
    expect(results[1].data).toEqual(results[0].data);
    return results[1].data;
  };
  beforeAll(async () => {
    await mongoose.connect(mongoUri, { dbName: namespace });
    pool = new pg.Pool({ connectionString: postgresUri });
    backends = [
      { api: createRuntime(createMongoAdapter()), fixture: typedFixture(), relations: createContractModelFixtures() },
      { api: createPostgres({ pool, schema: namespace }), fixture: typedFixture(), relations: createContractModelFixtures() },
    ];
    for (const backend of backends) {
      if (!backend.api.initializeDatabase) backend.api.preventCreatingCollection(true);
      backend.api.addNoEndpointType(backend.fixture.Detail);
      backend.api.connect(null, backend.fixture.Item, 'parityItem', 'parityItems');
      for (const registration of backend.relations.registrations) {
        if (registration.endpoint) backend.api.connect(null, registration.gqltype, registration.simpleEntityEndpointName, registration.listEntitiesEndpointName, registration.controller);
        else backend.api.addNoEndpointType(registration.gqltype);
      }
      backend.schema = backend.api.createSchema();
      if (backend.api.initializeDatabase) await backend.api.initializeDatabase();
      else for (const { model } of backend.api.getRegistrations()) if (model) await model.createCollection();
      const inputs = [
        { key: 'A', number: 1, score: 1.5, enabled: true, kind: 'ONE', checked: 'a.b', date: '2020-01-01T00:00:00Z', dates: ['2020-01-01T00:00:00Z'], tags: ['x', 'y'], detail: { number: 2, text: 'alpha' }, entries: [{ number: 1 }, { number: 5 }] },
        { key: 'B', number: 3, score: 3, enabled: false, kind: 'ONE', checked: 'axb', date: '2021-01-01T00:00:00Z', dates: ['2021-01-01T00:00:00Z'], tags: ['y', 'x'], detail: { number: 3 }, entries: [{ number: 3 }] },
        { key: 'C', number: 4, score: 7.5, enabled: true, kind: 'TWO', tags: [null, 'z'], entries: [null, { number: 4 }] },
        { key: 'D', tags: [], entries: [] },
        { key: 'E' },
      ];
      for (const input of inputs) {
        const result = await execute(backend, 'mutation($input:ParityItemInput!){addparityItem(input:$input){key}}', { input });
        expect(result.errors).toBeUndefined();
      }
      const star = await backend.api.getModel(backend.relations.types.ContractStar).create({ name: 'Lead' });
      for (const input of [
        { tenant: 'a', title: 'Alpha', categories: ['a', 'b'], director: { name: 'Ada' }, seasons: { added: [{ number: 1, year: 2030 }, { number: 2, year: 2031 }] }, credits: [{ role: 'First', star: { id: star._id.toString() } }, { role: 'Second', star: { id: star._id.toString() } }] },
        { tenant: 'a', title: 'Beta', seasons: { added: [{ number: 1, year: 2030 }, { number: 2, year: 2030 }] } },
        { tenant: 'b', title: 'Gamma' },
      ]) {
        const result = await execute(backend, 'mutation($input:ContractSerieInput!){addcontractserie(input:$input){id}}', { input });
        expect(result.errors).toBeUndefined();
      }
    }
  }, 30000);
  afterAll(async () => {
    if (mongoose.connection.readyState) { await mongoose.connection.db.dropDatabase(); await mongoose.disconnect(); }
    if (pool) { await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); await pool.end(); }
  });

  it('generates identical public schemas', () => {
    expect(printSchema(backends[1].schema)).toBe(printSchema(backends[0].schema));
  });

  it.each([
    'number:{value:1}', 'number:{operator:NE,value:1}', 'number:{operator:LT,value:3}',
    'number:{operator:LTE,value:3}', 'number:{operator:GT,value:1}', 'number:{operator:GTE,value:3}',
    'number:{operator:BTW,value:[2,4]}', 'number:{operator:IN,value:[1,4]}', 'number:{operator:NIN,value:[1,4]}',
    'number:{value:null}', 'number:{operator:NE,value:null}', 'number:{operator:IN,value:[]}', 'number:{operator:NIN,value:[]}',
    'enabled:{value:false}', 'kind:{value:"one"}', 'checked:{operator:LIKE,value:"a.b"}',
    'date:{operator:GTE,value:"2021-01-01T00:00:00Z"}', 'dates:{operator:IN,value:["2020-01-01T00:00:00Z"]}',
    'tags:{value:"x"}', 'tags:{operator:NE,value:"x"}',
    'tags:{value:null}',
    'detail:{terms:[{path:"number",operator:GT,value:2}]}',
    'entries:{terms:[{path:"number",operator:GT,value:3},{path:"number",operator:LT,value:2}]}',
    'entries:{terms:[{path:"number",value:null}]}',
    'OR:[{conditions:[{field:"number",value:1}]},{AND:[{conditions:[{field:"number",operator:GTE,value:3},{field:"number",operator:LTE,value:4}]}]}]',
  ])('matches filter %s', async (filter) => {
    await assertParity(`{parityItems(${filter},sort:{terms:[{field:"key",order:ASC}]}){key}}`);
  });

  it.each(['tags:{value:["x","y"]}', 'tags:{operator:NIN,value:[null,"x"]}'])('rejects invalid v3.1 filter %s on both backends', async (filter) => {
    for (const backend of backends) {
      const result = await execute(backend, `{parityItems(${filter}){key}}`);
      expect(result.errors?.[0].extensions.code).toBe('INVALID_FILTER_VALUE');
    }
  });

  it.each(['ASC', 'DESC'])('sorts nullable arrays consistently (%s)', async (order) => {
    await assertParity(`{parityItems(sort:{terms:[{field:"tags",order:${order}},{field:"key",order:ASC}]}){key}}`);
    await assertParity(`{parityItems(sort:{terms:[{field:"entries.number",order:${order}},{field:"key",order:ASC}]}){key}}`);
  });

  it('decodes dates, enums and scalar lists in reads', async () => {
    await assertParity('{parityItems(sort:{terms:[{field:"key",order:ASC}]}){key number score enabled date dates kind checked tags entries{number text}}}');
  });

  it.each([
    'seasons:{terms:[{path:"year",value:2030}]}',
    'seasons:{terms:[{path:"year",value:2030},{path:"number",value:2}]}',
    'credits:{terms:[{path:"role",operator:IN,value:["First","Second"]}]}',
    'credits:{terms:[{path:"star.name",value:"Lead"}]}',
    'OR:[{conditions:[{field:"seasons.year",value:2030}]},{conditions:[{field:"title",value:"Gamma"}]}]',
  ])('preserves joined rows and counts for %s', async (filter) => {
    const counts = [];
    const results = [];
    for (const backend of backends) {
      const context = { tenant: 'a' };
      const result = await execute(backend, `{contractseries(${filter},sort:{terms:[{field:"title",order:ASC}]},pagination:{page:1,size:2,count:true}){title}}`, undefined, context);
      expect(result.errors).toBeUndefined();
      results.push(result.data); counts.push(context.count);
    }
    expect(results[1]).toEqual(results[0]);
    expect(counts[1]).toBe(counts[0]);
  });

  it.each(['$bad', 'a..b', ''])('rejects malformed aggregate sort path %j on both backends', async (field) => {
    const source = 'query($sort:QLSortExpression){parityItems_aggregate(aggregation:{groupId:"kind",facts:[{operation:COUNT,factName:"total",path:"id"}]},sort:$sort){groupId facts}}';
    for (const backend of backends) {
      const result = await execute(backend, source, { sort: { terms: [{ field, order: 'ASC' }] } });
      expect(result.errors?.[0].extensions.code).toBe('INVALID_FILTER_PATH');
    }
  });

  it.each(['total', 'groupId', 'undeclaredAlias', 'safe.path'])('preserves aggregate ordering for safe sort field %j', async (field) => {
    const source = 'query($sort:QLSortExpression){parityItems_aggregate(aggregation:{groupId:"kind",facts:[{operation:COUNT,factName:"total",path:"id"}]},sort:$sort){groupId facts}}';
    const result = await assertParity(source, { sort: { terms: [{ field, order: 'ASC' }, { field: 'groupId', order: 'ASC' }] } });
    expect(result.parityItems_aggregate.map((row) => row.groupId)).toEqual(field === 'total' ? ['two', null, 'one'] : [null, 'one', 'two']);
  });

  it('aggregates scalar facts, null groups and relation paths with the same row multiplicity', async () => {
    await assertParity('{parityItems_aggregate(aggregation:{groupId:"kind",facts:[{operation:COUNT,factName:"count",path:"id"},{operation:SUM,factName:"sum",path:"score"},{operation:AVG,factName:"avg",path:"score"},{operation:MIN,factName:"min",path:"score"},{operation:MAX,factName:"max",path:"score"}]}){groupId facts}}');
    await assertParity('{contractseries_aggregate(aggregation:{groupId:"tenant",facts:[{operation:COUNT,factName:"count",path:"seasons.id"},{operation:SUM,factName:"sum",path:"seasons.number"}]}){groupId facts}}');
    await assertParity('{parityItems_aggregate(aggregation:{groupId:"kind",facts:[{operation:MIN,factName:"min",path:"enabled"},{operation:MAX,factName:"max",path:"enabled"}]}){groupId facts}}');
  });
});
