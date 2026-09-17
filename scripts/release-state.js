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
export const assertReleaseCurrent = (root, version) => {
  if (!releaseVersion.test(version)) throw new Error('Invalid release version');
  const newer = gitAt(root)('tag', '--list').split('\n').filter((tag) => (
    releaseVersion.test(tag) && (version.includes('-') || !tag.includes('-')) && isNewer(tag, version)
  ));
  if (newer.length) throw new Error(`Release ${version} is superseded by a newer release: ${newer.join(', ')}`);
};

/** Select immutable release source; ordinary commits with the same version do not republish. */
export const selectRelease = (root, { retryExisting = false, preview = false } = {}) => {
  const git = gitAt(root);
  if (git('status', '--porcelain', '--untracked-files=normal')) throw new Error('Release source must be clean and committed');
  const { version } = readRelease(root);
  const tag = `v${version}`;
  const head = git('rev-parse', 'HEAD');
  const tags = git('tag', '--list').split('\n');
  const prerelease = version.includes('-');
  if (preview) return { version, tag, commit: head, shouldRelease: true, prerelease };
  assertReleaseCurrent(root, version);
  if (tags.includes(tag)) {
    const commit = git('rev-parse', `${tag}^{commit}`);
    try { git('merge-base', '--is-ancestor', commit, head); }
    catch { throw new Error(`Release tag ${tag} is outside the current ancestor history; it will not be moved`); }
    return { version, tag, commit, shouldRelease: retryExisting || commit === head, prerelease };
  }
  return { version, tag, commit: head, shouldRelease: true, prerelease };
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [mode = 'auto', value, ...extra] = process.argv.slice(2);
    if (mode === 'verify-current' && value && !extra.length) assertReleaseCurrent(process.cwd(), value);
    else {
      if (!['auto', 'retry', 'preview'].includes(mode) || value || extra.length) throw new Error('Usage: node scripts/release-state.js [auto|retry|preview] | verify-current <version>');
      const result = selectRelease(process.cwd(), { retryExisting: mode === 'retry', preview: mode === 'preview' });
      for (const [key, output] of Object.entries(result)) console.log(`${key}=${output}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
