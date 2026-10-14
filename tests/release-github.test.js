import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { githubPages } from '../scripts/github-api.js';
import { findGitHubRelease } from '../scripts/github-release.js';

// Git fixtures and spawned CLIs can exceed the default 5 s while the full suite loads the machine.
vi.setConfig({ testTimeout: 30000 });

const servers = [];
const serve = async (handler) => {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
};
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
const reply = (response, status, value, headers = {}) => {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(typeof value === 'string' ? value : JSON.stringify(value));
};
const closedPort = async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return `http://127.0.0.1:${port}`;
};

// A release listing split into `pages`, linked the way GitHub links them (by repository id).
// `respond(request, response, count)` replaces it for failure scenarios.
const releasesApi = async (pages = [[]], respond) => {
  const requests = [];
  const api = await serve((request, response) => {
    requests.push({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      accept: request.headers.accept,
      version: request.headers['x-github-api-version'],
    });
    if (respond) return respond(request, response, requests.length);
    const page = Number(new URL(request.url, api).searchParams.get('page') || 1);
    const link = page < pages.length
      ? { link: `<${api}/repositories/1/releases?per_page=100&page=${page + 1}>; rel="next", <${api}/repositories/1/releases?per_page=100&page=${pages.length}>; rel="last"` }
      : {};
    reply(response, 200, pages[page - 1] ?? [], link);
  });
  return { api, options: { api, repository: 'o/r', token: 'secret', delayMs: 1 }, requests };
};
const request = (url) => ({ method: 'GET', url, authorization: 'Bearer secret', accept: 'application/vnd.github+json', version: '2022-11-28' });

describe('GitHub release lookup (#125)', () => {
  it('reports a missing release only after reading every page with the token', async () => {
    const { options, requests } = await releasesApi([[{ id: 1, tag_name: 'v1.0.0' }], [{ id: 2, tag_name: 'v0.9.0', draft: true }]]);
    await expect(findGitHubRelease('v1.1.0', options)).resolves.toBeNull();
    expect(requests).toEqual([request('/repos/o/r/releases?per_page=100'), request('/repositories/1/releases?per_page=100&page=2')]);
  });

  it('finds the draft or published release of the tag on any page', async () => {
    const draft = { id: 3, tag_name: 'v1.1.0', draft: true, html_url: 'https://github.test/o/r/releases/tag/untagged-1' };
    const { options } = await releasesApi([[{ id: 1, tag_name: 'v1.0.0' }], [draft]]);
    await expect(findGitHubRelease('v1.1.0', options)).resolves.toEqual(draft);
    const { options: other } = await releasesApi([[{ id: 4, tag_name: 'v1.1.0-rc.1', prerelease: true }, { id: 5, tag_name: 'v1.1.0' }]]);
    await expect(findGitHubRelease('v1.1.0-rc.1', other)).resolves.toEqual({ id: 4, tag_name: 'v1.1.0-rc.1', prerelease: true });
  });

  it.each([401, 403, 404, 422])('fails at once on HTTP %s instead of reporting a missing release', async (status) => {
    const { options, requests } = await releasesApi([], (request, response) => reply(response, status, { message: 'nope' }));
    await expect(findGitHubRelease('v1.1.0', options)).rejects.toThrow(`GitHub returned ${status} while listing releases`);
    expect(requests).toHaveLength(1);
  });

  it.each([429, 500, 502, 503])('retries HTTP %s three times, then fails closed', async (status) => {
    const { options, requests } = await releasesApi([], (request, response) => reply(response, status, { message: 'busy' }));
    await expect(findGitHubRelease('v1.1.0', options)).rejects.toThrow(`GitHub returned ${status} while listing releases`);
    expect(requests).toHaveLength(3);
  });

  it('reads the listing after a gateway error and a reset connection', async () => {
    const { options, requests } = await releasesApi([], (request, response, count) => {
      if (count === 1) return reply(response, 502, { message: 'Bad gateway' });
      if (count === 2) return request.socket.destroy();
      reply(response, 200, [{ id: 7, tag_name: 'v1.1.0' }]);
    });
    await expect(findGitHubRelease('v1.1.0', options)).resolves.toEqual({ id: 7, tag_name: 'v1.1.0' });
    expect(requests.map((item) => item.url)).toEqual(Array(3).fill('/repos/o/r/releases?per_page=100'));
  });

  it('retries each page on its own and keeps what earlier pages found', async () => {
    let failed = false;
    const { options, requests } = await releasesApi([], (request, response) => {
      if (request.url.endsWith('page=2') && !failed) { failed = true; return reply(response, 503, {}); }
      if (request.url.endsWith('page=2')) return reply(response, 200, [{ id: 2, tag_name: 'v1.1.0' }]);
      reply(response, 200, [{ id: 1, tag_name: 'v1.1.0' }], { link: `<${options.api}/repos/o/r/releases?per_page=100&page=2>; rel="next"` });
    });
    await expect(findGitHubRelease('v1.1.0', options)).rejects.toThrow('Several GitHub releases use v1.1.0; delete the extra ones and re-run: release 1, release 2');
    expect(requests.map((item) => item.url)).toEqual(['/repos/o/r/releases?per_page=100', '/repos/o/r/releases?per_page=100&page=2', '/repos/o/r/releases?per_page=100&page=2']);
  });

  it('fails closed when GitHub cannot be reached', async () => {
    const api = await closedPort();
    await expect(findGitHubRelease('v1.1.0', { api, repository: 'o/r', token: 'secret', delayMs: 1 }))
      .rejects.toThrow('GitHub could not be reached while listing releases: fetch failed ECONNREFUSED');
  });

  it('cuts a request that never answers at the deadline', async () => {
    const { options, requests } = await releasesApi([], () => {});
    const started = Date.now();
    await expect(findGitHubRelease('v1.1.0', { ...options, budgetMs: 300 }))
      .rejects.toThrow('GitHub could not be reached while listing releases: The operation was aborted due to timeout');
    expect(Date.now() - started).toBeLessThan(3000);
    expect(requests).toHaveLength(1);
  });

  it('rejects several releases that use the tag and names them', async () => {
    const { options } = await releasesApi([[
      { id: 3, tag_name: 'v1.1.0', draft: true, html_url: 'https://github.test/o/r/releases/tag/untagged-a' },
      { id: 4, tag_name: 'v1.1.0', html_url: 'https://github.test/o/r/releases/tag/v1.1.0' },
    ]]);
    await expect(findGitHubRelease('v1.1.0', options)).rejects.toThrow(
      'Several GitHub releases use v1.1.0; delete the extra ones and re-run: https://github.test/o/r/releases/tag/untagged-a, https://github.test/o/r/releases/tag/v1.1.0',
    );
  });

  it.each([
    ['an object', { message: 'not a list' }],
    ['invalid JSON', '[{"tag_name":'],
    ['a release without a tag name', [{ id: 1 }]],
    ['a null release', [null]],
  ])('rejects %s in the listing without retrying', async (label, body) => {
    const { options, requests } = await releasesApi([], (request, response) => reply(response, 200, body));
    await expect(findGitHubRelease('v1.1.0', options)).rejects.toThrow('GitHub sent a malformed response while listing releases');
    expect(requests).toHaveLength(1);
  });

  it('refuses pagination to another origin and never sends it the token', async () => {
    const foreign = [];
    const elsewhere = await serve((request, response) => { foreign.push(request.headers.authorization); reply(response, 200, []); });
    const { api, options } = await releasesApi([], (request, response) => reply(response, 200, [], { link: `<${elsewhere}/repos/o/r/releases?page=2>; rel="next"` }));
    await expect(findGitHubRelease('v1.1.0', options)).rejects.toThrow(`GitHub pagination left ${api} while listing releases`);
    expect(foreign).toEqual([]);
  });

  it('stops after the page limit', async () => {
    const { options, requests } = await releasesApi([], (request, response, count) => (
      reply(response, 200, [{ id: count, tag_name: 'v0.0.1' }], { link: `<${options.api}/repos/o/r/releases?per_page=100&page=${count + 1}>; rel="next"` })
    ));
    await expect(findGitHubRelease('v1.1.0', { ...options, maxPages: 3 })).rejects.toThrow('GitHub returned more than 3 pages while listing releases');
    expect(requests).toHaveLength(3);
  });

  it.each([
    ['1.1.0', { repository: 'o/r', token: 'secret' }, 'Invalid release tag'],
    ['v1.1', { repository: 'o/r', token: 'secret' }, 'Invalid release tag'],
    [undefined, { repository: 'o/r', token: 'secret' }, 'Invalid release tag'],
    ['v1.1.0', { token: 'secret' }, 'A GitHub repository (owner/name, from GITHUB_REPOSITORY) is required'],
    ['v1.1.0', { repository: 'o/..', token: 'secret' }, 'A GitHub repository (owner/name, from GITHUB_REPOSITORY) is required'],
    ['v1.1.0', { repository: 'o/r/releases', token: 'secret' }, 'A GitHub repository (owner/name, from GITHUB_REPOSITORY) is required'],
    ['v1.1.0', { repository: 'o/r' }, 'A GitHub token (GH_TOKEN or GITHUB_TOKEN) is required'],
    ['v1.1.0', { repository: 'o/r', token: '' }, 'A GitHub token (GH_TOKEN or GITHUB_TOKEN) is required'],
  ])('requires a release tag, a repository and a token before any request: %s', async (tag, settings, message) => {
    const { api, requests } = await releasesApi();
    await expect(findGitHubRelease(tag, { api, ...settings })).rejects.toThrow(message);
    expect(requests).toEqual([]);
  });

  it('reads listings page by page so a caller can stop early', async () => {
    const { options, requests } = await releasesApi([[{ id: 2 }], [{ id: 1 }]]);
    const pages = [];
    for await (const page of githubPages('repos/o/r/releases?per_page=100', { ...options, what: 'listing releases' })) {
      pages.push(page);
      break;
    }
    expect(pages).toEqual([[{ id: 2 }]]);
    expect(requests).toHaveLength(1);
  });
});

describe('github-release CLI', () => {
  const cli = fileURLToPath(new URL('../scripts/github-release.js', import.meta.url));
  // Asynchronous, so the in-process API keeps answering; the environment is explicit so a CI
  // runner's GITHUB_* variables never leak in.
  const run = (args, env) => new Promise((resolve) => {
    execFile(process.execPath, [cli, ...args], { encoding: 'utf8', env, timeout: 30000 }, (error, stdout, stderr) => {
      resolve({ status: error ? error.code : 0, stdout, stderr });
    });
  });

  it('prints exists= only after a definitive answer', async () => {
    const { api, requests } = await releasesApi([[{ id: 1, tag_name: 'v1.0.0' }], [{ id: 2, tag_name: 'v1.1.0', draft: true }]]);
    const env = { GITHUB_API_URL: api, GITHUB_REPOSITORY: 'o/r', GH_TOKEN: 'secret' };
    expect(await run(['find', 'v1.1.0'], env)).toEqual({ status: 0, stdout: 'exists=true\n', stderr: '' });
    expect(await run(['find', 'v1.2.0'], env)).toEqual({ status: 0, stdout: 'exists=false\n', stderr: '' });
    expect(await run(['find', 'v1.2.0'], { GITHUB_API_URL: api, GITHUB_REPOSITORY: 'o/r', GITHUB_TOKEN: 'secret' })).toEqual({ status: 0, stdout: 'exists=false\n', stderr: '' });
    expect(requests.every((item) => item.authorization === 'Bearer secret')).toBe(true);
    expect(requests).toHaveLength(6);
  });

  it('fails with no output when the lookup does not complete', async () => {
    const { api } = await releasesApi([], (request, response) => reply(response, 404, { message: 'Not Found' }));
    expect(await run(['find', 'v1.1.0'], { GITHUB_API_URL: api, GITHUB_REPOSITORY: 'o/r', GH_TOKEN: 'secret' }))
      .toEqual({ status: 1, stdout: '', stderr: 'GitHub returned 404 while listing releases\n' });
    const { api: duplicated } = await releasesApi([[{ id: 3, tag_name: 'v1.1.0' }, { id: 4, tag_name: 'v1.1.0' }]]);
    expect(await run(['find', 'v1.1.0'], { GITHUB_API_URL: duplicated, GITHUB_REPOSITORY: 'o/r', GH_TOKEN: 'secret' }))
      .toEqual({ status: 1, stdout: '', stderr: 'Several GitHub releases use v1.1.0; delete the extra ones and re-run: release 3, release 4\n' });
  });

  it.each([
    [['find', 'v1.1.0'], { GITHUB_REPOSITORY: 'o/r' }, 'A GitHub token (GH_TOKEN or GITHUB_TOKEN) is required'],
    [['find', 'v1.1.0'], { GH_TOKEN: 'secret' }, 'A GitHub repository (owner/name, from GITHUB_REPOSITORY) is required'],
    [['find', '1.1.0'], { GITHUB_REPOSITORY: 'o/r', GH_TOKEN: 'secret' }, 'Invalid release tag'],
    [[], { GITHUB_REPOSITORY: 'o/r', GH_TOKEN: 'secret' }, 'Usage: node scripts/github-release.js find <tag>'],
    [['find'], { GITHUB_REPOSITORY: 'o/r', GH_TOKEN: 'secret' }, 'Usage: node scripts/github-release.js find <tag>'],
    [['view', 'v1.1.0'], { GITHUB_REPOSITORY: 'o/r', GH_TOKEN: 'secret' }, 'Usage: node scripts/github-release.js find <tag>'],
    [['find', 'v1.1.0', 'extra'], { GITHUB_REPOSITORY: 'o/r', GH_TOKEN: 'secret' }, 'Usage: node scripts/github-release.js find <tag>'],
  ])('refuses %j before any request', async (args, env, message) => {
    const { api, requests } = await releasesApi();
    expect(await run(args, { GITHUB_API_URL: api, ...env })).toEqual({ status: 1, stdout: '', stderr: `${message}\n` });
    expect(requests).toEqual([]);
  });
});
