import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Linter } from 'eslint';
import parser from '@typescript-eslint/parser';
import plugin from '../src/index.js';

const auth = "import { createAuthPlugin as protect, composeRules, anyRule, createRule, requireRole, requirePermission, requireAuth } from '@simtlix/simfinity-core/auth';\n";
const lint = (code, typescript = false) => new Linter().verify(code, [{
  ...plugin.configs['recommended-3.8'],
  ...(typescript ? { languageOptions: { parser } } : {}),
}]);
const diagnostic = (code, rule, messageId, typescript = false) => {
  const messages = lint(code, typescript);
  assert.deepEqual(messages.map(message => [message.ruleId, message.messageId]), [[`simfinity/${rule}`, messageId]]);
  assert.equal(messages[0].line, 2);
  assert.equal(messages[0].fix, undefined);
};

describe('permission maps and configured rules (AUTH-02/04)', () => {
  for (const value of ['null', 'undefined', 'false', '1', "'read'", '[]', '/rule/', '() => true', 'class Policy {}']) {
    it(`rejects ${value} as the permission map`, () => diagnostic(auth + `protect(${value});`, 'valid-permissions', 'map'));
    it(`rejects ${value} as a type permission map`, () => diagnostic(auth + `protect({ Book: ${value} });`, 'valid-permissions', 'map'));
  }
  it('requires a permission map argument', () => diagnostic(auth + 'protect();', 'valid-permissions', 'map'));
  for (const value of ['undefined', 'null', '0', "'read'", '1n', '/rule/', '{}', '[]', '[,]', '[true, , false]', '[[[]]]', '[true, [undefined]]']) {
    it(`rejects ${value} in a rule slot`, () => diagnostic(auth + `protect({ Book: { title: ${value} } });`, 'valid-permissions', 'rule'));
  }
  it('reports the actual bad rule location', () => {
    const messages = lint(auth + 'protect({\n  Book: { title: [true, null] },\n});');
    assert.deepEqual(messages.map(message => [message.ruleId, message.line, message.column]), [['simfinity/valid-permissions', 3, 25]]);
  });
  it('supports primitive aliases and TypeScript assertions', () => diagnostic(auth + 'const absent = undefined; protect({ Book: { title: absent } } as const);', 'valid-permissions', 'rule', true));
  const valid = [
    'protect({}); protect({ Book: {} });',
    'protect({ Book: { title: true, summary: false, id: [[true], () => false] } });',
    'protect({ Book: { title: async () => true, summary: function* () {}, id: class Rule {} } });',
    'protect({ Book: { title: { allOf: [] }, summary: { anyOf: [] }, id: { eq: [1, 1] } } });',
    'protect({ Book: { title: customRule, summary: requireAuth(), id: createRule(async () => true) } });',
    'protect({ Book: { title: undefined, title: true } });',
    'protect({ Book: { title: undefined, ...rules } });',
    'protect({ Book: { title: undefined, [field]: true } });',
    'protect({ Book: { get title() { return true; } } });',
    'protect({ Book: { title: [undefined, ...rules] } });',
    'protect({ Book: { title: { get eq() { return [1, 1]; } } } });',
    'protect({ __proto__: null, Book: { title: true } });',
    'protect(Object.create(null));',
    'const map = {}; map.Book = { title: true }; protect(map);',
    'const rules = []; const box = { rules }; box.rules.push(true); protect({ Book: { title: rules } });',
    'const rule = {}; const box = [rule]; box[0].allOf = []; protect({ Book: { title: rule } });',
    'protect(...args);',
    'function f(protect) { protect(null); }',
    'function f(undefined) { protect({ Book: { title: undefined } }); }',
    'const map = load(); protect(map);',
  ];
  for (const code of valid) it(`preserves valid or unknown configuration: ${code}`, () => assert.deepEqual(lint(auth + code), []));
  it('bounds nested rule traversal without crashing', () => {
    const code = auth + `protect({ Book: { title: ${'['.repeat(210)}'bad'${']'.repeat(210)} } });`;
    assert.deepEqual(lint(code), []);
  });
});

describe('composition and predicate contracts (AUTH-06)', () => {
  for (const factory of ['anyRule', 'composeRules', 'createRule']) {
    it(`requires an argument to ${factory}`, () => diagnostic(auth + `${factory}();`, 'valid-auth-composition', 'missing'));
    for (const value of ['false', 'null', 'undefined', '0', "'read'", '{}', '[]', '{ eq: [1, 1] }', '[() => true]', '/rule/']) {
      it(`rejects ${value} in ${factory}`, () => diagnostic(auth + `${factory}(${value});`, 'valid-auth-composition', 'function'));
    }
  }
  it('checks every composition argument', () => diagnostic(auth + 'anyRule(() => true, null);', 'valid-auth-composition', 'function'));
  it('follows primitive aliases', () => diagnostic(auth + 'const invalid = false; composeRules(invalid);', 'valid-auth-composition', 'function'));
  const valid = [
    'anyRule(requireAuth(), custom); composeRules(async () => true, function* () {});',
    'createRule(async () => false, "Denied", "FORBIDDEN");',
    'createRule(class Predicate {});', // typeof is function; whether it can be called is not AUTH-06.
    'const rule = () => true; anyRule(rule);',
    'anyRule(...rules); composeRules(...args, false); createRule(...args);',
    'anyRule(config.rule); createRule(loadPredicate());',
    'function f(anyRule) { anyRule(false); }',
  ];
  for (const code of valid) it(`preserves valid or unknown functions: ${code}`, () => assert.deepEqual(lint(auth + code), []));
});

describe('required role/permission contracts (AUTH-07)', () => {
  for (const factory of ['requireRole', 'requirePermission']) {
    it(`requires a claim in ${factory}`, () => diagnostic(auth + `${factory}();`, 'valid-required-claims', 'invalid'));
    for (const value of ["''", '``', 'null', 'undefined', 'false', '1', '1n', '[]', '[,]', "['read', '']", "['read', undefined]", "[['read']]", '{}', '/claim/', '() => "read"', 'class Claim {}']) {
      it(`rejects ${value} in ${factory}`, () => diagnostic(auth + `${factory}(${value});`, 'valid-required-claims', 'invalid'));
    }
  }
  it('follows primitive aliases', () => diagnostic(auth + "const empty = ''; requireRole(['admin', empty]);", 'valid-required-claims', 'invalid'));
  it('unwraps TypeScript syntax', () => diagnostic(auth + 'requirePermission(["read", ""] as const);', 'valid-required-claims', 'invalid', true));
  const valid = [
    "requireRole('admin'); requireRole(['admin', 'editor']); requirePermission(['read', 'write']);",
    "requireRole(' '); requirePermission([' ', '*']);",
    "requireRole(`admin`); const role = 'admin'; requireRole(role);",
    'requireRole([config.role]); requirePermission(dynamic);',
    "requireRole(['', ...roles]); requirePermission(...permissions);",
    "const roles = []; const box = { roles }; box.roles.push('admin'); requireRole(roles);",
    "const roles = []; roles.push('admin'); requireRole(roles);",
    'function f(requireRole) { requireRole([]); }',
  ];
  for (const code of valid) it(`preserves valid or unknown claims: ${code}`, () => assert.deepEqual(lint(auth + code), []));
});

describe('auth contract provenance and engine parity', () => {
  for (const source of ['@simtlix/simfinity-core', '@simtlix/simfinity-js', '@simtlix/simfinity-postgres', '@simtlix/simfinity-sql']) {
    it(`checks the shared auth namespace from ${source}`, () => {
      const code = `import { auth } from '${source}';\nauth.createAuthPlugin({ Book: { id: [] } }); auth.anyRule(false); auth.requireRole([]);`;
      assert.deepEqual(lint(code).map(message => message.ruleId), ['simfinity/valid-permissions', 'simfinity/valid-auth-composition', 'simfinity/valid-required-claims']);
    });
  }
  it('supports runtime auth methods and destructured aliases', () => diagnostic("import { createPostgres } from '@simtlix/simfinity-postgres';\nconst rt = createPostgres(); const { requireRole: claim } = rt.auth; const alias = claim; alias([]);", 'valid-required-claims', 'invalid'));
  it('supports the MongoDB legacy auth entry', () => diagnostic("import auth from '@simtlix/simfinity-js/src/auth/index.js';\nauth.createRule(null);", 'valid-auth-composition', 'function'));
  for (const code of [
    "import { requireRole } from 'other'; requireRole([]);",
    "import { auth } from '@simtlix/simfinity-postgres'; auth.requireRole = custom; auth.requireRole([]);",
    "import { auth } from '@simtlix/simfinity-postgres'; const alias = auth; alias.createAuthPlugin = custom; auth.createAuthPlugin(null);",
    "import { auth } from '@simtlix/simfinity-postgres'; decorate(auth); auth.anyRule(false);",
    "import { auth } from '@simtlix/simfinity-postgres'; const box = { auth }; box.auth.anyRule = custom; auth.anyRule(false);",
    "import { auth } from '@simtlix/simfinity-postgres'; ({ method: auth.requireRole } = custom); auth.requireRole([]);",
    "import { auth } from '@simtlix/simfinity-postgres'; for (auth.requireRole of methods) {} auth.requireRole([]);",
  ]) it(`does not guess a changed or foreign API: ${code}`, () => assert.deepEqual(lint(code), []));
});
