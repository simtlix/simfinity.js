import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The packed TypeScript check in scripts/test-packages.js compiles these declarations; this file
// checks the export map and the declared names without packing.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../packages/core');
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const rootDeclarations = readFileSync(join(root, 'types/index.d.ts'), 'utf8');

// Each public subpath: its runtime module, its declaration file and the root types it re-exports.
const publicSubpaths = {
  './auth': {
    target: './src/auth/index.js',
    types: './types/auth/index.d.ts',
    rootTypes: [
      'AuthPluginOptions', 'AuthRule', 'AuthRuleFunction', 'EnvelopSchemaPlugin', 'PermissionSchema',
      'PolicyExpression', 'TypePermissions',
    ],
  },
  './auth/errors': { target: './src/auth/errors.js', types: './types/auth/errors.d.ts', rootTypes: [] },
  './auth/expressions': {
    target: './src/auth/expressions.js',
    types: './types/auth/expressions.d.ts',
    rootTypes: ['PolicyExpression'],
  },
  './auth/rules': { target: './src/auth/rules.js', types: './types/auth/rules.d.ts', rootTypes: ['AuthRuleFunction'] },
  './plugins': {
    target: './src/plugins.js',
    types: './types/plugins.d.ts',
    rootTypes: ['AuthPluginOptions', 'EnvelopSchemaPlugin', 'PermissionSchema'],
  },
  './scalars': { target: './src/scalars.js', types: './types/scalars.d.ts', rootTypes: [] },
  './validators': {
    target: './src/validators.js',
    types: './types/validators.d.ts',
    rootTypes: ['FieldValidations', 'FieldValidator', 'ItemValidators'],
  },
};
// Static imports, so the bundler resolves each subpath through the export map.
const load = {
  './auth': () => import('@simtlix/simfinity-core/auth'),
  './auth/errors': () => import('@simtlix/simfinity-core/auth/errors'),
  './auth/expressions': () => import('@simtlix/simfinity-core/auth/expressions'),
  './auth/rules': () => import('@simtlix/simfinity-core/auth/rules'),
  './plugins': () => import('@simtlix/simfinity-core/plugins'),
  './scalars': () => import('@simtlix/simfinity-core/scalars'),
  './validators': () => import('@simtlix/simfinity-core/validators'),
};
const declarationOf = (subpath) => readFileSync(join(root, publicSubpaths[subpath].types), 'utf8');

// Value exports a declaration file declares: `export const`, `export default`, and the names of
// `export { ... } from` lists. Type-only `export type { ... }` lists are skipped.
const declaredValues = (text) => {
  const names = new Set([...text.matchAll(/^export const (\w+)/gm)].map((match) => match[1]));
  for (const [, list] of text.matchAll(/^export \{([^}]*)\}/gm)) {
    for (const name of list.split(',').map((item) => item.trim()).filter(Boolean)) names.add(name);
  }
  if (/^export default /m.test(text)) names.add('default');
  return [...names].sort();
};

// Names of `export type { ... } from '<root>'` lists.
const reexportedRootTypes = (text) => [...text.matchAll(/^export type \{([^}]*)\} from '\.\.?\/index\.js'/gm)]
  .flatMap(([, list]) => list.split(',').map((item) => item.trim()).filter(Boolean))
  .sort();

describe('core subpath type declarations', () => {
  it.each(Object.entries(publicSubpaths))('%s has a types condition first and keeps its runtime target', (subpath, { target, types }) => {
    const entry = manifest.exports[subpath];
    expect(entry).toBeTypeOf('object');
    expect(Object.keys(entry)).toEqual(['types', 'default']);
    expect(entry.default).toBe(target);
    expect(entry.types).toBe(types);
    expect(existsSync(join(root, entry.types))).toBe(true);
  });

  it('keeps the internal subpaths untyped and unchanged', () => {
    expect(manifest.exports['./internal/object-id']).toBe('./src/auth/object-id.js');
    expect(manifest.exports['./internal/relation-storage']).toBe('./src/relation-storage.js');
  });

  it('maps exactly the public subpaths in typesVersions, to the same declarations, for Node10 resolution', () => {
    const expected = Object.fromEntries(Object.entries(publicSubpaths).map(([subpath, { types }]) => (
      [subpath.slice(2), [types.slice(2)]]
    )));
    expect(manifest.typesVersions).toEqual({ '*': expected });
    expect(manifest.types).toBe('./types/index.d.ts');
    expect(manifest.exports['.']).toEqual({ types: './types/index.d.ts', default: './src/index.js' });
  });

  it.each(Object.keys(publicSubpaths))('%s declares exactly its runtime value exports', async (subpath) => {
    const runtime = await load[subpath]();
    expect(declaredValues(declarationOf(subpath))).toEqual(Object.keys(runtime).sort());
  });

  it.each(Object.entries(publicSubpaths))('%s re-exports its related root types', (subpath, { rootTypes }) => {
    expect(reexportedRootTypes(declarationOf(subpath))).toEqual([...rootTypes].sort());
    for (const name of rootTypes) {
      expect(rootDeclarations, name).toMatch(new RegExp(`^export (type|interface) ${name}\\b`, 'm'));
    }
  });

  it('derives every subpath member from the root namespaces instead of restating signatures', () => {
    for (const subpath of Object.keys(publicSubpaths)) {
      const text = declarationOf(subpath);
      for (const [, name, type] of text.matchAll(/^export const (\w+): ([^;]+);/gm)) {
        expect(type, `${subpath} ${name}`).toMatch(new RegExp(`^typeof (auth|plugins|scalars|validators)\\.${name}$`));
      }
    }
  });

  it('shares runtime identity between the subpath defaults and the root namespaces', async () => {
    const core = await import('@simtlix/simfinity-core');
    for (const name of ['auth', 'plugins', 'scalars', 'validators']) {
      expect((await load[`./${name}`]()).default).toBe(core[name]);
    }
  });
});
