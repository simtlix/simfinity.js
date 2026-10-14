import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import http from 'node:http';
import {
  graphql,
  parse,
  validate,
  validateSchema,
  execute,
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  GraphQLList,
  GraphQLNonNull,
} from 'graphql';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { generateMCPTools, createHTTPMCPHandler } from '../packages/mcp/src/index.js';

// Pass-through spies on the graphql-js entry points MCP imports. vi.mock is
// hoisted and file-scoped, so MCP's own import of 'graphql' gets the spies.
vi.mock('graphql', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    graphql: vi.fn(actual.graphql),
    parse: vi.fn(actual.parse),
    validate: vi.fn(actual.validate),
    validateSchema: vi.fn(actual.validateSchema),
    execute: vi.fn(actual.execute),
  };
});

const ItemType = new GraphQLObjectType({
  name: 'McpCacheItem',
  fields: { id: { type: GraphQLString }, name: { type: GraphQLString } },
});

const makeSchema = () => new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    fields: {
      item: {
        type: ItemType,
        args: { id: { type: new GraphQLNonNull(GraphQLString) } },
        resolve: (parent, args) => ({ id: args.id, name: 'Cached' }),
      },
      items: {
        type: new GraphQLList(ItemType),
        resolve: () => [{ id: '1', name: 'One' }, { id: '2', name: 'Two' }],
      },
    },
  }),
});

const counts = () => ({
  graphql: graphql.mock.calls.length,
  parse: parse.mock.calls.length,
  validate: validate.mock.calls.length,
  execute: execute.mock.calls.length,
});

const resources = [];

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await Promise.all(resources.splice(0).map((close) => close()));
});

describe('MCP prepared tool operations', () => {
  it('parses and validates each tool operation once and executes it on every call', async () => {
    const { callTool, getOperation } = generateMCPTools(makeSchema());

    for (let i = 0; i < 3; i += 1) {
      expect((await callTool('items', {})).structuredContent).toEqual({ items: [{ id: '1', name: 'One' }, { id: '2', name: 'Two' }] });
    }
    for (let i = 0; i < 2; i += 1) {
      expect((await callTool('item', { id: String(i) })).structuredContent).toEqual({ item: { id: String(i), name: 'Cached' } });
    }

    expect(counts()).toEqual({
      graphql: 0, parse: 2, validate: 2, execute: 5,
    });
    expect(parse.mock.calls.map(([source]) => source)).toEqual([getOperation('items'), getOperation('item')]);
    // The schema is still validated on every call (graphql-js caches the result).
    expect(validateSchema).toHaveBeenCalledTimes(5);
    // Every execution gets the same document, and each call its own variables.
    const documents = execute.mock.calls.map(([args]) => args.document);
    expect(new Set(documents).size).toBe(2);
    expect(execute.mock.calls.map(([args]) => args.variableValues)).toEqual([{}, {}, {}, { id: '0' }, { id: '1' }]);
  });

  it('keeps the validation errors of an invalid selection and does not re-validate them', async () => {
    const { callTool } = generateMCPTools(makeSchema(), { toolOverrides: { item: { selection: 'id nope' } } });

    const first = await callTool('item', { id: '1' });
    const second = await callTool('item', { id: '1' });

    expect(first.isError).toBe(true);
    expect(second.content[0].text).toBe(first.content[0].text);
    expect(JSON.parse(first.content[0].text).errors[0].message).toBe('Cannot query field "nope" on type "McpCacheItem". Did you mean "name"?');
    expect(counts()).toEqual({
      graphql: 0, parse: 1, validate: 1, execute: 0,
    });
  });

  it('prepares the operation only after asynchronous schemaPlugins finish', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    let parsedBeforeInstall;
    const { callTool } = generateMCPTools(makeSchema(), {
      schemaPlugins: [{
        async onSchemaChange({ schema }) {
          await gate;
          const field = schema.getQueryType().getFields().items;
          const { resolve } = field;
          field.resolve = (...args) => resolve(...args).slice(0, 1);
          parsedBeforeInstall = parse.mock.calls.length;
        },
      }],
    });

    const pending = callTool('items', {});
    await new Promise((resolve) => { setTimeout(resolve, 10); });
    expect(parse).not.toHaveBeenCalled();
    release();

    expect((await pending).structuredContent).toEqual({ items: [{ id: '1', name: 'One' }] });
    expect(parsedBeforeInstall).toBe(0);
    expect(counts()).toEqual({
      graphql: 0, parse: 1, validate: 1, execute: 1,
    });
  });

  it('shares the prepared operation across Streamable HTTP requests', async () => {
    const handler = await createHTTPMCPHandler(makeSchema());
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => { raw += chunk; });
      req.on('end', () => {
        if (raw) req.body = JSON.parse(raw);
        handler(req, res);
      });
    });
    await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    resources.push(async () => {
      server.closeAllConnections();
      await new Promise((resolve) => { server.close(resolve); });
    });
    const client = new Client({ name: 'mcp-cache-http-client', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
    resources.unshift(() => client.close());

    for (const id of ['a', 'b', 'c']) {
      const result = await client.callTool({ name: 'item', arguments: { id } });
      expect(result.structuredContent).toEqual({ item: { id, name: 'Cached' } });
    }

    expect(counts()).toEqual({
      graphql: 0, parse: 1, validate: 1, execute: 3,
    });
  });
});
