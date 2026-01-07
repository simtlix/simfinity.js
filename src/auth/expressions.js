/**
 * JSON AST Policy Expression Evaluator
 * 
 * Safely evaluates declarative policy expressions without using eval() or Function().
 * Supports logical operators (allOf, anyOf, not), comparison operators (eq, in),
 * boolean literals, and references to parent/args/ctx.
 * 
 * Unknown operators or invalid references fail closed (deny).
 */

/**
 * Resolves a reference path like "parent.authorId" or "ctx.user.id"
 * @param {string} refPath - The reference path (e.g., "ctx.user.id")
 * @param {Object} context - The evaluation context { parent, args, ctx }
 * @returns {*} The resolved value or undefined if not found
 */
const resolveRef = (refPath, context) => {
  if (typeof refPath !== 'string') {
    return undefined;
  }

  const parts = refPath.split('.');
  const root = parts[0];

  // Only allow parent, args, ctx as root references
  if (!['parent', 'args', 'ctx'].includes(root)) {
    return undefined;
  }

  let value = context[root];
  
  for (let i = 1; i < parts.length; i++) {
    if (value === null || value === undefined) {
      return undefined;
    }
    value = value[parts[i]];
  }

  return value;
};

/**
 * Resolves a value which may be a literal or a reference
 * @param {*} value - The value to resolve (could be { ref: "..." } or a literal)
 * @param {Object} context - The evaluation context { parent, args, ctx }
 * @returns {*} The resolved value
 */
const resolveValue = (value, context) => {
  // Check if it's a reference object
  if (value !== null && typeof value === 'object' && 'ref' in value) {
    return resolveRef(value.ref, context);
  }
  // Return literal value
  return value;
};

/**
 * Evaluates an 'eq' expression: { eq: [left, right] }
 * @param {Array} operands - Array of two operands to compare
 * @param {Object} context - The evaluation context
 * @returns {boolean}
 */
const evaluateEq = (operands, context) => {
  if (!Array.isArray(operands) || operands.length !== 2) {
    return false; // Fail closed
  }
  const left = resolveValue(operands[0], context);
  const right = resolveValue(operands[1], context);
  return left === right;
};

/**
 * Evaluates an 'in' expression: { in: [value, array] }
 * @param {Array} operands - [value, array] where value should be in array
 * @param {Object} context - The evaluation context
 * @returns {boolean}
 */
const evaluateIn = (operands, context) => {
  if (!Array.isArray(operands) || operands.length !== 2) {
    return false; // Fail closed
  }
  const value = resolveValue(operands[0], context);
  const array = resolveValue(operands[1], context);
  
  if (!Array.isArray(array)) {
    return false; // Fail closed
  }
  
  return array.includes(value);
};

/**
 * Evaluates an 'allOf' expression: { allOf: [...expressions] }
 * All expressions must evaluate to true (logical AND)
 * @param {Array} expressions - Array of expressions to evaluate
 * @param {Object} context - The evaluation context
 * @returns {boolean}
 */
const evaluateAllOf = (expressions, context) => {
  if (!Array.isArray(expressions)) {
    return false; // Fail closed
  }
  
  for (const expr of expressions) {
    if (!evaluateExpression(expr, context)) {
      return false;
    }
  }
  return true;
};

/**
 * Evaluates an 'anyOf' expression: { anyOf: [...expressions] }
 * At least one expression must evaluate to true (logical OR)
 * @param {Array} expressions - Array of expressions to evaluate
 * @param {Object} context - The evaluation context
 * @returns {boolean}
 */
const evaluateAnyOf = (expressions, context) => {
  if (!Array.isArray(expressions)) {
    return false; // Fail closed
  }
  
  for (const expr of expressions) {
    if (evaluateExpression(expr, context)) {
      return true;
    }
  }
  return false;
};

/**
 * Evaluates a 'not' expression: { not: expression }
 * Negates the result of the inner expression
 * @param {*} expression - Expression to negate
 * @param {Object} context - The evaluation context
 * @returns {boolean}
 */
const evaluateNot = (expression, context) => {
  return !evaluateExpression(expression, context);
};

/**
 * Main expression evaluator
 * @param {*} expression - The expression to evaluate
 * @param {Object} context - The evaluation context { parent, args, ctx }
 * @returns {boolean} The result of the expression evaluation
 */
export const evaluateExpression = (expression, context) => {
  // Handle boolean literals
  if (typeof expression === 'boolean') {
    return expression;
  }

  // Handle null/undefined - fail closed
  if (expression === null || expression === undefined) {
    return false;
  }

  // Expression must be an object with exactly one operator key
  if (typeof expression !== 'object') {
    return false; // Fail closed for non-object expressions
  }

  const keys = Object.keys(expression);
  
  // Empty object fails closed
  if (keys.length === 0) {
    return false;
  }

  // Handle single operator expressions
  if (keys.length === 1) {
    const operator = keys[0];
    const operand = expression[operator];

    switch (operator) {
      case 'eq':
        return evaluateEq(operand, context);
      case 'in':
        return evaluateIn(operand, context);
      case 'allOf':
        return evaluateAllOf(operand, context);
      case 'anyOf':
        return evaluateAnyOf(operand, context);
      case 'not':
        return evaluateNot(operand, context);
      default:
        // Unknown operator - fail closed
        return false;
    }
  }

  // Multiple keys - treat as implicit allOf
  // This allows { eq: [...], in: [...] } to mean both must pass
  for (const operator of keys) {
    const operand = expression[operator];
    let result;
    
    switch (operator) {
      case 'eq':
        result = evaluateEq(operand, context);
        break;
      case 'in':
        result = evaluateIn(operand, context);
        break;
      case 'allOf':
        result = evaluateAllOf(operand, context);
        break;
      case 'anyOf':
        result = evaluateAnyOf(operand, context);
        break;
      case 'not':
        result = evaluateNot(operand, context);
        break;
      default:
        // Unknown operator - fail closed
        return false;
    }
    
    if (!result) {
      return false;
    }
  }
  
  return true;
};

/**
 * Checks if a value is a policy expression (object with operator keys)
 * @param {*} value - The value to check
 * @returns {boolean} True if the value appears to be a policy expression
 */
export const isPolicyExpression = (value) => {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  
  // Check if it's a function (not an expression)
  if (typeof value === 'function') {
    return false;
  }
  
  // Check if it has any known operator keys
  const operatorKeys = ['eq', 'in', 'allOf', 'anyOf', 'not'];
  const keys = Object.keys(value);
  
  return keys.some(key => operatorKeys.includes(key));
};

/**
 * Creates a rule function from a policy expression
 * @param {Object} expression - The policy expression
 * @returns {Function} A rule function (parent, args, ctx, info) => boolean
 */
export const createRuleFromExpression = (expression) => {
  return (parent, args, ctx) => {
    const context = { parent, args, ctx };
    return evaluateExpression(expression, context);
  };
};

// Export all expression utilities as an object for convenience
const expressions = {
  evaluateExpression,
  isPolicyExpression,
  createRuleFromExpression,
  resolveRef,
  resolveValue,
};

export default expressions;

