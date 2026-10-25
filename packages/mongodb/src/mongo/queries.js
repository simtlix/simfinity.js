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
  TEXT_QUERY_OPERATORS, aggregateJoinPrefixes, crossingKeys, describeEmptiness, effectiveScalarName, emptinessScopePaths,
  frameCollectionPaths, isEmptinessOperator, validateQuantifiedGroups,
  textQueryOperator, validateTextFilterValue,
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
// The scoped joins and frames of reference and collection emptiness (#108 part 2b). Each kind has its own counter, so
// the lookup aliases keep their numbers.
const RELATION_ALIAS_PREFIXES = { join: '__sf_j', frame: '__sf_q' };

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
// Only actual reference joins reached through embedded lists multiply a body's candidates.
const multiplyingBuilds = new WeakSet();

const allocateLookupAlias = (aggregationsIncluded, relationPath) => {
  let aliases = lookupAliases.get(aggregationsIncluded);
  if (!aliases) {
    aliases = new Map();
    lookupAliases.set(aggregationsIncluded, aliases);
  }
  if (!aliases.has(relationPath)) aliases.set(relationPath, `${LOOKUP_ALIAS_PREFIX}${aliases.size}`);
  return aliases.get(relationPath);
};

// The scoped joins and frames of one build, keyed by the build's `included` accumulator like the lookup aliases:
// their aliases by kind and key, a counter per kind, and each target scope compiled once.
const relationBuilds = new WeakMap();

const relationBuild = (aggregationsIncluded) => {
  let build = relationBuilds.get(aggregationsIncluded);
  if (!build) {
    build = {
      aliases: new Map(), counts: { join: 0, frame: 0, scope: 0, serial: 0 }, scopes: new WeakMap(), serials: new WeakMap(),
    };
    relationBuilds.set(aggregationsIncluded, build);
  }
  return build;
};

const allocateRelationAlias = (build, kind, key) => {
  const entry = `${kind} ${key}`;
  if (!build.aliases.has(entry)) build.aliases.set(entry, `${RELATION_ALIAS_PREFIXES[kind]}${build.counts[kind]++}`);
  return build.aliases.get(entry);
};

// Lookup entries are `{ stages }` by alias: a join's `$lookup` and `$unwind`, or a frame's single `$lookup`.
const appendLookups = (aggregateClauses, aggregationsIncluded, lookups) => {
  for (const [alias, { stages }] of Object.entries(lookups)) {
    if (!Object.hasOwn(aggregationsIncluded, alias)) {
      aggregateClauses.push(...stages);
      aggregationsIncluded[alias] = true;
    }
  }
};

const buildRelationLookup = ({
  collectionName, localField, foreignField, alias,
}) => ({
  stages: [
    {
      $lookup: {
        from: collectionName, foreignField, localField, as: alias,
        ...(foreignField !== '_id' && localField !== '_id' ? { pipeline: [{ $match: { [foreignField]: { $ne: null } } }] } : {}),
      },
    },
    { $unwind: { path: `$${alias}`, preserveNullAndEmptyArrays: true } },
  ],
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
const resolveQueryPath = (gqltype, path, aggregationsIncluded, origin) => {
  assertValidFilterPath(path);
  const parts = path.split('.');
  let currentType = gqltype;
  let currentModel = origin?.model ?? getModel(gqltype);
  let mongoPath = origin?.parent.key ?? '';
  let schemaPath = origin?.parent.schemaPath ?? '';
  let vector = false;
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
        vector ||= !!getListShape(field.type);
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
        if (vector) multiplyingBuilds.add(aggregationsIncluded);
        vector = false;
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

// The emptiness operators IS_EMPTY and IS_NOT_EMPTY (#108, parts 2a and 2b). Core's describeEmptiness applies their
// checks in the order every caller uses and describes what "empty" means for the path. It rejects interface and
// union fields and anything inside a list. On the queried document's own fields, through single embedded objects,
// the forms are plain query operators that need no lookup, valid wherever the $match runs. A path may also cross
// single references and end at a reference or a collection, and an embedded object may have reference and
// collection members (part 2b). A crossing reads the target through a join, and a reference or collection end or
// member through a frame: one `$lookup` that keeps at most one record id, so it never repeats a document, and that
// is empty when no record exists. A construct the client sent carries the client scope marker that the runtime
// fills, `__scope: { id, scopes }`, on its term or group condition; `scopes` holds each target's find scope
// arguments by path, or null when the scope added nothing. Its crossings are then scoped joins and its frames scoped
// frames, so a record the scope hides reads as missing. A construct without a marker, from middleware, a scope or a
// direct buildQuery() call, reads stored data, and its leaves share the plain lookup aliases with the other
// operators. The joins and frames sit with the other lookups before the $match, so they also filter counts,
// aggregates and batched collection reads.
const isPathless = (path) => path == null || path === '';
const joinPath = (base, name) => (base ? `${base}.${name}` : name);

const hasScopeMarker = (construct) => construct != null && typeof construct === 'object' && Object.hasOwn(construct, '__scope');
// Only the runtime writes and fills client scope markers, after middleware, so a marker that cannot be honored here
// is an internal error, never a construct compiled with stored semantics.
const detachedFilter = (message) => new SimfinityError(
  `${message}; only the runtime writes and fills client scope markers (docs/guide/middleware.md)`, 'DETACHED_CLIENT_FILTER', 500,
);

// Where a value is: the Mongo key that reads it, its storage path relative to the documents of `model` (which
// identifierLeaf and the identity rule read), and its dotted GraphQL path from the queried record, which names
// its scope. `{ key: '', schemaPath: '', path: '' }` is the queried document; a joined document has its alias as
// key, an empty storage path and its crossing as path.
const memberPlace = (model, parent, type, name) => {
  const field = type.getFields()[name];
  // A non-object `id` member follows identifierLeaf, as resolveQueryPath does; others keep their name.
  const leaf = name === 'id' && !(getNamedType(field.type) instanceof GraphQLObjectType)
    ? identifierLeaf(model, parent.schemaPath, type)
    : name;
  return { key: joinPath(parent.key, leaf), schemaPath: joinPath(parent.schemaPath, leaf), path: joinPath(parent.path, name) };
};

// MongoDB stores the built-in scalars, dates and enums as single values, but keeps an application scalar
// without a supported base as written, arrays included, and `{ p: null }` also matches an array that
// holds a null. The null rule of such a scalar leaves arrays out, so `[null]` is a value, as GraphQL
// reads it. The record identity `_id`, of the queried or a joined document, is never an array, so it keeps the
// plain form.
const SINGLE_VALUE_SCALARS = new Set(['String', 'ID', 'Int', 'Float', 'Boolean', 'DateTime', 'Date', 'Time']);
const holdsArrays = (place, type) => (
  place.schemaPath !== '_id' && isScalarType(type) && !SINGLE_VALUE_SCALARS.has(effectiveScalarName(type))
);
const nullForm = (place, type) => (holdsArrays(place, type)
  ? { $and: [{ [place.key]: null }, { [place.key]: { $not: { $type: 'array' } } }] }
  : { [place.key]: null });

// A frame: NONE over the reference or collection `name` of the object at `parent`, whose type is `type`. Its
// `$lookup` keeps at most one id of a target record that the reference points to (`foreignField: '_id'`) or of a
// child whose connection field, `shape.connectionField`, holds the object's `_id`, among those the target scope
// admits. A frame is keyed by its path and by the scopes of every crossing before it and its own, so a frame after
// a scoped crossing never shares a trusted one, even when its own scope is null. A collection frame also tests its
// local key for null: `$lookup` matches a missing local key with every child whose connection field is null.
const frameForm = (ctx, shape, parent, type, name) => {
  const field = type.getFields()[name];
  const path = joinPath(parent.path, name);
  const scope = ctx.scopes.get(path) ?? null;
  const alias = allocateRelationAlias(ctx.build, 'frame', `${path} ${[...ctx.chain, scope ? scope.token : '-'].join(',')}`);
  const collection = shape.rule === 'collection';
  const localField = joinPath(parent.key, collection ? '_id' : getFieldStorageName(name, field));
  ctx.lookups[alias] = {
    stages: [{
      $lookup: {
        from: getModel(getNamedType(field.type)).collection.collectionName,
        localField,
        foreignField: collection ? shape.connectionField : '_id',
        pipeline: [...(scope?.stages ?? []), { $limit: 1 }, { $project: { _id: 1 } }],
        as: alias,
      },
    }],
  };
  const none = { [`${alias}.0`]: { $exists: false } };
  return collection ? { $or: [{ [localField]: null }, none] } : none;
};

// The IS_EMPTY form of `shape` for the member `name` of the object at `parent`, whose type is `type`. An object is
// missing, null, or has every stored member empty. Without stored members it is always empty: MongoDB rejects an
// empty $and, so the empty query, which matches every document, stands in.
const emptyForm = (ctx, shape, parent, type, name) => {
  if (shape.rule === 'reference' || shape.rule === 'collection') return frameForm(ctx, shape, parent, type, name);
  const place = memberPlace(ctx.model, parent, type, name);
  const valueType = getNamedType(type.getFields()[name].type);
  if (shape.rule === 'string') return { [place.key]: { $in: [null, ''] } };
  if (shape.rule === 'null') return nullForm(place, valueType);
  if (shape.rule === 'list') return { [`${place.key}.0`]: { $exists: false } };
  const members = shape.members.map((member) => emptyForm(ctx, member.shape, place, valueType, member.name));
  return { $or: [{ [place.key]: null }, members.length ? { $and: members } : {}] };
};

// IS_NOT_EMPTY is the exact complement: the positive form of a leaf, which an index can serve, or the $nor of the
// IS_EMPTY form of an object, a reference, a collection or a scalar that may hold arrays.
const notEmptyForm = (ctx, shape, parent, type, name) => {
  if (shape.rule === 'reference' || shape.rule === 'collection' || shape.rule === 'object') {
    return { $nor: [emptyForm(ctx, shape, parent, type, name)] };
  }
  const place = memberPlace(ctx.model, parent, type, name);
  const valueType = getNamedType(type.getFields()[name].type);
  if (shape.rule === 'string') return { [place.key]: { $nin: [null, ''] } };
  if (shape.rule === 'null') return holdsArrays(place, valueType) ? { $nor: [nullForm(place, valueType)] } : { [place.key]: { $ne: null } };
  return { [`${place.key}.0`]: { $exists: true } };
};

// The GraphQL target type of each reference and collection path an emptiness construct reads (its crossings, its end
// and its members), by dotted path from the queried type.
const relationTargets = (gqltype, segments, shape) => {
  const targets = new Map();
  let type = gqltype;
  for (const [index, name] of segments.entries()) {
    type = getNamedType(type.getFields()[name].type);
    targets.set(segments.slice(0, index + 1).join('.'), type);
  }
  const visit = (node, objectType, path) => {
    if (node.rule !== 'object') return;
    for (const member of node.members) {
      const memberType = getNamedType(objectType.getFields()[member.name].type);
      targets.set(`${path}.${member.name}`, memberType);
      visit(member.shape, memberType, `${path}.${member.name}`);
    }
  };
  visit(shape, type, segments.join('.'));
  return targets;
};

// A target's find scope from a filled client scope marker, compiled once per build and target type with this
// compiler, in a fresh alias space: its own lookups live on the joined documents, and ID casting and state names are
// the target's. Scope arguments are trusted. Gives `{ token, stages }`, or null for a null scope or one that adds no
// stage, which reads like no scope.
const compileTargetScope = async (build, scope, targetType) => {
  if (scope === null) return null;
  const compiled = build.scopes.get(scope);
  if (compiled?.has(targetType)) return compiled.get(targetType);
  const stages = [];
  const match = await collectFiltersAndLookups(scope, targetType, stages, {}, 'find');
  if (match) stages.push(match);
  const result = stages.length ? { token: `s${build.counts.scope++}`, stages } : null;
  if (!build.scopes.has(scope)) build.scopes.set(scope, new Map());
  build.scopes.get(scope).set(targetType, result);
  return result;
};

// The scopes of a client construct's filled marker, or null for a construct without one. Fails closed: a marker
// on a construct that reads no reference or collection, or whose `scopes` lack a path the construct reads, is an
// internal error.
const clientScopes = (construct, label, paths) => {
  if (!hasScopeMarker(construct)) return null;
  if (!paths.length) throw detachedFilter(`${label} carries a client scope marker, but reads no reference or collection`);
  const scopes = construct.__scope?.scopes;
  if (!scopes || typeof scopes !== 'object' || Array.isArray(scopes)) {
    throw detachedFilter(`${label} carries a client scope marker whose scopes are not filled`);
  }
  for (const path of paths) {
    if (!Object.hasOwn(scopes, path) || scopes[path] === undefined) {
      throw detachedFilter(`${label} carries a client scope marker without the scope of ${path}`);
    }
  }
  return scopes;
};

// The match clause of one emptiness condition on `path`, the field itself or a dotted path from it. `construct` is
// the term or group condition that holds it, the only objects whose client scope marker is read, or null. Its joins
// and frames are added to `lookups` as entries by alias, which the caller appends before the $match. A crossing, end
// or member whose target has no model fails with INVALID_FILTER_PATH before any entry is added.
const buildEmptinessClause = async (gqltype, path, operator, value, construct, lookups, aggregationsIncluded) => {
  const segments = path.split('.');
  const shape = describeEmptiness(gqltype, segments, { operator, value, path });
  const { joins, frames } = emptinessScopePaths(shape, segments);
  const paths = [...joins, ...frames];
  const targets = relationTargets(gqltype, segments, shape);
  if (paths.some((relationPath) => !getModel(targets.get(relationPath)))) {
    throw filterError(`Related model is not available for ${path}`, 'INVALID_FILTER_PATH');
  }
  const scopes = clientScopes(construct, `${operator} on ${path}`, paths);
  const build = relationBuild(aggregationsIncluded);
  const compiled = new Map();
  if (scopes) {
    for (const relationPath of paths) compiled.set(relationPath, await compileTargetScope(build, scopes[relationPath], targets.get(relationPath)));
  }
  const ctx = {
    build, lookups, scopes: compiled, chain: [], model: getModel(gqltype),
  };
  // Crossings: a plain lookup, shared with the other operators, while every crossing so far is trusted or has a null
  // scope; from the first scoped crossing on, a scoped join keyed by the scopes of every crossing up to it, also when
  // its own scope is null, correlated through the joins before it.
  const crossings = new Set(joins);
  let parent = { key: '', schemaPath: '', path: '' };
  let type = gqltype;
  let scoped = false;
  for (const name of segments.slice(0, -1)) {
    const field = type.getFields()[name];
    const fieldType = getNamedType(field.type);
    const crossing = joinPath(parent.path, name);
    if (!crossings.has(crossing)) {
      parent = { key: joinPath(parent.key, name), schemaPath: joinPath(parent.schemaPath, name), path: crossing };
    } else {
      const scope = compiled.get(crossing) ?? null;
      ctx.chain.push(scope ? scope.token : '-');
      scoped ||= !!scope;
      const target = getModel(fieldType);
      const localField = joinPath(parent.key, getFieldStorageName(name, field));
      let alias;
      if (!scoped) {
        alias = allocateLookupAlias(aggregationsIncluded, crossing);
        lookups[alias] = buildRelationLookup({
          collectionName: target.collection.collectionName, localField, foreignField: '_id', alias,
        });
      } else {
        alias = allocateRelationAlias(build, 'join', `${crossing} ${ctx.chain.join(',')}`);
        lookups[alias] = {
          stages: [
            {
              $lookup: {
                from: target.collection.collectionName,
                localField,
                foreignField: '_id',
                pipeline: [...(scope?.stages ?? []), { $limit: 1 }],
                as: alias,
              },
            },
            { $unwind: { path: `$${alias}`, preserveNullAndEmptyArrays: true } },
          ],
        };
      }
      parent = { key: alias, schemaPath: '', path: crossing };
      ctx.model = target;
    }
    type = fieldType;
  }
  const form = operator === 'IS_EMPTY' ? emptyForm : notEmptyForm;
  return form(ctx, shape, parent, type, segments.at(-1));
};

// A build keeps one rewrite context; aggregate J paths must survive every logical-group pass.
const rewriteContext = (gqltype, operation = 'find', aggregation) => {
  const ctx = { gqltype, operation, quantifiers: true, referenceEmptiness: true, operators: new Set(MONGO_QUERY_OPERATORS), base: '', inFrame: false };
  // Ordinary root markers reject at the existing post-value guards, preserving native order.
  ctx.deferOrdinaryRootMarkers = true;
  ctx.J = operation === 'aggregate' ? aggregateJoinPrefixes(aggregation, ctx) : new Set();
  return ctx;
};

// Cross references in the containing pipeline. Collection steps occur here only for an aggregate
// anchor: all ordinary collection crossings have already become frames in the shared rewrite.
const crossFramePath = async (gqltype, segments, scopes, build, lookups, included) => {
  let type = gqltype;
  let parent = { key: '', schemaPath: '', path: '' };
  let model = getModel(type);
  const chain = [];
  let scoped = false;
  let vector = false;
  for (const name of segments) {
    const field = type.getFields()[name];
    const targetType = getNamedType(field.type);
    const path = joinPath(parent.path, name);
    const relation = field.extensions?.relation;
    if (!relation || relation.embedded) {
      vector ||= !!getListShape(field.type);
      parent = { key: joinPath(parent.key, name), schemaPath: joinPath(parent.schemaPath, name), path };
    } else {
      const target = getModel(targetType);
      if (!target) throw filterError(`Related model is not available for ${path}`, 'INVALID_FILTER_PATH');
      const collection = !!getListShape(field.type);
      const foreignField = collection ? normalizeConnectionField(targetType, relation.connectionField || name).storageFieldName : '_id';
      const localField = joinPath(parent.key, collection ? '_id' : getFieldStorageName(name, field));
      const scope = scopes && Object.hasOwn(scopes, path) ? await compileTargetScope(build, scopes[path], targetType) : null;
      if (vector && scope) throw new SimfinityError('A reference inside an embedded list cannot apply a target scope', 'FORBIDDEN_FILTER_PATH', 403);
      chain.push(scope ? scope.token : '-');
      scoped ||= !!scope;
      let alias;
      if (!scoped) {
        alias = allocateLookupAlias(included, path);
        lookups[alias] = buildRelationLookup({ collectionName: target.collection.collectionName, localField, foreignField, alias });
      } else {
        alias = allocateRelationAlias(build, 'join', `${path} ${chain.join(',')}`);
        // A vector with a null target scope keeps every target. The chain alias isolates it
        // from a trusted join while its local key preserves the earlier restricted reference.
        lookups[alias] = vector ? buildRelationLookup({ collectionName: target.collection.collectionName, localField, foreignField, alias }) : { stages: [
          { $lookup: { from: target.collection.collectionName, localField, foreignField, pipeline: [...(scope?.stages ?? []), { $limit: 1 }], as: alias } },
          { $unwind: { path: `$${alias}`, preserveNullAndEmptyArrays: true } },
        ] };
      }
      if (vector) multiplyingBuilds.add(included);
      vector = false;
      parent = { key: alias, schemaPath: '', path };
      model = target;
    }
    type = targetType;
  }
  return { type, parent, model, chain };
};

// A non-emptiness marker is legal only inside a frame, on a condition crossing references. Its
// keys are relative to the element, just like 2b emptiness keys in the same sub-build.
const resolveConditionPath = async (gqltype, path, construct, included, ctx) => {
  if (!hasScopeMarker(construct)) return resolveQueryPath(gqltype, path, included);
  // buildQueryTerms rejects the marker immediately after buildMatchesClause; group conditions
  // also retain their raw-condition guard. No accepted path parses or casts a value twice.
  if (!ctx?.inFrame && ctx?.deferOrdinaryRootMarkers === true) return resolveQueryPath(gqltype, path, included);
  if (!ctx?.inFrame) throw detachedFilter(`${construct.operator ?? 'EQ'} on ${joinPath(ctx?.base, path)} carries a client scope marker, but is not an emptiness condition`);
  const paths = crossingKeys(path.split('.'), { gqltype });
  const scopes = clientScopes(construct, `${construct.operator ?? 'EQ'} on ${joinPath(ctx.base, path)}`, paths);
  const aggregateClauses = {};
  const crossed = await crossFramePath(gqltype, path.split('.').slice(0, -1), scopes, relationBuild(included), aggregateClauses, included);
  const resolved = resolveQueryPath(crossed.type, path.split('.').at(-1), included, crossed);
  return { ...resolved, aggregateClauses: { ...aggregateClauses, ...resolved.aggregateClauses } };
};

const compileFrame = async (ctx, quantifier, group) => {
  const build = relationBuild(ctx.included);
  const anchor = group.__implicit === true ? group.__anchor ?? [] : [];
  const segments = [...anchor, ...group.path.split('.')];
  const paths = [];
  let type = ctx.gqltype;
  let vector = false;
  let multiplyingPrefix = false;
  for (const [index, name] of segments.entries()) {
    const field = type.getFields()[name];
    if (field.extensions?.relation && !field.extensions.relation.embedded) {
      if (index < segments.length - 1 && vector) multiplyingPrefix = true;
      vector = false;
      if (!getModel(getNamedType(field.type))) throw filterError(`Related model is not available for ${joinPath(ctx.base, segments.join('.'))}`, 'INVALID_FILTER_PATH');
      if (!anchor.length || index >= anchor.length || getListShape(field.type)) paths.push(segments.slice(0, index + 1).join('.'));
    } else {
      vector ||= !!getListShape(field.type);
    }
    type = getNamedType(field.type);
  }
  const scopes = clientScopes(group, `${quantifier} on ${joinPath(ctx.base, segments.join('.'))}`, paths);
  if (anchor.length && scopes) {
    for (const path of paths.filter((key) => anchor.join('.').startsWith(key))) {
      if (scopes[path] !== null) throw detachedFilter('Aggregate anchors require null J scopes and legacy reference joins');
    }
  }
  const emptyAll = quantifier === 'ALL' && !['conditions', 'ANY', 'ALL', 'NONE', 'AND', 'OR'].some((key) => group[key]?.length);
  // A vector prefix belongs to this predicate, not to the containing result set. A
  // self-correlated witness keeps its joins local without discarding any target. Aggregate
  // anchors retain their intentional expansion. NONE tests the positive ANY witness; ALL
  // looks for a prefix whose complete ALL test fails, including vacuous empty prefixes.
  if (multiplyingPrefix && !anchor.length && !ctx.prefixIsolated && !emptyAll) {
    const model = getModel(ctx.gqltype);
    if (!model) throw filterError(`Related model is not available for ${ctx.gqltype.name}`, 'INVALID_FILTER_PATH');
    if (!build.serials.has(group)) build.serials.set(group, build.counts.serial++);
    const alias = allocateRelationAlias(build, 'frame', `prefix:${build.serials.get(group)}`);
    const stages = [];
    const included = {};
    relationBuilds.set(included, { ...relationBuild(included), counts: build.counts, scopes: build.scopes });
    const positive = await compileFrame({ ...ctx, stages, included, prefixIsolated: true }, quantifier === 'NONE' ? 'ANY' : quantifier, group);
    if (quantifier === 'ALL' && !Object.keys(positive).length) return {};
    ctx.stages.push({ $lookup: {
      from: model.collection.collectionName, localField: '_id', foreignField: '_id',
      pipeline: [...stages, { $match: quantifier === 'ALL' ? { $nor: [positive] } : positive }, { $limit: 1 }, { $project: { _id: 1 } }],
      as: alias,
    } });
    ctx.included[alias] = true;
    return { [`${alias}.0`]: { $exists: quantifier === 'ANY' } };
  }
  const lookups = {};
  const crossed = await crossFramePath(ctx.gqltype, segments.slice(0, -1), anchor.length ? null : scopes, build, lookups, ctx.included);
  const name = segments.at(-1);
  const field = crossed.type.getFields()[name];
  const targetType = getNamedType(field.type);
  const path = segments.join('.');
  const scope = scopes ? await compileTargetScope(build, scopes[path], targetType) : null;
  if (emptyAll) return {};
  // Allocate before compiling the body: descendants follow their parent's serial even though
  // their lookups live inside its pipeline. No quantified frame shares a 2b emptiness frame.
  if (!build.serials.has(group)) build.serials.set(group, build.counts.serial++);
  const alias = allocateRelationAlias(build, 'frame', `group:${build.serials.get(group)} ${path} ${[...crossed.chain, scope ? scope.token : '-'].join(',')}`);
  const stages = [];
  const included = {};
  relationBuilds.set(included, { ...relationBuild(included), counts: build.counts, scopes: build.scopes });
  const childCtx = { ...rewriteContext(targetType), base: joinPath(ctx.base, path), inFrame: true };
  const body = await buildFilterGroupMatch(group, targetType, stages, included, 0, childCtx);
  if (quantifier === 'ALL' && body === null) return {};
  // ALL negates one truth value for the actual child. With vector joins, negating
  // individual expanded rows would incorrectly turn a bad sibling target into a failing
  // child. Keep the complete positive body together, with its scope admission outside.
  let bodyStages = stages;
  let bodyMatch = quantifier === 'ALL' ? { $nor: [body] } : body;
  if (quantifier === 'ALL' && multiplyingBuilds.has(included)) {
    const witness = allocateRelationAlias(build, 'frame', `body:${build.serials.get(group)}`);
    bodyStages = [{ $lookup: {
      from: getModel(targetType).collection.collectionName, localField: '_id', foreignField: '_id',
      pipeline: [...stages, { $match: body }, { $limit: 1 }, { $project: { _id: 1 } }],
      as: witness,
    } }];
    bodyMatch = { [`${witness}.0`]: { $exists: false } };
  }
  const collection = !!getListShape(field.type);
  const localField = joinPath(crossed.parent.key, collection ? '_id' : getFieldStorageName(name, field));
  const foreignField = collection ? normalizeConnectionField(targetType, field.extensions.relation.connectionField || name).storageFieldName : '_id';
  lookups[alias] = { stages: [{ $lookup: {
    from: getModel(targetType).collection.collectionName, localField, foreignField,
    pipeline: [
      ...(collection && localField !== '_id' ? [{ $match: { [foreignField]: { $ne: null } } }] : []),
      ...(scope?.stages ?? []), ...bodyStages,
      ...(body === null ? [] : [{ $match: bodyMatch }]),
      { $limit: 1 }, { $project: { _id: 1 } },
    ],
    as: alias,
  } }] };
  appendLookups(ctx.stages, ctx.included, lookups);
  return { [`${alias}.0`]: { $exists: quantifier === 'ANY' } };
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

const buildQueryTerms = async (filterField, qlField, fieldName, gqltype, aggregationsIncluded, ctx) => {
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
    // Only the terms of an object filter are constructs; a scalar filter is its own term.
    if (isEmptinessOperator(term.operator)) {
      const pathed = isObject && !isPathless(term.path);
      if (pathed) assertValidFilterPath(term.path);
      matchesClauses.push(await buildEmptinessClause(
        gqltype, pathed ? `${fieldName}.${term.path}` : fieldName, term.operator, term.value, isObject ? term : null,
        aggregateClauses, aggregationsIncluded,
      ));
      continue;
    }
    if (isObject) assertValidFilterPath(term.path);
    const path = isObject ? `${fieldName}.${term.path}` : fieldName;
    const resolved = await resolveConditionPath(gqltype, path, isObject ? term : null, aggregationsIncluded, ctx);
    Object.assign(aggregateClauses, resolved.aggregateClauses);
    matchesClauses.push(buildMatchesClause(resolved, term.operator, term.value, path));
    if (isObject && hasScopeMarker(term) && !ctx?.inFrame) {
      throw detachedFilter(`${term.operator ?? 'EQ'} on ${path} carries a client scope marker, but is not an emptiness condition`);
    }
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

const buildFilterGroupMatch = async (rawFilterGroup, gqltype, aggregateClauses, aggregationsIncluded, depth = 0, rewriteCtx) => {
  let filterGroup = rawFilterGroup;
  let ctx = rewriteCtx;
  if (!ctx) {
    ctx = rewriteContext(gqltype);
    const input = { AND: [filterGroup] };
    validateQuantifiedGroups(input, ctx);
    filterGroup = frameCollectionPaths(input, ctx).AND[0];
  }
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
      const path = rawCondition.path ? `${rawCondition.field}.${rawCondition.path}` : rawCondition.field;
      if (isEmptinessOperator(condition.operator)) {
        const lookups = {};
        const match = await buildEmptinessClause(gqltype, path, condition.operator, condition.value, rawCondition, lookups, aggregationsIncluded);
        appendLookups(aggregateClauses, aggregationsIncluded, lookups);
        parts.push(match);
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
          terms: [{ ...rawCondition, field: undefined, path: condition.path, operator: condition.operator, value: condition.value }],
        };
      } else {
        if (condition.path != null && condition.path !== '') throw filterError(`Cannot traverse scalar field ${condition.field}`, 'INVALID_FILTER_PATH');
        filterInput = { operator: condition.operator, value: condition.value };
      }

      const result = await buildQueryTerms(filterInput, qlField, condition.field, gqltype, aggregationsIncluded, ctx);
      if (hasScopeMarker(rawCondition) && !ctx.inFrame) {
        throw detachedFilter(`${condition.operator ?? 'EQ'} on ${path} carries a client scope marker, but is not an emptiness condition`);
      }
      appendLookups(aggregateClauses, aggregationsIncluded, result.aggregateClauses);
      for (const matchClause of Object.values(result.matchesClauses)) {
        for (const [matchKey, match] of Object.entries(matchClause)) {
          parts.push({ [matchKey]: match });
        }
      }
    }
  }

  for (const quantifier of ['ANY', 'ALL', 'NONE']) {
    for (const group of filterGroup[quantifier] ?? []) parts.push(await compileFrame({ ...ctx, stages: aggregateClauses, included: aggregationsIncluded }, quantifier, group));
  }

  if (filterGroup.AND?.length > 0) {
    for (const subGroup of filterGroup.AND) {
      const subMatch = await buildFilterGroupMatch(subGroup, gqltype, aggregateClauses, aggregationsIncluded, depth + (subGroup.__implicit === true ? 0 : 1), ctx);
      if (subMatch) parts.push(subMatch);
    }
  }

  if (filterGroup.OR?.length > 0) {
    const orParts = [];
    for (const subGroup of filterGroup.OR) {
      const subMatch = await buildFilterGroupMatch(subGroup, gqltype, aggregateClauses, aggregationsIncluded, depth + (subGroup.__implicit === true ? 0 : 1), ctx);
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

const collectFiltersAndLookups = async (rawInput, gqltype, aggregateClauses, aggregationsIncluded, operation = 'find', aggregation) => {
  const ctx = rewriteContext(gqltype, operation, aggregation);
  validateQuantifiedGroups(rawInput, ctx);
  const input = frameCollectionPaths(rawInput, ctx);
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
    const result = await buildQueryTerms(filterField, qlField, key, gqltype, aggregationsIncluded, ctx);
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
      const groupMatch = await buildFilterGroupMatch(group, gqltype, aggregateClauses, aggregationsIncluded, 0, ctx);
      if (groupMatch) topLevelAndParts.push(groupMatch);
    }
  }

  if (input.OR?.length > 0) {
    const orParts = [];
    for (const group of input.OR) {
      const groupMatch = await buildFilterGroupMatch(group, gqltype, aggregateClauses, aggregationsIncluded, 0, ctx);
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
    let type = gqltype;
    for (const name of sort.field.split('.')) {
      const field = type.getFields?.()[name];
      if (!field) break;
      if (field.extensions?.relation && !field.extensions.relation.embedded && getListShape(field.type)) {
        throw filterError(`Sort path ${sort.field} crosses the collection ${type.name}.${name}; a record has no single value there`, 'INVALID_FILTER_PATH');
      }
      type = getNamedType(field.type);
    }
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

  const matchStage = await collectFiltersAndLookups(input, gqltype, aggregateClauses, aggregationsIncluded, 'aggregate', aggregationExpression);
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
