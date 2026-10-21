import { analyze } from '../analysis.js';

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Keep Envelop authorization plugins out of runtime middleware' },
    schema: [],
    messages: {
      invalid: 'Simfinity use() requires a middleware function; createAuthPlugin() returns an Envelop plugin object. Install it in the GraphQL server plugins instead.',
    },
  },
  create(context) {
    const analysis = analyze(context);
    return {
      CallExpression(node) {
        if (node.arguments.some(argument => argument.type === 'SpreadElement')) return;
        const callee = analysis.origin(node.callee);
        if (callee?.kind !== 'runtime-function' || callee.name !== 'use') return;
        const argument = analysis.resolve(node.arguments[0]);
        if (argument?.type !== 'CallExpression' || argument.arguments.some(input => input.type === 'SpreadElement')) return;
        const factory = analysis.origin(argument.callee);
        if (factory?.kind === 'auth-function' && factory.name === 'createAuthPlugin') {
          context.report({ node: node.arguments[0], messageId: 'invalid' });
        }
      },
    };
  },
};
