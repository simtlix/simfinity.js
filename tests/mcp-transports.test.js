import {
  describe, it, expect, beforeAll, afterAll, vi,
} from 'vitest';
import http from 'node:http';
import {
  GraphQLObjectType,
  GraphQLEnumType,
  GraphQLList,
  GraphQLSchema,
  GraphQLString,
  GraphQLNonNull,
} from 'graphql';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import * as simfinity from '../src/index.js';

// ---------------------------------------------------------------------------
// Stub schema (unique McpTrans* names).
// ---------------------------------------------------------------------------

const ItemType = new GraphQLObjectType({
  name: 'McpTransItem',
  fields: () => ({
    id: { type: GraphQLString },
    name: { type: GraphQLString },
  }),
});

const WhoType = new GraphQLObjectType({
  name: 'McpTransWho',
  fields: () => ({
    auth: { type: GraphQLString },
  }),
});

// List-shaped return type with a nullable enum field and a nullable nested
// object relation: exercises the nullable widening of the output schema for
// array/nested/enum shapes end-to-end (the SDK client validates with Ajv).
const MoodEnum = new GraphQLEnumType({
  name: 'McpTransMood',
  values: { HAPPY: {}, SAD: {} },
});

const TagType = new GraphQLObjectType({
  name: 'McpTransTag',
  fields: () => ({
    id: { type: GraphQLString },
    label: { type: GraphQLString },
  }),
});

const EntryType = new GraphQLObjectType({
  name: 'McpTransEntry',
  fields: () => ({
    id: { type: GraphQLString },
    mood: { type: MoodEnum },
    tag: { type: TagType },
  }),
});

const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    fields: {
      item: {
        type: ItemType,
        args: { id: { type: new GraphQLNonNull(GraphQLString) } },
        // 'missing' simulates a get-by-id miss: the tool returns { item: null }.
        resolve: (parent, args) => (args.id === 'missing' ? null : { id: args.id, name: 'Widget' }),
      },
      whoami: {
        type: WhoType,
        resolve: (parent, args, context) => ({ auth: (context && context.auth) || null }),
      },
      entries: {
        type: new GraphQLList(EntryType),
        resolve: () => [
          { id: '1', mood: 'HAPPY', tag: { id: 't1', label: 'first' } },
          { id: '2', mood: null, tag: null },
        ],
      },
    },
  }),
});

// ---------------------------------------------------------------------------
// createMCPServer over a linked InMemoryTransport pair
// ---------------------------------------------------------------------------

describe('createMCPServer over InMemoryTransport', () => {
  let server;
  let client;

  beforeAll(async () => {
    server = await simfinity.createMCPServer(schema, {
      serverName: 'mcp-trans-test',
      serverVersion: '0.0.1',
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'mcp-trans-test-client', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    // Caches outputSchema validators client-side, so every callTool below also
    // validates structuredContent against the published schema.
    await client.listTools();
  });

  afterAll(async () => {
    await client.close();
    await server.close();
  });

  it('lists tools with title, annotations and outputSchema', async () => {
    const { tools } = await client.listTools();
    const item = tools.find((tool) => tool.name === 'item');

    expect(item).toBeDefined();
    expect(item.title).toBe('Get McpTransItem');
    expect(item.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: false });
    expect(item.outputSchema).toBeDefined();
    expect(item.outputSchema.properties.item.type).toEqual(['object', 'null']);
    expect(item.inputSchema.required).toContain('id');
  });

  it('calls a tool end-to-end with SDK-side output schema validation', async () => {
    // The SDK client validates structuredContent against the cached
    // outputSchema and rejects on mismatch, so this passing IS the
    // nullable-output-schema integration check.
    const result = await client.callTool({ name: 'item', arguments: { id: '42' } });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ item: { id: '42', name: 'Widget' } });
    expect(JSON.parse(result.content[0].text)).toEqual({ item: { id: '42', name: 'Widget' } });
  });

  it('validates a null get-by-id miss against the nullable output schema', async () => {
    const result = await client.callTool({ name: 'item', arguments: { id: 'missing' } });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ item: null });
  });

  it('validates a list result with a null enum and a null nested relation against the output schema', async () => {
    // The SDK client validates structuredContent against the published
    // outputSchema with Ajv: passing proves the nullable widening works for
    // array items, nested object relations and enum values end-to-end.
    const result = await client.callTool({ name: 'entries', arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      entries: [
        { id: '1', mood: 'HAPPY', tag: { id: 't1', label: 'first' } },
        { id: '2', mood: null, tag: null },
      ],
    });
  });

  it('surfaces GraphQL errors as isError tool results', async () => {
    // Missing required arg: graphql reports a variable coercion error.
    const result = await client.callTool({ name: 'item', arguments: {} });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.errors.length).toBeGreaterThan(0);
  });

  it('rejects unknown tools with a protocol-level error', async () => {
    await expect(client.callTool({ name: 'no_such_tool', arguments: {} }))
      .rejects.toThrow(/no_such_tool/);
  });
});

// ---------------------------------------------------------------------------
// createHTTPMCPHandler over Streamable HTTP
// ---------------------------------------------------------------------------

describe('createHTTPMCPHandler over Streamable HTTP', () => {
  let httpServer;
  let baseUrl;

  beforeAll(async () => {
    const handler = await simfinity.createHTTPMCPHandler(schema, {
      serverName: 'mcp-trans-http',
      serverVersion: '0.0.1',
      // Per-request context factory: receives the Express-style request.
      context: (req) => ({ auth: req.headers.authorization || null }),
    });

    // Minimal express.json() stand-in: parse the JSON body onto req.body.
    httpServer = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        if (raw) {
          try {
            req.body = JSON.parse(raw);
          } catch {
            req.body = raw;
          }
        }
        handler(req, res);
      });
    });
    await new Promise((resolve) => { httpServer.listen(0, '127.0.0.1', resolve); });
    baseUrl = `http://127.0.0.1:${httpServer.address().port}/mcp`;
  });

  afterAll(async () => {
    // Drop undici's keep-alive sockets so close() resolves immediately instead
    // of stalling ~4s until the idle connections time out on their own.
    httpServer.closeAllConnections();
    await new Promise((resolve) => { httpServer.close(resolve); });
  });

  it('serves tool calls and passes the HTTP request to the context factory', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(baseUrl), {
      requestInit: { headers: { authorization: 'Bearer secret-token' } },
    });
    const client = new Client({ name: 'mcp-trans-http-client', version: '1.0.0' });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain('whoami');

      // The Authorization header travels: request -> context factory -> resolver.
      const result = await client.callTool({ name: 'whoami', arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ whoami: { auth: 'Bearer secret-token' } });
    } finally {
      await client.close();
    }
  });

  it('answers a raw JSON-RPC initialize POST', async () => {
    const response = await fetch(baseUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'raw-fetch-client', version: '0.0.0' },
        },
      }),
    });

    expect(response.status).toBe(200);
    // Stateless transport streams the response as SSE by default; the payload
    // still carries the JSON-RPC initialize result.
    const text = await response.text();
    expect(text).toContain('serverInfo');
    expect(text).toContain('mcp-trans-http');
  });

  it('invokes onError and responds 500 JSON-RPC when the handler fails on garbage input', async () => {
    const onError = vi.fn();
    const failingHandler = await simfinity.createHTTPMCPHandler(schema, { onError });

    const res = {
      on: vi.fn(),
      headersSent: false,
      writeHead: vi.fn(),
      end: vi.fn(),
    };
    // Garbage request: reading req.body inside the handler throws a TypeError,
    // which must be routed through onError and answered with a JSON-RPC 500.
    await failingHandler(null, res);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(res.writeHead).toHaveBeenCalledWith(500, { 'content-type': 'application/json' });
    const body = JSON.parse(res.end.mock.calls[0][0]);
    expect(body).toEqual({
      jsonrpc: '2.0',
      error: { code: -32603, message: 'Internal server error' },
      id: null,
    });
  });

  it('still responds 500 when onError itself throws', async () => {
    const failingHandler = await simfinity.createHTTPMCPHandler(schema, {
      onError: () => {
        throw new Error('onError exploded');
      },
    });

    const res = {
      on: vi.fn(),
      headersSent: false,
      writeHead: vi.fn(),
      end: vi.fn(),
    };
    await failingHandler(null, res);

    expect(res.writeHead).toHaveBeenCalledWith(500, { 'content-type': 'application/json' });
  });
});
