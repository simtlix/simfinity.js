import {
  describe, it, expect, afterEach, vi,
} from 'vitest';
import http from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import {
  graphql,
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLInputObjectType,
  GraphQLEnumType,
  GraphQLScalarType,
  GraphQLString,
  GraphQLNonNull,
  GraphQLList,
  GraphQLInt,
  GraphQLBoolean,
} from 'graphql';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  generateMCPTools, createMCPServer, createHTTPMCPHandler,
} from '../packages/mongodb/src/mcp.js';
import { createValidatedScalar, scalars } from '../packages/mongodb/src/index.js';

// Resolve the SDK's AJV version without adding a dependency or loading the
// different AJV version used by ESLint. Unlike the SDK defaults, enable schema
// meta-validation so invalid metadata cannot hide behind successful data checks.
const resolveFromSdk = createRequire(createRequire(import.meta.url).resolve('@modelcontextprotocol/sdk/validation/ajv'));
const { default: Ajv2020 } = await import(pathToFileURL(resolveFromSdk.resolve('ajv/dist/2020.js')).href);

const makeSchema = (fields, mutationFields) => new GraphQLSchema({
  query: new GraphQLObjectType({ name: 'Query', fields }),
  mutation: mutationFields ? new GraphQLObjectType({ name: 'Mutation', fields: mutationFields }) : undefined,
});

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

const resources = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(resources.splice(0).map((close) => close()));
});

const listen = async (handler) => {
  const server = http.createServer(handler);
  await new Promise((resolve) => { server.listen(0, '127.0.0.1', resolve); });
  resources.push(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => { server.close(resolve); });
  });
  return `http://127.0.0.1:${server.address().port}/graphql`;
};

const errorCode = (result) => JSON.parse(result.content[0].text).errors?.[0]?.extensions?.code;

describe('MCP GraphQL input contracts', () => {
  const State = new GraphQLEnumType({
    name: 'McpContractState',
    values: { OPEN: { value: 1 }, CLOSED: { value: 2 } },
  });
  const Preferences = new GraphQLInputObjectType({
    name: 'McpContractPreferences',
    fields: () => ({
      label: { type: GraphQLString },
      state: { type: State, defaultValue: 2 },
      labels: { type: new GraphQLList(GraphQLString) },
      requiredLabels: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
      children: { type: new GraphQLList(Preferences) },
    }),
  });
  const defaultsSchema = makeSchema({
    defaults: {
      type: GraphQLString,
      args: {
        mode: { type: new GraphQLNonNull(GraphQLString), defaultValue: 'fast "mode"\nnext' },
        state: { type: new GraphQLNonNull(State), defaultValue: 1 },
        prefs: { type: new GraphQLNonNull(Preferences), defaultValue: { label: 'saved', state: 2 } },
      },
      resolve: (parent, args) => JSON.stringify(args),
    },
  });

  it('executes omitted non-null defaults using their external GraphQL literal forms', async () => {
    const { callTool, tools } = generateMCPTools(defaultsSchema);
    expect(tools[0].inputSchema.required).toBeUndefined();
    const result = await callTool('defaults');
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.structuredContent.defaults)).toEqual({
      mode: 'fast "mode"\nnext', state: 1, prefs: { label: 'saved', state: 2 },
    });
  });

  it('keeps explicit argument values and rejects explicit null for non-null defaults', async () => {
    const { callTool } = generateMCPTools(defaultsSchema);
    const supplied = await callTool('defaults', { mode: 'slow', state: 'CLOSED', prefs: { label: 'new' } });
    expect(JSON.parse(supplied.structuredContent.defaults)).toEqual({
      mode: 'slow', state: 2, prefs: { label: 'new', state: 2 },
    });
    expect((await callTool('defaults', { mode: null })).isError).toBe(true);
  });

  it('preserves validated custom scalar defaults through GraphQL serialization', async () => {
    const scalar = new GraphQLScalarType({
      name: 'McpContractScalar',
      serialize: (value) => value.label,
      parseValue: (value) => ({ label: value }),
      parseLiteral: (node) => ({ label: node.value }),
    });
    const schema = makeSchema({
      echo: {
        type: GraphQLString,
        args: { value: { type: new GraphQLNonNull(scalar), defaultValue: { label: 'saved' } } },
        resolve: (parent, args) => args.value.label,
      },
    });
    expect((await generateMCPTools(schema).callTool('echo')).structuredContent).toEqual({ echo: 'saved' });
  });

  it('keeps opaque non-null scalar arguments and list items non-null in the input contract', () => {
    const scalar = new GraphQLScalarType({ name: 'McpContractOpaque', serialize: (value) => value });
    const schema = makeSchema({
      echo: {
        type: GraphQLString,
        args: {
          required: { type: new GraphQLNonNull(scalar) },
          optional: { type: scalar },
          items: { type: new GraphQLList(new GraphQLNonNull(scalar)) },
        },
      },
    });
    const { tools } = generateMCPTools(schema);
    const validate = new AjvJsonSchemaValidator().getValidator(tools[0].inputSchema);
    expect(validate({ required: null }).valid).toBe(false);
    expect(validate({ required: {}, optional: null, items: [null] }).valid).toBe(false);
    expect(validate({ required: {}, optional: null, items: [{}] }).valid).toBe(true);
  });

  it('retains a scalar default that cannot be represented as a GraphQL literal', async () => {
    const scalar = new GraphQLScalarType({ name: 'McpContractObjectScalar', serialize: (value) => value });
    const schema = makeSchema({
      echo: {
        type: GraphQLString,
        args: { value: { type: new GraphQLNonNull(scalar), defaultValue: { label: 'saved' } } },
        resolve: (parent, args) => args.value.label,
      },
    });
    const { callTool } = generateMCPTools(schema);
    expect((await callTool('echo')).structuredContent).toEqual({ echo: 'saved' });
    expect((await callTool('echo', { value: null })).isError).toBe(true);
  });

  it('accepts nullable input objects, nested fields, enum values and list items in SDK validation and execution', async () => {
    const schema = makeSchema({
      echo: {
        type: GraphQLString,
        args: { prefs: { type: Preferences } },
        resolve: (parent, args) => JSON.stringify(args.prefs),
      },
    });
    const server = await createMCPServer(schema);
    const client = new Client({ name: 'mcp-contract-client', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    resources.push(async () => { await client.close(); await server.close(); });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const { tools } = await client.listTools();
    const validate = new AjvJsonSchemaValidator().getValidator(tools[0].inputSchema);
    const cases = [null, {
      label: null,
      state: null,
      labels: ['one', null],
      requiredLabels: null,
      children: [null, { label: null, state: null }],
    }];
    for (const prefs of cases) {
      expect(validate({ prefs }).valid).toBe(true);
      const result = await client.callTool({ name: 'echo', arguments: { prefs } });
      expect(result.isError).toBe(false);
      expect(JSON.parse(result.structuredContent.echo)).toEqual(prefs);
    }
    expect(validate({ prefs: { requiredLabels: [null] } }).valid).toBe(false);
    expect((await client.callTool({ name: 'echo', arguments: { prefs: { requiredLabels: [null] } } })).isError).toBe(true);
  });

  it.each(['constructor', 'toString'])('resolves JSON Schema definitions for the inherited name %s', async (name) => {
    const type = name === 'constructor'
      ? new GraphQLInputObjectType({ name, fields: { label: { type: GraphQLString } } })
      : new GraphQLEnumType({ name, values: { OPEN: { value: 1 } } });
    const schema = makeSchema({
      echo: {
        type: GraphQLString,
        args: { value: { type: new GraphQLNonNull(type) } },
        resolve: (parent, args) => JSON.stringify(args.value),
      },
    });
    const { tools, callTool } = generateMCPTools(schema);
    expect(() => new Ajv2020({ strict: false }).compile(tools[0].inputSchema)).not.toThrow();
    const validate = new AjvJsonSchemaValidator().getValidator(tools[0].inputSchema);
    const value = name === 'constructor' ? { label: 'valid' } : 'OPEN';
    expect(validate({ value }).valid).toBe(true);
    expect((await callTool('echo', { value })).isError).toBe(false);
  });

  it('publishes valid schema metadata for inherited scalar and argument names', () => {
    const scalar = new GraphQLScalarType({ name: 'constructor', serialize: (value) => value });
    const schema = makeSchema({
      echo: { type: scalar, args: { toString: { type: GraphQLString }, value: { type: scalar } } },
    });
    const { tools } = generateMCPTools(schema);
    expect(() => new Ajv2020({ strict: false }).compile(tools[0].inputSchema)).not.toThrow();
    expect(() => new Ajv2020({ strict: false }).compile(tools[0].outputSchema)).not.toThrow();
  });

  it('publishes the root JSON type and own description of chained validated scalars', async () => {
    const Corporate = createValidatedScalar('McpContractCorporate', 'Corporate email address', scalars.EmailScalar, (value) => {
      if (!value.endsWith('@example.com')) {
        throw new Error('Not a corporate address');
      }
    });
    const Even = createValidatedScalar('McpContractEven', 'An even positive integer', scalars.PositiveIntScalar, (value) => {
      if (value % 2 !== 0) {
        throw new Error('Not even');
      }
    });
    const schema = makeSchema({
      echo: {
        type: Corporate,
        args: {
          email: { type: new GraphQLNonNull(Corporate) },
          count: { type: Even },
          work: { type: Corporate, description: 'Work address' },
          label: { type: GraphQLString },
        },
        resolve: (parent, args) => args.email,
      },
    });
    const { tools, callTool } = generateMCPTools(schema);
    const { properties } = tools[0].inputSchema;
    expect(properties.email).toEqual({ type: 'string', description: 'Corporate email address' });
    expect(properties.count).toEqual({ type: ['integer', 'null'], description: 'An even positive integer' });
    expect(properties.work).toEqual({ type: ['string', 'null'], description: 'Work address' });
    expect(properties.label).toEqual({ type: ['string', 'null'] });
    expect(tools[0].outputSchema.properties.echo).toEqual({ type: ['string', 'null'], description: 'Corporate email address' });

    const validate = new AjvJsonSchemaValidator().getValidator(tools[0].inputSchema);
    expect(validate({ email: 'a@example.com', count: 4 }).valid).toBe(true);
    expect(validate({ email: 'a@example.com', count: '4' }).valid).toBe(false);
    expect((await callTool('echo', { email: 'a@example.com' })).structuredContent).toEqual({ echo: 'a@example.com' });
  });

  it('publishes one-sided bounded scalar descriptions without undefined bounds', () => {
    const Title = scalars.createBoundedStringScalar('McpContractTitle', undefined, 120);
    const Score = scalars.createBoundedIntScalar('McpContractScore', null, 100);
    const schema = makeSchema({
      echo: { type: Title, args: { title: { type: Title }, score: { type: Score } }, resolve: (parent, args) => args.title },
    });
    const { tools } = generateMCPTools(schema);
    expect(tools[0].inputSchema.properties.title).toEqual({ type: ['string', 'null'], description: 'A string with at most 120 characters' });
    expect(tools[0].inputSchema.properties.score).toEqual({ type: ['integer', 'null'], description: 'An integer of at most 100' });
    expect(tools[0].outputSchema.properties.echo).toEqual({ type: ['string', 'null'], description: 'A string with at most 120 characters' });
  });

  it('stops at a cyclic baseScalarType chain', () => {
    const first = new GraphQLScalarType({ name: 'McpContractCycleA', serialize: (value) => value });
    const second = new GraphQLScalarType({ name: 'McpContractCycleB', serialize: (value) => value });
    first.baseScalarType = second;
    second.baseScalarType = first;
    const schema = makeSchema({ echo: { type: GraphQLString, args: { value: { type: first } } } });
    const { tools } = generateMCPTools(schema);
    expect(tools[0].inputSchema.properties.value).toEqual({});
  });

  it('uses a valid selection fallback when an id field returns an object at depth zero', async () => {
    const Id = new GraphQLObjectType({ name: 'McpContractObjectId', fields: { label: { type: GraphQLString } } });
    const Item = new GraphQLObjectType({
      name: 'McpContractObjectItem',
      fields: { id: { type: Id, extensions: { relation: { embedded: true } } } },
    });
    const schema = makeSchema({ item: { type: Item, resolve: () => ({ id: { label: 'nested' } }) } });
    const { callTool, tools } = generateMCPTools(schema, { selectionDepth: 0 });
    const result = await callTool('item');
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ item: { __typename: 'McpContractObjectItem' } });
    expect(new AjvJsonSchemaValidator().getValidator(tools[0].outputSchema)(result.structuredContent).valid).toBe(true);
  });
});

describe('MCP execution boundaries', () => {
  it.each([false, true])('limits error payloads including partial data: partial=%s', async (partial) => {
    const Payload = new GraphQLObjectType({
      name: 'McpContractPayload',
      fields: {
        good: { type: GraphQLString, resolve: () => 'x'.repeat(1000) },
        bad: { type: GraphQLString, resolve: () => { throw new Error('x'.repeat(1000)); } },
      },
    });
    const schema = makeSchema({
      payload: {
        type: partial ? Payload : GraphQLString,
        resolve: () => { if (!partial) { throw new Error('x'.repeat(1000)); } return {}; },
      },
    });
    const result = await generateMCPTools(schema, { limits: { maxResultBytes: 100 } }).callTool('payload');
    expect(errorCode(result)).toBe('MCP_RESULT_TOO_LARGE');
    expect(JSON.parse(result.content[0].text).data).toBeUndefined();
    expect(result.content[0].text.length).toBeLessThan(500);
  });

  it('accepts a successful payload exactly at the cap', async () => {
    const schema = makeSchema({ echo: { type: GraphQLString, resolve: () => 'ok' } });
    const result = await generateMCPTools(schema, { limits: { maxResultBytes: 18 } }).callTool('echo');
    expect(result.structuredContent).toEqual({ echo: 'ok' });
    expect(Buffer.byteLength(result.content[0].text)).toBe(18);
  });

  it('preserves partial errors and data below the cap', async () => {
    const Payload = new GraphQLObjectType({
      name: 'McpContractSmallPayload',
      fields: {
        good: { type: GraphQLString, resolve: () => 'ok' },
        bad: { type: GraphQLString, resolve: () => { throw new Error('denied'); } },
      },
    });
    const schema = makeSchema({ payload: { type: Payload, resolve: () => ({}) } });
    const result = await generateMCPTools(schema, { limits: { maxResultBytes: 1000 } }).callTool('payload');
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      errors: [{ message: 'denied' }], data: { payload: { good: 'ok', bad: null } },
    });
  });

  it('does not start a mutation cancelled while awaiting its context', async () => {
    const started = deferred();
    const context = deferred();
    let writes = 0;
    const schema = makeSchema({ ping: { type: GraphQLString } }, {
      write: { type: GraphQLString, resolve: () => { writes += 1; return 'saved'; } },
    });
    const { callTool } = generateMCPTools(schema, {
      context: async () => { started.resolve(); return context.promise; },
    });
    const controller = new AbortController();
    const pending = callTool('write', {}, { signal: controller.signal });
    await started.promise;
    controller.abort();
    context.resolve({});
    await expect(pending).rejects.toMatchObject({ extensions: { code: 'MCP_CALL_CANCELLED' } });
    expect(writes).toBe(0);
    expect((await callTool('write')).structuredContent).toEqual({ write: 'saved' });
    expect(writes).toBe(1);
  });
});

describe('MCP unknown arguments', () => {
  const calls = { item: 0, items: 0, deleteItem: 0 };
  const Filter = new GraphQLInputObjectType({ name: 'McpContractArgFilter', fields: { value: { type: GraphQLString } } });
  const Page = new GraphQLInputObjectType({
    name: 'McpContractArgPage',
    fields: { page: { type: GraphQLInt }, size: { type: GraphQLInt } },
  });
  const Item = new GraphQLObjectType({
    name: 'McpContractArgItem',
    fields: { id: { type: GraphQLString }, title: { type: GraphQLString }, owner: { type: GraphQLString } },
  });
  const schema = makeSchema({
    item: {
      type: Item,
      args: { id: { type: new GraphQLNonNull(GraphQLString) } },
      resolve: (parent, args) => { calls.item += 1; return { id: args.id }; },
    },
    items: {
      type: new GraphQLList(Item),
      args: {
        title: { type: Filter }, owner: { type: Filter }, sort: { type: GraphQLString }, pagination: { type: Page },
      },
      resolve: (parent, args) => { calls.items += 1; return [{ id: '1', title: 'Dune', owner: args.owner ? args.owner.value : null }]; },
    },
    ping: { type: GraphQLString, resolve: () => 'pong' },
  }, {
    deleteItem: {
      type: Item,
      args: { id: { type: new GraphQLNonNull(GraphQLString) } },
      resolve: (parent, args) => { calls.deleteItem += 1; return { id: args.id }; },
    },
  });
  const firstError = (result) => JSON.parse(result.content[0].text).errors[0];
  const reset = () => Object.keys(calls).forEach((key) => { calls[key] = 0; });

  it('publishes additionalProperties false on the arguments object', () => {
    const { tools } = generateMCPTools(schema);
    for (const tool of tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
    const items = tools.find((tool) => tool.name === 'items');
    const validate = new AjvJsonSchemaValidator().getValidator(items.inputSchema);
    expect(validate({ title: { value: 'Dune' } }).valid).toBe(true);
    expect(validate({ titel: { value: 'Dune' } }).valid).toBe(false);
    const ping = new AjvJsonSchemaValidator().getValidator(tools.find((tool) => tool.name === 'ping').inputSchema);
    expect(ping({}).valid).toBe(true);
    expect(ping({ verbose: true }).valid).toBe(false);
  });

  it('returns MCP_UNKNOWN_ARGUMENT without executing a query or a mutation', async () => {
    const { callTool } = generateMCPTools(schema);
    reset();
    const list = await callTool('items', { titel: { value: 'Dune' }, limit: 1 });
    expect(list.isError).toBe(true);
    expect(list.structuredContent).toBeUndefined();
    expect(firstError(list)).toEqual({
      message: 'Unknown arguments "titel", "limit" for tool "items". Did you mean "title" instead of "titel"? Valid arguments: title, owner, sort, pagination. The tool was not executed.',
      extensions: { code: 'MCP_UNKNOWN_ARGUMENT' },
    });
    // A guessed safety switch must not let the write run.
    const removal = await callTool('deleteItem', { id: '1', dryRun: true });
    expect(firstError(removal).extensions.code).toBe('MCP_UNKNOWN_ARGUMENT');
    expect(firstError(removal).message).toContain('"dryRun"');
    expect(firstError(await callTool('ping', { verbose: true })).message)
      .toBe('Unknown argument "verbose" for tool "ping". The tool takes no arguments. The tool was not executed.');
    expect(calls).toEqual({ item: 0, items: 0, deleteItem: 0 });
  });

  it.each([
    ['item', { AND: [] }, undefined],
    ['deleteItem', { id: '1', q: 'x' }, undefined],
    ['item', { ID: '1' }, '"id" instead of "ID"'],
    ['items', { Title: { value: 'x' } }, '"title" instead of "Title"'],
    ['items', { srot: 'title' }, '"sort" instead of "srot"'],
    ['items', { titles: { value: 'x' } }, '"title" instead of "titles"'],
    ['items', { sorting: 'title' }, undefined],
    ['items', { own: { value: 'x' } }, undefined],
  ])('hints only near names and never guesses id: %s %j', async (name, args, hint) => {
    const { callTool } = generateMCPTools(schema);
    const { message, extensions } = firstError(await callTool(name, args));
    expect(extensions.code).toBe('MCP_UNKNOWN_ARGUMENT');
    if (hint) {
      expect(message).toContain(`Did you mean ${hint}?`);
    } else {
      expect(message).not.toContain('Did you mean');
    }
  });

  it('ignores undefined values the caller sent (guard)', async () => {
    const { callTool } = generateMCPTools(schema);
    expect((await callTool('items', { titel: undefined })).isError).toBe(false);
  });

  it('passes keys that middleware injected and lets middleware consume keys the caller sent', async () => {
    const seen = [];
    const { callTool } = generateMCPTools(schema, {
      toolMiddleware: [
        // An owner filter injected into every call, as tenant scoping does.
        (call, next) => {
          call.args = { ...call.args, owner: { value: 'me' } };
          return next();
        },
        (call, next) => {
          if ('reason' in call.args) {
            seen.push(call.args.reason);
            if (call.args.consume) {
              delete call.args.reason;
              delete call.args.consume;
            }
          }
          return next();
        },
      ],
    });
    reset();
    // `item` does not declare owner: the injected key is not the caller's.
    expect((await callTool('item', { id: '1' })).structuredContent).toEqual({ item: { id: '1', title: null, owner: null } });
    expect((await callTool('items', {})).structuredContent.items[0].owner).toBe('me');
    expect((await callTool('items', { reason: 'audit', consume: true })).isError).toBe(false);
    const kept = firstError(await callTool('items', { reason: 'audit' }));
    expect(kept.extensions.code).toBe('MCP_UNKNOWN_ARGUMENT');
    expect(kept.message).toContain('Unknown argument "reason"');
    // The same key sent by the caller is still rejected.
    expect(firstError(await callTool('item', { id: '1', owner: 'me' })).extensions.code).toBe('MCP_UNKNOWN_ARGUMENT');
    expect(seen).toEqual(['audit', 'audit']);
    expect(calls).toEqual({ item: 1, items: 2, deleteItem: 0 });
  });

  it('lets middleware consume caller keys named like Object.prototype members', async () => {
    const { callTool } = generateMCPTools(schema, {
      toolMiddleware: (call, next) => {
        if (call.args.consume) {
          delete call.args.consume;
          delete call.args.constructor;
          // Deletes the own __proto__ key; the inherited accessor stays.
          Reflect.deleteProperty(call.args, '__proto__');
        }
        return next();
      },
    });
    reset();
    // JSON.parse, as the SDK does, makes __proto__ an own key.
    const consumed = JSON.parse('{ "id": "1", "consume": true, "constructor": "x", "__proto__": { "polluted": true } }');
    expect(Object.keys(consumed)).toEqual(['id', 'consume', 'constructor', '__proto__']);

    const result = await callTool('item', consumed);
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toEqual({ item: { id: '1', title: null, owner: null } });

    // Not consumed, the same keys are still rejected.
    const kept = firstError(await callTool('item', JSON.parse('{ "id": "1", "constructor": "x", "__proto__": { "polluted": true } }')));
    expect(kept.extensions.code).toBe('MCP_UNKNOWN_ARGUMENT');
    expect(kept.message).toContain('Unknown arguments "constructor", "__proto__" for tool "item"');
    expect(calls).toEqual({ item: 1, items: 0, deleteItem: 0 });
  });

  it('rejects before any remote request is sent', async () => {
    let requests = 0;
    const endpoint = await listen((req, res) => {
      requests += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { items: [] } }));
    });
    const { callTool } = generateMCPTools(schema, { execution: { mode: 'remote', endpoint } });
    expect(firstError(await callTool('items', { where: 'x' })).extensions.code).toBe('MCP_UNKNOWN_ARGUMENT');
    expect(requests).toBe(0);
    expect((await callTool('items', {})).isError).toBe(false);
    expect(requests).toBe(1);
  });
});

describe('MCP totalCount and truncation notice contracts', () => {
  const Pagination = new GraphQLInputObjectType({
    name: 'McpContractPagination',
    fields: { page: { type: GraphQLInt }, size: { type: GraphQLInt }, count: { type: GraphQLBoolean } },
  });
  const Row = new GraphQLObjectType({
    name: 'McpContractRow',
    fields: { id: { type: GraphQLString }, note: { type: GraphQLString } },
  });
  const schema = makeSchema({
    rows: {
      type: new GraphQLList(Row),
      args: { pagination: { type: Pagination } },
      resolve: (parent, args, context) => {
        if (args.pagination && args.pagination.count) context.count = 3;
        return [{ id: 'r1', note: 'n' }];
      },
    },
    allRows: { type: new GraphQLList(Row), resolve: () => [] },
    totalCount: {
      type: new GraphQLList(GraphQLString),
      args: { pagination: { type: Pagination } },
      resolve: (parent, args, context) => {
        context.count = 9;
        return ['a'];
      },
    },
  }, {
    addRow: { type: Row, description: 'add', resolve: () => ({ id: 'r9', note: 'x'.repeat(2000) }) },
  });
  const counted = { pagination: { page: 1, size: 1, count: true } };
  // Meta-validates the schema on compile, unlike the SDK's default validator.
  const strictValidator = (outputSchema) => new Ajv2020({ strict: false }).compile(outputSchema);
  const connect = async (server) => {
    const client = new Client({ name: 'mcp-contract-client', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    resources.push(async () => { await client.close(); await server.close(); });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    // Caches the output validators, so callTool validates structuredContent.
    return { client, tools: (await client.listTools()).tools };
  };
  const byName = (tools, name) => tools.find((tool) => tool.name === name);

  it('publishes totalCount only for list tools with a pagination argument', () => {
    const { tools } = generateMCPTools(schema);

    expect(byName(tools, 'rows').outputSchema.properties.totalCount).toMatchObject({ type: 'integer', minimum: 0 });
    expect(byName(tools, 'allRows').outputSchema.properties).not.toHaveProperty('totalCount');
    expect(byName(tools, 'totalCount').outputSchema.properties.__totalCount.description).toContain('Named __totalCount');
    expect(byName(tools, 'addRow').outputSchema.properties).not.toHaveProperty('totalCount');
    for (const tool of tools) expect(() => strictValidator(tool.outputSchema)).not.toThrow();
  });

  it('returns a counted list total that validates against the published outputSchema over the SDK client', async () => {
    const { client, tools } = await connect(await createMCPServer(schema, { context: {} }));
    const wire = await client.callTool({ name: 'rows', arguments: counted });

    expect(wire.isError).toBe(false);
    expect(wire.structuredContent).toEqual({ rows: [{ id: 'r1', note: 'n' }], totalCount: 3 });
    expect(wire.content[0].text).toContain('"totalCount": 3');
    expect(wire._meta).toEqual({ count: 3 });
    expect(strictValidator(byName(tools, 'rows').outputSchema)(wire.structuredContent)).toBe(true);
  });

  it('uses __totalCount for a list field named totalCount', async () => {
    const response = await generateMCPTools(schema, { context: {} }).callTool('totalCount', counted);

    expect(response.structuredContent).toEqual({ totalCount: ['a'], __totalCount: 9 });
    expect(response._meta).toEqual({ count: 9 });
  });

  it('declares the truncated notice only for mutations, with maxResultBytes and a generated selection', () => {
    const limited = generateMCPTools(schema, { limits: { maxResultBytes: 512 } }).tools;
    const notice = byName(limited, 'addRow').outputSchema.properties.truncated;

    expect(notice).toMatchObject({ type: 'object', required: ['applied', 'message', 'resultBytes', 'maxResultBytes'] });
    expect(byName(limited, 'rows').outputSchema.properties).not.toHaveProperty('truncated');
    expect(byName(generateMCPTools(schema).tools, 'addRow').outputSchema.properties).not.toHaveProperty('truncated');
    const overridden = generateMCPTools(schema, {
      limits: { maxResultBytes: 512 },
      toolOverrides: { addRow: { selection: '{ id }' } },
    }).tools;
    expect(byName(overridden, 'addRow').outputSchema).toBeUndefined();
  });

  it('returns an oversized mutation success that passes SDK client output validation', async () => {
    const { client, tools } = await connect(await createMCPServer(schema, { limits: { maxResultBytes: 512 } }));
    const wire = await client.callTool({ name: 'addRow', arguments: {} });

    expect(wire.isError).toBe(false);
    expect(wire._meta).toEqual({ truncated: true });
    expect(wire.structuredContent.addRow).toEqual({ id: 'r9' });
    expect(wire.structuredContent.truncated).toMatchObject({ applied: true, maxResultBytes: 512 });
    expect(strictValidator(byName(tools, 'addRow').outputSchema)(wire.structuredContent)).toBe(true);
  });

  it.each([
    [512.5, 512],
    ['600.25', 600],
  ])('reports a fractional maxResultBytes %j as %i bytes, so SDK client output validation passes', async (maxResultBytes, reported) => {
    const { client, tools } = await connect(await createMCPServer(schema, { limits: { maxResultBytes } }));
    const wire = await client.callTool({ name: 'addRow', arguments: {} });

    expect(wire.isError).toBe(false);
    expect(wire.structuredContent.addRow).toEqual({ id: 'r9' });
    expect(wire.structuredContent.truncated).toMatchObject({ applied: true, maxResultBytes: reported });
    expect(wire.structuredContent.truncated.message).toContain(`exceeds maxResultBytes (${reported})`);
    expect(strictValidator(byName(tools, 'addRow').outputSchema)(wire.structuredContent)).toBe(true);
  });

  it('applies both through createHTTPMCPHandler over Streamable HTTP', async () => {
    const handler = await createHTTPMCPHandler(schema, { limits: { maxResultBytes: 512 } });
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
    const client = new Client({ name: 'mcp-contract-http-client', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
    resources.unshift(() => client.close());

    const { tools } = await client.listTools();
    expect(byName(tools, 'addRow').outputSchema.properties).toHaveProperty('truncated');
    expect(byName(tools, 'rows').outputSchema.properties).toHaveProperty('totalCount');

    const added = await client.callTool({ name: 'addRow', arguments: {} });
    expect(added.isError).toBe(false);
    expect(added.structuredContent.addRow).toEqual({ id: 'r9' });
    const listed = await client.callTool({ name: 'rows', arguments: counted });
    expect(listed.structuredContent.totalCount).toBe(3);
  });
});

describe('MCP remote response contracts', () => {
  const schema = makeSchema({ echo: { type: GraphQLString } }, { write: { type: GraphQLString } });

  const observeBodyRead = () => {
    const started = deferred();
    const fetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (...args) => {
      const response = await fetch(...args);
      const json = response.json.bind(response);
      response.json = () => { started.resolve(); return json(); };
      return response;
    });
    return started.promise;
  };

  it.each(['echo', 'write'])('handles a timeout after headers, retrying only queries: %s', async (name) => {
    let requests = 0;
    const bodyRead = observeBodyRead();
    const endpoint = await listen((req, res) => {
      requests += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      if (requests === 1) {
        res.write('{"data":');
      } else {
        res.end(JSON.stringify({ data: { echo: 'retried' } }));
      }
    });
    const { callTool } = generateMCPTools(schema, {
      execution: { mode: 'remote', endpoint, timeoutMs: 200, retry: { attempts: 1, backoffMs: 0 } },
    });
    const pending = callTool(name);
    await bodyRead;
    const result = await pending;
    if (name === 'echo') {
      expect(result.structuredContent).toEqual({ echo: 'retried' });
      expect(requests).toBe(2);
    } else {
      expect(errorCode(result)).toBe('MCP_REMOTE_REQUEST_FAILED');
      expect(requests).toBe(1);
    }
  });

  it.each([200, 503])('rejects client cancellation during body reading without retry: HTTP %s', async (status) => {
    let requests = 0;
    const bodyRead = observeBodyRead();
    const endpoint = await listen((req, res) => {
      requests += 1;
      res.writeHead(status, { 'content-type': 'application/json' });
      res.write('{"errors":');
    });
    const controller = new AbortController();
    const { callTool } = generateMCPTools(schema, {
      execution: { mode: 'remote', endpoint, retry: { attempts: 1, backoffMs: 0 } },
    });
    const pending = callTool('echo', {}, { signal: controller.signal });
    await bodyRead;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(requests).toBe(1);
  });

  it.each([
    { errors: [] }, { errors: {} }, { errors: [null] }, { errors: [{ message: 123 }] },
    { data: [] }, { data: 'invalid' }, { data: null }, { data: {}, errors: [] },
  ])('returns a valid error result for malformed remote payload %j', async (body) => {
    const endpoint = await listen((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    const { callTool } = generateMCPTools(schema, { execution: { mode: 'remote', endpoint } });
    const result = await callTool('echo');
    expect(result.isError).toBe(true);
    expect(errorCode(result)).toBe('MCP_REMOTE_INVALID_RESPONSE');
    expect(typeof result.content[0].text).toBe('string');
  });

  it('executes generated defaults remotely with real GraphQL coercion', async () => {
    const remoteSchema = makeSchema({
      echo: {
        type: GraphQLString,
        args: { mode: { type: new GraphQLNonNull(GraphQLString), defaultValue: 'default' } },
        resolve: (parent, args) => args.mode,
      },
    });
    const endpoint = await listen((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        const { query, variables } = JSON.parse(body);
        const result = await graphql({ schema: remoteSchema, source: query, variableValues: variables });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(result));
      });
    });
    const result = await generateMCPTools(remoteSchema, { execution: { mode: 'remote', endpoint } }).callTool('echo');
    expect(result.structuredContent).toEqual({ echo: 'default' });
  });

  it('reports malformed JSON from a real remote response without retrying a successful HTTP status', async () => {
    let requests = 0;
    const endpoint = await listen((req, res) => {
      requests += 1;
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>not GraphQL</html>');
    });
    const result = await generateMCPTools(schema, {
      execution: { mode: 'remote', endpoint, retry: { attempts: 1, backoffMs: 0 } },
    }).callTool('echo');
    expect(errorCode(result)).toBe('MCP_REMOTE_INVALID_RESPONSE');
    expect(requests).toBe(1);
  });

  const headerPairs = (rawHeaders, name) => {
    const pairs = [];
    for (let index = 0; index < rawHeaders.length; index += 2) {
      if (rawHeaders[index].toLowerCase() === name) {
        pairs.push(rawHeaders[index + 1]);
      }
    }
    return pairs;
  };

  it.each([
    ['a Title-Case object', () => ({ 'Content-Type': 'application/json; charset=utf-8', Authorization: 'Bearer t' })],
    ['a Headers instance', () => new Headers({ 'Content-Type': 'application/json; charset=utf-8', Authorization: 'Bearer t' })],
    ['[name, value] pairs', () => [['Content-Type', 'application/json; charset=utf-8'], ['Authorization', 'Bearer t']]],
  ])('sends a single content type and the credentials of %s', async (label, make) => {
    const seen = [];
    const endpoint = await listen((req, res) => {
      seen.push(req.rawHeaders);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { echo: 'ok' } }));
    });

    const result = await generateMCPTools(schema, { execution: { mode: 'remote', endpoint, headers: make() } }).callTool('echo');

    expect(result.structuredContent).toEqual({ echo: 'ok' });
    expect(headerPairs(seen[0], 'content-type')).toEqual(['application/json; charset=utf-8']);
    expect(headerPairs(seen[0], 'authorization')).toEqual(['Bearer t']);
  });

  it('reports an invalid header value without sending the request or quoting the value', async () => {
    let requests = 0;
    const endpoint = await listen((req, res) => {
      requests += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { echo: 'ok' } }));
    });

    const result = await generateMCPTools(schema, {
      execution: { mode: 'remote', endpoint, headers: { authorization: 'Bearer secret\r\nx-injected: 1' } },
    }).callTool('echo');

    expect(errorCode(result)).toBe('MCP_REMOTE_REQUEST_FAILED');
    expect(result.content[0].text).toContain('invalid value for header \\"authorization\\"');
    expect(result.content[0].text).not.toContain('secret');
    expect(requests).toBe(0);
  });

  it('accepts a Request as the endpoint, as fetch does', async () => {
    const methods = [];
    const endpoint = await listen((req, res) => {
      methods.push(req.method);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { echo: 'ok' } }));
    });

    const result = await generateMCPTools(schema, { execution: { mode: 'remote', endpoint: new Request(endpoint) } }).callTool('echo');

    expect(result.structuredContent).toEqual({ echo: 'ok' });
    expect(methods).toEqual(['POST']);
  });

  it.each([
    ['credentials', (endpoint) => endpoint.replace('http://', 'http://user:secret@'), 'execution.endpoint must not include a username or password; send credentials through execution.headers'],
    ['a relative URL', () => '/graphql?apikey=secret', 'execution.endpoint must be an absolute http(s) URL, such as https://api.example.com/graphql'],
  ])('reports an endpoint changed after setup to one with %s without quoting it', async (label, change, reason) => {
    let requests = 0;
    const endpoint = await listen((req, res) => {
      requests += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: { echo: 'ok' } }));
    });
    const execution = { mode: 'remote', endpoint };
    const { callTool } = generateMCPTools(schema, { execution });
    expect((await callTool('echo')).structuredContent).toEqual({ echo: 'ok' });

    execution.endpoint = change(endpoint);
    const result = await callTool('echo');

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).errors[0]).toEqual({
      message: `GraphQL endpoint request failed: ${reason}`,
      extensions: { code: 'MCP_REMOTE_REQUEST_FAILED' },
    });
    expect(result.content[0].text).not.toContain('secret');
    expect(requests).toBe(1);
  });

  it('stops a retry backoff on client cancellation without another request', async () => {
    let requests = 0;
    const endpoint = await listen((req, res) => {
      requests += 1;
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{}');
    });
    const controller = new AbortController();
    const { callTool } = generateMCPTools(schema, {
      execution: { mode: 'remote', endpoint, retry: { attempts: 2, backoffMs: 5000 } },
    });

    const pending = callTool('echo', {}, { signal: controller.signal });
    await vi.waitFor(() => expect(requests).toBe(1), { interval: 5 });
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    controller.abort();

    await expect(Promise.race([
      pending,
      new Promise((resolve) => { setTimeout(() => resolve('still pending'), 500); }),
    ])).rejects.toMatchObject({ name: 'AbortError' });
    expect(requests).toBe(1);
  });

  it('settles a tool call cancelled by an SDK client during a retry backoff', async () => {
    let requests = 0;
    const endpoint = await listen((req, res) => {
      requests += 1;
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end('{}');
    });
    const settled = deferred();
    const server = await createMCPServer(schema, {
      execution: { mode: 'remote', endpoint, retry: { attempts: 2, backoffMs: 5000 } },
      toolMiddleware: async (call, next) => {
        try {
          return await next();
        } finally {
          settled.resolve('settled');
        }
      },
    });
    const client = new Client({ name: 'mcp-contract-client', version: '1' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    resources.push(async () => { await client.close(); await server.close(); });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const controller = new AbortController();

    const call = client.callTool({ name: 'echo', arguments: {} }, undefined, { signal: controller.signal });
    call.catch(() => {});
    await vi.waitFor(() => expect(requests).toBe(1), { interval: 5 });
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    controller.abort();

    await expect(call).rejects.toThrow();
    // The server side frees the call at once instead of after the backoff.
    expect(await Promise.race([
      settled.promise,
      new Promise((resolve) => { setTimeout(() => resolve('still pending'), 500); }),
    ])).toBe('settled');
    expect(requests).toBe(1);
  });
});

describe('MCP stateless HTTP configuration', () => {
  it.each(['sessionIdGenerator', 'onsessioninitialized', 'onsessionclosed', 'eventStore'])('rejects unsupported stateful transport option %s at setup', async (key) => {
    const schema = makeSchema({ echo: { type: GraphQLString } });
    await expect(createHTTPMCPHandler(schema, { transportOptions: { [key]: () => 'session' } }))
      .rejects.toMatchObject({ extensions: { code: 'MCP_INVALID_TRANSPORT_OPTIONS' } });
  });

  it.each([
    ['schema', { schema: undefined }, 'MCP_INVALID_SCHEMA'],
    ['toolNamePrefix', { toolNamePrefix: 'bad prefix!' }, 'MCP_INVALID_TOOL_NAME'],
    ['toolMiddleware', { toolMiddleware: [null] }, 'MCP_INVALID_MIDDLEWARE'],
    ['sparse toolMiddleware', { toolMiddleware: new Array(1) }, 'MCP_INVALID_MIDDLEWARE'],
    ['limits', { limits: { maxPageSize: 10, defaultPagination: { page: 1, size: 50 } } }, 'MCP_INVALID_LIMITS'],
    ['limits type', { limits: 'x' }, 'MCP_INVALID_LIMITS'],
    ['negative cap', { limits: { maxPageSize: -1 } }, 'MCP_INVALID_LIMITS'],
    ['schemaPlugins', { schemaPlugins: [{}] }, 'MCP_INVALID_SCHEMA_PLUGIN'],
    ['misspelled schemaPlugins hook', { schemaPlugins: [{ onSchemaChanged() {} }] }, 'MCP_INVALID_SCHEMA_PLUGIN'],
    ['execution.headers', { execution: { mode: 'remote', endpoint: 'http://127.0.0.1:9/graphql', headers: 'Bearer x' } }, 'MCP_INVALID_EXECUTION_CONFIG'],
    ['execution.timeoutMs', { execution: { mode: 'remote', endpoint: 'http://127.0.0.1:9/graphql', timeoutMs: '5s' } }, 'MCP_INVALID_EXECUTION_CONFIG'],
  ])('rejects invalid %s when creating the handler, before any schema plugin runs (guard)', async (label, options, code) => {
    const valid = makeSchema({ echo: { type: GraphQLString, resolve: () => 'open' } });
    const original = valid.getQueryType().getFields().echo.resolve;
    const { schema: given, ...rest } = options;
    const spy = { onSchemaChange: vi.fn() };
    await expect(createHTTPMCPHandler(Object.hasOwn(options, 'schema') ? given : valid, {
      ...rest,
      schemaPlugins: [spy, ...(rest.schemaPlugins || [])],
    })).rejects.toMatchObject({ extensions: { code } });
    expect(spy.onSchemaChange).not.toHaveBeenCalled();
    expect(valid.getQueryType().getFields().echo.resolve).toBe(original);
  });

  it.each([
    ['a username and password', 'http://user:secret@127.0.0.1:9/graphql'],
    ['a username only (guard)', 'http://secret@127.0.0.1:9/graphql'],
  ])('rejects an execution.endpoint with %s when creating the handler, without quoting it', async (label, endpoint) => {
    await expect(createHTTPMCPHandler(makeSchema({ echo: { type: GraphQLString } }), { execution: { mode: 'remote', endpoint } }))
      .rejects.toMatchObject({
        extensions: { code: 'MCP_INVALID_EXECUTION_CONFIG' },
        message: 'execution.endpoint must not include a username or password; send credentials through execution.headers',
      });
  });

  const absoluteURL = 'execution.endpoint must be an absolute http(s) URL, such as https://api.example.com/graphql';
  it.each([
    ['a relative URL', '/graphql?key=secret', absoluteURL],
    ['an unparsable URL', '127.0.0.1:9/graphql?key=secret', absoluteURL],
    // fetch's error for another protocol does not quote the URL, so it is kept.
    ['another protocol', 'ftp://127.0.0.1:9/graphql?key=secret', 'fetch failed'],
  ])('creates the handler for an execution.endpoint with %s and fails each call without quoting it', async (label, endpoint, reason) => {
    const handler = await createHTTPMCPHandler(makeSchema({ echo: { type: GraphQLString } }), { execution: { mode: 'remote', endpoint } });
    const client = new Client({ name: 'mcp-contract-endpoint-client', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(await listen(handler))));
    resources.unshift(() => client.close());

    const result = await client.callTool({ name: 'echo', arguments: {} });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).errors[0]).toEqual({
      message: `GraphQL endpoint request failed: ${reason}`,
      extensions: { code: 'MCP_REMOTE_REQUEST_FAILED' },
    });
    expect(result.content[0].text).not.toContain('secret');
  });

  it('awaits an asynchronous onSchemaChange and surfaces its failure at setup', async () => {
    const schema = makeSchema({ echo: { type: GraphQLString } });
    let installed = false;
    await createHTTPMCPHandler(schema, {
      schemaPlugins: [{
        async onSchemaChange() {
          await new Promise((resolve) => { setTimeout(resolve, 10); });
          installed = true;
        },
      }],
    });
    expect(installed).toBe(true);

    await expect(createHTTPMCPHandler(schema, {
      schemaPlugins: [{
        async onSchemaChange() {
          throw new Error('install failed');
        },
      }],
    })).rejects.toThrow('install failed');
  });

  it('resolves createMCPServer only after an asynchronous onSchemaChange finishes', async () => {
    const schema = makeSchema({ echo: { type: GraphQLString } });
    let installed = false;
    const server = await createMCPServer(schema, {
      schemaPlugins: [{
        async onSchemaChange() {
          await new Promise((resolve) => { setTimeout(resolve, 10); });
          installed = true;
        },
      }],
    });
    resources.push(() => server.close());
    expect(installed).toBe(true);

    await expect(createMCPServer(schema, {
      schemaPlugins: [{
        async onSchemaChange() {
          throw new Error('install failed');
        },
      }],
    })).rejects.toThrow('install failed');
  });
});
