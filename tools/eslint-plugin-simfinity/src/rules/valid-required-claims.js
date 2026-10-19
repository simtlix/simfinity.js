import { analyze, unwrap } from '../analysis.js';
import { functionSyntax, primitive } from '../auth-values.js';

export default {
  meta: {
    type: 'problem',
    docs: { description: 'Require nonempty role and permission names', url: 'https://simtlix.github.io/simfinity.js/guide/linting#valid-required-claims' },
    schema: [],
    messages: {
      invalid: '{{name}} requires a nonempty string or a dense nonempty array of nonempty strings in Simfinity 3.8. Supply the intended claims; roles use OR and permissions use AND. Whitespace is not trimmed.',
    },
  },
  create(context) {
    const analysis = analyze(context);
    const invalidString = input => {
      const node = unwrap(input);
      const result = primitive(analysis, node);
      return (result.known && (typeof result.value !== 'string' || result.value.length === 0))
        || ['ObjectExpression', 'ArrayExpression'].includes(node?.type) || functionSyntax(node) || !!node?.regex;
    };
    return {
      CallExpression(node) {
        if (node.arguments.some(argument => argument.type === 'SpreadElement')) return;
        const callee = analysis.origin(node.callee);
        if (callee?.kind !== 'auth-function' || !['requireRole', 'requirePermission'].includes(callee.name)) return;
        const input = node.arguments[0];
        const claim = unwrap(input);
        let invalid = !claim;
        if (claim?.type === 'ArrayExpression') {
          if (claim.elements.some(element => element?.type === 'SpreadElement')) return;
          invalid = !claim.elements.length || claim.elements.some(element => !element || invalidString(element));
        } else if (claim) invalid = invalidString(claim);
        if (invalid) context.report({ node: input || node.callee, messageId: 'invalid', data: { name: callee.name } });
      },
    };
  },
};
