import { expect, test, vi } from 'vitest';
import {
  GraphQLEnumType, GraphQLID, GraphQLInputObjectType, GraphQLInt, GraphQLList, GraphQLNonNull,
  GraphQLObjectType, GraphQLScalarType, GraphQLString, graphql, validateSchema,
} from 'graphql';
import { createRuntime } from '../packages/core/src/runtime.js';
import { QLOperator, SimfinityError } from '../packages/core/src/index.js';

const createAdapter = () => ({
  prepare: vi.fn(),
  createModel: vi.fn((type) => ({ name: type.name })),
  withTransaction: vi.fn(async (session, body) => body(session || { attempt: 1 })),
});

const entity = (name, extensions) => new GraphQLObjectType({
  name,
  fields: { id: { type: GraphQLID }, name: { type: GraphQLString } },
  extensions,
});

const Base = entity('NvBase');
const options = (extra = {}) => ({ type: Base, description: 'Open items', where: () => [], ...extra });

const invalidView = expect.objectContaining({ extensions: expect.objectContaining({ code: 'INVALID_VIEW', status: 500 }) });
const nameConflict = expect.objectContaining({ extensions: expect.objectContaining({ code: 'QUERY_NAME_CONFLICT', status: 500 }) });

test.each([
  ['empty name', '', {}],
  ['invalid name', 'open-items', {}],
  ['reserved name', '__openItems', {}],
  ['aggregate suffix', 'openItems_aggregate', {}],
  ['unknown option', 'openItems', { fields: {} }],
  ['missing description', 'openItems', { description: undefined }],
  ['empty description', 'openItems', { description: '' }],
  ['type not an object type', 'openItems', { type: GraphQLString }],
  ['where not a function', 'openItems', { where: [] }],
  ['param without type', 'openItems', { params: { from: {} } }],
  ['param entry null', 'openItems', { params: { from: null } }],
  ['param typed with an input object', 'openItems', { params: { from: { type: new GraphQLInputObjectType({ name: 'NvIn', fields: { a: { type: GraphQLString } } }) } } }],
  ['param typed with a list of input objects', 'openItems', { params: { from: { type: new GraphQLList(new GraphQLInputObjectType({ name: 'NvIn2', fields: { a: { type: GraphQLString } } })) } } }],
  ['param with an unknown key', 'openItems', { params: { from: { type: GraphQLString, resolve: () => 1 } } }],
  ['param description not a string', 'openItems', { params: { from: { type: GraphQLString, description: 1 } } }],
])('rejects %s at registration without keeping the entry', (label, name, invalid) => {
  const runtime = createRuntime(createAdapter());
  expect(() => runtime.registerView(name, options(invalid))).toThrow(invalidView);
  expect(() => runtime.registerView('openItems', options())).not.toThrow(); // the registry is intact
});

test.each([['no options', undefined], ['null options', null], ['array options', []]])('rejects %s', (label, value) => {
  expect(() => createRuntime(createAdapter()).registerView('openItems', value)).toThrow(invalidView);
});

test('accepts scalar, enum, list and NonNull param types', () => {
  const runtime = createRuntime(createAdapter());
  const Kind = new GraphQLEnumType({ name: 'NvKind', values: { A: { value: 'A' } } });
  expect(() => runtime.registerView('typedParams', options({
    params: {
      a: { type: GraphQLString },
      b: { type: new GraphQLNonNull(Kind) },
      c: { type: new GraphQLList(GraphQLID) },
      d: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLInt))), description: 'd', defaultValue: [1] },
    },
  }))).not.toThrow();
});

test('rejects a duplicate view name with QUERY_NAME_CONFLICT and keeps the first registration', async () => {
  const runtime = createRuntime(createAdapter());
  expect(() => runtime.registerView('openItems', options())).not.toThrow();
  expect(() => runtime.registerView('openItems', options({ description: 'Other' }))).toThrow(nameConflict);
  expect(() => runtime.registerView('openItems', options())).toThrow(nameConflict); // the first registration is kept
  expect(() => runtime.registerView('otherItems', options())).not.toThrow();
});

test('is exposed by the MongoDB and PostgreSQL facades', async () => {
  const mongo = await import('../packages/mongodb/src/index.js');
  const postgres = await import('../packages/postgres/src/index.js');
  expect(typeof mongo.registerView).toBe('function');
  expect(typeof postgres.registerView).toBe('function');
});

const invalidViewWith = (message) => expect.objectContaining({
  message: expect.stringContaining(message),
  extensions: expect.objectContaining({ code: 'INVALID_VIEW', status: 500 }),
});

// Built inside each test: a type with relation fields binds to the first runtime that builds its resolvers.
const relationTypes = () => {
  const Owner = new GraphQLObjectType({
    name: 'NvOwner',
    fields: () => ({
      id: { type: GraphQLID },
      items: { type: new GraphQLList(Item), extensions: { relation: { connectionField: 'owner' } } },
    }),
  });
  const Item = new GraphQLObjectType({
    name: 'NvItem',
    fields: () => ({ id: { type: GraphQLID }, owner: { type: Owner, extensions: { relation: {} } } }),
  });
  return { Owner, Item };
};

const connectRelationTypes = (runtime) => {
  const types = relationTypes();
  runtime.connect(null, types.Owner, 'nvOwner', 'nvOwners');
  runtime.connect(null, types.Item, 'nvItem', 'nvItems');
  return types;
};

test.each([
  ['a type not registered in this runtime', 'v needs a type registered with connect() in this runtime',
    (r) => r.registerView('v', options({ type: entity('NvOther') }))],
  ['a type registered with addNoEndpointType', 'v needs a type registered with connect() in this runtime', (r) => {
    const T = entity('NvNoEndpoint');
    r.addNoEndpointType(T);
    r.registerView('v', options({ type: T }));
  }],
  ['another type object with the name of a connected type', 'v needs a type registered with connect() in this runtime',
    (r) => r.registerView('v', options({ type: entity('NvBase') }))],
  ['a param whose name is not a GraphQL name', 'v param min-stock requires a valid GraphQL name',
    (r) => r.registerView('v', options({ params: { 'min-stock': { type: GraphQLInt } } }))],
  ['a param whose name starts with __', 'v param __minStock requires a valid GraphQL name',
    (r) => r.registerView('v', options({ params: { __minStock: { type: GraphQLInt } } }))],
  ['a param named like a stored field', 'v param name has the name of a field of NvBase',
    (r) => r.registerView('v', options({ params: { name: { type: GraphQLString } } }))],
  ['a param named like a reference field', 'v param owner has the name of a field of NvItem', (r) => {
    const { Item } = connectRelationTypes(r);
    r.registerView('v', options({ type: Item, params: { owner: { type: GraphQLID } } }));
  }],
  ['a param named like a collection field', 'v param items has the name of a field of NvOwner', (r) => {
    const { Owner } = connectRelationTypes(r);
    r.registerView('v', options({ type: Owner, params: { items: { type: GraphQLInt } } }));
  }],
  ['a param named like a virtual field', 'v param score has the name of a field of NvScored', (r) => {
    const Scored = new GraphQLObjectType({
      name: 'NvScored',
      fields: {
        id: { type: GraphQLID },
        score: { type: GraphQLInt, resolve: () => 1, extensions: { virtual: true } },
      },
    });
    r.connect(null, Scored, 'nvScored', 'nvScoreds');
    r.registerView('v', options({ type: Scored, params: { score: { type: GraphQLInt } } }));
  }],
  ['a param named like a control argument', 'v param sort has the name of a generated list query argument',
    (r) => r.registerView('v', options({ params: { sort: { type: GraphQLString } } }))],
])('rejects %s at createSchema before any model is prepared', (label, message, register) => {
  const adapter = createAdapter();
  const runtime = createRuntime(adapter);
  runtime.connect(null, Base, 'nvBase', 'nvBases');
  register(runtime);
  expect(() => runtime.createSchema()).toThrow(invalidViewWith(message));
  expect(adapter.prepare).not.toHaveBeenCalled();
  expect(adapter.createModel).not.toHaveBeenCalled();
});

// The `_aggregate` root is unreachable: registerView rejects the suffix.
test.each(['nvBase', 'nvBases'])('rejects a view named like the generated %s in either registration order', (name) => {
  for (const viewFirst of [true, false]) {
    const adapter = createAdapter();
    const runtime = createRuntime(adapter);
    const view = () => runtime.registerView(name, options());
    if (viewFirst) view();
    runtime.connect(null, Base, 'nvBase', 'nvBases');
    if (!viewFirst) view();
    expect(() => runtime.createSchema()).toThrow(nameConflict);
    expect(adapter.prepare).not.toHaveBeenCalled();
    expect(adapter.createModel).not.toHaveBeenCalled();
  }
});

test('rejects a view named like an included custom query, and ignores an excluded one', () => {
  const adapter = createAdapter();
  const runtime = createRuntime(adapter);
  runtime.connect(null, Base, 'nvBase', 'nvBases');
  runtime.registerCustomQuery('report', 'Report', null, GraphQLString, () => 'custom');
  runtime.registerView('report', options());
  expect(() => runtime.createSchema()).toThrow(nameConflict);
  expect(() => runtime.createSchema(null, null, null, { includedCustomQueries: ['report'] })).toThrow(nameConflict);
  expect(adapter.prepare).not.toHaveBeenCalled();
  expect(adapter.createModel).not.toHaveBeenCalled();

  const field = runtime.createSchema(null, null, null, { includedCustomQueries: [] }).getQueryType().getFields().report;
  expect(field.type.toString()).toBe('[NvBase]');
  expect(field.extensions.simfinityQuery.view).toEqual({ name: 'report' });
});

test('builds the view root with the generated list arguments plus the params, the base type and the marker', () => {
  const runtime = createRuntime(createAdapter());
  runtime.connect(null, Base, 'nvBase', 'nvBases');
  runtime.registerView('openItems', options({
    params: {
      minStock: { type: GraphQLInt, description: 'Minimum stock', defaultValue: 1 },
      shop: { type: new GraphQLNonNull(GraphQLID) },
    },
  }));
  const schema = runtime.createSchema();
  const fields = schema.getQueryType().getFields();
  const field = fields.openItems;
  const signature = (args) => args.map(({ name, type }) => [name, type.toString()]);
  expect(field.description).toBe('Open items');
  expect(field.type.toString()).toBe('[NvBase]');
  expect(signature(field.args)).toEqual([['minStock', 'Int'], ['shop', 'ID!'], ...signature(fields.nvBases.args)]);
  expect(field.args.find((a) => a.name === 'minStock')).toMatchObject({ description: 'Minimum stock', defaultValue: 1 });
  expect(field.args.find((a) => a.name === 'shop')).toMatchObject({ description: undefined, defaultValue: undefined });
  expect(field.extensions.simfinityQuery).toEqual({
    typeName: 'NvBase', operation: 'find', countSink: true, view: { name: 'openItems' },
  });
  expect(validateSchema(schema)).toEqual([]);
});

test('follows its base type into and out of the schema', () => {
  const runtime = createRuntime(createAdapter());
  const Other = entity('NvFollowOther');
  runtime.connect(null, Base, 'nvBase', 'nvBases');
  runtime.connect(null, Other, 'nvOther', 'nvOthers');
  runtime.registerView('openItems', options());
  const rootNames = (schema) => Object.keys(schema.getQueryType().getFields());
  expect(rootNames(runtime.createSchema([Base]))).toEqual(['nvBase', 'nvBases', 'nvBases_aggregate', 'openItems']);
  expect(rootNames(runtime.createSchema([Other]))).toEqual(['nvOther', 'nvOthers', 'nvOthers_aggregate']);

  // A view takes its name only in the schemas that include its type.
  runtime.registerView('nvOthers', options());
  expect(() => runtime.createSchema()).toThrow(nameConflict);
  const otherFields = runtime.createSchema([Other]).getQueryType().getFields();
  expect(otherFields.nvOthers.extensions.simfinityQuery).toEqual({ typeName: 'NvFollowOther', operation: 'find', countSink: true });
  const baseFields = runtime.createSchema([Base]).getQueryType().getFields();
  expect(Object.keys(baseFields)).toEqual(['nvBase', 'nvBases', 'nvBases_aggregate', 'openItems', 'nvOthers']);
  expect(baseFields.nvOthers.extensions.simfinityQuery.view).toEqual({ name: 'nvOthers' });
});

test('builds the view once when an application scalar named JSON forces a second RootQueryType build', () => {
  const runtime = createRuntime(createAdapter());
  const JSONScalar = new GraphQLScalarType({ name: 'JSON', serialize: (value) => value });
  const Doc = new GraphQLObjectType({
    name: 'NvJsonDoc',
    fields: { id: { type: GraphQLID }, data: { type: JSONScalar } },
  });
  runtime.connect(null, Doc, 'nvJsonDoc', 'nvJsonDocs');
  runtime.registerView('openItems', options({ type: Doc, params: { minStock: { type: GraphQLInt } } }));
  const schema = runtime.createSchema();
  expect(validateSchema(schema)).toEqual([]);
  // The second build ran: aggregation results are typed with the application scalar.
  expect(schema.getType('QLTypeAggregationResult').getFields().facts.type).toBe(JSONScalar);
  const fields = schema.getQueryType().getFields();
  expect(fields.openItems.type.toString()).toBe('[NvJsonDoc]');
  expect(fields.openItems.args.map((a) => a.name)).toEqual(['minStock', ...fields.nvJsonDocs.args.map((a) => a.name)]);
});

// The shape of tests/query-path-authorization.test.js: every adapter read is recorded with a copy of its arguments.
const createRecordingAdapter = (calls, rows) => ({
  prepare() {},
  createModel: (gqltype) => ({ name: gqltype.name }),
  castId: String,
  withTransaction: async (session, body) => body(session || {}),
  async find(Model, gqltype, args) {
    calls.push({ method: 'find', args: structuredClone(args) });
    return rows;
  },
  async count(Model, gqltype, args) {
    calls.push({ method: 'count', args: structuredClone(args) });
    return rows.length;
  },
});

test('strips the params before middleware, the scope and the adapter', async () => {
  const calls = [];
  const seen = [];
  const scoped = [];
  const runtime = createRuntime(createRecordingAdapter(calls, [{ _id: 'r1', name: 'a' }]));
  const Scoped = entity('NvScoped', { scope: { find: ({ args }) => { scoped.push(structuredClone(args)); } } });
  runtime.connect(null, Scoped, 'nvScoped', 'nvScopeds');
  // The registration holds functions, so only the arguments are copied.
  runtime.use((params, next) => {
    seen.push({
      type: params.type, operation: params.operation, entry: params.entry, args: structuredClone(params.args),
    });
    return next();
  });
  runtime.registerView('openItems', options({
    type: Scoped,
    params: { minStock: { type: GraphQLInt, defaultValue: 1 }, shop: { type: new GraphQLNonNull(GraphQLID) } },
  }));
  const schema = runtime.createSchema();
  const registration = runtime.getRegistrations().find((r) => r.gqltype === Scoped);
  const clientArgs = { name: { operator: 'EQ', value: 'a' }, pagination: { page: 1, size: 5, count: true } };

  const contextValue = {};
  const result = await graphql({
    schema,
    source: `{ openItems(minStock: 2, shop: "s1", name: { operator: EQ, value: "a" },
      pagination: { page: 1, size: 5, count: true }) { id name } }`,
    contextValue,
  });
  expect(result).toEqual({ data: { openItems: [{ id: 'r1', name: 'a' }] } });
  expect(contextValue.count).toBe(1);
  expect(seen).toHaveLength(1);
  expect(seen[0].type).toBe(registration);
  expect(seen[0]).toMatchObject({ operation: 'find', entry: 'openItems' });
  expect(seen[0].args).toEqual(clientArgs);
  // After middleware, the groups of where, none here, are appended to AND.
  const listArgs = { ...clientArgs, AND: [] };
  expect(scoped).toEqual([listArgs]);
  expect(calls).toEqual([{ method: 'find', args: listArgs }, { method: 'count', args: listArgs }]);

  // A param the client omits arrives with its default, and is stripped as well.
  await graphql({ schema, source: '{ openItems(shop: "s1") { id } }', contextValue: {} });
  expect(seen[1].args).toEqual({});
  expect(scoped[1]).toEqual({ AND: [] });
  expect(calls[2]).toEqual({ method: 'find', args: { AND: [] } });
});

// The groups of a view's `where` are client constructs, appended after middleware.
const NV_ROWS = {
  NvItem: [
    {
      _id: 'i1', id: 'i1', stock: 5, tenant: 'A', shop: 's1', code: 'c1', label: 'first',
    },
    { _id: 'i2', id: 'i2', stock: 0, tenant: 'A', shop: 's2' },
    { _id: 'i3', id: 'i3', stock: 9, tenant: 'B', shop: 's1' },
  ],
  NvShop: [
    { _id: 's1', id: 's1', name: 'North', state: 'OPEN' },
    { _id: 's2', id: 's2', name: 'South', state: 'CLOSED' },
  ],
};
const OPERATORS = QLOperator.getValues().map((entry) => entry.value);

// The value a condition reads on an item: its own field, or, through the shop reference, the shop's id
// or another field of the shop, also when the condition names it with a dotted field.
const nvValue = (row, condition) => {
  const path = condition.path ? `${condition.field}.${condition.path}` : condition.field;
  const [head, ...rest] = path.split('.');
  if (head !== 'shop' || !rest.length || rest[0] === 'id') return row[head];
  return NV_ROWS.NvShop.find((shop) => shop.id === row.shop)?.[rest[0]];
};
// EQ and GTE are evaluated; any other operator keeps the row.
const nvMatches = (row, condition) => {
  if (condition.operator === 'EQ') return nvValue(row, condition) === condition.value;
  if (condition.operator === 'GTE') return nvValue(row, condition) >= condition.value;
  return true;
};
const nvGroupMatches = (row, group) => (group.conditions || []).every((condition) => nvMatches(row, condition))
  && (group.AND || []).every((nested) => nvGroupMatches(row, nested));
const nvRows = (Model, args) => NV_ROWS[Model.name].filter((row) => (args.AND || []).every((group) => nvGroupMatches(row, group)));

// The shape of tests/scope-args.test.js: every read is recorded with a copy of its arguments.
const createViewAdapter = (calls, queryFeatures) => {
  const adapter = {
    bind() {},
    prepare() {},
    createModel: (gqltype) => ({ name: gqltype.name }),
    castId: String,
    withTransaction: async (session, body) => body(session || {}),
    async getById(Model, id) { return NV_ROWS[Model.name].find((row) => row._id === id) ?? null; },
    async find(Model, gqltype, args) {
      calls.push({ method: 'find', args: structuredClone(args) });
      const rows = nvRows(Model, args);
      if (!args.pagination) return rows;
      const { page, size } = args.pagination;
      return rows.slice((page - 1) * size, page * size);
    },
    async count(Model, gqltype, args) {
      calls.push({ method: 'count', args: structuredClone(args) });
      return nvRows(Model, args).length;
    },
  };
  if (queryFeatures !== undefined) adapter.queryFeatures = queryFeatures;
  return adapter;
};

const stock = (value) => ({ conditions: [{ field: 'stock', operator: 'GTE', value }] });
const tenant = (value) => ({ conditions: [{ field: 'tenant', operator: 'EQ', value }] });
const tenantScope = ({ args, context }) => {
  args.AND = [...(args.AND || []), tenant(context.user.tenant)];
};
const openOnlyScope = ({ args, context }) => {
  if (context.openOnly) args.state = { operator: 'EQ', value: 'OPEN' };
};

// Built inside each test: NvItem holds a reference, so its types bind to the first runtime that builds
// their relation resolvers. Registers openItems, with `where`, and the `views` given, on NvItem.
const build = ({
  queryFeatures, where = ({ params }) => [stock(params.minStock)], scopes = {}, views = {}, middleware,
} = {}) => {
  const calls = [];
  const runtime = createRuntime(createViewAdapter(calls, queryFeatures));
  const Shop = new GraphQLObjectType({
    name: 'NvShop',
    extensions: { scope: { find: scopes.shop ?? openOnlyScope } },
    fields: { id: { type: GraphQLID }, name: { type: GraphQLString }, state: { type: GraphQLString } },
  });
  const Item = new GraphQLObjectType({
    name: 'NvItem',
    extensions: { scope: { find: scopes.item ?? tenantScope } },
    fields: {
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      stock: { type: GraphQLInt },
      tenant: { type: GraphQLString },
      shop: { type: Shop, extensions: { relation: { embedded: false } } },
      score: { type: GraphQLInt, resolve: () => 1, extensions: { virtual: true } },
      // Stored, and not queryable by clients: one by its declaration, one for its application resolver.
      code: { type: GraphQLString, extensions: { queryable: false } },
      label: { type: GraphQLString, resolve: (item) => item.label },
    },
  });
  runtime.connect(null, Shop, 'nvShop', 'nvShops');
  runtime.connect(null, Item, 'nvItem', 'nvItems');
  if (middleware) runtime.use(middleware);
  runtime.registerView('openItems', {
    type: Item, description: 'Items in stock', params: { minStock: { type: GraphQLInt, defaultValue: 1 } }, where,
  });
  for (const [name, view] of Object.entries(views)) runtime.registerView(name, { type: Item, description: name, ...view });
  return {
    runtime, schema: runtime.createSchema(), calls, Item, Shop,
  };
};

const ids = (rows) => rows.map((row) => row.id);
const run = (schema, source, contextValue = { user: { tenant: 'A' } }) => graphql({ schema, source, contextValue });

test('appends the where groups after middleware and the scope cannot see the view', async () => {
  const scoped = [];
  const { schema, calls } = build({
    // Rebuilds the arguments and drops the client's groups, as a middleware may.
    middleware: async (params, next) => {
      if (params.operation === 'find') params.args = { ...params.args, AND: [] };
      await next();
    },
    scopes: {
      item: (payload) => {
        scoped.push({ payload, args: structuredClone(payload.args) });
        tenantScope(payload);
      },
    },
  });
  const result = await run(schema, '{ openItems { id } }');
  expect(result.errors).toBeUndefined();
  expect(ids(result.data.openItems)).toEqual(['i1']);
  expect(scoped).toHaveLength(1);
  expect(scoped[0].payload).not.toHaveProperty('entry');
  expect(scoped[0].payload).not.toHaveProperty('view');
  expect(scoped[0].args).toEqual({ AND: [stock(1)] }); // the where group, and no minStock
  expect(calls).toEqual([{ method: 'find', args: { AND: [stock(1), tenant('A')] } }]);
});

test('runs the find scope for the list and for the count, and reports the count', async () => {
  const { schema, calls } = build();
  const context = { user: { tenant: 'A' } };
  const result = await run(schema, '{ openItems(minStock: 0, pagination: { page: 1, size: 1, count: true }) { id } }', context);
  expect(result.errors).toBeUndefined();
  expect(ids(result.data.openItems)).toEqual(['i1']);
  expect(context.count).toBe(2);
  expect(calls.map((call) => call.method)).toEqual(['find', 'count']);
  for (const call of calls) expect(call.args.AND).toEqual([stock(0), tenant('A')]);
});

test('receives { params, context } and never the client arguments', async () => {
  const where = vi.fn(({ params }) => [stock(params.minStock)]);
  const { schema } = build({ where });
  const context = { user: { tenant: 'A' } };
  const result = await run(schema, `{ openItems(minStock: 3, tenant: { operator: EQ, value: "A" },
    pagination: { page: 1, size: 5 }) { id } }`, context);
  expect(result.errors).toBeUndefined();
  expect(where).toHaveBeenCalledTimes(1);
  const [input] = where.mock.calls[0];
  expect(input).toEqual({ params: { minStock: 3 }, context });
  expect(input.context).toBe(context);
  expect(Object.keys(input)).toEqual(['params', 'context']);
});

test('two aliases with different params return different rows and counts in one document', async () => {
  const { schema, calls } = build();
  const result = await run(schema, `{
    a: openItems(minStock: 1, pagination: { page: 1, size: 10, count: true }) { id }
    b: openItems(minStock: 6, pagination: { page: 1, size: 10, count: true }) { id }
  }`);
  expect(result.errors).toBeUndefined();
  expect(ids(result.data.a)).toEqual(['i1']);
  expect(ids(result.data.b)).toEqual([]);
  // One context holds one count, so the counts are read from the adapter calls.
  const counts = calls.filter((call) => call.method === 'count').map((call) => call.args.AND);
  expect(counts).toHaveLength(2);
  expect(counts).toEqual(expect.arrayContaining([[stock(1), tenant('A')], [stock(6), tenant('A')]]));
});

test('keeps the code and status of an error thrown by where', async () => {
  const { schema, calls } = build({
    where: () => { throw new SimfinityError('date must be YYYY-MM-DD', 'INVALID_INPUT', 400); },
  });
  const result = await run(schema, '{ openItems { id } }');
  expect(result.errors[0].message).toBe('date must be YYYY-MM-DD');
  expect(result.errors[0].extensions).toMatchObject({ code: 'INVALID_INPUT', status: 400 });
  expect(calls).toEqual([]);
});

test.each([
  ['a non-array result', () => ({ conditions: [] }), 'must return an array of AND groups'],
  ['a group that is not an object', () => ['x'], 'returned a group that is not a plain object'],
  ['a nested group that is not an object', () => [{ AND: [null] }], 'returned a group that is not a plain object'],
  ['nested groups that are not an array', () => [{ OR: {} }], 'returned a group whose OR is not an array'],
  ['conditions that are not an array', () => [{ conditions: {} }], 'returned a group whose conditions is not an array'],
  ['a misspelled group key', () => [{ condition: [{ field: 'stock', operator: 'GT', value: 0 }] }],
    'returned a group with unknown key condition'],
  ['a misspelled nested group key', () => [{ AND: [{ OR: [{ conditons: [stock(1)] }] }] }],
    'returned a group with unknown key conditons'],
  ['an unknown condition key', () => [{ conditions: [{ field: 'stock', operator: 'GTE', value: 1, extra: true }] }],
    'condition on stock has unknown key extra'],
  ['terms on a condition', () => [{ conditions: [{ field: 'stock', operator: 'GTE', value: 1, terms: [] }] }],
    'condition on stock has unknown key terms'],
  ['a condition that is not an object', () => [{ conditions: [null] }], 'returned a condition that is not a plain object with a field name'],
  ['a condition without a field', () => [{ conditions: [{ operator: 'EQ', value: 1 }] }],
    'returned a condition that is not a plain object with a field name'],
  ['an unknown field', () => [{ conditions: [{ field: 'nope', operator: 'EQ', value: 1 }] }], 'names nope, which is not a field of NvItem'],
  ['an unknown field below a reference', () => [{ conditions: [{ field: 'shop', path: 'nope', operator: 'EQ', value: 1 }] }],
    'names shop.nope, which is not a field of NvShop'],
  ['a path past a scalar', () => [{ conditions: [{ field: 'stock.value', operator: 'EQ', value: 1 }] }],
    'names stock.value, which is past NvItem.stock, whose type Int has no fields'],
  ['a virtual field', () => [{ conditions: [{ field: 'score', operator: 'EQ', value: 1 }] }], 'names score, which is the virtual field NvItem.score'],
  ['a condition with a __scope key', () => [{ conditions: [{ field: 'stock', operator: 'GTE', value: 1, __scope: { id: 0 } }] }],
    'condition on stock carries a __scope key, which Simfinity reserves'],
])('fails with INVALID_VIEW when where returns %s', async (label, where, message) => {
  const { schema, calls } = build({ where });
  const result = await run(schema, '{ openItems(pagination: { page: 1, size: 10, count: true }) { id } }');
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0].message).toBe(`View openItems where ${message}`);
  expect(result.errors[0].extensions).toMatchObject({ code: 'INVALID_VIEW', status: 500 });
  expect(calls).toEqual([]);
});

test.each(['AND', 'OR'])('rejects an ancestor cycle through %s with INVALID_VIEW before find or count', async (key) => {
  const group = {};
  group[key] = [{ AND: [group] }];
  const { schema, calls } = build({ where: () => [group] });
  const result = await run(schema, '{ openItems(pagination: { page: 1, size: 10, count: true }) { id } }');
  expect(result.errors).toHaveLength(1);
  expect(result.errors[0]).toMatchObject({
    message: expect.stringContaining('cyclic group'),
    extensions: { code: 'INVALID_VIEW', status: 500 },
  });
  expect(result.data.openItems).toBeNull();
  expect(calls).toEqual([]);
});

test('accepts empty groups and a group shared between separate branches', async () => {
  const shared = stock(1);
  const groups = [{}, { conditions: [], AND: [], OR: [] }, { AND: [shared], OR: [shared] }, shared];
  const { schema, calls } = build({ where: () => groups });
  const context = { user: { tenant: 'A' } };
  const result = await run(schema, '{ openItems(pagination: { page: 1, size: 10, count: true }) { id } }', context);
  expect(result.errors).toBeUndefined();
  expect(ids(result.data.openItems)).toEqual(['i1']);
  expect(context.count).toBe(1);
  expect(calls.map((call) => call.method)).toEqual(['find', 'count']);
  for (const call of calls) expect(call.args.AND).toEqual([...groups, tenant('A')]);
});

test('keeps condition values opaque, including structural and reserved marker keys', async () => {
  const value = { condition: { field: 'unknown' }, terms: [], __scope: { id: 123 }, AND: 'data' };
  const calls = [];
  const runtime = createRuntime(createRecordingAdapter(calls, [{ _id: 'd1' }]));
  const Data = new GraphQLScalarType({ name: 'NvOpaqueData', serialize: (data) => data });
  const Doc = new GraphQLObjectType({ name: 'NvOpaqueDoc', fields: { id: { type: GraphQLID }, data: { type: Data } } });
  runtime.connect(null, Doc, 'nvOpaqueDoc', 'nvOpaqueDocs');
  runtime.registerView('opaqueDocs', {
    type: Doc, description: 'Match opaque data',
    where: () => [{ conditions: [{ field: 'data', operator: 'EQ', value }] }],
  });
  const context = {};
  const result = await run(runtime.createSchema(), '{ opaqueDocs(pagination: { page: 1, size: 10, count: true }) { id } }', context);
  expect(result.errors).toBeUndefined();
  expect(result.data.opaqueDocs).toEqual([{ id: 'd1' }]);
  expect(context.count).toBe(1);
  expect(calls.map((call) => call.method)).toEqual(['find', 'count']);
  for (const call of calls) expect(call.args.AND[0].conditions[0].value).toEqual(value);
});

// A param may not take the name of a field of the base type, so the shop's ID is shopId.
const shopItems = {
  params: { shopId: { type: new GraphQLNonNull(GraphQLID) } },
  where: ({ params }) => [{ conditions: [{ field: 'shop', path: 'id', operator: 'EQ', value: params.shopId }] }],
};

test('gives a where reference path the joined find scope of its target', async () => {
  const { schema, calls } = build({ views: { shopItems } });
  const opened = await run(schema, '{ shopItems(shopId: "s2") { id } }', { user: { tenant: 'A' }, openOnly: true });
  expect(opened.errors).toBeUndefined();
  expect(ids(opened.data.shopItems)).toEqual([]); // s2 is CLOSED
  // Joined scopes are prefixed into dotted fields and land inside the where group, as for a client group.
  expect(calls[0].args.AND).toEqual([
    {
      conditions: [{ field: 'shop', path: 'id', operator: 'EQ', value: 's2' }],
      AND: [{ conditions: [{ field: 'shop.state', operator: 'EQ', value: 'OPEN' }] }],
    },
    tenant('A'),
  ]);

  const all = await run(schema, '{ shopItems(shopId: "s2") { id } }');
  expect(all.errors).toBeUndefined();
  expect(ids(all.data.shopItems)).toEqual(['i2']);
});

test('marks a where emptiness condition through a reference on the same issued map as the client arguments', async () => {
  const { schema, calls } = build({
    queryFeatures: { operators: OPERATORS, referenceEmptiness: true },
    views: { orphanItems: { where: () => [{ conditions: [{ field: 'shop', operator: 'IS_EMPTY' }] }] } },
  });
  const result = await run(schema, `{ orphanItems(AND: [{ conditions: [{ field: "shop", path: "name",
    operator: IS_NOT_EMPTY }] }]) { id } }`);
  expect(result.errors).toBeUndefined();
  const { AND } = calls[0].args;
  expect(AND[0].conditions[0]).toMatchObject({ field: 'shop', path: 'name', operator: 'IS_NOT_EMPTY' });
  // Both markers are filled: the shop's find scope adds nothing for this caller.
  expect(AND[0].conditions[0].__scope).toEqual({ id: 0, scopes: { shop: null } }); // the client's condition
  expect(AND[1].conditions[0]).toMatchObject({ field: 'shop', operator: 'IS_EMPTY' });
  expect(AND[1].conditions[0].__scope).toEqual({ id: 1, scopes: { shop: null } }); // the where condition
  // Markers live on conditions, never on groups.
  expect(AND.some((group) => Object.hasOwn(group, '__scope'))).toBe(false);
});

test('lets where name fields that are not queryable by clients, which the client still may not name', async () => {
  const { schema, calls } = build({
    views: {
      firstItems: {
        where: () => [{ conditions: [{ field: 'code', operator: 'EQ', value: 'c1' }, { field: 'label', operator: 'EQ', value: 'first' }] }],
      },
    },
  });
  const result = await run(schema, '{ firstItems { id } }');
  expect(result.errors).toBeUndefined();
  expect(ids(result.data.firstItems)).toEqual(['i1']);
  expect(calls[0].args.AND).toEqual([
    { conditions: [{ field: 'code', operator: 'EQ', value: 'c1' }, { field: 'label', operator: 'EQ', value: 'first' }] },
    tenant('A'),
  ]);

  for (const field of ['code', 'label']) {
    const client = await run(schema, `{ firstItems(AND: [{ conditions: [{ field: "${field}", operator: EQ, value: "c1" }] }]) { id } }`);
    expect(client.errors[0].extensions).toMatchObject({ code: 'FORBIDDEN_FILTER_PATH', status: 403 });
  }
  expect(calls).toHaveLength(1);
});

test('fails with UNSUPPORTED_QUERY when where uses an emptiness operator through a reference and the adapter does not declare it', async () => {
  const { schema, calls } = build({
    queryFeatures: { operators: OPERATORS },
    views: { orphanItems: { where: () => [{ conditions: [{ field: 'shop', operator: 'IS_EMPTY' }] }] } },
  });
  const result = await run(schema, '{ orphanItems { id } }');
  expect(result.errors[0].extensions).toMatchObject({ code: 'UNSUPPORTED_QUERY', status: 400 });
  expect(calls).toEqual([]);
});

test('fails with FILTER_DEPTH_EXCEEDED when where nests an emptiness condition at depth 6', async () => {
  // Groups in args.AND are at depth 0, so the innermost group is at depth 6.
  let group = { conditions: [{ field: 'name', operator: 'IS_EMPTY' }] };
  for (let level = 0; level < 6; level += 1) group = { AND: [group] };
  const { schema, calls } = build({ queryFeatures: { operators: OPERATORS }, where: () => [group] });
  const result = await run(schema, '{ openItems { id } }');
  expect(result.errors[0].extensions).toMatchObject({ code: 'FILTER_DEPTH_EXCEEDED', status: 400 });
  expect(calls).toEqual([]);
});

test('does not mutate the groups where returns across requests', async () => {
  const groups = [
    { conditions: [{ field: 'stock', operator: 'GTE', value: 1 }, { field: 'shop', path: 'id', operator: 'EQ', value: 's1' }] },
    { conditions: [{ field: 'shop', path: 'name', operator: 'IS_NOT_EMPTY' }] },
  ];
  const snapshot = structuredClone(groups);
  const { schema, calls } = build({
    queryFeatures: { operators: OPERATORS, referenceEmptiness: true },
    where: () => groups,
  });
  const opened = await run(schema, '{ openItems { id } }', { user: { tenant: 'A' }, openOnly: true });
  const all = await run(schema, '{ openItems { id } }');
  expect(opened.errors).toBeUndefined();
  expect(all.errors).toBeUndefined();
  expect(ids(opened.data.openItems)).toEqual(['i1']);
  expect(ids(all.data.openItems)).toEqual(['i1']);
  // The first request joined the shop scope into its copy of the group and marked its copy of the emptiness condition.
  expect(calls[0].args.AND[0].AND).toEqual([{ conditions: [{ field: 'shop.state', operator: 'EQ', value: 'OPEN' }] }]);
  expect(calls[0].args.AND[1].conditions[0].__scope).toMatchObject({ id: 0 });
  expect(calls[1].args.AND[0]).not.toHaveProperty('AND');
  expect(groups).toEqual(snapshot); // no __scope, no AND appended by joined scopes
});

test('splits the params by the names the schema was built with', async () => {
  const where = vi.fn(() => []);
  const params = { minStock: { type: GraphQLInt, defaultValue: 1 } };
  const { schema, calls } = build({ views: { counted: { params, where } } });
  // Changing the params object after createSchema does not change how that schema's arguments are split.
  delete params.minStock;
  params.tenant = { type: GraphQLString };
  const result = await run(schema, '{ counted(minStock: 2, tenant: { operator: EQ, value: "A" }) { id } }');
  expect(result.errors).toBeUndefined();
  expect(where.mock.calls[0][0].params).toEqual({ minStock: 2 });
  expect(calls[0].args).toMatchObject({ tenant: { operator: 'EQ', value: 'A' } });
  expect(calls[0].args).not.toHaveProperty('minStock');
});
