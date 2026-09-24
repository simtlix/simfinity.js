import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkPackageQuality } from '../scripts/package-quality.js';

const roots = [];
const fixture = (edit = () => {}) => {
  const root = mkdtempSync(join(tmpdir(), 'simfinity-quality-test-'));
  roots.push(root);
  mkdirSync(join(root, 'src'));
  mkdirSync(join(root, 'types'));
  writeFileSync(join(root, 'src/index.js'), 'export const ready = true;\n');
  writeFileSync(join(root, 'types/index.d.ts'), 'export declare const ready: boolean;\n');
  writeFileSync(join(root, 'README.md'), '# Fixture\n');
  writeFileSync(join(root, 'LICENSE'), 'Apache-2.0\n');
  const manifest = {
    name: '@simtlix/quality-fixture',
    version: '1.0.0',
    type: 'module',
    main: './src/index.js',
    types: './types/index.d.ts',
    exports: { '.': { types: './types/index.d.ts', default: './src/index.js' } },
    files: ['src', 'types', 'README.md', 'LICENSE'],
    keywords: ['graphql'],
    license: 'Apache-2.0',
    repository: { type: 'git', url: 'https://github.com/simtlix/simfinity.js' },
  };
  edit(manifest, root);
  writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
  return root;
};

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('packed package quality gate', () => {
  test('accepts a complete ESM package with shipped declarations', () => {
    expect(() => checkPackageQuality(fixture())).not.toThrow();
  });

  test.each(['exports', 'keywords'])('rejects missing %s metadata', (field) => {
    expect(() => checkPackageQuality(fixture((manifest) => { delete manifest[field]; }))).toThrow();
  });

  test('rejects an empty keyword array', () => {
    expect(() => checkPackageQuality(fixture((manifest) => { manifest.keywords = []; }))).toThrow();
  });

  test.each(['README.md', 'LICENSE', 'src/index.js', 'types/index.d.ts'])('rejects an archive missing %s', (file) => {
    expect(() => checkPackageQuality(fixture((manifest, root) => { rmSync(join(root, file)); }))).toThrow();
  });

  test.each(['main', 'types'])('rejects a %s declaration pointing outside the archive', (field) => {
    expect(() => checkPackageQuality(fixture((manifest) => { manifest[field] = '../package.json'; }))).toThrow();
  });
});
