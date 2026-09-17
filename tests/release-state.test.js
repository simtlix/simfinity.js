import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeReleaseFixture } from './helpers/release-fixture.js';
import { setReleaseVersion } from '../scripts/release-packages.js';
import * as state from '../scripts/release-state.js';

const roots = [];
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (root) => {
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Release Test', '-c', 'user.email=release@example.test', 'commit', '-qm', 'fixture');
  return git(root, 'rev-parse', 'HEAD');
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

describe('automatic release selection', () => {
  it('selects an aligned unreleased version and its committed source', () => {
    const { root, head } = fixture();
    expect(state.selectRelease(root)).toEqual({ version: '3.2.0', tag: 'v3.2.0', commit: head, shouldRelease: true, prerelease: false });
  });

  it('retries the same commit after its tag was already created', () => {
    const { root, head } = fixture();
    git(root, 'tag', 'v3.2.0');
    expect(state.selectRelease(root)).toMatchObject({ commit: head, shouldRelease: true });
  });

  it('does not publish changed sources under an already released version', () => {
    const { root, head } = fixture();
    git(root, 'tag', 'v3.2.0');
    writeFileSync(join(root, 'notes.md'), 'documentation only');
    commit(root);
    expect(state.selectRelease(root)).toMatchObject({ commit: head, shouldRelease: false });
    expect(state.selectRelease(root, { retryExisting: true })).toMatchObject({ commit: head, shouldRelease: true });
  });

  it('rejects a tag outside the current history instead of moving it', () => {
    const { root } = fixture();
    writeFileSync(join(root, 'notes.md'), 'other branch');
    commit(root);
    git(root, 'tag', 'v3.2.0');
    git(root, 'checkout', '--detach', 'HEAD~1');
    expect(() => state.selectRelease(root)).toThrow(/ancestor|history/i);
    expect(git(root, 'rev-parse', 'v3.2.0')).not.toBe(git(root, 'rev-parse', 'HEAD'));
  });

  it('rejects a new stable version below a previously released stable version', () => {
    const { root } = fixture();
    git(root, 'tag', 'v3.2.0');
    setReleaseVersion(root, '3.1.1');
    commit(root);
    expect(() => state.selectRelease(root)).toThrow(/newer|advance/i);
  });

  it('compares numeric versions and identifies prereleases', () => {
    const { root } = fixture();
    git(root, 'tag', 'v3.2.0');
    setReleaseVersion(root, '3.10.0');
    commit(root);
    expect(state.selectRelease(root)).toMatchObject({ tag: 'v3.10.0', shouldRelease: true, prerelease: false });
    setReleaseVersion(root, '4.0.0-rc.1');
    commit(root);
    expect(state.selectRelease(root)).toMatchObject({ tag: 'v4.0.0-rc.1', prerelease: true });
  });

  it('rejects uncommitted release source', () => {
    const { root } = fixture();
    writeFileSync(join(root, 'packages/core/src/index.js'), 'export const dirty = true;');
    expect(() => state.selectRelease(root)).toThrow(/clean|committed/i);
  });

  it.each([false, true])('rejects a superseded old run even when its own tag exists: %s', (tagged) => {
    const { root, head } = fixture();
    if (tagged) git(root, 'tag', 'v3.2.0');
    setReleaseVersion(root, '3.2.1');
    commit(root);
    git(root, 'tag', 'v3.2.1');
    git(root, 'checkout', '--detach', head);
    expect(() => state.selectRelease(root, { retryExisting: true })).toThrow(/newer|supersed/i);
    // A failed-job retry can reuse source outputs, so publication must guard again.
    expect(() => state.assertReleaseCurrent(root, '3.2.0')).toThrow(/newer|supersed/i);
  });

  it.each([
    ['4.0.0-rc.2', '4.0.0-rc.10'],
    ['4.0.0-beta.1', '4.0.0-rc.1'],
    ['4.0.0-rc.1', '4.0.0'],
  ])('rejects stale prerelease %s after %s was tagged', (candidate, newer) => {
    const { root } = fixture();
    setReleaseVersion(root, candidate);
    const head = commit(root);
    setReleaseVersion(root, newer);
    commit(root);
    git(root, 'tag', `v${newer}`);
    git(root, 'checkout', '--detach', head);
    expect(() => state.selectRelease(root)).toThrow(/newer|supersed/i);
  });

  it('previews the current candidate rather than testing an older version tag', () => {
    const { root } = fixture();
    git(root, 'tag', 'v3.2.0');
    writeFileSync(join(root, 'packages/core/src/index.js'), 'export const candidate = true;');
    const head = commit(root);
    expect(state.selectRelease(root, { preview: true })).toMatchObject({ commit: head, shouldRelease: true });
  });

  it('keeps the stable channel available when only a newer prerelease exists', () => {
    const { root } = fixture();
    git(root, 'tag', 'v4.0.0-rc.1');
    expect(() => state.assertReleaseCurrent(root, '3.2.0')).not.toThrow();
  });
});
