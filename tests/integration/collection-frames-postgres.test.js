import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { graphql, GraphQLBoolean, GraphQLEnumType, GraphQLFloat, GraphQLID, GraphQLInt, GraphQLList, GraphQLObjectType, GraphQLScalarType, GraphQLString } from 'graphql';
import pg from 'pg';
import { describeModels } from '../../packages/core/src/metadata.js';
import { createQueryPlan } from '../../packages/core/src/query-plan.js';
import { createPostgres, postgresPlugin } from '../../packages/postgres/src/index.js';
import { compileChildrenQuery, compileQuery } from '../../packages/postgres/src/query/compiler.js';
import { describeDatabase } from '../../packages/postgres/src/schema/describe.js';
import { encodeParameter } from '../../packages/postgres/src/codecs.js';
import { createSQLAdapter } from '../../packages/sql/src/adapter.js';
import { bindPlugin } from '../../packages/sql/src/plugin.js';
import { createSQL } from '../../packages/sql/src/index.js';
import { COLLECTION_CASES, COLLECTION_AGGREGATES, COLLECTION_ANCHOR_ROWS, seedCollectionFrames } from '../helpers/collection-frames.js';
import { REFERENCE_SHAPES, createReferenceEmptinessTypes, registerReferenceEmptinessTypes } from '../helpers/query-emptiness.js';

const uri = process.env.SIMFINITY_POSTGRES_URI;
const createTypes = () => {
  const own = createReferenceEmptinessTypes('Qf');
  own.Review.getFields().lines = { name: 'lines', type: new GraphQLList(own.embedded[1]), args: [], extensions: { relation: { embedded: true } } };
  return own;
};
const types = createTypes();
const originalScope = types.Product.extensions.scope;
types.Product.extensions.scope = { ...originalScope, find: async (params) => { await originalScope?.find?.(params); await params.context?.ownScope?.(params); }, get_by_id: async (params) => { await params.context?.ownScope?.(params); } };
const originalReviewScope = types.Review.extensions.scope;
types.Review.extensions.scope = { ...originalReviewScope, find: async (params) => { await originalReviewScope?.find?.(params); await params.context?.reviewScope?.(params); } };
const registrations = [types.Shop, types.Pro, types.Product, types.Review].map((gqltype) => ({ gqltype }))
  .concat(types.embedded.map((gqltype) => ({ gqltype, endpoint: false })));
const models = describeModels(registrations);
const database = describeDatabase(registrations, { schema: 'app' });
const pred = (path, operator = 'EQ', value = 'x', extra = {}) => ({ kind: 'predicate', path: path.split('.'), operator, value, ...extra });
const frame = (path = 'reviews', where = pred('rating', 'GTE', 4), extra = {}) => ({ kind: 'quantified', quantifier: 'ANY', path: path.split('.'), where, scope: null, ...extra });
const plan = (where, entity = 'Product', extra = {}) => ({ entity: `Qf${entity}`, mode: 'count', where, sort: [], ...extra });
const compile = (where, entity, extra) => compileQuery(models, database, plan(where, entity, extra));
const count = (table, condition, joins = '') => `SELECT count(*) AS size FROM "app"."Qf${table}" t0 ${joins} WHERE ${condition.startsWith('EXISTS') || condition.startsWith('NOT EXISTS') ? `(${condition})` : condition}`;
const review = 'FROM "app"."QfReview" t1 WHERE t1."productId" = t0."id"';
const caught = (run) => { try { run(); } catch (error) { return error; } return null; };
const nodes = (node) => [node, ...(node.Plans ?? []).flatMap(nodes)];
// Same referenced-subtree traversal as the reference-emptiness physical probes; only OR may use it.
const hashedNodes = (plan) => {
  const names = new Set([...JSON.stringify(plan).matchAll(/hashed SubPlan (\d+)/g)].map(([, number]) => `SubPlan ${number}`));
  const found = [];
  const walk = (node, inside) => {
    const here = inside || names.has(node['Subplan Name']);
    if (here) found.push(node);
    for (const child of node.Plans || []) walk(child, here);
  };
  walk(plan, false);
  return found;
};
const inverseCard = new GraphQLObjectType({
  name: 'QfiCard', fields: { id: { type: GraphQLID }, name: { type: GraphQLString }, tags: { type: new GraphQLList(GraphQLString) }, ownerId: { type: GraphQLID } },
});
const inverseOwner = new GraphQLObjectType({
  name: 'QfiOwner', fields: { id: { type: GraphQLID }, cards: { type: new GraphQLList(inverseCard), extensions: { relation: { embedded: false, connectionField: 'ownerId' } } } },
});
const inverseRegistrations = [inverseCard, inverseOwner].map((gqltype) => ({ gqltype }));
const inverseModels = describeModels(inverseRegistrations);
const inverseDatabase = describeDatabase(inverseRegistrations, { schema: 'app' });

describe('PostgreSQL collection frame statements', () => {
  it.each(['ANY', 'NONE', 'ALL'])('pins %s and null-safe ALL with bound values', (quantifier) => {
    const body = quantifier === 'ALL' ? 'NOT (COALESCE(t1."rating" >= $1::integer, FALSE))' : '(t1."rating" >= $1::integer)';
    expect(compile(frame('reviews', pred('rating', 'GTE', 4), { quantifier }))).toEqual({
      text: count('Product', `${quantifier === 'ANY' ? '' : 'NOT '}EXISTS (SELECT 1 ${review} AND ${body})`), values: [4],
    });
  });
  it('pins ALL with IS DISTINCT FROM and a scope outside the negation', () => {
    expect(compile(frame('reviews', pred('author', 'NE', 'x'), { quantifier: 'ALL', scope: pred('author', 'NE', 'hidden') }))).toEqual({
      text: count('Product', `NOT EXISTS (SELECT 1 ${review} AND ((t1."author") COLLATE "pg_catalog"."C" IS DISTINCT FROM $1::text) AND NOT ((t1."author") COLLATE "pg_catalog"."C" IS DISTINCT FROM $2::text))`), values: ['hidden', 'x'],
    });
  });
  it.each(['ANY', 'NONE'])('pins %s alone byte-equal to collection emptiness', (quantifier) => {
    for (const scope of [null, pred('author', 'NE', 'hidden')]) {
      const statement = compile(frame('reviews', null, { quantifier, scope }));
      const empty = compile(pred('reviews', quantifier === 'ANY' ? 'IS_NOT_EMPTY' : 'IS_EMPTY', null, { scopes: { reviews: scope } }));
      expect(statement).toEqual(empty);
      expect(statement.text).not.toContain('AND TRUE');
    }
  });
  it.each(['ANY', 'NONE'])('pins scoped %s alone byte-equal to reference emptiness', (quantifier) => {
    const scope = pred('name', 'NE', 'S2');
    expect(compile(frame('shop', null, { quantifier, scope }))).toEqual(compile(pred('shop', quantifier === 'ANY' ? 'IS_NOT_EMPTY' : 'IS_EMPTY', null, { scopes: { shop: scope } })));
    expect(compile(frame('shop', null, { quantifier })).text).toContain('SELECT 1 FROM "app"."QfShop" t1 WHERE t1."id" = t0."shop"');
  });
  it('keeps ALL alone TRUE, including an OR branch', () => {
    expect(compile(frame('reviews', null, { quantifier: 'ALL' }))).toEqual({ text: count('Product', 'TRUE'), values: [] });
    expect(compile({ kind: 'or', terms: [frame('reviews', null, { quantifier: 'ALL' }), pred('name')] })).toEqual({
      text: count('Product', '(TRUE OR ((t0."name") COLLATE "pg_catalog"."C" = $1::text))'), values: ['x'],
    });
  });
  it('pins nested frames and element-relative aliases', () => {
    expect(compile(frame('products', frame()), 'Shop')).toEqual({ text: count('Shop', 'EXISTS (SELECT 1 FROM "app"."QfProduct" t1 WHERE t1."shop" = t0."id" AND (EXISTS (SELECT 1 FROM "app"."QfReview" t2 WHERE t2."productId" = t1."id" AND (t2."rating" >= $1::integer))))'), values: [4] });
  });
  it('pins reference frames with nested collections', () => {
    expect(compile(frame('shop', frame('products', pred('stock', 'EQ', 5)), { quantifier: 'NONE' }))).toEqual({
      text: count('Product', 'NOT EXISTS (SELECT 1 FROM "app"."QfShop" t1 WHERE t1."id" = t0."shop" AND (EXISTS (SELECT 1 FROM "app"."QfProduct" t2 WHERE t2."shop" = t1."id" AND (t2."stock" = $1::integer))))'), values: [5],
    });
  });
  it('pins scoped references before a frame in the outer FROM', () => {
    expect(compile(frame('shop.products', pred('stock', 'EQ', 5), { joins: { shop: pred('name', 'NE', 'S2') } }))).toEqual({
      text: count('Product', 'EXISTS (SELECT 1 FROM "app"."QfProduct" t3 WHERE t3."shop" = t1."id" AND (t3."stock" = $2::integer))', 'LEFT JOIN LATERAL (SELECT t2.* FROM "app"."QfShop" t2 WHERE t2."id" = t0."shop" AND ((t2."name") COLLATE "pg_catalog"."C" IS DISTINCT FROM $1::text) LIMIT 1) t1 ON TRUE'), values: ['S2', 5],
    });
  });
  it('pins scoped references inside the frame FROM', () => {
    expect(compile(frame('products', pred('pro.name', 'EQ', 'P2', { joins: { pro: pred('name', 'NE', 'P2') } })), 'Shop')).toEqual({
      text: count('Shop', 'EXISTS (SELECT 1 FROM "app"."QfProduct" t1 LEFT JOIN LATERAL (SELECT t3.* FROM "app"."QfPro" t3 WHERE t3."id" = t1."pro" AND ((t3."name") COLLATE "pg_catalog"."C" IS DISTINCT FROM $1::text) LIMIT 1) t2 ON TRUE WHERE t1."shop" = t0."id" AND ((t2."name") COLLATE "pg_catalog"."C" = $2::text))'), values: ['P2', 'P2'],
    });
  });
  it('pins an anchored frame sharing plain groupId reference joins', () => {
    const result = compile(frame('products', pred('name', 'EQ', 'Ka'), { anchor: ['products', 'pro', 'shop'] }), 'Shop', { mode: 'aggregate', aggregation: { groupId: ['products', 'key'], facts: [{ path: ['id'], operation: 'COUNT', factName: 'n' }] } });
    expect(result.text).toBe('SELECT * FROM (SELECT (t1."key") COLLATE "pg_catalog"."C" AS "groupId", count(*) AS "fact_0" FROM "app"."QfShop" t0 LEFT JOIN "app"."QfProduct" t1 ON t1."shop" = t0."id" LEFT JOIN "app"."QfPro" t2 ON t2."id" = t1."pro" LEFT JOIN "app"."QfShop" t3 ON t3."id" = t2."shop" WHERE (EXISTS (SELECT 1 FROM "app"."QfProduct" t4 WHERE t4."shop" = t3."id" AND ((t4."name") COLLATE "pg_catalog"."C" = $1::text))) GROUP BY (t1."key") COLLATE "pg_catalog"."C") aggregated ORDER BY "groupId" ASC NULLS FIRST');
    expect(result.values).toEqual(['Ka']);
  });
  it('plans shorthand and explicit forms to the same statement', () => {
    const make = (args) => compileQuery(models, database, createQueryPlan(models, 'QfProduct', args));
    expect(make({ reviews: { terms: [{ path: 'rating', operator: 'GTE', value: 4 }] } })).toEqual(compile(frame(), 'Product', { mode: 'find', pagination: { limit: 100, offset: 0 } }));
    expect(make({ AND: [{ ANY: [{ path: 'reviews', conditions: [{ field: 'rating', operator: 'GTE', value: 4 }] }] }] })).toEqual(make({ reviews: { terms: [{ path: 'rating', operator: 'GTE', value: 4 }] } }));
  });
  it.each([['EQ', 'IS NOT DISTINCT FROM', 'x'], ['IN', 'COALESCE', ['x']], ['NIN', 'COALESCE', ['x']]])('keeps ALL %s two-valued', (operator, expected, value) => {
    const result = compile(frame('reviews', pred('author', operator, value), { quantifier: 'ALL' }));
    expect(result.text).toContain(expected);
    expect(result.text).toContain('AND NOT (');
    expect(result.values).toEqual([value]);
  });
  it.each([['olines', 'UNSUPPORTED_QUERY'], ['odim', 'INVALID_FILTER_PATH']])('classifies the hand-built terminal path %s as %s', (path, expected) => {
    const error = caught(() => compile(frame(path, null)));
    expect(error?.extensions, error?.stack).toMatchObject({ code: expected, status: 400 });
  });
  it.each(['name', 'tags', 'ownerId'])('rejects the hand-built scalar terminal %s, including inferred inverse IDs', (path) => {
    const error = caught(() => compileQuery(inverseModels, inverseDatabase, { entity: 'QfiCard', mode: 'count', where: frame(path, null), sort: [] }));
    expect(error?.extensions, error?.stack).toMatchObject({ code: 'INVALID_FILTER_PATH', status: 400 });
  });
  it('accepts a planner-generated implicit frame through an embedded-list prefix', () => {
    const query = createQueryPlan(models, 'QfProduct', { AND: [{ conditions: [{ field: 'olines.shop.products.name', operator: 'EQ', value: 'Ka' }] }] });
    expect(query.where).toMatchObject({ kind: 'quantified', path: ['olines', 'shop', 'products'] });
    const result = compileQuery(models, database, query);
    expect(result.text).toContain('EXISTS (SELECT 1 FROM "app"."QfProduct"');
    expect(result.text).toContain('LEFT JOIN "app"."QfShop"');
    expect(result.text).toContain('= ANY (ARRAY(');
    expect(result.values).toEqual(['Ka', 100, 0]);
  });
  it('rejects an unknown hand-built quantifier', () => {
    expect(caught(() => compile(frame('reviews', null, { quantifier: 'SOME' })))?.extensions).toMatchObject({ code: 'INVALID_FILTER_VALUE', status: 400 });
  });
  it('checks 400 path/value errors before malformed client joins', () => {
    const error = caught(() => compile(frame('products', pred('pro.name', 'GT', null, { joins: {} })), 'Shop'));
    expect(error?.extensions).toMatchObject({ code: 'INVALID_FILTER_VALUE', status: 400 });
  });
  it.each(['find', 'count'])('rejects a hand-built collection sort in %s', (mode) => {
    expect(caught(() => compile(null, 'Product', { mode, sort: [{ path: ['reviews', 'rating'], order: 'ASC' }] }))?.extensions).toMatchObject({ code: 'INVALID_FILTER_PATH', status: 400 });
  });
  it('does not share scoped chains with trusted joins before a frame', () => {
    const result = compile(frame('pro.shop.products', pred('stock', 'EQ', 5), { joins: { pro: pred('name', 'NE', 'P2'), 'pro.shop': null } }));
    expect(result.text).toContain('LEFT JOIN LATERAL (SELECT t2.*');
    expect(result.text).toContain('LEFT JOIN LATERAL (SELECT t4.*');
    expect(result.text).toContain('t4."id" = t1."shop"');
    expect(result.text).toContain('t5."shop" = t3."id"');
    expect(result.values).toEqual(['P2', 5]);
  });
  it('preserves every vector reference after a restricted prefix inside a frame', () => {
    const result = compile(frame('reviews', pred('product.olines.shop.name', 'EQ', 'S1', { joins: { product: pred('name', 'NE', 'hidden'), 'product.olines.shop': null } })));
    expect(result.text).toContain('LEFT JOIN LATERAL (SELECT t3.* FROM "app"."QfProduct" t3');
    expect(result.text).toContain('LEFT JOIN "app"."QfShop" t6 ON t6."id" = ANY (ARRAY(');
    expect(result.text).not.toContain('SELECT t7.* FROM "app"."QfShop" t7');
    expect(result.values).toEqual(['hidden', 'S1']);
  });
  it('rejects a non-null scope on a vector reference in a hand-built frame', () => {
    const error = caught(() => compile(frame('reviews', pred('product.olines.shop.name', 'EQ', 'S1', { joins: { product: pred('name', 'NE', 'hidden'), 'product.olines.shop': pred('name', 'NE', 'S2') } }))));
    expect(error?.extensions).toMatchObject({ code: 'FORBIDDEN_FILTER_PATH', status: 403 });
  });
  const malformed = [
    ['missing crossing', { joins: {} }], ['undefined crossing', { joins: { shop: undefined } }],
    ['non-object joins', { joins: [] }], ['malformed crossing', { joins: { shop: false } }],
    ['malformed scope', { scope: { kind: 'unknown' } }], ['undefined scope', { scope: undefined }],
    ['anchor joins', { anchor: ['shop'], joins: { shop: null }, path: ['products'] }],
  ];
  it.each(malformed)('rejects hand-built quantified %s before crossing', (label, extra) => {
    const error = caught(() => compile(frame('shop.products', null, extra)));
    expect(error?.extensions).toMatchObject({ code: 'DETACHED_CLIENT_FILTER', status: 500 });
    expect(error.message).toContain('only createQueryPlan writes the scopes of a predicate');
  });
  it.each([{}, { shop: undefined }, { shop: false }, []])('rejects malformed predicate joins %j', (joins) => {
    expect(caught(() => compile(frame('products', pred('shop.name', 'EQ', 'x', { joins })), 'Shop'))?.extensions).toMatchObject({ code: 'DETACHED_CLIENT_FILTER', status: 500 });
  });
  it('accepts absent scope and joins as trusted', () => {
    const trusted = frame('shop.products', pred('stock', 'EQ', 5));
    delete trusted.scope;
    expect(compile(trusted).text).toContain('LEFT JOIN "app"."QfShop" t1');
    expect(compile(trusted).text).toContain('EXISTS (SELECT 1');
  });
  it('rejects collections in hand-built sort paths', () => {
    expect(caught(() => compile(null, 'Product', { mode: 'find', sort: [{ path: ['reviews', 'rating'], order: 'ASC' }] }))?.extensions).toMatchObject({ code: 'INVALID_FILTER_PATH', status: 400 });
  });
  it.each([1, 'true', {}, []])('validates plugin quantifiers %j', (quantifiers) => {
    expect(caught(() => bindPlugin({ ...postgresPlugin(), queryFeatures: { ...postgresPlugin().queryFeatures, quantifiers } }))?.extensions).toMatchObject({ code: 'INVALID_SQL_PLUGIN', status: 400 });
  });
  it.each([false, null, undefined])('pin: leaves quantifiers undeclared for %s', (quantifiers) => {
    const plugin = postgresPlugin();
    expect(bindPlugin({ ...plugin, queryFeatures: { ...plugin.queryFeatures, quantifiers } }).queryFeatures).toEqual({ operators: plugin.queryFeatures.operators, referenceEmptiness: true });
  });
  it('requires referenceEmptiness and binds quantifiers only to the declared compiler', () => {
    const plugin = postgresPlugin();
    expect(bindPlugin(plugin).queryFeatures.quantifiers).toBe(true);
    expect(caught(() => bindPlugin({ ...plugin, queryFeatures: { ...plugin.queryFeatures, referenceEmptiness: false, quantifiers: true } }))?.extensions).toMatchObject({ code: 'INVALID_SQL_PLUGIN', status: 400 });
    expect(bindPlugin({ ...plugin, compileQuery: () => ({ text: '', values: [] }) }).queryFeatures).not.toHaveProperty('quantifiers');
    const custom = (...args) => compileQuery(...args);
    const declared = bindPlugin({ ...plugin, compileQuery: custom, queryFeatures: { ...plugin.queryFeatures, compileQuery: custom } });
    expect(declared.queryFeatures.quantifiers).toBe(true);
    plugin.queryFeatures.quantifiers = false;
    expect(declared.queryFeatures.quantifiers).toBe(true);
  });
});

describe('phase5-native PostgreSQL operand precedence', () => {
  const At = new GraphQLScalarType({ name: 'DateTime', serialize: (value) => value });
  const Kind = new GraphQLEnumType({ name: 'NativeKind', values: { ONE: { value: 'one' }, TWO: { value: 2 } } });
  const Detail = new GraphQLObjectType({ name: 'NativeDetail', fields: { id: { type: GraphQLString } } });
  const Target = new GraphQLObjectType({ name: 'NativeTarget', fields: {
    id: { type: GraphQLString }, name: { type: GraphQLString }, rank: { type: GraphQLInt }, score: { type: GraphQLFloat }, enabled: { type: GraphQLBoolean },
    at: { type: At }, kind: { type: Kind }, tags: { type: new GraphQLList(GraphQLString) }, detail: { type: Detail, extensions: { relation: { embedded: true } } },
  } });
  const Root = new GraphQLObjectType({ name: 'NativeRoot', fields: { id: { type: GraphQLString }, owner: { type: GraphQLID }, ref: { type: Target, extensions: { relation: { embedded: false } } } } });
  const own = [{ gqltype: Root }, { gqltype: Target }, { gqltype: Detail, endpoint: false }];
  const nativeModels = describeModels(own);
  const nativeDatabase = describeDatabase(own, { schema: 'app' });
  const nativePlan = (where, extra = {}) => ({ entity: Root.name, mode: 'count', where, sort: [], ...extra });
  const native = (where) => compileQuery(nativeModels, nativeDatabase, nativePlan(where));
  it.each([
    ['String', 'name', 'EQ', 42, 'INVALID_FILTER_VALUE', 'Expected a string for name'],
    ['Int', 'rank', 'EQ', 1.5, 'INVALID_FILTER_VALUE', 'Expected a 32-bit integer for rank'],
    ['Float', 'score', 'EQ', Infinity, 'INVALID_FILTER_VALUE', 'Expected a finite number for score'],
    ['Boolean', 'enabled', 'EQ', 1, 'INVALID_FILTER_VALUE', 'Expected a boolean for enabled'],
    ['String-exposed UUID', 'id', 'EQ', 'bad', 'NOT_VALID_ID', 'Expected a UUID identifier'],
    ['Date', 'at', 'EQ', 'invalid-date', 'INVALID_FILTER_VALUE', 'Invalid date for at'],
    ['Enum', 'kind', 'EQ', 'UNKNOWN', 'INVALID_FILTER_VALUE', 'Invalid enum value for kind'],
    ['native list element', 'tags', 'IN', ['x', 42], 'INVALID_FILTER_VALUE', 'Expected a string for tags'],
    ['BTW element', 'rank', 'BTW', [1, 1.5], 'INVALID_FILTER_VALUE', 'Expected a 32-bit integer for rank'],
  ])('pin: checks native %s operands before new joins metadata', (label, field, operator, value, code, message) => {
    for (const extra of [{}, { joins: { ref: null } }, { joins: {} }]) {
      const error = caught(() => native(pred(`ref.${field}`, operator, value, extra)));
      expect(error?.extensions, error?.stack).toMatchObject({ code, status: 400 });
      expect(error.message).toBe(message);
    }
  });
  it('checks a native String operand inside a literal new quantified plan', () => {
    const error = caught(() => compile(frame('products', pred('pro.name', 'EQ', 42, { joins: {} })), 'Shop'));
    expect(error?.extensions, error?.stack).toMatchObject({ code: 'INVALID_FILTER_VALUE', status: 400 });
    expect(error.message).toBe('Expected a string for name');
  });
  it.each([{}, { ref: undefined }, [], { ref: false }])('keeps valid native operands fail-closed with malformed joins %j', (joins) => {
    expect(caught(() => native(pred('ref.name', 'EQ', 'valid', { joins })))?.extensions).toMatchObject({ code: 'DETACHED_CLIENT_FILTER', status: 500 });
  });
  it('keeps an embedded String id distinct from an entity UUID on the rejecting branch', () => {
    expect(caught(() => native(pred('ref.detail.id', 'EQ', 'plain-string', { joins: {} })))?.extensions).toMatchObject({ code: 'DETACHED_CLIENT_FILTER', status: 500 });
  });
  it('preserves exact scoped SQL and scope-before-body native Date encoding once', () => {
    const events = [];
    // Scope identity reads the date before its codec; each operand is then encoded once.
    const date = (name) => { let calls = 0; const value = new Date('2026-01-01T00:00:00Z'); value.getTime = () => { events.push(name === 'scope' && ++calls === 1 ? 'scope identity' : `${name} codec`); return Date.prototype.getTime.call(value); }; return value; };
    const scope = date('scope'); const body = date('body');
    const result = native(pred('ref.at', 'EQ', body, { joins: { ref: pred('at', 'EQ', scope) } }));
    expect(events).toEqual(['scope identity', 'scope codec', 'body codec']);
    expect(result.text).toBe('SELECT count(*) AS size FROM "app"."NativeRoot" t0 LEFT JOIN LATERAL (SELECT t2.* FROM "app"."NativeTarget" t2 WHERE t2."id" = t0."ref" AND (t2."at" = $1::timestamp with time zone) LIMIT 1) t1 ON TRUE WHERE (t1."at" = $2::timestamp with time zone)');
    expect(result.values[0]).toBe(scope); expect(result.values[1]).toBe(body); expect(result.values).toHaveLength(2);
  });
  it('preserves single metadata reads, native UUID encoding and children bind numbering', () => {
    const events = []; let reads = 0; let scopeCalls = 0;
    const scope = new Date('2026-01-01T00:00:00Z'); scope.getTime = () => { events.push(++scopeCalls === 1 ? 'scope identity' : 'scope codec'); return Date.prototype.getTime.call(scope); };
    const id = 'ABCDEFAB-0000-4000-8000-000000000001';
    const value = { get id() { events.push('body codec'); return id; } };
    const where = pred('ref.id', 'EQ', value);
    Object.defineProperty(where, 'joins', { get: () => { reads++; return { ref: pred('at', 'EQ', scope) }; } });
    const parents = ['00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003'];
    const result = compileChildrenQuery(nativeModels, nativeDatabase, nativePlan(where, { mode: 'find', pagination: { limit: 100, offset: 0 } }), { column: 'owner', ids: parents });
    expect(events).toEqual(['scope identity', 'scope codec', 'body codec']); expect(reads).toBe(1);
    expect(result.values[0]).toBe(scope);
    expect(result.values.slice(1)).toEqual([id.toLowerCase(), 100, 0, ...parents]);
    expect(result.text).toContain('t0."owner" = $5::uuid'); expect(result.text).toContain('t0."owner" = $6::uuid');
  });
  it.each([42, 'valid'])('pin: preserves ordinary illegal-scopes precedence for %s', (value) => {
    const error = caught(() => native(pred('ref.name', 'EQ', value, { scopes: {} })));
    expect(error?.extensions).toMatchObject({ code: value === 42 ? 'INVALID_FILTER_VALUE' : 'DETACHED_CLIENT_FILTER', status: value === 42 ? 400 : 500 });
  });
});

// These reads use the real runtime so every target scope and client marker is filled normally.
describe.skipIf(!uri)('PostgreSQL collection frame rows and plans', () => {
  let pool; let api; let schema; let ids; let undeclared; let directAdapter; let directModel;
  const statements = [];
  const namespace = `frames_${randomUUID().replaceAll('-', '')}`;
  const run = async (root, args, shape = 'admin', mode = 'find', context = {}) => {
    const field = schema.getQueryType().getFields()[`${types.roots[root].plural}${mode === 'aggregate' ? '_aggregate' : ''}`];
    return field.resolve(null, structuredClone(args), { shape, ...context });
  };
  beforeAll(async () => {
    if (!uri) throw new Error('SIMFINITY_POSTGRES_URI must identify the supplied PostgreSQL test database');
    pool = new pg.Pool({ connectionString: uri });
    const recordedPool = { query: (text, values) => { statements.push(text); return pool.query(text, values); }, connect: async () => { const client = await pool.connect(); return { query: (text, values) => { statements.push(text); return client.query(text, values); }, release: (...args) => client.release(...args) }; } };
    api = createPostgres({ pool: recordedPool, schema: namespace, batchedCollections: true });
    registerReferenceEmptinessTypes(api, types);
    api.use(async (params, next) => { await params.context?.middleware?.(params); await next(); });
    schema = api.createSchema();
    await api.initializeDatabase();
    ids = await seedCollectionFrames(schema, types);
    directAdapter = createSQLAdapter(postgresPlugin({ pool: recordedPool, schema: namespace }));
    directModel = directAdapter.createModel(types.Product);
    directAdapter.prepare(registrations);
    await directAdapter.initialize({ mode: 'validate' });
    const line = await graphql({ schema, source: 'mutation($input:QfReviewInputForUpdate!){updateqfReview(input:$input){id}}', variableValues: { input: { id: ids['Ka:null:x'], lines: [{ qty: 1, shop: { id: ids.S1 } }] } } });
    expect(line.errors).toBeUndefined();
    for (const table of ['Shop', 'Pro', 'Product', 'Review']) await pool.query(`ANALYZE "${namespace}"."Qf${table}"`);
    undeclared = createSQL({ plugin: { ...postgresPlugin({ pool, schema: namespace }), queryFeatures: { operators: postgresPlugin().queryFeatures.operators, referenceEmptiness: true } } });
    registerReferenceEmptinessTypes(undeclared, createTypes());
    undeclared.createSchema();
    await undeclared.initializeDatabase({ mode: 'validate' });
  }, 120000);
  afterAll(async () => {
    if (pool) { await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`); await pool.end(); }
  });
  it.each(COLLECTION_CASES.map((item) => [(['ALL alone', 'ALL alone AND neutral', 'reference inside frame EQ', 'rule 4 reference before collection', 'ALL reference shop alone', 'ALL reference pro alone'].includes(item.name) ? 'pin: returns ' : 'returns ') + item.name, item]))('%s rows and counts in every scope shape', async (name, item) => {
    for (const shape of REFERENCE_SHAPES) {
      if (item.forbidden?.includes(shape)) {
        await expect(run(item.root, item.args, shape)).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN_FILTER_PATH' } });
        continue;
      }
      const rows = await run(item.root, item.args, shape);
      expect(rows.map((row) => row.key).sort(), shape).toEqual(item.rows[shape]);
      const field = schema.getQueryType().getFields()[types.roots[item.root].plural];
      const context = { shape };
      const result = await field.resolve(null, { ...structuredClone(item.args), pagination: { count: true, size: 3, page: 1 }, sort: { terms: [{ field: 'key', order: 'ASC' }] } }, context);
      expect(result.map((row) => row.key), shape).toEqual(item.rows[shape].slice(0, 3));
      expect(context.count, shape).toBe(item.rows[shape].length);
    }
  });
  it.each(COLLECTION_AGGREGATES.map((item) => [(item.name === 'shop counts with rating frame' ? 'returns aggregate ' : 'pin: returns aggregate ') + item.name, item]))('%s with shared J joins', async (name, item) => {
    const filter = !item.filter ? {} : item.filter === 'twoGroups'
      ? { AND: [{ conditions: [{ field: 'reviews.rating', operator: 'GTE', value: 4 }] }, { conditions: [{ field: 'reviews.author', value: 'x' }] }] }
      : { AND: [{ conditions: [{ field: 'reviews.rating', operator: 'GTE', value: item.filter === 'rating1' ? 1 : 5 }] }] };
    for (const shape of REFERENCE_SHAPES) {
      const pending = run('product', { ...filter, aggregation: { groupId: item.groupId, facts: item.facts } }, shape, 'aggregate');
      if (item.forbidden?.includes(shape)) { await expect(pending).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN_FILTER_PATH' } }); continue; }
      const result = await pending;
      expect(result.map((row) => [row.groupId, ...item.facts.map((fact) => row.facts[fact.factName])]).sort((a, b) => String(a[0] ?? '').localeCompare(String(b[0] ?? ''))), shape).toEqual(item.rowsByShape[shape]);
    }
  });
  it('keeps anchored frames on the legacy groupId alias, including references after J', async () => {
    for (const [key, field, value] of [['reviewsPerProduct', 'products.reviews.rating', 1], ['referenceChain', 'products.pro.shop.products.name', 'Ka']]) {
      for (const shape of REFERENCE_SHAPES) {
        const rows = await run('shop', { aggregation: { groupId: 'products.key', facts: [{ path: 'id', operation: 'COUNT', factName: 'n' }] }, AND: [{ conditions: [{ field, operator: key === 'reviewsPerProduct' ? 'GTE' : 'EQ', value }] }] }, shape, 'aggregate');
        expect(rows.map((row) => [row.groupId, row.facts.n]).sort(), `${key} ${shape}`).toEqual(COLLECTION_ANCHOR_ROWS[key][shape]);
      }
    }
  });
  it('keeps explicit ALL on J per record and its inner collection a frame', async () => {
    for (const shape of REFERENCE_SHAPES) {
      const pending = run('shop', { aggregation: { groupId: 'products.reviews.author', facts: [{ path: 'id', operation: 'COUNT', factName: 'n' }] }, AND: [{ ALL: [{ path: 'products', conditions: [{ field: 'reviews.rating', operator: 'GTE', value: 5 }] }] }] }, shape, 'aggregate');
      if (COLLECTION_ANCHOR_ROWS.universalProducts.forbidden.includes(shape)) await expect(pending).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN_FILTER_PATH' } });
      else expect((await pending).map((row) => row.groupId)).toEqual(COLLECTION_ANCHOR_ROWS.universalProducts[shape].length ? ['hidden', 'x'] : []);
    }
  });
  it('rejects explicit forms on an undeclared SQL plugin before middleware', async () => {
    let calls = 0;
    undeclared.use(async (params, next) => { calls++; await next(); });
    const ownSchema = undeclared.createSchema();
    for (const quantifier of ['ANY', 'NONE', 'ALL']) {
      const result = await graphql({ schema: ownSchema, source: `query{qfProducts(AND:[{${quantifier}:[{path:"reviews"}]}]){key}}` });
      expect(result.errors?.[0]?.extensions.code).toBe('UNSUPPORTED_QUERY');
    }
    expect(calls).toBe(0);
  });
  it('reads ANY/NONE/ALL collection children in one batch with their expected rows and the same rows as individual parents', async () => {
    const children = types.Shop.getFields().products;
    for (const quantifier of ['ANY', 'NONE', 'ALL']) for (const shape of REFERENCE_SHAPES) {
      const expected = COLLECTION_CASES.find((item) => item.name === `${quantifier} rating GTE 4`).rows[shape];
      const shopOf = { Ka: 'S1', E: 'S1', F: 'S1', c: 'S2', D: 'S3' };
      const args = { reviews: { quantifier, terms: [{ path: 'rating', operator: 'GTE', value: 4 }] } };
      statements.length = 0;
      const result = await graphql({ schema, source: 'query($f:QLTypeFilterExpression){qfShops(sort:{terms:[{field:"key",order:ASC}]}){key products(reviews:$f){key}}}', variableValues: { f: args.reviews }, contextValue: { shape } });
      expect(result.errors).toBeUndefined();
      expect(statements.filter((text) => text.includes(' UNION ALL ') && text.includes('"__simfinity_parent"'))).toHaveLength(result.data.qfShops.length > 1 ? 1 : 0);
      for (const shop of result.data.qfShops) {
        expect(shop.products.map((row) => row.key).sort(), `${quantifier} ${shape} ${shop.key}`).toEqual(expected.filter((key) => shopOf[key] === shop.key));
        const alone = await children.resolve({ id: ids[shop.key], _id: ids[shop.key] }, structuredClone(args), { shape });
        expect(shop.products.map((row) => row.key).sort()).toEqual(alone.map((row) => row.key).sort());
      }
    }
  });
  it('preserves mixed trust in a shared frame and independent trusted groups', async () => {
    const args = { reviews: { terms: [{ path: 'rating', operator: 'GTE', value: 4 }] } };
    const same = await run('product', args, 'NE', 'find', { middleware: ({ args: current, type }) => {
      if (type.gqltype === types.Product) current.reviews.terms.push({ path: 'author', value: 'hidden' });
    } });
    expect(same.map((row) => row.key)).toEqual([]);
    const separate = await run('product', args, 'NE', 'find', { middleware: ({ args: current, type }) => {
      if (type.gqltype === types.Product) current.AND = [{ conditions: [{ field: 'reviews.author', value: 'hidden' }] }];
    } });
    expect(separate.map((row) => row.key)).toEqual(['E']);
  });
  it('reads trusted frames from query and get_by_id scopes beside client frames', async () => {
    const ownScope = ({ args }) => { args.reviews = { terms: [{ path: 'author', operator: 'NE', value: 'hidden' }] }; };
    expect((await run('product', {}, 'NE', 'find', { ownScope })).map((row) => row.key).sort()).toEqual(['D', 'E', 'Ka']);
    const get = schema.getQueryType().getFields()[types.roots.product.single];
    expect(await get.resolve(null, { id: ids.C }, { shape: 'NE', ownScope })).toBeNull();
    expect((await get.resolve(null, { id: ids.D }, { shape: 'NE', ownScope })).key).toBe('D');
  });
  it.each(['find', 'aggregate'])('reads references inside embedded lists within a frame in %s and rejects a scoped target', async (mode) => {
    const args = { AND: [{ conditions: [{ field: 'reviews.lines.shop.name', value: 'S1' }] }], ...(mode === 'aggregate' ? { aggregation: { groupId: 'key', facts: [{ path: 'id', factName: 'n', operation: 'COUNT' }] } } : {}) };
    for (const shape of REFERENCE_SHAPES) {
      statements.length = 0;
      const pending = run('product', args, shape, mode);
      if (['NE', 'EQ', 'shopNE', 'shopEQ'].includes(shape)) await expect(pending).rejects.toMatchObject({ extensions: { code: 'FORBIDDEN_FILTER_PATH' } });
      else {
        expect((await pending).map((row) => mode === 'aggregate' ? row.groupId : row.key)).toEqual(['Ka']);
        expect(statements.some((text) => text.includes(`EXISTS (SELECT 1 FROM "${namespace}"."QfReview"`))).toBe(true);
      }
    }
  });
  it('preserves rows for every vector target after a restricted prefix inside a frame', async () => {
    const replaceLines = async (lines) => {
      const result = await graphql({ schema, source: 'mutation($input:QfProductInputForUpdate!){updateqfProduct(input:$input){id}}', variableValues: { input: { id: ids.Ka, olines: lines } } });
      expect(result.errors).toBeUndefined();
    };
    try {
      await replaceLines([{ qty: 1, shop: { id: ids.S1 } }, { qty: 2, shop: { id: ids.S3 } }]);
      for (const name of ['S1', 'S3']) {
        const condition = frame('reviews', pred('product.olines.shop.name', 'EQ', name, { joins: { product: pred('name', 'NE', 'hidden'), 'product.olines.shop': null } }));
        const statement = compileQuery(models, { ...database, schema: namespace }, plan({ kind: 'and', terms: [pred('id', 'EQ', ids.Ka), condition] }));
        const { rows } = await pool.query(statement.text, statement.values.map(encodeParameter));
        expect(rows[0].size, name).toBe('1');
      }
    } finally { await replaceLines([{ qty: 1, shop: { id: ids.S1 } }, { qty: 9 }]); }
  });
  // Round1 uses generated writes in this suite's disposable schema; every temporary root/child is removed.
  const withVectorRows = async (linesByChild, check) => {
    const children = [];
    const mutate = async (type, input, update = false) => {
      const result = await graphql({ schema, source: `mutation($input:${type}Input${update ? 'ForUpdate' : ''}!){${update ? 'update' : 'add'}${type[0].toLowerCase() + type.slice(1)}(input:$input){id key}}`, variableValues: { input } });
      expect(result.errors).toBeUndefined();
      return Object.values(result.data)[0];
    };
    const root = await mutate('QfProduct', { key: 'round1-root', name: 'round1-root', olines: [{ qty: 1, shop: { id: ids.S1 } }, { qty: 2, shop: { id: ids.S3 } }] });
    try {
      for (const [index, lines] of linesByChild.entries()) {
        const child = await mutate('QfReview', { key: `round1-child-${index}`, author: 'round1', rating: 5, product: { id: root.id }, ...(lines === undefined ? {} : { lines }) });
        children.push(child);
      }
      await check(root, children);
    } finally {
      for (const [single, id] of [...children.map((child) => ['qfReview', child.id]), ['qfProduct', root.id]]) {
        const result = await graphql({ schema, source: `mutation($id:ID!){delete${single}(id:$id){id}}`, variableValues: { id } });
        expect(result.errors).toBeUndefined();
      }
    }
  };
  const mixedLines = () => [{ qty: 1, shop: { id: ids.S1 } }, { qty: 2, shop: { id: ids.S3 } }];
  const vectorCondition = (field = 'name', value = 'S3', operator = 'EQ') => ({ field: `lines.shop.${field}`, value, operator });
  const frameArgs = (root, quantifier, conditions) => ({ id: { value: root.id }, AND: [{ [quantifier]: [{ path: 'reviews', ...(conditions === null ? {} : { conditions }) }] }] });
  const assertRoot = async (root, args, expected, context = {}, { frame = true, rootKind = 'product' } = {}) => {
    statements.length = 0;
    const rows = await run(rootKind, args, 'admin', 'find', context);
    if (frame) expect(statements.some((sql) => sql.includes(`EXISTS (SELECT 1 FROM "${namespace}"."QfReview"`) || sql.includes(`EXISTS (SELECT 1 FROM "${namespace}"."QfProduct"`)), 'the frame must be compiled, including on the actual baseline').toBe(true);
    expect(rows.map((row) => row.key)).toEqual(Array.from({ length: expected }, () => root.key));
    const field = schema.getQueryType().getFields()[types.roots[rootKind].plural];
    for (const page of [1, 2, 3]) {
      const own = { shape: 'admin', ...context };
      const result = await field.resolve(null, { ...structuredClone(args), pagination: { count: true, size: 1, page }, sort: { terms: [{ field: 'key', order: 'ASC' }] } }, own);
      expect(result.map((row) => row.key), `page ${page}`).toEqual(page <= expected ? [root.key] : []);
      expect(own.count, `count on page ${page}`).toBe(expected);
    }
  };
  it.each(['ANY', 'NONE', 'ALL'])('round1 evaluates the complete positive mixed-vector child body for %s', async (quantifier) => {
    await withVectorRows([mixedLines()], async (root) => {
      await assertRoot(root, frameArgs(root, quantifier, [vectorCondition()]), quantifier === 'NONE' ? 0 : 1);
    });
  });
  it('pin: round1 positive child vector query retains its original witness semantics', async () => {
    await withVectorRows([mixedLines()], async (root, [child]) => {
      const rows = await run('review', { id: { value: child.id }, AND: [{ conditions: [vectorCondition()] }] });
      expect(rows.map((row) => row.key)).toEqual([child.key]);
    });
  });
  it.each([
    ['same target', [vectorCondition('name', 'S1'), vectorCondition('state', 'OPEN')], 1],
    ['different targets', [vectorCondition(), vectorCondition('state', 'OPEN')], 0],
  ])('round1 keeps the complete ALL body correlated on the %s', async (label, conditions, expected) => {
    await withVectorRows([mixedLines()], async (root) => { await assertRoot(root, frameArgs(root, 'ALL', conditions), expected); });
  });
  it('round1 rejects a real failing child despite another mixed-vector child', async () => {
    await withVectorRows([mixedLines(), [{ qty: 1, shop: { id: ids.S1 } }]], async (root) => {
      await assertRoot(root, frameArgs(root, 'ALL', [vectorCondition()]), 0);
    });
  });
  it.each([
    ['childless', [], 'S3', 1], ['missing list', [undefined], 'S3', 0], ['null list', [null], 'S3', 0],
    ['empty list', [[]], 'S3', 0], ['missing reference', [[{ qty: 1 }]], 'S3', 0],
    ['missing reference equals null', [[{ qty: 1 }]], null, 1],
  ])('round1 retains ALL %s semantics', async (label, lines, value, expected) => {
    await withVectorRows(lines, async (root) => { await assertRoot(root, frameArgs(root, 'ALL', [vectorCondition('name', value)]), expected); });
  });
  it('round1 keeps ALL vector witnesses after a restricted single-reference prefix', async () => {
    await withVectorRows([mixedLines()], async (root) => {
      const ownScope = ({ args }) => { args.AND = [...(args.AND ?? []), { conditions: [{ field: 'name', operator: 'NE', value: 'hidden' }] }]; };
      await assertRoot(root, frameArgs(root, 'ALL', [{ field: 'product.olines.shop.name', value: 'S3' }]), 1, { ownScope });
      expect(statements.some((sql) => sql.includes('LEFT JOIN LATERAL'))).toBe(true);
    });
  });
  it.each([
    ['zero', ['absent'], 0], ['one', ['Ka'], 1], ['two', ['Ka', 'D'], 1],
  ])('round1 keeps a collection after %s matching vector-prefix targets one boolean', async (label, names, expected) => {
    await withVectorRows([], async (root) => {
      await assertRoot(root, { id: { value: root.id }, AND: [{ conditions: [{ field: 'olines.shop.products.name', operator: 'IN', value: names }] }] }, expected);
    });
  });
  it('round1 keeps a vector-prefix collection boolean after a restricted reference', async () => {
    await withVectorRows([mixedLines()], async (root, [child]) => {
      const ownScope = ({ args }) => { args.AND = [...(args.AND ?? []), { conditions: [{ field: 'name', operator: 'NE', value: 'hidden' }] }]; };
      await assertRoot(child, { id: { value: child.id }, AND: [{ conditions: [{ field: 'product.olines.shop.products.name', operator: 'IN', value: ['Ka', 'D'] }] }] }, 1, { ownScope }, { rootKind: 'review' });
      expect(statements.some((sql) => sql.includes('LEFT JOIN LATERAL'))).toBe(true);
    });
  });
  it('pin: round1 keeps legacy vector-only list/count/page multiplicity', async () => {
    await withVectorRows([], async (root) => {
      await assertRoot(root, { id: { value: root.id }, AND: [{ conditions: [{ field: 'olines.shop.name', operator: 'IN', value: ['S1', 'S3'] }] }] }, 2, {}, { frame: false });
    });
  });
  const reviewVisibility = (conditions) => ({ args }) => { args.AND = [...(args.AND ?? []), { conditions }]; };
  it.each(['ANY', 'NONE', 'ALL'])('round1 separates runtime-filled scope and body vector witnesses for %s', async (quantifier) => {
    await withVectorRows([mixedLines()], async (root) => {
      await assertRoot(root, frameArgs(root, quantifier, [vectorCondition()]), quantifier === 'NONE' ? 0 : 1, { reviewScope: reviewVisibility([vectorCondition('name', 'S1')]) });
    });
  });
  it.each([
    ['scope only', null, [vectorCondition('name', 'S1')], 1],
    ['body only', [vectorCondition()], null, 1],
    ['same-target scope and separate body', [vectorCondition()], [vectorCondition('name', 'S1'), vectorCondition('state', 'OPEN')], 1],
    ['different-target scope', [vectorCondition()], [vectorCondition(), vectorCondition('state', 'OPEN')], 0],
    ['same-target body and separate scope', [vectorCondition('name', 'S1'), vectorCondition('state', 'OPEN')], [vectorCondition()], 1],
    ['different-target body', [vectorCondition(), vectorCondition('state', 'OPEN')], [vectorCondition('name', 'S1')], 0],
  ])('round1 preserves complete independent %s membership', async (label, body, scope, expected) => {
    await withVectorRows([mixedLines()], async (root) => {
      await assertRoot(root, frameArgs(root, 'ANY', body), expected, scope ? { reviewScope: reviewVisibility(scope) } : {});
    });
  });

  const directRows = async (args, expected) => {
    const model = api.getModel(types.Product);
    const before = structuredClone(args);
    const sort = { terms: [{ field: 'key', order: 'ASC' }] };
    expect((await model.find({ ...args, sort })).map((row) => row.key)).toEqual(expected);
    expect(await directAdapter.count(directModel, types.Product, args)).toBe(expected.length);
    for (let page = 1; page <= expected.length + 1; page++) {
      const rows = await model.find({ ...args, sort, pagination: { page, size: 1 } });
      expect(rows.map((row) => row.key), `native page ${page}`).toEqual(expected.slice(page - 1, page));
    }
    expect(args).toEqual(before);
  };
  it('phase5 L3-1 native scalar collection filters keep roots/count/pages unique', async () => {
    await directRows({ 'reviews.rating': { operator: 'GTE', value: 1 } }, ['D', 'E', 'Ka', 'c']);
  });
  it('phase5 L3-1 native default EQ ignores scalar terms and uses the actual carrier', async () => {
    await directRows({ 'reviews.author': { value: 'x', terms: [{ path: 'invalid..ignored', operator: 'FUTURE' }] } }, ['D', 'E', 'Ka']);
  });
  it.each([['EQ', null, ['Ka']], ['NE', 1, ['D', 'E', 'Ka']]])('phase5 L3-1 native %s excludes empty collections while preserving null child values', async (operator, value, expected) => {
    await directRows({ 'reviews.rating': { operator, value } }, expected);
  });
  it('phase5 L3-1 native scalar entries and adjacent relation/AND filters keep separate witnesses', async () => {
    const args = { 'reviews.rating': { operator: 'GTE', value: 4 }, 'reviews.author': { value: 'hidden' },
      reviews: { terms: [{ path: 'author', value: 'x' }] }, AND: [{ conditions: [{ field: 'reviews.rating', operator: 'LT', value: 2 }] }] };
    await directRows(args, ['D', 'E']);
  });
  it('phase5 L3-1 native aggregate scalar frame anchors after joined reviews and product', async () => {
    const args = { 'reviews.product.reviews.rating': { operator: 'GTE', value: 1 }, aggregation: { groupId: 'reviews.author', facts: [{ path: 'id', operation: 'COUNT', factName: 'n' }] } };
    const rows = await directAdapter.aggregate(directModel, types.Product, args);
    expect(rows.map((row) => [row.groupId, row.facts.n]).sort()).toEqual([['hidden', 3], ['x', 4]]);
  });
  it('pin: phase5 L3-1 native reference-only, disabled and all-J collection filters retain their legacy results', async () => {
    const sort = { terms: [{ field: 'key', order: 'ASC' }] };
    expect((await api.getModel(types.Product).find({ 'shop.name': { value: 'S1', terms: [{ path: 'ignored' }] }, sort })).map((row) => row.key)).toEqual(['E', 'F', 'Ka']);
    expect((await undeclared.getModel(types.Product).find({ 'reviews.rating': { operator: 'GTE', value: 1 }, sort })).map((row) => row.key)).toEqual(['D', 'D', 'E', 'E', 'Ka', 'c']);
    const args = { 'reviews.rating': { operator: 'GTE', value: 1 }, aggregation: { groupId: 'reviews.author', facts: [{ path: 'id', operation: 'COUNT', factName: 'n' }] } };
    const rows = await directAdapter.aggregate(directModel, types.Product, args);
    expect(rows.map((row) => [row.groupId, row.facts.n]).sort()).toEqual([['hidden', 3], ['x', 3]]);
  });

  const explain = async (statement) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const setting of ['enable_seqscan', 'enable_hashjoin', 'enable_mergejoin', 'enable_material']) await client.query(`SET LOCAL ${setting} = off`);
      const { rows } = await client.query(`EXPLAIN (FORMAT JSON) ${statement.text}`, statement.values.map(encodeParameter));
      const parsed = rows[0]['QUERY PLAN'];
      return nodes((typeof parsed === 'string' ? JSON.parse(parsed) : parsed)[0].Plan);
    } finally { await client.query('ROLLBACK'); client.release(); }
  };
  // Restrict the candidate root for these probe checks: an unconstrained ANY can reverse the
  // semi-join and scan children before probing parent primary keys. These verify per-candidate probes.
  const physical = (where, entity = 'Product', extra = {}) => compileQuery(models, { ...database, schema: namespace }, plan({ kind: 'and', terms: [pred('id', 'EQ', ids[entity === 'Shop' ? 'S1' : 'Ka']), where] }, entity, { mode: 'find', ...extra }));
  it.each(['ANY', 'NONE', 'ALL'])('probes connection indexes with a %s semi/anti frame', async (quantifier) => {
    const statement = physical(frame('reviews', pred('rating', 'GTE', 4), { quantifier }));
    expect(statement.text).toContain('EXISTS (SELECT 1');
    const result = await explain(statement);
    expect(result.some((node) => node['Join Type'] === (quantifier === 'ANY' ? 'Semi' : 'Anti')) || statement.text.includes('EXISTS (SELECT 1')).toBe(true);
    expect(result.some((node) => node['Index Name'] === 'QfReview__productId__idx' && (node['Index Cond']?.includes('t0.id') || node['Index Cond']?.includes(ids.Ka)))).toBe(true);
  });
  it('probes nested frames, reference before frame, scoped LATERAL, OR and scoped NONE in every batch branch', async () => {
    for (const [where, entity, indexes, allowHashed = false] of [
      [frame('products', frame()), 'Shop', ['QfProduct__shop__idx', 'QfReview__productId__idx']],
      [frame('shop.products', pred('stock', 'EQ', 5)), 'Product', ['QfShop__pk', 'QfProduct__shop__idx']],
      [frame('products', pred('pro.name', 'EQ', 'P2', { joins: { pro: pred('name', 'NE', 'P2') } })), 'Shop', ['QfProduct__shop__idx', 'QfPro__pk']],
      [{ kind: 'or', terms: [frame(), pred('name')] }, 'Product', ['QfReview__productId__idx'], true],
    ]) {
      const statement = physical(where, entity);
      expect(statement.text).toContain('EXISTS (SELECT 1');
      const result = await explain(statement);
      const hashed = new Set(allowHashed ? hashedNodes(result[0]).filter((node) => indexes.some((index) => node['Relation Name'] === index.split('__')[0])) : []);
      expect(result.filter((node) => node['Node Type'] === 'Seq Scan' && !/^t0(?:_\d+)?$/.test(node.Alias) && !hashed.has(node)), `${statement.text}: ${JSON.stringify(result[0])}`).toEqual([]);
      for (const index of indexes) expect(result.some((node) => node['Index Name'] === index && node['Index Cond']) || [...hashed].some((node) => node['Relation Name'] === index.split('__')[0]), `${index}: ${JSON.stringify(result[0])}`).toBe(true);
    }
    const statement = compileChildrenQuery(models, { ...database, schema: namespace }, plan(frame('reviews', pred('product.name', 'EQ', 'Ka', { joins: { product: pred('name', 'NE', 'hidden') } }), { quantifier: 'NONE' }), 'Product', { mode: 'find', pagination: { limit: 100, offset: 0 } }), { column: 'shop', ids: ['S1', 'S2', 'S3'].map((key) => ids[key]) });
    expect(statement.text.match(/NOT EXISTS \(SELECT 1/g)).toHaveLength(3);
    const result = await explain(statement);
    expect(result.filter((node) => node['Index Name'] === 'QfReview__productId__idx').map((node) => node['Index Cond']), JSON.stringify(result[0])).toEqual(['("productId" = t0.id)', '("productId" = t0_1.id)', '("productId" = t0_2.id)']);
  });
});
