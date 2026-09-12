import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Dependencies precede every consumer in both archive manifests and publication.
const packages = [
  ['packages/core', '@simtlix/simfinity-core'],
  ['packages/mcp', '@simtlix/simfinity-mcp'],
  ['packages/postgres', '@simtlix/simfinity-postgres'],
  ['', '@simtlix/simfinity-js'],
];
const names = new Set(packages.map(([, name]) => name));
const dependencyGroups = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'];
const parseJSON = (path) => JSON.parse(readFileSync(path, 'utf8'));
const validVersion = (version) => typeof version === 'string'
  && /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.test(version)
  && version.trim() === version
  && !(version.split('-').slice(1).join('-').split('.').some((part) => /^[0-9]+$/.test(part) && part.length > 1 && part.startsWith('0')));
const assertVersion = (version) => { if (!validVersion(version)) throw new Error(`Invalid release version: ${JSON.stringify(version)}`); };
const readInputs = (root) => {
  const entries = packages.map(([directory, name]) => {
    const manifest = parseJSON(join(root, directory, 'package.json'));
    if (manifest.name !== name) throw new Error(`Expected package ${name} in ${directory || '.'}`);
    return { directory, name, manifest };
  });
  const lock = parseJSON(join(root, 'package-lock.json'));
  if (![2, 3].includes(lock.lockfileVersion) || entries.some(({ directory }) => !lock.packages?.[directory])) {
    throw new Error('Release requires a complete npm v2 or v3 workspace lockfile');
  }
  return { entries, lock };
};
const updateInternal = (dependencies, version) => {
  for (const name of Object.keys(dependencies || {})) if (names.has(name)) dependencies[name] = version;
};

/** Validate a release before packing, tagging, or publishing it. */
export const readRelease = (root) => {
  const { entries, lock } = readInputs(root);
  const version = entries.find((item) => item.directory === '').manifest.version;
  assertVersion(version);
  if (lock.version !== version) throw new Error('Root lockfile version differs from the release');
  const precedingPackages = new Set();
  for (const { directory, name, manifest } of entries) {
    if (manifest.version !== version) throw new Error(`Package ${name} has a different release version`);
    const locked = lock.packages[directory];
    if (locked.version !== version) throw new Error(`Lockfile version differs for ${name}`);
    for (const group of dependencyGroups) {
      for (const [dependency, range] of Object.entries(manifest[group] || {})) {
        if (names.has(dependency) && range !== version) throw new Error(`Exact internal dependency version required: ${name} -> ${dependency}`);
        if (group !== 'devDependencies' && names.has(dependency) && !precedingPackages.has(dependency)) throw new Error(`Invalid publication order: ${name} requires ${dependency} first`);
      }
      if (JSON.stringify(locked[group] || {}) !== JSON.stringify(manifest[group] || {})) throw new Error(`Lockfile ${group} differs for ${name}`);
    }
    precedingPackages.add(name);
    for (const [dependency, range] of Object.entries(lock.dependencies?.[name]?.requires || {})) {
      if (names.has(dependency) && range !== version) throw new Error(`Lockfile internal dependency version differs for ${name}`);
    }
  }
  return { version, packages: entries.map(({ directory, name, manifest }) => ({ directory, name, version, dependencies: manifest.dependencies || {} })) };
};

/** Update every package and internal lock entry without installing or contacting a registry. */
export const setReleaseVersion = (root, version) => {
  assertVersion(version);
  const { entries, lock } = readInputs(root);
  const changes = new Map();
  for (const { directory, name, manifest } of entries) {
    manifest.version = version;
    lock.packages[directory].version = version;
    for (const group of dependencyGroups) {
      updateInternal(manifest[group], version);
      if (manifest[group]) lock.packages[directory][group] = structuredClone(manifest[group]);
      else delete lock.packages[directory][group];
    }
    updateInternal(lock.dependencies?.[name]?.requires, version);
    changes.set(join(root, directory, 'package.json'), manifest);
  }
  lock.version = version;
  changes.set(join(root, 'package-lock.json'), lock);
  const originals = new Map([...changes.keys()].map((path) => [path, readFileSync(path, 'utf8')]));
  try {
    for (const [path, value] of changes) {
      const newline = originals.get(path).includes('\r\n') ? '\r\n' : '\n';
      writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`.replaceAll('\n', newline));
    }
    return readRelease(root);
  } catch (error) {
    for (const [path, original] of originals) writeFileSync(path, original);
    throw error;
  }
};

const archiveHashes = (path) => {
  const bytes = readFileSync(path);
  return {
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
};
const validFilename = (filename) => typeof filename === 'string' && /^[a-z0-9][a-z0-9._-]*\.tgz$/i.test(filename) && basename(filename) === filename;
const assertCommit = (commit) => { if (typeof commit !== 'string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(commit)) throw new Error('A full source commit hash is required'); };

/** Produce local archives only. No lifecycle hooks, registry calls, tags, or publication. */
export const packRelease = (root, destination, { commit } = {}) => {
  const release = readRelease(root);
  const sourceCommit = commit || execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  assertCommit(sourceCommit);
  if (existsSync(destination)) throw new Error(`Artifact destination already exists: ${destination}`);
  mkdirSync(destination, { recursive: true });
  try {
    const packed = release.packages.map(({ directory, name, version }) => {
      const output = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--workspaces=false', '--pack-destination', resolve(destination)], {
        cwd: join(root, directory), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      }));
      const item = output[0];
      if (output.length !== 1 || item.name !== name || item.version !== version || !validFilename(item.filename)) throw new Error(`Unexpected archive metadata for ${name}`);
      const hashes = archiveHashes(join(destination, item.filename));
      if (hashes.integrity !== item.integrity) throw new Error(`Archive integrity mismatch for ${name}`);
      return { name, version, filename: item.filename, ...hashes };
    });
    const manifest = { version: release.version, commit: sourceCommit, packages: packed };
    writeFileSync(join(destination, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    return readReleaseManifest(join(destination, 'manifest.json'));
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
};

/** Verify the archive set and content before using a local release manifest. */
export const readReleaseManifest = (path) => {
  const manifest = parseJSON(path);
  assertVersion(manifest.version);
  assertCommit(manifest.commit);
  if (!Array.isArray(manifest.packages) || manifest.packages.length !== packages.length) throw new Error('Invalid release manifest package set');
  for (const [index, item] of manifest.packages.entries()) {
    if (item.name !== packages[index][1] || item.version !== manifest.version || !validFilename(item.filename)) throw new Error('Invalid release manifest package order, version, or filename');
    const archive = join(dirname(path), item.filename);
    const hashes = archiveHashes(archive);
    if (hashes.integrity !== item.integrity || hashes.sha256 !== item.sha256) throw new Error(`Archive integrity mismatch for ${item.name}`);
    const metadata = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }));
    if (metadata.name !== item.name || metadata.version !== item.version) throw new Error(`Archive identity mismatch for ${item.name}`);
    for (const group of dependencyGroups) {
      for (const [name, version] of Object.entries(metadata[group] || {})) if (names.has(name) && version !== manifest.version) throw new Error(`Archive internal dependency differs for ${item.name}`);
    }
  }
  return manifest;
};

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, value] = process.argv.slice(2);
    if (command === 'version' && value) console.log(JSON.stringify(setReleaseVersion(root, value), null, 2));
    else if (command === 'check' && !value) console.log(JSON.stringify(readRelease(root), null, 2));
    else if (command === 'pack' && value) console.log(JSON.stringify(packRelease(root, resolve(value)), null, 2));
    else if (command === 'verify' && value) console.log(JSON.stringify(readReleaseManifest(resolve(value)), null, 2));
    else throw new Error('Usage: node scripts/release-packages.js version <version> | check | pack <new-directory> | verify <manifest.json>');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
