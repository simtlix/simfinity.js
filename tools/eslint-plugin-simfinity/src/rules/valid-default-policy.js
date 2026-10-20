import { analyze } from '../analysis.js';

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Require a valid explicit authorization default policy', url: 'https://simtlix.github.io/simfinity.js/guide/linting#valid-default-policy' },
    schema: [],
    messages: { invalid: 'Simfinity 3.8 defaultPolicy must be "ALLOW" or "DENY" (omitted/undefined defaults to "DENY"). Choose the intended policy explicitly; do not change permissions automatically.' },
  },
  create(context) {
    const analysis = analyze(context);
    return {
      CallExpression(node) {
        if (node.arguments.some(argument => argument.type === 'SpreadElement')) return;
        const callee = analysis.origin(node.callee);
        if (callee?.kind !== 'auth-function' || callee.name !== 'createAuthPlugin') return;
        const policy = analysis.properties(node.arguments[1])?.get('defaultPolicy');
        const result = analysis.value(policy);
        if (result.known && ![undefined, 'ALLOW', 'DENY'].includes(result.value)) context.report({ node: policy, messageId: 'invalid' });
      },
    };
  },
};
