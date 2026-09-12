import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { packRelease, readRelease, readReleaseManifest, setReleaseVersion } from '../scripts/release-packages.js';

const roots = [];
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'simfinity-release-test-'));
  roots.push(root);
  const items = [
    ['', '@simtlix/simfinity-js', { '@simtlix/simfinity-core': '0.1.0', '@simtlix/simfinity-mcp': '0.1.0' }],
    ['packages/core', '@simtlix/simfinity-core', {}],
    ['packages/mcp', '@simtlix/simfinity-mcp', { '@simtlix/simfinity-core': '0.1.0' }],
    ['packages/postgres', '@simtlix/simfinity-postgres', { '@simtlix/simfinity-core': '0.1.0', pg: '^8.16.3' }],
  ];
  const lock = { name: items[0][1], version: '3.1.0', lockfileVersion: 2, packages: {}, dependencies: {} };
  for (const [directory, name, dependencies] of items) {
    const version = directory ? '0.1.0' : '3.1.0';
    mkdirSync(join(root, directory, 'src'), { recursive: true });
    const manifest = { name, version, type: 'module', files: ['src'], main: 'src/index.js', dependencies, peerDependencies: { graphql: '^16.11.0' }, scripts: { prepack: 'exit 97' } };
    writeFileSync(join(root, directory, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`.replaceAll('\n', '\r\n'));
    writeFileSync(join(root, directory, 'src/index.js'), 'export const value = 42;\n');
    lock.packages[directory] = structuredClone(manifest);
    if (directory) {
      lock.packages[`node_modules/${name}`] = { resolved: directory, link: true };
      lock.dependencies[name] = { version: `file:${directory}`, requires: { ...dependencies } };
    }
  }
  lock.packages['node_modules/pg'] = { version: '8.16.3', integrity: 'preserve-external-entry' };
  writeFileSync(join(root, 'package-lock.json'), `${JSON.stringify(lock, null, 2)}\n`.replaceAll('\n', '\r\n'));
  return root;
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

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
    writeFileSync(join(destination, manifest.packages[0].filename), 'tampered');
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

  it('rejects manifest paths escaping the artifact directory before reading files', () => {
    const root = fixture();
    const path = join(root, 'manifest.json');
    const packages = ['core', 'mcp', 'postgres', 'js'].map((name) => ({ name: `@simtlix/simfinity-${name}`, version: '3.2.0', filename: 'safe.tgz' }));
    packages[0].filename = '../secret.tgz';
    writeFileSync(path, JSON.stringify({ version: '3.2.0', commit: 'a'.repeat(40), packages }));
    expect(() => readReleaseManifest(path)).toThrow(/filename|manifest/i);
  });
});
