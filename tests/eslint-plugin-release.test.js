import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { pluginSource, packPlugin, readPluginArchive, pluginRegistryState } from '../scripts/release-eslint-plugin.js';

const roots = [];
const servers = [];
const name = '@simtlix/eslint-plugin-simfinity';
const directory = 'tools/eslint-plugin-simfinity';
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const commit = root => { git(root, 'add', '.'); git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'commit', '-qm', 'fixture'); };
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'eslint-release-'));
  roots.push(root);
  mkdirSync(join(root, directory, 'src'), { recursive: true });
  writeFileSync(join(root, directory, 'package.json'), JSON.stringify({ name, version: '0.2.0', files: ['src'], scripts: { prepack: 'exit 99' } }));
  writeFileSync(join(root, directory, 'package-lock.json'), JSON.stringify({ name, version: '0.2.0', packages: { '': { name, version: '0.2.0' } } }));
  writeFileSync(join(root, directory, 'src/index.js'), 'export const version = "0.2.0";\n');
  writeFileSync(join(root, '.gitignore'), 'ignored.js\n');
  git(root, 'init', '-q', '-b', 'master');
  commit(root);
  git(root, 'update-ref', 'refs/remotes/origin/master', 'HEAD');
  git(root, 'tag', 'eslint-plugin-v0.2.0');
  return root;
};
const registry = async (status, body) => {
  const server = createServer((req, res) => {
    expect(req.url).toContain('write=true');
    res.statusCode = status;
    res.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}/`;
};
afterEach(async () => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

describe('independent ESLint release source and archive', () => {
  it('requires a matching plugin tag on master; previews never need a tag', () => {
    const root = fixture();
    expect(pluginSource(root, { tag: 'eslint-plugin-v0.2.0' })).toMatchObject({ version: '0.2.0', commit: git(root, 'rev-parse', 'HEAD') });
    expect(() => pluginSource(root)).toThrow(/tag/i);
    expect(() => pluginSource(root, { tag: 'v0.2.0' })).toThrow(/tag/i);
    git(root, 'tag', '-d', 'eslint-plugin-v0.2.0');
    expect(pluginSource(root, { preview: true }).version).toBe('0.2.0');
  });
  it('rejects dirty sources and mismatched lock versions', () => {
    const root = fixture();
    writeFileSync(join(root, directory, 'src/index.js'), '// changed');
    expect(() => pluginSource(root, { preview: true })).toThrow(/clean/i);
    writeFileSync(join(root, directory, 'package-lock.json'), '{}');
    commit(root);
    expect(() => pluginSource(root, { preview: true })).toThrow(/lock/i);
  });
  it('rejects a merged side-branch head that is not on the first-parent history', () => {
    const root = fixture();
    git(root, 'switch', '-c', 'feature');
    writeFileSync(join(root, 'change'), 'side branch'); commit(root);
    const head = git(root, 'rev-parse', 'HEAD');
    git(root, 'tag', '-f', 'eslint-plugin-v0.2.0');
    git(root, 'switch', 'master');
    git(root, '-c', 'user.name=Test', '-c', 'user.email=test@example.test', 'merge', '--no-ff', 'feature', '-m', 'merge');
    git(root, 'update-ref', 'refs/remotes/origin/master', 'HEAD');
    git(root, 'checkout', '--detach', head);
    expect(() => pluginSource(root, { tag: 'eslint-plugin-v0.2.0' })).toThrow(/first.parent|master/i);
  });
  it('packs without lifecycle scripts and verifies digest, source commit and archive bytes', () => {
    const root = fixture();
    const output = mkdtempSync(join(tmpdir(), 'eslint-artifacts-')); roots.push(output);
    const release = packPlugin(root, output, { tag: 'eslint-plugin-v0.2.0' });
    const manifest = join(output, 'manifest.json');
    const digest = hash(manifest);
    expect(readPluginArchive(manifest, { digest, commit: release.commit })).toEqual(release);
    expect(() => readPluginArchive(manifest, { digest: '0'.repeat(64), commit: release.commit })).toThrow(/digest/i);
    expect(() => readPluginArchive(manifest, { digest, commit: '1'.repeat(40) })).toThrow(/commit/i);
    const archive = join(output, release.packages[0].filename);
    writeFileSync(archive, 'tampered');
    expect(() => readPluginArchive(manifest, { digest, commit: release.commit })).toThrow(/integrity/i);
    rmSync(archive); symlinkSync(join(root, directory, 'src/index.js'), archive);
    expect(() => readPluginArchive(manifest, { digest, commit: release.commit })).toThrow(/regular/i);
  }, 15000);
  it('refuses ignored source files that npm would pack', () => {
    const root = fixture();
    writeFileSync(join(root, directory, 'src/ignored.js'), 'secret');
    const output = mkdtempSync(join(tmpdir(), 'eslint-artifacts-')); roots.push(output);
    expect(() => packPlugin(root, output, { preview: true })).toThrow(/tracked/i);
  }, 15000);
});

describe('ESLint registry idempotency and freshness', () => {
  const release = { version: '0.2.0', packages: [{ name, integrity: 'sha512-expected' }] };
  it('publishes a new version and skips only byte-identical existing archives', async () => {
    const fresh = await registry(200, { versions: { '0.1.0': {} }, 'dist-tags': { latest: '0.1.0' } });
    expect(await pluginRegistryState(release, { registry: fresh })).toBe('publish');
    const same = await registry(200, { versions: { '0.2.0': { dist: { integrity: 'sha512-expected' } } }, 'dist-tags': { latest: '0.2.0' } });
    expect(await pluginRegistryState(release, { registry: same })).toBe('published');
  });
  it('refuses missing packages, registry denial and conflicting bytes', async () => {
    for (const status of [404, 401]) {
      await expect(pluginRegistryState(release, { registry: await registry(status, {}) })).rejects.toThrow(/404|401/);
    }
    const conflict = await registry(200, { versions: { '0.2.0': { dist: { integrity: 'sha512-other' } } } });
    await expect(pluginRegistryState(release, { registry: conflict })).rejects.toThrow(/integrity/i);
  });
  it('refuses old retries even if their own version matches', async () => {
    const newer = await registry(200, { versions: { '0.2.0': { dist: { integrity: 'sha512-expected' } }, '0.10.0': {} } });
    await expect(pluginRegistryState(release, { registry: newer })).rejects.toThrow(/superseded/i);
  });
});
