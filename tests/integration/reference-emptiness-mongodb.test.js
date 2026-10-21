import {
  afterAll, beforeAll, describe, expect, test,
} from 'vitest';
import mongoose from 'mongoose';
import {
  GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString,
} from 'graphql';
import { createMongoAdapter, createRuntime } from '../../packages/mongodb/src/index.js';
import { createMongoQueries } from '../../packages/mongodb/src/mongo/queries.js';
import {
  REFERENCE_CASES, REFERENCE_DANGLING_KEY, REFERENCE_SCOPES, REFERENCE_SHAPES, createReferenceEmptinessTypes,
  expectedReferenceRows, readMongoEmptinessDocuments, referenceCaseArgs, registerReferenceEmptinessTypes,
  seedReferenceEmptiness, writeMongoDanglingReference, writeMongoEmptinessDocuments,
} from '../helpers/query-emptiness.js';

// #108 part 2b on MongoDB: IS_EMPTY and IS_NOT_EMPTY through single references and at references and collections.
// A crossing reads its target through a join and a reference or collection end or member through a frame, one
// `$lookup` that keeps at most one record id (`__sf_qN`). A client construct carries the scope marker that the runtime
// fills after middleware, `__scope: { id, scopes }`: its crossings become scoped joins (`__sf_jN`, the target's find
// scope inside the `$lookup` pipeline) and its frames take the target's find scope, so a hidden record reads as
// missing. A construct without a marker reads stored data: its leaves share the plain lookup aliases (`__sf_lN`) of the
// other operators, and a dangling reference reads as empty. These tests call the compiler with markers filled as the
// runtime fills them, from the fixture's own find scopes; the parity tests run the same cases through the runtime. The
// compile tests need no database; the row, plan and batching tests run on the disposable replica set and standalone
// server.

const replicaSetUri = process.env.SIMFINITY_MONGODB_URI;
const standaloneUri = process.env.SIMFINITY_STANDALONE_MONGODB_URI;

const OPERATORS = ['IS_EMPTY', 'IS_NOT_EMPTY'];
const PAGE = [{ $skip: 0 }, { $limit: 100 }];
const HEX = '64b7f0c2a1b2c3d4e5f60718';
const EMPTY_STRING = { $in: [null, ''] };
const NOT_EMPTY_STRING = { $nin: [null, ''] };

// The compiled scope stages of the fixture's find scopes.
const SHOP_NE = [{ $match: { name: { $ne: 'S2' } } }];
const SHOP_EQ = [{ $match: { state: 'OPEN' } }];
const PRO_NE = [{ $match: { name: { $ne: 'P2' } } }];
const REVIEW_NE = [{ $match: { author: { $ne: 'hidden' } } }];

// Review.product is stored as productId, and no shape scopes Product, so a client marker on it holds null. This
// Product scope, written by the tests, hides the product D; it compiles to PRODUCT_NE.
const PRODUCT_SCOPE = Object.freeze({ name: Object.freeze({ operator: 'NE', value: 'D' }) });
const PRODUCT_NE = [{ $match: { name: { $ne: 'D' } } }];
// The reviews each shape reads: NE and EQ hide the reviews by "hidden" (the fixture's REFERENCE_SCOPES).
const ALL_REVIEWS = ['D:1:x', 'D:5:hidden', 'E:1:hidden', 'E:5:x', 'Ka:5:x', 'c:1:hidden'];
const VISIBLE_REVIEWS = {
  admin: ALL_REVIEWS, NE: ['D:1:x', 'E:5:x', 'Ka:5:x'], EQ: ['D:1:x', 'E:5:x', 'Ka:5:x'], proOnly: ALL_REVIEWS, shopNE: ALL_REVIEWS, shopEQ: ALL_REVIEWS,
};

const none = (alias) => ({ [`${alias}.0`]: { $exists: false } });
const frame = (from, localField, foreignField, alias, scope = []) => ({
  $lookup: {
    from, localField, foreignField, pipeline: [...scope, { $limit: 1 }, { $project: { _id: 1 } }], as: alias,
  },
});
const join = (from, localField, alias, scope = []) => [
  {
    $lookup: {
      from, localField, foreignField: '_id', pipeline: [...scope, { $limit: 1 }], as: alias,
    },
  },
  { $unwind: { path: `$${alias}`, preserveNullAndEmptyArrays: true } },
];
const plain = (from, localField, alias) => [
  {
    $lookup: {
      from, foreignField: '_id', localField, as: alias,
    },
  },
  { $unwind: { path: `$${alias}`, preserveNullAndEmptyArrays: true } },
];
const find = (stages, match, aliases) => [...stages, { $match: match }, ...PAGE, { $unset: aliases }];

const createFixture = (prefix, { adapter = createMongoAdapter(), preventCreatingCollection = false } = {}) => {
  const types = createReferenceEmptinessTypes(prefix, { backend: 'mongodb' });
  const runtime = createRuntime(adapter);
  if (preventCreatingCollection) runtime.preventCreatingCollection(true);
  registerReferenceEmptinessTypes(runtime, types);
  const schema = runtime.createSchema();
  const queries = createMongoQueries({ getModel: (type) => runtime.getModel(type), getRegistrations: () => runtime.getRegistrations() });
  return {
    adapter, runtime, schema, types, queries, model: (rootKey) => runtime.getModel(types.roots[rootKey].type),
  };
};

// The arguments a target's find scope gives for the request shape, as the runtime runs it before filling markers:
// empty arguments, operation find; null when the scope adds nothing.
const findScopeArgs = (type, shape) => {
  const args = {};
  type.extensions.scope.find({
    type, args, operation: 'find', context: { shape },
  });
  return Object.keys(args).length ? args : null;
};

const isEmptinessOperator = (operator) => operator === 'IS_EMPTY' || operator === 'IS_NOT_EMPTY';
const namedType = (type) => (type.ofType ? namedType(type.ofType) : type);
const isRelation = (field) => !!field.extensions?.relation && !field.extensions.relation.embedded;

// The paths whose scope a client construct on `path` reads, with their target types: each single reference the path
// crosses, its end when that is a reference or a collection, and the reference and collection members of an embedded
// end, through single embedded members.
const scopeTargets = (rootType, path) => {
  const targets = {};
  const segments = path.split('.');
  let type = rootType;
  let field = null;
  for (const [index, name] of segments.entries()) {
    field = type.getFields()[name];
    type = namedType(field.type);
    if (isRelation(field)) targets[segments.slice(0, index + 1).join('.')] = type;
  }
  const members = (objectType, base) => {
    for (const [name, member] of Object.entries(objectType.getFields())) {
      const memberType = namedType(member.type);
      if (isRelation(member)) targets[`${base}.${name}`] = memberType;
      else if (memberType instanceof GraphQLObjectType && !(member.type instanceof GraphQLList)) members(memberType, `${base}.${name}`);
    }
  };
  if (!isRelation(field) && type instanceof GraphQLObjectType && !(field.type instanceof GraphQLList)) members(type, path);
  return targets;
};

// Fills the marker of the client construct on `path` as the runtime does: one key per crossing, end and member path,
// each the find scope arguments of its target, computed once per call and target type (`cache`), or null. A construct
// on the record's own fields gets no marker.
const markConstruct = (rootType, construct, path, shape, cache = new Map()) => {
  const targets = Object.entries(scopeTargets(rootType, path));
  if (!targets.length) return construct;
  const scopes = {};
  for (const [scopePath, targetType] of targets) {
    if (!cache.has(targetType)) cache.set(targetType, findScopeArgs(targetType, shape));
    scopes[scopePath] = cache.get(targetType);
  }
  construct.__scope = { id: 0, scopes };
  return construct;
};

// Marks every emptiness term and group condition of client arguments that reads a reference or collection, with one
// cache for the call.
const markClientArgs = (rootType, args, shape) => {
  const cache = new Map();
  const reads = (path) => Object.keys(scopeTargets(rootType, path)).length > 0;
  const visit = (group) => {
    for (const condition of group.conditions ?? []) {
      const path = condition.path ? `${condition.field}.${condition.path}` : condition.field;
      if (isEmptinessOperator(condition.operator) && reads(path)) markConstruct(rootType, condition, path, shape, cache);
    }
    for (const nested of [...(group.AND ?? []), ...(group.OR ?? [])]) visit(nested);
  };
  for (const [field, filter] of Object.entries(args)) {
    if (['AND', 'OR', 'sort', 'pagination'].includes(field)) continue;
    for (const term of filter?.terms ?? []) {
      const path = term.path ? `${field}.${term.path}` : field;
      if (isEmptinessOperator(term.operator) && reads(path)) markConstruct(rootType, term, path, shape, cache);
    }
  }
  visit(args);
  return args;
};

// The construct of a REFERENCE_CASES construct case, in the arguments referenceCaseArgs writes.
const constructOf = (item, args, form) => (form === 'condition' ? args.AND[0].conditions[0] : args[item.path.split('.')[0]].terms[0]);

describe('MongoDB reference emptiness compilation', () => {
  const target = createFixture('QrmPlan', { preventCreatingCollection: true });
  const { types, adapter } = target;
  const from = (name) => `QrmPlan${name}`;
  const rootType = (rootKey) => types.roots[rootKey].type;
  const build = (args, rootKey = 'product', isCount) => adapter.buildQuery(args, rootType(rootKey), isCount);
  const term = (path, operator) => {
    const [head, ...rest] = path.split('.');
    return { [head]: { terms: [{ ...(rest.length ? { path: rest.join('.') } : {}), operator }] } };
  };
  const client = (path, operator, shape, { rootKey = 'product', form = 'field' } = {}) => {
    const args = referenceCaseArgs({ path, operator }, {}, form);
    markConstruct(rootType(rootKey), constructOf({ path }, args, form), path, shape);
    return args;
  };
  const errorOf = (body) => body().then(() => null, (error) => error);

  test('trusted constructs read stored data: frames without a scope, and leaves through the plain lookup aliases', async () => {
    expect(await build(term('shop', 'IS_EMPTY'))).toStrictEqual(find([frame(from('Shop'), 'shop', '_id', '__sf_q0')], none('__sf_q0'), ['__sf_q0']));
    expect(await build(term('shop', 'IS_NOT_EMPTY')))
      .toStrictEqual(find([frame(from('Shop'), 'shop', '_id', '__sf_q0')], { $nor: [none('__sf_q0')] }, ['__sf_q0']));
    // A collection reads its storage column, `productId`, and tests its local key for null.
    const reviews = { $or: [{ _id: null }, none('__sf_q0')] };
    expect(await build(term('reviews', 'IS_EMPTY'))).toStrictEqual(find([frame(from('Review'), '_id', 'productId', '__sf_q0')], reviews, ['__sf_q0']));
    // A leaf through a reference shares the lookup of the other operators on the path.
    expect(await build({ shop: { terms: [{ path: 'state', operator: 'IS_EMPTY' }, { path: 'name', value: 'S1' }] } })).toStrictEqual(find(
      plain(from('Shop'), 'shop', '__sf_l0'), { '__sf_l0.state': EMPTY_STRING, '__sf_l0.name': 'S1' }, ['__sf_l0'],
    ));
    // The target's identity right after a reference takes the null rule, also when it is declared String.
    expect(await build(term('shop.id', 'IS_EMPTY'))).toStrictEqual(find(plain(from('Shop'), 'shop', '__sf_l0'), { '__sf_l0._id': null }, ['__sf_l0']));
    expect(await build(term('shop.id', 'IS_NOT_EMPTY')))
      .toStrictEqual(find(plain(from('Shop'), 'shop', '__sf_l0'), { '__sf_l0._id': { $ne: null } }, ['__sf_l0']));
    expect(await build(term('pro.shop', 'IS_EMPTY'))).toStrictEqual(find(
      [...plain(from('Pro'), 'pro', '__sf_l0'), frame(from('Shop'), '__sf_l0.shop', '_id', '__sf_q0')], none('__sf_q0'), ['__sf_l0', '__sf_q0'],
    ));
    expect(await build(term('pro.shop.state', 'IS_NOT_EMPTY'))).toStrictEqual(find(
      [...plain(from('Pro'), 'pro', '__sf_l0'), ...plain(from('Shop'), '__sf_l0.shop', '__sf_l1')], { '__sf_l1.state': NOT_EMPTY_STRING }, ['__sf_l0', '__sf_l1'],
    ));
    expect(await build(term('shop.products', 'IS_EMPTY'))).toStrictEqual(find(
      [...plain(from('Shop'), 'shop', '__sf_l0'), frame(from('Product'), '__sf_l0._id', 'shop', '__sf_q0')],
      { $or: [{ '__sf_l0._id': null }, none('__sf_q0')] }, ['__sf_l0', '__sf_q0'],
    ));
    // The member rule with a reference member.
    expect(await build(term('odim', 'IS_EMPTY'))).toStrictEqual(find(
      [frame(from('Shop'), 'odim.shop', '_id', '__sf_q0')], { $or: [{ odim: null }, { $and: [{ 'odim.w': null }, none('__sf_q0')] }] }, ['__sf_q0'],
    ));
    // Review.product is stored as productId.
    expect(await build(term('product.shop', 'IS_EMPTY'), 'review')).toStrictEqual(find(
      [...plain(from('Product'), 'productId', '__sf_l0'), frame(from('Shop'), '__sf_l0.shop', '_id', '__sf_q0')], none('__sf_q0'), ['__sf_l0', '__sf_q0'],
    ));
  });

  test('client constructs read through scoped joins and frames, in a field filter term and in a group condition', async () => {
    for (const form of ['field', 'condition']) {
      expect(await build(client('shop', 'IS_EMPTY', 'NE', { form })), form)
        .toStrictEqual(find([frame(from('Shop'), 'shop', '_id', '__sf_q0', SHOP_NE)], none('__sf_q0'), ['__sf_q0']));
      expect(await build(client('shop.state', 'IS_EMPTY', 'EQ', { form })), form)
        .toStrictEqual(find(join(from('Shop'), 'shop', '__sf_j0', SHOP_EQ), { '__sf_j0.state': EMPTY_STRING }, ['__sf_j0']));
    }
    expect(await build(client('shop', 'IS_NOT_EMPTY', 'EQ')))
      .toStrictEqual(find([frame(from('Shop'), 'shop', '_id', '__sf_q0', SHOP_EQ)], { $nor: [none('__sf_q0')] }, ['__sf_q0']));
    expect(await build(client('shop.id', 'IS_EMPTY', 'NE')))
      .toStrictEqual(find(join(from('Shop'), 'shop', '__sf_j0', SHOP_NE), { '__sf_j0._id': null }, ['__sf_j0']));
    expect(await build(client('reviews', 'IS_EMPTY', 'NE'))).toStrictEqual(find(
      [frame(from('Review'), '_id', 'productId', '__sf_q0', REVIEW_NE)], { $or: [{ _id: null }, none('__sf_q0')] }, ['__sf_q0'],
    ));
    // Product has no find scope, so the collection frame after the scoped crossing has none, and reads through it.
    expect(await build(client('shop.products', 'IS_EMPTY', 'NE'))).toStrictEqual(find(
      [...join(from('Shop'), 'shop', '__sf_j0', SHOP_NE), frame(from('Product'), '__sf_j0._id', 'shop', '__sf_q0')],
      { $or: [{ '__sf_j0._id': null }, none('__sf_q0')] }, ['__sf_j0', '__sf_q0'],
    ));
    expect(await build(client('odim', 'IS_NOT_EMPTY', 'NE'))).toStrictEqual(find(
      [frame(from('Shop'), 'odim.shop', '_id', '__sf_q0', SHOP_NE)], { $nor: [{ $or: [{ odim: null }, { $and: [{ 'odim.w': null }, none('__sf_q0')] }] }] }, ['__sf_q0'],
    ));
    expect(await build(client('odim.shop.state', 'IS_EMPTY', 'EQ')))
      .toStrictEqual(find(join(from('Shop'), 'odim.shop', '__sf_j0', SHOP_EQ), { '__sf_j0.state': EMPTY_STRING }, ['__sf_j0']));
    expect(await build(client('product.shop', 'IS_EMPTY', 'shopEQ', { rootKey: 'review' }), 'review')).toStrictEqual(find(
      [...plain(from('Product'), 'productId', '__sf_l0'), frame(from('Shop'), '__sf_l0.shop', '_id', '__sf_q0', SHOP_EQ)], none('__sf_q0'), ['__sf_l0', '__sf_q0'],
    ));
  });

  test('a reference stored under another name frames and joins on its storage column, trusted and client', async () => {
    // Review.product, stored as productId: the frame reads productId, never the field name, in each form.
    const scoped = (operator, form) => {
      const args = referenceCaseArgs({ path: 'product', operator }, {}, form);
      constructOf({ path: 'product' }, args, form).__scope = { id: 0, scopes: { product: PRODUCT_SCOPE } };
      return args;
    };
    for (const [operator, match] of [['IS_EMPTY', none('__sf_q0')], ['IS_NOT_EMPTY', { $nor: [none('__sf_q0')] }]]) {
      for (const form of ['field', 'condition']) {
        const label = `${operator} ${form}`;
        const stored = find([frame(from('Product'), 'productId', '_id', '__sf_q0')], match, ['__sf_q0']);
        expect(await build(referenceCaseArgs({ path: 'product', operator }, {}, form), 'review'), `${label} trusted`).toStrictEqual(stored);
        expect(await build(client('product', operator, 'NE', { rootKey: 'review', form }), 'review'), `${label} client`).toStrictEqual(stored);
        expect(await build(scoped(operator, form), 'review'), `${label} scoped`)
          .toStrictEqual(find([frame(from('Product'), 'productId', '_id', '__sf_q0', PRODUCT_NE)], match, ['__sf_q0']));
      }
    }
    // A scoped crossing of it joins on the same column, and the hop after it correlates through the join.
    const crossing = { product: { terms: [{ path: 'shop.state', operator: 'IS_EMPTY', __scope: { id: 0, scopes: { product: PRODUCT_SCOPE, 'product.shop': null } } }] } };
    expect(await build(crossing, 'review')).toStrictEqual(find(
      [...join(from('Product'), 'productId', '__sf_j0', PRODUCT_NE), ...join(from('Shop'), '__sf_j0.shop', '__sf_j1')], { '__sf_j1.state': EMPTY_STRING }, ['__sf_j0', '__sf_j1'],
    ));
  });

  test('a client construct whose scopes are all null compiles exactly as the trusted one, so an admin shares its joins', async () => {
    const readsRelations = (entry) => entry.path && Object.keys(scopeTargets(rootType(entry.root), entry.path)).length > 0;
    for (const item of REFERENCE_CASES.filter(readsRelations)) {
      for (const form of ['field', 'condition']) {
        const trusted = await build(referenceCaseArgs(item, {}, form), item.root);
        const marked = referenceCaseArgs(item, {}, form);
        markConstruct(rootType(item.root), constructOf(item, marked, form), item.path, 'admin');
        expect(Object.values(constructOf(item, marked, form).__scope.scopes).every((scope) => scope === null), item.name).toBe(true);
        expect(await build(marked, item.root), `${item.name} ${form}`).toStrictEqual(trusted);
      }
    }
  });

  test('a hop after a scoped crossing stays scoped, also when its own scope is null', async () => {
    // Pro is scoped and Shop is not: the second hop correlates through the first scoped join.
    expect(await build(client('pro.shop.state', 'IS_EMPTY', 'proOnly'))).toStrictEqual(find(
      [...join(from('Pro'), 'pro', '__sf_j0', PRO_NE), ...join(from('Shop'), '__sf_j0.shop', '__sf_j1')], { '__sf_j1.state': EMPTY_STRING }, ['__sf_j0', '__sf_j1'],
    ));
    expect(await build(client('pro.shop', 'IS_EMPTY', 'proOnly'))).toStrictEqual(find(
      [...join(from('Pro'), 'pro', '__sf_j0', PRO_NE), frame(from('Shop'), '__sf_j0.shop', '_id', '__sf_q0')], none('__sf_q0'), ['__sf_j0', '__sf_q0'],
    ));
    // An unscoped first hop is the plain join; the scoped second hop reads through it.
    expect(await build(client('pro.shop.state', 'IS_EMPTY', 'shopNE'))).toStrictEqual(find(
      [...plain(from('Pro'), 'pro', '__sf_l0'), ...join(from('Shop'), '__sf_l0.shop', '__sf_j0', SHOP_NE)], { '__sf_j0.state': EMPTY_STRING }, ['__sf_l0', '__sf_j0'],
    ));
    // In one query: a client chain, a trusted condition on the same path, a legacy condition in an OR branch and a
    // client chain in another. No client hop reuses a plain alias or a trusted frame.
    const args = {
      pro: { terms: [{ path: 'shop', operator: 'IS_EMPTY' }] },
      AND: [{ conditions: [{ field: 'pro', path: 'shop', operator: 'IS_NOT_EMPTY' }] }],
      OR: [
        { conditions: [{ field: 'pro', path: 'shop.name', operator: 'EQ', value: 'S2' }] },
        { conditions: [{ field: 'pro', path: 'shop.state', operator: 'IS_EMPTY' }] },
      ],
    };
    const cache = new Map();
    markConstruct(types.Product, args.pro.terms[0], 'pro.shop', 'proOnly', cache);
    markConstruct(types.Product, args.OR[1].conditions[0], 'pro.shop.state', 'proOnly', cache);
    const pipeline = await build(args);
    expect(pipeline).toStrictEqual([
      ...join(from('Pro'), 'pro', '__sf_j0', PRO_NE), frame(from('Shop'), '__sf_j0.shop', '_id', '__sf_q0'),
      ...plain(from('Pro'), 'pro', '__sf_l0'), frame(from('Shop'), '__sf_l0.shop', '_id', '__sf_q1'),
      ...plain(from('Shop'), '__sf_l0.shop', '__sf_l1'), ...join(from('Shop'), '__sf_j0.shop', '__sf_j1'),
      {
        $match: {
          $and: [
            none('__sf_q0'), { $nor: [none('__sf_q1')] }, { $or: [{ '__sf_l1.name': 'S2' }, { '__sf_j1.state': EMPTY_STRING }] },
          ],
        },
      },
      ...PAGE,
      { $unset: ['__sf_j0', '__sf_q0', '__sf_l0', '__sf_q1', '__sf_l1', '__sf_j1'] },
    ]);
  });

  test('legacy conditions keep their lookups, aliases and match when client constructs share the query', async () => {
    const legacy = {
      shop: { terms: [{ path: 'name', value: 'S1' }] }, AND: [{ conditions: [{ field: 'pro.shop.state', value: 'OPEN' }] }],
      sort: { terms: [{ field: 'pro.name', order: 'ASC' }] },
    };
    const alone = await build(structuredClone(legacy));
    expect(alone).toStrictEqual([
      ...plain(from('Shop'), 'shop', '__sf_l0'), ...plain(from('Pro'), 'pro', '__sf_l1'), ...plain(from('Shop'), '__sf_l1.shop', '__sf_l2'),
      { $match: { $and: [{ '__sf_l0.name': 'S1' }, { '__sf_l2.state': 'OPEN' }] } }, { $sort: { '__sf_l1.name': 1 } }, ...PAGE,
      { $unset: ['__sf_l0', '__sf_l1', '__sf_l2'] },
    ]);
    const mixed = structuredClone(legacy);
    mixed.OR = [{ conditions: [{ field: 'pro', path: 'shop.state', operator: 'IS_EMPTY' }] }, { conditions: [{ field: 'reviews', operator: 'IS_EMPTY' }] }];
    markClientArgs(types.Product, mixed, 'NE');
    const pipeline = await build(mixed);
    const relation = (stage) => /^__sf_[jq]/.test(stage.$lookup?.as ?? stage.$unwind?.path.slice(1) ?? '');
    expect(pipeline.filter((stage) => !relation(stage) && !stage.$match && !stage.$unset)).toStrictEqual(alone.filter((stage) => !stage.$match && !stage.$unset));
    expect(pipeline.filter(relation)).toStrictEqual([
      ...join(from('Pro'), 'pro', '__sf_j0', PRO_NE), ...join(from('Shop'), '__sf_j0.shop', '__sf_j1', SHOP_NE),
      frame(from('Review'), '_id', 'productId', '__sf_q0', REVIEW_NE),
    ]);
    expect(pipeline.find((stage) => stage.$match)).toStrictEqual({
      $match: {
        $and: [
          { '__sf_l0.name': 'S1' }, { '__sf_l2.state': 'OPEN' }, { $or: [{ '__sf_j1.state': EMPTY_STRING }, { $or: [{ _id: null }, none('__sf_q0')] }] },
        ],
      },
    });
  });

  test('each target scope compiles with this compiler in a fresh alias space, with the target model', async () => {
    // A Pro scope that crosses Pro.shop: its own plain lookup restarts at __sf_l0 inside the join, apart from the
    // query's __sf_l0, which joins Product.shop.
    const crossing = {
      shop: { terms: [{ path: 'name', value: 'S1' }] },
      pro: {
        terms: [{
          path: 'shop.state', operator: 'IS_EMPTY', __scope: { id: 0, scopes: { pro: { shop: { terms: [{ path: 'state', value: 'OPEN' }] } }, 'pro.shop': null } },
        }],
      },
    };
    expect(await build(crossing)).toStrictEqual(find([
      ...plain(from('Shop'), 'shop', '__sf_l0'),
      ...join(from('Pro'), 'pro', '__sf_j0', [...plain(from('Shop'), 'shop', '__sf_l0'), { $match: { '__sf_l0.state': 'OPEN' } }]),
      ...join(from('Shop'), '__sf_j0.shop', '__sf_j1'),
    ], { '__sf_l0.name': 'S1', '__sf_j1.state': EMPTY_STRING }, ['__sf_l0', '__sf_j0', '__sf_j1']));
    // Shop's identity, declared String, is cast to the model's ObjectId; sort and pagination are not filters.
    const casting = {
      shop: {
        terms: [{
          operator: 'IS_EMPTY',
          __scope: { id: 0, scopes: { shop: { id: { operator: 'NE', value: HEX }, sort: { terms: [{ field: 'name', order: 'ASC' }] }, pagination: { page: 1, size: 1 } } } },
        }],
      },
    };
    expect(await build(casting)).toStrictEqual(find(
      [frame(from('Shop'), 'shop', '_id', '__sf_q0', [{ $match: { _id: { $ne: new mongoose.Types.ObjectId(HEX) } } }])], none('__sf_q0'), ['__sf_q0'],
    ));
    // Emptiness inside a scope is trusted: its frame restarts at __sf_q0 inside the outer __sf_q0.
    const nested = { shop: { terms: [{ operator: 'IS_EMPTY', __scope: { id: 0, scopes: { shop: { products: { terms: [{ operator: 'IS_NOT_EMPTY' }] } } } } }] } };
    expect(await build(nested)).toStrictEqual(find([frame(from('Shop'), 'shop', '_id', '__sf_q0', [
      frame(from('Product'), '_id', 'shop', '__sf_q0'), { $match: { $nor: [{ $or: [{ _id: null }, none('__sf_q0')] }] } },
    ])], none('__sf_q0'), ['__sf_q0']));
  });

  test('joins and frames are shared by scope object, and a scope that adds nothing reads as none', async () => {
    const scope = { name: { operator: 'NE', value: 'S2' } };
    const marked = (path, scopes) => ({ field: 'shop', ...(path ? { path } : {}), operator: 'IS_EMPTY', __scope: { id: 0, scopes } });
    // The same scope object: the frame and both joins carry it, and the two joins on one path are one.
    expect(await build({ AND: [{ conditions: [marked(null, { shop: scope }), marked('state', { shop: scope }), marked('name', { shop: scope })] }] }))
      .toStrictEqual(find([frame(from('Shop'), 'shop', '_id', '__sf_q0', [{ $match: { name: { $ne: 'S2' } } }]), ...join(from('Shop'), 'shop', '__sf_j0', [{ $match: { name: { $ne: 'S2' } } }])], {
        $and: [none('__sf_q0'), { '__sf_j0.state': EMPTY_STRING }, { '__sf_j0.name': EMPTY_STRING }],
      }, ['__sf_q0', '__sf_j0']));
    // Equal scope objects that are not the same object are not shared.
    const twice = await build({ AND: [{ conditions: [marked('state', { shop: { ...scope } }), marked('name', { shop: { ...scope } })] }] });
    expect(twice.filter((stage) => stage.$lookup).map((stage) => stage.$lookup.as)).toEqual(['__sf_j0', '__sf_j1']);
    // A scope without filters is no scope: the plain lookup and the trusted frame.
    expect(await build({ AND: [{ conditions: [marked('state', { shop: { AND: [] } }), marked(null, { shop: {} })] }] })).toStrictEqual(find(
      [...plain(from('Shop'), 'shop', '__sf_l0'), frame(from('Shop'), 'shop', '_id', '__sf_q0')],
      { $and: [{ '__sf_l0.state': EMPTY_STRING }, none('__sf_q0')] }, ['__sf_l0', '__sf_q0'],
    ));
  });

  test('counts and aggregates add the joins and frames before $count and $group', async () => {
    const args = () => markClientArgs(types.Product, { shop: { terms: [{ operator: 'IS_EMPTY' }, { path: 'state', operator: 'IS_NOT_EMPTY' }] } }, 'EQ');
    const stages = [frame(from('Shop'), 'shop', '_id', '__sf_q0', SHOP_EQ), ...join(from('Shop'), 'shop', '__sf_j0', SHOP_EQ)];
    const match = { $match: { '__sf_q0.0': { $exists: false }, '__sf_j0.state': NOT_EMPTY_STRING } };
    expect(await build(args(), 'product', true)).toStrictEqual([...stages, match, { $count: 'size' }]);
    const aggregation = { groupId: 'name', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }] };
    expect(await target.queries.buildAggregationQuery(args(), types.Product, aggregation)).toStrictEqual([
      ...stages, match, { $group: { _id: '$name', fact_0: { $sum: 1 } } },
      { $project: { _id: 0, groupId: '$_id', facts: { n: '$fact_0' } } }, { $sort: { groupId: 1 } },
    ]);
  });

  test('a marker that is not filled for every path the construct reads fails closed, after every 400', async () => {
    const outcome = async (args) => {
      const clauses = [];
      const included = {};
      const error = await errorOf(() => adapter.buildFilterGroupMatch(args, types.Product, clauses, included));
      expect(clauses, JSON.stringify(args)).toEqual([]);
      return [error?.extensions?.code, error?.extensions?.status, error?.message];
    };
    const suffix = '; only the runtime writes and fills client scope markers (docs/guide/middleware.md)';
    const condition = (field, path, operator, extra) => ({ conditions: [{ field, ...(path ? { path } : {}), operator, ...extra }] });
    for (const marker of [{ id: 0 }, null, 0, { id: 0, scopes: null }, { id: 0, scopes: [] }]) {
      expect(await outcome(condition('shop', 'state', 'IS_EMPTY', { __scope: marker }))).toEqual([
        'DETACHED_CLIENT_FILTER', 500, `IS_EMPTY on shop.state carries a client scope marker whose scopes are not filled${suffix}`,
      ]);
    }
    for (const scopes of [{ pro: null }, { pro: null, 'pro.shop': undefined }, { 'pro.shop': null }]) {
      const missing = Object.hasOwn(scopes, 'pro') ? 'pro.shop' : 'pro';
      expect(await outcome(condition('pro', 'shop.state', 'IS_EMPTY', { __scope: { id: 0, scopes } }))).toEqual([
        'DETACHED_CLIENT_FILTER', 500, `IS_EMPTY on pro.shop.state carries a client scope marker without the scope of ${missing}${suffix}`,
      ]);
    }
    expect(await outcome(condition('odim', 'w', 'IS_EMPTY', { __scope: { id: 0, scopes: {} } }))).toEqual([
      'DETACHED_CLIENT_FILTER', 500, `IS_EMPTY on odim.w carries a client scope marker, but reads no reference or collection${suffix}`,
    ]);
    expect(await outcome(condition('shop', 'name', 'EQ', { value: 'S1', __scope: { id: 0, scopes: { shop: null } } }))).toEqual([
      'DETACHED_CLIENT_FILTER', 500, `EQ on shop.name carries a client scope marker, but is not an emptiness condition${suffix}`,
    ]);
    expect(await outcome(condition('stock', null, 'GT', { value: 1, __scope: { id: 0, scopes: {} } }))).toEqual([
      'DETACHED_CLIENT_FILTER', 500, `GT on stock carries a client scope marker, but is not an emptiness condition${suffix}`,
    ]);
    const marked = await errorOf(() => build({ shop: { terms: [{ path: 'name', operator: 'NE', value: 'S1', __scope: { id: 0, scopes: { shop: null } } }] } }));
    expect([marked?.extensions?.code, marked?.message]).toEqual(['DETACHED_CLIENT_FILTER', `NE on shop.name carries a client scope marker, but is not an emptiness condition${suffix}`]);
    // The 400s of the order of checks come first.
    expect((await outcome(condition('shop', 'state', 'IS_EMPTY', { value: 'x', __scope: { id: 0 } })))[0]).toBe('INVALID_FILTER_VALUE');
    expect((await outcome(condition('olines', 'shop', 'IS_EMPTY', { __scope: { id: 0 } })))[0]).toBe('INVALID_FILTER_PATH');
    expect((await outcome(condition('shop', 'name', 'EQ', { value: 5, __scope: { id: 0 } })))[0]).toBe('INVALID_FILTER_VALUE');
  });

  test('a marker anywhere else is not read (regression pin, passes on 3.10.0)', async () => {
    // Field filters, groups and values are no constructs.
    expect(await build({ name: { operator: 'IS_EMPTY', __scope: { id: 0 } }, AND: [{ conditions: [], __scope: { id: 0 } }] }))
      .toStrictEqual([{ $match: { name: EMPTY_STRING } }, ...PAGE]);
    const planted = await errorOf(() => build({ id: { operator: 'EQ', value: { id: HEX, __scope: { id: 0 } } } }));
    expect(planted?.extensions?.code).toBe('INVALID_FILTER_VALUE');
  });
});

// Every record of the fixture, with the dangling product, on the replica set (written through generated mutations)
// and the standalone server (the replica set's documents, inserted natively).
const servers = [
  ['replica set', replicaSetUri, 'QrmRs'],
  ['standalone server', standaloneUri, 'QrmSa'],
];
let replicaSet = null;
const connectTo = async (uri, suffix) => {
  await mongoose.connect(uri, { dbName: `${new URL(uri).pathname.slice(1)}_${suffix}`, monitorCommands: true });
  await mongoose.connection.dropDatabase();
};
// Generated models create their collections and indexes in the background; let them finish before the database is
// dropped, so that none is created again afterwards.
const dropDatabase = async () => {
  await Promise.allSettled(mongoose.modelNames().map((name) => mongoose.model(name).init()));
  await mongoose.connection.dropDatabase();
};
const seedReplicaSet = async (target) => {
  const ids = await seedReferenceEmptiness(target.schema, target.types);
  await writeMongoDanglingReference(target.runtime, target.types);
  replicaSet = { ids, documents: await readMongoEmptinessDocuments(target.runtime, target.types) };
};
const seedOwnReplicaSet = async () => {
  await connectTo(replicaSetUri, 'qrm_seed');
  const seeding = createFixture('QrmSeed');
  await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
  await seedReplicaSet(seeding);
  await dropDatabase();
  await mongoose.disconnect();
};

// The runtime's legacy joined scopes for the args cases: a legacy condition ANDs, into its group, the find scope of
// each reference it crosses, prefixed; a sort adds it to the whole query.
const joinedConditions = (types, path, shape) => {
  const conditions = [];
  const segments = path.split('.');
  let type = types.Product;
  for (const [index, name] of segments.slice(0, -1).entries()) {
    const field = type.getFields()[name];
    type = field.type;
    const typeKey = Object.entries(types.roots).find(([, root]) => root.type === type)?.[0];
    const restriction = REFERENCE_SCOPES[shape][typeKey];
    if (restriction) conditions.push({ ...restriction, field: [...segments.slice(0, index + 1), restriction.field].join('.') });
  }
  return conditions;
};
const withJoinedScopes = (types, args, shape) => {
  const visit = (group) => {
    const legacy = (group.conditions ?? []).filter((condition) => !isEmptinessOperator(condition.operator));
    for (const condition of legacy) {
      group.conditions.push(...joinedConditions(types, condition.path ? `${condition.field}.${condition.path}` : condition.field, shape));
    }
    for (const nested of [...(group.AND ?? []), ...(group.OR ?? [])]) visit(nested);
  };
  visit(args);
  const sorted = (args.sort?.terms ?? []).flatMap((term) => joinedConditions(types, term.field, shape));
  if (sorted.length) args.AND = [...(args.AND ?? []), { conditions: sorted }];
  return args;
};

// A collection member inside an embedded type, which only a supplied model reaches: Box.inner.kids, whose children
// point to the subdocument `_id` of `inner`. Orphan kids have a null or missing `box`.
const createBoxes = (prefix) => {
  const Kid = new GraphQLObjectType({ name: `${prefix}Kid`, fields: { id: { type: GraphQLID }, key: { type: GraphQLString }, n: { type: GraphQLInt } } });
  const Inner = new GraphQLObjectType({
    name: `${prefix}Inner`,
    fields: { label: { type: GraphQLString }, kids: { type: new GraphQLList(Kid), extensions: { relation: { embedded: false, connectionField: 'box' } } } },
  });
  const Box = new GraphQLObjectType({
    name: `${prefix}Box`,
    fields: { id: { type: GraphQLID }, key: { type: new GraphQLNonNull(GraphQLString) }, inner: { type: Inner, extensions: { relation: { embedded: true } } } },
  });
  const { ObjectId } = mongoose.Schema.Types;
  const BoxModel = mongoose.model(`${prefix}Box`, new mongoose.Schema({ key: String, inner: new mongoose.Schema({ label: String }) }), `${prefix}Box`);
  const KidModel = mongoose.model(`${prefix}Kid`, new mongoose.Schema({ key: String, n: Number, box: ObjectId }), `${prefix}Kid`);
  const models = new Map([[Box, BoxModel], [Kid, KidModel]]);
  const queries = createMongoQueries({ getModel: (type) => models.get(type) ?? null, getRegistrations: () => [] });
  return {
    Box, Kid, BoxModel, KidModel, queries,
  };
};

describe.each(servers)('MongoDB reference emptiness on a %s', (label, uri, prefix) => {
  const enabled = !!uri && !!replicaSetUri;
  let target;
  let boxes;

  const keysOf = async (rootKey, pipeline) => (await target.model(rootKey).aggregate(pipeline)).map((document) => document.key).sort();
  // The rows of client or trusted arguments on a root, with the root's own find scope applied as the runtime applies
  // it to every query.
  const rowsOf = async (rootKey, args, shape, isCount) => {
    const { type } = target.types.roots[rootKey];
    type.extensions.scope.find({
      type, args, operation: 'find', context: { shape },
    });
    const pipeline = await target.adapter.buildQuery(args, type, isCount);
    return isCount ? (await target.model(rootKey).aggregate(pipeline))[0]?.size ?? 0 : keysOf(rootKey, pipeline);
  };
  const clientArgs = (item, shape, form) => {
    const args = referenceCaseArgs(item, replicaSet.ids, form);
    markConstruct(target.types.roots[item.root].type, constructOf(item, args, form), item.path, shape);
    return args;
  };

  beforeAll(async () => {
    if (!enabled) return;
    if (label === 'standalone server' && !replicaSet) await seedOwnReplicaSet();
    await connectTo(uri, 'qrm');
    target = createFixture(prefix, { adapter: createMongoAdapter({ batchedCollections: true, collectionBatchSize: 2 }) });
    boxes = createBoxes(prefix);
    await Promise.all(mongoose.modelNames().map((name) => mongoose.model(name).init()));
    if (label === 'replica set') await seedReplicaSet(target);
    else await writeMongoEmptinessDocuments(target.runtime, target.types, replicaSet.documents);
    await target.model('product').collection.createIndex({ name: 1 });
  }, 60000);

  afterAll(async () => {
    if (!enabled) return;
    await dropDatabase();
    await mongoose.disconnect();
  });

  describe.skipIf(!enabled)('rows', () => {
    test('the fixture is stored, with the dangling product (helper check, passes on 3.10.0)', async () => {
      expect(await keysOf('product', [{ $match: {} }])).toEqual(['C', 'D', REFERENCE_DANGLING_KEY, 'E', 'Ka', 'c'].sort());
      const dangling = await target.model('product').collection.findOne({ key: REFERENCE_DANGLING_KEY });
      expect(await target.model('shop').collection.countDocuments({ _id: dangling.shop })).toBe(0);
    });

    test('every construct case, client in a term and a group condition and trusted, for every shape', async () => {
      for (const item of REFERENCE_CASES.filter((entry) => entry.path)) {
        for (const shape of REFERENCE_SHAPES) {
          const label = `${item.name} ${shape}`;
          const expected = expectedReferenceRows(item, shape, { dangling: true });
          for (const form of ['field', 'condition']) expect(await rowsOf(item.root, clientArgs(item, shape, form), shape), `${label} ${form}`).toEqual(expected);
          expect(await rowsOf(item.root, referenceCaseArgs(item), shape), `${label} trusted`)
            .toEqual(expectedReferenceRows(item, shape, { trusted: true, dangling: true }));
        }
      }
    }, 60000);

    test('a reference stored under another name reads its storage column, trusted and client', async () => {
      // Every review has a product, so IS_EMPTY on Review.product matches none and IS_NOT_EMPTY every review the
      // caller reads; a Product scope that hides D empties the reviews of D.
      const item = (operator) => ({ root: 'review', path: 'product', operator });
      const scoped = (operator, form) => {
        const args = referenceCaseArgs(item(operator), {}, form);
        constructOf(item(operator), args, form).__scope = { id: 0, scopes: { product: PRODUCT_SCOPE } };
        return args;
      };
      for (const shape of REFERENCE_SHAPES) {
        const visible = VISIBLE_REVIEWS[shape];
        const ofD = visible.filter((key) => key.startsWith('D:'));
        for (const form of ['field', 'condition']) {
          const label = `${shape} ${form}`;
          expect(await rowsOf('review', clientArgs(item('IS_EMPTY'), shape, form), shape), `${label} client`).toEqual([]);
          expect(await rowsOf('review', clientArgs(item('IS_NOT_EMPTY'), shape, form), shape), `${label} client`).toEqual(visible);
          expect(await rowsOf('review', referenceCaseArgs(item('IS_EMPTY'), {}, form), shape), `${label} trusted`).toEqual([]);
          expect(await rowsOf('review', referenceCaseArgs(item('IS_NOT_EMPTY'), {}, form), shape), `${label} trusted`).toEqual(visible);
          expect(await rowsOf('review', scoped('IS_EMPTY', form), shape), `${label} scoped`).toEqual(ofD);
          expect(await rowsOf('review', scoped('IS_NOT_EMPTY', form), shape), `${label} scoped`).toEqual(visible.filter((key) => !ofD.includes(key)));
        }
      }
    }, 60000);

    test('IS_EMPTY matches the dangling reference and IS_NOT_EMPTY does not, for every caller', async () => {
      for (const path of ['shop', 'shop.id', 'shop.state', 'pro', 'pro.shop', 'odim', 'odim.shop']) {
        for (const shape of REFERENCE_SHAPES) {
          const [empty, notEmpty] = await Promise.all(OPERATORS.map((operator) => rowsOf('product', clientArgs({ root: 'product', path, operator }, shape, 'field'), shape)));
          expect(empty, `${path} ${shape}`).toContain(REFERENCE_DANGLING_KEY);
          expect(notEmpty, `${path} ${shape}`).not.toContain(REFERENCE_DANGLING_KEY);
        }
      }
    });

    test('legacy branches, a sort and trusted conditions beside client constructs keep the documented rows', async () => {
      for (const item of REFERENCE_CASES.filter((entry) => entry.args)) {
        for (const shape of REFERENCE_SHAPES) {
          const args = withJoinedScopes(target.types, markClientArgs(target.types.Product, referenceCaseArgs(item, replicaSet.ids), shape), shape);
          // Conditions that the root's own find scope appends are trusted.
          if (item.scopeArgs) args.AND = [...(args.AND ?? []), ...structuredClone(item.scopeArgs).AND];
          expect(await rowsOf('product', args, shape), `${item.name} ${shape}`).toEqual(expectedReferenceRows(item, shape, { dangling: true }));
        }
      }
    }, 60000);

    test('counts and aggregates read the same joins and frames', async () => {
      for (const item of REFERENCE_CASES.filter((entry) => entry.root === 'product' && ['pro.shop', 'shop.products', 'odim'].includes(entry.path))) {
        for (const shape of ['admin', 'NE', 'proOnly', 'shopEQ']) {
          const expected = expectedReferenceRows(item, shape, { dangling: true });
          expect(await rowsOf('product', clientArgs(item, shape, 'condition'), shape, true), `${item.name} ${shape}`).toBe(expected.length);
          const pipeline = await target.queries.buildAggregationQuery(clientArgs(item, shape, 'field'), target.types.Product, {
            groupId: 'key', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }],
          });
          expect(await target.model('product').aggregate(pipeline), `${item.name} ${shape}`).toEqual(expected.map((key) => ({ groupId: key, facts: { n: 1 } })));
        }
      }
    }, 60000);

    test('collection reads filter children one parent at a time and batched with $unionWith', async () => {
      const Product = target.model('product');
      const shops = ['S1', 'S2', 'S3'].map((key) => replicaSet.ids[key]);
      const commands = [];
      // Only this test's reads, whose pipelines start with the match on a parent: an earlier test that timed out may
      // still be sending aggregates on Product.
      const readsParent = (pipeline) => shops.some((shop) => String(pipeline[0]?.$match?.shop) === shop);
      const listener = (event) => {
        if (event.commandName === 'aggregate' && event.command.aggregate === Product.collection.collectionName && readsParent(event.command.pipeline)) {
          commands.push(event.command.pipeline);
        }
      };
      const client = mongoose.connection.getClient();
      // Products by shop: S1 Ka and E, S2 c, S3 D. A hidden Pro (P2, c's) and one without a shop (P4, D's) empty pro.shop.
      const cases = [
        [{ root: 'product', path: 'pro.shop', operator: 'IS_EMPTY' }, 'NE', [['E'], ['c'], ['D']]],
        [{ root: 'product', path: 'pro.shop.state', operator: 'IS_NOT_EMPTY' }, 'proOnly', [['Ka'], [], []]],
        [{ root: 'product', path: 'reviews', operator: 'IS_EMPTY' }, 'EQ', [[], ['c'], []]],
      ];
      client.on('commandStarted', listener);
      try {
        for (const [item, shape, expected] of cases) {
          const read = (lists) => lists.map((list) => list.map((document) => document.key).sort());
          commands.length = 0;
          const oneByOne = await Promise.all(shops.map((shop) => target.adapter.findChildren(Product, target.types.Product, 'shop', shop, clientArgs(item, shape, 'field'))));
          expect(read(oneByOne), `${item.path} ${shape}`).toEqual(expected);
          expect(commands.every((pipeline) => pipeline.every((stage) => !stage.$unionWith))).toBe(true);
          commands.length = 0;
          const batched = await target.adapter.findChildrenBatch(Product, target.types.Product, 'shop', shops, clientArgs(item, shape, 'field'));
          expect(read(batched), `${item.path} ${shape}`).toEqual(expected);
          // Three parents in batches of two: one command with a $unionWith stage, and one without. Each sub-pipeline
          // holds the joins and frames before its $match.
          expect(commands).toHaveLength(2);
          const [unionWith] = commands[0].filter((stage) => stage.$unionWith).map((stage) => stage.$unionWith);
          expect(unionWith.pipeline.slice(1, -1)).toEqual(commands[0].slice(1, unionWith.pipeline.length - 1));
          expect(unionWith.pipeline.some((stage) => /^__sf_[jq]\d+$/.test(stage.$lookup?.as ?? ''))).toBe(true);
        }
      } finally {
        client.off('commandStarted', listener);
      }
    });

    test('a collection member inside an embedded type of a supplied model reads the subdocument _id, with the null guard', async () => {
      const ids = [0, 1, 2, 3].map(() => new mongoose.Types.ObjectId());
      await boxes.BoxModel.collection.insertMany([
        { key: 'a', inner: { _id: ids[0], label: 'a' } }, { key: 'b', inner: { _id: ids[1] } }, { key: 'c' },
        { key: 'd', inner: { _id: ids[2], label: null } }, { key: 'e', inner: { _id: ids[3], label: 'e' } },
      ]);
      // Kids of a and d, and orphans whose null or missing box a missing local key would otherwise match.
      await boxes.KidModel.collection.insertMany([
        { key: 'k1', n: 1, box: ids[0] }, { key: 'k3', n: 5, box: ids[2] }, { key: 'k0', n: 9, box: null }, { key: 'k2', n: 9 },
      ]);
      const rows = async (args) => (await boxes.BoxModel.aggregate(await boxes.queries.buildQuery(args, boxes.Box))).map((document) => document.key).sort();
      const condition = (field, operator, scopes) => ({ AND: [{ conditions: [{ field, operator, ...(scopes ? { __scope: { id: 0, scopes } } : {}) }] }] });
      expect(await rows(condition('inner.kids', 'IS_EMPTY'))).toEqual(['b', 'c', 'e']);
      expect(await rows(condition('inner.kids', 'IS_NOT_EMPTY'))).toEqual(['a', 'd']);
      expect(await rows(condition('inner', 'IS_EMPTY'))).toEqual(['b', 'c']);
      expect(await rows(condition('inner', 'IS_NOT_EMPTY'))).toEqual(['a', 'd', 'e']);
      // A Kid find scope that hides k1 empties a's kids, and a's label keeps its inner.
      const scope = { 'inner.kids': { AND: [{ conditions: [{ field: 'n', operator: 'GT', value: 1 }] }] } };
      expect(await rows(condition('inner.kids', 'IS_EMPTY', scope))).toEqual(['a', 'b', 'c', 'e']);
      expect(await rows(condition('inner', 'IS_EMPTY', scope))).toEqual(['b', 'c']);
    });
  });

  describe.skipIf(!enabled)('plans', () => {
    // Index use of each $lookup by alias: a classic $lookup stage reports `indexesUsed` and `collectionScans`; a
    // lookup that the slot-based engine runs reports an EQ_LOOKUP stage with its strategy and index.
    const lookupIndexes = (explain) => {
      const found = {};
      const walk = (node) => {
        if (Array.isArray(node)) node.forEach(walk);
        else if (node && typeof node === 'object') {
          if (node.$lookup && Array.isArray(node.indexesUsed)) found[node.$lookup.as] = [node.indexesUsed, node.collectionScans];
          if (node.stage === 'EQ_LOOKUP') found[node.asField] = node.strategy === 'IndexedLoopJoin' ? [[node.indexName], 0] : [[], 1];
          Object.values(node).forEach(walk);
        }
      };
      walk(explain);
      return found;
    };
    const rootScans = (explain) => {
      const found = new Set();
      const walk = (node) => {
        if (Array.isArray(node)) node.forEach(walk);
        else if (node && typeof node === 'object') {
          if (node.stage === 'IXSCAN' || node.stage === 'COLLSCAN') found.add(`${node.stage} ${JSON.stringify(node.indexBounds ?? null)}`);
          for (const [key, value] of Object.entries(node)) if (key !== '$lookup') walk(value);
        }
      };
      walk(explain);
      return [...found];
    };

    test('joins and frames probe the _id index and the connection index, and the root predicate keeps its index bounds', async () => {
      // Before 8.0, equality with null also matched the deprecated undefined type, so the null interval starts at
      // undefined, as in part 2a.
      const { versionArray } = await target.model('product').db.db.admin().serverInfo();
      const notEmpty = [versionArray[0] < 8 ? '[MinKey, undefined)' : '[MinKey, null)', '(null, "")', '("", MaxKey]'];
      const cases = [
        ['shop', 'IS_EMPTY', 'NE', { __sf_q0: ['_id_'] }],
        ['shop.state', 'IS_EMPTY', 'EQ', { __sf_j0: ['_id_'] }],
        ['reviews', 'IS_NOT_EMPTY', 'NE', { __sf_q0: ['productId_1'] }],
        ['shop.products', 'IS_EMPTY', 'NE', { __sf_j0: ['_id_'], __sf_q0: ['shop_1'] }],
        ['pro.shop.state', 'IS_EMPTY', 'proOnly', { __sf_j0: ['_id_'], __sf_j1: ['_id_'] }],
        ['pro.shop', 'IS_EMPTY', 'shopNE', { __sf_l0: ['_id_'], __sf_q0: ['_id_'] }],
        ['odim', 'IS_EMPTY', 'EQ', { __sf_q0: ['_id_'] }],
        ['shop', 'IS_EMPTY', 'admin', { __sf_q0: ['_id_'] }],
      ];
      for (const [path, operator, shape, indexes] of cases) {
        const args = clientArgs({ root: 'product', path, operator }, shape, 'field');
        args.name = { operator: 'IS_NOT_EMPTY' };
        const pipeline = await target.adapter.buildQuery(args, target.types.Product);
        const explain = await target.model('product').aggregate(pipeline).explain('executionStats');
        const label = `${path} ${operator} ${shape}`;
        expect(rootScans(explain), label).toEqual([`IXSCAN ${JSON.stringify({ name: notEmpty })}`]);
        expect(lookupIndexes(explain), label).toEqual(Object.fromEntries(Object.entries(indexes).map(([alias, used]) => [alias, [used, 0]])));
      }
    });
  });
});
