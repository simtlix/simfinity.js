import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, test, vi } from 'vitest';
import { GraphQLObjectType, GraphQLString } from 'graphql';
import { auth, createRuntime } from '../packages/core/src/index.js';
import * as http from '../packages/core/src/http.js';

const schema = () => {
  const api = createRuntime({ createModel: () => ({}) });
  api.connect(null, new GraphQLObjectType({ name: 'Book', fields: { title: { type: GraphQLString } } }), 'book', 'books');
  return api.createSchema();
};
const serve = async (handler, body) => {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { await body(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
};

test('requires an explicit access decision and validates options at setup', () => {
  for (const options of [undefined, {}, { authorize: true }, { authorize: 'public', context: () => {}, extra: true }, { authorize: 'public', onError: true }]) {
    expect(() => http.createClientDescriptorHandler(schema(), options)).toThrow(/options/);
  }
});

test('serves stable JSON, GET/HEAD, ETag comparisons and method rejection', async () => {
  const context = vi.fn(); const handler = http.createClientDescriptorHandler(schema(), { authorize: 'public', context });
  await serve(handler, async (url) => {
    const first = await fetch(url); const etag = first.headers.get('etag'); const body = await first.text();
    expect(first.status).toBe(200); expect(first.headers.get('cache-control')).toBe('no-cache');
    expect(JSON.parse(body).types.Book.endpoints.get).toBe('book');
    for (const match of [etag, `W/${etag}`, `"other", W/${etag}`, '*']) {
      const response = await fetch(url, { headers: { 'If-None-Match': match } });
      expect(response.status).toBe(304); expect(await response.text()).toBe('');
    }
    const head = await fetch(url, { method: 'HEAD' }); expect(head.status).toBe(200); expect(await head.text()).toBe('');
    expect(head.headers.get('etag')).toBe(etag);
    context.mockClear();
    const rejected = await fetch(url, { method: 'POST' });
    expect(rejected.status).toBe(405); expect(rejected.headers.get('allow')).toBe('GET, HEAD'); expect(context).not.toHaveBeenCalled();
    const other = await fetch(url, { headers: { 'If-None-Match': 'invalid ' + etag } }); expect(other.status).toBe(200);
  });
});

test('authorizes before conditional responses and masks unexpected/observer failures', async () => {
  const observed = vi.fn(() => { throw new Error('observer failure'); });
  const authorize = vi.fn((req, ctx) => {
    if (ctx === 'deny') return false;
    if (ctx === 'login') throw new auth.UnauthenticatedError('Login required');
    if (ctx === 'crash') throw new Error('secret error');
    return true;
  });
  await serve(http.createClientDescriptorHandler(schema(), { authorize, context: (req) => req.headers.authorization, onError: observed }), async (url) => {
    const first = await fetch(url); const etag = first.headers.get('etag');
    expect(first.headers.get('cache-control')).toBe('private, no-cache');
    expect(first.headers.get('vary')).toBe('Authorization, Cookie');
    for (const [token, status, code] of [['deny', 403, 'FORBIDDEN'], ['login', 401, 'UNAUTHENTICATED'], ['crash', 500, 'INTERNAL_SERVER_ERROR']]) {
      const headers = { Authorization: token, 'If-None-Match': etag };
      const response = await fetch(url, { headers });
      expect(response.status).toBe(status); expect(response.headers.get('cache-control')).toBe('no-store');
      const data = await response.json(); expect(data.errors[0].extensions.code).toBe(code);
      expect(JSON.stringify(data)).not.toContain('secret error');
      const head = await fetch(url, { headers, method: 'HEAD' }); expect(head.status).toBe(status); expect(await head.text()).toBe('');
    }
    expect(observed).toHaveBeenCalled(); expect(authorize).toHaveBeenCalledTimes(7);
  });
});
