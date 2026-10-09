import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const appRoot = fileURLToPath(new URL('..', import.meta.url));
const configFile = path.join(appRoot, 'eslint.config.mjs');
const linkRule = '@next/next/no-html-link-for-pages';

const lintLink = async (cwd, href, rootDir) => {
  const eslint = new ESLint({
    cwd,
    overrideConfigFile: configFile,
    ...(rootDir === undefined ? {} : { overrideConfig: { settings: { next: { rootDir } } } }),
  });
  const [result] = await eslint.lintText(
    `export default function Example() { return <a href="${href}">Visit</a>; }`,
    { filePath: path.join(cwd, 'example.jsx') },
  );
  assert.equal(result.fatalErrorCount, 0);
  return result.messages.filter((message) => message.ruleId === linkRule);
};

test('Next lint still rejects internal anchors with the default application root', async () => {
  assert.equal((await lintLink(appRoot, '/')).length, 1);
  assert.equal((await lintLink(appRoot, 'https://example.com/')).length, 0);
});

test('Next lint resolves wildcard, brace and array rootDir settings', async (t) => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), 'barber-eslint-'));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  for (const [app, route] of [['shop', 'booking'], ['admin', 'users']]) {
    const pages = path.join(fixture, 'apps', app, 'pages');
    await mkdir(pages, { recursive: true });
    await writeFile(path.join(pages, `${route}.jsx`), 'export default function Page() { return null; }');
  }
  const unrelated = path.join(fixture, 'archive', 'pages');
  await mkdir(unrelated, { recursive: true });
  await writeFile(path.join(unrelated, 'archived.jsx'), 'export default function Page() { return null; }');

  const patterns = [
    path.join(fixture, 'apps', '*'),
    path.join(fixture, 'apps', '{shop,admin}'),
    [path.join(fixture, 'apps', 'sh*'), path.join(fixture, 'apps', 'adm*')],
  ];
  for (const rootDir of patterns) {
    assert.equal((await lintLink(fixture, '/booking', rootDir)).length, 1);
    assert.equal((await lintLink(fixture, '/users', rootDir)).length, 1);
    assert.equal((await lintLink(fixture, '/archived', rootDir)).length, 0);
  }
});
