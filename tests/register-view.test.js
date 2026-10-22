import { expect, test, vi } from 'vitest';
import {
  GraphQLEnumType, GraphQLID, GraphQLInputObjectType, GraphQLInt, GraphQLList, GraphQLNonNull,
  GraphQLObjectType, GraphQLScalarType, GraphQLString, graphql, validateSchema,
} from 'graphql';
import { createRuntime } from '../packages/core/src/runtime.js';

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
  expect(scoped).toEqual([clientArgs]);
  expect(calls).toEqual([{ method: 'find', args: clientArgs }, { method: 'count', args: clientArgs }]);

  // A param the client omits arrives with its default, and is stripped as well.
  await graphql({ schema, source: '{ openItems(shop: "s1") { id } }', contextValue: {} });
  expect(seen[1].args).toEqual({});
  expect(scoped[1]).toEqual({});
  expect(calls[2]).toEqual({ method: 'find', args: {} });
});
