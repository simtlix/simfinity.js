import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Linter } from 'eslint';
import parser from '@typescript-eslint/parser';
import plugin from '../src/index.js';

const auth = "import { requireAuth, requireRole, requirePermission, isOwner, createRule, createAuthPlugin } from '@simtlix/simfinity-core/auth';\n";
const mongo = "import * as sf from '@simtlix/simfinity-js';\n";
const lint = (code, typescript = false) => new Linter().verify(code, [{
  ...plugin.configs['recommended-3.8'],
  ...(typescript ? { languageOptions: { parser } } : {}),
}]);
const reports = (code, rule, typescript = false) => {
  const messages = lint(code, typescript);
  assert.deepEqual(messages.map(message => [message.ruleId, message.messageId]), [[`simfinity/${rule}`, 'invalid']]);
  assert.equal(messages[0].fix, undefined);
  assert.equal(messages[0].suggestions, undefined);
};

describe('synchronous authorization extractors (AUTH-08)', () => {
  for (const extractor of ['async ctx => ctx.user', 'async function (ctx) { return ctx.user; }', 'async function* () { yield user; }']) {
    for (const call of [
      `requireAuth(${extractor})`,
      `requireRole('admin', { userPath: ${extractor} })`,
      `requireRole('admin', { rolePath: ${extractor} })`,
      `requirePermission('read', { userPath: ${extractor} })`,
      `requirePermission('read', { permissionsPath: ${extractor} })`,
      `isOwner(${extractor})`,
      `isOwner('ownerId', ${extractor})`,
      `isOwner('ownerId', 'id', { userPath: ${extractor} })`,
    ]) it(`reports ${call}`, () => reports(auth + call, 'no-async-auth-extractor'));
  }
  it('follows stable const function aliases', () => reports(auth + 'const extract = async c => c.user; const alias = extract; requireAuth(alias);', 'no-async-auth-extractor'));
  it('unwraps TypeScript assertions', () => reports(auth + 'requireRole("admin", { rolePath: (async u => u.role) as Extractor } satisfies Options);', 'no-async-auth-extractor', true));
  it('reports the extractor at its use, not its declaration', () => {
    const messages = lint(auth + 'const extract = async c => c.user;\nrequireAuth(extract);');
    assert.deepEqual(messages.map(message => [message.ruleId, message.line, message.column]), [['simfinity/no-async-auth-extractor', 3, 13]]);
  });
  it('uses the last duplicate property', () => reports(auth + 'requireRole("admin", { rolePath: "role", rolePath: async u => u.role });', 'no-async-auth-extractor'));
  for (const code of [
    'requireAuth(); requireAuth("session.user"); requireAuth(c => c.user);',
    'requireRole("admin", { userPath: c => c.user, rolePath: u => u.role });',
    'requirePermission("read", { permissionsPath: u => u.permissions });',
    'isOwner(p => p.ownerId, u => u.id, { userPath: c => c.user });',
    'createRule(async (_p, _a, ctx) => Boolean(await load(ctx)));',
    'createAuthPlugin({ Book: { title: async () => true } });',
    'requireAuth(function* () { yield user; });', // The runtime only rejects async function tags.
    'requireAuth(c => Promise.resolve(c.user));', // Return-value inference is outside this batch.
    'requireRole("admin", { rolePath: async u => u.role, rolePath: "role" });',
    'requireRole("admin", { unrelated: async () => true });',
    'requireRole("admin", { rolePath: async u => u.role, ...options });',
    'requireRole("admin", { [key]: async u => u.role });',
    'requireRole("admin", { get rolePath() { return async u => u.role; } });',
    'requireRole("admin", { async rolePath(u) { return u.role; } });', // Method syntax is outside the plain-literal analysis.
    'const options = { rolePath: async u => u.role }; options.rolePath = "role"; requireRole("admin", options);',
    'let extract = async c => c.user; extract = c => c.user; requireAuth(extract);',
    'const extract = async c => c.user; decorate(extract); requireAuth(extract);',
    'const extract = async c => c.user; const alias = extract; alias.tag = "custom"; requireAuth(extract);',
    'requireAuth(imported); requireAuth(config.extract); requireAuth(loadExtractor());',
    'async function extract(c) { return c.user; } requireAuth(extract);',
    'requireAuth(...args); requireRole(...args, { rolePath: async u => u.role });',
    'function f(requireAuth) { requireAuth(async c => c.user); }',
    'const extract = c => c.user; function f(extract) { requireAuth(extract); }',
  ]) it(`preserves valid or unknown syntax: ${code}`, () => assert.deepEqual(lint(auth + code), []));
});

describe('Envelop authorization plugins are not runtime middleware (AUTH-14)', () => {
  const runtimes = [
    mongo,
    "import { use as middleware } from '@simtlix/simfinity-js/src/index.js';\n",
    "import * as sf from '@simtlix/simfinity-postgres';\n",
    "import { createRuntime } from '@simtlix/simfinity-core'; const sf = createRuntime(adapter);\n",
    "import { createSQL } from '@simtlix/simfinity-sql'; const sf = createSQL({ plugin });\n",
    "import { createPostgres } from '@simtlix/simfinity-postgres'; const sf = createPostgres();\n",
  ];
  for (const runtime of runtimes) it(`recognizes ${runtime.trim()}`, () => reports(auth + runtime + `${runtime.includes('middleware') ? 'middleware' : 'sf.use'}(createAuthPlugin({}));`, 'no-auth-plugin-as-middleware'));
  it('follows stable aliases for both the plugin and use', () => reports(auth + mongo + 'const register = sf.use; const protect = createAuthPlugin; const plugin = protect({}); const alias = plugin; register(alias);', 'no-auth-plugin-as-middleware'));
  it('supports a runtime auth namespace and destructuring', () => reports("import { createPostgres } from '@simtlix/simfinity-postgres'; const sf = createPostgres(); const { createAuthPlugin: protect } = sf.auth; sf.use(protect({}));", 'no-auth-plugin-as-middleware'));
  it('unwraps TypeScript syntax', () => reports(auth + mongo + 'sf.use(createAuthPlugin({}) as unknown as Middleware);', 'no-auth-plugin-as-middleware', true));
  it('reports the actual middleware argument', () => {
    const messages = lint(auth + mongo + 'const plugin = createAuthPlugin({});\nsf.use(plugin);');
    assert.deepEqual(messages.map(message => [message.ruleId, message.line, message.column]), [['simfinity/no-auth-plugin-as-middleware', 4, 8]]);
  });
  for (const code of [
    'sf.use(async (operation, context, next) => next());',
    'const plugin = createAuthPlugin({}); createYoga({ schema, plugins: [plugin] });',
    'const plugin = createAuthPlugin({}); envelop({ plugins: [plugin] });',
    'sf.use(createAuthPlugin);', // A bare factory is a function; contextual misuse is a separate follow-up.
    'sf.use(wrap(createAuthPlugin({})));',
    'sf.use(importedPlugin); sf.use(config.plugin);',
    'sf.use(middleware, createAuthPlugin({}));', // use reads only its first argument.
    'sf.use(...args, createAuthPlugin({}));',
    'sf.use(createAuthPlugin(...args));',
    'function f(sf) { sf.use(createAuthPlugin({})); }',
    'function f(createAuthPlugin) { sf.use(createAuthPlugin({})); }',
    'const plugin = createAuthPlugin({}); function f(plugin) { sf.use(plugin); }',
    'let plugin = createAuthPlugin({}); plugin = middleware; sf.use(plugin);',
    'sf.use = custom; sf.use(createAuthPlugin({}));',
    'const alias = sf; alias.use = custom; sf.use(createAuthPlugin({}));',
    'decorate(sf); sf.use(createAuthPlugin({}));',
    'const box = { sf }; box.sf.use = custom; sf.use(createAuthPlugin({}));',
  ]) it(`preserves valid or unknown integration: ${code}`, () => assert.deepEqual(lint(auth + mongo + code), []));
  it('does not mistake foreign factories for Simfinity', () => assert.deepEqual(lint(mongo + "import { createAuthPlugin } from 'other'; sf.use(createAuthPlugin({}));"), []));
  it('does not mistake foreign use for Simfinity', () => assert.deepEqual(lint(auth + "import { use } from 'other'; use(createAuthPlugin({}));"), []));
});

describe('extractor import provenance and engine parity', () => {
  for (const source of ['@simtlix/simfinity-core', '@simtlix/simfinity-js', '@simtlix/simfinity-sql', '@simtlix/simfinity-postgres']) {
    it(`recognizes auth from ${source}`, () => reports(`import { auth } from '${source}'; const { requireAuth: requireUser } = auth; requireUser(async c => c.user);`, 'no-async-auth-extractor'));
  }
  it('recognizes legacy Mongo auth imports', () => reports("import auth from '@simtlix/simfinity-js/src/auth/index.js'; auth.requireAuth(async c => c.user);", 'no-async-auth-extractor'));
  for (const code of [
    "import { requireAuth } from 'other'; requireAuth(async c => c.user);",
    "import { auth } from '@simtlix/simfinity-core'; auth.requireAuth = custom; auth.requireAuth(async c => c.user);",
    "import { auth } from '@simtlix/simfinity-core'; decorate(auth); auth.requireAuth(async c => c.user);",
  ]) it(`skips changed or foreign factories: ${code}`, () => assert.deepEqual(lint(code), []));
});
