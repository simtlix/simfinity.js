import { analyze } from '../analysis.js';

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Keep the identity of a Simfinity schema and its introspection types', url: 'https://simtlix.github.io/simfinity.js/guide/linting#no-schema-cloning' },
    schema: [],
    messages: { invalid: 'Do not pass a Simfinity schema to {{name}}: rebuilding it duplicates injected introspection types. Use Envelop plugins or in-place resolver wrapping.' },
  },
  create(context) {
    const analysis = analyze(context);
    return {
      CallExpression(node) {
        if (node.arguments.some(argument => argument.type === 'SpreadElement')) return;
        const callee = analysis.origin(node.callee);
        if (callee?.kind === 'cloner' && analysis.origin(node.arguments[0])?.kind === 'schema') context.report({ node, messageId: 'invalid', data: { name: callee.name } });
      },
    };
  },
};
