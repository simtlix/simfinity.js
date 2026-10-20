// The literal text operators (#108, part 1) on both backends: the same fixture, written by the same generated
// mutations, returns the same rows for every case, except the case-folding limitations that #108 accepts, which
// FOLDING_CASES and the Unicode 16 test pin.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { graphql } from 'graphql';
import mongoose from 'mongoose';
import pg from 'pg';
import { createRuntime } from '../../packages/core/src/index.js';
import { createMongoAdapter } from '../../packages/mongodb/src/mongo/adapter.js';
import { createPostgres } from '../../packages/postgres/src/index.js';
import {
  ACCEPTED_FOLDING_DIFFERENCES, createTextOperatorFixture, FOLDING_CASES, ITEM_CASES, listOperation, registerTextOperatorFixture, seedTextOperatorFixture, WORDS,
} from '../helpers/query-text-operators.js';

const mongoUri = process.env.SIMFINITY_MONGODB_URI;
const postgresUri = process.env.SIMFINITY_POSTGRES_URI;
const TEXT = ['ILIKE', 'STARTS_WITH', 'ISTARTS_WITH', 'ENDS_WITH', 'IENDS_WITH', 'IEQ'];
// Every prefix, suffix and substring of every folding word, so that each letter, a capital sigma included, is searched
// at both ends of a value and inside it: `[start, end, value]` for each word's code points.
const substrings = () => {
  const out = [];
  for (const word of new Set(Object.values(WORDS))) {
    const chars = [...word];
    for (let start = 0; start < chars.length; start += 1) {
      for (let end = start + 1; end <= chars.length; end += 1) out.push({ value: chars.slice(start, end).join(''), prefix: start === 0, suffix: end === chars.length });
    }
  }
  return out;
};

describe.skipIf(!mongoUri || !postgresUri)('MongoDB/PostgreSQL text operator parity', () => {
  const namespace = `qt_parity_${randomUUID().replaceAll('-', '')}`;
  let pool; let backends; let unicode16;
  const execute = (backend, source, variableValues, contextValue = {}) => graphql({ schema: backend.schema, source, variableValues, contextValue });
  // The keys each backend returns, by backend name.
  const keys = async (endpoint, args, contextValue) => {
    const { source, variables } = listOperation(endpoint, args);
    const rows = {};
    for (const backend of backends) {
      const result = await execute(backend, source, variables, contextValue ? { ...contextValue } : {});
      expect(result.errors, `${backend.name} ${JSON.stringify(args)}`).toBeUndefined();
      rows[backend.name] = result.data[endpoint].map((row) => row.key);
    }
    return rows;
  };
  // The same result on every backend.
  const alike = (expected) => Object.fromEntries(backends.map(({ name }) => [name, expected]));

  beforeAll(async () => {
    await mongoose.connect(mongoUri, { dbName: namespace });
    pool = new pg.Pool({ connectionString: postgresUri });
    backends = [
      { name: 'mongodb', api: createRuntime(createMongoAdapter()) },
      { name: 'postgres', api: createPostgres({ pool, schema: namespace }) },
    ];
    for (const backend of backends) {
      if (!backend.api.initializeDatabase) backend.api.preventCreatingCollection(true);
      registerTextOperatorFixture(backend.api, createTextOperatorFixture());
      backend.schema = backend.api.createSchema();
      if (backend.api.initializeDatabase) await backend.api.initializeDatabase();
      else for (const { model } of backend.api.getRegistrations()) if (model) await model.createCollection();
      backend.ids = await seedTextOperatorFixture((source, variables) => execute(backend, source, variables));
    }
    unicode16 = (await pool.query('SELECT lower(chr(42972) COLLATE "pg_catalog"."und-x-icu") = chr(411) AS folds')).rows[0].folds;
  }, 60000);
  afterAll(async () => {
    if (mongoose.connection.readyState) { await mongoose.connection.db.dropDatabase(); await mongoose.disconnect(); }
    if (pool) { await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); await pool.end(); }
  });

  it('lists the text operators in QLOperator on both backends', async () => {
    const source = '{__type(name:"QLOperator"){enumValues{name}}}';
    const names = await Promise.all(backends.map(async (backend) => (await execute(backend, source)).data.__type.enumValues.map((value) => value.name)));
    for (const other of names.slice(1)) expect(other).toEqual(names[0]);
    expect(names[0]).toEqual(expect.arrayContaining(TEXT));
  });

  it.each(ITEM_CASES.map((item) => [item.name, item]))('returns the same rows for %s', async (name, { args, keys: expected }) => {
    expect(await keys('qtItems', args)).toEqual(alike(expected));
  });

  it('counts and aggregates text conditions alike', async () => {
    const counts = {};
    const aggregates = {};
    const page = listOperation('qtItems', { name: { operator: 'ISTARTS_WITH', value: 'palermo' } }, 'key', 'sort:{terms:[{field:"key",order:ASC}]},pagination:{page:2,size:1,count:true}');
    const repeated = listOperation('qtItems', { reviews: { terms: [{ path: 'author', operator: 'ILIKE', value: '' }] } }, 'key', 'pagination:{page:1,size:10,count:true}');
    for (const backend of backends) {
      const context = {};
      const result = await execute(backend, page.source, page.variables, context);
      const repeatedContext = {};
      const repeatedResult = await execute(backend, repeated.source, repeated.variables, repeatedContext);
      expect([result.errors, repeatedResult.errors]).toEqual([undefined, undefined]);
      counts[backend.name] = { rows: result.data.qtItems.map((row) => row.key), count: context.count, repeated: repeatedContext.count };
      const aggregate = await execute(backend, 'query($name:QLFilter){qtItems_aggregate(name:$name,aggregation:{groupId:"rank",facts:[{operation:COUNT,factName:"n",path:"id"}]},sort:{terms:[{field:"groupId",order:ASC}]}){groupId facts}}', { name: { operator: 'ILIKE', value: 'PALERMO' } });
      expect(aggregate.errors).toBeUndefined();
      aggregates[backend.name] = aggregate.data.qtItems_aggregate;
    }
    expect(counts).toEqual(alike({ rows: ['B'], count: 2, repeated: 3 }));
    expect(aggregates).toEqual(alike([{ groupId: 1, facts: { n: 1 } }, { groupId: 2, facts: { n: 1 } }]));
  });

  it('filters collection fields with text conditions alike', async () => {
    const results = {};
    for (const backend of backends) {
      const result = await execute(backend, 'query($name:QLFilter){qtShops(sort:{terms:[{field:"key",order:ASC}]}){key items(name:$name,sort:{terms:[{field:"key",order:ASC}]}){key}}}', { name: { operator: 'ILIKE', value: 'palermo' } });
      expect(result.errors).toBeUndefined();
      results[backend.name] = result.data.qtShops;
    }
    expect(results).toEqual(alike([{ key: 'S1', items: [{ key: 'A' }] }, { key: 'S2', items: [{ key: 'B' }] }, { key: 'S3', items: [] }]));
  });

  it('applies text conditions that scopes and joined scopes add alike', async () => {
    expect(await keys('qtItems', { tags: { operator: 'IEQ', value: 'red' } }, { itemPrefix: 'PALERMO S' })).toEqual(alike(['A']));
    expect(await keys('qtShops', {}, { openShopsOnly: true })).toEqual(alike(['S1', 'S3']));
    const bulk = { shop: { terms: [{ path: 'tags', operator: 'IEQ', value: 'BULK' }] } };
    expect(await keys('qtItems', bulk)).toEqual(alike(['B']));
    expect(await keys('qtItems', bulk, { openShopsOnly: true })).toEqual(alike([]));
    const found = {};
    for (const backend of backends) {
      const byId = async (itemPrefix) => (await execute(backend, 'query($id:ID!){qtItem(id:$id){key}}', { id: backend.ids.A }, { itemPrefix })).data.qtItem;
      found[backend.name] = [await byId('palermo'), await byId('xyz')];
    }
    expect(found).toEqual(alike([{ key: 'A' }, null]));
  });

  it('rejects the same invalid text conditions with INVALID_FILTER_VALUE', async () => {
    for (const operator of TEXT) {
      for (const args of [
        { name: { operator, value: 'a\u0000' } }, { rank: { operator, value: '1' } }, { name: { operator, value: null } },
        { name: { operator, value: ['a'] } }, { shop: { terms: [{ path: 'name', operator, value: 5 }] } }, { shop: { terms: [{ path: 'id', operator, value: 'x' }] } },
      ]) {
        const { source, variables } = listOperation('qtItems', args);
        const codes = await Promise.all(backends.map(async (backend) => (await execute(backend, source, variables)).errors?.[0]?.extensions?.code));
        expect(codes, JSON.stringify(args)).toEqual(backends.map(() => 'INVALID_FILTER_VALUE'));
      }
    }
  });

  it('rejects a value longer than MongoDB regular expressions allow with INVALID_FILTER_VALUE on MongoDB only', async () => {
    // MongoDB accepts patterns of at most 32,764 bytes; PostgreSQL binds the value and has no such limit.
    for (const [operator, value] of [['ILIKE', 'a'.repeat(32765)], ['ISTARTS_WITH', '.'.repeat(16382)], ['LIKE', 'a'.repeat(32761)]]) {
      const { source, variables } = listOperation('qtItems', { name: { operator, value } });
      const outcomes = await Promise.all(backends.map(async (backend) => {
        const result = await execute(backend, source, variables);
        return result.errors ? result.errors[0].extensions?.code : result.data.qtItems;
      }));
      expect(outcomes, operator).toEqual(['INVALID_FILTER_VALUE', []]);
    }
  });

  // Runs each condition on each backend, one operation per 200 conditions, each condition an aliased field, and
  // returns the keys of the words each condition finds, by backend name.
  const wordsOf = async (conditions) => {
    const found = {};
    for (const backend of backends) {
      found[backend.name] = [];
      for (let start = 0; start < conditions.length; start += 200) {
        const chunk = conditions.slice(start, start + 200);
        const source = `query(${chunk.map((_, index) => `$f${index}:QLFilter`).join(',')}){${chunk.map((_, index) => `f${index}:qtWords(word:$f${index},sort:{terms:[{field:"key",order:ASC}]}){key}`).join(' ')}}`;
        const result = await execute(backend, source, Object.fromEntries(chunk.map((condition, index) => [`f${index}`, condition])));
        expect(result.errors, backend.name).toBeUndefined();
        chunk.forEach((_, index) => found[backend.name].push(result.data[`f${index}`].map((row) => row.key)));
      }
    }
    return found;
  };

  it.each(FOLDING_CASES.map(([operator, value, words, mongodb, difference]) => [`${operator} ${JSON.stringify(value)}${difference ? `, which differs on ${difference}` : ''}`, operator, value, words, mongodb]))('folds case for %s', async (name, operator, value, words, mongodb) => {
    expect(await keys('qtWords', { word: { operator, value } })).toEqual({ mongodb: mongodb ?? words, postgres: words });
  });

  it('returns, with each case-insensitive operator, every word that its case-sensitive form returns, on both backends', async () => {
    const pairs = new Map();
    for (const { value, prefix, suffix } of substrings()) {
      const add = (exact, folded) => pairs.set(`${exact} ${value}`, [exact, folded, value]);
      if (prefix) add('STARTS_WITH', 'ISTARTS_WITH');
      if (suffix) add('ENDS_WITH', 'IENDS_WITH');
      add('LIKE', 'ILIKE');
    }
    const conditions = [...pairs.values()].flatMap(([exact, folded, value]) => [{ operator: exact, value }, { operator: folded, value }]);
    const found = await wordsOf(conditions);
    const missing = [];
    for (const backend of backends) {
      for (let index = 0; index < conditions.length; index += 2) {
        const extra = found[backend.name][index].filter((key) => !found[backend.name][index + 1].includes(key));
        if (extra.length) missing.push(`${backend.name}: ${conditions[index + 1].operator} ${JSON.stringify(conditions[index].value)} misses ${extra.join(', ')}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('returns the same words on both backends for every case-insensitive search of each substring of the folding words, in each case, except the accepted differences', async () => {
    // Each substring as written, in upper case and in lower case, with ILIKE, and also with ISTARTS_WITH for prefixes,
    // IENDS_WITH for suffixes and IEQ for whole words. The words of ACCEPTED_FOLDING_DIFFERENCES may only be extra
    // rows on PostgreSQL, the Unicode 16 letters only when its ICU knows them.
    const accepted = [...ACCEPTED_FOLDING_DIFFERENCES.dottedCapitalI, ...(unicode16 ? ACCEPTED_FOLDING_DIFFERENCES.unicode16 : [])];
    const conditions = new Map();
    for (const { value: written, prefix, suffix } of substrings()) {
      for (const value of [written, written.toUpperCase(), written.toLowerCase()]) {
        const add = (operator) => conditions.set(`${operator} ${value}`, { operator, value });
        add('ILIKE');
        if (prefix) add('ISTARTS_WITH');
        if (suffix) add('IENDS_WITH');
        if (prefix && suffix) add('IEQ');
      }
    }
    const list = [...conditions.values()];
    const found = await wordsOf(list);
    const differences = [];
    list.forEach(({ operator, value }, index) => {
      const mongodb = found.mongodb[index];
      const postgres = found.postgres[index];
      const onlyMongo = mongodb.filter((key) => !postgres.includes(key));
      const onlyPostgres = postgres.filter((key) => !mongodb.includes(key) && !accepted.includes(key));
      if (onlyMongo.length || onlyPostgres.length) differences.push(`${operator} ${JSON.stringify(value)}: only MongoDB ${onlyMongo.join(', ') || '-'}, only PostgreSQL ${onlyPostgres.join(', ') || '-'}`);
    });
    expect(list.length).toBeGreaterThan(1000);
    expect(differences).toEqual([]);
  }, 60000);

  it('folds Unicode 16 letters on PostgreSQL only with an ICU that knows them, never on MongoDB 8.0', async () => {
    expect(await keys('qtWords', { word: { operator: 'IEQ', value: WORDS.w25 } })).toEqual({ mongodb: ['w25'], postgres: unicode16 ? ['w25', 'w26'] : ['w25'] });
    expect(await keys('qtWords', { word: { operator: 'IEQ', value: WORDS.w26 } })).toEqual({ mongodb: ['w26'], postgres: unicode16 ? ['w25', 'w26'] : ['w26'] });
  });
});
