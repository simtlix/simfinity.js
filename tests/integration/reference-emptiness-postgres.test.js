// Reference and collection emptiness on PostgreSQL (#108, part 2b). Client constructs carry the scopes that
// createQueryPlan lifts from the marker the runtime fills, and read through scoped joins (LEFT JOIN LATERAL ... LIMIT 1)
// and frames (NOT EXISTS) with their targets' find scopes, so a hidden record reads as a missing one; trusted
// constructs read stored data through plain joins, and a reference's own column. This file pins the statements of
// every form and the checks of plans built by hand, the plugin's declaration and bindPlugin, the SQL adapter's
// plans and an undeclared plugin; and, on a database, the rows of every case of the shared fixture in every scope
// shape, owned objects inside owned objects with reference members, counts, aggregates, batched children, batched
// collection fields through the adapter, and the index each frame and scoped join uses. Markers are filled here as the
// runtime fills them, so the compiler is tested apart from the runtime; the parity tests read the same rows through
// GraphQL, as the batched collection fields do here.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GraphQLID, GraphQLInt, GraphQLNonNull, GraphQLObjectType, GraphQLString, getNamedType, graphql, isListType,
} from 'graphql';
import pg from 'pg';
import { createRuntime } from '../../packages/core/src/index.js';
import { describeModels } from '../../packages/core/src/metadata.js';
// A namespace import, so that the regression pins also load where these functions do not exist yet.
import * as emptinessCore from '../../packages/core/src/query-emptiness.js';
import { createQueryPlan } from '../../packages/core/src/query-plan.js';
import { encodeParameter } from '../../packages/postgres/src/codecs.js';
import { createPostgres, postgresPlugin } from '../../packages/postgres/src/index.js';
import { compileChildrenQuery, compileQuery } from '../../packages/postgres/src/query/compiler.js';
import { describeDatabase } from '../../packages/postgres/src/schema/describe.js';
import { createSQLAdapter } from '../../packages/sql/src/adapter.js';
import { createSQL } from '../../packages/sql/src/index.js';
import { bindPlugin } from '../../packages/sql/src/plugin.js';
import {
  REFERENCE_CASES, REFERENCE_SCOPES, REFERENCE_SHAPES, createEmptinessTypes, createReferenceEmptinessTypes, emptinessArgumentType,
  expectedReferenceRows, referenceCaseArgs, registerReferenceEmptinessTypes, seedReferenceEmptiness,
} from '../helpers/query-emptiness.js';

const uri = process.env.SIMFINITY_POSTGRES_URI;
const OPERATORS = ['IS_EMPTY', 'IS_NOT_EMPTY'];
const LEGACY = ['EQ', 'NE', 'LT', 'LTE', 'GT', 'GTE', 'BTW', 'IN', 'NIN', 'LIKE'];
const NOT_SUPPORTED = 'the database adapter does not support emptiness through references and collections';
const code = (error) => error?.extensions?.code;
const caught = (run) => { try { run(); } catch (error) { return error; } return undefined; };
const failure = (error) => (error ? [code(error), error.extensions?.status, error.message] : null);
const embedded = { relation: { embedded: true } };
const reference = { relation: { embedded: false } };
const nodes = (plan) => [plan, ...(plan.Plans || []).flatMap(nodes)];
// A pool that records the text of every statement it runs.
const recording = (pool, log) => ({
  query: (text, values) => { log.push(text); return pool.query(text, values); },
  connect: async () => {
    const client = await pool.connect();
    return { query: (text, values) => { log.push(text); return client.query(text, values); }, release: (error) => client.release(error) };
  },
});

// Owned storage inside owned storage with a reference member, which the shared fixture does not have: Kit { key,
// nest { w, inner { tag, shop: Shop } } }. Both embedded types are owned tables, QrKit__nest and QrKit__nest__inner,
// because the inner one holds a reference.
const createKitTypes = (prefix, Shop) => {
  const KInner = new GraphQLObjectType({ name: `${prefix}KInner`, fields: () => ({ tag: { type: GraphQLString }, shop: { type: Shop, extensions: reference } }) });
  const KNest = new GraphQLObjectType({ name: `${prefix}KNest`, fields: () => ({ w: { type: GraphQLInt }, inner: { type: KInner, extensions: embedded } }) });
  const Kit = new GraphQLObjectType({
    name: `${prefix}Kit`,
    fields: () => ({ id: { type: GraphQLID }, key: { type: new GraphQLNonNull(GraphQLString) }, nest: { type: KNest, extensions: embedded } }),
  });
  return { Kit, embedded: [KNest, KInner] };
};
const entitiesOf = (types, kit) => [types.Shop, types.Pro, types.Product, types.Review, kit.Kit];
const registrationsOf = (types, kit) => entitiesOf(types, kit).map((gqltype) => ({ gqltype }))
  .concat([...types.embedded, ...kit.embedded].map((gqltype) => ({ gqltype, endpoint: false })));

// The kits, with shops by key, and the rows of their cases by Shop scope: S2 is hidden under NE, S2 and S3 under EQ.
// Only Shop's scope matters here, so NE and EQ stand for every shape with that Shop scope.
const KITS = [
  { key: 'K1', nest: { w: 1 } },
  { key: 'K2', nest: { inner: { shop: 'S1' } } },
  { key: 'K3', nest: { inner: { shop: 'S2' } } },
  { key: 'K4', nest: { inner: { shop: 'S3' } } },
  { key: 'K5', nest: { inner: { tag: 't', shop: 'S2' } } },
  { key: 'K6' },
  { key: 'K7', nest: { inner: { tag: '' } } },
  { key: 'K8', nest: { w: 2, inner: { shop: 'S2' } } },
];
const KIT_KEYS = KITS.map((kit) => kit.key);
const KIT_SHOPS = { admin: 'admin', NE: 'shopNE', EQ: 'shopEQ' };
const KIT_CASES = [
  // The reference member two owned levels down, and a member's String rule: K7's tag is "".
  ['nest', { admin: 'K6 K7', NE: 'K3 K6 K7', EQ: 'K3 K4 K6 K7' }],
  ['nest.inner', { admin: 'K1 K6 K7', NE: 'K1 K3 K6 K7 K8', EQ: 'K1 K3 K4 K6 K7 K8' }],
  ['nest.inner.shop', { admin: 'K1 K6 K7', NE: 'K1 K3 K5 K6 K7 K8', EQ: 'K1 K3 K4 K5 K6 K7 K8' }],
  // A crossing from a row owned by an owned row; the identity after it takes the null rule.
  ['nest.inner.shop.id', { admin: 'K1 K6 K7', NE: 'K1 K3 K5 K6 K7 K8', EQ: 'K1 K3 K4 K5 K6 K7 K8' }],
  ['nest.inner.shop.name', { admin: 'K1 K6 K7', NE: 'K1 K3 K5 K6 K7 K8', EQ: 'K1 K3 K4 K5 K6 K7 K8' }],
  ['nest.inner.shop.state', { admin: 'K1 K4 K6 K7', NE: 'K1 K3 K4 K5 K6 K7 K8', EQ: 'K1 K3 K4 K5 K6 K7 K8' }],
].map(([path, rows]) => ({ path, rows: Object.fromEntries(Object.entries(rows).map(([shape, keys]) => [shape, keys.split(' ')])) }));
const kitRows = (kitCase, shape, operator) => {
  const empty = kitCase.rows[shape];
  return operator === 'IS_EMPTY' ? empty : KIT_KEYS.filter((key) => !empty.includes(key));
};
const kitArgs = (path, operator, form) => {
  const [head, ...rest] = path.split('.');
  const tail = rest.join('.');
  if (form === 'condition') return { AND: [{ conditions: [{ field: head, ...(tail ? { path: tail } : {}), operator }] }] };
  return { [head]: { terms: [{ ...(tail ? { path: tail } : {}), operator }] } };
};

// What the runtime does for a declaring adapter (#108 part 2b), around compileQuery. Each client emptiness construct
// (a term or a group condition) that reads a reference or a collection gets `__scope: { id, scopes }`, with one key per
// scoped join and frame: the raw find scope arguments of its target, or null when the scope adds nothing. Legacy
// conditions and sorts get joined scopes, prefixed with their path, in the group that holds them or at the top level,
// and the root's own find scope appends its arguments last; neither is marked.
const scopeArgsOf = (type, context) => {
  const args = {};
  type.extensions?.scope?.find?.({ type, args, operation: 'find', context });
  return Object.keys(args).length ? args : null;
};
const constructsOf = (args) => {
  const found = [];
  const segments = (field, path) => [...field.split('.'), ...(path ? path.split('.') : [])];
  for (const [name, value] of Object.entries(args)) {
    if (['AND', 'OR', 'sort', 'pagination', 'aggregation'].includes(name)) continue;
    for (const term of value?.terms ?? []) found.push({ construct: term, owner: null, segments: segments(name, term.path) });
  }
  const visit = (group) => {
    for (const condition of group.conditions ?? []) found.push({ construct: condition, owner: group, segments: segments(condition.field, condition.path) });
    for (const item of [...(group.AND ?? []), ...(group.OR ?? [])]) visit(item);
  };
  for (const group of [...(args.AND ?? []), ...(args.OR ?? [])]) visit(group);
  return found;
};
const markClient = (entities, rootType, args, context) => {
  // Before reference emptiness (3.10.0), the runtime marks nothing.
  if (!emptinessCore.emptinessScopeTargets) return args;
  let id = 0;
  for (const { construct, segments } of constructsOf(args)) {
    if (!['IS_EMPTY', 'IS_NOT_EMPTY'].includes(construct.operator)) continue;
    const shape = emptinessCore.describeEmptiness(rootType, segments, { operator: construct.operator, referenceEmptiness: true });
    const targets = Object.entries(emptinessCore.emptinessScopeTargets(shape, segments));
    if (!targets.length) continue;
    const scopes = Object.fromEntries(targets.map(([path, target]) => [path, scopeArgsOf(entities.find((type) => type.name === target), context)]));
    construct.__scope = { id: id++, scopes };
  }
  return args;
};
// Whether a construct reads a reference or a collection, which is when the runtime marks it: a segment of its path is
// one, or the path ends at an embedded object with one among its members at any depth, which the member rule reads.
// The others are 2a's own-field constructs. It reads only the types, so it holds on 3.10.0 too.
const readsRelations = (rootType, segments) => {
  const relationOf = (field) => field.extensions?.relation;
  const hasRelationMember = (type) => Object.values(type.getFields()).some((field) => relationOf(field)
    && (!relationOf(field).embedded || hasRelationMember(getNamedType(field.type))));
  let type = rootType;
  for (const name of segments) {
    const field = type?.getFields?.()[name];
    if (!field) return false;
    if (relationOf(field) && !relationOf(field).embedded) return true;
    type = getNamedType(field.type);
  }
  return typeof type?.getFields === 'function' && hasRelationMember(type);
};
const joinLegacyScopes = (entities, rootType, args, context) => {
  const joined = new Map();
  const record = (segments, owner) => {
    let type = rootType;
    segments.forEach((name, index) => {
      const field = type?.getFields?.()[name];
      if (!field) return;
      const target = getNamedType(field.type);
      const relation = field.extensions?.relation;
      if (relation && !relation.embedded && !isListType(field.type)) {
        const prefix = segments.slice(0, index + 1).join('.');
        if (!joined.has(prefix)) joined.set(prefix, { target, topLevel: false, owners: new Set() });
        if (owner) joined.get(prefix).owners.add(owner);
        else joined.get(prefix).topLevel = true;
      }
      type = target;
    });
  };
  for (const { construct, owner, segments } of constructsOf(args)) {
    if (!['IS_EMPTY', 'IS_NOT_EMPTY'].includes(construct.operator)) record(segments, owner);
  }
  for (const term of args.sort?.terms ?? []) record(term.field.split('.'), null);
  for (const [prefix, { target, topLevel, owners }] of joined) {
    const scope = scopeArgsOf(entities.find((type) => type.name === target.name), context);
    if (!scope) continue;
    const groups = scope.AND.map((group) => ({ conditions: group.conditions.map((condition) => ({ ...condition, field: `${prefix}.${condition.field}` })) }));
    for (const owner of topLevel ? [args] : owners) owner.AND = [...(owner.AND ?? []), ...groups];
  }
  return args;
};
const withRootScope = (rootType, args, context, extra = null) => {
  rootType.extensions?.scope?.find?.({ type: rootType, args, operation: 'find', context });
  if (extra) args.AND = [...(args.AND ?? []), ...structuredClone(extra).AND];
  return args;
};

// Raw find scope arguments as the fixture's scopes give them (REFERENCE_SCOPES), and the SQL their lifted predicates
// compile to in a frame whose alias is `alias`, bound as parameter `n`.
const scopeArgs = (condition) => ({ AND: [{ conditions: [{ ...condition }] }] });
const SHOP_NE = scopeArgs(REFERENCE_SCOPES.NE.shop);
const SHOP_EQ = scopeArgs(REFERENCE_SCOPES.EQ.shop);
const PRO_NE = scopeArgs(REFERENCE_SCOPES.NE.pro);
const REVIEW_NE = scopeArgs(REFERENCE_SCOPES.NE.review);
const ne = (alias, n, column = 'name') => `((${alias}."${column}") COLLATE "pg_catalog"."C" IS DISTINCT FROM $${n}::text)`;
const eq = (alias, n, column = 'state') => `((${alias}."${column}") COLLATE "pg_catalog"."C" = $${n}::text)`;
const T = (name) => `"app"."Qr${name}"`;
const lateral = (name, inner, table, correlation, scope = null, joins = '') => `LEFT JOIN LATERAL (SELECT ${inner}.* FROM ${T(table)} ${inner}${joins ? ` ${joins}` : ''} WHERE ${inner}."id" = ${correlation}${scope ? ` AND ${scope}` : ''} LIMIT 1) ${name} ON TRUE`;
const plain = (name, table, correlation) => `LEFT JOIN ${T(table)} ${name} ON ${name}."id" = ${correlation}`;
const owned = (name, table, owner, state) => `LEFT JOIN ${T(table)} ${name} ON ${name}."__owner_id" = ${owner} AND ${state} = 'present'`;
const exists = (inner, table, correlation, scope = null) => `EXISTS (SELECT 1 FROM ${T(table)} ${inner} WHERE ${correlation}${scope ? ` AND ${scope}` : ''})`;
const none = (...args) => `NOT ${exists(...args)}`;
const string = (c) => [`(${c} IS NULL OR ${c} = '')`, `(${c} IS NOT NULL AND ${c} <> '')`];
const nullable = (c) => [`${c} IS NULL`, `${c} IS NOT NULL`];
const count = (table, joins, condition) => `SELECT count(*) AS size FROM ${T(table)} t0 ${joins} WHERE ${condition}`;

const offline = () => {
  const types = createReferenceEmptinessTypes('Qr');
  const kit = createKitTypes('Qr', types.Shop);
  const registrations = registrationsOf(types, kit);
  const models = describeModels(registrations);
  const bare = { entities: models.entities.map((entity) => Object.fromEntries(Object.entries(entity).filter(([key]) => key !== 'gqltype'))) };
  const database = describeDatabase(registrations, { schema: 'app' });
  const { operators, quantifiers } = postgresPlugin().queryFeatures;
  const plan = (entity, args, mode = 'count') => createQueryPlan(models, `Qr${entity}`, args, { mode, operators, referenceEmptiness: true, quantifiers });
  const statement = (entity, args, mode = 'count') => compileQuery(models, database, plan(entity, args, mode));
  return { types, kit, models, bare, database, operators, plan, statement };
};
const marked = (term, scopes) => ({ ...term, __scope: { id: 0, scopes } });

describe('PostgreSQL reference emptiness statements', () => {
  const { models, bare, database, plan, statement } = offline();
  const shop = (operator, scopes) => ({ shop: { terms: [scopes === undefined ? { operator } : marked({ operator }, scopes)] } });
  const term = (field, path, operator, scopes) => ({ [field]: { terms: [scopes === undefined ? { path, operator } : marked({ path, operator }, scopes)] } });
  const condition = (field, path, operator, scopes) => {
    const item = { field, ...(path ? { path } : {}), operator };
    return { AND: [{ conditions: [scopes === undefined ? item : marked(item, scopes)] }] };
  };
  // [label, entity, IS_EMPTY args, IS_NOT_EMPTY args, [IS_EMPTY condition, IS_NOT_EMPTY condition], joins, values].
  const odimShop = owned('t1', 'Product__odim', 't0."id"', 't0."__odim_state"');
  const PINS = [
    // NONE over a reference: NOT EXISTS with the target's scope, or EXISTS; the scope value is a parameter.
    ['reference frame', 'Product', (operator) => shop(operator, { shop: SHOP_NE }), [none, exists].map((form) => form('t1', 'Shop', 't1."id" = t0."shop"', ne('t1', 1))), '', ['S2']],
    // A trusted reference reads its own column, and so does a client one whose scope added nothing.
    ['trusted reference', 'Product', (operator) => shop(operator), nullable('t0."shop"'), '', []],
    ['client reference with a null scope', 'Product', (operator) => shop(operator, { shop: null }), nullable('t0."shop"'), '', []],
    // NONE over a collection, through its storage column productId; trusted without a scope.
    ['collection frame', 'Product', (operator) => term('reviews', undefined, operator, { reviews: REVIEW_NE }), [none, exists].map((form) => form('t1', 'Review', 't1."productId" = t0."id"', ne('t1', 1, 'author'))), '', ['hidden']],
    ['trusted collection', 'Product', (operator) => term('reviews', undefined, operator), [none, exists].map((form) => form('t1', 'Review', 't1."productId" = t0."id"')), '', []],
    // A leaf through a scoped join: the LATERAL's alias first, then its own frame.
    ['scoped join', 'Product', (operator) => term('shop', 'state', operator, { shop: SHOP_NE }), string('t1."state"'), lateral('t1', 't2', 'Shop', 't0."shop"', ne('t2', 1)), ['S2']],
    ['trusted join', 'Product', (operator) => term('shop', 'state', operator), string('t1."state"'), plain('t1', 'Shop', 't0."shop"'), []],
    // The target's identity right after a reference is its uuid key under the null rule, though Shop declares it String.
    ['identity after a scoped join', 'Product', (operator) => condition('shop', 'id', operator, { shop: SHOP_EQ }), nullable('t1."id"'), lateral('t1', 't2', 'Shop', 't0."shop"', eq('t2', 1)), ['OPEN']],
    ['identity after a plain join', 'Product', (operator) => condition('shop', 'id', operator), nullable('t1."id"'), plain('t1', 'Shop', 't0."shop"'), []],
    // A chain: the second hop correlates to the first scoped join, t1."shop".
    ['chain ending at a reference', 'Product', (operator) => term('pro', 'shop', operator, { pro: PRO_NE, 'pro.shop': SHOP_NE }), [none, exists].map((form) => form('t3', 'Shop', 't3."id" = t1."shop"', ne('t3', 2))), lateral('t1', 't2', 'Pro', 't0."pro"', ne('t2', 1)), ['P2', 'S2']],
    ['chain ending at a leaf', 'Product', (operator) => term('pro', 'shop.state', operator, { pro: PRO_NE, 'pro.shop': SHOP_NE }), string('t3."state"'), `${lateral('t1', 't2', 'Pro', 't0."pro"', ne('t2', 1))} ${lateral('t3', 't4', 'Shop', 't1."shop"', ne('t4', 2))}`, ['P2', 'S2']],
    // A null scope after a scoped crossing stays in the scoped chain: a LATERAL without a scope, or the column of the
    // scoped join, never a plain join.
    ['null hop after a scoped crossing', 'Product', (operator) => term('pro', 'shop.state', operator, { pro: PRO_NE, 'pro.shop': null }), string('t3."state"'), `${lateral('t1', 't2', 'Pro', 't0."pro"', ne('t2', 1))} ${lateral('t3', 't4', 'Shop', 't1."shop"')}`, ['P2']],
    ['null end after a scoped crossing', 'Product', (operator) => term('pro', 'shop', operator, { pro: PRO_NE, 'pro.shop': null }), nullable('t1."shop"'), lateral('t1', 't2', 'Pro', 't0."pro"', ne('t2', 1)), ['P2']],
    // Before the first scoped crossing a null hop is the plain join that legacy paths use.
    ['scoped hop after a null crossing', 'Product', (operator) => term('pro', 'shop.state', operator, { pro: null, 'pro.shop': SHOP_NE }), string('t2."state"'), `${plain('t1', 'Pro', 't0."pro"')} ${lateral('t2', 't3', 'Shop', 't1."shop"', ne('t3', 1))}`, ['S2']],
    ['scoped end after a null crossing', 'Product', (operator) => term('pro', 'shop', operator, { pro: null, 'pro.shop': SHOP_NE }), [none, exists].map((form) => form('t2', 'Shop', 't2."id" = t1."shop"', ne('t2', 1))), plain('t1', 'Pro', 't0."pro"'), ['S2']],
    ['trusted chain', 'Product', (operator) => term('pro', 'shop.state', operator), string('t2."state"'), `${plain('t1', 'Pro', 't0."pro"')} ${plain('t2', 'Shop', 't1."shop"')}`, []],
    // A collection end after a scoped crossing correlates to the scoped join's id.
    ['collection after a scoped crossing', 'Product', (operator) => term('shop', 'products', operator, { shop: SHOP_NE, 'shop.products': null }), [none, exists].map((form) => form('t3', 'Product', 't3."shop" = t1."id"')), lateral('t1', 't2', 'Shop', 't0."shop"', ne('t2', 1)), ['S2']],
    // Two hops from Review, the first unscoped.
    ['two hops', 'Review', (operator) => term('product', 'shop.state', operator, { product: null, 'product.shop': SHOP_EQ }), string('t2."state"'), `${plain('t1', 'Product', 't0."productId"')} ${lateral('t2', 't3', 'Shop', 't1."shop"', eq('t3', 1))}`, ['OPEN']],
    // A crossing from an owned row, through its LEFT JOIN, which 2a's forms share.
    ['crossing from an owned row', 'Product', (operator) => term('odim', 'shop.state', operator, { 'odim.shop': SHOP_NE }), string('t2."state"'), `${odimShop} ${lateral('t2', 't3', 'Shop', 't1."shop"', ne('t3', 1))}`, ['S2']],
    ['reference end in an owned row', 'Product', (operator) => term('odim', 'shop', operator, { 'odim.shop': SHOP_NE }), [none, exists].map((form) => form('t2', 'Shop', 't2."id" = t1."shop"', ne('t2', 1))), odimShop, ['S2']],
    ['trusted reference end in an owned row', 'Product', (operator) => term('odim', 'shop', operator), nullable('t1."shop"'), odimShop, []],
  ];

  it.each(PINS.map(([label, ...rest]) => [label, ...rest]))('pins the statements of a %s', (label, entity, args, forms, joins, values) => {
    OPERATORS.forEach((operator, index) => {
      expect(statement(entity, args(operator)), `${label} ${operator}`).toEqual({ text: count(entity, joins, `(${forms[index]})`), values });
    });
  });

  it('pins member frames inside owned rows, and inside an owned row of an owned row, with their own scopes', () => {
    const member = (scope) => (scope ? none('t2', 'Shop', 't2."id" = t1."shop"', ne('t2', 1)) : 't1."shop" IS NULL');
    const odim = (scope) => `(t0."__odim_state" IS DISTINCT FROM 'present' OR NOT EXISTS (SELECT 1 FROM ${T('Product__odim')} t1 WHERE t1."__owner_id" = t0."id" AND NOT (t1."w" IS NULL AND ${member(scope)})))`;
    for (const [scopes, scope] of [[{ 'odim.shop': SHOP_NE }, true], [{ 'odim.shop': null }, false], [undefined, false]]) {
      expect(statement('Product', term('odim', undefined, 'IS_EMPTY', scopes)), JSON.stringify(scopes)).toEqual({ text: count('Product', '', `(${odim(scope)})`), values: scope ? ['S2'] : [] });
      expect(statement('Product', term('odim', undefined, 'IS_NOT_EMPTY', scopes)).text, JSON.stringify(scopes)).toBe(count('Product', '', `(NOT ${odim(scope)})`));
    }
    // Kit: nest { w, inner { tag, shop } }, each level an owned table read in a subquery of its own, correlated to the
    // __id of the row that owns it; the frame correlates to the innermost row.
    const inner = `(t1."__inner_state" IS DISTINCT FROM 'present' OR NOT EXISTS (SELECT 1 FROM ${T('Kit__nest__inner')} t2 WHERE t2."__owner_id" = t1."__id" AND NOT ((t2."tag" IS NULL OR t2."tag" = '') AND ${none('t3', 'Shop', 't3."id" = t2."shop"', ne('t3', 1))})))`;
    expect(statement('Kit', term('nest', undefined, 'IS_EMPTY', { 'nest.inner.shop': SHOP_NE }))).toEqual({
      text: count('Kit', '', `((t0."__nest_state" IS DISTINCT FROM 'present' OR NOT EXISTS (SELECT 1 FROM ${T('Kit__nest')} t1 WHERE t1."__owner_id" = t0."id" AND NOT (t1."w" IS NULL AND ${inner}))))`),
      values: ['S2'],
    });
    // A crossing from the inner owned row, through both owned LEFT JOINs.
    const joins = `${owned('t1', 'Kit__nest', 't0."id"', 't0."__nest_state"')} ${owned('t2', 'Kit__nest__inner', 't1."__id"', 't1."__inner_state"')}`;
    expect(statement('Kit', term('nest', 'inner.shop.name', 'IS_EMPTY', { 'nest.inner.shop': SHOP_NE }))).toEqual({
      text: count('Kit', `${joins} ${lateral('t3', 't4', 'Shop', 't2."shop"', ne('t4', 1))}`, `(${string('t3."name"')[0]})`),
      values: ['S2'],
    });
    expect(statement('Kit', term('nest', 'inner.shop', 'IS_NOT_EMPTY'))).toEqual({ text: count('Kit', joins, '(t2."shop" IS NOT NULL)'), values: [] });
  });

  it('compiles a scope in its own frame: its joins inside the subquery after its alias, its emptiness trusted, and nested frames', () => {
    // Shop's scope crosses products with a nested frame inside the outer frame.
    const crossing = { products: { terms: [{ path: 'name', operator: 'EQ', value: 'Ka' }] } };
    const crossingSQL = '(EXISTS (SELECT 1 FROM "app"."QrProduct" t3 WHERE t3."shop" = t2."id" AND ((t3."name") COLLATE "pg_catalog"."C" = $1::text)))';
    expect(statement('Product', term('shop', 'state', 'IS_EMPTY', { shop: crossing }))).toEqual({
      text: count('Product', lateral('t1', 't2', 'Shop', 't0."shop"', crossingSQL), `(${string('t1."state"')[0]})`),
      values: ['Ka'],
    });
    expect(statement('Product', shop('IS_EMPTY', { shop: crossing })).text)
      .toBe(count('Product', '', '(NOT EXISTS (SELECT 1 FROM "app"."QrShop" t1 WHERE t1."id" = t0."shop" AND (EXISTS (SELECT 1 FROM "app"."QrProduct" t2 WHERE t2."shop" = t1."id" AND ((t2."name") COLLATE "pg_catalog"."C" = $1::text)))))'));
    // Emptiness inside a scope is trusted: a reference reads its column, a String its two forms, a collection a frame
    // of its own, nested in the scope's frame.
    const scope = { name: { operator: 'IS_NOT_EMPTY' }, AND: [{ conditions: [{ field: 'products', operator: 'IS_NOT_EMPTY' }] }] };
    expect(statement('Product', term('pro', 'shop', 'IS_EMPTY', { pro: { shop: { terms: [{ operator: 'IS_NOT_EMPTY' }] } }, 'pro.shop': scope }))).toEqual({
      text: count('Product', lateral('t1', 't2', 'Pro', 't0."pro"', '(t2."shop" IS NOT NULL)'), `(NOT EXISTS (SELECT 1 FROM "app"."QrShop" t3 WHERE t3."id" = t1."shop" AND (((t3."name" IS NOT NULL AND t3."name" <> '')) AND (${exists('t4', 'Product', 't4."shop" = t3."id"')}))))`),
      values: [],
    });
    // A scope's trusted emptiness through a reference reads a plain LEFT JOIN of the scope's own frame.
    expect(statement('Product', term('pro', 'name', 'IS_EMPTY', { pro: { shop: { terms: [{ path: 'state', operator: 'IS_NOT_EMPTY' }] } } }))).toEqual({
      text: count('Product', lateral('t1', 't2', 'Pro', 't0."pro"', `(${string('t3."state"')[1]})`, plain('t3', 'Shop', 't2."shop"')), `(${string('t1."name"')[0]})`),
      values: [],
    });
  });

  it('shares a scoped join between client constructs with the same chain, and never with a trusted or legacy path', () => {
    const scopedShop = lateral('t1', 't2', 'Shop', 't0."shop"', ne('t2', 1));
    // The same path and scope: one LATERAL, bound once.
    expect(statement('Product', { shop: { terms: [marked({ path: 'state', operator: 'IS_EMPTY' }, { shop: SHOP_NE }), marked({ path: 'name', operator: 'IS_NOT_EMPTY' }, { shop: structuredClone(SHOP_NE) })] } })).toEqual({
      text: count('Product', scopedShop, `((${string('t1."state"')[0]}) AND (${string('t1."name"')[1]}))`),
      values: ['S2'],
    });
    // Another scope on the same path is another LATERAL.
    expect(statement('Product', { shop: { terms: [marked({ path: 'state', operator: 'IS_EMPTY' }, { shop: SHOP_NE }), marked({ path: 'name', operator: 'IS_EMPTY' }, { shop: SHOP_EQ })] } })).toEqual({
      text: count('Product', `${scopedShop} ${lateral('t3', 't4', 'Shop', 't0."shop"', eq('t4', 2))}`, `((${string('t1."state"')[0]}) AND (${string('t3."name"')[0]}))`),
      values: ['S2', 'OPEN'],
    });
    // A trusted construct and a legacy condition share the plain join, apart from the client's LATERAL.
    expect(statement('Product', {
      shop: { terms: [marked({ path: 'state', operator: 'IS_EMPTY' }, { shop: SHOP_NE }), { path: 'state', operator: 'IS_EMPTY' }, { path: 'name', operator: 'EQ', value: 'S1' }] },
    })).toEqual({
      text: count('Product', `${scopedShop} ${plain('t3', 'Shop', 't0."shop"')}`, `((${string('t1."state"')[0]}) AND (${string('t3."state"')[0]}) AND ((t3."name") COLLATE "pg_catalog"."C" = $2::text))`),
      values: ['S2', 'S1'],
    });
    // The first hop of two chains with the same Pro scope is one join; the second hop is the chain's own.
    expect(statement('Product', { pro: { terms: [marked({ path: 'name', operator: 'IS_EMPTY' }, { pro: PRO_NE }), marked({ path: 'shop.state', operator: 'IS_EMPTY' }, { pro: PRO_NE, 'pro.shop': SHOP_NE })] } })).toEqual({
      text: count('Product', `${lateral('t1', 't2', 'Pro', 't0."pro"', ne('t2', 1))} ${lateral('t3', 't4', 'Shop', 't1."shop"', ne('t4', 2))}`, `((${string('t1."name"')[0]}) AND (${string('t3."state"')[0]}))`),
      values: ['P2', 'S2'],
    });
    // After a scoped crossing, the owned join of the target is the chain's own too, apart from the legacy one.
    const productScope = { stock: { operator: 'GT', value: 0 } };
    expect(statement('Review', { product: { terms: [marked({ path: 'odim.w', operator: 'IS_EMPTY' }, { product: productScope }), { path: 'odim.w', operator: 'EQ', value: 1 }] } })).toEqual({
      text: count('Review', [
        lateral('t1', 't2', 'Product', 't0."productId"', '(t2."stock" > $1::integer)'), owned('t3', 'Product__odim', 't1."id"', 't1."__odim_state"'),
        plain('t4', 'Product', 't0."productId"'), owned('t5', 'Product__odim', 't4."id"', 't4."__odim_state"'),
      ].join(' '), '((t3."w" IS NULL) AND (t5."w" = $2::integer))'),
      values: [0, 1],
    });
  });

  it('keeps a legacy condition, a joined scope and a sort on the plain join beside a client construct on the same reference', () => {
    // As the runtime sends them: a legacy branch with its joined scope, and a client branch whose frame has the scope.
    const args = {
      OR: [
        { conditions: [{ field: 'shop', path: 'name', operator: 'EQ', value: 'S2' }], AND: [{ conditions: [{ field: 'shop.name', operator: 'NE', value: 'S2' }] }] },
        { conditions: [marked({ field: 'shop', operator: 'IS_NOT_EMPTY' }, { shop: SHOP_NE })] },
      ],
    };
    expect(statement('Product', args)).toEqual({
      text: count('Product', plain('t1', 'Shop', 't0."shop"'), `((((t1."name") COLLATE "pg_catalog"."C" = $1::text) AND (${ne('t1', 2).slice(1, -1)})) OR (${exists('t2', 'Shop', 't2."id" = t0."shop"', ne('t2', 3))}))`),
      values: ['S2', 'S2', 'S2'],
    });
    // A sort reads the plain join, which the frame does not use.
    const sorted = statement('Product', { ...shop('IS_EMPTY', { shop: SHOP_NE }), sort: { terms: [{ field: 'shop.name', order: 'ASC' }] }, pagination: { page: 1, size: 5 } }, 'find');
    expect(sorted).toEqual({
      text: `SELECT t0.* FROM ${T('Product')} t0 ${plain('t2', 'Shop', 't0."shop"')} WHERE (${none('t1', 'Shop', 't1."id" = t0."shop"', ne('t1', 1))}) ORDER BY (t2."name") COLLATE "pg_catalog"."C" ASC NULLS FIRST LIMIT $2::bigint OFFSET $3::bigint`,
      values: ['S2', 5, 0],
    });
  });

  it('compiles the same forms in finds, counts, aggregates and batched children, scope parameters before the parent IDs', () => {
    const args = term('pro', 'shop.state', 'IS_EMPTY', { pro: PRO_NE, 'pro.shop': SHOP_NE });
    const joins = `${lateral('t1', 't2', 'Pro', 't0."pro"', ne('t2', 1))} ${lateral('t3', 't4', 'Shop', 't1."shop"', ne('t4', 2))}`;
    const condition = `(${string('t3."state"')[0]})`;
    expect(statement('Product', { ...args, pagination: { page: 1, size: 5 } }, 'find')).toEqual({
      text: `SELECT t0.* FROM ${T('Product')} t0 ${joins} WHERE ${condition} LIMIT $3::bigint OFFSET $4::bigint`, values: ['P2', 'S2', 5, 0],
    });
    const aggregate = statement('Product', { ...args, aggregation: { groupId: 'stock', facts: [{ path: 'id', operation: 'COUNT', factName: 'n' }] } }, 'aggregate');
    expect(aggregate.text).toBe(`SELECT * FROM (SELECT t0."stock" AS "groupId", count(*) AS "fact_0" FROM ${T('Product')} t0 ${joins} WHERE ${condition} GROUP BY t0."stock") aggregated ORDER BY "groupId" ASC NULLS FIRST`);
    expect(aggregate.values).toEqual(['P2', 'S2']);
    const ids = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];
    const children = compileChildrenQuery(models, database, plan('Product', { ...args, pagination: { page: 1, size: 5 } }, 'find'), { column: 'shop', ids });
    const branch = (index) => `SELECT ${index + 1}::integer AS "__simfinity_parent", row_number() OVER () AS "__simfinity_ordinal", simfinity_children.* FROM (SELECT t0.* FROM ${T('Product')} t0 ${joins} WHERE ${condition} AND t0."shop" = $${index + 5}::uuid LIMIT $3::bigint OFFSET $4::bigint) simfinity_children`;
    expect(children.text).toBe(`${branch(0)} UNION ALL ${branch(1)} ORDER BY "__simfinity_parent", "__simfinity_ordinal"`);
    expect(children.values).toEqual(['P2', 'S2', 5, 0, ...ids]);
    // A collection field's own per-parent statement binds the parent after the scopes.
    expect(compileQuery(models, database, plan('Product', { ...args, pagination: { page: 1, size: 5 } }, 'find'), { column: 'shop', id: ids[0] })).toEqual({
      text: `SELECT t0.* FROM ${T('Product')} t0 ${joins} WHERE ${condition} AND t0."shop" = $3::uuid LIMIT $4::bigint OFFSET $5::bigint`, values: ['P2', 'S2', ids[0], 5, 0],
    });
  });

  it('reads a collection whose connection field is an inferred inverse reference through that column, and keeps the reference itself a scalar', () => {
    const inverse = createEmptinessTypes('Qi', { inverse: true });
    const registrations = [inverse.Item, inverse.Shop, inverse.Review, inverse.Sid, ...Object.values(inverse.owned), inverse.Owner, inverse.Card]
      .map((gqltype) => ({ gqltype, ...(gqltype === inverse.Item ? { stateMachine: inverse.stateMachine } : {}) }))
      .concat(inverse.embedded.map((gqltype) => ({ gqltype, endpoint: false })));
    const inverseModels = describeModels(registrations);
    const inverseDatabase = describeDatabase(registrations, { schema: 'app' });
    const compile = (entity, args) => compileQuery(inverseModels, inverseDatabase, createQueryPlan(inverseModels, entity, args, { mode: 'count' }));
    const scope = { AND: [{ conditions: [{ field: 'ownerId', operator: 'NE', value: null }] }] };
    expect(compile('QiOwner', { cards: { terms: [{ operator: 'IS_EMPTY' }] } }).text)
      .toBe('SELECT count(*) AS size FROM "app"."QiOwner" t0  WHERE (NOT EXISTS (SELECT 1 FROM "app"."QiCard" t1 WHERE t1."ownerId" = t0."id"))');
    expect(compile('QiOwner', { cards: { terms: [marked({ operator: 'IS_NOT_EMPTY' }, { cards: scope })] } }).text)
      .toBe('SELECT count(*) AS size FROM "app"."QiOwner" t0  WHERE (EXISTS (SELECT 1 FROM "app"."QiCard" t1 WHERE t1."ownerId" = t0."id" AND (t1."ownerId" IS NOT NULL)))');
    // 2a's null rule for the scalar ID that GraphQL exposes, with no frame.
    expect(compile('QiCard', { ownerId: { operator: 'IS_EMPTY' } }).text).toBe('SELECT count(*) AS size FROM "app"."QiCard" t0  WHERE (t0."ownerId" IS NULL)');
  });

  it('binds every scope value as a parameter, never as text', () => {
    const marker = { 'odim.shop': { AND: [{ conditions: [{ field: 'name', operator: 'IN', value: ['x\'; DROP TABLE y; --', 'S1'] }] }] } };
    const { text, values } = statement('Product', term('odim', undefined, 'IS_EMPTY', marker));
    expect(text).not.toContain('DROP');
    expect(text).toContain('= ANY ($1::text[])');
    expect(values).toEqual([['x\'; DROP TABLE y; --', 'S1']]);
  });

  it('compiles plans built by hand as createQueryPlan plans them, from the GraphQL types or from the field descriptions', () => {
    const hand = (entity, path, operator, extra = {}) => ({ entity: `Qr${entity}`, mode: 'count', where: { kind: 'predicate', path, operator, value: null, ...extra }, sort: [], pagination: null });
    const CASES = [
      ['Product', ['shop'], undefined], ['Product', ['shop'], { shop: SHOP_NE }], ['Product', ['reviews'], { reviews: null }],
      ['Product', ['pro', 'shop', 'state'], { pro: PRO_NE, 'pro.shop': null }], ['Product', ['odim'], { 'odim.shop': SHOP_EQ }],
      ['Product', ['shop', 'id'], { shop: SHOP_EQ }], ['Review', ['product', 'shop'], { product: null, 'product.shop': SHOP_NE }],
      ['Kit', ['nest'], { 'nest.inner.shop': SHOP_NE }], ['Shop', ['products'], undefined],
    ];
    for (const [entity, path, scopes] of CASES) {
      const gqltype = models.entities.find((item) => item.name === `Qr${entity}`).gqltype;
      const targets = emptinessCore.emptinessScopeTargets(emptinessCore.describeEmptiness(gqltype, path), path);
      for (const operator of OPERATORS) {
        const label = `${entity} ${path.join('.')} ${operator} ${JSON.stringify(scopes)}`;
        const lifted = scopes && Object.fromEntries(Object.entries(scopes).map(([key, value]) => [key, value && createQueryPlan(models, targets[key], value).where]));
        const built = hand(entity, path, operator, lifted ? { scopes: lifted } : {});
        const [field, ...rest] = path;
        const args = { [field]: { terms: [scopes === undefined ? { operator, ...(rest.length ? { path: rest.join('.') } : {}) } : marked({ operator, ...(rest.length ? { path: rest.join('.') } : {}) }, scopes)] } };
        expect(compileQuery(models, database, built), label).toEqual(statement(entity, args));
        expect(compileQuery(bare, database, built), label).toEqual(compileQuery(models, database, built));
      }
    }
  });

  it('fails closed with DETACHED_CLIENT_FILTER (500) on scopes that createQueryPlan does not write, after the checks with their 400 codes', () => {
    const hand = (path, operator, scopes, entity = 'QrProduct') => ({ entity, mode: 'count', where: { kind: 'predicate', path, operator, value: null, scopes }, sort: [], pagination: null });
    const run = (built, on = models) => failure(caught(() => compileQuery(on, database, built)));
    const SUFFIX = 'only createQueryPlan writes the scopes of a predicate, from the client scope markers the runtime fills (docs/guide/middleware.md)';
    const shopScope = createQueryPlan(models, 'QrShop', SHOP_NE).where;
    const DETACHED = [
      [['shop'], {}, 'IS_EMPTY on shop has no scope for shop'],
      [['shop'], { shop: undefined }, 'IS_EMPTY on shop has no scope for shop'],
      [['shop'], null, 'IS_EMPTY on shop has scopes that are not an object'],
      [['shop'], [], 'IS_EMPTY on shop has scopes that are not an object'],
      [['shop'], 'scoped', 'IS_EMPTY on shop has scopes that are not an object'],
      [['shop'], { shop: 'name NE S2' }, 'IS_EMPTY on shop has a scope for shop that is neither a query predicate nor null'],
      [['shop'], { shop: { kind: 'not', term: shopScope } }, 'IS_EMPTY on shop has a scope for shop that is neither a query predicate nor null'],
      // Every scoped join and frame needs its key: the second hop, the member, the collection.
      [['pro', 'shop', 'state'], { pro: null }, 'IS_EMPTY on pro.shop.state has no scope for pro.shop'],
      [['pro', 'shop'], { 'pro.shop': shopScope }, 'IS_EMPTY on pro.shop has no scope for pro'],
      [['odim'], { odim: null }, 'IS_EMPTY on odim has no scope for odim.shop'],
      [['reviews'], { review: null }, 'IS_EMPTY on reviews has no scope for reviews'],
    ];
    for (const [path, scopes, message] of DETACHED) {
      expect(run(hand(path, 'IS_EMPTY', scopes)), `${path.join('.')} ${JSON.stringify(scopes)}`).toEqual(['DETACHED_CLIENT_FILTER', 500, `${message}; ${SUFFIX}`]);
      expect(run(hand(path, 'IS_EMPTY', scopes), bare), `${path.join('.')} ${JSON.stringify(scopes)}`).toEqual(['DETACHED_CLIENT_FILTER', 500, `${message}; ${SUFFIX}`]);
    }
    // Scopes on a predicate of another operator are never ignored.
    expect(run({ ...hand(['shop', 'name'], 'EQ', { shop: null }), where: { kind: 'predicate', path: ['shop', 'name'], operator: 'EQ', value: 'x', scopes: { shop: null } } }))
      .toEqual(['DETACHED_CLIENT_FILTER', 500, `EQ on shop.name has scopes, but is not an emptiness condition; ${SUFFIX}`]);
    // The checks of createQueryPlan, with their 400 codes, come first.
    expect(run(hand(['nope'], 'IS_EMPTY', {}))[0]).toBe('INVALID_FILTER_FIELD');
    expect(run(hand(['olines', 'shop'], 'IS_EMPTY', {}))[0]).toBe('INVALID_FILTER_PATH');
    expect(run({ ...hand(['shop'], 'IS_EMPTY', {}), where: { kind: 'predicate', path: ['shop'], operator: 'IS_EMPTY', value: '', scopes: {} } })[0]).toBe('INVALID_FILTER_VALUE');
    expect(run({ ...hand(['shop', 'name'], 'EQ', {}), where: { kind: 'predicate', path: ['shop', 'nope'], operator: 'EQ', value: 'x', scopes: {} } })[0]).toBe('INVALID_FILTER_FIELD');
    // A scope is planned on its target, so a path of another type fails as it would there.
    expect(run(hand(['shop'], 'IS_EMPTY', { shop: { kind: 'predicate', path: ['stock'], operator: 'EQ', value: 1 } }))[0]).toBe('INVALID_FILTER_FIELD');
    // Extra keys, such as those of another position of the same construct, are ignored; a construct on the record's
    // own fields needs none and compiles as in 2a.
    expect(compileQuery(models, database, hand(['shop'], 'IS_EMPTY', { shop: shopScope, 'pro.shop': null }))).toEqual(compileQuery(models, database, hand(['shop'], 'IS_EMPTY', { shop: shopScope })));
    expect(compileQuery(models, database, hand(['name'], 'IS_EMPTY', {}))).toEqual({ text: count('Product', '', `(${string('t0."name"')[0]})`), values: [] });
    expect(compileQuery(models, database, hand(['odim', 'w'], 'IS_EMPTY', { anything: null })).text).toBe(count('Product', odimShop, '(t1."w" IS NULL)'));
  });

  it('keeps the statements of legacy conditions and of 2a emptiness on this fixture (regression pin, passes on 3.10.0 by design)', () => {
    const legacy = (entity, args) => compileQuery(models, database, createQueryPlan(models, `Qr${entity}`, args, { mode: 'count', operators: LEGACY }));
    const twoA = (entity, args) => compileQuery(models, database, createQueryPlan(models, `Qr${entity}`, args, { mode: 'count' }));
    expect(legacy('Product', { pro: { terms: [{ path: 'shop.name', operator: 'EQ', value: 'S2' }] } })).toEqual({
      text: count('Product', `${plain('t1', 'Pro', 't0."pro"')} ${plain('t2', 'Shop', 't1."shop"')}`, '((t2."name") COLLATE "pg_catalog"."C" = $1::text)'), values: ['S2'],
    });
    expect(legacy('Product', { AND: [{ conditions: [{ field: 'odim', path: 'shop.id', operator: 'EQ', value: null }] }] })).toEqual({
      text: count('Product', `${odimShop} ${plain('t2', 'Shop', 't1."shop"')}`, '(t2."id" IS NULL)'), values: [],
    });
    expect(legacy('Product', { reviews: { terms: [{ path: 'author', operator: 'EQ', value: 'x' }] } })).toEqual({
      text: count('Product', 'LEFT JOIN "app"."QrReview" t1 ON t1."productId" = t0."id"', '((t1."author") COLLATE "pg_catalog"."C" = $1::text)'), values: ['x'],
    });
    expect(twoA('Product', { name: { operator: 'IS_EMPTY' } })).toEqual({ text: count('Product', '', `(${string('t0."name"')[0]})`), values: [] });
    expect(twoA('Product', { odim: { terms: [{ path: 'w', operator: 'IS_NOT_EMPTY' }] } })).toEqual({ text: count('Product', odimShop, '(t1."w" IS NOT NULL)'), values: [] });
    expect(twoA('Product', { olines: { terms: [{ operator: 'IS_EMPTY' }] } })).toEqual({
      text: count('Product', '', `((t0."__olines_state" IS DISTINCT FROM 'present' OR NOT EXISTS (SELECT 1 FROM ${T('Product__olines')} t1 WHERE t1."__owner_id" = t0."id")))`), values: [],
    });
  });
});

describe('PostgreSQL reference emptiness declaration', () => {
  const ALL = postgresPlugin().queryFeatures.operators;
  const invalidPlugin = expect.objectContaining({ extensions: expect.objectContaining({ code: 'INVALID_SQL_PLUGIN' }) });

  it('declares referenceEmptiness in the PostgreSQL plugin, and bindPlugin copies it under the compileQuery identity rule', () => {
    expect(postgresPlugin().queryFeatures.referenceEmptiness).toBe(true);
    const bound = bindPlugin(postgresPlugin());
    expect(bound.queryFeatures).toEqual({ operators: ALL, referenceEmptiness: true, quantifiers: true, valuePath: true });
    expect(Object.isFrozen(bound.queryFeatures)).toBe(true);
    expect(createSQLAdapter(postgresPlugin()).queryFeatures).toEqual({ operators: ALL, referenceEmptiness: true, quantifiers: true, valuePath: true });
    const custom = (...args) => compileQuery(...args);
    // A copy with another compileQuery inherits a declaration that names the bundled one: the operators of 3.7.0 and
    // no reference emptiness, until it declares its own.
    expect(bindPlugin({ ...postgresPlugin(), compileQuery: custom }).queryFeatures).toEqual({ operators: LEGACY });
    expect(bindPlugin({ ...postgresPlugin(), compileQuery: custom, queryFeatures: { operators: ALL, referenceEmptiness: true, compileQuery: custom } }).queryFeatures).toEqual({ operators: ALL, referenceEmptiness: true });
    expect(bindPlugin({ ...postgresPlugin(), compileQuery: custom, queryFeatures: { operators: ALL, referenceEmptiness: true } }).queryFeatures).toEqual({ operators: ALL, referenceEmptiness: true });
    expect(bindPlugin({ ...postgresPlugin(), queryFeatures: { operators: ALL, referenceEmptiness: true, compileQuery: custom } }).queryFeatures).toEqual({ operators: LEGACY });
    // Only true is copied; false, null and an omitted flag bind the operators alone, as before.
    for (const referenceEmptiness of [false, null, undefined]) {
      expect(bindPlugin({ ...postgresPlugin(), queryFeatures: { operators: ALL, referenceEmptiness } }).queryFeatures, String(referenceEmptiness)).toEqual({ operators: ALL });
    }
    for (const queryFeatures of [undefined, null]) expect(bindPlugin({ ...postgresPlugin(), queryFeatures }).queryFeatures).toEqual({ operators: LEGACY });
    // The runtime accepts what the adapter exposes.
    expect(() => createRuntime(createSQLAdapter(postgresPlugin()))).not.toThrow();
  });

  it.each([['true'], [1], [0], [{}], [[]]])('rejects queryFeatures.referenceEmptiness %j with INVALID_SQL_PLUGIN', (referenceEmptiness) => {
    expect(() => bindPlugin({ ...postgresPlugin(), queryFeatures: { operators: ALL, referenceEmptiness } })).toThrow(invalidPlugin);
    // Also when the declaration does not hold for this compileQuery.
    expect(() => bindPlugin({ ...postgresPlugin(), queryFeatures: { operators: ALL, referenceEmptiness, compileQuery: () => {} } })).toThrow(invalidPlugin);
  });
});

describe.skipIf(!uri)('PostgreSQL reference emptiness rows', () => {
  const namespace = `qb4_${randomUUID().replaceAll('-', '')}`;
  let pool; let api; let types; let kit; let entities; let ids; let models; let database; let operators; let quantifiers;
  const rootTypeOf = (rootKey) => (rootKey === 'kit' ? kit.Kit : types.roots[rootKey].type);
  const keys = async (rootKey, args) => (await api.getModel(rootTypeOf(rootKey)).find(args)).map((record) => record.key).sort();
  // The client's arguments as the runtime hands them to the adapter: marked and filled, legacy joined scopes added,
  // then the root's own scope and any trusted arguments it appends.
  const clientArgs = (rootKey, args, shape, extra = null) => {
    const context = { shape };
    const root = rootTypeOf(rootKey);
    return withRootScope(root, joinLegacyScopes(entities, root, markClient(entities, root, args, context), context), context, extra);
  };
  const trustedArgs = (rootKey, args, shape) => withRootScope(rootTypeOf(rootKey), args, { shape });
  const run = async (statement) => (await pool.query(statement.text, statement.values.map(encodeParameter))).rows;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: uri });
    api = createPostgres({ pool, schema: namespace, batchedCollections: true });
    types = createReferenceEmptinessTypes('Qr');
    kit = createKitTypes('Qr', types.Shop);
    entities = entitiesOf(types, kit);
    registerReferenceEmptinessTypes(api, types);
    for (const type of kit.embedded) api.addNoEndpointType(type);
    api.connect(null, kit.Kit, 'qrKit', 'qrKits');
    const schema = api.createSchema();
    await api.initializeDatabase();
    ids = await seedReferenceEmptiness(schema, types);
    for (const { key, nest } of KITS) {
      const input = { key, ...(nest ? { nest: { ...nest, ...(nest.inner ? { inner: { ...nest.inner, ...(nest.inner.shop ? { shop: { id: ids[nest.inner.shop] } } : {}) } } : {}) } } : {}) };
      const result = await graphql({ schema, source: 'mutation($input:QrKitInput!){addqrKit(input:$input){id}}', variableValues: { input }, contextValue: {} });
      if (result.errors) throw new Error(`${key}: ${JSON.stringify(result.errors)}`);
    }
    models = describeModels(api.getRegistrations());
    database = api.describeDatabase();
    ({ operators, quantifiers } = postgresPlugin().queryFeatures);
  }, 120000);
  afterAll(async () => {
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await pool.end();
    }
  });

  it('stores the seeded references as uuids under their storage columns (a check of the fixture, passes on 3.10.0 by design)', async () => {
    const { rows } = await pool.query(`SELECT p."key", s."key" AS shop, r."key" AS pro FROM "${namespace}"."QrProduct" p LEFT JOIN "${namespace}"."QrShop" s ON s."id" = p."shop" LEFT JOIN "${namespace}"."QrPro" r ON r."id" = p."pro" ORDER BY p."key"`);
    expect(rows).toEqual([{ key: 'C', shop: null, pro: 'P3' }, { key: 'D', shop: 'S3', pro: 'P4' }, { key: 'E', shop: 'S1', pro: null }, { key: 'Ka', shop: 'S1', pro: 'P1' }, { key: 'c', shop: 'S2', pro: 'P2' }]);
    const { rows: reviews } = await pool.query(`SELECT count(*)::integer AS n FROM "${namespace}"."QrReview" WHERE "productId" IS NOT NULL`);
    expect(reviews).toEqual([{ n: 6 }]);
    const { rows: inner } = await pool.query(`SELECT k."key", i."tag", s."key" AS shop FROM "${namespace}"."QrKit" k JOIN "${namespace}"."QrKit__nest" n ON n."__owner_id" = k."id" JOIN "${namespace}"."QrKit__nest__inner" i ON i."__owner_id" = n."__id" LEFT JOIN "${namespace}"."QrShop" s ON s."id" = i."shop" ORDER BY k."key"`);
    expect(inner).toEqual([['K2', null, 'S1'], ['K3', null, 'S2'], ['K4', null, 'S3'], ['K5', 't', 'S2'], ['K7', '', null], ['K8', null, 'S2']].map(([key, tag, shop]) => ({ key, tag, shop })));
  });

  const constructCases = REFERENCE_CASES.filter((item) => item.path);
  // Cases whose construct reads a reference or a collection, and the own-field ones (odim.w), which read as on 3.10.0.
  const caseTypes = createReferenceEmptinessTypes('Qr');
  const relationCases = constructCases.filter((item) => readsRelations(caseTypes.roots[item.root].type, item.path.split('.')));
  const ownFieldCases = constructCases.filter((item) => !relationCases.includes(item));
  // The rows of a construct case in every shape, client and trusted, as a term and as a group condition; `marked` is
  // whether the client construct carries a marker.
  const expectConstructRows = async (item, marked) => {
    for (const shape of REFERENCE_SHAPES) {
      for (const form of ['field', 'condition']) {
        const args = clientArgs(item.root, referenceCaseArgs(item, ids, form), shape);
        const carries = JSON.stringify(args).includes('"__scope"');
        expect(await keys(item.root, args), `${shape} ${form}`).toEqual(expectedReferenceRows(item, shape));
        expect(await keys(item.root, trustedArgs(item.root, referenceCaseArgs(item, ids, form), shape)), `${shape} ${form} trusted`).toEqual(expectedReferenceRows(item, shape, { trusted: true }));
        expect(carries, `${shape} ${form} marked`).toBe(marked);
      }
    }
  };
  it.each(relationCases.map((item) => [item.name, item]))('returns the rows of %s for every shape, client and trusted, as terms and group conditions', async (name, item) => {
    await expectConstructRows(item, true);
  });
  it.each(ownFieldCases.map((item) => [item.name, item]))('returns the rows of %s, which reads no reference and no collection, for every shape, client and trusted, as terms and group conditions (regression pin, passes on 3.10.0 by design)', async (name, item) => {
    await expectConstructRows(item, false);
  });

  const argsCases = REFERENCE_CASES.filter((item) => item.args);
  it.each(argsCases.map((item) => [item.name, item]))('returns the rows of %s for every shape, beside legacy conditions, sorts and trusted conditions', async (name, item) => {
    for (const shape of REFERENCE_SHAPES) {
      expect(await keys(item.root, clientArgs(item.root, referenceCaseArgs(item, ids), shape, item.scopeArgs)), shape).toEqual(expectedReferenceRows(item, shape));
    }
  });

  it('returns the rows of owned objects inside owned objects with a reference member, client and trusted', async () => {
    for (const kitCase of KIT_CASES) {
      for (const operator of OPERATORS) {
        for (const [shape, scopeShape] of Object.entries(KIT_SHOPS)) {
          for (const form of ['field', 'condition']) {
            const label = `${kitCase.path} ${operator} ${shape} ${form}`;
            expect(await keys('kit', clientArgs('kit', kitArgs(kitCase.path, operator, form), scopeShape)), label).toEqual(kitRows(kitCase, shape, operator).sort());
            expect(await keys('kit', trustedArgs('kit', kitArgs(kitCase.path, operator, form), scopeShape)), `${label} trusted`).toEqual(kitRows(kitCase, 'admin', operator).sort());
          }
        }
      }
    }
  });

  it('counts and aggregates with the rows of finds', async () => {
    for (const item of constructCases.filter((entry) => entry.root === 'product')) {
      for (const shape of ['NE', 'EQ', 'proOnly']) {
        const rows = expectedReferenceRows(item, shape);
        const plan = (mode, extra = {}) => createQueryPlan(models, 'QrProduct', { ...clientArgs('product', referenceCaseArgs(item, ids), shape), ...extra }, { mode, operators, referenceEmptiness: true, quantifiers });
        expect((await run(compileQuery(models, database, plan('count'))))[0].size, `${item.name} ${shape}`).toBe(String(rows.length));
        const grouped = await run(compileQuery(models, database, plan('aggregate', { aggregation: { groupId: 'key', facts: [{ path: 'id', operation: 'COUNT', factName: 'n' }] } })));
        expect(grouped.map((row) => row.groupId).sort(), `${item.name} ${shape}`).toEqual(rows);
      }
    }
  });

  it('reads batched children with the rows of each parent\'s own statement', async () => {
    const parents = ['S1', 'S2', 'S3'].map((key) => ids[key]);
    for (const item of constructCases.filter((entry) => entry.root === 'product')) {
      for (const shape of ['admin', 'NE', 'EQ', 'proOnly', 'shopEQ']) {
        const args = { ...clientArgs('product', referenceCaseArgs(item, ids, 'condition'), shape), sort: { terms: [{ field: 'key', order: 'ASC' }] }, pagination: { page: 1, size: 10 } };
        const plan = createQueryPlan(models, 'QrProduct', args, { mode: 'find', operators, referenceEmptiness: true, quantifiers });
        const batched = compileChildrenQuery(models, database, plan, { column: 'shop', ids: parents });
        const byParent = parents.map(() => []);
        for (const row of await run(batched)) byParent[Number(row[batched.parentColumn]) - 1].push(row.key);
        const alone = [];
        for (const id of parents) alone.push((await run(compileQuery(models, database, plan, { column: 'shop', id }))).map((row) => row.key));
        expect(byParent, `${item.name} ${shape}`).toEqual(alone);
        // Each shop's products are the rows of the case that point to it.
        const shopOf = { Ka: 'S1', c: 'S2', D: 'S3', E: 'S1' };
        expect(byParent, `${item.name} ${shape}`).toEqual(['S1', 'S2', 'S3'].map((key) => expectedReferenceRows(item, shape).filter((product) => shopOf[product] === key)));
      }
    }
  });

  // The runtime reads batched collection fields with the adapter's findChildrenBatch, whose plan carries the plugin's
  // flag as the plan of its other reads does. Without the flag, that plan rejects these arguments with UNSUPPORTED_QUERY
  // and the runtime reads each parent alone, without a warning and with the same rows; so these tests count the
  // batched statements, and call findChildrenBatch itself.
  describe('batched collection fields', () => {
    const statements = [];
    // Products by shop: S1 Ka and E, S2 c, S3 D; C has no shop.
    const SHOP_OF = { Ka: 'S1', c: 'S2', D: 'S3', E: 'S1' };
    const childrenOf = (item, shape, shops) => shops.map((shop) => expectedReferenceRows(item, shape).filter((product) => SHOP_OF[product] === shop));
    // Crossings, a reference end, a collection end and a member of an owned row; `shop` is the connection field, which
    // these fields take no filter on. Under NE the Shop scope hides S2, and under proOnly the Pro scope hides P2, c's Pro.
    const CASES = [['pro.shop', 'IS_EMPTY'], ['pro.name', 'IS_EMPTY'], ['reviews', 'IS_EMPTY'], ['pro.shop.state', 'IS_NOT_EMPTY'], ['odim.shop', 'IS_EMPTY']]
      .map(([path, operator]) => relationCases.find((item) => item.root === 'product' && item.path === path && item.operator === operator));
    const SHAPES = [['admin', ['S1', 'S2', 'S3']], ['NE', ['S1', 'S3']], ['proOnly', ['S1', 'S2', 'S3']]];
    let batched; let unbatched; let declared; let undeclared;
    beforeAll(async () => {
      const runtimeOf = (options) => {
        const instance = createPostgres({ schema: namespace, ...options });
        const own = createReferenceEmptinessTypes('Qr');
        registerReferenceEmptinessTypes(instance, own);
        return { api: instance, types: own, schema: instance.createSchema() };
      };
      // A runtime on an adapter this test keeps, so that it can call findChildrenBatch with the runtime's models.
      const adapterOf = (plugin) => {
        const adapter = createSQLAdapter(plugin);
        const runtime = createRuntime(adapter);
        const own = createReferenceEmptinessTypes('Qr');
        registerReferenceEmptinessTypes(runtime, own);
        runtime.createSchema();
        return { adapter, types: own, model: runtime.getModel(own.Product) };
      };
      batched = runtimeOf({ pool: recording(pool, statements), batchedCollections: true });
      unbatched = runtimeOf({ pool });
      declared = adapterOf(postgresPlugin({ pool, schema: namespace, batchedCollections: true }));
      // The PostgreSQL plugin with a declaration of the operators alone: it batches, and its plans have no flag.
      undeclared = adapterOf({ ...postgresPlugin({ pool, schema: namespace, batchedCollections: true }), queryFeatures: { operators: postgresPlugin().queryFeatures.operators } });
      for (const { api: instance } of [batched, unbatched]) await instance.initializeDatabase({ mode: 'validate' });
      for (const { adapter } of [declared, undeclared]) await adapter.initialize({ mode: 'validate' });
    });

    it('filters batched collection fields through references and collections with one batched statement, as reads without batching do', async () => {
      for (const item of CASES) {
        const [head, ...rest] = item.path.split('.');
        const filter = { terms: [{ ...(rest.length ? { path: rest.join('.') } : {}), operator: item.operator }] };
        const source = `query($f:${emptinessArgumentType(batched.types, 'product', head)}){qrShops(sort:{terms:[{field:"key",order:ASC}]}){key products(${head}:$f,sort:{terms:[{field:"key",order:ASC}]}){key}}}`;
        for (const [shape, shops] of SHAPES) {
          const label = `${item.name} ${shape}`;
          const rows = childrenOf(item, shape, shops).map((products, index) => ({ key: shops[index], products: products.map((key) => ({ key })) }));
          statements.length = 0;
          const result = await graphql({ schema: batched.schema, source, variableValues: { f: filter }, contextValue: { shape } });
          expect(result.errors, label).toBeUndefined();
          expect(result.data.qrShops, label).toEqual(rows);
          // Every shop's products came from one batched statement.
          expect(statements.filter((text) => text.includes(' UNION ALL ') && text.includes('"__simfinity_parent"')), label).toHaveLength(1);
          const alone = await graphql({ schema: unbatched.schema, source, variableValues: { f: filter }, contextValue: { shape } });
          expect(alone.errors, label).toBeUndefined();
          expect(alone.data.qrShops, label).toEqual(rows);
        }
      }
    });

    it('reads batched children through the adapter\'s findChildrenBatch with the flag its plugin declares, and rejects them for a plugin that does not declare it', async () => {
      const shops = ['S1', 'S2', 'S3'];
      const parents = shops.map((key) => ids[key]);
      for (const item of CASES) {
        for (const [shape] of SHAPES) {
          const label = `${item.name} ${shape}`;
          const lists = await declared.adapter.findChildrenBatch(declared.model, declared.types.Product, 'shop', parents, clientArgs('product', referenceCaseArgs(item, ids), shape));
          expect(lists.map((list) => list.map((record) => record.key).sort()), label).toEqual(childrenOf(item, shape, shops));
          await expect(undeclared.adapter.findChildrenBatch(undeclared.model, undeclared.types.Product, 'shop', parents, clientArgs('product', referenceCaseArgs(item, ids), shape)), label)
            .rejects.toMatchObject({ message: expect.stringContaining(NOT_SUPPORTED), extensions: { code: 'UNSUPPORTED_QUERY', status: 400 } });
        }
      }
    });
  });

  describe('plans', () => {
    // Without hash joins, merge joins and materialized inner sides, each correlation that an index can serve runs as a
    // probe of that index, with an Index Cond, whatever the size of these tables.
    const explain = async (statement) => {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const setting of ['enable_seqscan', 'enable_hashjoin', 'enable_mergejoin', 'enable_material']) await client.query(`SET LOCAL ${setting} = off`);
        const { rows } = await client.query(`EXPLAIN (FORMAT JSON) ${statement.text}`, statement.values.map(encodeParameter));
        const plan = rows[0]['QUERY PLAN'];
        return (typeof plan === 'string' ? JSON.parse(plan) : plan)[0].Plan;
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    };
    const scans = (plan) => nodes(plan).filter((node) => node['Index Cond']).map((node) => [node['Index Name'], node['Index Cond']]);
    // An owned single object has a unique index and a foreign-key index on its __owner_id, and either serves the probe.
    const ownerIndex = (table) => Object.assign(new RegExp(`^${table}____owner_id__(uq|idx)$`), { table });
    // Whether the plan has an index scan whose index and condition match one of `alternatives`, each a pair of an index
    // name and its Index Cond, either a string or a pattern.
    const matches = (expected, actual) => (typeof expected === 'string' ? actual === expected : expected.test(actual));
    const probes = (used, ...alternatives) => alternatives.some(([index, condition]) => used.some(([name, cond]) => matches(index, name) && matches(condition, cond)));
    // A correlated EXISTS under OR may instead run as a hashed SubPlan, built once from a whole read of its table.
    // PostgreSQL 18 picks it for these small tables by cost, even through scans that enable_seqscan disables, so no
    // setting forces the probe there. The nodes under a hashed SubPlan may read their table whole.
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
    // The table an index belongs to: an entity's indexes start with its name, and an owned table's are ownerIndex().
    const tableOf = (index) => (typeof index === 'string' ? index.split('__')[0] : index.table);
    const hashedRead = (plan, ...alternatives) => alternatives.some(([index]) => hashedNodes(plan).some((node) => node['Relation Name'] === tableOf(index)));
    // EXPLAIN may name a column of a scoped join by its LATERAL's alias or by the alias of the table inside it.
    // In a batched statement it adds the branch's suffix, as in t2_1.
    const through = (key, column, suffix = '') => new RegExp(`^\\(${key} = t[12]${suffix}\\.${column}\\)$`);
    const find = (rootKey, path, operator, shape) => {
      const [head, ...rest] = path.split('.');
      const args = clientArgs(rootKey, { [head]: { terms: [{ ...(rest.length ? { path: rest.join('.') } : {}), operator }] } }, shape);
      return compileQuery(models, database, createQueryPlan(models, rootTypeOf(rootKey).name, args, { operators, referenceEmptiness: true, quantifiers }));
    };

    it('probes the target\'s primary key from frames and scoped joins, and the connection index from collection frames', async () => {
      // Each entry lists the probes the plan must have; a probe with two alternatives is a semi-join, which PostgreSQL
      // may also run from the target's side, through the index of the reference column.
      const PLANS = [
        ['product', 'shop', 'IS_EMPTY', 'NE', [[['QrShop__pk', '(id = t0.shop)']]]],
        ['product', 'shop', 'IS_NOT_EMPTY', 'EQ', [[['QrShop__pk', '(id = t0.shop)'], ['QrProduct__shop__idx', '(shop = t1.id)']]]],
        ['product', 'shop.state', 'IS_EMPTY', 'NE', [[['QrShop__pk', '(id = t0.shop)']]]],
        ['product', 'reviews', 'IS_EMPTY', 'NE', [[['QrReview__productId__idx', '("productId" = t0.id)']]]],
        ['product', 'reviews', 'IS_NOT_EMPTY', 'EQ', [[['QrReview__productId__idx', '("productId" = t0.id)'], ['QrProduct__pk', '(id = t1."productId")']]]],
        ['product', 'pro.shop', 'IS_EMPTY', 'NE', [[['QrPro__pk', '(id = t0.pro)']], [['QrShop__pk', through('id', 'shop')]]]],
        ['product', 'pro.shop.state', 'IS_EMPTY', 'proOnly', [[['QrPro__pk', '(id = t0.pro)']], [['QrShop__pk', through('id', 'shop')]]]],
        ['product', 'shop.products', 'IS_EMPTY', 'EQ', [[['QrShop__pk', '(id = t0.shop)']], [['QrProduct__shop__idx', through('shop', 'id')]]]],
        ['product', 'odim', 'IS_EMPTY', 'EQ', [[[ownerIndex('QrProduct__odim'), '(__owner_id = t0.id)']], [['QrShop__pk', '(id = t1.shop)']]]],
        ['kit', 'nest.inner.shop.name', 'IS_EMPTY', 'shopNE', [[[ownerIndex('QrKit__nest'), '(__owner_id = t0.id)']], [[ownerIndex('QrKit__nest__inner'), '(__owner_id = t1.__id)']], [['QrShop__pk', '(id = t2.shop)']]]],
      ];
      for (const [rootKey, path, operator, shape, expected] of PLANS) {
        const plan = await explain(find(rootKey, path, operator, shape));
        const used = scans(plan);
        for (const alternatives of expected) {
          expect(probes(used, ...alternatives) || hashedRead(plan, ...alternatives), `${path} ${operator} ${shape} ${alternatives.join(' | ')}: ${JSON.stringify(used)} ${JSON.stringify(plan)}`).toBe(true);
        }
        // Only the root, and the tables a hashed SubPlan reads once, may be read whole.
        const hashed = hashedNodes(plan);
        expect(nodes(plan).filter((node) => node['Node Type'] === 'Seq Scan' && node.Alias !== 't0' && !hashed.includes(node)), `${path} ${operator} ${shape} ${JSON.stringify(plan)}`).toEqual([]);
      }
    });

    it('serves a trusted reference IS_EMPTY with the generated index of its column', async () => {
      const statement = compileQuery(models, database, createQueryPlan(models, 'QrProduct', { shop: { terms: [{ operator: 'IS_EMPTY' }] } }, { operators, referenceEmptiness: true, quantifiers }));
      expect(statement.text).toContain('WHERE (t0."shop" IS NULL)');
      expect(scans(await explain(statement))).toEqual([['QrProduct__shop__idx', '(shop IS NULL)']]);
    });

    it('probes the same indexes in every branch of a batched children statement', async () => {
      const parents = ['S1', 'S2', 'S3'].map((key) => ids[key]);
      const args = { ...clientArgs('product', { pro: { terms: [{ path: 'shop', operator: 'IS_EMPTY' }] } }, 'NE'), pagination: { page: 1, size: 10 } };
      const plan = createQueryPlan(models, 'QrProduct', args, { mode: 'find', operators, referenceEmptiness: true, quantifiers });
      const used = scans(await explain(compileChildrenQuery(models, database, plan, { column: 'shop', ids: parents })));
      // EXPLAIN names each branch's copies of the aliases apart: t0, t0_1, t0_2.
      expect(used.filter(([name]) => name === 'QrPro__pk')).toEqual(parents.map(() => ['QrPro__pk', expect.stringMatching(/^\(id = t0(_\d+)?\.pro\)$/)]));
      expect(used.filter(([name]) => name === 'QrShop__pk')).toEqual(parents.map(() => ['QrShop__pk', expect.stringMatching(through('id', 'shop', '(_\\d+)?'))]));
    });
  });

  describe('a plugin that does not declare referenceEmptiness', () => {
    let undeclared;
    beforeAll(async () => {
      // The same storage, read by a plugin that declares the operators and not the flag, and by a copy whose
      // compileQuery is another function.
      const runtimeOf = (plugin) => {
        const instance = createSQL({ plugin });
        const own = createReferenceEmptinessTypes('Qr');
        registerReferenceEmptinessTypes(instance, own);
        return { api: instance, types: own, schema: instance.createSchema() };
      };
      undeclared = [
        runtimeOf({ ...postgresPlugin({ pool, schema: namespace }), queryFeatures: { operators: postgresPlugin().queryFeatures.operators } }),
        runtimeOf({ ...postgresPlugin({ pool, schema: namespace }), compileQuery: (...args) => compileQuery(...args) }),
      ];
      for (const { api: instance } of undeclared) await instance.initializeDatabase({ mode: 'validate' });
    });

    it('rejects emptiness through references and collections with UNSUPPORTED_QUERY, in GraphQL and in reads outside the runtime', async () => {
      // The plugin that declares the operators gives rule 6's message; the copy, which compiles the operators of 3.7.0,
      // rejects the operator itself.
      const messages = [
        (path, kind) => `IS_EMPTY on ${path} ${kind}: ${NOT_SUPPORTED}`,
        () => 'The IS_EMPTY filter operator is not supported by this query compiler',
      ];
      for (const [index, { api: instance, types: own, schema }] of undeclared.entries()) {
        for (const [path, kind] of [['shop', 'ends at the reference shop'], ['shop.name', 'crosses the reference shop'], ['reviews', 'ends at the collection reviews'], ['odim', 'reads the reference member odim.shop'], ['pro.shop.id', 'crosses the reference pro']]) {
          const [head, ...rest] = path.split('.');
          const args = { [head]: { terms: [{ ...(rest.length ? { path: rest.join('.') } : {}), operator: 'IS_EMPTY' }] } };
          const message = messages[index](path, kind);
          await expect(instance.getModel(own.Product).find(args), path).rejects.toMatchObject({ message, extensions: { code: 'UNSUPPORTED_QUERY', status: 400 } });
          // A marker, filled or not, lifts nothing.
          await expect(instance.getModel(own.Product).find(markClient(entities, types.Product, structuredClone(args), { shape: 'NE' })), path).rejects.toMatchObject({ message, extensions: { code: 'UNSUPPORTED_QUERY' } });
          const result = await graphql({ schema, source: `query($f:QLTypeFilterExpression){qrProducts(${head}:$f){key}}`, variableValues: { f: args[head] }, contextValue: {} });
          expect(code(result.errors?.[0]), path).toBe('UNSUPPORTED_QUERY');
        }
      }
      // The record's own fields keep 2a's forms.
      expect((await undeclared[0].api.getModel(undeclared[0].types.Product).find({ name: { operator: 'IS_NOT_EMPTY' }, odim: { terms: [{ path: 'w', operator: 'IS_EMPTY' }] } })).map((record) => record.key).sort()).toEqual(['C', 'D', 'E', 'c']);
    });
  });
});
