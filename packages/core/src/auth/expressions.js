/**
 * Shared JSON AST policy evaluation without eval() or Function().
 * Invalid syntax is rejected before execution. Missing runtime references remain
 * distinct from false, so negation cannot turn an invalid comparison into a grant.
 */

import { normalizeObjectId } from './object-id.js';

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

const isPlainValue = value => value !== null && typeof value === 'object'
  && (Array.isArray(value) || [Object.prototype, null].includes(Object.getPrototypeOf(value)));

// Literals are compared as they are, so a `{ ref }` nested inside one would never be resolved.
const containsReference = (value, seen = new Set()) => {
  if (!isPlainValue(value) || seen.has(value)) return false;
  if (isReference(value)) return true;
  seen.add(value);
  return Object.values(value).some(item => containsReference(item, seen));
};

const isMembershipItem = value => value === null || ['string', 'boolean', 'bigint'].includes(typeof value)
  || (typeof value === 'number' && Number.isFinite(value)) || normalizeObjectId(value) !== undefined;

const isValidComparison = (operator, operand) => {
  if (!isDenseArray(operand) || operand.length !== 2 || !operand.every(isValidValue)) return false;
  if (operand.some(value => !isReference(value) && containsReference(value))) return false;
  if (operator !== 'in' || isReference(operand[1])) return true;
  return isDenseArray(operand[1]) && operand[1].every(isMembershipItem);
};

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
        return isValidComparison(operator, operand);
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

/**
 * An operand of a created rule. The literal or reference classification is made once, when the
 * rule is created, so mutating a literal object afterwards cannot turn it into a reference.
 */
class CompiledOperand {
  constructor(reference, value) {
    this.reference = reference;
    this.value = value;
    Object.freeze(this);
  }
}

/** Resolve a literal or reference without coercing its value. */
const resolveValue = (value, context) => {
  if (value instanceof CompiledOperand) return value.reference ? resolveRef(value.value, context) : value.value;
  return isReference(value) ? resolveRef(value.ref, context) : value;
};

// Registered ObjectIds compare by hexadecimal value; every other value compares strictly.
const comparable = value => normalizeObjectId(value) ?? value;

// Strict equality never matches values of different types, such as a string and a number or a
// primitive and a list. Such a comparison is invalid, so `not` cannot turn it into a grant.
// null stays comparable with anything, as an explicit check for a missing value.
const isMismatch = (left, right) => left !== null && right !== null && typeof left !== typeof right;

const evaluateMembership = (target, list) => {
  // A list or plain object is not a member value.
  if (!Array.isArray(list) || isPlainValue(target)) return invalidResult;
  // Never call the list's own includes: Mongoose arrays cast and compare loosely.
  let mismatched = false;
  for (let index = 0; index < list.length; index++) {
    const item = comparable(list[index]);
    if (item === target) return true;
    if (isMismatch(target, item)) mismatched = true;
  }
  // Without a match, an item of another type means the list could not be checked reliably.
  return mismatched ? invalidResult : false;
};

const evaluateComparison = (operator, operands, context) => {
  const left = resolveValue(operands[0], context);
  const right = resolveValue(operands[1], context);
  if (left === undefined || right === undefined || typeof left === 'function' || typeof right === 'function') {
    return invalidResult;
  }
  const target = comparable(left);
  if (operator === 'in') return evaluateMembership(target, right);
  const other = comparable(right);
  return isMismatch(target, other) ? invalidResult : target === other;
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

// Copy by index with built-in methods only, so an Array subclass cannot alter the copy.
const copyArray = (array, transform = value => value) => Array.from(
  { length: array.length },
  (_, index) => transform(array[index], index),
);

const compileOperand = (operator, value, index) => {
  if (isReference(value)) return new CompiledOperand(true, value.ref);
  // A literal membership list is copied, so only its validated items are compared.
  if (operator === 'in' && index === 1) return new CompiledOperand(false, Object.freeze(copyArray(value)));
  // Other literals keep their identity, which equality compares.
  return new CompiledOperand(false, value);
};

const snapshotOperands = (operator, operand) => Object.freeze(
  copyArray(operand, (value, index) => compileOperand(operator, value, index)),
);

/**
 * Copy the validated structure, so evaluation needs no revalidation and later changes to the
 * configured object cannot make it malformed. Other literal operands keep their identity.
 */
const snapshotExpression = (expression) => {
  if (typeof expression === 'boolean') return expression;
  const snapshot = {};
  for (const [operator, operand] of Object.entries(expression)) {
    if (operator === 'not') snapshot[operator] = snapshotExpression(operand);
    else if (operator === 'eq' || operator === 'in') snapshot[operator] = snapshotOperands(operator, operand);
    else snapshot[operator] = Object.freeze(copyArray(operand, snapshotExpression));
  }
  return Object.freeze(snapshot);
};

/** Create a rule, rejecting malformed policies at configuration time. */
export const createRuleFromExpression = (expression) => {
  if (!isPolicyExpression(expression)) {
    throw new TypeError('Invalid authorization policy expression');
  }
  const snapshot = snapshotExpression(expression);
  return (parent, args, ctx) => evaluateValidatedExpression(snapshot, { parent, args, ctx }) === true;
};

const expressions = {
  evaluateExpression,
  isPolicyExpression,
  createRuleFromExpression,
  resolveRef,
  resolveValue,
};

export default expressions;
