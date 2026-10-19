// The literal text operators on PostgreSQL (#108, part 1): their statements in every place LIKE compiles, the
// statements of the 3.7.0 operators, the plugin's queryFeatures, rows, plans and case folding.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GraphQLID, GraphQLObjectType, GraphQLString, graphql } from 'graphql';
import pg from 'pg';
import QLOperator from '../../packages/core/src/const/QLOperator.js';
import { describeModels } from '../../packages/core/src/metadata.js';
import { createQueryPlan } from '../../packages/core/src/query-plan.js';
import { encodeParameter } from '../../packages/postgres/src/codecs.js';
import { createPostgres, postgresPlugin } from '../../packages/postgres/src/index.js';
import { compileChildrenQuery, compileQuery } from '../../packages/postgres/src/query/compiler.js';
import { describeDatabase } from '../../packages/postgres/src/schema/describe.js';
import { createSQLAdapter } from '../../packages/sql/src/adapter.js';
import { createSQL } from '../../packages/sql/src/index.js';
import { bindPlugin } from '../../packages/sql/src/plugin.js';
import {
  createTextOperatorFixture, FOLDING_CASES, ITEM_CASES, listOperation, registerTextOperatorFixture, seedTextOperatorFixture, WORDS,
} from '../helpers/query-text-operators.js';

const uri = process.env.SIMFINITY_POSTGRES_URI;
const LEGACY = ['EQ', 'NE', 'LT', 'LTE', 'GT', 'GTE', 'BTW', 'IN', 'NIN', 'LIKE'];
const TEXT = ['ILIKE', 'STARTS_WITH', 'ISTARTS_WITH', 'ENDS_WITH', 'IENDS_WITH', 'IEQ'];
const ICU = '"pg_catalog"."und-x-icu"';
// The folded form of a column, as the compiler writes it and as an application index must repeat it.
const folded = (column) => `lower(${column} COLLATE "und-x-icu")`;
const code = (error) => error?.extensions?.code;
const nodes = (plan) => [plan, ...(plan.Plans || []).flatMap(nodes)];

const offline = () => ({ query: async () => { throw new Error('offline'); }, connect: async () => { throw new Error('offline'); } });
const compiled = () => {
  const fixture = createTextOperatorFixture();
  const registrations = [fixture.Item, fixture.Shop, fixture.Review, fixture.Word].map((gqltype) => ({ gqltype }))
    .concat(fixture.embedded.map((gqltype) => ({ gqltype, endpoint: false })));
  const models = describeModels(registrations);
  const database = describeDatabase(registrations, { schema: 'app' });
  const page = { page: 1, size: 10 };
  const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
  // One statement per place and surface, from field filters, group conditions and OR branches to counts,
  // aggregate filters and the batched children statement of a collection field.
  const surfaces = {
    field: (args) => compileQuery(models, database, createQueryPlan(models, 'QtItem', { ...args, pagination: page })),
    count: (args) => compileQuery(models, database, createQueryPlan(models, 'QtItem', args, { mode: 'count' })),
    aggregate: (args) => compileQuery(models, database, createQueryPlan(models, 'QtItem', { ...args, aggregation: { groupId: 'rank', facts: [{ path: 'id', operation: 'COUNT', factName: 'n' }] } }, { mode: 'aggregate' })),
    children: (args) => compileChildrenQuery(models, database, createQueryPlan(models, 'QtItem', { ...args, pagination: page }), { column: 'shop', ids }),
  };
  const shape = (path, operator, value, form) => {
    const [head, ...rest] = path.split('.');
    if (form === 'condition') return { AND: [{ conditions: [{ field: path, operator, value }] }] };
    if (form === 'or') return { OR: [{ conditions: [{ field: 'rank', operator: 'GT', value: 1 }] }, { conditions: [{ field: path, operator, value }] }] };
    return rest.length ? { [head]: { terms: [{ path: rest.join('.'), operator, value }] } } : { [head]: { operator, value } };
  };
  return { models, database, surfaces, shape };
};
// Every path whose last field is a String or a String list: root columns, a validated scalar, a list, jsonb values
// and lists, owned rows and the references inside them, a reference and a collection.
const PLACES = ['name', 'code', 'tags', 'dims.label', 'dims.codes', 'lines.sku', 'lines.notes', 'parts.sku', 'parts.shop.name', 'parts.shop.tags', 'box.label', 'box.shop.name', 'shop.name', 'shop.tags', 'reviews.author'];

describe('PostgreSQL text operator statements', () => {
  const { models, database, surfaces, shape } = compiled();
  const fold = (sql) => `lower(${sql} COLLATE ${ICU})`;
  // The comparison each operator puts where LIKE puts strpos(left, $n), and the value it binds instead.
  const expected = (operator, left, parameter, value) => {
    const uncollated = left === 'v.value' ? '(v.value)' : left.replace(/ COLLATE "pg_catalog"\."C"$/, '');
    const literal = value.replace(/[\\%_]/g, '\\$&');
    return {
      ILIKE: [`${fold(uncollated)} LIKE ${fold(parameter)}`, `%${literal}%`],
      STARTS_WITH: [`starts_with(${left}, ${parameter})`, value],
      ISTARTS_WITH: [`${fold(uncollated)} LIKE ${fold(parameter)}`, `${literal}%`],
      ENDS_WITH: [`right(${left}, char_length(${parameter})) = ${parameter}`, value],
      IENDS_WITH: [`${fold(uncollated)} LIKE ${fold(parameter)}`, `%${literal}`],
      IEQ: [`${fold(uncollated)} = ${fold(parameter)}`, value],
    }[operator];
  };

  it.each(PLACES)('compiles each text operator on %s wherever LIKE compiles, inside the same statement', (path) => {
    const value = 'v%_\\\'--';
    for (const [surface, compile] of Object.entries(surfaces)) {
      for (const form of ['field', 'condition', 'or']) {
        if (form !== 'field' && surface !== 'field') continue;
        const like = compile(shape(path, 'LIKE', value, form));
        const [fragment, left, number] = like.text.match(/strpos\((.+?), \$(\d+)::text\) > 0/);
        const position = Number(number);
        const parameter = `$${position}::text`;
        // The batched children statement repeats the per-parent statement once per parent.
        expect(like.text.split(fragment), `${path} ${surface} ${form}`).toHaveLength(surface === 'children' ? 3 : 2);
        for (const operator of TEXT) {
          const label = `${path} ${operator} ${surface} ${form}`;
          const [comparison, bound] = expected(operator, left, parameter, value);
          const statement = compile(shape(path, operator, value, form));
          expect(statement.text, label).toBe(like.text.split(fragment).join(comparison));
          expect(statement.values, label).toEqual(like.values.map((item, index) => (index === position - 1 ? bound : item)));
          expect(statement.text, label).not.toContain(value);
        }
      }
    }
  });

  it('keeps the 3.7.0 statements of LIKE in every place', () => {
    const like = (path, surface = 'field') => surfaces[surface](shape(path, 'LIKE', 'x', 'field')).text;
    const page = 'LIMIT $2::bigint OFFSET $3::bigint';
    expect(like('name')).toBe(`SELECT t0.* FROM "app"."QtItem" t0  WHERE (strpos((t0."name") COLLATE "pg_catalog"."C", $1::text) > 0) ${page}`);
    expect(like('code')).toBe(`SELECT t0.* FROM "app"."QtItem" t0  WHERE (strpos((t0."code") COLLATE "pg_catalog"."C", $1::text) > 0) ${page}`);
    expect(like('tags')).toBe(`SELECT t0.* FROM "app"."QtItem" t0  WHERE (EXISTS (SELECT 1 FROM unnest((t0."tags") COLLATE "pg_catalog"."C") v(value) WHERE strpos(v.value, $1::text) > 0)) ${page}`);
    expect(like('dims.label')).toBe(`SELECT t0.* FROM "app"."QtItem" t0  WHERE (strpos(((t0."dims" ->> 'label')::text) COLLATE "pg_catalog"."C", $1::text) > 0) ${page}`);
    expect(like('dims.codes')).toBe(`SELECT t0.* FROM "app"."QtItem" t0  WHERE (EXISTS (SELECT 1 FROM unnest((CASE WHEN (t0."dims" -> 'codes') IS NULL OR (t0."dims" -> 'codes') = 'null'::jsonb THEN NULL ELSE ARRAY(SELECT (value #>> '{}')::text FROM jsonb_array_elements(CASE WHEN jsonb_typeof((t0."dims" -> 'codes')) = 'array' THEN (t0."dims" -> 'codes') ELSE '[]'::jsonb END) j(value)) END) COLLATE "pg_catalog"."C") v(value) WHERE strpos(v.value, $1::text) > 0)) ${page}`);
    expect(like('lines.sku')).toBe(`SELECT t0.* FROM "app"."QtItem" t0  WHERE (EXISTS (SELECT 1 FROM unnest((ARRAY(SELECT (t1.value ->> 'sku')::text FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t0."lines") = 'array' THEN t0."lines" ELSE '[{}]'::jsonb END) t1(value) WHERE jsonb_typeof(t1.value) = 'object')) COLLATE "pg_catalog"."C") v(value) WHERE strpos(v.value, $1::text) > 0)) ${page}`);
    const owned = database.tables.find((table) => table.name === 'QtItem__parts');
    const storedRow = owned.columns.map((column) => `t2."${column.name}"`).join(', ');
    const nullRow = owned.columns.map((column) => `NULL::${column.type} AS "${column.name}"`).join(', ');
    expect(like('parts.sku')).toBe(`SELECT t0.* FROM "app"."QtItem" t0  WHERE (EXISTS (SELECT 1 FROM unnest((ARRAY(SELECT t1."sku" FROM LATERAL (SELECT ${storedRow} FROM "app"."QtItem__parts" t2 WHERE t2."__owner_id" = t0."id" AND t0."__parts_state" = 'present' AND t2."__item_present" UNION ALL SELECT ${nullRow} WHERE t0."__parts_state" IS DISTINCT FROM 'present') t1 WHERE TRUE)) COLLATE "pg_catalog"."C") v(value) WHERE strpos(v.value, $1::text) > 0)) ${page}`);
    expect(like('box.label')).toBe(`SELECT t0.* FROM "app"."QtItem" t0 LEFT JOIN "app"."QtItem__box" t1 ON t1."__owner_id" = t0."id" AND t0."__box_state" = 'present' WHERE (strpos((t1."label") COLLATE "pg_catalog"."C", $1::text) > 0) ${page}`);
    expect(like('shop.name')).toBe(`SELECT t0.* FROM "app"."QtItem" t0 LEFT JOIN "app"."QtShop" t1 ON t1."id" = t0."shop" WHERE (strpos((t1."name") COLLATE "pg_catalog"."C", $1::text) > 0) ${page}`);
    expect(like('reviews.author')).toBe(`SELECT t0.* FROM "app"."QtItem" t0 LEFT JOIN "app"."QtReview" t1 ON t1."item" = t0."id" WHERE (strpos((t1."author") COLLATE "pg_catalog"."C", $1::text) > 0) ${page}`);
    expect(like('name', 'count')).toBe('SELECT count(*) AS size FROM "app"."QtItem" t0  WHERE (strpos((t0."name") COLLATE "pg_catalog"."C", $1::text) > 0)');
    expect(like('name', 'aggregate')).toBe('SELECT * FROM (SELECT t0."rank" AS "groupId", count(*) AS "fact_0" FROM "app"."QtItem" t0  WHERE (strpos((t0."name") COLLATE "pg_catalog"."C", $1::text) > 0) GROUP BY t0."rank") aggregated ORDER BY "groupId" ASC NULLS FIRST');
  });

  it('keeps the 3.7.0 statements of every other operator', () => {
    const where = (operator, value, path = 'name') => {
      const { text, values } = surfaces.count(shape(path, operator, value, 'field'));
      return { sql: text.slice(text.indexOf(' WHERE ') + 7), values };
    };
    const name = '(t0."name") COLLATE "pg_catalog"."C"';
    expect(where('EQ', 'a')).toEqual({ sql: `(${name} = $1::text)`, values: ['a'] });
    expect(where('NE', 'a')).toEqual({ sql: `(${name} IS DISTINCT FROM $1::text)`, values: ['a'] });
    expect(where('LT', 'a').sql).toBe(`(${name} < $1::text)`);
    expect(where('LTE', 'a').sql).toBe(`(${name} <= $1::text)`);
    expect(where('GT', 'a').sql).toBe(`(${name} > $1::text)`);
    expect(where('GTE', 'a').sql).toBe(`(${name} >= $1::text)`);
    expect(where('BTW', ['a', 'b']).sql).toBe(`((${name} >= $1::text AND ${name} <= $2::text))`);
    expect(where('IN', ['a', 'b'])).toEqual({ sql: `(${name} = ANY ($1::text[]))`, values: [['a', 'b']] });
    expect(where('NIN', ['a', 'b']).sql).toBe(`(NOT COALESCE(${name} = ANY ($1::text[]), FALSE))`);
    expect(where('LIKE', '%_').sql).toBe(`(strpos(${name}, $1::text) > 0)`);
    expect(where('EQ', 'a', 'tags').sql).toBe('(array_position((t0."tags") COLLATE "pg_catalog"."C", $1::text) IS NOT NULL)');
    expect(where('LT', 'a', 'tags').sql).toBe('(EXISTS (SELECT 1 FROM unnest((t0."tags") COLLATE "pg_catalog"."C") v(value) WHERE v.value < $1::text))');
  });

  it('binds escaped LIKE patterns, so values never become SQL or wildcards', () => {
    const value = '\'); DROP TABLE x; -- $1 %_\\';
    for (const operator of TEXT) {
      const { text, values } = surfaces.count({ name: { operator, value } });
      expect(text, operator).not.toContain('DROP');
      expect(values, operator).toEqual([{ ILIKE: `%${value.replace(/[\\%_]/g, '\\$&')}%`, ISTARTS_WITH: `${value.replace(/[\\%_]/g, '\\$&')}%`, IENDS_WITH: `%${value.replace(/[\\%_]/g, '\\$&')}` }[operator] ?? value]);
    }
    expect(surfaces.count({ name: { operator: 'ISTARTS_WITH', value: '' } }).values).toEqual(['%']);
    expect(surfaces.count({ name: { operator: 'ILIKE', value: '' } }).values).toEqual(['%%']);
  });

  it('rejects text operators on other scalars and invalid values in plans built by hand', () => {
    const plan = (path, operator, value) => ({ entity: 'QtItem', mode: 'find', where: { kind: 'predicate', path, operator, value }, sort: [], pagination: null });
    for (const operator of TEXT) {
      for (const [path, value] of [[['rank'], 'x'], [['id'], 'x'], [['shop', 'id'], 'x'], [['name'], null], [['name'], 5], [['name'], 'a\u0000b'], [['tags'], 7]]) {
        let error;
        try { compileQuery(models, database, plan(path, operator, value)); } catch (caught) { error = caught; }
        expect(code(error), `${operator} ${path.join('.')} ${JSON.stringify(value)}`).toBe('INVALID_FILTER_VALUE');
      }
    }
    expect(() => compileQuery(models, database, plan(['name'], 'MATCHES', 'x'))).toThrow(expect.objectContaining({ extensions: expect.objectContaining({ code: 'UNSUPPORTED_QUERY' }) }));
  });
});

describe('SQL plugin queryFeatures', () => {
  const ALL = QLOperator.getValues().map((item) => item.value);
  const invalidPlugin = expect.objectContaining({ extensions: expect.objectContaining({ code: 'INVALID_SQL_PLUGIN' }) });

  it('declares every QLOperator value in the PostgreSQL plugin and binds a frozen copy', () => {
    expect([...ALL].sort()).toEqual([...LEGACY, ...TEXT].sort());
    const plugin = postgresPlugin();
    expect([...plugin.queryFeatures.operators].sort()).toEqual([...ALL].sort());
    const bound = bindPlugin(plugin);
    plugin.queryFeatures.operators.push('LATER');
    expect(bound.queryFeatures).toEqual({ operators: postgresPlugin().queryFeatures.operators });
    expect(Object.isFrozen(bound.queryFeatures) && Object.isFrozen(bound.queryFeatures.operators)).toBe(true);
    expect(createSQLAdapter(postgresPlugin()).queryFeatures).toEqual({ operators: postgresPlugin().queryFeatures.operators });
  });

  it('gives a version 1 plugin without queryFeatures the operators of 3.7.0', () => {
    for (const queryFeatures of [undefined, null]) {
      expect(bindPlugin({ ...postgresPlugin(), queryFeatures }).queryFeatures).toEqual({ operators: LEGACY });
      expect(createSQLAdapter({ ...postgresPlugin(), queryFeatures }).queryFeatures).toEqual({ operators: LEGACY });
    }
    // Names this version does not know are kept; the runtime and the plans ignore them.
    expect(bindPlugin({ ...postgresPlugin(), queryFeatures: { operators: ['EQ', 'LATER'] } }).queryFeatures).toEqual({ operators: ['EQ', 'LATER'] });
  });

  it('ties the declaration to the compileQuery it names, so a copy with another compiler gets the operators of 3.7.0', () => {
    const custom = (...args) => compileQuery(...args);
    expect(postgresPlugin().queryFeatures.compileQuery).toBe(compileQuery);
    expect(bindPlugin({ ...postgresPlugin(), compileQuery: custom }).queryFeatures).toEqual({ operators: LEGACY });
    expect(createSQLAdapter({ ...postgresPlugin(), compileQuery: custom }).queryFeatures).toEqual({ operators: LEGACY });
    // A declaration that names the copy's own compiler, or names none, describes that compiler.
    expect(bindPlugin({ ...postgresPlugin(), compileQuery: custom, queryFeatures: { operators: ALL, compileQuery: custom } }).queryFeatures).toEqual({ operators: ALL });
    expect(bindPlugin({ ...postgresPlugin(), compileQuery: custom, queryFeatures: { operators: ALL } }).queryFeatures).toEqual({ operators: ALL });
    expect(bindPlugin({ ...postgresPlugin(), queryFeatures: { operators: ['EQ'], compileQuery: custom } }).queryFeatures).toEqual({ operators: LEGACY });
  });

  it.each([['EQ'], [[]], [{}], [{ operators: 'EQ' }], [{ operators: [1] }], [{ operators: null }], [() => {}], [{ operators: ['EQ'], compileQuery: 'compileQuery' }], [{ operators: ['EQ'], compileQuery: null }]])('rejects queryFeatures %j with INVALID_SQL_PLUGIN', (queryFeatures) => {
    expect(() => bindPlugin({ ...postgresPlugin(), queryFeatures })).toThrow(invalidPlugin);
  });

  it('rejects undeclared operators before middleware, and passes declared ones to the adapter', async () => {
    const run = async (plugin) => {
      const api = createSQL({ plugin });
      const fixture = createTextOperatorFixture();
      let middleware = 0;
      api.use((params, next) => { middleware += 1; return next(); });
      registerTextOperatorFixture(api, fixture);
      const schema = api.createSchema();
      const result = async (args) => {
        const { source, variables } = listOperation('qtItems', args);
        return code((await graphql({ schema, source, variableValues: variables, contextValue: {} })).errors?.[0]);
      };
      return { result, middleware: () => middleware };
    };
    const legacy = await run({ ...postgresPlugin({ pool: offline(), schema: 'offline' }), queryFeatures: undefined });
    for (const operator of TEXT) {
      expect(await legacy.result({ name: { operator, value: 'x' } }), operator).toBe('UNSUPPORTED_QUERY');
      expect(await legacy.result({ OR: [{ conditions: [{ field: 'shop.name', operator, value: 'x' }] }] }), operator).toBe('UNSUPPORTED_QUERY');
    }
    expect(legacy.middleware()).toBe(0);
    // The storage is not initialized, so a request that passes the gate fails there.
    expect(await legacy.result({ name: { operator: 'LIKE', value: 'x' } })).toBe('DATABASE_NOT_INITIALIZED');
    const current = await run(postgresPlugin({ pool: offline(), schema: 'offline' }));
    for (const operator of TEXT) expect(await current.result({ name: { operator, value: 'x' } }), operator).toBe('DATABASE_NOT_INITIALIZED');
    // A copy that replaces compileQuery, as 3.8.0 documents, keeps the operators of 3.7.0 until it declares more.
    let compiled = 0;
    const copy = await run({ ...postgresPlugin({ pool: offline(), schema: 'offline' }), compileQuery: (...args) => { compiled += 1; return compileQuery(...args); } });
    for (const operator of TEXT) expect(await copy.result({ name: { operator, value: 'x' } }), operator).toBe('UNSUPPORTED_QUERY');
    expect([copy.middleware(), compiled]).toEqual([0, 0]);
  });
});

describe.skipIf(!uri)('PostgreSQL text operators', () => {
  const namespace = `qt_${randomUUID().replaceAll('-', '')}`;
  const legacyNamespace = `${namespace}_legacy`;
  const copyNamespace = `${namespace}_copy`;
  let pool; let api; let schema; let fixture; let ids; let models; let database; let legacy; let copy; let unicode16;
  const execute = (source, variableValues, contextValue = {}) => graphql({ schema, source, variableValues, contextValue });
  const keys = async (endpoint, args, contextValue) => {
    const { source, variables } = listOperation(endpoint, args);
    const result = await execute(source, variables, contextValue);
    expect(result.errors, JSON.stringify(args)).toBeUndefined();
    return result.data[endpoint].map((row) => row.key);
  };
  const failure = async (args) => {
    const { source, variables } = listOperation('qtItems', args);
    return code((await execute(source, variables)).errors?.[0]);
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: uri });
    api = createPostgres({ pool, schema: namespace, batchedCollections: true });
    fixture = createTextOperatorFixture();
    registerTextOperatorFixture(api, fixture);
    schema = api.createSchema();
    await api.initializeDatabase();
    ids = await seedTextOperatorFixture((source, variables) => execute(source, variables));
    models = describeModels(api.getRegistrations());
    database = api.describeDatabase();
    const LegacyWord = new GraphQLObjectType({ name: 'QtLegacyWord', fields: { id: { type: GraphQLID }, key: { type: GraphQLString }, word: { type: GraphQLString } } });
    legacy = createSQL({ plugin: { ...postgresPlugin({ pool, schema: legacyNamespace }), queryFeatures: undefined } });
    legacy.connect(null, LegacyWord, 'qtLegacyWord', 'qtLegacyWords');
    legacy.schema = legacy.createSchema();
    await legacy.initializeDatabase();
    await legacy.getModel(LegacyWord).create({ key: 'l1', word: 'Palermo' });
    legacy.type = LegacyWord;
    // A copy of the plugin with its own compileQuery, which wraps the bundled one, as 3.8.0 documents.
    const CopyWord = new GraphQLObjectType({ name: 'QtCopyWord', fields: { id: { type: GraphQLID }, key: { type: GraphQLString }, word: { type: GraphQLString } } });
    copy = createSQL({ plugin: { ...postgresPlugin({ pool, schema: copyNamespace }), compileQuery: (...args) => { copy.compiled += 1; return compileQuery(...args); } } });
    copy.compiled = 0;
    copy.connect(null, CopyWord, 'qtCopyWord', 'qtCopyWords');
    copy.schema = copy.createSchema();
    await copy.initializeDatabase();
    await copy.getModel(CopyWord).create({ key: 'c1', word: 'Palermo' });
    copy.type = CopyWord;
    // ICU folds the Unicode 16 letter U+A7DC to U+019B only when the server's ICU knows Unicode 16.
    unicode16 = (await pool.query(`SELECT lower(chr(42972) COLLATE ${ICU}) = chr(411) AS folds`)).rows[0].folds;
  }, 60000);
  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await pool.query(`DROP SCHEMA IF EXISTS "${legacyNamespace}" CASCADE`);
      await pool.query(`DROP SCHEMA IF EXISTS "${copyNamespace}" CASCADE`);
      await pool.end();
    }
  });

  it.each(ITEM_CASES.map((item) => [item.name, item]))('returns the rows of %s', async (name, { args, keys: expected }) => {
    expect(await keys('qtItems', args)).toEqual(expected);
    // Reads that do not go through the runtime plan the same statement.
    const records = await api.getModel(fixture.Item).find({ ...args, sort: { terms: [{ field: 'key', order: 'ASC' }] } });
    expect(records.map((record) => record.key)).toEqual(expected);
  });

  it('counts, aggregates and pages text conditions', async () => {
    const context = {};
    const { source, variables } = listOperation('qtItems', { name: { operator: 'ISTARTS_WITH', value: 'palermo' } }, 'key', 'sort:{terms:[{field:"key",order:ASC}]},pagination:{page:2,size:1,count:true}');
    const page = await execute(source, variables, context);
    expect(page.errors).toBeUndefined();
    expect({ rows: page.data.qtItems.map((row) => row.key), count: context.count }).toEqual({ rows: ['B'], count: 2 });
    const aggregate = await execute('query($name:QLFilter){qtItems_aggregate(name:$name,aggregation:{groupId:"rank",facts:[{operation:COUNT,factName:"n",path:"id"}]},sort:{terms:[{field:"groupId",order:ASC}]}){groupId facts}}', { name: { operator: 'ILIKE', value: 'PALERMO' } });
    expect(aggregate.errors).toBeUndefined();
    expect(aggregate.data.qtItems_aggregate).toEqual([{ groupId: 1, facts: { n: 1 } }, { groupId: 2, facts: { n: 1 } }]);
    const reviews = { reviews: { terms: [{ path: 'author', operator: 'ILIKE', value: '' }] } };
    const counted = {};
    const repeated = await execute(listOperation('qtItems', reviews, 'key', 'pagination:{page:1,size:10,count:true}').source, reviews, counted);
    expect(repeated.errors).toBeUndefined();
    expect(counted.count).toBe(3);
  });

  it('filters batched collection fields with text conditions', async () => {
    const result = await execute('query($name:QLFilter){qtShops(sort:{terms:[{field:"key",order:ASC}]}){key items(name:$name,sort:{terms:[{field:"key",order:ASC}]}){key}}}', { name: { operator: 'ILIKE', value: 'palermo' } });
    expect(result.errors).toBeUndefined();
    expect(result.data.qtShops).toEqual([{ key: 'S1', items: [{ key: 'A' }] }, { key: 'S2', items: [{ key: 'B' }] }, { key: 'S3', items: [] }]);
  });

  it('applies text conditions that scopes and joined scopes add', async () => {
    expect(await keys('qtItems', { tags: { operator: 'IEQ', value: 'red' } }, { itemPrefix: 'PALERMO S' })).toEqual(['A']);
    expect(await keys('qtItems', { tags: { operator: 'IEQ', value: 'red' } }, { itemPrefix: '' })).toEqual(['A', 'B']);
    expect(await keys('qtShops', {}, { openShopsOnly: true })).toEqual(['S1', 'S3']);
    const bulk = { shop: { terms: [{ path: 'tags', operator: 'IEQ', value: 'BULK' }] } };
    expect(await keys('qtItems', bulk)).toEqual(['B']);
    expect(await keys('qtItems', bulk, { openShopsOnly: true })).toEqual([]);
    const byId = (contextValue) => execute('query($id:ID!){qtItem(id:$id){key}}', { id: ids.A }, contextValue);
    expect((await byId({ itemPrefix: 'palermo' })).data.qtItem).toEqual({ key: 'A' });
    expect((await byId({ itemPrefix: 'xyz' })).data.qtItem).toBeNull();
  });

  it('rejects invalid text conditions with INVALID_FILTER_VALUE', async () => {
    for (const operator of TEXT) {
      expect(await failure({ name: { operator, value: 'a\u0000' } }), operator).toBe('INVALID_FILTER_VALUE');
      expect(await failure({ rank: { operator, value: '1' } }), operator).toBe('INVALID_FILTER_VALUE');
      expect(await failure({ name: { operator, value: null } }), operator).toBe('INVALID_FILTER_VALUE');
      expect(await failure({ name: { operator, value: ['a'] } }), operator).toBe('INVALID_FILTER_VALUE');
      expect(await failure({ shop: { terms: [{ path: 'name', operator, value: 5 }] } }), operator).toBe('INVALID_FILTER_VALUE');
      expect(await failure({ shop: { terms: [{ path: 'id', operator, value: 'x' }] } }), operator).toBe('INVALID_FILTER_VALUE');
    }
  });

  it.each(FOLDING_CASES.map(([operator, value, postgres]) => [`${operator} ${JSON.stringify(value)}`, operator, value, postgres]))('folds case with ICU lower() for %s', async (name, operator, value, postgres) => {
    expect(await keys('qtWords', { word: { operator, value } })).toEqual(postgres);
  });

  // The documented sigma gap: lower() turns the value's last Σ into ς, where the stored word goes on with σ.
  it('misses, with a case-insensitive value that ends in a capital Σ, a word that its case-sensitive form finds', async () => {
    const lowered = await pool.query(`SELECT lower($1::text COLLATE ${ICU}) AS value, lower($2::text COLLATE ${ICU}) AS stored`, ['ΚΑΣ%', 'ΚΑΣΤΡΟ']);
    expect(lowered.rows[0]).toEqual({ value: 'κας%', stored: 'καστρο' });
    expect(await keys('qtWords', { word: { operator: 'STARTS_WITH', value: 'ΚΑΣ' } })).toEqual(['w29']);
    expect(await keys('qtWords', { word: { operator: 'ISTARTS_WITH', value: 'ΚΑΣ' } })).toEqual([]);
    expect(await keys('qtWords', { word: { operator: 'ILIKE', value: 'ΚΑΣ' } })).toEqual([]);
    // A value whose Σ has a letter after it, or that holds σ instead, finds the word.
    expect(await keys('qtWords', { word: { operator: 'ISTARTS_WITH', value: 'ΚΑΣΤ' } })).toEqual(['w29']);
    expect(await keys('qtWords', { word: { operator: 'ISTARTS_WITH', value: 'κασ' } })).toEqual(['w29']);
  });

  it('folds the letters of the Unicode version of the server ICU', async () => {
    expect(await keys('qtWords', { word: { operator: 'IEQ', value: WORDS.w25 } })).toEqual(unicode16 ? ['w25', 'w26'] : ['w25']);
  });

  it('rejects the new operators for a plugin without queryFeatures, also in reads outside the runtime', async () => {
    for (const operator of TEXT) {
      const result = await graphql({ schema: legacy.schema, source: 'query($word:QLFilter){qtLegacyWords(word:$word){key}}', variableValues: { word: { operator, value: 'p' } } });
      expect(code(result.errors?.[0]), operator).toBe('UNSUPPORTED_QUERY');
      await expect(legacy.getModel(legacy.type).find({ word: { operator, value: 'p' } }), operator).rejects.toMatchObject({ extensions: { code: 'UNSUPPORTED_QUERY' } });
    }
    expect((await legacy.getModel(legacy.type).find({ word: { operator: 'LIKE', value: 'Pal' } })).map((record) => record.key)).toEqual(['l1']);
  });

  it('rejects the new operators for a copy of the plugin that replaces compileQuery, before its compiler runs', async () => {
    const before = copy.compiled;
    for (const operator of TEXT) {
      const result = await graphql({ schema: copy.schema, source: 'query($word:QLFilter){qtCopyWords(word:$word){key}}', variableValues: { word: { operator, value: 'p' } } });
      expect(code(result.errors?.[0]), operator).toBe('UNSUPPORTED_QUERY');
      await expect(copy.getModel(copy.type).find({ word: { operator, value: 'p' } }), operator).rejects.toMatchObject({ extensions: { code: 'UNSUPPORTED_QUERY' } });
    }
    expect(copy.compiled).toBe(before);
    expect((await copy.getModel(copy.type).find({ word: { operator: 'LIKE', value: 'Pal' } })).map((record) => record.key)).toEqual(['c1']);
    expect(copy.compiled).toBe(before + 1);
  });

  describe('plans', () => {
    const table = () => `"${namespace}"."QtItem"`;
    const explain = async (args, setup) => {
      const { text, values } = compileQuery(models, database, createQueryPlan(models, 'QtItem', args));
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const statement of setup) await client.query(statement);
        await client.query('SET LOCAL enable_seqscan = off');
        const { rows } = await client.query(`EXPLAIN (FORMAT JSON) ${text}`, values.map(encodeParameter));
        const plan = rows[0]['QUERY PLAN'];
        return (typeof plan === 'string' ? JSON.parse(plan) : plan)[0].Plan;
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    };
    const served = (plan, index) => nodes(plan).some((node) => node['Index Name'] === index && node['Index Cond']);
    const conditions = (plan) => nodes(plan).filter((node) => node['Index Cond']);

    it('serves IEQ from a btree on the folded column, but not ISTARTS_WITH', async () => {
      const index = `CREATE INDEX qt_name_lower ON ${table()} (${folded('"name"')})`;
      const plan = await explain({ name: { operator: 'IEQ', value: 'PALERMO SOHO' } }, [index]);
      expect(served(plan, 'qt_name_lower'), JSON.stringify(plan)).toBe(true);
      const prefix = await explain({ name: { operator: 'ISTARTS_WITH', value: 'palermo' } }, [index]);
      expect(conditions(prefix), JSON.stringify(prefix)).toEqual([]);
    });

    it('serves IEQ and ISTARTS_WITH from a text_pattern_ops btree on the folded column', async () => {
      const index = `CREATE INDEX qt_name_pattern ON ${table()} (${folded('"name"')} text_pattern_ops)`;
      for (const [operator, value] of [['IEQ', 'palermo soho'], ['ISTARTS_WITH', 'PALERMO'], ['ISTARTS_WITH', '100%'], ['ISTARTS_WITH', 'ΚΑΣ']]) {
        const plan = await explain({ name: { operator, value } }, [index]);
        expect(served(plan, 'qt_name_pattern'), `${operator} ${JSON.stringify(plan)}`).toBe(true);
      }
    });

    it('serves IEQ on an embedded value from an index on its folded expression', async () => {
      const index = `CREATE INDEX qt_label_lower ON ${table()} (${folded('("dims" ->> \'label\')')})`;
      const plan = await explain({ dims: { terms: [{ path: 'label', operator: 'IEQ', value: 'LARGE BOX' }] } }, [index]);
      expect(served(plan, 'qt_label_lower'), JSON.stringify(plan)).toBe(true);
    });

    it('serves STARTS_WITH from the btree of the C column', async () => {
      const index = `CREATE INDEX qt_code ON ${table()} ("code")`;
      const plan = await explain({ code: { operator: 'STARTS_WITH', value: 'AB' } }, [index]);
      expect(served(plan, 'qt_code'), JSON.stringify(plan)).toBe(true);
    });

    it('reads every row for LIKE, ENDS_WITH and IENDS_WITH with btree indexes', async () => {
      const setup = [`CREATE INDEX qt_name ON ${table()} ("name")`, `CREATE INDEX qt_name_pattern ON ${table()} (${folded('"name"')} text_pattern_ops)`];
      for (const [operator, value] of [['LIKE', 'Soho'], ['ENDS_WITH', 'Soho'], ['IENDS_WITH', 'soho'], ['ILIKE', 'soho']]) {
        const plan = await explain({ name: { operator, value } }, setup);
        expect(conditions(plan), `${operator} ${JSON.stringify(plan)}`).toEqual([]);
      }
    });

    it('serves ILIKE, ISTARTS_WITH and IENDS_WITH from a trigram index on the folded column', async (context) => {
      const { rows } = await pool.query('SELECT 1 FROM pg_available_extensions WHERE name = \'pg_trgm\'');
      if (!rows.length) context.skip();
      const installed = (await pool.query('SELECT extnamespace::regnamespace::text AS schema FROM pg_extension WHERE extname = \'pg_trgm\'')).rows[0]?.schema;
      // Created in the test's schema and transaction unless the database already has it.
      const setup = [
        ...(installed ? [] : [`CREATE EXTENSION pg_trgm SCHEMA "${namespace}"`]),
        `CREATE INDEX qt_name_trgm ON ${table()} USING gin (${folded('"name"')} ${installed ?? `"${namespace}"`}.gin_trgm_ops)`,
      ];
      for (const [operator, value] of [['ILIKE', 'ermo'], ['ISTARTS_WITH', 'PALERMO'], ['IENDS_WITH', 'WOOD']]) {
        const plan = await explain({ name: { operator, value } }, setup);
        expect(served(plan, 'qt_name_trgm'), `${operator} ${JSON.stringify(plan)}`).toBe(true);
      }
    });
  });
});
