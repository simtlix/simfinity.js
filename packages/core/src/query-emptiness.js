import {
  getNamedType, isInterfaceType, isObjectType, isScalarType, isUnionType,
} from 'graphql';
import SimfinityError from './errors/simfinity.error.js';
import { effectiveScalarName } from './metadata.js';
import { getListShape, isVirtualField } from './relation-storage.js';

// Internal: what the emptiness operators IS_EMPTY and IS_NOT_EMPTY (#108, part 2a) mean for a path,
// shared by the runtime gate, the query plan and the MongoDB compiler through the
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
// The record identity, the queried entity's own `id` or `_id`, is never empty in practice: PostgreSQL
// stores it as a uuid primary key even when it is declared String.
const IDENTITY = ['id', '_id'];
const LISTS = { embeddedList: 'an embedded list', collection: 'a collection' };

// A path step or a member, classified as MongoDB reads paths: interface and union types first, then an
// object field without a relation or with `embedded: true` is embedded, and any other object field is
// a collection when it is a list and a reference otherwise. `node` is what members are read from (an
// object type, or a description's `fields`), and `string` tells a String scalar.
const graphqlStep = (name, field) => {
  const type = getNamedType(field.type);
  const list = !!getListShape(field.type);
  if (isInterfaceType(type) || isUnionType(type)) return { name, kind: 'abstract' };
  if (isObjectType(type)) {
    const relation = field.extensions?.relation;
    const embedded = !relation || relation.embedded;
    return {
      name, typeName: type.name, node: type, kind: embedded ? (list ? 'embeddedList' : 'embedded') : (list ? 'collection' : 'reference'),
    };
  }
  return { name, kind: list ? 'scalarList' : 'scalar', string: isScalarType(type) && effectiveScalarName(type) === 'String' };
};
// Virtual members store nothing and are never read.
const graphqlMembers = (type) => Object.entries(type.getFields())
  .filter(([, field]) => !isVirtualField(field)).map(([name, field]) => graphqlStep(name, field));

// The same classification of a describeModels field description: inferred inverse references are ID
// scalars, as GraphQL exposes them. Descriptions hold no interface or union fields.
const modelStep = (field) => {
  if (field.kind === 'embedded') return { name: field.name, kind: field.list ? 'embeddedList' : 'embedded', node: field.fields ?? [] };
  if (field.kind === 'collection') return { name: field.name, kind: 'collection' };
  if (field.kind === 'reference' && !field.inferred) return { name: field.name, kind: 'reference' };
  return { name: field.name, kind: field.list ? 'scalarList' : 'scalar', string: field.scalar === 'String' };
};
const modelMembers = (fields) => fields.filter((field) => !field.private).map(modelStep);

const leafShape = (step, atRoot) => {
  if (step.kind === 'scalarList' || step.kind === 'embeddedList') return { rule: 'list' };
  if (atRoot && IDENTITY.includes(step.name)) return { rule: 'null' };
  return { rule: step.string ? 'string' : 'null' };
};

// Rules 3 to 6 of the order of checks, on a path whose fields resolved (rule 1): rule 3 throws as
// soon as it is found; a cycle (rule 4) and a reference or collection (rule 6) are recorded, are not
// entered, and throw only once the whole path and its members passed rule 3, with the value (rule 5)
// checked between them.
const describeSteps = (steps, { operator, value, label, membersOf }) => {
  const segments = steps.map((step) => step.name);
  const prefix = (index) => segments.slice(0, index + 1).join('.');
  let cycle = null;
  let unsupported = null;
  const abstract = (path) => fail(`${operator} cannot test ${label}: ${path} is an interface or union field, whose emptiness is not defined`, 'INVALID_FILTER_PATH');
  for (const [index, step] of steps.entries()) {
    const list = index > 0 ? LISTS[steps[index - 1].kind] : null;
    if (list) {
      fail(`${operator} cannot test ${label}: emptiness of a value inside a list is not defined, and ${prefix(index - 1)} is ${list}`, 'INVALID_FILTER_PATH');
    }
    if (step.kind === 'abstract') abstract(prefix(index));
    if (!unsupported && (step.kind === 'reference' || step.kind === 'collection')) {
      unsupported = `${operator} on ${label} ${index === steps.length - 1 ? 'ends at' : 'crosses'} the ${step.kind} ${prefix(index)}`;
    }
  }
  // The member rule: each stored member by its own rule, single embedded members recursively, lists
  // by the list rule without looking inside their items.
  const expand = (node, base, ancestors) => {
    const members = [];
    for (const member of membersOf(node)) {
      const memberPath = [...base, member.name].join('.');
      if (member.kind === 'abstract') abstract(memberPath);
      if (member.kind === 'reference' || member.kind === 'collection') {
        unsupported ??= `${operator} on ${label} reads the ${member.kind} member ${memberPath}`;
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
  const shape = last.kind === 'embedded'
    ? { rule: 'object', members: expand(last.node, segments, [last.node]) }
    : leafShape(last, steps.length === 1);
  if (cycle) fail(cycle, 'INVALID_FILTER_OPERATOR');
  validateEmptinessValue(operator, value, label);
  if (unsupported) {
    fail(`${unsupported}: emptiness through references and collections arrives with reference emptiness (#108)`, 'UNSUPPORTED_QUERY');
  }
  return shape;
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
 * validateEmptinessValue checks it) and rule 6 (UNSUPPORTED_QUERY when the path crosses or ends at a
 * reference or a collection, or a member is one). Form, depth and the adapter's operators are the
 * caller's checks. `segments` is an array or a dotted string; `path` names the condition in messages.
 *
 * Returns the shape: `{ rule: 'string' }` (missing, null or ""), `{ rule: 'null' }` (missing or
 * null; the record identity always), `{ rule: 'list' }` (missing, null or []), or
 * `{ rule: 'object', members: [{ name, shape }] }` (missing, null, or every stored member empty).
 */
export const describeEmptiness = (gqltype, segments, { operator = 'IS_EMPTY', value, path } = {}) => {
  const { steps, label } = graphqlSteps(gqltype, segments, path);
  return describeSteps(steps, { operator, value, label, membersOf: graphqlMembers });
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
export const describeModelEmptiness = (steps, { operator = 'IS_EMPTY', value, path } = {}) => {
  if (!Array.isArray(steps) || !steps.length) fail('Invalid filter path', 'INVALID_FILTER_PATH');
  const classified = steps.map(modelStep);
  const label = path == null ? classified.map((step) => step.name).join('.') : pathName(path);
  return describeSteps(classified, { operator, value, label, membersOf: modelMembers });
};

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
