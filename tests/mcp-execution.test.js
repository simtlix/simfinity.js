import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import { getEventListeners } from 'node:events';
import {
  graphql,
  GraphQLObjectType,
  GraphQLInputObjectType,
  GraphQLSchema,
  GraphQLString,
  GraphQLInt,
  GraphQLBoolean,
  GraphQLList,
  GraphQLNonNull,
} from 'graphql';
import * as simfinity from '../packages/mongodb/src/index.js';
import { createRuntime } from '../packages/core/src/index.js';

// ---------------------------------------------------------------------------
// Stub schema shared by the callTool behavior tests (unique McpExec* names).
// ---------------------------------------------------------------------------

let itemCalls = 0;

const ItemType = new GraphQLObjectType({
  name: 'McpExecItem',
  fields: () => ({
    id: { type: GraphQLString },
    name: { type: GraphQLString },
  }),
});

const PaginationInput = new GraphQLInputObjectType({
  name: 'McpExecPagination',
  fields: () => ({
    page: { type: GraphQLInt },
    size: { type: GraphQLInt },
    count: { type: GraphQLBoolean },
  }),
});

const PageEchoType = new GraphQLObjectType({
  name: 'McpExecPageEcho',
  fields: () => ({
    page: { type: GraphQLInt },
    size: { type: GraphQLInt },
  }),
});

const PairType = new GraphQLObjectType({
  name: 'McpExecPair',
  fields: () => ({
    good: { type: GraphQLString, resolve: () => 'ok' },
    bad: {
      type: GraphQLString,
      resolve: () => {
        throw new Error('boom');
      },
    },
  }),
});

const AddInput = new GraphQLInputObjectType({
  name: 'McpExecAddInput',
  fields: () => ({
    name: { type: new GraphQLNonNull(GraphQLString) },
  }),
});

const stubSchema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    fields: {
      item: {
        type: ItemType,
        args: { id: { type: new GraphQLNonNull(GraphQLString) } },
        resolve: (parent, args) => {
          itemCalls += 1;
          return { id: args.id, name: 'InProcess' };
        },
      },
      items: {
        type: new GraphQLList(ItemType),
        args: { pagination: { type: PaginationInput } },
        resolve: (parent, args, context) => {
          if (args.pagination && args.pagination.count && context) {
            context.count = 7;
          }
          return [{ id: '1', name: 'One' }];
        },
      },
      echoPage: {
        type: PageEchoType,
        args: { pagination: { type: PaginationInput } },
        resolve: (parent, args) => ({
          page: args.pagination ? args.pagination.page : null,
          size: args.pagination ? args.pagination.size : null,
        }),
      },
      pair: {
        type: PairType,
        resolve: () => ({}),
      },
    },
  }),
  mutation: new GraphQLObjectType({
    name: 'Mutation',
    fields: {
      // The placeholder description and name prefix of a generated create, so
      // it is classified 'add' (a name prefix alone makes a custom tool).
      addItem: {
        type: ItemType,
        description: 'add',
        args: { input: { type: new GraphQLNonNull(AddInput) } },
        resolve: (parent, args) => ({ id: '1', name: args.input.name }),
      },
    },
  }),
});

// ---------------------------------------------------------------------------
// Remote execution (fetch stubbed)
// ---------------------------------------------------------------------------

describe('MCP callTool remote execution', () => {
  const ENDPOINT = 'http://graphql.test/graphql';
  let fetchMock;

  const jsonResponse = (body) => ({ ok: true, status: 200, json: async () => body });
  const httpError = (status) => ({ ok: false, status, json: async () => ({}) });

  // A fetch stub that never resolves on its own: it only rejects (with the
  // abort reason) once init.signal fires, mimicking an aborted real fetch.
  const stubAbortAwareFetch = () => {
    fetchMock.mockImplementation((url, init) => new Promise((resolve, reject) => {
      if (init.signal.aborted) {
        reject(init.signal.reason);
        return;
      }
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true });
    }));
  };

  const remoteTools = (execution = {}) => simfinity.generateMCPTools(stubSchema, {
    execution: { mode: 'remote', endpoint: ENDPOINT, ...execution },
  });

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('passes the operation through and returns structuredContent on success', async () => {
    const data = { item: { id: '9', name: 'Remote' } };
    fetchMock.mockResolvedValueOnce(jsonResponse({ data }));

    const { callTool } = remoteTools();
    const response = await callTool('item', { id: '9' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body.query).toContain('query itemOperation');
    expect(body.query).toContain('item(id: $id)');
    expect(body.variables).toEqual({ id: '9' });

    expect(response.isError).toBe(false);
    expect(response.structuredContent).toEqual(data);
    expect(JSON.parse(response.content[0].text)).toEqual(data);
  });

  it('retries a query once after an HTTP 502 when retry is configured', async () => {
    const data = { item: { id: '9', name: 'Recovered' } };
    fetchMock
      .mockResolvedValueOnce(httpError(502))
      .mockResolvedValueOnce(jsonResponse({ data }));

    const { callTool } = remoteTools({ retry: { attempts: 1, backoffMs: 1 } });
    const response = await callTool('item', { id: '9' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.isError).toBe(false);
    expect(response.structuredContent).toEqual(data);
  });

  it('never retries mutations, even on HTTP 5xx', async () => {
    fetchMock.mockResolvedValue(httpError(502));

    const { callTool } = remoteTools({ retry: { attempts: 2, backoffMs: 1 } });
    const response = await callTool('addItem', { input: { name: 'x' } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.errors[0].extensions.code).toBe('MCP_REMOTE_HTTP_ERROR');
    expect(payload.errors[0].extensions.status).toBe(502);
  });

  it('does not retry an HTTP 400 on a query', async () => {
    fetchMock.mockResolvedValue(httpError(400));

    const { callTool } = remoteTools({ retry: { attempts: 2, backoffMs: 1 } });
    const response = await callTool('item', { id: '9' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.errors[0].extensions.code).toBe('MCP_REMOTE_HTTP_ERROR');
    expect(payload.errors[0].extensions.status).toBe(400);
  });

  it('flags a non-JSON body as MCP_REMOTE_INVALID_RESPONSE', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    });

    const { callTool } = remoteTools();
    const response = await callTool('item', { id: '9' });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('MCP_REMOTE_INVALID_RESPONSE');
  });

  it('merges custom headers over the JSON content type', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { item: null } }));

    const { callTool } = remoteTools({
      headers: { authorization: 'Bearer remote-token', 'x-extra': '1' },
    });
    await callTool('item', { id: '9' });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers).toMatchObject({
      'content-type': 'application/json',
      authorization: 'Bearer remote-token',
      'x-extra': '1',
    });
  });

  it('surfaces a remote extensions.count as result _meta.count and as totalCount next to the data', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: { items: [{ id: '1', name: 'One' }] },
      extensions: { count: 42 },
    }));

    const { callTool } = remoteTools();
    const response = await callTool('items', {});

    expect(response.isError).toBe(false);
    expect(response._meta).toEqual({ count: 42 });
    expect(response.structuredContent).toEqual({ items: [{ id: '1', name: 'One' }], totalCount: 42 });
    expect(JSON.parse(response.content[0].text)).toEqual(response.structuredContent);
  });

  it('keeps a remote count that is not a non-negative integer in _meta only (guard)', async () => {
    for (const count of [4.5, -1]) {
      fetchMock.mockResolvedValueOnce(jsonResponse({
        data: { items: [{ id: '1', name: 'One' }] },
        extensions: { count },
      }));
      const response = await remoteTools().callTool('items', {});

      expect(response.isError).toBe(false);
      expect(response._meta).toEqual({ count });
      expect(response.structuredContent).toEqual({ items: [{ id: '1', name: 'One' }] });
    }
  });

  it('reports an oversized remote mutation that succeeded as applied, with its id', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { addItem: { id: 'r1', name: 'x'.repeat(2000) } } }));

    const { callTool } = simfinity.generateMCPTools(stubSchema, {
      execution: { mode: 'remote', endpoint: ENDPOINT },
      limits: { maxResultBytes: 512 },
    });
    const response = await callTool('addItem', { input: { name: 'big' } });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.isError).toBe(false);
    expect(response._meta).toEqual({ truncated: true });
    expect(response.structuredContent.addItem).toEqual({ id: 'r1' });
    expect(response.structuredContent.truncated).toMatchObject({ applied: true, maxResultBytes: 512 });
    expect(response.structuredContent.truncated.message).toContain('addItem was applied (the record was created)');
    expect(JSON.parse(response.content[0].text)).toEqual(response.structuredContent);
  });

  it('aborts a hung request after execution.timeoutMs and reports MCP_REMOTE_REQUEST_FAILED', async () => {
    stubAbortAwareFetch();

    const { callTool } = remoteTools({ timeoutMs: 30 });
    const response = await callTool('item', { id: '9' });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('MCP_REMOTE_REQUEST_FAILED');
  });

  it('rethrows a user cancellation (extra.signal) instead of retrying or converting it to isError', async () => {
    stubAbortAwareFetch();
    const controller = new AbortController();

    const { callTool } = remoteTools({ retry: { attempts: 2, backoffMs: 1 } });
    const pending = callTool('item', { id: '9' }, { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);

    // User cancellation must escape as a rejection (the SDK turns it into a
    // protocol-level cancellation), never an isError result, and never retry.
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retries a query after a network error and succeeds on the second attempt', async () => {
    const data = { item: { id: '9', name: 'Recovered' } };
    fetchMock
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse({ data }));

    const { callTool } = remoteTools({ retry: { attempts: 1, backoffMs: 1 } });
    const response = await callTool('item', { id: '9' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.isError).toBe(false);
    expect(response.structuredContent).toEqual(data);
  });

  it('retries a query after an HTTP 429 when retry is configured', async () => {
    const data = { item: { id: '9', name: 'AfterBackoff' } };
    fetchMock
      .mockResolvedValueOnce(httpError(429))
      .mockResolvedValueOnce(jsonResponse({ data }));

    const { callTool } = remoteTools({ retry: { attempts: 1, backoffMs: 1 } });
    const response = await callTool('item', { id: '9' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(response.isError).toBe(false);
    expect(response.structuredContent).toEqual(data);
  });

  it('returns the last failure as isError after exhausting all retry attempts', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const { callTool } = remoteTools({ retry: { attempts: 2, backoffMs: 1 } });
    const response = await callTool('item', { id: '9' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('MCP_REMOTE_REQUEST_FAILED');
  });

  it('treats NaN or negative retry.attempts as "no retries" and never throws a TypeError', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const nan = remoteTools({ retry: { attempts: NaN, backoffMs: 1 } });
    const nanResponse = await nan.callTool('item', { id: '9' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(nanResponse.isError).toBe(true);
    expect(nanResponse.content[0].text).toContain('MCP_REMOTE_REQUEST_FAILED');

    const negative = remoteTools({ retry: { attempts: -2, backoffMs: 1 } });
    const negativeResponse = await negative.callTool('item', { id: '9' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(negativeResponse.isError).toBe(true);
  });

  it('coerces a string retry.attempts ("2") to exactly 3 total attempts, not 21', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const { callTool } = remoteTools({ retry: { attempts: '2', backoffMs: 1 } });
    const response = await callTool('item', { id: '9' });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(response.isError).toBe(true);
  });

  it('passes a GraphQL-shaped non-2xx body through verbatim instead of synthesizing a transport error', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: async () => ({ errors: [{ message: 'Variable "$id" got invalid value' }] }),
    });

    const { callTool } = remoteTools({ retry: { attempts: 2, backoffMs: 1 } });
    const response = await callTool('item', { id: '9' });

    // 400 is not retryable: the real GraphQL errors surface on the first try.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.errors[0].message).toBe('Variable "$id" got invalid value');
    expect(response.content[0].text).not.toContain('MCP_REMOTE_HTTP_ERROR');
  });

  it('lets a user-supplied content-type header win over the JSON default', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ data: { item: null } }));

    const { callTool } = remoteTools({
      headers: { 'content-type': 'application/graphql-response+json' },
    });
    await callTool('item', { id: '9' });

    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers['content-type']).toBe('application/graphql-response+json');
  });

  describe('endpoint', () => {
    it.each([
      ['a relative URL', '/graphql'],
      ['a Request', new Request(ENDPOINT)],
    ])('sets up %s as the endpoint and passes it to fetch, which an application may replace', async (label, endpoint) => {
      const data = { item: { id: '9', name: 'Remote' } };
      fetchMock.mockResolvedValueOnce(jsonResponse({ data }));

      const response = await remoteTools({ endpoint }).callTool('item', { id: '9' });

      expect(response.structuredContent).toEqual(data);
      expect(fetchMock.mock.calls[0][0]).toBe(endpoint);
    });

    it('reports an application fetch error, not an endpoint problem, for a relative endpoint', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      const response = await remoteTools({ endpoint: '/graphql' }).callTool('item', { id: '9' });

      expect(JSON.parse(response.content[0].text).errors[0]).toEqual({
        message: 'GraphQL endpoint request failed: fetch failed',
        extensions: { code: 'MCP_REMOTE_REQUEST_FAILED' },
      });
    });

    it('reports the endpoint problem, not the URL, when a fetch error quotes a relative endpoint', async () => {
      fetchMock.mockRejectedValue(new TypeError('Failed to parse URL from /graphql?apikey=secret'));

      const response = await remoteTools({ endpoint: '/graphql?apikey=secret' }).callTool('item', { id: '9' });
      const { message } = JSON.parse(response.content[0].text).errors[0];

      expect(message).toBe('GraphQL endpoint request failed: execution.endpoint must be an absolute http(s) URL, such as https://api.example.com/graphql');
      expect(message).not.toContain('secret');
    });

    it('reports the fetch error, not an endpoint problem, when a request to a Request endpoint fails', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));

      const response = await remoteTools({ endpoint: new Request(ENDPOINT) }).callTool('item', { id: '9' });

      expect(JSON.parse(response.content[0].text).errors[0]).toEqual({
        message: 'GraphQL endpoint request failed: fetch failed',
        extensions: { code: 'MCP_REMOTE_REQUEST_FAILED' },
      });
    });
  });

  describe('headers', () => {
    const sentHeaders = () => fetchMock.mock.calls.map(([, init]) => init.headers);

    it('sends one content type when the caller sets Content-Type in any casing', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: { item: null } }));

      await remoteTools({
        headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: 'Bearer t' },
      }).callTool('item', { id: '9' });
      await remoteTools({
        headers: [['CONTENT-TYPE', 'application/graphql-response+json'], ['content-type', 'application/json']],
      }).callTool('item', { id: '9' });

      expect(sentHeaders()).toEqual([
        { 'content-type': 'application/json; charset=utf-8', authorization: 'Bearer t' },
        { 'content-type': 'application/json' },
      ]);
    });

    it.each([
      ['a Headers instance', () => new Headers({ Authorization: 'Bearer t' })],
      ['an array of [name, value] pairs', () => [['Authorization', 'Bearer t']]],
      ['a Map', () => new Map([['Authorization', 'Bearer t']])],
    ])('sends the credentials of %s', async (label, make) => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ data: { item: null } }));

      const response = await remoteTools({ headers: make() }).callTool('item', { id: '9' });

      expect(response.isError).toBe(false);
      expect(sentHeaders()).toEqual([{ 'content-type': 'application/json', authorization: 'Bearer t' }]);
    });

    it('sends only the own enumerable string keys of a plain object', async () => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ data: { item: null } }));
      // Spreading copied the symbol key, which fetch rejects; new Headers(object)
      // would send the non-enumerable key on Node.js 22 and later.
      const headers = Object.create({ inherited: 'x' });
      headers.authorization = 'Bearer t';
      headers[Symbol('meta')] = 'x';
      Object.defineProperty(headers, 'internal', { value: 'x', enumerable: false });

      const response = await remoteTools({ headers }).callTool('item', { id: '9' });

      expect(response.isError).toBe(false);
      expect(Reflect.ownKeys(sentHeaders()[0])).toEqual(['authorization', 'content-type']);
    });

    it.each([undefined, null, false, '', 0])('sends only the JSON content type for headers %j (guard)', async (headers) => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ data: { item: null } }));

      const response = await remoteTools({ headers }).callTool('item', { id: '9' });

      expect(response.isError).toBe(false);
      expect(sentHeaders()).toEqual([{ 'content-type': 'application/json' }]);
    });

    it('reads execution.headers on every call, so a rotated token applies (guard)', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: { item: null } }));
      const execution = { mode: 'remote', endpoint: ENDPOINT, headers: { authorization: 'Bearer one' } };
      const { callTool } = simfinity.generateMCPTools(stubSchema, { execution });

      await callTool('item', { id: '9' });
      execution.headers.authorization = 'Bearer two';
      await callTool('item', { id: '9' });
      execution.headers = { authorization: 'Bearer three' };
      await callTool('item', { id: '9' });

      expect(sentHeaders().map((headers) => headers.authorization)).toEqual(['Bearer one', 'Bearer two', 'Bearer three']);
    });

    it('reads a lazy header value per call, never at setup (guard)', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: { item: null } }));
      let token = null;
      let reads = 0;
      const headers = {
        get authorization() {
          reads += 1;
          if (!token) {
            throw new Error('token not loaded yet');
          }
          return token;
        },
      };

      const { callTool } = remoteTools({ headers });
      expect(reads).toBe(0);
      token = 'Bearer late';
      await callTool('item', { id: '9' });

      expect(reads).toBe(1);
      expect(sentHeaders()[0].authorization).toBe('Bearer late');
    });

    it('runs an execution.headers getter per call, never at setup, so a token that loads later is sent', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: { item: null } }));
      let token = null;
      let reads = 0;
      const execution = {
        mode: 'remote',
        endpoint: ENDPOINT,
        get headers() {
          reads += 1;
          if (!token) {
            throw new Error('token not loaded yet');
          }
          return { authorization: token };
        },
      };

      const { callTool } = simfinity.generateMCPTools(stubSchema, { execution });
      expect(reads).toBe(0);
      token = 'Bearer late';
      const response = await callTool('item', { id: '9' });

      expect(response.isError).toBe(false);
      expect(reads).toBe(1);
      expect(sentHeaders()[0].authorization).toBe('Bearer late');
    });

    // Lazy headers that throw until a token loads, read through a class
    // getter or a Proxy rather than an own getter.
    class LazyRemoteSettings {
      constructor(state) {
        this.mode = 'remote';
        this.endpoint = ENDPOINT;
        this.state = state;
      }

      get headers() {
        if (!this.state.token) {
          throw new Error('token not loaded yet');
        }
        return { authorization: this.state.token };
      }
    }
    const lazyProxy = (state) => new Proxy({ mode: 'remote', endpoint: ENDPOINT }, {
      get(target, key, receiver) {
        if (key === 'headers') {
          if (!state.token) {
            throw new Error('token not loaded yet');
          }
          return { authorization: state.token };
        }
        return Reflect.get(target, key, receiver);
      },
    });

    const lazyHeadersProxy = (state) => ({
      mode: 'remote',
      endpoint: ENDPOINT,
      headers: new Proxy({ authorization: '' }, {
        get(target, key, receiver) {
          if (!state.token) {
            throw new Error('token not loaded yet');
          }
          return key === 'authorization' ? state.token : Reflect.get(target, key, receiver);
        },
        ownKeys: () => ['authorization'],
        getOwnPropertyDescriptor: () => ({ value: state.token, enumerable: true, configurable: true }),
      }),
    });

    it.each([
      ['a class whose prototype getter', (state) => new LazyRemoteSettings(state)],
      ['a Proxy whose get trap', lazyProxy],
      ['a headers Proxy whose get trap', lazyHeadersProxy],
    ])('sets up %s for execution.headers throws until a token loads, and sends the token once it does', async (label, make) => {
      fetchMock.mockResolvedValue(jsonResponse({ data: { item: null } }));
      const state = { token: null };

      const { callTool } = simfinity.generateMCPTools(stubSchema, { execution: make(state) });
      state.token = 'Bearer late';
      const response = await callTool('item', { id: '9' });

      expect(response.isError).toBe(false);
      expect(sentHeaders()[0].authorization).toBe('Bearer late');
    });

    it('checks the value of an inherited execution.headers getter that does not throw at setup (guard)', () => {
      class FixedRemoteSettings {
        constructor() {
          this.mode = 'remote';
          this.endpoint = ENDPOINT;
          this.token = 'Bearer secret';
        }

        get headers() {
          return this.token;
        }
      }

      expect(() => simfinity.generateMCPTools(stubSchema, { execution: new FixedRemoteSettings() }))
        .toThrow(/^execution\.headers must be an object of header names to values, .*, got string;/);
    });

    it('still checks what an execution.headers getter returns on every call', async () => {
      const { callTool } = simfinity.generateMCPTools(stubSchema, {
        execution: { mode: 'remote', endpoint: ENDPOINT, get headers() { return 'Bearer secret'; } },
      });
      const response = await callTool('item', { id: '9' });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(response.isError).toBe(true);
      expect(JSON.parse(response.content[0].text).errors[0]).toMatchObject({
        extensions: { code: 'MCP_REMOTE_REQUEST_FAILED' },
        message: expect.stringContaining('got string;'),
      });
      expect(response.content[0].text).not.toContain('secret');
    });

    it.each([
      ['a value with a line break', { 'x-api-key': 'secret\ninjected' }, 'execution.headers has an invalid value for header "x-api-key"'],
      ['a value outside Latin-1', { authorization: 'Bearer €-secret' }, 'execution.headers has an invalid value for header "authorization"'],
      ['an invalid name', { 'secret name': 'x' }, 'execution.headers entry 1 has an invalid header name'],
      ['a symbol name in a Map', new Map([[Symbol('secret'), 'x']]), 'execution.headers entry 1 has an invalid header name'],
      ['a pair without a value', [['authorization']], 'execution.headers entry 1 is not a [name, value] pair'],
      ['an entry that is not a pair', [['accept', 'application/json'], 'secret'], 'execution.headers entry 2 is not a [name, value] pair'],
    ])('fails the call for %s, naming the header but not its value', async (label, headers, message) => {
      const response = await remoteTools({ headers }).callTool('item', { id: '9' });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(response.isError).toBe(true);
      const payload = JSON.parse(response.content[0].text);
      expect(payload.errors[0].extensions.code).toBe('MCP_REMOTE_REQUEST_FAILED');
      expect(payload.errors[0].message).toBe(`GraphQL endpoint request failed: ${message}`);
      expect(response.content[0].text).not.toContain('secret');
    });

    it('fails calls when execution.headers is replaced after setup by a value that is not a header map', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: { item: null } }));
      const execution = { mode: 'remote', endpoint: ENDPOINT };
      const { callTool } = simfinity.generateMCPTools(stubSchema, { execution });

      execution.headers = 'Bearer secret';
      const fromString = await callTool('item', { id: '9' });
      execution.headers = new Map([['authorization', 'Bearer secret']]).entries();
      const fromIterator = await callTool('item', { id: '9' });

      expect(fetchMock).not.toHaveBeenCalled();
      expect(fromString.isError).toBe(true);
      expect(JSON.parse(fromString.content[0].text).errors[0].message).toContain('got string;');
      expect(fromIterator.isError).toBe(true);
      expect(JSON.parse(fromIterator.content[0].text).errors[0].message).toContain('got an iterator');
      expect(`${fromString.content[0].text}${fromIterator.content[0].text}`).not.toContain('secret');
    });
  });

  describe('timeoutMs', () => {
    let timeoutSpy;

    beforeEach(() => {
      timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    });

    afterEach(() => {
      timeoutSpy.mockRestore();
    });

    const callWithTimeout = async (timeoutMs) => {
      fetchMock.mockResolvedValueOnce(jsonResponse({ data: { item: null } }));
      const response = await remoteTools({ timeoutMs }).callTool('item', { id: '9' });
      expect(response.isError).toBe(false);
      return fetchMock.mock.calls[0][1].signal;
    };

    it.each([
      ['"5000"', 5000, '5000'],
      ['" 250 "', 250, ' 250 '],
      ['1500.5', 1501, 1500.5],
      ['0.2', 1, 0.2],
      ['10n', 10, 10n],
      ['2 ** 31', 2147483647, 2 ** 31],
      ['2 ** 32 - 1', 2147483647, 2 ** 32 - 1],
      ['1e12', 2147483647, 1e12],
    ])('applies timeoutMs %s as an AbortSignal.timeout of %i ms', async (label, delay, timeoutMs) => {
      const signal = await callWithTimeout(timeoutMs);

      expect(timeoutSpy.mock.calls).toEqual([[delay]]);
      expect(signal).toBe(timeoutSpy.mock.results[0].value);
    });

    it.each([
      [30, 30],
      [2147483647, 2147483647],
    ])('applies timeoutMs %i as an AbortSignal.timeout of %i ms (guard)', async (timeoutMs, delay) => {
      await callWithTimeout(timeoutMs);

      expect(timeoutSpy.mock.calls).toEqual([[delay]]);
    });

    it.each(['0', '0.0', ' 0 '])('applies no timeout for timeoutMs %j', async (timeoutMs) => {
      expect(await callWithTimeout(timeoutMs)).toBeUndefined();
      expect(timeoutSpy).not.toHaveBeenCalled();
    });

    it.each([
      ['undefined', undefined], ['null', null], ['false', false], ['0', 0], ['""', ''], ['NaN', NaN],
    ])('applies no timeout for timeoutMs %s (guard)', async (label, timeoutMs) => {
      expect(await callWithTimeout(timeoutMs)).toBeUndefined();
      expect(timeoutSpy).not.toHaveBeenCalled();
    });

    it('reads timeoutMs on every call (guard)', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: { item: null } }));
      const execution = { mode: 'remote', endpoint: ENDPOINT };
      const { callTool } = simfinity.generateMCPTools(stubSchema, { execution });

      await callTool('item', { id: '9' });
      execution.timeoutMs = 50;
      await callTool('item', { id: '9' });

      expect(timeoutSpy.mock.calls).toEqual([[50]]);
    });

    it('runs an execution.timeoutMs getter per call, never at setup', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: { item: null } }));
      let loaded = false;
      let reads = 0;
      const execution = {
        mode: 'remote',
        endpoint: ENDPOINT,
        get timeoutMs() {
          reads += 1;
          if (!loaded) {
            throw new Error('settings not loaded yet');
          }
          return '75';
        },
      };

      const { callTool } = simfinity.generateMCPTools(stubSchema, { execution });
      expect(reads).toBe(0);
      loaded = true;
      expect((await callTool('item', { id: '9' })).isError).toBe(false);

      expect(reads).toBe(1);
      expect(timeoutSpy.mock.calls).toEqual([[75]]);
    });

    it('sets up a class whose prototype getter for execution.timeoutMs throws until settings load, and applies it once they do', async () => {
      fetchMock.mockResolvedValue(jsonResponse({ data: { item: null } }));
      class LazyRemoteSettings {
        constructor() {
          this.mode = 'remote';
          this.endpoint = ENDPOINT;
          this.loaded = false;
        }

        get timeoutMs() {
          if (!this.loaded) {
            throw new Error('settings not loaded yet');
          }
          return '75';
        }
      }
      const execution = new LazyRemoteSettings();

      const { callTool } = simfinity.generateMCPTools(stubSchema, { execution });
      execution.loaded = true;
      expect((await callTool('item', { id: '9' })).isError).toBe(false);

      expect(timeoutSpy.mock.calls).toEqual([[75]]);
    });

    it('rejects a call with MCP_INVALID_EXECUTION_CONFIG when timeoutMs is changed to an invalid value after setup', async () => {
      const execution = { mode: 'remote', endpoint: ENDPOINT };
      const { callTool } = simfinity.generateMCPTools(stubSchema, { execution });

      execution.timeoutMs = 'soon';

      await expect(callTool('item', { id: '9' })).rejects.toMatchObject({
        extensions: { code: 'MCP_INVALID_EXECUTION_CONFIG' },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe('cancellation during a retry backoff', () => {
    const settledWithin = (promise, ms) => Promise.race([
      promise,
      new Promise((resolve) => { setTimeout(() => resolve('still pending'), ms); }),
    ]);

    it('rejects promptly when cancelled during a backoff, without another fetch', async () => {
      fetchMock.mockResolvedValue(httpError(503));
      const controller = new AbortController();

      const pending = remoteTools({ retry: { attempts: 2, backoffMs: 5000 } })
        .callTool('item', { id: '9' }, { signal: controller.signal });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { interval: 5 });
      controller.abort();

      await expect(settledWithin(pending, 500)).rejects.toMatchObject({ name: 'AbortError' });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('rejects with the abort reason of the caller during a later backoff', async () => {
      fetchMock.mockRejectedValue(new TypeError('fetch failed'));
      const controller = new AbortController();

      const pending = remoteTools({ retry: { attempts: 3, backoffMs: 100 } })
        .callTool('item', { id: '9' }, { signal: controller.signal });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2), { interval: 5 });
      controller.abort('stop');

      await expect(settledWithin(pending, 500)).rejects.toBe('stop');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('leaves no abort listener on a long-lived caller signal after backoffs (guard)', async () => {
      const { signal } = new AbortController();
      const { callTool } = remoteTools({ timeoutMs: 60000, retry: { attempts: 1, backoffMs: 1 } });

      for (let i = 0; i < 20; i += 1) {
        fetchMock
          .mockResolvedValueOnce(httpError(503))
          .mockResolvedValueOnce(jsonResponse({ data: { item: null } }));
        expect((await callTool('item', { id: '9' }, { signal })).isError).toBe(false);
      }

      expect(fetchMock).toHaveBeenCalledTimes(40);
      expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    });

    it('still retries with a signal-like object that is not an EventTarget (guard)', async () => {
      const data = { item: { id: '9', name: 'Recovered' } };
      fetchMock
        .mockResolvedValueOnce(httpError(503))
        .mockResolvedValueOnce(jsonResponse({ data }));

      const response = await remoteTools({ retry: { attempts: 1, backoffMs: 1 } })
        .callTool('item', { id: '9' }, { signal: { aborted: false } });

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(response.structuredContent).toEqual(data);
    });
  });

  it('combines the caller signal and the timeout through AbortSignal.any only when both exist (guard)', async () => {
    const anySpy = vi.spyOn(AbortSignal, 'any');
    try {
      fetchMock.mockResolvedValue(jsonResponse({ data: { item: null } }));
      const { signal } = new AbortController();

      await remoteTools().callTool('item', { id: '9' }, { signal });
      await remoteTools({ timeoutMs: 1000 }).callTool('item', { id: '9' });
      await remoteTools({ timeoutMs: 1000 }).callTool('item', { id: '9' }, { signal });

      const sent = fetchMock.mock.calls.map(([, init]) => init.signal);
      expect(sent[0]).toBe(signal);
      expect(sent[1]).toBeInstanceOf(AbortSignal);
      expect(sent[1]).not.toBe(signal);
      expect(anySpy).toHaveBeenCalledTimes(1);
      expect(anySpy.mock.calls[0][0]).toEqual([signal, expect.any(AbortSignal)]);
      expect(sent[2]).toBe(anySpy.mock.results[0].value);
    } finally {
      anySpy.mockRestore();
    }
  });

  // Node.js 19 and 20.0–20.2, inside the engines range, have no AbortSignal.any.
  describe('without AbortSignal.any', () => {
    let anyDescriptor;
    let timeoutSpy;

    beforeEach(() => {
      anyDescriptor = Object.getOwnPropertyDescriptor(AbortSignal, 'any');
      delete AbortSignal.any;
      timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    });

    afterEach(() => {
      timeoutSpy.mockRestore();
      Object.defineProperty(AbortSignal, 'any', anyDescriptor);
    });

    const timeoutSignals = () => timeoutSpy.mock.results.map(({ value }) => value);

    it('sends a call that has both a caller signal and timeoutMs', async () => {
      const data = { item: { id: '9', name: 'Remote' } };
      fetchMock.mockResolvedValueOnce(jsonResponse({ data }));
      const { signal } = new AbortController();

      const response = await remoteTools({ timeoutMs: 1000 }).callTool('item', { id: '9' }, { signal });

      expect(response.isError).toBe(false);
      expect(response.structuredContent).toEqual(data);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const sent = fetchMock.mock.calls[0][1].signal;
      expect(sent).toBeInstanceOf(AbortSignal);
      expect(sent).not.toBe(signal);
      expect(sent.aborted).toBe(false);
    });

    it('aborts the request with the caller reason, without retrying', async () => {
      stubAbortAwareFetch();
      const controller = new AbortController();

      const pending = remoteTools({ timeoutMs: 60000, retry: { attempts: 2, backoffMs: 1 } })
        .callTool('item', { id: '9' }, { signal: controller.signal });
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1), { interval: 5 });
      controller.abort('stop');

      await expect(pending).rejects.toBe('stop');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1].signal.reason).toBe('stop');
      expect(getEventListeners(timeoutSignals()[0], 'abort')).toHaveLength(0);
    });

    it('rejects with the reason of a caller signal that aborted after the cancellation check', async () => {
      stubAbortAwareFetch();
      const controller = new AbortController();
      // The caller aborts after callTool checked the signal, while timeoutMs
      // is read, so it is already aborted when the signals are combined.
      const execution = {
        mode: 'remote',
        endpoint: ENDPOINT,
        get timeoutMs() {
          controller.abort('gone');
          return 1000;
        },
      };
      const { callTool } = simfinity.generateMCPTools(stubSchema, { execution });

      await expect(callTool('item', { id: '9' }, { signal: controller.signal })).rejects.toBe('gone');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
      expect(fetchMock.mock.calls[0][1].signal.reason).toBe('gone');
    });

    it('fails the attempt with MCP_REMOTE_REQUEST_FAILED when timeoutMs elapses', async () => {
      stubAbortAwareFetch();
      const { signal } = new AbortController();

      const response = await remoteTools({ timeoutMs: 30 }).callTool('item', { id: '9' }, { signal });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain('MCP_REMOTE_REQUEST_FAILED');
      expect(fetchMock.mock.calls[0][1].signal.reason).toBe(timeoutSignals()[0].reason);
      expect(getEventListeners(signal, 'abort')).toHaveLength(0);
    });

    it('leaves no abort listener on a long-lived caller signal or the timeouts (guard)', async () => {
      const { signal } = new AbortController();
      const { callTool } = remoteTools({ timeoutMs: 60000, retry: { attempts: 1, backoffMs: 1 } });

      for (let i = 0; i < 20; i += 1) {
        fetchMock
          .mockResolvedValueOnce(httpError(503))
          .mockResolvedValueOnce(jsonResponse({ data: { item: null } }));
        expect((await callTool('item', { id: '9' }, { signal })).isError).toBe(false);
      }

      expect(fetchMock).toHaveBeenCalledTimes(40);
      expect(getEventListeners(signal, 'abort')).toHaveLength(0);
      expect(timeoutSignals()).toHaveLength(40);
      for (const timeout of timeoutSignals()) {
        expect(getEventListeners(timeout, 'abort')).toHaveLength(0);
      }
    });
  });
});

// ---------------------------------------------------------------------------
// In-process execution
// ---------------------------------------------------------------------------

describe('MCP callTool in-process execution', () => {
  it('reports _meta.count when pagination.count is true and the resolver sets context.count', async () => {
    const { callTool } = simfinity.generateMCPTools(stubSchema, { context: {} });
    const response = await callTool('items', { pagination: { page: 1, size: 10, count: true } });

    expect(response.isError).toBe(false);
    expect(response._meta).toEqual({ count: 7 });
    // The model sees the total too: hosts pass structuredContent or the text
    // to the model and keep _meta for client code.
    expect(response.structuredContent).toEqual({ items: [{ id: '1', name: 'One' }], totalCount: 7 });
    expect(JSON.parse(response.content[0].text)).toEqual(response.structuredContent);
  });

  it('omits _meta.count when pagination.count is not requested', async () => {
    const { callTool } = simfinity.generateMCPTools(stubSchema, { context: {} });
    const response = await callTool('items', { pagination: { page: 1, size: 10 } });

    expect(response.isError).toBe(false);
    expect(response._meta).toBeUndefined();
    expect(response.structuredContent).toEqual({ items: [{ id: '1', name: 'One' }] });
  });

  it('counts when limits.defaultPagination requests it', async () => {
    const { callTool } = simfinity.generateMCPTools(stubSchema, {
      context: {},
      limits: { defaultPagination: { page: 1, size: 10, count: true } },
    });
    const response = await callTool('items', {});

    expect(response._meta).toEqual({ count: 7 });
    expect(response.structuredContent.totalCount).toBe(7);
  });

  it('includes the total in the MCP_RESULT_TOO_LARGE error of an oversized counted list', async () => {
    const { callTool } = simfinity.generateMCPTools(stubSchema, { context: {}, limits: { maxResultBytes: 16 } });
    const counted = JSON.parse((await callTool('items', { pagination: { count: true } })).content[0].text);
    const uncounted = JSON.parse((await callTool('items', { pagination: {} })).content[0].text);

    expect(counted.errors[0].extensions).toEqual({ code: 'MCP_RESULT_TOO_LARGE', totalCount: 7 });
    expect(uncounted.errors[0].extensions).toEqual({ code: 'MCP_RESULT_TOO_LARGE' });
  });

  describe('_meta.count context isolation', () => {
    const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

    // Two list tools sharing one static context object: countingList writes
    // context.count (like simfinity's find resolver), quietList never does,
    // and slowList writes a per-call count before awaiting a per-call delay.
    const countSchema = new GraphQLSchema({
      query: new GraphQLObjectType({
        name: 'Query',
        fields: {
          countingList: {
            type: new GraphQLList(ItemType),
            args: { pagination: { type: PaginationInput } },
            resolve: (parent, args, context) => {
              context.count = 7;
              return [{ id: '1', name: 'Counted' }];
            },
          },
          quietList: {
            type: new GraphQLList(ItemType),
            args: { pagination: { type: PaginationInput } },
            resolve: () => [{ id: '2', name: 'Quiet' }],
          },
          slowList: {
            type: new GraphQLList(ItemType),
            args: {
              pagination: { type: PaginationInput },
              delayMs: { type: GraphQLInt },
              total: { type: GraphQLInt },
            },
            resolve: async (parent, args, context) => {
              // Write first, THEN wait: a concurrent call gets the chance to
              // clobber a shared count before this call's result is read.
              context.count = args.total;
              await wait(args.delayMs || 0);
              return [{ id: String(args.total), name: 'Slow' }];
            },
          },
        },
      }),
    });

    it('never leaks a stale count from a previous call on a shared context', async () => {
      const sharedContext = {};
      const { callTool } = simfinity.generateMCPTools(countSchema, { context: sharedContext });

      // Uncounted call: no private layer is created, so the resolver writes
      // count straight onto the shared context object — the stale value.
      const uncounted = await callTool('countingList', { pagination: { page: 1, size: 10 } });
      expect(uncounted.isError).toBe(false);
      expect(uncounted._meta).toBeUndefined();
      expect(sharedContext.count).toBe(7);

      // Counted call on the tool that DOES write a count.
      const counted = await callTool('countingList', { pagination: { count: true } });
      expect(counted.isError).toBe(false);
      expect(counted._meta).toEqual({ count: 7 });
      expect(counted.structuredContent.totalCount).toBe(7);

      // Counted call on a tool that does NOT write one: the count sitting on
      // the shared context must not surface as this call's _meta.count.
      const quiet = await callTool('quietList', { pagination: { count: true } });
      expect(quiet.isError).toBe(false);
      expect(quiet._meta).toBeUndefined();
      expect(quiet.structuredContent).toEqual({ quietList: [{ id: '2', name: 'Quiet' }] });
    });

    it('gives concurrent counted calls each their own count', async () => {
      const { callTool } = simfinity.generateMCPTools(countSchema, { context: {} });

      const [slow, fast] = await Promise.all([
        callTool('slowList', { pagination: { count: true }, delayMs: 40, total: 11 }),
        callTool('slowList', { pagination: { count: true }, delayMs: 5, total: 22 }),
      ]);

      expect(slow.isError).toBe(false);
      expect(fast.isError).toBe(false);
      expect(slow._meta).toEqual({ count: 11 });
      expect(fast._meta).toEqual({ count: 22 });
      expect(slow.structuredContent.totalCount).toBe(11);
      expect(fast.structuredContent.totalCount).toBe(22);
    });

    it('gives list resolvers without the countSink marker a context layer whose prototype is the caller context (guard)', async () => {
      const seen = [];
      const layerSchema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: 'Query',
          fields: {
            layeredList: {
              type: new GraphQLList(ItemType),
              args: { pagination: { type: PaginationInput } },
              resolve: (parent, args, context) => {
                seen.push({ parent, context });
                context.count = 3;
                return [];
              },
            },
          },
        }),
      });
      const shared = {};
      const { callTool } = simfinity.generateMCPTools(layerSchema, { context: shared });

      const counted = await callTool('layeredList', { pagination: { count: true } });
      expect(counted._meta).toEqual({ count: 3 });
      expect(seen[0].parent).toBeUndefined();
      expect(seen[0].context).not.toBe(shared);
      expect(Object.getPrototypeOf(seen[0].context)).toBe(shared);
      expect(Object.hasOwn(shared, 'count')).toBe(false);
    });
  });

  it('keeps partial data visible alongside errors', async () => {
    const { callTool } = simfinity.generateMCPTools(stubSchema);
    const response = await callTool('pair', {});

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toBeUndefined();
    const payload = JSON.parse(response.content[0].text);
    expect(payload.errors).toHaveLength(1);
    expect(payload.errors[0].message).toContain('boom');
    expect(payload.data.pair).toEqual({ good: 'ok', bad: null });
  });

  describe('limits', () => {
    it('rejects pagination.size above maxPageSize with MCP_PAGE_SIZE_EXCEEDED', async () => {
      const { callTool } = simfinity.generateMCPTools(stubSchema, { limits: { maxPageSize: 10 } });
      const response = await callTool('items', { pagination: { size: 50 } });

      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain('MCP_PAGE_SIZE_EXCEEDED');
    });

    it('allows pagination.size equal to maxPageSize', async () => {
      const { callTool } = simfinity.generateMCPTools(stubSchema, { limits: { maxPageSize: 10 } });
      const response = await callTool('items', { pagination: { size: 10 } });

      expect(response.isError).toBe(false);
    });

    it('injects defaultPagination when the caller sends none', async () => {
      const { callTool } = simfinity.generateMCPTools(stubSchema, {
        limits: { defaultPagination: { page: 2, size: 5 } },
      });
      const response = await callTool('echoPage', {});

      expect(response.isError).toBe(false);
      expect(response.structuredContent).toEqual({ echoPage: { page: 2, size: 5 } });
    });

    it('does not override explicit pagination with defaultPagination', async () => {
      const { callTool } = simfinity.generateMCPTools(stubSchema, {
        limits: { defaultPagination: { page: 2, size: 5 } },
      });
      const response = await callTool('echoPage', { pagination: { page: 9, size: 3 } });

      expect(response.structuredContent).toEqual({ echoPage: { page: 9, size: 3 } });
    });

    it('rejects oversized results with MCP_RESULT_TOO_LARGE', async () => {
      const { callTool } = simfinity.generateMCPTools(stubSchema, { limits: { maxResultBytes: 16 } });
      const response = await callTool('item', { id: 'a-rather-long-identifier' });

      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain('MCP_RESULT_TOO_LARGE');
    });

    it.each([[16.9, 16], ['16.5', 16]])('reports a fractional maxResultBytes %j as %i whole bytes in MCP_RESULT_TOO_LARGE', async (maxResultBytes, reported) => {
      const { callTool } = simfinity.generateMCPTools(stubSchema, { limits: { maxResultBytes } });
      const response = await callTool('item', { id: 'a-rather-long-identifier' });

      expect(JSON.parse(response.content[0].text).errors[0].message)
        .toMatch(new RegExp(`^Result of \\d+ bytes exceeds maxResultBytes \\(${reported}\\)\\. `));
    });

    describe('oversized mutation results', () => {
      const CAP = 512;
      const big = 'x'.repeat(2000);
      let writes = 0;
      const PartialType = new GraphQLObjectType({
        name: 'McpExecPartial',
        fields: () => ({
          id: { type: GraphQLString },
          bad: { type: GraphQLString, resolve: () => { throw new Error('e'.repeat(2000)); } },
        }),
      });
      const AuditedType = new GraphQLObjectType({
        name: 'McpExecAudited',
        fields: () => ({
          id: { type: GraphQLString },
          audit: { type: new GraphQLNonNull(GraphQLString), resolve: () => { throw new Error('a'.repeat(2000)); } },
        }),
      });
      const write = (value) => { writes += 1; return value; };
      const rejectOversized = () => { throw new Error(`Rejected: ${'r'.repeat(2000)}`); };
      const mutationSchema = new GraphQLSchema({
        query: new GraphQLObjectType({ name: 'Query', fields: { ping: { type: GraphQLString } } }),
        mutation: new GraphQLObjectType({
          name: 'Mutation',
          fields: {
            addBig: {
              type: ItemType, description: 'add', args: { input: { type: new GraphQLNonNull(AddInput) } }, resolve: () => write({ id: 'n1', name: big }),
            },
            updateBig: {
              type: ItemType, description: 'update', args: { input: { type: new GraphQLNonNull(AddInput) } }, resolve: () => write({ id: 'u1', name: big }),
            },
            deleteBig: {
              type: ItemType, description: 'delete', args: { id: { type: new GraphQLNonNull(GraphQLString) } }, resolve: () => write({ id: 'd1', name: big }),
            },
            importItems: {
              type: new GraphQLList(ItemType), description: 'Import items', resolve: () => write([{ id: 'a', name: big }, { id: 'b', name: big }]),
            },
            importMany: {
              type: new GraphQLList(ItemType),
              description: 'Import many items',
              resolve: () => write(Array.from({ length: 100 }, (unused, index) => ({ id: `item-${index}`, name: 'n' }))),
            },
            exportText: { type: GraphQLString, description: 'Export as text', resolve: () => write(big) },
            partial: { type: PartialType, description: 'Writes, then a field fails', resolve: () => write({ id: 'p1' }) },
            failing: {
              type: ItemType,
              description: 'Fails validation',
              resolve: () => { throw new Error(`Validation failed: ${'y'.repeat(2000)}`); },
            },
            bubbling: { type: AuditedType, description: 'Writes, then a non-null field fails', resolve: () => write({ id: 'b1' }) },
            truncated: { type: ItemType, description: 'Named like the notice key', resolve: () => write({ id: 't1', name: big }) },
            addRejected: {
              type: ItemType, description: 'add', args: { input: { type: new GraphQLNonNull(AddInput) } }, resolve: rejectOversized,
            },
            updateRejected: {
              type: ItemType, description: 'update', args: { input: { type: new GraphQLNonNull(AddInput) } }, resolve: rejectOversized,
            },
            deleteRejected: {
              type: ItemType, description: 'delete', args: { id: { type: new GraphQLNonNull(GraphQLString) } }, resolve: rejectOversized,
            },
            // Shaped like a generated state-machine transition.
            approveBig: {
              type: ItemType,
              args: { input: { type: new GraphQLNonNull(AddInput) } },
              extensions: {
                simfinityMutation: {
                  typeName: 'McpExecItem', operation: 'state_changed', action: 'approve', from: 'DRAFT', to: 'APPROVED',
                },
              },
              resolve: () => write({ id: 's1', name: big }),
            },
          },
        }),
      });
      const oversizedTools = (options = {}) => simfinity.generateMCPTools(mutationSchema, {
        limits: { maxResultBytes: CAP }, ...options,
      });
      const payloadOf = (response) => JSON.parse(response.content[0].text);

      beforeEach(() => { writes = 0; });

      it('reports an oversized successful mutation as applied, with its id and a notice', async () => {
        const response = await oversizedTools().callTool('addBig', { input: { name: 'n' } });

        expect(writes).toBe(1);
        expect(response.isError).toBe(false);
        expect(response._meta).toEqual({ truncated: true });
        expect(response.structuredContent.addBig).toEqual({ id: 'n1' });
        expect(response.structuredContent.truncated).toMatchObject({ applied: true, maxResultBytes: CAP });
        expect(response.structuredContent.truncated.resultBytes).toBeGreaterThan(CAP);
        const { message } = response.structuredContent.truncated;
        expect(message).toContain('addBig was applied (the record was created)');
        expect(message).toContain('only the id is returned');
        expect(message).toContain('Calling addBig again would create another record; do not call addBig again for this change');
        expect(JSON.parse(response.content[0].text)).toEqual(response.structuredContent);
      });

      it('words the notice per operation without contradicting idempotentHint', async () => {
        const { tools, callTool } = oversizedTools();
        expect(tools.find((tool) => tool.name === 'updateBig').annotations.idempotentHint).toBe(true);
        expect(tools.find((tool) => tool.name === 'deleteBig').annotations.idempotentHint).toBe(true);

        const update = (await callTool('updateBig', { input: { name: 'n' } })).structuredContent.truncated.message;
        expect(update).toContain('updateBig was applied (the record was updated)');
        expect(update).toContain('would not repeat the change, so there is no need to call it again');
        expect(update).not.toMatch(/do not call/i);

        const removed = (await callTool('deleteBig', { id: 'd1' })).structuredContent.truncated.message;
        expect(removed).toContain('deleteBig was applied (the record was deleted)');
        expect(removed).toContain('the record no longer exists, so there is nothing to read back');
        expect(removed).not.toContain('read the record');

        const custom = (await callTool('exportText', {})).structuredContent;
        expect(custom).toEqual({ truncated: expect.objectContaining({ applied: true }) });
        expect(custom.truncated.message).toContain('exportText was applied. Its full result');
        expect(custom.truncated.message).toContain('Calling exportText again could repeat the change; do not call exportText again');

        // The wording follows the published annotation, including overrides.
        const overridden = oversizedTools({ toolOverrides: { updateBig: { annotations: { idempotentHint: false } } } });
        const repeat = (await overridden.callTool('updateBig', { input: { name: 'n' } })).structuredContent.truncated.message;
        expect(repeat).toContain('Calling updateBig again could repeat the change; do not call updateBig again for this change');
      });

      it('keeps the ids of a list-returning mutation and drops an id list that alone exceeds the cap', async () => {
        const { callTool } = oversizedTools();
        const listed = await callTool('importItems', {});
        expect(listed.isError).toBe(false);
        expect(listed.structuredContent.importItems).toEqual([{ id: 'a' }, { id: 'b' }]);
        expect(listed.structuredContent.truncated.message).toContain('only the ids are returned');

        const many = await callTool('importMany', {});
        expect(many.isError).toBe(false);
        expect(many.structuredContent).not.toHaveProperty('importMany');
        expect(many.structuredContent.truncated.message).toContain('its ids alone exceed maxResultBytes and were omitted too');
      });

      it('says "its id" when a single root id alone exceeds the cap', async () => {
        // {"id":"n1"} is 11 bytes.
        const response = await oversizedTools({ limits: { maxResultBytes: 10 } }).callTool('addBig', { input: { name: 'n' } });

        expect(response.isError).toBe(false);
        expect(response.structuredContent).toEqual({ truncated: expect.objectContaining({ applied: true, maxResultBytes: 10 }) });
        const { message } = response.structuredContent.truncated;
        expect(message).toContain('; its id alone exceeds maxResultBytes and was omitted too.');
        expect(message).not.toContain('ids');
      });

      it('words the "unknown" notice of a create, an idempotent update and a delete per operation (guard)', async () => {
        const { tools, callTool } = oversizedTools();
        const messageOf = async (name, args) => {
          const { errors, data } = payloadOf(await callTool(name, args));
          expect(errors[0].extensions).toMatchObject({ code: 'MCP_RESULT_TOO_LARGE', applied: 'unknown' });
          expect(data).toBeUndefined();
          expect(errors[0].message).toContain(`${name} returned errors; the error result (`);
          expect(errors[0].message).toContain('It may have been applied, fully or in part.');
          return errors[0].message;
        };

        const add = await messageOf('addRejected', { input: { name: 'n' } });
        expect(add).toContain('If it was applied, calling addRejected again would create another record.');
        expect(add).toContain('Check the current state with a query tool before calling it again.');

        expect(tools.find((tool) => tool.name === 'updateRejected').annotations.idempotentHint).toBe(true);
        const update = await messageOf('updateRejected', { input: { name: 'n' } });
        expect(update).toContain('Calling updateRejected again with the same arguments would not repeat a change that was already applied.');
        expect(update).toContain('Check the current state with a query tool before calling it again.');
        expect(update).not.toMatch(/do not call|could repeat|would create/i);

        const removal = await messageOf('deleteRejected', { id: 'd1' });
        expect(removal).toContain('Calling deleteRejected again with the same arguments would not repeat a change that was already applied.');
        expect(removal).toContain('Check whether the record still exists with a query tool before calling it again.');
        expect(removal).not.toContain('read the record');
        expect(removal).not.toMatch(/do not call|could repeat|would create/i);
        expect(writes).toBe(0);
      });

      it('reports an oversized state transition as applied, warning that a repeat could repeat it (guard)', async () => {
        const { tools, callTool } = oversizedTools();
        expect(tools.find((tool) => tool.name === 'approveBig').annotations).not.toHaveProperty('idempotentHint');
        const response = await callTool('approveBig', { input: { name: 'n' } });

        expect(writes).toBe(1);
        expect(response.isError).toBe(false);
        expect(response._meta).toEqual({ truncated: true });
        expect(response.structuredContent.approveBig).toEqual({ id: 's1' });
        const { message, resultBytes } = response.structuredContent.truncated;
        expect(message).toBe(`approveBig was applied. Its full result (${resultBytes} bytes) exceeds maxResultBytes (${CAP}) and was omitted; only the id is returned. Calling approveBig again could repeat the change; do not call approveBig again for this change; use a query tool to read the current state if you need it.`);
      });

      it('keeps an oversized mutation with field errors an error, saying it was applied', async () => {
        const response = await oversizedTools().callTool('partial', {});
        const payload = payloadOf(response);

        expect(writes).toBe(1);
        expect(response.isError).toBe(true);
        expect(response.structuredContent).toBeUndefined();
        expect(payload.errors).toHaveLength(1);
        expect(payload.errors[0].extensions).toMatchObject({ code: 'MCP_RESULT_TOO_LARGE', applied: true });
        expect(payload.errors[0].extensions.firstError).toBe(`${'e'.repeat(300)}…`);
        expect(payload.errors[0].message).toContain('partial was applied, but parts of its result failed');
        expect(payload.errors[0].message).toContain('do not call partial again for this change');
        expect(payload.data).toEqual({ partial: { id: 'p1' } });
      });

      it('reports applied "unknown" with a truncated first error when the mutation returned no root value', async () => {
        const response = await oversizedTools().callTool('failing', {});
        const payload = payloadOf(response);

        expect(response.isError).toBe(true);
        expect(payload.errors[0].extensions.code).toBe('MCP_RESULT_TOO_LARGE');
        expect(payload.errors[0].extensions.applied).toBe('unknown');
        expect(payload.errors[0].extensions.firstError).toBe(`Validation failed: ${'y'.repeat(281)}…`);
        expect(payload.errors[0].message).toContain('It may have been applied, fully or in part.');
        expect(payload.errors[0].message).toContain('If it was applied, calling failing again could repeat the change.');
        expect(payload.errors[0].message).toContain('Check the current state with a query tool before calling it again.');
        expect(payload.data).toBeUndefined();
      });

      it('never reports applied false when NonNull bubbling nulls the root of a committed write', async () => {
        const response = await oversizedTools().callTool('bubbling', {});
        const payload = payloadOf(response);

        expect(writes).toBe(1);
        expect(response.isError).toBe(true);
        expect(payload.errors[0].extensions.applied).toBe('unknown');
        expect(response.content[0].text).not.toContain('"applied": false');
      });

      it('uses __truncated for a mutation whose root field is named truncated', async () => {
        const { tools, callTool } = oversizedTools();
        const response = await callTool('truncated', {});

        expect(response.isError).toBe(false);
        expect(response.structuredContent.truncated).toEqual({ id: 't1' });
        expect(response.structuredContent.__truncated).toMatchObject({ applied: true });
        expect(Object.keys(tools.find((tool) => tool.name === 'truncated').outputSchema.properties))
          .toEqual(['truncated', '__truncated']);
      });

      it('leaves mutation results within the cap unchanged (guard)', async () => {
        const { callTool } = simfinity.generateMCPTools(mutationSchema, { limits: { maxResultBytes: 100000 } });
        const response = await callTool('addBig', { input: { name: 'n' } });

        expect(response._meta).toBeUndefined();
        expect(response.structuredContent).toEqual({ addBig: { id: 'n1', name: big } });
      });
    });

    it('throws MCP_INVALID_LIMITS at setup when defaultPagination.size exceeds maxPageSize', () => {
      let error;
      try {
        simfinity.generateMCPTools(stubSchema, {
          limits: { defaultPagination: { page: 1, size: 500 }, maxPageSize: 100 },
        });
      } catch (err) {
        error = err;
      }
      expect(error).toBeDefined();
      expect(error.extensions.code).toBe('MCP_INVALID_LIMITS');
    });

    describe('setup validation', () => {
      const setupError = (schema, limits) => {
        try {
          simfinity.generateMCPTools(schema, { limits });
        } catch (err) {
          return err;
        }
        return undefined;
      };
      const expectInvalid = async (schema, limits, message) => {
        const error = setupError(schema, limits);
        expect(error).toMatchObject({ extensions: { code: 'MCP_INVALID_LIMITS' } });
        if (message) {
          expect(error.message).toMatch(message);
        }
        await expect(simfinity.createHTTPMCPHandler(schema, { limits }))
          .rejects.toMatchObject({ extensions: { code: 'MCP_INVALID_LIMITS' } });
      };

      // A generated Simfinity list, whose pagination argument is QLPagination.
      const pagedRuntime = createRuntime({
        bind() {},
        prepare() {},
        createModel: (gqltype) => ({ name: gqltype.name }),
        castId: String,
        withTransaction: async (session, body) => body(session || {}),
        async getById() { return null; },
        async find() { return [{ _id: 'n1', text: 'note' }]; },
        async count() { return 1; },
        async aggregate() { return []; },
        async findChildren() { return []; },
      });
      pagedRuntime.connect(null, new GraphQLObjectType({
        name: 'McpExecNote',
        fields: () => ({ id: { type: GraphQLString }, text: { type: GraphQLString } }),
      }), 'mcpexecnote', 'mcpexecnotes');
      const pagedSchema = pagedRuntime.createSchema();

      it.each([
        ['a missing page', { size: 20 }, /QLPagination for the pagination argument of tool "mcpexecnotes": Field "page" of required type "Int!" was not provided/],
        ['a zero size', { page: 1, size: 0 }, /requires page and size to be positive integers/],
        ['a zero page', { page: 0, size: 20 }, /requires page and size to be positive integers/],
        ['a negative size', { page: 1, size: -5 }, /requires page and size to be positive integers/],
        ['a fractional size', { page: 1, size: 2.5 }, /Int cannot represent non-integer value: 2.5/],
        ['a string size', { page: 1, size: '20' }, /Int cannot represent non-integer value: "20"/],
        ['a non-boolean count', { page: 1, size: 20, count: 'yes' }, /Boolean cannot represent a non boolean value/],
        ['an unknown key', { page: 1, size: 20, offset: 0 }, /Field "offset" is not defined by type "QLPagination"/],
        ['a number', 20, /limits.defaultPagination must be an object such as \{ page: 1, size: 20 \}, got number/],
        ['a string', 'page=1', /got string/],
      ])('rejects a default page with %s at setup in both factories', async (label, defaultPagination, message) => {
        await expectInvalid(pagedSchema, { defaultPagination }, message);
      });

      it('accepts a valid QLPagination default page (guard)', async () => {
        const { callTool } = simfinity.generateMCPTools(pagedSchema, { limits: { defaultPagination: { page: 1, size: 10, count: true } } });
        const response = await callTool('mcpexecnotes', {});
        expect(response.isError).toBe(false);
        expect(response.structuredContent.totalCount).toBe(1);
      });

      it('validates the default page against a custom pagination type, not QLPagination', async () => {
        // McpExecPagination declares page and size nullable.
        const { callTool } = simfinity.generateMCPTools(stubSchema, { limits: { defaultPagination: { size: 5 } } });
        expect((await callTool('echoPage', {})).structuredContent).toEqual({ echoPage: { page: null, size: 5 } });

        await expectInvalid(stubSchema, { defaultPagination: { size: '5' } }, /not a valid McpExecPagination for the pagination argument of tool "items"/);
        await expectInvalid(stubSchema, { defaultPagination: { size: 5, cursor: 'a' } }, /Field "cursor" is not defined/);
      });

      it.each([
        ['the number -1', -1, '-1'],
        ['the string "-1"', '-1', '"-1"'],
        ['the bigint -1n', -1n, '-1n'],
        ['true', true, 'true'],
        ['a blank string', ' ', '" "'],
        ['a tab', '\t', '"\\t"'],
        ['the string "0"', '0', '"0"'],
        ['the string "0.0"', '0.0', '"0.0"'],
        ['the number 0.5', 0.5, '0.5'],
        ['the string "0.5"', '0.5', '"0.5"'],
        ['the number 1e-9', 1e-9, '1e-9'],
        ['a non-numeric string', 'abc', '"abc"'],
        ['an object', {}, 'object'],
        ['an array', [], 'an array'],
        ['a function', () => 1, 'a function'],
      ])('rejects a cap that is %s at setup', async (label, cap, shown) => {
        const message = (name) => `limits.${name} must be a number of at least 1, got ${shown}; omit it, or pass 0, false or null, to disable the cap`;
        await expectInvalid(stubSchema, { maxPageSize: cap }, message('maxPageSize'));
        await expectInvalid(stubSchema, { maxResultBytes: cap }, message('maxResultBytes'));
      });

      it.each([
        ['undefined', undefined], ['null', null], ['false', false], ['0', 0], ['an empty string', ''], ['0n', 0n],
      ])('treats a cap that is %s as unset (guard)', async (label, cap) => {
        const { callTool } = simfinity.generateMCPTools(stubSchema, { limits: { maxPageSize: cap, maxResultBytes: cap } });
        expect((await callTool('echoPage', { pagination: { page: 1, size: 5000 } })).isError).toBe(false);
      });

      it('keeps numeric-string, bigint and Infinity caps working (guard)', async () => {
        for (const cap of ['10', ' 10 ', 10n, '1e1']) {
          const { callTool } = simfinity.generateMCPTools(stubSchema, { limits: { maxPageSize: cap } });
          expect((await callTool('echoPage', { pagination: { size: 10 } })).isError).toBe(false);
          expect((await callTool('echoPage', { pagination: { size: 11 } })).content[0].text).toContain('MCP_PAGE_SIZE_EXCEEDED');
        }
        const unlimited = simfinity.generateMCPTools(stubSchema, { limits: { maxPageSize: 'Infinity', maxResultBytes: 'Infinity' } });
        expect((await unlimited.callTool('echoPage', { pagination: { size: 5000 } })).isError).toBe(false);
        const small = simfinity.generateMCPTools(stubSchema, { limits: { maxResultBytes: '16' } });
        expect((await small.callTool('item', { id: 'a-rather-long-identifier' })).content[0].text).toContain('exceeds maxResultBytes (16)');
      });

      it('accepts caps of exactly 1 (guard)', async () => {
        const { callTool } = simfinity.generateMCPTools(stubSchema, { limits: { maxPageSize: 1, maxResultBytes: '1' } });
        expect((await callTool('echoPage', { pagination: { size: 2 } })).content[0].text).toContain('MCP_PAGE_SIZE_EXCEEDED');
        expect((await callTool('echoPage', { pagination: { size: 1 } })).content[0].text).toContain('exceeds maxResultBytes (1)');
      });

      it('applies no NaN cap and warns once per setup', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
          const { callTool } = simfinity.generateMCPTools(stubSchema, { limits: { maxPageSize: Number.NaN, maxResultBytes: Number.NaN } });
          expect(warn).toHaveBeenCalledTimes(1);
          expect(warn.mock.calls[0][0]).toBe('[simfinity-mcp] limits.maxPageSize and limits.maxResultBytes are NaN, so no cap is applied. Pass a number of at least 1, or omit it.');
          expect((await callTool('echoPage', { pagination: { size: 5000 } })).isError).toBe(false);
          expect(warn).toHaveBeenCalledTimes(1);

          // Each setup warns: there is no process-wide deduplication.
          await simfinity.createHTTPMCPHandler(stubSchema, { limits: { maxResultBytes: Number.NaN } });
          expect(warn).toHaveBeenCalledTimes(2);
          expect(warn.mock.calls[1][0]).toContain('limits.maxResultBytes is NaN');
        } finally {
          warn.mockRestore();
        }
      });

      it('treats limits: null as unset', async () => {
        const { callTool } = simfinity.generateMCPTools(stubSchema, { limits: null });
        expect((await callTool('echoPage', {})).isError).toBe(false);
        await expect(simfinity.createHTTPMCPHandler(stubSchema, { limits: null })).resolves.toBeTypeOf('function');
      });

      it.each([['false', false], ['0', 0], ['an empty string', ''], ['NaN', Number.NaN]])('treats limits that is %s as unset (guard)', async (label, limits) => {
        const { callTool } = simfinity.generateMCPTools(stubSchema, { limits });
        expect((await callTool('echoPage', { pagination: { size: 5000 } })).isError).toBe(false);
      });

      it.each([['null', null], ['false', false], ['0', 0], ['an empty string', '']])('treats a defaultPagination that is %s as unset (guard)', async (label, defaultPagination) => {
        const { callTool } = simfinity.generateMCPTools(pagedSchema, { limits: { defaultPagination, maxPageSize: 10 } });
        expect((await callTool('mcpexecnotes', {})).isError).toBe(false);
      });

      it.each([
        ['a string', 'x', /limits must be an object such as \{ maxPageSize: 100 \}, got string/],
        ['a number', 5, /got number/],
        ['true', true, /got boolean/],
        ['an array', [], /got an array/],
        ['a function', () => ({}), /got a function/],
      ])('rejects limits that is %s at setup', async (label, limits, message) => {
        await expectInvalid(stubSchema, limits, message);
      });

      it('reads the caller limits object on every call (guard)', async () => {
        const limits = { maxPageSize: 100 };
        const { callTool } = simfinity.generateMCPTools(stubSchema, { limits });
        expect((await callTool('echoPage', { pagination: { size: 10 } })).isError).toBe(false);
        limits.maxPageSize = 5;
        expect((await callTool('echoPage', { pagination: { size: 10 } })).content[0].text).toContain('MCP_PAGE_SIZE_EXCEEDED');
        limits.maxPageSize = '20';
        expect((await callTool('echoPage', { pagination: { size: 10 } })).isError).toBe(false);
        limits.defaultPagination = { page: 3, size: 2 };
        expect((await callTool('echoPage', {})).structuredContent).toEqual({ echoPage: { page: 3, size: 2 } });
      });

      it('fails calls with MCP_INVALID_LIMITS when a cap is changed to an invalid value after setup', async () => {
        const limits = { maxPageSize: 100 };
        const { callTool } = simfinity.generateMCPTools(stubSchema, { limits });
        limits.maxPageSize = -1;
        await expect(callTool('echoPage', { pagination: { size: 10 } }))
          .rejects.toMatchObject({ extensions: { code: 'MCP_INVALID_LIMITS' } });
      });
    });
  });

  describe('toolMiddleware', () => {
    it('runs middleware in onion order around the execution', async () => {
      const order = [];
      const mw1 = async (call, next) => {
        order.push('mw1:before');
        expect(call.kind).toBe('query');
        expect(call.operation).toContain('itemOperation');
        const result = await next();
        order.push('mw1:after');
        return result;
      };
      const mw2 = async (call, next) => {
        order.push('mw2:before');
        const result = await next();
        order.push('mw2:after');
        return result;
      };

      const { callTool } = simfinity.generateMCPTools(stubSchema, { toolMiddleware: [mw1, mw2] });
      const response = await callTool('item', { id: '1' });

      expect(response.isError).toBe(false);
      expect(order).toEqual(['mw1:before', 'mw2:before', 'mw2:after', 'mw1:after']);
    });

    it('makes args mutations visible to the resolver', async () => {
      const rewrite = (call, next) => {
        call.args = { ...call.args, id: 'rewritten' };
        return next();
      };

      const { callTool } = simfinity.generateMCPTools(stubSchema, { toolMiddleware: [rewrite] });
      const response = await callTool('item', { id: 'original' });

      expect(response.structuredContent.item.id).toBe('rewritten');
    });

    it('lets middleware short-circuit without executing the operation', async () => {
      const cached = { content: [{ type: 'text', text: 'cached' }], isError: false };
      const shortCircuit = () => cached;

      const { callTool } = simfinity.generateMCPTools(stubSchema, { toolMiddleware: [shortCircuit] });
      const callsBefore = itemCalls;
      const response = await callTool('item', { id: '1' });

      expect(response).toBe(cached);
      expect(itemCalls).toBe(callsBefore);
    });

    it('propagates middleware exceptions to the caller', async () => {
      const failing = () => {
        throw new Error('mw-fail');
      };

      const { callTool } = simfinity.generateMCPTools(stubSchema, { toolMiddleware: [failing] });
      await expect(callTool('item', { id: '1' })).rejects.toThrow('mw-fail');
    });

    // A non-async policy check that throws synchronously.
    const policy = () => {
      throw new Error('policy denied');
    };
    const blocked = (err) => ({ content: [{ type: 'text', text: `blocked: ${err.message}` }], isError: true });

    it('lets an outer .catch boundary handle a synchronous throw from an inner middleware', async () => {
      const boundary = (call, next) => next().catch(blocked);
      const { callTool } = simfinity.generateMCPTools(stubSchema, { toolMiddleware: [boundary, policy] });
      const callsBefore = itemCalls;

      const response = await callTool('item', { id: '1' });

      expect(response).toEqual({ content: [{ type: 'text', text: 'blocked: policy denied' }], isError: true });
      expect(itemCalls).toBe(callsBefore);
    });

    it('runs an outer finally around a synchronous inner throw', async () => {
      const log = [];
      const metrics = (call, next) => next().finally(() => log.push(call.name));
      const { callTool } = simfinity.generateMCPTools(stubSchema, { toolMiddleware: [metrics, policy] });

      await expect(callTool('item', { id: '1' })).rejects.toThrow('policy denied');
      expect(log).toEqual(['item']);
    });

    it.each([
      ['a synchronous inner throw', [policy], undefined],
      ['an asynchronous inner throw', [async () => { throw new Error('policy denied'); }], undefined],
      ['a rejected execution', [], { signal: AbortSignal.abort() }],
    ])('does not leave an unhandled rejection when an outer middleware awaits other work before awaiting next(): %s', async (label, inner, extra) => {
      const unhandled = [];
      const onUnhandled = (reason) => { unhandled.push(reason); };
      process.on('unhandledRejection', onUnhandled);
      try {
        const deferred = async (call, next) => {
          const pending = next();
          await new Promise((resolve) => { setTimeout(resolve, 20); });
          try {
            return await pending;
          } catch (err) {
            return blocked(err);
          }
        };
        const { callTool } = simfinity.generateMCPTools(stubSchema, { toolMiddleware: [deferred, ...inner] });

        const response = await callTool('item', { id: '1' }, extra);

        expect(response.isError).toBe(true);
        expect(response.content[0].text).toMatch(/^blocked: (policy denied|MCP tool call cancelled: item)$/);
        await new Promise((resolve) => { setTimeout(resolve, 10); });
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

    it('rejects with MCP_MIDDLEWARE_ERROR when next() is called twice', async () => {
      const doubleNext = async (call, next) => {
        await next();
        await next();
      };

      const { callTool } = simfinity.generateMCPTools(stubSchema, { toolMiddleware: [doubleNext] });
      await expect(callTool('item', { id: '1' })).rejects.toMatchObject({
        extensions: { code: 'MCP_MIDDLEWARE_ERROR' },
      });
    });

    it('rejects with MCP_MIDDLEWARE_ERROR when middleware neither returns a result nor calls next()', async () => {
      const sideEffectsOnly = async () => {
        // Performs side effects but forgets `return next()`.
      };

      const { callTool } = simfinity.generateMCPTools(stubSchema, { toolMiddleware: [sideEffectsOnly] });
      await expect(callTool('item', { id: '1' })).rejects.toMatchObject({
        extensions: { code: 'MCP_MIDDLEWARE_ERROR' },
      });
    });

    const DENY = { content: [{ type: 'text', text: 'denied' }], isError: true };

    it.each([
      ['zero-parameter', () => DENY],
      ['rest-parameter', (...args) => (args.length ? DENY : DENY)],
      ['default-parameter', (call = {}) => (call ? DENY : DENY)],
      ['two-parameter', (call, next) => (next ? DENY : DENY)],
    ])('runs a single %s function as a one-element stack', async (label, guard) => {
      const { callTool } = simfinity.generateMCPTools(stubSchema, { toolMiddleware: guard });
      const callsBefore = itemCalls;

      expect(await callTool('item', { id: '1' })).toBe(DENY);
      expect(itemCalls).toBe(callsBefore);
    });

    it.each([
      ['a null entry', [(call, next) => next(), null], /toolMiddleware\[1\] must be a function/],
      ['an undefined entry', [undefined], /toolMiddleware\[0\] must be a function/],
      ['an object entry', [{}], /toolMiddleware\[0\] must be a function/],
      // A stray double comma leaves a hole that forEach would skip.
      // eslint-disable-next-line no-sparse-arrays
      ['a sparse array literal', [(call, next) => next(), , (call, next) => next()], /toolMiddleware\[1\] must be a function, got an empty array slot/],
      ['a preallocated array', new Array(2), /toolMiddleware\[0\] must be a function, got an empty array slot/],
      ['an array with a deleted entry', (() => {
        const stack = [(call, next) => next(), (call, next) => next()];
        delete stack[1];
        return stack;
      })(), /toolMiddleware\[1\] must be a function, got an empty array slot/],
      ['a string', 'logger', /toolMiddleware must be a function or an array/],
      ['an object', {}, /toolMiddleware must be a function or an array/],
    ])('rejects %s at setup with MCP_INVALID_MIDDLEWARE', (label, toolMiddleware, message) => {
      let error;
      try {
        simfinity.generateMCPTools(stubSchema, { toolMiddleware });
      } catch (err) {
        error = err;
      }
      expect(error).toMatchObject({ extensions: { code: 'MCP_INVALID_MIDDLEWARE' } });
      expect(error.message).toMatch(message);
    });

    it('copies the stack at setup, ignoring later changes to the array', async () => {
      const stack = [];
      const { callTool } = simfinity.generateMCPTools(stubSchema, { toolMiddleware: stack });
      stack.push(() => DENY);
      const callsBefore = itemCalls;

      expect((await callTool('item', { id: '1' })).isError).toBe(false);
      expect(itemCalls).toBe(callsBefore + 1);
    });
  });

  describe('schemaPlugins', () => {
    it('applies onSchemaChange resolver wraps to in-process execution', async () => {
      const PluginItemType = new GraphQLObjectType({
        name: 'McpExecPluginItem',
        fields: () => ({ id: { type: GraphQLString } }),
      });
      const pluginSchema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: 'Query',
          fields: {
            secret: { type: PluginItemType, resolve: () => ({ id: 'open' }) },
          },
        }),
      });

      const plugin = {
        onSchemaChange: vi.fn(({ schema }) => {
          const field = schema.getQueryType().getFields().secret;
          field.resolve = () => {
            throw new Error('denied by auth plugin');
          };
        }),
      };

      const { callTool } = simfinity.generateMCPTools(pluginSchema, { schemaPlugins: [plugin] });
      expect(plugin.onSchemaChange).toHaveBeenCalledTimes(1);

      const response = await callTool('secret', {});
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain('denied by auth plugin');
    });

    // Fresh schema per test: plugins wrap its resolvers in place.
    const guardedSchema = (name) => {
      const calls = { count: 0 };
      const schema = new GraphQLSchema({
        query: new GraphQLObjectType({
          name: `McpExecGuard${name}`,
          fields: {
            secret: {
              type: GraphQLString,
              resolve: () => {
                calls.count += 1;
                return 'open';
              },
            },
          },
        }),
      });
      return { schema, calls };
    };
    const denyPlugin = () => ({
      onSchemaChange({ schema }) {
        Object.values(schema.getQueryType().getFields()).forEach((field) => {
          field.resolve = () => {
            throw new Error('denied by auth plugin');
          };
        });
      },
    });
    const setupError = (fn) => {
      try {
        fn();
      } catch (err) {
        return err;
      }
      return undefined;
    };

    it.each([
      ['a plugin factory', () => [denyPlugin]],
      ['a nested array', () => [[denyPlugin()]]],
      ['a promise', () => [Promise.resolve(denyPlugin())]],
      ['an object without hooks', () => [{}]],
      ['a non-function onSchemaChange', () => [{ onSchemaChange: true }]],
      ['a non-array plugin object', () => denyPlugin()],
      ['a string', () => 'auth'],
    ])('rejects %s with MCP_INVALID_SCHEMA_PLUGIN before invoking any hook', (label, build) => {
      const { schema, calls } = guardedSchema(`Invalid${label.replace(/\W/g, '')}`);
      const first = { onSchemaChange: vi.fn() };
      const schemaPlugins = build();
      const error = setupError(() => simfinity.generateMCPTools(schema, {
        schemaPlugins: Array.isArray(schemaPlugins) ? [first, ...schemaPlugins] : schemaPlugins,
      }));

      expect(error).toMatchObject({ extensions: { code: 'MCP_INVALID_SCHEMA_PLUGIN' } });
      expect(first.onSchemaChange).not.toHaveBeenCalled();
      expect(calls.count).toBe(0);
    });

    it.each([
      ['an undefined schema', () => ({ schema: undefined }), 'MCP_INVALID_SCHEMA'],
      ['an object that is not a schema', () => ({ schema: {} }), 'MCP_INVALID_SCHEMA'],
      ['an invalid toolNamePrefix', () => ({ options: { toolNamePrefix: 'bad prefix!' } }), 'MCP_INVALID_TOOL_NAME'],
      ['a default page above maxPageSize', () => ({ options: { limits: { maxPageSize: 1, defaultPagination: { page: 1, size: 5 } } } }), 'MCP_INVALID_LIMITS'],
      ['a negative cap', () => ({ options: { limits: { maxResultBytes: -1 } } }), 'MCP_INVALID_LIMITS'],
      ['an invalid toolMiddleware', () => ({ options: { toolMiddleware: [null] } }), 'MCP_INVALID_MIDDLEWARE'],
      ['an invalid execution mode', () => ({ options: { execution: { mode: 'bogus' } } }), 'MCP_INVALID_EXECUTION_MODE'],
    ])('validates %s before running onSchemaChange, leaving the resolvers as they were (guard)', async (label, build, code) => {
      const guarded = guardedSchema(`Order${label.replace(/\W/g, '')}`);
      const original = guarded.schema.getQueryType().getFields().secret.resolve;
      const built = build();
      const schema = 'schema' in built ? built.schema : guarded.schema;
      const options = built.options || {};
      const plugin = { onSchemaChange: vi.fn(denyPlugin().onSchemaChange) };
      const withPlugin = { ...options, schemaPlugins: [plugin] };

      expect(setupError(() => simfinity.generateMCPTools(schema, withPlugin))).toMatchObject({ extensions: { code } });
      await expect(simfinity.createMCPServer(schema, withPlugin)).rejects.toMatchObject({ extensions: { code } });
      await expect(simfinity.createHTTPMCPHandler(schema, withPlugin)).rejects.toMatchObject({ extensions: { code } });

      expect(plugin.onSchemaChange).not.toHaveBeenCalled();
      const { secret } = guarded.schema.getQueryType().getFields();
      expect(secret.resolve).toBe(original);
      expect(await graphql({ schema: guarded.schema, source: '{ secret }' })).toEqual({ data: { secret: 'open' } });
      expect(guarded.calls.count).toBe(1);
    });

    it.each([
      ['an own onSchemaChanged', 'onSchemaChanged', () => ({ onSchemaChanged: denyPlugin().onSchemaChange })],
      ['an own onSchemaChage', 'onSchemaChage', () => ({ onSchemaChage: denyPlugin().onSchemaChange })],
      ['an own onschemaChange', 'onschemaChange', () => ({ onschemaChange: denyPlugin().onSchemaChange })],
      ['an own onSchemChange', 'onSchemChange', () => ({ onSchemChange: denyPlugin().onSchemaChange })],
      ['an own onShemaChange', 'onShemaChange', () => ({ onShemaChange: denyPlugin().onSchemaChange })],
      ['an own onSchmeaChange', 'onSchmeaChange', () => ({ onSchmeaChange: denyPlugin().onSchemaChange })],
      ['an own onScemaChange (next to onExecute)', 'onScemaChange', () => ({ onScemaChange: denyPlugin().onSchemaChange, onExecute() {} })],
      ['a getter onSchemeChange', 'onSchemeChange', () => Object.defineProperty({}, 'onSchemeChange', {
        get: () => { throw new Error('getter invoked'); },
        enumerable: true,
      })],
      ['an inherited onSchemaChanged', 'onSchemaChanged', () => new (class {
        onSchemaChanged(payload) { denyPlugin().onSchemaChange(payload); }
      })()],
    ])('rejects %s hook with a did-you-mean hint instead of warning', (label, key, build) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { schema, calls } = guardedSchema(`Misspelled${label.replace(/\W/g, '')}`);
        const first = { onSchemaChange: vi.fn() };
        const error = setupError(() => simfinity.generateMCPTools(schema, { schemaPlugins: [first, build()] }));

        expect(error).toMatchObject({ extensions: { code: 'MCP_INVALID_SCHEMA_PLUGIN' } });
        expect(error.message).toContain(`schemaPlugins[1] declares ${key}`);
        expect(error.message).toContain('did you mean onSchemaChange?');
        expect(first.onSchemaChange).not.toHaveBeenCalled();
        expect(calls.count).toBe(0);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        warn.mockRestore();
      }
    });

    it.each([
      ['a class plugin with an onSchemaReady helper', () => new (class {
        onSchemaChange(payload) {
          denyPlugin().onSchemaChange(payload);
          this.onSchemaReady();
        }

        onSchemaReady() {
          this.ready = true;
        }
      })()],
      ['a class plugin delegating to onSchemaChangeImpl', () => new (class {
        constructor() {
          this.onSchemaChangeCount = 0;
        }

        onSchemaChange(payload) {
          this.onSchemaChangeCount += 1;
          return this.onSchemaChangeImpl(payload);
        }

        onSchemaChangeImpl(payload) {
          denyPlugin().onSchemaChange(payload);
        }
      })()],
      ['onSchemaChanged next to onSchemaChange', () => ({ ...denyPlugin(), onSchemaChanged() {} })],
    ])('accepts %s and installs its onSchemaChange', async (label, build) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { schema, calls } = guardedSchema(`Helper${label.replace(/\W/g, '')}`);
        const { callTool } = simfinity.generateMCPTools(schema, { schemaPlugins: [build()] });

        const response = await callTool('secret', {});
        expect(response.isError).toBe(true);
        expect(response.content[0].text).toContain('denied by auth plugin');
        expect(calls.count).toBe(0);
      } finally {
        warn.mockRestore();
      }
    });

    it('rejects an entry with a then accessor as a promise without invoking it', () => {
      const then = vi.fn(() => {
        throw new Error('then getter invoked');
      });
      const { schema, calls } = guardedSchema('ThenGetter');
      const thenable = Object.defineProperty(denyPlugin(), 'then', { get: then });
      const error = setupError(() => simfinity.generateMCPTools(schema, { schemaPlugins: [thenable] }));

      expect(error).toMatchObject({ extensions: { code: 'MCP_INVALID_SCHEMA_PLUGIN' } });
      expect(error.message).toContain('schemaPlugins[0] must be a plugin object, got a promise');
      expect(then).not.toHaveBeenCalled();
      expect(calls.count).toBe(0);
    });

    it('reads no plugin property other than onSchemaChange during setup', () => {
      const reads = new Set();
      const plugin = new Proxy(denyPlugin(), {
        get(target, key, receiver) {
          reads.add(key);
          return Reflect.get(target, key, receiver);
        },
      });
      simfinity.generateMCPTools(guardedSchema('ProxyReads').schema, { schemaPlugins: [plugin] });

      expect([...reads]).toEqual(['onSchemaChange']);
    });

    it('validates a plugin without invoking its getters', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        class AuditPlugin {
          #schema;

          get schema() {
            if (!this.#schema) {
              throw new Error('AuditPlugin not initialized');
            }
            return this.#schema;
          }

          onSchemaChange(payload) {
            this.#schema = payload.schema;
            denyPlugin().onSchemaChange(payload);
          }
        }
        const { schema, calls } = guardedSchema('Getter');
        const { callTool } = simfinity.generateMCPTools(schema, { schemaPlugins: [new AuditPlugin()] });

        expect((await callTool('secret', {})).isError).toBe(true);
        expect(calls.count).toBe(0);

        // A hook defined by a getter counts as declared without being called.
        const onExecute = vi.fn(() => {
          throw new Error('getter invoked');
        });
        const shared = Object.defineProperty({}, 'onExecute', { get: onExecute, enumerable: true });
        simfinity.generateMCPTools(guardedSchema('GetterHook').schema, { schemaPlugins: [shared] });

        expect(onExecute).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toMatch(/ignores onExecute/);
      } finally {
        warn.mockRestore();
      }
    });

    it('skips null, undefined and false entries like Envelop', async () => {
      const { schema } = guardedSchema('Falsy');
      const { callTool } = simfinity.generateMCPTools(schema, {
        schemaPlugins: [null, undefined, false, denyPlugin()],
      });

      const response = await callTool('secret', {});
      expect(response.isError).toBe(true);
      expect(response.content[0].text).toContain('denied by auth plugin');
    });

    describe('ignored plugin hooks', () => {
      afterEach(() => {
        vi.restoreAllMocks();
      });

      it('warns once per plugin object, naming the hooks MCP does not run', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { schema } = guardedSchema('Hooks');
        const shared = { onExecute() {}, onPluginInit() {} };

        simfinity.generateMCPTools(schema, { schemaPlugins: [shared] });
        simfinity.generateMCPTools(schema, { schemaPlugins: [shared] });

        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toMatch(/onExecute/);
        expect(warn.mock.calls[0][0]).toMatch(/onPluginInit/);
      });

      it('still installs onSchemaChange of a plugin that also has request hooks', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const { schema, calls } = guardedSchema('Mixed');
        const { callTool } = simfinity.generateMCPTools(schema, {
          schemaPlugins: [{ ...denyPlugin(), onExecute() {} }],
        });

        expect((await callTool('secret', {})).isError).toBe(true);
        expect(calls.count).toBe(0);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0][0]).toMatch(/onExecute/);
      });
    });

    it('accepts replaceSchema with the same schema and rejects a replacement with MCP_UNSUPPORTED_SCHEMA_REPLACEMENT', () => {
      const { schema } = guardedSchema('Replace');
      const { schema: other } = guardedSchema('ReplaceOther');

      expect(() => simfinity.generateMCPTools(schema, {
        schemaPlugins: [{ onSchemaChange({ schema: current, replaceSchema }) { replaceSchema(current); } }],
      })).not.toThrow();
      expect(setupError(() => simfinity.generateMCPTools(schema, {
        schemaPlugins: [{ onSchemaChange({ replaceSchema }) { replaceSchema(other); } }],
      }))).toMatchObject({ extensions: { code: 'MCP_UNSUPPORTED_SCHEMA_REPLACEMENT' } });
    });

    it('makes calls wait for an asynchronous onSchemaChange', async () => {
      const { schema, calls } = guardedSchema('Async');
      const { callTool } = simfinity.generateMCPTools(schema, {
        schemaPlugins: [{
          async onSchemaChange(payload) {
            await new Promise((resolve) => { setTimeout(resolve, 10); });
            denyPlugin().onSchemaChange(payload);
          },
        }],
      });

      const response = await callTool('secret', {});
      expect(response.content[0].text).toContain('denied by auth plugin');
      expect(calls.count).toBe(0);
    });

    it('rejects every call when an asynchronous onSchemaChange fails, without an unhandled rejection', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      try {
        const { schema, calls } = guardedSchema('AsyncFail');
        const { callTool } = simfinity.generateMCPTools(schema, {
          schemaPlugins: [{
            async onSchemaChange() {
              throw new Error('install failed');
            },
          }],
        });
        await new Promise((resolve) => { setTimeout(resolve, 10); });

        expect(unhandled).not.toHaveBeenCalled();
        expect(warn.mock.calls[0][0]).toMatch(/schemaPlugins installer failed/);
        await expect(callTool('secret', {})).rejects.toThrow('install failed');
        await expect(callTool('secret', {})).rejects.toThrow('install failed');
        expect(calls.count).toBe(0);
      } finally {
        process.off('unhandledRejection', unhandled);
        warn.mockRestore();
      }
    });

    it('throws a synchronous onSchemaChange failure at setup without leaving earlier asynchronous hooks unhandled', async () => {
      const unhandled = vi.fn();
      process.on('unhandledRejection', unhandled);
      try {
        const { schema } = guardedSchema('MixedFail');
        expect(() => simfinity.generateMCPTools(schema, {
          schemaPlugins: [
            {
              async onSchemaChange() {
                throw new Error('async install failed');
              },
            },
            {
              onSchemaChange() {
                throw new Error('sync install failed');
              },
            },
          ],
        })).toThrow('sync install failed');
        await new Promise((resolve) => { setTimeout(resolve, 10); });

        expect(unhandled).not.toHaveBeenCalled();
      } finally {
        process.off('unhandledRejection', unhandled);
      }
    });

    it('neither validates nor applies schemaPlugins in remote mode', () => {
      const { schema } = guardedSchema('Remote');
      const plugin = { onSchemaChange: vi.fn() };

      expect(() => simfinity.generateMCPTools(schema, {
        schemaPlugins: [{}, plugin],
        execution: { mode: 'remote', endpoint: 'http://graphql.test/graphql' },
      })).not.toThrow();
      expect(plugin.onSchemaChange).not.toHaveBeenCalled();
    });
  });

  describe('execution config validation', () => {
    it('treats execution: null as in-process', async () => {
      const { callTool } = simfinity.generateMCPTools(stubSchema, { execution: null });
      const response = await callTool('item', { id: '5' });

      expect(response.isError).toBe(false);
      expect(response.structuredContent.item.id).toBe('5');
    });

    it('throws MCP_INVALID_EXECUTION_MODE for a string execution config', () => {
      let error;
      try {
        simfinity.generateMCPTools(stubSchema, { execution: 'remote' });
      } catch (err) {
        error = err;
      }
      expect(error).toBeDefined();
      expect(error.extensions.code).toBe('MCP_INVALID_EXECUTION_MODE');
    });

    describe('remote headers and timeoutMs', () => {
      const remote = (extra) => ({ execution: { mode: 'remote', endpoint: 'http://graphql.test/graphql', ...extra } });
      const setupError = (options) => {
        try {
          simfinity.generateMCPTools(stubSchema, options);
        } catch (err) {
          return err;
        }
        return undefined;
      };

      it.each([
        ['a string', 'Bearer secret-token', 'got string;'],
        ['true', true, 'got boolean;'],
        ['a number', 5, 'got number;'],
        ['a promise', Promise.resolve({ authorization: 'Bearer secret-token' }), 'got a promise;'],
        ['a function', () => ({ authorization: 'Bearer secret-token' }), 'got a function;'],
        ['a Map entries() iterator', new Map([['authorization', 'Bearer secret-token']]).entries(), 'got an iterator'],
        ['a generator', (function* pairs() { yield ['authorization', 'Bearer secret-token']; }()), 'got an iterator'],
      ])('rejects %s as remote headers at setup without quoting it', (label, headers, got) => {
        const error = setupError(remote({ headers }));

        expect(error).toBeDefined();
        expect(error.extensions.code).toBe('MCP_INVALID_EXECUTION_CONFIG');
        expect(error.message).toMatch(/^execution\.headers must be an object of header names to values, a Headers instance, a Map or an array of \[name, value\] pairs, got /);
        expect(error.message).toContain(got);
        expect(error.message).not.toContain('secret');
      });

      it.each([
        ['"abc"', 'abc'],
        ['a blank string', ' '],
        ['"5s"', '5s'],
        ['true', true],
        ['-1', -1],
        ['"-5"', '-5'],
        ['Infinity', Infinity],
        ['"Infinity"', 'Infinity'],
        ['-Infinity', -Infinity],
        ['an object', {}],
        ['an array', [5]],
        ['a function', () => 5],
      ])('rejects remote timeoutMs %s at setup', (label, timeoutMs) => {
        const error = setupError(remote({ timeoutMs }));

        expect(error).toBeDefined();
        expect(error.extensions.code).toBe('MCP_INVALID_EXECUTION_CONFIG');
        expect(error.message).toMatch(/^execution\.timeoutMs must be a positive, finite number of milliseconds, got /);
      });

      it('names the invalid timeoutMs and how to disable the timeout', () => {
        expect(setupError(remote({ timeoutMs: 'abc' })).message).toBe(
          'execution.timeoutMs must be a positive, finite number of milliseconds, got "abc"; omit it, or pass 0, false or null, to disable the timeout',
        );
      });

      const absoluteURL = 'execution.endpoint must be an absolute http(s) URL, such as https://api.example.com/graphql';
      const noCredentials = 'execution.endpoint must not include a username or password; send credentials through execution.headers';

      it.each([
        ['a username and password', 'http://user:secret@graphql.test/graphql'],
        ['a username only', 'https://secret@graphql.test/graphql'],
        ['another protocol and a password', 'ftp://user:secret@graphql.test/graphql'],
        ['a password in a URL instance (guard)', new URL('http://user:secret@graphql.test/graphql')],
      ])('rejects a remote endpoint with %s at setup without quoting it', (label, endpoint) => {
        const error = setupError(remote({ endpoint }));

        expect(error).toBeDefined();
        expect(error.extensions.code).toBe('MCP_INVALID_EXECUTION_CONFIG');
        expect(error.message).toBe(noCredentials);
      });

      // fetch (not stubbed here) rejects these, but an application-provided
      // fetch may not, so they fail each call instead of setup. A fetch error
      // that quotes the URL is replaced by the reason; fetch's error for
      // another protocol does not quote it and is kept.
      it.each([
        ['a relative URL', '/graphql?apikey=secret', absoluteURL],
        ['an unparsable URL', 'graphql.test/graphql?apikey=secret', absoluteURL],
        ['another protocol', 'ftp://graphql.test/graphql?apikey=secret', 'fetch failed'],
      ])('sets up a remote endpoint with %s and fails each call without quoting it', async (label, endpoint, reason) => {
        const { callTool } = simfinity.generateMCPTools(stubSchema, remote({ endpoint }));
        const response = await callTool('item', { id: '5' });

        expect(response.isError).toBe(true);
        expect(JSON.parse(response.content[0].text).errors[0]).toEqual({
          message: `GraphQL endpoint request failed: ${reason}`,
          extensions: { code: 'MCP_REMOTE_REQUEST_FAILED' },
        });
        expect(response.content[0].text).not.toContain('secret');
      });

      it.each([
        ['an https URL', 'https://graphql.test:8443/graphql?tenant=a'],
        ['a URL instance', new URL('http://127.0.0.1:4000/graphql')],
      ])('accepts %s as the remote endpoint (guard)', (label, endpoint) => {
        expect(setupError(remote({ endpoint }))).toBeUndefined();
      });

      it('ignores remote-only settings in in-process mode (guard)', async () => {
        const { callTool } = simfinity.generateMCPTools(stubSchema, { execution: { timeoutMs: 'abc', headers: 'x' } });

        expect((await callTool('item', { id: '5' })).isError).toBe(false);
      });
    });
  });

  describe('cancellation', () => {
    it('rejects with MCP_CALL_CANCELLED when extra.signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();

      const { callTool } = simfinity.generateMCPTools(stubSchema);
      const callsBefore = itemCalls;

      await expect(callTool('item', { id: '1' }, { signal: controller.signal }))
        .rejects.toMatchObject({ extensions: { code: 'MCP_CALL_CANCELLED' } });
      expect(itemCalls).toBe(callsBefore);
    });
  });
});
