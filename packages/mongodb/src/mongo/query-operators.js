import { invalidQuery } from './query-values.js';
import { parseLiteralRegex } from './query-regex.js';

const MAX_ARRAY_SIZE = 2 ** 31 - 1;
const BSON_TYPES = new Set([
  'string', 'number', 'double', 'int', 'long', 'decimal', 'date',
  'objectId', 'bool', 'object', 'array', 'null', 'binData',
]);

const literal = (parser, { operand, field }) => ({ value: parser.fieldLiteral(operand, field) });
const array = (parser, term) => {
  if (!Array.isArray(term.operand)) invalidQuery(term.operator + ' requires an array');
  return literal(parser, term);
};
const exists = (_parser, { operand }) => {
  if (typeof operand !== 'boolean') invalidQuery('$exists requires a boolean');
  return { value: operand };
};
const size = (_parser, { operand }) => {
  if (!Number.isSafeInteger(operand) || operand < 0 || operand > MAX_ARRAY_SIZE) {
    invalidQuery('$size requires an integer from 0 through 2147483647');
  }
  return { value: operand };
};
const bsonType = (_parser, { operand }) => {
  if (!BSON_TYPES.has(operand)) invalidQuery('Unsupported BSON type');
  return { value: operand };
};
const regex = (_parser, { operand, value }) => ({ value: parseLiteralRegex(operand, value.$options) });
const regexOptions = (_parser, { value }) => {
  if (!Object.hasOwn(value, '$regex')) invalidQuery('$options requires $regex');
  return null;
};
const not = (parser, { operand, field, depth }) => ({ terms: parser.operators(operand, field, depth + 1) });
const elementMatch = (parser, { operand, field, depth }) => parser.elementMatch(operand, field, depth);

// Adding an operator changes this vocabulary and its handler, not the document walker.
const FIELD_OPERATORS = {
  $eq: literal, $ne: literal, $lt: literal, $lte: literal, $gt: literal, $gte: literal,
  $in: array, $nin: array, $all: array,
  $exists: exists,
  $size: size,
  $type: bsonType,
  $regex: regex,
  $options: regexOptions,
  $not: not,
  $elemMatch: elementMatch,
};

export const parseFieldOperator = (parser, term) => {
  if (!Object.hasOwn(FIELD_OPERATORS, term.operator)) {
    invalidQuery('Unsupported filter operator: ' + term.operator, 'INVALID_FILTER_OPERATOR');
  }
  const value = FIELD_OPERATORS[term.operator](parser, term);
  if (value === null) return null;
  return { operator: term.operator, ...value };
};
