import { GraphQLEnumType, GraphQLID, GraphQLObjectType, GraphQLString, GraphQLList } from 'graphql';
import { describe, it, expect } from 'vitest';
import { describeModels } from '../packages/core/src/metadata.js';
import { createQueryPlan } from '../packages/core/src/query-plan.js';
import { describeDatabase } from '../packages/postgres/src/schema/describe.js';
import { compileQuery } from '../packages/postgres/src/query/compiler.js';
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
