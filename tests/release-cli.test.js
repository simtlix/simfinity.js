import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isEntryPoint } from '../scripts/cli.js';

// Git fixtures and spawned CLIs can exceed the default 5 s while the full suite loads the machine.
vi.setConfig({ testTimeout: 30000 });

const scripts = realpathSync(fileURLToPath(new URL('../scripts/', import.meta.url)));
const directories = [];
// Real paths, so that relative entries computed here match what the child resolves.
const temporary = () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'simfinity-cli-')));
  directories.push(directory);
  return directory;
};
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

// Each CLI fails before any registry, git or archive access with these arguments.
const clis = [
  ['release-state.js', ['verify-current', 'not-a-version'], /^Invalid release version$/],
  ['release-packages.js', ['unknown-command'], /^Usage: node scripts\/release-packages\.js /],
  ['publish-packages.js', [], /^Usage: node scripts\/publish-packages\.js /],
  ['verify-published.js', [], /^Usage: node scripts\/verify-published\.js /],
  ['github-release.js', [], /^Usage: node scripts\/github-release\.js find <tag>$/],
  ['release-eslint-plugin.js', [], /^Usage: release-eslint-plugin\.js /],
];
const invocations = {
  'its real path': () => (file) => join(scripts, file),
  'a symlinked directory': (directory) => {
    symlinkSync(scripts, join(directory, 'linked'), 'dir');
    return (file) => join(directory, 'linked', file);
  },
  'a symlinked file': (directory) => (file) => {
    const link = join(directory, file);
    symlinkSync(join(scripts, file), link);
    return link;
  },
  'its path without the extension': () => (file) => join(scripts, file.replace(/\.js$/, '')),
  'a relative path from another directory': (directory) => (file) => relative(directory, join(scripts, file)),
  'a relative path through a symlinked directory': (directory) => {
    symlinkSync(scripts, join(directory, 'linked'), 'dir');
    return (file) => join('linked', file);
  },
};

describe('release CLIs run however Node is pointed at them', () => {
  for (const [label, prepare] of Object.entries(invocations)) {
    it.each(clis)(`runs %s through ${label}`, (file, args, message) => {
      const directory = temporary();
      const entry = prepare(directory)(file);
      const result = spawnSync(process.execPath, [entry, ...args], { cwd: directory, encoding: 'utf8', timeout: 30000 });
      expect({ status: result.status, stderr: result.stderr.trim().split('\n')[0] }).toEqual({ status: 1, stderr: expect.stringMatching(message) });
      expect(result.stdout).toBe('');
    });
  }

  it('only imports the release scripts when Node runs other code with a sibling-named argument', () => {
    const directory = temporary();
    const imports = clis.map(([file]) => `await import(${JSON.stringify(pathToFileURL(join(scripts, file)).href)});`).join(' ');
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `${imports} console.log(process.argv[1]);`, './release-state.js', 'verify-current', 'not-a-version'], { cwd: directory, encoding: 'utf8', timeout: 30000 });
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({ status: 0, stdout: './release-state.js\n', stderr: '' });
  });

  it('leaves entry-point detection to isEntryPoint in every script', () => {
    const raw = readdirSync(scripts).filter((file) => file.endsWith('.js') && file !== 'cli.js' && readFileSync(join(scripts, file), 'utf8').includes('process.argv[1]'));
    expect(raw).toEqual([]);
    for (const [file] of clis) expect(readFileSync(join(scripts, file), 'utf8')).toContain('if (isEntryPoint(import.meta.url)) {');
  });
});

describe('entry point detection', () => {
  const script = join(scripts, 'release-state.js');
  const url = pathToFileURL(script).href;

  it('matches the module through its own, symlinked, extensionless and relative paths', () => {
    const directory = temporary();
    const link = join(directory, 'linked.js');
    symlinkSync(script, link);
    for (const entry of [script, link, script.replace(/\.js$/, ''), relative(process.cwd(), script)]) expect(isEntryPoint(url, entry)).toBe(true);
  });

  it('resolves a relative entry against the working directory, not the module directory', () => {
    expect(resolve('./release-state.js')).not.toBe(script);
    expect(isEntryPoint(url, './release-state.js')).toBe(false);
  });

  it.each([
    ['no entry', undefined],
    ['an empty entry', ''],
    ['another script', join(scripts, 'release-packages.js')],
    ['a missing file', join(scripts, 'missing-release-script.js')],
  ])('does not match %s', (label, entry) => {
    expect(isEntryPoint(url, entry)).toBe(false);
  });

  it('treats the test runner as an importer', () => {
    expect(isEntryPoint(url)).toBe(false);
  });
});
