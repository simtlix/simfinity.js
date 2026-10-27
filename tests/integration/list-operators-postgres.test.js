// The list operators CONTAINS_ALL and IIN on PostgreSQL (#108, part 4): their statements in every place and surface,
// as substitutions of the EQ and IEQ statements of the same path, the two-valued forms under negation, the scoped
// joins inside frames, the hand-built plans that fail closed with core's codes before any join, the hand-built implicit
// groups and anchors that core rejects before any plan, the bound element types on the server, the index plans, and the
// rows of hand-built implicit groups that cross a collection before their end.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { graphql } from 'graphql';
import pg from 'pg';
import { describeModels } from '../../packages/core/src/metadata.js';
import { createQueryPlan } from '../../packages/core/src/query-plan.js';
import { encodeParameter } from '../../packages/postgres/src/codecs.js';
import { caseFoldExpression as fold, createPostgres } from '../../packages/postgres/src/index.js';
import { compileChildrenQuery, compileQuery } from '../../packages/postgres/src/query/compiler.js';
import { describeDatabase } from '../../packages/postgres/src/schema/describe.js';
import {
  createListOperatorTypes, LIST_OPERATOR_CASES, LIST_OPERATOR_DATES, listOperatorArgs, registerListOperatorTypes, seedListOperators,
} from '../helpers/list-operators.js';
import { listOperation } from '../helpers/query-text-operators.js';

const uri = process.env.SIMFINITY_POSTGRES_URI;
const { d1, d2 } = LIST_OPERATOR_DATES;
const ICU = '"pg_catalog"."und-x-icu"';
const UUID = '00000000-0000-4000-8000-0000000000aa';
const code = (error) => error?.extensions?.code;
const caught = (run) => { try { run(); } catch (error) { return error; } return null; };
const failure = (error) => (error ? { code: code(error), status: error.extensions?.status, message: error.message } : null);
const nodes = (plan) => [plan, ...(plan.Plans || []).flatMap(nodes)];
// `[, value]`, written without a sparse literal: a hole at index 0, then the value.
const holeThen = (value) => Object.assign(new Array(2), { 1: value });
// The comparison IIN puts where IEQ puts `= <fold($n::text)>`: the bound values, folded by the server.
const members = (number) => `ANY (ARRAY(SELECT ${fold('w.value')} FROM unnest($${number}::text[]) w(value)))`;

const compiled = () => {
  const types = createListOperatorTypes(null, { backend: 'postgres' });
  const registrations = [types.Shop, types.Label, types.Item, types.Review, types.Note].map((gqltype) => ({ gqltype }))
    .concat(types.embedded.map((gqltype) => ({ gqltype, endpoint: false })));
  const models = describeModels(registrations);
  const database = describeDatabase(registrations, { schema: 'app' });
  const page = { page: 1, size: 10 };
  const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
  // One statement per surface: a find with its page, a count, an aggregate and the batched children statement of the
  // collection field Shop.items.
  const surfaces = {
    field: (args) => compileQuery(models, database, createQueryPlan(models, 'QlItem', { ...args, pagination: page })),
    count: (args) => compileQuery(models, database, createQueryPlan(models, 'QlItem', args, { mode: 'count' })),
    aggregate: (args) => compileQuery(models, database, createQueryPlan(models, 'QlItem', { ...args, aggregation: { groupId: 'name', facts: [{ path: 'id', operation: 'COUNT', factName: 'n' }] } }, { mode: 'aggregate' })),
    children: (args) => compileChildrenQuery(models, database, createQueryPlan(models, 'QlItem', { ...args, pagination: page }), { column: 'shop', ids }),
  };
  // A field filter, a group condition, and an OR branch beside a condition that matches nothing.
  const shape = (path, operator, value, form) => {
    const [head, ...rest] = path.split('.');
    if (form === 'condition') return { AND: [{ conditions: [{ field: path, operator, value }] }] };
    if (form === 'or') return { OR: [{ conditions: [{ field: 'name', operator: 'EQ', value: 'zzz' }] }, { conditions: [{ field: path, operator, value }] }] };
    return rest.length ? { [head]: { terms: [{ path: rest.join('.'), operator, value }] } } : { [head]: { operator, value } };
  };
  // The WHERE of the count statement, and its values.
  const where = (args) => {
    const { text, values } = surfaces.count(args);
    return { sql: text.slice(text.indexOf(' WHERE ') + 7), values };
  };
  return { models, database, surfaces, shape, where };
};

// Hand-built plan nodes, as createQueryPlan writes them.
const pred = (path, operator, value, extra = {}) => ({ kind: 'predicate', path: path.split('.'), operator, value, ...extra });
const frame = (path, body, extra = {}) => ({ kind: 'quantified', quantifier: 'ANY', path: path.split('.'), where: body, scope: null, ...extra });

// Every path whose last field is a String or a String list: root columns, a validated scalar list, a list, jsonb
// values and lists, nested jsonb lists, owned rows and the references inside them, references and a collection.
const IIN_PLACES = [
  'name', 'emails', 'tags', 'dims.label', 'dims.codes', 'lines.sku', 'lines.notes', 'lines.subs.code', 'lines.subs.notes', 'parts.sku',
  'parts.codes', 'parts.subs.code', 'parts.shop.name', 'parts.shop.tags', 'box.label', 'box.tags', 'box.shop.name', 'shop.name', 'shop.tags',
  'shop.slines.sku', 'reviews.author', 'reviews.tags',
];
// Every list leaf CONTAINS_ALL accepts, with a value EQ accepts there: root lists of each scalar, lists in a jsonb
// object and an owned object, scalars and lists through jsonb and owned lists, nested lists, and lists after a single
// reference, jsonb ones included.
const CONTAINS_ALL_PLACES = {
  tags: 'v', emails: 'v@x.io', ids: UUID, ranks: 1, scores: 1.5, flags: true, kinds: 'ONE', ats: d1, 'dims.codes': 'v', 'box.tags': 'v',
  'lines.sku': 'v', 'lines.notes': 'v', 'lines.qty': 1, 'lines.at': d1, 'lines.id': UUID, 'lines.subs.code': 'v', 'lines.subs.notes': 'v',
  'parts.sku': 'v', 'parts.at': d1, 'parts.codes': 'v', 'parts.subs.code': 'v', 'shop.tags': 'v', 'shop.slines.sku': 'v', 'box.shop.tags': 'v',
};

describe('PostgreSQL list operator statements', () => {
  const { models, database, surfaces, shape, where } = compiled();

  it.each(IIN_PLACES)('compiles IIN on %s as the IEQ statement with the bound values folded by the server, in every surface', (path) => {
    for (const [surface, compile] of Object.entries(surfaces)) {
      for (const form of ['field', 'condition', 'or']) {
        if (form !== 'field' && surface !== 'field') continue;
        const label = `${path} ${surface} ${form}`;
        const ieq = compile(shape(path, 'IEQ', 'v', form));
        const number = Number(ieq.text.match(/ = translate\(lower\(\(\$(\d+)::text\) COLLATE "pg_catalog"\."und-x-icu"\)/)[1]);
        const fragment = ` = ${fold(`$${number}::text`)}`;
        // The batched children statement repeats the per-parent statement once per parent.
        const copies = surface === 'children' ? 2 : 1;
        expect(ieq.text.split(fragment), label).toHaveLength(copies + 1);
        const statement = compile(shape(path, 'IIN', ['v'], form));
        expect(statement.text, label).toBe(ieq.text.split(fragment).join(` = ${members(number)}`));
        expect(statement.values, label).toEqual(ieq.values.map((item, index) => (index === number - 1 ? ['v'] : item)));
        // Both sides of the comparison fold.
        expect(statement.text.split(ICU).length - 1, label).toBe(2 * copies);
      }
    }
  });

  it.each(Object.entries(CONTAINS_ALL_PLACES))('compiles CONTAINS_ALL on %s as the EQ statement with set containment of one bound array, in every surface', (path, value) => {
    for (const [surface, compile] of Object.entries(surfaces)) {
      for (const form of ['field', 'condition', 'or']) {
        if (form !== 'field' && surface !== 'field') continue;
        const label = `${path} ${surface} ${form}`;
        const eq = compile(shape(path, 'EQ', value, form));
        const [fragment, sql, number, type] = eq.text.match(/array_position\((.+?), \$(\d+)::([a-z ]+)\) IS NOT NULL/);
        expect(eq.text.split(fragment), label).toHaveLength(surface === 'children' ? 3 : 2);
        const statement = compile(shape(path, 'CONTAINS_ALL', [value], form));
        expect(statement.text, label).toBe(eq.text.split(fragment).join(`${sql} @> $${number}::${type}[]`));
        // The element is cast as EQ casts it, and bound as one array of the path's element type.
        expect(statement.values, label).toEqual(eq.values.map((item, index) => (index === Number(number) - 1 ? [item] : item)));
        expect(statement.text, label).not.toContain(ICU);
      }
    }
  });

  it('pins the CONTAINS_ALL statements with their bound values', () => {
    expect(where({ tags: { operator: 'CONTAINS_ALL', value: ['A', 'B'] } })).toEqual({ sql: '((t0."tags") COLLATE "pg_catalog"."C" @> $1::text[])', values: [['A', 'B']] });
    expect(where({ ids: { operator: 'CONTAINS_ALL', value: [UUID.toUpperCase()] } })).toEqual({ sql: '(t0."ids" @> $1::uuid[])', values: [[UUID]] });
    const ats = where({ ats: { operator: 'CONTAINS_ALL', value: [d1] } });
    expect(ats).toEqual({ sql: '(t0."ats" @> $1::timestamp with time zone[])', values: [[new Date(d1)]] });
    expect(encodeParameter(ats.values[0])).toEqual(['2024-01-01T00:00:00.000+00:00']);
    // Enum names are cast to the stored values, as IN casts them.
    expect(where({ kinds: { operator: 'CONTAINS_ALL', value: ['ONE', 'TWO'] } })).toEqual({ sql: '((t0."kinds") COLLATE "pg_catalog"."C" @> $1::text[])', values: [['one_v', 'two_v']] });
    expect(where({ dims: { terms: [{ path: 'codes', operator: 'CONTAINS_ALL', value: ['A'] }] } })).toEqual({
      sql: '((CASE WHEN (t0."dims" -> \'codes\') IS NULL OR (t0."dims" -> \'codes\') = \'null\'::jsonb THEN NULL ELSE ARRAY(SELECT (value #>> \'{}\')::text FROM jsonb_array_elements(CASE WHEN jsonb_typeof((t0."dims" -> \'codes\')) = \'array\' THEN (t0."dims" -> \'codes\') ELSE \'[]\'::jsonb END) j(value)) END) COLLATE "pg_catalog"."C" @> $1::text[])',
      values: [['A']],
    });
    expect(where({ lines: { terms: [{ path: 'sku', operator: 'CONTAINS_ALL', value: ['A', 'B'] }] } })).toEqual({
      sql: '((ARRAY(SELECT (t1.value ->> \'sku\')::text FROM jsonb_array_elements(CASE WHEN jsonb_typeof(t0."lines") = \'array\' THEN t0."lines" ELSE \'[{}]\'::jsonb END) t1(value) WHERE jsonb_typeof(t1.value) = \'object\')) COLLATE "pg_catalog"."C" @> $1::text[])',
      values: [['A', 'B']],
    });
    expect(surfaces.count({ box: { terms: [{ path: 'tags', operator: 'CONTAINS_ALL', value: ['p'] }] } })).toEqual({
      text: 'SELECT count(*) AS size FROM "app"."QlItem" t0 LEFT JOIN "app"."QlItem__box" t1 ON t1."__owner_id" = t0."id" AND t0."__box_state" = \'present\' WHERE ((t1."tags") COLLATE "pg_catalog"."C" @> $1::text[])',
      values: [['p']],
    });
    // An owned DateTime list binds timestamps, which encodeParameter sends as UTC ISO strings; the jsonb one binds
    // epoch milliseconds, as its path reads them.
    const owned = database.tables.find((table) => table.name === 'QlItem__parts');
    const storedRow = owned.columns.map((column) => `t2."${column.name}"`).join(', ');
    const nullRow = owned.columns.map((column) => `NULL::${column.type} AS "${column.name}"`).join(', ');
    const presence = owned.ownership.nullableItems ? ' AND t2."__item_present"' : '';
    const parts = where({ parts: { terms: [{ path: 'at', operator: 'CONTAINS_ALL', value: [d1, d2] }] } });
    expect(parts).toEqual({
      sql: `(ARRAY(SELECT t1."at" FROM LATERAL (SELECT ${storedRow} FROM "app"."QlItem__parts" t2 WHERE t2."__owner_id" = t0."id" AND t0."__parts_state" = 'present'${presence} UNION ALL SELECT ${nullRow} WHERE t0."__parts_state" IS DISTINCT FROM 'present') t1 WHERE TRUE) @> $1::timestamp with time zone[])`,
      values: [[new Date(d1), new Date(d2)]],
    });
    expect(nullRow).toContain('NULL::timestamp with time zone AS "at"');
    expect(encodeParameter(parts.values[0])).toEqual(['2024-01-01T00:00:00.000+00:00', '2024-06-01T12:30:00.000+00:00']);
    const lines = where({ lines: { terms: [{ path: 'at', operator: 'CONTAINS_ALL', value: [d1, d2] }] } });
    expect(lines.sql).toMatch(/^\(ARRAY\(SELECT .+\) @> \$1::double precision\[\]\)$/);
    expect(lines.values).toEqual([[Date.parse(d1), Date.parse(d2)]]);
    // A value is never statement text, and a duplicate is kept.
    const injected = where({ tags: { operator: 'CONTAINS_ALL', value: ['\'); DROP TABLE x; --', 'a', 'a'] } });
    expect(injected.sql).not.toContain('DROP');
    expect(injected.values).toEqual([['\'); DROP TABLE x; --', 'a', 'a']]);
  });

  it('pins the IIN statements with their bound values', () => {
    expect(where({ name: { operator: 'IIN', value: ['ana', 'B'] } })).toEqual({ sql: `(${fold('t0."name"')} = ${members(1)})`, values: [['ana', 'B']] });
    expect(where({ tags: { operator: 'IIN', value: ['b'] } })).toEqual({
      sql: `(EXISTS (SELECT 1 FROM unnest((t0."tags") COLLATE "pg_catalog"."C") v(value) WHERE ${fold('v.value')} = ${members(1)}))`, values: [['b']],
    });
    expect(where({ dims: { terms: [{ path: 'label', operator: 'IIN', value: ['l'] }] } }).sql).toBe(`(${fold('(t0."dims" ->> \'label\')::text')} = ${members(1)})`);
    // The empty list matches nothing, with no fold and no value, as IN [] does.
    expect(where({ name: { operator: 'IIN', value: [] } })).toEqual({ sql: '(FALSE)', values: [] });
    expect(where({ tags: { operator: 'IIN', value: [] } })).toEqual({ sql: '(FALSE)', values: [] });
    // Values stay literal: metacharacters, duplicates and the folded forms are bound as they are, never folded here.
    const value = ['\'); DROP TABLE x; -- $1 %_\\', 'ΣΑ', 'ΣΑ', 'ſun'];
    const literal = where({ name: { operator: 'IIN', value } });
    expect(literal.sql).not.toContain('DROP');
    expect(literal.values).toEqual([value]);
  });

  it('keeps CONTAINS_ALL and the scalar IIN two-valued under ALL, with COALESCE only there', () => {
    const quantified = (quantifier, path, field, operator, value) => surfaces.count({ AND: [{ [quantifier]: [{ path, conditions: [{ field, operator, value }] }] }] });
    const contains = '(t1."tags") COLLATE "pg_catalog"."C" @> $1::text[]';
    expect(quantified('ALL', 'reviews', 'tags', 'CONTAINS_ALL', ['x']).text).toContain(`NOT EXISTS (SELECT 1 FROM "app"."QlReview" t1 WHERE t1."item" = t0."id" AND NOT (COALESCE(${contains}, FALSE)))`);
    expect(quantified('ALL', 'shop', 'tags', 'CONTAINS_ALL', ['a', 'b']).text).toContain(`NOT EXISTS (SELECT 1 FROM "app"."QlShop" t1 WHERE t1."id" = t0."shop" AND NOT (COALESCE(${contains}, FALSE)))`);
    // The quantified field filter expands into the same explicit group.
    expect(surfaces.count({ reviews: { quantifier: 'ALL', terms: [{ path: 'tags', operator: 'CONTAINS_ALL', value: ['x'] }] } })).toEqual(quantified('ALL', 'reviews', 'tags', 'CONTAINS_ALL', ['x']));
    for (const quantifier of ['ANY', 'NONE']) {
      const { text } = quantified(quantifier, 'reviews', 'tags', 'CONTAINS_ALL', ['x']);
      expect(text, quantifier).toContain(`AND (${contains}))`);
      expect(text, quantifier).not.toContain('COALESCE');
    }
    const compare = `${fold('t1."author"')} = ${members(1)}`;
    expect(quantified('ALL', 'reviews', 'author', 'IIN', ['ana', 'bob']).text).toContain(`AND NOT (COALESCE(${compare}, FALSE)))`);
    expect(quantified('ANY', 'reviews', 'author', 'IIN', ['ana']).text).toContain(`AND (${compare}))`);
    // The list form of IIN is an EXISTS, two-valued already, and IIN [] stays FALSE.
    const list = quantified('ALL', 'reviews', 'tags', 'IIN', ['x']).text;
    expect(list).toContain(`AND NOT (EXISTS (SELECT 1 FROM unnest((t1."tags") COLLATE "pg_catalog"."C") v(value) WHERE ${fold('v.value')} = ${members(1)})))`);
    expect(list).not.toContain('COALESCE');
    expect(quantified('ALL', 'reviews', 'author', 'IIN', []).text).toContain('AND NOT (FALSE))');
    // A body whose reference inside an embedded list multiplies rows is a witness, negated as a whole, whose IIN keeps
    // its COALESCE.
    const witness = quantified('ALL', 'reviews', 'item.parts.shop.name', 'IIN', ['alpha']).text;
    expect(witness).toContain('AND NOT EXISTS (SELECT 1 FROM (SELECT 1) simfinity_witness');
    expect(witness).toMatch(/COALESCE\(translate\(lower\(\(t\d+\."name"\) COLLATE "pg_catalog"\."und-x-icu"\), '[^']+', '[^']+'\) = ANY \(ARRAY\(SELECT /);
  });

  it.each(['ANY', 'ALL'])('compiles both operators through the scoped joins of a %s frame, the reference join plain where its scope is null', (quantifier) => {
    const joins = { item: null, 'item.shop': pred('name', 'NE', 'beta') };
    const item = 'LEFT JOIN "app"."QlItem" t2 ON t2."id" = t1."item"';
    const shop = 'LEFT JOIN LATERAL (SELECT t4.* FROM "app"."QlShop" t4 WHERE t4."id" = t2."shop" AND ((t4."name") COLLATE "pg_catalog"."C" IS DISTINCT FROM $1::text) LIMIT 1) t3 ON TRUE';
    const forms = {
      CONTAINS_ALL: ['item.shop.tags', ['a'], '(t3."tags") COLLATE "pg_catalog"."C" @> $2::text[]'],
      IIN: ['item.shop.name', ['alpha', 'BETA'], `${fold('t3."name"')} = ${members(2)}`],
    };
    for (const [operator, [path, value, form]] of Object.entries(forms)) {
      const { text, values } = compileQuery(models, database, { entity: 'QlItem', mode: 'count', where: frame('reviews', pred(path, operator, value, { joins }), { quantifier }), sort: [] });
      expect(text, operator).toContain(item);
      expect(text, operator).toContain(shop);
      expect(text, operator).toContain(quantifier === 'ALL' ? `AND NOT (COALESCE(${form}, FALSE))` : `AND (${form})`);
      expect(values, operator).toEqual(['beta', value]);
    }
  });
});

describe('PostgreSQL list operators in plans built by hand', () => {
  const { models, database, surfaces } = compiled();
  const plan = (where, entity = 'QlItem') => ({ entity, mode: 'count', where, sort: [] });
  const compile = (where, entity) => failure(caught(() => compileQuery(models, database, plan(where, entity))));
  const nonList = (path) => `CONTAINS_ALL requires a list field, or a field reached through an embedded list; ${path} is not one`;
  const object = 'Filter on object field requires a scalar path';

  // compileQuery checks CONTAINS_ALL's path and leaf with core's codes and messages before path() resolves the path,
  // so a rejected predicate never adds a join, and an object end, a collection or a reference after an embedded list
  // never reaches the legacy joins.
  it.each([
    ['QlItem', 'name', 'INVALID_FILTER_OPERATOR', nonList('name')],
    ['QlItem', 'id', 'INVALID_FILTER_OPERATOR', nonList('id')],
    ['QlItem', 'dims.label', 'INVALID_FILTER_OPERATOR', nonList('dims.label')],
    ['QlItem', 'shop.name', 'INVALID_FILTER_OPERATOR', nonList('shop.name')],
    ['QlNote', 'itemId', 'INVALID_FILTER_OPERATOR', nonList('itemId')],
    ['QlItem', 'dims', 'MISSING_FILTER_PATH', object],
    ['QlItem', 'lines', 'MISSING_FILTER_PATH', object],
    ['QlItem', 'box', 'MISSING_FILTER_PATH', object],
    ['QlItem', 'shop', 'MISSING_FILTER_PATH', object],
    ['QlItem', 'reviews', 'MISSING_FILTER_PATH', object],
    ['QlItem', 'box.shop', 'INVALID_FILTER_PATH', object],
    ['QlItem', 'parts.shop', 'INVALID_FILTER_PATH', object],
    ['QlShop', 'items', 'MISSING_FILTER_PATH', object],
    ['QlItem', 'shop.items', 'INVALID_FILTER_PATH', object],
    ['QlItem', 'reviews.item', 'INVALID_FILTER_PATH', object],
    ['QlItem', 'reviews.tags', 'INVALID_FILTER_PATH', 'The shorthand excludes them; use an explicit group'],
    ['QlItem', 'parts.shop.tags', 'INVALID_FILTER_PATH', 'CONTAINS_ALL cannot cross the reference parts.shop inside an embedded list, which joins one referenced record per row; combine EQ conditions on the path instead'],
  ])('fails CONTAINS_ALL on %s.%s closed with %s', (entity, path, expected, message) => {
    expect(compile(pred(path, 'CONTAINS_ALL', ['a']), entity)).toEqual({ code: expected, status: 400, message });
  });

  it('guard: object ends with a joins member keep core\'s object-end codes', () => {
    for (const [path, expected] of [['dims', 'MISSING_FILTER_PATH'], ['box.shop', 'INVALID_FILTER_PATH']]) {
      for (const joins of [{}, { [path.split('.')[0]]: null }]) {
        expect(compile(pred(path, 'CONTAINS_ALL', ['a'], { joins })), `${path} ${JSON.stringify(joins)}`).toEqual({ code: expected, status: 400, message: object });
      }
    }
  });

  it('rejects invalid CONTAINS_ALL values with core\'s messages', () => {
    for (const [value, message] of [
      [undefined, 'Expected a scalar filter value'], [null, 'Expected a scalar filter value'], [[null], 'Filter lists require non-null scalar elements'],
      [[{}], 'Filter lists require non-null scalar elements'], [[['a']], 'Filter lists require non-null scalar elements'],
      [holeThen('a'), 'Filter lists require non-null scalar elements'], [new Array(1), 'Filter lists require non-null scalar elements'], [[], 'CONTAINS_ALL requires a non-empty list'], ['x', 'CONTAINS_ALL requires an array value'],
    ]) {
      expect(compile(pred('tags', 'CONTAINS_ALL', value)), JSON.stringify(value)).toEqual({ code: 'INVALID_FILTER_VALUE', status: 400, message });
    }
  });

  it('rejects IIN on a field that is not a String, a record identity declared String included, with the message of predicate(), which names no path', () => {
    const message = 'IIN requires a String field';
    for (const [entity, path] of [['QlItem', 'kinds'], ['QlItem', 'id'], ['QlItem', 'ranks'], ['QlItem', 'shop.id'], ['QlNote', 'itemId'], ['QlLabel', 'id'], ['QlItem', 'label.id']]) {
      for (const value of [['a'], []]) {
        expect(compile(pred(path, 'IIN', value), entity), `${entity}.${path} ${JSON.stringify(value)}`).toEqual({ code: 'INVALID_FILTER_VALUE', status: 400, message });
      }
    }
    // Core accepts a record identity declared String, as it does for IEQ; the compiler reads the uuid identity as ID.
    const planned = (entity, args) => failure(caught(() => compileQuery(models, database, createQueryPlan(models, entity, args, { mode: 'count' }))));
    for (const value of [['abc'], []]) {
      expect(planned('QlLabel', { id: { operator: 'IIN', value } }), JSON.stringify(value)).toEqual({ code: 'INVALID_FILTER_VALUE', status: 400, message });
      expect(planned('QlItem', { label: { terms: [{ path: 'id', operator: 'IIN', value }] } }), JSON.stringify(value)).toEqual({ code: 'INVALID_FILTER_VALUE', status: 400, message });
      expect(planned('QlItem', { AND: [{ ANY: [{ path: 'label', conditions: [{ field: 'id', operator: 'IIN', value }] }] }] }), JSON.stringify(value)).toEqual({ code: 'INVALID_FILTER_VALUE', status: 400, message });
    }
  });

  it('pin: IEQ on a record identity declared String fails in the compiler with IEQ requires a String field', () => {
    const message = 'IEQ requires a String field';
    for (const [entity, path] of [['QlLabel', 'id'], ['QlItem', 'label.id']]) {
      expect(compile(pred(path, 'IEQ', 'abc'), entity), `${entity}.${path}`).toEqual({ code: 'INVALID_FILTER_VALUE', status: 400, message });
    }
    const planned = (entity, args) => failure(caught(() => compileQuery(models, database, createQueryPlan(models, entity, args, { mode: 'count' }))));
    expect(planned('QlLabel', { id: { operator: 'IEQ', value: 'abc' } })).toEqual({ code: 'INVALID_FILTER_VALUE', status: 400, message });
    expect(planned('QlItem', { label: { terms: [{ path: 'id', operator: 'IEQ', value: 'abc' }] } })).toEqual({ code: 'INVALID_FILTER_VALUE', status: 400, message });
    expect(planned('QlItem', { AND: [{ ANY: [{ path: 'label', conditions: [{ field: 'id', operator: 'IEQ', value: 'abc' }] }] }] })).toEqual({ code: 'INVALID_FILTER_VALUE', status: 400, message });
  });

  it('rejects invalid IIN values', () => {
    for (const [value, message] of [
      [null, 'IIN requires an array value'], ['a', 'IIN requires an array value'], [[null], 'IIN requires non-null string elements'], [[5], 'IIN requires non-null string elements'],
      [holeThen('a'), 'IIN requires non-null string elements'], [['a\u0000'], 'IIN values cannot contain U+0000'],
    ]) {
      expect(compile(pred('name', 'IIN', value)), JSON.stringify(value)).toEqual({ code: 'INVALID_FILTER_VALUE', status: 400, message });
    }
  });

  it('keeps malformed joins of a CONTAINS_ALL or IIN predicate fail-closed, after its path, leaf and value checks', () => {
    for (const joins of [[], null, 'shop']) {
      for (const [operator, value] of [['CONTAINS_ALL', ['x']], ['IIN', ['x']]]) {
        const error = compile(pred('lines.sku', operator, value, { joins }));
        expect(error, `${operator} ${JSON.stringify(joins)}`).toMatchObject({ code: 'DETACHED_CLIENT_FILTER', status: 500 });
        expect(error.message).toContain('only createQueryPlan writes the scopes of a predicate');
      }
    }
    // A value error still comes first.
    expect(compile(pred('lines.sku', 'CONTAINS_ALL', [], { joins: [] }))).toEqual({ code: 'INVALID_FILTER_VALUE', status: 400, message: 'CONTAINS_ALL requires a non-empty list' });
  });

  it('checks CONTAINS_ALL on the path relative to a frame, on the frame\'s entity, before any statement', () => {
    for (const [path, expected, message] of [
      ['author', 'INVALID_FILTER_OPERATOR', nonList('author')],
      ['item.parts.shop.tags', 'INVALID_FILTER_PATH', 'CONTAINS_ALL cannot cross the reference item.parts.shop inside an embedded list, which joins one referenced record per row; combine EQ conditions on the path instead'],
      ['item.shop', 'INVALID_FILTER_PATH', object],
    ]) {
      for (const quantifier of ['ANY', 'ALL']) {
        expect(compile(frame('reviews', pred(path, 'CONTAINS_ALL', ['a']), { quantifier })), `${quantifier} ${path}`).toEqual({ code: expected, status: 400, message });
      }
    }
    // The same relative paths compile where they name a list of the frame's entity.
    expect(compileQuery(models, database, plan(frame('reviews', pred('tags', 'CONTAINS_ALL', ['a'])))).values).toEqual([['a']]);
    expect(compileQuery(models, database, plan(frame('reviews', pred('item.tags', 'CONTAINS_ALL', ['a'])))).values).toEqual([['a']]);
  });

  // The cast failures of the parity section, compile-only: each element is cast as IN casts it, with the messages of
  // encodeScalar, which name the leaf field. PostgreSQL reports a malformed UUID as NOT_VALID_ID and rejects a number
  // on a date leaf, where MongoDB reports INVALID_FILTER_VALUE and reads epoch milliseconds: inherited from IN.
  it.each([
    ['ranks', [1.5], 'INVALID_FILTER_VALUE', 'Expected a 32-bit integer for ranks'],
    ['ranks', ['x'], 'INVALID_FILTER_VALUE', 'Expected a 32-bit integer for ranks'],
    ['ats', ['not-a-date'], 'INVALID_FILTER_VALUE', 'Invalid date for ats'],
    ['ats', [1704067200000], 'INVALID_FILTER_VALUE', 'Invalid date for ats'],
    ['lines.at', ['bad'], 'INVALID_FILTER_VALUE', 'Invalid date for at'],
    ['lines.at', [1704067200000], 'INVALID_FILTER_VALUE', 'Invalid date for at'],
    ['kinds', ['FOUR'], 'INVALID_FILTER_VALUE', 'Invalid enum value for kinds'],
    ['tags', [5], 'INVALID_FILTER_VALUE', 'Expected a string for tags'],
    ['lines.qty', ['x'], 'INVALID_FILTER_VALUE', 'Expected a 32-bit integer for qty'],
    ['scores', ['x'], 'INVALID_FILTER_VALUE', 'Expected a finite number for scores'],
    ['flags', [1], 'INVALID_FILTER_VALUE', 'Expected a boolean for flags'],
    ['ids', ['not-an-id'], 'NOT_VALID_ID', 'Expected a UUID identifier'],
    ['lines.id', ['not-an-id'], 'NOT_VALID_ID', 'Expected a UUID identifier'],
  ])('fails to cast CONTAINS_ALL on %s %j with %s', (path, value, expected, message) => {
    const [head, ...rest] = path.split('.');
    const args = rest.length ? { [head]: { terms: [{ path: rest.join('.'), operator: 'CONTAINS_ALL', value }] } } : { [head]: { operator: 'CONTAINS_ALL', value } };
    expect(failure(caught(() => surfaces.count(args)))).toEqual({ code: expected, status: 400, message });
  });
});

// A group that trusted code writes by hand with __implicit, whatever its operators, must end, after any anchor, at a
// collection, or at a reference without crossing a list (spec 1.3 and 2.4, maintainer answer 4 as revised). A
// quantified plan node carries no __implicit flag, so createQueryPlan's validator rejects the group before compileQuery
// builds any join or statement. On 7f12322 createQueryPlan read the bodies over lines, parts and box on the item and
// failed with other codes, and planned the groups over parts.shop and reviews.item, whose statements compiled (the
// first failing with 42P01 when it ran).
describe('PostgreSQL hand-built implicit groups', () => {
  const { models, database, surfaces, where } = compiled();
  const IMPLICIT_END = { code: 'INVALID_FILTER_PATH', status: 400, message: 'An implicit quantified path must end at a collection, or at a reference without crossing a list' };
  const implicitGroup = (quantifier, path, condition) => ({ AND: [{ [quantifier]: [{ __implicit: true, path, conditions: [condition] }] }] });
  const explicitGroup = (quantifier, path, condition) => ({ AND: [{ [quantifier]: [{ path, conditions: [condition] }] }] });
  // Per path, a scalar leaf of the element for EQ, IN and IIN and a list leaf for CONTAINS_ALL, each valid on its own:
  // embedded lists, a single embedded object, a reference after an embedded list and one after a collection.
  const REJECTED = [
    ['lines', 'sku', 'notes'], ['parts', 'sku', 'codes'], ['box', 'label', 'tags'], ['parts.shop', 'name', 'tags'], ['reviews.item', 'name', 'tags'],
  ].flatMap(([path, scalar, list]) => [
    { field: scalar, operator: 'EQ', value: 'a' }, { field: scalar, operator: 'IN', value: ['a'] },
    { field: list, operator: 'CONTAINS_ALL', value: ['a'] }, { field: scalar, operator: 'IIN', value: ['a'] },
  ].map((condition) => [`${path}, with ${condition.field} ${condition.operator}`, path, condition]));
  // The implicit group over shop compiles from the plan of the explicit one, under every quantifier and in every surface.
  const asExplicit = (condition) => {
    for (const quantifier of ['ANY', 'ALL', 'NONE']) {
      for (const [surface, compile] of Object.entries(surfaces)) {
        expect(compile(implicitGroup(quantifier, 'shop', condition)), `${condition.operator} ${quantifier} ${surface}`)
          .toEqual(compile(explicitGroup(quantifier, 'shop', condition)));
      }
    }
  };
  const shopFrame = (comparison) => `(EXISTS (SELECT 1 FROM "app"."QlShop" t1 WHERE t1."id" = t0."shop" AND (${comparison})))`;
  // The group the rewrite writes for parts.shop.items: the shops of the item's parts joined in a witness, then their
  // items as a collection frame.
  const partsShopItems = (comparison) => {
    const owned = database.tables.find((table) => table.name === 'QlItem__parts');
    const storedRow = owned.columns.map((column) => `t2."${column.name}"`).join(', ');
    const nullRow = owned.columns.map((column) => `NULL::${column.type} AS "${column.name}"`).join(', ');
    const presence = owned.ownership.nullableItems ? ' AND t2."__item_present"' : '';
    const shops = `ARRAY(SELECT t1."shop" FROM LATERAL (SELECT ${storedRow} FROM "app"."QlItem__parts" t2 WHERE t2."__owner_id" = t0."id" AND t0."__parts_state" = 'present'${presence} UNION ALL SELECT ${nullRow} WHERE t0."__parts_state" IS DISTINCT FROM 'present') t1 WHERE TRUE)`;
    return `(EXISTS (SELECT 1 FROM (SELECT 1) simfinity_witness LEFT JOIN "app"."QlShop" t3 ON t3."id" = ANY (${shops}) WHERE EXISTS (SELECT 1 FROM "app"."QlItem" t4 WHERE t4."shop" = t3."id" AND (${comparison}))))`;
  };

  describe('compileQuery rejects a hand-built implicit group that does not end at a collection or at a reference without crossing a list, before any join', () => {
    it.each(REJECTED)('over %s', (_name, path, condition) => {
      for (const quantifier of ['ANY', 'ALL', 'NONE']) {
        const args = implicitGroup(quantifier, path, condition);
        // createQueryPlan throws, so no surface reaches compileQuery.
        expect(failure(caught(() => createQueryPlan(models, 'QlItem', args, { mode: 'count' }))), `${quantifier} plan`).toEqual(IMPLICIT_END);
        for (const [surface, compile] of Object.entries(surfaces)) {
          expect(failure(caught(() => compile(args))), `${quantifier} ${surface}`).toEqual(IMPLICIT_END);
        }
      }
    });
  });

  it('guard: a hand-built implicit group over shop compiles to the statement of the explicit ANY group over shop', () => {
    for (const [condition, comparison] of [
      [{ field: 'name', operator: 'EQ', value: 'Alpha' }, '(t1."name") COLLATE "pg_catalog"."C" = $1::text'],
      [{ field: 'name', operator: 'IN', value: ['Alpha'] }, '(t1."name") COLLATE "pg_catalog"."C" = ANY ($1::text[])'],
    ]) {
      asExplicit(condition);
      expect(where(implicitGroup('ANY', 'shop', condition)), condition.operator).toEqual({ sql: shopFrame(comparison), values: [condition.value] });
    }
  });

  it('compiles CONTAINS_ALL and IIN in a hand-built implicit group over shop to the statement of the explicit ANY group over shop', () => {
    for (const [condition, comparison] of [
      [{ field: 'tags', operator: 'CONTAINS_ALL', value: ['a'] }, '(t1."tags") COLLATE "pg_catalog"."C" @> $1::text[]'],
      [{ field: 'name', operator: 'IIN', value: ['alpha'] }, `${fold('t1."name"')} = ${members(1)}`],
    ]) {
      asExplicit(condition);
      expect(where(implicitGroup('ANY', 'shop', condition)), condition.operator).toEqual({ sql: shopFrame(comparison), values: [condition.value] });
    }
  });

  it('guard: the implicit group the rewrite writes for parts.shop.items compiles', () => {
    const args = { parts: { terms: [{ path: 'shop.items.name', operator: 'EQ', value: 'one' }] } };
    expect(createQueryPlan(models, 'QlItem', args, { mode: 'count' }).where).toEqual(frame('parts.shop.items', pred('name', 'EQ', 'one')));
    expect(where(args)).toEqual({ sql: partsShopItems('(t4."name") COLLATE "pg_catalog"."C" = $1::text'), values: ['one'] });
  });

  it('compiles IIN through parts.shop.items as the implicit group the rewrite writes', () => {
    const args = { parts: { terms: [{ path: 'shop.items.name', operator: 'IIN', value: ['ONE'] }] } };
    expect(createQueryPlan(models, 'QlItem', args, { mode: 'count' }).where).toEqual(frame('parts.shop.items', pred('name', 'IIN', ['ONE'])));
    expect(where(args)).toEqual({ sql: partsShopItems(`${fold('t4."name"')} = ${members(1)}`), values: [['ONE']] });
  });

  // A hand-built anchor is valid only in exactly the shape the rewrite (cutAt) writes: (i) in an aggregate, (ii) on a
  // group at the root, (iii) a non-empty array of single path segments, (iv) whose steps cross at least one collection,
  // every one a join prefix of the aggregate, with any embedded lists, embedded objects and references between, (v)
  // followed by exactly one step, a collection (spec 1.3 and 2.4, maintainer answer 6 as revised). createQueryPlan's
  // validator rejects every other anchor before compileQuery builds any join or statement. On 7f12322 the EQ and IN
  // groups below compiled or failed with another error: ['reviews'] with item compiled to a statement that joined the
  // reviews into the root rows, which read an item once per review, the Set with shop to the frame over shop without the
  // anchor, and ['items'] with shop compiled too; the embedded anchors failed in the compiler with INVALID_FILTER_FIELD,
  // the paths of more than one step after the anchor with DETACHED_CLIENT_FILTER, and the dotted element with Invalid
  // filter path.
  describe('hand-built anchors', () => {
    const ANCHOR = { code: 'INVALID_FILTER_PATH', status: 400, message: 'An implicit quantified anchor must name the aggregate\'s join prefixes' };
    const groupedBy = (groupId) => ({ groupId, facts: [{ path: 'id', operation: 'COUNT', factName: 'n' }] });
    // Per entity a group ends at, a String field for EQ, IN and IIN and a list for CONTAINS_ALL, each valid on its own.
    const END_FIELDS = { QlItem: ['name', 'tags'], QlShop: ['name', 'tags'], QlReview: ['author', 'tags'] };
    const SHOP_BY_ITEMS = { entity: 'QlShop', groupId: 'items.name' };
    const ITEM_BY_AUTHOR = { entity: 'QlItem', groupId: 'reviews.author' };
    const ITEM_BY_SHOP_ITEMS = { entity: 'QlItem', groupId: 'parts.shop.items.name' };
    // [name, row]: the queried entity, the aggregation whose join prefixes leave only the named condition failing, the
    // explicit ANY frames around the group, outermost first, a fresh anchor, the path after it and the entity it ends
    // at. Condition (i) cannot fail alone here, since createQueryPlan derives J only in aggregates; core's validator rows
    // pin it.
    const ANCHORS = [
      // (ii) The frame-relative anchor items is a root join prefix, so only the enclosing frames fail.
      ['(ii) [items] reviews inside ANY items, then ANY shop, on QlShop grouped by items.name', {
        ...SHOP_BY_ITEMS, frames: ['items', 'shop'], anchor: () => ['items'], path: 'reviews', end: 'QlReview',
      }],
      // (iii) An empty anchor, a dotted element, the rewrite's own anchor as a Set, and, before the path rule, a Set
      // whose bare path also crosses a list before its reference end.
      ['(iii) [] items on QlShop grouped by items.name', { ...SHOP_BY_ITEMS, anchor: () => [], path: 'items', end: 'QlItem' }],
      ['(iii) [items.parts, shop] items on QlShop grouped by items.name', {
        ...SHOP_BY_ITEMS, anchor: () => ['items.parts', 'shop'], path: 'items', end: 'QlItem',
      }],
      ['(iii) Set [parts, shop, items] reviews on QlItem grouped by parts.shop.items.name', {
        ...ITEM_BY_SHOP_ITEMS, anchor: () => new Set(['parts', 'shop', 'items']), path: 'reviews', end: 'QlReview',
      }],
      ['(iii) before the path rule: Set [parts] parts.shop on QlItem grouped by reviews.author', {
        ...ITEM_BY_AUTHOR, anchor: () => new Set(['parts']), path: 'parts.shop', end: 'QlShop',
      }],
      // (iv) A join prefix, then a collection outside J; an anchor that crosses no collection.
      ['(iv) [items, reviews, item] reviews on QlShop grouped by items.name', {
        ...SHOP_BY_ITEMS, anchor: () => ['items', 'reviews', 'item'], path: 'reviews', end: 'QlReview',
      }],
      ['(iv) [parts, shop] items on QlItem grouped by reviews.author', {
        ...ITEM_BY_AUTHOR, anchor: () => ['parts', 'shop'], path: 'items', end: 'QlItem',
      }],
      // (v) A reference after the anchor, and more than one step after it.
      ['(v) [items] shop on QlShop grouped by items.name', { ...SHOP_BY_ITEMS, anchor: () => ['items'], path: 'shop', end: 'QlShop' }],
      ['(v) [items] shop.items on QlShop grouped by items.name', { ...SHOP_BY_ITEMS, anchor: () => ['items'], path: 'shop.items', end: 'QlItem' }],
      ['(v) [items] reviews.item.reviews on QlShop grouped by items.name', {
        ...SHOP_BY_ITEMS, anchor: () => ['items'], path: 'reviews.item.reviews', end: 'QlReview',
      }],
      ['(v) [items] parts.shop.items on QlShop grouped by items.name', {
        ...SHOP_BY_ITEMS, anchor: () => ['items'], path: 'parts.shop.items', end: 'QlItem',
      }],
      ['(v) [reviews] item on QlItem grouped by reviews.author', { ...ITEM_BY_AUTHOR, anchor: () => ['reviews'], path: 'item', end: 'QlItem' }],
      // The first version's rows: embedded anchors that cross no collection, and a Set.
      ['[parts] shop on QlItem grouped by reviews.author', { ...ITEM_BY_AUTHOR, anchor: () => ['parts'], path: 'shop', end: 'QlShop' }],
      ['[box] shop on QlItem grouped by reviews.author', { ...ITEM_BY_AUTHOR, anchor: () => ['box'], path: 'shop', end: 'QlShop' }],
      ['Set [parts] shop on QlItem grouped by reviews.author', { ...ITEM_BY_AUTHOR, anchor: () => new Set(['parts']), path: 'shop', end: 'QlShop' }],
    ];
    const ROWS = ANCHORS.flatMap(([name, row]) => {
      const [scalar, list] = END_FIELDS[row.end];
      return [
        { field: scalar, operator: 'EQ', value: 'a' }, { field: scalar, operator: 'IN', value: ['a'] },
        { field: scalar, operator: 'IIN', value: ['a'] }, { field: list, operator: 'CONTAINS_ALL', value: ['a'] },
      ].map((condition) => [`${name}, with ${condition.field} ${condition.operator}`, row, condition]);
    });

    describe('compileQuery rejects a hand-built implicit anchor that is not in the shape the rewrite writes, before any statement', () => {
      it.each(ROWS)('%s', (_name, {
        entity, groupId, frames = [], anchor, path,
      }, condition) => {
        for (const quantifier of ['ANY', 'ALL', 'NONE']) {
          // The group inside the row's frames, with a fresh anchor and condition per plan.
          const args = () => ({
            AND: [frames.reduceRight((inner, frame) => ({ ANY: [{ path: frame, ...inner }] }), {
              [quantifier]: [{ __implicit: true, __anchor: anchor(), path, conditions: [{ ...condition }] }],
            })],
          });
          // createQueryPlan throws in every mode, the aggregate grouped by name (J empty) included, so compileQuery
          // never runs.
          for (const [mode, aggregation] of [['find'], ['count'], ['aggregate', groupedBy('name')], ['aggregate', groupedBy(groupId)]]) {
            const plan = () => createQueryPlan(models, entity, aggregation ? { ...args(), aggregation } : args(), { mode });
            expect(failure(caught(() => compileQuery(models, database, plan()))), `${quantifier} ${mode}${aggregation ? ` by ${aggregation.groupId}` : ''}`)
              .toEqual(ANCHOR);
          }
          if (entity !== 'QlItem') continue;
          for (const [surface, compile] of Object.entries(surfaces)) {
            expect(failure(caught(() => compile(args()))), `${quantifier} ${surface}`).toEqual(ANCHOR);
          }
        }
      });
    });

    // cutAt writes as anchor every step before the first collection outside J, embedded lists and references included:
    // grouped by items.name, the shorthand items.parts.shop.items.name on QlShop becomes the group
    // { __anchor: ['items', 'parts', 'shop'], path: 'items' }, and grouped by parts.shop.items.name,
    // parts.shop.items.reviews.author on QlItem becomes { __anchor: ['parts', 'shop', 'items'], path: 'reviews' }.
    it('guard: hand-built copies of the anchors the rewrite writes through an embedded list compile to their shorthands\' statements', () => {
      const aggregate = (entity, groupId, args) => compileQuery(models, database, createQueryPlan(models, entity, { aggregation: groupedBy(groupId), ...args }, { mode: 'aggregate' }));
      for (const [operator, value] of [['EQ', 'one'], ['IN', ['one']]]) {
        const copy = (anchor, path, field) => ({ AND: [{ ANY: [{ __implicit: true, __anchor: anchor, path, conditions: [{ field, operator, value }] }] }] });
        const shorthand = (field) => ({ AND: [{ conditions: [{ field, operator, value }] }] });
        expect(aggregate('QlShop', 'items.name', copy(['items', 'parts', 'shop'], 'items', 'name')), `${operator} on QlShop`)
          .toEqual(aggregate('QlShop', 'items.name', shorthand('items.parts.shop.items.name')));
        expect(aggregate('QlItem', 'parts.shop.items.name', copy(['parts', 'shop', 'items'], 'reviews', 'author')), `${operator} on QlItem`)
          .toEqual(aggregate('QlItem', 'parts.shop.items.name', shorthand('parts.shop.items.reviews.author')));
      }
    });
  });
});

describe.skipIf(!uri)('PostgreSQL list operators', () => {
  const namespace = `ql_${randomUUID().replaceAll('-', '')}`;
  let pool; let api; let schema; let types; let seeded; let models; let database;
  const execute = (source, variableValues, contextValue = {}) => graphql({ schema, source, variableValues, contextValue });
  const keys = async (args) => {
    const { source, variables } = listOperation(types.roots.item.plural, args);
    const result = await execute(source, variables);
    expect(result.errors?.map((error) => error.message), JSON.stringify(args)).toBeUndefined();
    return result.data[types.roots.item.plural].map((row) => row.key);
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: uri });
    api = createPostgres({ pool, schema: namespace });
    types = createListOperatorTypes(null, { backend: 'postgres' });
    registerListOperatorTypes(api, types);
    schema = api.createSchema();
    await api.initializeDatabase();
    seeded = await seedListOperators((source, variables) => execute(source, variables), 'postgres');
    models = describeModels(api.getRegistrations());
    database = api.describeDatabase();
  }, 60000);
  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await pool.end();
    }
  });

  // Each bound array has exactly the element type of its path, or the server would reject the statement (42883):
  // root lists of every scalar, enum names cast to values, jsonb and owned DateTime lists, ids read back from jsonb.
  it.each(LIST_OPERATOR_CASES.filter((item) => item.bullet === 'CONTAINS_ALL rows').map((item) => [item.name, item]))('runs %s on the server, with the element type of its path', async (name, item) => {
    expect(await keys(listOperatorArgs(item.args, seeded))).toEqual(item.rows.admin);
  });

  describe('plans', () => {
    const explain = async (args, setup) => {
      const { text, values } = compileQuery(models, database, createQueryPlan(models, 'QlItem', args));
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const statement of setup) await client.query(statement);
        await client.query('SET LOCAL enable_seqscan = off');
        const { rows } = await client.query(`EXPLAIN (FORMAT JSON) ${text}`, values.map(encodeParameter));
        const result = rows[0]['QUERY PLAN'];
        return (typeof result === 'string' ? JSON.parse(result) : result)[0].Plan;
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    };
    const table = () => `"${namespace}"."QlItem"`;

    it('serves CONTAINS_ALL on a root list from a GIN index of the application, which initialization keeps', async () => {
      await pool.query(`CREATE INDEX ql_tags_gin ON ${table()} USING gin ("tags")`);
      try {
        expect(await api.initializeDatabase({ mode: 'validate' })).toEqual({ mode: 'validate', created: [] });
        const plan = await explain({ tags: { operator: 'CONTAINS_ALL', value: ['A', 'B'] } }, []);
        const scans = nodes(plan).filter((node) => node['Node Type'] === 'Bitmap Index Scan' && node['Index Name'] === 'ql_tags_gin');
        expect(scans, JSON.stringify(plan)).toHaveLength(1);
        expect(scans[0]['Index Cond'], JSON.stringify(plan)).toContain('@>');
        expect(await keys({ tags: { operator: 'CONTAINS_ALL', value: ['A', 'B'] } })).toEqual(['I1', 'I3']);
      } finally {
        await pool.query(`DROP INDEX IF EXISTS "${namespace}"."ql_tags_gin"`);
      }
    });

    it.each([['a plain', ''], ['a text_pattern_ops', ' text_pattern_ops']])('serves IIN on a String column from %s btree on caseFoldExpression, as IEQ', async (label, operatorClass) => {
      const index = `CREATE INDEX ql_name_fold ON ${table()} (${fold('"name"')}${operatorClass})`;
      const plan = await explain({ name: { operator: 'IIN', value: ['ONE', 'two'] } }, [index]);
      const served = nodes(plan).filter((node) => node['Index Name'] === 'ql_name_fold' && node['Index Cond']);
      expect(served, JSON.stringify(plan)).toHaveLength(1);
      // PostgreSQL 17 and later print the InitPlan's parameter differently, so only the comparison is matched.
      expect(served[0]['Index Cond'], JSON.stringify(plan)).toContain('= ANY (');
    });
  });
});

// Hand-built implicit groups on the server: a trusted find scope that writes one over an embedded list fails the read
// before any statement, one over reviews.item.reviews reads each item once, and the group the rewrite writes for
// parts.shop.items reads its rows.
describe.skipIf(!uri)('PostgreSQL hand-built implicit groups on the server', () => {
  // The group that Item's find scope appends when the request context asks for it; on 7f12322 createQueryPlan read its
  // body on the item and failed the read with INVALID_FILTER_FIELD (Unknown field sku).
  const LINES = { ANY: [{ __implicit: true, path: 'lines', conditions: [{ field: 'sku', operator: 'EQ', value: 'A' }] }] };
  const namespace = `qli_${randomUUID().replaceAll('-', '')}`;
  const statements = [];
  let pool; let schema; let types;
  const execute = (source, variableValues, contextValue = {}) => graphql({ schema, source, variableValues, contextValue });
  const read = (args, contextValue) => {
    const { source, variables } = listOperation(types.roots.item.plural, args);
    return execute(source, variables, contextValue);
  };
  const keys = async (args) => {
    const result = await read(args);
    expect(result.errors?.map((error) => error.message), JSON.stringify(args)).toBeUndefined();
    return result.data[types.roots.item.plural].map((row) => row.key);
  };
  // The keys in order and pagination.count of a list query whose find scope appends `group`.
  const scoped = async (group) => {
    const context = { group };
    const { source, variables } = listOperation(types.roots.item.plural, {}, 'key', 'sort:{terms:[{field:"key",order:ASC}]},pagination:{page:1,size:100,count:true}');
    const result = await execute(source, variables, context);
    expect(result.errors?.map((error) => error.message), JSON.stringify(group)).toBeUndefined();
    return { keys: result.data[types.roots.item.plural].map((row) => row.key), count: context.count };
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: uri });
    // A pool that records the text of every statement it runs.
    const recorded = {
      query: (text, values) => { statements.push(text); return pool.query(text, values); },
      connect: async () => {
        const client = await pool.connect();
        return { query: (text, values) => { statements.push(text); return client.query(text, values); }, release: (...args) => client.release(...args) };
      },
    };
    const api = createPostgres({ pool: recorded, schema: namespace });
    types = createListOperatorTypes(null, {
      backend: 'postgres',
      scopes: {
        item: {
          find: ({ args, context }) => {
            const groups = [...(context?.implicitLines ? [LINES] : []), ...(context?.group ? [context.group] : [])];
            if (groups.length) args.AND = [...(Array.isArray(args.AND) ? args.AND : []), ...structuredClone(groups)];
          },
        },
      },
    });
    registerListOperatorTypes(api, types);
    schema = api.createSchema();
    await api.initializeDatabase();
    await seedListOperators((source, variables) => execute(source, variables), 'postgres');
  }, 60000);
  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await pool.end();
    }
  });

  it('a find scope that writes a hand-built implicit group over an embedded list fails the read with INVALID_FILTER_PATH and no rows', async () => {
    // Without the group, the same read runs its statement and returns every item.
    statements.length = 0;
    expect(await keys({})).toEqual(['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7', 'I8']);
    expect(statements.filter((text) => text.includes(`FROM "${namespace}"."QlItem" t0`))).toHaveLength(1);
    statements.length = 0;
    const result = await read({}, { implicitLines: true });
    expect(result.errors?.map((error) => ({ code: code(error), status: error.extensions?.status, message: error.message }))).toEqual([{
      code: 'INVALID_FILTER_PATH', status: 400, message: 'An implicit quantified path must end at a collection, or at a reference without crossing a list',
    }]);
    expect(result.data?.[types.roots.item.plural] ?? null).toBeNull();
    expect(statements).toEqual([]);
  });

  it('guard: the implicit group the rewrite writes for parts.shop.items reads the items with a part at the shop of the item named one', async () => {
    expect(await keys({ parts: { terms: [{ path: 'shop.items.name', operator: 'EQ', value: 'one' }] } })).toEqual(['I1', 'I3', 'I6']);
  });

  it('reads IIN through parts.shop.items as the implicit group the rewrite writes', async () => {
    expect(await keys({ parts: { terms: [{ path: 'shop.items.name', operator: 'IIN', value: ['ONE'] }] } })).toEqual(['I1', 'I3', 'I6']);
  });

  // Each review's item is the item itself, so the group holds for an item with a review whose author or tags match.
  // PostgreSQL isolates the crossed reviews in the prefix witness and read each item once on 7f12322 too, where MongoDB
  // read I1 once per review (spec 9.5, maintainer answer 5).
  const reviewsItemReviews = (condition) => ({ ANY: [{ __implicit: true, path: 'reviews.item.reviews', conditions: [condition] }] });

  it('guard: a hand-built implicit group over reviews.item.reviews with EQ reads each item once', async () => {
    expect(await scoped(reviewsItemReviews({ field: 'author', operator: 'EQ', value: 'Ana' }))).toEqual({ keys: ['I1'], count: 1 });
  });

  it('reads a hand-built implicit group over reviews.item.reviews with IIN and CONTAINS_ALL once per item', async () => {
    expect(await scoped(reviewsItemReviews({ field: 'author', operator: 'IIN', value: ['ana', 'BOB'] })), 'IIN').toEqual({ keys: ['I1', 'I2'], count: 2 });
    expect(await scoped(reviewsItemReviews({ field: 'tags', operator: 'CONTAINS_ALL', value: ['x'] })), 'CONTAINS_ALL').toEqual({ keys: ['I1', 'I2', 'I6'], count: 3 });
  });
});

// A collection that a hand-built implicit group crosses before its end, on a seed of its own: S1 has C1, with reviews by
// Ana and by Bob, and C2, with none; S2 has C3 and C4, each with one review by Ana; S3 has C5, with none; S4 has no item.
// Ana's reviews are tagged x and y, Bob's y only. A Shop find scope appends the group that the request context names
// (spec 9.5, maintainer answer 5). PostgreSQL isolates the crossed items in the prefix witness and gave these rows on
// 7f12322 too; MongoDB gives the same rows now that its compileFrame isolates them alike.
describe.skipIf(!uri)('PostgreSQL: a collection crossed before the end on the server', () => {
  // The rows of the implicit group and of the explicit nested groups, on both backends.
  const EXPECTED = {
    ANY: { keys: ['S1', 'S2'], count: 2 }, ALL: { keys: ['S2', 'S3', 'S4'], count: 3 }, NONE: { keys: ['S3', 'S4'], count: 2 },
  };
  const implicitGroup = (quantifier, condition) => ({ [quantifier]: [{ __implicit: true, path: 'items.reviews', conditions: [condition] }] });
  // ANY items then ANY reviews, ALL then ALL, and NONE then ANY.
  const explicitGroups = (quantifier, condition) => ({
    [quantifier]: [{ path: 'items', [quantifier === 'NONE' ? 'ANY' : quantifier]: [{ path: 'reviews', conditions: [condition] }] }],
  });
  const namespace = `qlx_${randomUUID().replaceAll('-', '')}`;
  let pool; let schema; let types;
  const execute = (source, variableValues, contextValue = {}) => graphql({ schema, source, variableValues, contextValue });
  // The keys in order and pagination.count of the shop list query whose find scope appends `group`.
  const scoped = async (group) => {
    const context = { group };
    const shops = types.roots.shop.plural;
    const { source, variables } = listOperation(shops, {}, 'key', 'sort:{terms:[{field:"key",order:ASC}]},pagination:{page:1,size:100,count:true}');
    const result = await execute(source, variables, context);
    expect(result.errors?.map((error) => error.message), JSON.stringify(group)).toBeUndefined();
    return { keys: result.data[shops].map((row) => row.key), count: context.count };
  };
  const both = async (quantifier, condition) => ({
    implicit: await scoped(implicitGroup(quantifier, condition)), explicit: await scoped(explicitGroups(quantifier, condition)),
  });

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: uri });
    const api = createPostgres({ pool, schema: namespace });
    types = createListOperatorTypes(null, {
      backend: 'postgres',
      scopes: {
        shop: {
          find: ({ args, context }) => {
            if (context?.group) args.AND = [...(Array.isArray(args.AND) ? args.AND : []), structuredClone(context.group)];
          },
        },
      },
    });
    registerListOperatorTypes(api, types);
    schema = api.createSchema();
    await api.initializeDatabase();
    // Generated mutations only, references by id.
    const ids = {};
    const add = async (typeKey, input) => {
      const { type, single } = types.roots[typeKey];
      const result = await execute(`mutation($input:${type.name}Input!){add${single}(input:$input){id}}`, { input });
      if (result.errors) throw new Error(`add${single} ${JSON.stringify(input)}: ${JSON.stringify(result.errors)}`);
      ids[input.key] = result.data[`add${single}`].id;
    };
    for (const key of ['S1', 'S2', 'S3', 'S4']) await add('shop', { key });
    for (const [key, shop] of [['C1', 'S1'], ['C2', 'S1'], ['C3', 'S2'], ['C4', 'S2'], ['C5', 'S3']]) await add('item', { key, shop: { id: ids[shop] } });
    for (const [key, item, author, tags] of [['W1', 'C1', 'Ana', ['x', 'y']], ['W2', 'C1', 'Bob', ['y']], ['W3', 'C3', 'Ana', ['x', 'y']], ['W4', 'C4', 'Ana', ['x', 'y']]]) {
      await add('review', {
        key, author, tags, item: { id: ids[item] },
      });
    }
  }, 60000);
  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await pool.end();
    }
  });

  it('guard: a hand-built implicit group over items.reviews with EQ reads the rows of the explicit nested groups', async () => {
    for (const quantifier of ['ANY', 'ALL', 'NONE']) {
      const expected = EXPECTED[quantifier];
      expect(await both(quantifier, { field: 'author', operator: 'EQ', value: 'Ana' }), quantifier).toEqual({ implicit: expected, explicit: expected });
    }
  });

  it('reads a hand-built implicit group over items.reviews with IIN and CONTAINS_ALL as the explicit nested groups do', async () => {
    for (const condition of [{ field: 'author', operator: 'IIN', value: ['ana'] }, { field: 'tags', operator: 'CONTAINS_ALL', value: ['x', 'y'] }]) {
      for (const quantifier of ['ANY', 'ALL', 'NONE']) {
        const expected = EXPECTED[quantifier];
        expect(await both(quantifier, condition), `${quantifier} ${condition.operator}`).toEqual({ implicit: expected, explicit: expected });
      }
    }
  });
});
