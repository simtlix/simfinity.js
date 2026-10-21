import {
  GraphQLEnumType,
  GraphQLID,
  GraphQLObjectType,
  getNamedType,
  isAbstractType,
  isScalarType,
} from 'graphql';
import mongoose from 'mongoose';

import { SimfinityError, QLOperator, paginationStages } from '@simtlix/simfinity-core';
import {
  TEXT_QUERY_OPERATORS, describeEmptiness, effectiveScalarName, isEmptinessOperator, textQueryOperator,
  validateTextFilterValue,
} from '@simtlix/simfinity-core/internal/query-operators';
import {
  getFieldStorageName, getListShape, hasStoredIdentity, isVirtualField, normalizeConnectionField,
} from '@simtlix/simfinity-core/internal/relation-storage';

import { castObjectId } from './ids.js';
import { resolveStorageScalar } from './models.js';

const isGraphQLisoDate = (typeName) => (
  typeName === 'DateTime' || typeName === 'Date' || typeName === 'Time'
);

// GraphQL reserves `__` names, so these aliases never replace a stored field.
const LOOKUP_ALIAS_PREFIX = '__sf_l';

/**
 * The filter operators this compiler supports, which the adapter declares as its queryFeatures. They
 * are listed explicitly, so that a QLOperator value added later stays unsupported until it compiles.
 */
export const MONGO_QUERY_OPERATORS = Object.freeze([
  'EQ', 'NE', 'LT', 'LTE', 'GT', 'GTE', 'BTW', 'IN', 'NIN', 'LIKE',
  'ILIKE', 'STARTS_WITH', 'ISTARTS_WITH', 'ENDS_WITH', 'IENDS_WITH', 'IEQ',
  'IS_EMPTY', 'IS_NOT_EMPTY',
]);

export const createMongoQueries = ({ getModel, getRegistrations }) => {
// One alias per relation path for each query build, keyed by the build's `included` accumulator.
const lookupAliases = new WeakMap();

const allocateLookupAlias = (aggregationsIncluded, relationPath) => {
  let aliases = lookupAliases.get(aggregationsIncluded);
  if (!aliases) {
    aliases = new Map();
    lookupAliases.set(aggregationsIncluded, aliases);
  }
  if (!aliases.has(relationPath)) aliases.set(relationPath, `${LOOKUP_ALIAS_PREFIX}${aliases.size}`);
  return aliases.get(relationPath);
};

const appendLookups = (aggregateClauses, aggregationsIncluded, lookups) => {
  for (const [alias, { lookup, unwind }] of Object.entries(lookups)) {
    if (!Object.hasOwn(aggregationsIncluded, alias)) {
      aggregateClauses.push(lookup, unwind);
      aggregationsIncluded[alias] = true;
    }
  }
};

const buildRelationLookup = ({
  collectionName, localField, foreignField, alias,
}) => ({
  lookup: {
    $lookup: {
      from: collectionName, foreignField, localField, as: alias,
    },
  },
  unwind: { $unwind: { path: `$${alias}`, preserveNullAndEmptyArrays: true } },
});

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// MongoDB rejects a $regex pattern longer than 32,764 UTF-8 bytes on the server (Location51091),
// which would report a client's long value as an internal error. Escaping adds a byte to each
// metacharacter and the operators add their anchors, so the limit applies to the compiled pattern.
const MAX_REGEX_PATTERN_BYTES = 32764;
// A $regex match, rejected with INVALID_FILTER_VALUE before the query runs when MongoDB would reject
// its pattern. `path` is the condition's GraphQL path, for the message.
const regexMatch = (operator, pattern, ignoreCase, path) => {
  const bytes = Buffer.byteLength(pattern, 'utf8');
  if (bytes > MAX_REGEX_PATTERN_BYTES) {
    const where = path == null ? '' : ` on ${path}`;
    throw filterError(`${operator} value${where} is too long: MongoDB accepts regular expressions of at most ${MAX_REGEX_PATTERN_BYTES} bytes, and this one has ${bytes}`);
  }
  return ignoreCase ? { $regex: pattern, $options: 'i' } : { $regex: pattern };
};

// The literal text operators: the escaped value, anchored with `^` at the start of the string and
// `\z` at its very end (`$` would also match before a final newline), with the `i` option to ignore
// case. Without the `m` option, `^` never matches after a newline.
const TEXT_PATTERNS = {
  contains: (escaped) => escaped,
  prefix: (escaped) => `^${escaped}`,
  suffix: (escaped) => `${escaped}\\z`,
  exact: (escaped) => `^${escaped}\\z`,
};
const textRegex = (operator, { match, ignoreCase }) => (value, path) => (
  regexMatch(operator, TEXT_PATTERNS[match](escapeRegex(value)), ignoreCase, path)
);

const PATH_SEGMENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const assertValidFilterPath = (path) => {
  if (typeof path !== 'string' || path.length === 0) {
    throw new SimfinityError('Filter path must be a non-empty string', 'INVALID_FILTER_PATH', 400);
  }
  for (const segment of path.split('.')) {
    if (!PATH_SEGMENT_RE.test(segment)) {
      throw new SimfinityError(`Invalid filter path segment: "${segment}"`, 'INVALID_FILTER_PATH', 400);
    }
  }
};

const normalizeFilterCondition = (condition) => {
  const { field } = condition;
  if (typeof field !== 'string') return condition;
  const dotIdx = field.indexOf('.');
  if (dotIdx < 0) return condition;
  if (condition.path != null && condition.path !== '') {
    throw new SimfinityError(
      'Filter condition cannot use both dotted field syntax and a separate path',
      'AMBIGUOUS_FILTER_FIELD',
      400,
    );
  }
  return {
    ...condition,
    field: field.slice(0, dotIdx),
    path: field.slice(dotIdx + 1),
  };
};

const OP_TO_MONGO = {
  LT: (v) => ({ $lt: v }),
  GT: (v) => ({ $gt: v }),
  LTE: (v) => ({ $lte: v }),
  GTE: (v) => ({ $gte: v }),
  NE: (v) => ({ $ne: v }),
  BTW: (v) => ({ $gte: v[0], $lte: v[1] }),
  LIKE: (v, path) => regexMatch('LIKE', `.*${escapeRegex(v)}.*`, false, path),
  ...Object.fromEntries(Object.entries(TEXT_QUERY_OPERATORS).map(([op, text]) => [op, textRegex(op, text)])),
};

const AGG_OP_TO_MONGO = {
  SUM: (path) => ({ $sum: `$${path}` }),
  COUNT: () => ({ $sum: 1 }),
  AVG: (path) => ({ $avg: `$${path}` }),
  MIN: (path) => ({ $min: `$${path}` }),
  MAX: (path) => ({ $max: `$${path}` }),
};

const filterError = (message, code = 'INVALID_FILTER_VALUE') => new SimfinityError(message, code, 400);

// `id` is the record key `_id` at an entity boundary: the root or a joined document. Inside an
// embedded object it follows what reads return. Entity types read the stored subdocument `_id`
// through the generated id resolver; that resolver lives on the type object, so any runtime that
// marked the type an entity decides it, not only this one. Every other embedded object stores and
// returns its declared `id` member. A supplied subdocument schema without an `id` path keeps `_id`,
// which only hydrated reads expose, through Mongoose's `id` virtual; list reads return null for it.
const identifierLeaf = (model, schemaPath, gqltype) => {
  if (!schemaPath) return '_id';
  const schema = model?.schema;
  if (!schema?.path(`${schemaPath}._id`)) return 'id';
  return hasStoredIdentity(gqltype) || !schema.path(`${schemaPath}.id`) ? '_id' : 'id';
};

// Resolve GraphQL paths and storage paths together; supplied models own ID casting.
const resolveQueryPath = (gqltype, path, aggregationsIncluded) => {
  assertValidFilterPath(path);
  const parts = path.split('.');
  let currentType = gqltype;
  let currentModel = getModel(gqltype);
  let mongoPath = '';
  let schemaPath = '';
  const aggregateClauses = {};

  for (const [index, part] of parts.entries()) {
    const field = Object.hasOwn(currentType.getFields(), part) ? currentType.getFields()[part] : null;
    if (!field) throw filterError(`Unknown query field: ${path}`, 'INVALID_FILTER_FIELD');
    // Core rejects generated and trusted paths through a virtual field before the adapter runs. A
    // native buildQuery() or buildFilterGroupMatch() call fails here, instead of matching storage
    // that does not exist.
    if (isVirtualField(field)) {
      throw filterError(`Query path ${path} uses the virtual field ${currentType.name}.${part}, which is not stored`, 'INVALID_FILTER_FIELD');
    }
    const fieldType = getNamedType(field.type);
    const relation = field.extensions?.relation;
    if (fieldType instanceof GraphQLObjectType) {
      if (index === parts.length - 1) throw filterError(`Query path must end in a scalar field: ${path}`, 'INVALID_FILTER_PATH');
      if (!relation || relation.embedded) {
        mongoPath = mongoPath ? `${mongoPath}.${part}` : part;
        schemaPath = schemaPath ? `${schemaPath}.${part}` : part;
      } else {
        const relatedModel = getModel(fieldType);
        if (!relatedModel) throw filterError(`Related model is not available for ${path}`, 'INVALID_FILTER_PATH');
        const isList = !!getListShape(field.type);
        // A collection without connectionField keeps reading through its field name, as before.
        const connField = isList
          ? normalizeConnectionField(fieldType, relation.connectionField || part).storageFieldName
          : getFieldStorageName(part, field);
        const localLeaf = isList ? '_id' : connField;
        const alias = allocateLookupAlias(aggregationsIncluded, parts.slice(0, index + 1).join('.'));
        aggregateClauses[alias] = buildRelationLookup({
          collectionName: relatedModel.collection.collectionName,
          localField: mongoPath ? `${mongoPath}.${localLeaf}` : localLeaf,
          foreignField: isList ? connField : '_id',
          alias,
        });
        mongoPath = alias;
        schemaPath = '';
        currentModel = relatedModel;
      }
      currentType = fieldType;
    } else {
      if (index !== parts.length - 1) throw filterError(`Cannot traverse scalar field in ${path}`, 'INVALID_FILTER_PATH');
      const leaf = part === 'id' ? identifierLeaf(currentModel, schemaPath, currentType) : part;
      const storagePath = schemaPath ? `${schemaPath}.${leaf}` : leaf;
      return {
        mongoPath: mongoPath ? `${mongoPath}.${leaf}` : leaf,
        schemaType: currentModel?.schema?.path(storagePath),
        fieldType,
        storesStateName: part === 'state' && !!getRegistrations().find((entry) => entry.gqltype.name === currentType.name)?.stateMachine,
        aggregateClauses,
      };
    }
  }
  throw filterError(`Invalid query path: ${path}`, 'INVALID_FILTER_PATH');
};

// The emptiness operators IS_EMPTY and IS_NOT_EMPTY (#108, part 2a). Core's describeEmptiness applies
// their checks in the order every caller uses and describes what "empty" means for the path. It
// rejects references, collections, interface and union fields and anything inside a list, so the
// path and every member it reads are stored in the queried document, through single embedded objects.
// The forms are plain query operators that need no lookup, valid wherever the $match runs.
const isPathless = (path) => path == null || path === '';

// The stored key of the member `name` of `type`, an object stored at `schemaPath` ('' at the root):
// a non-object `id` member follows identifierLeaf, as resolveQueryPath does; others keep their name.
const emptinessKey = (model, type, schemaPath, name) => {
  const field = type.getFields()[name];
  const leaf = name === 'id' && !(getNamedType(field.type) instanceof GraphQLObjectType)
    ? identifierLeaf(model, schemaPath, type)
    : name;
  return schemaPath ? `${schemaPath}.${leaf}` : leaf;
};

// MongoDB stores the built-in scalars, dates and enums as single values, but keeps an application scalar
// without a supported base as written, arrays included, and `{ p: null }` also matches an array that
// holds a null. The null rule of such a scalar leaves arrays out, so `[null]` is a value, as GraphQL
// reads it. The record identity `_id` is never an array, so it keeps the plain form.
const SINGLE_VALUE_SCALARS = new Set(['String', 'ID', 'Int', 'Float', 'Boolean', 'DateTime', 'Date', 'Time']);
const holdsArrays = (key, type) => (
  key !== '_id' && isScalarType(type) && !SINGLE_VALUE_SCALARS.has(effectiveScalarName(type))
);
const nullForm = (key, type) => (holdsArrays(key, type)
  ? { $and: [{ [key]: null }, { [key]: { $not: { $type: 'array' } } }] }
  : { [key]: null });

// The IS_EMPTY form of `shape` for the value stored at `key`; `type` is the named type of its field.
// An object is missing, null, or has every stored member empty. Without stored members it is always
// empty: MongoDB rejects an empty $and, so the empty query, which matches every document, stands in.
const emptyForm = (model, shape, key, type) => {
  if (shape.rule === 'string') return { [key]: { $in: [null, ''] } };
  if (shape.rule === 'null') return nullForm(key, type);
  if (shape.rule === 'list') return { [`${key}.0`]: { $exists: false } };
  const fields = type.getFields();
  const members = shape.members.map((member) => emptyForm(
    model, member.shape, emptinessKey(model, type, key, member.name), getNamedType(fields[member.name].type),
  ));
  return { $or: [{ [key]: null }, members.length ? { $and: members } : {}] };
};

// IS_NOT_EMPTY is the exact complement: the positive form of a leaf, which an index can serve, or
// the $nor of the IS_EMPTY form of an object or of a scalar that may hold arrays.
const notEmptyForm = (model, shape, key, type) => {
  if (shape.rule === 'string') return { [key]: { $nin: [null, ''] } };
  if (shape.rule === 'null') return holdsArrays(key, type) ? { $nor: [nullForm(key, type)] } : { [key]: { $ne: null } };
  if (shape.rule === 'list') return { [`${key}.0`]: { $exists: true } };
  return { $nor: [emptyForm(model, shape, key, type)] };
};

// The match clause of one emptiness condition on `path`, the field itself or a dotted path from it.
const buildEmptinessClause = (gqltype, path, operator, value) => {
  const segments = path.split('.');
  const shape = describeEmptiness(gqltype, segments, { operator, value, path });
  const model = getModel(gqltype);
  let type = gqltype;
  let schemaPath = '';
  for (const name of segments.slice(0, -1)) {
    schemaPath = schemaPath ? `${schemaPath}.${name}` : name;
    type = getNamedType(type.getFields()[name].type);
  }
  const name = segments.at(-1);
  const form = operator === 'IS_EMPTY' ? emptyForm : notEmptyForm;
  return form(model, shape, emptinessKey(model, type, schemaPath, name), getNamedType(type.getFields()[name].type));
};

const castFilterValue = (value, resolved) => {
  if (value === null) return null;
  if (value === undefined || Array.isArray(value)
    || (typeof value === 'object' && !(value instanceof Date) && !(value instanceof mongoose.Types.ObjectId))) {
    throw filterError(`Expected a scalar value for ${resolved.mongoPath}`);
  }
  try {
    const schemaType = resolved.schemaType?.caster || resolved.schemaType;
    const scalar = resolved.fieldType;
    if (scalar === GraphQLID && typeof value !== 'string' && typeof value !== 'number'
      && !(value instanceof mongoose.Types.ObjectId)) throw new Error('Invalid ID');
    // ID representation is a persistence concern, including String/Number/custom _id schemas.
    if (schemaType && (scalar === GraphQLID || resolved.mongoPath.endsWith('._id') || resolved.mongoPath === '_id'
      || schemaType.instance === 'ObjectId')) return schemaType.cast(value);
    const typeName = effectiveScalarName(scalar);
    if (isGraphQLisoDate(typeName)) {
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(date.getTime())) throw new Error('Invalid date');
      return date;
    }
    if (scalar === GraphQLID && !schemaType) return castObjectId(value);
    if (scalar instanceof GraphQLEnumType) {
      const entry = scalar.getValues().find((item) => item.name === value)
        || scalar.getValues().find((item) => item.value === value);
      if (!entry) throw new Error('Invalid enum value');
      const stored = resolved.storesStateName ? entry.name : entry.value;
      return schemaType ? schemaType.cast(stored) : stored;
    }
    const parsed = resolveStorageScalar(scalar).parseValue(value);
    return schemaType ? schemaType.cast(parsed) : parsed;
  } catch {
    throw filterError(`Invalid value for ${resolved.mongoPath}`);
  }
};

// `path` is the condition's GraphQL path, for messages.
const buildMatchesClause = (resolved, operator, value, path) => {
  const op = operator ?? 'EQ';
  if (!QLOperator.getValues().some((entry) => entry.value === op)) {
    throw filterError(`Unsupported filter operator: ${op}`, 'INVALID_FILTER_OPERATOR');
  }
  // Text operators take the value as is, once core's shared rule accepts it: a String field (a
  // validated scalar by its base scalar) and a string without U+0000.
  if (textQueryOperator(op)) {
    const text = validateTextFilterValue(op, value, effectiveScalarName(resolved.fieldType), path);
    return { [resolved.mongoPath]: OP_TO_MONGO[op](text, path) };
  }
  const collectionOperator = op === 'IN' || op === 'NIN' || op === 'BTW';
  if (collectionOperator && (!Array.isArray(value) || (op === 'BTW' && value.length !== 2))) {
    throw filterError(`${op} requires ${op === 'BTW' ? 'exactly two values' : 'an array value'}`);
  }
  if (op === 'LIKE' && (typeof value !== 'string' || effectiveScalarName(resolved.fieldType) !== 'String')) {
    throw filterError('LIKE requires a string field and string value');
  }
  if (value === null && op !== 'EQ' && op !== 'NE') throw filterError(`${op} does not accept null`);
  const cast = (item) => {
    if (item === null && collectionOperator) throw filterError(`${op} does not accept null elements`);
    return castFilterValue(item, resolved);
  };
  const coerced = collectionOperator ? value.map(cast) : op === 'LIKE' ? value : cast(value);
  if (op === 'EQ') return { [resolved.mongoPath]: coerced };
  if (op === 'IN' || op === 'NIN') return { [resolved.mongoPath]: { [op === 'IN' ? '$in' : '$nin']: coerced } };
  return { [resolved.mongoPath]: OP_TO_MONGO[op](coerced, path) };
};

const buildQueryTerms = async (filterField, qlField, fieldName, gqltype, aggregationsIncluded) => {
  const aggregateClauses = {};
  const matchesClauses = [];
  if (!qlField) throw filterError(`Unknown filter field: ${fieldName}`, 'INVALID_FILTER_FIELD');
  if (filterField == null) return { aggregateClauses, matchesClauses };
  if (typeof filterField !== 'object' || Array.isArray(filterField)) throw filterError(`Invalid filter for ${fieldName}`);
  const namedType = getNamedType(qlField.type);
  const isObject = namedType instanceof GraphQLObjectType;
  // Only trusted code writes an operator on an object filter, since QLTypeFilterExpression has none:
  // an emptiness operator there fails instead of being dropped; other operators stay left out. Rule 1
  // comes first, so a virtual field fails as it does in every other form.
  if (isObject && isEmptinessOperator(filterField.operator)) {
    const { operator } = filterField;
    if (isVirtualField(qlField)) {
      throw filterError(`Query path ${fieldName} uses the virtual field ${gqltype.name}.${fieldName}, which is not stored`, 'INVALID_FILTER_FIELD');
    }
    throw filterError(`Filter on ${fieldName} takes ${operator} only in a term; to test the field itself, use a term without a path: `
      + `${fieldName}: { terms: [{ operator: ${operator} }] }`, 'MISSING_FILTER_PATH');
  }
  if (isObject && (!Array.isArray(filterField.terms) || filterField.terms.length === 0)) {
    throw filterError(`Filter on ${fieldName} requires non-empty terms`, 'MISSING_FILTER_PATH');
  }
  // QLTypeFilterExpression gives interface and union lists terms too. An emptiness operator beside
  // them or in one of them tests the field itself, which rule 3 rejects, or a path through it, which
  // rule 1 rejects: describeEmptiness throws both, in the order the gate reads them. Other operators
  // keep reading the filter as a value.
  if (isAbstractType(namedType) && Array.isArray(filterField.terms)) {
    for (const term of [filterField, ...filterField.terms]) {
      if (!isEmptinessOperator(term?.operator)) continue;
      const pathed = term !== filterField && !isPathless(term.path);
      if (pathed) assertValidFilterPath(term.path);
      describeEmptiness(gqltype, pathed ? `${fieldName}.${term.path}` : fieldName, { operator: term.operator, value: term.value });
    }
  }
  const terms = isObject ? filterField.terms : [filterField];
  for (const term of terms) {
    if (!term || typeof term !== 'object' || Array.isArray(term)) throw filterError(`Invalid term for ${fieldName}`);
    // An emptiness term whose path is omitted, null or "" tests the field itself.
    if (isEmptinessOperator(term.operator)) {
      const pathed = isObject && !isPathless(term.path);
      if (pathed) assertValidFilterPath(term.path);
      matchesClauses.push(buildEmptinessClause(gqltype, pathed ? `${fieldName}.${term.path}` : fieldName, term.operator, term.value));
      continue;
    }
    if (isObject) assertValidFilterPath(term.path);
    const path = isObject ? `${fieldName}.${term.path}` : fieldName;
    const resolved = resolveQueryPath(gqltype, path, aggregationsIncluded);
    Object.assign(aggregateClauses, resolved.aggregateClauses);
    matchesClauses.push(buildMatchesClause(resolved, term.operator, term.value, path));
  }
  return { aggregateClauses, matchesClauses };
};

const MAX_FILTER_GROUP_DEPTH = 5;

const validateLogicalLists = (group, keys = ['AND', 'OR', 'conditions']) => {
  if (!group || typeof group !== 'object' || Array.isArray(group)) throw filterError('Expected a filter group object');
  for (const key of keys) {
    if (group[key] != null && !Array.isArray(group[key])) throw filterError(`${key} requires an array`);
  }
};

const buildFilterGroupMatch = async (filterGroup, gqltype, aggregateClauses, aggregationsIncluded, depth = 0) => {
  if (depth > MAX_FILTER_GROUP_DEPTH) {
    throw new SimfinityError('Filter nesting too deep', 'FILTER_DEPTH_EXCEEDED', 400);
  }
  validateLogicalLists(filterGroup);

  const parts = [];
  const fields = gqltype.getFields();

  if (filterGroup.conditions?.length > 0) {
    for (const rawCondition of filterGroup.conditions) {
      if (!rawCondition || typeof rawCondition.field !== 'string') throw filterError('Filter conditions require a field');
      const condition = normalizeFilterCondition(rawCondition);
      // An emptiness condition without a path tests its field, also an object field; a dotted field
      // is resolved as a whole, as the query plan resolves it.
      if (isEmptinessOperator(condition.operator)) {
        const path = rawCondition.path ? `${rawCondition.field}.${rawCondition.path}` : rawCondition.field;
        parts.push(buildEmptinessClause(gqltype, path, condition.operator, condition.value));
        continue;
      }
      const qlField = fields[condition.field];
      if (!qlField) {
        throw new SimfinityError(`Unknown filter field: ${condition.field}`, 'INVALID_FILTER_FIELD', 400);
      }

      const isObject = getNamedType(qlField.type) instanceof GraphQLObjectType;

      let filterInput;
      if (isObject) {
        if (!condition.path) {
          throw new SimfinityError(`Filter on object field "${condition.field}" requires a path`, 'MISSING_FILTER_PATH', 400);
        }
        filterInput = {
          terms: [{ path: condition.path, operator: condition.operator, value: condition.value }],
        };
      } else {
        if (condition.path != null && condition.path !== '') throw filterError(`Cannot traverse scalar field ${condition.field}`, 'INVALID_FILTER_PATH');
        filterInput = { operator: condition.operator, value: condition.value };
      }

      const result = await buildQueryTerms(filterInput, qlField, condition.field, gqltype, aggregationsIncluded);
      appendLookups(aggregateClauses, aggregationsIncluded, result.aggregateClauses);
      for (const matchClause of Object.values(result.matchesClauses)) {
        for (const [matchKey, match] of Object.entries(matchClause)) {
          parts.push({ [matchKey]: match });
        }
      }
    }
  }

  if (filterGroup.AND?.length > 0) {
    for (const subGroup of filterGroup.AND) {
      const subMatch = await buildFilterGroupMatch(subGroup, gqltype, aggregateClauses, aggregationsIncluded, depth + 1);
      if (subMatch) parts.push(subMatch);
    }
  }

  if (filterGroup.OR?.length > 0) {
    const orParts = [];
    for (const subGroup of filterGroup.OR) {
      const subMatch = await buildFilterGroupMatch(subGroup, gqltype, aggregateClauses, aggregationsIncluded, depth + 1);
      if (subMatch) orParts.push(subMatch);
    }
    if (orParts.length === 1) {
      parts.push(orParts[0]);
    } else if (orParts.length > 1) {
      parts.push({ $or: orParts });
    }
  }

  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return { $and: parts };
};

const FIND_CONTROL_KEYS = new Set(['pagination', 'sort', 'AND', 'OR']);
// `aggregation` is the expression argument only on aggregate queries; elsewhere it names a field.
const AGGREGATE_CONTROL_KEYS = new Set([...FIND_CONTROL_KEYS, 'aggregation']);

const collectFiltersAndLookups = async (input, gqltype, aggregateClauses, aggregationsIncluded, operation = 'find') => {
  // Top-level arguments are field filters plus AND/OR groups; `conditions` is a key only inside groups.
  validateLogicalLists(input, ['AND', 'OR']);
  const controlKeys = operation === 'aggregate' ? AGGREGATE_CONTROL_KEYS : FIND_CONTROL_KEYS;
  const flatMatchConditions = {};
  const repeatedConditions = [];
  let hasFlat = false;
  const fields = gqltype.getFields();

  for (const [key, filterField] of Object.entries(input)) {
    if (controlKeys.has(key)) continue;
    const qlField = fields[key];
    const result = await buildQueryTerms(filterField, qlField, key, gqltype, aggregationsIncluded);
    appendLookups(aggregateClauses, aggregationsIncluded, result.aggregateClauses);
    for (const matchClause of Object.values(result.matchesClauses)) {
      for (const [matchKey, match] of Object.entries(matchClause)) {
        if (Object.hasOwn(flatMatchConditions, matchKey)) {
          repeatedConditions.push({ [matchKey]: match });
        } else {
          flatMatchConditions[matchKey] = match;
        }
        hasFlat = true;
      }
    }
  }

  const topLevelAndParts = [];
  if (hasFlat) topLevelAndParts.push(flatMatchConditions);
  topLevelAndParts.push(...repeatedConditions);

  if (input.AND?.length > 0) {
    for (const group of input.AND) {
      const groupMatch = await buildFilterGroupMatch(group, gqltype, aggregateClauses, aggregationsIncluded);
      if (groupMatch) topLevelAndParts.push(groupMatch);
    }
  }

  if (input.OR?.length > 0) {
    const orParts = [];
    for (const group of input.OR) {
      const groupMatch = await buildFilterGroupMatch(group, gqltype, aggregateClauses, aggregationsIncluded);
      if (groupMatch) orParts.push(groupMatch);
    }
    if (orParts.length === 1) {
      topLevelAndParts.push(orParts[0]);
    } else if (orParts.length > 1) {
      topLevelAndParts.push({ $or: orParts });
    }
  }

  if (topLevelAndParts.length === 1) return { $match: topLevelAndParts[0] };
  if (topLevelAndParts.length > 1) return { $match: { $and: topLevelAndParts } };
  return null;
};

const validateSortTerms = (sort) => {
  if (!Array.isArray(sort?.terms) || sort.terms.length === 0) throw filterError('Sort requires non-empty terms', 'INVALID_SORT');
  for (const term of sort.terms) {
    if (!term || !['ASC', 'DESC'].includes(term.order)) throw filterError('Sort order must be ASC or DESC', 'INVALID_SORT');
    assertValidFilterPath(term.field);
  }
  return sort.terms;
};

const buildSortClause = (sortTerms, gqltype, aggregateClauses, aggregationsIncluded) => {
  const sortExpressions = {};
  for (const sort of sortTerms) {
    const resolved = resolveQueryPath(gqltype, sort.field, aggregationsIncluded);
    appendLookups(aggregateClauses, aggregationsIncluded, resolved.aggregateClauses);
    sortExpressions[resolved.mongoPath] = sort.order === 'ASC' ? 1 : -1;
  }
  return { $sort: sortExpressions };
};

const buildQuery = async (input, gqltype, isCount) => {
  const aggregateClauses = [];
  const aggregationsIncluded = {};
  const paging = paginationStages(input.pagination, true);

  const matchStage = await collectFiltersAndLookups(input, gqltype, aggregateClauses, aggregationsIncluded, 'find');
  if (matchStage) aggregateClauses.push(matchStage);

  if (isCount) {
    aggregateClauses.push({ $count: 'size' });
    return aggregateClauses;
  }

  if (input.sort) {
    aggregateClauses.push(buildSortClause(validateSortTerms(input.sort), gqltype, aggregateClauses, aggregationsIncluded));
  }

  aggregateClauses.push(...paging);

  // Joined documents only serve $match/$sort; returned rows keep their stored references.
  const lookupAliasList = Object.keys(aggregationsIncluded);
  if (lookupAliasList.length > 0) aggregateClauses.push({ $unset: lookupAliasList });

  return aggregateClauses;
};

const RESERVED_FACT_NAMES = new Set(['__proto__', 'constructor', 'prototype']);

const buildAggregationQuery = async (input, gqltype, aggregationExpression) => {
  const aggregateClauses = [];
  const aggregationsIncluded = {};
  const paging = paginationStages(input.pagination, false);

  const matchStage = await collectFiltersAndLookups(input, gqltype, aggregateClauses, aggregationsIncluded, 'aggregate');
  if (matchStage) aggregateClauses.push(matchStage);

  const { groupId, facts } = aggregationExpression ?? {};
  if (!groupId || !Array.isArray(facts) || facts.length === 0) throw filterError('Aggregation requires a groupId and facts');
  const groupIdPath = resolveQueryPath(gqltype, groupId, aggregationsIncluded);
  appendLookups(aggregateClauses, aggregationsIncluded, groupIdPath.aggregateClauses);

  const groupStage = { $group: { _id: `$${groupIdPath.mongoPath}` } };
  const factNames = new Set();

  // Positional accumulator names keep a fact named `_id` from replacing the group key.
  facts.forEach((fact, index) => {
    if (!Object.hasOwn(AGG_OP_TO_MONGO, fact?.operation)) throw filterError('Invalid aggregate operation');
    if (typeof fact.factName !== 'string' || !PATH_SEGMENT_RE.test(fact.factName)
      || RESERVED_FACT_NAMES.has(fact.factName) || factNames.has(fact.factName)) {
      throw filterError('Invalid or duplicate aggregation fact name');
    }
    factNames.add(fact.factName);
    const factPath = resolveQueryPath(gqltype, fact.path, aggregationsIncluded);
    appendLookups(aggregateClauses, aggregationsIncluded, factPath.aggregateClauses);
    groupStage.$group[`fact_${index}`] = AGG_OP_TO_MONGO[fact.operation](factPath.mongoPath);
  });

  aggregateClauses.push(groupStage);

  aggregateClauses.push({
    $project: {
      _id: 0,
      groupId: '$_id',
      facts: Object.fromEntries(facts.map((fact, index) => [fact.factName, `$fact_${index}`])),
    },
  });

  const sortTerms = input.sort ? validateSortTerms(input.sort) : null;
  if (sortTerms) {
    const sortObject = {};
    sortTerms.forEach((sortTerm) => {
      const field = sortTerm.field || 'groupId';
      const sortFieldPath = factNames.has(field) ? `facts.${field}` : 'groupId';
      sortObject[sortFieldPath] = sortTerm.order === 'ASC' ? 1 : -1;
    });
    aggregateClauses.push({ $sort: sortObject });
  } else {
    aggregateClauses.push({ $sort: { groupId: 1 } });
  }

  aggregateClauses.push(...paging);

  return aggregateClauses;
};

  return { buildQuery, buildFilterGroupMatch, buildAggregationQuery };
};
