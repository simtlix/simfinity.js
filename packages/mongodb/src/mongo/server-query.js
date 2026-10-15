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
import { parseFieldOperator } from './query-operators.js';
import { parseWindow, parseSort, parseProjection } from './query-shape.js';

const QUERY_KEYS = new Set(['dialect', 'filter', 'sort', 'window', 'projection']);
const LOGICAL_OPERATORS = new Set(['$and', '$or', '$nor']);
const MAX_PATH_LENGTH = 1024;

const assertCountShape = (query) => {
  if (query.sort !== undefined || query.projection !== undefined || query.window !== undefined) {
    invalidQuery('Count does not accept sort, projection or window');
  }
};

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

  operators(value, field, depth) {
    return this.budget.visit(value, depth, () => {
      const pairs = queryEntries(value);
      if (!pairs.length) {
        invalidQuery('Empty field operator object');
      }
      return pairs
        .map(([operator, operand]) => parseFieldOperator(this, { operator, operand, value, field, depth }))
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

  parse(query, operation) {
    assertQueryKeys(query, QUERY_KEYS);
    if (query.dialect !== 'mongodb') {
      invalidQuery('Unsupported query dialect', 'UNSUPPORTED_CAPABILITY');
    }
    const where = this.document(Object.hasOwn(query, 'filter') ? query.filter : {});
    const plan = { operation, where, sort: null, projection: null, window: null };
    if (operation === 'count') {
      assertCountShape(query);
      return plan;
    }
    plan.window = parseWindow(query.window, operation);
    if (query.sort !== undefined) {
      plan.sort = parseSort(query.sort, (path) => this.path(path));
    }
    if (query.projection !== undefined) {
      plan.projection = parseProjection(query.projection, (path) => this.path(path));
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
