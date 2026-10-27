import { describe, expect, it, vi } from 'vitest';
import {
  GraphQLID, GraphQLList, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';

import { QLOperator, createRuntime } from '../packages/core/src/index.js';
import { createListOperatorTypes, listOperatorStore, registerListOperatorTypes } from './helpers/list-operators.js';
import { createMemoryAdapter } from './helpers/collection-frames.js';
import { createOptimisticMemoryAdapter } from './helpers/optimistic-memory-adapter.js';

// #108 part 4: the runtime half of the list operators CONTAINS_ALL and IIN. The runtime changes no code for them
// (section 3 of the spec): these tests pin what its gates already do with the two QLOperator values, on the adapter
// shapes that declare them and on those that do not, for client requests and for the constructs that middleware,
// scopes and views write. Database-free: the memory adapter plans every read with createQueryPlan, with its declared
// features, and answers it from the list operator fixture's store, so rows show what a plan matches. The validator's
// order and the plans are in list-operators.test.js, and each backend's forms with that backend.

// The QLOperator values before part 4, in declaration order.
const EARLIER_18 = [
  'EQ', 'LT', 'GT', 'LTE', 'GTE', 'BTW', 'NE', 'IN', 'NIN', 'LIKE', 'ILIKE', 'STARTS_WITH', 'ISTARTS_WITH', 'ENDS_WITH',
  'IENDS_WITH', 'IEQ', 'IS_EMPTY', 'IS_NOT_EMPTY',
];
const OPERATORS = QLOperator.getValues().map(({ value }) => value);
// The shape of both bundled declarations.
const DECLARED = { operators: OPERATORS, referenceEmptiness: true, quantifiers: true };
// A declaring adapter without collection frames (spec 7.5).
const WITHOUT_QUANTIFIERS = { operators: OPERATORS, referenceEmptiness: true };
// The adapters that do not declare the list operators, with the site that reports them: the runtime's operator
// check (site A) on legacy adapters, the shared validator (site B) on quantified ones.
const NARROW = [
  ['no queryFeatures', undefined, 'A'],
  ['{ operators: EARLIER_18 }', { operators: EARLIER_18 }, 'A'],
  ['{ operators: EARLIER_18, referenceEmptiness: true, quantifiers: true }', { operators: EARLIER_18, referenceEmptiness: true, quantifiers: true }, 'B'],
];
const unsupported = (site, operator, path, type = 'QlItem') => ({
  code: 'UNSUPPORTED_QUERY',
  status: 400,
  message: site === 'A'
    ? `The database adapter does not support the ${operator} filter operator, used on ${type}.${path}`
    : `The ${operator} filter operator is not supported by this query compiler`,
});
const invalid = (code, message) => ({ code, status: 400, message });
const SHORTHAND = invalid('INVALID_FILTER_PATH', 'The shorthand excludes them; use an explicit group');
const QUANTIFIED_UNSUPPORTED = invalid('UNSUPPORTED_QUERY', 'Quantified groups are not supported by this query compiler');
const ADVICE = 'middleware and scopes must keep the client\'s filter objects: copy them instead of rebuilding them, and append '
  + 'restrictions instead of assigning over them (docs/guide/middleware.md)';
const detached = (message) => ({ code: 'DETACHED_CLIENT_FILTER', status: 500, message: `${message}; ${ADVICE}` });

// One runtime on the memory adapter, with the fixture's types (prefix Ql) and named scopes, which apply when the
// request context lists them in `context.scopes`. `queryFeatures` defaults to the bundled shape; passing it as
// undefined gives an adapter without the property. Middleware does what `context.middleware(params)` asks.
const build = (options = {}) => {
  const queryFeatures = Object.hasOwn(options, 'queryFeatures') ? options.queryFeatures : DECLARED;
  const { scopes = true, batch = false, views = {} } = options;
  const calls = [];
  const middleware = vi.fn(async (params, next) => {
    await params.context?.middleware?.(params);
    await next();
  });
  const types = createListOperatorTypes(null, { scopes });
  const runtime = createRuntime(createMemoryAdapter({ queryFeatures, calls, batch, data: listOperatorStore }));
  runtime.use(middleware);
  registerListOperatorTypes(runtime, types);
  for (const [name, view] of Object.entries(views)) runtime.registerView(name, view(types));
  const schema = runtime.createSchema();
  const run = (source, context = {}, variableValues = undefined) => graphql({ schema, source, contextValue: context, variableValues });
  // Calls a root field's resolver with arguments as the runtime receives them.
  const invoke = async (field, args, context = {}) => {
    try {
      return { rows: await schema.getQueryType().getFields()[field].resolve(null, structuredClone(args), context) };
    } catch (error) {
      return { error };
    }
  };
  return { calls, middleware, types, run, invoke };
};

const failure = (result) => {
  const error = result.error ?? result.errors?.[0];
  return error ? { code: error.extensions?.code, status: error.extensions?.status, message: error.message } : null;
};
const ok = (result) => expect(result.error ?? result.errors).toBeUndefined();
const keysOf = (rows) => rows.map(({ key }) => key);
const itemCalls = (calls) => calls.filter(({ type }) => type === 'QlItem');
const allNodes = (node) => (!node ? [] : [
  node, ...(node.terms ?? []).flatMap(allNodes), ...allNodes(node.where), ...allNodes(node.scope), ...Object.values(node.joins ?? {}).flatMap(allNodes),
]);
const predicatesOf = (node, operator) => allNodes(node).filter((item) => item.kind === 'predicate' && item.operator === operator);
// The value of every term, condition or field filter with `operator` in a call's arguments.
const sentValues = (args, operator) => {
  const found = [];
  const visit = (value) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value !== null && typeof value === 'object') {
      if (value.operator === operator) found.push(value.value);
      Object.values(value).forEach(visit);
    }
  };
  visit(args);
  return found;
};
// Middleware that edits the arguments of `type` reads with `operation`, and leaves every other read alone.
const on = (edit, { type = 'QlItem', operation = 'find' } = {}) => (params) => {
  if (params.type.gqltype.name === type && params.operation === operation) edit(params.args, params);
};
const appendGroup = (args, ...conditions) => { args.AND = [...(args.AND ?? []), { conditions }]; };
// An array whose first element is a hole.
const sparse = (item) => {
  const value = new Array(2);
  value[1] = item;
  return value;
};
const aggregation = 'aggregation: { groupId: "name", facts: [{ operation: COUNT, factName: "n", path: "id" }] }';

describe('a declaring adapter receives CONTAINS_ALL and IIN with the values as sent', () => {
  // [surface, operator, the value as sent, source, the item reads it makes, the item keys they match, batch]
  const SURFACES = [
    ['a field filter', 'CONTAINS_ALL', ['B', 'A', 'A'], '{ qlItems(tags: { operator: CONTAINS_ALL, value: ["B", "A", "A"] }) { key } }', ['find'], ['I1', 'I3']],
    ['a field filter', 'IIN', ['ONE', 'two', 'one'], '{ qlItems(name: { operator: IIN, value: ["ONE", "two", "one"] }) { key } }', ['find'], ['I1', 'I2']],
    ['a relation term', 'CONTAINS_ALL', ['q', 'p', 'p'], '{ qlItems(box: { terms: [{ path: "tags", operator: CONTAINS_ALL, value: ["q", "p", "p"] }] }) { key } }', ['find'], ['I1', 'I6']],
    ['a relation term', 'IIN', ['ALPHA', 'Beta'], '{ qlItems(shop: { terms: [{ path: "name", operator: IIN, value: ["ALPHA", "Beta"] }] }) { key } }', ['find'], ['I1', 'I2']],
    ['a group condition', 'CONTAINS_ALL', ['B', 'A'], '{ qlItems(AND: [{ conditions: [{ field: "lines.sku", operator: CONTAINS_ALL, value: ["B", "A"] }] }]) { key } }', ['find'], ['I1', 'I3']],
    ['a group condition', 'IIN', ['b', 'B'], '{ qlItems(AND: [{ conditions: [{ field: "lines.sku", operator: IIN, value: ["b", "B"] }] }]) { key } }', ['find'], ['I1', 'I3', 'I8']],
    ['an OR branch', 'CONTAINS_ALL', ['A', 'B'], '{ qlItems(OR: [{ conditions: [{ field: "name", operator: EQ, value: "zzz" }] }, { conditions: [{ field: "dims.codes", operator: CONTAINS_ALL, value: ["A", "B"] }] }]) { key } }', ['find'], ['I1']],
    ['an OR branch', 'IIN', ['P'], '{ qlItems(OR: [{ conditions: [{ field: "name", operator: EQ, value: "zzz" }] }, { conditions: [{ field: "box.tags", operator: IIN, value: ["P"] }] }]) { key } }', ['find'], ['I1', 'I2', 'I6']],
    ['a count', 'CONTAINS_ALL', ['A', 'B'], '{ qlItems(tags: { operator: CONTAINS_ALL, value: ["A", "B"] }, pagination: { page: 1, size: 10, count: true }) { key } }', ['find', 'count'], ['I1', 'I3']],
    ['a count', 'IIN', ['one', 'TWO'], '{ qlItems(name: { operator: IIN, value: ["one", "TWO"] }, pagination: { page: 1, size: 10, count: true }) { key } }', ['find', 'count'], ['I1', 'I2']],
    ['an aggregate', 'CONTAINS_ALL', ['A', 'B'], `{ qlItems_aggregate(tags: { operator: CONTAINS_ALL, value: ["A", "B"] }, ${aggregation}) { groupId } }`, ['aggregate'], ['I1', 'I3']],
    ['an aggregate', 'IIN', ['one', 'TWO'], `{ qlItems_aggregate(name: { operator: IIN, value: ["one", "TWO"] }, ${aggregation}) { groupId } }`, ['aggregate'], ['I1', 'I2']],
    ['a collection field', 'CONTAINS_ALL', ['A', 'B'], '{ qlShops { key items(tags: { operator: CONTAINS_ALL, value: ["A", "B"] }) { key } } }', ['findChildren', 'findChildren', 'findChildren', 'findChildren'], ['I1', 'I3']],
    ['a collection field', 'IIN', ['one', 'TWO'], '{ qlShops { key items(name: { operator: IIN, value: ["one", "TWO"] }) { key } } }', ['findChildren', 'findChildren', 'findChildren', 'findChildren'], ['I1', 'I2']],
    ['a batched collection field', 'CONTAINS_ALL', ['A', 'B'], '{ qlShops { key items(tags: { operator: CONTAINS_ALL, value: ["A", "B"] }) { key } } }', ['findChildrenBatch'], ['I1', 'I3'], true],
    ['a batched collection field', 'IIN', ['one', 'TWO'], '{ qlShops { key items(name: { operator: IIN, value: ["one", "TWO"] }) { key } } }', ['findChildrenBatch'], ['I1', 'I2'], true],
    ['an explicit frame', 'CONTAINS_ALL', ['y', 'x'], '{ qlItems(AND: [{ ANY: [{ path: "reviews", conditions: [{ field: "tags", operator: CONTAINS_ALL, value: ["y", "x"] }] }] }]) { key } }', ['find'], ['I1', 'I2', 'I6']],
    ['an explicit frame', 'IIN', ['ANA'], '{ qlItems(AND: [{ ANY: [{ path: "reviews", conditions: [{ field: "author", operator: IIN, value: ["ANA"] }] }] }]) { key } }', ['find'], ['I1', 'I2']],
    ['a quantified field filter', 'CONTAINS_ALL', ['x'], '{ qlItems(reviews: { quantifier: ALL, terms: [{ path: "tags", operator: CONTAINS_ALL, value: ["x"] }] }) { key } }', ['find'], ['I1', 'I2', 'I4', 'I6', 'I7', 'I8']],
    ['a quantified field filter', 'IIN', ['ana', 'bob'], '{ qlItems(reviews: { quantifier: ALL, terms: [{ path: "author", operator: IIN, value: ["ana", "bob"] }] }) { key } }', ['find'], ['I1', 'I2', 'I4', 'I7', 'I8']],
    ['a shorthand frame through a collection', 'IIN', ['ana'], '{ qlItems(AND: [{ conditions: [{ field: "reviews.author", operator: IIN, value: ["ana"] }] }]) { key } }', ['find'], ['I1', 'I2']],
  ];

  it.each(SURFACES)('from %s, %s', async (_surface, operator, value, source, methods, keys, batch = false) => {
    const { calls, run } = build({ batch });
    ok(await run(source));
    const reads = itemCalls(calls);
    expect(reads.map(({ method }) => method)).toEqual(methods);
    for (const read of reads) {
      expect(sentValues(read.args, operator)).toEqual([value]);
      expect(predicatesOf(read.plan.where, operator).map((node) => node.value)).toEqual([value]);
    }
    expect([...new Set(reads.flatMap(({ rows }) => rows))].sort()).toEqual(keys);
  });

  it('plans a client IIN through a collection as an implicit ANY frame, and CONTAINS_ALL on a list through embedded lists as a predicate', async () => {
    const { calls, run } = build();
    ok(await run('{ qlItems(AND: [{ conditions: [{ field: "reviews.author", operator: IIN, value: ["ana"] }, { field: "lines.subs.code", operator: CONTAINS_ALL, value: ["c1", "c3"] }] }]) { key } }'));
    expect(calls[0].plan.where).toEqual({
      kind: 'and',
      terms: [
        { kind: 'predicate', path: ['lines', 'subs', 'code'], operator: 'CONTAINS_ALL', value: ['c1', 'c3'] },
        { kind: 'quantified', quantifier: 'ANY', path: ['reviews'], where: { kind: 'predicate', path: ['author'], operator: 'IIN', value: ['ana'] }, scope: null },
      ],
    });
    expect(calls[0].rows).toEqual(['I1']);
  });
});

describe('adapters that do not declare CONTAINS_ALL and IIN', () => {
  const FORMS = [
    ['a field filter', 'CONTAINS_ALL', 'tags', '{ qlItems(tags: { operator: CONTAINS_ALL, value: ["A"] }) { key } }'],
    ['a field filter', 'IIN', 'name', '{ qlItems(name: { operator: IIN, value: ["one"] }) { key } }'],
    ['a group condition', 'CONTAINS_ALL', 'lines.sku', '{ qlItems(AND: [{ conditions: [{ field: "lines.sku", operator: CONTAINS_ALL, value: ["A"] }] }]) { key } }'],
    ['a group condition', 'IIN', 'lines.sku', '{ qlItems(AND: [{ conditions: [{ field: "lines.sku", operator: IIN, value: ["a"] }] }]) { key } }'],
  ];
  // The forms the compilers ignore (spec 4.2), as middleware writes them: an operator beside an object field's terms,
  // and the terms of a field that is not an object. [the ignored operator, the field, its filter, the predicate the
  // compilers read: path and EQ value]
  const IGNORED = [
    ['CONTAINS_ALL', 'shop', { operator: 'CONTAINS_ALL', value: ['a'], terms: [{ path: 'name', operator: 'EQ', value: 'Alpha' }] }, ['shop', 'name'], 'Alpha'],
    ['IIN', 'shop', { operator: 'IIN', value: ['a'], terms: [{ path: 'name', operator: 'EQ', value: 'Alpha' }] }, ['shop', 'name'], 'Alpha'],
    ['IIN', 'name', { operator: 'EQ', value: 'one', terms: [{ path: 'x', operator: 'IIN', value: ['a'] }] }, ['name'], 'one'],
    ['CONTAINS_ALL', 'tags', { operator: 'EQ', value: 'A', terms: [{ path: 'x', operator: 'CONTAINS_ALL', value: ['a'] }] }, ['tags'], 'A'],
  ];
  const BESIDE_TERMS = IGNORED.filter(([, field]) => field === 'shop');
  const SCALAR_TERMS = IGNORED.filter(([, field]) => field !== 'shop');
  // The same forms on Review, written by its find scope: beside the terms of the reference item, and in the terms of
  // the scalar author and of the scalar list tags. [the ignored operator, the field, its filter, the predicate the
  // compilers read: path and EQ value]
  const REVIEW_IGNORED = [
    ['IIN', 'item', { operator: 'IIN', value: ['a'], terms: [{ path: 'name', operator: 'EQ', value: 'one' }] }, ['item', 'name'], 'one'],
    ['CONTAINS_ALL', 'item', { operator: 'CONTAINS_ALL', value: ['a'], terms: [{ path: 'name', operator: 'EQ', value: 'one' }] }, ['item', 'name'], 'one'],
    ['IIN', 'author', { operator: 'EQ', value: 'ana', terms: [{ path: 'x', operator: 'IIN', value: ['a'] }] }, ['author'], 'ana'],
    ['CONTAINS_ALL', 'tags', { operator: 'EQ', value: 'x', terms: [{ path: 'x', operator: 'CONTAINS_ALL', value: ['a'] }] }, ['tags'], 'x'],
  ];
  // The path site A names for an ignored form: the object field beside whose terms the operator sits, or the term
  // below the field that is not an object.
  const reportedOn = (field) => (['shop', 'item'].includes(field) ? field : `${field}.x`);
  // Scopes of the type `typeKey` that write an ignored form, in the reads `when` accepts.
  const writing = (operation, field, filter, when = () => true, typeKey = 'item') => ({
    [typeKey]: { [operation]: ({ args }) => { if (when(args)) args[field] = structuredClone(filter); } },
  });
  // Client reads that join Item's find scope through the single reference item, as a group condition and as a term.
  const JOINED = [
    ['a group condition', '{ qlReviews(AND: [{ conditions: [{ field: "item.name", operator: EQ, value: "one" }] }]) { key } }'],
    ['a relation term', '{ qlReviews(item: { terms: [{ path: "name", operator: EQ, value: "one" }] }) { key } }'],
  ];
  // [the ignored operator, the field, the client's form, the filter the scope writes, the source]
  const JOINED_BESIDE_TERMS = JOINED.flatMap(([form, source]) => BESIDE_TERMS.map(([operator, field, filter]) => [operator, field, form, filter, source]));
  const JOINED_SCALAR_TERMS = JOINED.flatMap(([form, source]) => SCALAR_TERMS.map(([operator, field, filter]) => [operator, field, form, filter, source]));
  // Client reads that join Item's find scope through the scoped collection QlShop.items, as a group condition and as
  // a term.
  const THROUGH_ITEMS = [
    ['a group condition', '{ qlShops(AND: [{ conditions: [{ field: "items.name", operator: EQ, value: "one" }] }]) { key } }'],
    ['a relation term', '{ qlShops(items: { terms: [{ path: "name", operator: EQ, value: "one" }] }) { key } }'],
  ];
  // Where each of those forms carries the implicit frame's scope marker in the arguments the adapter receives.
  const ITEMS_MARKER = {
    'a group condition': (args) => args.AND[0].conditions[0].__scope.scopes,
    'a relation term': (args) => args.items.terms[0].__scope.scopes,
  };
  // [the ignored operator, the field, the client's form, the filter the scope writes, the source, the predicate the
  // compilers read: path and EQ value]
  const ITEMS_IGNORED =THROUGH_ITEMS.flatMap(([form, source]) => IGNORED.map(([operator, field, filter, path, value]) => [operator, field, form, filter, source, path, value]));
  // A client read that joins Review's find scope through the scoped collection QlItem.reviews.
  const THROUGH_REVIEWS = '{ qlItems(AND: [{ conditions: [{ field: "reviews.author", operator: EQ, value: "ana" }] }]) { key } }';
  const forbiddenCollection = (prefix, collection) => ({
    code: 'FORBIDDEN_FILTER_PATH', status: 403, message: `Query path ${prefix} enters the scoped collection ${collection}`,
  });
  // A client frame that reads Item through reviews.item; Item's find scope then runs with empty arguments
  // (clientScopeArgs), which the writer below waits for, so that it leaves the root read alone.
  const FRAME_THROUGH_ITEM = '{ qlItems(AND: [{ ANY: [{ path: "reviews", conditions: [{ field: "item.name", operator: EQ, value: "one" }] }] }]) { key } }';
  const emptyArgs = (args) => !Object.keys(args).length;
  const QUANTIFIED_18 = NARROW.find(([, , site]) => site === 'B')[1];
  // The legacy declaration of the earlier names with reference emptiness, which is none of the three narrow shapes:
  // like the quantified 18-name adapter, it reads target scopes in the markers of reference-emptiness constructs.
  const LEGACY_18_EMPTINESS = { operators: EARLIER_18, referenceEmptiness: true };
  // The forms that Shop's find scope writes for a client's reference-emptiness construct on shop, outside any frame:
  // clientScopeArgs runs that scope with empty arguments, which the writer waits for, and checks them raw
  // (runtime.js:2520). [the ignored operator, the Shop field, its filter, the path site A names, the EQ value the
  // compilers read]
  const SHOP_IGNORED = [
    ['IIN', 'name', { operator: 'EQ', value: 'Alpha', terms: [{ path: 'x', operator: 'IIN', value: ['a'] }] }, 'name.x', 'Alpha'],
    ['CONTAINS_ALL', 'tags', { operator: 'EQ', value: 'a', terms: [{ path: 'x', operator: 'CONTAINS_ALL', value: ['a'] }] }, 'tags.x', 'a'],
    ['IIN', 'items', { operator: 'IIN', value: ['a'], terms: [{ path: 'name', operator: 'EQ', value: 'one' }] }, 'items', 'one'],
  ];
  // The client's reference-emptiness constructs on shop: [the construct, the source, its emptiness operator, the
  // construct that carries the scope marker in the arguments the adapter receives]
  const EMPTINESS_READS = [
    ['term', '{ qlItems(shop: { terms: [{ operator: IS_EMPTY }] }) { key } }', 'IS_EMPTY', (args) => args.shop.terms[0]],
    ['condition', '{ qlItems(AND: [{ conditions: [{ field: "shop", operator: IS_NOT_EMPTY }] }]) { key } }', 'IS_NOT_EMPTY', (args) => args.AND[0].conditions[0]],
  ];
  // [the ignored operator, the Shop field, the construct, the shape, then the row's data and the shape's queryFeatures]
  const shopEmptinessRows = (shapes) => shapes.flatMap(([shape, queryFeatures]) => EMPTINESS_READS.flatMap(([construct, source, emptiness, carrier]) => (
    SHOP_IGNORED.map(([operator, field, filter, reported, value]) => [operator, field, construct, shape, { filter, reported, value, source, emptiness, carrier, queryFeatures }])
  )));

  describe.each(NARROW)('an adapter with %s', (_shape, queryFeatures, site) => {
    it.each(FORMS)('rejects, in %s, a client\'s %s before middleware', async (_form, operator, path, source) => {
      const { calls, middleware, run } = build({ queryFeatures });
      expect(failure(await run(source))).toEqual(unsupported(site, operator, path));
      expect(middleware).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    });

    it.each([['CONTAINS_ALL', 'tags', ['A']], ['IIN', 'name', ['one']]])('rejects a middleware\'s %s after middleware, with no adapter call', async (operator, field, value) => {
      const { calls, middleware, run } = build({ queryFeatures });
      const result = await run('{ qlItems { key } }', { middleware: on((args) => { args[field] = { operator, value }; }) });
      expect(failure(result)).toEqual(unsupported(site, operator, field));
      expect(middleware).toHaveBeenCalledTimes(1);
      expect(calls).toEqual([]);
    });

    it('rejects a client\'s CONTAINS_ALL through a collection as undeclared, before its path rule', async () => {
      const { calls, middleware, run } = build({ queryFeatures });
      const result = await run('{ qlItems(AND: [{ conditions: [{ field: "reviews.author", operator: CONTAINS_ALL, value: ["x"] }] }]) { key } }');
      expect(failure(result)).toEqual(unsupported(site, 'CONTAINS_ALL', 'reviews.author'));
      expect(middleware).not.toHaveBeenCalled();
      expect(calls).toEqual([]);
    });

    it('rejects a middleware\'s CONTAINS_ALL through a collection as undeclared, after middleware, before its path rule', async () => {
      const { calls, middleware, run } = build({ queryFeatures });
      const result = await run('{ qlItems { key } }', { middleware: on((args) => appendGroup(args, { field: 'reviews.author', operator: 'CONTAINS_ALL', value: ['x'] })) });
      expect(failure(result)).toEqual(unsupported(site, 'CONTAINS_ALL', 'reviews.author'));
      expect(middleware).toHaveBeenCalledTimes(1);
      expect(calls).toEqual([]);
    });

    // The validator skips the ignored forms, so the runtime's operator check reports them: site A on every shape, the
    // quantified one included. On 3.15.0 that check skipped the two names, which it did not know, so these forms
    // reached the adapter and createQueryPlan ignored them, as it still does on the bundled declaration (the guard
    // below): these adapters now reject requests that 3.15.0 passed to them.
    it.each(BESIDE_TERMS)('gives a middleware\'s %s beside the terms of %s site A\'s message', async (operator, field, filter) => {
      const { calls, run } = build({ queryFeatures });
      const result = await run('{ qlItems { key } }', { middleware: on((args) => { args[field] = structuredClone(filter); }) });
      expect(failure(result)).toEqual(unsupported('A', operator, field));
      expect(calls).toEqual([]);
    });

    it.each(SCALAR_TERMS)('gives a middleware\'s %s in the terms of %s, which is not an object, site A\'s message', async (operator, field, filter) => {
      const { calls, run } = build({ queryFeatures });
      const result = await run('{ qlItems { key } }', { middleware: on((args) => { args[field] = structuredClone(filter); }) });
      expect(failure(result)).toEqual(unsupported('A', operator, `${field}.x`));
      expect(calls).toEqual([]);
    });

    // The same forms that scopes write, through each runtime call of site A that a scope's arguments reach: the
    // get_by_id gate of findVisibleById, for qlItem and for a generated reference field; and the operator check of
    // applyJoinedScopes on the find scope of a type that a client path joins. The find and aggregate scopes of the
    // read's own type reach the final gate (settleClientArgs) in the read they scope, as middleware does: those rows
    // pin the writers, not another call.
    it.each(IGNORED)('gives a get_by_id scope\'s %s on %s site A\'s message in qlItem, with no adapter call', async (operator, field, filter) => {
      const { calls, run } = build({ queryFeatures, scopes: writing('get_by_id', field, filter) });
      const result = await run('{ qlItem(id: "I1") { key } }');
      expect(failure(result)).toEqual(unsupported('A', operator, reportedOn(field)));
      expect(result.errors).toHaveLength(1);
      expect(result.data).toEqual({ qlItem: null });
      expect(calls).toEqual([]);
    });

    it.each(IGNORED)('gives a get_by_id scope\'s %s on %s site A\'s message in every generated reference field, with no Item read', async (operator, field, filter) => {
      const { calls, run } = build({ queryFeatures, scopes: writing('get_by_id', field, filter) });
      const result = await run('{ qlReviews { key item { key } } }');
      const expected = unsupported('A', operator, reportedOn(field));
      expect(failure(result)).toEqual(expected);
      expect(result.errors.map((error) => failure({ error }))).toEqual(Array(6).fill(expected));
      expect(result.data.qlReviews.map(({ item }) => item)).toEqual(Array(6).fill(null));
      expect(itemCalls(calls)).toEqual([]);
    });

    it.each(IGNORED)('gives a find scope\'s %s on %s site A\'s message in the read it scopes, with no adapter call', async (operator, field, filter) => {
      const { calls, run } = build({ queryFeatures, scopes: writing('find', field, filter) });
      const result = await run('{ qlItems { key } }');
      expect(failure(result)).toEqual(unsupported('A', operator, reportedOn(field)));
      expect(calls).toEqual([]);
    });

    it.each(IGNORED)('gives an aggregate scope\'s %s on %s site A\'s message in the aggregate it scopes, with no adapter call', async (operator, field, filter) => {
      const { calls, run } = build({ queryFeatures, scopes: writing('aggregate', field, filter) });
      expect(failure(await run(`{ qlItems_aggregate(${aggregation}) { groupId } }`))).toEqual(unsupported('A', operator, reportedOn(field)));
      expect(calls).toEqual([]);
    });

    // A joined find scope, below a single reference. The prefixing (prefixScopeArgs) drops an operator beside terms,
    // so 7f12322 ran the request without it, and turns a scalar field's terms into a path through that field, which
    // 7f12322 rejected with INVALID_FILTER_PATH (Field <name> cannot be traversed) on every shape. The raw scope check
    // (runtime.js:2355) precedes the prefixing, so on these shapes both forms now give site A's message on the target
    // type (spec 7.1 item 4, the 7.3 Existing filters bullet, the 7.4 Changed row); declaring adapters keep
    // 7f12322's outcomes (the guards below).
    it.each(JOINED_BESIDE_TERMS)('gives a joined find scope\'s %s beside the terms of %s site A\'s message on QlItem, in %s, with no adapter call', async (operator, field, _form, filter, source) => {
      const { calls, run } = build({ queryFeatures, scopes: writing('find', field, filter) });
      const result = await run(source);
      expect(failure(result)).toEqual(unsupported('A', operator, field));
      expect(calls).toEqual([]);
    });

    it.each(JOINED_SCALAR_TERMS)('gives a joined find scope\'s %s in the terms of %s, which is not an object, site A\'s message on QlItem, in %s, with no adapter call', async (operator, field, _form, filter, source) => {
      const { calls, run } = build({ queryFeatures, scopes: writing('find', field, filter) });
      expect(failure(await run(source))).toEqual(unsupported('A', operator, `${field}.x`));
      expect(calls).toEqual([]);
    });

    // A find scope below a scoped collection. On the two legacy shapes applyJoinedScopes runs its raw check
    // (runtime.js:2355) before the FORBIDDEN_FILTER_PATH of runtime.js:2358, which 7f12322 gave (403); on the
    // quantified 18-name shape the scope is read through the client's implicit frame by clientScopeArgs, whose raw
    // check (runtime.js:2520) reports it, where 7f12322 passed it to the adapter. Site A on the target type, on every
    // shape; declaring adapters keep 7f12322's outcomes (the guards below).
    it.each(ITEMS_IGNORED)('gives a find scope\'s %s on %s that a client path reads through the scoped collection items site A\'s message, in %s, with no adapter call', async (operator, field, _form, filter, source) => {
      const { calls, run } = build({ queryFeatures, scopes: writing('find', field, filter) });
      expect(failure(await run(source))).toEqual(unsupported('A', operator, reportedOn(field)));
      expect(calls).toEqual([]);
    });

    it.each(REVIEW_IGNORED)('gives a Review find scope\'s %s on %s that a client path reads through the scoped collection reviews site A\'s message on QlReview, with no adapter call', async (operator, field, filter) => {
      const { calls, run } = build({ queryFeatures, scopes: writing('find', field, filter, undefined, 'review') });
      expect(failure(await run(THROUGH_REVIEWS))).toEqual(unsupported('A', operator, reportedOn(field), 'QlReview'));
      expect(calls).toEqual([]);
    });
  });

  // The quantified 18-name adapter reads Item's find scope for a client frame through reviews.item, and checks its
  // arguments at site A (clientScopeArgs); the legacy shapes reject the frame itself.
  it.each(IGNORED)('gives a find scope\'s %s on %s that a client frame reads through site A\'s message on the quantified 18-name adapter, with no adapter call', async (operator, field, filter) => {
    const { calls, run } = build({ queryFeatures: QUANTIFIED_18, scopes: writing('find', field, filter, emptyArgs) });
    const result = await run(FRAME_THROUGH_ITEM);
    expect(failure(result)).toEqual(unsupported('A', operator, reportedOn(field)));
    expect(calls).toEqual([]);
  });

  // The two undeclared shapes that declare referenceEmptiness read Shop's find scope for a client's reference-emptiness
  // term or condition, and check its arguments at site A (clientScopeArgs), where 7f12322 passed the forms to the
  // adapter in the construct's marker. The other two narrow shapes reject the construct itself, on 7f12322 too.
  const UNDECLARED_EMPTINESS = [
    ['{ operators: EARLIER_18, referenceEmptiness: true }', LEGACY_18_EMPTINESS],
    ['{ operators: EARLIER_18, referenceEmptiness: true, quantifiers: true }', QUANTIFIED_18],
  ];
  it.each(shopEmptinessRows(UNDECLARED_EMPTINESS))(
    'gives a Shop find scope\'s %s on %s that a client\'s reference-emptiness %s reads site A\'s message on QlShop, on %s, with no adapter call',
    async (operator, field, _construct, _shape, { filter, reported, source, queryFeatures }) => {
      const { calls, run } = build({ queryFeatures, scopes: writing('find', field, filter, emptyArgs, 'shop') });
      expect(failure(await run(source))).toEqual(unsupported('A', operator, reported, 'QlShop'));
      expect(calls).toEqual([]);
    },
  );

  it.each(IGNORED)('guard: the ignored forms keep being ignored on the bundled declaration: %s on %s', async (operator, field, filter, path, value) => {
    const { calls, run } = build();
    const result = await run('{ qlItems { key } }', { middleware: on((args) => { args[field] = structuredClone(filter); }) });
    ok(result);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[field]).toEqual(filter);
    expect(calls[0].plan.where).toEqual({ kind: 'predicate', path, operator: 'EQ', value });
  });

  // The twins of the scope-written rows above, on the bundled declaration.
  it.each(IGNORED)('guard: a find scope\'s %s on %s keeps being ignored in the read it scopes on the bundled declaration', async (operator, field, filter, path, value) => {
    const { calls, run } = build({ scopes: writing('find', field, filter) });
    ok(await run('{ qlItems { key } }'));
    expect(calls).toHaveLength(1);
    expect(calls[0].args[field]).toEqual(filter);
    expect(calls[0].plan.where).toEqual({ kind: 'predicate', path, operator: 'EQ', value });
  });

  it.each(IGNORED)('guard: an aggregate scope\'s %s on %s keeps being ignored in the aggregate it scopes on the bundled declaration', async (operator, field, filter, path, value) => {
    const { calls, run } = build({ scopes: writing('aggregate', field, filter) });
    ok(await run(`{ qlItems_aggregate(${aggregation}) { groupId } }`));
    expect(calls.map(({ type, method }) => [type, method])).toEqual([['QlItem', 'aggregate']]);
    expect(calls[0].args[field]).toEqual(filter);
    expect(calls[0].plan.where).toEqual({ kind: 'predicate', path, operator: 'EQ', value });
  });

  const byIdWhere = (id, path, value) => ({
    kind: 'and', terms: [{ kind: 'predicate', path: ['id'], operator: 'EQ', value: id }, { kind: 'predicate', path, operator: 'EQ', value }],
  });
  it.each(IGNORED)('guard: a get_by_id scope\'s %s on %s keeps being ignored in qlItem on the bundled declaration', async (operator, field, filter, path, value) => {
    const { calls, run } = build({ scopes: writing('get_by_id', field, filter) });
    ok(await run('{ qlItem(id: "I1") { key } }'));
    expect(calls.map(({ type, method }) => [type, method])).toEqual([['QlItem', 'find']]);
    expect(calls[0].args[field]).toEqual(filter);
    expect(calls[0].plan.where).toEqual(byIdWhere('I1', path, value));
  });

  it.each(IGNORED)('guard: a get_by_id scope\'s %s on %s keeps being ignored in generated reference fields on the bundled declaration', async (operator, field, filter, path, value) => {
    const { calls, run } = build({ scopes: writing('get_by_id', field, filter) });
    ok(await run('{ qlReviews { key item { key } } }'));
    const reads = itemCalls(calls);
    expect(reads).toHaveLength(6);
    for (const read of reads) {
      expect(read.method).toBe('find');
      expect(read.args[field]).toEqual(filter);
      expect(read.plan.where).toEqual(byIdWhere(read.args.id.value, path, value));
    }
  });

  // The declaring adapters, with and without quantifiers.
  const DECLARING = [['the bundled declaration', DECLARED], ['a declaring adapter without quantifiers', WITHOUT_QUANTIFIERS]];
  // The joined rows on each declaring shape, the shape fourth so that the titles name it. [the ignored operator, the
  // field, the client's form, the shape, the filter the scope writes, the source, the shape's queryFeatures]
  const onDeclaring = (rows) => DECLARING.flatMap(([shape, queryFeatures]) => rows.map(([operator, field, form, ...rest]) => [operator, field, form, shape, ...rest, queryFeatures]));

  // applyJoinedScopes prefixes the scope's terms into conditions below item and leaves the operator beside them out.
  it.each(onDeclaring(JOINED_BESIDE_TERMS))(
    'guard: a joined find scope\'s %s beside the terms of %s keeps being ignored, in %s, on %s',
    async (operator, field, _form, _shape, filter, source, queryFeatures) => {
      const { calls, run } = build({ queryFeatures, scopes: writing('find', field, filter) });
      const result = await run(source);
      ok(result);
      expect(keysOf(result.data.qlReviews)).toEqual(['R1', 'R2']);
      expect(calls.map(({ type }) => type)).toEqual(['QlReview']);
      expect(sentValues(calls[0].args, operator)).toEqual([]);
      expect(calls[0].plan.where).toEqual({
        kind: 'and',
        terms: [
          { kind: 'predicate', path: ['item', 'name'], operator: 'EQ', value: 'one' },
          { kind: 'predicate', path: ['item', 'shop', 'name'], operator: 'EQ', value: 'Alpha' },
        ],
      });
    },
  );

  // The path that the prefixing makes from a scalar field's terms keeps 7f12322's INVALID_FILTER_PATH on declaring
  // adapters, with or without quantifiers.
  it.each(onDeclaring(JOINED_SCALAR_TERMS))(
    'guard: a joined find scope\'s %s in the terms of %s, which is not an object, keeps INVALID_FILTER_PATH, in %s, on %s',
    async (operator, field, _form, _shape, filter, source, queryFeatures) => {
      const { calls, run } = build({ queryFeatures, scopes: writing('find', field, filter) });
      expect(failure(await run(source))).toEqual(invalid('INVALID_FILTER_PATH', `Field ${field} cannot be traversed`));
      expect(calls).toEqual([]);
    },
  );

  // Below a scoped collection, an adapter without quantifiers keeps 7f12322's FORBIDDEN_FILTER_PATH.
  it.each(ITEMS_IGNORED)('guard: a find scope\'s %s on %s that a client path reads through the scoped collection items keeps FORBIDDEN_FILTER_PATH, in %s, on a declaring adapter without quantifiers', async (operator, field, _form, filter, source) => {
    const { calls, run } = build({ queryFeatures: WITHOUT_QUANTIFIERS, scopes: writing('find', field, filter) });
    expect(failure(await run(source))).toEqual(forbiddenCollection('items', 'QlShop.items'));
    expect(calls).toEqual([]);
  });

  // On the bundled declaration the client's implicit frame carries the scope in its marker, and createQueryPlan
  // reads only the predicate beside which, or above whose terms, the ignored operator sits.
  it.each(ITEMS_IGNORED)('guard: a find scope\'s %s on %s that a client path reads through the scoped collection items keeps being ignored in the frame, in %s, on the bundled declaration', async (operator, field, form, filter, source, path, value) => {
    const { calls, run } = build({ scopes: writing('find', field, filter) });
    ok(await run(source));
    expect(calls.map(({ type, method }) => [type, method])).toEqual([['QlShop', 'find']]);
    expect(ITEMS_MARKER[form](calls[0].args)).toEqual({ items: { [field]: filter } });
    expect(calls[0].plan.where).toEqual({
      kind: 'quantified',
      quantifier: 'ANY',
      path: ['items'],
      where: { kind: 'predicate', path: ['name'], operator: 'EQ', value: 'one' },
      scope: { kind: 'predicate', path, operator: 'EQ', value },
    });
  });

  it.each(REVIEW_IGNORED)('guard: a Review find scope\'s %s on %s that a client path reads through the scoped collection reviews keeps FORBIDDEN_FILTER_PATH on a declaring adapter without quantifiers', async (operator, field, filter) => {
    const { calls, run } = build({ queryFeatures: WITHOUT_QUANTIFIERS, scopes: writing('find', field, filter, undefined, 'review') });
    expect(failure(await run(THROUGH_REVIEWS))).toEqual(forbiddenCollection('reviews', 'QlItem.reviews'));
    expect(calls).toEqual([]);
  });

  // Likewise through the scoped collection reviews.
  it.each(REVIEW_IGNORED)('guard: a Review find scope\'s %s on %s that a client path reads through the scoped collection reviews keeps being ignored in the frame on the bundled declaration', async (operator, field, filter, path, value) => {
    const { calls, run } = build({ scopes: writing('find', field, filter, undefined, 'review') });
    ok(await run(THROUGH_REVIEWS));
    expect(calls.map(({ type, method }) => [type, method])).toEqual([['QlItem', 'find']]);
    expect(calls[0].args.AND[0].conditions[0].__scope.scopes).toEqual({ reviews: { [field]: filter } });
    expect(calls[0].plan.where).toEqual({
      kind: 'quantified',
      quantifier: 'ANY',
      path: ['reviews'],
      where: { kind: 'predicate', path: ['author'], operator: 'EQ', value: 'ana' },
      scope: { kind: 'predicate', path, operator: 'EQ', value },
    });
  });

  it.each(IGNORED)('guard: a find scope\'s %s on %s that a client frame reads through keeps being ignored on the bundled declaration', async (operator, field, filter, path, value) => {
    const { calls, run } = build({ scopes: writing('find', field, filter, emptyArgs) });
    ok(await run(FRAME_THROUGH_ITEM));
    expect(calls).toHaveLength(1);
    const [group] = calls[0].args.AND[0].ANY;
    expect(group.conditions[0].__scope.scopes).toEqual({ item: { [field]: filter } });
    expect(calls[0].plan.where).toEqual({
      kind: 'quantified',
      quantifier: 'ANY',
      path: ['reviews'],
      where: { kind: 'predicate', path: ['item', 'name'], operator: 'EQ', value: 'one', joins: { item: { kind: 'predicate', path, operator: 'EQ', value } } },
      scope: null,
    });
  });

  // On declaring adapters the reference-emptiness construct carries Shop's scope, forms included, in its marker, and
  // createQueryPlan reads only the EQ predicate the form sits beside or above.
  it.each(shopEmptinessRows(DECLARING))(
    'guard: a Shop find scope\'s %s on %s that a client\'s reference-emptiness %s reads keeps being ignored in its marker, on %s',
    async (operator, field, _construct, _shape, { filter, value, source, emptiness, carrier, queryFeatures }) => {
      const { calls, run } = build({ queryFeatures, scopes: writing('find', field, filter, emptyArgs, 'shop') });
      ok(await run(source));
      expect(calls.map(({ type, method }) => [type, method])).toEqual([['QlItem', 'find']]);
      expect(carrier(calls[0].args).__scope.scopes).toEqual({ shop: { [field]: filter } });
      expect(calls[0].plan.where).toMatchObject({ kind: 'predicate', path: ['shop'], operator: emptiness });
      expect(sentValues(calls[0].plan.where, operator)).toEqual([]);
      expect(sentValues(calls[0].plan.where, 'EQ')).toEqual([value]);
    },
  );

  it('guard: a middleware\'s CONTAINS_ALL through a collection keeps the shorthand\'s INVALID_FILTER_PATH on the bundled declaration', async () => {
    const { calls, run } = build();
    const result = await run('{ qlItems { key } }', { middleware: on((args) => appendGroup(args, { field: 'reviews.tags', operator: 'CONTAINS_ALL', value: ['x'] })) });
    expect(failure(result)).toEqual(SHORTHAND);
    expect(calls).toEqual([]);
  });

  it.each([['the bundled declaration', DECLARED], ...NARROW.map(([shape, queryFeatures]) => [shape, queryFeatures])])(
    'guard: unknown names (SOUNDS_LIKE) keep INVALID_FILTER_OPERATOR on %s', async (_shape, queryFeatures) => {
      const { calls, run } = build({ queryFeatures });
      const result = await run('{ qlItems { key } }', { middleware: on((args) => { args.name = { operator: 'SOUNDS_LIKE', value: 'x' }; }) });
      expect(failure(result)).toEqual(invalid('INVALID_FILTER_OPERATOR', 'Unknown filter operator: SOUNDS_LIKE'));
      expect(calls).toEqual([]);
    },
  );
});

describe('a declaring adapter without quantifiers', () => {
  it.each([
    ['CONTAINS_ALL through a collection', '{ qlItems(AND: [{ conditions: [{ field: "reviews.tags", operator: CONTAINS_ALL, value: ["x"] }] }]) { key } }', SHORTHAND],
    ['an explicit ANY group', '{ qlItems(AND: [{ ANY: [{ path: "reviews", conditions: [{ field: "tags", operator: CONTAINS_ALL, value: ["x"] }] }] }]) { key } }', QUANTIFIED_UNSUPPORTED],
    ['a quantified field filter', '{ qlItems(reviews: { quantifier: ANY, terms: [{ path: "tags", operator: CONTAINS_ALL, value: ["x"] }] }) { key } }', QUANTIFIED_UNSUPPORTED],
  ])('rejects %s before middleware', async (_what, source, expected) => {
    const { calls, middleware, run } = build({ queryFeatures: WITHOUT_QUANTIFIERS });
    expect(failure(await run(source))).toEqual(expected);
    expect(middleware).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it.each([
    ['tags', '{ qlItems(tags: { operator: CONTAINS_ALL, value: ["A"] }) { key } }', ['I1', 'I2', 'I3', 'I6']],
    ['lines.sku', '{ qlItems(AND: [{ conditions: [{ field: "lines.sku", operator: CONTAINS_ALL, value: ["A"] }] }]) { key } }', ['I1', 'I2', 'I3']],
  ])('passes CONTAINS_ALL on %s, which crosses no collection, to the adapter', async (field, source, keys) => {
    const { calls, run } = build({ queryFeatures: WITHOUT_QUANTIFIERS });
    const result = await run(source);
    ok(result);
    expect(keysOf(result.data.qlItems)).toEqual(keys);
    expect(calls).toHaveLength(1);
    expect(sentValues(calls[0].args, 'CONTAINS_ALL')).toEqual([['A']]);
    expect(calls[0].plan.where).toEqual({ kind: 'predicate', path: field.split('.'), operator: 'CONTAINS_ALL', value: ['A'] });
  });

  // Without quantifiers, frameCollectionPaths leaves the arguments as they are: IIN keeps IN's legacy join.
  const legacyJoin = async (operator, value) => {
    const { calls, run } = build({ queryFeatures: WITHOUT_QUANTIFIERS });
    const result = await run(`{ qlItems(AND: [{ conditions: [{ field: "reviews.author", operator: ${operator}, value: ${JSON.stringify(value)} }] }]) { key } }`);
    ok(result);
    expect(keysOf(result.data.qlItems)).toEqual(['I1', 'I2']);
    expect(calls).toHaveLength(1);
    expect(calls[0].args.AND).toEqual([{ conditions: [{ field: 'reviews.author', operator, value }] }]);
    expect(JSON.stringify(calls[0].args)).not.toContain('__implicit');
    expect(calls[0].plan.where).toEqual({ kind: 'predicate', path: ['reviews', 'author'], operator, value });
    expect(allNodes(calls[0].plan.where).filter((node) => node.kind === 'quantified')).toEqual([]);
  };
  it('keeps the legacy join of IN for reviews.author IIN ["ana"]', () => legacyJoin('IIN', ['ana']));
  it('guard: reviews.author IN ["Ana", "ANA"] keeps the legacy join of IN', () => legacyJoin('IN', ['Ana', 'ANA']));

  // D17's third case: the itemTags scope, prefixed below reviews.item, crosses a collection.
  const reviewItemName = '{ qlItems(AND: [{ conditions: [{ field: "reviews.item.name", operator: EQ, value: "one" }] }]) { key } }';
  it('gives a client path through reviews.item INVALID_FILTER_PATH under the itemTags scope, before the adapter', async () => {
    const { calls, run } = build({ queryFeatures: WITHOUT_QUANTIFIERS });
    expect(failure(await run(reviewItemName, { scopes: ['itemTags'] }))).toEqual(SHORTHAND);
    expect(calls).toEqual([]);
  });
  it('reads the same path under the itemTags scope on a quantified adapter, which carries the scope in the frame', async () => {
    const { calls, run } = build();
    const result = await run(reviewItemName, { scopes: ['itemTags'] });
    ok(result);
    expect(keysOf(result.data.qlItems)).toEqual(['I1']);
    expect(calls[0].args.AND[0].conditions[0].__scope).toEqual({
      id: 0, scopes: { reviews: null, 'reviews.item': { AND: [{ conditions: [{ field: 'tags', operator: 'CONTAINS_ALL', value: ['A'] }] }] } },
    });
    expect(calls[0].args.AND[1]).toEqual({ conditions: [{ field: 'tags', operator: 'CONTAINS_ALL', value: ['A'] }] });
  });
});

// Hand-built implicit groups (spec 7.1 item 10) that an Item scope writes inside an explicit ANY, on the adapters
// without quantifiers. The runtime's own checks of the conditions inside the group come first (site A for an operator
// other than IS_EMPTY and IS_NOT_EMPTY that the adapter does not declare, emptiness through a reference without
// referenceEmptiness), then the implicit group's path and anchor rules, then the explicit ANY's QUANTIFIED_UNSUPPORTED,
// all before any adapter call. Site A skips the declaration of IS_EMPTY and IS_NOT_EMPTY inside a frame
// (runtime.js:2236), so the validator checks an undeclared one only after the group's rules.
describe('hand-built implicit groups on adapters without quantifiers', () => {
  const GROUPS = {
    'lines with notes CONTAINS_ALL': { __implicit: true, path: 'lines', conditions: [{ field: 'notes', operator: 'CONTAINS_ALL', value: ['a'] }] },
    'parts with shop IS_EMPTY': { __implicit: true, path: 'parts', conditions: [{ field: 'shop', operator: 'IS_EMPTY' }] },
    'lines with sku EQ': { __implicit: true, path: 'lines', conditions: [{ field: 'sku', operator: 'EQ', value: 'A' }] },
    'shop with name EQ': { __implicit: true, path: 'shop', conditions: [{ field: 'name', operator: 'EQ', value: 'Alpha' }] },
    'lines with sku IS_EMPTY': { __implicit: true, path: 'lines', conditions: [{ field: 'sku', operator: 'IS_EMPTY' }] },
    'lines with sku IS_NOT_EMPTY': { __implicit: true, path: 'lines', conditions: [{ field: 'sku', operator: 'IS_NOT_EMPTY' }] },
    '[reviews] item with name IS_EMPTY': { __implicit: true, __anchor: ['reviews'], path: 'item', conditions: [{ field: 'name', operator: 'IS_EMPTY' }] },
    'shop with name IS_EMPTY': { __implicit: true, path: 'shop', conditions: [{ field: 'name', operator: 'IS_EMPTY' }] },
    'reviews with author IS_NOT_EMPTY': { __implicit: true, path: 'reviews', conditions: [{ field: 'author', operator: 'IS_NOT_EMPTY' }] },
  };
  const LEGACY_18 = ['{ operators: EARLIER_18 }', { operators: EARLIER_18 }];
  const WITHOUT = ['a declaring adapter without quantifiers', WITHOUT_QUANTIFIERS];
  // The operators of 3.7.0, without IS_EMPTY and IS_NOT_EMPTY.
  const NO_FEATURES = ['no queryFeatures', undefined];
  // A declaration that leaves out the two emptiness operators.
  const UNDECLARED_EMPTINESS = ['{ operators } without IS_EMPTY and IS_NOT_EMPTY', { operators: EARLIER_18.filter((op) => !op.startsWith('IS_')) }];
  const IMPLICIT_PATH = invalid('INVALID_FILTER_PATH', 'An implicit quantified path must end at a collection, or at a reference without crossing a list');
  const IMPLICIT_ANCHOR = invalid('INVALID_FILTER_PATH', 'An implicit quantified anchor must name the aggregate\'s join prefixes');
  const SHOP_EMPTINESS = invalid('UNSUPPORTED_QUERY',
    'IS_EMPTY on shop ends at the reference shop: the database adapter does not support emptiness through references and collections');
  // An Item scope for `operation` that appends `{ ANY: [group] }` to the arguments.
  const writingGroup = (group, operation = 'find') => ({
    item: { [operation]: ({ args }) => { args.AND = [...(args.AND ?? []), { ANY: [structuredClone(group)] }]; } },
  });
  const rejects = async (queryFeatures, group, expected) => {
    const { calls, run } = build({ queryFeatures, scopes: writingGroup(group) });
    expect(failure(await run('{ qlItems { key } }'))).toEqual(expected);
    expect(calls).toEqual([]);
  };

  // [the group, the shape, the shape's queryFeatures, the failure]
  it.each([
    ['lines with notes CONTAINS_ALL', ...LEGACY_18, unsupported('A', 'CONTAINS_ALL', 'lines.notes')],
    ['lines with sku EQ', ...LEGACY_18, IMPLICIT_PATH],
    ['lines with notes CONTAINS_ALL', ...WITHOUT, IMPLICIT_PATH],
    ['parts with shop IS_EMPTY', ...WITHOUT, IMPLICIT_PATH],
    ['lines with sku EQ', ...WITHOUT, IMPLICIT_PATH],
  ])('gives a find scope\'s implicit group over %s, on %s, the runtime\'s checks of its conditions first, then the implicit path rule', async (name, _shape, queryFeatures, expected) => {
    await rejects(queryFeatures, GROUPS[name], expected);
  });

  // An undeclared emptiness operator that site A does not reject: 7f12322 gave the validator's UNSUPPORTED_QUERY
  // `The <OP> filter operator is not supported by this query compiler`, which now comes after the group's rules.
  it.each([
    ['lines with sku IS_EMPTY', ...NO_FEATURES, IMPLICIT_PATH],
    ['lines with sku IS_NOT_EMPTY', ...NO_FEATURES, IMPLICIT_PATH],
    ['[reviews] item with name IS_EMPTY', ...NO_FEATURES, IMPLICIT_ANCHOR],
    ['lines with sku IS_EMPTY', ...UNDECLARED_EMPTINESS, IMPLICIT_PATH],
    ['lines with sku IS_NOT_EMPTY', ...UNDECLARED_EMPTINESS, IMPLICIT_PATH],
    ['[reviews] item with name IS_EMPTY', ...UNDECLARED_EMPTINESS, IMPLICIT_ANCHOR],
  ])('gives a find scope\'s implicit group over %s, on %s, the group\'s rule before the validator\'s check of the undeclared emptiness operator', async (name, _shape, queryFeatures, expected) => {
    await rejects(queryFeatures, GROUPS[name], expected);
  });

  // Groups that the runtime's own checks reject, or that the group's rules accept, keep their 3.15.0 failures. In an
  // accepted group (shop ends at a reference, reviews at a collection) an undeclared emptiness operator still gives the
  // validator's UNSUPPORTED_QUERY (site B's message), after the group's rules and before the explicit ANY's.
  it.each([
    ['parts with shop IS_EMPTY', ...LEGACY_18, SHOP_EMPTINESS],
    ['parts with shop IS_EMPTY', ...NO_FEATURES, SHOP_EMPTINESS],
    ['shop with name EQ', ...LEGACY_18, QUANTIFIED_UNSUPPORTED],
    ['shop with name EQ', ...WITHOUT, QUANTIFIED_UNSUPPORTED],
    ['shop with name IS_EMPTY', ...NO_FEATURES, unsupported('B', 'IS_EMPTY')],
    ['shop with name IS_EMPTY', ...UNDECLARED_EMPTINESS, unsupported('B', 'IS_EMPTY')],
    ['reviews with author IS_NOT_EMPTY', ...NO_FEATURES, unsupported('B', 'IS_NOT_EMPTY')],
    ['reviews with author IS_NOT_EMPTY', ...UNDECLARED_EMPTINESS, unsupported('B', 'IS_NOT_EMPTY')],
  ])('guard: a find scope\'s implicit group over %s, on %s, keeps its 3.15.0 failure', async (name, _shape, queryFeatures, expected) => {
    await rejects(queryFeatures, GROUPS[name], expected);
  });

  // The anchor rule keeps the same order: an empty __anchor over the collection reviews, in the aggregate it scopes.
  it.each([
    [...LEGACY_18, unsupported('A', 'CONTAINS_ALL', 'reviews.tags')],
    [...WITHOUT, IMPLICIT_ANCHOR],
  ])('gives an aggregate scope\'s implicit group with an empty anchor and CONTAINS_ALL inside, on %s, the runtime\'s checks of its conditions first, then the anchor rule', async (_shape, queryFeatures, expected) => {
    const group = { __implicit: true, __anchor: [], path: 'reviews', conditions: [{ field: 'tags', operator: 'CONTAINS_ALL', value: ['x'] }] };
    const { calls, run } = build({ queryFeatures, scopes: writingGroup(group, 'aggregate') });
    expect(failure(await run(`{ qlItems_aggregate(${aggregation}) { groupId } }`))).toEqual(expected);
    expect(calls).toEqual([]);
  });
});

describe('constructs that middleware and scopes write', () => {
  // A find scope on Item that does what `context.itemScope(args)` asks.
  const itemScope = { item: { find: ({ args, context }) => context?.itemScope?.(args) } };

  it('passes a middleware\'s CONTAINS_ALL and a find scope\'s IIN to the adapter, which matches stored values as for IN', async () => {
    const { calls, run } = build({ scopes: itemScope });
    const result = await run('{ qlItems { key } }', {
      middleware: on((args) => { args.tags = { operator: 'CONTAINS_ALL', value: ['A', 'B'] }; }),
      itemScope: (args) => appendGroup(args, { field: 'name', operator: 'IIN', value: ['ONE', 'three'] }),
    });
    ok(result);
    expect(keysOf(result.data.qlItems)).toEqual(['I1', 'I3']);
    expect(calls[0].args).toEqual({
      tags: { operator: 'CONTAINS_ALL', value: ['A', 'B'] },
      AND: [{ conditions: [{ field: 'name', operator: 'IIN', value: ['ONE', 'three'] }] }],
    });
  });

  it.each([
    ['a middleware', 'CONTAINS_ALL on a scalar', 'middleware', { field: 'name', operator: 'CONTAINS_ALL', value: ['x'] },
      invalid('INVALID_FILTER_OPERATOR', 'CONTAINS_ALL requires a list field, or a field reached through an embedded list; name is not one')],
    ['a middleware', 'CONTAINS_ALL through a reference inside an embedded list', 'middleware', { field: 'parts.shop.tags', operator: 'CONTAINS_ALL', value: ['a'] },
      invalid('INVALID_FILTER_PATH', 'CONTAINS_ALL cannot cross the reference parts.shop inside an embedded list, which joins one referenced record per row; combine EQ conditions on the path instead')],
    ['a find scope', 'IIN on an enum list', 'itemScope', { field: 'kinds', operator: 'IIN', value: ['one_v'] },
      invalid('INVALID_FILTER_VALUE', 'IIN requires a String field on kinds')],
    ['a find scope', 'CONTAINS_ALL with a null element', 'itemScope', { field: 'tags', operator: 'CONTAINS_ALL', value: ['A', null] },
      invalid('INVALID_FILTER_VALUE', 'Filter lists require non-null scalar elements')],
  ])('rejects %s\'s %s in the final gate, with no adapter call', async (_writer, _what, writer, condition, expected) => {
    const { calls, run } = build({ scopes: itemScope });
    const write = (args) => appendGroup(args, { ...condition });
    const result = await run('{ qlItems { key } }', writer === 'middleware' ? { middleware: on(write) } : { itemScope: write });
    expect(failure(result)).toEqual(expected);
    expect(calls).toEqual([]);
  });

  it.each([
    ['shop.name IIN through the group-level joined scope of shopTags', { shop: { terms: [{ path: 'name', operator: 'IIN', value: ['alpha', 'beta', 'gamma'] }] } }, ['I1', 'I2']],
    ['box.shop.name EQ through the group-level joined scope of shopTags', { box: { terms: [{ path: 'shop.name', operator: 'EQ', value: 'Alpha' }] } }, ['I1']],
  ])('reads %s', async (_what, args, keys) => {
    const { calls, invoke } = build();
    const result = await invoke('qlItems', args, { scopes: ['shopTags'] });
    ok(result);
    expect(keysOf(result.rows)).toEqual(keys);
    expect(sentValues(calls[0].args, 'CONTAINS_ALL')).toEqual([['a']]);
  });

  // D17: a target scope with CONTAINS_ALL, prefixed below an embedded list or an aggregate J collection, is a path
  // the rules of CONTAINS_ALL reject.
  it('gives parts.shop.name EQ "Alpha" under the shopTags scope INVALID_FILTER_PATH naming parts.shop, before the adapter', async () => {
    const { calls, run } = build();
    const result = await run('{ qlItems(AND: [{ conditions: [{ field: "parts.shop.name", operator: EQ, value: "Alpha" }] }]) { key } }', { scopes: ['shopTags'] });
    expect(failure(result)).toEqual(invalid('INVALID_FILTER_PATH',
      'CONTAINS_ALL cannot cross the reference parts.shop inside an embedded list, which joins one referenced record per row; combine EQ conditions on the path instead'));
    expect(calls).toEqual([]);
  });
  it('gives an aggregate on the J prefix reviews with reviews.item.name EQ "one" under the itemTags scope INVALID_FILTER_PATH, before the adapter', async () => {
    const { calls, run } = build();
    const result = await run('{ qlItems_aggregate(aggregation: { groupId: "reviews.author", facts: [{ operation: COUNT, factName: "n", path: "id" }] }, '
      + 'AND: [{ conditions: [{ field: "reviews.item.name", operator: EQ, value: "one" }] }]) { groupId } }', { scopes: ['itemTags'] });
    expect(failure(result)).toEqual(SHORTHAND);
    expect(calls).toEqual([]);
  });
});

describe('lists that server code builds', () => {
  // Each writer appends `tags <operator> <list>` from `context.serverList` to Item's find reads, or to its by-ID reads.
  const append = (writer) => (args, context) => {
    const list = context?.serverList;
    if (list?.writer === writer) appendGroup(args, { field: 'tags', operator: list.operator, value: list.value });
  };
  const scopes = { item: { find: ({ args, context }) => append('find scope')(args, context), get_by_id: ({ args, context }) => append('get_by_id scope')(args, context) } };
  const context = (writer, operator, value) => ({
    serverList: { writer, operator, value },
    middleware: on((args, params) => append('middleware')(args, params.context)),
  });
  const EMPTY = invalid('INVALID_FILTER_VALUE', 'CONTAINS_ALL requires a non-empty list');
  const BY_ID = '{ a: qlItem(id: "I1") { key } b: qlItem(id: "I2") { key } }';
  const REFERENCES = '{ qlReviews { key item { key } } }';

  it.each(['find scope', 'middleware'])('fails every list read with INVALID_FILTER_VALUE when a %s\'s CONTAINS_ALL list is empty, and reads with a non-empty one', async (writer) => {
    const { calls, run } = build({ scopes });
    expect(failure(await run('{ qlItems { key } }', context(writer, 'CONTAINS_ALL', [])))).toEqual(EMPTY);
    expect(calls).toEqual([]);
    const result = await run('{ qlItems { key } }', context(writer, 'CONTAINS_ALL', ['A', 'B']));
    ok(result);
    expect(keysOf(result.data.qlItems)).toEqual(['I1', 'I3']);
  });

  it('fails every by-ID read, generated reference fields included, when a get_by_id scope\'s CONTAINS_ALL list is empty, and reads with a non-empty one', async () => {
    const { calls, run } = build({ scopes });
    const byId = await run(BY_ID, context('get_by_id scope', 'CONTAINS_ALL', []));
    expect(byId.data).toEqual({ a: null, b: null });
    expect(byId.errors.map((error) => failure({ error }))).toEqual([EMPTY, EMPTY]);
    const references = await run(REFERENCES, context('get_by_id scope', 'CONTAINS_ALL', []));
    expect(references.data.qlReviews.map(({ item }) => item)).toEqual([null, null, null, null, null, null]);
    expect(references.errors.length).toBeGreaterThan(0);
    expect(references.errors.map((error) => failure({ error }))).toEqual(references.errors.map(() => EMPTY));
    expect(itemCalls(calls)).toEqual([]);
    const found = await run(BY_ID, context('get_by_id scope', 'CONTAINS_ALL', ['A', 'B']));
    ok(found);
    expect(found.data).toEqual({ a: { key: 'I1' }, b: null });
    const read = await run(REFERENCES, context('get_by_id scope', 'CONTAINS_ALL', ['A', 'B']));
    ok(read);
    expect(read.data.qlReviews.map(({ key, item }) => [key, item?.key ?? null])).toEqual([
      ['R1', 'I1'], ['R2', 'I1'], ['R3', null], ['R4', 'I3'], ['R5', null], ['R6', null],
    ]);
  });

  it.each(['find scope', 'middleware', 'get_by_id scope'])('guard: IN [] from a %s returns no rows and no error', async (writer) => {
    const { run } = build({ scopes });
    const result = await run(writer === 'get_by_id scope' ? BY_ID : '{ qlItems { key } }', context(writer, 'IN', []));
    ok(result);
    expect(result.data).toEqual(writer === 'get_by_id scope' ? { a: null, b: null } : { qlItems: [] });
  });
});

describe('sparse arrays from middleware', () => {
  it.each([
    ['CONTAINS_ALL', 'tags', 'A', 'Filter lists require non-null scalar elements'],
    ['IIN', 'name', 'a', 'IIN requires non-null string elements on name'],
  ])('rejects %s with a hole in the final gate, with no adapter call', async (operator, field, item, message) => {
    const { calls, run } = build();
    let written;
    const result = await run('{ qlItems { key } }', { middleware: on((args) => {
      written = sparse(item);
      args[field] = { operator, value: written };
    }) });
    expect(0 in written).toBe(false);
    expect(failure(result)).toEqual(invalid('INVALID_FILTER_VALUE', message));
    expect(calls).toEqual([]);
  });
});

describe('client frames, scope markers and views', () => {
  const FORBIDDEN_FRAME = '{ qlItems(AND: [{ ANY: [{ path: "reviews", conditions: [{ field: "item.parts.shop.name", operator: IIN, value: ["alpha"] }] }] }]) { key } }';

  it('reads ANY reviews: item.parts.shop.name IIN ["alpha"] for an admin', async () => {
    const { run } = build();
    const result = await run(FORBIDDEN_FRAME);
    ok(result);
    expect(keysOf(result.data.qlItems)).toEqual(['I1', 'I3', 'I6']);
  });

  it.each(['shopNE', 'shopEQ'])('gives ANY reviews: item.parts.shop.name IIN ["alpha"] FORBIDDEN_FILTER_PATH under %s, with no adapter call', async (shape) => {
    const { calls, run } = build();
    expect(failure(await run(FORBIDDEN_FRAME, { scopes: [shape] }))).toEqual({
      code: 'FORBIDDEN_FILTER_PATH', status: 403, message: 'Query path reviews.item.parts.shop enters QlShop, whose find scope restricts the relation QlPart.shop inside a list',
    });
    expect(calls).toEqual([]);
  });

  it.each([[['reviewNE', 'shopNE']], [['reviewNE']]])('detaches the client\'s IIN frame carrier that middleware edits into CONTAINS_ALL on shop.tags, under %j', async (shapes) => {
    const { calls, run } = build();
    let marker;
    const result = await run('{ qlItems(AND: [{ conditions: [{ field: "reviews.author", operator: IIN, value: ["ana"] }] }]) { key } }', {
      scopes: shapes,
      middleware: on((args) => {
        const condition = args.AND[0].conditions[0];
        marker = structuredClone(condition.__scope);
        Object.assign(condition, { field: 'shop.tags', operator: 'CONTAINS_ALL', value: ['a'] });
      }),
    });
    expect(failure(result)).toEqual(detached('The client\'s IIN condition on reviews.author now uses CONTAINS_ALL on shop.tags, which reads through shop without its scope'));
    expect(marker).toEqual({ id: 0 });
    expect(calls).toEqual([]);
  });

  // [frame, scope shape, the IIN source, its IN twin, the filled markers, the item keys]
  const MARKED = [
    ['an explicit frame', 'shopNE',
      '{ qlItems(AND: [{ ANY: [{ path: "reviews", conditions: [{ field: "item.shop.name", operator: IIN, value: ["alpha", "BETA"] }] }] }]) { key } }',
      '{ qlItems(AND: [{ ANY: [{ path: "reviews", conditions: [{ field: "item.shop.name", operator: IN, value: ["Alpha", "beta"] }] }] }]) { key } }',
      (args) => [args.AND[0].ANY[0].__scope.scopes, args.AND[0].ANY[0].conditions[0].__scope.scopes],
      [{ reviews: null }, { item: null, 'item.shop': { AND: [{ conditions: [{ field: 'name', operator: 'NE', value: 'beta' }] }] } }],
      ['I1']],
    ['a shorthand frame', 'reviewEQ',
      '{ qlItems(AND: [{ conditions: [{ field: "reviews.author", operator: IIN, value: ["ana"] }] }]) { key } }',
      '{ qlItems(AND: [{ conditions: [{ field: "reviews.author", operator: IN, value: ["Ana"] }] }]) { key } }',
      (args) => [args.AND[0].conditions[0].__scope.scopes],
      [{ reviews: { AND: [{ conditions: [{ field: 'author', operator: 'EQ', value: 'Ana' }] }] } }],
      ['I1']],
  ];
  it.each(MARKED)('marks and fills a client IIN in %s over a scoped type like IN, under %s', async (_frame, shape, source, twin, markers, filled, keys) => {
    const read = async (query) => {
      const { calls, run } = build();
      let seen;
      const result = await run(query, { scopes: [shape], middleware: on((args) => { seen = structuredClone(args); }) });
      ok(result);
      return { keys: keysOf(result.data.qlItems), seen, filled: markers(calls[0].args), marked: JSON.stringify(seen).match(/"__scope":\{"id":\d+\}/g) };
    };
    const iin = await read(source);
    const inTwin = await read(twin);
    expect(iin.filled).toEqual(filled);
    expect(iin.filled).toEqual(inTwin.filled);
    expect(iin.marked).toEqual(inTwin.marked);
    expect(iin.marked).toHaveLength(filled.length);
    expect(iin.keys).toEqual(keys);
    expect(inTwin.keys).toEqual(keys);
  });

  it('gives CONTAINS_ALL with a forged __scope outside a frame DETACHED_CLIENT_FILTER, with no adapter call', async () => {
    const { calls, run } = build();
    const result = await run('{ qlItems(AND: [{ conditions: [{ field: "tags", operator: CONTAINS_ALL, value: ["A"] }] }]) { key } }', {
      middleware: on((args) => { args.AND[0].conditions[0].__scope = { id: 7 }; }),
    });
    expect(failure(result)).toEqual(detached('The CONTAINS_ALL condition on tags carries a client scope marker that this query field did not issue'));
    expect(calls).toEqual([]);
  });

  it.each([
    ['byIdTags', ['CONTAINS_ALL', 'tags', ['A', 'B']]],
    ['byIdName', ['IIN', 'name', ['ONE']]],
  ])('applies the get_by_id scope %s', async (shape, [operator, field, value]) => {
    const { calls, run } = build();
    const result = await run('{ a: qlItem(id: "I1") { key } b: qlItem(id: "I2") { key } }', { scopes: [shape] });
    ok(result);
    expect(result.data).toEqual({ a: { key: 'I1' }, b: null });
    expect(calls.map(({ method, args }) => [method, args])).toEqual(['I1', 'I2'].map((id) => ['find', {
      id: { operator: 'EQ', value: id }, AND: [{ conditions: [{ field, operator, value }] }],
    }]));
  });

  const views = {
    qlItemsWithTags: (types) => ({
      type: types.Item, description: 'Items with every tag', params: { codes: { type: new GraphQLList(GraphQLString) } },
      where: ({ params }) => [{ conditions: [{ field: 'tags', operator: 'CONTAINS_ALL', value: params.codes }] }],
    }),
    qlItemsNamed: (types) => ({
      type: types.Item, description: 'Items with one of the names, ignoring case', params: { names: { type: new GraphQLList(GraphQLString) } },
      where: ({ params }) => [{ conditions: [{ field: 'name', operator: 'IIN', value: params.names }] }],
    }),
  };
  it('reads named views whose where uses CONTAINS_ALL and IIN, and validates their values per call', async () => {
    const { calls, run } = build({ views });
    const tags = await run('{ qlItemsWithTags(codes: ["A", "B"]) { key } }');
    ok(tags);
    expect(keysOf(tags.data.qlItemsWithTags)).toEqual(['I1', 'I3']);
    const named = await run('{ qlItemsNamed(names: ["one"]) { key } }');
    ok(named);
    expect(keysOf(named.data.qlItemsNamed)).toEqual(['I1']);
    expect(calls.map(({ args }) => args.AND)).toEqual([
      [{ conditions: [{ field: 'tags', operator: 'CONTAINS_ALL', value: ['A', 'B'] }] }],
      [{ conditions: [{ field: 'name', operator: 'IIN', value: ['one'] }] }],
    ]);
    calls.length = 0;
    expect(failure(await run('{ qlItemsWithTags(codes: []) { key } }'))).toEqual(invalid('INVALID_FILTER_VALUE', 'CONTAINS_ALL requires a non-empty list'));
    expect(calls).toEqual([]);
  });

  it('gives each call its own CONTAINS_ALL value array when fields share the variable', async () => {
    const { calls, run } = build();
    const variables = { v: ['A'] };
    const result = await run(
      'query($v: QLValue) { a: qlItems(tags: { operator: CONTAINS_ALL, value: $v }, AND: [{ conditions: [{ field: "lines.sku", operator: CONTAINS_ALL, value: $v }] }]) { key } '
        + 'b: qlItems(tags: { operator: CONTAINS_ALL, value: $v }) { key } }',
      { middleware: on((args) => { if (args.AND) args.tags.value.push('B'); }) },
      variables,
    );
    ok(result);
    expect(variables).toEqual({ v: ['A'] });
    expect(keysOf(result.data.a)).toEqual(['I1', 'I3']);
    expect(keysOf(result.data.b)).toEqual(['I1', 'I2', 'I3', 'I6']);
    const [first, second] = [calls.find(({ args }) => args.AND), calls.find(({ args }) => !args.AND)];
    expect(first.args.tags.value).toEqual(['A', 'B']);
    expect(first.args.AND[0].conditions[0].value).toEqual(['A']);
    expect(second.args.tags.value).toEqual(['A']);
  });
});

// Optimistic concurrency reports a stale or exhausted version early only to a caller who can read the record through
// the protected type's get_by_id scope (reportEarlyConflict), and that visibility check runs the scope, the get_by_id
// gate (site A) and adapter.find as a by-ID read does (tests/optimistic-concurrency-visibility.test.js). A scope that
// writes CONTAINS_ALL or IIN in a form the compilers ignore therefore reaches site A there too (spec 7.1 item 4,
// maintainer answer 3).
describe('the visibility check of optimistic concurrency', () => {
  // The operators of 3.7.0, which an adapter that declares no queryFeatures supports.
  const LEGACY_3_7_0 = ['EQ', 'NE', 'LT', 'LTE', 'GT', 'GTE', 'BTW', 'IN', 'NIN', 'LIKE'];
  const STORED = {
    _id: '1', tenant: 'A', name: 'a', version: 5,
  };
  // The get_by_id scope's filter: an EQ field filter, the only operator the optimistic memory adapter's find
  // compiles, with `operator` in the terms of the scalar tenant, a form the compilers ignore.
  const tenantFilter = (operator) => ({ operator: 'EQ', value: 'A', terms: [{ path: 'x', operator, value: ['a'] }] });
  // A protected Producto whose get_by_id scope writes that filter, with Producto 1 of tenant A stored at version 5,
  // on the optimistic memory adapter with `queryFeatures` when given and without the property otherwise.
  const buildProtected = (operator, queryFeatures) => {
    const adapter = createOptimisticMemoryAdapter();
    if (queryFeatures) adapter.queryFeatures = queryFeatures;
    const runtime = createRuntime(adapter);
    const Producto = new GraphQLObjectType({
      name: 'Producto',
      extensions: {
        concurrency: { mode: 'optimistic' },
        scope: { get_by_id: ({ args }) => { args.tenant = tenantFilter(operator); } },
      },
      fields: { id: { type: GraphQLID }, tenant: { type: GraphQLString }, name: { type: GraphQLString } },
    });
    runtime.connect(null, Producto, 'producto', 'productos');
    adapter.seed('Producto', STORED);
    const schema = runtime.createSchema();
    return { adapter, run: (source) => graphql({ schema, source, contextValue: {} }) };
  };
  // [the operator the scope writes, the operation, a stale version 4 against the stored 5]
  const STALE = ['IIN', 'CONTAINS_ALL'].flatMap((operator) => [
    [operator, 'update', 'mutation { updateproducto(input: { id: "1", version: 4, name: "Z" }) { id version } }'],
    [operator, 'delete', 'mutation { deleteproducto(id: "1", version: 4) { id } }'],
  ]);
  // A mutation's outcome in one value, so that a failed assertion shows the error, the number of errors, the finds
  // and the writes together.
  const outcome = (adapter, result) => ({
    failure: failure(result),
    errors: result.errors?.length ?? 0,
    finds: adapter.find.mock.calls.length,
    writes: [...adapter.update.mock.calls, ...adapter.delete.mock.calls].length,
  });

  // On 7f12322 the runtime skipped the two names, which it did not know: the scope's filter reached adapter.find,
  // which compiled the EQ and found the record, and the caller got VERSION_CONFLICT (409). The get_by_id gate of
  // findVisibleById now reports the form with site A's 400 before adapter.find, and a matching version, which runs no
  // visibility check, updates as before.
  it.each(STALE)('gives a get_by_id scope\'s %s in the terms of tenant, which is not an object, site A\'s message in the visibility check of a stale %s on an adapter without queryFeatures, with no find and no write', async (operator, _operation, source) => {
    const { adapter, run } = buildProtected(operator);
    expect(outcome(adapter, await run(source))).toEqual({
      failure: unsupported('A', operator, 'tenant.x', 'Producto'), errors: 1, finds: 0, writes: 0,
    });
    expect(adapter.stored('Producto', '1')).toEqual(STORED);
    const current = await run('mutation { updateproducto(input: { id: "1", version: 5, name: "Z" }) { id version } }');
    ok(current);
    expect(current.data.updateproducto).toEqual({ id: '1', version: 6 });
    expect(adapter.find).not.toHaveBeenCalled();
    expect(adapter.stored('Producto', '1')).toMatchObject({ name: 'Z', version: 6 });
  });

  it.each(STALE)('guard: a get_by_id scope\'s %s in the terms of tenant keeps the VERSION_CONFLICT of a stale %s, after one find that receives it, on an adapter that declares the 3.7.0 names, CONTAINS_ALL and IIN', async (operator, _operation, source) => {
    const { adapter, run } = buildProtected(operator, { operators: [...LEGACY_3_7_0, 'CONTAINS_ALL', 'IIN'] });
    expect(outcome(adapter, await run(source))).toEqual({
      failure: { code: 'VERSION_CONFLICT', status: 409, message: 'Producto 1 was modified by another operation' }, errors: 1, finds: 1, writes: 0,
    });
    expect(adapter.find.mock.calls[0][2]).toEqual({ id: { operator: 'EQ', value: '1' }, tenant: tenantFilter(operator) });
    expect(adapter.stored('Producto', '1')).toEqual(STORED);
  });
});

// A spread copy of a bundled adapter keeps the bundled queryFeatures, an own property, so it receives CONTAINS_ALL and
// IIN on upgrade (spec 7.5). The copy's find, count and aggregate record a copy of their arguments and answer with no
// rows instead of calling the bundled adapter: this file has no database, and a forwarded read would wait for
// Mongoose's buffering timeout (the recording copy of tests/integration/reference-emptiness-parity.test.js forwards,
// with a database).
describe('copies of the bundled adapters', () => {
  // Mongoose keeps one model per name, so the copy's runtime is built once, on first use.
  let built;
  const buildCopy = async () => {
    const { createMongoAdapter } = await import('../packages/mongodb/src/index.js');
    const reads = [];
    const record = (method, answer) => async (_model, gqltype, args) => {
      reads.push({ method, type: gqltype.name, args: structuredClone(args) });
      return answer;
    };
    const copy = {
      ...createMongoAdapter(), find: record('find', []), count: record('count', 0), aggregate: record('aggregate', []),
    };
    const runtime = createRuntime(copy);
    runtime.preventCreatingCollection(true);
    registerListOperatorTypes(runtime, createListOperatorTypes(null, { backend: 'mongodb' }));
    const schema = runtime.createSchema();
    return { reads, run: (source) => graphql({ schema, source, contextValue: {} }) };
  };
  const copyOf = () => {
    built ??= buildCopy();
    return built;
  };

  // [surface, source, the reads it makes, the CONTAINS_ALL and IIN values that each read receives]
  const SOURCES = [
    ['field filters', '{ qlmItems(tags: { operator: CONTAINS_ALL, value: ["B", "A", "A"] }, name: { operator: IIN, value: ["ONE", "two", "one"] }) { key } }', ['find'], [[['B', 'A', 'A']], [['ONE', 'two', 'one']]]],
    ['group conditions with a count', '{ qlmItems(AND: [{ conditions: [{ field: "lines.sku", operator: CONTAINS_ALL, value: ["B", "A"] }, { field: "shop.name", operator: IIN, value: ["ALPHA"] }] }], pagination: { page: 1, size: 10, count: true }) { key } }', ['count', 'find'], [[['B', 'A']], [['ALPHA']]]],
    ['an aggregate', `{ qlmItems_aggregate(box: { terms: [{ path: "tags", operator: CONTAINS_ALL, value: ["q", "p", "p"] }] }, OR: [{ conditions: [{ field: "name", operator: IIN, value: [] }] }], ${aggregation}) { groupId } }`, ['aggregate'], [[['q', 'p', 'p']], [[]]]],
  ];

  it.each(SOURCES)('a spread copy of createMongoAdapter() receives a client\'s CONTAINS_ALL and IIN in %s, with the values as sent', async (_surface, source, methods, values) => {
    const { reads, run } = await copyOf();
    const first = reads.length;
    ok(await run(source));
    const received = reads.slice(first);
    expect(received.map(({ method }) => method).sort()).toEqual(methods);
    for (const { type, args } of received) {
      expect(type).toBe('QlmItem');
      expect([sentValues(args, 'CONTAINS_ALL'), sentValues(args, 'IIN')]).toEqual(values);
    }
  });
});
