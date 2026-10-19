import { analyze } from '../analysis.js';
import { nonFunction } from '../auth-values.js';

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Pass functions to authorization composition and predicate helpers', url: 'https://simtlix.github.io/simfinity.js/guide/linting#valid-auth-composition' },
    schema: [],
    messages: {
      missing: '{{name}} requires {{requirement}} in Simfinity 3.8. Supply the intended check; use allow() only for a deliberate unconditional grant.',
      function: '{{name}} requires a function here in Simfinity 3.8. Pass a rule/predicate function; wrap a policy expression with createRuleFromExpression() before composing it.',
    },
  },
  create(context) {
    const analysis = analyze(context);
    return {
      CallExpression(node) {
        if (node.arguments.some(argument => argument.type === 'SpreadElement')) return;
        const callee = analysis.origin(node.callee);
        if (callee?.kind !== 'auth-function' || !['composeRules', 'anyRule', 'createRule'].includes(callee.name)) return;
        if (!node.arguments.length) {
          context.report({ node: node.callee, messageId: 'missing', data: { name: callee.name, requirement: callee.name === 'createRule' ? 'a predicate function' : 'at least one rule function' } });
          return;
        }
        const args = callee.name === 'createRule' ? node.arguments.slice(0, 1) : node.arguments;
        for (const argument of args) {
          if (nonFunction(analysis, argument)) context.report({ node: argument, messageId: 'function', data: { name: callee.name } });
        }
      },
    };
  },
};
