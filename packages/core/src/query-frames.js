import { getNamedType, isEnumType, isObjectType } from 'graphql';
import { GROUP_KEYS, QUANTIFIED_LISTS, QUANTIFIERS } from './const/QLQuantifier.js';
import SimfinityError from './errors/simfinity.error.js';
import { effectiveScalarName } from './metadata.js';
import { isVirtualField } from './relation-storage.js';
import {
  describeEmptiness, describeModelEmptiness, emptinessScopePaths, graphqlStep, isEmptinessOperator, modelStep,
} from './query-emptiness.js';
import {
  assertContainsAllPath, isQueryOperator, takesListValue, textQueryOperator, validateContainsAllValue, validateTextFilterValue,
  validateTextListFilterValue, hasValuePath, validateComparisonOperand, validateComparisonTypes,
} from './query-operators.js';
import { collectQueryOperators, validateQueryGroupKeys } from './query-plan.js';
import { getQueryMaxFrameNesting } from './query-limits.js';

export { GROUP_KEYS };
export const IMPLICIT_KEY = '__implicit';
export const ANCHOR_KEY = '__anchor';

const fail = (message, code = 'INVALID_FILTER_VALUE') => { throw new SimfinityError(message, code, 400); };
const detached = (message) => { throw new SimfinityError(message, 'DETACHED_CLIENT_FILTER', 500); };
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const plain = (value) => object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const list = (value) => (Array.isArray(value) ? value : []);
const pathless = (value) => value == null || value === '';
const relation = (step) => ['reference', 'collection'].includes(step.kind);
const controls = (operation) => new Set(['AND', 'OR', 'sort', 'pagination', ...(operation === 'aggregate' ? ['aggregation'] : [])]);
const hasMarker = (value) => object(value) && Object.hasOwn(value, '__scope');
const nonemptyPath = (path) => typeof path === 'string' && path.length > 0;
const partsOf = (path) => (Array.isArray(path) ? path : typeof path === 'string' ? path.split('.') : []);
const childContext = (ctx, step) => (ctx.gqltype
  ? { ...ctx, gqltype: step.node }
  : { ...ctx, entity: step.target ?? ctx.entity, fields: step.node });

// One schema-path resolver for these operations, using the same step classifications as emptiness.
// Model contexts retain embedded fields locally; relation steps switch to the target entity.
const resolve = (path, ctx, onStep, virtualLabel, ordinaryCondition = false) => {
  const parts = partsOf(path);
  const invalid = parts.findIndex((part) => typeof part !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part));
  if (!parts.length || invalid !== -1) {
    if (ordinaryCondition && invalid > 0) fail(`Invalid filter path segment: "${parts[invalid]}"`, 'INVALID_FILTER_PATH');
    fail('Invalid filter path', 'INVALID_FILTER_PATH');
  }
  let current = ctx;
  const steps = [];
  const raw = [];
  for (const [index, name] of parts.entries()) {
    let step;
    if (ctx.gqltype) {
      const fields = isObjectType(current.gqltype) ? current.gqltype.getFields() : null;
      const field = fields && Object.hasOwn(fields, name) ? fields[name] : null;
      if (!field) fail(ordinaryCondition && index === 0 ? `Unknown filter field: ${name}`
        : `Unknown field ${parts.slice(0, index + 1).join('.')}`, 'INVALID_FILTER_FIELD');
      if (isVirtualField(field)) {
        const label = virtualLabel?.(field) ?? parts.join('.');
        fail(`Query path ${label} uses the virtual field ${current.gqltype.name}.${name}, which is not stored`, 'INVALID_FILTER_FIELD');
      }
      step = graphqlStep(name, field);
      const type = getNamedType(field.type);
      step.scalar = isEnumType(type) ? 'Enum' : effectiveScalarName(type);
      step.enumName = isEnumType(type) ? type.name : undefined;
      step.temporalName = ['Date', 'Time', 'DateTime'].includes(step.scalar) ? step.scalar : undefined;
      step.version = step.scalar === 'RecordVersion' || step.scalar === 'Version';
      raw.push(field);
    } else {
      const fields = current.fields ?? current.models?.entities.find((entity) => entity.name === current.entity)?.fields;
      const field = fields?.find((item) => item.name === name && !item.private);
      if (!field) fail(`Unknown field ${parts.slice(0, index + 1).join('.')}`, 'INVALID_FILTER_FIELD');
      step = { ...field, ...modelStep(field) };
      if (relation(step)) step.node = ctx.models?.entities.find((entity) => entity.name === step.target)?.fields;
      raw.push(field);
    }
    onStep?.(step, current);
    steps.push(step);
    if (index < parts.length - 1 && !step.node) fail(`Field ${name} cannot be traversed`, 'INVALID_FILTER_PATH');
    current = childContext(current, step);
  }
  return { steps, raw, end: current };
};

const comparisonDescriptor = (resolved) => {
  const last = resolved.steps.at(-1);
  const previous = resolved.steps.at(-2);
  return { ...last, list: last.kind === 'scalarList', identity: ['id', '_id'].includes(last.name)
    && (!previous || relation(previous)), version: last.version || ['Version', 'RecordVersion'].includes(last.scalar) };
};
const operandContext = (entry, ctx, up) => inFrames({ frames: entry.frames.slice(0, entry.frames.length - up) }, ctx);
const validateInternalOperand = (entry) => {
  const operand = entry.operand;
  if (operand === undefined) return;
  if (!plain(operand) || !Number.isSafeInteger(operand.up) || operand.up <= 0 || operand.up > entry.frames.length
    || entry.frames.slice(-operand.up).some((frame) => frame.construct.__implicit !== true)
    || !Array.isArray(operand.path) || !operand.path.length
    || operand.path.some((part) => typeof part !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))
    || Object.keys(operand).some((key) => !['up', 'path', 'scopes'].includes(key)) || entry.hasValuePath || entry.value !== undefined) {
    fail('Invalid compiler-generated comparison operand', 'INVALID_FILTER_PATH');
  }
};
const inFrames = (entry, ctx) => {
  let current = ctx;
  for (const frame of entry.frames) {
    const anchor = frame.construct.__implicit === true ? list(frame.construct.__anchor) : [];
    current = resolve([...anchor, ...partsOf(frame.path)], current).end;
  }
  return current;
};
const describe = (resolved, path, ctx, operator, value) => {
  const options = { path, operator, value, referenceEmptiness: ctx.referenceEmptiness === true };
  return ctx.gqltype ? describeEmptiness(ctx.gqltype, path, options) : describeModelEmptiness(resolved.raw, options);
};

// Mongo's GraphQL boundary reads abstract fields through their own value carrier, not object
// terms. Metadata/model contexts cannot describe abstract fields and do not gain this behavior.
const valueLeaf = (step, ctx) => ['scalar', 'scalarList'].includes(step.kind) || (ctx.gqltype && step.kind === 'abstract');

/** Internal: the single references crossed, excluding a reference end and inferred scalar IDs. */
export const crossingKeys = (parts, ctx) => resolve(parts, ctx).steps.flatMap((step, index, steps) => (
  step.kind === 'reference' && !step.inferred && index < steps.length - 1 ? [steps.slice(0, index + 1).map(({ name }) => name).join('.')] : []
));

/** Internal: lenient aggregate join prefixes; an invalid complete path contributes no prefixes. */
export const aggregateJoinPrefixes = (aggregation, ctx) => {
  const prefixes = new Set();
  for (const path of [aggregation?.groupId, ...list(aggregation?.facts).map((fact) => fact?.path)]) {
    try {
      const { steps } = resolve(path, ctx);
      steps.forEach((step, index) => {
        if (step.kind === 'collection') prefixes.add(steps.slice(0, index + 1).map(({ name }) => name).join('.'));
      });
    } catch (error) {
      if (!(error instanceof SimfinityError)) throw error;
    }
  }
  return prefixes;
};

// The first non-J collection and its optional legacy-join anchor. J is supplied only at the root.
const cutAt = (resolved, J) => {
  let joined = false;
  for (const [index, step] of resolved.steps.entries()) {
    if (step.kind !== 'collection') continue;
    const prefix = resolved.steps.slice(0, index + 1).map(({ name }) => name);
    if (J.has(prefix.join('.'))) { joined = true; continue; }
    const anchor = joined ? prefix.slice(0, -1) : [];
    return { index, prefix, anchor, path: prefix.slice(anchor.length).join('.') };
  }
  return null;
};
const comparisonInGroup = (group, seen = new Set()) => {
  if (seen.has(group)) return false;
  seen.add(group);
  return list(group.conditions).some((condition) => hasValuePath(condition) || condition.__operand !== undefined)
    || ['AND', 'OR', ...QUANTIFIED_LISTS].some((key) => list(group[key]).some((child) => comparisonInGroup(child, seen)));
};
const comparisonKeys = (resolved) => resolved.steps.flatMap((step, index, steps) => relation(step) ? [steps.slice(0, index + 1).map(({ name }) => name).join('.')] : []);
const markerKeys = (resolved, J = new Set()) => {
  const cut = cutAt(resolved, J);
  const anchored = resolved.steps.some((step, index, steps) => step.kind === 'collection'
    && J.has(steps.slice(0, index + 1).map(({ name }) => name).join('.')));
  return resolved.steps.flatMap((step, index, steps) => {
    if (!relation(step) || (anchored && step.kind === 'reference' && (cut === null || index < cut.index))) return [];
    return [steps.slice(0, index + 1).map(({ name }) => name).join('.')];
  });
};
const prefixScopes = (scopes, prefix, keys) => Object.fromEntries(Object.entries(scopes ?? {}).filter(([key]) => (
  keys.includes(key) && (key === prefix || prefix.startsWith(`${key}.`))
)));
const cutCondition = (item, rest, prefix, keys, rightKeys = []) => {
  const { __scope, ...operands } = item;
  delete operands.field;
  delete operands.path;
  const condition = { field: rest, ...operands };
  if (item.__operand) condition.__operand = { ...item.__operand, up: item.__operand.up + 1 };
  else if (hasValuePath(item)) {
    if (item.valuePath.startsWith(`${prefix}.`)) condition.valuePath = item.valuePath.slice(prefix.length + 1);
    else {
      delete condition.valuePath;
      condition.__operand = { up: 1, path: item.valuePath.split('.') };
      if (hasMarker(item) && rightKeys.length) {
        condition.__operand.scopes = Object.fromEntries(Object.entries(__scope?.scopes ?? {}).filter(([key]) => rightKeys.includes(key)));
      }
    }
  }
  if (hasMarker(item)) {
    const scopes = Object.fromEntries(Object.entries(__scope?.scopes ?? {})
      .filter(([key]) => [...keys, ...rightKeys].includes(key) && key.startsWith(`${prefix}.`)).map(([key, value]) => [key.slice(prefix.length + 1), value]));
    if (Object.keys(scopes).length) condition.__scope = { id: __scope.id, scopes };
  }
  return condition;
};
const termCondition = (term) => {
  const { path, ...operands } = term;
  return { field: path, ...operands };
};

/** Internal: pure collection-frame rewrite. The same J must be threaded through repeated passes. */
export const frameCollectionPaths = (args, ctx) => {
  if (ctx.quantifiers !== true) return args;
  const memo = new Map();
  const active = new Map();
  const identities = new Map();
  const positionOf = (parent, construct, type, path) => {
    if (!identities.has(construct)) identities.set(construct, identities.size + 1);
    return `${parent}/${identities.get(construct)}:${type}:${path}`;
  };
  const rewriteGroup = (input, frame, J, position = 'root') => {
    if (active.has(input)) return active.get(input);
    if (!memo.has(input)) memo.set(input, new Map());
    const positions = memo.get(input);
    if (positions.has(position)) return positions.get(position);
    const output = { ...input };
    positions.set(position, output);
    active.set(input, output);
    const buckets = new Map();
    const cut = (condition, path) => {
      const resolved = resolve(path, frame);
      const operator = condition.operator ?? 'EQ';
      if (isEmptinessOperator(operator) || operator === 'CONTAINS_ALL') return null;
      const at = cutAt(resolved, J);
      if (!at) return null;
      const prefix = at.prefix.join('.');
      let bucket = buckets.get(prefix);
      if (!bucket) {
        bucket = { path: at.path, conditions: [], __implicit: true };
        if (at.anchor.length) bucket.__anchor = at.anchor;
        buckets.set(prefix, bucket);
      }
      const rightResolved = hasValuePath(condition) ? resolve(condition.valuePath, frame) : null;
      const rightKeys = rightResolved ? comparisonKeys(rightResolved) : [];
      const keys = hasValuePath(condition) || condition.__operand ? comparisonKeys(resolved) : markerKeys(resolved, J);
      if (hasMarker(condition) && !hasMarker(bucket)) {
        bucket.__scope = { scopes: prefixScopes(condition.__scope?.scopes, prefix, [...keys, ...rightKeys]) };
      }
      bucket.conditions.push(cutCondition(condition, resolved.steps.slice(at.index + 1).map(({ name }) => name).join('.'), prefix, keys, rightKeys));
      return bucket;
    };
    if (Array.isArray(input.conditions)) {
      output.conditions = input.conditions.filter((item) => !cut(item, pathless(item.path) ? item.field : `${item.field}.${item.path}`));
    }
    for (const key of ['AND', 'OR']) if (Array.isArray(input[key])) output[key] = input[key].map((group) => rewriteGroup(group, frame, J, position));
    for (const type of QUANTIFIED_LISTS) if (Array.isArray(input[type])) {
      output[type] = input[type].map((group) => {
        const anchor = group.__implicit === true ? list(group.__anchor) : [];
        return rewriteGroup(group, resolve([...anchor, ...partsOf(group.path)], frame).end, new Set(), positionOf(position, group, type, group.path));
      });
    }
    for (const bucket of buckets.values()) {
      const path = [...list(bucket.__anchor), ...partsOf(bucket.path)];
      const rewritten = rewriteGroup(bucket, resolve(path, frame).end, new Set(), positionOf(position, bucket, 'ANY', bucket.path));
      output.ANY = [...list(output.ANY), rewritten];
    }
    active.delete(input);
    return output;
  };
  const output = { ...args };
  const syntheticGroups = [];
  const consumed = new Set();
  // Expand every quantified field before considering any shorthand terms.
  for (const [name, value] of Object.entries(args)) {
    if (controls(ctx.operation).has(name) || !object(value) || value.quantifier == null) continue;
    const group = { path: name, conditions: list(value.terms).map(termCondition) };
    if (hasMarker(value)) group.__scope = value.__scope;
    syntheticGroups.push({ __implicit: true, [value.quantifier]: [group] });
    delete output[name];
    consumed.add(name);
  }
  const implicitGroups = [];
  for (const [name, value] of Object.entries(args)) {
    if (controls(ctx.operation).has(name) || consumed.has(name) || !object(value)) continue;
    const leaf = resolve(name, ctx).steps.at(-1);
    if (['scalar', 'scalarList'].includes(leaf.kind)) {
      // Native planner inputs may name a scalar through collections. Each entry is its own
      // correlation group; ignored terms and filter metadata never become predicates or markers.
      const carrier = hasValuePath(value) ? { ...value } : { operator: value.operator ?? 'EQ', value: value.value };
      const group = { conditions: [{ field: name, ...carrier }] };
      const rewritten = rewriteGroup(group, ctx, ctx.J ?? new Set());
      if (list(rewritten.ANY).length) {
        syntheticGroups.push({ __implicit: true, ANY: rewritten.ANY });
        delete output[name];
      }
      continue;
    }
    if (!Array.isArray(value.terms) || valueLeaf(leaf, ctx)) continue;
    const group = { conditions: value.terms.map((term) => ({ ...termCondition(term), field: pathless(term.path) ? name : `${name}.${term.path}`, ...(hasValuePath(term) ? { valuePath: `${name}.${term.valuePath}` } : {}) })) };
    const rewritten = rewriteGroup(group, ctx, ctx.J ?? new Set());
    implicitGroups.push(...list(rewritten.ANY));
    if (rewritten.conditions.length === value.terms.length) continue;
    if (!rewritten.conditions.length) delete output[name];
    else output[name] = { ...value, terms: value.terms.filter((term, index) => rewritten.conditions.includes(group.conditions[index])) };
  }
  if (implicitGroups.length) syntheticGroups.push({ __implicit: true, ANY: implicitGroups });
  for (const key of ['AND', 'OR']) if (Array.isArray(args[key])) output[key] = args[key].map((group) => rewriteGroup(group, ctx, ctx.J ?? new Set()));
  for (const group of syntheticGroups) {
    output.AND = [...list(output.AND), rewriteGroup(group, ctx, ctx.J ?? new Set())];
  }
  return output;
};

const validateShapes = (args) => {
  let hasQuantifiedLists = false;
  if (!plain(args)) fail('Expected query arguments object');
  const open = new Set();
  const visit = (group, depth, quantified = false) => {
    if (!plain(group)) fail('Expected a filter group object');
    if (open.has(group)) fail('Cyclic filter groups', 'FILTER_DEPTH_EXCEEDED');
    validateQueryGroupKeys(group, { quantified });
    for (const key of ['conditions', 'AND', 'OR', ...QUANTIFIED_LISTS]) {
      if (group[key] != null && !Array.isArray(group[key])) fail(`${key} requires an array`);
      if (Array.isArray(group[key]) && group[key].some((item) => !plain(item))) fail(`${key} requires an array of filter objects`);
    }
    const level = depth + (group.__implicit === true ? 0 : 1);
    if (level > 5) fail('Filter nesting too deep', 'FILTER_DEPTH_EXCEEDED');
    if (quantified && group.__implicit !== true && !nonemptyPath(group.path)) fail('Relationship terms require a path', 'INVALID_FILTER_PATH');
    open.add(group);
    for (const key of ['AND', 'OR']) for (const item of list(group[key])) visit(item, level);
    for (const key of QUANTIFIED_LISTS) {
      if (group[key] != null && group.__implicit !== true) hasQuantifiedLists = true;
      for (const item of list(group[key])) visit(item, level, true);
    }
    open.delete(group);
  };
  for (const key of ['AND', 'OR']) {
    if (args[key] != null && !Array.isArray(args[key])) fail(`${key} requires an array`);
    for (const group of list(args[key])) visit(group, -1);
  }
  return hasQuantifiedLists;
};
const validateValue = (entry, resolved, ctx) => {
  const { operator, value } = entry;
  const scalar = resolved.steps.at(-1).scalar;
  // GraphQL compilers historically report the text operator's own type/value diagnostic.
  // Model planning retains its generic scalar-shape checks before text validation.
  if (ctx.gqltype && textQueryOperator(operator)) {
    validateTextFilterValue(operator, value, scalar, entry.path);
    return;
  }
  if (ctx.gqltype && operator === 'IIN') {
    validateTextListFilterValue(operator, value, scalar, entry.path);
    return;
  }
  const array = takesListValue(operator);
  if (value === undefined || (!array && Array.isArray(value)) || (value === null && !['EQ', 'NE'].includes(operator))) fail('Expected a scalar filter value');
  if (array && Array.isArray(value) && value.some((item) => item == null || Array.isArray(item))) fail('Filter lists require non-null scalar elements');
  if (array && !Array.isArray(value)) fail(`${operator} requires an array value`);
  if (operator === 'BTW' && value.length !== 2) fail('BTW requires two values');
  if (operator === 'CONTAINS_ALL') validateContainsAllValue(value);
  if (textQueryOperator(operator)) validateTextFilterValue(operator, value, scalar, entry.path);
  if (operator === 'IIN') validateTextListFilterValue(operator, value, scalar, entry.path);
};
/** Internal: check sort shape and path syntax without resolving or authorizing model fields. */
export const assertSortSyntax = (sort) => {
  if (sort == null) return;
  if (!plain(sort) || !Array.isArray(sort.terms) || !sort.terms.length) fail('Sort requires non-empty terms', 'INVALID_SORT');
  if (sort.terms.some((term) => !plain(term) || !['ASC', 'DESC'].includes(term.order))) fail('Invalid sort order', 'INVALID_SORT');
  for (const term of sort.terms) {
    const parts = partsOf(term.field);
    if (typeof term.field !== 'string' || !parts.length || parts.some((part) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(part))) fail('Invalid sort path', 'INVALID_FILTER_PATH');
  }
};
const validateSort = (args, ctx) => {
  assertSortSyntax(args.sort);
  for (const term of args.sort?.terms ?? []) {
    const parts = partsOf(term.field);
    if (ctx.operation === 'aggregate') continue;
    const { steps } = resolve(parts, ctx, (step, owner) => {
      if (step.kind === 'collection') {
        const type = owner.gqltype?.name ?? owner.entity;
        fail(`Sort path ${term.field} crosses the collection ${type}.${step.name}; a record has no single value there`, 'INVALID_FILTER_PATH');
      }
    });
    if (!valueLeaf(steps.at(-1), ctx)) fail('Sort path must end in a scalar field', 'INVALID_FILTER_PATH');
  }
};

// Scalar terms are inspection-only. Abstract terms also are, except that their emptiness forms
// still require describeEmptiness's path/type rejection before validating the actual carrier.
const ignoredValueTerm = (entry, ctx) => {
  if (entry.form !== 'term' || entry.frames.length) return false;
  const leaf = resolve(entry.field, ctx).steps.at(-1);
  return ['scalar', 'scalarList'].includes(leaf.kind)
    || (ctx.gqltype && leaf.kind === 'abstract' && !isEmptinessOperator(entry.operator));
};

/**
 * Internal: validate received arguments before rewriting, with all 400 checks before markers.
 * Runtime gates before fill pass scopeMarkers: 'pending'; issued IDs and detach validity then
 * belong to the runtime. Every other mode requires filled scopes, as direct compilers do.
 */
export const validateQuantifiedGroups = (args, ctx) => {
  const hasQuantifiedLists = validateShapes(args);
  const markers = [];
  const gates = [];
  const scalarCarriers = [];
  const abstractFields = new Set();
  for (const [name, value] of Object.entries(args)) {
    if (controls(ctx.operation).has(name) || value == null) continue;
    if (!plain(value)) {
      // Unknown top-level arguments are fields, retaining the planner's existing field error.
      resolve(name, ctx);
      fail('Expected a filter object');
    }
    if (value.quantifier != null) {
      if (value.terms != null && !Array.isArray(value.terms)) fail('Relationship terms require an array');
      for (const term of list(value.terms)) {
        if (!plain(term)) fail('Expected a relationship filter term');
        if (!nonemptyPath(term.path)) fail('Relationship terms require a path', 'INVALID_FILTER_PATH');
      }
    }
    const resolved = resolve(name, ctx, undefined, (field) => {
      // Classification must not shorten the actual object term's virtual-path diagnostic.
      const termPath = value.quantifier == null && !isEmptinessOperator(value.operator)
        && isObjectType(getNamedType(field.type)) && Array.isArray(value.terms) ? value.terms[0]?.path : null;
      return typeof termPath === 'string' && termPath ? `${name}.${termPath}` : name;
    });
    const leaf = resolved.steps.at(-1);
    if (ctx.gqltype && leaf.kind === 'abstract') abstractFields.add(name);
    if (value.quantifier == null && valueLeaf(leaf, ctx) && Array.isArray(value.terms) && value.operator === undefined) {
      scalarCarriers.push({ form: 'filter', field: name, path: name, relative: partsOf(name), segments: partsOf(name), frames: [],
        operator: 'EQ', value: value.value, construct: hasValuePath(value) ? value : null,
        ...(hasValuePath(value) ? { hasValuePath: true, valuePath: value.valuePath } : {}) });
    }
    if (!valueLeaf(leaf, ctx) && value.quantifier == null) {
      if (isEmptinessOperator(value.operator)) fail(`Filter on ${name} takes ${value.operator} only in a term; to test the field itself, use a term `
        + `without a path: ${name}: { terms: [{ operator: ${value.operator} }] }`, 'MISSING_FILTER_PATH');
      if (!Array.isArray(value.terms) || !value.terms.length) fail('Object filters require non-empty terms', 'MISSING_FILTER_PATH');
      for (const term of value.terms) {
        if (!plain(term)) fail('Expected a relationship filter term');
        if (!nonemptyPath(term.path) && !(isEmptinessOperator(term.operator) && pathless(term.path))) fail('Relationship terms require a path', 'INVALID_FILTER_PATH');
      }
    }
  }
  const abstractCarriers = [];
  const entries = [...scalarCarriers, ...collectQueryOperators(args, ctx.operation)].filter((entry) => {
    if (abstractFields.has(entry.field) && ['filter', 'beside-terms'].includes(entry.form) && !isEmptinessOperator(entry.operator)) {
      abstractCarriers.push(entry);
      return false;
    }
    return true;
  });
  entries.push(...abstractCarriers);
  for (const entry of entries) {
    if (ignoredValueTerm(entry, ctx)) continue;
    if (entry.hasValuePath) validateComparisonOperand(entry.construct);
    validateInternalOperand(entry);
    const comparison = entry.hasValuePath || entry.operand !== undefined;
    const current = inFrames(entry, ctx);
    let rightResolved;
    let rightCurrent;
    const implicit = entry.form === 'quantified' && entry.construct.__implicit === true;
    if (entry.form === 'condition' && typeof entry.field !== 'string') fail('Invalid filter path', 'INVALID_FILTER_PATH');
    if (entry.ambiguous) fail('Filter condition cannot use both dotted field syntax and a separate path', 'AMBIGUOUS_FILTER_FIELD');
    const anchor = implicit ? list(entry.construct.__anchor) : [];
    const path = entry.relative;
    // Direct GraphQL compilers retain native condition diagnostics; pending runtime gates keep
    // their shared diagnostics, as do model contexts and quantified forms.
    const ordinaryCondition = Boolean(current.gqltype) && ctx.scopeMarkers !== 'pending' && entry.form === 'condition'
      && !entry.frames.length && !isEmptinessOperator(entry.operator);
    const resolved = resolve(path, current, undefined, undefined, ordinaryCondition);
    const { steps } = resolved;
    const last = steps.at(-1);
    // Ordinary operators beside object terms are inspection carriers, not predicates. Runtime
    // capability inspection still sees these rows; direct planners validate only their terms.
    if (entry.form === 'beside-terms' && !isEmptinessOperator(entry.operator)
      && !valueLeaf(last, current)) continue;
    let shape;
    if (entry.form === 'quantified') {
      if (!implicit && (steps.slice(0, -1).some((step) => ['collection', 'embeddedList'].includes(step.kind))
        || !['reference', 'collection', 'embeddedList'].includes(last.kind))) fail('A quantified path must end at a relation without crossing a list', 'INVALID_FILTER_PATH');
      // A hand-built anchor (#108 part 4) is first a non-empty array of single path segments, before the path rule,
      // which counts the anchor's steps by its elements; list() reads any other present value as [].
      const anchored = implicit && entry.construct.__anchor != null;
      if (anchored && (!anchor.length || anchor.some((name) => typeof name !== 'string' || name.includes('.')))) {
        fail('An implicit quantified anchor must name the aggregate\'s join prefixes', 'INVALID_FILTER_PATH');
      }
      // A hand-built implicit group, whatever its operators (#108 part 4): after any anchor, its path ends at a collection,
      // whatever it crosses first, or at a reference without crossing a list, the explicit groups' rule for references.
      if (implicit && last.kind !== 'collection' && (last.kind !== 'reference'
        || steps.slice(anchor.length, -1).some((step) => ['collection', 'embeddedList'].includes(step.kind)))) {
        fail('An implicit quantified path must end at a collection, or at a reference without crossing a list', 'INVALID_FILTER_PATH');
      }
      // Then the shape the rewrite writes (cutAt): in an aggregate, on a group at the root, an anchor that crosses at
      // least one collection, every one a J prefix, with any embedded lists, embedded objects and references between,
      // and after it one step, a collection.
      if (anchored) {
        const prefixes = ctx.J ?? new Set();
        const crossed = steps.slice(0, anchor.length);
        const prefix = (index) => crossed.slice(0, index + 1).map(({ name }) => name).join('.');
        if (ctx.operation !== 'aggregate' || entry.frames.length
          || !crossed.some((step) => step.kind === 'collection')
          || crossed.some((step, index) => step.kind === 'collection' && !prefixes.has(prefix(index)))
          || partsOf(entry.construct.path).length !== 1 || last.kind !== 'collection') {
          fail('An implicit quantified anchor must name the aggregate\'s join prefixes', 'INVALID_FILTER_PATH');
        }
      }
      if (!implicit && !QUANTIFIERS.has(entry.quantifier)) fail('Unknown quantifier', 'INVALID_FILTER_VALUE');
      if (!implicit) gates.push(() => {
        if (ctx.quantifiers !== true || last.kind === 'embeddedList') fail('Quantified groups are not supported by this query compiler', 'UNSUPPORTED_QUERY');
      });
    } else {
      if (comparison) {
        rightCurrent = entry.operand ? operandContext(entry, ctx, entry.operand.up) : current;
        const rightPath = entry.operand?.path ?? partsOf(entry.valuePath);
        rightResolved = resolve(rightPath, rightCurrent);
        if (!['scalar', 'scalarList'].includes(last.kind) || !['scalar', 'scalarList'].includes(rightResolved.steps.at(-1).kind)) {
          fail('Field comparison operands must end in scalar fields', 'INVALID_FILTER_PATH');
        }
        if (!isQueryOperator(entry.operator)) fail(`Unknown filter operator: ${entry.operator}`, 'INVALID_FILTER_OPERATOR');
        if (ctx.operators && !ctx.operators.has(entry.operator)) fail(`The ${entry.operator} filter operator is not supported by this query compiler`, 'UNSUPPORTED_QUERY');
        const collections = new Set(steps.flatMap((step, index) => step.kind === 'collection' ? [steps.slice(0, index + 1).map(({ name }) => name).join('.')] : []));
        if (entry.operand) {
          const chain = entry.frames.slice(entry.frames.length - entry.operand.up)
            .flatMap((frame) => [...list(frame.construct.__anchor), ...partsOf(frame.path)]);
          const bound = resolve([...chain, ...path], rightCurrent).steps;
          for (const [index, step] of bound.entries()) if (step.kind === 'collection') {
            const key = bound.slice(0, index + 1).map(({ name }) => name).join('.');
            if (ctx.J?.has(key) && entry.operand.up === entry.frames.length) collections.add(key);
          }
        }
        if (rightResolved.steps.some((step, index, right) => step.kind === 'collection'
          && !collections.has(right.slice(0, index + 1).map(({ name }) => name).join('.')))) {
          fail('The right operand introduces an unbound collection; use an explicit group', 'INVALID_FILTER_PATH');
        }
        validateComparisonTypes(comparisonDescriptor(resolved), comparisonDescriptor(rightResolved), entry.operator, path.join('.'), rightPath.join('.'));
        gates.push(() => {
          if ([...steps, ...rightResolved.steps].some((step) => step.kind === 'embeddedList')) fail('Field comparisons through embedded lists require element frames', 'UNSUPPORTED_QUERY');
          if (ctx.valuePath !== true || ctx.referenceEmptiness !== true) fail('Field comparisons require valuePath and referenceEmptiness support from this query compiler', 'UNSUPPORTED_QUERY');
          const J = entry.frames.length ? new Set() : ctx.J ?? new Set();
          if (ctx.quantifiers !== true && steps.some((step, index) => step.kind === 'collection' && !J.has(steps.slice(0, index + 1).map(({ name }) => name).join('.')))) {
            fail('Collection field comparisons require quantifiers', 'UNSUPPORTED_QUERY');
          }
        });
      } else if (isEmptinessOperator(entry.operator)) {
        if (ctx.operators && !ctx.operators.has(entry.operator)) fail(`The ${entry.operator} filter operator is not supported by this query compiler`, 'UNSUPPORTED_QUERY');
        if (ctx.quantifiers === true && steps.slice(0, -1).some((step) => step.kind === 'collection')) fail('The shorthand excludes them; use an explicit group', 'INVALID_FILTER_PATH');
        shape = describe(resolved, path, current, entry.operator, entry.value);
      } else {
        if (!valueLeaf(last, current)) fail(ordinaryCondition && steps.length === 1
          ? `Filter on object field "${last.name}" requires a path` : 'Filter on object field requires a scalar path',
        steps.length > 1 ? 'INVALID_FILTER_PATH' : 'MISSING_FILTER_PATH');
        if (!isQueryOperator(entry.operator)) fail(`Unknown filter operator: ${entry.operator}`, 'INVALID_FILTER_OPERATOR');
        if (ctx.operators && !ctx.operators.has(entry.operator)) fail(`The ${entry.operator} filter operator is not supported by this query compiler`, 'UNSUPPORTED_QUERY');
        // CONTAINS_ALL's permanent path rules, then its leaf rule (#108 section 3.3), on the frame-relative path.
        if (entry.operator === 'CONTAINS_ALL') assertContainsAllPath(steps);
        if (current.gqltype && last.kind === 'abstract' && entry.value === undefined) fail(`Expected a scalar value for ${entry.path}`);
        validateValue(entry, resolved, current);
      }
    }
    if (entry.operand && ctx.scopeMarkers !== 'pending' && (entry.operand.scopes !== undefined
      || hasMarker(entry.construct))) markers.push(() => {
      const keys = crossingKeys(entry.operand.path, rightCurrent);
      const scopes = entry.operand.scopes;
      if (keys.length && (!plain(scopes) || keys.some((key) => !Object.hasOwn(scopes, key) || scopes[key] === undefined))) detached('Outer operand scope marker is not filled for every crossing');
      if (!keys.length && scopes !== undefined) detached('Outer operand scope marker reads no reference');
    });
    const J = entry.frames.length ? new Set() : ctx.J ?? new Set();
    const extra = entry.form === 'quantified' ? 1 : shape ? (emptinessScopePaths(shape, path).frames.length ? 1 : 0) : ctx.quantifiers === true ? steps.filter((step, index) => step.kind === 'collection'
      && !J.has(steps.slice(0, index + 1).map(({ name }) => name).join('.'))).length : 0;
    gates.push(() => {
      if (entry.frames.length + extra > getQueryMaxFrameNesting()) fail('Frame nesting too deep (maxFrameNesting)', 'FILTER_DEPTH_EXCEEDED');
    });
    if (hasMarker(entry.construct) && ctx.scopeMarkers !== 'pending') markers.push(() => {
      const suffix = '; only the runtime writes and fills client scope markers (docs/guide/middleware.md)';
      if (!comparison && !shape && entry.form !== 'quantified' && !entry.frames.length
        && (ctx.quantifiers !== true || !cutAt(resolved, ctx.J ?? new Set()))) {
        // Mongo rejects these at its native predicate checkpoint, after parsing/casting once.
        // Every other caller remains fail-closed here, after the common 400 gates above.
        if (ctx.gqltype && ctx.deferOrdinaryRootMarkers === true) return;
        detached(`${entry.operator} on ${path.join('.')} carries a client scope marker, but is not an emptiness condition${suffix}`);
      }
      let keys;
      if (shape) {
        const paths = emptinessScopePaths(shape, path);
        keys = [...paths.joins, ...paths.frames];
      } else keys = markerKeys(resolved, !entry.frames.length && (implicit || entry.form !== 'quantified') ? ctx.J ?? new Set() : new Set());
      if (comparison) keys = [...new Set([...comparisonKeys(resolved), ...(!entry.operand ? comparisonKeys(rightResolved) : [])])];
      const comparisonAnchor = implicit && anchor.length && comparisonInGroup(entry.construct);
      if (comparisonAnchor) keys = comparisonKeys(resolved);
      const scopes = entry.construct.__scope?.scopes;
      if (shape) {
        // Preserve 2b's direct-compiler diagnostics when the shared validator now runs first.
        const label = `${entry.operator} on ${path.join('.')}`;
        if (!keys.length) detached(`${label} carries a client scope marker, but reads no reference or collection${suffix}`);
        if (!plain(scopes)) detached(`${label} carries a client scope marker whose scopes are not filled${suffix}`);
        for (const key of keys) if (!Object.hasOwn(scopes, key) || scopes[key] === undefined) detached(`${label} carries a client scope marker without the scope of ${key}${suffix}`);
      } else if (!keys.length || !plain(scopes) || keys.some((key) => !Object.hasOwn(scopes, key) || scopes[key] === undefined)) detached('Client scope marker is not filled for every crossing and frame');
      if (implicit && anchor.length) {
        for (const [index, step] of steps.slice(0, anchor.length).entries()) {
          const key = steps.slice(0, index + 1).map(({ name }) => name).join('.');
          if ((step.kind === 'collection' && scopes[key] !== null)
            || (step.kind === 'reference' && !comparisonAnchor && Object.hasOwn(scopes, key))) detached('Aggregate anchors require null J scopes and legacy reference joins');
        }
      }
    });
  }
  validateSort(args, ctx);
  if (hasQuantifiedLists && ctx.quantifiers !== true) fail('Quantified groups are not supported by this query compiler', 'UNSUPPORTED_QUERY');
  for (const gate of gates) gate();
  for (const marker of markers) marker();
};

/** Internal: count compiled client frames/joins independently of markers and target scope bodies. */
export const frameUnits = (args, ctx) => {
  const rewritten = frameCollectionPaths(args, ctx);
  const units = new Set();
  const identities = new Map();
  const id = (construct) => {
    if (!identities.has(construct)) identities.set(construct, identities.size + 1);
    return identities.get(construct);
  };
  const frameKey = (entry) => entry.frames.reduce((key, frame) => `${key}/${id(frame.construct)}:${frame.type}:${frame.path}`, 'root');
  const joinUnit = (frame, path, scoped) => `join:${frame}:${path}${scoped ? ':scoped' : ''}`;
  for (const entry of collectQueryOperators(rewritten, ctx.operation)) {
    if (ignoredValueTerm(entry, ctx)) continue;
    const current = inFrames(entry, ctx);
    const frame = frameKey(entry);
    if (entry.form === 'quantified') {
      units.add(`frame:${frame}/${id(entry.construct)}:${entry.quantifier}:${entry.path}`);
      const anchor = entry.construct.__implicit === true ? list(entry.construct.__anchor) : [];
      const path = entry.relative;
      const { steps } = resolve(path, current);
      for (const [index, step] of steps.entries()) {
        if ((index >= anchor.length || comparisonInGroup(entry.construct)) && index < steps.length - 1 && step.kind === 'reference') {
          units.add(joinUnit(frame, steps.slice(0, index + 1).map(({ name }) => name).join('.'), hasMarker(entry.construct)));
        }
      }
    } else if (isEmptinessOperator(entry.operator)) {
      const resolved = resolve(entry.relative, current);
      const shape = describe(resolved, entry.relative, current, entry.operator, entry.value);
      const paths = emptinessScopePaths(shape, entry.relative);
      for (const path of paths.joins) units.add(joinUnit(frame, path, hasMarker(entry.construct)));
      for (const path of paths.frames) units.add(`emptiness-frame:${frame}:${path}`);
    } else if (entry.frames.length || entry.hasValuePath || entry.operand) {
      for (const path of crossingKeys(entry.relative, current)) units.add(joinUnit(frame, path, hasMarker(entry.construct)));
      if (entry.hasValuePath) for (const path of crossingKeys(entry.valuePath, current)) units.add(joinUnit(frame, path, hasMarker(entry.construct)));
      if (entry.operand) {
        const outer = operandContext(entry, ctx, entry.operand.up);
        const owner = frameKey({ frames: entry.frames.slice(0, entry.frames.length - entry.operand.up) });
        for (const path of crossingKeys(entry.operand.path, outer)) units.add(joinUnit(owner, path, Object.hasOwn(entry.operand, 'scopes')));
      }
    }
  }
  return { count: units.size, units: [...units] };
};
