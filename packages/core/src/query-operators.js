import QLOperator from './const/QLOperator.js';
import SimfinityError from './errors/simfinity.error.js';

// Internal: the filter operators and the value rules every backend applies to them. They are shared
// by the core runtime, the query plan and the MongoDB compiler through the
// `./internal/query-operators` subpath, which is not public API.

/** Every `QLOperator` value, in declaration order. QLOperator is the only list of operators. */
export const QUERY_OPERATORS = Object.freeze(QLOperator.getValues().map((entry) => entry.value));

/**
 * The operators of 3.7.0. An adapter that declares no `queryFeatures` supports exactly these, so a
 * custom adapter written for 3.7 never receives an operator it would drop or misread.
 */
export const LEGACY_QUERY_OPERATORS = Object.freeze(['EQ', 'NE', 'LT', 'LTE', 'GT', 'GTE', 'BTW', 'IN', 'NIN', 'LIKE']);

/**
 * The literal text operators (#108, part 1) and what each one matches: `contains`, `prefix`,
 * `suffix` or `exact` (the whole value), respecting case or ignoring it (`ignoreCase`). Values are
 * literal: `%`, `_`, `.`, `*`, `\`, `^`, `$` and `(` match themselves. `LIKE`, the case-sensitive
 * substring of 3.7.0, keeps its own validation and compilation and is not listed here.
 */
export const TEXT_QUERY_OPERATORS = Object.freeze({
  ILIKE: Object.freeze({ match: 'contains', ignoreCase: true }),
  STARTS_WITH: Object.freeze({ match: 'prefix', ignoreCase: false }),
  ISTARTS_WITH: Object.freeze({ match: 'prefix', ignoreCase: true }),
  ENDS_WITH: Object.freeze({ match: 'suffix', ignoreCase: false }),
  IENDS_WITH: Object.freeze({ match: 'suffix', ignoreCase: true }),
  IEQ: Object.freeze({ match: 'exact', ignoreCase: true }),
});

/** Whether `operator` is a `QLOperator` value. */
export const isQueryOperator = (operator) => QUERY_OPERATORS.includes(operator);

/** The {@link TEXT_QUERY_OPERATORS} entry of `operator`, or null for any other operator. */
export const textQueryOperator = (operator) => (
  typeof operator === 'string' && Object.hasOwn(TEXT_QUERY_OPERATORS, operator) ? TEXT_QUERY_OPERATORS[operator] : null
);

const invalidValue = (message) => { throw new SimfinityError(message, 'INVALID_FILTER_VALUE', 400); };

/**
 * Validates the value of a text operator condition before any backend compiles it, so both backends
 * reject the same input with the same code. `scalar` names the effective scalar of the path's last
 * field: the base scalar of a validated scalar (`String` for an email scalar), `Enum` or the enum
 * type's name for an enum, `ID` for identifiers and references. The field must be a `String` field
 * or a `String` list, and the value a string without U+0000; the empty string is valid. Anything
 * else fails with `INVALID_FILTER_VALUE` (400), as `LIKE` does. Returns the value unchanged: it is
 * not passed through the field's scalar, since a validated scalar filters by its base scalar.
 */
export const validateTextFilterValue = (operator, value, scalar, path) => {
  const where = path == null ? '' : ` on ${Array.isArray(path) ? path.join('.') : path}`;
  if (scalar !== 'String') invalidValue(`${operator} requires a String field${where}`);
  if (typeof value !== 'string') invalidValue(`${operator} requires a non-null string value${where}`);
  if (value.includes('\u0000')) invalidValue(`${operator} values cannot contain U+0000${where}`);
  return value;
};

const invalidFeatures = (message) => {
  throw new SimfinityError(`DatabaseAdapter queryFeatures ${message}`, 'INVALID_QUERY_FEATURES', 500);
};

/**
 * Reads an adapter's `queryFeatures` declaration into the set of operators it compiles. Without a
 * declaration (undefined or null) the adapter supports {@link LEGACY_QUERY_OPERATORS}. A declaration
 * is an object whose `operators` is an array of operator names; names this version does not
 * know are ignored, and other members are left for later features. Anything else throws
 * `INVALID_QUERY_FEATURES` (500).
 */
export const resolveQueryFeatures = (queryFeatures) => {
  if (queryFeatures == null) return { operators: new Set(LEGACY_QUERY_OPERATORS) };
  if (typeof queryFeatures !== 'object' || Array.isArray(queryFeatures)) {
    invalidFeatures('must be an object with an operators array');
  }
  const { operators } = queryFeatures;
  if (!Array.isArray(operators) || operators.some((operator) => typeof operator !== 'string')) {
    invalidFeatures('operators must be an array of operator names');
  }
  return { operators: new Set(operators.filter(isQueryOperator)) };
};
