import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GraphQLBoolean, GraphQLEnumType, GraphQLFloat, GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLScalarType, GraphQLString } from 'graphql';
import pg from 'pg';
import { describeModels } from '../packages/core/src/metadata.js';
import { createQueryPlan } from '../packages/core/src/query-plan.js';
import { createPostgres } from '../packages/postgres/src/index.js';
import { compileQuery } from '../packages/postgres/src/query/compiler.js';
import { encodeParameter } from '../packages/postgres/src/codecs.js';

const uri = process.env.SIMFINITY_POSTGRES_URI;
const fixture = () => {
  const DateTime = new GraphQLScalarType({ name: 'DateTime', serialize: (value) => new Date(value).toISOString(), parseValue: (value) => new Date(value), parseLiteral: (node) => new Date(node.value) });
  const Kind = new GraphQLEnumType({ name: 'SargKind', values: { ONE: { value: 'one' }, TWO: { value: 'two' } } });
  const Detail = new GraphQLObjectType({ name: 'SargDetail', fields: { number: { type: GraphQLInt }, at: { type: DateTime } } });
  const Owner = new GraphQLObjectType({ name: 'SargOwner', fields: { id: { type: GraphQLID }, label: { type: GraphQLString } } });
  const Item = new GraphQLObjectType({ name: 'SargItem', extensions: { indexes: [{ fields: ['rank'] }] }, fields: {
    id: { type: GraphQLID },
    code: { type: new GraphQLNonNull(GraphQLString), extensions: { unique: true } },
    name: { type: GraphQLString }, rank: { type: GraphQLInt }, score: { type: GraphQLFloat },
    enabled: { type: GraphQLBoolean }, at: { type: DateTime }, kind: { type: Kind },
    tags: { type: new GraphQLList(GraphQLString) },
    owner: { type: Owner, extensions: { relation: { embedded: false, connectionField: 'owner' } } },
    detail: { type: Detail, extensions: { relation: { embedded: true } } },
  } });
  return { Item, Owner, Detail };
};

const dates = ['2020-01-01T00:00:00.000Z', '2021-01-01T00:00:00.000Z', '2022-01-01T00:00:00.000Z'];
const dateFields = new Set(['at', 'detail.at']);
const normalize = (field, value) => value == null ? null : dateFields.has(field) ? new Date(value).getTime() : value;
const valueOf = (row, field) => {
  const [head, leaf] = field.split('.');
  if (head === 'owner') return row.owner == null ? null : row.owner[leaf] ?? null;
  if (head === 'detail') return row.detail?.[leaf] ?? null;
  // Omitted scalar lists are stored as empty arrays, like Mongoose array defaults.
  return row[head] ?? (head === 'tags' ? [] : null);
};
/** Reference semantics of the null-safe filters: NULL never equals a value, NE/NIN keep NULL rows. */
const matches = (row, { field, operator, value }) => {
  const raw = valueOf(row, field);
  const list = field === 'tags';
  const actual = list ? raw?.map((item) => normalize(field, item)) ?? null : normalize(field, raw);
  const equal = (item) => {
    const expected = normalize(field, item);
    if (!list) return actual === expected;
    return expected == null ? actual == null || actual.includes(null) : actual != null && actual.includes(expected);
  };
  const compare = (op, bound) => {
    const limit = normalize(field, bound);
    const test = (item) => item != null && { LT: item < limit, LTE: item <= limit, GT: item > limit, GTE: item >= limit, LIKE: String(item).includes(limit) }[op];
    return list ? actual != null && actual.some(test) : test(actual);
  };
  switch (operator) {
    case 'EQ': return equal(value);
    case 'NE': return !equal(value);
    case 'IN': return value.some(equal);
    case 'NIN': return !value.some(equal);
    case 'BTW': return compare('GTE', value[0]) && compare('LTE', value[1]);
    default: return compare(operator, value);
  }
};
const evaluate = (row, group) => {
  const terms = [
    ...(group.conditions || []).map((condition) => matches(row, condition)),
    ...(group.AND || []).map((item) => evaluate(row, item)),
  ];
  if (group.OR?.length) terms.push(group.OR.some((item) => evaluate(row, item)));
  return terms.every(Boolean);
};

describe.skipIf(!uri)('PostgreSQL index-friendly filters', () => {
  const namespace = `sargable_${randomUUID().replaceAll('-', '')}`;
  let pool; let api; let types; let models; let database; let rows; let leaves;
  const find = async (args) => (await api.getModel(types.Item).find(args)).map((record) => record.code).sort();
  const expected = (group) => rows.filter((row) => evaluate(row, group)).map((row) => row.code).sort();
  const assertParity = async (group) => expect({ group, codes: await find({ AND: [group] }) }).toEqual({ group, codes: expected(group) });
  const explain = async (args) => {
    const { text, values } = compileQuery(models, database, createQueryPlan(models, 'SargItem', args));
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL enable_seqscan = off');
      const { rows: output } = await client.query(`EXPLAIN (FORMAT JSON) ${text}`, values.map(encodeParameter));
      const plan = output[0]['QUERY PLAN'];
      return (typeof plan === 'string' ? JSON.parse(plan) : plan)[0].Plan;
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  };
  const nodes = (plan) => [plan, ...(plan.Plans || []).flatMap(nodes)];
  const indexName = (columns, unique = false) => {
    const table = database.tables.find((item) => item.name === 'SargItem');
    if (columns[0] === 'id') return table.primaryKey.name;
    return table.indexes.find((index) => index.columns.join() === columns.join() && !!index.unique === unique).name;
  };
  const expectIndexCondition = (plan, name) => {
    const used = nodes(plan).filter((node) => node['Index Name'] === name && node['Index Cond']);
    expect(used, JSON.stringify(plan)).not.toHaveLength(0);
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: uri });
    api = createPostgres({ pool, schema: namespace });
    types = fixture();
    api.connect(null, types.Owner, 'sargOwner', 'sargOwners');
    api.addNoEndpointType(types.Detail);
    api.connect(null, types.Item, 'sargItem', 'sargItems');
    api.createSchema();
    await api.initializeDatabase();
    models = describeModels(api.getRegistrations());
    database = api.describeDatabase();
    const owners = [];
    for (const label of ['first', null, 'third']) {
      const owner = await api.getModel(types.Owner).create(label == null ? {} : { label });
      owners.push({ id: owner.id, label });
    }
    rows = [
      { code: 'a', name: 'alpha', rank: 1, score: 1.5, enabled: true, at: dates[0], kind: 'one', tags: ['x', 'y'], owner: owners[0], detail: { number: 1, at: dates[0] } },
      { code: 'b', name: 'beta', rank: 2, score: 2.5, enabled: false, at: dates[1], kind: 'two', tags: ['y'], owner: owners[1], detail: { number: 2 } },
      { code: 'c', rank: 3, tags: [null, 'x'] },
      { code: 'd', name: 'delta', score: 4.5, enabled: true, at: dates[2], kind: 'one', tags: [], owner: owners[0], detail: { at: dates[1] } },
      { code: 'e' },
      { code: 'f', name: 'beta', rank: 2, enabled: false, kind: 'two', owner: owners[1], detail: { number: 2, at: dates[2] } },
    ];
    for (const row of rows) await api.getModel(types.Item).create({ ...row, ...(row.owner ? { owner: row.owner.id } : {}) });
    const samples = {
      code: ['a', 'b', 'e'], name: ['alpha', 'beta', 'delta'], rank: [1, 2, 3], score: [1.5, 2.5, 4.5],
      enabled: [false, true, true], at: dates, kind: ['one', 'one', 'two'], tags: ['x', 'x', 'y'],
      'owner.id': owners.map((owner) => owner.id).sort(), 'owner.label': ['first', 'first', 'third'],
      'detail.number': [1, 2, 2], 'detail.at': dates,
    };
    leaves = Object.entries(samples).flatMap(([field, [low, middle, high]]) => [
      { field, operator: 'EQ', value: middle }, { field, operator: 'EQ', value: null },
      { field, operator: 'NE', value: middle }, { field, operator: 'NE', value: null },
      { field, operator: 'IN', value: [low, high] }, { field, operator: 'NIN', value: [low, high] },
      { field, operator: 'LT', value: middle }, { field, operator: 'LTE', value: middle },
      { field, operator: 'GT', value: middle }, { field, operator: 'GTE', value: middle },
      { field, operator: 'BTW', value: [low, middle] },
    ]);
    leaves.push({ field: 'name', operator: 'LIKE', value: 'et' }, { field: 'owner.label', operator: 'LIKE', value: 'ir' }, { field: 'tags', operator: 'LIKE', value: 'x' });
  }, 30000);
  afterAll(async () => {
    if (pool) { await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); await pool.end(); }
  });

  it('returns the null-safe results for every operator on nullable scalars, lists, relations and JSON paths', async () => {
    for (const leaf of leaves) await assertParity({ conditions: [leaf] });
  }, 60000);

  it('returns the null-safe results when positive and negated filters are combined with AND/OR groups', async () => {
    const count = leaves.length;
    for (let index = 0; index < count; index++) {
      const [first, second, third] = [leaves[index], leaves[(index + 11) % count], leaves[(index * 7 + 5) % count]];
      await assertParity({ conditions: [first, second] });
      await assertParity({ OR: [{ conditions: [first] }, { conditions: [second] }] });
      await assertParity({ OR: [{ conditions: [first], AND: [{ conditions: [second] }] }, { conditions: [third] }] });
      await assertParity({ AND: [{ OR: [{ conditions: [first] }, { conditions: [third] }] }], conditions: [second] });
    }
  }, 120000);

  it('binds IN and NIN lists as one array parameter, so large lists stay within the protocol limit', async () => {
    const codes = Array.from({ length: 70000 }, (_, index) => `missing-${index}`);
    expect(await find({ code: { operator: 'IN', value: [...codes, 'a'] } })).toEqual(['a']);
    expect(await find({ code: { operator: 'NIN', value: [...codes, 'a'] } })).toEqual(['b', 'c', 'd', 'e', 'f']);
  }, 60000);

  it('lets the primary key, unique, reference and declared indexes serve non-null filters', async () => {
    const [{ id }] = await api.getModel(types.Item).find({ code: { operator: 'EQ', value: 'b' } });
    expectIndexCondition(await explain({ id: { operator: 'EQ', value: id } }), indexName(['id']));
    expectIndexCondition(await explain({ code: { operator: 'EQ', value: 'b' } }), indexName(['code'], true));
    expectIndexCondition(await explain({ code: { operator: 'IN', value: ['a', 'b'] } }), indexName(['code'], true));
    expectIndexCondition(await explain({ rank: { operator: 'BTW', value: [1, 2] } }), indexName(['rank']));
    expectIndexCondition(await explain({ rank: { operator: 'GT', value: 1 } }), indexName(['rank']));
    const reference = await explain({ owner: { terms: [{ path: 'id', operator: 'EQ', value: rows[0].owner.id }] } });
    expectIndexCondition(reference, indexName(['owner']));
    expect(nodes(reference).filter((node) => node['Join Type'] === 'Left')).toEqual([]);
  });
});
