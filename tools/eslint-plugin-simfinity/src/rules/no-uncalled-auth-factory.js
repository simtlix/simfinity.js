import { analyze, factories, unwrap } from '../analysis.js';

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Pass authorization rules, not their factories', url: 'https://simtlix.github.io/simfinity.js/guide/linting#no-uncalled-auth-factory' },
    schema: [],
    messages: { invalid: '{{name}} is a rule factory, not an authorization rule. Call it with the intended arguments before using it here; the returned function must perform the check.' },
  },
  create(context) {
    const analysis = analyze(context);
    const inspect = node => {
      const rule = analysis.origin(node);
      if (rule?.kind === 'auth-function' && factories.has(rule.name)) {
        context.report({ node, messageId: 'invalid', data: { name: rule.name } });
      } else if (unwrap(node)?.type === 'ArrayExpression') {
        for (const element of unwrap(node).elements) if (element) inspect(element);
      }
    };
    return {
      CallExpression(node) {
        if (node.arguments.some(argument => argument.type === 'SpreadElement')) return;
        const callee = analysis.origin(node.callee);
        if (callee?.kind !== 'auth-function') return;
        if (['composeRules', 'anyRule'].includes(callee.name)) node.arguments.forEach(inspect);
        if (callee.name !== 'createAuthPlugin') return;
        for (const type of analysis.properties(node.arguments[0])?.values() || []) {
          for (const rule of analysis.properties(type)?.values() || []) inspect(rule);
        }
      },
    };
  },
};
