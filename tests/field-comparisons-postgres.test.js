import { GraphQLBoolean, GraphQLEnumType, GraphQLFloat, GraphQLID, GraphQLInt, GraphQLList, GraphQLObjectType, GraphQLScalarType, GraphQLString } from 'graphql';
import { describe, expect, it } from 'vitest';
import { describeModels } from '../packages/core/src/metadata.js';
import { describeDatabase } from '../packages/postgres/src/schema/describe.js';
import { compileChildrenQuery, compileQuery } from '../packages/postgres/src/query/compiler.js';
import { postgresPlugin } from '../packages/postgres/src/plugin.js';
import { bindPlugin } from '../packages/sql/src/plugin.js';

const DateTime = new GraphQLScalarType({ name: 'DateTime', serialize: (value) => value });
const Kind = new GraphQLEnumType({ name: 'FcKind', values: { FIRST: { value: 'one' }, SECOND: { value: 2 } } });
const OtherKind = new GraphQLEnumType({ name: 'FcOtherKind', values: { FIRST: { value: 'one' }, SECOND: { value: 2 } } });
const Detail = new GraphQLObjectType({ name: 'FcDetail', fields: {
  width: { type: GraphQLInt }, height: { type: GraphQLFloat }, at: { type: DateTime }, tags: { type: new GraphQLList(GraphQLString) },
} });
const Shop = new GraphQLObjectType({ name: 'FcShop', fields: () => ({ id: { type: GraphQLID }, minimum: { type: GraphQLInt }, name: { type: GraphQLString }, products: { type: new GraphQLList(Product), extensions: { relation: { embedded: false, connectionField: 'shop' } } } }) });
const Product = new GraphQLObjectType({ name: 'FcProduct', fields: () => ({
  id: { type: GraphQLString }, stock: { type: GraphQLInt }, threshold: { type: GraphQLFloat }, name: { type: GraphQLString }, suffix: { type: GraphQLString }, active: { type: GraphQLBoolean },
  tags: { type: new GraphQLList(GraphQLString) }, quantities: { type: new GraphQLList(GraphQLInt) }, at: { type: DateTime },
  kind: { type: Kind }, otherKind: { type: OtherKind }, sameKind: { type: Kind },
  detail: { type: Detail, extensions: { relation: { embedded: true } } },
  details: { type: new GraphQLList(Detail), extensions: { relation: { embedded: true } } },
  shop: { type: Shop, extensions: { relation: { embedded: false } } },
  reviews: { type: new GraphQLList(Review), extensions: { relation: { embedded: false, connectionField: 'productId' } } },
}) });
const Review = new GraphQLObjectType({ name: 'FcReview', fields: () => ({
  id: { type: GraphQLID }, productId: { type: GraphQLID }, rating: { type: GraphQLInt }, maxRating: { type: GraphQLInt },
  shop: { type: Shop, extensions: { relation: { embedded: false } } },
  product: { type: Product, extensions: { relation: { embedded: false } } },
}) });
const registrations = [Product, Shop, Review].map((gqltype) => ({ gqltype }));
const models = describeModels(registrations);
const database = describeDatabase(registrations, { schema: 'app' });
const predicate = (left = 'stock', right = 'threshold', operator = 'LT', extra = {}) => ({ kind: 'predicate', path: left.split('.'), operator, value: null, operand: { up: 0, path: right.split('.') }, ...extra });
const plan = (where, extra = {}) => ({ entity: 'FcProduct', mode: 'count', where, sort: [], ...extra });
const compile = (where, extra) => compileQuery(models, database, plan(where, extra));
const caught = (run) => { try { run(); } catch (error) { return error; } return null; };
const code = (run, expected) => expect(caught(run)?.extensions).toMatchObject({ code: expected });

describe('PostgreSQL field operands', () => {
  it('compares two stored numeric fields with two-valued ordering and no value binding', () => {
    expect(compile(predicate())).toEqual({ text: 'SELECT count(*) AS size FROM "app"."FcProduct" t0  WHERE (COALESCE(t0."stock" < t0."threshold", FALSE))', values: [] });
  });
  it.each([['EQ', 'IS NOT DISTINCT FROM'], ['NE', 'IS DISTINCT FROM']])('uses null-safe scalar %s', (operator, expected) => {
    const result = compile(predicate('name', 'suffix', operator));
    expect(result.text).toContain(`(t0."name") COLLATE "pg_catalog"."C" ${expected} (t0."suffix") COLLATE "pg_catalog"."C"`);
    expect(result.values).toEqual([]);
  });
  it.each([['LIKE', 'strpos('], ['STARTS_WITH', 'starts_with('], ['ENDS_WITH', 'right(']])('compares %s text literally and guards nulls', (operator, expected) => {
    const result = compile(predicate('name', 'suffix', operator));
    expect(result.text).toContain(`COALESCE(${expected}`);
    expect(result.text).toContain('(t0."suffix") COLLATE "pg_catalog"."C"');
    expect(result.values).toEqual([]);
  });
  it.each(['EQ', 'NE'])('normalizes list membership and its complement for %s', (operator) => {
    const result = compile(predicate('tags', 'suffix', operator));
    expect(result.text).toContain('array_position((t0."tags") COLLATE "pg_catalog"."C", (t0."suffix") COLLATE "pg_catalog"."C") IS NOT NULL');
    expect(result.text).toContain('t0."tags") COLLATE "pg_catalog"."C" IS NULL');
    expect(result.text).toContain('t0."suffix") COLLATE "pg_catalog"."C" IS NULL');
    expect(result.text.includes('NOT (')).toBe(operator === 'NE');
  });
  it('normalizes native and json temporal operands to the same epoch representation', () => {
    const result = compile(predicate('at', 'detail.at', 'LTE'));
    expect(result.text).toContain('extract(epoch FROM t0."at") * 1000');
    expect(result.text).toContain('__simfinity_date_value');
    expect(result.text).toContain('COALESCE(');
    expect(result.values).toEqual([]);
  });
  it('binds the containing frame alias for an implicit outer operand', () => {
    const result = compile({ kind: 'quantified', quantifier: 'ANY', path: ['reviews'], scope: null, where: predicate('rating', 'stock', 'LTE', { operand: { up: 1, path: ['stock'] } }) });
    expect(result.text).toContain('WHERE t1."productId" = t0."id" AND (COALESCE(t1."rating" <= t0."stock", FALSE))');
    expect(result.text).not.toContain('LEFT JOIN');
  });
  it('owns outer scoped joins in the ancestor FROM and child joins in its own FROM', () => {
    const scope = { kind: 'predicate', path: ['name'], operator: 'NE', value: 'hidden' };
    const result = compile({ kind: 'quantified', quantifier: 'ANY', path: ['reviews'], scope: null,
      where: predicate('shop.minimum', 'shop.minimum', 'LT', { joins: { shop: null }, operand: { up: 1, path: ['shop', 'minimum'], joins: { shop: scope } } }),
    });
    expect(result.text).toMatch(/FROM "app"\."FcProduct" t0 LEFT JOIN LATERAL/);
    expect(result.text).toMatch(/EXISTS \(SELECT 1 FROM "app"\."FcReview" t1 LEFT JOIN "app"\."FcShop"/);
    expect(result.values).toEqual(['hidden']);
  });
  it('requires the union of same-frame scoped joins', () => {
    code(() => compile(predicate('stock', 'shop.minimum', 'LT', { joins: {} })), 'DETACHED_CLIENT_FILTER');
    expect(compile(predicate('stock', 'shop.minimum', 'LT', { joins: { shop: null } })).text).toContain('LEFT JOIN "app"."FcShop"');
  });
  it('rejects a competing literal and malformed scope metadata on hand-built comparisons', () => {
    code(() => compile(predicate('stock', 'threshold', 'EQ', { value: 5 })), 'INVALID_FILTER_VALUE');
    code(() => compile(predicate('stock', 'threshold', 'EQ', { operand: { up: 0, path: ['threshold'], joins: {} } })), 'DETACHED_CLIENT_FILTER');
    code(() => compile(predicate('stock', 'threshold', 'EQ', { joins: { nonexistent: null } })), 'DETACHED_CLIENT_FILTER');
  });
  it('defaults an omitted hand-built comparison operator to EQ', () => {
    expect(compile({ ...predicate('name', 'suffix', 'EQ'), operator: undefined }).text).toContain('IS NOT DISTINCT FROM');
  });
  it.each([
    [{ up: -1, path: ['threshold'] }, 'INVALID_FILTER_VALUE'],
    [{ up: 0.5, path: ['threshold'] }, 'INVALID_FILTER_VALUE'],
    [{ up: 1, path: ['threshold'] }, 'INVALID_FILTER_PATH'],
    [{ up: 0, path: [] }, 'INVALID_FILTER_PATH'],
    [{ up: 0, path: ['threshold;DROP'] }, 'INVALID_FILTER_PATH'],
    [{ up: 0, path: ['missing'] }, 'INVALID_FILTER_FIELD'],
    [{ up: 0, path: ['quantities'] }, 'INVALID_FILTER_PATH'],
    [{ up: 0, path: ['details', 'width'] }, 'UNSUPPORTED_QUERY'],
    [{ up: 0, path: ['details'] }, 'INVALID_FILTER_PATH'],
    [{ up: 0, path: ['reviews', 'rating'] }, 'INVALID_FILTER_PATH'],
  ])('rejects a malformed hand-built operand %j', (operand, expected) => {
    code(() => compile(predicate('stock', 'threshold', 'EQ', { operand })), expected);
  });
  it.each([
    ['details', 'stock', 'EQ', 'INVALID_FILTER_PATH'], ['stock', 'name', 'EQ', 'INVALID_FILTER_VALUE'], ['id', 'name', 'EQ', 'INVALID_FILTER_VALUE'],
    ['kind', 'otherKind', 'EQ', 'INVALID_FILTER_VALUE'], ['tags', 'suffix', 'LT', 'INVALID_FILTER_OPERATOR'],
    ['name', 'suffix', 'ILIKE', 'INVALID_FILTER_OPERATOR'], ['stock', 'threshold', 'IS_EMPTY', 'INVALID_FILTER_OPERATOR'],
  ])('rejects incompatible hand-built %s/%s %s', (left, right, operator, expected) => {
    code(() => compile(predicate(left, right, operator)), expected);
  });
  it('fails closed when enum descriptions omit logical identity', () => {
    const withoutIdentity = JSON.parse(JSON.stringify(models));
    // GraphQL types are optional for portable descriptions; comparisons must use the additive logical metadata.
    for (const entity of withoutIdentity.entities) {
      delete entity.gqltype;
      for (const field of entity.fields) delete field.enumName;
    }
    code(() => compileQuery(withoutIdentity, database, plan(predicate('kind', 'sameKind', 'EQ'))), 'UNSUPPORTED_QUERY');
  });
  it('uses the existing aggregate J row for a scoped field operand', () => {
    const joins = { shop: { kind: 'predicate', path: ['name'], operator: 'NE', value: 'hidden' } };
    const result = compile(predicate('shop.products.stock', 'shop.products.threshold', 'LT', { joins }), {
      mode: 'aggregate', aggregation: { groupId: ['name'], facts: [{ path: ['shop', 'products', 'id'], operation: 'COUNT', factName: 'n' }] },
    });
    expect(result.text.match(/LEFT JOIN "app"\."FcProduct"/g)).toHaveLength(1);
    expect(result.text).toContain('CASE WHEN');
    expect(result.text).toContain('IS NOT NULL THEN');
  });
  it('applies visibility before an aggregate anchor without replacing its joined collection row', () => {
    const where = { kind: 'quantified', quantifier: 'ANY', anchor: ['shop', 'products'], path: ['reviews'], scope: null,
      joins: { shop: { kind: 'predicate', path: ['name'], operator: 'NE', value: 'hidden' } }, where: predicate('rating', 'maxRating', 'LT'),
    };
    const result = compile(where, { mode: 'aggregate', aggregation: { groupId: ['name'], facts: [{ path: ['shop', 'products', 'id'], operation: 'COUNT', factName: 'n' }] } });
    expect(result.text.match(/LEFT JOIN "app"\."FcProduct"/g)).toHaveLength(1);
    expect(result.text).toContain('LEFT JOIN LATERAL');
    expect(result.text).toMatch(/IS NOT NULL AND \(EXISTS/);
    expect(result.values).toEqual(['hidden']);
  });
  it('allows outer J operands only on the quantified frame own aggregate anchor', () => {
    const where = { kind: 'quantified', quantifier: 'ANY', anchor: ['shop', 'products'], path: ['reviews'], scope: null,
      where: predicate('rating', 'shop.products.stock', 'LT', { operand: { up: 1, path: ['shop', 'products', 'stock'] } }),
    };
    const aggregation = { groupId: ['name'], facts: [{ path: ['shop', 'products', 'id'], operation: 'COUNT', factName: 'n' }, { path: ['reviews', 'id'], operation: 'COUNT', factName: 'm' }] };
    const result = compile(where, { mode: 'aggregate', aggregation });
    expect(result.text).toMatch(/COALESCE\(t[0-9]+\."rating" < t[0-9]+\."stock", FALSE\)/);
    code(() => compile({ ...where, where: { ...where.where, operand: { up: 1, path: ['reviews', 'rating'] } } }, { mode: 'aggregate', aggregation }), 'INVALID_FILTER_PATH');
  });
  it('repeats ancestor aliases safely per batched-child UNION branch', () => {
    const where = { kind: 'quantified', quantifier: 'ANY', path: ['product'], scope: null, where: predicate('stock', 'rating', 'LT', { operand: { up: 1, path: ['rating'] } }) };
    const childPlan = { entity: 'FcReview', mode: 'find', where, sort: [], pagination: { limit: 3, offset: 0 } };
    const result = compileChildrenQuery(models, database, childPlan, { column: 'productId', ids: ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'] });
    expect(result.text.match(/COALESCE\(t1\."stock" < t0\."rating", FALSE\)/g)).toHaveLength(2);
    expect(result.setup).toEqual([{ text: 'SET LOCAL jit = off', values: [] }]);
    expect(result.values).toEqual([3, 0, '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']);
  });
});

describe('SQL field-comparison compiler capability', () => {
  it('binds comparisons only for the compiler the declaration describes', () => {
    const plugin = postgresPlugin();
    expect(bindPlugin(plugin).queryFeatures.valuePath).toBe(true);
    expect(bindPlugin({ ...plugin, compileQuery: () => ({ text: '', values: [] }) }).queryFeatures.valuePath).toBeUndefined();
  });
  it.each([1, 'true', {}, []])('rejects malformed valuePath capability %j', (valuePath) => {
    const plugin = postgresPlugin();
    code(() => bindPlugin({ ...plugin, queryFeatures: { ...plugin.queryFeatures, valuePath } }), 'INVALID_SQL_PLUGIN');
  });
  it('requires referenceEmptiness for valuePath', () => {
    const plugin = postgresPlugin();
    code(() => bindPlugin({ ...plugin, queryFeatures: { ...plugin.queryFeatures, quantifiers: false, referenceEmptiness: false, valuePath: true } }), 'INVALID_SQL_PLUGIN');
  });
});
