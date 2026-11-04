import { describe, expect, it } from 'vitest';
import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const createLinter = () => new ESLint({ cwd: root, overrideConfigFile: 'eslint.config.mjs' });

describe('repository lint configuration', () => {
  it.each([
    'packages/core/src/runtime.js',
    'packages/mongodb/src/mongo/adapter.js',
    'scripts/release-packages.js',
    'tests/runtime.test.js',
  ])('checks source files at %s with the existing rules and Node globals', async (filePath) => {
    const eslint = createLinter();
    expect(await eslint.isPathIgnored(filePath)).toBe(false);
    const [valid] = await eslint.lintText('export const version = process.version;\n', { filePath });
    expect(valid.messages).toEqual([]);
    const [invalid] = await eslint.lintText('var unused = missingGlobal\n', { filePath });
    expect(invalid.messages.map(message => message.ruleId)).toEqual(expect.arrayContaining([
      'no-var', 'no-unused-vars', 'no-undef', 'semi',
    ]));
  });

  it.each([
    'node_modules/dependency/index.js',
    '.claude/worktrees/another-task/index.js',
    'examples/barber/mongodb/index.js',
    'examples/barber/frontend/src/example.js',
    'docs/.vitepress/dist/assets/example.js',
    'docs/.vitepress/cache/example.js',
    'docs/.vitepress/.temp/example.js',
    'data/example.js',
    'eslint.config.mjs',
  ])('keeps %s outside the root lint scope', async (filePath) => {
    expect(await createLinter().isPathIgnored(filePath)).toBe(true);
  });
});
