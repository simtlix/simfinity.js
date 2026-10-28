import SimfinityError from './errors/simfinity.error.js';

const fail = (message, code = 'INVALID_FILTER_VALUE') => { throw new SimfinityError(message, code, 400); };
const equality = new Set(['EQ', 'NE']);
const ordered = new Set(['LT', 'LTE', 'GT', 'GTE']);
const text = new Set(['LIKE', 'STARTS_WITH', 'ENDS_WITH']);
const temporal = new Set(['DateTime', 'Date', 'Time']);

/** A nullable optional path selects a field operand only when non-null and non-undefined. */
export const hasValuePath = (carrier) => carrier?.valuePath !== undefined && carrier?.valuePath !== null;

/** Validate the public operand syntax before resolving either path. Literal carriers are unchanged. */
export const validateComparisonOperand = (carrier) => {
  if (!hasValuePath(carrier)) return null;
  if (carrier.value !== undefined) fail('A filter cannot supply both value and valuePath');
  if (typeof carrier.valuePath !== 'string') fail('valuePath requires a string field path');
  if (!/^(?:\$parent\.)*[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/.test(carrier.valuePath)) {
    fail('valuePath requires a field path optionally preceded by embedded $parent prefixes', 'INVALID_FILTER_PATH');
  }
  return carrier.valuePath;
};

const typeOf = (field, path) => {
  if (field.identity || field.scalar === 'ID') return 'ID';
  if (field.scalar === 'Enum') {
    if (!field.enumName) fail(`Field comparison on ${path} requires logical enumName metadata`, 'UNSUPPORTED_QUERY');
    return `Enum:${field.enumName}`;
  }
  if (temporal.has(field.scalar)) {
    if (!field.temporalName) fail(`Field comparison on ${path} requires effective temporalName metadata`, 'UNSUPPORTED_QUERY');
    return field.temporalName;
  }
  return field.scalar;
};

/** Logical comparison rules shared by runtime/model validation and hand-built engine plans. */
export const validateComparisonTypes = (left, right, operator = 'EQ', leftPath = 'left', rightPath = 'right') => {
  if (right.list) fail(`The right operand ${rightPath} must be a scalar, not a list`, 'INVALID_FILTER_PATH');
  if (!equality.has(operator) && !ordered.has(operator) && !text.has(operator)) {
    fail(`${operator} does not accept valuePath`, 'INVALID_FILTER_OPERATOR');
  }
  if (left.list && !equality.has(operator)) fail(`${operator} does not accept a list left operand`, 'INVALID_FILTER_OPERATOR');
  const a = typeOf(left, leftPath);
  const b = typeOf(right, rightPath);
  const numeric = ['Int', 'Float'].includes(a) && ['Int', 'Float'].includes(b);
  const supported = numeric || (a === b && (['String', 'Boolean', 'ID'].includes(a) || temporal.has(a) || a?.startsWith('Enum:')));
  if (!supported || left.version || right.version) {
    fail(`Incompatible field comparison: ${leftPath} (${a}) and ${rightPath} (${b})`);
  }
  if (text.has(operator) && a !== 'String') fail(`${operator} requires String operands`, 'INVALID_FILTER_OPERATOR');
  if (ordered.has(operator) && !numeric && a !== 'String' && !temporal.has(a)) {
    fail(`${operator} does not order ${a} operands`, 'INVALID_FILTER_OPERATOR');
  }
};
