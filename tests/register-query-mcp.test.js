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

describe('registered queries through GraphQL and MCP', () => {
  it('executes a no-input scalar query through GraphQL and MCP without a mutation root', async () => {
    const runtime = createTestRuntime();
    runtime.registerQuery('availabilityStatus', 'Read availability status', null, GraphQLString,
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
    const callback = vi.fn((input, session, context) => `shop:${context.user.shopId}`);
    runtime.registerQuery('privateAvailability', 'Read shop availability', null, GraphQLString,
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
    runtime.registerQuery('privateAvailability', 'Read shop availability', null, output,
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
    runtime.registerQuery('listBusyRanges', 'Read busy ranges for a shop', input,
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

  it('filters custom queries with the fourth schema allowlist without removing legacy mutations', async () => {
    const runtime = createTestRuntime();
    runtime.registerQuery('publicStatus', 'Read public status', null, GraphQLString,
      () => 'public');
    runtime.registerQuery('privateStatus', 'Read private status', null, GraphQLString,
      () => 'private');
    runtime.registerMutation('legacyStatus', 'Legacy operation', null, GraphQLString, () => 'legacy');
    const schema = runtime.createSchema(undefined, undefined, undefined, ['publicStatus']);

    const { tools, callTool } = generateMCPTools(schema);
    expect(tools.map((tool) => tool.name)).toEqual(['publicStatus', 'legacyStatus']);
    expect((await callTool('publicStatus', {})).structuredContent).toEqual({ publicStatus: 'public' });
    expect((await callTool('legacyStatus', {})).structuredContent).toEqual({ legacyStatus: 'legacy' });
  });

  it('keeps query-first MCP collisions and the explicitly selected legacy mutation executable', async () => {
    const runtime = createTestRuntime();
    runtime.registerQuery('bookingAvailability', 'Read availability', null, GraphQLString,
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
});
