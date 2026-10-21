import { analyze, unwrap } from '../analysis.js';
import { functionSyntax, primitive } from '../auth-values.js';

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Use well-formed authorization policy expressions', url: 'https://simtlix.github.io/simfinity.js/guide/linting#valid-policy-expression' },
    schema: [],
    messages: {
      expression: 'Simfinity 3.8 requires a boolean or nonempty policy expression here. Supply the intended expression using eq, in, allOf, anyOf or not.',
      operator: 'Unknown policy operator "{{operator}}" in Simfinity 3.8. Use eq, in, allOf, anyOf or not with the intended authorization condition.',
      comparison: 'The {{operator}} policy operator requires a dense array of exactly two operands in Simfinity 3.8. Supply both intended comparison values.',
      logical: 'The {{operator}} policy operator requires a dense array of policy expressions in Simfinity 3.8. Empty allOf/anyOf arrays are valid logical identities.',
      reference: 'Invalid policy reference in Simfinity 3.8. Use an object containing only ref, with a parent, args or ctx path and no empty, __proto__, prototype or constructor segments.',
      nestedReference: 'A ref nested inside a literal is not resolved and makes this policy invalid in Simfinity 3.8. Place references directly in comparison operand positions; for in, reference the complete list or use literal members.',
      operand: 'Invalid policy operand in Simfinity 3.8. Use a literal value or reference; undefined, NaN, functions and symbols are not valid operands.',
      membership: 'The right operand of in must be a reference or a dense literal list of null, booleans, strings, finite numbers, bigints or genuine ObjectIds in Simfinity 3.8. Supply the intended allowed values.',
    },
  },
  create(context) {
    const analysis = analyze(context);
    return {
      CallExpression(call) {
        if (call.arguments.some(argument => argument.type === 'SpreadElement')) return;
        const callee = analysis.origin(call.callee);
        if (callee?.kind !== 'auth-function' || !['createAuthPlugin', 'createRuleFromExpression'].includes(callee.name)) return;
        let remaining = 200;
        const enter = input => remaining-- > 0 ? unwrap(input) : null;
        const problem = (node, messageId, data) => ({ node, messageId, ...(data ? { data } : {}) });
        // Containers stay inline: a const binding does not freeze an object/array.
        const properties = node => node?.type === 'ObjectExpression' && node.properties.length <= remaining ? analysis.properties(node) : null;
        const elements = node => node?.type === 'ArrayExpression' && node.elements.length <= remaining
          && !node.elements.some(item => item?.type === 'SpreadElement') ? node.elements : null;
        const nonArray = node => primitive(analysis, node).known || functionSyntax(node) || node.regex || properties(node);

        const reference = entries => {
          const ref = entries.get('ref');
          const node = unwrap(ref);
          const value = primitive(analysis, ref);
          if (entries.size !== 1 || functionSyntax(node) || node.regex || elements(node) || properties(node)
            || (value.known && (typeof value.value !== 'string'
            || !['parent', 'args', 'ctx'].includes(value.value.split('.')[0])
            || value.value.split('.').some(part => !part || ['__proto__', 'prototype', 'constructor'].includes(part))))) {
            return problem(ref, 'reference');
          }
          return null;
        };
        const nestedReference = input => {
          const node = enter(input);
          if (!node) return null;
          const entries = properties(node);
          if (entries?.has('ref')) return problem(node, 'nestedReference');
          for (const child of entries?.values() || elements(node) || []) {
            if (remaining <= 0) break;
            const issue = child && nestedReference(child);
            if (issue) return issue;
          }
          return null;
        };
        const membershipItem = input => {
          const node = enter(input);
          if (!node) return null;
          const value = primitive(analysis, node);
          if (value.known) {
            return value.value === null || ['string', 'boolean', 'bigint'].includes(typeof value.value)
              || (typeof value.value === 'number' && Number.isFinite(value.value)) ? null : problem(node, 'membership');
          }
          if (functionSyntax(node) || node.regex || elements(node) || properties(node)) {
            return nestedReference(node) || problem(node, 'membership');
          }
          return null;
        };
        const operand = (input, list) => {
          const node = enter(input);
          if (!node) return null;
          const value = primitive(analysis, node);
          if (value.known && (value.value === undefined || Number.isNaN(value.value))) return problem(node, 'operand');
          if (functionSyntax(node)) return problem(node, 'operand');
          const entries = properties(node);
          if (entries?.has('ref')) return reference(entries);
          if (list) {
            const items = elements(node);
            if (!items) return nonArray(node) ? problem(node, 'membership') : null;
            if (items.some(item => item === null)) return problem(node, 'membership');
            for (const item of items) {
              if (remaining <= 0) break;
              const issue = membershipItem(item);
              if (issue) return issue;
            }
            return null;
          }
          return nestedReference(node);
        };
        const arrayOperand = (input, operator) => {
          const node = enter(input);
          if (!node) return null;
          const comparison = ['eq', 'in'].includes(operator);
          const kind = comparison ? 'comparison' : 'logical';
          const items = elements(node);
          if (!items) return nonArray(node) ? problem(node, kind, { operator }) : null;
          if (items.some(item => item === null) || (comparison && items.length !== 2)) return problem(node, kind, { operator });
          for (const [index, item] of items.entries()) {
            if (remaining <= 0) break;
            const issue = comparison ? operand(item, operator === 'in' && index === 1) : expression(item);
            if (issue) return issue;
          }
          return null;
        };
        const expression = input => {
          const node = enter(input);
          if (!node) return null;
          const value = primitive(analysis, node);
          if (value.known) return typeof value.value === 'boolean' ? null : problem(node, 'expression');
          if (functionSyntax(node) || node.regex || node.type === 'ArrayExpression') return problem(node, 'expression');
          const entries = properties(node);
          if (entries?.size === 0) return problem(node, 'expression');
          for (const [operator, valueNode] of entries || []) {
            if (remaining-- <= 0) break;
            if (!['eq', 'in', 'allOf', 'anyOf', 'not'].includes(operator)) return problem(valueNode, 'operator', { operator });
            const issue = operator === 'not' ? expression(valueNode) : arrayOperand(valueNode, operator);
            if (issue) return issue;
          }
          return null;
        };
        const rule = input => {
          const node = enter(input);
          if (!node) return;
          const items = elements(node);
          if (items) {
            // valid-permissions owns empty/sparse rule arrays and invalid scalar rules.
            if (items.some(item => item === null)) return;
            for (const item of items) {
              if (remaining <= 0) break;
              rule(item);
            }
          } else if (properties(node)?.size) {
            const issue = expression(node);
            if (issue) context.report(issue);
          }
        };

        if (callee.name === 'createRuleFromExpression') {
          const issue = call.arguments.length ? expression(call.arguments[0]) : problem(call.callee, 'expression');
          if (issue) context.report(issue);
        } else {
          for (const type of properties(unwrap(call.arguments[0]))?.values() || []) {
            if (remaining <= 0) break;
            for (const configured of properties(unwrap(type))?.values() || []) {
              if (remaining <= 0) break;
              rule(configured);
            }
          }
        }
      },
    };
  },
};
