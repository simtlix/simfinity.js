import { paginationStages } from './query-limits.js';
import SimfinityError from './errors/simfinity.error.js';
import {
  QUERY_OPERATORS, describeEmptiness, describeModelEmptiness, emptinessMemberPaths, emptinessScopeTargets, isEmptinessOperator,
  textQueryOperator, validateTextFilterValue,
} from './query-operators.js';

const fail = (message, code = 'INVALID_FILTER_VALUE') => { throw new SimfinityError(message, code, 400); };
// A client scope marker that cannot be honored: only the runtime writes `__scope` on a term or group
// condition, and fills it after middleware (#108 part 2b).
const detached = (message) => {
  throw new SimfinityError(`${message}; only the runtime writes and fills client scope markers (docs/guide/middleware.md)`, 'DETACHED_CLIENT_FILTER', 500);
};
const operators = new Set(QUERY_OPERATORS);
const reserved = new Set(['AND', 'OR', 'sort', 'pagination', 'aggregation']);
// `aggregation` is a generated argument only on aggregate endpoints; on find and count a field of
// that name is filtered like any other.
const listReserved = new Set(['AND', 'OR', 'sort', 'pagination']);
const controlArgs = (operation) => (operation === 'aggregate' ? reserved : listReserved);
const listOf = (value) => (Array.isArray(value) ? value : []);
const nestedGroups = (group) => [...listOf(group.AND), ...listOf(group.OR)];
// A term or condition path that names nothing: for the emptiness operators only, the field itself.
const isPathless = (path) => path == null || path === '';
const hasTermPath = (term) => typeof term?.path === 'string' && term.path !== '';

/**
 * Internal: the model paths named by generated query arguments, as `{ segments, group, operator,
 * construct }` entries. Covers filter keys and relation terms, AND/OR conditions, list sort terms,
 * and aggregation groupId and fact paths; aggregate sort terms name result keys. Outside aggregate
 * mode a key named `aggregation` is a field filter like any other. `group` is the AND/OR group
 * object whose `conditions` hold the path, or null for the other forms. `operator` is the operator
 * that reads the path, an omitted one read as `EQ`, or null for sort, groupId and fact paths.
 * `construct` is the term or group condition object that names the path, or null for a field
 * filter's own operator and for sort, groupId and fact paths. Malformed entries are left to the
 * backends. An emptiness term without a path (omitted, null or "") names its field, also next to
 * sibling terms that have paths.
 *
 * With `expandMembers` and the queried `gqltype`, the path of each emptiness condition is followed by
 * the stored member paths that condition reads (emptinessMemberPaths), as entries with the same
 * group, operator and construct and `member: true`, so that the checks of client paths apply to them.
 * Only client arguments are expanded.
 */
export const collectQueryPathEntries = (args, operation = 'find', { gqltype, expandMembers = false } = {}) => {
  const entries = [];
  const add = (path, group = null, operator = null, construct = null) => {
    if (typeof path === 'string' && path) entries.push({ segments: path.split('.'), group, operator, construct });
  };
  const addEmptiness = (path, group, operator, construct) => {
    add(path, group, operator, construct);
    if (!expandMembers || typeof path !== 'string' || !path) return;
    for (const segments of emptinessMemberPaths(gqltype, path.split('.'))) {
      entries.push({
        segments, group, operator, construct, member: true,
      });
    }
  };
  if (!args || typeof args !== 'object') return entries;
  const operatorOf = (item) => item?.operator ?? 'EQ';
  const visit = (group) => {
    if (!group || typeof group !== 'object') return;
    for (const condition of listOf(group.conditions)) {
      if (typeof condition?.field !== 'string') continue;
      const path = isPathless(condition.path) ? condition.field : `${condition.field}.${condition.path}`;
      if (isEmptinessOperator(condition.operator)) addEmptiness(path, group, condition.operator, condition);
      else add(path, group, operatorOf(condition), condition);
    }
    for (const item of nestedGroups(group)) visit(item);
  };
  const controls = controlArgs(operation);
  for (const [name, value] of Object.entries(args)) {
    if (controls.has(name) || value == null) continue;
    const terms = listOf(value.terms);
    const pathless = (term) => isEmptinessOperator(term?.operator) && isPathless(term.path);
    if (!terms.some(hasTermPath)) {
      const term = terms.find(pathless);
      if (term) addEmptiness(name, null, term.operator, term);
      else if (isEmptinessOperator(value.operator)) addEmptiness(name, null, value.operator, null);
      else add(name, null, operatorOf(value));
      continue;
    }
    let field = false;
    for (const term of terms) {
      if (hasTermPath(term)) {
        if (isEmptinessOperator(term.operator)) addEmptiness(`${name}.${term.path}`, null, term.operator, term);
        else add(`${name}.${term.path}`, null, operatorOf(term), term);
      } else if (!field && pathless(term)) {
        addEmptiness(name, null, term.operator, term);
        field = true;
      }
    }
    // An emptiness operator beside terms is rejected later; until then it reads the field too.
    if (!field && isEmptinessOperator(value.operator)) addEmptiness(name, null, value.operator, null);
  }
  for (const item of nestedGroups(args)) visit(item);
  if (operation === 'aggregate') {
    add(args.aggregation?.groupId);
    for (const fact of listOf(args.aggregation?.facts)) add(fact?.path);
  } else for (const term of listOf(args.sort?.terms)) add(term?.field);
  return entries;
};

/**
 * Internal: every condition the arguments hold, as `{ operator, path, segments, form, field, rawPath,
 * value, hasValue, ambiguous, depth, construct, emptiness }` entries: field filters, relation terms
 * and AND/OR group conditions at any depth, with an omitted operator read as `EQ`.
 * - `form` is 'filter' (an argument's own operator, without a terms array), 'beside-terms' (an
 *   operator written next to a terms array, which the compilers read only to reject an emptiness
 *   operator), 'term' or 'condition'.
 * - `field` is the argument or condition field as written (a condition's may be dotted) and `rawPath`
 *   the term or condition path as written. `path`, for messages, and `segments` join them; a path that
 *   is omitted, null or "" names the field itself.
 * - `value` is the condition's value, and `hasValue` whether it has an own `value` key.
 * - `ambiguous` marks a condition with both a dotted field and a non-empty path.
 * - `depth` is 0 for argument filters and for the groups listed in args.AND and args.OR, and one more
 *   for each nested group; a group reached at several depths reports the deepest.
 * - `construct` is the term or group condition object itself, or null for a field filter's own
 *   operator ('filter' and 'beside-terms'). These objects are the only ones that carry a client scope
 *   marker, `__scope` (#108 part 2b).
 * - `emptiness` tells whether the operator is IS_EMPTY or IS_NOT_EMPTY.
 * Sort, pagination and aggregation hold no operators. Malformed entries are skipped and left to the
 * backends; a group reached twice is read once.
 */
export const collectQueryOperators = (args, operation = 'find') => {
  const entries = [];
  if (!args || typeof args !== 'object') return entries;
  const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
  const add = (item, form, field, rawPath, depth, ambiguous = false) => {
    if (!isObject(item)) return;
    const path = isPathless(rawPath) ? field : `${field}.${rawPath}`;
    const operator = item.operator ?? 'EQ';
    entries.push({
      operator,
      path,
      segments: typeof path === 'string' && path ? path.split('.') : [],
      form,
      field,
      rawPath,
      value: item.value,
      hasValue: Object.hasOwn(item, 'value'),
      ambiguous,
      depth,
      construct: form === 'term' || form === 'condition' ? item : null,
      emptiness: isEmptinessOperator(operator),
    });
  };
  // The deepest level of each group, as the backends' depth limit counts it; a group inside itself is
  // not entered again.
  const depths = new Map();
  const open = new Set();
  const measure = (group, depth) => {
    if (!isObject(group) || open.has(group) || depths.get(group) >= depth) return;
    depths.set(group, depth);
    open.add(group);
    for (const item of nestedGroups(group)) measure(item, depth + 1);
    open.delete(group);
  };
  const visited = new Set();
  const visit = (group) => {
    if (!isObject(group) || visited.has(group)) return;
    visited.add(group);
    for (const condition of listOf(group.conditions)) {
      const field = condition?.field;
      const rawPath = condition?.path;
      add(condition, 'condition', field, rawPath, depths.get(group), typeof field === 'string' && field.includes('.') && !isPathless(rawPath));
    }
    for (const item of nestedGroups(group)) visit(item);
  };
  const controls = controlArgs(operation);
  for (const [name, value] of Object.entries(args)) {
    if (controls.has(name) || !isObject(value)) continue;
    // A relation filter's operators are in its terms; an operator beside them is read too, since a
    // backend that reads the field as a scalar would compile it.
    const terms = Array.isArray(value.terms);
    if (!terms || value.operator !== undefined) add(value, terms ? 'beside-terms' : 'filter', name, undefined, 0);
    if (terms) for (const term of value.terms) add(term, 'term', name, term?.path, 0);
  }
  for (const item of nestedGroups(args)) measure(item, 0);
  for (const item of nestedGroups(args)) visit(item);
  return entries;
};

/** Internal: the segment arrays of {@link collectQueryPathEntries}. */
export const collectQueryPaths = (args, operation = 'find') => (
  collectQueryPathEntries(args, operation).map((entry) => entry.segments)
);

/** Internal: visits each declared GraphQL field a path names, stopping at an unknown or leaf segment. */
export const walkQueryPath = (gqltype, segments, visit) => {
  let type = gqltype;
  for (const [index, fieldName] of segments.entries()) {
    const fields = typeof type?.getFields === 'function' ? type.getFields() : null;
    if (!fields || !Object.hasOwn(fields, fieldName)) return;
    const field = fields[fieldName];
    visit({ type, fieldName, field, index });
    type = field.type;
    while (type?.ofType) type = type.ofType;
  }
};

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

/**
 * Typed paths and logical groups; neither SQL nor Mongo pipeline objects are stored here. Operators
 * and values are validated here, text operators through validateTextFilterValue. With `operators`,
 * the names a compiler supports, any other QLOperator value fails with UNSUPPORTED_QUERY (400);
 * without it every QLOperator value is planned.
 *
 * The emptiness operators plan `{ kind: 'predicate', path, operator, value: null }`, whose path may
 * end at a scalar, a scalar list, an embedded list or an embedded object, after the checks of
 * describeEmptiness in their order (on the entity's GraphQL type, or on the field descriptions when
 * the description has none). A term or condition without a path tests the field itself; an emptiness
 * operator on an object filter without terms, or beside terms, fails with MISSING_FILTER_PATH. A
 * filter path of other operators that has more than one segment and ends at an object fails with
 * INVALID_FILTER_PATH; a bare object field keeps MISSING_FILTER_PATH.
 *
 * With `referenceEmptiness` (#108 part 2b; by default true when `operators` is omitted and false
 * when it is given), an emptiness path may also cross single references, end at a reference or a
 * collection, or read reference and collection members; without it they fail with UNSUPPORTED_QUERY.
 * Such a predicate is trusted, with stored semantics, unless its term or group condition carries the
 * client scope marker the runtime fills, `__scope: { id, scopes }`. Then the predicate gets `scopes:
 * { [path]: where | null }`, with one key for each path emptinessScopePaths lists for it: the plan of
 * that path's target find scope arguments, planned on the target type in its own frame, or null when
 * the scope added nothing. A `__scope` without filled `scopes`, without one of those keys, or on a
 * construct that reads no reference or collection fails with DETACHED_CLIENT_FILTER (500) after the
 * checks above; a `__scope` anywhere else is never read.
 */
export const createQueryPlan = (models, entityName, input = {}, {
  mode = 'find', operators: supported, referenceEmptiness = supported == null,
} = {}) => {
  const allowed = supported == null ? null : new Set(supported);
  const references = referenceEmptiness === true;
  const combine = (kind, terms) => {
    const active = terms.filter(Boolean);
    return active.length > 1 ? { kind, terms: active } : active[0] || null;
  };
  // The client scope marker of a construct, lifted into the predicate's `scopes`: each target scope's
  // arguments are planned on the target type, as trusted find arguments in their own frame, whatever
  // the query's mode, with the operator names already read (`operators` may be a one-time iterable).
  const liftScopes = (marker, shape, segments, operator) => {
    const label = `${operator} on ${segments.join('.')}`;
    const targets = emptinessScopeTargets(shape, segments);
    const paths = Object.keys(targets);
    if (!paths.length) detached(`${label} carries a client scope marker, but reads no reference or collection`);
    const scopes = marker?.scopes;
    if (!scopes || typeof scopes !== 'object' || Array.isArray(scopes)) detached(`${label} carries a client scope marker whose scopes are not filled`);
    const lifted = {};
    for (const path of paths) {
      if (!Object.hasOwn(scopes, path) || scopes[path] === undefined) detached(`${label} carries a client scope marker without the scope of ${path}`);
      lifted[path] = scopes[path] === null
        ? null
        : createQueryPlan(models, targets[path], scopes[path], { mode: 'find', operators: allowed ?? undefined, referenceEmptiness: references }).where;
    }
    return lifted;
  };
  const hasMarker = (construct) => construct != null && typeof construct === 'object' && Object.hasOwn(construct, '__scope');
  // Rule 1 has resolved the path; rule 2 is the compiler's operators, rules 3 to 6 describeEmptiness's.
  const emptiness = (path, steps, operator, value, construct) => {
    if (allowed && !allowed.has(operator)) fail(`The ${operator} filter operator is not supported by this query compiler`, 'UNSUPPORTED_QUERY');
    const segments = Array.isArray(path) ? path : path.split('.');
    const options = {
      operator, value, path: segments.join('.'), referenceEmptiness: references,
    };
    const gqltype = models.entities.find((item) => item.name === entityName)?.gqltype;
    const shape = gqltype ? describeEmptiness(gqltype, segments, options) : describeModelEmptiness(steps, options);
    const node = {
      kind: 'predicate', path: segments, operator, value: null,
    };
    if (hasMarker(construct)) node.scopes = liftScopes(construct.__scope, shape, segments, operator);
    return node;
  };
  // `construct` is the term or group condition that holds the predicate, the only objects whose
  // `__scope` is read; null for a field filter's own operator.
  const predicate = (path, operator, value, construct = null) => {
    const steps = resolveModelPath(models, entityName, path);
    const op = operator ?? 'EQ';
    if (isEmptinessOperator(op)) return emptiness(path, steps, op, value, construct);
    const field = steps.at(-1);
    if (field.kind !== 'scalar' && !field.inferred) {
      fail(`Filter on object field ${path} requires a scalar path`, steps.length > 1 ? 'INVALID_FILTER_PATH' : 'MISSING_FILTER_PATH');
    }
    if (!operators.has(op)) fail(`Unknown filter operator: ${op}`, 'INVALID_FILTER_OPERATOR');
    if (allowed && !allowed.has(op)) fail(`The ${op} filter operator is not supported by this query compiler`, 'UNSUPPORTED_QUERY');
    const collection = ['IN', 'NIN', 'BTW'].includes(op);
    if (value === undefined || (!collection && Array.isArray(value)) || (value === null && !['EQ', 'NE'].includes(op))) fail('Expected a scalar filter value');
    if (collection && Array.isArray(value) && value.some((item) => item == null || Array.isArray(item))) fail('Filter lists require non-null scalar elements');
    if (['IN', 'NIN', 'BTW'].includes(op) && !Array.isArray(value)) fail(`${op} requires an array value`);
    if (op === 'BTW' && value.length !== 2) fail('BTW requires two values');
    if (textQueryOperator(op)) validateTextFilterValue(op, value, field.scalar, path);
    if (hasMarker(construct)) detached(`${op} on ${Array.isArray(path) ? path.join('.') : path} carries a client scope marker, but is not an emptiness condition`);
    return { kind: 'predicate', path: Array.isArray(path) ? path : path.split('.'), operator: op, value: value === undefined ? null : value };
  };
  const validateGroup = (value, keys = ['conditions', 'AND', 'OR']) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected a filter group object');
    for (const key of keys) if (value[key] != null && !Array.isArray(value[key])) fail(`${key} requires an array`);
  };
  const group = (value, depth = 0) => {
    validateGroup(value);
    if (depth > 5) fail('Filter nesting too deep', 'FILTER_DEPTH_EXCEEDED');
    const terms = [];
    for (const condition of value.conditions || []) {
      if (!condition || typeof condition.field !== 'string') fail('Invalid filter path', 'INVALID_FILTER_PATH');
      if (condition.field.includes('.') && condition.path) fail('Filter condition cannot use both dotted field syntax and a separate path', 'AMBIGUOUS_FILTER_FIELD');
      terms.push(predicate(condition.path ? `${condition.field}.${condition.path}` : condition.field, condition.operator, condition.value, condition));
    }
    for (const item of value.AND || []) terms.push(group(item, depth + 1));
    terms.push(combine('or', (value.OR || []).map((item) => group(item, depth + 1))));
    return combine('and', terms);
  };
  // Top-level arguments are field filters plus AND/OR; `conditions` only lists conditions inside groups.
  validateGroup(input, ['AND', 'OR']);
  const controls = controlArgs(mode);
  const terms = [];
  for (const [name, value] of Object.entries(input)) {
    if (controls.has(name) || value == null) continue;
    const field = resolveModelPath(models, entityName, name).at(-1);
    if (typeof value !== 'object' || Array.isArray(value)) fail('Expected a filter object');
    const object = field.kind !== 'scalar' && !field.inferred;
    // Only trusted code writes these forms, since QLTypeFilterExpression has no operator. Other
    // operators beside terms are left out, as before.
    if (object && isEmptinessOperator(value.operator)) {
      fail(`Filter on ${name} takes ${value.operator} only in a term; to test the field itself, use a term without a path: `
        + `${name}: { terms: [{ operator: ${value.operator} }] }`, 'MISSING_FILTER_PATH');
    }
    if (object && (!Array.isArray(value.terms) || !value.terms.length)) fail('Object filters require non-empty terms', 'MISSING_FILTER_PATH');
    if (!object) terms.push(predicate(name, value.operator, value.value));
    else for (const term of value.terms) {
      if (!term || typeof term !== 'object' || Array.isArray(term)) fail('Expected a relationship filter term');
      if (isEmptinessOperator(term.operator) && isPathless(term.path)) {
        terms.push(predicate(name, term.operator, term.value, term));
        continue;
      }
      if (typeof term.path !== 'string' || !term.path) fail('Relationship terms require a path', 'INVALID_FILTER_PATH');
      terms.push(predicate(`${name}.${term.path}`, term.operator, term.value, term));
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
    if (typeof sort.field !== 'string' || sort.field.split('.').some((part) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))) {
      fail('Invalid sort path', 'INVALID_FILTER_PATH');
    }
    if (mode !== 'aggregate') {
      const field = resolveModelPath(models, entityName, sort.field).at(-1);
      if (field.kind !== 'scalar' && !field.inferred) fail('Sort path must end in a scalar field', 'INVALID_FILTER_PATH');
    }
    plan.sort.push({ path: sort.field.split('.'), order: sort.order });
  }
  return plan;
};
