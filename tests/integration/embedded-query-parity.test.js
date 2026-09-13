import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GraphQLBoolean, GraphQLEnumType, GraphQLID, GraphQLInt, GraphQLList, GraphQLObjectType, GraphQLScalarType, GraphQLString, graphql } from 'graphql';
import mongoose from 'mongoose';
import pg from 'pg';
import { createRuntime } from '../../packages/core/src/index.js';
import { createMongoAdapter } from '../../src/mongo/adapter.js';
import { createFunctionSQL } from '../../packages/postgres/src/schema/ddl.js';
import { createPostgres } from '../../packages/postgres/src/index.js';

const mongoUri = process.env.SIMFINITY_MONGODB_URI;
const postgresUri = process.env.SIMFINITY_POSTGRES_URI;
const fixture = () => {
  const DateTime = new GraphQLScalarType({ name: 'DateTime', serialize: (v) => new Date(v).toISOString(), parseValue: (v) => new Date(v), parseLiteral: (n) => new Date(n.value) });
  const Kind = new GraphQLEnumType({ name: 'EmbeddedKind', values: { ONE: { value: 'one' }, TWO: { value: 'two' } } });
  const TargetDetail = new GraphQLObjectType({ name: 'EmbeddedTargetDetail', fields: { x: { type: new GraphQLList(GraphQLInt) } } });
  const Target = new GraphQLObjectType({ name: 'EmbeddedTarget', fields: { id: { type: GraphQLID }, key: { type: GraphQLString }, details: { type: new GraphQLList(TargetDetail), extensions: { relation: { embedded: true } } } } });
  const Scalar = new GraphQLObjectType({ name: 'EmbeddedScalar', fields: { n: { type: GraphQLInt } } });
  const types = [Target, TargetDetail, Scalar];
  const roots = [];
  for (const owned of [false, true]) {
    const suffix = owned ? 'Owned' : 'JSON';
    const fields = { n: { type: GraphQLInt }, x: { type: new GraphQLList(GraphQLInt) }, texts: { type: new GraphQLList(GraphQLString) }, dates: { type: new GraphQLList(DateTime) }, kinds: { type: new GraphQLList(Kind) }, p: { type: Scalar, extensions: { relation: { embedded: true } } } };
    if (owned) fields.ref = { type: Target, extensions: { relation: { embedded: false } } };
    const Leaf = new GraphQLObjectType({ name: `EmbeddedLeaf${suffix}`, fields });
    const Branch = new GraphQLObjectType({ name: `EmbeddedBranch${suffix}`, fields: { ...fields, nested: { type: new GraphQLList(Leaf), extensions: { relation: { embedded: true } } } } });
    const Child = new GraphQLObjectType({ name: `EmbeddedChild${suffix}`, fields: { id: { type: GraphQLID }, owner: { type: GraphQLID }, n: { type: GraphQLInt } } });
    types.push(Child);
    const Root = new GraphQLObjectType({ name: `EmbeddedRoot${suffix}`, fields: { children: { type: new GraphQLList(Child), extensions: { relation: { embedded: false, connectionField: 'owner' } } }, id: { type: GraphQLID }, key: { type: GraphQLString }, bucket: { type: GraphQLString }, enabled: { type: GraphQLBoolean }, date: { type: DateTime }, dates: { type: new GraphQLList(DateTime) }, p: { type: Scalar, extensions: { relation: { embedded: true } } }, w: { type: Branch, extensions: { relation: { embedded: true } } }, a: { type: new GraphQLList(Branch), extensions: { relation: { embedded: true } } } } });
    types.push(Leaf, Branch); roots.push(Root);
  }
  const State = new GraphQLEnumType({ name: 'EmbeddedState', values: { ALPHA: { value: 'zzz' }, ZETA: { value: 'aaa' } } });
  const Stateful = new GraphQLObjectType({ name: 'EmbeddedStateful', fields: { id: { type: GraphQLID }, key: { type: GraphQLString }, state: { type: State } } });
  const uniqueTypes = [false, true].map((array) => {
    const Detail = new GraphQLObjectType({ name: `EmbeddedUniqueDetail${array}`, fields: { x: { type: new GraphQLList(GraphQLInt), extensions: { unique: array } }, n: { type: GraphQLInt, extensions: { unique: !array } } } });
    types.push(Detail);
    return new GraphQLObjectType({ name: `EmbeddedUnique${array}`, fields: { id: { type: GraphQLID }, key: { type: GraphQLString }, w: { type: Detail, extensions: { relation: { embedded: true } } } } });
  });
  return { types, roots, Stateful, uniqueTypes, Target };
};
const inputs = [
  {}, { a: null }, { a: [] }, { a: [null] }, { a: [{}] }, { a: [{ x: null, n: null }] },
  { a: [{ x: [] }] }, { a: [{ x: [null] }] }, { a: [{ x: [1] }] }, { a: [{ x: [1, 2] }] },
  { a: [{ x: [1] }, { x: [2] }] }, { a: [{ x: [2] }] }, { a: [{ x: [1, 1, -3] }, null, {}] },
  { a: [{ x: [1] }, { x: [] }] }, { a: [{ n: 2, nested: [{ x: [1, 2] }, null, { x: [-4] }] }, { n: -1, nested: [] }] },
  { a: [{ nested: null }] }, { a: [{ nested: [null] }] },
  { a: [{ nested: [{ x: null }, { x: [] }, { x: [null] }] }] },
  { a: [{ nested: [{ x: [1] }, null] }, null, { nested: [] }] },
  { a: [{ texts: ['é', 'z'], kinds: ['one', null], dates: [new Date('2020-01-01Z'), null] }] },
  { a: [{ texts: ['a', 'β', 'aa'], kinds: ['two'], dates: [new Date('2021-01-01Z')] }] },
];

describe.skipIf(!mongoUri || !postgresUri)('embedded query differential parity', () => {
  const namespace = `embedded_${randomUUID().replaceAll('-', '')}`;
  let pool; let backends;
  const execute = (backend, source, variableValues, contextValue = {}) => graphql({ schema: backend.schema, source, variableValues, contextValue });
  const parity = async (source, variableValues) => {
    const results = await Promise.all(backends.map((b) => execute(b, source, variableValues)));
    results.forEach((r) => expect(r.errors, source).toBeUndefined());
    // QLValue can contain Date instances on either driver; compare their logical JSON output.
    expect(JSON.parse(JSON.stringify(results[1].data)), source).toEqual(JSON.parse(JSON.stringify(results[0].data)));
    return results[0].data;
  };
  beforeAll(async () => {
    await mongoose.connect(mongoUri, { dbName: namespace });
    pool = new pg.Pool({ connectionString: postgresUri });
    backends = [{ api: createRuntime(createMongoAdapter()), fixture: fixture() }, { api: createPostgres({ pool, schema: namespace }), fixture: fixture() }];
    for (const b of backends) {
      if (!b.api.initializeDatabase) b.api.preventCreatingCollection(true);
      b.fixture.types.forEach((t) => b.api.addNoEndpointType(t));
      b.fixture.roots.forEach((t, i) => b.api.connect(null, t, `item${i}`, `items${i}`));
      b.api.connect(null, b.fixture.Stateful, 'stateful', 'statefuls', null, null, { initialState: { name: 'ALPHA', value: 'zzz' }, actions: { finish: { from: { name: 'ALPHA', value: 'zzz' }, to: { name: 'ZETA', value: 'aaa' } } } });
      b.fixture.uniqueTypes.forEach((t, i) => b.api.connect(null, t, `unique${i}`, `uniques${i}`));
      b.schema = b.api.createSchema();
      if (b.api.initializeDatabase) await b.api.initializeDatabase();
      else for (const { model } of b.api.getRegistrations()) if (model) await model.createCollection();
      if (!b.api.initializeDatabase) {
        for (const type of b.fixture.uniqueTypes) await b.api.getModel(type).init();
        await b.api.getModel(b.fixture.uniqueTypes[1]).collection.createIndex({ 'w.x': 1 }, { unique: true });
      }
      for (const type of b.fixture.roots) {
        for (const [i, input] of inputs.entries()) await b.api.getModel(type).create({ key: String(i).padStart(2, '0'), bucket: 'all', enabled: i % 2 === 0, ...input });
        const record = await b.api.getModel(type).create({ key: 'missingList', bucket: 'all', a: [{}] });
        if (!b.api.initializeDatabase) await b.api.getModel(type).collection.updateOne({ _id: record._id }, { $unset: { 'a.0.x': '' } });
        else if (type.name.endsWith('JSON')) await pool.query(`UPDATE "${namespace}"."${type.name}" SET a = jsonb_set(a, '{0}', (a -> 0) - 'x') WHERE id = $1`, [record.id]);
        else await pool.query(`UPDATE "${namespace}"."${type.name}__a" SET x = NULL, __field__x__present = false WHERE __owner_id = $1`, [record.id]);
        const parent = await b.api.getModel(type).create({ key: 'missingParent', bucket: 'all', a: [] });
        if (!b.api.initializeDatabase) await b.api.getModel(type).collection.updateOne({ _id: parent._id }, { $unset: { a: '' } });
        else if (type.name.endsWith('JSON')) await pool.query(`UPDATE "${namespace}"."${type.name}" SET a = NULL, __field__a__present = false WHERE id = $1`, [parent.id]);
        else await pool.query(`UPDATE "${namespace}"."${type.name}" SET __a_state = 'missing' WHERE id = $1`, [parent.id]);
      }
    }
  }, 30000);
  afterAll(async () => {
    if (mongoose.connection.readyState) { await mongoose.connection.db.dropDatabase(); await mongoose.disconnect(); }
    if (pool) { await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); await pool.end(); }
  });
  for (const i of [0, 1]) {
    it(`preserves native defaults and explicit nulls (${i})`, async () => {
      await parity(`{items${i}(sort:{terms:[{field:"key",order:ASC}]}){key p{n} w{n x p{n} nested{n x}} a{n x p{n} nested{n x}}}}`);
    });
    for (const path of ['x', 'n', 'nested.x']) {
      it.each(['{value:null}', '{operator:NE,value:null}', '{value:1}', '{operator:NE,value:1}', '{operator:IN,value:[1,2]}', '{operator:NIN,value:[1,2]}', '{operator:GT,value:0}', '{operator:BTW,value:[-2,2]}'])(`filters ${i} a.${path}: %s`, async (filter) => {
        await parity(`{items${i}(a:{terms:[{path:"${path}",${filter.slice(1, -1)}}]},sort:{terms:[{field:"key",order:ASC}]}){key}}`);
      });
      it.each(['ASC', 'DESC'])(`sorts ${i} a.${path}: %s`, async (order) => {
        await parity(`{items${i}(sort:{terms:[{field:"a.${path}",order:${order}},{field:"key",order:ASC}]}){key}}`);
      });
    }
    for (const path of ['a.x', 'a.n', 'a.nested.x', 'a.texts', 'a.dates', 'a.kinds']) {
      it(`groups ${i} ${path} preserving projected shapes`, async () => {
        await parity(`{items${i}_aggregate(aggregation:{groupId:"${path}",facts:[{operation:COUNT,factName:"count",path:"id"},{operation:MIN,factName:"first",path:"key"}]},sort:{terms:[{field:"groupId",order:ASC},{field:"first",order:ASC}]}){groupId facts}}`);
      });
      it.each(['ASC', 'DESC'])(`aggregates and sorts ${i} ${path}: %s`, async (order) => {
        await parity(`{items${i}_aggregate(aggregation:{groupId:"bucket",facts:[{operation:SUM,factName:"sum",path:"${path}"},{operation:AVG,factName:"avg",path:"${path}"},{operation:COUNT,factName:"count",path:"${path}"},{operation:MIN,factName:"min",path:"${path}"},{operation:MAX,factName:"max",path:"${path}"}]},sort:{terms:[{field:"min",order:${order}}]}){groupId facts}}`);
      });
    }
    it(`materializes GraphQL defaults and minimizes inline empty objects (${i})`, async () => {
      for (const [index, input] of [{}, { p: {}, w: {}, a: [{}] }, { p: null, w: null, a: null }, { a: [null, { x: null, n: null, p: {}, nested: [{}] }] }].entries()) {
        await parity(`mutation($input:EmbeddedRoot${i ? 'Owned' : 'JSON'}Input!){additem${i}(input:$input){key p{n} w{n x p{n} nested{x}} a{n x p{n} nested{x}}}}`, { input: { key: `defaults${index}`, ...input } });
      }
    });
  }
  for (const i of [0, 1]) for (const order of ['ASC', 'DESC']) {
    it.each(['a.x', 'a.nested.x', 'a.texts', 'a.dates', 'a.kinds'])(`sorts array aggregate facts across multiple groups (${i}, ${order}, %s)`, async (path) => {
      await parity(`{items${i}_aggregate(aggregation:{groupId:"key",facts:[{operation:MIN,factName:"min",path:"${path}"},{operation:MAX,factName:"max",path:"${path}"}]},sort:{terms:[{field:"min",order:${order}},{field:"groupId",order:ASC}]}){groupId facts}}`);
    });
  }
  it('shares referenced joins with embedded projections and inverse collection cardinality', async () => {
    for (const b of backends) {
      const targetModel = b.api.getModel(b.fixture.Target);
      const targetA = await targetModel.create({ key: 'leadA', details: [{ x: [1, 2] }, { x: [3] }] });
      const targetB = await targetModel.create({ key: 'leadB', details: [{ x: [2] }] });
      const root = await b.api.getModel(b.fixture.roots[1]).create({ key: 'joined', bucket: 'joined', a: [{ x: [1, 2], ref: targetA._id }, { x: [3], ref: targetA._id }, { x: [2], ref: targetB._id }] });
      const childType = b.fixture.types.find((t) => t.name === 'EmbeddedChildOwned');
      for (const n of [1, 2, 3]) await b.api.getModel(childType).create({ owner: root._id, n });
    }
    const sources = [
      '{items1(a:{terms:[{path:"ref.key",operator:LIKE,value:"lead"},{path:"x",operator:GTE,value:1}]},children:{terms:[{path:"n",operator:GTE,value:2}]},sort:{terms:[{field:"key",order:ASC}]},pagination:{size:3,page:1,count:true}){key}}',
      '{items1_aggregate(bucket:{value:"joined"},aggregation:{groupId:"a.x",facts:[{operation:COUNT,factName:"count",path:"children.n"},{operation:SUM,factName:"sum",path:"children.n"},{operation:MIN,factName:"min",path:"a.ref.details.x"}]}){groupId facts}}',
      '{items1_aggregate(bucket:{value:"joined"},aggregation:{groupId:"a.ref.details.x",facts:[{operation:COUNT,factName:"count",path:"children.n"}]},sort:{terms:[{field:"groupId",order:ASC}]}){groupId facts}}',
    ];
    for (const source of sources) {
      const contexts = [{}, {}];
      const results = await Promise.all(backends.map((b, i) => execute(b, source, undefined, contexts[i])));
      results.forEach((r) => expect(r.errors).toBeUndefined());
      expect(results[1].data).toEqual(results[0].data);
      expect(contexts[1].count).toBe(contexts[0].count);
      if (source.includes('pagination:')) expect(contexts[1].count).toBe(4);
    }
  });
  it('uses immediate array elements for default group ordering, with lexicographic nested arrays', async () => {
    const records = [[], null, [{ x: [] }], [{ x: [1, 2] }], [{ x: [2] }]];
    for (const b of backends) for (const [index, a] of records.entries()) await b.api.getModel(b.fixture.roots[0]).create({ key: `order${index}`, bucket: 'order-only', a });
    const result = await parity('{items0_aggregate(bucket:{value:"order-only"},aggregation:{groupId:"a.x",facts:[{operation:COUNT,factName:"count",path:"id"}]}){groupId facts}}');
    expect(result.items0_aggregate.map((item) => item.groupId)).toEqual([[], null, [[]], [[1, 2]], [[2]]]);
  });
  it.each([false, 0, ''])('rejects malformed singular embedded values instead of materializing defaults: %j', async (value) => {
    for (const type of backends[1].fixture.roots) {
      await expect(backends[1].api.getModel(type).create({ key: 'bad-shape', w: value })).rejects.toMatchObject({ extensions: { code: 'INVALID_VALUE' } });
    }
  });
  it('retains native explicit undefined clears and minimizes replaced inline objects', async () => {
    for (const type of backends[1].fixture.roots) {
      const model = backends[1].api.getModel(type);
      const record = await model.create({ key: 'nativeClear', p: { n: 1 }, a: [{ x: [1] }] });
      const changed = await model.update(record.id, { p: {}, a: undefined });
      expect(changed.p).toBeUndefined();
      expect(changed.a).toBeUndefined();
    }
  });
  it('orders finite numeric extremes, nested arrays and typed values with one SQL comparison helper', async () => {
    const values = [
      ['null', null, 'Int'], ['low', -Number.MAX_VALUE, 'Float'], ['negative', -1.25, 'Float'], ['tinyNegative', -Number.MIN_VALUE, 'Float'], ['zero', 0, 'Float'], ['tiny', Number.MIN_VALUE, 'Float'], ['positive', 1.25, 'Float'], ['high', Number.MAX_VALUE, 'Float'],
      ['string', 'a', 'String'], ['array', [], 'Boolean'], ['uuid', '00000000-0000-4000-8000-000000000000', 'ID'], ['boolean', false, 'Boolean'], ['date', 0, 'DateTime'],
    ];
    const source = values.map(([name, value, type]) => ({ name, value, type }));
    const result = await pool.query(`SELECT item ->> 'name' AS name FROM jsonb_array_elements($1::jsonb) AS e(item) ORDER BY "${namespace}".__simfinity_value_key(item -> 'value', item ->> 'type')`, [JSON.stringify(source.reverse())]);
    expect(result.rows.map((row) => row.name)).toEqual(values.map(([name]) => name));
    const zero = await pool.query(`SELECT "${namespace}".__simfinity_value_key('-0'::jsonb, 'Float') = "${namespace}".__simfinity_value_key('0'::jsonb, 'Float') AS same`);
    expect(zero.rows[0].same).toBe(true);
  });
  it('validates ordering helper and presence marker drift without changing the catalog', async () => {
    const api = backends[1].api;
    const description = api.describeDatabase();
    const fn = description.functions.find((item) => item.name === '__simfinity_value_key');
    const ddl = (body) => createFunctionSQL(namespace, { ...fn, body }).replace('CREATE FUNCTION', 'CREATE OR REPLACE FUNCTION');
    await pool.query(ddl(`${fn.body}\n`));
    try { await expect(api.initializeDatabase({ mode: 'validate' })).rejects.toMatchObject({ extensions: { code: 'SCHEMA_MISMATCH' } }); }
    finally { await pool.query(ddl(fn.body)); await api.initializeDatabase({ mode: 'validate' }); }
    const owned = description.tables.find((item) => item.name === 'EmbeddedRootOwned__a');
    expect(owned.columns.find((column) => column.name === 'x').presenceColumn).toBe('__field__x__present');
    await pool.query(`ALTER TABLE "${namespace}"."${owned.name}" ALTER COLUMN __field__x__present SET DEFAULT true`);
    try { await expect(api.initializeDatabase({ mode: 'validate' })).rejects.toMatchObject({ extensions: { code: 'SCHEMA_MISMATCH' } }); }
    finally { await pool.query(`ALTER TABLE "${namespace}"."${owned.name}" ALTER COLUMN __field__x__present SET DEFAULT false`); await api.initializeDatabase({ mode: 'validate' }); }
    await expect(pool.query(`UPDATE "${namespace}"."${owned.name}" SET __field__x__present = true WHERE NOT __item_present`)).rejects.toMatchObject({ code: '23514' });
  });
  it('aggregates state names when internal enum values have the opposite order', async () => {
    for (const b of backends) {
      for (const key of ['first', 'second']) {
        const result = await execute(b, `mutation{addstateful(input:{key:"${key}"}){id}}`);
        expect(result.errors).toBeUndefined();
        if (key === 'second') expect((await execute(b, 'mutation($id:ID!){finish_stateful(input:{id:$id}){key}}', { id: result.data.addstateful.id })).errors).toBeUndefined();
      }
    }
    await parity('{statefuls_aggregate(aggregation:{groupId:"state",facts:[{operation:COUNT,factName:"count",path:"id"}]}){groupId facts}}');
    await parity('{statefuls_aggregate(aggregation:{groupId:"key",facts:[{operation:MIN,factName:"min",path:"state"},{operation:MAX,factName:"max",path:"state"}]},sort:{terms:[{field:"min",order:ASC}]}){groupId facts}}');
  });
  it('derives omitted singular-parent unique keys after descendant defaults', async () => {
    for (const b of backends) {
      const duplicate = b.api.initializeDatabase ? { extensions: { code: 'DUPLICATE_KEY' } } : { code: 11000 };
      const scalar = b.api.getModel(b.fixture.uniqueTypes[0]);
      const array = b.api.getModel(b.fixture.uniqueTypes[1]);
      expect((await scalar.create({ key: 'first' })).w.x).toEqual([]);
      await expect(scalar.create({ key: 'second', w: { n: null } })).rejects.toMatchObject(duplicate);
      expect((await array.create({ key: 'first' })).w.x).toEqual([]);
      await expect(array.create({ key: 'second', w: {} })).rejects.toMatchObject(duplicate);
      const nullRecord = await array.create({ key: 'null', w: null });
      expect((nullRecord.toObject ? nullRecord.toObject() : nullRecord).w).toBeNull();
    }
  });
  it.each([0, 1])('preserves native omission/minimization inside returned objects (%s)', async (i) => {
    const clean = (value) => {
      if (value instanceof Date) return value.toISOString();
      if (Array.isArray(value)) return value.map(clean);
      if (!value || typeof value !== 'object') return value;
      const record = value.toObject ? value.toObject() : value;
      return Object.fromEntries(Object.entries(record).filter(([key]) => !['_id', 'id', '__v'].includes(key)).map(([key, v]) => [key, clean(v)]));
    };
    for (const input of [{}, { p: {}, w: {}, a: [{}] }, { w: null, a: null }, { a: [null, { n: null, x: null, p: {}, nested: [{}] }] }]) {
      const records = await Promise.all(backends.map((b) => b.api.getModel(b.fixture.roots[i]).create({ key: 'nativeDefault', ...input })));
      const embedded = (record) => Object.fromEntries(Object.entries(clean(record)).filter(([key]) => ['p', 'w', 'a'].includes(key)));
      expect(embedded(records[1])).toEqual(embedded(records[0]));
    }
  });
  it.each([0, 1])('filters literal string and enum lists and rejects malformed operations (%s)', async (i) => {
    for (const filter of ['path:"texts",operator:LIKE,value:"é"', 'path:"texts",operator:LT,value:"β"', 'path:"kinds",value:"one"']) await parity(`{items${i}(a:{terms:[{${filter}}]},sort:{terms:[{field:"key",order:ASC}]}){key}}`);
    for (const filter of ['path:"x",value:[1,2]', 'path:"x",operator:IN,value:[null,1]']) {
      for (const b of backends) expect((await execute(b, `{items${i}(a:{terms:[{${filter}}]}){key}}`)).errors?.[0].extensions.code).toBe('INVALID_FILTER_VALUE');
    }
  });
  it.each(['2026-01-01T00:00:00.000Z', '0000-01-01T00:00:00.000Z', '-000001-01-01T00:00:00.000Z', '+010000-01-01T00:00:00.000Z'])('roundtrips historical native dates and filters in host timezone: %s', async (iso) => {
    const date = new Date(iso);
    for (const b of backends) for (const type of b.fixture.roots) {
      const model = b.api.getModel(type);
      const record = await model.create({ key: iso, bucket: 'date-only', date, dates: [date], a: [{ dates: [date] }] });
      expect(record.date.toISOString()).toBe(iso);
      expect(record.dates[0].toISOString()).toBe(iso);
    }
    for (const i of [0, 1]) {
      for (const field of ['date', 'dates']) for (const operator of ['EQ', 'GTE']) await parity(`{items${i}(${field}:{operator:${operator},value:"${iso}"},sort:{terms:[{field:"key",order:ASC}]}){key date dates a{dates}}}`);
      await parity(`{items${i}(a:{terms:[{path:"dates",value:"${iso}"}]},sort:{terms:[{field:"key",order:ASC}]}){key}}`);
    }
  });
  it.each([0, 1])('sorts and groups astronomical Date arrays after UTC parameter encoding (%s)', async (i) => {
    await parity(`{items${i}(bucket:{value:"date-only"},sort:{terms:[{field:"a.dates",order:ASC}]}){key dates a{dates}}}`);
    await parity(`{items${i}_aggregate(bucket:{value:"date-only"},aggregation:{groupId:"a.dates",facts:[{operation:MIN,factName:"min",path:"dates"},{operation:MAX,factName:"max",path:"dates"}]}){groupId facts}}`);
  });

  it.each([0, 1])('merges top-level null scalar-list group keys without collapsing nested array nulls (%s)', async (i) => {
    const bucket = `null-groups-${i}`;
    for (const b of backends) {
      const type = b.fixture.roots[i];
      const model = b.api.getModel(type);
      await model.create({ key: 'null-parent', bucket, w: null });
      await model.create({ key: 'null-terminal', bucket, w: { x: null, n: 1 } });
      const terminal = await model.create({ key: 'missing-terminal', bucket, w: { n: 1 } });
      const parent = await model.create({ key: 'missing-parent', bucket, w: null });
      if (!b.api.initializeDatabase) {
        await model.collection.updateOne({ _id: terminal._id }, { $unset: { 'w.x': '' } });
        await model.collection.updateOne({ _id: parent._id }, { $unset: { w: '' } });
      } else if (i === 0) {
        await pool.query(`UPDATE "${namespace}"."${type.name}" SET w = w - 'x' WHERE id = $1`, [terminal.id]);
        await pool.query(`UPDATE "${namespace}"."${type.name}" SET w = NULL, __field__w__present = false WHERE id = $1`, [parent.id]);
      } else {
        await pool.query(`UPDATE "${namespace}"."${type.name}__w" SET x = NULL, __field__x__present = false WHERE __owner_id = $1`, [terminal.id]);
        await pool.query(`UPDATE "${namespace}"."${type.name}" SET __w_state = 'missing' WHERE id = $1`, [parent.id]);
      }
      for (const [index, x] of [[], [null], [1]].entries()) await model.create({ key: `array-${index}`, bucket, w: { x } });
      const arrays = [null, [], [{ x: null }], [{ x: [] }], [{ x: [null] }], [{ x: [1, 2] }], [{ x: [1] }, { x: [2] }]];
      for (const [index, a] of arrays.entries()) await model.create({ key: `nested-${index}`, bucket: `${bucket}-nested`, a });
    }
    const aggregate = (selectedBucket, path) => `{items${i}_aggregate(bucket:{value:"${selectedBucket}"},aggregation:{groupId:"${path}",facts:[{operation:COUNT,factName:"count",path:"id"},{operation:MIN,factName:"first",path:"key"}]},sort:{terms:[{field:"groupId",order:ASC},{field:"first",order:ASC}]}){groupId facts}}`;
    const groups = (await parity(aggregate(bucket, 'w.x')))[`items${i}_aggregate`];
    expect(groups).toHaveLength(4);
    expect(groups.filter((row) => row.groupId === null)).toEqual([{ groupId: null, facts: { count: 4, first: 'missing-parent' } }]);
    expect(groups.filter((row) => row.groupId !== null).map((row) => row.groupId)).toEqual([[], [null], [1]]);
    const nested = (await parity(aggregate(`${bucket}-nested`, 'a.x')))[`items${i}_aggregate`];
    expect(nested).toHaveLength(7);
    expect(nested.map((row) => row.groupId)).toEqual(expect.arrayContaining([null, [], [null], [[]], [[null]], [[1, 2]], [[1], [2]]]));
    expect(nested.every((row) => row.facts.count === 1)).toBe(true);
  });

});
