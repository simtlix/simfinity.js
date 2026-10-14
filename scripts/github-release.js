import { isEntryPoint } from './cli.js';
import { assertGitHubAccess, githubFromEnvironment, githubPages } from './github-api.js';

const releaseTag = /^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/**
 * The single GitHub release, draft or published, that uses `tag`, or null only after every
 * page of the repository's release listing was read. The token must see drafts (push
 * access). Transient failures are retried within `budgetMs` (see githubPages); any other
 * failure, a malformed listing and several releases for one tag throw, so a failed lookup
 * never reads as a missing release.
 */
export const findGitHubRelease = async (tag, { api, repository, token, budgetMs = 120000, ...limits } = {}) => {
  if (typeof tag !== 'string' || !releaseTag.test(tag)) throw new Error('Invalid release tag');
  assertGitHubAccess({ repository, token });
  const matches = [];
  const listing = githubPages(`repos/${repository}/releases?per_page=100`, {
    maxPages: 50, ...limits, api, token, what: 'listing releases', deadline: Date.now() + budgetMs,
  });
  for await (const releases of listing) {
    for (const release of releases) {
      if (typeof release?.tag_name !== 'string') throw new Error('GitHub sent a malformed response while listing releases');
      if (release.tag_name === tag) matches.push(release);
    }
  }
  if (matches.length > 1) {
    throw new Error(`Several GitHub releases use ${tag}; delete the extra ones and re-run: ${matches.map((release) => release.html_url || `release ${release.id}`).join(', ')}`);
  }
  return matches[0] ?? null;
};

if (isEntryPoint(import.meta.url)) {
  try {
    const [mode, tag, ...extra] = process.argv.slice(2);
    if (mode !== 'find' || !tag || extra.length) throw new Error('Usage: node scripts/github-release.js find <tag>');
    const release = await findGitHubRelease(tag, githubFromEnvironment());
    console.log(`exists=${release !== null}`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
