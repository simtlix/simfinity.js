import { analyze, unwrap } from '../analysis.js';
import { functionSyntax, primitive } from '../auth-values.js';

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Use valid permission maps and configured authorization rules', url: 'https://simtlix.github.io/simfinity.js/guide/linting#valid-permissions' },
    schema: [],
    messages: {
      map: 'Simfinity 3.8 requires a plain or null-prototype permission map at both the top and type levels. Supply an object mapping types to field rules; use an empty map only if the default policy is intended.',
      rule: 'This configured authorization rule is invalid in Simfinity 3.8. Supply a rule function, boolean, valid policy expression or nonempty dense array of rules; omit the field entry only if the default policy is intended.',
    },
  },
  create(context) {
    const analysis = analyze(context);
    const inspectMap = (input, fallback) => {
      const node = unwrap(input);
      if (!node || primitive(analysis, node).known || functionSyntax(node) || node.type === 'ArrayExpression' || node.regex) {
        context.report({ node: input || fallback, messageId: 'map' });
        return null;
      }
      return analysis.properties(node);
    };
    return {
      CallExpression(node) {
        if (node.arguments.some(argument => argument.type === 'SpreadElement')) return;
        const callee = analysis.origin(node.callee);
        if (callee?.kind !== 'auth-function' || callee.name !== 'createAuthPlugin') return;
        let remaining = 200;
        const inspectRule = input => {
          if (remaining-- <= 0) return;
          const rule = unwrap(input);
          const value = primitive(analysis, rule);
          const properties = analysis.properties(rule);
          if ((value.known && typeof value.value !== 'boolean') || rule.regex || properties?.size === 0) {
            context.report({ node: input, messageId: 'rule' });
          } else if (rule.type === 'ArrayExpression') {
            if (rule.elements.some(element => element?.type === 'SpreadElement')) return;
            if (!rule.elements.length || rule.elements.some(element => element === null)) {
              context.report({ node: input, messageId: 'rule' });
              return;
            }
            rule.elements.forEach(inspectRule);
          }
        };
        for (const type of inspectMap(node.arguments[0], node.callee)?.values() || []) {
          for (const rule of inspectMap(type)?.values() || []) inspectRule(rule);
        }
      },
    };
  },
};
