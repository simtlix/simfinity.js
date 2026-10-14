import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { isTransientFailure, requestSignal, retry } from '../scripts/transient.js';

const servers = [];
const listen = async (handler) => {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}/`;
};
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
const failure = async (url, options) => fetch(url, options).then((response) => response.json()).then(() => null, (error) => error);
const httpError = (status) => Object.assign(new Error(`HTTP ${status}`), { status });

describe('transient failure classification', () => {
  it.each([429, 500, 502, 503, 504, 599])('repeats HTTP %s', (status) => {
    expect(isTransientFailure(status)).toBe(true);
    expect(isTransientFailure(new Response(null, { status }))).toBe(true);
    expect(isTransientFailure(httpError(status))).toBe(true);
  });

  it.each([200, 204, 301, 304, 400, 401, 403, 404, 409, 422])('does not repeat HTTP %s', (status) => {
    expect(isTransientFailure(status)).toBe(false);
    expect(isTransientFailure(httpError(status))).toBe(false);
  });

  it('repeats a refused connection, a reset, a body cut off mid-transfer and a timeout', async () => {
    const closed = await listen(() => {});
    const port = new URL(closed).port;
    servers.pop().close();
    const refused = await failure(`http://127.0.0.1:${port}/`);
    const reset = await failure(await listen((request) => request.socket.destroy()));
    const cut = await failure(await listen((request, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': '4096' });
      response.write('{"versions":{', () => request.socket.destroy());
    }));
    const timeout = await failure(await listen(() => {}), { signal: AbortSignal.timeout(50) });
    expect([refused, reset, cut, timeout].map((error) => [error.name, error.message])).toEqual([
      ['TypeError', 'fetch failed'],
      ['TypeError', 'fetch failed'],
      ['TypeError', 'terminated'],
      ['TimeoutError', expect.any(String)],
    ]);
    for (const error of [refused, reset, cut, timeout]) expect(isTransientFailure(error)).toBe(true);
    expect(isTransientFailure(new DOMException('The operation was aborted', 'AbortError'))).toBe(true);
  });

  it.each([
    ['a malformed body', new SyntaxError('Unexpected token < in JSON')],
    ['a programming error', new TypeError('Cannot read properties of undefined')],
    ['an invalid URL', (() => { try { return new URL('not a url'); } catch (error) { return error; } })()],
    ['a plain error with a network message', new Error('fetch failed')],
    ['a missing value', undefined],
    ['a message', 'fetch failed'],
  ])('does not repeat %s', (label, value) => {
    expect(isTransientFailure(value)).toBe(false);
  });
});

describe('request signals', () => {
  it('times a request out at the deadline when it comes before the timeout', async () => {
    const started = Date.now();
    const signal = requestSignal({ deadline: Date.now() + 30, timeoutMs: 10000 });
    await new Promise((resolve) => signal.addEventListener('abort', resolve));
    expect(signal.reason.name).toBe('TimeoutError');
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('times a request out after the timeout when there is no deadline', async () => {
    const signal = requestSignal({ timeoutMs: 30 });
    await new Promise((resolve) => signal.addEventListener('abort', resolve));
    expect(signal.reason.name).toBe('TimeoutError');
  });

  it('still gives a request past its deadline a signal that fires at once', async () => {
    const signal = requestSignal({ deadline: Date.now() - 1000 });
    await new Promise((resolve) => signal.addEventListener('abort', resolve));
    expect(signal.aborted).toBe(true);
  });
});

describe('bounded retries', () => {
  it('calls once when the first attempt succeeds', async () => {
    const fn = vi.fn().mockResolvedValue('value');
    await expect(retry(fn, { attempts: 3, delayMs: 0 })).resolves.toBe('value');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0][0]).toEqual({ attempt: 1, signal: expect.any(AbortSignal) });
  });

  it('repeats transient failures until an attempt succeeds', async () => {
    const fn = vi.fn().mockRejectedValueOnce(httpError(503)).mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValue('value');
    await expect(retry(fn, { attempts: 3, delayMs: 0 })).resolves.toBe('value');
    expect(fn.mock.calls.map(([{ attempt }]) => attempt)).toEqual([1, 2, 3]);
  });

  it('rethrows a permanent failure at once, unchanged', async () => {
    const error = httpError(404);
    const fn = vi.fn().mockRejectedValue(error);
    await expect(retry(fn, { attempts: 3, delayMs: 0 })).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('rethrows the last transient failure after the attempts', async () => {
    const errors = [httpError(502), httpError(503), httpError(504)];
    const fn = vi.fn();
    for (const error of errors) fn.mockRejectedValueOnce(error);
    await expect(retry(fn, { attempts: 3, delayMs: 0 })).rejects.toBe(errors[2]);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('waits between attempts', async () => {
    const fn = vi.fn().mockRejectedValueOnce(httpError(503)).mockRejectedValueOnce(httpError(503)).mockResolvedValue('value');
    const started = Date.now();
    await expect(retry(fn, { attempts: 3, delayMs: 60 })).resolves.toBe('value');
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  it('does not start a wait that would pass the deadline', async () => {
    const error = httpError(503);
    const fn = vi.fn().mockRejectedValue(error);
    const started = Date.now();
    await expect(retry(fn, { attempts: 5, delayMs: 2000, deadline: Date.now() + 300 })).rejects.toBe(error);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it('cuts a hanging request at the deadline', async () => {
    let requests = 0;
    const url = await listen(() => { requests++; });
    const started = Date.now();
    const error = await retry(({ signal }) => fetch(url, { signal }), { attempts: 3, delayMs: 0, deadline: Date.now() + 200 }).catch((caught) => caught);
    expect(error.name).toBe('TimeoutError');
    expect(Date.now() - started).toBeLessThan(2000);
    expect(requests).toBeGreaterThanOrEqual(1);
  });

  it('honours a caller-specific retryable predicate', async () => {
    const pending = new Error('not yet visible');
    const fn = vi.fn().mockRejectedValueOnce(pending).mockResolvedValue('value');
    await expect(retry(fn, { attempts: 2, delayMs: 0, retryable: (error) => error === pending })).resolves.toBe('value');
    await expect(retry(vi.fn().mockRejectedValue(httpError(503)), { attempts: 2, delayMs: 0, retryable: () => false })).rejects.toThrow('HTTP 503');
  });

  it('reads a JSON body through a reset and a 503 from a real server', async () => {
    let requests = 0;
    const url = await listen((request, response) => {
      requests++;
      if (requests === 1) return request.socket.destroy();
      if (requests === 2) { response.statusCode = 503; return response.end('{}'); }
      response.end('{"ok":true}');
    });
    const body = await retry(async ({ signal }) => {
      const response = await fetch(url, { signal });
      if (!response.ok) {
        await response.body?.cancel();
        throw httpError(response.status);
      }
      return response.json();
    }, { attempts: 3, delayMs: 0 });
    expect(body).toEqual({ ok: true });
    expect(requests).toBe(3);
  });

  it.each([
    [{ attempts: 0 }], [{ attempts: 1.5 }], [{ delayMs: -1 }], [{ delayMs: Infinity }],
    [{ deadline: Number.NaN }], [{ deadline: '1' }], [{ timeoutMs: 0 }], [{ timeoutMs: Infinity }],
  ])('rejects invalid limits %o without calling', async (limits) => {
    const fn = vi.fn();
    await expect(retry(fn, limits)).rejects.toThrow(RangeError);
    expect(fn).not.toHaveBeenCalled();
  });

  it('rejects a missing function or predicate and a deadline already past', async () => {
    await expect(retry(undefined)).rejects.toThrow(TypeError);
    await expect(retry(vi.fn(), { retryable: null })).rejects.toThrow(TypeError);
    const fn = vi.fn();
    await expect(retry(fn, { deadline: Date.now() - 1 })).rejects.toThrow('The retry deadline has already passed');
    expect(fn).not.toHaveBeenCalled();
  });
});
