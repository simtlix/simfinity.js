import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { isEntryPoint } from './cli.js';
import { githubFromEnvironment, assertGitHubAccess, githubPages } from './github-api.js';
import { retry } from './transient.js';
import { verifyPublished } from './verify-published.js';

const name = '@simtlix/eslint-plugin-simfinity';
const directory = 'tools/eslint-plugin-simfinity';
const stable = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const hash = (path, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(readFileSync(path)).digest(encoding);
const regular = path => { if (!lstatSync(path).isFile()) throw new Error('Release assets must be regular files'); };

export const pluginSource = (root, { tag, preview = false } = {}) => {
  if (git(root, 'status', '--porcelain', '--untracked-files=normal')) throw new Error('Release source must be clean');
  const pkg = json(join(root, directory, 'package.json'));
  const lock = json(join(root, directory, 'package-lock.json'));
  if (pkg.name !== name || !stable.test(pkg.version)) throw new Error('Invalid stable plugin version/name');
  if (lock.version !== pkg.version || lock.packages?.['']?.version !== pkg.version) throw new Error('Plugin lock version differs');
  const commit = git(root, 'rev-parse', 'HEAD');
  const expectedTag = `eslint-plugin-v${pkg.version}`;
  if (!preview) {
    if (tag !== expectedTag || git(root, 'rev-parse', '--verify', `refs/tags/${tag}^{commit}`) !== commit) throw new Error('Release tag must match the plugin version and source commit');
    if (!git(root, 'rev-list', '--first-parent', 'refs/remotes/origin/master').split('\n').includes(commit)) throw new Error('Release must be on master first-parent history');
  }
  return { version: pkg.version, tag: expectedTag, commit };
};

/** Fresh checkout only: no dependencies or package lifecycle scripts run before packing. */
export const packPlugin = (root, destination, options = {}) => {
  const selected = pluginSource(root, options);
  mkdirSync(destination, { recursive: true });
  const [packed] = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], {
    cwd: join(root, directory), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  }));
  if (packed.name !== name || packed.version !== selected.version || packed.filename !== `simtlix-eslint-plugin-simfinity-${selected.version}.tgz`) throw new Error('Unexpected packed plugin metadata');
  const tracked = new Set(git(root, 'ls-files', '-z', directory).split('\0'));
  for (const file of packed.files) {
    if (!tracked.has(`${directory}/${file.path}`)) throw new Error(`Packed plugin file is not tracked: ${file.path}`);
  }
  const path = join(destination, packed.filename);
  regular(path);
  const release = { ...selected, packages: [{ name, version: selected.version, filename: packed.filename, sha256: hash(path), integrity: `sha512-${hash(path, 'sha512', 'base64')}` }] };
  writeFileSync(join(destination, 'manifest.json'), `${JSON.stringify(release, null, 2)}\n`);
  return release;
};

export const readPluginArchive = (path, { digest, commit } = {}) => {
  regular(path);
  if (!/^[0-9a-f]{64}$/.test(digest) || hash(path) !== digest) throw new Error('Plugin manifest digest differs from packing output');
  const release = json(path);
  if (!/^[0-9a-f]{40}$/.test(commit) || release.commit !== commit) throw new Error('Plugin source commit differs');
  const item = release.packages?.[0];
  if (!stable.test(release.version) || release.tag !== `eslint-plugin-v${release.version}` || release.packages.length !== 1
    || item?.name !== name || item.version !== release.version || item.filename !== `simtlix-eslint-plugin-simfinity-${release.version}.tgz`) throw new Error('Invalid plugin release manifest');
  const archive = join(dirname(path), item.filename);
  regular(archive);
  if (hash(archive) !== item.sha256 || `sha512-${hash(archive, 'sha512', 'base64')}` !== item.integrity) throw new Error('Plugin archive integrity differs');
  return release;
};

const newer = (candidate, version) => {
  const left = candidate.split('.').map(BigInt);
  const right = version.split('.').map(BigInt);
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] > right[index];
  return false;
};

export const pluginRegistryState = async (release, { registry = 'https://registry.npmjs.org/' } = {}) => {
  const metadata = await retry(async ({ signal }) => {
    const url = new URL(encodeURIComponent(name), registry);
    url.searchParams.set('write', 'true');
    const response = await fetch(url, { signal, headers: { 'cache-control': 'no-cache' } });
    if (!response.ok) { await response.body?.cancel(); throw Object.assign(new Error(`Plugin registry returned ${response.status}`), { status: response.status }); }
    return response.json();
  });
  if (!metadata.versions || typeof metadata.versions !== 'object' || Array.isArray(metadata.versions)) throw new Error('Missing plugin registry versions');
  if (Object.keys(metadata.versions).some(version => stable.test(version) && newer(version, release.version))) throw new Error('Plugin release is superseded');
  const existing = metadata.versions[release.version];
  if (!existing) return 'publish';
  if (existing.dist?.integrity !== release.packages[0].integrity) throw new Error('Registry integrity conflicts with plugin archive');
  return 'published';
};

const githubRelease = async (release, path) => {
  const options = githubFromEnvironment();
  assertGitHubAccess(options);
  const matches = [];
  for await (const entries of githubPages(`repos/${options.repository}/releases?per_page=100`, { ...options, maxPages: 50, what: 'listing plugin releases' })) {
    for (const entry of entries) {
      if (typeof entry?.tag_name !== 'string') throw new Error('Malformed GitHub release listing');
      if (entry.tag_name === release.tag) matches.push(entry);
    }
  }
  if (matches.length > 1) throw new Error('Multiple GitHub releases use the plugin tag');
  const gh = (...args) => execFileSync('gh', [...args, '--repo', options.repository], { stdio: 'inherit' });
  if (!matches.length) gh('release', 'create', release.tag, '--verify-tag', '--draft', '--title', `ESLint plugin ${release.version}`, '--notes', `Optional Simfinity application linting. Install @simtlix/eslint-plugin-simfinity@${release.version}. See the included README and manifest for contracts and archive integrity.`);
  gh('release', 'upload', release.tag, path, join(dirname(path), release.packages[0].filename), join(dirname(path), 'npm-verification.json'), '--clobber');
  gh('release', 'edit', release.tag, '--draft=false', '--prerelease=false', '--latest=false');
};

if (isEntryPoint(import.meta.url)) {
  try {
    const [mode, input, ...extra] = process.argv.slice(2);
    if (extra.length) throw new Error('Unexpected release arguments');
    const root = process.cwd();
    const options = { tag: process.env.ESLINT_RELEASE_TAG, preview: process.env.ESLINT_RELEASE_PREVIEW === 'true' };
    if (mode === 'pack' && input) {
      packPlugin(root, resolve(input), options);
      console.log(`manifest_sha256=${hash(join(resolve(input), 'manifest.json'))}`);
    } else if (mode === 'verify-docs' && !input) {
      const { version } = json(join(root, directory, 'package.json'));
      console.log(JSON.stringify(await verifyPublished({ version, packages: [{ name }] })));
    } else if (['verify', 'publish', 'github-release'].includes(mode) && input) {
      const path = resolve(input);
      const release = readPluginArchive(path, { digest: process.env.ESLINT_RELEASE_MANIFEST_SHA256, commit: process.env.ESLINT_RELEASE_COMMIT });
      if (mode !== 'verify') {
        const selected = pluginSource(root, { tag: process.env.ESLINT_RELEASE_TAG });
        if (selected.commit !== release.commit || selected.version !== release.version) throw new Error('Selected source differs from plugin archive');
        const state = await pluginRegistryState(release);
        if (mode === 'publish' && state === 'publish') {
          execFileSync('npm', ['publish', join(dirname(path), release.packages[0].filename), '--access', 'public', '--tag', 'latest', '--provenance', '--ignore-scripts'], { stdio: 'inherit' });
        }
        const evidence = await verifyPublished(release);
        writeFileSync(join(dirname(path), 'npm-verification.json'), `${JSON.stringify(evidence, null, 2)}\n`);
        if (mode === 'github-release') await githubRelease(release, path);
      }
      console.log(`Verified ${name}@${release.version}`);
    } else throw new Error('Usage: release-eslint-plugin.js pack <directory> | verify|publish|github-release <manifest> | verify-docs');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
