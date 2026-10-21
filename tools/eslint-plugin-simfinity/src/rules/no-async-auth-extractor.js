import { analyze } from '../analysis.js';

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Require synchronous extractors in built-in authorization helpers' },
    schema: [],
    messages: {
      invalid: 'Simfinity authorization extractors must be synchronous. Resolve asynchronous data in the GraphQL context or use an async custom rule.',
    },
  },
  create(context) {
    const analysis = analyze(context);
    const check = input => {
      const node = analysis.resolve(input);
      if (['ArrowFunctionExpression', 'FunctionExpression'].includes(node?.type) && node.async) {
        context.report({ node: input, messageId: 'invalid' });
      }
    };
    const options = (input, keys) => {
      const properties = analysis.properties(input);
      for (const key of keys) check(properties?.get(key));
    };
    return {
      CallExpression(node) {
        if (node.arguments.some(argument => argument.type === 'SpreadElement')) return;
        const callee = analysis.origin(node.callee);
        if (callee?.kind !== 'auth-function') return;
        const [first, second, third] = node.arguments;
        switch (callee.name) {
          case 'requireAuth':
            check(first);
            break;
          case 'requireRole':
            options(second, ['userPath', 'rolePath']);
            break;
          case 'requirePermission':
            options(second, ['userPath', 'permissionsPath']);
            break;
          case 'isOwner':
            check(first);
            check(second);
            options(third, ['userPath']);
            break;
          default:
            break;
        }
      },
    };
  },
};
