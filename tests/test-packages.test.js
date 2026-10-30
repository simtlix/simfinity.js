import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendFileSync, chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packRelease } from '../scripts/release-packages.js';

// The consumer installs need the registry, so a stub npm stops the CLI at its first install
// and records which archives it reached that call with. `npm pack` is passed to the real npm.
const root = fileURLToPath(new URL('..', import.meta.url));
const script = fileURLToPath(new URL('../scripts/test-packages.js', import.meta.url));
const realNpm = execFileSync('sh', ['-c', 'command -v npm'], { encoding: 'utf8' }).trim();
const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
let temporary; let release; let manifest; let runs = 0;
beforeAll(() => {
  temporary = mkdtempSync(join(tmpdir(), 'simfinity-test-packages-'));
  release = join(temporary, 'release');
  manifest = packRelease(root, release);
  mkdirSync(join(temporary, 'bin'));
  writeFileSync(join(temporary, 'bin/npm'), [
    '#!/bin/sh',
    'printf \'%s\\n\' "$*" >> "$SIMFINITY_NPM_LOG"',
    'if [ "$1" = pack ]; then exec "$SIMFINITY_REAL_NPM" "$@"; fi',
    'exit 1',
    '',
  ].join('\n'));
  chmodSync(join(temporary, 'bin/npm'), 0o755);
}, 60000);
afterAll(() => { if (temporary) rmSync(temporary, { recursive: true, force: true }); });

const digestOf = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const consumerCheck = (args, env = {}) => {
  const log = join(temporary, `npm-${runs++}.log`);
  const inherited = { ...process.env };
  delete inherited.SIMFINITY_RELEASE_MANIFEST_SHA256;
  delete inherited.SIMFINITY_RELEASE_COMMIT;
  const result = spawnSync(process.execPath, [script, ...args], {
    env: { ...inherited, PATH: `${join(temporary, 'bin')}${delimiter}${process.env.PATH}`, SIMFINITY_NPM_LOG: log, SIMFINITY_REAL_NPM: realNpm, ...env },
    encoding: 'utf8',
  });
  return { status: result.status, stderr: result.stderr, calls: existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [] };
};
const reachedConsumers = ({ status, calls }, archiveDirectory) => {
  expect(status).toBe(1);
  expect(calls.filter((call) => call.startsWith('pack'))).toEqual([]);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toMatch(/^install --ignore-scripts /);
  expect(calls[0]).toContain(join(archiveDirectory, manifest.packages[0].filename));
};

describe('test:packages archive source (#154)', () => {
  it('consumer-tests exactly the archives of a verified release manifest without packing again', () => {
    reachedConsumers(consumerCheck([join(release, 'manifest.json')]), release);
  }, 60000);

  it('requires the manifest the packing job recorded when a digest is supplied', () => {
    reachedConsumers(consumerCheck([join(release, 'manifest.json')], { SIMFINITY_RELEASE_MANIFEST_SHA256: digestOf(join(release, 'manifest.json')) }), release);
    for (const digest of ['0'.repeat(64), '']) {
      const { status, stderr, calls } = consumerCheck([join(release, 'manifest.json')], { SIMFINITY_RELEASE_MANIFEST_SHA256: digest });
      expect(status).toBe(1);
      expect(stderr).toContain('Release manifest differs from the packed manifest digest');
      expect(calls).toEqual([]);
    }
  }, 60000);

  it('rejects a changed archive before running npm', () => {
    const tampered = join(temporary, 'tampered');
    cpSync(release, tampered, { recursive: true });
    appendFileSync(join(tampered, manifest.packages.at(-1).filename), 'x');
    const { status, stderr, calls } = consumerCheck([join(tampered, 'manifest.json')]);
    expect(status).toBe(1);
    expect(stderr).toContain(`Archive integrity mismatch for ${manifest.packages.at(-1).name}`);
    expect(calls).toEqual([]);
  });

  it('rejects archives packed from another commit than the tested source', () => {
    const other = join(temporary, 'other-commit');
    packRelease(root, other, { commit: 'f'.repeat(40) });
    const stale = consumerCheck([join(other, 'manifest.json')]);
    expect(stale.status).toBe(1);
    expect(stale.stderr).toContain(`Release archives were packed from ${'f'.repeat(40)}, not the tested source ${head}`);
    expect(stale.calls).toEqual([]);
    reachedConsumers(consumerCheck([join(other, 'manifest.json')], { SIMFINITY_RELEASE_COMMIT: 'f'.repeat(40) }), other);
    const mismatch = consumerCheck([join(release, 'manifest.json')], { SIMFINITY_RELEASE_COMMIT: 'e'.repeat(40) });
    expect(mismatch.stderr).toContain(`Release archives were packed from ${head}, not the tested source ${'e'.repeat(40)}`);
    expect(mismatch.calls).toEqual([]);
  }, 60000);

  it('packs the working tree with the release packer when no manifest is given, ignoring a stray digest', () => {
    const { status, calls } = consumerCheck([], { SIMFINITY_RELEASE_MANIFEST_SHA256: '0'.repeat(64) });
    expect(status).toBe(1);
    expect(calls).toHaveLength(8);
    for (const call of calls.slice(0, 7)) expect(call).toMatch(/^pack --json --ignore-scripts --workspaces=false --pack-destination \S+\/release$/);
    expect(calls[7]).toMatch(/^install --ignore-scripts .*\/release\/simtlix-simfinity-core-/);
  }, 60000);

  it('rejects extra arguments before creating temporary files or running npm', () => {
    const empty = join(temporary, 'empty-tmp');
    mkdirSync(empty);
    const { status, stderr, calls } = consumerCheck([join(release, 'manifest.json'), 'extra'], { TMPDIR: empty });
    expect(status).toBe(1);
    expect(stderr).toContain('Usage: node scripts/test-packages.js [<release manifest.json>]');
    expect(calls).toEqual([]);
    expect(readdirSync(empty)).toEqual([]);
  });
});
