import { execFileSync } from 'node:child_process';
import { isEntryPoint } from './cli.js';
import { assertGitHubAccess, githubFromEnvironment, githubPages } from './github-api.js';
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
  const missing = [];
  for (const { name } of readRelease(root).packages) {
    // write=true reads npm's primary copy: the plain packument is served from a CDN
    // cache for up to 5 minutes whatever the request headers say, which would hide a
    // version published moments earlier.
    const url = new URL(encodeURIComponent(name), registry);
    url.searchParams.set('write', 'true');
    const response = await fetch(url, { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(15000) });
    // A 404 cannot prove that nothing newer was published: npm also answers it for a
    // private package read anonymously and during registry faults. Trusted Publishing
    // can only be configured for a package that already exists, so every release
    // package must be visible. The refusal waits for the loop so that a newer
    // published sibling is still reported as superseding the release.
    if (response.status === 404) { await response.body?.cancel(); missing.push(name); continue; }
    if (!response.ok) throw new Error(`Registry returned ${response.status} for ${name}`);
    const metadata = await response.json();
    if (!metadata.versions || typeof metadata.versions !== 'object' || Array.isArray(metadata.versions)) throw new Error(`Registry version metadata is unavailable for ${name}`);
    const newer = Object.keys(metadata.versions).filter((published) => (
      releaseVersion.test(published) && (version.includes('-') || !published.includes('-')) && isNewer(published, version)
    ));
    if (newer.length) throw new Error(`Release ${version} is superseded by a newer published package: ${name}@${newer.join(', ')}`);
  }
  if (missing.length === 1) throw new Error(`${missing[0]} is not on the registry; publish it once and configure its Trusted Publisher before releasing`);
  if (missing.length) throw new Error(`${missing.join(', ')} are not on the registry; publish them once and configure their Trusted Publishers before releasing`);
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

/**
 * Select the release again in a later job's own checkout and require the tag and commit the
 * caller selected. A preview checks the version-derived tag and HEAD without requiring a tag.
 */
export const assertSelectedSource = (root, { tag, commit, preview = false } = {}) => {
  const selected = selectRelease(root, { tag, preview });
  if (selected.tag !== tag) throw new Error('Release tag must match the aligned package version');
  if (selected.commit !== commit) throw new Error('Checked out source must be the selected release commit');
  return selected;
};

const stableVersion = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const commitId = /^[0-9a-f]{40}$/;

/**
 * The newest deployment of `environment` whose newest status is success, as { id, sha },
 * or null when none has succeeded. GitHub lists deployments newest first and keeps the
 * success status of replaced Pages deployments, so the first success found is the one
 * live; a deployment still waiting or running, a failed one and one marked inactive are
 * skipped. The listing order is checked rather than trusted. Reads follow githubPages:
 * transient failures are retried within `budgetMs`, anything else fails closed.
 */
export const findLiveDocumentation = async ({ api, repository, token, environment = 'github-pages', budgetMs = 120000, ...limits } = {}) => {
  assertGitHubAccess({ repository, token });
  const options = { ...limits, api, token, deadline: Date.now() + budgetMs };
  const listing = githubPages(`repos/${repository}/deployments?environment=${encodeURIComponent(environment)}&per_page=100`, {
    ...options, what: `listing ${environment} deployments`,
  });
  let previous = Infinity;
  for await (const deployments of listing) {
    for (const deployment of deployments) {
      if (!Number.isSafeInteger(deployment?.id) || deployment.id < 1 || deployment.environment !== environment) {
        throw new Error(`GitHub sent a malformed response while listing ${environment} deployments`);
      }
      if (deployment.id >= previous) throw new Error(`GitHub did not list ${environment} deployments newest first`);
      previous = deployment.id;
      const what = `reading the statuses of deployment ${deployment.id}`;
      let latest;
      for await (const statuses of githubPages(`repos/${repository}/deployments/${deployment.id}/statuses?per_page=100`, { ...options, maxPages: 1, what })) {
        for (const status of statuses) {
          if (!Number.isSafeInteger(status?.id) || typeof status.state !== 'string') throw new Error(`GitHub sent a malformed response while ${what}`);
          if (!latest || status.id > latest.id) latest = status;
        }
      }
      if (latest?.state !== 'success') continue;
      if (typeof deployment.sha !== 'string' || !commitId.test(deployment.sha)) throw new Error(`GitHub deployment ${deployment.id} has no commit id`);
      return { id: deployment.id, sha: deployment.sha };
    }
  }
  return null;
};

const isAncestor = (root, ancestor, descendant) => {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd: root, stdio: 'ignore' });
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
};
const hasCommit = (root, commit) => {
  try {
    execFileSync('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

/**
 * Decide whether documentation built from `commit` at `version` may replace the live
 * GitHub Pages site. Before any request it requires a full commit id, a stable version, the
 * commit the run deploys (`expectedCommit`, GITHUB_SHA in the CLI; GitHub records it as the
 * deployment's commit) and GitHub access. It then keeps the npm freshness guard and reads
 * the live deployment: a source equal to or descending from the live commit deploys, a
 * source the live site already contains is skipped (deploy: false), and a source that is
 * neither, or a live commit missing from this clone, is refused. With no successful
 * deployment yet, the first one deploys. Returns { deploy, live, deployment } with empty
 * strings when nothing is live.
 */
export const assertDocumentationCurrent = async (root, version, commit, { registry, github, expectedCommit } = {}) => {
  if (typeof commit !== 'string' || !commitId.test(commit)) throw new Error('Documentation source must be a full commit id');
  if (typeof version !== 'string' || !stableVersion.test(version)) throw new Error(`Only a stable release version can replace the documentation site, not ${version}`);
  if (expectedCommit !== undefined && commit !== expectedCommit) throw new Error(`Documentation source ${commit} is not the commit this run deploys (${expectedCommit})`);
  assertGitHubAccess(github);
  await assertReleaseCurrent(root, version, registry ? { registry } : undefined);
  const live = await findLiveDocumentation(github);
  if (!live) return { deploy: true, live: '', deployment: '' };
  const found = { live: live.sha, deployment: live.id };
  if (!hasCommit(root, commit)) throw new Error(`Documentation source ${commit} is not in this clone`);
  if (!hasCommit(root, live.sha)) {
    throw new Error(`The live documentation commit ${live.sha} (deployment ${live.id}) is not in this clone; refusing to replace it`);
  }
  if (isAncestor(root, live.sha, commit)) return { deploy: true, ...found };
  if (isAncestor(root, commit, live.sha)) return { deploy: false, ...found };
  throw new Error(`Documentation source ${commit} neither contains nor is contained in the live site ${live.sha} (deployment ${live.id}); release from a master merge commit or deploy documentation from master`);
};

const usage = 'Usage: node scripts/release-state.js release <tag> | preview | verify-source <tag> <commit> [--preview] | verify-current <version> | verify-docs <version> <commit>';

if (isEntryPoint(import.meta.url)) {
  try {
    const [mode, value, ...extra] = process.argv.slice(2);
    if (mode === 'verify-current' && value && !extra.length) await assertReleaseCurrent(process.cwd(), value);
    else {
      const [commit, flag, ...rest] = extra;
      let result;
      if (mode === 'verify-source' && value && commit && [undefined, '--preview'].includes(flag) && !rest.length) {
        result = assertSelectedSource(process.cwd(), { tag: value, commit, preview: flag === '--preview' });
      } else if (mode === 'verify-docs' && value && commit && extra.length === 1) {
        result = await assertDocumentationCurrent(process.cwd(), value, commit, {
          expectedCommit: process.env.GITHUB_SHA || undefined,
          github: githubFromEnvironment(),
        });
      } else if (!extra.length && ((mode === 'release' && value) || (mode === 'preview' && !value))) {
        result = selectRelease(process.cwd(), { tag: value, preview: mode === 'preview' });
      } else {
        throw new Error(usage);
      }
      for (const [key, output] of Object.entries(result)) console.log(`${key}=${output}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
