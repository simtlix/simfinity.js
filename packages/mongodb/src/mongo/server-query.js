import {
  QueryBudget,
  assertQueryKeys,
  copyQueryLiteral,
  invalidQuery,
  isPlainQueryObject,
  queryArray,
  queryEntries,
  unsafeQueryKey,
} from './query-values.js';
import { parseLiteralRegex } from './query-regex.js';

const QUERY_KEYS = new Set(['dialect', 'filter', 'sort', 'window', 'projection']);
const WINDOW_KEYS = new Set(['skip', 'limit', 'unbounded']);
const LOGICAL_OPERATORS = new Set(['$and', '$or', '$nor']);
const COMPARISON_OPERATORS = new Set(['$eq', '$ne', '$lt', '$lte', '$gt', '$gte']);
const ARRAY_OPERATORS = new Set(['$in', '$nin', '$all']);
const BSON_TYPES = new Set([
  'string',
  'number',
  'double',
  'int',
  'long',
  'decimal',
  'date',
  'objectId',
  'bool',
  'object',
  'array',
  'null',
  'binData',
]);
const MAX_PATH_LENGTH = 1024;
const MAX_ARRAY_SIZE = 2 ** 31 - 1;

const parseWindow = (window, operation) => {
  assertQueryKeys(window, WINDOW_KEYS);
  if (window.unbounded === true) {
    if (Object.keys(window).length !== 1) {
      invalidQuery('Unbounded window cannot contain paging');
    }
    if (operation === 'page') {
      invalidQuery('Page requires a finite window', 'INVALID_PAGINATION');
    }
    return {};
  }
  const { skip = 0, limit } = window;
  const validSkip = Number.isSafeInteger(skip) && skip >= 0;
  const validLimit = Number.isSafeInteger(limit) && limit >= 1;
  if (Object.hasOwn(window, 'unbounded') || !validSkip || !validLimit) {
    invalidQuery('Window requires a positive limit and nonnegative skip', 'INVALID_PAGINATION');
  }
  return { skip, limit };
};

const assertArraySize = (value) => {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_ARRAY_SIZE) {
    invalidQuery('$size requires an integer from 0 through 2147483647');
  }
};

const overlapsPath = (left, right) =>
  left === right || left.startsWith(right + '.') || right.startsWith(left + '.');

/** Rebuilds a bounded semantic plan; never forwards caller-owned query data. */
class ServerQueryParser {
  constructor(resolve) {
    this.resolve = resolve;
    this.budget = new QueryBudget();
  }

  path(name) {
    this.budget.countNode();
    const validName = typeof name === 'string' && name && name.length <= MAX_PATH_LENGTH;
    if (!validName) {
      invalidQuery('Invalid query path', 'INVALID_FILTER_PATH');
    }
    const validParts = name
      .split('.')
      .every((part) => part && !unsafeQueryKey(part) && /^[A-Za-z0-9_]+$/.test(part));
    if (!validParts) {
      invalidQuery('Invalid query path', 'INVALID_FILTER_PATH');
    }
    return this.resolve(name);
  }

  inspectStructuredLiteral(value, field) {
    if (!this.path(field).structured || value === null) {
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry) => this.inspectStructuredLiteral(entry, field));
      return;
    }
    if (!isPlainQueryObject(value)) {
      return;
    }
    for (const [key, child] of queryEntries(value)) {
      this.inspectStructuredLiteral(child, field + '.' + key);
    }
  }

  fieldLiteral(value, field) {
    const copied = copyQueryLiteral(value, this.budget);
    this.inspectStructuredLiteral(copied, field);
    return copied;
  }

  elementMatch(operand, field, depth) {
    const members = queryEntries(operand);
    const scalar =
      members.length > 0 &&
      members.every(([key]) => key.startsWith('$') && !LOGICAL_OPERATORS.has(key));
    if (scalar) {
      return { terms: this.operators(operand, field, depth + 1) };
    }
    return {
      predicate: this.document(operand, field + '.', depth + 1),
      prefix: this.path(field).mongoPath + '.',
    };
  }

  operator(operator, operand, value, field, depth) {
    if (COMPARISON_OPERATORS.has(operator)) {
      return { operator, value: this.fieldLiteral(operand, field) };
    }
    if (ARRAY_OPERATORS.has(operator)) {
      if (!Array.isArray(operand)) {
        invalidQuery(operator + ' requires an array');
      }
      return { operator, value: this.fieldLiteral(operand, field) };
    }
    switch (operator) {
      case '$exists':
        if (typeof operand !== 'boolean') {
          invalidQuery('$exists requires a boolean');
        }
        return { operator, value: operand };
      case '$size':
        assertArraySize(operand);
        return { operator, value: operand };
      case '$type':
        if (!BSON_TYPES.has(operand)) {
          invalidQuery('Unsupported BSON type');
        }
        return { operator, value: operand };
      case '$regex':
        return { operator, value: parseLiteralRegex(operand, value.$options) };
      case '$options':
        if (!Object.hasOwn(value, '$regex')) {
          invalidQuery('$options requires $regex');
        }
        return null;
      case '$not':
        return { operator, terms: this.operators(operand, field, depth + 1) };
      case '$elemMatch':
        return { operator, ...this.elementMatch(operand, field, depth) };
      default:
        return invalidQuery('Unsupported filter operator: ' + operator, 'INVALID_FILTER_OPERATOR');
    }
  }

  operators(value, field, depth) {
    return this.budget.visit(value, depth, () => {
      const pairs = queryEntries(value);
      if (!pairs.length) {
        invalidQuery('Empty field operator object');
      }
      return pairs
        .map(([operator, operand]) => this.operator(operator, operand, value, field, depth))
        .filter((term) => term !== null);
    });
  }

  documentTerm(key, operand, prefix, depth) {
    if (LOGICAL_OPERATORS.has(key)) {
      const members = queryArray(operand);
      if (!members.length) {
        invalidQuery(key + ' requires a nonempty array');
      }
      return { kind: key, terms: members.map((item) => this.document(item, prefix, depth + 1)) };
    }
    const field = prefix + key;
    const resolved = this.path(field);
    const hasOperators =
      isPlainQueryObject(operand) && queryEntries(operand).some(([name]) => name.startsWith('$'));
    const terms = hasOperators
      ? this.operators(operand, field, depth + 1)
      : [{ operator: '$eq', value: this.fieldLiteral(operand, field) }];
    return { kind: 'field', path: resolved.mongoPath, terms };
  }

  document(value, prefix = '', depth = 0) {
    return this.budget.visit(value, depth, () => ({
      kind: '$and',
      terms: queryEntries(value).map(([key, operand]) =>
        this.documentTerm(key, operand, prefix, depth),
      ),
    }));
  }

  sort(value) {
    const result = {};
    const pairs = queryEntries(value);
    if (!pairs.length) {
      invalidQuery('Sort must not be empty', 'INVALID_SORT');
    }
    for (const [name, order] of pairs) {
      if (order !== 1 && order !== -1) {
        invalidQuery('Sort requires 1 or -1', 'INVALID_SORT');
      }
      const field = this.path(name);
      if (field.structured) {
        invalidQuery('Sort requires a scalar or explicitly dynamic field', 'INVALID_SORT');
      }
      if (Object.hasOwn(result, field.mongoPath)) {
        invalidQuery('Duplicate resolved sort field', 'INVALID_SORT');
      }
      result[field.mongoPath] = order;
    }
    return result;
  }

  projection(value) {
    const result = {};
    let mode;
    for (const [name, include] of queryEntries(value)) {
      if (include !== 0 && include !== 1) {
        invalidQuery('Projection requires 0 or 1');
      }
      const resolved = this.path(name).mongoPath;
      if (Object.keys(result).some((key) => overlapsPath(key, resolved))) {
        invalidQuery('Overlapping projection paths');
      }
      if (resolved !== '_id') {
        if (mode !== undefined && mode !== include) {
          invalidQuery('Cannot mix inclusion and exclusion projection');
        }
        mode = include;
      }
      result[resolved] = include;
    }
    if (!Object.keys(result).length) {
      invalidQuery('Projection must not be empty');
    }
    return result;
  }

  parse(query, operation) {
    assertQueryKeys(query, QUERY_KEYS);
    if (query.dialect !== 'mongodb') {
      invalidQuery('Unsupported query dialect', 'UNSUPPORTED_CAPABILITY');
    }
    const where = this.document(Object.hasOwn(query, 'filter') ? query.filter : {});
    const plan = { operation, where, sort: null, projection: null, window: null };
    if (operation === 'count') {
      if (
        query.sort !== undefined ||
        query.projection !== undefined ||
        query.window !== undefined
      ) {
        invalidQuery('Count does not accept sort, projection or window');
      }
      return plan;
    }
    plan.window = parseWindow(query.window, operation);
    if (query.sort !== undefined) {
      plan.sort = this.sort(query.sort);
    }
    if (query.projection !== undefined) {
      plan.projection = this.projection(query.projection);
    }
    return plan;
  }
}

export const parseServerQuery = (query, operation, resolve) =>
  new ServerQueryParser(resolve).parse(query, operation);

const lowerOperatorValue = (term) => {
  if (term.predicate) {
    return lowerServerPredicate(term.predicate, term.prefix);
  }
  if (term.terms) {
    return lowerOperators(term.terms);
  }
  return term.value;
};

const lowerOperators = (terms) => {
  const result = {};
  for (const term of terms) {
    if (term.operator === '$regex') {
      result.$regex = term.value.pattern;
      if (term.value.flags) {
        result.$options = term.value.flags;
      }
      continue;
    }
    result[term.operator] = lowerOperatorValue(term);
  }
  return result;
};

export const lowerServerPredicate = (node, prefix = '') => {
  if (node.kind === 'field') {
    return { [node.path.slice(prefix.length)]: lowerOperators(node.terms) };
  }
  if (!node.terms.length) {
    return {};
  }
  if (node.kind === '$and' && node.terms.length === 1) {
    return lowerServerPredicate(node.terms[0], prefix);
  }
  return { [node.kind]: node.terms.map((term) => lowerServerPredicate(term, prefix)) };
};
