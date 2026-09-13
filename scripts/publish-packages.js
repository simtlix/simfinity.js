import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readReleaseManifest } from './release-packages.js';

const registries = { npm: 'https://registry.npmjs.org/', github: 'https://npm.pkg.github.com/' };
const invoke = (run, args) => run('npm', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const missingVersion = (error) => {
  try { return JSON.parse(error.stdout)?.error?.code === 'E404'; }
  catch { return false; }
};
const publishedIntegrity = (run, item, registry) => {
  let output;
  try {
    output = invoke(run, ['view', `${item.name}@${item.version}`, 'dist.integrity', '--json', '--registry', registry]);
  } catch (error) {
    if (missingVersion(error)) return null;
    throw new Error(`Unable to inspect registry version ${item.name}@${item.version}`, { cause: error });
  }
  try {
    const integrity = JSON.parse(output);
    if (typeof integrity === 'string' && integrity.startsWith('sha512-')) return integrity;
  } catch { /* Missing or malformed metadata cannot prove an existing archive matches. */ }
  throw new Error(`Registry integrity is unavailable for ${item.name}@${item.version}`);
};

/** Manual publication; default mode verifies local artifacts without registry requests. */
export const publishRelease = (manifestPath, { registry = 'npm', dryRun = true, expectedCommit, run = execFileSync } = {}) => {
  if (!Object.hasOwn(registries, registry)) throw new Error(`Unknown package registry: ${registry}`);
  if (typeof dryRun !== 'boolean') throw new Error('dryRun must be a boolean');
  const manifest = readReleaseManifest(manifestPath);
  if (expectedCommit !== undefined && manifest.commit !== expectedCommit) throw new Error('Release archive source commit differs from the validated commit');
  const url = registries[registry];
  const distTag = manifest.version.includes('-') ? 'next' : 'latest';
  const result = { version: manifest.version, registry: url, distTag, dryRun, packages: [] };
  if (dryRun) {
    result.packages = manifest.packages.map((item) => ({ name: item.name, action: 'validated' }));
    return result;
  }
  // Check the entire registry set before publishing any dependency: a later conflict
  // must not leave newly published earlier packages behind unnecessarily.
  const pending = manifest.packages.map((item) => {
    const existing = publishedIntegrity(run, item, url);
    if (existing !== null && existing !== item.integrity) throw new Error(`Registry integrity conflicts with the local archive for ${item.name}@${item.version}`);
    return { item, exists: existing !== null };
  });
  for (const { item, exists } of pending) {
    if (!exists) {
      // An uncertain error ends the run. A later manual rerun verifies registry
      // integrity before deciding whether publication is still necessary.
      invoke(run, ['publish', join(dirname(manifestPath), item.filename), '--access', 'public', '--tag', distTag, '--ignore-scripts', '--registry', url]);
    }
    result.packages.push({ name: item.name, action: exists ? 'skipped' : 'published' });
  }
  return result;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [manifestPath, flag, registry, execution] = process.argv.slice(2);
    if (!manifestPath || flag !== '--registry' || !registry || ![undefined, '--execute', '--dry-run'].includes(execution) || process.argv.length > 6) {
      throw new Error('Usage: node scripts/publish-packages.js <manifest.json> --registry npm|github [--dry-run|--execute]');
    }
    console.log(JSON.stringify(publishRelease(resolve(manifestPath), { registry, dryRun: execution !== '--execute', expectedCommit: process.env.SIMFINITY_RELEASE_COMMIT }), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
