import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import express from 'express';
import { createRateLimiters, readRateLimit, rejectJsonRpcBatch } from '../routes/rateLimits.js';

describe('readRateLimit', () => {
  it('uses the documented defaults', () => {
    expect(readRateLimit('GRAPHQL_RATE_LIMIT_MAX', {})).toBe(300);
    expect(readRateLimit('MCP_RATE_LIMIT_MAX', {})).toBe(300);
    expect(readRateLimit('UPLOAD_IP_RATE_LIMIT_MAX', {})).toBe(100);
    expect(readRateLimit('UPLOAD_RATE_LIMIT_MAX', {})).toBe(20);
    expect(readRateLimit('UPLOAD_RATE_LIMIT_MAX', { UPLOAD_RATE_LIMIT_MAX: '' })).toBe(20);
  });
  it('accepts positive integer overrides and rejects anything else at startup', () => {
    expect(readRateLimit('MCP_RATE_LIMIT_MAX', { MCP_RATE_LIMIT_MAX: '5000' })).toBe(5000);
    for (const raw of ['0', '-1', '1.5', 'abc']) {
      expect(() => readRateLimit('MCP_RATE_LIMIT_MAX', { MCP_RATE_LIMIT_MAX: raw })).toThrow(/positive integer/);
    }
    expect(() => createRateLimiters({ UPLOAD_RATE_LIMIT_MAX: '0' })).toThrow(/UPLOAD_RATE_LIMIT_MAX must be a positive integer/);
  });
});

describe('route limiters', () => {
  let server;
  let origin;
  beforeAll(async () => {
    const limiters = createRateLimiters({ GRAPHQL_RATE_LIMIT_MAX: '2', MCP_RATE_LIMIT_MAX: '2' });
    const app = express();
    app.use('/graphql', limiters.graphql, (_req, res) => res.json({ ok: true }));
    app.all('/mcp', limiters.mcp, express.json(), rejectJsonRpcBatch, (req, res) => res.json({ jsonrpc: '2.0', id: req.body.id, result: {} }));
    app.get('/health', (_req, res) => res.json({ status: 'ok' }));
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    origin = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(() => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve); }));

  const mcp = (body) => fetch(`${origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('rejects a JSON-RPC batch on /mcp with Invalid Request', async () => {
    const response = await mcp([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request: JSON-RPC batches are not supported' }, id: null,
    });
  });

  it('limits /mcp with its own counter and a JSON-RPC 429 body', async () => {
    // The batch above used one MCP request.
    const ok = await mcp({ jsonrpc: '2.0', id: 3, method: 'tools/list' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('ratelimit-policy')).toBe('2;w=60');
    const limited = await mcp({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 }, id: null });
    // GraphQL still has its whole budget.
    expect((await fetch(`${origin}/graphql`, { method: 'POST' })).status).toBe(200);
    expect((await fetch(`${origin}/graphql`, { method: 'POST' })).status).toBe(200);
    expect((await fetch(`${origin}/graphql`, { method: 'POST' })).status).toBe(429);
  });

  it('never limits /health', async () => {
    const statuses = [];
    for (let i = 0; i < 5; i += 1) statuses.push((await fetch(`${origin}/health`)).status);
    expect(statuses).toEqual([200, 200, 200, 200, 200]);
  });
});
