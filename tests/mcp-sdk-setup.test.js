import {
  describe, it, expect, afterEach, vi,
} from 'vitest';
import {
  graphql, GraphQLObjectType, GraphQLSchema, GraphQLString,
} from 'graphql';

// SDK modules the MCP package imports dynamically. Module mocks need their own
// file: each test mocks some of them and loads a fresh copy of the package.
const SERVER = '@modelcontextprotocol/sdk/server/index.js';
const TYPES = '@modelcontextprotocol/sdk/types.js';
const STDIO = '@modelcontextprotocol/sdk/server/stdio.js';
const HTTP = '@modelcontextprotocol/sdk/server/streamableHttp.js';

const loadMcp = async (mocks) => {
  vi.resetModules();
  for (const [path, factory] of Object.entries(mocks)) {
    vi.doMock(path, factory);
  }
  return import('../packages/mcp/src/index.js');
};

afterEach(() => {
  for (const path of [SERVER, TYPES, STDIO, HTTP]) {
    vi.doUnmock(path);
  }
  vi.resetModules();
});

// A schema whose resolver a deny plugin would replace.
const guarded = () => {
  const schema = new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'McpSetupQuery',
      fields: { secret: { type: GraphQLString, resolve: () => 'open' } },
    }),
  });
  const original = schema.getQueryType().getFields().secret.resolve;
  const plugin = {
    onSchemaChange: vi.fn(({ schema: target }) => {
      target.getQueryType().getFields().secret.resolve = () => {
        throw new Error('denied by auth plugin');
      };
    }),
  };
  return { schema, original, plugin };
};

const expectUntouched = async ({ schema, original, plugin }) => {
  expect(plugin.onSchemaChange).not.toHaveBeenCalled();
  expect(schema.getQueryType().getFields().secret.resolve).toBe(original);
  expect(await graphql({ schema, source: '{ secret }' })).toEqual({ data: { secret: 'open' } });
};

const incompatible = (what) => ({
  extensions: { code: 'MCP_SDK_INCOMPATIBLE' },
  message: `The installed "@modelcontextprotocol/sdk" does not provide ${what}; install a supported version with: npm install @modelcontextprotocol/sdk@^1.31.0`,
});

describe('MCP SDK loading before schemaPlugins', () => {
  it('reports a stdio module without StdioServerTransport before running schemaPlugins', async () => {
    const mcp = await loadMcp({ [STDIO]: () => ({ StdioServerTransport: undefined }) });
    const fixture = guarded();

    await expect(mcp.startStdioMCPServer(fixture.schema, { schemaPlugins: [fixture.plugin] }))
      .rejects.toMatchObject(incompatible('the stdio transport'));
    await expectUntouched(fixture);
  });

  it('reports a stdio module that fails to load before running schemaPlugins', async () => {
    const mcp = await loadMcp({
      [STDIO]: () => {
        throw new Error('stdio exploded');
      },
    });
    const fixture = guarded();

    await expect(mcp.startStdioMCPServer(fixture.schema, { schemaPlugins: [fixture.plugin] }))
      .rejects.toMatchObject({ extensions: { code: 'MCP_SDK_LOAD_FAILED' } });
    await expectUntouched(fixture);
  });

  it.each(['createMCPServer', 'startStdioMCPServer', 'createHTTPMCPHandler'])('%s reports a server module without Server as MCP_SDK_INCOMPATIBLE before running schemaPlugins', async (factory) => {
    const mcp = await loadMcp({ [SERVER]: () => ({ Server: undefined }) });
    const fixture = guarded();

    await expect(mcp[factory](fixture.schema, { schemaPlugins: [fixture.plugin] }))
      .rejects.toMatchObject(incompatible('the MCP Server API'));
    await expectUntouched(fixture);
  });

  it.each(['createMCPServer', 'startStdioMCPServer', 'createHTTPMCPHandler'].flatMap((factory) => (
    ['CallToolRequestSchema', 'ListToolsRequestSchema'].map((missing) => [factory, missing])
  )))('%s reports a types module without %s as MCP_SDK_INCOMPATIBLE before running schemaPlugins (guard)', async (factory, missing) => {
    const mcp = await loadMcp({ [TYPES]: async (importOriginal) => ({ ...(await importOriginal()), [missing]: undefined }) });
    const fixture = guarded();

    await expect(mcp[factory](fixture.schema, { schemaPlugins: [fixture.plugin] }))
      .rejects.toMatchObject(incompatible('the MCP Server API'));
    await expectUntouched(fixture);
  });

  it('createHTTPMCPHandler reports a Streamable HTTP module without the transport before running schemaPlugins', async () => {
    const mcp = await loadMcp({ [HTTP]: () => ({ StreamableHTTPServerTransport: undefined }) });
    const fixture = guarded();

    await expect(mcp.createHTTPMCPHandler(fixture.schema, { schemaPlugins: [fixture.plugin] }))
      .rejects.toMatchObject(incompatible('the Streamable HTTP transport'));
    await expectUntouched(fixture);
  });

  it.each([
    ['server module without Server', { [SERVER]: () => ({ Server: undefined }) }, 'the MCP Server API'],
    ['Streamable HTTP module without the transport', { [HTTP]: () => ({ StreamableHTTPServerTransport: undefined }) }, 'the Streamable HTTP transport'],
  ])('createHTTPMCPHandler reports a %s before rejecting stateful transportOptions', async (label, mocks, what) => {
    const mcp = await loadMcp(mocks);
    const fixture = guarded();

    await expect(mcp.createHTTPMCPHandler(fixture.schema, {
      transportOptions: { sessionIdGenerator: () => 'session' },
      schemaPlugins: [fixture.plugin],
    })).rejects.toMatchObject(incompatible(what));
    await expectUntouched(fixture);
  });

  it('createHTTPMCPHandler rejects stateful transportOptions before running schemaPlugins (guard)', async () => {
    const mcp = await loadMcp({});
    const fixture = guarded();

    await expect(mcp.createHTTPMCPHandler(fixture.schema, {
      transportOptions: { eventStore: {} },
      schemaPlugins: [fixture.plugin],
    })).rejects.toMatchObject({ extensions: { code: 'MCP_INVALID_TRANSPORT_OPTIONS' } });
    await expectUntouched(fixture);
  });

  it('startStdioMCPServer runs schemaPlugins once and connects the stdio transport (guard)', async () => {
    const events = [];
    class FakeStdioTransport {
      async start() { events.push('start'); }

      async send() {}

      async close() { events.push('close'); }
    }
    const mcp = await loadMcp({ [STDIO]: () => ({ StdioServerTransport: FakeStdioTransport }) });
    const fixture = guarded();

    const server = await mcp.startStdioMCPServer(fixture.schema, { schemaPlugins: [fixture.plugin] });
    expect(fixture.plugin.onSchemaChange).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['start']);
    await server.close();
    expect(events).toEqual(['start', 'close']);
  });
});
