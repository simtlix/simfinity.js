import { describe, expect, it, vi } from 'vitest';
import {
  GraphQLBoolean,
  GraphQLID,
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
  graphql,
  parse,
} from 'graphql';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { auth, createRuntime } from '../packages/core/src/index.js';
import { generateMCPTools } from '../packages/mcp/src/index.js';

const createTestRuntime = () => createRuntime({
  withTransaction: async (session, body) => body(session || { adapter: 'test' }),
});

describe('custom queries through GraphQL and MCP', () => {
  it('executes a no-input scalar query through GraphQL and MCP without a mutation root', async () => {
    const runtime = createTestRuntime();
    runtime.registerCustomQuery('availabilityStatus', 'Read availability status', null, GraphQLString,
      () => 'available');
    const schema = runtime.createSchema();

    const result = await graphql({ schema, source: '{ availabilityStatus }' });

    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual({ availabilityStatus: 'available' });

    const { tools, callTool, getOperation } = generateMCPTools(schema);
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      name: 'availabilityStatus',
      kind: 'query',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    });
    expect(parse(getOperation('availabilityStatus')).definitions[0].operation).toBe('query');
    const response = await callTool('availabilityStatus', {});
    expect(response.isError).toBe(false);
    expect(response.structuredContent).toEqual({ availabilityStatus: 'available' });
    const validate = new AjvJsonSchemaValidator().getValidator(tools[0].outputSchema);
    expect(validate(response.structuredContent).valid).toBe(true);
  });

  it('enforces RootQueryType authorization before invoking a registered callback', async () => {
    const runtime = createTestRuntime();
    const callback = vi.fn((input, context) => `shop:${context.user.shopId}`);
    runtime.registerCustomQuery('privateAvailability', 'Read shop availability', null, GraphQLString,
      callback);
    const schema = runtime.createSchema();
    const plugin = auth.createAuthPlugin({
      RootQueryType: { privateAvailability: auth.requireAuth() },
    }, { defaultPolicy: 'DENY' });
    plugin.onSchemaChange({ schema });

    const denied = await graphql({ schema, source: '{ privateAvailability }', contextValue: {} });

    expect(denied.errors).toHaveLength(1);
    expect(denied.errors[0].extensions.code).toBe('UNAUTHENTICATED');
    expect(denied.data).toEqual({ privateAvailability: null });
    expect(callback).not.toHaveBeenCalled();

    const allowed = await graphql({
      schema,
      source: '{ privateAvailability }',
      contextValue: { user: { shopId: 'shop-1' } },
    });
    expect(allowed.errors).toBeUndefined();
    expect(allowed.data).toEqual({ privateAvailability: 'shop:shop-1' });
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('denies a custom query without a RootQueryType rule under the DENY default policy', async () => {
    const runtime = createTestRuntime();
    const callback = vi.fn(() => 'secret');
    runtime.registerCustomQuery('unruledReport', 'Report without a rule', null, GraphQLString, callback);
    runtime.registerCustomQuery('ruledReport', 'Report with a rule', null, GraphQLString, () => 'public');
    const schema = runtime.createSchema();
    const plugin = auth.createAuthPlugin({ RootQueryType: { ruledReport: true } }, { defaultPolicy: 'DENY' });
    plugin.onSchemaChange({ schema });

    const result = await graphql({ schema, source: '{ unruledReport ruledReport }', contextValue: { user: {} } });

    expect(result.data).toEqual({ unruledReport: null, ruledReport: 'public' });
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatchObject({ path: ['unruledReport'], extensions: { code: 'FORBIDDEN' } });
    expect(callback).not.toHaveBeenCalled();
  });

  it('applies MCP schemaPlugins to the root and output fields of registered queries', async () => {
    const runtime = createTestRuntime();
    const output = new GraphQLObjectType({
      name: 'RegisteredQueryPrivateAvailability',
      fields: {
        startsAt: { type: GraphQLString },
        privateNote: { type: GraphQLString },
      },
    });
    const callback = vi.fn(() => ({ startsAt: '10:00', privateNote: 'staff only' }));
    runtime.registerCustomQuery('privateAvailability', 'Read shop availability', null, output,
      callback);
    const schema = runtime.createSchema();
    const plugin = auth.createAuthPlugin({
      RootQueryType: { privateAvailability: auth.requireAuth() },
      RegisteredQueryPrivateAvailability: {
        startsAt: true,
        privateNote: (parent, args, context) => context.user.role === 'admin',
      },
    }, { defaultPolicy: 'DENY' });
    const { tools, callTool } = generateMCPTools(schema, {
      context: (extra) => ({ user: extra?.user }),
      schemaPlugins: [plugin],
    });

    const denied = await callTool('privateAvailability', {});
    expect(denied.isError).toBe(true);
    expect(JSON.parse(denied.content[0].text).errors[0].extensions.code).toBe('UNAUTHENTICATED');
    expect(callback).not.toHaveBeenCalled();

    const member = await callTool('privateAvailability', {}, { user: { role: 'member' } });
    const partial = JSON.parse(member.content[0].text);
    expect(member.isError).toBe(true);
    expect(partial.data).toEqual({ privateAvailability: { startsAt: '10:00', privateNote: null } });
    expect(partial.errors).toHaveLength(1);
    expect(partial.errors[0]).toMatchObject({
      path: ['privateAvailability', 'privateNote'],
      extensions: { code: 'FORBIDDEN' },
    });

    const admin = await callTool('privateAvailability', {}, { user: { role: 'admin' } });
    expect(admin.isError).toBe(false);
    expect(admin.structuredContent).toEqual({
      privateAvailability: { startsAt: '10:00', privateNote: 'staff only' },
    });
    const validate = new AjvJsonSchemaValidator().getValidator(tools[0].outputSchema);
    expect(validate(admin.structuredContent).valid).toBe(true);
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('keeps custom input and list output schemas without CRUD pagination, counts or path metadata', async () => {
    const runtime = createTestRuntime();
    const pagination = new GraphQLInputObjectType({
      name: 'RegisteredQueryWindow',
      fields: {
        size: { type: GraphQLInt },
        count: { type: GraphQLBoolean },
      },
    });
    const input = new GraphQLInputObjectType({
      name: 'RegisteredQueryAvailabilityInput',
      fields: {
        id: { type: new GraphQLNonNull(GraphQLID) },
        pagination: { type: pagination },
      },
    });
    const output = new GraphQLObjectType({
      name: 'RegisteredQueryBusyRange',
      fields: {
        startsAt: { type: new GraphQLNonNull(GraphQLString) },
        endsAt: { type: new GraphQLNonNull(GraphQLString) },
      },
    });
    const callback = vi.fn(() => [
      { startsAt: '10:00', endsAt: '10:30' },
      { startsAt: '11:00', endsAt: '11:30' },
    ]);
    runtime.registerCustomQuery('listBusyRanges', 'Read busy ranges for a shop', input,
      new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(output))),
      callback);
    const schema = runtime.createSchema();
    const field = schema.getQueryType().getFields().listBusyRanges;
    expect(field.extensions.simfinityQuery).toBeUndefined();
    expect(field.args.map((argument) => argument.name)).toEqual(['input']);
    const { tools, callTool, getOperation } = generateMCPTools(schema, {
      limits: { defaultPagination: { page: 1, size: 1, count: true }, maxPageSize: 1 },
    });
    expect(tools).toHaveLength(1);
    const tool = tools[0];
    expect(tool).toMatchObject({
      name: 'listBusyRanges',
      title: 'listBusyRanges',
      kind: 'query',
      annotations: { readOnlyHint: true },
      inputSchema: { required: ['input'] },
    });
    expect(Object.keys(tool.inputSchema.properties)).toEqual(['input']);
    expect(Object.keys(tool.outputSchema.properties)).toEqual(['listBusyRanges']);
    expect(parse(getOperation('listBusyRanges')).definitions[0].operation).toBe('query');

    const args = { input: { id: 'shop-1', pagination: { size: 2, count: true } } };
    const validator = new AjvJsonSchemaValidator();
    const validateInput = validator.getValidator(tool.inputSchema);
    expect(validateInput(args).valid).toBe(true);
    expect(validateInput({}).valid).toBe(false);
    const result = await callTool('listBusyRanges', args);

    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({
      listBusyRanges: [
        { startsAt: '10:00', endsAt: '10:30' },
        { startsAt: '11:00', endsAt: '11:30' },
      ],
    });
    expect(callback.mock.calls[0][0]).toEqual({ id: 'shop-1', pagination: { size: 2, count: true } });
    expect(validator.getValidator(tool.outputSchema)(result.structuredContent).valid).toBe(true);

    const noInput = await callTool('listBusyRanges', {});
    expect(noInput.isError).toBe(true);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('filters custom queries with includedCustomQueries without removing custom mutations', async () => {
    const runtime = createTestRuntime();
    runtime.registerCustomQuery('publicStatus', 'Read public status', null, GraphQLString,
      () => 'public');
    runtime.registerCustomQuery('privateStatus', 'Read private status', null, GraphQLString,
      () => 'private');
    runtime.registerMutation('legacyStatus', 'Legacy operation', null, GraphQLString, () => 'legacy');
    const schema = runtime.createSchema(undefined, undefined, undefined, { includedCustomQueries: ['publicStatus'] });

    const { tools, callTool } = generateMCPTools(schema);
    expect(tools.map((tool) => tool.name)).toEqual(['publicStatus', 'legacyStatus']);
    expect((await callTool('publicStatus', {})).structuredContent).toEqual({ publicStatus: 'public' });
    expect((await callTool('legacyStatus', {})).structuredContent).toEqual({ legacyStatus: 'legacy' });
  });

  it('keeps query-first MCP collisions and the explicitly selected legacy mutation executable', async () => {
    const runtime = createTestRuntime();
    runtime.registerCustomQuery('bookingAvailability', 'Read availability', null, GraphQLString,
      () => 'query');
    runtime.registerMutation('bookingAvailability', 'Legacy availability', null, GraphQLString,
      () => 'legacy mutation');
    const schema = runtime.createSchema();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const generated = generateMCPTools(schema);
      expect(generated.tools).toHaveLength(1);
      expect(generated.tools[0].kind).toBe('query');
      expect((await generated.callTool('bookingAvailability', {})).structuredContent)
        .toEqual({ bookingAvailability: 'query' });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('Duplicate tool name "bookingAvailability"');

      const legacy = await graphql({ schema, source: 'mutation { bookingAvailability }' });
      expect(legacy.errors).toBeUndefined();
      expect(legacy.data).toEqual({ bookingAvailability: 'legacy mutation' });
      const mutationTools = generateMCPTools(schema, { include: 'mutation' });
      expect(mutationTools.tools).toHaveLength(1);
      expect(mutationTools.tools[0]).toMatchObject({
        kind: 'mutation',
        annotations: { readOnlyHint: false },
      });
      expect((await mutationTools.callTool('bookingAvailability', {})).structuredContent)
        .toEqual({ bookingAvailability: 'legacy mutation' });
    } finally {
      warn.mockRestore();
    }
  });
  it('selects custom query tools by name, prefix, category, output type and overrides', async () => {
    const runtime = createRuntime({
      withTransaction: async (session, body) => body(session || { adapter: 'test' }),
      createModel: (type) => ({ name: type.name }),
    });
    const Quote = new GraphQLObjectType({ name: 'CustomQueryQuote', fields: { total: { type: GraphQLInt } } });
    const Shop = new GraphQLObjectType({
      name: 'CustomQueryShop',
      fields: {
        id: { type: GraphQLID },
        openSlots: {
          type: new GraphQLList(GraphQLString),
          args: { date: { type: new GraphQLNonNull(GraphQLString) } },
          extensions: { virtual: true },
          resolve: () => ['10:00'],
        },
      },
    });
    runtime.connect(null, Shop, 'shop', 'shops');
    runtime.registerCustomQuery('quotePreview', 'Price a cart without storing it', null, Quote, () => ({ total: 3 }));
    runtime.registerCustomQuery('serverTime', 'Read the server time', null, GraphQLString, () => 'now');
    runtime.registerMutation('refreshQuotes', 'Refresh quotes', null, GraphQLString, () => 'ok');
    const schema = runtime.createSchema();
    const names = (options) => generateMCPTools(schema, options).tools.map((tool) => tool.name);
    const custom = ['quotePreview', 'serverTime'];

    const { tools } = generateMCPTools(schema);
    const quote = tools.find((tool) => tool.name === 'quotePreview');
    expect(quote).toMatchObject({
      kind: 'query', title: 'quotePreview', description: 'Price a cart without storing it',
      annotations: { readOnlyHint: true },
    });
    expect(names({ exclude: 'mutation' })).toEqual(expect.arrayContaining(custom));
    expect(names({ exclude: 'query' })).not.toEqual(expect.arrayContaining(['quotePreview']));
    expect(names({ exclude: 'query' })).toEqual(expect.arrayContaining(['refreshQuotes']));
    expect(names({ include: 'query' })).toEqual(expect.arrayContaining(custom));
    expect(names({ include: 'query' })).not.toContain('refreshQuotes');
    expect(names({ include: ['quotePreview'] })).toEqual(['quotePreview']);
    expect(names({ toolNamePrefix: 'app_', include: ['app_serverTime'] })).toEqual(['app_serverTime']);
    expect(names({ toolNamePrefix: 'app_', include: 'query', exclude: ['quotePreview'] }))
      .not.toContain('app_quotePreview');
    expect(names({ includeTypes: ['CustomQueryQuote'] })).toEqual(['quotePreview']);
    expect(names({ include: 'query', excludeTypes: ['CustomQueryQuote'] })).toContain('serverTime');
    expect(names({ include: 'query', excludeTypes: ['CustomQueryQuote'] })).not.toContain('quotePreview');

    const overridden = generateMCPTools(schema, {
      toolNamePrefix: 'app_',
      include: custom,
      toolOverrides: { app_quotePreview: { title: 'Quote preview' }, serverTime: { description: 'Now' } },
    });
    expect(overridden.tools.map(({ name, title, description }) => ({ name, title, description }))).toEqual([
      { name: 'app_quotePreview', title: 'Quote preview', description: 'Price a cart without storing it' },
      { name: 'app_serverTime', title: 'serverTime', description: 'Now' },
    ]);
    expect((await overridden.callTool('app_quotePreview', {})).structuredContent)
      .toEqual({ quotePreview: { total: 3 } });
  });

  it('gives a custom query named like a virtual field tool that tool name', async () => {
    const runtime = createRuntime({
      withTransaction: async (session, body) => body(session || { adapter: 'test' }),
      createModel: (type) => ({ name: type.name }),
    });
    const Shop = new GraphQLObjectType({
      name: 'CustomQueryVirtualShop',
      fields: {
        id: { type: GraphQLID },
        openSlots: {
          type: new GraphQLList(GraphQLString),
          args: { date: { type: new GraphQLNonNull(GraphQLString) } },
          extensions: { virtual: true },
          resolve: () => ['10:00'],
        },
      },
    });
    runtime.connect(null, Shop, 'shop', 'shops');
    runtime.registerCustomQuery('shop_openSlots', 'Open slots across shops', null, GraphQLString, () => 'custom');
    const schema = runtime.createSchema();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { tools, callTool } = generateMCPTools(schema, { include: 'query' });
      expect(tools.filter((tool) => tool.name === 'shop_openSlots')).toHaveLength(1);
      expect((await callTool('shop_openSlots', {})).structuredContent).toEqual({ shop_openSlots: 'custom' });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0][0]).toContain('shop_openSlots');
    } finally {
      warn.mockRestore();
    }
  });
});
