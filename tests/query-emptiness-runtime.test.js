import { describe, expect, it } from 'vitest';
import {
  GraphQLID, GraphQLInt, GraphQLInterfaceType, GraphQLList, GraphQLObjectType, GraphQLString, GraphQLUnionType, graphql,
} from 'graphql';

import {
  QLOperator, createQueryPlan, createRuntime, describeModels,
} from '../packages/core/src/index.js';
import * as auth from '../packages/core/src/auth/index.js';
import { generateMCPTools } from '../packages/mcp/src/index.js';
import { createEmptinessTypes, emptinessQuery, registerEmptinessTypes } from './helpers/query-emptiness.js';

// #108 part 2a: the runtime half of the emptiness operators IS_EMPTY and IS_NOT_EMPTY. The gate checks every
// emptiness condition before middleware and again before the adapter call, with the codes a direct createQueryPlan
// call gives; a target find scope that uses them is not applied below a client's relation path; and the stored
// members an object-level condition reads are authorized like named paths. Database-free: the adapters plan every
// read with createQueryPlan, as the SQL adapter does, or only record what they receive. The core rules are in
// query-emptiness.test.js, and each backend's forms with that backend.

const OPERATORS = QLOperator.getValues().map((entry) => entry.value);
const LEGACY = ['EQ', 'NE', 'LT', 'LTE', 'GT', 'GTE', 'BTW', 'IN', 'NIN', 'LIKE'];
const LATER = 'emptiness through references and collections arrives with reference emptiness (#108)';
const embedded = { relation: { embedded: true } };
const reference = (connectionField) => ({ relation: { embedded: false, ...(connectionField ? { connectionField } : {}) } });

const codeOf = (body) => {
  try {
    body();
  } catch (error) {
    return error.extensions?.code ?? error.message;
  }
  return null;
};
const failures = (result) => (result.errors ?? []).map((error) => ({
  code: error.extensions?.code, status: error.extensions?.status, message: error.message,
}));
const failure = (result) => failures(result)[0] ?? null;
// A group condition `depth` AND levels below the groups listed in args.AND, which are at depth 0.
const nested = (condition, depth) => {
  let group = { conditions: [condition] };
  for (let level = 0; level < depth; level += 1) group = { AND: [group] };
  return { AND: [group] };
};
const predicatesOf = (node) => {
  if (!node) return [];
  return node.kind === 'predicate' ? [node] : node.terms.flatMap(predicatesOf);
};
const predicate = (path, operator, value = null) => ({ kind: 'predicate', path: path.split('.'), operator, value });

// A database-free adapter. With `plan`, each read is recorded and then planned with createQueryPlan over
// describeModels, with the declared operators as the compiler's, so the compiler answers what the gate lets
// through; without it, reads are only recorded, so types that describeModels rejects (interfaces, self-embedding
// types) can be served. `batch` adds findChildrenBatch. Each call keeps its arguments and its plan.
const createAdapter = ({
  queryFeatures, plan, batch, calls, rows = {},
}) => {
  let described = null;
  const read = (method, Model, args, mode) => {
    calls.push({ method, type: Model.name, args: structuredClone(args) });
    if (plan) calls.at(-1).plan = createQueryPlan(described, Model.name, args, { mode, operators: queryFeatures?.operators ?? LEGACY });
    return mode === 'aggregate' ? [] : rows[Model.name] ?? [];
  };
  return {
    ...(queryFeatures === undefined ? {} : { queryFeatures }),
    bind() {},
    prepare(registrations) { if (plan) described = describeModels(registrations); },
    models: () => described,
    createModel: (gqltype) => ({ name: gqltype.name }),
    castId: String,
    withTransaction: async (session, body) => body(session || {}),
    async getById(Model, id) { return { _id: id, id }; },
    async find(Model, gqltype, args) { return read('find', Model, args, 'find'); },
    async count(Model, gqltype, args) { read('count', Model, args, 'count'); return 0; },
    async aggregate(Model, gqltype, args) { return read('aggregate', Model, args, 'aggregate'); },
    async findChildren(Model, gqltype, connectionField, parentId, args) { return read('findChildren', Model, args, 'find'); },
    ...(batch ? {
      async findChildrenBatch(Model, gqltype, connectionField, parentIds, args) {
        read('findChildrenBatch', Model, args, 'find');
        return parentIds.map(() => []);
      },
    } : {}),
  };
};

// Middleware and scopes do what the request context asks: `context.middleware(params)`, and
// `context.scopes[name](args, context)` for the find scope of a type (`shop`, `review`, `item`) or Item's get_by_id
// and aggregate scopes (`item get_by_id`, `item aggregate`). `context.ran` lists, in order, every middleware and
// scope call.
const scopeOf = (name) => ({ args, context }) => {
  context?.ran?.push(`scope ${name}`);
  context?.scopes?.[name]?.(args, context);
};
const createTypes = () => {
  const Owner = new GraphQLObjectType({ name: 'QrOwner', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
  const Plain = new GraphQLObjectType({ name: 'QrPlain', fields: { a: { type: GraphQLInt }, b: { type: GraphQLString } } });
  const Hidden = new GraphQLObjectType({ name: 'QrHidden', fields: { w: { type: GraphQLInt }, secret: { type: GraphQLString, extensions: { queryable: false } } } });
  // An application resolver makes a field non-queryable unless it is marked queryable.
  const Masked = new GraphQLObjectType({ name: 'QrMasked', fields: { w: { type: GraphQLInt }, code: { type: GraphQLString, resolve: (parent) => parent.code } } });
  const Virt = new GraphQLObjectType({
    name: 'QrVirt',
    fields: { w: { type: GraphQLInt }, extra: { type: GraphQLString, resolve: () => 'x', extensions: { virtual: true } } },
  });
  const Deep = new GraphQLObjectType({ name: 'QrDeep', fields: { n: { type: GraphQLInt }, inner: { type: Hidden, extensions: embedded } } });
  const Line = new GraphQLObjectType({ name: 'QrLine', fields: { qty: { type: GraphQLInt }, sku: { type: GraphQLString } } });
  const ShopDims = new GraphQLObjectType({ name: 'QrShopDims', fields: { w: { type: GraphQLInt }, label: { type: GraphQLString } } });
  const ShopLine = new GraphQLObjectType({ name: 'QrShopLine', fields: { qty: { type: GraphQLInt } } });
  const Shop = new GraphQLObjectType({
    name: 'QrShop',
    extensions: { scope: { find: scopeOf('shop') } },
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      slug: { type: GraphQLString, resolve: () => 's', extensions: { virtual: true } },
      tags: { type: new GraphQLList(GraphQLString) },
      dims: { type: ShopDims, extensions: embedded },
      lines: { type: new GraphQLList(ShopLine), extensions: embedded },
      owner: { type: Owner, extensions: reference('owner') },
      items: { type: new GraphQLList(Item), extensions: reference('shop') },
    }),
  });
  // A reference member: queryable in ODim, not in HODim.
  const ODim = new GraphQLObjectType({ name: 'QrODim', fields: () => ({ w: { type: GraphQLInt }, shop: { type: Shop, extensions: reference() } }) });
  const HODim = new GraphQLObjectType({
    name: 'QrHODim',
    fields: () => ({ w: { type: GraphQLInt }, shop: { type: Shop, extensions: { ...reference(), queryable: false } } }),
  });
  const Review = new GraphQLObjectType({
    name: 'QrReview',
    extensions: { scope: { find: scopeOf('review') } },
    fields: () => ({
      id: { type: GraphQLID }, text: { type: GraphQLString }, deletedAt: { type: GraphQLString }, item: { type: Item, extensions: reference('item') },
    }),
  });
  const Item = new GraphQLObjectType({
    name: 'QrItem',
    extensions: { scope: { find: scopeOf('item'), get_by_id: scopeOf('item get_by_id'), aggregate: scopeOf('item aggregate') } },
    fields: () => ({
      id: { type: GraphQLID },
      note: { type: GraphQLString },
      tags: { type: new GraphQLList(GraphQLString) },
      plain: { type: Plain, extensions: embedded },
      hidden: { type: Hidden, extensions: embedded },
      masked: { type: Masked, extensions: embedded },
      virt: { type: Virt, extensions: embedded },
      deep: { type: Deep, extensions: embedded },
      odim: { type: ODim, extensions: embedded },
      hodim: { type: HODim, extensions: embedded },
      lines: { type: new GraphQLList(Line), extensions: embedded },
      shop: { type: Shop, extensions: reference('shop') },
      reviews: { type: new GraphQLList(Review), extensions: reference('item') },
    }),
  });
  return {
    Owner, Shop, Review, Item, embedded: [Plain, Hidden, Masked, Virt, Deep, Line, ShopDims, ShopLine, ODim, HODim],
  };
};

const SHOPS = { QrShop: [{ _id: 's1', id: 's1', name: 'a' }, { _id: 's2', id: 's2', name: 'b' }] };

// `queryFeatures` defaults to every operator; pass it as undefined for an adapter that declares none.
const featuresOf = (options) => (Object.hasOwn(options, 'queryFeatures') ? options.queryFeatures : { operators: OPERATORS });

const build = (options = {}) => {
  const {
    plan = true, batch = false, permissions, defaultPolicy = 'DENY',
  } = options;
  const queryFeatures = featuresOf(options);
  const calls = [];
  const adapter = createAdapter({
    queryFeatures, plan, batch, calls, rows: SHOPS,
  });
  const runtime = createRuntime(adapter);
  const types = createTypes();
  runtime.use(async (params, next) => {
    params.context?.ran?.push(`middleware ${params.type.gqltype.name} ${params.operation}`);
    await params.context?.middleware?.(params);
    await next();
  });
  for (const type of types.embedded) runtime.addNoEndpointType(type);
  runtime.connect(null, types.Owner, 'qrOwner', 'qrOwners');
  runtime.connect(null, types.Shop, 'qrShop', 'qrShops');
  runtime.connect(null, types.Review, 'qrReview', 'qrReviews');
  runtime.connect(null, types.Item, 'qrItem', 'qrItems');
  const schema = runtime.createSchema();
  if (permissions) auth.createAuthPlugin(permissions, { defaultPolicy }).onSchemaChange({ schema });
  const run = (source, context = {}, variables = undefined) => graphql({
    schema, source, variableValues: variables, contextValue: { user: { role: 'viewer' }, ...context },
  });
  return {
    schema, calls, run, adapter,
  };
};

// The members' 403 come from inspectClientPaths with FORBIDDEN_FILTER_PATH and the full member path.
const nonQueryable = (path, owner) => ({ code: 'FORBIDDEN_FILTER_PATH', status: 403, message: `Query path ${path} uses the non-queryable field ${owner}` });
const unsupported = (message) => ({ code: 'UNSUPPORTED_QUERY', status: 400, message: `${message}: ${LATER}` });
const decision3 = (path, operator = 'IS_EMPTY') => ({
  code: 'UNSUPPORTED_QUERY',
  status: 400,
  message: `Query path shop enters QrShop, whose find scope tests ${path} with ${operator}: ${LATER}; until then, use EQ null in the QrShop find scope`,
});

describe('the gate around middleware', () => {
  it('gives a client\'s path-less condition on a scoped collection 400 for an admin and a restricted caller alike, and never runs the scope', async () => {
    const { run, calls } = build();
    for (const restricted of [false, true]) {
      const context = {
        ran: [],
        scopes: { review: (args) => { if (restricted) args.deletedAt = { operator: 'EQ', value: null }; } },
      };
      for (const operator of ['IS_EMPTY', 'IS_NOT_EMPTY']) {
        const result = await run(`{ qrItems(reviews: {terms: [{operator: ${operator}}]}) { id } }`, context);
        expect(failure(result), `${restricted} ${operator}`).toEqual(unsupported(`${operator} on reviews ends at the collection reviews`));
      }
      // Nothing ran: no middleware, and neither Review's nor Item's find scope.
      expect(context.ran).toEqual([]);
    }
    // A legacy path into the same collection keeps today's answers: 403 for the restricted caller only.
    const restricted = await run('{ qrItems(reviews: {terms: [{path: "text", value: "x"}]}) { id } }', {
      scopes: { review: (args) => { args.deletedAt = { operator: 'EQ', value: null }; } },
    });
    expect(failure(restricted)).toEqual({ code: 'FORBIDDEN_FILTER_PATH', status: 403, message: 'Query path reviews enters the scoped collection QrItem.reviews' });
    expect(calls).toEqual([]);
    expect(failure(await run('{ qrItems(reviews: {terms: [{path: "text", value: "x"}]}) { id } }'))).toBeNull();
  });

  it('gives the same condition on an aggregate or a collection field, batched or not, 400 for every caller, and never runs QrItem\'s middleware or scopes', async () => {
    const aggregation = 'aggregation: {groupId: "note", facts: [{operation: COUNT, factName: "n", path: "id"}]}';
    for (const batch of [false, true]) {
      const { run, calls } = build({ batch });
      for (const restricted of [false, true]) {
        const scopes = { review: (args) => { if (restricted) args.deletedAt = { operator: 'EQ', value: null }; } };
        for (const [source, operator, count, ran] of [
          [`{ qrItems_aggregate(reviews: {terms: [{operator: IS_EMPTY}]}, ${aggregation}) { groupId } }`, 'IS_EMPTY', 1, []],
          // Only the shops list runs; the items field fails once per shop.
          ['{ qrShops { items(reviews: {terms: [{operator: IS_NOT_EMPTY}]}) { id } } }', 'IS_NOT_EMPTY', 2, ['middleware QrShop find', 'scope shop']],
        ]) {
          const context = { ran: [], scopes };
          const label = `batch ${batch}, restricted ${restricted}: ${source}`;
          expect(failures(await run(source, context)), label).toEqual(Array(count).fill(unsupported(`${operator} on reviews ends at the collection reviews`)));
          expect(context.ran, label).toEqual(ran);
        }
      }
      expect(calls.filter((call) => call.type !== 'QrShop')).toEqual([]);
    }
  });

  it('rejects a reference crossing that middleware or a scope adds to an aggregate or a collection field, before the adapter runs', async () => {
    const aggregation = 'aggregation: {groupId: "note", facts: [{operation: COUNT, factName: "n", path: "id"}]}';
    // QrShop's middleware call adds nothing, so the shops list is served.
    const onItem = (body) => (params) => { if (params.type.gqltype.name === 'QrItem') body(params); };
    for (const batch of [false, true]) {
      const { run, calls } = build({ batch });
      for (const [source, scope, count] of [
        [`{ qrItems_aggregate(${aggregation}) { groupId } }`, 'item aggregate', 1],
        ['{ qrShops { items { id } } }', 'item', 2],
      ]) {
        const label = `batch ${batch}: ${source}`;
        const middleware = await run(source, { middleware: onItem(({ args }) => { args.shop = { terms: [{ path: 'name', operator: 'IS_EMPTY' }] }; }) });
        expect(failures(middleware), label).toEqual(Array(count).fill(unsupported('IS_EMPTY on shop.name crosses the reference shop')));
        const scoped = await run(source, {
          scopes: { [scope]: (args) => { args.AND = [...(args.AND ?? []), { conditions: [{ field: 'shop', path: 'dims', operator: 'IS_NOT_EMPTY' }] }]; } },
        });
        expect(failures(scoped), label).toEqual(Array(count).fill(unsupported('IS_NOT_EMPTY on shop.dims crosses the reference shop')));
      }
      // Only the two shops lists reached the adapter, which records each call before planning it.
      expect(calls.map(({ method, type }) => `${method}:${type}`)).toEqual(['find:QrShop', 'find:QrShop']);
    }
  });

  it('rejects a reference crossing that middleware or a scope adds with UNSUPPORTED_QUERY, before the adapter runs', async () => {
    const { run, calls } = build();
    const middleware = await run('{ qrItems { id } }', {
      middleware: ({ args }) => { args.shop = { terms: [{ path: 'name', operator: 'IS_EMPTY' }] }; },
    });
    expect(failure(middleware)).toEqual(unsupported('IS_EMPTY on shop.name crosses the reference shop'));
    const scope = await run('{ qrItems { id } }', {
      scopes: { item: (args) => { args.AND = [...(args.AND ?? []), { conditions: [{ field: 'shop', path: 'dims', operator: 'IS_NOT_EMPTY' }] }]; } },
    });
    expect(failure(scope)).toEqual(unsupported('IS_NOT_EMPTY on shop.dims crosses the reference shop'));
    const member = await run('{ qrItems { id } }', { middleware: ({ args }) => { args.odim = { terms: [{ operator: 'IS_EMPTY' }] }; } });
    expect(failure(member)).toEqual(unsupported('IS_EMPTY on odim reads the reference member odim.shop'));
    expect(calls).toEqual([]);
    // A condition on the record's own fields that middleware or a scope adds reaches the adapter.
    const own = await run('{ qrItems { id } }', {
      middleware: ({ args }) => { args.note = { operator: 'IS_EMPTY' }; },
      scopes: { item: (args) => { args.AND = [{ conditions: [{ field: 'plain', operator: 'IS_NOT_EMPTY' }] }]; } },
    });
    expect(own.errors).toBeUndefined();
    expect(predicatesOf(calls[0].plan.where)).toEqual([predicate('note', 'IS_EMPTY'), predicate('plain', 'IS_NOT_EMPTY')]);
  });

  it('checks lists, counts, aggregates, collection fields batched or not, and get_by_id scopes, whatever the adapter declares', async () => {
    const aggregation = 'aggregation: {groupId: "note", facts: [{operation: COUNT, factName: "n", path: "id"}]}';
    for (const batch of [false, true]) {
      const { run, calls } = build({ batch });
      const cases = [
        ['{ qrItems(odim: {terms: [{operator: IS_EMPTY}]}, pagination: {page: 1, size: 5, count: true}) { id } }', 'IS_EMPTY on odim reads the reference member odim.shop'],
        [`{ qrItems_aggregate(shop: {terms: [{path: "name", operator: IS_NOT_EMPTY}]}, ${aggregation}) { groupId } }`, 'IS_NOT_EMPTY on shop.name crosses the reference shop'],
        ['{ qrShops { items(odim: {terms: [{operator: IS_EMPTY}]}) { id } } }', 'IS_EMPTY on odim reads the reference member odim.shop'],
      ];
      for (const [source, message] of cases) {
        const result = await run(source);
        expect(failure(result), source).toEqual(unsupported(message));
      }
      const listItem = await run('{ qrShops { items(reviews: {terms: [{path: "text", operator: IS_EMPTY}]}) { id } } }');
      expect(listItem.errors.map((error) => error.extensions.code)).toEqual(['INVALID_FILTER_PATH', 'INVALID_FILTER_PATH']);
      expect(listItem.errors[0].message).toBe('IS_EMPTY cannot test reviews.text: emptiness of a value inside a list is not defined, and reviews is a collection');
      const byId = await run('{ qrItem(id: "i1") { id } }', {
        scopes: { 'item get_by_id': (args) => { args.shop = { terms: [{ path: 'name', operator: 'IS_EMPTY' }] }; } },
      });
      expect(failure(byId)).toEqual(unsupported('IS_EMPTY on shop.name crosses the reference shop'));
      expect(calls.filter((call) => call.type !== 'QrShop')).toEqual([]);

      calls.length = 0;
      const accepted = [
        '{ qrItems(note: {operator: IS_EMPTY}, pagination: {page: 1, size: 5, count: true}) { id } }',
        `{ qrItems_aggregate(plain: {terms: [{operator: IS_NOT_EMPTY}]}, ${aggregation}) { groupId } }`,
        '{ qrShops { items(tags: {operator: IS_EMPTY}) { id } } }',
      ];
      for (const source of accepted) expect((await run(source)).errors, source).toBeUndefined();
      const byIdScope = await run('{ qrItem(id: "i1") { id } }', { scopes: { 'item get_by_id': (args) => { args.note = { operator: 'IS_NOT_EMPTY' }; } } });
      expect(byIdScope.errors).toBeUndefined();
      expect(calls.filter((call) => call.type === 'QrItem').map(({ method, plan }) => [method, predicatesOf(plan.where)])).toEqual([
        ['find', [predicate('note', 'IS_EMPTY')]], ['count', [predicate('note', 'IS_EMPTY')]],
        ['aggregate', [predicate('plain', 'IS_NOT_EMPTY')]],
        ...(batch ? [['findChildrenBatch', [predicate('tags', 'IS_EMPTY')]]] : [['findChildren', [predicate('tags', 'IS_EMPTY')]], ['findChildren', [predicate('tags', 'IS_EMPTY')]]]),
        ['find', [predicate('id', 'EQ', 'i1'), predicate('note', 'IS_NOT_EMPTY')]],
      ]);
    }
  });

  it('rejects the operators with UNSUPPORTED_QUERY for an adapter that does not declare them, after the form and the path', async () => {
    const { run, calls } = build({ queryFeatures: undefined });
    expect(failure(await run('{ qrItems(note: {operator: IS_EMPTY}) { id } }'))).toEqual({
      code: 'UNSUPPORTED_QUERY', status: 400, message: 'The database adapter does not support the IS_EMPTY filter operator, used on QrItem.note',
    });
    expect(failure(await run('{ qrItems(lines: {terms: [{path: "qty", operator: IS_NOT_EMPTY}]}) { id } }')).message)
      .toBe('The database adapter does not support the IS_NOT_EMPTY filter operator, used on QrItem.lines.qty');
    expect(failure(await run('{ qrItems(shop: {terms: [{path: "nope", operator: IS_EMPTY}]}) { id } }'))).toEqual({
      code: 'INVALID_FILTER_FIELD', status: 400, message: 'Unknown field shop.nope',
    });
    expect(failure(await run('{ qrItems { id } }', { middleware: ({ args }) => { args.plain = { operator: 'IS_EMPTY' }; } })).code).toBe('MISSING_FILTER_PATH');
    expect(calls).toEqual([]);
    // Other operators keep today's gate.
    expect((await run('{ qrItems(note: {operator: LIKE, value: "a"}) { id } }')).errors).toBeUndefined();
    expect(failure(await run('{ qrItems(note: {operator: ILIKE, value: "a"}) { id } }')).code).toBe('UNSUPPORTED_QUERY');
  });
});

describe('the runtime gate and createQueryPlan', () => {
  // The shared fixture, served by an adapter that plans every read and records each call before planning it, so a
  // rejection with no call is the gate's own.
  const setup = (queryFeatures) => {
    const calls = [];
    const adapter = createAdapter({ queryFeatures, plan: true, calls });
    const runtime = createRuntime(adapter);
    const types = createEmptinessTypes('Qg', { backend: 'postgres' });
    runtime.use(async (params, next) => {
      await params.context?.middleware?.(params);
      await next();
    });
    registerEmptinessTypes(runtime, types);
    const schema = runtime.createSchema();
    // A client sends `input` as the list query's arguments; trusted code writes it in middleware.
    const send = async (input, { trusted = false } = {}) => {
      calls.length = 0;
      const { source, variables } = trusted ? { source: '{ qgItems { id } }', variables: undefined } : emptinessQuery(types, 'item', input, 'id');
      const middleware = trusted ? ({ args }) => { Object.assign(args, input); } : undefined;
      const result = await graphql({ schema, source, variableValues: variables, contextValue: { middleware } });
      return { error: failure(result), calls: calls.length };
    };
    return { send, models: adapter.models() };
  };
  const IS = { operator: 'IS_EMPTY' };
  const condition = (field, path, extra = {}) => ({ AND: [{ conditions: [{ field, ...(path === undefined ? {} : { path }), ...IS, ...extra }] }] });
  // [input, code, trusted]: every form and rule of the order of checks that a client or trusted code can write.
  // Accepted: terms without a path (omitted, null or ""), also next to terms with paths.
  const ACCEPTED = [
    [{ dims: { terms: [IS] } }, null], [{ dims: { terms: [{ path: '', operator: 'IS_NOT_EMPTY' }] } }, null],
    [{ dims: { terms: [{ path: null, ...IS }, { path: 'w', operator: 'EQ', value: 1 }] } }, null],
    [{ lines: { terms: [{ operator: 'IS_NOT_EMPTY', value: null }] } }, null], [{ tags: IS }, null], [condition('outer'), null],
    [condition('outer.inner.z'), null], [condition('plain', ''), null], [condition('ghost'), null],
  ];
  // Rule 1: form, syntax, fields and depth.
  const RULE_1 = [
    [{ dims: IS }, 'MISSING_FILTER_PATH', true], [{ shop: IS }, 'MISSING_FILTER_PATH', true], [{ reviews: IS }, 'MISSING_FILTER_PATH', true],
    [{ odim: IS }, 'MISSING_FILTER_PATH', true], [{ lines: { ...IS, value: null } }, 'MISSING_FILTER_PATH', true],
    [{ dims: { ...IS, terms: [{ path: 'w', value: 1 }] } }, 'MISSING_FILTER_PATH', true],
    [{ shop: { operator: 'IS_NOT_EMPTY', terms: [{ path: 'name', value: 'a' }] } }, 'MISSING_FILTER_PATH', true],
    [{ reviews: { ...IS, terms: [{ path: 'text', value: 'a' }] } }, 'MISSING_FILTER_PATH', true],
    [{ dims: { ...IS, value: 1 } }, 'MISSING_FILTER_PATH', true],
    [condition('shop.name', 'x'), 'AMBIGUOUS_FILTER_FIELD'], [condition('outer.inner', 'z'), 'AMBIGUOUS_FILTER_FIELD'],
    [{ shop: { terms: [{ path: 'nope', ...IS }] } }, 'INVALID_FILTER_FIELD'], [{ nope: IS }, 'INVALID_FILTER_FIELD', true],
    [{ shop: { terms: [{ path: 'name.x', ...IS }] } }, 'INVALID_FILTER_PATH'], [condition('note', 'x'), 'INVALID_FILTER_PATH'],
    [{ dims: { terms: [{ path: 'w-x', ...IS }] } }, 'INVALID_FILTER_PATH'], [{ dims: { terms: [{ path: 5, ...IS }] } }, 'INVALID_FILTER_PATH', true],
    [nested({ field: 'shop', path: 'name', ...IS }, 6), 'FILTER_DEPTH_EXCEEDED'], [nested({ field: 'lines', path: 'qty', ...IS }, 6), 'FILTER_DEPTH_EXCEEDED'],
  ];
  // Rules 3 to 6, which come after the adapter's operators (rule 2).
  const LATER_RULES = [
    [nested({ field: 'shop', path: 'name', ...IS }, 5), 'UNSUPPORTED_QUERY'],
    // Rule 3: values inside lists and collections, before any reference.
    [{ lines: { terms: [{ path: 'qty', ...IS }] } }, 'INVALID_FILTER_PATH'], [condition('reviews', 'text'), 'INVALID_FILTER_PATH'],
    [condition('shop', 'items.note'), 'INVALID_FILTER_PATH'], [{ olines: { terms: [{ path: 'shop', ...IS, value: 'x' }] } }, 'INVALID_FILTER_PATH'],
    // Rule 5: the value, before rule 6.
    [{ note: { ...IS, value: 'x' } }, 'INVALID_FILTER_VALUE'], [{ odim: { terms: [{ ...IS, value: 'x' }] } }, 'INVALID_FILTER_VALUE'],
    [condition('shop', undefined, { value: '' }), 'INVALID_FILTER_VALUE'], [{ tags: { ...IS, value: [] } }, 'INVALID_FILTER_VALUE'],
    [{ dims: { terms: [{ ...IS, value: false }] } }, 'INVALID_FILTER_VALUE'], [{ plain: { terms: [{ path: 'a', ...IS, value: 0 }] } }, 'INVALID_FILTER_VALUE'],
    // Rule 6: references and collections, crossed, reached, or members.
    [{ shop: { terms: [IS] } }, 'UNSUPPORTED_QUERY'], [condition('shop'), 'UNSUPPORTED_QUERY'], [condition('shop', 'name'), 'UNSUPPORTED_QUERY'],
    [{ reviews: { terms: [IS] } }, 'UNSUPPORTED_QUERY'], [{ odim: { terms: [IS] } }, 'UNSUPPORTED_QUERY'],
    [{ odim: { terms: [{ path: 'shop', ...IS }] } }, 'UNSUPPORTED_QUERY'], [condition('shop', 'items'), 'UNSUPPORTED_QUERY'],
    [condition('odim', 'shop.name'), 'UNSUPPORTED_QUERY'],
  ];
  const TABLE = [...ACCEPTED, ...RULE_1, ...LATER_RULES];

  it('gives every row the code of a direct createQueryPlan call, before the adapter runs, whoever writes it', async () => {
    const { send, models } = setup({ operators: OPERATORS });
    for (const [input, code, trusted = false] of TABLE) {
      const label = `${trusted ? 'trusted' : 'client'} ${JSON.stringify(input)}`;
      const { error, calls } = await send(input, { trusted });
      const direct = codeOf(() => createQueryPlan(models, 'QgItem', input));
      expect(direct, label).toBe(code);
      expect(error?.code ?? null, label).toBe(code);
      expect(calls, label).toBe(code ? 0 : 1);
      // Client-writable rows give the same code when trusted code writes them.
      if (!trusted) expect((await send(input, { trusted: true })).error?.code ?? null, label).toBe(code);
    }
  });

  it('gives an adapter that does not declare the operators the rule-1 codes first, then UNSUPPORTED_QUERY', async () => {
    const { send, models } = setup(undefined);
    for (const [input, code, trusted = false] of TABLE) {
      const label = `${trusted ? 'trusted' : 'client'} ${JSON.stringify(input)}`;
      const expected = RULE_1.some(([row]) => row === input) ? code : 'UNSUPPORTED_QUERY';
      expect(codeOf(() => createQueryPlan(models, 'QgItem', input, { operators: LEGACY })), label).toBe(expected);
      const { error, calls } = await send(input, { trusted });
      expect(error?.code, label).toBe(expected);
      expect(calls, label).toBe(0);
    }
  });

  it('gives a group condition without a string field createQueryPlan\'s rule-1 error when the adapter does not declare the operator, and leaves it to a declaring adapter\'s compiler', async () => {
    const undeclared = setup(undefined);
    const declared = setup({ operators: OPERATORS });
    const invalidPath = { code: 'INVALID_FILTER_PATH', status: 400, message: 'Invalid filter path' };
    // Only trusted code can write these, since GraphQL's condition field is a non-null String.
    for (const input of [condition(123), condition(null), { AND: [{ conditions: [IS] }] }]) {
      const label = JSON.stringify(input);
      expect(codeOf(() => createQueryPlan(undeclared.models, 'QgItem', input, { operators: LEGACY })), label).toBe('INVALID_FILTER_PATH');
      expect(await undeclared.send(input, { trusted: true }), label).toEqual({ error: invalidPath, calls: 0 });
      // Here the compiler is createQueryPlan; MongoDB's buildQuery rejects the condition with its own code.
      expect(await declared.send(input, { trusted: true }), label).toEqual({ error: invalidPath, calls: 1 });
    }
  });

  it('gives the messages of createQueryPlan for the form and the path, and describeEmptiness\'s for the other rules', async () => {
    const { send, models } = setup({ operators: OPERATORS });
    for (const [input, , trusted = false] of TABLE.filter(([, code]) => code)) {
      let message;
      try {
        createQueryPlan(models, 'QgItem', input);
      } catch (error) {
        message = error.message;
      }
      // createQueryPlan names a term without a string path its own way; the code is the same.
      if (JSON.stringify(input).includes('"path":5')) continue;
      expect((await send(input, { trusted })).error.message, JSON.stringify(input)).toBe(message);
    }
  });

  it('per caller, rejects a virtual path with 403 for a client and INVALID_MODEL for trusted code, as createQueryPlan rejects an unknown field', async () => {
    const { send, models } = setup({ operators: OPERATORS });
    for (const input of [{ ghost: { terms: [{ path: 'label', ...IS }] } }, condition('ghost', 'label')]) {
      expect((await send(input)).error, JSON.stringify(input)).toEqual({
        code: 'FORBIDDEN_FILTER_PATH', status: 403, message: 'Query path ghost.label uses the virtual field QgGhost.label, which is not stored',
      });
      expect((await send(input, { trusted: true })).error, JSON.stringify(input)).toEqual({
        code: 'INVALID_MODEL',
        status: 500,
        message: 'Query path ghost.label, added by middleware or a scope, uses the virtual field QgGhost.label, which is not stored',
      });
      expect(codeOf(() => createQueryPlan(models, 'QgItem', input))).toBe('INVALID_FILTER_FIELD');
    }
  });

  it('leaves a term of a scalar field to the compiler, which reads the filter\'s own operator (regression pin, passes on 3.9.0)', async () => {
    const { send, models } = setup({ operators: OPERATORS });
    const input = { note: { terms: [{ path: 'x', ...IS }] } };
    expect(await send(input, { trusted: true })).toEqual({
      error: { code: 'INVALID_FILTER_VALUE', status: 400, message: 'Expected a scalar filter value' }, calls: 1,
    });
    expect(codeOf(() => createQueryPlan(models, 'QgItem', input))).toBe('INVALID_FILTER_VALUE');
  });

  it('still applies rule 2 to a term of a scalar or enum field, so an adapter that does not declare the operator never receives it', async () => {
    const { send } = setup(undefined);
    // Only trusted code can write these. The gate leaves rules 3 to 6 to the compiler, but not the adapter's operators.
    for (const [input, operator, path] of [
      [{ note: { terms: [{ path: 'x', ...IS }] } }, 'IS_EMPTY', 'QgItem.note.x'],
      [{ note: { operator: 'EQ', value: 'x', terms: [{ path: 'x', ...IS }] } }, 'IS_EMPTY', 'QgItem.note.x'],
      [{ kind: { terms: [{ path: 'x', operator: 'IS_NOT_EMPTY' }] } }, 'IS_NOT_EMPTY', 'QgItem.kind.x'],
    ]) {
      expect(await send(input, { trusted: true }), JSON.stringify(input)).toEqual({
        error: { code: 'UNSUPPORTED_QUERY', status: 400, message: `The database adapter does not support the ${operator} filter operator, used on ${path}` },
        calls: 0,
      });
    }
  });

  it('takes the null rule for a record identity declared as String', async () => {
    const calls = [];
    const runtime = createRuntime(createAdapter({ queryFeatures: { operators: OPERATORS }, plan: true, calls }));
    const types = createEmptinessTypes('Qs', { backend: 'postgres' });
    registerEmptinessTypes(runtime, types);
    const schema = runtime.createSchema();
    for (const operator of ['IS_EMPTY', 'IS_NOT_EMPTY']) {
      const result = await graphql({ schema, source: `{ qsSids(id: {operator: ${operator}}) { id } }`, contextValue: {} });
      expect(result.errors, operator).toBeUndefined();
      expect(calls.at(-1).plan.where).toEqual(predicate('id', operator));
    }
  });
});

describe('joined scopes', () => {
  const legacy = '{ qrItems(shop: {terms: [{path: "name", value: "x"}]}) { id } }';
  const withShopScope = (scope) => ({ scopes: { shop: scope } });

  it('rejects a target scope that uses an emptiness operator, naming the scope and its prefixed condition', async () => {
    const { run, calls } = build();
    const result = await run(legacy, withShopScope((args) => { args.dims = { terms: [{ operator: 'IS_EMPTY' }] }; }));
    expect(failure(result)).toEqual(decision3('shop.dims'));
    expect(result.errors[0].message).not.toContain('undefined');
    for (const [scope, path, operator] of [
      [(args) => { args.dims = { terms: [{ path: '', operator: 'IS_NOT_EMPTY' }] }; }, 'shop.dims', 'IS_NOT_EMPTY'],
      [(args) => { args.dims = { terms: [{ path: null, operator: 'IS_EMPTY' }, { path: 'w', operator: 'EQ', value: 1 }] }; }, 'shop.dims'],
      [(args) => { args.name = { operator: 'IS_NOT_EMPTY' }; }, 'shop.name', 'IS_NOT_EMPTY'],
      [(args) => { args.AND = [{ conditions: [{ field: 'dims', path: 'w', operator: 'IS_EMPTY' }] }]; }, 'shop.dims.w'],
      [(args) => { args.OR = [{ conditions: [{ field: 'lines', operator: 'IS_EMPTY' }] }]; }, 'shop.lines'],
      // A scope that crosses a reference on its own endpoint gets the same rejection.
      [(args) => { args.owner = { terms: [{ path: 'name', operator: 'IS_EMPTY' }] }; }, 'shop.owner.name'],
    ]) expect(failure(await run(legacy, withShopScope(scope))), path).toEqual(decision3(path, operator));
    expect(calls).toEqual([]);
    // The same scope applies on its own endpoint, and without a client path into Shop.
    const own = await run('{ qrShops { id } }', withShopScope((args) => { args.dims = { terms: [{ operator: 'IS_EMPTY' }] }; }));
    expect(own.errors).toBeUndefined();
    expect(calls[0].plan.where).toEqual(predicate('dims', 'IS_EMPTY'));
    expect((await run('{ qrItems(note: {operator: EQ, value: "x"}) { id } }', withShopScope((args) => { args.name = { operator: 'IS_EMPTY' }; }))).errors).toBeUndefined();
  });

  it('keeps the 403 of a restricted caller\'s legacy path into a scoped collection, or into a target whose scope crosses a collection (regression pin, passes on 3.9.0)', async () => {
    const { run, calls } = build();
    const collection = await run('{ qrItems(reviews: {terms: [{path: "text", value: "x"}]}) { id } }', {
      scopes: { review: (args) => { args.deletedAt = { operator: 'IS_EMPTY' }; } },
    });
    expect(failure(collection)).toEqual({ code: 'FORBIDDEN_FILTER_PATH', status: 403, message: 'Query path reviews enters the scoped collection QrItem.reviews' });
    const crossing = { code: 'FORBIDDEN_FILTER_PATH', status: 403, message: 'Query path shop enters QrShop, whose find scope filters through the collection QrShop.items' };
    expect(failure(await run(legacy, withShopScope((args) => {
      args.name = { operator: 'IS_EMPTY' };
      args.items = { terms: [{ path: 'note', value: 'x' }] };
    })))).toEqual(crossing);
    expect(failure(await run(legacy, withShopScope((args) => { args.items = { terms: [{ path: 'note', operator: 'IS_EMPTY' }] }; })))).toEqual(crossing);
    expect(calls).toEqual([]);
  });

  it('gives a target scope the permanent code it gets on its own endpoint', async () => {
    const { run, calls } = build();
    const cases = [
      [(args) => { args.dims = { operator: 'IS_NOT_EMPTY', terms: [{ path: 'w', value: 1 }] }; }, 'MISSING_FILTER_PATH',
        'Filter on dims takes IS_NOT_EMPTY only in a term; to test the field itself, use a term without a path: dims: { terms: [{ operator: IS_NOT_EMPTY }] }'],
      [(args) => { args.dims = { operator: 'IS_EMPTY' }; }, 'MISSING_FILTER_PATH',
        'Filter on dims takes IS_EMPTY only in a term; to test the field itself, use a term without a path: dims: { terms: [{ operator: IS_EMPTY }] }'],
      [(args) => { args.name = { operator: 'IS_EMPTY', value: 'x' }; }, 'INVALID_FILTER_VALUE', 'IS_EMPTY takes no value on name: omit it or pass null'],
      [(args) => { args.lines = { terms: [{ path: 'qty', operator: 'IS_EMPTY' }] }; }, 'INVALID_FILTER_PATH',
        'IS_EMPTY cannot test lines.qty: emptiness of a value inside a list is not defined, and lines is an embedded list'],
      [(args) => { args.nope = { operator: 'IS_EMPTY' }; }, 'INVALID_FILTER_FIELD', 'Unknown field nope'],
      [(args) => { args.AND = [{ conditions: [{ field: 'dims.w', path: 'x', operator: 'IS_EMPTY' }] }]; }, 'AMBIGUOUS_FILTER_FIELD',
        'Filter condition cannot use both dotted field syntax and a separate path'],
      // A permanent error in any condition of the scope wins over the rejection of another.
      [(args) => {
        args.name = { operator: 'IS_EMPTY' };
        args.tags = { operator: 'IS_NOT_EMPTY', value: [] };
      }, 'INVALID_FILTER_VALUE', 'IS_NOT_EMPTY takes no value on tags: omit it or pass null'],
    ];
    for (const [scope, code, message] of cases) {
      expect(failure(await run(legacy, withShopScope(scope))), message).toEqual({ code, status: 400, message });
      expect(failure(await run('{ qrShops { id } }', withShopScope(scope))), message).toEqual({ code, status: 400, message });
    }
    // A path through a virtual field, which a scope cannot use on any endpoint.
    const virtual = (args) => {
      args.name = { operator: 'IS_EMPTY' };
      args.slug = { operator: 'EQ', value: 's' };
    };
    for (const source of [legacy, '{ qrShops { id } }']) {
      expect(failure(await run(source, withShopScope(virtual))), source).toEqual({
        code: 'INVALID_MODEL', status: 500, message: 'Query path slug, added by middleware or a scope, uses the virtual field QrShop.slug, which is not stored',
      });
    }
    expect(calls).toEqual([]);
    // An adapter that does not declare the operators says so first.
    const undeclared = build({ queryFeatures: undefined });
    expect(failure(await undeclared.run(legacy, withShopScope((args) => { args.dims = { terms: [{ operator: 'IS_EMPTY' }] }; })))).toEqual({
      code: 'UNSUPPORTED_QUERY', status: 400, message: 'The database adapter does not support the IS_EMPTY filter operator, used on QrShop.dims',
    });
  });

  it('rejects a joined scope reached only through a sort term, a groupId or a fact path', async () => {
    const { run, calls } = build();
    const scope = withShopScope((args) => { args.name = { operator: 'IS_EMPTY' }; });
    for (const source of [
      '{ qrItems(sort: {terms: [{field: "shop.name", order: ASC}]}) { id } }',
      '{ qrItems_aggregate(aggregation: {groupId: "shop.name", facts: [{operation: COUNT, factName: "n", path: "id"}]}) { groupId } }',
      '{ qrItems_aggregate(aggregation: {groupId: "note", facts: [{operation: MAX, factName: "m", path: "shop.name"}]}) { groupId } }',
    ]) expect(failure(await run(source, scope)), source).toEqual(decision3('shop.name'));
    expect(calls).toEqual([]);
  });

  describe('below a prefix that continues inside an embedded list or a collection', () => {
    // An item's embedded order lines reference a scoped shop, and its reviews, an unscoped collection, reference
    // the scoped item again, so the joined scopes of olines.shop and reviews.item sit below a list.
    const buildListPrefixes = () => {
      const calls = [];
      const runtime = createRuntime(createAdapter({ queryFeatures: { operators: OPERATORS }, plan: true, calls }));
      const Shop = new GraphQLObjectType({
        name: 'QjShop',
        extensions: { scope: { find: scopeOf('shop') } },
        fields: { id: { type: GraphQLID }, name: { type: GraphQLString }, note: { type: GraphQLString } },
      });
      const OLine = new GraphQLObjectType({ name: 'QjOLine', fields: { qty: { type: GraphQLInt }, shop: { type: Shop, extensions: reference() } } });
      const Review = new GraphQLObjectType({
        name: 'QjReview',
        fields: () => ({ id: { type: GraphQLID }, text: { type: GraphQLString }, item: { type: Item, extensions: reference('item') } }),
      });
      const Item = new GraphQLObjectType({
        name: 'QjItem',
        extensions: { scope: { find: scopeOf('item') } },
        fields: () => ({
          id: { type: GraphQLID },
          note: { type: GraphQLString },
          olines: { type: new GraphQLList(OLine), extensions: embedded },
          shop: { type: Shop, extensions: reference('shop') },
          reviews: { type: new GraphQLList(Review), extensions: reference('item') },
        }),
      });
      runtime.addNoEndpointType(OLine);
      runtime.connect(null, Shop, 'qjShop', 'qjShops');
      runtime.connect(null, Review, 'qjReview', 'qjReviews');
      runtime.connect(null, Item, 'qjItem', 'qjItems');
      const schema = runtime.createSchema();
      return { calls, run: (source, scopes) => graphql({ schema, source, contextValue: { scopes } }) };
    };
    const throughLines = '{ qjItems(olines: {terms: [{path: "shop.name", value: "x"}]}) { id } }';
    const throughReviews = '{ qjItems(reviews: {terms: [{path: "item.note", value: "x"}]}) { id } }';
    const insideList = (path, list, kind, operator = 'IS_EMPTY') => ({
      code: 'INVALID_FILTER_PATH',
      status: 400,
      message: `${operator} cannot test ${path}: emptiness of a value inside a list is not defined, and ${list} is ${kind}`,
    });
    const lines = insideList('olines.shop.note', 'olines', 'an embedded list');
    const reviews = insideList('reviews.item.note', 'reviews', 'a collection');

    it('gives the target scope\'s emptiness condition the permanent INVALID_FILTER_PATH of its prefixed condition, not the decision-3 rejection', async () => {
      const { run, calls } = buildListPrefixes();
      const note = (args) => { args.note = { operator: 'IS_EMPTY' }; };
      expect(failure(await run(throughLines, { shop: note }))).toEqual(lines);
      expect(failure(await run(throughReviews, { item: note }))).toEqual(reviews);
      // Every form of the scope's condition, as on its own endpoint.
      for (const [scope, operator] of [
        [(args) => { args.note = { operator: 'IS_NOT_EMPTY' }; }, 'IS_NOT_EMPTY'],
        [(args) => { args.AND = [{ conditions: [{ field: 'note', operator: 'IS_EMPTY' }] }]; }, 'IS_EMPTY'],
        [(args) => { args.OR = [{ conditions: [{ field: 'note', operator: 'IS_NOT_EMPTY' }] }]; }, 'IS_NOT_EMPTY'],
      ]) {
        expect(failure(await run(throughLines, { shop: scope })), operator).toEqual(insideList('olines.shop.note', 'olines', 'an embedded list', operator));
        expect(failure(await run(throughReviews, { item: scope })), operator).toEqual(insideList('reviews.item.note', 'reviews', 'a collection', operator));
      }
      expect(calls).toEqual([]);
    });

    it('matches the code of the same prefixed condition written by the client or by a scope', async () => {
      const { run, calls } = buildListPrefixes();
      expect(failure(await run('{ qjItems(olines: {terms: [{path: "shop.note", operator: IS_EMPTY}]}) { id } }'))).toEqual(lines);
      expect(failure(await run('{ qjItems(reviews: {terms: [{path: "item.note", operator: IS_EMPTY}]}) { id } }'))).toEqual(reviews);
      const written = (field) => (args) => { args.AND = [...(args.AND ?? []), { conditions: [{ field, operator: 'IS_EMPTY' }] }]; };
      expect(failure(await run('{ qjItems { id } }', { item: written('olines.shop.note') }))).toEqual(lines);
      expect(failure(await run('{ qjItems { id } }', { item: written('reviews.item.note') }))).toEqual(reviews);
      expect(calls).toEqual([]);
    });

    it('applies rule 3 of the prefix before the target scope\'s value check, as the final gate does', async () => {
      const { run, calls } = buildListPrefixes();
      const valued = (args) => { args.note = { operator: 'IS_EMPTY', value: 'x' }; };
      expect(failure(await run(throughLines, { shop: valued }))).toEqual(lines);
      expect(failure(await run('{ qjItems(olines: {terms: [{path: "shop.note", operator: IS_EMPTY, value: "x"}]}) { id } }'))).toEqual(lines);
      // A prefix through a reference alone adds rule 6 only, so the scope keeps its own endpoint's code.
      const own = { code: 'INVALID_FILTER_VALUE', status: 400, message: 'IS_EMPTY takes no value on note: omit it or pass null' };
      expect(failure(await run('{ qjItems(shop: {terms: [{path: "name", value: "x"}]}) { id } }', { shop: valued }))).toEqual(own);
      expect(failure(await run('{ qjShops { id } }', { shop: valued }))).toEqual(own);
      expect(calls).toEqual([]);
    });

    it('keeps the decision-3 rejection for a prefix through a reference alone, and applies EQ null scopes below list prefixes', async () => {
      const { run, calls } = buildListPrefixes();
      expect(failure(await run('{ qjItems(shop: {terms: [{path: "name", value: "x"}]}) { id } }', { shop: (args) => { args.note = { operator: 'IS_EMPTY' }; } }))).toEqual({
        code: 'UNSUPPORTED_QUERY',
        status: 400,
        message: `Query path shop enters QjShop, whose find scope tests shop.note with IS_EMPTY: ${LATER}; until then, use EQ null in the QjShop find scope`,
      });
      expect(calls).toEqual([]);
      // The legacy form of the same restriction is joined below both prefixes today.
      const eqNull = (args) => { args.note = { operator: 'EQ', value: null }; };
      expect((await run(throughLines, { shop: eqNull })).errors).toBeUndefined();
      expect(predicatesOf(calls.at(-1).plan.where)).toContainEqual(predicate('olines.shop.note', 'EQ'));
      expect((await run(throughReviews, { item: eqNull })).errors).toBeUndefined();
      expect(predicatesOf(calls.at(-1).plan.where)).toContainEqual(predicate('reviews.item.note', 'EQ'));
    });
  });

  it('keeps today\'s codes for a path-less term of another operator in a joined target scope (regression pin, passes on 3.9.0)', async () => {
    const { run } = build();
    for (const [scope, code, message] of [
      [(args) => { args.dims = { terms: [{ operator: 'EQ', value: 1 }] }; }, 'INVALID_FILTER_FIELD', 'Unknown field shop.dims.undefined'],
      [(args) => { args.dims = { terms: [{ path: '', operator: 'EQ', value: 1 }] }; }, 'INVALID_FILTER_PATH', 'Invalid filter path'],
      [(args) => { args.tags = { terms: [{ operator: 'EQ', value: 'x' }] }; }, 'INVALID_FILTER_PATH', 'Field tags cannot be traversed'],
    ]) expect(failure(await run(legacy, withShopScope(scope))), message).toEqual({ code, status: 400, message });
  });
});

describe('member authorization', () => {
  it('rejects a non-queryable or application-resolved member with FORBIDDEN_FILTER_PATH naming the member path', async () => {
    const { run, calls } = build();
    const aggregation = 'aggregation: {groupId: "note", facts: [{operation: COUNT, factName: "n", path: "id"}]}';
    const cases = [
      ['qrItems(hidden: {terms: [{operator: IS_EMPTY}]})', 'hidden.secret', 'QrHidden.secret'],
      ['qrItems(hidden: {terms: [{path: "w", operator: EQ, value: 1}, {operator: IS_NOT_EMPTY}]})', 'hidden.secret', 'QrHidden.secret'],
      ['qrItems(hidden: {terms: [{path: "w", operator: EQ, value: 1}, {path: "", operator: IS_EMPTY}]})', 'hidden.secret', 'QrHidden.secret'],
      ['qrItems(OR: [{conditions: [{field: "hidden", operator: IS_EMPTY}]}])', 'hidden.secret', 'QrHidden.secret'],
      ['qrItems(deep: {terms: [{operator: IS_EMPTY}]})', 'deep.inner.secret', 'QrHidden.secret'],
      ['qrItems(deep: {terms: [{path: "inner", operator: IS_NOT_EMPTY}]})', 'deep.inner.secret', 'QrHidden.secret'],
      ['qrItems(masked: {terms: [{operator: IS_EMPTY}]})', 'masked.code', 'QrMasked.code'],
      [`qrItems_aggregate(hidden: {terms: [{operator: IS_EMPTY}]}, ${aggregation})`, 'hidden.secret', 'QrHidden.secret'],
    ];
    for (const [field, path, owner] of cases) {
      const selection = field.startsWith('qrItems_aggregate') ? 'groupId' : 'id';
      expect(failure(await run(`{ ${field} { ${selection} } }`)), field).toEqual(nonQueryable(path, owner));
    }
    const collection = await run('{ qrShops { items(hidden: {terms: [{operator: IS_EMPTY}]}) { id } } }');
    expect(collection.errors.map((error) => error.message)).toEqual([0, 1].map(() => nonQueryable('hidden.secret', 'QrHidden.secret').message));
    expect(calls.filter((call) => call.type !== 'QrShop')).toEqual([]);
    // Conditions that read no member are not affected.
    for (const source of [
      '{ qrItems(hidden: {terms: [{path: "w", operator: IS_EMPTY}]}) { id } }',
      '{ qrItems(hidden: {terms: [{path: "w", operator: EQ, value: 1}]}) { id } }',
      '{ qrItems(lines: {terms: [{operator: IS_EMPTY}]}) { id } }',
    ]) expect((await run(source)).errors, source).toBeUndefined();
  });

  it('rejects a non-queryable single-reference member with 403, not UNSUPPORTED_QUERY', async () => {
    const { run, calls } = build();
    expect(failure(await run('{ qrItems(hodim: {terms: [{operator: IS_EMPTY}]}) { id } }'))).toEqual(nonQueryable('hodim.shop', 'QrHODim.shop'));
    expect(failure(await run('{ qrItems(hodim: {terms: [{path: "shop", operator: IS_EMPTY}]}) { id } }'))).toEqual(nonQueryable('hodim.shop', 'QrHODim.shop'));
    expect(calls).toEqual([]);
  });

  it('gives a queryable reference member UNSUPPORTED_QUERY and never runs its target\'s scope', async () => {
    const { run, calls } = build();
    const context = { ran: [], scopes: { shop: (args) => { args.name = { operator: 'EQ', value: 'a' }; } } };
    expect(failure(await run('{ qrItems(odim: {terms: [{operator: IS_EMPTY}]}) { id } }', context)))
      .toEqual(unsupported('IS_EMPTY on odim reads the reference member odim.shop'));
    expect(context.ran).toEqual([]);
    expect(calls).toEqual([]);
  });

  it('leaves virtual members out', async () => {
    const { run, calls } = build();
    expect((await run('{ qrItems(virt: {terms: [{operator: IS_EMPTY}]}) { id } }')).errors).toBeUndefined();
    expect(calls[0].plan.where).toEqual(predicate('virt', 'IS_EMPTY'));
  });

  it('does not check conditions that middleware or scopes add', async () => {
    const { run, calls } = build();
    const result = await run('{ qrItems { id } }', {
      middleware: ({ args }) => { args.hidden = { terms: [{ operator: 'IS_EMPTY' }] }; },
      scopes: { item: (args) => { args.AND = [{ conditions: [{ field: 'masked', operator: 'IS_NOT_EMPTY' }] }]; } },
    });
    expect(result.errors).toBeUndefined();
    expect(predicatesOf(calls[0].plan.where)).toEqual([predicate('hidden', 'IS_EMPTY'), predicate('masked', 'IS_NOT_EMPTY')]);
  });

  describe('with the authorization plugin', () => {
    const base = {
      RootQueryType: { '*': auth.allow() },
      QLTypeAggregationResult: { '*': auth.allow() },
      QrItem: { '*': auth.allow() },
      QrShop: { '*': auth.allow() },
      QrVirt: { w: auth.allow() },
      QrODim: { w: auth.allow(), shop: auth.allow() },
    };
    const denied = (key) => ({ code: 'FORBIDDEN', status: 403, message: `Access denied to ${key}` });
    const plainQueries = [
      '{ qrItems(plain: {terms: [{operator: IS_EMPTY}]}) { id } }',
      '{ qrItems(plain: {terms: [{path: "a", operator: EQ, value: 1}, {path: "", operator: IS_NOT_EMPTY}]}) { id } }',
      '{ qrItems(AND: [{conditions: [{field: "plain", operator: IS_EMPTY}]}]) { id } }',
      '{ qrItems_aggregate(plain: {terms: [{operator: IS_EMPTY}]}, aggregation: {groupId: "note", facts: [{operation: COUNT, factName: "n", path: "id"}]}) { groupId } }',
      '{ qrShops { items(plain: {terms: [{operator: IS_EMPTY}]}) { id } } }',
    ];

    it('gives a member that a rule denies, or an unruled member under DENY, the plugin\'s FORBIDDEN for that field', async () => {
      for (const QrPlain of [{ a: auth.allow(), b: () => false }, { a: auth.allow() }]) {
        const { run, calls } = build({ permissions: { ...base, QrPlain } });
        for (const source of plainQueries) expect(failure(await run(source)), source).toEqual(denied('QrPlain.b'));
        expect(calls.filter((call) => call.type !== 'QrShop')).toEqual([]);
      }
    });

    it('gives a member a requireRole rule protects the rule\'s own error', async () => {
      const { run, calls } = build({ permissions: { ...base, QrPlain: { a: auth.allow(), b: auth.requireRole('ADMIN') } } });
      expect(failure(await run(plainQueries[0]))).toEqual({ code: 'FORBIDDEN', status: 403, message: 'Requires role: ADMIN' });
      expect(calls).toEqual([]);
      expect((await run(plainQueries[0], { user: { role: 'ADMIN' } })).errors).toBeUndefined();
    });

    it('lets an unruled member pass under ALLOW, and never checks virtual members', async () => {
      const allowed = build({ permissions: base, defaultPolicy: 'ALLOW' });
      for (const source of plainQueries) expect((await allowed.run(source)).errors, source).toBeUndefined();
      const denying = build({ permissions: { ...base, QrPlain: { '*': auth.allow() } } });
      expect((await denying.run('{ qrItems(virt: {terms: [{operator: IS_EMPTY}]}) { id } }')).errors).toBeUndefined();
    });

    it('denies a single-reference member before the gate, and lets an allowed one reach it', async () => {
      const { run, calls } = build({ permissions: { ...base, QrODim: { w: auth.allow(), shop: () => false } } });
      expect(failure(await run('{ qrItems(odim: {terms: [{operator: IS_EMPTY}]}) { id } }'))).toEqual(denied('QrODim.shop'));
      const allowed = build({ permissions: base });
      expect(failure(await allowed.run('{ qrItems(odim: {terms: [{operator: IS_EMPTY}]}) { id } }')))
        .toEqual(unsupported('IS_EMPTY on odim reads the reference member odim.shop'));
      expect([...calls, ...allowed.calls]).toEqual([]);
    });

    it('does not check conditions that middleware adds', async () => {
      const { run, calls } = build({ permissions: base });
      const result = await run('{ qrItems { id } }', { middleware: ({ args }) => { args.plain = { terms: [{ operator: 'IS_EMPTY' }] }; } });
      expect(result.errors).toBeUndefined();
      expect(calls[0].plan.where).toEqual(predicate('plain', 'IS_EMPTY'));
    });
  });
});

describe('types that describeModels rejects', () => {
  // Served by an adapter that only records, as MongoDB's default mode with supplied models serves them: an embedded
  // type that reaches itself through a single embedded member (readOnly, so no input is generated), one that reaches
  // itself only through a list, interface members, and interface and union lists of the root, which get a terms
  // argument.
  const buildRaw = (options = {}) => {
    const calls = [];
    const runtime = createRuntime(createAdapter({ queryFeatures: featuresOf(options), plan: false, calls }));
    const Target = new GraphQLObjectType({ name: 'QxTarget', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
    const Shape = new GraphQLInterfaceType({ name: 'QxShape', fields: { label: { type: GraphQLString } } });
    const Circle = new GraphQLObjectType({ name: 'QxCircle', fields: { label: { type: GraphQLString } } });
    const Square = new GraphQLObjectType({ name: 'QxSquare', fields: { label: { type: GraphQLString } } });
    const Either = new GraphQLUnionType({ name: 'QxEither', types: [Circle, Square] });
    const Node = new GraphQLObjectType({
      name: 'QxNode',
      fields: () => ({ label: { type: GraphQLString }, child: { type: Node, extensions: { ...embedded, readOnly: true } } }),
    });
    const Tree = new GraphQLObjectType({
      name: 'QxTree',
      fields: () => ({ label: { type: GraphQLString }, children: { type: new GraphQLList(Tree), extensions: embedded } }),
    });
    const WithShape = new GraphQLObjectType({ name: 'QxWithShape', fields: { label: { type: GraphQLString }, shape: { type: Shape, extensions: { readOnly: true } } } });
    const WithBoth = new GraphQLObjectType({
      name: 'QxWithBoth',
      fields: { owner: { type: Target, extensions: reference() }, shape: { type: Shape, extensions: { readOnly: true } } },
    });
    const HiddenShape = new GraphQLObjectType({ name: 'QxHiddenShape', fields: { shape: { type: Shape, extensions: { readOnly: true, queryable: false } } } });
    const Holder = new GraphQLObjectType({
      name: 'QxHolder',
      fields: {
        id: { type: GraphQLID },
        node: { type: Node, extensions: embedded },
        tree: { type: Tree, extensions: embedded },
        withShape: { type: WithShape, extensions: embedded },
        withBoth: { type: WithBoth, extensions: embedded },
        hiddenShape: { type: HiddenShape, extensions: { ...embedded, readOnly: true } },
        shapes: { type: new GraphQLList(Shape), extensions: { readOnly: true } },
        eithers: { type: new GraphQLList(Either), extensions: { readOnly: true } },
      },
    });
    for (const type of [Node, Tree, WithShape, WithBoth, HiddenShape]) runtime.addNoEndpointType(type);
    runtime.connect(null, Target, 'qxTarget', 'qxTargets');
    runtime.connect(null, Holder, 'qxHolder', 'qxHolders');
    const schema = runtime.createSchema();
    if (options.permissions) auth.createAuthPlugin(options.permissions, { defaultPolicy: 'DENY' }).onSchemaChange({ schema });
    return { calls, run: (source) => graphql({ schema, source, contextValue: {} }) };
  };
  const permissions = {
    RootQueryType: { '*': auth.allow() }, QxHolder: { '*': auth.allow() }, QxNode: { '*': auth.allow() }, QxTree: { '*': auth.allow() },
  };

  it('rejects re-entry through a single embedded member with INVALID_FILTER_OPERATOR, or UNSUPPORTED_QUERY when undeclared, with and without the plugin', async () => {
    for (const options of [{}, { permissions }]) {
      const declared = buildRaw(options);
      for (const source of ['{ qxHolders(node: {terms: [{operator: IS_EMPTY}]}) { id } }', '{ qxHolders(node: {terms: [{path: "child", operator: IS_NOT_EMPTY}]}) { id } }']) {
        const operator = source.includes('IS_NOT_EMPTY') ? 'IS_NOT_EMPTY' : 'IS_EMPTY';
        const path = source.includes('child') ? 'node.child' : 'node';
        expect(failure(await declared.run(source)), source).toEqual({
          code: 'INVALID_FILTER_OPERATOR',
          status: 400,
          message: `${operator} cannot test ${path}: the embedded type QxNode reaches itself through the single embedded member ${path}.child`,
        });
      }
      const undeclared = buildRaw({ ...options, queryFeatures: undefined });
      expect(failure(await undeclared.run('{ qxHolders(node: {terms: [{operator: IS_EMPTY}]}) { id } }'))).toEqual({
        code: 'UNSUPPORTED_QUERY', status: 400, message: 'The database adapter does not support the IS_EMPTY filter operator, used on QxHolder.node',
      });
      expect([...declared.calls, ...undeclared.calls]).toEqual([]);
      // A type that reaches itself only through a list member is accepted.
      expect((await declared.run('{ qxHolders(tree: {terms: [{operator: IS_EMPTY}]}) { id } }')).errors).toBeUndefined();
      expect(declared.calls.map((call) => call.args.tree)).toEqual([{ terms: [{ operator: 'IS_EMPTY' }] }]);
    }
  });

  it('rejects an interface member with INVALID_FILTER_PATH, also next to a reference member, after its own 403', async () => {
    const { run, calls } = buildRaw();
    expect(failure(await run('{ qxHolders(withShape: {terms: [{operator: IS_EMPTY}]}) { id } }'))).toEqual({
      code: 'INVALID_FILTER_PATH',
      status: 400,
      message: 'IS_EMPTY cannot test withShape: withShape.shape is an interface or union field, whose emptiness is not defined',
    });
    expect(failure(await run('{ qxHolders(withBoth: {terms: [{operator: IS_NOT_EMPTY}]}) { id } }')).code).toBe('INVALID_FILTER_PATH');
    expect(failure(await run('{ qxHolders(hiddenShape: {terms: [{operator: IS_EMPTY}]}) { id } }')))
      .toEqual(nonQueryable('hiddenShape.shape', 'QxHiddenShape.shape'));
    expect(calls).toEqual([]);
  });

  it('rejects an emptiness term on an interface or union list field with INVALID_FILTER_PATH, before the adapter runs', async () => {
    const { run, calls } = buildRaw();
    for (const field of ['shapes', 'eithers']) {
      expect(failure(await run(`{ qxHolders(${field}: {terms: [{operator: IS_EMPTY}]}) { id } }`)), field).toEqual({
        code: 'INVALID_FILTER_PATH', status: 400, message: `IS_EMPTY cannot test ${field}: ${field} is an interface or union field, whose emptiness is not defined`,
      });
      // A path into the field fails rule 1, as createQueryPlan's path resolution does.
      expect(failure(await run(`{ qxHolders(${field}: {terms: [{path: "label", operator: IS_NOT_EMPTY}]}) { id } }`)), field).toEqual({
        code: 'INVALID_FILTER_PATH', status: 400, message: `Field ${field} cannot be traversed`,
      });
    }
    expect(calls).toEqual([]);
  });
});

describe('MCP list and aggregate tools', () => {
  it('go through the same gate, since they execute the generated GraphQL fields', async () => {
    const { schema, calls } = build();
    const { callTool } = generateMCPTools(schema, { context: {} });
    const errorOf = (result) => (result.isError ? JSON.parse(result.content[0].text).errors[0] : null);
    const aggregation = { groupId: 'note', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }] };
    const reference = errorOf(await callTool('qrItems', { shop: { terms: [{ path: 'name', operator: 'IS_EMPTY' }] } }));
    expect([reference.extensions.code, reference.message]).toEqual(['UNSUPPORTED_QUERY', `IS_EMPTY on shop.name crosses the reference shop: ${LATER}`]);
    const member = errorOf(await callTool('qrItems', { hidden: { terms: [{ operator: 'IS_EMPTY' }] } }));
    expect([member.extensions.code, member.message]).toEqual(['FORBIDDEN_FILTER_PATH', nonQueryable('hidden.secret', 'QrHidden.secret').message]);
    const value = errorOf(await callTool('qrItems_aggregate', { note: { operator: 'IS_EMPTY', value: 'x' }, aggregation }));
    expect([value.extensions.code, value.message]).toEqual(['INVALID_FILTER_VALUE', 'IS_EMPTY takes no value on note: omit it or pass null']);
    expect(calls).toEqual([]);
    expect(errorOf(await callTool('qrItems_aggregate', { plain: { terms: [{ operator: 'IS_NOT_EMPTY' }] }, aggregation }))).toBeNull();
    expect(calls.map(({ method, plan }) => [method, plan.where])).toEqual([['aggregate', predicate('plain', 'IS_NOT_EMPTY')]]);
  });
});
