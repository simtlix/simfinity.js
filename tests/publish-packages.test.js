import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { writeReleaseFixture } from './helpers/release-fixture.js';
import { packRelease, setReleaseVersion } from '../scripts/release-packages.js';
import { publishRelease } from '../scripts/publish-packages.js';

let root; let manifest; let manifestPath;
const remoteError = (code) => Object.assign(new Error('Registry rejected request'), { status: 1, stdout: JSON.stringify({ error: { code } }), stderr: '' });
const registry = (initial = new Map(), release = manifest) => {
  const versions = new Map(initial);
  const writes = [];
  const run = (command, args) => {
    expect(command).toBe('npm');
    if (args[0] === 'view') {
      if (!versions.has(args[1])) throw remoteError('E404');
      return JSON.stringify(versions.get(args[1]));
    }
    if (args[0] === 'publish') {
      const item = release.packages.find((item) => item.filename === basename(args[1]));
      if (!item) throw new Error('Unrecognized archive');
      writes.push({ name: item.name, args });
      versions.set(`${item.name}@${item.version}`, item.integrity);
      return '{}';
    }
    throw new Error(`Unexpected registry command: ${args[0]}`);
  };
  return { run, writes, versions };
};
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'simfinity-publish-test-'));
  writeReleaseFixture(root);
  setReleaseVersion(root, '3.2.0');
  manifest = packRelease(root, join(root, 'archives'), { commit: 'b'.repeat(40) });
  manifestPath = join(root, 'archives/manifest.json');
}, 30000);
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe('manual workspace publication', () => {
  it('defaults to a local-only dry run with zero registry commands', () => {
    const before = readFileSync(manifestPath);
    const result = publishRelease(manifestPath, { registry: 'npm', run: () => { throw new Error('Network must not be called'); } });
    expect(result.dryRun).toBe(true);
    expect(result.registry).toBe('https://registry.npmjs.org/');
    expect(result.packages.map((item) => item.action)).toEqual(['validated', 'validated', 'validated', 'validated']);
    expect(readFileSync(manifestPath)).toEqual(before);
  });

  it('runs the actual CLI safely in default and explicit dry modes and enforces the validated commit', () => {
    const binaryDirectory = join(root, 'blocked-npm');
    mkdirSync(binaryDirectory);
    const npm = join(binaryDirectory, 'npm');
    writeFileSync(npm, '#!/bin/sh\nexit 93\n');
    chmodSync(npm, 0o755);
    const env = { ...process.env, PATH: `${binaryDirectory}${delimiter}${process.env.PATH}`, SIMFINITY_RELEASE_COMMIT: manifest.commit };
    const script = fileURLToPath(new URL('../scripts/publish-packages.js', import.meta.url));
    const args = [script, manifestPath, '--registry', 'npm'];
    for (const flags of [[], ['--dry-run']]) {
      const output = execFileSync(process.execPath, [...args, ...flags], { env, encoding: 'utf8' });
      expect(JSON.parse(output).dryRun).toBe(true);
    }
    expect(() => execFileSync(process.execPath, [...args, '--execute'], { env: { ...env, SIMFINITY_RELEASE_COMMIT: 'c'.repeat(40) }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).toThrow(/commit/i);
  });

  it('publishes verified archives in dependency order using the stable distribution tag', () => {
    const remote = registry();
    const result = publishRelease(manifestPath, { registry: 'npm', dryRun: false, run: remote.run });
    expect(result.dryRun).toBe(false);
    expect(result.packages.map((item) => item.action)).toEqual(['published', 'published', 'published', 'published']);
    expect(remote.writes.map((item) => item.name)).toEqual(['@simtlix/simfinity-core', '@simtlix/simfinity-mcp', '@simtlix/simfinity-postgres', '@simtlix/simfinity-js']);
    for (const { args } of remote.writes) {
      expect(args.slice(2)).toEqual(['--access', 'public', '--tag', 'latest', '--ignore-scripts', '--registry', 'https://registry.npmjs.org/']);
    }
  });

  it('routes prerelease archives to next without changing the requested registry', () => {
    const source = join(root, 'prerelease');
    writeReleaseFixture(source);
    setReleaseVersion(source, '3.3.0-rc.1');
    const release = packRelease(source, join(source, 'archives'), { commit: 'b'.repeat(40) });
    const remote = registry(new Map(), release);
    const result = publishRelease(join(source, 'archives/manifest.json'), { registry: 'npm', dryRun: false, run: remote.run });
    expect(result.distTag).toBe('next');
    for (const { args } of remote.writes) expect(args[5]).toBe('next');
  }, 30000);

  it('rejects an artifact from a different validated source commit before registry access', () => {
    expect(() => publishRelease(manifestPath, { registry: 'npm', dryRun: false, expectedCommit: 'a'.repeat(40), run: () => { throw new Error('Network must not be called'); } })).toThrow(/commit/i);
  });

  it('skips an already published package only when its integrity matches the actual archive', () => {
    const core = manifest.packages[0];
    const remote = registry(new Map([[`${core.name}@${core.version}`, core.integrity]]));
    const result = publishRelease(manifestPath, { registry: 'github', dryRun: false, run: remote.run });
    expect(result.packages[0].action).toBe('skipped');
    expect(remote.writes.map((item) => item.name)).toEqual(['@simtlix/simfinity-mcp', '@simtlix/simfinity-postgres', '@simtlix/simfinity-js']);
    for (const { args } of remote.writes) expect(args.slice(-2)).toEqual(['--registry', 'https://npm.pkg.github.com/']);
    const second = publishRelease(manifestPath, { registry: 'github', dryRun: false, run: remote.run });
    expect(second.packages.map((item) => item.action)).toEqual(['skipped', 'skipped', 'skipped', 'skipped']);
    expect(remote.writes).toHaveLength(3);
  });

  it.each(['sha512-different', undefined, {}])('rejects conflicting or missing registry integrity %j before publishing any earlier package', (integrity) => {
    const last = manifest.packages[3];
    const remote = registry(new Map([[`${last.name}@${last.version}`, integrity]]));
    expect(() => publishRelease(manifestPath, { registry: 'npm', dryRun: false, run: remote.run })).toThrow(/integrity/i);
    expect(remote.writes).toEqual([]);
  });

  it.each(['E401', 'E403', 'ETIMEDOUT'])('does not treat registry failure %s as an absent version', (code) => {
    const calls = [];
    const run = (command, args) => { calls.push(args[0]); throw remoteError(code); };
    expect(() => publishRelease(manifestPath, { registry: 'npm', dryRun: false, run })).toThrow(/registry|inspect/i);
    expect(calls).toEqual(['view']);
  });

  it('stops after an uncertain publish failure and never automatically republishes the archive', () => {
    const calls = [];
    const run = (command, args) => {
      calls.push(args[0]);
      if (args[0] === 'view') throw remoteError('E404');
      throw remoteError('ETIMEDOUT');
    };
    expect(() => publishRelease(manifestPath, { registry: 'npm', dryRun: false, run })).toThrow(/publish|Registry/i);
    expect(calls).toEqual(['view', 'view', 'view', 'view', 'publish']);
  });

  it('rejects an unconfigured registry without a network request', () => {
    expect(() => publishRelease(manifestPath, { registry: 'https://example.com', dryRun: false, run: () => { throw new Error('Network must not be called'); } })).toThrow(/registry/i);
  });
});
