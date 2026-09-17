import { setTimeout } from 'node:timers/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRelease, readReleaseManifest } from './release-packages.js';

/** Read-only verification, including npm's asynchronous publication visibility. */
export const verifyPublished = async (release, { registry = 'https://registry.npmjs.org/', attempts = 20, delayMs = 15000 } = {}) => {
  if (!release?.version || !release.packages?.length) throw new Error('A release must contain packages to verify');
  if (!Number.isInteger(attempts) || attempts < 1 || !Number.isFinite(delayMs) || delayMs < 0) throw new Error('Invalid publication verification retry limits');
  const distTag = release.version.includes('-') ? 'next' : 'latest';
  let pending;
  for (let attempt = 0; attempt < attempts; attempt++) {
    pending = [];
    const packages = [];
    for (const item of release.packages) {
      const response = await fetch(new URL(encodeURIComponent(item.name), registry), { headers: { 'cache-control': 'no-cache' }, signal: AbortSignal.timeout(15000) });
      if (response.status === 404 || response.status === 429 || response.status >= 500) {
        await response.body?.cancel();
        pending.push(item.name);
        continue;
      }
      if (!response.ok) throw new Error(`Registry returned ${response.status} for ${item.name}`);
      const metadata = await response.json();
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
    if (attempt + 1 < attempts) await setTimeout(delayMs);
  }
  throw new Error(`Published packages are not yet visible with the expected distribution tag: ${pending.join(', ')}`);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
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
