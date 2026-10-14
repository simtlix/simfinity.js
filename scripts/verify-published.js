import { setTimeout } from 'node:timers/promises';
import { resolve } from 'node:path';
import { isEntryPoint } from './cli.js';
import { readRelease, readReleaseManifest } from './release-packages.js';
import { isTransientFailure, requestSignal } from './transient.js';

const describeFailure = (error) => [error.message, error.cause?.code].filter(Boolean).join(' ');

/**
 * Read-only verification, including npm's asynchronous publication visibility.
 *
 * Each attempt reads every package once. A 404, 429 or 5xx answer, a network failure,
 * a timeout or an unparsable body says nothing about publication, so it leaves the
 * package pending for the next attempt, `delayMs` later; integrity conflicts and other
 * 4xx answers fail at once. Every request is cut at `timeoutMs` or at the overall
 * deadline, `budgetMs` after the call starts, whichever comes first, and no wait or
 * attempt starts past that deadline. With the defaults, requests that answer or fail
 * quickly give up after the 20 attempts, 19 waits of 15 s (about 5 minutes); slow
 * requests are cut so that the call ends by the 10-minute deadline, which leaves the
 * earlier publish-npm steps room inside that job's 15-minute timeout.
 */
export const verifyPublished = async (release, { registry = 'https://registry.npmjs.org/', attempts = 20, delayMs = 15000, timeoutMs = 15000, budgetMs = 600000 } = {}) => {
  if (!release?.version || !release.packages?.length) throw new Error('A release must contain packages to verify');
  if (!Number.isInteger(attempts) || attempts < 1 || !Number.isFinite(delayMs) || delayMs < 0
    || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(budgetMs) || budgetMs <= 0) {
    throw new Error('Invalid publication verification retry limits');
  }
  const deadline = Date.now() + budgetMs;
  const distTag = release.version.includes('-') ? 'next' : 'latest';
  let pending;
  let failure;
  for (let attempt = 0; attempt < attempts; attempt++) {
    // Only the final attempt's registry errors are reported.
    pending = [];
    failure = undefined;
    const packages = [];
    for (const [index, item] of release.packages.entries()) {
      // write=true reads npm's primary copy: the plain packument is served from a CDN
      // cache for up to 5 minutes whatever the request headers say. An invalid registry
      // URL throws here, outside the retried request.
      const url = new URL(encodeURIComponent(item.name), registry);
      url.searchParams.set('write', 'true');
      let response;
      let metadata;
      try {
        response = await fetch(url, { headers: { 'cache-control': 'no-cache' }, signal: requestSignal({ deadline, timeoutMs }) });
        if (response.ok) metadata = await response.json();
        else await response.body?.cancel();
      } catch (error) {
        if (!isTransientFailure(error) && !(error instanceof SyntaxError)) throw error;
        // End the attempt: a failing registry is not asked about every remaining package.
        failure = `${item.name}: ${describeFailure(error)}`;
        pending.push(...release.packages.slice(index).map(({ name }) => name));
        break;
      }
      if (isTransientFailure(response.status)) { failure = `${item.name}: HTTP ${response.status}`; pending.push(item.name); continue; }
      if (response.status === 404) { pending.push(item.name); continue; }
      if (!response.ok) throw new Error(`Registry returned ${response.status} for ${item.name}`);
      const published = metadata.versions?.[release.version];
      if (!published) { pending.push(item.name); continue; }
      const integrity = published.dist?.integrity;
      if (typeof integrity !== 'string' || !integrity.startsWith('sha512-') || (item.integrity && integrity !== item.integrity)) {
        throw new Error(`Registry integrity differs for ${item.name}@${release.version}`);
      }
      if (metadata['dist-tags']?.[distTag] !== release.version) { pending.push(item.name); continue; }
      packages.push({ name: item.name, version: release.version, distTag, integrity });
    }
    if (!pending.length) return { version: release.version, verifiedAt: new Date().toISOString(), packages };
    if (attempt + 1 >= attempts || Date.now() + delayMs >= deadline) break;
    await setTimeout(delayMs);
  }
  throw new Error(`Published packages are not yet visible with the expected distribution tag: ${pending.join(', ')}${failure ? ` (last registry error: ${failure})` : ''}`);
};

if (isEntryPoint(import.meta.url)) {
  try {
    const [input, ...extra] = process.argv.slice(2);
    if (!input || extra.length) throw new Error('Usage: node scripts/verify-published.js <manifest.json>|--workspace');
    const release = input === '--workspace' ? readRelease(process.cwd()) : readReleaseManifest(resolve(input));
    console.log(JSON.stringify(await verifyPublished(release), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
