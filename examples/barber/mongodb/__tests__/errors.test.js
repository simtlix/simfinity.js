import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { jsonErrorHandler, mcpBodyErrors } from '../routes/errors.js';

let server;
let origin;
beforeAll(async () => {
  const app = express();
  app.all('/mcp', express.json(), mcpBodyErrors, (req, res) => res.json({ received: req.body }));
  app.get('/boom', () => { throw new Error('ENOENT: /srv/app/secret/path'); });
  app.get('/teapot', (_req, _res, next) => next(Object.assign(new Error('Short and stout'), { status: 418, expose: true })));
  app.get('/hidden', (_req, _res, next) => next(Object.assign(new Error('internal detail'), { status: 400, expose: false })));
  app.use(jsonErrorHandler);
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise((resolve) => server.close(resolve)));

const postMcp = async (body, contentType = 'application/json') => {
  const response = await fetch(`${origin}/mcp`, { method: 'POST', headers: { 'content-type': contentType }, body });
  const text = await response.text();
  return { status: response.status, type: response.headers.get('content-type'), text, json: JSON.parse(text) };
};

describe('MCP body errors (UP-4)', () => {
  it('answers a body that is not JSON with the JSON-RPC Parse error, not an HTML stack trace', async () => {
    const { status, type, text, json } = await postMcp('{bad');
    expect(status).toBe(400);
    expect(type).toMatch(/^application\/json/);
    expect(json).toEqual({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: the request body is not valid JSON' }, id: null });
    expect(text).not.toMatch(/node_modules|SyntaxError|at /);
  });

  it('answers a body above the parser limit with 413', async () => {
    const { status, json } = await postMcp(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { pad: 'x'.repeat(200_000) } }));
    expect(status).toBe(413);
    expect(json).toEqual({ jsonrpc: '2.0', error: { code: -32000, message: 'Request body too large' }, id: null });
  });

  it('keeps the status of other body-parser rejections', async () => {
    const { status, json } = await postMcp('{}', 'application/json; charset=latin1');
    expect(status).toBe(415);
    expect(json).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 }, id: null });
  });

  it('passes a valid body through', async () => {
    expect((await postMcp('{"jsonrpc":"2.0"}')).json).toEqual({ received: { jsonrpc: '2.0' } });
  });
});

describe('jsonErrorHandler', () => {
  it('logs a server error and answers 500 JSON without its message or stack', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await fetch(`${origin}/boom`);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: 'Internal server error' });
      expect(logged).toHaveBeenCalledWith('Request failed:', expect.any(Error));
    } finally {
      logged.mockRestore();
    }
  });

  it('keeps a client error status, and its message only when it is meant for the client', async () => {
    const teapot = await fetch(`${origin}/teapot`);
    expect([teapot.status, await teapot.json()]).toEqual([418, { error: 'Short and stout' }]);
    const hidden = await fetch(`${origin}/hidden`);
    expect([hidden.status, await hidden.json()]).toEqual([400, { error: 'Bad request' }]);
  });
});
