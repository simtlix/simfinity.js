import { paginationStages } from './query-limits.js';
import SimfinityError from './errors/simfinity.error.js';

const fail = (message, code = 'INVALID_FILTER_VALUE') => { throw new SimfinityError(message, code, 400); };
const operators = new Set(['EQ', 'NE', 'LT', 'LTE', 'GT', 'GTE', 'BTW', 'IN', 'NIN', 'LIKE']);
const reserved = new Set(['AND', 'OR', 'sort', 'pagination', 'aggregation']);

export const resolveModelPath = (models, entityName, path) => {
  const parts = Array.isArray(path) ? path : typeof path === 'string' ? path.split('.') : [];
  if (!parts.length || parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))) fail('Invalid filter path', 'INVALID_FILTER_PATH');
  let entity = models.entities.find((item) => item.name === entityName);
  if (!entity) fail(`Unknown entity ${entityName}`, 'INVALID_FILTER_FIELD');
  let fields = entity.fields;
  const steps = [];
  for (let index = 0; index < parts.length; index++) {
    const field = fields.find((item) => item.name === parts[index] && !item.private);
    if (!field) fail(`Unknown field ${parts.slice(0, index + 1).join('.')}`, 'INVALID_FILTER_FIELD');
    steps.push(field);
    if (index < parts.length - 1) {
      if (field.kind === 'embedded') fields = field.fields;
      else if (field.target && !field.inferred) {
        entity = models.entities.find((item) => item.name === field.target);
        fields = entity.fields;
      } else fail(`Field ${field.name} cannot be traversed`, 'INVALID_FILTER_PATH');
    }
  }
  return steps;
};

/** Typed paths and logical groups; neither SQL nor Mongo pipeline objects are stored here. */
export const createQueryPlan = (models, entityName, input = {}, { mode = 'find' } = {}) => {
  const combine = (kind, terms) => {
    const active = terms.filter(Boolean);
    return active.length > 1 ? { kind, terms: active } : active[0] || null;
  };
  const predicate = (path, operator, value) => {
    const steps = resolveModelPath(models, entityName, path);
    const field = steps.at(-1);
    if (field.kind !== 'scalar' && !field.inferred) fail(`Filter on object field ${path} requires a scalar path`, 'MISSING_FILTER_PATH');
    const op = operator ?? 'EQ';
    if (!operators.has(op)) fail(`Unknown filter operator: ${op}`, 'INVALID_FILTER_OPERATOR');
    const collection = ['IN', 'NIN', 'BTW'].includes(op);
    if (value === undefined || (!collection && Array.isArray(value)) || (value === null && !['EQ', 'NE'].includes(op))) fail('Expected a scalar filter value');
    if (collection && Array.isArray(value) && value.some((item) => item == null || Array.isArray(item))) fail('Filter lists require non-null scalar elements');
    if (['IN', 'NIN', 'BTW'].includes(op) && !Array.isArray(value)) fail(`${op} requires an array value`);
    if (op === 'BTW' && value.length !== 2) fail('BTW requires two values');
    return { kind: 'predicate', path: Array.isArray(path) ? path : path.split('.'), operator: op, value: value === undefined ? null : value };
  };
  const validateGroup = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected a filter group object');
    for (const key of ['conditions', 'AND', 'OR']) if (value[key] != null && !Array.isArray(value[key])) fail(`${key} requires an array`);
  };
  const group = (value, depth = 0) => {
    validateGroup(value);
    if (depth > 5) fail('Filter nesting too deep', 'FILTER_DEPTH_EXCEEDED');
    const terms = [];
    for (const condition of value.conditions || []) {
      if (!condition || typeof condition.field !== 'string') fail('Invalid filter path', 'INVALID_FILTER_PATH');
      if (condition.field.includes('.') && condition.path) fail('Filter condition cannot use both dotted field syntax and a separate path', 'AMBIGUOUS_FILTER_FIELD');
      terms.push(predicate(condition.path ? `${condition.field}.${condition.path}` : condition.field, condition.operator, condition.value));
    }
    for (const item of value.AND || []) terms.push(group(item, depth + 1));
    terms.push(combine('or', (value.OR || []).map((item) => group(item, depth + 1))));
    return combine('and', terms);
  };
  validateGroup(input);
  const terms = [];
  for (const [name, value] of Object.entries(input)) {
    if (reserved.has(name) || value == null) continue;
    const field = resolveModelPath(models, entityName, name).at(-1);
    if (typeof value !== 'object' || Array.isArray(value)) fail('Expected a filter object');
    if (field.kind !== 'scalar' && !field.inferred && (!Array.isArray(value.terms) || !value.terms.length)) fail('Object filters require non-empty terms', 'MISSING_FILTER_PATH');
    if (field.kind === 'scalar' || field.inferred) terms.push(predicate(name, value.operator, value.value));
    else for (const term of value.terms) {
      if (!term || typeof term !== 'object' || Array.isArray(term)) fail('Expected a relationship filter term');
      if (typeof term.path !== 'string' || !term.path) fail('Relationship terms require a path', 'INVALID_FILTER_PATH');
      terms.push(predicate(`${name}.${term.path}`, term.operator, term.value));
    }
  }
  for (const item of input.AND || []) terms.push(group(item));
  terms.push(combine('or', (input.OR || []).map((item) => group(item))));
  const paging = paginationStages(input.pagination, mode === 'find');
  const plan = { entity: entityName, where: combine('and', terms), mode, sort: [], pagination: mode !== 'count' && paging.length ? { limit: paging[1].$limit, offset: paging[0].$skip } : null };
  if (mode === 'aggregate') {
    const aggregation = input.aggregation;
    if (!aggregation?.groupId || !Array.isArray(aggregation.facts) || !aggregation.facts.length) fail('Aggregation requires a groupId and facts');
    resolveModelPath(models, entityName, aggregation.groupId);
    const seen = new Set();
    for (const fact of aggregation.facts) {
      if (!['SUM', 'COUNT', 'AVG', 'MIN', 'MAX'].includes(fact.operation)) fail('Invalid aggregate operation');
      if (typeof fact.factName !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(fact.factName) || ['__proto__', 'constructor', 'prototype'].includes(fact.factName) || seen.has(fact.factName)) fail('Invalid or duplicate aggregation fact name');
      seen.add(fact.factName);
      resolveModelPath(models, entityName, fact.path);
    }
    plan.aggregation = { groupId: aggregation.groupId.split('.'), facts: aggregation.facts.map((fact) => ({ ...fact, path: fact.path.split('.') })) };
  }
  if (input.sort && (!Array.isArray(input.sort.terms) || !input.sort.terms.length)) fail('Sort requires non-empty terms', 'INVALID_SORT');
  if (mode !== 'count') for (const sort of input.sort?.terms || []) {
    if (!sort || (sort.order !== 'ASC' && sort.order !== 'DESC')) fail('Invalid sort order', 'INVALID_SORT');
    if (mode !== 'aggregate') {
      const field = resolveModelPath(models, entityName, sort.field).at(-1);
      if (field.kind !== 'scalar' && !field.inferred) fail('Sort path must end in a scalar field', 'INVALID_FILTER_PATH');
    }
    plan.sort.push({ path: sort.field.split('.'), order: sort.order });
  }
  return plan;
};
