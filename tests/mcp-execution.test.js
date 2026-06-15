import {
  describe, it, expect, beforeEach, afterEach, vi,
} from 'vitest';
import {
  GraphQLObjectType,
  GraphQLInputObjectType,
  GraphQLSchema,
  GraphQLString,
  GraphQLInt,
  GraphQLBoolean,
  GraphQLList,
  GraphQLNonNull,
} from 'graphql';
import * as simfinity from '../src/index.js';

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
      addItem: {
        type: ItemType,
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
        throw new Error('Unexpected token < in JSON');
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

  it('surfaces a remote extensions.count as result _meta.count', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: { items: [{ id: '1', name: 'One' }] },
      extensions: { count: 42 },
    }));

    const { callTool } = remoteTools();
    const response = await callTool('items', {});

    expect(response.isError).toBe(false);
    expect(response._meta).toEqual({ count: 42 });
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
  });

  it('omits _meta.count when pagination.count is not requested', async () => {
    const { callTool } = simfinity.generateMCPTools(stubSchema, { context: {} });
    const response = await callTool('items', { pagination: { page: 1, size: 10 } });

    expect(response.isError).toBe(false);
    expect(response._meta).toBeUndefined();
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

      // Counted call on a tool that does NOT write one: the count sitting on
      // the shared context must not surface as this call's _meta.count.
      const quiet = await callTool('quietList', { pagination: { count: true } });
      expect(quiet.isError).toBe(false);
      expect(quiet._meta).toBeUndefined();
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
