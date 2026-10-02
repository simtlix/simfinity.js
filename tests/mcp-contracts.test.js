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
} from 'graphql';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
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
});

describe('MCP stateless HTTP configuration', () => {
  it.each(['sessionIdGenerator', 'onsessioninitialized', 'onsessionclosed', 'eventStore'])('rejects unsupported stateful transport option %s at setup', async (key) => {
    const schema = makeSchema({ echo: { type: GraphQLString } });
    await expect(createHTTPMCPHandler(schema, { transportOptions: { [key]: () => 'session' } }))
      .rejects.toMatchObject({ extensions: { code: 'MCP_INVALID_TRANSPORT_OPTIONS' } });
  });

  it.each([
    ['toolMiddleware', { toolMiddleware: [null] }, 'MCP_INVALID_MIDDLEWARE'],
    ['sparse toolMiddleware', { toolMiddleware: new Array(1) }, 'MCP_INVALID_MIDDLEWARE'],
    ['limits', { limits: { maxPageSize: 10, defaultPagination: { page: 1, size: 50 } } }, 'MCP_INVALID_LIMITS'],
    ['schemaPlugins', { schemaPlugins: [{}] }, 'MCP_INVALID_SCHEMA_PLUGIN'],
    ['misspelled schemaPlugins hook', { schemaPlugins: [{ onSchemaChanged() {} }] }, 'MCP_INVALID_SCHEMA_PLUGIN'],
  ])('rejects invalid %s when creating the handler', async (label, options, code) => {
    const schema = makeSchema({ echo: { type: GraphQLString } });
    await expect(createHTTPMCPHandler(schema, options)).rejects.toMatchObject({ extensions: { code } });
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
