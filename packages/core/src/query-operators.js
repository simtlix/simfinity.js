import QLOperator from './const/QLOperator.js';
import SimfinityError from './errors/simfinity.error.js';

// Internal: the filter operators and the value rules every backend applies to them, and the path
// and leaf rules of the list operator CONTAINS_ALL (#108, part 4). They are shared by the core
// runtime, the query plan and the backend compilers through the `./internal/query-operators`
// subpath, which is not public API. The emptiness operators live in query-emptiness.js and are
// re-exported here, so the subpath stays the only one.

export {
  EMPTINESS_QUERY_OPERATORS, describeEmptiness, describeModelEmptiness, emptinessMemberPaths, emptinessScopePaths,
  emptinessScopeTargets, isEmptinessOperator, validateEmptinessValue,
} from './query-emptiness.js';
export {
  ANCHOR_KEY, GROUP_KEYS, IMPLICIT_KEY, aggregateJoinPrefixes, crossingKeys, frameCollectionPaths, frameUnits, validateQuantifiedGroups,
} from './query-frames.js';
export { hasValuePath, validateComparisonOperand, validateComparisonTypes } from './query-comparisons.js';
export { effectiveScalarName } from './metadata.js';

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
 * substring of 3.7.0, keeps its own validation and compilation and is not listed here. Neither is
 * `IIN` (#108, part 4), `IN` ignoring case: it takes a list of such values, which
 * {@link validateTextListFilterValue} checks.
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

/** The operators whose value is an array: IN, NIN and BTW (3.7.0), CONTAINS_ALL and IIN (#108 part 4). */
export const LIST_VALUE_OPERATORS = Object.freeze(['IN', 'NIN', 'BTW', 'CONTAINS_ALL', 'IIN']);

/** Whether `operator` takes an array value. */
export const takesListValue = (operator) => LIST_VALUE_OPERATORS.includes(operator);

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

/**
 * Validates the value of CONTAINS_ALL (#108 section 3.3) before any backend compiles it: a non-empty array of
 * non-null scalars, none of them an array or a plain object. Anything else fails with INVALID_FILTER_VALUE (400).
 * Returns the value unchanged: the compilers cast each element as they cast IN elements, and keep duplicates.
 */
export const validateContainsAllValue = (value) => {
  if (value === undefined || value === null) invalidValue('Expected a scalar filter value');
  // Array.from reads a hole of a sparse array as undefined; `some` would skip it.
  if (Array.isArray(value) && Array.from(value).some((item) => item == null || Array.isArray(item) || isPlainObject(item))) {
    invalidValue('Filter lists require non-null scalar elements');
  }
  if (!Array.isArray(value)) invalidValue('CONTAINS_ALL requires an array value');
  if (!value.length) invalidValue('CONTAINS_ALL requires a non-empty list');
  return value;
};

/**
 * Validates the value of IIN, IN ignoring case, before any backend compiles it: the field must be a `String` field
 * or a `String` list by its effective scalar, as for IEQ, and the value an array of strings without U+0000; the
 * empty array is valid and matches nothing. Anything else fails with INVALID_FILTER_VALUE (400). Returns the value
 * unchanged: it is neither folded nor deduplicated.
 */
export const validateTextListFilterValue = (operator, value, scalar, path) => {
  const where = path == null ? '' : ` on ${Array.isArray(path) ? path.join('.') : path}`;
  if (scalar !== 'String') invalidValue(`${operator} requires a String field${where}`);
  if (!Array.isArray(value)) invalidValue(`${operator} requires an array value${where}`);
  // Array.from reads a hole of a sparse array as undefined; `some` would skip it.
  const items = Array.from(value);
  if (items.some((item) => typeof item !== 'string')) invalidValue(`${operator} requires non-null string elements${where}`);
  if (items.some((item) => item.includes('\u0000'))) invalidValue(`${operator} values cannot contain U+0000${where}`);
  return value;
};

const failPath = (message, code) => { throw new SimfinityError(message, code, 400); };
// The validator's steps (graphqlStep, modelStep) and resolveModelPath's field descriptions, read alike.
const stepKind = (step) => {
  if (step.kind === 'embedded') return step.list ? 'embeddedList' : 'embedded';
  if (step.kind === 'scalar') return step.list ? 'scalarList' : 'scalar';
  if (step.kind === 'reference' && step.inferred) return 'scalar';
  return step.kind;
};

/**
 * The permanent path and leaf rules of CONTAINS_ALL (#108 section 3.3), on the steps of a path relative to its
 * frame: the path ends at a value, as for every operator (MISSING_FILTER_PATH for one segment, INVALID_FILTER_PATH
 * otherwise; the validator has applied this rule already, and PostgreSQL's hand-built plans get core's codes from
 * it), no collection is crossed (INVALID_FILTER_PATH, which the shorthand's exclusion states), no reference follows
 * an embedded list (INVALID_FILTER_PATH: that join yields one referenced record per row), and the leaf is a list: a
 * scalar list, or a scalar reached through an embedded list (INVALID_FILTER_OPERATOR otherwise).
 */
export const assertContainsAllPath = (steps) => {
  const kinds = steps.map(stepKind);
  const names = steps.map(({ name }) => name);
  // Core's object-end rule first (query-frames.js:420-422), so that every caller gets core's codes in core's order.
  if (['embedded', 'embeddedList', 'reference', 'collection'].includes(kinds.at(-1))) {
    failPath('Filter on object field requires a scalar path', steps.length > 1 ? 'INVALID_FILTER_PATH' : 'MISSING_FILTER_PATH');
  }
  const crossed = kinds.slice(0, -1);
  if (crossed.includes('collection')) failPath('The shorthand excludes them; use an explicit group', 'INVALID_FILTER_PATH');
  const list = crossed.indexOf('embeddedList');
  const reference = list === -1 ? -1 : crossed.findIndex((kind, index) => index > list && kind === 'reference');
  if (reference !== -1) {
    failPath(`CONTAINS_ALL cannot cross the reference ${names.slice(0, reference + 1).join('.')} inside an embedded list, which joins one referenced record per row; combine EQ conditions on the path instead`, 'INVALID_FILTER_PATH');
  }
  const leaf = kinds.at(-1);
  if (leaf !== 'scalarList' && !(leaf === 'scalar' && list !== -1)) {
    failPath(`CONTAINS_ALL requires a list field, or a field reached through an embedded list; ${names.join('.')} is not one`, 'INVALID_FILTER_OPERATOR');
  }
};

const invalidFeatures = (message) => {
  throw new SimfinityError(`DatabaseAdapter queryFeatures ${message}`, 'INVALID_QUERY_FEATURES', 500);
};

/**
 * Reads an adapter's `queryFeatures` declaration into `{ operators, referenceEmptiness, quantifiers, valuePath }`:
 * the operators it compiles and whether it compiles reference emptiness and collection frames.
 * Without a declaration (undefined or null) the adapter supports {@link LEGACY_QUERY_OPERATORS}
 * and neither feature. A declaration is an object whose `operators`
 * is an array of operator names, whose names this version does not know are ignored, and whose
 * optional `referenceEmptiness`, `quantifiers` and `valuePath` are booleans, undefined or null (false). A name
 * counts once this version knows it: a declaration that listed `CONTAINS_ALL` or `IIN` before
 * #108 part 4 added them receives them on upgrade.
 * Quantifiers and valuePath require reference emptiness for scoped joins. Other members are left for later
 * features. Anything else throws `INVALID_QUERY_FEATURES` (500).
 */
export const resolveQueryFeatures = (queryFeatures) => {
  if (queryFeatures == null) return { operators: new Set(LEGACY_QUERY_OPERATORS), referenceEmptiness: false, quantifiers: false, valuePath: false };
  if (typeof queryFeatures !== 'object' || Array.isArray(queryFeatures)) {
    invalidFeatures('must be an object with an operators array');
  }
  const { operators, referenceEmptiness, quantifiers, valuePath } = queryFeatures;
  if (!Array.isArray(operators) || operators.some((operator) => typeof operator !== 'string')) {
    invalidFeatures('operators must be an array of operator names');
  }
  if (referenceEmptiness != null && typeof referenceEmptiness !== 'boolean') {
    invalidFeatures('referenceEmptiness must be a boolean');
  }
  if (quantifiers != null && typeof quantifiers !== 'boolean') {
    invalidFeatures('quantifiers must be a boolean');
  }
  if (quantifiers === true && referenceEmptiness !== true) {
    invalidFeatures('quantifiers require referenceEmptiness: true');
  }
  if (valuePath != null && typeof valuePath !== 'boolean') invalidFeatures('valuePath must be a boolean');
  if (valuePath === true && referenceEmptiness !== true) invalidFeatures('valuePath requires referenceEmptiness: true');
  return {
    operators: new Set(operators.filter(isQueryOperator)),
    referenceEmptiness: referenceEmptiness === true,
    quantifiers: quantifiers === true,
    valuePath: valuePath === true,
  };
};
