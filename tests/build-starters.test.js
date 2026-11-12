import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { assertStarters, starterChanges, writeStarters } from '../scripts/build-starters.js';
import { readRelease, setReleaseVersion } from '../scripts/release-packages.js';
import { writeReleaseFixture, writeStarterFixture } from './helpers/release-fixture.js';

const repository = fileURLToPath(new URL('../', import.meta.url));
const roots = [];
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'simfinity-starters-test-'));
  roots.push(root);
  return writeStarterFixture(writeReleaseFixture(root));
};
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const archive = (root, version) => join(root, `docs/public/releases/simfinity-${version}-starters.zip`);

// Reads the central directory of an archive whose entries are stored without compression.
const entries = (bytes) => {
  const end = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const result = {};
  let offset = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < bytes.readUInt16LE(end + 10); index++) {
    expect(bytes.readUInt32LE(offset)).toBe(0x02014b50);
    const size = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
    const local = bytes.readUInt32LE(offset + 42);
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
    result[name] = { text: bytes.toString('utf8', start, start + size), method: bytes.readUInt16LE(offset + 10), mode: bytes.readUInt32LE(offset + 38) >>> 16 };
    offset += 46 + nameLength + bytes.readUInt16LE(offset + 30) + bytes.readUInt16LE(offset + 32);
  }
  return result;
};

describe('downloadable starters', () => {
  it('builds one archive with both applications pinned to the release', () => {
    const root = fixture();
    writeStarters(root, '3.2.0');
    const files = entries(readFileSync(archive(root, '3.2.0')));
    expect(Object.keys(files)).toEqual([
      'simfinity-3.2.0-starters/README.md',
      'simfinity-3.2.0-starters/mongodb/mcp.js',
      'simfinity-3.2.0-starters/mongodb/package.json',
      'simfinity-3.2.0-starters/mongodb/schema.js',
      'simfinity-3.2.0-starters/mongodb/server.js',
      'simfinity-3.2.0-starters/postgres/package.json',
      'simfinity-3.2.0-starters/postgres/server.js',
    ]);
    expect(files['simfinity-3.2.0-starters/README.md'].text).toBe('# Simfinity 3.2.0 starters\n\nRelease: https://example.test/releases/tag/v3.2.0\n');
    expect(JSON.parse(files['simfinity-3.2.0-starters/mongodb/package.json'].text).dependencies).toEqual({ '@simtlix/simfinity-core': '3.2.0', '@simtlix/simfinity-js': '3.2.0', graphql: '^16.11.0' });
    expect(JSON.parse(files['simfinity-3.2.0-starters/postgres/package.json'].text).dependencies).toEqual({ '@simtlix/simfinity-postgres': '3.2.0', '@simtlix/simfinity-sql': '3.2.0', pg: '^8.16.3' });
    expect(files['simfinity-3.2.0-starters/postgres/server.js'].text).toBe('export const file = \'postgresql-server.js\';\n');
    expect(Object.values(files).every(({ method, mode }) => method === 0 && mode === 0o100644)).toBe(true);
  });

  it('pins the source manifests and keeps the README a template', () => {
    const root = fixture();
    writeStarters(root, '3.2.0');
    expect(json(join(root, 'docs/starters/package.mongodb.json')).dependencies['@simtlix/simfinity-js']).toBe('3.2.0');
    expect(json(join(root, 'docs/starters/package.postgres.json')).dependencies.pg).toBe('^8.16.3');
    expect(readFileSync(join(root, 'docs/starters/README.md'), 'utf8')).toContain('{{version}}');
  });

  it('writes the checksum that shasum verifies', () => {
    const root = fixture();
    writeStarters(root, '3.2.0');
    const digest = createHash('sha256').update(readFileSync(archive(root, '3.2.0'))).digest('hex');
    expect(readFileSync(`${archive(root, '3.2.0')}.sha256.txt`, 'utf8')).toBe(`${digest}  simfinity-3.2.0-starters.zip\n`);
  });

  it('builds the same bytes again, also from a CRLF checkout', () => {
    const root = fixture();
    const first = starterChanges(root, '3.2.0').get(archive(root, '3.2.0'));
    for (const path of ['docs/starters/README.md', 'docs/starters/package.mongodb.json', 'docs/public/starter/schema.js', 'docs/examples/postgresql-server.js']) {
      writeFileSync(join(root, path), readFileSync(join(root, path), 'utf8').replaceAll('\n', '\r\n'));
    }
    expect(starterChanges(root, '3.2.0').get(archive(root, '3.2.0')).equals(first)).toBe(true);
  });

  it('accepts built starters and names what differs otherwise', () => {
    const root = fixture();
    expect(() => assertStarters(root, '3.2.0')).toThrow(/starters differ from release 3\.2\.0: docs\/starters\/package\.mongodb\.json/);
    writeStarters(root, '3.2.0');
    expect(() => assertStarters(root, '3.2.0')).not.toThrow();
    writeFileSync(join(root, 'docs/public/starter/server.js'), 'export const changed = true;\n');
    expect(() => assertStarters(root, '3.2.0')).toThrow(/starters differ from release 3\.2\.0: docs\/public\/releases\/simfinity-3\.2\.0-starters\.zip/);
    writeStarters(root, '3.2.0');
    rmSync(`${archive(root, '3.2.0')}.sha256.txt`);
    expect(() => assertStarters(root, '3.2.0')).toThrow(/simfinity-3\.2\.0-starters\.zip\.sha256\.txt/);
    expect(() => assertStarters(root, '3.2.1')).toThrow(/release 3\.2\.1/);
  });

  it('refuses a README without the version placeholder or a manifest without Simfinity packages', () => {
    const root = fixture();
    writeFileSync(join(root, 'docs/starters/README.md'), '# Simfinity 3.2.0 starters\n');
    expect(() => starterChanges(root, '3.2.0')).toThrow(/\{\{version\}\}/);
    const other = fixture();
    writeFileSync(join(other, 'docs/starters/package.postgres.json'), '{ "dependencies": { "pg": "^8.16.3" } }\n');
    expect(() => starterChanges(other, '3.2.0')).toThrow(/package\.postgres\.json/);
  });
});

describe('release preparation with starters', () => {
  it('rebuilds the starters with the version and validates them with the release', () => {
    const root = fixture();
    setReleaseVersion(root, '3.2.0');
    expect(existsSync(archive(root, '3.2.0'))).toBe(true);
    expect(json(join(root, 'docs/starters/package.postgres.json')).dependencies['@simtlix/simfinity-sql']).toBe('3.2.0');
    expect(readRelease(root).version).toBe('3.2.0');
    const pinned = join(root, 'docs/starters/package.mongodb.json');
    writeFileSync(pinned, readFileSync(pinned, 'utf8').replaceAll('3.2.0', '3.1.9'));
    expect(() => readRelease(root)).toThrow(/starters differ from release 3\.2\.0/);
  });

  it('keeps earlier archives and adds the next one', () => {
    const root = fixture();
    setReleaseVersion(root, '3.2.0');
    setReleaseVersion(root, '3.2.1');
    expect(existsSync(archive(root, '3.2.0'))).toBe(true);
    expect(existsSync(`${archive(root, '3.2.1')}.sha256.txt`)).toBe(true);
    expect(readRelease(root).version).toBe('3.2.1');
  });

  it('restores the starters when the release is refused', () => {
    const root = fixture();
    const core = join(root, 'packages/core/package.json');
    writeFileSync(core, JSON.stringify({ ...json(core), dependencies: { '@simtlix/simfinity-sql': '0.1.0' } }, null, 2));
    const before = readFileSync(join(root, 'docs/starters/package.mongodb.json'), 'utf8');
    expect(() => setReleaseVersion(root, '3.2.0')).toThrow();
    expect(readFileSync(join(root, 'docs/starters/package.mongodb.json'), 'utf8')).toBe(before);
    expect(existsSync(archive(root, '3.2.0'))).toBe(false);
    expect(existsSync(`${archive(root, '3.2.0')}.sha256.txt`)).toBe(false);
  });

  it('keeps this repository\'s starters aligned with its version', () => {
    expect(() => assertStarters(repository, json(join(repository, 'package.json')).version)).not.toThrow();
  });
});
