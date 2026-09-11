/**
 * JSON AST policy evaluation without eval() or Function().
 * Invalid syntax is rejected before execution. Missing runtime references remain
 * distinct from false, so negation cannot turn an invalid comparison into a grant.
 */

const invalidResult = Symbol('invalid policy result');

const isValidRef = (refPath) => {
  if (typeof refPath !== 'string') return false;
  const parts = refPath.split('.');
  return ['parent', 'args', 'ctx'].includes(parts[0])
    && parts.every(part => part.length > 0 && !['__proto__', 'prototype', 'constructor'].includes(part));
};

const isReference = value => value !== null && typeof value === 'object' && 'ref' in value;

const isValidValue = (value) => {
  if (isReference(value)) {
    return Object.keys(value).length === 1 && Object.hasOwn(value, 'ref') && isValidRef(value.ref);
  }
  return value !== undefined && typeof value !== 'function' && typeof value !== 'symbol';
};

const isDenseArray = value => Array.isArray(value)
  && Array.from({ length: value.length }, (_, index) => Object.hasOwn(value, index)).every(Boolean);

const validateExpression = (expression, ancestors = new Set()) => {
  if (typeof expression === 'boolean') return true;
  if (expression === null || typeof expression !== 'object' || Array.isArray(expression)) return false;
  if (ancestors.has(expression)) return false;
  const keys = Object.keys(expression);
  if (keys.length === 0) return false;

  ancestors.add(expression);
  const valid = keys.every((operator) => {
    const operand = expression[operator];
    switch (operator) {
      case 'eq':
      case 'in':
        return isDenseArray(operand) && operand.length === 2 && operand.every(isValidValue)
          && (operator !== 'in' || Array.isArray(operand[1]) || isReference(operand[1]));
      case 'allOf':
      case 'anyOf':
        return isDenseArray(operand) && operand.every(expr => validateExpression(expr, ancestors));
      case 'not':
        return validateExpression(operand, ancestors);
      default:
        return false;
    }
  });
  ancestors.delete(expression);
  return valid;
};

/** Resolve a parent/args/ctx reference, retaining document getters and array paths. */
const resolveRef = (refPath, context) => {
  if (!isValidRef(refPath)) return undefined;
  const [root, ...parts] = refPath.split('.');
  let value = context?.[root];
  for (const part of parts) {
    if (value === null || value === undefined) return undefined;
    value = value[part];
  }
  return value;
};

/** Resolve a literal or reference without coercing its value. */
const resolveValue = (value, context) => {
  return isReference(value) ? resolveRef(value.ref, context) : value;
};

const evaluateComparison = (operator, operands, context) => {
  const left = resolveValue(operands[0], context);
  const right = resolveValue(operands[1], context);
  if (left === undefined || right === undefined || typeof left === 'function' || typeof right === 'function') {
    return invalidResult;
  }
  if (operator === 'eq') return left === right;
  return Array.isArray(right) ? right.includes(left) : invalidResult;
};

const evaluateAllOf = (expressions, context) => {
  let result = true;
  for (const expression of expressions) {
    const current = evaluateValidatedExpression(expression, context);
    if (current === invalidResult) return invalidResult;
    if (current === false) result = false;
  }
  return result;
};

const evaluateAnyOf = (expressions, context) => {
  let result = false;
  for (const expression of expressions) {
    const current = evaluateValidatedExpression(expression, context);
    // A valid public branch may grant access even when another branch has no user.
    if (current === true) return true;
    if (current === invalidResult) result = invalidResult;
  }
  return result;
};

const evaluateOperator = (operator, operand, context) => {
  switch (operator) {
    case 'eq':
    case 'in':
      return evaluateComparison(operator, operand, context);
    case 'allOf':
      return evaluateAllOf(operand, context);
    case 'anyOf':
      return evaluateAnyOf(operand, context);
    case 'not': {
      const result = evaluateValidatedExpression(operand, context);
      return result === invalidResult ? invalidResult : !result;
    }
    default:
      return invalidResult;
  }
};

const evaluateValidatedExpression = (expression, context) => {
  if (typeof expression === 'boolean') return expression;
  let result = true;
  // Multiple operator keys retain the existing implicit AND behavior.
  for (const [operator, operand] of Object.entries(expression)) {
    const current = evaluateOperator(operator, operand, context);
    if (current === invalidResult) return invalidResult;
    if (current === false) result = false;
  }
  return result;
};

/** Evaluate a policy; malformed expressions and unresolved comparisons deny. */
export const evaluateExpression = (expression, context) => {
  if (!isPolicyExpression(expression)) return false;
  return evaluateValidatedExpression(expression, context) === true;
};

/** Check the complete AST, including boolean literals and every nested branch. */
export const isPolicyExpression = value => validateExpression(value);

/** Create a rule, rejecting malformed policies at configuration time. */
export const createRuleFromExpression = (expression) => {
  if (!isPolicyExpression(expression)) {
    throw new TypeError('Invalid authorization policy expression');
  }
  return (parent, args, ctx) => evaluateExpression(expression, { parent, args, ctx });
};

const expressions = {
  evaluateExpression,
  isPolicyExpression,
  createRuleFromExpression,
  resolveRef,
  resolveValue,
};

export default expressions;
