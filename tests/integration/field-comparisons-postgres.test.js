import { randomUUID } from 'node:crypto';
import { GraphQLBoolean, GraphQLEnumType, GraphQLFloat, GraphQLID, GraphQLInt, GraphQLList, GraphQLObjectType, GraphQLScalarType, GraphQLString } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { describeModels } from '../../packages/core/src/metadata.js';
import { createQueryPlan } from '../../packages/core/src/query-plan.js';
import { compileChildrenQuery, compileQuery } from '../../packages/postgres/src/query/compiler.js';
import { compileDatabaseSchema } from '../../packages/postgres/src/schema/ddl.js';
import { describeDatabase } from '../../packages/postgres/src/schema/describe.js';

const uri = process.env.SIMFINITY_POSTGRES_URI;
const DateTime = new GraphQLScalarType({ name: 'DateTime', serialize: (value) => value });
const Kind = new GraphQLEnumType({ name: 'FciKind', values: { ONE: { value: 'TWO' }, TWO: { value: 2 } } });
const Detail = new GraphQLObjectType({ name: 'FciDetail', fields: { at: { type: DateTime }, ats: { type: new GraphQLList(DateTime) }, width: { type: GraphQLInt }, tags: { type: new GraphQLList(GraphQLString) } } });
const Shop = new GraphQLObjectType({ name: 'FciShop', fields: () => ({ id: { type: GraphQLID }, name: { type: GraphQLString }, minimum: { type: GraphQLInt }, products: { type: new GraphQLList(Product), extensions: { relation: { embedded: false, connectionField: 'shop' } } } }) });
const Owned = new GraphQLObjectType({ name: 'FciOwned', fields: { at: { type: DateTime }, ats: { type: new GraphQLList(DateTime) }, shop: { type: Shop, extensions: { relation: { embedded: false } } } } });
const Product = new GraphQLObjectType({ name: 'FciProduct', fields: () => ({
  id: { type: GraphQLString }, key: { type: GraphQLString }, stock: { type: GraphQLInt }, threshold: { type: GraphQLFloat },
  name: { type: GraphQLString }, suffix: { type: GraphQLString }, active: { type: GraphQLBoolean }, otherActive: { type: GraphQLBoolean },
  tags: { type: new GraphQLList(GraphQLString) }, quantities: { type: new GraphQLList(GraphQLInt) },
  kind: { type: Kind }, sameKind: { type: Kind }, kinds: { type: new GraphQLList(Kind) },
  at: { type: DateTime }, ats: { type: new GraphQLList(DateTime) },
  detail: { type: Detail, extensions: { relation: { embedded: true } } },
  owned: { type: Owned, extensions: { relation: { embedded: true } } },
  shop: { type: Shop, extensions: { relation: { embedded: false } } },
  reviews: { type: new GraphQLList(Review), extensions: { relation: { embedded: false, connectionField: 'productId' } } },
}) });
const Review = new GraphQLObjectType({ name: 'FciReview', fields: () => ({
  id: { type: GraphQLID }, productId: { type: GraphQLID }, rating: { type: GraphQLInt }, maxRating: { type: GraphQLInt },
  product: { type: Product, extensions: { relation: { embedded: false } } },
}) });
const registrations = [Product, Shop, Review].map((gqltype) => ({ gqltype }));
const models = describeModels(registrations);
const namespace = `field_comparisons_${randomUUID().replaceAll('-', '')}`;
const database = describeDatabase(registrations, { schema: namespace });
const pred = (left, right, operator = 'EQ', extra = {}) => ({ kind: 'predicate', path: left.split('.'), operator, value: null, operand: { up: 0, path: right.split('.') }, ...extra });
const planned = (where, extra = {}) => ({ entity: 'FciProduct', mode: 'find', where, sort: [{ path: ['key'], order: 'ASC' }], ...extra });
const d1 = '2024-01-01T00:00:00.123Z';
const d2 = '2024-06-01T12:30:00.456Z';
const ids = [1, 2, 3, 4, 5, 6, 7].map((index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`);

describe.skipIf(!uri)('PostgreSQL real field comparisons', () => {
  let pool;
  const query = async (statement) => (await pool.query(statement.text, statement.values)).rows;
  const keys = async (where, extra) => (await query(compileQuery(models, database, planned(where, extra)))).map((row) => row.key);
  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: uri });
    for (const text of compileDatabaseSchema(database)) await pool.query(text);
    await pool.query(`INSERT INTO "${namespace}"."FciShop" (id,name,minimum) VALUES ($1,'visible',5),($2,'hidden',100)`, [ids[5], ids[6]]);
    const rows = [
      { key: 'a', stock: 2, threshold: 3, name: 'a%_😀', suffix: '😀', tags: ['x', null], quantities: [2, null], active: true, otherActive: true, kind: 'TWO', sameKind: 'TWO', kinds: ['TWO', null], at: d1, ats: [d1, null], detail: { at: d1, ats: [d1, null], width: 3, tags: ['😀', null] }, shop: ids[5] },
      { key: 'b', stock: 4, threshold: 3, name: 'tiny', suffix: 'a longer suffix', tags: [], quantities: [], active: false, otherActive: true, kind: '2', sameKind: 'TWO', kinds: ['2'], at: d1, ats: [], detail: { at: d2, ats: [], width: 2, tags: [] }, shop: ids[6] },
      { key: 'c', stock: null, threshold: null, name: '', suffix: '', tags: [], quantities: null, active: null, otherActive: null, kind: null, sameKind: null, kinds: [], at: null, ats: [], detail: { at: null, ats: [], tags: [] }, shop: null },
      { key: 'd', stock: null, threshold: 2, name: null, suffix: null, tags: [null], quantities: [null], active: null, otherActive: false, kind: null, sameKind: '2', kinds: [null], at: null, ats: [null], detail: null, shop: null },
      { key: 'e', stock: 3, threshold: null, name: 'Z', suffix: 'a', tags: null, quantities: null, active: true, otherActive: true, kind: '2', sameKind: '2', kinds: null, at: d2, ats: [d1, d2], detail: { at: d2, ats: [d2], tags: null }, shop: null },
    ];
    for (const [index, row] of rows.entries()) {
      const columns = Object.keys(row);
      await pool.query(`INSERT INTO "${namespace}"."FciProduct" (id,${columns.map((column) => `"${column}"`).join(',')}) VALUES ($1,${columns.map((_, position) => `$${position + 2}`).join(',')})`, [ids[index], ...Object.values(row)]);
    }
    await pool.query(`INSERT INTO "${namespace}"."FciReview" ("productId",rating,"maxRating",product) VALUES ($1,1,2,$1),($1,4,3,$1),($2,5,6,$2),($3,NULL,1,$3)`, [ids[0], ids[1], ids[2]]);
    // Owned records need the root's state and the child row to change in the same transaction.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`UPDATE "${namespace}"."FciProduct" SET __owned_state='present' WHERE key='a'`);
      await client.query(`INSERT INTO "${namespace}"."FciProduct__owned" (__owner_id,at,ats) VALUES ($1,$2,$3)`, [ids[0], d1, [d1, null]]);
      await client.query('COMMIT');
    } finally { client.release(); }
  });
  afterAll(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
    await pool.end();
  });

  it.each([
    ['stock', 'threshold', 'EQ', ['c']], ['stock', 'threshold', 'NE', ['a', 'b', 'd', 'e']],
    ['stock', 'threshold', 'LT', ['a']], ['active', 'otherActive', 'EQ', ['a', 'c', 'e']],
    ['kind', 'sameKind', 'EQ', ['a', 'c', 'e']], ['kinds', 'sameKind', 'EQ', ['a']],
    ['quantities', 'threshold', 'EQ', ['c', 'e']], ['quantities', 'stock', 'EQ', ['a', 'c', 'd']],
    ['name', 'suffix', 'LIKE', ['a', 'c']], ['name', 'suffix', 'STARTS_WITH', ['c']], ['name', 'suffix', 'ENDS_WITH', ['a', 'c']],
    ['name', 'suffix', 'LT', ['a', 'e']], ['tags', 'suffix', 'EQ', ['d']],
    ['at', 'detail.at', 'EQ', ['a', 'c', 'd', 'e']], ['at', 'detail.at', 'LT', ['b']],
    ['ats', 'detail.at', 'EQ', ['a', 'd', 'e']], ['detail.ats', 'at', 'EQ', ['a', 'd', 'e']],
    ['at', 'owned.at', 'EQ', ['a', 'c', 'd']], ['owned.ats', 'detail.at', 'EQ', ['a', 'c', 'd']],
  ])('evaluates %s %s %s with null/list/text/date semantics', async (left, right, operator, expected) => {
    expect(await keys(pred(left, right, operator))).toEqual(expected);
  });
  it('uses scoped RHS references as null while retaining visible root rows', async () => {
    const scope = { kind: 'predicate', path: ['name'], operator: 'NE', value: 'hidden' };
    expect(await keys(pred('threshold', 'shop.minimum', 'EQ', { joins: { shop: scope } }))).toEqual(['c', 'e']);
    expect(await keys(pred('stock', 'shop.minimum', 'LT', { joins: { shop: scope } }))).toEqual(['a']);
  });
  it('correlates one child, preserves the root operand and keeps ALL two-valued', async () => {
    const outer = pred('rating', 'stock', 'LT', { operand: { up: 1, path: ['stock'] } });
    expect(await keys({ kind: 'quantified', path: ['reviews'], quantifier: 'ANY', scope: null, where: outer })).toEqual(['a']);
    expect(await keys({ kind: 'quantified', path: ['reviews'], quantifier: 'ALL', scope: null, where: pred('rating', 'maxRating', 'LT') })).toEqual(['b', 'd', 'e']);
  });
  it('retains aggregate joined-row cardinality for comparisons on J', async () => {
    const compiled = compileQuery(models, database, planned(pred('reviews.rating', 'reviews.maxRating', 'LT'), {
      mode: 'aggregate', sort: [], aggregation: { groupId: ['key'], facts: [{ path: ['reviews', 'id'], operation: 'COUNT', factName: 'n' }] },
    }));
    expect((await query(compiled)).map((row) => ({ groupId: row.groupId, count: Number(row.fact_0) }))).toEqual([{ groupId: 'a', count: 1 }, { groupId: 'b', count: 1 }]);
  });
  it('compares the existing J row after a scoped reference instead of multiplying independent children', async () => {
    const extraId = randomUUID();
    await pool.query(`INSERT INTO "${namespace}"."FciProduct" (id,key,stock,threshold,shop) VALUES ($1,'f',10,0,$2)`, [extraId, ids[5]]);
    try {
      const where = pred('shop.products.stock', 'shop.products.threshold', 'LT', {
        joins: { shop: { kind: 'predicate', path: ['name'], operator: 'NE', value: 'hidden' } },
      });
      const result = await query(compileQuery(models, database, planned(where, { mode: 'aggregate', sort: [],
        aggregation: { groupId: ['key'], facts: [{ path: ['shop', 'products', 'id'], operation: 'COUNT', factName: 'n' }] },
      })));
      expect(result).toEqual([{ groupId: 'a', fact_0: '1' }, { groupId: 'f', fact_0: '1' }]);
    } finally { await pool.query(`DELETE FROM "${namespace}"."FciProduct" WHERE id=$1`, [extraId]); }
  });
  it('reads scoped-out references before J as null without deleting the already joined row', async () => {
    const where = pred('shop.products.stock', 'shop.products.threshold', 'EQ', {
      joins: { shop: { kind: 'predicate', path: ['name'], operator: 'NE', value: 'hidden' } },
    });
    const result = await query(compileQuery(models, database, planned(where, { mode: 'aggregate', sort: [],
      aggregation: { groupId: ['key'], facts: [{ path: ['shop', 'products', 'id'], operation: 'COUNT', factName: 'n' }] },
    })));
    expect(result).toEqual(['b', 'c', 'd', 'e'].map((groupId) => ({ groupId, fact_0: '1' })));
  });
  it('keeps scoped reference visibility before J without adding an independent collection witness', async () => {
    const where = { kind: 'quantified', quantifier: 'ANY', anchor: ['shop', 'products'], path: ['reviews'], scope: null,
      joins: { shop: { kind: 'predicate', path: ['name'], operator: 'NE', value: 'hidden' } }, where: pred('rating', 'maxRating', 'LT'),
    };
    const compiled = compileQuery(models, database, planned(where, { mode: 'aggregate', sort: [],
      aggregation: { groupId: ['key'], facts: [{ path: ['shop', 'products', 'id'], operation: 'COUNT', factName: 'n' }] },
    }));
    expect(await query(compiled)).toEqual([{ groupId: 'a', fact_0: '1' }]);
  });
  it('resolves a normalized outer operand on its aggregate J anchor', async () => {
    const where = { kind: 'quantified', quantifier: 'ANY', anchor: ['shop', 'products'], path: ['reviews'], scope: null,
      where: pred('rating', 'shop.products.stock', 'LT', { operand: { up: 1, path: ['shop', 'products', 'stock'] } }),
    };
    const result = await query(compileQuery(models, database, planned(where, { mode: 'aggregate', sort: [],
      aggregation: { groupId: ['key'], facts: [{ path: ['shop', 'products', 'id'], operation: 'COUNT', factName: 'n' }] },
    })));
    expect(result).toEqual([{ groupId: 'a', fact_0: '1' }]);
    const args = { AND: [{ conditions: [{ field: 'shop.products.reviews.rating', operator: 'LT', valuePath: 'shop.products.stock' }] }],
      aggregation: { groupId: 'key', facts: [{ path: 'shop.products.id', operation: 'COUNT', factName: 'n' }] } };
    expect(await query(compileQuery(models, database, createQueryPlan(models, Product.name, args, { mode: 'aggregate' })))).toEqual([{ groupId: 'a', fact_0: '1' }]);
  });
  it('reproduces individual child reads for a batched outer comparison', async () => {
    const where = { kind: 'quantified', path: ['product'], quantifier: 'ANY', scope: null, where: pred('stock', 'rating', 'GT', { operand: { up: 1, path: ['rating'] } }) };
    const childPlan = { entity: 'FciReview', mode: 'find', where, sort: [{ path: ['rating'], order: 'ASC' }], pagination: { limit: 5, offset: 0 } };
    const parents = ids.slice(0, 3);
    const individual = await Promise.all(parents.map((id) => query(compileQuery(models, database, childPlan, { column: 'productId', id }))));
    const batch = compileChildrenQuery(models, database, childPlan, { column: 'productId', ids: parents });
    const result = await query(batch);
    for (let index = 0; index < parents.length; index++) expect(result.filter((row) => row[batch.parentColumn] === index + 1).map((row) => row.id)).toEqual(individual[index].map((row) => row.id));
  });
  it('executes planner comparisons as list, count and aggregate queries', async () => {
    const args = { stock: { operator: 'LT', valuePath: 'threshold' } };
    const names = (await query(compileQuery(models, database, createQueryPlan(models, Product.name, { ...args, sort: { terms: [{ field: 'key', order: 'ASC' }] } })))).map((row) => row.key);
    expect(names).toEqual(['a']);
    expect((await query(compileQuery(models, database, createQueryPlan(models, Product.name, args, { mode: 'count' }))))[0].size).toBe('1');
    const aggregate = createQueryPlan(models, Product.name, { ...args, aggregation: { groupId: 'key', facts: [{ path: 'id', operation: 'COUNT', factName: 'n' }] } }, { mode: 'aggregate' });
    expect(await query(compileQuery(models, database, aggregate))).toEqual([{ groupId: 'a', fact_0: '1' }]);
  });
  it('executes normalized shorthand with a root RHS and a same-child RHS', async () => {
    for (const [valuePath, expected] of [['stock', ['a']], ['reviews.maxRating', ['a', 'b']]]) {
      const args = { AND: [{ conditions: [{ field: 'reviews.rating', operator: 'LT', valuePath }] }], sort: { terms: [{ field: 'key', order: 'ASC' }] } };
      expect((await query(compileQuery(models, database, createQueryPlan(models, Product.name, args)))).map((row) => row.key)).toEqual(expected);
    }
  });
});
