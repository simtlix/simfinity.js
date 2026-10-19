import { analyze } from '../analysis.js';

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Require a positive safe integer query page limit', url: 'https://simtlix.github.io/simfinity.js/guide/linting#valid-query-limits' },
    schema: [],
    messages: { invalid: 'Simfinity 3.8 maxPageSize must be a positive safe integer. Omit it or use undefined for the default (1000); choose a positive integer for an explicit cap.' },
  },
  create(context) {
    const analysis = analyze(context);
    return {
      CallExpression(node) {
        if (node.arguments.some(argument => argument.type === 'SpreadElement')) return;
        const callee = analysis.origin(node.callee);
        if (callee?.kind !== 'runtime-function' || callee.name !== 'configureQueryLimits') return;
        const cap = analysis.properties(node.arguments[0])?.get('maxPageSize');
        const result = analysis.value(cap);
        if (result.known && result.value !== undefined && (!Number.isSafeInteger(result.value) || result.value < 1)) context.report({ node: cap, messageId: 'invalid' });
      },
    };
  },
};
