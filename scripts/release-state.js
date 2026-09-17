import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRelease } from './release-packages.js';

const releaseVersion = /^v?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const isNewer = (candidate, previous) => {
  const leftMatch = candidate.match(releaseVersion);
  const rightMatch = previous.match(releaseVersion);
  const left = leftMatch.slice(1, 4).map(BigInt);
  const right = rightMatch.slice(1, 4).map(BigInt);
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  if (!leftMatch[4] || !rightMatch[4]) return !leftMatch[4] && !!rightMatch[4];
  const leftPre = leftMatch[4].split('.');
  const rightPre = rightMatch[4].split('.');
  for (let index = 0; index < Math.max(leftPre.length, rightPre.length); index++) {
    if (leftPre[index] === rightPre[index]) continue;
    if (leftPre[index] === undefined || rightPre[index] === undefined) return rightPre[index] === undefined;
    const leftNumeric = /^\d+$/.test(leftPre[index]);
    const rightNumeric = /^\d+$/.test(rightPre[index]);
    if (leftNumeric && rightNumeric) return BigInt(leftPre[index]) > BigInt(rightPre[index]);
    if (leftNumeric !== rightNumeric) return rightNumeric;
    return leftPre[index] > rightPre[index];
  }
  return false;
};
const gitAt = (root) => (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Run again immediately before every publishing/latest/Pages mutation on retries. */
export const assertReleaseCurrent = async (root, version, { registry = 'https://registry.npmjs.org/' } = {}) => {
  if (!releaseVersion.test(version)) throw new Error('Invalid release version');
  // Tags can be queued before any publication. Only published package versions
  // supersede a run; check every package to include partially published releases.
  for (const { name } of readRelease(root).packages) {
    const response = await fetch(new URL(encodeURIComponent(name), registry), { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(15000) });
    if (response.status === 404) { await response.body?.cancel(); continue; }
    if (!response.ok) throw new Error(`Registry returned ${response.status} for ${name}`);
    const metadata = await response.json();
    if (!metadata.versions || typeof metadata.versions !== 'object' || Array.isArray(metadata.versions)) throw new Error(`Registry version metadata is unavailable for ${name}`);
    const newer = Object.keys(metadata.versions).filter((published) => (
      releaseVersion.test(published) && (version.includes('-') || !published.includes('-')) && isNewer(published, version)
    ));
    if (newer.length) throw new Error(`Release ${version} is superseded by a newer published package: ${name}@${newer.join(', ')}`);
  }
};

/** Only an explicit existing release tag authorizes publication; previews never publish. */
export const selectRelease = (root, { tag, preview = false } = {}) => {
  const git = gitAt(root);
  if (git('status', '--porcelain', '--untracked-files=normal')) throw new Error('Release source must be clean and committed');
  const { version } = readRelease(root);
  const head = git('rev-parse', 'HEAD');
  const prerelease = version.includes('-');
  if (preview) return { version, tag: `v${version}`, commit: head, prerelease };
  if (!tag) throw new Error('Publication requires an explicit release tag');
  if (tag !== `v${version}`) throw new Error('Release tag must match the aligned package version');
  let commit;
  try { commit = git('rev-parse', '--verify', `refs/tags/${tag}^{commit}`); }
  catch { throw new Error('Release tag must already exist'); }
  if (commit !== head) throw new Error('Release tag must match the checked out source');
  try { git('merge-base', '--is-ancestor', commit, 'refs/remotes/origin/master'); }
  catch { throw new Error('Release tag must point to source merged into master'); }
  return { version, tag, commit, prerelease };
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode, value, ...extra] = process.argv.slice(2);
    if (mode === 'verify-current' && value && !extra.length) await assertReleaseCurrent(process.cwd(), value);
    else {
      if (extra.length || !((mode === 'release' && value) || (mode === 'preview' && !value))) throw new Error('Usage: node scripts/release-state.js release <tag> | preview | verify-current <version>');
      const result = selectRelease(process.cwd(), { tag: value, preview: mode === 'preview' });
      for (const [key, output] of Object.entries(result)) console.log(`${key}=${output}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
