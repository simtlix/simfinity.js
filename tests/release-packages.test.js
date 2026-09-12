import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeReleaseFixture } from './helpers/release-fixture.js';
import { packRelease, readRelease, readReleaseManifest, setReleaseVersion } from '../scripts/release-packages.js';

const roots = [];
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'simfinity-release-test-'));
  roots.push(root);
  return writeReleaseFixture(root);
};
afterEach(() => { vi.restoreAllMocks(); syncBuiltinESMExports(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('workspace release preparation', () => {
  it('updates every internal package and v2 lock dependency together without changing external resolutions', () => {
    const root = fixture();
    setReleaseVersion(root, '3.2.0');
    const release = readRelease(root);
    expect(release.version).toBe('3.2.0');
    expect(release.packages.map((item) => item.name)).toEqual(['@simtlix/simfinity-core', '@simtlix/simfinity-mcp', '@simtlix/simfinity-postgres', '@simtlix/simfinity-js']);
    for (const item of release.packages) expect(json(join(root, item.directory, 'package.json')).version).toBe('3.2.0');
    const lock = json(join(root, 'package-lock.json'));
    expect(lock.version).toBe('3.2.0');
    expect(lock.packages['packages/postgres'].dependencies).toEqual({ '@simtlix/simfinity-core': '3.2.0', pg: '^8.16.3' });
    expect(lock.dependencies['@simtlix/simfinity-mcp']).toEqual({ version: 'file:packages/mcp', requires: { '@simtlix/simfinity-core': '3.2.0' } });
    expect(lock.packages['node_modules/pg']).toEqual({ version: '8.16.3', integrity: 'preserve-external-entry' });
    expect(readFileSync(join(root, 'package.json'), 'utf8').replaceAll('\r\n', '')).not.toContain('\n');
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

  it('packs all four actual archives in install order, skips lifecycle scripts, and verifies provenance and integrity', () => {
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
    expect(readReleaseManifest(join(destination, 'manifest.json'))).toEqual(manifest);
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

  it('rejects a new internal dependency that would publish a consumer before its dependency', () => {
    const root = fixture();
    const path = join(root, 'packages/core/package.json');
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
    const packages = ['core', 'mcp', 'postgres', 'js'].map((name) => ({ name: `@simtlix/simfinity-${name}`, version: '3.2.0', filename: 'safe.tgz' }));
    packages[0].filename = '../secret.tgz';
    writeFileSync(path, JSON.stringify({ version: '3.2.0', commit: 'a'.repeat(40), packages }));
    expect(() => readReleaseManifest(path)).toThrow(/filename|manifest/i);
  });
});
