import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeReleaseFixture } from './helpers/release-fixture.js';
import { packRelease, readRelease, readReleaseManifest, releaseAssets, setReleaseVersion } from '../scripts/release-packages.js';

const roots = [];
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'simfinity-release-test-'));
  roots.push(root);
  return writeReleaseFixture(root);
};
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
// A committed release fixture whose core package also matches an ignored and an untracked file.
const committedFixture = () => {
  const root = fixture();
  setReleaseVersion(root, '3.2.0');
  writeFileSync(join(root, '.gitignore'), '**/config.js\nscripts/\n');
  git(root, 'init', '-q');
  git(root, 'add', '.');
  git(root, '-c', 'user.name=Release Test', '-c', 'user.email=release@example.test', 'commit', '-qm', 'fixture');
  writeFileSync(join(root, 'packages/core/src/config.js'), 'export const secret = 1;\n');
  writeFileSync(join(root, 'packages/sql/src/scratch.js'), 'export const draft = 1;\n');
  return root;
};
const sha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('workspace release preparation', () => {
  it('keeps the descriptor generator version aligned and rejects drift', () => {
    const root = fixture();
    const info = join(root, 'packages/core/src/package-info.js');
    copyFileSync(new URL('../packages/core/src/package-info.js', import.meta.url), info);
    setReleaseVersion(root, '3.2.0');
    expect(readFileSync(info, 'utf8')).toContain('version: \'3.2.0\'');
    writeFileSync(info, readFileSync(info, 'utf8').replace('3.2.0', '3.1.0'));
    expect(() => readRelease(root)).toThrow(/descriptor generator/);
  });

  it('updates every internal package and v2 lock dependency together without changing external resolutions', () => {
    const root = fixture();
    setReleaseVersion(root, '3.2.0');
    const release = readRelease(root);
    expect(release.version).toBe('3.2.0');
    expect(release.packages.map((item) => item.name)).toEqual(['@simtlix/simfinity-core', '@simtlix/simfinity-sql', '@simtlix/simfinity-mcp', '@simtlix/simfinity-postgres', '@simtlix/simfinity-js']);
    for (const item of release.packages) expect(json(join(root, item.directory, 'package.json')).version).toBe('3.2.0');
    const lock = json(join(root, 'package-lock.json'));
    expect(lock.version).toBe('3.2.0');
    expect(lock.packages['packages/postgres'].dependencies).toEqual({ '@simtlix/simfinity-core': '3.2.0', '@simtlix/simfinity-sql': '3.2.0', pg: '^8.16.3' });
    expect(lock.dependencies['@simtlix/simfinity-mcp']).toEqual({ version: 'file:packages/mcp', requires: { '@simtlix/simfinity-core': '3.2.0' } });
    expect(lock.packages['node_modules/pg']).toEqual({ version: '8.16.3', integrity: 'preserve-external-entry' });
    expect(json(join(root, 'package.json')).private).toBe(true);
    expect(lock.packages[''].version).toBe('3.2.0');
    expect(release.packages.map((item) => item.directory)).toEqual(['packages/core', 'packages/sql', 'packages/mcp', 'packages/postgres', 'packages/mongodb']);
    expect(readFileSync(join(root, 'package.json'), 'utf8').replaceAll('\r\n', '')).not.toContain('\n');
  });

  it('rejects a publishable repository root before writing release versions', () => {
    const root = fixture();
    const path = join(root, 'package.json');
    const manifest = json(path);
    manifest.private = false;
    writeFileSync(path, JSON.stringify(manifest));
    expect(() => setReleaseVersion(root, '3.2.0')).toThrow(/private/i);
    expect(json(path).version).toBe('3.1.0');
    expect(json(join(root, 'packages/mongodb/package.json')).version).toBe('0.1.0');
  });

  it('prepares releases without documentation dependencies or lockfiles', () => {
    const root = fixture();
    expect(() => setReleaseVersion(root, '3.2.0')).not.toThrow();
    expect(readRelease(root).packages).toHaveLength(5);
  });

  it.each(['../3.2.0', '3.2', 'v3.2.0', '03.2.0', '3.2.0-01', '3.2.0\n', '3.2.0\r'])('rejects unsafe or invalid release version %j before writing files', (version) => {
    const root = fixture();
    const before = readFileSync(join(root, 'package.json'));
    expect(() => setReleaseVersion(root, version)).toThrow(/version/i);
    expect(readFileSync(join(root, 'package.json'))).toEqual(before);
  });

  it('validates lockfile package entries before any version writes', () => {
    const root = fixture();
    const lock = json(join(root, 'package-lock.json'));
    delete lock.packages['packages/mcp'];
    writeFileSync(join(root, 'package-lock.json'), JSON.stringify(lock));
    const before = readFileSync(join(root, 'package.json'));
    expect(() => setReleaseVersion(root, '3.2.0')).toThrow(/lockfile/i);
    expect(readFileSync(join(root, 'package.json'))).toEqual(before);
  });

  it('rejects a v2 lock with missing legacy workspace metadata before writing any versions', () => {
    const root = fixture();
    const path = join(root, 'package-lock.json');
    const lock = json(path);
    delete lock.dependencies['@simtlix/simfinity-mcp'];
    writeFileSync(path, JSON.stringify(lock));
    const before = readFileSync(join(root, 'package.json'));
    expect(() => setReleaseVersion(root, '3.2.0')).toThrow(/lockfile/i);
    expect(readFileSync(join(root, 'package.json'))).toEqual(before);
  });

  it('detects and repairs an omitted internal v2 requires edge', () => {
    const root = fixture();
    setReleaseVersion(root, '3.2.0');
    const path = join(root, 'package-lock.json');
    const lock = json(path);
    delete lock.dependencies['@simtlix/simfinity-mcp'].requires['@simtlix/simfinity-core'];
    writeFileSync(path, JSON.stringify(lock));
    expect(() => readRelease(root)).toThrow(/lockfile/i);
    setReleaseVersion(root, '3.2.1');
    expect(json(path).dependencies['@simtlix/simfinity-mcp'].requires).toEqual({ '@simtlix/simfinity-core': '3.2.1' });
  });

  it('updates and validates v3 locks without adding a legacy dependencies section', () => {
    const root = fixture();
    const path = join(root, 'package-lock.json');
    const lock = json(path);
    lock.lockfileVersion = 3;
    delete lock.dependencies;
    writeFileSync(path, JSON.stringify(lock));
    setReleaseVersion(root, '3.2.0');
    expect(readRelease(root).version).toBe('3.2.0');
    expect(json(path).dependencies).toBeUndefined();
    expect(json(path).packages['packages/mcp'].dependencies).toEqual({ '@simtlix/simfinity-core': '3.2.0' });
  });

  it('rejects drifting manifests and exact internal dependency versions before packing', () => {
    const root = fixture();
    setReleaseVersion(root, '3.2.0');
    const path = join(root, 'packages/postgres/package.json');
    const manifest = json(path);
    manifest.dependencies['@simtlix/simfinity-core'] = '^3.2.0';
    writeFileSync(path, JSON.stringify(manifest));
    expect(() => readRelease(root)).toThrow(/internal dependency/i);
    expect(() => packRelease(root, join(root, 'artifacts'), { commit: 'a'.repeat(40) })).toThrow(/internal dependency/i);
    expect(readdirSync(root)).not.toContain('artifacts');
  });

  it('packs all five actual archives in install order, skips lifecycle scripts, and verifies provenance and integrity', () => {
    const root = fixture();
    setReleaseVersion(root, '3.2.0-rc.1');
    const destination = join(root, 'artifacts');
    const manifest = packRelease(root, destination, { commit: 'a'.repeat(40) });
    expect(manifest.version).toBe('3.2.0-rc.1');
    expect(manifest.commit).toBe('a'.repeat(40));
    const seen = new Set();
    for (const item of manifest.packages) {
      const archive = join(destination, item.filename);
      const metadata = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }));
      expect(metadata.name).toBe(item.name);
      expect(metadata.version).toBe('3.2.0-rc.1');
      for (const name of Object.keys(metadata.dependencies || {}).filter((name) => name.startsWith('@simtlix/'))) expect(seen.has(name)).toBe(true);
      seen.add(item.name);
      expect(item.integrity).toBe(`sha512-${createHash('sha512').update(readFileSync(archive)).digest('base64')}`);
      expect(item.sha256).toBe(createHash('sha256').update(readFileSync(archive)).digest('hex'));
    }
    const manifestPath = join(destination, 'manifest.json');
    expect(readReleaseManifest(manifestPath)).toEqual(manifest);
    const incomplete = { ...manifest, packages: manifest.packages.filter((item) => item.name !== '@simtlix/simfinity-sql') };
    writeFileSync(manifestPath, JSON.stringify(incomplete));
    expect(() => readReleaseManifest(manifestPath)).toThrow(/package set/i);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const firstArchive = join(destination, manifest.packages[0].filename);
    const outside = join(root, 'outside.tgz');
    renameSync(firstArchive, outside);
    symlinkSync(outside, firstArchive);
    expect(() => readReleaseManifest(join(destination, 'manifest.json'))).toThrow(/symlink|regular file|containment/i);
    rmSync(firstArchive);
    renameSync(outside, firstArchive);
    writeFileSync(firstArchive, 'tampered');
    expect(() => readReleaseManifest(join(destination, 'manifest.json'))).toThrow(/integrity/i);
  }, 30000);

  it('verifies the manifest digest recorded by the packing job before reading archives (#28)', () => {
    const root = fixture();
    setReleaseVersion(root, '3.2.0');
    const manifest = packRelease(root, join(root, 'artifacts'), { commit: 'a'.repeat(40) });
    const path = join(root, 'artifacts/manifest.json');
    const digest = sha256(path);
    expect(readReleaseManifest(path, { sha256: digest })).toEqual(manifest);
    for (const wrong of ['0'.repeat(64), '', digest.toUpperCase(), ` ${digest}`, null, 42]) {
      expect(() => readReleaseManifest(path, { sha256: wrong })).toThrow('Release manifest differs from the packed manifest digest');
    }
    writeFileSync(path, `${JSON.stringify(manifest)}\n`);
    expect(() => readReleaseManifest(path, { sha256: digest })).toThrow('Release manifest differs from the packed manifest digest');
    expect(readReleaseManifest(path)).toEqual(manifest);
    expect(readReleaseManifest(path, {})).toEqual(manifest);
  }, 30000);

  it('lists only the verified manifest, its archives and the npm evidence as GitHub release assets (#28)', () => {
    const root = fixture();
    setReleaseVersion(root, '3.2.0');
    const manifest = packRelease(root, join(root, 'artifacts'), { commit: 'a'.repeat(40) });
    const path = join(root, 'artifacts/manifest.json');
    const digest = sha256(path);
    expect(() => releaseAssets(path, { sha256: digest })).toThrow('npm-verification.json must be a regular file next to the release manifest');
    writeFileSync(join(root, 'artifacts/npm-verification.json'), '{}\n');
    writeFileSync(join(root, 'artifacts/install.sh'), 'echo extra\n');
    expect(releaseAssets(path, { sha256: digest })).toEqual([
      path, ...manifest.packages.map((item) => join(root, 'artifacts', item.filename)), join(root, 'artifacts/npm-verification.json'),
    ]);
    expect(() => releaseAssets(path, { sha256: '0'.repeat(64) })).toThrow('Release manifest differs from the packed manifest digest');
  }, 30000);

  it('refuses to pack untracked or ignored files only when asked to (#28)', () => {
    const root = committedFixture();
    const destination = join(root, 'tracked');
    expect(() => packRelease(root, destination, { requireTracked: true })).toThrow('Release archive for @simtlix/simfinity-core would include files git does not track: src/config.js');
    expect(existsSync(destination)).toBe(false);
    rmSync(join(root, 'packages/core/src/config.js'));
    expect(() => packRelease(root, destination, { requireTracked: true })).toThrow('Release archive for @simtlix/simfinity-sql would include files git does not track: src/scratch.js');
    expect(existsSync(destination)).toBe(false);
    writeFileSync(join(root, 'packages/core/src/config.js'), 'export const secret = 1;\n');
    // Without the option (test:packages on a working tree), the files on disk are packed.
    const loose = packRelease(root, join(root, 'loose'));
    expect(loose.commit).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(execFileSync('tar', ['-tzf', join(root, 'loose', loose.packages[0].filename)], { encoding: 'utf8' })).toContain('package/src/config.js');
    rmSync(join(root, 'packages/core/src/config.js'));
    rmSync(join(root, 'packages/sql/src/scratch.js'));
    const tracked = packRelease(root, destination, { requireTracked: true });
    expect(execFileSync('tar', ['-tzf', join(destination, tracked.packages[0].filename)], { encoding: 'utf8' })).not.toContain('config.js');
    expect(tracked.packages.slice(2)).toEqual(loose.packages.slice(2));
    // Outside a git checkout the check cannot list tracked files and fails closed.
    const plain = fixture();
    setReleaseVersion(plain, '3.2.0');
    expect(() => packRelease(plain, join(plain, 'artifacts'), { commit: 'a'.repeat(40), requireTracked: true })).toThrow(/git/);
    expect(existsSync(join(plain, 'artifacts'))).toBe(false);
  }, 30000);

  it('runs the pack CLI with the tracked-file check and the verify CLI with the manifest digest (#28)', () => {
    const root = committedFixture();
    mkdirSync(join(root, 'scripts'));
    for (const file of ['release-packages.js', 'cli.js']) copyFileSync(fileURLToPath(new URL(`../scripts/${file}`, import.meta.url)), join(root, 'scripts', file));
    writeFileSync(join(root, 'scripts/package.json'), '{ "type": "module" }\n');
    const script = join(root, 'scripts/release-packages.js');
    const inherited = { ...process.env };
    delete inherited.SIMFINITY_RELEASE_MANIFEST_SHA256;
    const run = (args, env = {}) => spawnSync(process.execPath, [script, ...args], { cwd: root, env: { ...inherited, ...env }, encoding: 'utf8' });
    const cli = (args, env = {}) => {
      const result = run(args, env);
      return { status: result.status, stderr: result.stderr };
    };
    const destination = join(root, 'artifacts');
    expect(cli(['pack', destination])).toEqual({ status: 1, stderr: 'Release archive for @simtlix/simfinity-core would include files git does not track: src/config.js\n' });
    expect(existsSync(destination)).toBe(false);
    rmSync(join(root, 'packages/core/src/config.js'));
    rmSync(join(root, 'packages/sql/src/scratch.js'));
    expect(cli(['pack', destination])).toEqual({ status: 0, stderr: '' });
    const manifest = join(destination, 'manifest.json');
    expect(cli(['verify', manifest])).toEqual({ status: 0, stderr: '' });
    expect(cli(['verify', manifest], { SIMFINITY_RELEASE_MANIFEST_SHA256: sha256(manifest) })).toEqual({ status: 0, stderr: '' });
    for (const wrong of ['', 'f'.repeat(64)]) {
      expect(cli(['verify', manifest], { SIMFINITY_RELEASE_MANIFEST_SHA256: wrong })).toEqual({ status: 1, stderr: 'Release manifest differs from the packed manifest digest\n' });
    }

    // The GitHub release upload list: one path per line, only from a digest-checked manifest.
    const digest = { SIMFINITY_RELEASE_MANIFEST_SHA256: sha256(manifest) };
    for (const env of [{}, { SIMFINITY_RELEASE_MANIFEST_SHA256: '' }]) {
      expect(cli(['assets', manifest], env)).toEqual({ status: 1, stderr: 'Release assets require SIMFINITY_RELEASE_MANIFEST_SHA256, the packed manifest digest\n' });
    }
    expect(cli(['assets', manifest], digest)).toEqual({ status: 1, stderr: 'npm-verification.json must be a regular file next to the release manifest\n' });
    writeFileSync(join(destination, 'npm-verification.json'), '{}\n');
    writeFileSync(join(destination, 'install.sh'), 'echo extra\n');
    const listed = run(['assets', manifest], digest);
    expect({ status: listed.status, stderr: listed.stderr }).toEqual({ status: 0, stderr: '' });
    const archives = JSON.parse(readFileSync(manifest, 'utf8')).packages.map((item) => join(destination, item.filename));
    expect(listed.stdout).toBe(`${[manifest, ...archives, join(destination, 'npm-verification.json')].join('\n')}\n`);
    expect(cli(['assets', manifest], { SIMFINITY_RELEASE_MANIFEST_SHA256: 'f'.repeat(64) })).toEqual({ status: 1, stderr: 'Release manifest differs from the packed manifest digest\n' });
  }, 30000);

  it('names the package directory of a misplaced package manifest (#156)', () => {
    const root = fixture();
    const path = join(root, 'packages/mcp/package.json');
    writeFileSync(path, JSON.stringify({ ...json(path), name: '@simtlix/simfinity-other' }));
    expect(() => readRelease(root)).toThrow('Expected package @simtlix/simfinity-mcp in packages/mcp');
  });

  it.each(['0.0.9', '^3.2.0'])('reports a wrong v2 internal requires range %s at the manifest edge check (#156)', (range) => {
    const root = fixture();
    setReleaseVersion(root, '3.2.0');
    const path = join(root, 'package-lock.json');
    const lock = json(path);
    lock.dependencies['@simtlix/simfinity-postgres'].requires['@simtlix/simfinity-sql'] = range;
    writeFileSync(path, JSON.stringify(lock));
    expect(() => readRelease(root)).toThrow('Lockfile internal dependency is missing or differs for @simtlix/simfinity-postgres');
  });

  it.each(['core', 'sql'])('rejects a new internal dependency that would publish %s before its dependency', (consumer) => {
    const root = fixture();
    const path = join(root, `packages/${consumer}/package.json`);
    const manifest = json(path);
    manifest.dependencies['@simtlix/simfinity-postgres'] = '0.1.0';
    writeFileSync(path, JSON.stringify(manifest));
    expect(() => setReleaseVersion(root, '3.2.0')).toThrow(/publication order/i);
    expect(json(join(root, 'package.json')).version).toBe('3.1.0');
  });

  it('does not overwrite an existing artifact directory', () => {
    const root = fixture();
    setReleaseVersion(root, '3.2.0');
    const destination = join(root, 'artifacts');
    mkdirSync(destination);
    writeFileSync(join(destination, 'keep.txt'), 'user file');
    expect(() => packRelease(root, destination, { commit: 'a'.repeat(40) })).toThrow(/exist/i);
    expect(readFileSync(join(destination, 'keep.txt'), 'utf8')).toBe('user file');
  });

  it('preserves another process directory when it appears at the exclusive creation boundary', () => {
    const root = fixture();
    setReleaseVersion(root, '3.2.0');
    const destination = join(root, 'artifacts');
    const originalMkdir = fs.mkdirSync;
    let injected = false;
    vi.spyOn(fs, 'mkdirSync').mockImplementation((path, options) => {
      if (path === destination && !injected) {
        injected = true;
        originalMkdir(destination);
        writeFileSync(join(destination, 'keep.txt'), 'other process');
      }
      return originalMkdir(path, options);
    });
    syncBuiltinESMExports();
    expect(() => packRelease(root, destination, { commit: 'a'.repeat(40) })).toThrow(/exist/i);
    expect(readFileSync(join(destination, 'keep.txt'), 'utf8')).toBe('other process');
    expect(readdirSync(destination)).toEqual(['keep.txt']);
  });

  it('rejects manifest paths escaping the artifact directory before reading files', () => {
    const root = fixture();
    const path = join(root, 'manifest.json');
    const packages = ['core', 'sql', 'mcp', 'postgres', 'js'].map((name) => ({ name: `@simtlix/simfinity-${name}`, version: '3.2.0', filename: 'safe.tgz' }));
    packages[0].filename = '../secret.tgz';
    writeFileSync(path, JSON.stringify({ version: '3.2.0', commit: 'a'.repeat(40), packages }));
    expect(() => readReleaseManifest(path)).toThrow(/filename|manifest/i);
  });
});
