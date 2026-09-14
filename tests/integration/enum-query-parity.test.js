import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GraphQLEnumType, GraphQLID, GraphQLList, GraphQLObjectType, GraphQLString, graphql } from 'graphql';
import mongoose from 'mongoose';
import pg from 'pg';
import { createRuntime } from '../../packages/core/src/index.js';
import { createMongoAdapter } from '../../packages/mongodb/src/mongo/adapter.js';
import { createPostgres } from '../../packages/postgres/src/index.js';

const mongoUri = process.env.SIMFINITY_MONGODB_URI;
const postgresUri = process.env.SIMFINITY_POSTGRES_URI;
const fixture = () => {
  const Kind = new GraphQLEnumType({ name: 'FilterKind', values: { ONE: { value: 'TWO' }, TWO: { value: 'two' } } });
  const Plain = new GraphQLEnumType({ name: 'FilterPlain', values: { ONE: { value: 'one' }, TWO: { value: 'two' } } });
  const Numeric = new GraphQLEnumType({ name: 'FilterNumeric', values: { ONE: { value: 1 }, TWO: { value: 2 } } });
  const Leaf = new GraphQLObjectType({ name: 'FilterLeaf', fields: { kinds: { type: new GraphQLList(Kind) } } });
  const Target = new GraphQLObjectType({ name: 'FilterTarget', fields: { id: { type: GraphQLID }, kind: { type: Kind } } });
  const Root = new GraphQLObjectType({ name: 'FilterRoot', fields: {
    id: { type: GraphQLID }, key: { type: GraphQLString }, kind: { type: Kind }, plain: { type: Plain }, numeric: { type: Numeric },
    kinds: { type: new GraphQLList(Kind) }, leaves: { type: new GraphQLList(Leaf), extensions: { relation: { embedded: true } } },
    target: { type: Target, extensions: { relation: { embedded: false } } },
  } });
  const Stateful = new GraphQLObjectType({ name: 'FilterStateful', fields: { id: { type: GraphQLID }, key: { type: GraphQLString }, state: { type: Kind } } });
  return { Kind, Leaf, Target, Root, Stateful };
};

describe.skipIf(!mongoUri || !postgresUri)('enum filter differential parity', () => {
  const namespace = `enum_${randomUUID().replaceAll('-', '')}`;
  let pool; let backends;
  const execute = (b, source, contextValue = {}) => graphql({ schema: b.schema, source, contextValue });
  const compare = async (field, operator, value, endpoint = 'items') => {
    const filter = `AND:[{conditions:[{field:"${field}",operator:${operator},value:${JSON.stringify(value)}}]}]`;
    const contexts = [{}, {}];
    const results = await Promise.all(backends.map((b, i) => execute(b, `{${endpoint}(${filter},sort:{terms:[{field:"key",order:ASC}]},pagination:{page:1,size:100,count:true}){key}}`, contexts[i])));
    for (const result of results) expect(result.errors).toBeUndefined();
    expect(results[1].data).toEqual(results[0].data);
    expect(contexts[1].count).toEqual(contexts[0].count);
    const aggregates = await Promise.all(backends.map((b) => execute(b, `{${endpoint}_aggregate(${filter},aggregation:{groupId:"key",facts:[{operation:COUNT,path:"id",factName:"n"}]}){groupId facts}}`)));
    for (const result of aggregates) expect(result.errors).toBeUndefined();
    expect(aggregates[1].data).toEqual(aggregates[0].data);
    return results[0].data[endpoint].map((item) => item.key);
  };
  beforeAll(async () => {
    await mongoose.connect(mongoUri, { dbName: namespace });
    pool = new pg.Pool({ connectionString: postgresUri });
    backends = [{ api: createRuntime(createMongoAdapter()), fixture: fixture() }, { api: createPostgres({ pool, schema: namespace }), fixture: fixture() }];
    for (const b of backends) {
      const { api, fixture: f } = b;
      if (!api.initializeDatabase) api.preventCreatingCollection(true);
      api.addNoEndpointType(f.Leaf);
      api.connect(null, f.Target, 'target', 'targets');
      api.connect(null, f.Root, 'item', 'items');
      api.connect(null, f.Stateful, 'stateful', 'statefuls', null, null, { initialState: f.Kind.getValue('ONE'), actions: { finish: { from: f.Kind.getValue('ONE'), to: f.Kind.getValue('TWO') } } });
      b.schema = api.createSchema();
      if (api.initializeDatabase) await api.initializeDatabase();
      else for (const { model } of api.getRegistrations()) if (model) await model.createCollection();
      for (const [key, kind, numeric, plain] of [['first', 'TWO', 1, 'one'], ['second', 'two', 2, 'two'], ['null', null, null, null]]) {
        const target = await api.getModel(f.Target).create({ kind });
        await api.getModel(f.Root).create({ key, kind, plain, numeric, kinds: [kind], leaves: [{ kinds: [kind] }], target: target._id || target.id });
      }
      await api.getModel(f.Root).create({ key: 'missing' });
      for (const key of ['first', 'second']) {
        const added = await execute(b, `mutation{addstateful(input:{key:"${key}"}){id state}}`);
        expect(added.errors).toBeUndefined();
        expect(added.data.addstateful.state).toBe('ONE');
        if (key === 'second') {
          const changed = await execute(b, `mutation{finish_stateful(input:{id:"${added.data.addstateful.id}"}){state}}`);
          expect(changed.errors).toBeUndefined();
          expect(changed.data.finish_stateful.state).toBe('TWO');
        }
      }
    }
  }, 30000);
  afterAll(async () => {
    if (mongoose.connection.readyState) { await mongoose.connection.db.dropDatabase(); await mongoose.disconnect(); }
    if (pool) { await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); await pool.end(); }
  });

  it.each(['EQ', 'NE', 'LT', 'LTE', 'GT', 'GTE', 'BTW', 'IN', 'NIN'])('preserves name-first, strict-internal resolution through find/count/aggregate with %s', async (operator) => {
    const collection = ['BTW', 'IN', 'NIN'].includes(operator);
    for (const field of ['kind', 'kinds', 'leaves.kinds', 'target.kind']) {
      for (const value of ['ONE', 'TWO', 'two']) await compare(field, operator, collection ? [value, value] : value);
    }
    for (const value of ['ONE', 'one', 'TWO', 'two']) await compare('plain', operator, collection ? [value, value] : value);
    for (const value of ['ONE', 1, 'TWO', 2]) await compare('numeric', operator, collection ? [value, value] : value);
    for (const value of ['ONE', 'TWO', 'two']) await compare('state', operator, collection ? [value, value] : value, 'statefuls');
  });
  it('selects the named member in a collision and preserves null/list/set behavior', async () => {
    expect(await compare('kind', 'EQ', 'TWO')).toEqual(['second']);
    expect(await compare('state', 'EQ', 'TWO', 'statefuls')).toEqual(['second']);
    expect(await compare('numeric', 'EQ', 1)).toEqual(['first']);
    for (const field of ['kind', 'numeric', 'kinds', 'leaves.kinds', 'target.kind']) {
      for (const operator of ['EQ', 'NE']) await compare(field, operator, null);
      for (const operator of ['IN', 'NIN']) await compare(field, operator, []);
    }
    expect(await compare('kind', 'IN', ['ONE', 'TWO'])).toEqual(['first', 'second']);
  });
  it.each([
    ['numeric', 'EQ', '1'], ['kind', 'EQ', 'unknown'], ['kind', 'LIKE', 'two'], ['numeric', 'LIKE', 'ONE'],
    ['kind', 'IN', [null]], ['kinds', 'EQ', ['TWO']], ['kind', 'LT', null], ['kind', 'BTW', ['ONE']],
  ])('rejects the same invalid enum filter %s %s %j', async (field, operator, value) => {
    for (const b of backends) {
      const result = await execute(b, `{items(AND:[{conditions:[{field:"${field}",operator:${operator},value:${JSON.stringify(value)}}]}]){key}}`);
      expect(result.errors?.[0].extensions.code).toBe('INVALID_FILTER_VALUE');
    }
  });
});
