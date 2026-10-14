import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import * as verification from '../scripts/verify-published.js';

const servers = [];
const release = { version: '3.4.1', packages: [{ name: '@simtlix/simfinity-core', version: '3.4.1', integrity: 'sha512-expected' }] };
const metadata = () => ({ name: '@simtlix/simfinity-core', 'dist-tags': { latest: '3.4.1' }, versions: { '3.4.1': { version: '3.4.1', dist: { integrity: 'sha512-expected' } } } });
const registry = async (handler) => {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}/`;
};
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

describe('published npm release verification', () => {
  it('verifies the uncached registry packument against archive integrity and the distribution tag', async () => {
    const targets = [];
    const url = await registry((request, response) => {
      const target = new URL(request.url, 'http://registry.test');
      targets.push([request.method, target.pathname, [...target.searchParams]]);
      response.end(JSON.stringify(metadata()));
    });
    const result = await verification.verifyPublished(release, { registry: url, attempts: 1 });
    expect(targets).toEqual([['GET', '/%40simtlix%2Fsimfinity-core', [['write', 'true']]]]);
    expect(result.packages).toEqual([{ name: '@simtlix/simfinity-core', version: '3.4.1', distTag: 'latest', integrity: 'sha512-expected' }]);
  });

  it('waits for an accepted publication to become visible without publishing again', async () => {
    let requests = 0;
    const url = await registry((request, response) => {
      expect(request.method).toBe('GET');
      if (++requests === 1) { response.statusCode = 404; response.end('{}'); }
      else response.end(JSON.stringify(metadata()));
    });
    await expect(verification.verifyPublished(release, { registry: url, attempts: 2, delayMs: 0 })).resolves.toMatchObject({ version: '3.4.1' });
    expect(requests).toBe(2);
  });

  it('waits for the distribution tag to catch up with the visible version', async () => {
    let requests = 0;
    const url = await registry((request, response) => {
      const value = metadata();
      if (++requests === 1) value['dist-tags'].latest = '3.4.0';
      response.end(JSON.stringify(value));
    });
    await expect(verification.verifyPublished(release, { registry: url, attempts: 2, delayMs: 0 })).resolves.toMatchObject({ version: '3.4.1' });
    expect(requests).toBe(2);
  });

  it('fails immediately on conflicting registry contents', async () => {
    let requests = 0;
    const url = await registry((request, response) => {
      requests++;
      const value = metadata();
      value.versions['3.4.1'].dist.integrity = 'sha512-different';
      response.end(JSON.stringify(value));
    });
    await expect(verification.verifyPublished(release, { registry: url, attempts: 2, delayMs: 0 })).rejects.toThrow(/integrity/i);
    expect(requests).toBe(1);
  });

  it('fails after the bounded visibility deadline', async () => {
    let requests = 0;
    const url = await registry((request, response) => { requests++; response.statusCode = 404; response.end('{}'); });
    await expect(verification.verifyPublished(release, { registry: url, attempts: 2, delayMs: 0 })).rejects.toThrow(/visible|published/i);
    expect(requests).toBe(2);
  });

  it('does not mistake an authentication failure for pending publication', async () => {
    const url = await registry((request, response) => { response.statusCode = 401; response.end('{}'); });
    await expect(verification.verifyPublished(release, { registry: url, attempts: 2, delayMs: 0 })).rejects.toThrow(/401/);
  });

  it('rejects an empty package set rather than reporting success', async () => {
    await expect(verification.verifyPublished({ version: '3.4.1', packages: [] })).rejects.toThrow(/package/i);
  });
});

describe('transient registry failures during publication verification', () => {
  it('retries a connection reset before the registry answers', async () => {
    let requests = 0;
    const url = await registry((request, response) => {
      if (++requests === 1) request.socket.destroy();
      else response.end(JSON.stringify(metadata()));
    });
    await expect(verification.verifyPublished(release, { registry: url, attempts: 2, delayMs: 0 })).resolves.toMatchObject({ version: '3.4.1' });
    expect(requests).toBe(2);
  });

  it('retries a response body cut off mid-transfer', async () => {
    let requests = 0;
    const url = await registry((request, response) => {
      if (++requests === 1) {
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': '4096' });
        response.write('{"name":"@simtlix/simfinity-core","versions":{', () => request.socket.destroy());
      } else response.end(JSON.stringify(metadata()));
    });
    await expect(verification.verifyPublished(release, { registry: url, attempts: 2, delayMs: 0 })).resolves.toMatchObject({ version: '3.4.1' });
    expect(requests).toBe(2);
  });

  it('retries an unparsable registry body', async () => {
    let requests = 0;
    const url = await registry((request, response) => {
      response.end(++requests === 1 ? '<html>gateway</html>' : JSON.stringify(metadata()));
    });
    await expect(verification.verifyPublished(release, { registry: url, attempts: 2, delayMs: 0 })).resolves.toMatchObject({ version: '3.4.1' });
    expect(requests).toBe(2);
  });

  it.each(['TimeoutError', 'AbortError'])('retries a request that ends with %s', async (name) => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new DOMException('The operation was aborted', name))
      .mockResolvedValue(new Response(JSON.stringify(metadata())));
    vi.stubGlobal('fetch', fetch);
    await expect(verification.verifyPublished(release, { registry: 'http://registry.test/', attempts: 2, delayMs: 0 })).resolves.toMatchObject({ version: '3.4.1' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([429, 500, 503])('waits through HTTP %s and names it if it is still the last answer', async (status) => {
    let requests = 0;
    const url = await registry((request, response) => { requests++; response.statusCode = status; response.end('{}'); });
    await expect(verification.verifyPublished(release, { registry: url, attempts: 2, delayMs: 0 }))
      .rejects.toThrow(`Published packages are not yet visible with the expected distribution tag: @simtlix/simfinity-core (last registry error: @simtlix/simfinity-core: HTTP ${status})`);
    expect(requests).toBe(2);
  });

  it('names the package and the last network error after the bounded attempts', async () => {
    let requests = 0;
    const url = await registry((request) => { requests++; request.socket.destroy(); });
    await expect(verification.verifyPublished(release, { registry: url, attempts: 2, delayMs: 0 })).rejects.toThrow(/not yet visible.*@simtlix\/simfinity-core.*last registry error: @simtlix\/simfinity-core: fetch failed/);
    expect(requests).toBe(2);
  });

  it('reports only the registry errors of the final attempt', async () => {
    let requests = 0;
    const url = await registry((request, response) => {
      if (++requests === 1) return request.socket.destroy();
      response.statusCode = 404;
      response.end('{}');
    });
    const error = await verification.verifyPublished(release, { registry: url, attempts: 3, delayMs: 0 }).catch((caught) => caught);
    expect(error.message).toBe('Published packages are not yet visible with the expected distribution tag: @simtlix/simfinity-core');
    expect(requests).toBe(3);
  });

  it('ends an attempt at the first network failure and checks every package on the next one', async () => {
    const paths = [];
    const two = { version: '3.4.1', packages: [release.packages[0], { name: '@simtlix/simfinity-sql', version: '3.4.1' }] };
    const url = await registry((request, response) => {
      const name = decodeURIComponent(new URL(request.url, 'http://registry.test').pathname).slice(1);
      paths.push(name);
      if (paths.length === 1) return request.socket.destroy();
      response.end(JSON.stringify({ ...metadata(), name }));
    });
    await expect(verification.verifyPublished(two, { registry: url, attempts: 2, delayMs: 0 })).resolves.toMatchObject({ packages: [{ name: '@simtlix/simfinity-core' }, { name: '@simtlix/simfinity-sql' }] });
    expect(paths).toEqual(['@simtlix/simfinity-core', '@simtlix/simfinity-core', '@simtlix/simfinity-sql']);
  });

  it.each([
    ['an integrity conflict', (response) => { const value = metadata(); value.versions['3.4.1'].dist.integrity = 'sha512-different'; response.end(JSON.stringify(value)); }, /integrity/i],
    ['an authorization failure', (response) => { response.statusCode = 403; response.end('{}'); }, /403/],
  ])('keeps %s fatal after a retried network failure', async (label, answer, error) => {
    let requests = 0;
    const url = await registry((request, response) => {
      if (++requests === 1) request.socket.destroy();
      else answer(response);
    });
    await expect(verification.verifyPublished(release, { registry: url, attempts: 3, delayMs: 0 })).rejects.toThrow(error);
    expect(requests).toBe(2);
  });

  it('does not retry an invalid registry URL', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(verification.verifyPublished(release, { registry: 'not a url', attempts: 3, delayMs: 0 })).rejects.toThrow(/URL/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('overall publication verification deadline', () => {
  it('cuts a request that would outlive the deadline and stops there', async () => {
    let requests = 0;
    const url = await registry(() => { requests++; });
    const started = Date.now();
    await expect(verification.verifyPublished(release, { registry: url, attempts: 5, delayMs: 0, timeoutMs: 15000, budgetMs: 300 }))
      .rejects.toThrow(/not yet visible.*last registry error: @simtlix\/simfinity-core: .*(timeout|aborted)/i);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(requests).toBe(1);
  });

  it('cuts every request at the per-request timeout', async () => {
    let requests = 0;
    const url = await registry(() => { requests++; });
    const started = Date.now();
    await expect(verification.verifyPublished(release, { registry: url, attempts: 2, delayMs: 0, timeoutMs: 100 })).rejects.toThrow(/not yet visible/);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(requests).toBe(2);
  });

  it('skips a wait that would pass the deadline', async () => {
    let requests = 0;
    const url = await registry((request, response) => { requests++; response.statusCode = 404; response.end('{}'); });
    const started = Date.now();
    await expect(verification.verifyPublished(release, { registry: url, attempts: 5, delayMs: 2000, budgetMs: 500 })).rejects.toThrow(/not yet visible/);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(requests).toBe(1);
  });

  it.each([
    [{ timeoutMs: 0 }], [{ timeoutMs: Infinity }], [{ budgetMs: 0 }], [{ budgetMs: Number.NaN }],
  ])('rejects invalid timing limits %o', async (limits) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(verification.verifyPublished(release, { registry: 'http://registry.test/', ...limits })).rejects.toThrow('Invalid publication verification retry limits');
    expect(fetch).not.toHaveBeenCalled();
  });
});
