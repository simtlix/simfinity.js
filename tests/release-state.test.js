import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { writeReleaseFixture } from './helpers/release-fixture.js';
import { setReleaseVersion } from '../scripts/release-packages.js';
import * as state from '../scripts/release-state.js';

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
      paths.push(decodeURIComponent(request.url));
      const version = paths.length === 5 ? '3.2.1' : '3.2.0';
      response.end(JSON.stringify({ versions: { [version]: {} } }));
    });
    await expect(Promise.resolve().then(() => state.assertReleaseCurrent(root, '3.2.0', { registry: url }))).rejects.toThrow(/newer|supersed/i);
    expect(new Set(paths).size).toBe(5);
  });

  it('allows queued tags and the stable channel when only a newer prerelease is published', async () => {
    const { root } = fixture();
    git(root, 'tag', 'v9.0.0');
    const url = await registry((request, response) => {
      response.end(JSON.stringify({ versions: { '3.2.0': {}, '4.0.0-rc.1': {} } }));
    });
    await expect(Promise.resolve().then(() => state.assertReleaseCurrent(root, '3.2.0', { registry: url }))).resolves.toBeUndefined();
  });

  it('allows a package with no published versions only on a real 404 response', async () => {
    const { root } = fixture();
    const url = await registry((request, response) => { response.statusCode = 404; response.end('{}'); });
    await expect(Promise.resolve().then(() => state.assertReleaseCurrent(root, '3.2.0', { registry: url }))).resolves.toBeUndefined();
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
