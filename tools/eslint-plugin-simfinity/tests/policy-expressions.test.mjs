import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Linter } from 'eslint';
import parser from '@typescript-eslint/parser';
import plugin from '../src/index.js';

const imports = "import { createAuthPlugin as protect, createRuleFromExpression as policy } from '@simtlix/simfinity-core/auth';\n";
const lint = (code, typescript = false) => new Linter().verify(code, [{
  ...plugin.configs['recommended-3.8'],
  ...(typescript ? { languageOptions: { parser } } : {}),
}]);
const diagnostic = (code, messageId, typescript = false) => {
  const messages = lint(imports + code, typescript);
  assert.deepEqual(messages.map(message => [message.ruleId, message.messageId]), [['simfinity/valid-policy-expression', messageId]]);
  assert.equal(messages[0].fix, undefined);
  assert.equal(messages[0].suggestions, undefined);
};

describe('policy expression syntax (AUTH-11)', () => {
  const invalid = [
    ['{ equal: [1, 1] }', 'operator'],
    ['{ eq: [1] }', 'comparison'],
    ['{ eq: [1, 1, 1] }', 'comparison'],
    ['{ eq: [, 1] }', 'comparison'],
    ['{ eq: null }', 'comparison'],
    ['{ in: {} }', 'comparison'],
    ['{ allOf: true }', 'logical'],
    ['{ anyOf: [, true] }', 'logical'],
    ['{ anyOf: [true, { wrong: true }] }', 'operator'],
    ['{ not: {} }', 'expression'],
    ['{ not: [] }', 'expression'],
    ['{ not: null }', 'expression'],
    ['{ allOf: [false, { not: "admin" }] }', 'expression'],
    ["{ eq: [{ ref: 'context.user.id' }, 1] }", 'reference'],
    ["{ eq: [{ ref: 'ctx..id' }, 1] }", 'reference'],
    ["{ eq: [{ ref: 'ctx.constructor.name' }, 1] }", 'reference'],
    ["{ eq: [{ ref: 'ctx.__proto__' }, 1] }", 'reference'],
    ["{ eq: [{ ref: 'parent.prototype.id' }, 1] }", 'reference'],
    ['{ eq: [{ ref: 1 }, 1] }', 'reference'],
    ['{ eq: [{ ref: [] }, 1] }', 'reference'],
    ['{ eq: [{ ref: {} }, 1] }', 'reference'],
    ['{ eq: [{ ref: /ctx/ }, 1] }', 'reference'],
    ['{ eq: [{ ref: () => "ctx.id" }, 1] }', 'reference'],
    ["{ eq: [{ ref: 'ctx.id', extra: true }, 1] }", 'reference'],
    ["{ in: [{ ref: 'ctx.id' }, [{ ref: 'parent.id' }]] }", 'nestedReference'],
    ["{ eq: [{ data: [{ ref: 'args.id' }] }, null] }", 'nestedReference'],
    ['{ eq: [undefined, 1] }', 'operand'],
    ['{ eq: [1, NaN] }', 'operand'],
    ['{ eq: [() => true, true] }', 'operand'],
    ['{ in: [1, null] }', 'membership'],
    ['{ in: [1, {}] }', 'membership'],
    ['{ in: [1, [, 1]] }', 'membership'],
    ['{ in: [1, [Infinity]] }', 'membership'],
    ['{ in: [1, [undefined]] }', 'membership'],
    ['{ in: [1, [{}]] }', 'membership'],
    ['{ in: [1, [[1]]] }', 'membership'],
    ['{ in: [1, [/one/]] }', 'membership'],
    ['{ in: [1, [() => true]] }', 'membership'],
  ];
  for (const [expression, messageId] of invalid) {
    it(`rejects factory expression ${expression}`, () => diagnostic(`policy(${expression});`, messageId));
    it(`rejects permission expression ${expression}`, () => diagnostic(`protect({ Book: { id: [true, [${expression}]] } });`, messageId));
  }
  for (const expression of ['', '{}', 'null', 'undefined', '1', '[]', '/policy/', '() => true', 'class Policy {}']) {
    it(`rejects non-expression factory input ${expression || '(missing)'}`, () => diagnostic(`policy(${expression});`, 'expression'));
  }
  it('reports the exact invalid reference location', () => {
    const messages = lint(imports + "policy({\n  eq: [{ ref: 'context.id' }, 1],\n});");
    assert.deepEqual(messages.map(message => [message.ruleId, message.line, message.column]), [['simfinity/valid-policy-expression', 3, 15]]);
  });
  it('uses the final duplicate property', () => diagnostic('policy({ eq: [1, 1], eq: [1] });', 'comparison'));
  it('follows safe primitive constants', () => diagnostic("const path = 'context.id'; policy({ eq: [{ ref: path }, 1] });", 'reference'));
  it('checks TypeScript assertions and satisfies expressions', () => diagnostic("policy(({ eq: [{ ref: 'context.id' as const }, 1] } satisfies Policy)!);", 'reference', true));
});

describe('policy precision and legitimate alternatives', () => {
  const valid = [
    'policy(true); policy(false);',
    'policy({ allOf: [] }); policy({ anyOf: [] }); policy({ not: false });',
    'policy({ eq: [null, null], allOf: [true], not: { anyOf: [] } });',
    "policy({ eq: [{ ref: 'ctx' }, { ref: 'parent.items.0.id' }] });",
    "policy({ in: [{ ref: 'args.id' }, { ref: 'ctx.allowedIds' }] });",
    "policy({ in: [{ ref: 'ctx.id' }, [null, false, 0, '', 1n, -1, +2]] });",
    'policy({ in: [1, []] }); policy({ eq: [Infinity, Infinity] });',
    'policy({ eq: [{ id: 1, data: [undefined, , 1] }, {}] });',
    'policy({ eq: [/a/, /a/] }); policy({ eq: [new Date(), new Date()] });',
    "policy({ not: { eq: [1, '1'] } });", // AUTH-12: well-formed AST, invalid runtime comparison.
    "policy({ eq: [{ ref: 'context.id', ref: 'ctx.id' }, 1] });",
    'policy({ eq: [1], eq: [1, 1] });',
    'protect({ Book: { id: [true, { allOf: [] }, async () => true] } });',
    'policy(dynamic); policy(loadPolicy());',
    'const expression = {}; const box = { expression }; box.expression.allOf = []; policy(expression);',
    'const operands = []; operands.push(1, 1); policy({ eq: operands });',
    "const reference = { ref: 'context.id' }; const box = [reference]; box[0].ref = 'ctx.id'; policy({ eq: [reference, 1] });",
    "policy({ eq: [{ ref: configuredPath }, 1] }); policy({ in: [1, allowedValues] });",
    'policy({ allOf: [unknownPolicy] }); policy({ eq: [unknown, 1] });',
    'policy({ invalid: true, ...dynamic }); policy({ [operator]: [] });',
    'policy({ eq: [1, ...operands] }); policy({ anyOf: [null, ...rules] });',
    'policy({ in: [1, [undefined, ...allowed]] });',
    'policy({ get eq() { throw new Error("must not execute"); } });',
    'policy({ eq() { throw new Error("must not execute"); } });',
    "policy({ eq: [{ get ref() { return 'ctx.id'; } }, 1] });",
    'policy({ __proto__: null, allOf: [] });',
    'policy(...expressions);',
    'function f(policy) { policy({ invalid: true }); }',
    'function f(undefined, NaN, Infinity) { policy({ eq: [undefined, NaN] }); policy({ in: [1, [Infinity]] }); }',
    "const path = 'ctx.id'; policy({ eq: [{ ref: path }, 1] });",
    'let path = "context.id"; path = getPath(); policy({ eq: [{ ref: path }, 1] });',
    'protect({ Book: { id: { invalid: true }, ...fields } });',
    'protect({ Book: { id: [{ invalid: true }, ...rules] } });',
    'const permissions = { Book: { id: { invalid: true } } }; configure(permissions); protect(permissions);',
  ];
  for (const code of valid) it(`preserves valid or unknown syntax: ${code}`, () => assert.deepEqual(lint(imports + code), []));
  it('avoids duplicate errors from valid-permissions', () => {
    const messages = lint(imports + 'protect({ Book: { id: {}, title: null, other: [] } });');
    assert.deepEqual(messages.map(message => message.ruleId), Array(3).fill('simfinity/valid-permissions'));
  });
  it('keeps validation/evaluation helpers available for intentional invalid input', () => {
    assert.deepEqual(lint("import { isPolicyExpression, evaluateExpression } from '@simtlix/simfinity-core/auth/expressions'; isPolicyExpression({ wrong: true }); evaluateExpression({ wrong: true }, {});"), []);
  });
  it('bounds deep expression traversal and resets the budget for each call', () => {
    const code = imports + `policy(${'{ not: '.repeat(220)}{ wrong: true }${'}'.repeat(220)}); policy({ wrong: true });`;
    assert.deepEqual(lint(code).map(message => message.ruleId), ['simfinity/valid-policy-expression']);
  });
  it('bounds large arrays even when their entries are not traversable expressions', () => {
    assert.deepEqual(lint(imports + `policy({ allOf: [${'unknown,'.repeat(210)}{ wrong: true }] });`), []);
  });
});

describe('policy API provenance and engine parity', () => {
  for (const source of ['@simtlix/simfinity-core', '@simtlix/simfinity-js', '@simtlix/simfinity-postgres', '@simtlix/simfinity-sql']) {
    it(`checks the shared auth namespace from ${source}`, () => {
      assert.deepEqual(lint(`import { auth } from '${source}'; auth.createRuleFromExpression({ wrong: true }); auth.createAuthPlugin({ Book: { id: { eq: [1] } } });`).map(message => message.ruleId), Array(2).fill('simfinity/valid-policy-expression'));
    });
  }
  for (const source of ['@simtlix/simfinity-core/auth/expressions', '@simtlix/simfinity-js/src/auth/expressions.js']) {
    it(`supports the expression subpath ${source}`, () => {
      assert.deepEqual(lint(`import expressions from '${source}'; const { createRuleFromExpression: rule } = expressions; const alias = rule; alias({ wrong: true });`).map(message => message.ruleId), ['simfinity/valid-policy-expression']);
    });
  }
  it('supports runtime auth factories', () => {
    assert.deepEqual(lint("import { createPostgres } from '@simtlix/simfinity-postgres'; const runtime = createPostgres(); runtime.auth.createRuleFromExpression({ eq: [1] });").map(message => message.ruleId), ['simfinity/valid-policy-expression']);
  });
  for (const code of [
    "import { createRuleFromExpression } from 'other'; createRuleFromExpression({ wrong: true });",
    "import { auth } from '@simtlix/simfinity-core'; auth.createRuleFromExpression = custom; auth.createRuleFromExpression({ wrong: true });",
    "import { auth } from '@simtlix/simfinity-core'; const alias = auth; alias.createRuleFromExpression = custom; auth.createRuleFromExpression({ wrong: true });",
    "import { auth } from '@simtlix/simfinity-core'; decorate(auth); auth.createRuleFromExpression({ wrong: true });",
    "import { auth } from '@simtlix/simfinity-core'; const box = { auth }; box.auth.createRuleFromExpression = custom; auth.createRuleFromExpression({ wrong: true });",
  ]) it(`does not guess a changed or foreign API: ${code}`, () => assert.deepEqual(lint(code), []));
});
