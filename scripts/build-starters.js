import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isEntryPoint } from './cli.js';

// Archive path -> source path. The applications ship the sources the quick starts render.
const applicationFiles = {
  'mongodb/schema.js': 'docs/public/starter/schema.js',
  'mongodb/server.js': 'docs/public/starter/server.js',
  'mongodb/mcp.js': 'docs/public/starter/mcp.js',
  'postgres/server.js': 'docs/examples/postgresql-server.js',
};
const backends = ['mongodb', 'postgres'];
const readme = 'docs/starters/README.md';
const placeholder = '{{version}}';
// A CRLF checkout must build the same archive as an LF one.
const text = (path) => readFileSync(path, 'utf8').replaceAll('\r\n', '\n');

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
const crc32 = (bytes) => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

/**
 * A ZIP whose entries are stored without compression, sorted, with one fixed timestamp
 * and mode 0644. Deflate output depends on the zlib build, so stored entries are what
 * makes the archive byte-identical on every machine and lets `assertStarters` compare it.
 */
const storedZip = (files) => {
  const date = ((2026 - 1980) << 9) | (9 << 5) | 12;
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, contents] of [...files].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!/^[\x20-\x7e]+$/.test(name)) throw new Error(`Starter archive names must be printable ASCII: ${name}`);
    const nameBytes = Buffer.from(name);
    const crc = crc32(contents);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(contents.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE((3 << 8) | 20, 4); // Made on Unix, so the mode below applies.
    header.writeUInt16LE(20, 6);
    header.writeUInt16LE(date, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(contents.length, 20);
    header.writeUInt32LE(contents.length, 24);
    header.writeUInt16LE(nameBytes.length, 28);
    header.writeUInt32LE((0o100644 << 16) >>> 0, 38);
    header.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, contents);
    central.push(header, nameBytes);
    offset += local.length + nameBytes.length + contents.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.size, 8);
  end.writeUInt16LE(files.size, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
};

/**
 * Every file the starters of `version` consist of, as absolute path -> contents: the two
 * source manifests with their Simfinity packages pinned to the release, the archive and
 * its SHA-256 file. Reads the sources and writes nothing.
 */
export const starterChanges = (root, version) => {
  const changes = new Map();
  const files = new Map();
  const template = text(join(root, readme));
  if (!template.includes(placeholder)) throw new Error(`${readme} must name the release as ${placeholder}`);
  files.set('README.md', Buffer.from(template.replaceAll(placeholder, version)));
  for (const backend of backends) {
    const source = `docs/starters/package.${backend}.json`;
    const manifest = JSON.parse(text(join(root, source)));
    const internal = Object.keys(manifest.dependencies || {}).filter((name) => name.startsWith('@simtlix/'));
    if (!internal.length) throw new Error(`${source} must depend on a Simfinity package`);
    for (const name of internal) manifest.dependencies[name] = version;
    const pinned = `${JSON.stringify(manifest, null, 2)}\n`;
    changes.set(join(root, source), pinned);
    files.set(`${backend}/package.json`, Buffer.from(pinned));
  }
  for (const [name, source] of Object.entries(applicationFiles)) files.set(name, Buffer.from(text(join(root, source))));
  const prefix = `simfinity-${version}-starters`;
  const archive = storedZip(new Map([...files].map(([name, contents]) => [`${prefix}/${name}`, contents])));
  const output = join(root, 'docs/public/releases', `${prefix}.zip`);
  changes.set(output, archive);
  changes.set(`${output}.sha256.txt`, `${createHash('sha256').update(archive).digest('hex')}  ${prefix}.zip\n`);
  return changes;
};

/** Fails unless the committed starters are exactly what `writeStarters` produces for `version`. */
export const assertStarters = (root, version) => {
  for (const [path, expected] of starterChanges(root, version)) {
    const matches = existsSync(path) && (typeof expected === 'string' ? text(path) === expected : readFileSync(path).equals(expected));
    if (!matches) {
      const relative = path.slice(root.length).replace(/^[\\/]/, '').replaceAll('\\', '/');
      throw new Error(`Downloadable starters differ from release ${version}: ${relative}. Rebuild them with "node scripts/build-starters.js" and commit the result`);
    }
  }
};

/** Pins the starter manifests to `version` and writes its archive and checksum. */
export const writeStarters = (root, version) => {
  const changes = starterChanges(root, version);
  for (const [path, contents] of changes) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  return [...changes.keys()];
};

if (isEntryPoint(import.meta.url)) {
  try {
    const root = fileURLToPath(new URL('../', import.meta.url));
    const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const [flag, ...extra] = process.argv.slice(2);
    if (extra.length || ![undefined, '--check'].includes(flag)) throw new Error('Usage: node scripts/build-starters.js [--check]');
    if (flag === '--check') {
      assertStarters(root, version);
      console.log(`Starters match release ${version}`);
    } else {
      const archive = writeStarters(root, version).find((path) => path.endsWith('.zip'));
      console.log(`Built ${archive.slice(root.length)}: SHA-256 ${createHash('sha256').update(readFileSync(archive)).digest('hex')}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
