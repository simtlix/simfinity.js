import {
  getNamedType, isInterfaceType, isObjectType, isScalarType, isUnionType,
} from 'graphql';
import SimfinityError from './errors/simfinity.error.js';
import { effectiveScalarName } from './metadata.js';
import { getListShape, isVirtualField, normalizeConnectionField } from './relation-storage.js';

// Internal: what the emptiness operators IS_EMPTY and IS_NOT_EMPTY (#108, parts 2a and 2b) mean for a
// path, shared by the runtime gate, the query plan and the MongoDB compiler through the
// `./internal/query-operators` subpath, which re-exports it and is not public API. Each backend
// compiles the shape described here to its own forms.

/** The emptiness operators, in QLOperator order. IS_NOT_EMPTY is the two-valued complement of IS_EMPTY. */
export const EMPTINESS_QUERY_OPERATORS = Object.freeze(['IS_EMPTY', 'IS_NOT_EMPTY']);

/** Whether `operator` is IS_EMPTY or IS_NOT_EMPTY. */
export const isEmptinessOperator = (operator) => EMPTINESS_QUERY_OPERATORS.includes(operator);

const fail = (message, code) => { throw new SimfinityError(message, code, 400); };
const pathName = (path) => (Array.isArray(path) ? path.join('.') : path);

/**
 * Validates the value of an emptiness condition: it must be omitted (undefined) or null. Anything
 * else, `""`, `[]`, `{}`, `false` and `0` included, fails with INVALID_FILTER_VALUE (400). `path`
 * names the condition in the message. Returns null, the value the plan carries.
 */
export const validateEmptinessValue = (operator, value, path) => {
  if (value !== undefined && value !== null) {
    fail(`${operator} takes no value${path == null ? '' : ` on ${pathName(path)}`}: omit it or pass null`, 'INVALID_FILTER_VALUE');
  }
  return null;
};

const PATH_SEGMENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
// The record identity, an entity's own `id` or `_id`, is never empty in practice: PostgreSQL stores it
// as a uuid primary key even when it is declared String. It is the queried entity's at the root, and
// the target's right after a single reference.
const IDENTITY = ['id', '_id'];
const LISTS = { embeddedList: 'an embedded list', collection: 'a collection' };

// A path step or a member, classified as MongoDB reads paths: interface and union types first, then an
// object field without a relation or with `embedded: true` is embedded, and any other object field is
// a collection when it is a list and a reference otherwise. `node` is what members are read from (an
// object type, or a description's `fields`), and `string` tells a String scalar. A reference or a
// collection names its `target` type, and a collection the child's storage column that links it,
// `connectionField`, derived as MongoDB derives it; without a declared connectionField a collection
// reads through its own field name.
export const graphqlStep = (name, field) => {
  const type = getNamedType(field.type);
  const list = !!getListShape(field.type);
  if (isInterfaceType(type) || isUnionType(type)) return { name, kind: 'abstract' };
  if (isObjectType(type)) {
    const relation = field.extensions?.relation;
    const embedded = !relation || relation.embedded;
    const kind = embedded ? (list ? 'embeddedList' : 'embedded') : (list ? 'collection' : 'reference');
    const step = { name, typeName: type.name, node: type, kind };
    if (kind === 'reference') step.target = type.name;
    if (kind === 'collection') {
      Object.assign(step, { target: type.name, connectionField: normalizeConnectionField(type, relation.connectionField || name).storageFieldName });
    }
    return step;
  }
  return { name, kind: list ? 'scalarList' : 'scalar', string: isScalarType(type) && effectiveScalarName(type) === 'String' };
};
// Virtual members store nothing and are never read.
const graphqlMembers = (type) => Object.entries(type.getFields())
  .filter(([, field]) => !isVirtualField(field)).map(([name, field]) => graphqlStep(name, field));

// The same classification of a describeModels field description: inferred inverse references are ID
// scalars, as GraphQL exposes them. Descriptions hold no interface or union fields, and describeModels
// has already normalized a collection's connectionField to the child's storage column.
export const modelStep = (field) => {
  if (field.kind === 'embedded') return { name: field.name, kind: field.list ? 'embeddedList' : 'embedded', node: field.fields ?? [] };
  if (field.kind === 'collection') return { name: field.name, kind: 'collection', target: field.target, connectionField: field.connectionField };
  if (field.kind === 'reference' && !field.inferred) return { name: field.name, kind: 'reference', target: field.target };
  return { name: field.name, kind: field.list ? 'scalarList' : 'scalar', string: field.scalar === 'String' };
};
const modelMembers = (fields) => fields.filter((field) => !field.private).map(modelStep);

const isRelation = (step) => step.kind === 'reference' || step.kind === 'collection';
const leafShape = (step, identity) => {
  if (step.kind === 'scalarList' || step.kind === 'embeddedList') return { rule: 'list' };
  if (identity && IDENTITY.includes(step.name)) return { rule: 'null' };
  return { rule: step.string ? 'string' : 'null' };
};
const relationShape = (step) => (step.kind === 'reference'
  ? { rule: 'reference', target: step.target }
  : { rule: 'collection', target: step.target, connectionField: step.connectionField });

// Rules 3 to 6 of the order of checks, on a path whose fields resolved (rule 1): rule 3 throws as
// soon as it is found; a cycle (rule 4) and a reference or collection (rule 6) are recorded, are not
// entered, and throw only once the whole path and its members passed rule 3, with the value (rule 5)
// checked between them. Rule 6 throws only when the caller does not support reference emptiness;
// otherwise a reference or collection end or member gets its own shape, and each single reference the
// path crosses is listed in `crossings`.
const describeSteps = (steps, {
  operator, value, label, membersOf, referenceEmptiness,
}) => {
  const segments = steps.map((step) => step.name);
  const prefix = (index) => segments.slice(0, index + 1).join('.');
  let cycle = null;
  let unsupported = null;
  const crossings = [];
  const abstract = (path) => fail(`${operator} cannot test ${label}: ${path} is an interface or union field, whose emptiness is not defined`, 'INVALID_FILTER_PATH');
  for (const [index, step] of steps.entries()) {
    const list = index > 0 ? LISTS[steps[index - 1].kind] : null;
    if (list) {
      fail(`${operator} cannot test ${label}: emptiness of a value inside a list is not defined, and ${prefix(index - 1)} is ${list}`, 'INVALID_FILTER_PATH');
    }
    if (step.kind === 'abstract') abstract(prefix(index));
    if (!unsupported && isRelation(step)) {
      unsupported = `${operator} on ${label} ${index === steps.length - 1 ? 'ends at' : 'crosses'} the ${step.kind} ${prefix(index)}`;
    }
    // Only a single reference can be crossed: rule 3 rejects any step after a collection.
    if (step.kind === 'reference' && index < steps.length - 1) crossings.push({ path: prefix(index), target: step.target });
  }
  // The member rule: each stored member by its own rule, single embedded members recursively, lists
  // by the list rule without looking inside their items, references and collections by their own
  // rules without entering them.
  const expand = (node, base, ancestors) => {
    const members = [];
    for (const member of membersOf(node)) {
      const memberPath = [...base, member.name].join('.');
      if (member.kind === 'abstract') abstract(memberPath);
      if (isRelation(member)) {
        unsupported ??= `${operator} on ${label} reads the ${member.kind} member ${memberPath}`;
        members.push({ name: member.name, shape: relationShape(member) });
      } else if (member.kind !== 'embedded') {
        members.push({ name: member.name, shape: leafShape(member, false) });
      } else if (ancestors.includes(member.node)) {
        cycle ??= `${operator} cannot test ${label}: the embedded type ${member.typeName ?? `of ${memberPath}`} reaches itself through the single embedded member ${memberPath}`;
      } else {
        members.push({ name: member.name, shape: { rule: 'object', members: expand(member.node, [...base, member.name], [...ancestors, member.node]) } });
      }
    }
    return members;
  };
  const last = steps.at(-1);
  let shape;
  if (last.kind === 'embedded') shape = { rule: 'object', members: expand(last.node, segments, [last.node]) };
  else if (isRelation(last)) shape = relationShape(last);
  else shape = leafShape(last, steps.length === 1 || steps.at(-2).kind === 'reference');
  if (cycle) fail(cycle, 'INVALID_FILTER_OPERATOR');
  validateEmptinessValue(operator, value, label);
  if (unsupported && !referenceEmptiness) {
    fail(`${unsupported}: the database adapter does not support emptiness through references and collections`, 'UNSUPPORTED_QUERY');
  }
  return crossings.length ? { ...shape, crossings } : shape;
};

// Rule 1 on GraphQL types: segment syntax and declared, stored fields, with resolveModelPath's codes
// and messages; nothing is traversed after a field that is not an object.
const graphqlSteps = (gqltype, segments, path) => {
  const parts = typeof segments === 'string' ? segments.split('.') : segments;
  if (!Array.isArray(parts) || !parts.length || parts.some((part) => typeof part !== 'string' || !PATH_SEGMENT.test(part))) {
    fail('Invalid filter path', 'INVALID_FILTER_PATH');
  }
  const label = path == null ? parts.join('.') : pathName(path);
  const steps = [];
  let type = gqltype;
  for (const [index, name] of parts.entries()) {
    const fields = isObjectType(type) ? type.getFields() : null;
    if (!fields || !Object.hasOwn(fields, name)) fail(`Unknown field ${parts.slice(0, index + 1).join('.')}`, 'INVALID_FILTER_FIELD');
    if (isVirtualField(fields[name])) {
      fail(`Query path ${label} uses the virtual field ${type.name}.${name}, which is not stored`, 'INVALID_FILTER_FIELD');
    }
    const step = graphqlStep(name, fields[name]);
    if (index < parts.length - 1 && !step.node) fail(`Field ${name} cannot be traversed`, 'INVALID_FILTER_PATH');
    steps.push(step);
    type = step.node;
  }
  return { steps, label };
};

/**
 * Describes what an emptiness condition tests on a path of `gqltype`, the queried type, and applies
 * the checks of #108 part 2a in their order: rule 1 (segment syntax and declared, stored fields, with
 * resolveModelPath's codes and messages; nothing is traversed after a field that is not an object),
 * then rule 3 (INVALID_FILTER_PATH for a segment after an embedded list or a collection, and for an
 * interface or union field on the path or among the members), rule 4 (INVALID_FILTER_OPERATOR when
 * the members re-enter an embedded type through single embedded members), rule 5 (the value, as
 * validateEmptinessValue checks it) and, with `referenceEmptiness: false`, rule 6 (UNSUPPORTED_QUERY
 * when the path crosses or ends at a reference or a collection, or a member is one, for a caller whose
 * database adapter does not support reference emptiness, #108 part 2b). Form, depth and the adapter's
 * operators are the caller's checks. `segments` is an array or a dotted string; `path` names the
 * condition in messages.
 *
 * Returns the shape: `{ rule: 'string' }` (missing, null or ""), `{ rule: 'null' }` (missing or
 * null; the record identity, at the root or right after a single reference, always, whatever scalar
 * it is declared with), `{ rule: 'list' }` (missing, null or []), `{ rule: 'object', members: [{
 * name, shape }] }` (missing, null, or every stored member empty), `{ rule: 'reference', target }`
 * (no record the reference points to) or `{ rule: 'collection', target, connectionField }` (no child
 * record whose `connectionField`, the child's storage column, points to the record); `target` is the
 * type name. The members of an object take these shapes too. When the path crosses single references,
 * the shape also lists them in path order as `crossings: [{ path, target }]`, with `path` the dotted
 * path of the reference from the queried type; emptinessScopePaths reads them.
 */
export const describeEmptiness = (gqltype, segments, {
  operator = 'IS_EMPTY', value, path, referenceEmptiness = true,
} = {}) => {
  const { steps, label } = graphqlSteps(gqltype, segments, path);
  return describeSteps(steps, {
    operator, value, label, membersOf: graphqlMembers, referenceEmptiness,
  });
};

/**
 * Rule 1 of {@link describeEmptiness} alone, with its codes and messages, for a caller that applies a
 * check of its own between rule 1 and rules 3 to 6, as the runtime gate applies the adapter's
 * operators (rule 2). Throws for a path that does not fully resolve on `gqltype`; returns nothing.
 */
export const assertEmptinessPath = (gqltype, segments, { path } = {}) => {
  graphqlSteps(gqltype, segments, path);
};

/**
 * The same description from model metadata, for a description whose entities carry no GraphQL type:
 * `steps` are the field descriptions resolveModelPath returns for the path, so rule 1 is already
 * done. Gives the shapes, codes and messages of {@link describeEmptiness} for the same types.
 */
export const describeModelEmptiness = (steps, {
  operator = 'IS_EMPTY', value, path, referenceEmptiness = true,
} = {}) => {
  if (!Array.isArray(steps) || !steps.length) fail('Invalid filter path', 'INVALID_FILTER_PATH');
  const classified = steps.map(modelStep);
  const label = path == null ? classified.map((step) => step.name).join('.') : pathName(path);
  return describeSteps(classified, {
    operator, value, label, membersOf: modelMembers, referenceEmptiness,
  });
};

// The scoped joins and frames of one emptiness construct, as `[{ path, kind, target }]`: each crossing
// in path order, then the end and the reference and collection members, depth first in field order.
const scopeEntries = (shape, path) => {
  const entries = (shape?.crossings ?? []).map(({ path: crossing, target }) => ({ path: crossing, kind: 'join', target }));
  const visit = (node, at) => {
    if (node?.rule === 'reference' || node?.rule === 'collection') entries.push({ path: at, kind: 'frame', target: node.target });
    else if (node?.rule === 'object') for (const member of node.members) visit(member.shape, `${at}.${member.name}`);
  };
  visit(shape, pathName(path));
  return entries;
};

/**
 * The reference and collection paths that one emptiness construct reads, from the shape that
 * describeEmptiness or describeModelEmptiness gave for its `path` (an array or a dotted string):
 * `joins` are the single references the path crosses (one scoped join each, for a client construct),
 * and `frames` the end when it is a reference or a collection, then each reference and collection
 * member (one frame each). Every path is dotted and starts at the queried type. A construct on the
 * record's own fields gives two empty lists.
 */
export const emptinessScopePaths = (shape, path) => {
  const entries = scopeEntries(shape, path);
  return {
    joins: entries.filter((entry) => entry.kind === 'join').map((entry) => entry.path),
    frames: entries.filter((entry) => entry.kind === 'frame').map((entry) => entry.path),
  };
};

/**
 * The target type name of every path {@link emptinessScopePaths} lists, as `{ [path]: target }`,
 * joins first: the type whose `find` scope restricts that join or frame.
 */
export const emptinessScopeTargets = (shape, path) => Object.fromEntries(
  scopeEntries(shape, path).map((entry) => [entry.path, entry.target]),
);

/**
 * The stored member paths an emptiness condition reads when its path, on `gqltype`, ends at a single
 * embedded object: absolute segment arrays, depth first in field order, entering single embedded
 * members and nothing else. Virtual members are left out. A list, reference, collection, interface or
 * union member is listed and not entered, and so is a single embedded member whose type is already on
 * the chain being listed. A path that does not resolve to a single embedded object lists nothing. The
 * path is followed as walkQueryPath follows it. Never throws; every code comes from the checks.
 */
export const emptinessMemberPaths = (gqltype, segments) => {
  const paths = [];
  if (!Array.isArray(segments) || !segments.length) return paths;
  let type = gqltype;
  let last = null;
  for (const name of segments) {
    const fields = typeof type?.getFields === 'function' ? type.getFields() : null;
    if (!fields || typeof name !== 'string' || !Object.hasOwn(fields, name) || isVirtualField(fields[name])) return paths;
    last = graphqlStep(name, fields[name]);
    type = getNamedType(fields[name].type);
  }
  if (last.kind !== 'embedded') return paths;
  const visit = (node, base, ancestors) => {
    for (const member of graphqlMembers(node)) {
      const memberPath = [...base, member.name];
      paths.push(memberPath);
      if (member.kind === 'embedded' && !ancestors.includes(member.node)) visit(member.node, memberPath, [...ancestors, member.node]);
    }
  };
  visit(last.node, segments, [last.node]);
  return paths;
};
