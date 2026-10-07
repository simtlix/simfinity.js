import {
  describe, it, expect, beforeAll,
} from 'vitest';
import {
  GraphQLObjectType,
  GraphQLInputObjectType,
  GraphQLSchema,
  GraphQLString,
  GraphQLFloat,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
} from 'graphql';
import * as simfinity from '../packages/mongodb/src/index.js';
import { auth, createRuntime } from '../packages/core/src/index.js';

describe('MCP generation', () => {
  let schema;

  const AuthorType = new GraphQLObjectType({
    name: 'McpAuthor',
    fields: () => ({
      id: { type: GraphQLString },
      name: { type: GraphQLString },
    }),
  });

  const BookType = new GraphQLObjectType({
    name: 'McpBook',
    description: 'A book in the catalog.',
    fields: () => ({
      id: { type: GraphQLString },
      title: { type: new GraphQLNonNull(GraphQLString), description: 'The book title.' },
      rating: { type: GraphQLFloat },
      pages: { type: GraphQLInt },
      state: { type: GraphQLString },
      author: {
        type: AuthorType,
        extensions: {
          relation: {
            embedded: false,
            connectionField: 'author_id',
          },
        },
      },
    }),
  });

  const NotifyInput = new GraphQLInputObjectType({
    name: 'McpNotifyInput',
    fields: () => ({
      bookId: { type: new GraphQLNonNull(GraphQLString) },
    }),
  });

  const NotifyResult = new GraphQLObjectType({
    name: 'McpNotifyResult',
    fields: () => ({
      ok: { type: GraphQLString },
    }),
  });

  const bookStateMachine = {
    initialState: { name: 'DRAFT', value: 'DRAFT' },
    actions: {
      publish: {
        from: { name: 'DRAFT', value: 'DRAFT' },
        to: { name: 'PUBLISHED', value: 'PUBLISHED' },
        description: 'Publish the book',
      },
    },
  };

  beforeAll(() => {
    simfinity.preventCreatingCollection(true);

    simfinity.addNoEndpointType(AuthorType);
    simfinity.connect(
      null,
      BookType,
      'mcpbook',
      'mcpbooks',
      null,
      null,
      bookStateMachine,
    );
    simfinity.registerMutation(
      'notifyMcpBook',
      'Send a notification about a book',
      NotifyInput,
      NotifyResult,
      async () => ({ ok: 'sent' }),
    );

    schema = simfinity.createSchema();
  });

  describe('exports', () => {
    it('exposes the MCP public API', () => {
      expect(typeof simfinity.generateMCPTools).toBe('function');
      expect(typeof simfinity.graphqlArgsToJSONSchema).toBe('function');
      expect(typeof simfinity.createMCPServer).toBe('function');
      expect(typeof simfinity.startStdioMCPServer).toBe('function');
      expect(typeof simfinity.createHTTPMCPHandler).toBe('function');
      expect(simfinity.mcp).toBeDefined();
      expect(typeof simfinity.mcp.generateMCPTools).toBe('function');
    });
  });

  describe('generateMCPTools', () => {
    it('generates one tool per generated GraphQL operation', () => {
      const { tools } = simfinity.generateMCPTools(schema);
      const names = tools.map((tool) => tool.name);

      expect(names).toContain('mcpbook');
      expect(names).toContain('mcpbooks');
      expect(names).toContain('mcpbooks_aggregate');
      expect(names).toContain('addmcpbook');
      expect(names).toContain('updatemcpbook');
      expect(names).toContain('deletemcpbook');
      expect(names).toContain('publish_mcpbook');
      expect(names).toContain('notifyMcpBook');
    });

    it('tags tools with their GraphQL operation kind', () => {
      const { tools } = simfinity.generateMCPTools(schema);
      const single = tools.find((tool) => tool.name === 'mcpbook');
      const add = tools.find((tool) => tool.name === 'addmcpbook');

      expect(single.kind).toBe('query');
      expect(add.kind).toBe('mutation');
    });

    it('throws for an invalid schema', () => {
      expect(() => simfinity.generateMCPTools(null)).toThrow();
      expect(() => simfinity.generateMCPTools({})).toThrow();
    });

    it('throws when remote execution lacks an endpoint', () => {
      expect(() => simfinity.generateMCPTools(schema, { execution: { mode: 'remote' } }))
        .toThrow();
    });

    it('respects include/exclude filters', () => {
      const { tools: onlyAdd } = simfinity.generateMCPTools(schema, { include: ['addmcpbook'] });
      expect(onlyAdd.map((tool) => tool.name)).toEqual(['addmcpbook']);

      const { tools: noMutations } = simfinity.generateMCPTools(schema, { exclude: ['mutation'] });
      expect(noMutations.every((tool) => tool.kind === 'query')).toBe(true);
    });
  });

  describe('inputSchema generation', () => {
    let tools;

    beforeAll(() => {
      ({ tools } = simfinity.generateMCPTools(schema));
    });

    it('marks NonNull mutation input as required and references its input type', () => {
      const add = tools.find((tool) => tool.name === 'addmcpbook');
      expect(add.inputSchema.type).toBe('object');
      expect(add.inputSchema.required).toContain('input');
      expect(add.inputSchema.properties.input).toEqual({ $ref: '#/$defs/McpBookInput' });
      expect(add.inputSchema.$defs.McpBookInput).toBeDefined();
    });

    it('maps GraphQL scalars to JSON Schema primitives', () => {
      const add = tools.find((tool) => tool.name === 'addmcpbook');
      const bookInput = add.inputSchema.$defs.McpBookInput;
      expect(bookInput.properties.title).toMatchObject({ type: 'string' });
      expect(bookInput.properties.rating).toEqual({ type: ['number', 'null'] });
      expect(bookInput.properties.pages).toEqual({ type: ['integer', 'null'] });
      expect(bookInput.required).toContain('title');
    });

    it('exposes full-fidelity filter/pagination/sort arguments on list queries', () => {
      const list = tools.find((tool) => tool.name === 'mcpbooks');
      expect(list.inputSchema.properties.pagination.anyOf).toEqual([{ $ref: '#/$defs/QLPagination' }, { type: 'null' }]);
      expect(list.inputSchema.properties.sort.anyOf).toEqual([{ $ref: '#/$defs/QLSortExpression' }, { type: 'null' }]);
      expect(list.inputSchema.properties.AND).toMatchObject({
        type: ['array', 'null'],
        items: { anyOf: [{ $ref: '#/$defs/QLFilterGroup' }, { type: 'null' }] },
      });
      expect(list.inputSchema.properties.OR).toMatchObject({
        type: ['array', 'null'],
        items: { anyOf: [{ $ref: '#/$defs/QLFilterGroup' }, { type: 'null' }] },
      });
    });

    it('handles recursive input types via $defs/$ref', () => {
      const list = tools.find((tool) => tool.name === 'mcpbooks');
      const group = list.inputSchema.$defs.QLFilterGroup;
      expect(group).toBeDefined();
      expect(group.properties.AND).toEqual({
        type: ['array', 'null'],
        items: { anyOf: [{ $ref: '#/$defs/QLFilterGroup' }, { type: 'null' }] },
      });
    });

    it('represents enums as string enumerations', () => {
      const list = tools.find((tool) => tool.name === 'mcpbooks');
      const operator = list.inputSchema.$defs.QLOperator;
      expect(operator.type).toBe('string');
      expect(operator.enum).toContain('EQ');
      expect(operator.enum).toContain('LIKE');
    });

    it('requires the aggregation argument on aggregate queries', () => {
      const aggregate = tools.find((tool) => tool.name === 'mcpbooks_aggregate');
      expect(aggregate.inputSchema.required).toContain('aggregation');
    });

    it('propagates GraphQL type and field descriptions into input $defs', () => {
      const add = tools.find((tool) => tool.name === 'addmcpbook');
      const bookInput = add.inputSchema.$defs.McpBookInput;
      expect(bookInput.description).toBe('A book in the catalog.');
      expect(bookInput.properties.title.description).toBe('The book title.');
    });

    it('supplies curated descriptions for synthetic filter types and args', () => {
      const list = tools.find((tool) => tool.name === 'mcpbooks');
      expect(list.inputSchema.$defs.QLOperator.description).toContain('EQ');
      expect(list.inputSchema.$defs.QLPagination.description).toBeTruthy();
      expect(list.inputSchema.properties.pagination.description).toBeTruthy();
      expect(list.inputSchema.properties.AND.description).toBeTruthy();
      const aggregate = tools.find((tool) => tool.name === 'mcpbooks_aggregate');
      expect(aggregate.inputSchema.properties.aggregation.description).toBeTruthy();
    });
  });

  describe('tool descriptions', () => {
    let tools;

    beforeAll(() => {
      ({ tools } = simfinity.generateMCPTools(schema));
    });

    it('generates an actionable description for list queries', () => {
      const list = tools.find((tool) => tool.name === 'mcpbooks');
      expect(list.description).toContain('McpBook');
      expect(list.description).toContain('LIKE');
      expect(list.description).toContain('pagination');
      expect(list.description).toContain('A book in the catalog.');
    });

    it('generates an actionable description for aggregate queries', () => {
      const aggregate = tools.find((tool) => tool.name === 'mcpbooks_aggregate');
      expect(aggregate.description).toContain('McpBook');
      expect(aggregate.description).toContain('SUM');
      expect(aggregate.description).toContain('aggregation');
    });

    it('describes CRUD mutations referencing the entity', () => {
      const add = tools.find((tool) => tool.name === 'addmcpbook');
      const del = tools.find((tool) => tool.name === 'deletemcpbook');
      expect(add.description).toContain('Create');
      expect(add.description).toContain('McpBook');
      expect(del.description).toContain('Delete');
    });

    it('prefers the GraphQL field description when present', () => {
      const custom = tools.find((tool) => tool.name === 'notifyMcpBook');
      expect(custom.description).toBe('Send a notification about a book');
    });
  });

  describe('output schema', () => {
    let tools;

    beforeAll(() => {
      ({ tools } = simfinity.generateMCPTools(schema));
    });

    it('wraps the return type under the field name', () => {
      const single = tools.find((tool) => tool.name === 'mcpbook');
      expect(single.outputSchema.type).toBe('object');
      expect(single.outputSchema.properties.mcpbook).toBeDefined();
      // Nullable GraphQL positions accept null in the output schema.
      expect(single.outputSchema.properties.mcpbook.type).toEqual(['object', 'null']);
      expect(single.outputSchema.properties.mcpbook.description).toBe('A book in the catalog.');
      expect(single.outputSchema.properties.mcpbook.properties.title.description).toBe('The book title.');
    });

    it('describes list queries as arrays of the entity', () => {
      const list = tools.find((tool) => tool.name === 'mcpbooks');
      expect(list.outputSchema.properties.mcpbooks.type).toEqual(['array', 'null']);
      expect(list.outputSchema.properties.mcpbooks.items.type).toEqual(['object', 'null']);
    });
  });

  describe('title and annotations', () => {
    let tools;

    beforeAll(() => {
      ({ tools } = simfinity.generateMCPTools(schema));
    });

    it('marks queries as read-only', () => {
      const list = tools.find((tool) => tool.name === 'mcpbooks');
      expect(list.title).toBe('List McpBook');
      expect(list.annotations.readOnlyHint).toBe(true);
      expect(list.annotations.openWorldHint).toBe(false);
    });

    it('marks delete as destructive and update as idempotent', () => {
      const del = tools.find((tool) => tool.name === 'deletemcpbook');
      const update = tools.find((tool) => tool.name === 'updatemcpbook');
      expect(del.annotations.destructiveHint).toBe(true);
      expect(del.annotations.idempotentHint).toBe(true);
      expect(update.annotations.idempotentHint).toBe(true);
      expect(del.annotations.readOnlyHint).toBe(false);
    });

    it('gives mutations a human-readable title', () => {
      const add = tools.find((tool) => tool.name === 'addmcpbook');
      expect(add.title).toBe('Create McpBook');
    });
  });
});

describe('MCP callTool execution', () => {
  const InputType = new GraphQLInputObjectType({
    name: 'McpStubInput',
    fields: () => ({
      name: { type: new GraphQLNonNull(GraphQLString) },
    }),
  });

  const ItemType = new GraphQLObjectType({
    name: 'McpStubItem',
    fields: () => ({
      id: { type: GraphQLString },
      name: { type: GraphQLString },
    }),
  });

  const stubSchema = new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'Query',
      fields: {
        item: {
          type: ItemType,
          args: { id: { type: new GraphQLNonNull(GraphQLString) } },
          resolve: (parent, args, context) => ({ id: args.id, name: context?.who || 'anon' }),
        },
      },
    }),
    mutation: new GraphQLObjectType({
      name: 'Mutation',
      fields: {
        addItem: {
          type: ItemType,
          args: { input: { type: new GraphQLNonNull(InputType) } },
          resolve: (parent, args) => ({ id: '1', name: args.input.name }),
        },
      },
    }),
  });

  it('executes a query in-process, passing variables and selecting output fields', async () => {
    const { callTool } = simfinity.generateMCPTools(stubSchema);
    const response = await callTool('item', { id: 'abc' });
    const payload = JSON.parse(response.content[0].text);

    expect(response.isError).toBe(false);
    expect(payload.item).toEqual({ id: 'abc', name: 'anon' });
  });

  it('returns structuredContent matching the GraphQL data', async () => {
    const { callTool } = simfinity.generateMCPTools(stubSchema);
    const response = await callTool('item', { id: 'abc' });

    expect(response.structuredContent).toEqual({ item: { id: 'abc', name: 'anon' } });
  });

  it('passes a static context through to resolvers', async () => {
    const { callTool } = simfinity.generateMCPTools(stubSchema, { context: { who: 'tester' } });
    const response = await callTool('item', { id: 'abc' });
    const payload = JSON.parse(response.content[0].text);

    expect(payload.item.name).toBe('tester');
  });

  it('supports a context factory receiving the call extra', async () => {
    const { callTool } = simfinity.generateMCPTools(stubSchema, {
      context: (extra) => ({ who: extra?.who || 'factory' }),
    });
    const response = await callTool('item', { id: 'abc' }, { who: 'fromExtra' });
    const payload = JSON.parse(response.content[0].text);

    expect(payload.item.name).toBe('fromExtra');
  });

  it('executes mutations in-process', async () => {
    const { callTool } = simfinity.generateMCPTools(stubSchema);
    const response = await callTool('addItem', { input: { name: 'New' } });
    const payload = JSON.parse(response.content[0].text);

    expect(payload.addItem.name).toBe('New');
  });

  it('flags GraphQL errors via isError', async () => {
    const { callTool } = simfinity.generateMCPTools(stubSchema);
    const response = await callTool('item', {});

    expect(response.isError).toBe(true);
  });

  it('throws for an unknown tool', async () => {
    const { callTool } = simfinity.generateMCPTools(stubSchema);
    await expect(callTool('doesNotExist', {})).rejects.toThrow();
  });
});

describe('MCP classification of entities with a field named aggregation', () => {
  const rows = [{ _id: 'r1', key: 'a', aggregation: 1 }, { _id: 'r2', key: 'b', aggregation: 10 }];
  const calls = [];
  const runtime = createRuntime({
    bind() {},
    prepare() {},
    createModel: (gqltype) => ({ name: gqltype.name }),
    castId: String,
    withTransaction: async (session, body) => body(session || {}),
    async getById(Model, id) { return rows.find((row) => row._id === id) || null; },
    async find(Model, gqltype, args) {
      calls.push({ method: 'find', args });
      return rows;
    },
    async count(Model, gqltype, args) {
      calls.push({ method: 'count', args });
      return rows.length;
    },
    async aggregate(Model, gqltype, args) {
      calls.push({ method: 'aggregate', args });
      return [{ groupId: 'a', facts: { total: 1 } }];
    },
    async findChildren() { return []; },
  });
  const MetricType = new GraphQLObjectType({
    name: 'McpMetric',
    fields: () => ({
      id: { type: GraphQLString },
      key: { type: GraphQLString },
      aggregation: { type: GraphQLInt },
    }),
  });
  runtime.connect(null, MetricType, 'mcpmetric', 'mcpmetrics');
  const schema = runtime.createSchema();

  it('lists the generated list query and returns _meta.count', async () => {
    const { tools, callTool } = simfinity.generateMCPTools(schema, { context: {} });
    const list = tools.find((tool) => tool.name === 'mcpmetrics');
    expect(list.title).toBe('List McpMetric');
    expect(list.description).toContain('List and search McpMetric');
    expect(list.inputSchema.required ?? []).not.toContain('aggregation');

    calls.length = 0;
    const response = await callTool('mcpmetrics', {
      aggregation: { operator: 'GT', value: 5 },
      pagination: { page: 1, size: 10, count: true },
    });
    expect(response.isError).toBe(false);
    expect(response._meta).toEqual({ count: 2 });
    expect(response.structuredContent.totalCount).toBe(2);
    expect(list.outputSchema.properties.totalCount).toMatchObject({ type: 'integer', minimum: 0 });
    expect(calls.map((call) => call.method).sort()).toEqual(['count', 'find']);
    for (const call of calls) expect(call.args.aggregation).toEqual({ operator: 'GT', value: 5 });
  });

  it('describes the count flag as a model-visible totalCount, not _meta.count', () => {
    const { tools } = simfinity.generateMCPTools(schema);
    const published = JSON.stringify(tools.find((tool) => tool.name === 'mcpmetrics').inputSchema);
    expect(published).toContain('as `totalCount` next to the results');
    expect(published).not.toContain('_meta.count');
  });

  it('keeps the generated _aggregate query an aggregate tool', async () => {
    const { tools, callTool } = simfinity.generateMCPTools(schema, { context: {} });
    const aggregate = tools.find((tool) => tool.name === 'mcpmetrics_aggregate');
    expect(aggregate.title).toBe('Aggregate McpMetric');
    expect(aggregate.inputSchema.required).toContain('aggregation');

    const response = await callTool('mcpmetrics_aggregate', {
      aggregation: { groupId: 'key', facts: [{ operation: 'SUM', factName: 'total', path: 'aggregation' }] },
      pagination: { page: 1, size: 10, count: true },
    });
    expect(response.isError).toBe(false);
    expect(response._meta).toBeUndefined();
    expect(response.structuredContent).not.toHaveProperty('totalCount');
    expect(aggregate.outputSchema.properties).not.toHaveProperty('totalCount');
  });

  it('classifies custom queries with an aggregation argument as aggregates, whatever its type', () => {
    // Custom fields carry no generated-operation marker, so the argument-name heuristic applies.
    const customSchema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          metricsByFilter: {
            type: new GraphQLList(MetricType),
            args: { aggregation: { type: schema.getType('QLFilter') } },
            resolve: () => [],
          },
        },
      }),
    });
    const { tools } = simfinity.generateMCPTools(customSchema);
    expect(tools.find((tool) => tool.name === 'metricsByFilter').title).toBe('Aggregate McpMetric');
  });
});

describe('MCP counted list calls keep the caller context', () => {
  const clone = (value) => JSON.parse(JSON.stringify(value));

  // In-memory adapter: find returns the first stored order and count all of
  // them, unless a test supplies its own count.
  const createStore = ({ count } = {}) => {
    const records = new Map();
    let nextId = 1;
    const adapter = {
      bind() {},
      prepare() {},
      createModel: (gqltype) => ({ name: gqltype.name }),
      castId: String,
      withTransaction: async (session, body) => body(session || {}),
      newRecord: (Model, data) => ({ ...clone(data), _id: `order-${nextId++}` }),
      async saveRecord(Model, record) {
        records.set(record._id, record);
        return record;
      },
      toObject: (record) => clone(record),
      async getById(Model, id) { return records.has(String(id)) ? clone(records.get(String(id))) : null; },
      async find() { return [...records.values()].slice(0, 1).map(clone); },
      async count(Model, gqltype, args) { return count ? count(args) : records.size; },
      async aggregate() { return []; },
      async findChildren() { return []; },
    };
    return { records, adapter };
  };

  const buildOrders = ({ rows = 0, middleware, count } = {}) => {
    const store = createStore({ count });
    const runtime = createRuntime(store.adapter);
    const LineType = new GraphQLObjectType({
      name: 'McpCountLine',
      fields: () => ({ sku: { type: GraphQLString }, note: { type: GraphQLString } }),
    });
    const OrderType = new GraphQLObjectType({
      name: 'McpCountOrder',
      fields: () => ({
        id: { type: GraphQLString },
        customer: { type: GraphQLString },
        lines: { type: new GraphQLList(LineType), extensions: { relation: { embedded: true } } },
      }),
    });
    runtime.addNoEndpointType(LineType);
    runtime.connect(null, OrderType, 'mcpcountorder', 'mcpcountorders');
    if (middleware) runtime.use(middleware);
    for (let index = 0; index < rows; index += 1) {
      store.records.set(`o${index}`, { _id: `o${index}`, customer: 'C' });
    }
    return { schema: runtime.createSchema(), store };
  };

  const counted = { pagination: { page: 1, size: 5, count: true } };
  const uncounted = { pagination: { page: 1, size: 5 } };

  class RequestContext {
    #user;

    constructor(user) { this.#user = user; }

    get user() { return this.#user; }
  }
  const sessions = new WeakMap();
  const contexts = {
    plain: { create: () => ({ user: { id: 'u' } }), read: (ctx) => ctx.user },
    'class with a #private field': { create: () => new RequestContext({ id: 'u' }), read: (ctx) => ctx.user },
    Map: { create: () => new Map([['user', { id: 'u' }]]), read: (ctx) => ctx.get('user') },
    'own-property guard': { create: () => ({ user: { id: 'u' } }), read: (ctx) => (Object.hasOwn(ctx, 'user') ? ctx.user : null) },
    spread: { create: () => ({ user: { id: 'u' } }), read: (ctx) => ({ ...ctx }).user },
    'WeakMap-keyed': {
      create: () => {
        const ctx = {};
        sessions.set(ctx, { id: 'u' });
        return ctx;
      },
      read: (ctx) => sessions.get(ctx),
    },
    frozen: { create: () => Object.freeze({ user: { id: 'u' } }), read: (ctx) => ctx.user },
  };

  it.each(Object.keys(contexts))('serves counted calls like uncounted ones with a %s context', async (name) => {
    const { create, read } = contexts[name];
    const seen = [];
    const { schema } = buildOrders({
      rows: 2,
      middleware: async (params, next) => {
        if (params.operation === 'find') {
          seen.push(params.context);
          if (!read(params.context)) throw new Error('Unauthenticated');
        }
        await next();
      },
    });
    const ctx = create();
    const { callTool } = simfinity.generateMCPTools(schema, { context: ctx });

    const plain = await callTool('mcpcountorders', uncounted);
    const total = await callTool('mcpcountorders', counted);

    expect(plain.isError, plain.content[0].text).toBe(false);
    expect(total.isError, total.content[0].text).toBe(false);
    expect(total._meta).toEqual({ count: 2 });
    expect(total.structuredContent.totalCount).toBe(2);
    expect(seen).toHaveLength(2);
    for (const value of seen) expect(value).toBe(ctx);
    if (!(ctx instanceof Map)) expect(Object.hasOwn(ctx, 'count')).toBe(false);
  });

  it('lets middleware write to the caller context on counted calls', async () => {
    const { schema } = buildOrders({
      rows: 1,
      middleware: async (params, next) => {
        params.context.tenant = 'acme';
        await next();
      },
    });
    const ctx = {};
    const response = await simfinity.generateMCPTools(schema, { context: ctx }).callTool('mcpcountorders', counted);

    expect(response._meta).toEqual({ count: 1 });
    expect(ctx).toEqual({ tenant: 'acme' });
  });

  it('runs the stock auth plugin with a #private-field context on counted calls', async () => {
    const { schema } = buildOrders({ rows: 1 });
    const plugin = auth.createAuthPlugin(
      { RootQueryType: { mcpcountorders: auth.requireAuth() } },
      { defaultPolicy: 'ALLOW' },
    );
    const { callTool } = simfinity.generateMCPTools(schema, {
      context: () => new RequestContext({ id: 'u' }),
      schemaPlugins: [plugin],
    });
    const response = await callTool('mcpcountorders', counted);

    expect(response.isError, response.content[0].text).toBe(false);
    expect(response._meta).toEqual({ count: 1 });
  });

  it('counts with a context factory that returns null', async () => {
    const { schema } = buildOrders({ rows: 4 });
    const response = await simfinity.generateMCPTools(schema, { context: () => null }).callTool('mcpcountorders', counted);

    expect(response.isError, response.content[0].text).toBe(false);
    expect(response.structuredContent.totalCount).toBe(4);
  });

  it('keeps concurrent counted calls on one shared context isolated (guard)', async () => {
    const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
    // Each call's total is ten times its page size; the smaller page answers last.
    const { schema } = buildOrders({
      rows: 1,
      count: async (args) => {
        await wait(args.pagination.size === 1 ? 30 : 1);
        return args.pagination.size * 10;
      },
    });
    const shared = {};
    const { callTool } = simfinity.generateMCPTools(schema, { context: shared });
    const [slow, fast] = await Promise.all([
      callTool('mcpcountorders', { pagination: { page: 1, size: 1, count: true } }),
      callTool('mcpcountorders', { pagination: { page: 1, size: 2, count: true } }),
    ]);

    expect(slow._meta).toEqual({ count: 10 });
    expect(fast._meta).toEqual({ count: 20 });
    expect(Object.hasOwn(shared, 'count')).toBe(false);
  });

  it('never writes a count that middleware requested onto the caller context', async () => {
    const { schema } = buildOrders({
      rows: 2,
      middleware: async (params, next) => {
        params.args = { ...params.args, pagination: { ...params.args.pagination, count: true } };
        await next();
      },
    });
    const shared = {};
    const response = await simfinity.generateMCPTools(schema, { context: shared }).callTool('mcpcountorders', uncounted);

    expect(response.isError).toBe(false);
    // Only a count the call itself requested is reported.
    expect(response._meta).toBeUndefined();
    expect(Object.hasOwn(shared, 'count')).toBe(false);
  });

  it('marks generated find fields with extensions.simfinityQuery.countSink', () => {
    const { schema } = buildOrders();
    const fields = schema.getQueryType().getFields();

    expect(fields.mcpcountorders.extensions.simfinityQuery).toEqual({ typeName: 'McpCountOrder', operation: 'find', countSink: true });
    expect(fields.mcpcountorders_aggregate.extensions.simfinityQuery).toEqual({ typeName: 'McpCountOrder', operation: 'aggregate' });
  });

  it('keeps the context layer for a find field without the countSink marker (guard)', async () => {
    const seen = [];
    const { schema } = buildOrders({
      rows: 2,
      middleware: async (params, next) => {
        seen.push(params.context);
        await next();
      },
    });
    delete schema.getQueryType().getFields().mcpcountorders.extensions.simfinityQuery.countSink;
    const shared = {};
    const response = await simfinity.generateMCPTools(schema, { context: shared }).callTool('mcpcountorders', counted);

    expect(response._meta).toEqual({ count: 2 });
    expect(seen[0]).not.toBe(shared);
    expect(Object.getPrototypeOf(seen[0])).toBe(shared);
    expect(Object.hasOwn(shared, 'count')).toBe(false);
  });

  it.each(['plain', 'frozen'])('counts through a resolver wrapper that forwards only three arguments: %s context (guard)', async (kind) => {
    const { schema } = buildOrders({ rows: 3 });
    const wrapper = {
      onSchemaChange({ schema: changed }) {
        const field = changed.getQueryType().getFields().mcpcountorders;
        const original = field.resolve;
        field.resolve = (parent, args, context) => original(parent, args, context);
      },
    };
    const ctx = kind === 'frozen' ? Object.freeze({}) : {};
    const { callTool } = simfinity.generateMCPTools(schema, { context: ctx, schemaPlugins: [wrapper] });
    const response = await callTool('mcpcountorders', counted);

    expect(response.isError, response.content[0].text).toBe(false);
    expect(response._meta).toEqual({ count: 3 });
    expect(Object.hasOwn(ctx, 'count')).toBe(false);
  });

  it('gives resolvers and auth rules the same root value on counted and uncounted calls (guard)', async () => {
    const { schema } = buildOrders({ rows: 1 });
    const parents = [];
    const plugin = auth.createAuthPlugin({
      RootQueryType: {
        mcpcountorders: (parent) => {
          parents.push(parent);
          return true;
        },
      },
    }, { defaultPolicy: 'ALLOW' });
    const { callTool } = simfinity.generateMCPTools(schema, { context: {}, schemaPlugins: [plugin] });
    await callTool('mcpcountorders', uncounted);
    await callTool('mcpcountorders', counted);

    expect(parents).toHaveLength(2);
    expect(typeof parents[0]).toBe(typeof parents[1]);
    expect(Object.getPrototypeOf(parents[0] ?? {})).toBe(Object.getPrototypeOf(parents[1] ?? {}));
  });

  it('reports an oversized generated add as applied, with the id of the stored record', async () => {
    const { schema, store } = buildOrders();
    const { callTool } = simfinity.generateMCPTools(schema, { limits: { maxResultBytes: 4096 } });
    const input = {
      customer: 'ACME',
      lines: Array.from({ length: 100 }, (unused, index) => ({ sku: `SKU-${index}`, note: 'n'.repeat(100) })),
    };
    const response = await callTool('addmcpcountorder', { input });

    expect(response.isError).toBe(false);
    expect(response.structuredContent.addmcpcountorder).toEqual({ id: 'order-1' });
    expect(response.structuredContent.truncated.message).toContain('addmcpcountorder was applied (the record was created)');
    expect(response.structuredContent.truncated.message).toContain('do not call addmcpcountorder again for this change');
    expect([...store.records.keys()]).toEqual(['order-1']);
  });
});

describe('MCP unknown arguments on generated tools', () => {
  const rows = new Map();
  const calls = [];
  const runtime = createRuntime({
    bind() {},
    prepare() {},
    createModel: (gqltype) => ({ name: gqltype.name }),
    castId: String,
    withTransaction: async (session, body) => body(session || {}),
    async getById(Model, id) {
      calls.push('getById');
      return rows.has(String(id)) ? { ...rows.get(String(id)) } : null;
    },
    async find() {
      calls.push('find');
      return [...rows.values()].map((row) => ({ ...row }));
    },
    async count() { return rows.size; },
    async aggregate() {
      calls.push('aggregate');
      return [];
    },
    async findChildren() { return []; },
    async delete(Model, id) {
      calls.push('delete');
      const row = rows.get(String(id));
      rows.delete(String(id));
      return row;
    },
  });
  const BookType = new GraphQLObjectType({
    name: 'McpArgBook',
    fields: () => ({
      id: { type: GraphQLString },
      title: { type: GraphQLString },
    }),
  });
  runtime.connect(null, BookType, 'mcpargbook', 'mcpargbooks');
  const schema = runtime.createSchema();
  const firstError = (result) => JSON.parse(result.content[0].text).errors[0];
  const reset = () => {
    rows.clear();
    rows.set('b1', { _id: 'b1', id: 'b1', title: 'Dune' });
    rows.set('b2', { _id: 'b2', id: 'b2', title: 'Emma' });
    calls.length = 0;
  };

  it('rejects a misspelled filter, a guessed page size and a guessed dryRun without running them', async () => {
    const { callTool } = simfinity.generateMCPTools(schema);
    reset();
    const list = firstError(await callTool('mcpargbooks', { titel: { operator: 'EQ', value: 'Dune' }, limit: 1 }));
    expect(list.extensions.code).toBe('MCP_UNKNOWN_ARGUMENT');
    expect(list.message).toContain('Did you mean "title" instead of "titel"?');
    expect(list.message).toContain('pagination');
    const aggregate = firstError(await callTool('mcpargbooks_aggregate', {
      aggregation: { groupId: 'title', facts: [{ operation: 'COUNT', factName: 'n', path: 'id' }] },
      titel: { operator: 'EQ', value: 'Dune' },
    }));
    expect(aggregate.extensions.code).toBe('MCP_UNKNOWN_ARGUMENT');
    const removal = firstError(await callTool('deletemcpargbook', { id: 'b1', dryRun: true }));
    expect(removal.extensions.code).toBe('MCP_UNKNOWN_ARGUMENT');
    expect(removal.message).toContain('The tool was not executed.');

    expect(calls).toEqual([]);
    expect([...rows.keys()]).toEqual(['b1', 'b2']);
  });

  it('serves get-by-id when middleware adds a filter group to every query tool', async () => {
    // Generated get tools declare only id: the injected AND is not the caller's.
    const { callTool } = simfinity.generateMCPTools(schema, {
      toolMiddleware: (call, next) => {
        if (call.kind === 'query') {
          call.args = { ...call.args, AND: [{ conditions: [{ field: 'title', operator: 'NE', value: 'x' }] }] };
        }
        return next();
      },
    });
    reset();
    const one = await callTool('mcpargbook', { id: 'b2' });
    expect(one.isError).toBe(false);
    expect(one.structuredContent).toEqual({ mcpargbook: { id: 'b2', title: 'Emma' } });
    expect((await callTool('mcpargbooks', {})).structuredContent.mcpargbooks).toHaveLength(2);
    // The same key sent by the agent to the get tool is still rejected.
    expect(firstError(await callTool('mcpargbook', { id: 'b2', AND: [] })).extensions.code).toBe('MCP_UNKNOWN_ARGUMENT');
  });
});
