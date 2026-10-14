import { isTransientFailure, retry } from './transient.js';

// GitHub forbids '.' and '..' as repository names; they would also move a request path.
const repositoryName = /^[A-Za-z0-9-]+\/(?!\.\.?$)[A-Za-z0-9_.-]+$/;
const describeFailure = (error) => [error.message, error.cause?.code].filter(Boolean).join(' ');

/** GitHub API access as a workflow step sees it: GITHUB_API_URL, GITHUB_REPOSITORY and GH_TOKEN or GITHUB_TOKEN. */
export const githubFromEnvironment = (env = process.env) => ({
  api: env.GITHUB_API_URL || undefined,
  repository: env.GITHUB_REPOSITORY,
  token: env.GH_TOKEN || env.GITHUB_TOKEN,
});

/**
 * Refuse before any request unless a repository and a token are given. Reads are always
 * authenticated: anonymous reads miss draft releases and share a small per-address quota.
 */
export const assertGitHubAccess = ({ repository, token } = {}) => {
  if (typeof repository !== 'string' || !repositoryName.test(repository)) throw new Error('A GitHub repository (owner/name, from GITHUB_REPOSITORY) is required');
  if (typeof token !== 'string' || !token) throw new Error('A GitHub token (GH_TOKEN or GITHUB_TOKEN) is required');
};

const nextPage = (link, base, what) => {
  for (const [, target, relation] of (link || '').matchAll(/<([^>]*)>\s*;\s*rel="([^"]*)"/g)) {
    if (!relation.split(/\s+/).includes('next')) continue;
    const url = new URL(target, base);
    // Every page carries the token: never follow a link off the API's own origin.
    if (url.origin !== base.origin) throw new Error(`GitHub pagination left ${base.origin} while ${what}`);
    return url;
  }
  return null;
};

/**
 * Yield the items of each page of a GitHub REST listing, in GitHub's order. `what` names
 * the read in errors ('listing releases'). Every page must be a JSON array; next links are
 * followed only on the API's origin, and reading stops with an error after `maxPages`.
 * A request answered with 429 or 5xx, or failing with a network error, a cut-off body or a
 * timeout, is repeated up to `attempts` times, `delayMs` apart (transient.js `retry`). Any
 * other status, including 401, 403 and 404, and a malformed body fail at once. Requests
 * time out after `timeoutMs`, and no request or wait outlives `deadline` (epoch ms).
 */
export async function* githubPages(path, {
  api = 'https://api.github.com', token, what, maxPages = 10, attempts = 3, delayMs = 2000, timeoutMs = 15000, deadline = Date.now() + 120000,
} = {}) {
  if (typeof token !== 'string' || !token) throw new Error('A GitHub token (GH_TOKEN or GITHUB_TOKEN) is required');
  if (!Number.isInteger(maxPages) || maxPages < 1) throw new RangeError('Invalid GitHub page limit');
  const base = new URL(api.endsWith('/') ? api : `${api}/`);
  let url = new URL(path, base);
  for (let page = 1; url; page++) {
    if (page > maxPages) throw new Error(`GitHub returned more than ${maxPages} pages while ${what}`);
    let body;
    let link;
    try {
      ({ body, link } = await retry(async ({ signal }) => {
        const response = await fetch(url, {
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${token}`,
            'user-agent': 'simfinity-release-tooling',
            'x-github-api-version': '2022-11-28',
          },
          signal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          throw Object.assign(new Error(`GitHub returned ${response.status} while ${what}`), { status: response.status });
        }
        return { body: await response.json(), link: response.headers.get('link') };
      }, { attempts, delayMs, deadline, timeoutMs }));
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`GitHub sent a malformed response while ${what}`, { cause: error });
      if (typeof error?.status !== 'number' && isTransientFailure(error)) {
        throw new Error(`GitHub could not be reached while ${what}: ${describeFailure(error)}`, { cause: error });
      }
      throw error;
    }
    if (!Array.isArray(body)) throw new Error(`GitHub sent a malformed response while ${what}`);
    yield body;
    url = nextPage(link, base, what);
  }
}
