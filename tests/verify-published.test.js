import { afterEach, describe, expect, it } from 'vitest';
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
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

describe('published npm release verification', () => {
  it('verifies real registry responses against archive integrity and the distribution tag', async () => {
    const url = await registry((request, response) => {
      expect(decodeURIComponent(request.url)).toBe('/@simtlix/simfinity-core');
      response.end(JSON.stringify(metadata()));
    });
    const result = await verification.verifyPublished(release, { registry: url, attempts: 1 });
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
