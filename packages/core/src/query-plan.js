import { GROUP_KEYS, QUANTIFIED_LISTS } from './const/QLQuantifier.js';
import { aggregateJoinPrefixes, crossingKeys, frameCollectionPaths, validateQuantifiedGroups } from './query-frames.js';
import { paginationStages } from './query-limits.js';
import SimfinityError from './errors/simfinity.error.js';
import {
  describeEmptiness, describeModelEmptiness, emptinessMemberPaths, emptinessScopeTargets, isEmptinessOperator, isQueryOperator,
  takesListValue, textQueryOperator, validateContainsAllValue, validateTextFilterValue, validateTextListFilterValue,
} from './query-operators.js';

const fail = (message, code = 'INVALID_FILTER_VALUE') => { throw new SimfinityError(message, code, 400); };
// A client scope marker that cannot be honored: only the runtime writes `__scope` on a term or group
// condition, and fills it after middleware (#108 part 2b).
const detached = (message) => {
  throw new SimfinityError(`${message}; only the runtime writes and fills client scope markers (docs/guide/middleware.md)`, 'DETACHED_CLIENT_FILTER', 500);
};
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

/** Internal: rejects group keys the query walker cannot inspect. Shape checks belong to the validator. */
export const validateQueryGroupKeys = (group, { quantified = false } = {}) => {
  for (const key of Object.keys(group)) {
    if (!GROUP_KEYS.has(key) || (key === 'path' && !quantified)) fail(`Unknown filter group key: ${key}`);
  }
};

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const pathSegments = (path) => (typeof path === 'string' && path ? path.split('.') : []);
const conditionPath = (field, path) => (isPathless(path) ? field : `${field}.${path}`);

// One graph walk for both collectors. Records are emitted after visiting so a group shared at
// several depths reports its deepest occurrence in that frame. Each quantified record owns a
// distinct child frame; the parent frame, construct and quantifier distinguish aliased positions.
const walkQueryEntries = (args, operation, { paths = false, gqltype, expandMembers = false } = {}) => {
  const entries = [];
  if (!args || typeof args !== 'object') return entries;
  const root = { base: [], frames: [], groups: new Map() };
  const records = [];
  const open = new Set();
  const childFrame = (parent, path, quantifier, construct, anchor = []) => ({
    base: [...parent.base, ...anchor, ...pathSegments(path)],
    frames: [...parent.frames, { path, type: quantifier, construct }],
    groups: new Map(),
  });
  const visit = (group, frame, parentDepth, quantifier = null) => {
    // Object cycles are cut even when a quantified edge would otherwise create another frame.
    if (!isObject(group) || open.has(group)) return;
    validateQueryGroupKeys(group, { quantified: quantifier !== null });
    const depth = parentDepth + (group.__implicit === true ? 0 : 1);
    let positions = frame.groups.get(group);
    if (!positions) {
      positions = new Map();
      frame.groups.set(group, positions);
    }
    let record = positions.get(quantifier);
    if (record && record.depth >= depth) return;
    if (!record) {
      const anchor = group.__implicit === true && Array.isArray(group.__anchor) ? group.__anchor : [];
      record = {
        group, frame, quantifier, depth, anchor,
        inner: quantifier === null ? frame : childFrame(frame, group.path, quantifier, group, anchor),
      };
      positions.set(quantifier, record);
      records.push(record);
    } else record.depth = depth;
    open.add(group);
    for (const item of nestedGroups(group)) visit(item, record.inner, depth);
    for (const type of QUANTIFIED_LISTS) {
      for (const item of listOf(group[type])) visit(item, record.inner, depth, type);
    }
    open.delete(group);
  };
  const controls = controlArgs(operation);
  for (const [name, value] of Object.entries(args)) {
    if (!controls.has(name) && value != null) records.push({ name, value });
  }
  for (const group of nestedGroups(args)) visit(group, root, -1);

  const metadata = (relative, frame, container, use = 'filter') => ({
    segments: [...frame.base, ...relative], relative, frames: frame.frames, container, use,
  });
  const addPath = (path, frame, container, group = null, operator = null, construct = null, extra = {}) => {
    if (typeof path !== 'string' || !path) return;
    const relative = path.split('.');
    const entry = { ...metadata(relative, frame, container), group, operator, construct, ...extra };
    entries.push(entry);
    if (!expandMembers || !isEmptinessOperator(operator)) return;
    for (const segments of emptinessMemberPaths(gqltype, entry.segments)) {
      entries.push({ ...entry, segments, relative: segments.slice(frame.base.length), member: true });
    }
  };
  const addOperator = (item, form, field, rawPath, depth, frame, container, relativePath, quantifier) => {
    if (!isObject(item)) return;
    const quantified = form === 'quantified';
    const relative = pathSegments(relativePath);
    const meta = metadata(relative, frame, container);
    const operator = quantified ? null : item.operator ?? 'EQ';
    const path = typeof relativePath === 'string' ? meta.segments.join('.') : relativePath;
    entries.push({
      ...meta,
      operator,
      path,
      form,
      field,
      rawPath,
      value: item.value,
      hasValue: Object.hasOwn(item, 'value'),
      ambiguous: form === 'condition' && typeof field === 'string' && field.includes('.') && !isPathless(rawPath),
      depth,
      construct: quantified || form === 'term' || form === 'condition' ? item : null,
      emptiness: isEmptinessOperator(operator),
      ...(quantified ? { quantifier } : {}),
    });
  };
  const addQuantified = (construct, path, quantifier, frame, container, depth) => {
    if (paths) addPath(path, frame, container, null, null, construct, { quantifier });
    else addOperator(construct, 'quantified', path, undefined, depth, frame, container, path, quantifier);
  };
  for (const record of records) {
    if (Object.hasOwn(record, 'group')) {
      const { group, frame, inner, quantifier, depth, anchor } = record;
      if (quantifier !== null) {
        const path = anchor.length && typeof group.path === 'string' ? [...anchor, group.path].join('.') : group.path;
        addQuantified(group, path, quantifier, frame, group, depth);
      }
      for (const condition of listOf(group.conditions)) {
        const field = condition?.field;
        const path = conditionPath(field, condition?.path);
        if (paths) {
          if (typeof field === 'string') addPath(path, inner, group, group, condition.operator ?? 'EQ', condition);
        } else addOperator(condition, 'condition', field, condition?.path, depth, inner, group, path);
      }
      continue;
    }
    const { name, value } = record;
    const terms = listOf(value.terms);
    if (value.quantifier != null) {
      addQuantified(value, name, value.quantifier, root, value, 0);
      const frame = childFrame(root, name, value.quantifier, value);
      for (const term of terms) {
        if (!isObject(term)) continue;
        if (paths) {
          // Invalid path-less terms still name the field, as before; validation rejects them
          // before authorization marking. Their relative path names nothing in the child.
          if (hasTermPath(term)) addPath(term.path, frame, value, null, term.operator ?? 'EQ', term);
          else if (isPathless(term.path)) {
            entries.push({ ...metadata([], frame, value), group: null, operator: term.operator ?? 'EQ', construct: term });
          }
        } else addOperator(term, 'term', name, term.path, 0, frame, value, isPathless(term.path) ? '' : term.path);
      }
      continue;
    }
    if (!paths) {
      const hasTerms = Array.isArray(value.terms);
      if (!hasTerms || value.operator !== undefined) addOperator(value, hasTerms ? 'beside-terms' : 'filter', name, undefined, 0, root, value, name);
      if (hasTerms) for (const term of terms) addOperator(term, 'term', name, term?.path, 0, root, value, conditionPath(name, term?.path));
      continue;
    }
    const pathless = (term) => isEmptinessOperator(term?.operator) && isPathless(term.path);
    if (!terms.some(hasTermPath)) {
      const term = terms.find(pathless);
      if (term) addPath(name, root, value, null, term.operator, term);
      else addPath(name, root, value, null, value.operator ?? 'EQ');
      continue;
    }
    let field = false;
    for (const term of terms) {
      if (hasTermPath(term)) addPath(`${name}.${term.path}`, root, value, null, term.operator ?? 'EQ', term);
      else if (!field && pathless(term)) {
        addPath(name, root, value, null, term.operator, term);
        field = true;
      }
    }
    // An emptiness operator beside terms is rejected later; until then it reads the field too.
    if (!field && isEmptinessOperator(value.operator)) addPath(name, root, value, null, value.operator);
  }
  if (paths) {
    const addUse = (path, use) => addPath(path, root, null, null, null, null, { use });
    if (operation === 'aggregate') {
      addUse(args.aggregation?.groupId, 'groupId');
      for (const fact of listOf(args.aggregation?.facts)) addUse(fact?.path, 'fact');
    } else for (const term of listOf(args.sort?.terms)) addUse(term?.field, 'sort');
  }
  return entries;
};

/**
 * Internal: model paths named by filter keys, terms, logical/quantified groups, sort, groupId and
 * facts. Each entry carries `use`, the correlation `container`, enclosing `frames` (relative path,
 * quantifier `type`, marker `construct`), `relative` segments in its frame and absolute `segments`.
 * A quantified carrier names its path in the containing frame, with `quantifier` and its own
 * construct; children enter its frame. The legacy `group` remains the conditions owner, otherwise
 * null; operator and construct retain their old meanings except that quantifier filters now carry
 * their own construct. An omitted filter operator is EQ; non-filter reads and quantified carriers
 * have no operator. `expandMembers` appends stored emptiness member paths, preserving metadata.
 */
export const collectQueryPathEntries = (args, operation = 'find', options = {}) => (
  walkQueryEntries(args, operation, { ...options, paths: true })
);

/**
 * Internal: filter constructs only, with the same frame metadata as the path collector. Preserves
 * form, field, rawPath, value, hasValue, ambiguous, deepest depth and emptiness. Quantified carriers
 * have form `quantified`, operator null and their own construct; ordinary own filter operators keep
 * construct null. Explicit groups add a depth level, implicit ones none. Invalid entries are left
 * to the validator; unknown group keys and path on a plain group fail closed here.
 */
export const collectQueryOperators = (args, operation = 'find') => walkQueryEntries(args, operation);

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
 * and values are validated here, text operators through validateTextFilterValue, CONTAINS_ALL
 * through validateContainsAllValue and IIN through validateTextListFilterValue. With `operators`,
 * the names a compiler supports, any other QLOperator value fails with UNSUPPORTED_QUERY (400);
 * without it every QLOperator value is planned.
 *
 * The list operators (#108 part 4) plan `{ kind: 'predicate', path, operator, value }` with the
 * array as validated, neither cast nor deduplicated: CONTAINS_ALL's is a non-empty array of
 * non-null scalars, on a scalar list or a scalar reached through embedded lists; IIN's is an array
 * of strings, possibly empty, on a String field or list. CONTAINS_ALL's path and leaf rules are the
 * shared validator's, which runs first: through a collection or a reference inside an embedded
 * list it fails with INVALID_FILTER_PATH, on any other leaf with INVALID_FILTER_OPERATOR. IIN
 * through a collection becomes a correlated ANY frame like IN, and CONTAINS_ALL is never cut.
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
 * checks above. With `quantifiers`, collection scalar paths become correlated ANY frames,
 * explicit ANY/ALL/NONE and quantifier filters retain their quantifier, and scoped reference
 * crossings inside a frame lift into `joins`. Aggregate collection joins remain legacy; later
 * frames carry their legacy chain in `anchor`. Sorts through collections fail even in count mode.
 */
export const createQueryPlan = (models, entityName, source = {}, {
  mode = 'find', operators: supported, referenceEmptiness = supported == null, quantifiers = supported == null,
} = {}) => {
  let input = source;
  const allowed = supported == null ? null : new Set(supported);
  const references = referenceEmptiness === true;
  const combine = (kind, terms) => {
    const active = terms.filter(Boolean);
    return active.length > 1 ? { kind, terms: active } : active[0] || null;
  };
  // The client scope marker of a construct, lifted into the predicate's `scopes`: each target scope's
  // arguments are planned on the target type, as trusted find arguments in their own frame, whatever
  // the query's mode, with the operator names already read (`operators` may be a one-time iterable).
  const liftScopes = (marker, targets, segments, operator) => {
    const label = `${operator} on ${segments.join('.')}`;
    const paths = Object.keys(targets);
    if (!paths.length) detached(`${label} carries a client scope marker, but reads no reference or collection`);
    const scopes = marker?.scopes;
    if (!scopes || typeof scopes !== 'object' || Array.isArray(scopes)) detached(`${label} carries a client scope marker whose scopes are not filled`);
    const lifted = {};
    for (const path of paths) {
      if (!Object.hasOwn(scopes, path) || scopes[path] === undefined) detached(`${label} carries a client scope marker without the scope of ${path}`);
      if (scopes[path] !== null && (!isObject(scopes[path]) || ![Object.prototype, null].includes(Object.getPrototypeOf(scopes[path])))) detached(`${label} carries a malformed scope of ${path}`);
      lifted[path] = scopes[path] === null
        ? null
        : createQueryPlan(models, targets[path], scopes[path], { mode: 'find', operators: allowed ?? undefined, referenceEmptiness: references, quantifiers }).where;
    }
    return lifted;
  };
  const hasMarker = (construct) => construct != null && typeof construct === 'object' && Object.hasOwn(construct, '__scope');
  // Rule 1 has resolved the path; rule 2 is the compiler's operators, rules 3 to 6 describeEmptiness's.
  const emptiness = (path, steps, operator, value, construct, frameEntity) => {
    if (allowed && !allowed.has(operator)) fail(`The ${operator} filter operator is not supported by this query compiler`, 'UNSUPPORTED_QUERY');
    const segments = Array.isArray(path) ? path : path.split('.');
    const options = {
      operator, value, path: segments.join('.'), referenceEmptiness: references,
    };
    const gqltype = models.entities.find((item) => item.name === frameEntity)?.gqltype;
    const shape = gqltype ? describeEmptiness(gqltype, segments, options) : describeModelEmptiness(steps, options);
    const node = {
      kind: 'predicate', path: segments, operator, value: null,
    };
    if (hasMarker(construct)) node.scopes = liftScopes(construct.__scope, emptinessScopeTargets(shape, segments), segments, operator);
    return node;
  };
  // `construct` is the term or group condition that holds the predicate, the only objects whose
  // `__scope` is read; null for a field filter's own operator.
  const predicate = (path, operator, value, construct = null, frameEntity = entityName, inFrame = false) => {
    const steps = resolveModelPath(models, frameEntity, path);
    const op = operator ?? 'EQ';
    if (isEmptinessOperator(op)) return emptiness(path, steps, op, value, construct, frameEntity);
    const field = steps.at(-1);
    if (field.kind !== 'scalar' && !field.inferred) {
      fail(`Filter on object field ${path} requires a scalar path`, steps.length > 1 ? 'INVALID_FILTER_PATH' : 'MISSING_FILTER_PATH');
    }
    if (!isQueryOperator(op)) fail(`Unknown filter operator: ${op}`, 'INVALID_FILTER_OPERATOR');
    if (allowed && !allowed.has(op)) fail(`The ${op} filter operator is not supported by this query compiler`, 'UNSUPPORTED_QUERY');
    const collection = takesListValue(op);
    if (value === undefined || (!collection && Array.isArray(value)) || (value === null && !['EQ', 'NE'].includes(op))) fail('Expected a scalar filter value');
    if (collection && Array.isArray(value) && value.some((item) => item == null || Array.isArray(item))) fail('Filter lists require non-null scalar elements');
    if (collection && !Array.isArray(value)) fail(`${op} requires an array value`);
    if (op === 'BTW' && value.length !== 2) fail('BTW requires two values');
    if (textQueryOperator(op)) validateTextFilterValue(op, value, field.scalar, path);
    if (op === 'CONTAINS_ALL') validateContainsAllValue(value);
    if (op === 'IIN') validateTextListFilterValue(op, value, field.scalar, path);
    const node = { kind: 'predicate', path: Array.isArray(path) ? path : path.split('.'), operator: op, value: value === undefined ? null : value };
    if (hasMarker(construct)) {
      if (!inFrame) detached(`${op} on ${node.path.join('.')} carries a client scope marker, but is not an emptiness condition`);
      const targets = Object.fromEntries(crossingKeys(node.path, { models, entity: frameEntity }).map((key) => [key, resolveModelPath(models, frameEntity, key).at(-1).target]));
      node.joins = liftScopes(construct.__scope, targets, node.path, op);
    }
    return node;
  };
  const validateGroup = (value, keys = ['conditions', 'AND', 'OR']) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('Expected a filter group object');
    for (const key of keys) if (value[key] != null && !Array.isArray(value[key])) fail(`${key} requires an array`);
  };
  const group = (value, depth = -1, frameEntity = entityName, inFrame = false) => {
    validateGroup(value);
    const level = depth + (value.__implicit === true ? 0 : 1);
    if (level > 5) fail('Filter nesting too deep', 'FILTER_DEPTH_EXCEEDED');
    const terms = [];
    for (const condition of value.conditions || []) {
      if (!condition || typeof condition.field !== 'string') fail('Invalid filter path', 'INVALID_FILTER_PATH');
      if (condition.field.includes('.') && condition.path) fail('Filter condition cannot use both dotted field syntax and a separate path', 'AMBIGUOUS_FILTER_FIELD');
      terms.push(predicate(condition.path ? `${condition.field}.${condition.path}` : condition.field, condition.operator, condition.value, condition, frameEntity, inFrame));
    }
    if (quantifiers !== true && QUANTIFIED_LISTS.some((key) => value[key] != null)) {
      fail('Quantified groups are not supported by this query compiler', 'UNSUPPORTED_QUERY');
    }
    for (const quantifier of QUANTIFIED_LISTS) for (const item of value[quantifier] || []) {
      const anchor = item.__implicit === true ? item.__anchor : undefined;
      const path = item.path.split('.');
      const target = resolveModelPath(models, frameEntity, [...(anchor ?? []), ...path]).at(-1).target;
      const node = { kind: 'quantified', quantifier, path, where: group(item, level, target, true), scope: null };
      if (anchor?.length) node.anchor = anchor;
      if (hasMarker(item)) {
        const fullPath = [...(anchor ?? []), ...path];
        const key = fullPath.join('.');
        const crossings = anchor?.length ? [] : crossingKeys(path, { models, entity: frameEntity });
        const targets = Object.fromEntries(crossings.map((prefix) => [prefix, resolveModelPath(models, frameEntity, prefix).at(-1).target]));
        targets[key] = target;
        const scopes = liftScopes(item.__scope, targets, fullPath, quantifier);
        node.scope = scopes[key];
        if (anchor?.length) {
          for (const prefix of J) if (key.startsWith(`${prefix}.`)) {
            if (!Object.hasOwn(item.__scope.scopes, prefix) || item.__scope.scopes[prefix] !== null) detached(`${quantifier} on ${key} requires a null aggregate anchor scope for ${prefix}`);
          }
        } else if (crossings.length) node.joins = Object.fromEntries(crossings.map((prefix) => [prefix, scopes[prefix]]));
      }
      terms.push(node);
    }
    for (const item of value.AND || []) terms.push(group(item, level, frameEntity, inFrame));
    terms.push(combine('or', (value.OR || []).map((item) => group(item, level, frameEntity, inFrame))));
    return combine('and', terms);
  };
  // Validate received arguments in filled-marker mode before the pure, frame-producing rewrite.
  validateGroup(input, ['AND', 'OR']);
  const context = { models, entity: entityName, operation: mode, operators: allowed, referenceEmptiness: references, quantifiers };
  const J = mode === 'aggregate' ? aggregateJoinPrefixes(input.aggregation, context) : new Set();
  context.J = J;
  validateQuantifiedGroups(input, context);
  input = frameCollectionPaths(input, context);
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
  for (const sort of input.sort?.terms || []) {
    if (!sort || (sort.order !== 'ASC' && sort.order !== 'DESC')) fail('Invalid sort order', 'INVALID_SORT');
    if (typeof sort.field !== 'string' || sort.field.split('.').some((part) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))) {
      fail('Invalid sort path', 'INVALID_FILTER_PATH');
    }
    if (mode !== 'aggregate') {
      const steps = resolveModelPath(models, entityName, sort.field);
      let owner = entityName;
      for (const step of steps) {
        if (step.kind === 'collection') fail(`Sort path ${sort.field} crosses the collection ${owner}.${step.name}; a record has no single value there`, 'INVALID_FILTER_PATH');
        if (step.target && !step.inferred) owner = step.target;
      }
      const field = steps.at(-1);
      if (field.kind !== 'scalar' && !field.inferred) fail('Sort path must end in a scalar field', 'INVALID_FILTER_PATH');
    }
    if (mode !== 'count') plan.sort.push({ path: sort.field.split('.'), order: sort.order });
  }
  return plan;
};
