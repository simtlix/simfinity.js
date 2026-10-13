import { GraphQLBoolean, GraphQLEnumType, GraphQLID, GraphQLInt, GraphQLNonNull, GraphQLObjectType, GraphQLScalarType, GraphQLString, GraphQLList } from 'graphql';
import { describe, it, expect } from 'vitest';
import { describeModels } from '../packages/core/src/metadata.js';
import { createQueryPlan } from '../packages/core/src/query-plan.js';
import { describeDatabase } from '../packages/postgres/src/schema/describe.js';
import { compileQuery } from '../packages/postgres/src/query/compiler.js';
import { compileRecordBatch } from '../packages/postgres/src/record-statements.js';
import { postgresPlugin } from '../packages/postgres/src/plugin.js';
import { bindPlugin } from '../packages/sql/src/plugin.js';
import { createContractModelFixtures } from './contracts/model-fixtures.js';

const compile = (args, options) => {
  const { registrations } = createContractModelFixtures();
  const models = describeModels(registrations);
  return compileQuery(models, describeDatabase(registrations, { schema: 'app' }), createQueryPlan(models, 'ContractSerie', args, options));
};
describe('PostgreSQL query compilation', () => {
  it('binds every value and reuses correlated relation joins without distinct', () => {
    const result = compile({ tenant: { value: '\'; DROP TABLE test; --' }, seasons: { terms: [
      { path: 'year', operator: 'GTE', value: 2000 }, { path: 'year', operator: 'LTE', value: 2030 },
    ] } });
    expect(result.text).not.toContain('DROP TABLE');
    expect(result.values).toContain('\'; DROP TABLE test; --');
    expect(result.text.match(/LEFT JOIN "app"\."ContractSeason"/g)).toHaveLength(1);
    expect(result.text).not.toContain('SELECT DISTINCT');
  });
  it('expresses Mongo null/array/LIKE semantics explicitly', () => {
    expect(compile({ title: { operator: 'NE', value: 'a' } }).text).toContain('IS DISTINCT FROM');
    expect(compile({ categories: { value: 'Drama' } }).text).toContain('array_position');
    expect(compile({ title: { operator: 'LIKE', value: '%_.*' } }).text).toContain('strpos');
    expect(compile({ title: { operator: 'IN', value: [] } }).text).toContain('FALSE');
    expect(compile({ title: { operator: 'NIN', value: [] } }).text).toContain('TRUE');
  });
  it('compiles positive non-null filters to index-friendly operators and keeps negations null-safe', () => {
    const where = (args) => { const { text, values } = compile(args); return { sql: text.slice(text.indexOf(' WHERE ') + 7, text.indexOf(' LIMIT ')), values }; };
    const title = '(t0."title") COLLATE "pg_catalog"."C"';
    expect(where({ title: { value: 'a' } }).sql).toBe(`(${title} = $1::text)`);
    expect(where({ id: { value: '00000000-0000-4000-8000-000000000000' } }).sql).toBe('(t0."id" = $1::uuid)');
    expect(where({ title: { value: null } }).sql).toBe(`(${title} IS NULL)`);
    const membership = where({ title: { operator: 'IN', value: ['a', 'b'] } });
    expect(membership.sql).toBe(`(${title} = ANY ($1::text[]))`);
    expect(membership.values[0]).toEqual(['a', 'b']);
    expect(where({ seasons: { terms: [{ path: 'year', operator: 'GTE', value: 2000 }] } }).sql).toBe('(t1."year" >= $1::integer)');
    expect(where({ seasons: { terms: [{ path: 'year', operator: 'BTW', value: [2000, 2030] }] } }).sql).toBe('((t1."year" >= $1::integer AND t1."year" <= $2::integer))');
    expect(where({ title: { operator: 'LIKE', value: 'x' } }).sql).toBe(`(strpos(${title}, $1::text) > 0)`);
    expect(where({ title: { operator: 'NE', value: 'a' } }).sql).toBe(`(${title} IS DISTINCT FROM $1::text)`);
    const exclusion = where({ title: { operator: 'NIN', value: ['a', 'b'] } });
    expect(exclusion.sql).toBe(`(NOT COALESCE(${title} = ANY ($1::text[]), FALSE))`);
    expect(exclusion.values[0]).toEqual(['a', 'b']);
    const categories = '(t0."categories") COLLATE "pg_catalog"."C"';
    expect(where({ categories: { operator: 'NIN', value: ['a', 'b'] } }).sql).toBe(`(NOT (array_position(${categories}, $1::text) IS NOT NULL OR array_position(${categories}, $2::text) IS NOT NULL))`);
    expect(where({ categories: { operator: 'NE', value: 'a' } }).sql).toBe(`(NOT (array_position(${categories}, $1::text) IS NOT NULL))`);
  });
  it('projects embedded-list group keys with presence and stable child order', () => {
    const result = compile({ aggregation: { groupId: 'credits.role', facts: [{ path: 'id', operation: 'COUNT', factName: 'count' }] } }, { mode: 'aggregate' });
    expect(result.text).toContain('jsonb_agg');
    expect(result.text).toContain('__field__role__present');
    expect(result.text).toContain('__position');
    expect(result.text).toContain('__simfinity_sort_key');
  });
  it('parameterizes nested list values and rejects malformed sort paths before SQL compilation', () => {
    const Leaf = new GraphQLObjectType({ name: 'CompileLeaf', fields: { texts: { type: new GraphQLList(GraphQLString) } } });
    const Root = new GraphQLObjectType({ name: 'CompileRoot', fields: { entries: { type: new GraphQLList(Leaf), extensions: { relation: { embedded: true } } } } });
    const registrations = [{ gqltype: Root }];
    const models = describeModels(registrations);
    const database = describeDatabase(registrations);
    const injected = '\'; DROP TABLE private_data; --';
    const result = compileQuery(models, database, createQueryPlan(models, 'CompileRoot', { entries: { terms: [{ path: 'texts', operator: 'LIKE', value: injected }] } }));
    expect(result.values).toContain(injected);
    expect(result.text).not.toContain(injected);
    for (const field of ['entries..texts', 'entries.texts;DROP', 'entries.missing']) expect(() => createQueryPlan(models, 'CompileRoot', { sort: { terms: [{ field, order: 'ASC' }] } })).toThrow();
    expect(() => createQueryPlan(models, 'CompileRoot', { sort: { terms: [{ field: 'entries.texts', order: 'BAD' }] } })).toThrow();
    expect(() => compileQuery(models, database, createQueryPlan(models, 'CompileRoot', { aggregation: { groupId: 'entries', facts: [{ path: 'entries.texts', operation: 'COUNT', factName: 'n' }] } }, { mode: 'aggregate' }))).toThrow('Whole embedded objects');
  });

  // UNION ALL pairs columns by position; `alias.*` would follow the physical order, which appended or
  // reordered columns change, so both branches must list the description's columns by name.
  const expectNamedOwnedRows = (text, database, tables) => {
    expect(text).not.toMatch(/LATERAL \(SELECT t\d+\.\*/);
    for (const name of tables) {
      const owned = database.tables.find((table) => table.name === name);
      const branch = text.match(new RegExp(`LATERAL \\(SELECT ([^()]+?) FROM "${database.schema}"\\."${name}" (t\\d+) WHERE`));
      expect(branch, name).not.toBeNull();
      expect(branch[1]).toBe(owned.columns.map((column) => `${branch[2]}."${column.name}"`).join(', '));
      expect(text).toContain(`UNION ALL SELECT ${owned.columns.map((column) => `NULL::${column.type} AS "${column.name}"`).join(', ')} WHERE`);
    }
  };
  it('projects owned-list rows by description column name in both UNION branches', () => {
    const { registrations } = createContractModelFixtures();
    const models = describeModels(registrations);
    const database = describeDatabase(registrations, { schema: 'app' });
    for (const args of [
      { credits: { terms: [{ path: 'role', value: 'x' }] } },
      { credits: { terms: [{ path: 'star.name', value: 'x' }] } },
      { sort: { terms: [{ field: 'credits.role', order: 'ASC' }] } },
    ]) {
      expectNamedOwnedRows(compileQuery(models, database, createQueryPlan(models, 'ContractSerie', args)).text, database, ['ContractSerie__credits']);
    }
    const aggregate = compileQuery(models, database, createQueryPlan(models, 'ContractSerie', { aggregation: { groupId: 'credits.star.name', facts: [{ path: 'id', operation: 'COUNT', factName: 'n' }] } }, { mode: 'aggregate' }));
    expectNamedOwnedRows(aggregate.text, database, ['ContractSerie__credits']);
  });

  it('projects nested owned lists and singular owned objects inside lists by column name', () => {
    const Star = new GraphQLObjectType({ name: 'NamedStar', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
    const reference = { relation: { embedded: false } };
    const Credit = new GraphQLObjectType({ name: 'NamedCredit', fields: { role: { type: GraphQLString }, star: { type: Star, extensions: reference } } });
    const Detail = new GraphQLObjectType({ name: 'NamedDetail', fields: { tag: { type: GraphQLString }, star: { type: Star, extensions: reference } } });
    const Season = new GraphQLObjectType({ name: 'NamedSeason', fields: {
      number: { type: GraphQLString },
      detail: { type: Detail, extensions: { relation: { embedded: true } } },
      credits: { type: new GraphQLList(Credit), extensions: { relation: { embedded: true } } },
    } });
    const Serie = new GraphQLObjectType({ name: 'NamedSerie', fields: { id: { type: GraphQLID }, seasons: { type: new GraphQLList(Season), extensions: { relation: { embedded: true } } } } });
    const registrations = [{ gqltype: Serie }, { gqltype: Star }];
    const models = describeModels(registrations);
    const database = describeDatabase(registrations, { schema: 'app' });
    expect(database.tables.map((table) => table.name)).toEqual(expect.arrayContaining(['NamedSerie__seasons', 'NamedSerie__seasons__credits', 'NamedSerie__seasons__detail']));
    const compile = (args) => compileQuery(models, database, createQueryPlan(models, 'NamedSerie', args)).text;
    for (const path of ['credits.role', 'credits.star.name']) {
      expectNamedOwnedRows(compile({ seasons: { terms: [{ path, value: 'x' }] } }), database, ['NamedSerie__seasons', 'NamedSerie__seasons__credits']);
    }
    expectNamedOwnedRows(compile({ seasons: { terms: [{ path: 'number', value: 'x' }] } }), database, ['NamedSerie__seasons']);
    for (const path of ['detail.tag', 'detail.star.name']) {
      expectNamedOwnedRows(compile({ seasons: { terms: [{ path, value: 'x' }] } }), database, ['NamedSerie__seasons', 'NamedSerie__seasons__detail']);
    }
    expectNamedOwnedRows(compile({ sort: { terms: [{ field: 'seasons.credits.role', order: 'DESC' }] } }), database, ['NamedSerie__seasons', 'NamedSerie__seasons__credits']);
  });
});

const compileEnum = (field, operator, value) => {
  const Kind = new GraphQLEnumType({ name: 'CompileEnum', values: { ONE: { value: 'TWO' }, TWO: { value: 'two' } } });
  const Numeric = new GraphQLEnumType({ name: 'CompileNumeric', values: { ONE: { value: 1 }, TWO: { value: 2 } } });
  const Root = new GraphQLObjectType({ name: 'CompileEnumRoot', fields: { kind: { type: Kind }, numeric: { type: Numeric }, kinds: { type: new GraphQLList(Kind) } } });
  const registrations = [{ gqltype: Root }];
  const models = describeModels(registrations);
  return compileQuery(models, describeDatabase(registrations), createQueryPlan(models, Root.name, { [field]: { operator, value } }));
};
describe('enum query value normalization', () => {
  it.each(['EQ', 'NE', 'LT', 'LTE', 'GT', 'GTE', 'BTW', 'IN', 'NIN'])('resolves member names before internal values for %s', (operator) => {
    const collection = ['BTW', 'IN', 'NIN'].includes(operator);
    // Scalar IN/NIN bind the whole list as one array parameter; list fields bind each element.
    const bound = (field, { values }) => ['IN', 'NIN'].includes(operator) && field !== 'kinds' ? values[0] : values.slice(0, collection ? 2 : 1);
    for (const field of ['kind', 'kinds']) {
      expect(bound(field, compileEnum(field, operator, collection ? ['ONE', 'TWO'] : 'TWO'))).toEqual(collection ? ['TWO', 'two'] : ['two']);
    }
    expect(bound('numeric', compileEnum('numeric', operator, collection ? ['ONE', 2] : 'ONE'))).toEqual(collection ? ['1', '2'] : ['1']);
  });
  it.each(['1', 'unknown', false, {}])('rejects undeclared numeric internal values with strict equality: %j', (value) => {
    expect(() => compileEnum('numeric', 'EQ', value)).toThrow('Invalid enum value');
  });
  it('rejects LIKE on enums even when the value is a valid internal string', () => {
    expect(() => compileEnum('kind', 'LIKE', 'two')).toThrow('LIKE requires a string');
  });
});

describe('PostgreSQL sort null placement', () => {
  const fixture = () => {
    const DateTime = new GraphQLScalarType({ name: 'DateTime', serialize: (value) => value, parseValue: (value) => value });
    const Kind = new GraphQLEnumType({ name: 'SortKind', values: { ONE: { value: 'one' }, TWO: { value: 'two' } } });
    const Maker = new GraphQLObjectType({ name: 'SortMaker', fields: { id: { type: GraphQLID }, name: { type: new GraphQLNonNull(GraphQLString) } } });
    // The reference stores the detail in an owned table that the sort joins.
    const Detail = new GraphQLObjectType({ name: 'SortDetail', fields: { code: { type: new GraphQLNonNull(GraphQLString) }, maker: { type: Maker, extensions: { relation: { embedded: false } } } } });
    const Root = new GraphQLObjectType({ name: 'SortRoot', fields: {
      id: { type: GraphQLID }, code: { type: new GraphQLNonNull(GraphQLString) }, rank: { type: GraphQLInt }, at: { type: new GraphQLNonNull(DateTime) },
      enabled: { type: new GraphQLNonNull(GraphQLBoolean) }, kind: { type: new GraphQLNonNull(Kind) }, note: { type: GraphQLString },
      maker: { type: Maker, extensions: { relation: { embedded: false } } }, detail: { type: Detail, extensions: { relation: { embedded: true } } },
      tags: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
    } });
    const registrations = [{ gqltype: Maker }, { gqltype: Root }];
    return { models: describeModels(registrations), database: describeDatabase(registrations, { schema: 'app' }) };
  };
  const orderBy = ({ text }) => text.slice(text.indexOf(' ORDER BY ') + 10, text.indexOf(' LIMIT '));
  const sorted = (models, database, terms, configuration) => orderBy(compileQuery(models, database, createQueryPlan(models, 'SortRoot', { sort: { terms } }), null, configuration));

  it('omits the NULLS clause for the identity and required root columns', () => {
    const { models, database } = fixture();
    const C = 'COLLATE "pg_catalog"."C"';
    for (const order of ['ASC', 'DESC']) {
      expect(sorted(models, database, [{ field: 'id', order }])).toBe(`t0."id" ${order}`);
      expect(sorted(models, database, [{ field: 'code', order }])).toBe(`(t0."code") ${C} ${order}`);
      expect(sorted(models, database, [{ field: 'at', order }])).toBe(`t0."at" ${order}`);
      expect(sorted(models, database, [{ field: 'enabled', order }])).toBe(`t0."enabled" ${order}`);
      expect(sorted(models, database, [{ field: 'kind', order }])).toBe(`(t0."kind") ${C} ${order}`);
    }
    expect(compile({ sort: { terms: [{ field: 'title', order: 'DESC' }, { field: 'id', order: 'ASC' }] } }).text).toContain(`ORDER BY (t0."title") ${C} DESC, t0."id" ASC LIMIT`);
  });

  it('keeps nulls first ascending and last descending for nullable, joined, embedded and list paths', () => {
    const { models, database } = fixture();
    const C = 'COLLATE "pg_catalog"."C"';
    const nulls = { ASC: 'NULLS FIRST', DESC: 'NULLS LAST' };
    for (const order of ['ASC', 'DESC']) {
      expect(sorted(models, database, [{ field: 'rank', order }])).toBe(`t0."rank" ${order} ${nulls[order]}`);
      expect(sorted(models, database, [{ field: 'note', order }])).toBe(`(t0."note") ${C} ${order} ${nulls[order]}`);
      // NOT NULL columns of joined rows are NULL when the join finds no row.
      expect(sorted(models, database, [{ field: 'maker.name', order }])).toBe(`(t1."name") ${C} ${order} ${nulls[order]}`);
      expect(sorted(models, database, [{ field: 'detail.code', order }])).toBe(`(t1."code") ${C} ${order} ${nulls[order]}`);
      expect(sorted(models, database, [{ field: 'tags', order }])).toMatch(new RegExp(`^"app"\\."__simfinity_sort_key"\\(.*\\) ${order} ${nulls[order]}$`));
    }
    expect(compile({ sort: { terms: [{ field: 'director.name', order: 'ASC' }] } }).text).toContain(`ORDER BY ((t0."director" ->> 'name')::text) ${C} ASC NULLS FIRST LIMIT`);
  });

  it('keeps the explicit NULLS clause on every sort term when explicitNullsOrder is set, as 3.5.9 did', () => {
    const { models, database } = fixture();
    const C = 'COLLATE "pg_catalog"."C"';
    const legacy = { explicitNullsOrder: true };
    expect(sorted(models, database, [{ field: 'id', order: 'ASC' }], legacy)).toBe('t0."id" ASC NULLS FIRST');
    expect(sorted(models, database, [{ field: 'code', order: 'DESC' }, { field: 'at', order: 'ASC' }, { field: 'rank', order: 'DESC' }], legacy))
      .toBe(`(t0."code") ${C} DESC NULLS LAST, t0."at" ASC NULLS FIRST, t0."rank" DESC NULLS LAST`);
    const { registrations } = createContractModelFixtures();
    const contract = describeModels(registrations);
    const plan = createQueryPlan(contract, 'ContractSerie', { sort: { terms: [{ field: 'title', order: 'DESC' }, { field: 'id', order: 'ASC' }] } });
    expect(compileQuery(contract, describeDatabase(registrations, { schema: 'app' }), plan, null, legacy).text)
      .toBe(`SELECT t0.* FROM "app"."ContractSerie" t0  WHERE TRUE ORDER BY (t0."title") ${C} DESC NULLS LAST, t0."id" ASC NULLS FIRST LIMIT $1::bigint OFFSET $2::bigint`);
    // Sorts without a required root column compile to the same text either way.
    for (const terms of [[{ field: 'rank', order: 'ASC' }], [{ field: 'maker.name', order: 'DESC' }, { field: 'tags', order: 'ASC' }]]) {
      expect(sorted(models, database, terms, legacy)).toBe(sorted(models, database, terms));
    }
  });
});

describe('PostgreSQL list aggregates', () => {
  const count = (text, table) => text.split(table).length - 1;

  it('evaluates a list path once per row for MIN and MAX', () => {
    const facts = [{ path: 'credits.role', operation: 'MIN', factName: 'first' }, { path: 'credits.role', operation: 'MAX', factName: 'last' }, { path: 'credits.role', operation: 'COUNT', factName: 'n' }];
    const { text } = compile({ aggregation: { groupId: 'tenant', facts } }, { mode: 'aggregate' });
    expect(count(text, '"app"."ContractSerie__credits"')).toBe(1);
    expect(text).toContain('CROSS JOIN LATERAL (SELECT CASE WHEN t0."__credits_state" = \'present\' THEN');
    expect(text).toContain('OFFSET 0) f0 WHERE');
    expect(text).toContain('(array_agg(f0.value ORDER BY "app"."__simfinity_value_key"(f0.value, \'String\') ASC) FILTER (WHERE f0.value IS NOT NULL AND f0.value <> \'null\'::jsonb))[1] AS "fact_0"');
    expect(text).toContain('(array_agg(f0.value ORDER BY "app"."__simfinity_value_key"(f0.value, \'String\') DESC) FILTER (WHERE f0.value IS NOT NULL AND f0.value <> \'null\'::jsonb))[1] AS "fact_1"');
    expect(text).not.toContain(' f1');
    // Each list path gets its own lateral, after the joins it can read.
    const joined = compile({ aggregation: { groupId: 'label.name', facts: [{ path: 'credits.role', operation: 'MIN', factName: 'role' }, { path: 'categories', operation: 'MAX', factName: 'category' }] } }, { mode: 'aggregate' }).text;
    expect(joined).toMatch(/LEFT JOIN "app"\."ContractLabel" t\d+ ON .* CROSS JOIN LATERAL \(SELECT .* OFFSET 0\) f0 CROSS JOIN LATERAL \(SELECT .*t0\."categories".* OFFSET 0\) f1 WHERE/);
    expect(count(joined, '"app"."ContractSerie__credits"')).toBe(1);
  });

  it('evaluates a nested owned list once per row for MIN and MAX', () => {
    const Star = new GraphQLObjectType({ name: 'ListStar', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
    const Credit = new GraphQLObjectType({ name: 'ListCredit', fields: { role: { type: GraphQLString }, star: { type: Star, extensions: { relation: { embedded: false } } } } });
    const Season = new GraphQLObjectType({ name: 'ListSeason', fields: { number: { type: GraphQLInt }, credits: { type: new GraphQLList(Credit), extensions: { relation: { embedded: true } } } } });
    const Serie = new GraphQLObjectType({ name: 'ListSerie', fields: { id: { type: GraphQLID }, key: { type: GraphQLString }, seasons: { type: new GraphQLList(Season), extensions: { relation: { embedded: true } } } } });
    const registrations = [{ gqltype: Serie }, { gqltype: Star }];
    const models = describeModels(registrations);
    const plan = createQueryPlan(models, 'ListSerie', { aggregation: { groupId: 'key', facts: [{ path: 'seasons.credits.role', operation: 'MIN', factName: 'min' }, { path: 'seasons.credits.role', operation: 'MAX', factName: 'max' }] } }, { mode: 'aggregate' });
    const { text } = compileQuery(models, describeDatabase(registrations, { schema: 'app' }), plan);
    expect(count(text, '"app"."ListSerie__seasons" ')).toBe(1);
    expect(count(text, '"app"."ListSerie__seasons__credits" ')).toBe(2);
  });
});

describe('PostgreSQL owned-row batches', () => {
  it('compiles a record batch into one multi-row INSERT without RETURNING', () => {
    const { registrations } = createContractModelFixtures();
    const table = describeDatabase(registrations, { schema: 'app' }).tables.find((item) => item.name === 'ContractSerie__credits');
    const owner = '00000000-0000-4000-8000-000000000000';
    const rows = [
      { __id: '00000000-0000-4000-8000-000000000001', __owner_id: owner, __position: 0, role: 'Lead' },
      { __id: '00000000-0000-4000-8000-000000000002', __owner_id: owner, __position: 1, role: null },
    ];
    expect(compileRecordBatch({ schema: 'app' }, { kind: 'insertMany', table, rows })).toEqual({
      text: 'INSERT INTO "app"."ContractSerie__credits" ("__id", "__owner_id", "__position", "role") VALUES ($1::uuid, $2::uuid, $3::integer, $4::text), ($5::uuid, $6::uuid, $7::integer, $8::text)',
      values: [rows[0].__id, owner, 0, 'Lead', rows[1].__id, owner, 1, null],
    });
  });

  it('advertises single-statement reads and binds the batch compiler with a 32,767-value limit', () => {
    const plugin = bindPlugin(postgresPlugin());
    expect(plugin.capabilities).toContain('singleStatementReads');
    expect(plugin.compileRecordBatch).toBe(compileRecordBatch);
    expect(plugin.maxRecordBatchValues).toBe(32767);
  });
});
