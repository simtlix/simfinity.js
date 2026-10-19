import { unwrap } from './analysis.js';

// The general analyzer uses an object sentinel for arrays/objects. Never use
// that sentinel to infer contents: a const container may have mutable aliases.
export const primitive = (analysis, input) => {
  const result = analysis.value(input);
  return result.known && (result.value === null || !['object', 'function'].includes(typeof result.value))
    ? result : { known: false };
};

export const functionSyntax = input => ['ArrowFunctionExpression', 'FunctionExpression', 'ClassExpression'].includes(unwrap(input)?.type);

export const nonFunction = (analysis, input) => {
  const node = unwrap(input);
  return primitive(analysis, node).known || ['ObjectExpression', 'ArrayExpression'].includes(node?.type) || !!node?.regex;
};
