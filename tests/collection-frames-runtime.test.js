import { afterEach, describe, expect, it, vi } from 'vitest';
import { graphql, GraphQLInt, GraphQLList } from 'graphql';
import { QLOperator, configureQueryLimits, createRuntime } from '../packages/core/src/index.js';
import * as auth from '../packages/core/src/auth/index.js';
import { createReferenceEmptinessTypes, registerReferenceEmptinessTypes } from './helpers/query-emptiness.js';
import { COLLECTION_DATA, createMemoryAdapter, referenceStore } from './helpers/collection-frames.js';

const OPERATORS = QLOperator.getValues().map(({ value }) => value);
const DECLARED = { operators: OPERATORS, referenceEmptiness: true, quantifiers: true };
const LEGACY = { operators: OPERATORS, referenceEmptiness: true };
const condition = (field = 'reviews.rating', value = 4, operator = 'GTE') => ({ field, operator, value });
const shorthand = () => ({ AND: [{ conditions: [condition()] }] });
const explicit = () => ({ AND: [{ ANY: [{ path: 'reviews', conditions: [condition('rating')] }] }] });
const aggregation = { groupId: 'name', facts: [{ factName: 'n', operation: 'COUNT', path: 'id' }] };
const allNodes = (node) => !node ? [] : [node, ...(node.terms ?? []).flatMap(allNodes), ...allNodes(node.where), ...allNodes(node.scope), ...Object.values(node.joins ?? {}).flatMap(allNodes)];
const build = ({ queryFeatures = DECLARED, scoped = ['review'], batch = false, permissions, configure } = {}) => {
  const calls = [];
  const scopeCalls = [];
  const middlewareCalls = [];
  const types = createReferenceEmptinessTypes('Cf');
  for (const key of ['shop', 'pro', 'product', 'review']) {
    const type = types.roots[key].type;
    type.extensions = {};
    if (scoped.includes(key)) type.extensions.scope = { find: async (params) => {
      scopeCalls.push(key);
      await params.context?.scopes?.[key]?.(params);
    } };
  }
  configure?.(types);
  const runtime = createRuntime(createMemoryAdapter({ queryFeatures, calls, batch, data: referenceStore('Cf', { records: COLLECTION_DATA }) }));
  runtime.use(async (params, next) => {
    middlewareCalls.push(params.type.gqltype.name);
    await params.context?.middleware?.(params);
    await next();
  });
  registerReferenceEmptinessTypes(runtime, types);
  const schema = runtime.createSchema();
  if (permissions) auth.createAuthPlugin(permissions, { defaultPolicy: 'DENY' }).onSchemaChange({ schema });
  const invoke = async (args, context = {}, site = 'find', root = 'product') => {
    const type = types.roots[root];
    const field = site === 'children' ? types.Shop.getFields().products : schema.getQueryType().getFields()[`${type.plural}${site === 'aggregate' ? '_aggregate' : ''}`];
    try {
      const rows = await field.resolve(site === 'children' ? { _id: 'S1', id: 'S1' } : null,
        site === 'aggregate' ? { aggregation: structuredClone(aggregation), ...args } : args, context);
      return { rows };
    } catch (error) { return { error }; }
  };
  const run = (source, variables, context = {}) => graphql({ schema, source, variableValues: variables, contextValue: context });
  return { calls, scopeCalls, middlewareCalls, types, runtime, schema, invoke, run };
};
const ok = (result) => expect(result.error ?? result.errors).toBeUndefined();
const code = (result, expected) => expect(result.error?.extensions?.code ?? result.errors?.[0]?.extensions?.code).toBe(expected);
afterEach(() => configureQueryLimits({}));

describe('collection frame runtime inputs and scope provenance', () => {
  it.each(['ANY', 'ALL', 'NONE'])('exposes %s groups and quantified field filters', async (quantifier) => {
    const f = build();
    const result = await f.run('query($g:[QLFilterGroup],$f:QLTypeFilterExpression){ a:cfProducts(AND:$g){key} b:cfProducts(reviews:$f){key} }', {
      g: [{ [quantifier]: [{ path: 'reviews', conditions: [condition('rating')] }] }],
      f: { quantifier, terms: [{ path: 'rating', operator: 'GTE', value: 4 }] },
    });
    ok(result);
    expect(f.calls.map(({ plan }) => allNodes(plan.where).find((node) => node.kind === 'quantified')?.quantifier)).toEqual([quantifier, quantifier]);
  });

  it.each(['find', 'aggregate', 'children'])('fills shorthand scopes and removes cut leaf markers on %s', async (site) => {
    const f = build();
    let pending;
    const result = await f.invoke(shorthand(), {
      middleware: ({ args }) => { pending = structuredClone(args.AND); },
      scopes: { review: ({ args }) => { args.author = { operator: 'NE', value: 'hidden' }; } },
    }, site);
    ok(result);
    expect(pending[0].conditions[0].__scope).toEqual({ id: 0 });
    expect(f.calls[0].args.AND[0].conditions[0].__scope).toEqual({ id: 0, scopes: { reviews: { author: { operator: 'NE', value: 'hidden' } } } });
    const frame = allNodes(f.calls[0].plan.where).find((node) => node.kind === 'quantified');
    expect(frame).toMatchObject({ path: ['reviews'], scope: { path: ['author'], operator: 'NE' }, where: { path: ['rating'] } });
    expect(frame.where).not.toHaveProperty('joins');
    expect(f.calls[0].rows).toEqual(['E', 'Ka']);
  });

  it.each([[], ['review'], ['product'], ['review', 'product']].map((scoped) => [scoped]))('marks nested groups by registered scope on the absolute chain %j', async (scoped) => {
    const f = build({ scoped });
    let before;
    const result = await f.invoke({ AND: [{ ANY: [{ path: 'reviews', conditions: [condition('product.name', 'Ka', 'EQ')] }] }] }, {
      middleware: ({ args }) => { before = structuredClone(args); },
    });
    ok(result);
    const group = before.AND[0].ANY[0];
    expect(allNodes(f.calls[0].plan.where).some((node) => node.kind === 'quantified')).toBe(true);
    expect(!!group.__scope).toBe(scoped.length > 0);
    expect(!!group.conditions[0].__scope).toBe(scoped.length > 0);
    const final = f.calls[0].args.AND[0].ANY[0];
    if (scoped.length) {
      expect(final.__scope.scopes).toEqual({ reviews: null });
      expect(final.conditions[0].__scope.scopes).toEqual({ product: null });
    }
  });

  it.each([false, true])('propagates nested scopes and marks own fields only when their absolute chain is scoped, outer=%s', async (outerScoped) => {
    const f = build({ scoped: outerScoped ? ['review', 'product'] : ['review'] });
    let pending;
    const result = await f.invoke({ AND: [{ ANY: [{ path: 'products', conditions: [condition('name', 'Ka', 'EQ')], ANY: [{ path: 'reviews' }] }] }] }, {
      middleware: ({ args }) => { pending = structuredClone(args); },
    }, 'find', 'shop');
    ok(result);
    const outer = pending.AND[0].ANY[0];
    expect(outer.__scope).toBeDefined();
    expect(outer.ANY[0].__scope).toBeDefined();
    expect(!!outer.conditions[0].__scope).toBe(outerScoped);
    expect(f.calls[0].args.AND[0].ANY[0].ANY[0].__scope.scopes).toEqual({ reviews: null });
  });

  it('marks explicit reference frames and drops own-field child markers at fill', async () => {
    const f = build({ scoped: ['shop'] });
    let pending;
    ok(await f.invoke({ shop: { quantifier: 'ANY', terms: [{ path: 'name', operator: 'EQ', value: 'S1' }] } }, {
      middleware: ({ args }) => { pending = structuredClone(args); },
    }));
    expect(pending.shop.__scope).toBeDefined();
    expect(pending.shop.terms[0].__scope).toBeDefined();
    expect(f.calls[0].args.shop.__scope.scopes).toEqual({ shop: null });
    expect(f.calls[0].args.shop.terms[0].__scope).toBeUndefined();
  });

  it('marks an unscoped collection with a scoped preceding reference', async () => {
    const f = build({ scoped: ['shop'] });
    ok(await f.invoke({ AND: [{ conditions: [condition('shop.products.name', 'Ka', 'EQ')] }] }));
    expect(f.calls[0].args.AND[0].conditions[0].__scope.scopes).toEqual({ shop: null, 'shop.products': null });
    expect(allNodes(f.calls[0].plan.where).find((n) => n.kind === 'quantified').joins).toEqual({ shop: null });
  });

  it('pin: preserves legacy reference-only marking and joined scope placement beside a frame', async () => {
    const f = build({ scoped: ['shop'] });
    let marker;
    ok(await f.invoke({ AND: [{ conditions: [condition('shop.name', 'S1', 'EQ'), condition()] }] }, {
      middleware: ({ args }) => { marker = args.AND[0].conditions[0].__scope; },
      scopes: { shop: ({ args }) => { args.name = { operator: 'NE', value: 'S2' }; } },
    }));
    expect(marker).toBeUndefined();
    expect(f.calls[0].args.AND[0].AND).toEqual([{ conditions: [{ field: 'shop.name', operator: 'NE', value: 'S2' }] }]);
  });
});

const edits = [
  ['spread', (a) => { a.AND[0].conditions[0] = { ...a.AND[0].conditions[0] }; }, true],
  ['clone', (a) => { a.AND = structuredClone(a.AND); }, true],
  ['duplicate', (a) => { a.OR = a.AND; }, true],
  ['move key', (a) => { a.OR = a.AND; delete a.AND; }, true],
  ['own field', (a) => { a.AND[0].conditions[0].field = 'stock'; }, true],
  ['path edit', (a) => { Object.assign(a.AND[0].conditions[0], condition('reviews.author', 'x', 'EQ')); }, true],
  ['shorthand prefix', (a) => { const c = a.AND[0].conditions[0]; c.path = 'rating'; delete c.field; a.reviews = { terms: [c] }; delete a.AND; }, true],
  ['rebuild', (a) => { a.AND = shorthand().AND; }, false],
  ['drop', (a) => { delete a.AND; }, false],
  ['assign over', (a) => { a.AND = []; }, false],
  ['prefill', (a) => { a.AND[0].conditions[0].__scope = { id: 0, scopes: {} }; }, false],
  ['forge', (a) => { a.AND[0].conditions[0].__scope = { id: 99 }; }, false],
  ...['ANY', 'ALL', 'NONE'].flatMap((q) => ['reviews', 'shop', 'shop.products'].map((path) => [`trusted ${q} ${path}`, (a) => {
    const c = a.AND[0].conditions[0]; c.field = path === 'reviews' ? 'rating' : path === 'shop' ? 'name' : 'stock'; c.value = path === 'shop' ? 'S1' : 4;
    a.AND = [{ [q]: [{ path, conditions: [c] }] }];
  }, false])),
  ['trusted field quantifier', (a) => { const c = a.AND[0].conditions[0]; c.path = 'rating'; delete c.field; a.reviews = { quantifier: 'ANY', terms: [c] }; delete a.AND; }, false],
  ['unsupported legacy move', (a) => { Object.assign(a.AND[0].conditions[0], condition('shop.name', 'S1', 'EQ')); }, false],
];
describe.each(['find', 'aggregate', 'children'])('client provenance on %s', (site) => {
  it.each(edits)('%s', async (_name, edit, allowed) => {
    const f = build();
    let marked;
    const result = await f.invoke(shorthand(), { middleware: ({ args }) => {
      marked = args.AND[0].conditions[0].__scope;
      edit(args);
    } }, site);
    // Establish provenance even for allowed edits that happen to have the same rows on legacy adapters.
    expect(marked).toEqual({ id: 0 });
    if (allowed) { ok(result); expect(f.calls).toHaveLength(1); }
    else { code(result, 'DETACHED_CLIENT_FILTER'); expect(f.calls).toHaveLength(0); }
  });
  it('protects inner conditions and permits lifting them to a final shorthand path', async () => {
    for (const drop of [false, true]) {
      const f = build();
      const result = await f.invoke(explicit(), { middleware: ({ args }) => {
        const g = args.AND[0].ANY[0];
        const c = g.conditions.pop();
        if (!drop) { c.field = 'reviews.rating'; args.AND[0].conditions = [c]; }
      } }, site);
      if (drop) { code(result, 'DETACHED_CLIENT_FILTER'); expect(f.calls).toHaveLength(0); }
      else { ok(result); expect(f.calls[0].args.AND[0].conditions[0].__scope.scopes).toEqual({ reviews: null }); }
    }
  });
});

describe('runtime gates, joined scopes and limits', () => {
  it.each(['ANY', 'ALL', 'NONE'])('rejects %s on undeclared adapters before middleware', async (q) => {
    const f = build({ queryFeatures: LEGACY });
    code(await f.invoke({ AND: [{ [q]: [{ path: 'reviews' }] }] }), 'UNSUPPORTED_QUERY');
    expect(f.middlewareCalls).toEqual([]); expect(f.scopeCalls).toEqual([]); expect(f.calls).toEqual([]);
  });
  it.each([{ quantifier: 'NONE', terms: [{ operator: 'IS_NOT_EMPTY' }] }, { quantifier: 'ANY', terms: [{ operator: 'EQ', value: 1 }] }, { quantifier: 'ANY', terms: [{ path: '', operator: 'EQ', value: 1 }] }])('rejects pathless quantified terms before scopes: %j', async (filter) => {
    const f = build();
    code(await f.invoke({ reviews: filter }), 'INVALID_FILTER_PATH');
    expect(f.middlewareCalls).toEqual([]); expect(f.scopeCalls).toEqual([]); expect(f.calls).toEqual([]);
  });
  it.each([false, true])('rejects client collection sort before scopes and middleware, count=%s', async (count) => {
    const f = build();
    const result = await f.invoke({ sort: { terms: [{ field: 'reviews.rating', order: 'ASC' }] }, pagination: { page: 1, size: 10, count } });
    code(result, 'INVALID_FILTER_PATH');
    expect(result.error.message).toBe('Sort path reviews.rating crosses the collection CfProduct.reviews; a record has no single value there');
    expect(f.middlewareCalls).toEqual([]); expect(f.scopeCalls).toEqual([]); expect(f.calls).toEqual([]);
  });
  it.each([false, true])('rejects trusted collection sorts in the final gate, count=%s', async (count) => {
    const f = build();
    code(await f.invoke({ pagination: { page: 1, size: 10, count } }, { middleware: ({ args }) => { args.sort = { terms: [{ field: 'reviews.rating', order: 'ASC' }] }; } }), 'INVALID_FILTER_PATH');
    expect(f.calls).toEqual([]);
  });
  it('gates raw joined-scope quantifiers before prefixing on an undeclared adapter', async () => {
    const f = build({ queryFeatures: LEGACY, scoped: ['shop'] });
    code(await f.invoke({ shop: { terms: [{ path: 'name', operator: 'EQ', value: 'S1' }] } }, {
      scopes: { shop: ({ args }) => { args.products = { quantifier: 'NONE', terms: [{ path: 'stock', operator: 'EQ', value: 5 }] }; } },
    }), 'UNSUPPORTED_QUERY');
    expect(f.calls).toEqual([]);
  });
  it('prefixes only the outer quantified paths and expands quantified field terms', async () => {
    const f = build({ scoped: ['shop'] });
    const nested = { path: 'products', AND: [{ conditions: [condition('stock', 5, 'EQ')] }], ANY: [{ path: 'reviews', conditions: [condition('rating')] }] };
    ok(await f.invoke({ shop: { terms: [{ path: 'name', operator: 'EQ', value: 'S1' }] } }, { scopes: { shop: ({ args }) => {
      args.products = { quantifier: 'ALL', terms: [{ path: 'stock', operator: 'EQ', value: 5 }] };
      args.AND = [{ ANY: [structuredClone(nested)] }];
      args.OR = [{ NONE: [{ path: 'products' }] }];
      args.sort = { terms: [{ field: 'products.stock', order: 'ASC' }] };
    } } }));
    expect(f.calls[0].args.AND).toEqual([
      { ALL: [{ path: 'shop.products', conditions: [condition('stock', 5, 'EQ')] }] },
      { ANY: [{ ...nested, path: 'shop.products' }] },
      { OR: [{ NONE: [{ path: 'shop.products' }] }] },
    ]);
  });
  it.each([['pin: flattened', 'flattened'], ['pin: quantifier', 'quantifier'], ['explicit', 'explicit']])('rejects joined %s collection scopes under an embedded-list prefix', async (_name, form) => {
    const f = build({ scoped: ['shop'] });
    const result = await f.invoke({ AND: [{ conditions: [condition('olines.shop.name', 'S1', 'EQ')] }] }, { scopes: { shop: ({ args }) => {
      if (form === 'flattened') args.products = { terms: [{ path: 'stock', operator: 'EQ', value: 5 }] };
      else if (form === 'quantifier') args.products = { quantifier: 'ANY' };
      else args.AND = [{ ANY: [{ path: 'products' }] }];
    } } });
    code(result, 'FORBIDDEN_FILTER_PATH'); expect(f.calls).toEqual([]);
  });
  it.each([3, 4])('enforces shorthand frame nesting at %i', async (depth) => {
    const f = build({ scoped: [] });
    const path = `${'products.shop.'.repeat(depth)}name`;
    const result = await f.invoke({ AND: [{ conditions: [condition(path, 'S1', 'EQ')] }] }, {}, 'find', 'shop');
    if (depth === 4) { code(result, 'FILTER_DEPTH_EXCEEDED'); expect(f.calls).toEqual([]); }
    else { ok(result); expect(allNodes(f.calls[0].plan.where).filter((n) => n.kind === 'quantified')).toHaveLength(3); }
  });
  it('pin: an undeclared adapter keeps a four-collection scalar path at the default nesting limit', async () => {
    const f = build({ queryFeatures: LEGACY, scoped: [] });
    ok(await f.invoke({ AND: [{ conditions: [condition(`${'products.shop.'.repeat(4)}name`, 'S1', 'EQ')] }] }, {}, 'find', 'shop'));
    expect(f.calls).toHaveLength(1);
  });
  it('counts unmarked frames independently and uses the exact maxReferenceFrames diagnostic', async () => {
    configureQueryLimits({ maxReferenceFrames: 1 });
    const f = build({ scoped: [] });
    const result = await f.invoke({ AND: [{ conditions: [condition()], ANY: [{ path: 'reviews' }] }] });
    code(result, 'FILTER_DEPTH_EXCEEDED');
    expect(result.error.message).toBe('The client\'s conditions need 2 frames and scoped joins in one query field, more than the limit of 1 (maxReferenceFrames)');
    expect(f.middlewareCalls).toEqual([]); expect(f.calls).toEqual([]);
  });
});

describe('frame positions, trust and caches', () => {
  it.each(['find', 'aggregate', 'children'])('rejects aliased relative keys with different targets before target scopes on %s', async (site) => {
    const f = build({ scoped: ['shop', 'pro'], configure: (types) => {
      types.Review.getFields().pro = { ...types.Product.getFields().pro, type: types.Shop };
    } });
    const result = await f.invoke({ AND: [{ conditions: [{ field: 'pro.name', operator: 'IS_EMPTY' }], ANY: [{ path: 'reviews', conditions: [{ field: 'pro.name', operator: 'IS_EMPTY' }] }] }] }, {
      middleware: ({ args }) => { args.AND[0].ANY[0].conditions.push(args.AND[0].conditions[0]); },
    }, site);
    code(result, 'DETACHED_CLIENT_FILTER');
    expect(result.error.message).toContain('different scope targets');
    expect(f.scopeCalls).toEqual([]); expect(f.calls).toEqual([]);
  });
  it('unions aliased same-target keys and fills each type once per call', async () => {
    const f = build({ scoped: ['shop', 'review'] });
    ok(await f.invoke({ AND: [{ ANY: [{ path: 'reviews', conditions: [condition('product.shop.name', 'S1', 'EQ')] }] }] }, {
      middleware: ({ args }) => { args.OR = args.AND; },
    }));
    const inner = f.calls[0].args.AND[0].ANY[0].conditions[0];
    expect(inner.__scope.scopes).toEqual({ product: null, 'product.shop': null });
    expect(f.scopeCalls).toEqual(['review', 'shop']);
  });
  it('keeps separate legacy-join and client-frame scope runs', async () => {
    const f = build({ scoped: ['shop'] });
    const spy = vi.fn(({ args }) => { args.name = { operator: 'NE', value: 'S2' }; });
    ok(await f.invoke({ AND: [{ conditions: [condition('shop.name', 'S1', 'EQ')], ANY: [{ path: 'shop' }] }] }, { scopes: { shop: spy } }));
    expect(spy).toHaveBeenCalledTimes(2);
    expect(f.calls[0].args.AND[0].ANY[0].__scope.scopes).toEqual({ shop: { name: { operator: 'NE', value: 'S2' } } });
  });
  it.each([false, true])('checks embedded-list reference scope after middleware, narrowed=%s', async (narrowed) => {
    const f = build({ scoped: ['shop'] });
    const result = await f.invoke({ AND: [{ conditions: [condition('olines.shop.products.name', 'Ka', 'EQ')] }] }, {
      middleware: ({ args }) => { if (narrowed) args.AND[0].conditions[0].field = 'name'; },
      scopes: { shop: ({ args }) => { args.name = { operator: 'NE', value: 'S2' }; } },
    });
    if (narrowed) { ok(result); expect(f.scopeCalls).toEqual([]); expect(f.calls[0].args.AND[0].conditions[0].__scope).toBeUndefined(); }
    else {
      code(result, 'FORBIDDEN_FILTER_PATH');
      expect(result.error.message).toBe('Query path olines.shop enters CfShop, whose find scope restricts the relation CfOLine.shop inside a list');
      expect(f.calls).toEqual([]);
    }
  });
  it('fills aggregate J with null, omits anchor-reference keys and keeps their legacy scope placement', async () => {
    const f = build({ scoped: ['product', 'pro', 'shop'] });
    const result = await f.invoke({
      aggregation: { ...aggregation, groupId: 'products.key' },
      AND: [{ conditions: [condition('products.pro.shop.products.name', 'Ka', 'EQ')] }],
    }, { scopes: { pro: ({ args }) => { args.name = { operator: 'NE', value: 'P2' }; } } }, 'aggregate', 'shop');
    ok(result);
    expect(f.calls[0].args.AND[0].conditions[0].__scope.scopes).toEqual({ products: null, 'products.pro.shop.products': null });
    expect(f.calls[0].args.AND[0].AND).toEqual([{ conditions: [{ field: 'products.pro.name', operator: 'NE', value: 'P2' }] }]);
    // Product once for J recording and once for the outside-J frame; Shop once as an anchor reference.
    expect(f.scopeCalls.filter((key) => key === 'product')).toHaveLength(2);
    const frame = allNodes(f.calls[0].plan.where).find((node) => node.kind === 'quantified');
    expect(frame.anchor).toEqual(['products', 'pro', 'shop']); expect(frame).not.toHaveProperty('joins');
  });
  it('rejects top-frame J drift before filling or calling the adapter', async () => {
    const f = build();
    const result = await f.invoke(shorthand(), { middleware: ({ args }) => { args.aggregation.groupId = 'reviews.author'; } }, 'aggregate');
    code(result, 'DETACHED_CLIENT_FILTER'); expect(f.scopeCalls).toEqual([]); expect(f.calls).toEqual([]);
  });
  it('applies root J only at the root, including inside an explicit frame on the same prefix', async () => {
    const f = build({ scoped: ['product', 'review'] });
    ok(await f.invoke({ aggregation: { ...aggregation, groupId: 'products.reviews.author' }, AND: [{ ALL: [{ path: 'products', conditions: [condition()] }] }] }, {}, 'aggregate', 'shop'));
    const frame = f.calls[0].args.AND[0].ALL[0];
    expect(frame.__scope.scopes).toEqual({ products: null });
    expect(frame.conditions[0].__scope.scopes).toEqual({ reviews: null });
    expect(allNodes(f.calls[0].plan.where).filter((node) => node.kind === 'quantified').map((node) => node.path)).toEqual([['products'], ['reviews']]);
  });
  it.each(['list', 'aggregate'])('copies shared quantified variables and aliased list positions across a list and %s', async (second) => {
    const f = build();
    const group = { path: 'reviews', conditions: [condition('rating')] };
    const variables = { g: [{ ANY: [group, group] }] };
    const before = structuredClone(variables);
    const secondField = second === 'list' ? 'cfProducts(AND:$g){key}' : 'cfProducts_aggregate(AND:$g,aggregation:{groupId:"name",facts:[{operation:COUNT,factName:"n",path:"id"}]}){groupId}';
    ok(await f.run(`query($g:[QLFilterGroup]){a:cfProducts(AND:$g){key} b:${secondField}}`, variables, {
      middleware: ({ args }) => {
        expect(args.AND[0].ANY[0]).not.toBe(args.AND[0].ANY[1]);
        expect(args.AND[0].ANY[0].conditions[0]).not.toBe(args.AND[0].ANY[1].conditions[0]);
        args.AND[0].ANY[0].conditions[0].value = 5;
      },
    }));
    expect(variables).toEqual(before);
    expect(f.calls).toHaveLength(2);
    expect(f.calls.map(({ args }) => args.AND[0].ANY[1].conditions[0].value)).toEqual([4, 4]);
  });
  it.each([false, true])('keeps sibling collection reads in one batch, scoped=%s', async (scoped) => {
    const f = build({ scoped: scoped ? ['review'] : [], batch: true });
    ok(await f.run('{cfShops {products(AND:[{ANY:[{path:"reviews",conditions:[{field:"rating",operator:GTE,value:4}]}]}]){key}}}'));
    const batches = f.calls.filter(({ method }) => method === 'findChildrenBatch');
    expect(batches).toHaveLength(1);
    expect(batches[0].parents).toEqual(['S1', 'S2', 'S3']);
    expect(allNodes(batches[0].plan.where).some((node) => node.kind === 'quantified')).toBe(true);
  });
  it.each(['group', 'field'])('checks read authorization, queryable and virtual paths in quantified %s forms', async (form) => {
    for (const restriction of ['auth', 'queryable', 'virtual']) {
      const f = build({
        permissions: restriction === 'auth' ? { RootQueryType: { '*': auth.allow() }, CfProduct: { '*': auth.allow() }, CfReview: { key: auth.allow() } } : undefined,
        configure: (types) => {
          if (restriction === 'queryable') types.Review.getFields().rating.extensions.queryable = false;
          if (restriction === 'virtual') { types.Review.getFields().rating.extensions.virtual = true; types.Review.getFields().rating.resolve = () => 5; }
        },
      });
      const filter = form === 'group' ? 'AND:[{ALL:[{path:"reviews",conditions:[{field:"rating",operator:GTE,value:4}]}]}]' : 'reviews:{quantifier:ALL,terms:[{path:"rating",operator:GTE,value:4}]}';
      code(await f.run(`{cfProducts(${filter}){key}}`), restriction === 'auth' ? 'FORBIDDEN' : 'FORBIDDEN_FILTER_PATH');
      expect(f.calls).toEqual([]); expect(f.scopeCalls).toEqual([]);
    }
  });
});

describe('pin: ignored object beside-terms carrier capabilities', () => {
  it.each([false, true])('keeps known undeclared operators gated and declared/unknown carriers ignored, trusted=%s', async (trusted) => {
    for (const [operator, declared, rejected] of [['IEQ', false, true], ['IEQ', true, false], ['UNKNOWN', false, false]]) {
      const f = build({ queryFeatures: { ...LEGACY, operators: declared ? OPERATORS : OPERATORS.filter((value) => value !== 'IEQ') }, scoped: [] });
      const args = { shop: { operator, value: 'ignored', terms: [{ path: 'name', operator: 'EQ', value: 'S1' }] } };
      const result = await f.invoke(trusted ? {} : args, trusted ? { middleware: ({ args: target }) => Object.assign(target, args) } : {});
      if (rejected) { code(result, 'UNSUPPORTED_QUERY'); expect(f.calls).toEqual([]); }
      else { ok(result); expect(f.calls[0].plan.where).toEqual({ kind: 'predicate', path: ['shop', 'name'], operator: 'EQ', value: 'S1' }); }
    }
  });
});

describe('pin: ignored scalar filter terms', () => {
  it.each(['name', 'stock'])('keeps the actual %s carrier and ignores terms while inspecting known operators', async (field) => {
    const f = build({ scoped: [] });
    const value = field === 'name' ? 'Ka' : 0;
    ok(await f.invoke({}, { middleware: ({ args }) => { args[field] = { operator: 'EQ', value, terms: [{ path: 'notAField', operator: 'IS_EMPTY' }] }; } }));
    expect(f.calls[0].plan.where).toEqual({ kind: 'predicate', path: [field], operator: 'EQ', value });
  });
});

describe('additional runtime frame boundaries', () => {
  it.each(['find', 'aggregate', 'children'])('preserves provenance when complete client frames are wrapped or inner leaves duplicated on %s', async (site) => {
    for (const move of ['whole', 'duplicate', 'quantifier']) {
      const f = build();
      const result = await f.invoke(explicit(), { middleware: ({ args }) => {
        const original = args.AND[0].ANY[0];
        if (move === 'whole') args.AND = [{ ANY: [{ path: 'shop', ANY: [original] }] }];
        else if (move === 'duplicate') args.AND.push({ ALL: [{ path: 'reviews', conditions: [original.conditions[0]] }] });
        else args.shop = { quantifier: 'NONE', terms: [{ ...original.conditions[0], path: 'name' }] };
      } }, site);
      code(result, 'DETACHED_CLIENT_FILTER'); expect(f.calls).toEqual([]);
    }
  });
  it.each(['find', 'aggregate', 'children'])('pin: rejects unsupported operator changes from marked emptiness to legacy references on %s', async (site) => {
    const f = build({ scoped: ['shop'] });
    const result = await f.invoke({ AND: [{ conditions: [{ field: 'shop.name', operator: 'IS_EMPTY' }] }] }, {
      middleware: ({ args }) => Object.assign(args.AND[0].conditions[0], { operator: 'EQ', value: 'S1' }),
    }, site);
    code(result, 'DETACHED_CLIENT_FILTER'); expect(f.calls).toEqual([]);
  });
  it('does not mark 2b reads whose chain or embedded-object members have no registered scope', async () => {
    const f = build({ scoped: [] });
    let pending;
    ok(await f.invoke({ AND: [{ conditions: [{ field: 'shop', operator: 'IS_EMPTY' }, { field: 'odim', operator: 'IS_EMPTY' }] }] }, {
      middleware: ({ args }) => { pending = structuredClone(args); },
    }));
    expect(pending.AND[0].conditions.every((item) => !Object.hasOwn(item, '__scope'))).toBe(true);
    expect(f.calls[0].args.AND[0].conditions.every((item) => !Object.hasOwn(item, '__scope'))).toBe(true);
  });
  it('pin: retains 2b protection for scoped embedded-object relation members', async () => {
    const f = build({ scoped: ['shop'] });
    ok(await f.invoke({ AND: [{ conditions: [{ field: 'odim', operator: 'IS_EMPTY' }] }] }));
    expect(f.calls[0].args.AND[0].conditions[0].__scope.scopes).toEqual({ 'odim.shop': null });
  });
  it('preserves a permitted keyless alias while filling its enclosing frame', async () => {
    const f = build();
    const result = await f.invoke(explicit(), { middleware: ({ args }) => {
      const own = args.AND[0].ANY[0].conditions[0];
      own.field = 'stock';
      args.AND[0].ANY[0].path = 'shop.products';
      args.AND[0].conditions = [own];
      // The same relative field is own in both places: no relation key is needed, so this is legal.
    } });
    ok(result);
    expect(f.calls[0].args.AND[0].conditions[0].__scope).toBeUndefined();
    expect(f.calls[0].args.AND[0].ANY[0].__scope.scopes).toEqual({ shop: null, 'shop.products': null });
  });
  it.each(['client', 'middleware', 'scope'])('enforces explicit nesting at three/four levels for %s frames', async (writer) => {
    const make = (count) => {
      let group = { path: count % 2 ? 'products' : 'shop' };
      for (let level = count - 1; level > 0; level--) group = { path: level % 2 ? 'products' : 'shop', ANY: [group] };
      return { AND: [{ ANY: [group] }] };
    };
    for (const count of [3, 4]) {
      const f = build({ scoped: writer === 'scope' ? ['shop'] : [] });
      const args = make(count);
      const context = writer === 'middleware' ? { middleware: ({ args: target }) => Object.assign(target, args) }
        : writer === 'scope' ? { scopes: { shop: ({ args: target }) => Object.assign(target, args) } } : {};
      const result = await f.invoke(writer === 'client' ? args : {}, context, 'find', 'shop');
      if (count === 4) { code(result, 'FILTER_DEPTH_EXCEEDED'); expect(f.calls).toEqual([]); }
      else { ok(result); expect(allNodes(f.calls[0].plan.where).filter((node) => node.kind === 'quantified')).toHaveLength(3); }
    }
  });
  it('starts a new nesting chain for target scopes and excludes trusted frames from the client unit count', async () => {
    configureQueryLimits({ maxReferenceFrames: 1 });
    const f = build({ scoped: ['review'] });
    ok(await f.invoke({ reviews: { quantifier: 'ANY' } }, { scopes: { review: ({ args }) => {
      args.AND = [{ ANY: [{ path: 'product', ANY: [{ path: 'shop', ANY: [{ path: 'products' }] }] }] }];
    } } }));
    expect(allNodes(f.calls[0].plan.where).filter((node) => node.kind === 'quantified')).toHaveLength(4);
  });
  it.each(['group', 'field'])('gates raw quantified target-scope invalid terms for %s frame markers', async (form) => {
    const f = build({ scoped: ['shop'] });
    const args = form === 'group' ? { AND: [{ ANY: [{ path: 'shop' }] }] } : { shop: { quantifier: 'ANY' } };
    code(await f.invoke(args, { scopes: { shop: ({ args: target }) => { target.products = { quantifier: 'NONE', terms: [{ operator: 'IS_NOT_EMPTY' }] }; } } }), 'INVALID_FILTER_PATH');
    expect(f.calls).toEqual([]);
  });
  it.each(['unknown', 'plain path'])('rejects a trusted %s group key with INVALID_FILTER_VALUE before adapters', async (what) => {
    const f = build();
    code(await f.invoke({}, { middleware: ({ args }) => { args.AND = [{ [what === 'unknown' ? 'wrong' : 'path']: 'reviews' }]; } }), 'INVALID_FILTER_VALUE');
    expect(f.calls).toEqual([]);
  });
  it.each(['sort', 'pagination'])('pin: shape-checks raw joined-scope %s before the quantifier gate', async (control) => {
    const f = build({ queryFeatures: LEGACY, scoped: ['shop'] });
    code(await f.invoke({ shop: { terms: [{ path: 'name', value: 'S1' }] } }, { scopes: { shop: ({ args }) => {
      args.products = { quantifier: 'NONE' };
      args[control] = control === 'sort' ? { terms: [] } : { page: 0, size: 1 };
    } } }), control === 'sort' ? 'INVALID_SORT' : 'INVALID_PAGINATION');
    expect(f.calls).toEqual([]);
  });
  it('rejects a query scope collection sort while ignoring a frame target scope collection sort', async () => {
    const f = build({ scoped: ['product', 'review'] });
    const sort = { terms: [{ field: 'reviews.rating', order: 'ASC' }] };
    code(await f.invoke({}, { scopes: { product: ({ args }) => { args.sort = sort; } } }), 'INVALID_FILTER_PATH');
    expect(f.calls).toEqual([]);
    ok(await f.invoke({ reviews: { quantifier: 'ANY' } }, { scopes: { review: ({ args }) => { args.sort = { terms: [{ field: 'product.reviews.rating', order: 'ASC' }] }; } } }));
    expect(f.calls[0].args.reviews.__scope.scopes).toEqual({ reviews: null });
  });
});

describe('frame consumer and lowering handoffs', () => {
  it('retains frame-relative emptiness in a raw joined scope after prefixing', async () => {
    const f = build({ scoped: ['shop'] });
    ok(await f.invoke({ shop: { terms: [{ path: 'name', value: 'S1' }] } }, { scopes: { shop: ({ args }) => {
      args.AND = [{ ALL: [{ path: 'products', conditions: [{ field: 'name', operator: 'IS_NOT_EMPTY' }], ANY: [{ path: 'reviews', conditions: [{ field: 'author', operator: 'IS_EMPTY' }] }] }] }];
    } } }));
    const frames = allNodes(f.calls[0].plan.where).filter((node) => node.kind === 'quantified');
    expect(frames.map((node) => node.path)).toEqual([['shop', 'products'], ['reviews']]);
    expect(predicatesOfRuntime(f.calls[0].plan.where).map((node) => node.path)).toContainEqual(['author']);
  });
  it.each(['auth', 'queryable', 'virtual'])('walks the quantified path itself for %s', async (restriction) => {
    const f = build({
      permissions: restriction === 'auth' ? { RootQueryType: { '*': auth.allow() }, CfProduct: { '*': auth.allow() } } : undefined,
      configure: (types) => {
        if (restriction === 'queryable') types.Shop.getFields().products.extensions.queryable = false;
        if (restriction === 'virtual') {
          types.Shop.getFields().products.extensions = { virtual: true };
          types.Shop.getFields().products.resolve = () => [];
        }
      },
    });
    code(await f.run('{cfProducts(AND:[{ALL:[{path:"shop.products"}]}]){key}}'), restriction === 'auth' ? 'FORBIDDEN' : 'FORBIDDEN_FILTER_PATH');
    expect(f.calls).toEqual([]); expect(f.scopeCalls).toEqual([]);
  });
  it('keeps virtual-field authorization ahead of the feature gate inside an ALL body and rejects trusted virtual paths', async () => {
    const f = build({ queryFeatures: LEGACY, configure: (types) => {
      types.Review.getFields().rating.extensions = { virtual: true };
      types.Review.getFields().rating.resolve = () => 5;
    } });
    code(await f.invoke({ AND: [{ ALL: [{ path: 'reviews', conditions: [condition('rating')] }] }] }), 'FORBIDDEN_FILTER_PATH');
    code(await f.invoke({}, { middleware: ({ args }) => Object.assign(args, explicit()) }), 'INVALID_MODEL');
    expect(f.calls).toEqual([]);
  });
  it('hands nested cut markers to the planner with relative joins and no keyless leaf marker', async () => {
    const f = build({ scoped: ['shop', 'review'] });
    ok(await f.invoke({ AND: [{ conditions: [condition('shop.products.reviews.rating')] }] }, { scopes: { review: ({ args }) => {
      args.author = { operator: 'NE', value: 'hidden' };
    } } }));
    expect(f.calls[0].args.AND[0].conditions[0].__scope.scopes).toEqual({ shop: null, 'shop.products': null, 'shop.products.reviews': { author: { operator: 'NE', value: 'hidden' } } });
    const frames = allNodes(f.calls[0].plan.where).filter((node) => node.kind === 'quantified');
    expect(frames[0]).toMatchObject({ path: ['shop', 'products'], joins: { shop: null }, scope: null });
    expect(frames[1]).toMatchObject({ path: ['reviews'], scope: { path: ['author'], operator: 'NE' }, where: { path: ['rating'] } });
    expect(frames[1].where).not.toHaveProperty('joins');
  });
  it('rejects a keyless/read alias before target scopes execute', async () => {
    const f = build({ scoped: ['shop'], configure: (types) => {
      types.Review.getFields().name = { ...types.Product.getFields().shop, name: 'name' };
    } });
    const result = await f.invoke({ AND: [{ ANY: [{ path: 'reviews', conditions: [{ field: 'name', operator: 'IS_EMPTY' }] }] }] }, {
      middleware: ({ args }) => { args.AND[0].conditions = [args.AND[0].ANY[0].conditions[0]]; },
    });
    code(result, 'DETACHED_CLIENT_FILTER'); expect(f.scopeCalls).toEqual([]); expect(f.calls).toEqual([]);
  });
  it('keeps all-J ordinary carriers unmarked with group-level legacy scopes even beside a frame', async () => {
    const f = build({ scoped: ['pro'] });
    let pending;
    ok(await f.invoke({ aggregation: { ...aggregation, groupId: 'products.key' }, AND: [{ conditions: [condition('products.pro.name', 'P1', 'EQ')], ANY: [{ path: 'products' }] }] }, {
      middleware: ({ args }) => { pending = structuredClone(args); },
      scopes: { pro: ({ args }) => { args.name = { operator: 'NE', value: 'P2' }; } },
    }, 'aggregate', 'shop'));
    expect(pending.AND[0].conditions[0].__scope).toBeUndefined();
    expect(f.calls[0].args.AND[0].AND).toEqual([{ conditions: [{ field: 'products.pro.name', operator: 'NE', value: 'P2' }] }]);
    expect(allNodes(f.calls[0].plan.where).filter((node) => node.kind === 'quantified')).toHaveLength(1);
  });
  it('keeps client and appended trusted terms in one frame, but a separate group in another', async () => {
    const f = build();
    ok(await f.invoke({ reviews: { terms: [{ path: 'rating', operator: 'GTE', value: 4 }] } }, { middleware: ({ args }) => {
      args.reviews.terms.push({ path: 'author', operator: 'EQ', value: 'x' });
      args.AND = [{ conditions: [condition('reviews.author', 'hidden', 'EQ')] }];
    }, scopes: { review: ({ args }) => { args.author = { operator: 'NE', value: 'hidden' }; } } }));
    const frames = allNodes(f.calls[0].plan.where).filter((node) => node.kind === 'quantified');
    expect(frames).toHaveLength(2);
    expect(frames.filter((node) => node.scope !== null)).toHaveLength(1);
    expect(frames.find((node) => node.scope !== null).where.terms.map((node) => node.path)).toEqual([['rating'], ['author']]);
  });
  it.each(['IS_EMPTY', 'IS_NOT_EMPTY'])('uses the declared shorthand reason for %s collection leaves before middleware', async (operator) => {
    const f = build();
    const result = await f.invoke({ AND: [{ conditions: [{ field: 'reviews.author', operator }] }] });
    code(result, 'INVALID_FILTER_PATH');
    expect(result.error.message).toBe('The shorthand excludes them; use an explicit group');
    expect(f.calls).toEqual([]); expect(f.middlewareCalls).toEqual([]);
  });
});
const predicatesOfRuntime = (node) => allNodes(node).filter((item) => item.kind === 'predicate');

describe('runtime frame accounting and trusted reads', () => {
  it.each([
    ['two explicit groups', { AND: [{ ANY: [{ path: 'reviews' }, { path: 'reviews' }] }] }, 2],
    ['field and group', { reviews: { quantifier: 'ANY' }, AND: [{ ALL: [{ path: 'reviews' }] }] }, 2],
    ['references inside one frame', { AND: [{ ANY: [{ path: 'reviews', conditions: [condition('product.shop.name', 'S1', 'EQ')] }] }] }, 3],
    ['joins in distinct frames', { AND: [{ ANY: [{ path: 'reviews', conditions: [condition('product.name', 'Ka', 'EQ')] }, { path: 'reviews', conditions: [condition('product.name', 'Ka', 'EQ')] }] }] }, 4],
    ['2b and ordinary collection', { reviews: { terms: [{ operator: 'IS_EMPTY' }] }, ...shorthand() }, 2],
  ])('counts %s even without registered scopes', async (_label, args, count) => {
    configureQueryLimits({ maxReferenceFrames: 1 });
    const f = build({ scoped: [] });
    const result = await f.invoke(structuredClone(args));
    code(result, 'FILTER_DEPTH_EXCEEDED');
    expect(result.error.message).toBe(`The client's conditions need ${count} frames and scoped joins in one query field, more than the limit of 1 (maxReferenceFrames)`);
    expect(f.middlewareCalls).toEqual([]); expect(f.calls).toEqual([]);
  });
  it('does not charge aggregate anchor segments or trusted middleware frames', async () => {
    configureQueryLimits({ maxReferenceFrames: 1 });
    const f = build({ scoped: ['pro'] });
    ok(await f.invoke({ aggregation: { ...aggregation, groupId: 'products.key' }, AND: [{ conditions: [condition('products.pro.shop.products.name', 'Ka', 'EQ')] }] }, {}, 'aggregate', 'shop'));
    expect(allNodes(f.calls[0].plan.where).filter((node) => node.kind === 'quantified')).toHaveLength(1);
    f.calls.length = 0;
    ok(await f.invoke({}, { middleware: ({ args }) => { args.AND = [{ ANY: Array.from({ length: 11 }, () => ({ path: 'reviews' })) }]; } }));
    expect(allNodes(f.calls[0].plan.where).filter((node) => node.kind === 'quantified')).toHaveLength(11);
  });
  it('plans get_by_id scope collection predicates as trusted frames, preserving the missing-child null difference', async () => {
    const f = build({ scoped: [], configure: (types) => {
      types.Product.extensions.scope = { get_by_id: ({ args }) => {
        args.reviews = { terms: [{ path: 'author', operator: 'EQ', value: null }] };
      } };
    } });
    const result = await f.run('{cfProduct(id:"C"){key}}');
    ok(result);
    expect(result.data.cfProduct).toBeNull();
    const frame = allNodes(f.calls[0].plan.where).find((node) => node.kind === 'quantified');
    expect(frame).toMatchObject({ path: ['reviews'], scope: null, where: { path: ['author'], operator: 'EQ', value: null } });
    expect(f.calls[0].args.reviews.terms[0]).not.toHaveProperty('__scope');
  });
  it('rejects an all-J final legacy position without deleting the surviving client marker', async () => {
    const f = build({ scoped: ['pro'] });
    const result = await f.invoke({ aggregation: { ...aggregation, groupId: 'products.key' }, AND: [{ conditions: [condition('products.pro.shop.products.name', 'Ka', 'EQ')] }] }, {
      middleware: ({ args }) => { args.AND[0].conditions[0].field = 'products.pro.name'; },
    }, 'aggregate', 'shop');
    code(result, 'DETACHED_CLIENT_FILTER'); expect(f.calls).toEqual([]);
  });
});

describe('alias unions and list-reference edges', () => {
  it('fills a shared marked leaf once across distinct client frames with the same target key', async () => {
    const f = build({ scoped: ['review', 'shop'] });
    const args = { AND: [{ ANY: [
      { path: 'reviews', conditions: [condition('product.shop.name', 'S1', 'EQ')] },
      { path: 'reviews', conditions: [condition('product.shop.name', 'S1', 'EQ')] },
    ] }] };
    ok(await f.invoke(args, { middleware: ({ args: final }) => {
      final.AND[0].ANY[1].conditions.push(final.AND[0].ANY[0].conditions[0]);
    } }));
    expect(f.scopeCalls).toEqual(['review', 'shop']);
    const [first, second] = f.calls[0].args.AND[0].ANY;
    expect(first.conditions[0].__scope.scopes).toEqual({ product: null, 'product.shop': null });
    expect(second.conditions[1].__scope).toEqual(first.conditions[0].__scope);
  });
  it('drops alias-union keys belonging to another prefix when each shorthand is cut', async () => {
    const f = build({ scoped: ['shop', 'pro'], configure: (types) => {
      types.Pro.getFields().products = { ...types.Shop.getFields().products, extensions: { relation: { embedded: false, connectionField: 'pro' } } };
    } });
    ok(await f.invoke({ shop: { terms: [{ path: 'products.name', operator: 'EQ', value: 'Ka' }] } }, { middleware: ({ args }) => {
      args.pro = { terms: [args.shop.terms[0]] };
    } }));
    expect(f.calls[0].args.shop.terms[0].__scope.scopes).toEqual({ shop: null, 'shop.products': null, pro: null, 'pro.products': null });
    const frames = allNodes(f.calls[0].plan.where).filter((node) => node.kind === 'quantified');
    expect(frames.map((node) => [node.path, node.joins])).toEqual([[['shop', 'products'], { shop: null }], [['pro', 'products'], { pro: null }]]);
    expect(frames.every((node) => !Object.hasOwn(node.where, 'joins'))).toBe(true);
  });
  it('rejects a later scoped reference on a vector chain before its first collection', async () => {
    const f = build({ scoped: ['pro'], configure: (types) => {
      types.Shop.getFields().pro = { ...types.Product.getFields().pro };
    } });
    const result = await f.invoke({ AND: [{ conditions: [condition('olines.shop.pro.shop.products.name', 'Ka', 'EQ')] }] }, {
      scopes: { pro: ({ args }) => { args.name = { operator: 'NE', value: 'P2' }; } },
    });
    code(result, 'FORBIDDEN_FILTER_PATH');
    expect(result.error.message).toBe('Query path olines.shop.pro enters CfPro, whose find scope restricts the relation CfShop.pro inside a list');
    expect(f.calls).toEqual([]);
  });
  it.each([['pin: flattened', 'flattened'], ['pin: quantifier', 'quantifier'], ['explicit', 'explicit']])('rejects joined %s collection scopes under a sort through an embedded list', async (_name, form) => {
    const f = build({ scoped: ['shop'] });
    const result = await f.invoke({ sort: { terms: [{ field: 'olines.shop.name', order: 'ASC' }] } }, { scopes: { shop: ({ args }) => {
      if (form === 'flattened') args.products = { terms: [{ path: 'stock', value: 5 }] };
      else if (form === 'quantifier') args.products = { quantifier: 'ANY' };
      else args.AND = [{ ANY: [{ path: 'products' }] }];
    } } });
    code(result, 'FORBIDDEN_FILTER_PATH'); expect(f.calls).toEqual([]);
    expect(result.error.message).toBe('Query path olines.shop enters CfShop, whose find scope filters through the collection CfShop.products');
  });
  it.each([
    ['pro', 'tests the quantified reference CfShop.pro under an embedded-list prefix'],
    ['pro.products', 'filters through the collection CfPro.products'],
  ])('names the unsupported joined scope path %s under an embedded-list prefix', async (path, cause) => {
    const f = build({ scoped: ['shop'], configure: (types) => {
      types.Shop.getFields().pro = { ...types.Product.getFields().pro };
      types.Pro.getFields().products = { ...types.Shop.getFields().products, extensions: { relation: { embedded: false, connectionField: 'pro' } } };
    } });
    const result = await f.invoke({ AND: [{ conditions: [condition('olines.shop.name', 'S1', 'EQ')] }] }, {
      scopes: { shop: ({ args }) => { args.AND = [{ ANY: [{ path }] }]; } },
    });
    code(result, 'FORBIDDEN_FILTER_PATH'); expect(f.calls).toEqual([]);
    expect(result.error.message).toBe(`Query path olines.shop enters CfShop, whose find scope ${cause}`);
  });
  it.each(['queryable', 'virtual'])('pin: checks the reached collection %s property before the collection sort error', async (restriction) => {
    const f = build({ configure: (types) => {
      const field = types.Product.getFields().reviews;
      if (restriction === 'queryable') field.extensions.queryable = false;
      else { field.extensions = { virtual: true }; field.resolve = () => []; }
    } });
    code(await f.invoke({ sort: { terms: [{ field: 'reviews.rating', order: 'ASC' }] } }), 'FORBIDDEN_FILTER_PATH');
    expect(f.calls).toEqual([]); expect(f.middlewareCalls).toEqual([]); expect(f.scopeCalls).toEqual([]);
  });
});

describe('nested provenance diagnostics', () => {
  it('names the original absolute path of an ancestor marked only by a nested scoped read', async () => {
    const f = build({ scoped: ['shop'] });
    const args = { AND: [{ ANY: [{ path: 'products', ANY: [{ path: 'reviews', ANY: [{ path: 'product.shop' }] }] }] }] };
    const result = await f.invoke(args, { middleware: ({ args: final }) => {
      // Keep the outer and deepest client markers, dropping only the intermediate frame ID.
      const middle = final.AND[0].ANY[0].ANY[0];
      const deepest = middle.ANY[0];
      deepest.path = 'shop';
      final.AND[0].ANY[0].ANY = [deepest];
    } }, 'find', 'shop');
    code(result, 'DETACHED_CLIENT_FILTER');
    expect(result.error.message).toContain('The client\'s ANY condition on products.reviews is no longer');
    expect(f.calls).toEqual([]);
  });
});

describe('quantified copy and scalar-carrier boundaries', () => {
  it('preserves prototypes and shallow-copies operand arrays in quantified bodies', async () => {
    const f = build();
    const leaf = Object.assign(Object.create(null), { field: 'rating', operator: 'IN', value: [4, 5] });
    const group = Object.assign(Object.create(null), { path: 'reviews', conditions: [leaf] });
    const input = { AND: [{ ALL: [group] }] };
    ok(await f.invoke(input, { middleware: ({ args }) => {
      const copied = args.AND[0].ALL[0];
      expect(copied).not.toBe(group); expect(Object.getPrototypeOf(copied)).toBeNull();
      expect(copied.conditions[0]).not.toBe(leaf); expect(Object.getPrototypeOf(copied.conditions[0])).toBeNull();
      expect(copied.conditions[0].value).not.toBe(leaf.value);
      copied.conditions[0].value.push(1);
    } }));
    expect(leaf.value).toEqual([4, 5]); expect(group).not.toHaveProperty('__scope');
    expect(allNodes(f.calls[0].plan.where).find((node) => node.kind === 'quantified').quantifier).toBe('ALL');
  });
  it('does not validate an invented scalar default carrier ahead of an invalid quantified scalar path', async () => {
    const f = build();
    const result = await f.invoke({ name: { quantifier: 'ANY', terms: [] } });
    code(result, 'INVALID_FILTER_PATH'); expect(f.middlewareCalls).toEqual([]); expect(f.calls).toEqual([]);
  });
  it('pin: compiles the default scalar EQ carrier while ignoring its terms', async () => {
    const f = build({ scoped: [] });
    ok(await f.invoke({}, { middleware: ({ args }) => { args.name = { value: 'Ka', terms: [{ path: 'notAField', operator: 'IS_EMPTY' }] }; } }));
    expect(f.calls[0].plan.where).toEqual({ kind: 'predicate', path: ['name'], operator: 'EQ', value: 'Ka' });
  });
});

describe.each(['find', 'aggregate', 'children'])('trusted unscoped collection quantifiers on %s', (site) => {
  it('rejects wrapping a marked condition in an unscoped quantified field filter', async () => {
    const f = build({ scoped: ['shop'] });
    const result = await f.invoke({ reviews: { terms: [{ path: 'product.shop.name', value: 'S1' }] } }, {
      middleware: ({ args }) => { args.reviews.quantifier = 'ANY'; },
    }, site);
    code(result, 'DETACHED_CLIENT_FILTER'); expect(f.calls).toEqual([]);
  });
});


describe('phase2 fix1 settlement and sort boundaries', () => {
  it.each(['find', 'aggregate', 'children'].flatMap((site) => ['scalar', 'scalar-list'].flatMap((kind) => ['park', 'shared alias', 'cloned alias'].map((placement) => [site, kind, placement]))))(
    'rejects marked inspection-only terms on %s %s %s', async (site, kind, placement) => {
      const f = build({ configure: (types) => { if (kind === 'scalar-list') types.Product.getFields().stock.type = new GraphQLList(GraphQLInt); } });
      const result = await f.invoke(shorthand(), { middleware: ({ args }) => {
        const marked = args.AND[0].conditions[0];
        expect(marked.__scope).toEqual({ id: 0 });
        const term = placement === 'cloned alias' ? { ...marked } : marked;
        if (kind === 'scalar') args.name = { operator: 'EQ', value: 'F', terms: [term] };
        else args.stock = { operator: 'IS_EMPTY', terms: [term] };
        if (placement === 'park') delete args.AND;
      } }, site);
      code(result, 'DETACHED_CLIENT_FILTER');
      expect(f.scopeCalls).toEqual([]); expect(f.calls).toEqual([]);
    },
  );
  it.each(['find', 'aggregate', 'children'].flatMap((site) => ['scalar', 'scalar-list'].map((kind) => [site, kind])))(
    'retains compiled carriers beside unmarked ignored terms on %s %s', async (site, kind) => {
      const f = build({ configure: (types) => { if (kind === 'scalar-list') types.Product.getFields().stock.type = new GraphQLList(GraphQLInt); } });
      ok(await f.invoke(shorthand(), { middleware: ({ args }) => {
        if (kind === 'scalar') args.name = { operator: 'EQ', value: 'F', terms: [condition()] };
        else args.stock = { operator: 'IS_EMPTY', terms: [condition()] };
      } }, site));
      expect(f.calls).toHaveLength(1); expect(f.scopeCalls).toEqual(['review']);
      expect(allNodes(f.calls[0].plan.where).some((node) => node.kind === 'quantified')).toBe(true);
    },
  );
  it.each([true, false, undefined].flatMap((quantifiers) => ['IS_EMPTY', 'IS_NOT_EMPTY'].map((operator) => [quantifiers, operator])))(
    'pin: keeps collection-end emptiness independent of J quantifiers=%s operator=%s', async (quantifiers, operator) => {
      const f = build({ queryFeatures: { ...LEGACY, ...(quantifiers === undefined ? {} : { quantifiers }) } });
      const result = await f.run(`{cfProducts_aggregate(reviews:{terms:[{operator:${operator}}]},aggregation:{groupId:"name",facts:[{operation:COUNT,factName:"n",path:"id"}]}){groupId}}`, {}, {
        middleware: ({ args }) => {
          const before = structuredClone(args.reviews.terms[0]);
          expect(before.__scope).toEqual({ id: 0 });
          args.aggregation.groupId = 'reviews.author';
          expect(args.reviews.terms[0]).toEqual(before);
        },
      });
      ok(result); expect(f.calls).toHaveLength(1); expect(f.scopeCalls).toEqual(['review']);
      expect(f.calls[0].args.reviews.terms[0].__scope).toEqual({ id: 0, scopes: { reviews: null } });
      expect(f.calls[0].plan.where).toEqual({ kind: 'predicate', path: ['reviews'], operator, value: null, scopes: { reviews: null } });
    },
  );
  it('pin: retains restrictive scoped aggregate grouping rejection', async () => {
    const f = build();
    code(await f.invoke({ reviews: { terms: [{ operator: 'IS_EMPTY' }] }, aggregation: { ...aggregation, groupId: 'reviews.author' } }, {
      scopes: { review: ({ args }) => { args.author = { operator: 'NE', value: 'hidden' }; } },
    }, 'aggregate'), 'FORBIDDEN_FILTER_PATH');
    expect(f.scopeCalls).toEqual(['review']); expect(f.calls).toEqual([]);
  });
  it.each([DECLARED, undefined].flatMap((features) => [false, true].map((count) => [features, count])))(
    'validates full GraphQL sort syntax before collection resolution features=%j count=%s', async (features, count) => {
      const f = build({ queryFeatures: features ?? null });
      const result = await f.run(`{cfProducts(sort:{terms:[{field:"reviews..rating",order:ASC}]},pagination:{page:1,size:10,count:${count}}){key}}`);
      code(result, 'INVALID_FILTER_PATH');
      expect(result.errors[0].message).toBe('Invalid sort path');
      expect(result.errors[0].extensions.status).toBe(400);
      expect(f.middlewareCalls).toEqual([]); expect(f.scopeCalls).toEqual([]); expect(f.calls).toEqual([]);
    },
  );
});
