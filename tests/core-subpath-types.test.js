import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The packed TypeScript check in scripts/test-packages.js compiles these declarations; this file
// checks the export map and the declared names without packing.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../packages/core');
const mongoRoot = resolve(root, '../mongodb');
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

// Root value declarations: only an explicit `export const`, `export function` or `export class`
// counts, with or without `declare`.
const explicitRootValues = (text) => [...new Set(
  [...text.matchAll(/^export (?:declare )?(?:const|function|class) (\w+)/gm)].map((match) => match[1]),
)].sort();

describe('core root declarations', () => {
  it('exports the root error classes its declarations declare, as the auth namespace classes', async () => {
    const core = await import('@simtlix/simfinity-core');
    const errors = await load['./auth/errors']();
    for (const [name, code, status] of [['ForbiddenError', 'FORBIDDEN', 403], ['UnauthenticatedError', 'UNAUTHENTICATED', 401]]) {
      expect(core[name], name).toBeTypeOf('function');
      expect(core[name], name).toBe(core.auth[name]);
      expect(errors[name], name).toBe(core[name]);
      expect(new core[name]()).toBeInstanceOf(core.SimfinityError);
      expect(new core[name]().extensions).toMatchObject({ code, status });
      expect(rootDeclarations).toMatch(new RegExp(`^export (?:declare )?class ${name} extends SimfinityError\\b`, 'm'));
    }
  });

  it('declares exactly the root runtime value exports, each with an explicit export', async () => {
    const core = await import('@simtlix/simfinity-core');
    expect(explicitRootValues(rootDeclarations)).toEqual(Object.keys(core).sort());
    // A top-level declaration without `export` is exported only while the file has no export
    // lists, so every value the root declares must say `export`.
    expect(rootDeclarations).not.toMatch(/^(?:declare )?(?:abstract )?(?:const|let|var|function|class|enum|namespace) /m);
  });
});

// MongoDB's legacy `src/` deep imports that re-export a core subpath, and that subpath. Their
// declarations are the JavaScript shims without the ObjectId registration import, so they cannot
// drift from core.
const legacySubpaths = {
  'src/auth/index.js': './auth',
  'src/auth/errors.js': './auth/errors',
  'src/auth/expressions.js': './auth/expressions',
  'src/auth/rules.js': './auth/rules',
  'src/plugins.js': './plugins',
  'src/scalars.js': './scalars',
  'src/validators.js': './validators',
};
// Static imports, so the bundler resolves each legacy path through the MongoDB export map.
const loadLegacy = {
  'src/auth/index.js': () => import('@simtlix/simfinity-js/src/auth/index.js'),
  'src/auth/errors.js': () => import('@simtlix/simfinity-js/src/auth/errors.js'),
  'src/auth/expressions.js': () => import('@simtlix/simfinity-js/src/auth/expressions.js'),
  'src/auth/rules.js': () => import('@simtlix/simfinity-js/src/auth/rules.js'),
  'src/plugins.js': () => import('@simtlix/simfinity-js/src/plugins.js'),
  'src/scalars.js': () => import('@simtlix/simfinity-js/src/scalars.js'),
  'src/validators.js': () => import('@simtlix/simfinity-js/src/validators.js'),
};
// The other legacy shims of public API: the root-derived statements of each declaration. `null`
// means the same statements as the JavaScript shim.
const legacyShims = {
  'src/index.js': 'export * from \'../types/index.js\';\n',
  'src/mcp.js': null,
  'src/const/QLOperator.js': null,
  'src/const/QLSort.js': null,
  'src/const/QLValue.js': null,
  'src/errors/simfinity.error.js': null,
  'src/errors/internal-server.error.js': null,
};
const mongoSource = (path) => readFileSync(join(mongoRoot, path), 'utf8');
const siblingOf = (path) => join(mongoRoot, path.replace(/\.js$/, '.d.ts'));
// Files with this suffix under packages/mongodb/src, except the adapter internals in src/mongo.
const legacyFiles = (suffix) => readdirSync(join(mongoRoot, 'src'), { recursive: true })
  .map((file) => `src/${String(file).split('\\').join('/')}`)
  .filter((file) => file.endsWith(suffix) && !file.startsWith('src/mongo/'))
  .sort();

describe('MongoDB legacy deep-import declarations', () => {
  it.each(Object.entries(legacySubpaths))('%s has a sibling that re-exports %s like its module', async (path, subpath) => {
    expect(existsSync(siblingOf(path)), path).toBe(true);
    const shim = mongoSource(path);
    expect(shim).toContain(`export * from '@simtlix/simfinity-core/${subpath.slice(2)}';\n`);
    expect(readFileSync(siblingOf(path), 'utf8')).toBe(shim.replace(/^import '\.\/register-mongo-object-id\.js';\n+/m, ''));
    const legacy = await loadLegacy[path]();
    const core = await load[subpath]();
    expect(Object.keys(legacy).sort()).toEqual(Object.keys(core).sort());
    expect(legacy.default).toBe(core.default);
  });

  it.each(Object.entries(legacyShims))('%s has a root-derived sibling', (path, statements) => {
    expect(existsSync(siblingOf(path)), path).toBe(true);
    const text = readFileSync(siblingOf(path), 'utf8').replace(/^\/\*\*[\s\S]*?\*\/\n/gm, '');
    expect(text).toBe(statements ?? mongoSource(path));
  });

  it('declares every legacy shim of public API and nothing else', () => {
    // The ObjectId registration is a side-effect import, which needs no declaration.
    const shims = legacyFiles('.js').filter((file) => file !== 'src/auth/register-mongo-object-id.js');
    expect(shims).toEqual([...Object.keys(legacySubpaths), ...Object.keys(legacyShims)].sort());
    expect(legacyFiles('.d.ts')).toEqual(shims.map((file) => file.replace(/\.js$/, '.d.ts')).sort());
    // The adapter internals stay undeclared.
    expect(readdirSync(join(mongoRoot, 'src/mongo')).filter((file) => file.endsWith('.ts'))).toEqual([]);
  });
});
