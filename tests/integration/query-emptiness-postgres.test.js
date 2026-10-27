// The emptiness operators IS_EMPTY and IS_NOT_EMPTY on PostgreSQL (#108, part 2a): their statements for every kind of
// storage (root columns and the root identity, jsonb values, owned single objects and owned lists, owned rows with
// native-array and jsonb members, owned storage inside owned storage), on every surface; the checks of plans built by
// hand; the plugin's declaration and the rejection by a plugin without it; and, on a database, the rows of generated
// and native writes, counts, aggregates, batched collection reads, the plan of the String form and the codes of
// object-ending filter paths.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GraphQLID, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';
import pg from 'pg';
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
  EMPTINESS_CASES, createEmptinessTypes, emptinessArgs, emptinessQuery, emptinessSampleId, expectedEmptinessKeys,
  registerEmptinessTypes, seedEmptiness, writePostgresEmptiness,
} from '../helpers/query-emptiness.js';

const uri = process.env.SIMFINITY_POSTGRES_URI;
const OPERATORS = ['IS_EMPTY', 'IS_NOT_EMPTY'];
const LEGACY = ['EQ', 'NE', 'LT', 'LTE', 'GT', 'GTE', 'BTW', 'IN', 'NIN', 'LIKE'];
const code = (error) => error?.extensions?.code;
const caught = (run) => { try { run(); } catch (error) { return error; } return undefined; };
const failure = (error) => ({ code: code(error), message: error?.message });
const nodes = (plan) => [plan, ...(plan.Plans || []).flatMap(nodes)];
const embedded = { relation: { embedded: true } };
const lowerFirst = (value) => value.charAt(0).toLowerCase() + value.slice(1);
// The root of the owned cases whose statements are pinned; every owned root has the same members.
const OWNED = 'owned:owned create omitted';

const registrationsOf = (types, roots = []) => [types.Item, types.Shop, types.Review, types.Sid, ...Object.values(types.owned), ...roots]
  .map((gqltype) => ({ gqltype, ...(gqltype === types.Item ? { stateMachine: types.stateMachine } : {}) }))
  .concat(types.embedded.map((gqltype) => ({ gqltype, endpoint: false })));
const compiled = () => {
  const types = createEmptinessTypes('Qp');
  const registrations = registrationsOf(types);
  const models = describeModels(registrations);
  const database = describeDatabase(registrations, { schema: 'app' });
  const operators = postgresPlugin().queryFeatures.operators;
  const owned = types.roots[OWNED].type.name;
  const entity = (rootKey) => types.roots[rootKey].type.name;
  const plan = (rootKey, args, mode = 'find') => createQueryPlan(models, entity(rootKey), args, { mode, operators });
  const find = (rootKey, args) => compileQuery(models, database, plan(rootKey, args));
  // The WHERE clause of the count statement of one emptiness condition, written as a field filter or a term.
  const where = (rootKey, path, operator, form = 'field') => {
    const { text, values } = compileQuery(models, database, plan(rootKey, emptinessArgs(types, rootKey, path, operator, form), 'count'));
    expect(values, `${path} ${operator}`).toEqual([]);
    return text.slice(text.indexOf(' WHERE ') + 7);
  };
  return { types, models, database, operators, owned, plan, find, where };
};

// The IS_EMPTY and IS_NOT_EMPTY forms of #108 part 2a, spelled out apart from the compiler.
const string = (c) => [`(${c} IS NULL OR ${c} = '')`, `(${c} IS NOT NULL AND ${c} <> '')`];
const nullable = (c) => [`${c} IS NULL`, `${c} IS NOT NULL`];
const array = (c) => [`COALESCE(cardinality(${c}), 0) = 0`, `COALESCE(cardinality(${c}), 0) > 0`];
const jsonList = (j) => ['=', '>'].map((compare) => `COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof(${j}) = 'array' THEN ${j} END), 0) ${compare} 0`);
const object = (empty) => [empty, `NOT ${empty}`];
const members = (forms) => (forms.length ? `(${forms.join(' AND ')})` : 'TRUE');
const jsonObject = (j, forms) => object(`(${j} IS NULL OR ${j} = 'null'::jsonb OR ${members(forms)})`);
const ownedList = (state, table, alias, key) => object(`(${state} IS DISTINCT FROM 'present' OR NOT EXISTS (SELECT 1 FROM "app"."${table}" ${alias} WHERE ${alias}."__owner_id" = ${key}))`);
const ownedObject = (state, table, alias, key, forms) => object(`(${state} IS DISTINCT FROM 'present' OR NOT EXISTS (SELECT 1 FROM "app"."${table}" ${alias} WHERE ${alias}."__owner_id" = ${key} AND NOT ${members(forms)}))`);
const E = ([empty]) => empty;

describe('PostgreSQL emptiness statements', () => {
  const { types, models, database, operators, owned, plan, find, where } = compiled();
  const dims = 't0."dims"';
  const dimsMembers = [E(nullable(`(${dims} ->> 'w')`)), E(string(`(${dims} ->> 'label')`)), E(jsonList(`(${dims} -> 'tags')`))];
  const inner = '(t0."outer" -> \'inner\')';
  const innerMembers = [E(nullable(`(${inner} ->> 'y')`)), E(string(`(${inner} ->> 'z')`))];
  const udimDims = (alias) => jsonObject(`${alias}."dims"`, [E(nullable(`(${alias}."dims" ->> 'a')`)), E(jsonList(`(${alias}."dims" -> 'tags')`))]);
  const udimMembers = (alias) => [E(nullable(`${alias}."w"`)), E(string(`${alias}."label"`)), E(array(`${alias}."tags"`)), E(udimDims(alias))];
  const meta = (owner, alias) => ownedObject(`${owner}."__meta_state"`, `${owned}__nest__meta`, alias, `${owner}."__id"`, [E(string(`${alias}."code"`))]);
  const mlines = (owner, alias) => ownedList(`${owner}."__mlines_state"`, `${owned}__nest__mlines`, alias, `${owner}."__id"`);
  const nestJoin = `LEFT JOIN "app"."${owned}__nest" t1 ON t1."__owner_id" = t0."id" AND t0."__nest_state" = 'present'`;
  // Each root's statements: [path, the IS_EMPTY and IS_NOT_EMPTY forms, the LEFT JOINs the statement needs].
  const PINS = {
    item: [
      // The record identity is the uuid primary key: the null rule, never `= ''`.
      ['id', nullable('t0."id"')],
      ['note', string('t0."note"')],
      // A validated scalar whose base is String.
      ['code', string('t0."code"')],
      ['count', nullable('t0."count"')],
      ['kind', nullable('t0."kind"')],
      ['state', nullable('t0."state"')],
      ['ref', nullable('t0."ref"')],
      ['at', nullable('t0."at"')],
      ['tags', array('t0."tags"')],
      // jsonb: members as text, never cast; lists through the array guard; nested objects on (J -> 'k').
      ['dims', jsonObject(dims, dimsMembers)],
      ['dims.w', nullable(`(${dims} ->> 'w')`)],
      ['dims.label', string(`(${dims} ->> 'label')`)],
      ['dims.tags', jsonList(`(${dims} -> 'tags')`)],
      ['plain', jsonObject('t0."plain"', [E(nullable('(t0."plain" ->> \'a\')')), E(string('(t0."plain" ->> \'b\')'))])],
      // An embedded `id` member is the jsonb key under its declared scalar's rule: ID gives null, String gives string.
      ['ident', jsonObject('t0."ident"', [E(nullable('(t0."ident" ->> \'id\')')), E(string('(t0."ident" ->> \'label\')'))])],
      ['ident.id', nullable('(t0."ident" ->> \'id\')')],
      ['sident.id', string('(t0."sident" ->> \'id\')')],
      ['outer', jsonObject('t0."outer"', [E(string('(t0."outer" ->> \'x\')')), E(jsonObject(inner, innerMembers))])],
      ['outer.inner', jsonObject(inner, innerMembers)],
      ['outer.inner.z', string(`(${inner} ->> 'z')`)],
      ['lines', jsonList('t0."lines"')],
      // Every member is virtual: always empty.
      ['ghost', jsonObject('t0."ghost"', [])],
      // Leaves through an owned single object read its LEFT JOIN, which a missed join leaves NULL.
      ['odim.w', nullable('t1."w"'), ['LEFT JOIN "app"."QpItem__odim" t1 ON t1."__owner_id" = t0."id" AND t0."__odim_state" = \'present\'']],
      ['odim.tags', array('t1."tags"'), ['LEFT JOIN "app"."QpItem__odim" t1 ON t1."__owner_id" = t0."id" AND t0."__odim_state" = \'present\'']],
      // An owned list counts its rows without __item_present, so [null] is not empty; the list rule never reads the
      // reference inside its items.
      ['olines', ownedList('t0."__olines_state"', 'QpItem__olines', 't1', 't0."id"')],
    ],
    sid: [['id', nullable('t0."id"')], ['name', string('t0."name"')]],
    [OWNED]: [
      // An owned single object with a native-array member and a jsonb member.
      ['udim', ownedObject('t0."__udim_state"', `${owned}__udim`, 't1', 't0."id"', udimMembers('t1'))],
      ['udim.tags', array('t1."tags"'), [`LEFT JOIN "app"."${owned}__udim" t1 ON t1."__owner_id" = t0."id" AND t0."__udim_state" = 'present'`]],
      ['udim.dims', udimDims('t1'), [`LEFT JOIN "app"."${owned}__udim" t1 ON t1."__owner_id" = t0."id" AND t0."__udim_state" = 'present'`]],
      ['udim.dims.a', nullable('(t1."dims" ->> \'a\')'), [`LEFT JOIN "app"."${owned}__udim" t1 ON t1."__owner_id" = t0."id" AND t0."__udim_state" = 'present'`]],
      ['ulist', ownedList('t0."__ulist_state"', `${owned}__ulist`, 't1', 't0."id"')],
      // Owned storage inside owned storage: a fresh alias per subquery, each correlated to the __id of its owner row.
      ['nest', ownedObject('t0."__nest_state"', `${owned}__nest`, 't1', 't0."id"', [E(nullable('t1."w"')), E(meta('t1', 't2')), E(mlines('t1', 't3'))])],
      // Through the LEFT JOIN of the outer object, whose __id the inner subquery reads.
      ['nest.meta', meta('t1', 't2'), [nestJoin]],
      ['nest.mlines', mlines('t1', 't2'), [nestJoin]],
      ['nest.meta.code', string('t2."code"'), [nestJoin, `LEFT JOIN "app"."${owned}__nest__meta" t2 ON t2."__owner_id" = t1."__id" AND t1."__meta_state" = 'present'`]],
    ],
  };

  it.each(Object.entries(PINS).flatMap(([rootKey, pins]) => pins.map(([path, forms, joins = []]) => [`${rootKey} ${path}`, rootKey, path, forms, joins])))('pins the statements of %s', (label, rootKey, path, forms, joins) => {
    OPERATORS.forEach((operator, index) => {
      for (const form of ['field', 'condition']) {
        expect(where(rootKey, path, operator, form), `${operator} ${form}`).toBe(`(${forms[index]})`);
        const { text, values } = find(rootKey, { ...emptinessArgs(types, rootKey, path, operator, form), pagination: { page: 1, size: 5 } });
        const table = types.roots[rootKey].type.name;
        expect(text, `${operator} ${form}`).toBe(`SELECT t0.* FROM "app"."${table}" t0 ${joins.join(' ')} WHERE (${forms[index]}) LIMIT $1::bigint OFFSET $2::bigint`);
        // Emptiness binds no parameters.
        expect(values).toEqual([5, 0]);
      }
    });
  });

  it('pins, word for word, owned storage inside owned storage, an owned row with native-array and jsonb members, and an identity declared String', () => {
    const table = `"app"."${owned}`;
    expect(where(OWNED, 'nest', 'IS_EMPTY')).toBe(`((t0."__nest_state" IS DISTINCT FROM 'present' OR NOT EXISTS (SELECT 1 FROM ${table}__nest" t1 WHERE t1."__owner_id" = t0."id" AND NOT (t1."w" IS NULL AND (t1."__meta_state" IS DISTINCT FROM 'present' OR NOT EXISTS (SELECT 1 FROM ${table}__nest__meta" t2 WHERE t2."__owner_id" = t1."__id" AND NOT ((t2."code" IS NULL OR t2."code" = '')))) AND (t1."__mlines_state" IS DISTINCT FROM 'present' OR NOT EXISTS (SELECT 1 FROM ${table}__nest__mlines" t3 WHERE t3."__owner_id" = t1."__id"))))))`);
    expect(where(OWNED, 'udim', 'IS_NOT_EMPTY')).toBe(`(NOT (t0."__udim_state" IS DISTINCT FROM 'present' OR NOT EXISTS (SELECT 1 FROM ${table}__udim" t1 WHERE t1."__owner_id" = t0."id" AND NOT (t1."w" IS NULL AND (t1."label" IS NULL OR t1."label" = '') AND COALESCE(cardinality(t1."tags"), 0) = 0 AND (t1."dims" IS NULL OR t1."dims" = 'null'::jsonb OR ((t1."dims" ->> 'a') IS NULL AND COALESCE(jsonb_array_length(CASE WHEN jsonb_typeof((t1."dims" -> 'tags')) = 'array' THEN (t1."dims" -> 'tags') END), 0) = 0))))))`);
    expect(compileQuery(models, database, plan('sid', { id: { operator: 'IS_EMPTY' } }, 'count')).text).toBe('SELECT count(*) AS size FROM "app"."QpSid" t0  WHERE (t0."id" IS NULL)');
    expect(types.Sid.getFields().id.type.toString()).toBe('String');
  });

  it('compiles a statement for every path an emptiness condition accepts, with distinct subquery aliases and no casts on jsonb', () => {
    for (const rootKey of ['item', 'sid', OWNED]) {
      for (const path of types.roots[rootKey].paths) {
        for (const operator of OPERATORS) {
          const sql = where(rootKey, path, operator);
          const label = `${rootKey} ${path} ${operator}`;
          const declared = [...sql.matchAll(/ FROM "app"\."[^"]+" (t\d+)/g)].map((match) => match[1]);
          expect(new Set(declared).size, label).toBe(declared.length);
          expect(declared, label).not.toContain('t0');
          // The only cast is the 'null' jsonb literal: a cast of a stored value could raise 22P02.
          expect(sql.replaceAll('\'null\'::jsonb', ''), label).not.toContain('::');
        }
      }
    }
  });

  it('compiles the same forms on every surface: path-less terms, group conditions, OR branches, counts, aggregates and batched children', () => {
    const [empty, notEmpty] = jsonObject(dims, dimsMembers);
    const page = { page: 1, size: 5 };
    const forms = (args) => find('item', { ...args, pagination: page }).text;
    const expected = (condition) => `SELECT t0.* FROM "app"."QpItem" t0  WHERE ${condition} LIMIT $1::bigint OFFSET $2::bigint`;
    // A path that is omitted, null or "" names the field itself; the value may be omitted or null.
    for (const term of [{ operator: 'IS_EMPTY' }, { path: '', operator: 'IS_EMPTY' }, { path: null, operator: 'IS_EMPTY', value: null }]) {
      expect(forms({ dims: { terms: [term] } }), JSON.stringify(term)).toBe(expected(`(${empty})`));
      expect(forms({ AND: [{ conditions: [{ field: 'dims', ...term }] }] }), JSON.stringify(term)).toBe(expected(`(${empty})`));
    }
    // Next to a sibling term with a path, and two object conditions in one group.
    expect(find('item', { dims: { terms: [{ operator: 'IS_NOT_EMPTY' }, { path: 'w', operator: 'EQ', value: 1 }] }, pagination: page })).toEqual({
      text: `SELECT t0.* FROM "app"."QpItem" t0  WHERE ((${notEmpty}) AND ((t0."dims" ->> 'w')::integer = $1::integer)) LIMIT $2::bigint OFFSET $3::bigint`,
      values: [1, 5, 0],
    });
    const [plainEmpty] = jsonObject('t0."plain"', [E(nullable('(t0."plain" ->> \'a\')')), E(string('(t0."plain" ->> \'b\')'))]);
    expect(forms({ AND: [{ conditions: [{ field: 'dims', operator: 'IS_EMPTY' }, { field: 'plain', operator: 'IS_NOT_EMPTY' }] }] }))
      .toBe(expected(`((${empty}) AND (NOT ${plainEmpty}))`));
    expect(forms({ OR: [{ conditions: [{ field: 'note', operator: 'IS_EMPTY' }] }, { conditions: [{ field: 'olines', operator: 'IS_NOT_EMPTY' }] }] }))
      .toBe(expected(`((${E(string('t0."note"'))}) OR (${ownedList('t0."__olines_state"', 'QpItem__olines', 't1', 't0."id"')[1]}))`));
    const count = compileQuery(models, database, plan('item', { dims: { terms: [{ operator: 'IS_EMPTY' }] } }, 'count'));
    expect(count).toEqual({ text: `SELECT count(*) AS size FROM "app"."QpItem" t0  WHERE (${empty})`, values: [] });
    const aggregate = compileQuery(models, database, plan('item', { olines: { terms: [{ operator: 'IS_EMPTY' }] }, aggregation: { groupId: 'count', facts: [{ path: 'id', operation: 'COUNT', factName: 'n' }] } }, 'aggregate'));
    expect(aggregate.text).toBe(`SELECT * FROM (SELECT t0."count" AS "groupId", count(*) AS "fact_0" FROM "app"."QpItem" t0  WHERE (${ownedList('t0."__olines_state"', 'QpItem__olines', 't1', 't0."id"')[0]}) GROUP BY t0."count") aggregated ORDER BY "groupId" ASC NULLS FIRST`);
    expect(aggregate.values).toEqual([]);
    // Each branch of the batched children statement is the per-parent statement, correlated subqueries included.
    const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
    const children = compileChildrenQuery(models, database, plan('item', { olines: { terms: [{ operator: 'IS_EMPTY' }] }, pagination: page }), { column: 'shop', ids });
    const branch = (index) => `SELECT ${index + 1}::integer AS "__simfinity_parent", row_number() OVER () AS "__simfinity_ordinal", simfinity_children.* FROM (SELECT t0.* FROM "app"."QpItem" t0  WHERE (${ownedList('t0."__olines_state"', 'QpItem__olines', 't1', 't0."id"')[0]}) AND t0."shop" = $${index + 3}::uuid LIMIT $1::bigint OFFSET $2::bigint) simfinity_children`;
    expect(children.text).toBe(`${branch(0)} UNION ALL ${branch(1)} ORDER BY "__simfinity_parent", "__simfinity_ordinal"`);
    expect(children.values).toEqual([5, 0, ...ids]);
  });

  it('shares the LEFT JOIN of an owned single object with the filters and sorts of the same path', () => {
    const { text, values } = find(OWNED, {
      udim: { terms: [{ path: 'w', operator: 'IS_EMPTY' }, { path: 'label', operator: 'EQ', value: 'x' }] }, AND: [{ conditions: [{ field: 'udim.tags', operator: 'IS_NOT_EMPTY' }] }],
      sort: { terms: [{ field: 'udim.label', order: 'ASC' }] }, pagination: { page: 1, size: 5 },
    });
    expect(text).toBe(`SELECT t0.* FROM "app"."${owned}" t0 LEFT JOIN "app"."${owned}__udim" t1 ON t1."__owner_id" = t0."id" AND t0."__udim_state" = 'present' WHERE ((t1."w" IS NULL) AND ((t1."label") COLLATE "pg_catalog"."C" = $1::text) AND (COALESCE(cardinality(t1."tags"), 0) > 0)) ORDER BY (t1."label") COLLATE "pg_catalog"."C" ASC NULLS FIRST LIMIT $2::bigint OFFSET $3::bigint`);
    expect(values).toEqual(['x', 5, 0]);
  });

  // 3.9.0 (d57c3e0) compiles these same statements, byte for byte. A one-off comparison of 47 statements of this
  // fixture and of the contract fixture, owned joins and lists, sorts, counts, aggregates and children included, found
  // no difference either.
  it('keeps the statements of the other operators on this fixture (regression pin, passes on 3.9.0 by design)', () => {
    const page = { page: 1, size: 5 };
    const odim = 'LEFT JOIN "app"."QpItem__odim" t1 ON t1."__owner_id" = t0."id" AND t0."__odim_state" = \'present\'';
    const nest = `LEFT JOIN "app"."${owned}__nest" t1 ON t1."__owner_id" = t0."id" AND t0."__nest_state" = 'present' LEFT JOIN "app"."${owned}__nest__meta" t2 ON t2."__owner_id" = t1."__id" AND t1."__meta_state" = 'present'`;
    expect(find('item', { odim: { terms: [{ path: 'w', operator: 'EQ', value: 1 }] }, pagination: page }).text)
      .toBe(`SELECT t0.* FROM "app"."QpItem" t0 ${odim} WHERE (t1."w" = $1::integer) LIMIT $2::bigint OFFSET $3::bigint`);
    expect(find('item', { sort: { terms: [{ field: 'odim.w', order: 'ASC' }] }, pagination: page }).text)
      .toBe(`SELECT t0.* FROM "app"."QpItem" t0 ${odim} WHERE TRUE ORDER BY t1."w" ASC NULLS FIRST LIMIT $1::bigint OFFSET $2::bigint`);
    expect(find(OWNED, { nest: { terms: [{ path: 'meta.code', operator: 'EQ', value: 'c' }] }, pagination: page }).text)
      .toBe(`SELECT t0.* FROM "app"."${owned}" t0 ${nest} WHERE ((t2."code") COLLATE "pg_catalog"."C" = $1::text) LIMIT $2::bigint OFFSET $3::bigint`);
    expect(find(OWNED, { sort: { terms: [{ field: 'nest.meta.code', order: 'DESC' }] }, pagination: page }).text)
      .toBe(`SELECT t0.* FROM "app"."${owned}" t0 ${nest} WHERE TRUE ORDER BY (t2."code") COLLATE "pg_catalog"."C" DESC NULLS LAST LIMIT $1::bigint OFFSET $2::bigint`);
    const olines = database.tables.find((table) => table.name === 'QpItem__olines');
    const storedRow = olines.columns.map((column) => `t2."${column.name}"`).join(', ');
    const nullRow = olines.columns.map((column) => `NULL::${column.type} AS "${column.name}"`).join(', ');
    expect(compileQuery(models, database, plan('item', { olines: { terms: [{ path: 'qty', operator: 'EQ', value: 1 }] } }, 'count')).text)
      .toBe(`SELECT count(*) AS size FROM "app"."QpItem" t0  WHERE (array_position(ARRAY(SELECT t1."qty" FROM LATERAL (SELECT ${storedRow} FROM "app"."QpItem__olines" t2 WHERE t2."__owner_id" = t0."id" AND t0."__olines_state" = 'present' AND t2."__item_present" UNION ALL SELECT ${nullRow} WHERE t0."__olines_state" IS DISTINCT FROM 'present') t1 WHERE TRUE), $1::integer) IS NOT NULL)`);
    expect(find('item', { dims: { terms: [{ path: 'label', operator: 'EQ', value: null }] }, pagination: page }).text)
      .toBe('SELECT t0.* FROM "app"."QpItem" t0  WHERE (((t0."dims" ->> \'label\')::text) COLLATE "pg_catalog"."C" IS NULL) LIMIT $1::bigint OFFSET $2::bigint');
  });

  it('applies the checks of createQueryPlan to plans built by hand, with its codes and messages, from the GraphQL types or from the field descriptions', () => {
    const bare = { entities: models.entities.map((entity) => Object.fromEntries(Object.entries(entity).filter(([key]) => key !== 'gqltype'))) };
    const hand = (path, operator = 'IS_EMPTY', value = null) => ({ entity: 'QpItem', mode: 'find', where: { kind: 'predicate', path, operator, value }, sort: [], pagination: null });
    const condition = (path, operator) => ({ AND: [{ conditions: [{ field: path.join('.'), operator }] }] });
    const REJECTED = [
      // Leaves through lists.
      [['lines', 'qty'], 'INVALID_FILTER_PATH'], [['olines', 'qty'], 'INVALID_FILTER_PATH'], [['reviews', 'text'], 'INVALID_FILTER_PATH'],
      // Field resolution.
      [['nope'], 'INVALID_FILTER_FIELD'], [['dims', 'nope'], 'INVALID_FILTER_FIELD'], [['note', 'x'], 'INVALID_FILTER_PATH'], [['ghost', 'label'], 'INVALID_FILTER_FIELD'],
    ];
    for (const [path, expected] of REJECTED) {
      for (const operator of OPERATORS) {
        const label = `${path.join('.')} ${operator}`;
        const direct = caught(() => compileQuery(models, database, hand(path, operator)));
        expect(code(direct), label).toBe(expected);
        // Without GraphQL types the field descriptions give the same answer.
        expect(failure(caught(() => compileQuery(bare, database, hand(path, operator)))), label).toEqual(failure(direct));
        if (path[0] === 'reviews') expect(failure(caught(() => createQueryPlan(models, 'QpItem', condition(path, operator)))), label).toEqual({ code: 'INVALID_FILTER_PATH', message: 'The shorthand excludes them; use an explicit group' });
        else expect(failure(caught(() => createQueryPlan(models, 'QpItem', condition(path, operator)))), label).toEqual(failure(direct));
      }
    }
    // The value is checked after the path rules, and before the reference rule.
    for (const value of ['', 0, false, [], {}, 'x']) {
      expect(code(caught(() => compileQuery(models, database, hand(['dims'], 'IS_EMPTY', value)))), JSON.stringify(value)).toBe('INVALID_FILTER_VALUE');
      expect(code(caught(() => compileQuery(models, database, hand(['odim'], 'IS_NOT_EMPTY', value)))), JSON.stringify(value)).toBe('INVALID_FILTER_VALUE');
      expect(code(caught(() => compileQuery(models, database, hand(['lines', 'qty'], 'IS_EMPTY', value)))), JSON.stringify(value)).toBe('INVALID_FILTER_PATH');
    }
    // A plan built by hand compiles what createQueryPlan plans, with or without GraphQL types.
    for (const [entity, path] of [[owned, ['nest']], [owned, ['nest', 'meta', 'code']], ['QpItem', ['dims']], ['QpItem', ['id']], ['QpSid', ['id']]]) {
      const built = { ...hand(path, 'IS_NOT_EMPTY'), entity };
      expect(compileQuery(bare, database, built), `${entity} ${path.join('.')}`).toEqual(compileQuery(models, database, built));
    }
  });

  // #108 part 2b lifts rule 6 for a compiler that declares referenceEmptiness, which this one does: a plan built by hand
  // that crosses or ends at a reference or a collection, or reads a reference member, compiles with stored semantics,
  // as createQueryPlan plans it by default. Plans for a compiler that does not declare it keep UNSUPPORTED_QUERY.
  it('compiles emptiness through references and collections with stored semantics, and plans without referenceEmptiness keep UNSUPPORTED_QUERY', () => {
    const bare = { entities: models.entities.map((entity) => Object.fromEntries(Object.entries(entity).filter(([key]) => key !== 'gqltype'))) };
    const hand = (path, operator) => ({ entity: 'QpItem', mode: 'count', where: { kind: 'predicate', path, operator, value: null }, sort: [], pagination: null });
    const condition = (path, operator) => ({ AND: [{ conditions: [{ field: path.join('.'), operator }] }] });
    const shopJoin = 'LEFT JOIN "app"."QpShop" t1 ON t1."id" = t0."shop"';
    const STORED = [
      // A reference member reads its column in the owned row; the reference its own column; a leaf through it a plain
      // LEFT JOIN; a collection NOT EXISTS on its storage column.
      [['odim'], '', ownedObject('t0."__odim_state"', 'QpItem__odim', 't1', 't0."id"', ['t1."w" IS NULL', 'COALESCE(cardinality(t1."tags"), 0) = 0', 't1."shop" IS NULL']), 'reads the reference member odim.shop'],
      [['shop'], '', nullable('t0."shop"'), 'ends at the reference shop'],
      [['shop', 'name'], shopJoin, string('t1."name"'), 'crosses the reference shop'],
      [['reviews'], '', ['NOT ', ''].map((not) => `${not}EXISTS (SELECT 1 FROM "app"."QpReview" t1 WHERE t1."item" = t0."id")`), 'ends at the collection reviews'],
    ];
    for (const [path, joins, forms, kind] of STORED) {
      OPERATORS.forEach((operator, index) => {
        const label = `${path.join('.')} ${operator}`;
        const direct = compileQuery(models, database, hand(path, operator));
        expect(direct, label).toEqual({ text: `SELECT count(*) AS size FROM "app"."QpItem" t0 ${joins} WHERE (${forms[index]})`, values: [] });
        expect(compileQuery(bare, database, hand(path, operator)), label).toEqual(direct);
        expect(compileQuery(models, database, createQueryPlan(models, 'QpItem', condition(path, operator), { mode: 'count' })), label).toEqual(direct);
        expect(compileQuery(models, database, createQueryPlan(models, 'QpItem', condition(path, operator), { mode: 'count', operators, referenceEmptiness: true })), label).toEqual(direct);
        // The plans of a compiler that does not declare it.
        expect(failure(caught(() => createQueryPlan(models, 'QpItem', condition(path, operator), { operators }))), label)
          .toEqual({ code: 'UNSUPPORTED_QUERY', message: `${operator} on ${path.join('.')} ${kind}: the database adapter does not support emptiness through references and collections` });
      });
    }
  });
});

describe('PostgreSQL emptiness declaration', () => {
  const offline = () => ({ query: async () => { throw new Error('offline'); }, connect: async () => { throw new Error('offline'); } });

  it('declares IS_EMPTY and IS_NOT_EMPTY in the PostgreSQL plugin, after the text operators, and binds them', () => {
    const { operators } = postgresPlugin().queryFeatures;
    expect(operators.slice(-5, -2)).toEqual(['IEQ', 'IS_EMPTY', 'IS_NOT_EMPTY']);
    expect(bindPlugin(postgresPlugin()).queryFeatures.operators).toEqual(operators);
    expect(createSQLAdapter(postgresPlugin()).queryFeatures.operators).toEqual(operators);
  });

  it('rejects the emptiness operators for a plugin that does not declare them, before middleware, with the earlier codes first', async () => {
    const run = async (plugin) => {
      const api = createSQL({ plugin });
      const types = createEmptinessTypes('Qd');
      let middleware = 0;
      api.use((params, next) => { middleware += 1; return next(); });
      registerEmptinessTypes(api, types);
      const schema = api.createSchema();
      const result = async (path, form = 'field') => {
        const { source, variables } = emptinessQuery(types, 'item', emptinessArgs(types, 'item', path, 'IS_EMPTY', form));
        return code((await graphql({ schema, source, variableValues: variables, contextValue: {} })).errors?.[0]);
      };
      return { result, middleware: () => middleware };
    };
    const paths = ['note', 'tags', 'dims', 'dims.w', 'lines', 'odim.w', 'olines', 'ghost', 'id'];
    const legacy = await run({ ...postgresPlugin({ pool: offline(), schema: 'offline' }), queryFeatures: undefined });
    // A copy that replaces compileQuery keeps the operators of 3.7.0 until it declares more.
    const copy = await run({ ...postgresPlugin({ pool: offline(), schema: 'offline' }), compileQuery: (...args) => compileQuery(...args) });
    for (const plugin of [legacy, copy]) {
      for (const path of paths) for (const form of ['field', 'condition']) expect(await plugin.result(path, form), `${path} ${form}`).toBe('UNSUPPORTED_QUERY');
      expect(plugin.middleware()).toBe(0);
    }
    // The declaring plugin passes the gate, and the request fails only at the storage, which is not initialized.
    const current = await run(postgresPlugin({ pool: offline(), schema: 'offline' }));
    for (const path of paths) expect(await current.result(path), path).toBe('DATABASE_NOT_INITIALIZED');
    // In plans with the operators of 3.7.0, an undeclared operator comes after field resolution and before the rules
    // on paths, values and references.
    const { models } = compiled();
    const plan = (args) => code(caught(() => createQueryPlan(models, 'QpItem', args, { operators: LEGACY })));
    expect(plan({ dims: { terms: [{ operator: 'IS_EMPTY' }] } })).toBe('UNSUPPORTED_QUERY');
    expect(plan({ lines: { terms: [{ path: 'qty', operator: 'IS_EMPTY' }] } })).toBe('UNSUPPORTED_QUERY');
    expect(plan({ odim: { terms: [{ operator: 'IS_EMPTY', value: 'x' }] } })).toBe('UNSUPPORTED_QUERY');
    expect(plan({ dims: { terms: [{ path: 'nope', operator: 'IS_EMPTY' }] } })).toBe('INVALID_FILTER_FIELD');
  });

  it('fails object-ending filter paths of more than one segment with INVALID_FILTER_PATH, as MongoDB does, and a bare object field with MISSING_FILTER_PATH', () => {
    const { plan } = compiled();
    const codes = (args) => code(caught(() => plan('item', args)));
    expect(codes({ AND: [{ conditions: [{ field: 'outer', path: 'inner', operator: 'EQ', value: 'x' }] }] })).toBe('INVALID_FILTER_PATH');
    expect(codes({ outer: { terms: [{ path: 'inner', operator: 'EQ', value: 'x' }] } })).toBe('INVALID_FILTER_PATH');
    expect(codes({ odim: { terms: [{ path: 'shop', operator: 'EQ', value: 'x' }] } })).toBe('INVALID_FILTER_PATH');
    expect(codes({ shop: { terms: [{ path: 'items', operator: 'EQ', value: 'x' }] } })).toBe('INVALID_FILTER_PATH');
    expect(codes({ AND: [{ conditions: [{ field: 'dims', operator: 'EQ', value: 'x' }] }] })).toBe('MISSING_FILTER_PATH');
  });
});

// Records written natively on top of a generated create: [key, root, shop, create input, writes, options, paths that
// are not empty]. Item's odim and olines have no unique member, so any number of records can hold their states; each
// owned root of its own (Nat*) holds one record, since a unique member takes one null per root.
const VALUES = EMPTINESS_CASES.find((item) => item.name === 'item create values');
const OWNED_BASE = EMPTINESS_CASES.find((item) => item.name === 'owned update null').base;
const notEmptyOf = (emptinessCase) => Object.entries(emptinessCase.expectEmpty).filter(([, empty]) => !empty).map(([path]) => path);
const ITEM_VALUES = { ...VALUES.input, ref: emptinessSampleId('postgres') };
const NATIVE = [
  ['native values', 'item', 'S1', ITEM_VALUES, [], {}, notEmptyOf(VALUES)],
  ['native null jsonb', 'item', 'S2', { dims: { w: 1 } }, [{ path: 'dims', sql: '\'null\'::jsonb', present: true }], {}, ['id', 'state']],
  ['native null jsonb list', 'item', 'S1', { dims: { w: 1, tags: ['t'] } }, [{ path: 'dims', sql: '\'{"tags":null}\'::jsonb' }], {}, ['id', 'state']],
  ['native null array item', 'item', 'S2', {}, [{ path: 'tags', sql: 'ARRAY[NULL]::text[]' }], {}, ['id', 'state', 'tags']],
  ['native olines missing', 'item', 'S1', { olines: [{ qty: 1 }] }, [{ path: 'olines', state: 'missing' }], {}, ['id', 'state']],
  ['native olines null', 'item', 'S2', { olines: [{ qty: 1 }] }, [{ path: 'olines', state: 'null' }], {}, ['id', 'state']],
  ['native olines present', 'item', 'S1', { olines: [{ qty: 1 }] }, [{ path: 'olines', state: 'present' }], {}, ['id', 'state']],
  ['native odim missing', 'item', 'S2', { odim: { w: 1, tags: ['o'] } }, [{ path: 'odim', state: 'missing' }], {}, ['id', 'state']],
  ['native odim null', 'item', 'S1', { odim: { w: 1, tags: ['o'] } }, [{ path: 'odim', state: 'null' }], {}, ['id', 'state']],
  ['native owned missing', 'native:NatMissing', null, OWNED_BASE, ['udim', 'ulist', 'nest'].map((path) => ({ path, state: 'missing' })), {}, ['id']],
  ['native owned null', 'native:NatNull', null, OWNED_BASE, ['udim', 'ulist', 'nest'].map((path) => ({ path, state: 'null' })), {}, ['id']],
  // The inner object null and the inner list missing: the outer object keeps its `w`.
  ['native owned inner', 'native:NatInner', null, OWNED_BASE, [{ path: 'nest.meta', state: 'null' }, { path: 'nest.mlines', state: 'missing' }], {},
    ['id', 'udim', 'udim.w', 'udim.label', 'udim.tags', 'udim.dims', 'udim.dims.a', 'udim.dims.tags', 'ulist', 'nest', 'nest.w']],
  // An owned single object marked present without a row, which only a write with the triggers disabled stores, and
  // an owned list present without rows.
  ['native owned present', 'native:NatPresent', null, OWNED_BASE, [{ path: 'udim', state: 'present' }, { path: 'ulist', state: 'present' }], { triggers: false },
    ['id', 'nest', 'nest.w', 'nest.meta', 'nest.meta.code', 'nest.mlines']],
].map(([key, root, shop, input, writes, options, notEmpty]) => ({ key, root, shop, input, writes, options, notEmpty }));
const NATIVE_ROOTS = [...new Set(NATIVE.map((item) => item.root).filter((root) => root.startsWith('native:')))];

// One root type per native owned record, with the members of the owned cases' roots.
const nativeRoots = (types) => {
  const member = (name) => types.embedded.find((type) => type.name === `${types.prefix}${name}`);
  const { paths } = types.roots[OWNED];
  return Object.fromEntries(NATIVE_ROOTS.map((key) => {
    const type = new GraphQLObjectType({
      name: `${types.prefix}${key.slice('native:'.length)}`,
      fields: {
        id: { type: GraphQLID }, key: { type: new GraphQLNonNull(GraphQLString) },
        udim: { type: member('UDim'), extensions: embedded }, ulist: { type: new GraphQLList(member('ULine')), extensions: embedded },
        nest: { type: member('Nest'), extensions: embedded },
      },
    });
    return [key, { key, type, single: lowerFirst(type.name), plural: `${lowerFirst(type.name)}s`, paths }];
  }));
};
const runtimeFor = (pool, schema, options = {}) => {
  const api = createPostgres({ pool, schema, ...options });
  const types = createEmptinessTypes('Qp');
  const roots = nativeRoots(types);
  registerEmptinessTypes(api, types);
  for (const root of Object.values(roots)) api.connect(null, root.type, root.single, root.plural);
  return { api, types, all: { ...types, roots: { ...types.roots, ...roots } }, schema: api.createSchema() };
};
// A pool that records the text of every statement it runs.
const recording = (pool, log) => ({
  query: (text, values) => { log.push(text); return pool.query(text, values); },
  connect: async () => {
    const client = await pool.connect();
    return { query: (text, values) => { log.push(text); return client.query(text, values); }, release: (error) => client.release(error) };
  },
});

describe.skipIf(!uri)('PostgreSQL emptiness rows', () => {
  const namespace = `qp_${randomUUID().replaceAll('-', '')}`;
  const legacyNamespace = `${namespace}_legacy`;
  const statements = [];
  let pool; let batched; let unbatched; let legacy; let shops;
  const execute = (runtime, source, variableValues, contextValue = {}) => graphql({ schema: runtime.schema, source, variableValues, contextValue });
  const keys = async (runtime, rootKey, args) => {
    const { source, variables } = emptinessQuery(runtime.all, rootKey, args);
    const result = await execute(runtime, source, variables);
    expect(result.errors, JSON.stringify(args)).toBeUndefined();
    return Object.values(result.data)[0].map((row) => row.key);
  };
  const expected = (rootKey, path, operator) => {
    const empty = operator === 'IS_EMPTY';
    const cases = rootKey.startsWith('native:') ? [] : expectedEmptinessKeys(rootKey, path, operator);
    const natives = NATIVE.filter((item) => item.root === rootKey && !item.notEmpty.includes(path) === empty).map((item) => item.key);
    return [...cases, ...natives].sort();
  };
  const failureOf = async (runtime, args) => {
    const { source, variables } = emptinessQuery(runtime.all, 'item', args);
    return code((await execute(runtime, source, variables)).errors?.[0]);
  };

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: uri });
    batched = runtimeFor(recording(pool, statements), namespace, { batchedCollections: true });
    await batched.api.initializeDatabase();
    await seedEmptiness(batched.schema, batched.types);
    const add = async (single, typeName, input) => {
      const result = await execute(batched, `mutation($input:${typeName}Input!){add${single}(input:$input){id}}`, { input });
      if (result.errors) throw new Error(`${single} ${JSON.stringify(input)}: ${JSON.stringify(result.errors)}`);
      return Object.values(result.data)[0].id;
    };
    shops = {};
    for (const key of ['S1', 'S2']) shops[key] = await add('qpShop', 'QpShop', { key });
    const database = batched.api.describeDatabase();
    for (const item of NATIVE) {
      const root = batched.all.roots[item.root];
      const id = await add(root.single, root.type.name, { ...item.input, key: item.key, ...(item.shop ? { shop: { id: shops[item.shop] } } : {}) });
      if (item.writes.length) await writePostgresEmptiness(pool, database, batched.all, item.root, id, item.writes, item.options);
    }
    // The same types on the same storage, read without batched collections.
    unbatched = runtimeFor(pool, namespace);
    await unbatched.api.initializeDatabase({ mode: 'validate' });
    const LegacyNote = new GraphQLObjectType({ name: 'QpLegacyNote', fields: { id: { type: GraphQLID }, key: { type: GraphQLString }, note: { type: GraphQLString }, tags: { type: new GraphQLList(GraphQLString) } } });
    const api = createSQL({ plugin: { ...postgresPlugin({ pool, schema: legacyNamespace }), queryFeatures: undefined } });
    api.connect(null, LegacyNote, 'qpLegacyNote', 'qpLegacyNotes');
    legacy = { api, type: LegacyNote, schema: api.createSchema() };
    await api.initializeDatabase();
    await api.getModel(LegacyNote).create({ key: 'l1', note: '' });
  }, 120000);
  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await pool.query(`DROP SCHEMA IF EXISTS "${legacyNamespace}" CASCADE`);
      await pool.end();
    }
  });

  it('stores the native values the cases describe (a check of the fixture, passes on 3.9.0 by design)', async () => {
    const row = async (table, key, columns) => (await pool.query(`SELECT ${columns} FROM "${namespace}"."${table}" WHERE "key" = $1`, [key])).rows[0];
    expect(await row('QpItem', 'native null jsonb', 'jsonb_typeof("dims") AS type, "__field__dims__present" AS present')).toEqual({ type: 'null', present: true });
    expect(await row('QpItem', 'native null jsonb list', '"dims"::text AS dims')).toEqual({ dims: '{"tags": null}' });
    expect(await row('QpItem', 'native null array item', '"tags"')).toEqual({ tags: [null] });
    for (const [key, state] of [['native olines missing', 'missing'], ['native olines null', 'null'], ['native olines present', 'present']]) {
      expect(await row('QpItem', key, `"__olines_state" AS state, (SELECT count(*)::integer FROM "${namespace}"."QpItem__olines" o WHERE o."__owner_id" = "QpItem"."id") AS rows`), key).toEqual({ state, rows: 0 });
    }
    expect(await row('QpNatPresent', 'native owned present', `"__udim_state" AS state, (SELECT count(*)::integer FROM "${namespace}"."QpNatPresent__udim" o WHERE o."__owner_id" = "QpNatPresent"."id") AS rows`)).toEqual({ state: 'present', rows: 0 });
    const { rows: [nest] } = await pool.query(`SELECT n."w", n."__meta_state" AS meta, n."__mlines_state" AS mlines FROM "${namespace}"."QpNatInner__nest" n JOIN "${namespace}"."QpNatInner" r ON r."id" = n."__owner_id" WHERE r."key" = 'native owned inner'`);
    expect(nest).toEqual({ w: 1, meta: 'null', mlines: 'missing' });
  });

  it.each(['item', 'sid', ...EMPTINESS_CASES.filter((item) => item.root === 'owned').map((item) => `owned:${item.name}`), ...NATIVE_ROOTS])('returns the rows of every path on %s, as field filters, terms and group conditions', async (rootKey) => {
    for (const path of batched.all.roots[rootKey].paths) {
      const rows = {};
      for (const operator of OPERATORS) {
        rows[operator] = expected(rootKey, path, operator);
        for (const form of ['field', 'condition']) {
          expect(await keys(batched, rootKey, emptinessArgs(batched.all, rootKey, path, operator, form)), `${path} ${operator} ${form}`).toEqual(rows[operator]);
        }
      }
      // IS_NOT_EMPTY is the exact complement of IS_EMPTY.
      expect(rows.IS_EMPTY.filter((key) => rows.IS_NOT_EMPTY.includes(key)), path).toEqual([]);
    }
    const all = await keys(batched, rootKey, {});
    for (const path of batched.all.roots[rootKey].paths) expect([...expected(rootKey, path, 'IS_EMPTY'), ...expected(rootKey, path, 'IS_NOT_EMPTY')].sort(), path).toEqual(all);
  });

  it('returns the same rows from reads outside the runtime', async () => {
    for (const path of batched.all.roots.item.paths) {
      for (const operator of OPERATORS) {
        const records = await batched.api.getModel(batched.types.Item).find({ ...emptinessArgs(batched.all, 'item', path, operator), sort: { terms: [{ field: 'key', order: 'ASC' }] } });
        expect(records.map((record) => record.key), `${path} ${operator}`).toEqual(expected('item', path, operator));
      }
    }
  });

  it('counts, pages and aggregates emptiness conditions', async () => {
    for (const [path, operator] of [['note', 'IS_EMPTY'], ['dims', 'IS_NOT_EMPTY'], ['olines', 'IS_EMPTY'], ['odim.w', 'IS_NOT_EMPTY']]) {
      const args = emptinessArgs(batched.all, 'item', path, operator);
      const [name] = Object.keys(args);
      const type = path.includes('.') || ['dims', 'olines'].includes(path) ? 'QLTypeFilterExpression' : 'QLFilter';
      const rows = expected('item', path, operator);
      const context = {};
      const page = await execute(batched, `query($f:${type}){qpItems(${name}:$f,sort:{terms:[{field:"key",order:ASC}]},pagination:{page:2,size:2,count:true}){key}}`, { f: args[name] }, context);
      expect(page.errors, path).toBeUndefined();
      expect({ rows: page.data.qpItems.map((row) => row.key), count: context.count }, path).toEqual({ rows: rows.slice(2, 4), count: rows.length });
      const aggregate = await execute(batched, `query($f:${type}){qpItems_aggregate(${name}:$f,aggregation:{groupId:"state",facts:[{operation:COUNT,factName:"n",path:"id"}]}){groupId facts}}`, { f: args[name] });
      expect(aggregate.errors, path).toBeUndefined();
      expect(aggregate.data.qpItems_aggregate, path).toEqual([{ groupId: 'OPEN', facts: { n: rows.length } }]);
    }
  });

  it('filters batched collection fields with emptiness conditions, as reads without batching do', async () => {
    for (const [path, operator] of [['note', 'IS_EMPTY'], ['note', 'IS_NOT_EMPTY'], ['dims', 'IS_NOT_EMPTY'], ['olines', 'IS_EMPTY'], ['odim.tags', 'IS_EMPTY'], ['tags', 'IS_NOT_EMPTY']]) {
      const args = emptinessArgs(batched.all, 'item', path, operator);
      const [name] = Object.keys(args);
      const type = path.includes('.') || ['dims', 'olines'].includes(path) ? 'QLTypeFilterExpression' : 'QLFilter';
      const source = `query($f:${type}){qpShops(sort:{terms:[{field:"key",order:ASC}]}){key items(${name}:$f,sort:{terms:[{field:"key",order:ASC}]}){key}}}`;
      const rows = ['S1', 'S2'].map((shop) => ({
        key: shop,
        items: NATIVE.filter((item) => item.shop === shop && !item.notEmpty.includes(path) === (operator === 'IS_EMPTY')).map((item) => ({ key: item.key })).sort((a, b) => (a.key < b.key ? -1 : 1)),
      }));
      statements.length = 0;
      const result = await execute(batched, source, { f: args[name] });
      expect(result.errors, `${path} ${operator}`).toBeUndefined();
      expect(result.data.qpShops, `${path} ${operator}`).toEqual(rows);
      // Both shops' items came from one batched statement, which carries the emptiness form in each branch.
      const children = statements.filter((text) => text.includes(' UNION ALL ') && text.includes('"__simfinity_parent"'));
      expect(children, `${path} ${operator}`).toHaveLength(1);
      const unbatchedResult = await execute(unbatched, source, { f: args[name] });
      expect(unbatchedResult.errors).toBeUndefined();
      expect(unbatchedResult.data.qpShops, `${path} ${operator}`).toEqual(rows);
    }
  });

  it('rejects, through the SQL runtime and in reads outside it, what emptiness cannot answer and object-ending filter paths', async () => {
    const find = (args) => batched.api.getModel(batched.types.Item).find(args).then(() => undefined, (error) => code(error));
    const REJECTED = [
      [{ lines: { terms: [{ path: 'qty', operator: 'IS_EMPTY' }] } }, 'INVALID_FILTER_PATH'],
      [{ olines: { terms: [{ path: 'shop', operator: 'IS_EMPTY' }] } }, 'INVALID_FILTER_PATH'],
      [{ reviews: { terms: [{ path: 'text', operator: 'IS_NOT_EMPTY' }] } }, 'INVALID_FILTER_PATH'],
      [{ dims: { terms: [{ operator: 'IS_EMPTY', value: '' }] } }, 'INVALID_FILTER_VALUE'],
      // Filter paths of other operators that end at an object (#108 2.6).
      [{ AND: [{ conditions: [{ field: 'outer', path: 'inner', operator: 'EQ', value: 'x' }] }] }, 'INVALID_FILTER_PATH'],
      [{ outer: { terms: [{ path: 'inner', operator: 'EQ', value: 'x' }] } }, 'INVALID_FILTER_PATH'],
      [{ odim: { terms: [{ path: 'shop', operator: 'EQ', value: 'x' }] } }, 'INVALID_FILTER_PATH'],
      [{ shop: { terms: [{ path: 'items', operator: 'EQ', value: 'x' }] } }, 'INVALID_FILTER_PATH'],
      [{ AND: [{ conditions: [{ field: 'dims', operator: 'EQ', value: 'x' }] }] }, 'MISSING_FILTER_PATH'],
    ];
    for (const [args, expectedCode] of REJECTED) {
      expect(await failureOf(batched, args), JSON.stringify(args)).toBe(expectedCode);
      expect(await find(args), JSON.stringify(args)).toBe(expectedCode);
    }
  });

  // #108 part 2b: the plugin declares referenceEmptiness, so these paths, which 2a rejected, return rows. Neither Item
  // nor Shop nor Review has a scope here, so the client's constructs read what trusted ones read: each gives the rows
  // of the legacy or 2a conditions that mean the same on stored data.
  it('answers emptiness through references and collections, through the SQL runtime and in reads outside it', async () => {
    const [reviewed] = await batched.api.getModel(batched.types.Item).find({ key: { operator: 'EQ', value: 'native values' } });
    const added = await execute(batched, 'mutation($input:QpReviewInput!){addqpReview(input:$input){id}}', { input: { key: 'r1', item: { id: reviewed.id } } });
    expect(added.errors).toBeUndefined();
    const named = await execute(batched, 'mutation($input:QpShopInputForUpdate!){updateqpShop(input:$input){id}}', { input: { id: shops.S1, name: 'S1' } });
    expect(named.errors).toBeUndefined();
    const condition = (field, path, operator, value) => ({ field, ...(path ? { path } : {}), operator, ...(value === undefined ? {} : { value }) });
    const EQUIVALENT = [
      [{ shop: { terms: [{ operator: 'IS_EMPTY' }] } }, { shop: { terms: [{ path: 'id', operator: 'EQ', value: null }] } }],
      [{ AND: [{ conditions: [condition('shop', 'name', 'IS_EMPTY')] }] }, { OR: [{ conditions: [condition('shop', 'name', 'EQ', null)] }, { conditions: [condition('shop', 'name', 'EQ', '')] }] }],
      [{ odim: { terms: [{ operator: 'IS_EMPTY' }] } }, { AND: [{ conditions: [condition('odim', 'w', 'IS_EMPTY'), condition('odim', 'tags', 'IS_EMPTY'), condition('odim', 'shop.id', 'EQ', null)] }] }],
    ];
    // A child frame has no null joined row for a parent without children. Collection emptiness
    // still returns those parents; ANY reviews: id EQ null cannot match a persisted child identity.
    expect(await keys(batched, 'item', { reviews: { terms: [{ path: 'id', operator: 'EQ', value: null }] } })).toEqual([]);
    const reviewedKeys = await keys(batched, 'item', { reviews: { terms: [{ operator: 'IS_NOT_EMPTY' }] } });
    expect(reviewedKeys).toEqual(['native values']);
    const all = await keys(batched, 'item', {});
    expect(await keys(batched, 'item', { reviews: { terms: [{ operator: 'IS_EMPTY' }] } })).toEqual(all.filter((key) => !reviewedKeys.includes(key)));
    const flip = (args) => JSON.parse(JSON.stringify(args).replace('"IS_EMPTY"', '"IS_NOT_EMPTY"'));
    for (const [args, same] of EQUIVALENT) {
      const label = JSON.stringify(args);
      const empty = [...new Set(await keys(batched, 'item', same))];
      expect(empty.length, label).toBeGreaterThan(0);
      expect(empty.length, label).toBeLessThan(all.length);
      expect(await keys(batched, 'item', args), label).toEqual(empty);
      expect(await keys(batched, 'item', flip(args)), label).toEqual(all.filter((key) => !empty.includes(key)));
      const records = await batched.api.getModel(batched.types.Item).find({ ...args, sort: { terms: [{ field: 'key', order: 'ASC' }] } });
      expect(records.map((record) => record.key), label).toEqual(empty);
    }
  });

  it('rejects emptiness through references and collections for a plugin that declares the operators and not referenceEmptiness, also in reads outside the runtime', async () => {
    const api = createSQL({ plugin: { ...postgresPlugin({ pool, schema: namespace }), queryFeatures: { operators: postgresPlugin().queryFeatures.operators } } });
    const types = createEmptinessTypes('Qp');
    registerEmptinessTypes(api, types);
    const schema = api.createSchema();
    await api.initializeDatabase({ mode: 'validate' });
    const runtime = { api, types, all: types, schema };
    for (const [args, message] of [
      [{ shop: { terms: [{ operator: 'IS_EMPTY' }] } }, 'IS_EMPTY on shop ends at the reference shop'],
      [{ odim: { terms: [{ operator: 'IS_NOT_EMPTY' }] } }, 'IS_NOT_EMPTY on odim reads the reference member odim.shop'],
      [{ AND: [{ conditions: [{ field: 'shop', path: 'name', operator: 'IS_EMPTY' }] }] }, 'IS_EMPTY on shop.name crosses the reference shop'],
      [{ reviews: { terms: [{ operator: 'IS_EMPTY' }] } }, 'IS_EMPTY on reviews ends at the collection reviews'],
    ]) {
      const label = JSON.stringify(args);
      expect(await failureOf(runtime, args), label).toBe('UNSUPPORTED_QUERY');
      await expect(api.getModel(types.Item).find(args), label).rejects.toMatchObject({ message: `${message}: the database adapter does not support emptiness through references and collections`, extensions: { code: 'UNSUPPORTED_QUERY' } });
    }
    // The record's own fields keep their rows.
    expect(await keys(runtime, 'item', { note: { operator: 'IS_EMPTY' } })).toEqual(await keys(batched, 'item', { note: { operator: 'IS_EMPTY' } }));
  });

  it('rejects the emptiness operators for a plugin without queryFeatures, also in reads outside the runtime', async () => {
    for (const operator of OPERATORS) {
      for (const field of ['note', 'tags']) {
        const result = await graphql({ schema: legacy.schema, source: `query($f:QLFilter){qpLegacyNotes(${field}:$f){key}}`, variableValues: { f: { operator } } });
        expect(code(result.errors?.[0]), `${field} ${operator}`).toBe('UNSUPPORTED_QUERY');
        await expect(legacy.api.getModel(legacy.type).find({ [field]: { operator } }), `${field} ${operator}`).rejects.toMatchObject({ extensions: { code: 'UNSUPPORTED_QUERY' } });
      }
    }
    expect((await legacy.api.getModel(legacy.type).find({ note: { operator: 'EQ', value: '' } })).map((record) => record.key)).toEqual(['l1']);
  });

  describe('plans', () => {
    const explain = async (runtime, rootKey, args, setup) => {
      const models = describeModels(runtime.api.getRegistrations());
      const entity = runtime.all.roots[rootKey].type.name;
      const { text, values } = compileQuery(models, runtime.api.describeDatabase(), createQueryPlan(models, entity, args));
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
    const scans = (plan) => nodes(plan).filter((node) => node['Index Cond']).map((node) => [node['Node Type'], node['Index Name'], node['Index Cond']]);

    it('serves the String form with a BitmapOr of two scans of a btree on the column', async () => {
      // The index is built on an empty table of its own schema, before any row exists. Built over the seeded
      // table, whose updates leave HOT chains, it is marked indcheckxmin, and transactions as old as its
      // creation, or older, cannot use it: whether the planner sees it then depends on page pruning.
      const schema = `${namespace}_plan`;
      const fresh = runtimeFor(pool, schema);
      try {
        await fresh.api.initializeDatabase();
        await pool.query(`CREATE INDEX qp_note ON "${schema}"."QpItem" ("note")`);
        const plan = await explain(fresh, 'item', { note: { operator: 'IS_EMPTY' } }, []);
        const bitmap = nodes(plan).find((node) => node['Node Type'] === 'BitmapOr');
        expect(bitmap, JSON.stringify(plan)).toBeDefined();
        expect(scans(bitmap)).toEqual([['Bitmap Index Scan', 'qp_note', '(note IS NULL)'], ['Bitmap Index Scan', 'qp_note', '(note = \'\'::text)']]);
      } finally {
        await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      }
    }, 120000);

    it('serves the null form with the generated index of an ID column', async () => {
      const plan = await explain(batched, 'item', { ref: { operator: 'IS_EMPTY' } }, []);
      expect(scans(plan).map(([, index, condition]) => [index, condition])).toEqual([['QpItem__ref__idx', '(ref IS NULL)']]);
    });
  });
});
