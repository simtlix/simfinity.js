import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeReleaseFixture } from './helpers/release-fixture.js';
import { setReleaseVersion } from '../scripts/release-packages.js';
import * as state from '../scripts/release-state.js';

// Git fixtures and spawned CLIs can exceed the default 5 s while the full suite loads the machine.
vi.setConfig({ testTimeout: 30000 });

const roots = [];
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root) => {
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Release Test', '-c', 'user.email=release@example.test', 'commit', '-qm', 'fixture');
  const head = git(root, 'rev-parse', 'HEAD');
  git(root, 'update-ref', 'refs/remotes/origin/master', head);
  return head;
};
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'simfinity-release-state-'));
  roots.push(root);
  writeReleaseFixture(root);
  setReleaseVersion(root, '3.2.0');
  git(root, 'init', '-q');
  return { root, head: commit(root) };
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('tag and GitHub release selection', () => {
  it('does not authorize publication just because an aligned version exists', () => {
    const { root } = fixture();
    expect(() => state.selectRelease(root)).toThrow(/explicit.*tag/i);
  });

  it.each(['lightweight', 'annotated'])('selects the explicit %s release tag', (kind) => {
    const { root, head } = fixture();
    if (kind === 'annotated') git(root, '-c', 'user.name=Release Test', '-c', 'user.email=release@example.test', 'tag', '-a', 'v3.2.0', '-m', 'release');
    else git(root, 'tag', 'v3.2.0');
    expect(state.selectRelease(root, { tag: 'v3.2.0' })).toEqual({ version: '3.2.0', tag: 'v3.2.0', commit: head, prerelease: false });
  });

  it('rejects a tag that has not been created', () => {
    const { root } = fixture();
    expect(() => state.selectRelease(root, { tag: 'v3.2.0' })).toThrow(/tag.*exist/i);
  });

  it.each(['v3.2.1', '3.2.0', 'master'])('rejects a tag inconsistent with the package version: %s', (tag) => {
    const { root } = fixture();
    git(root, 'tag', tag);
    expect(() => state.selectRelease(root, { tag })).toThrow(/tag.*version/i);
  });

  it('rejects changed source checked out after the tagged commit', () => {
    const { root, head } = fixture();
    git(root, 'tag', 'v3.2.0');
    writeFileSync(join(root, 'notes.md'), 'documentation only');
    commit(root);
    expect(() => state.selectRelease(root, { tag: 'v3.2.0' })).toThrow(/tag.*checked out/i);
    git(root, 'checkout', '--detach', head);
    expect(state.selectRelease(root, { tag: 'v3.2.0' })).toMatchObject({ commit: head });
  });

  it('rejects release tags whose source has not been merged to master', () => {
    const { root, head } = fixture();
    writeFileSync(join(root, 'notes.md'), 'unmerged branch');
    commit(root);
    git(root, 'update-ref', 'refs/remotes/origin/master', head);
    git(root, 'tag', 'v3.2.0');
    expect(() => state.selectRelease(root, { tag: 'v3.2.0' })).toThrow(/master/i);
  });

  it('compares numeric versions and identifies prereleases', () => {
    const { root } = fixture();
    git(root, 'tag', 'v3.2.0');
    setReleaseVersion(root, '3.10.0');
    commit(root);
    git(root, 'tag', 'v3.10.0');
    expect(state.selectRelease(root, { tag: 'v3.10.0' })).toMatchObject({ tag: 'v3.10.0', prerelease: false });
    setReleaseVersion(root, '4.0.0-rc.1');
    commit(root);
    git(root, 'tag', 'v4.0.0-rc.1');
    expect(state.selectRelease(root, { tag: 'v4.0.0-rc.1' })).toMatchObject({ tag: 'v4.0.0-rc.1', prerelease: true });
  });

  it('rejects uncommitted release source', () => {
    const { root } = fixture();
    git(root, 'tag', 'v3.2.0');
    writeFileSync(join(root, 'packages/core/src/index.js'), 'export const dirty = true;');
    expect(() => state.selectRelease(root, { tag: 'v3.2.0' })).toThrow(/clean|committed/i);
  });

  it('keeps a tagged version eligible while a newer tag is still waiting to publish', () => {
    const { root, head } = fixture();
    git(root, 'tag', 'v3.2.0');
    setReleaseVersion(root, '3.2.1');
    commit(root);
    git(root, 'tag', 'v3.2.1');
    git(root, 'checkout', '--detach', head);
    expect(state.selectRelease(root, { tag: 'v3.2.0' })).toMatchObject({ commit: head });
  });

  it('previews the current branch without requiring or creating a release tag', () => {
    const { root } = fixture();
    git(root, 'tag', 'v3.2.0');
    writeFileSync(join(root, 'packages/core/src/index.js'), 'export const candidate = true;');
    const head = commit(root);
    expect(state.selectRelease(root, { preview: true })).toEqual({ version: '3.2.0', tag: 'v3.2.0', commit: head, prerelease: false });
    expect(git(root, 'rev-parse', 'v3.2.0')).not.toBe(head);
  });

});

const servers = [];
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

describe('release freshness before publication and deployment', () => {
  it.each([
    ['3.2.0', '3.2.1'],
    ['3.2.0', '3.10.0'],
    ['4.0.0-rc.2', '4.0.0-rc.10'],
    ['4.0.0-beta.1', '4.0.0-rc.1'],
    ['4.0.0-rc.1', '4.0.0'],
  ])('rejects retry of %s when %s is actually published', async (candidate, newer) => {
    const { root } = fixture();
    const url = await registry((request, response) => {
      expect(request.method).toBe('GET');
      response.end(JSON.stringify({ versions: { [newer]: {} } }));
    });
    await expect(Promise.resolve().then(() => state.assertReleaseCurrent(root, candidate, { registry: url }))).rejects.toThrow(/newer|supersed/i);
  });

  it('checks all packages so a partially published newer version also blocks rollback', async () => {
    const { root } = fixture();
    const paths = [];
    const url = await registry((request, response) => {
      paths.push(decodeURIComponent(new URL(request.url, 'http://registry.test').pathname));
      const version = paths.length === 7 ? '3.2.1' : '3.2.0';
      response.end(JSON.stringify({ versions: { [version]: {} } }));
    });
    await expect(Promise.resolve().then(() => state.assertReleaseCurrent(root, '3.2.0', { registry: url }))).rejects.toThrow(/newer|supersed/i);
    expect(new Set(paths).size).toBe(7);
  });

  it('reads every packument uncached, past the registry CDN', async () => {
    const { root } = fixture();
    const targets = [];
    const url = await registry((request, response) => {
      const target = new URL(request.url, 'http://registry.test');
      targets.push([target.pathname, [...target.searchParams]]);
      response.end(JSON.stringify({ versions: { '3.2.0': {} } }));
    });
    await expect(Promise.resolve().then(() => state.assertReleaseCurrent(root, '3.2.0', { registry: url }))).resolves.toBeUndefined();
    expect(targets).toEqual([
      ['/%40simtlix%2Fsimfinity-core', [['write', 'true']]],
      ['/%40simtlix%2Fsimfinity-sql', [['write', 'true']]],
      ['/%40simtlix%2Fsimfinity-mcp', [['write', 'true']]],
      ['/%40simtlix%2Fsimfinity-descriptor', [['write', 'true']]],
      ['/%40simtlix%2Fsimfinity-postgres', [['write', 'true']]],
      ['/%40simtlix%2Fsimfinity-js', [['write', 'true']]],
      ['/%40simtlix%2Fsimfinity-js-client', [['write', 'true']]],
    ]);
  });

  it('allows queued tags and the stable channel when only a newer prerelease is published', async () => {
    const { root } = fixture();
    git(root, 'tag', 'v9.0.0');
    const url = await registry((request, response) => {
      response.end(JSON.stringify({ versions: { '3.2.0': {}, '4.0.0-rc.1': {} } }));
    });
    await expect(Promise.resolve().then(() => state.assertReleaseCurrent(root, '3.2.0', { registry: url }))).resolves.toBeUndefined();
  });

  it('fails closed when a release package is not on the registry', async () => {
    const { root } = fixture();
    const url = await registry((request, response) => {
      if (decodeURIComponent(new URL(request.url, 'http://registry.test').pathname) === '/@simtlix/simfinity-sql') {
        response.statusCode = 404;
        response.end('{"error":"Not found"}');
      } else response.end(JSON.stringify({ versions: { '3.1.0': {}, '3.2.0': {} } }));
    });
    await expect(Promise.resolve().then(() => state.assertReleaseCurrent(root, '3.2.0', { registry: url })))
      .rejects.toThrow('@simtlix/simfinity-sql is not on the registry; publish it once and configure its Trusted Publisher before releasing');
  });

  it('fails closed when every release package returns 404', async () => {
    const { root } = fixture();
    const url = await registry((request, response) => { response.statusCode = 404; response.end('{"error":"Not found"}'); });
    await expect(Promise.resolve().then(() => state.assertReleaseCurrent(root, '3.2.0', { registry: url })))
      .rejects.toThrow('@simtlix/simfinity-core, @simtlix/simfinity-sql, @simtlix/simfinity-mcp, @simtlix/simfinity-descriptor, @simtlix/simfinity-postgres, @simtlix/simfinity-js, @simtlix/simfinity-js-client are not on the registry; publish them once and configure their Trusted Publishers before releasing');
  });

  it('still reports a newer published sibling when a release package returns 404', async () => {
    const { root } = fixture();
    const url = await registry((request, response) => {
      if (decodeURIComponent(new URL(request.url, 'http://registry.test').pathname) === '/@simtlix/simfinity-core') {
        response.statusCode = 404;
        response.end('{"error":"Not found"}');
      } else response.end(JSON.stringify({ versions: { '3.2.0': {}, '3.2.1': {} } }));
    });
    await expect(Promise.resolve().then(() => state.assertReleaseCurrent(root, '3.2.0', { registry: url }))).rejects.toThrow(/supersed/i);
  });

  it.each([401, 429, 500])('fails closed on registry HTTP %s', async (status) => {
    const { root } = fixture();
    const url = await registry((request, response) => { response.statusCode = status; response.end('{}'); });
    await expect(Promise.resolve().then(() => state.assertReleaseCurrent(root, '3.2.0', { registry: url }))).rejects.toThrow(String(status));
  });

  it('fails closed on incomplete registry metadata', async () => {
    const { root } = fixture();
    const url = await registry((request, response) => { response.end('{}'); });
    await expect(Promise.resolve().then(() => state.assertReleaseCurrent(root, '3.2.0', { registry: url }))).rejects.toThrow(/metadata/i);
  });
});

const cli = fileURLToPath(new URL('../scripts/release-state.js', import.meta.url));
const runCli = (root, ...args) => execFileSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

describe('packing job source verification (#155)', () => {
  it('accepts the selected release tag and commit and nothing else', () => {
    const { root, head } = fixture();
    git(root, 'tag', 'v3.2.0');
    expect(state.assertSelectedSource(root, { tag: 'v3.2.0', commit: head })).toEqual({ version: '3.2.0', tag: 'v3.2.0', commit: head, prerelease: false });
    for (const commit of ['f'.repeat(40), '', undefined, head.toUpperCase()]) {
      expect(() => state.assertSelectedSource(root, { tag: 'v3.2.0', commit })).toThrow('Checked out source must be the selected release commit');
    }
    expect(() => state.assertSelectedSource(root, { tag: 'v3.2.1', commit: head })).toThrow(/tag.*version/i);
  });

  it('requires the tag on the checked out commit and in master history outside a preview', () => {
    const { root, head } = fixture();
    expect(() => state.assertSelectedSource(root, { tag: 'v3.2.0', commit: head })).toThrow(/tag.*exist/i);
    git(root, 'tag', 'v3.2.0');
    writeFileSync(join(root, 'notes.md'), 'unmerged');
    const unmerged = commit(root);
    git(root, 'update-ref', 'refs/remotes/origin/master', head);
    expect(() => state.assertSelectedSource(root, { tag: 'v3.2.0', commit: unmerged })).toThrow(/tag.*checked out/i);
    git(root, 'tag', '-f', 'v3.2.0', unmerged);
    expect(() => state.assertSelectedSource(root, { tag: 'v3.2.0', commit: unmerged })).toThrow(/merged into master/i);
  });

  it('checks a preview against its version-derived tag and commit without requiring a tag', () => {
    const { root, head } = fixture();
    expect(state.assertSelectedSource(root, { tag: 'v3.2.0', commit: head, preview: true })).toEqual({ version: '3.2.0', tag: 'v3.2.0', commit: head, prerelease: false });
    expect(() => state.assertSelectedSource(root, { tag: 'v3.2.1', commit: head, preview: true })).toThrow('Release tag must match the aligned package version');
    expect(() => state.assertSelectedSource(root, { tag: 'v3.2.0', commit: 'f'.repeat(40), preview: true })).toThrow('Checked out source must be the selected release commit');
  });

  it('rejects uncommitted or untracked source before packing', () => {
    const { root, head } = fixture();
    git(root, 'tag', 'v3.2.0');
    writeFileSync(join(root, 'packages/core/src/untracked.js'), 'export const leaked = true;');
    for (const preview of [false, true]) {
      expect(() => state.assertSelectedSource(root, { tag: 'v3.2.0', commit: head, preview })).toThrow('Release source must be clean and committed');
    }
  });

  it('exposes verify-source on the CLI and fails closed on missing or mismatched input', () => {
    const { root, head } = fixture();
    git(root, 'tag', 'v3.2.0');
    const selected = `version=3.2.0\ntag=v3.2.0\ncommit=${head}\nprerelease=false\n`;
    expect(runCli(root, 'verify-source', 'v3.2.0', head)).toBe(selected);
    expect(runCli(root, 'verify-source', 'v3.2.0', head, '--preview')).toBe(selected);
    expect(() => runCli(root, 'verify-source', 'v3.2.0', 'f'.repeat(40))).toThrow(/selected release commit/);
    expect(() => runCli(root, 'verify-source', 'v3.2.1', head, '--preview')).toThrow(/aligned package version/);
    for (const args of [['verify-source', 'v3.2.0'], ['verify-source'], ['verify-source', 'v3.2.0', head, '--execute'], ['verify-source', 'v3.2.0', head, '--preview', 'extra']]) {
      expect(() => runCli(root, ...args)).toThrow(/Usage: node scripts\/release-state\.js release <tag> \| preview \| verify-source <tag> <commit> \[--preview\] \| verify-current <version> \| verify-docs <version> <commit>\n/);
    }
  });
});

// Tag commit T at 3.2.0, a docs-only master commit M on top of it, and a commit X branched off T.
const pagesFixture = () => {
  const { root, head: tagged } = fixture();
  writeFileSync(join(root, 'notes.md'), 'documentation fix on master');
  const master = commit(root);
  git(root, 'checkout', '-q', '--detach', tagged);
  writeFileSync(join(root, 'branch.md'), 'unmerged branch');
  const branch = commit(root);
  git(root, 'checkout', '-q', '--detach', master);
  return { root, tagged, master, branch };
};
const npm = async (versions = ['3.2.0']) => {
  const requests = [];
  const url = await registry((request, response) => {
    requests.push(request.url);
    response.end(JSON.stringify({ versions: Object.fromEntries(versions.map((version) => [version, {}])) }));
  });
  return { registry: url, requests };
};
// A GitHub API serving `deployments` of github-pages and each deployment's `statuses` by id.
const pagesApi = async (deployments = [], statuses = {}, respond) => {
  const requests = [];
  const api = await registry((request, response) => {
    requests.push(request.url);
    if (respond) return respond(request, response, requests.length);
    const send = (status, value) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    if (request.url === '/repos/o/r/deployments?environment=github-pages&per_page=100') return send(200, deployments);
    const match = /^\/repos\/o\/r\/deployments\/(\d+)\/statuses\?per_page=100$/.exec(request.url);
    if (match) return send(200, statuses[match[1]] ?? []);
    send(404, { message: 'Not Found' });
  });
  return { github: { api, repository: 'o/r', token: 'secret', delayMs: 1 }, requests };
};
const deployment = (id, sha) => ({ id, sha, environment: 'github-pages' });
// Refusals before any network call touch neither the checkout nor git.
const unused = () => {
  const root = mkdtempSync(join(tmpdir(), 'simfinity-docs-gate-'));
  roots.push(root);
  return root;
};
const [someCommit, otherCommit] = ['a'.repeat(40), 'b'.repeat(40)];
const succeeded = (id) => [{ id: id * 10 + 2, state: 'success' }, { id: id * 10 + 1, state: 'in_progress' }];
const deploymentsListing = '/repos/o/r/deployments?environment=github-pages&per_page=100';
const statusesOf = (id) => `/repos/o/r/deployments/${id}/statuses?per_page=100`;

describe('documentation deployment gate (#123)', () => {
  it.each(['4.0.0-rc.1', '3.2.0-beta.1', 'v3.2.0', '3.2', '03.2.0', '3.2.0+build', '', undefined])('refuses %s documentation before any network call', async (version) => {
    const npmApi = await npm();
    const { github, requests } = await pagesApi();
    await expect(state.assertDocumentationCurrent(unused(), version, someCommit, { registry: npmApi.registry, github }))
      .rejects.toThrow(`Only a stable release version can replace the documentation site, not ${version}`);
    expect([npmApi.requests, requests]).toEqual([[], []]);
  });

  it('refuses a source that is not a full commit id before any network call', async () => {
    const npmApi = await npm();
    const { github, requests } = await pagesApi();
    for (const source of [someCommit.slice(0, 12), 'A'.repeat(40), 'HEAD', '', undefined]) {
      await expect(state.assertDocumentationCurrent(unused(), '4.0.0-rc.1', source, { registry: npmApi.registry, github }))
        .rejects.toThrow('Documentation source must be a full commit id');
    }
    expect([npmApi.requests, requests]).toEqual([[], []]);
  });

  it('refuses a source other than the commit the run deploys before any network call', async () => {
    const npmApi = await npm();
    const { github, requests } = await pagesApi();
    await expect(state.assertDocumentationCurrent(unused(), '3.2.0', someCommit, { registry: npmApi.registry, github, expectedCommit: otherCommit }))
      .rejects.toThrow(`Documentation source ${someCommit} is not the commit this run deploys (${otherCommit})`);
    expect([npmApi.requests, requests]).toEqual([[], []]);
  });

  it('requires a GitHub repository and token before any network call', async () => {
    const [root, master] = [unused(), someCommit];
    const npmApi = await npm();
    const { github, requests } = await pagesApi();
    await expect(state.assertDocumentationCurrent(root, '3.2.0', master, { registry: npmApi.registry, github: { ...github, token: undefined } }))
      .rejects.toThrow('A GitHub token (GH_TOKEN or GITHUB_TOKEN) is required');
    await expect(state.assertDocumentationCurrent(root, '3.2.0', master, { registry: npmApi.registry, github: { ...github, repository: undefined } }))
      .rejects.toThrow('A GitHub repository (owner/name, from GITHUB_REPOSITORY) is required');
    await expect(state.assertDocumentationCurrent(root, '3.2.0', master, { registry: npmApi.registry }))
      .rejects.toThrow('A GitHub repository (owner/name, from GITHUB_REPOSITORY) is required');
    expect([npmApi.requests, requests]).toEqual([[], []]);
  });

  it('keeps the npm freshness guard before reading deployments', async () => {
    const { root, head: master } = fixture();
    const npmApi = await npm(['3.2.0', '3.2.1']);
    const { github, requests } = await pagesApi([deployment(2, master)], { 2: succeeded(2) });
    await expect(state.assertDocumentationCurrent(root, '3.2.0', master, { registry: npmApi.registry, github })).rejects.toThrow(/supersed/);
    expect(requests).toEqual([]);
  });

  it('deploys a source that descends from the live site, or is the live commit itself', async () => {
    const { root, tagged, master } = pagesFixture();
    const npmApi = await npm();
    const { github, requests } = await pagesApi([deployment(2, tagged), deployment(1, tagged)], { 2: succeeded(2), 1: succeeded(1) });
    await expect(state.assertDocumentationCurrent(root, '3.2.0', master, { registry: npmApi.registry, github, expectedCommit: master }))
      .resolves.toEqual({ deploy: true, live: tagged, deployment: 2 });
    expect(requests).toEqual([deploymentsListing, statusesOf(2)]);
    await expect(state.assertDocumentationCurrent(root, '3.2.0', tagged, { registry: npmApi.registry, github }))
      .resolves.toEqual({ deploy: true, live: tagged, deployment: 2 });
  });

  it('skips, without failing, a source that the live site already contains', async () => {
    const { root, tagged, master } = pagesFixture();
    const npmApi = await npm();
    const { github } = await pagesApi([deployment(3, master), deployment(2, tagged)], { 3: succeeded(3), 2: succeeded(2) });
    await expect(state.assertDocumentationCurrent(root, '3.2.0', tagged, { registry: npmApi.registry, github }))
      .resolves.toEqual({ deploy: false, live: master, deployment: 3 });
  });

  it('refuses a source that neither contains nor is contained in the live site', async () => {
    const { root, master, branch } = pagesFixture();
    const npmApi = await npm();
    const { github } = await pagesApi([deployment(3, master)], { 3: succeeded(3) });
    await expect(state.assertDocumentationCurrent(root, '3.2.0', branch, { registry: npmApi.registry, github })).rejects.toThrow(
      `Documentation source ${branch} neither contains nor is contained in the live site ${master} (deployment 3); release from a master merge commit or deploy documentation from master`,
    );
  });

  it('refuses when the live commit or the source is not in this clone', async () => {
    const { root, master } = pagesFixture();
    const npmApi = await npm();
    const unknown = 'f'.repeat(40);
    const { github } = await pagesApi([deployment(3, unknown)], { 3: succeeded(3) });
    await expect(state.assertDocumentationCurrent(root, '3.2.0', master, { registry: npmApi.registry, github }))
      .rejects.toThrow(`The live documentation commit ${unknown} (deployment 3) is not in this clone; refusing to replace it`);
    await expect(state.assertDocumentationCurrent(root, '3.2.0', 'e'.repeat(40), { registry: npmApi.registry, github }))
      .rejects.toThrow(`Documentation source ${'e'.repeat(40)} is not in this clone`);
  });

  it('deploys the first documentation when no deployment has succeeded yet', async () => {
    const { root, head: master } = fixture();
    const npmApi = await npm();
    const none = await pagesApi();
    await expect(state.assertDocumentationCurrent(root, '3.2.0', master, { registry: npmApi.registry, github: none.github }))
      .resolves.toEqual({ deploy: true, live: '', deployment: '' });
    const failed = await pagesApi([deployment(2, master), deployment(1, master)], { 2: [{ id: 21, state: 'failure' }] });
    await expect(state.assertDocumentationCurrent(root, '3.2.0', master, { registry: npmApi.registry, github: failed.github }))
      .resolves.toEqual({ deploy: true, live: '', deployment: '' });
    expect(failed.requests).toEqual([deploymentsListing, statusesOf(2), statusesOf(1)]);
  });

  it('takes the newest deployment whose newest status is success', async () => {
    const [tagged, master] = [someCommit, otherCommit];
    const { github, requests } = await pagesApi(
      [deployment(5, master), deployment(4, master), deployment(3, master), deployment(2, tagged), deployment(1, master)],
      {
        5: [{ id: 52, state: 'in_progress' }, { id: 51, state: 'waiting' }],
        4: [{ id: 41, state: 'success' }, { id: 42, state: 'inactive' }],
        3: [{ id: 31, state: 'failure' }],
        2: [{ id: 21, state: 'in_progress' }, { id: 22, state: 'success' }],
        1: succeeded(1),
      },
    );
    await expect(state.findLiveDocumentation(github)).resolves.toEqual({ id: 2, sha: tagged });
    expect(requests).toEqual([deploymentsListing, statusesOf(5), statusesOf(4), statusesOf(3), statusesOf(2)]);
  });

  it('follows the deployment listing across pages and refuses a listing that is not newest first', async () => {
    const tagged = someCommit;
    const paged = await pagesApi([], {}, (request, response) => {
      const send = (value, headers = {}) => {
        response.writeHead(200, { 'content-type': 'application/json', ...headers });
        response.end(JSON.stringify(value));
      };
      if (request.url === deploymentsListing) return send([deployment(3, tagged)], { link: `<${paged.github.api}repositories/1/deployments?environment=github-pages&per_page=100&page=2>; rel="next"` });
      if (request.url.endsWith('page=2')) return send([deployment(2, tagged)]);
      send(request.url === statusesOf(2) ? succeeded(2) : [{ id: 31, state: 'error' }]);
    });
    await expect(state.findLiveDocumentation(paged.github)).resolves.toEqual({ id: 2, sha: tagged });
    expect(paged.requests).toEqual([deploymentsListing, statusesOf(3), '/repositories/1/deployments?environment=github-pages&per_page=100&page=2', statusesOf(2)]);
    const unordered = await pagesApi([deployment(2, tagged), deployment(3, tagged)], { 2: [{ id: 21, state: 'failure' }] });
    await expect(state.findLiveDocumentation(unordered.github)).rejects.toThrow('GitHub did not list github-pages deployments newest first');
  });

  it.each([401, 403, 404])('fails closed at once when deployments return HTTP %s', async (status) => {
    const { github, requests } = await pagesApi([], {}, (request, response) => { response.statusCode = status; response.end('{}'); });
    await expect(state.findLiveDocumentation(github)).rejects.toThrow(`GitHub returned ${status} while listing github-pages deployments`);
    expect(requests).toEqual([deploymentsListing]);
  });

  it('retries transient GitHub failures and fails closed when they persist', async () => {
    const master = someCommit;
    const recovering = await pagesApi([], {}, (request, response, count) => {
      if (count === 1) { response.statusCode = 502; return response.end('{}'); }
      if (count === 2) return request.socket.destroy();
      if (count === 3) return response.end(JSON.stringify([deployment(4, master)]));
      if (count === 4) { response.statusCode = 503; return response.end('{}'); }
      response.end(JSON.stringify(succeeded(4)));
    });
    await expect(state.findLiveDocumentation(recovering.github)).resolves.toEqual({ id: 4, sha: master });
    expect(recovering.requests).toEqual([deploymentsListing, deploymentsListing, deploymentsListing, statusesOf(4), statusesOf(4)]);
    const failing = await pagesApi([], {}, (request, response) => { response.statusCode = 503; response.end('{}'); });
    await expect(state.findLiveDocumentation(failing.github)).rejects.toThrow('GitHub returned 503 while listing github-pages deployments');
    expect(failing.requests).toHaveLength(3);
  });

  it.each([
    ['a listing that is not an array', { message: 'nope' }, {}, 'GitHub sent a malformed response while listing github-pages deployments'],
    ['a deployment without an id', [{ sha: 'a'.repeat(40), environment: 'github-pages' }], {}, 'GitHub sent a malformed response while listing github-pages deployments'],
    ['a deployment of another environment', [{ id: 2, sha: 'a'.repeat(40), environment: 'preview' }], {}, 'GitHub sent a malformed response while listing github-pages deployments'],
    ['a status without a state', [deployment(2, 'a'.repeat(40))], { 2: [{ id: 21 }] }, 'GitHub sent a malformed response while reading the statuses of deployment 2'],
    ['a live deployment without a commit id', [deployment(2, 'main')], { 2: succeeded(2) }, 'GitHub deployment 2 has no commit id'],
  ])('refuses %s', async (label, deployments, statuses, message) => {
    const { github } = await pagesApi(deployments, statuses);
    await expect(state.findLiveDocumentation(github)).rejects.toThrow(message);
  });

  // The CLI is only run up to its refusals: past them it reads the real npm registry. The
  // environment is explicit, so a CI runner's GITHUB_* variables never leak in.
  it('verify-docs refuses before any network call', async () => {
    const [root, tagged, master] = [unused(), otherCommit, someCommit];
    const { github, requests } = await pagesApi();
    const env = { GITHUB_API_URL: github.api, GITHUB_REPOSITORY: 'o/r', GH_TOKEN: 'secret', GITHUB_SHA: master };
    const run = (args, overrides = {}) => {
      const result = spawnSync(process.execPath, [cli, 'verify-docs', ...args], { cwd: root, encoding: 'utf8', env: { ...env, ...overrides }, timeout: 30000 });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    };
    const refused = (message) => ({ status: 1, stdout: '', stderr: `${message}\n` });
    const usage = 'Usage: node scripts/release-state.js release <tag> | preview | verify-source <tag> <commit> [--preview] | verify-current <version> | verify-docs <version> <commit>';
    expect(run(['3.2.0'])).toEqual(refused(usage));
    expect(run(['3.2.0', master, 'extra'])).toEqual(refused(usage));
    expect(run(['3.2.0', master.slice(0, 12)])).toEqual(refused('Documentation source must be a full commit id'));
    expect(run(['4.0.0-rc.1', master])).toEqual(refused('Only a stable release version can replace the documentation site, not 4.0.0-rc.1'));
    expect(run(['3.2.0', tagged])).toEqual(refused(`Documentation source ${tagged} is not the commit this run deploys (${master})`));
    expect(run(['3.2.0', master], { GH_TOKEN: undefined })).toEqual(refused('A GitHub token (GH_TOKEN or GITHUB_TOKEN) is required'));
    expect(run(['3.2.0', master], { GITHUB_REPOSITORY: undefined })).toEqual(refused('A GitHub repository (owner/name, from GITHUB_REPOSITORY) is required'));
    expect(requests).toEqual([]);
  });
});
