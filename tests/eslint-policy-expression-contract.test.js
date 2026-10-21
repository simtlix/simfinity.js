import { describe, expect, it } from 'vitest';
import { Linter } from 'eslint';
import { isPolicyExpression, createRuleFromExpression } from '../packages/core/src/auth/expressions.js';
import plugin from '../tools/eslint-plugin-simfinity/src/index.js';

// Hand-paired source and values: do not evaluate the application's source to lint it.
const invalid = [
  ['{ unknown: true }', { unknown: true }],
  ['{ eq: [1] }', { eq: [1] }],
  // eslint-disable-next-line no-sparse-arrays -- Deliberate runtime hole matching the source fixture.
  ['{ eq: [1, , 1] }', { eq: [1, , 1] }],
  ['{ anyOf: [true, { unknown: false }] }', { anyOf: [true, { unknown: false }] }],
  ['{ allOf: [false, null] }', { allOf: [false, null] }],
  ['{ not: {} }', { not: {} }],
  ['{ eq: [{ ref: \'context.id\' }, 1] }', { eq: [{ ref: 'context.id' }, 1] }],
  ['{ eq: [{ ref: \'ctx..id\' }, 1] }', { eq: [{ ref: 'ctx..id' }, 1] }],
  ['{ eq: [{ ref: \'ctx.constructor.name\' }, 1] }', { eq: [{ ref: 'ctx.constructor.name' }, 1] }],
  ['{ eq: [{ ref: \'ctx.id\', other: true }, 1] }', { eq: [{ ref: 'ctx.id', other: true }, 1] }],
  ['{ eq: [{ ref: [] }, 1] }', { eq: [{ ref: [] }, 1] }],
  ['{ eq: [undefined, 1] }', { eq: [undefined, 1] }],
  ['{ eq: [NaN, 1] }', { eq: [NaN, 1] }],
  ['{ eq: [{ data: [{ ref: \'ctx.id\' }] }, null] }', { eq: [{ data: [{ ref: 'ctx.id' }] }, null] }],
  ['{ in: [1, [{ ref: \'ctx.id\' }]] }', { in: [1, [{ ref: 'ctx.id' }]] }],
  ['{ in: [1, null] }', { in: [1, null] }],
  // eslint-disable-next-line no-sparse-arrays -- Membership lists must reject actual holes.
  ['{ in: [1, [, 1]] }', { in: [1, [, 1]] }],
  ['{ in: [1, [Infinity]] }', { in: [1, [Infinity]] }],
  ['{ in: [1, [undefined]] }', { in: [1, [undefined]] }],
  ['{ in: [1, [{}]] }', { in: [1, [{}]] }],
  ['{ in: [1, [[1]]] }', { in: [1, [[1]]] }],
];
const valid = [
  ['true', true],
  ['false', false],
  ['{ allOf: [] }', { allOf: [] }],
  ['{ anyOf: [] }', { anyOf: [] }],
  ['{ eq: [null, null], not: false }', { eq: [null, null], not: false }],
  ['{ eq: [{ ref: \'ctx\' }, { ref: \'parent.items.0.id\' }] }', { eq: [{ ref: 'ctx' }, { ref: 'parent.items.0.id' }] }],
  ['{ in: [1, { ref: \'args.ids\' }] }', { in: [1, { ref: 'args.ids' }] }],
  ['{ in: [1, [null, false, 0, \'\', 1n]] }', { in: [1, [null, false, 0, '', 1n]] }],
  ['{ in: [1, []] }', { in: [1, []] }],
  ['{ eq: [Infinity, Infinity] }', { eq: [Infinity, Infinity] }],
  // eslint-disable-next-line no-sparse-arrays -- A hole inside an equality literal remains valid syntax.
  ['{ eq: [{ data: [undefined, , 1] }, {}] }', { eq: [{ data: [undefined, , 1] }, {}] }],
  ['{ eq: [/a/, /a/] }', { eq: [/a/, /a/] }],
  ['{ eq: [new Date(0), new Date(0)] }', { eq: [new Date(0), new Date(0)] }],
  ['{ not: { eq: [1, \'1\'] } }', { not: { eq: [1, '1'] } }],
];
const lint = expression => new Linter().verify(
  `import { createRuleFromExpression } from '@simtlix/simfinity-core/auth'; createRuleFromExpression(${expression});`,
  [plugin.configs['recommended-3.8']],
);

describe('ESLint policy syntax matches the shared runtime contract', () => {
  for (const [source, value] of invalid) {
    it(`diagnoses rejected syntax: ${source}`, () => {
      expect(isPolicyExpression(value)).toBe(false);
      expect(() => createRuleFromExpression(value)).toThrow(TypeError);
      expect(lint(source).map(message => message.ruleId)).toEqual(['simfinity/valid-policy-expression']);
    });
  }
  for (const [source, value] of valid) {
    it(`preserves accepted syntax without deciding whether it grants: ${source}`, () => {
      expect(isPolicyExpression(value)).toBe(true);
      expect(() => createRuleFromExpression(value)).not.toThrow();
      expect(lint(source)).toEqual([]);
    });
  }
});
