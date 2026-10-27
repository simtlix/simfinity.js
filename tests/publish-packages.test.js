import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeReleaseFixture } from './helpers/release-fixture.js';
import { packRelease, setReleaseVersion } from '../scripts/release-packages.js';
import { publishRelease } from '../scripts/publish-packages.js';

// Git fixtures and spawned CLIs can exceed the default 5 s while the full suite loads the machine.
vi.setConfig({ testTimeout: 30000 });

let root; let manifest; let manifestPath;
const manifestDigest = () => createHash('sha256').update(readFileSync(manifestPath)).digest('hex');
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
    expect(result.packages.map((item) => item.action)).toEqual(['validated', 'validated', 'validated', 'validated', 'validated', 'validated']);
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
    const wrongCommit = { ...env, SIMFINITY_RELEASE_COMMIT: 'c'.repeat(40), SIMFINITY_RELEASE_MANIFEST_SHA256: manifestDigest() };
    expect(() => execFileSync(process.execPath, [...args, '--execute'], { env: wrongCommit, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).toThrow(/commit/i);
  });

  it('rejects a manifest that differs from the digest the packing job recorded before registry access (#28)', () => {
    const digest = manifestDigest();
    const offline = () => { throw new Error('Network must not be called'); };
    expect(publishRelease(manifestPath, { registry: 'npm', expectedManifestSha256: digest, run: offline }).dryRun).toBe(true);
    for (const wrong of ['0'.repeat(64), '', digest.toUpperCase(), digest.slice(1), 42]) {
      for (const dryRun of [true, false]) {
        expect(() => publishRelease(manifestPath, { registry: 'npm', dryRun, expectedManifestSha256: wrong, run: offline })).toThrow('Release manifest differs from the packed manifest digest');
      }
    }
  });

  it('publishes from the CLI only with the packed manifest digest and the validated commit (#28)', () => {
    const binaryDirectory = join(root, 'logging-npm');
    const log = join(root, 'logging-npm.log');
    mkdirSync(binaryDirectory);
    writeFileSync(join(binaryDirectory, 'npm'), '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$SIMFINITY_NPM_LOG"\nexit 93\n');
    chmodSync(join(binaryDirectory, 'npm'), 0o755);
    const script = fileURLToPath(new URL('../scripts/publish-packages.js', import.meta.url));
    const inherited = { ...process.env };
    delete inherited.SIMFINITY_RELEASE_COMMIT;
    delete inherited.SIMFINITY_RELEASE_MANIFEST_SHA256;
    const cli = (execution, variables) => {
      rmSync(log, { force: true });
      const result = spawnSync(process.execPath, [script, manifestPath, '--registry', 'npm', execution], {
        env: { ...inherited, PATH: `${binaryDirectory}${delimiter}${process.env.PATH}`, SIMFINITY_NPM_LOG: log, ...variables },
        encoding: 'utf8',
      });
      return { status: result.status, stderr: result.stderr, npm: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] };
    };
    const commit = { SIMFINITY_RELEASE_COMMIT: manifest.commit };
    const digest = { SIMFINITY_RELEASE_MANIFEST_SHA256: manifestDigest() };
    const refused = (message) => ({ status: 1, stderr: `${message}\n`, npm: [] });
    expect(cli('--execute', commit)).toEqual(refused('Publishing requires SIMFINITY_RELEASE_MANIFEST_SHA256, the packed manifest digest'));
    expect(cli('--execute', { ...commit, SIMFINITY_RELEASE_MANIFEST_SHA256: '' })).toEqual(refused('Publishing requires SIMFINITY_RELEASE_MANIFEST_SHA256, the packed manifest digest'));
    expect(cli('--execute', digest)).toEqual(refused('Publishing requires SIMFINITY_RELEASE_COMMIT, the validated source commit'));
    expect(cli('--execute', { ...digest, SIMFINITY_RELEASE_COMMIT: '' })).toEqual(refused('Publishing requires SIMFINITY_RELEASE_COMMIT, the validated source commit'));
    expect(cli('--execute', { ...commit, SIMFINITY_RELEASE_MANIFEST_SHA256: 'f'.repeat(64) })).toEqual(refused('Release manifest differs from the packed manifest digest'));
    // With both, the CLI reaches the registry, here a stub that fails the first lookup.
    const published = cli('--execute', { ...commit, ...digest });
    expect(published.status).toBe(1);
    expect(published.npm).toEqual([`view ${manifest.packages[0].name}@${manifest.version} dist.integrity --json --registry https://registry.npmjs.org/`]);
    // Dry runs stay local and keep both variables optional, but check them when given.
    for (const variables of [{}, digest, { ...commit, ...digest }]) {
      expect(cli('--dry-run', variables)).toMatchObject({ status: 0, stderr: '', npm: [] });
    }
    expect(cli('--dry-run', { SIMFINITY_RELEASE_MANIFEST_SHA256: '0'.repeat(64) })).toEqual(refused('Release manifest differs from the packed manifest digest'));
  });

  it('publishes verified archives in dependency order using the stable distribution tag', () => {
    const remote = registry();
    const result = publishRelease(manifestPath, { registry: 'npm', dryRun: false, run: remote.run });
    expect(result.dryRun).toBe(false);
    expect(result.packages.map((item) => item.action)).toEqual(['published', 'published', 'published', 'published', 'published', 'published']);
    expect(remote.writes.map((item) => item.name)).toEqual(['@simtlix/simfinity-core', '@simtlix/simfinity-sql', '@simtlix/simfinity-mcp', '@simtlix/simfinity-descriptor', '@simtlix/simfinity-postgres', '@simtlix/simfinity-js']);
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
    expect(remote.writes.map((item) => item.name)).toEqual(['@simtlix/simfinity-sql', '@simtlix/simfinity-mcp', '@simtlix/simfinity-descriptor', '@simtlix/simfinity-postgres', '@simtlix/simfinity-js']);
    for (const { args } of remote.writes) expect(args.slice(-2)).toEqual(['--registry', 'https://npm.pkg.github.com/']);
    const second = publishRelease(manifestPath, { registry: 'github', dryRun: false, run: remote.run });
    expect(second.packages.map((item) => item.action)).toEqual(['skipped', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
    expect(remote.writes).toHaveLength(5);
  });

  it.each(['sha512-different', undefined, {}])('rejects conflicting or missing registry integrity %j before publishing any earlier package', (integrity) => {
    const last = manifest.packages.at(-1);
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
    expect(calls).toEqual(['view', 'view', 'view', 'view', 'view', 'view', 'publish']);
  });

  it('rejects an unconfigured registry without a network request', () => {
    expect(() => publishRelease(manifestPath, { registry: 'https://example.com', dryRun: false, run: () => { throw new Error('Network must not be called'); } })).toThrow(/registry/i);
  });
});
