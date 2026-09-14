import {
  GraphQLEnumType,
  GraphQLID,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
} from 'graphql';
import mongoose from 'mongoose';

import { SimfinityError, QLOperator, paginationStages } from '@simtlix/simfinity-core';

const isNonNullOfType = (fieldEntryType, graphQLType) => (
  fieldEntryType instanceof GraphQLNonNull && fieldEntryType.ofType instanceof graphQLType
);

const unwrapNonNull = (type) => (type instanceof GraphQLNonNull ? type.ofType : type);

const unwrapListAndNonNull = (type) => {
  let unwrapped = type;
  while (unwrapped instanceof GraphQLList || unwrapped instanceof GraphQLNonNull) {
    unwrapped = unwrapped.ofType;
  }
  return unwrapped;
};

const isListType = (type) => unwrapNonNull(type) instanceof GraphQLList;

const getFieldStorageName = (fieldName, field) => {
  const relation = field.extensions?.relation;
  return relation && !relation.embedded && !isListType(field.type)
    ? relation.connectionField || fieldName
    : fieldName;
};

const getConnectionStorageName = (childType, declaredFieldName) => {
  const childFields = childType.getFields();
  if (childFields[declaredFieldName]) {
    return getFieldStorageName(declaredFieldName, childFields[declaredFieldName]);
  }
  const aliasedField = Object.entries(childFields).find(([fieldName, field]) => (
    getFieldStorageName(fieldName, field) === declaredFieldName
  ));
  return aliasedField
    ? getFieldStorageName(aliasedField[0], aliasedField[1])
    : declaredFieldName;
};

const getEffectiveTypeName = (type) => (
  type instanceof GraphQLScalarType && type.baseScalarType ? type.baseScalarType.name : type.name
);

const isGraphQLisoDate = (typeName) => (
  typeName === 'DateTime' || typeName === 'Date' || typeName === 'Time'
);

export const createMongoQueries = ({ getModel, getRegistrations }) => {
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
  LIKE: (v) => ({ $regex: `.*${escapeRegex(v)}.*` }),
};

const AGG_OP_TO_MONGO = {
  SUM: (path) => ({ $sum: `$${path}` }),
  COUNT: () => ({ $sum: 1 }),
  AVG: (path) => ({ $avg: `$${path}` }),
  MIN: (path) => ({ $min: `$${path}` }),
  MAX: (path) => ({ $max: `$${path}` }),
};

const filterError = (message, code = 'INVALID_FILTER_VALUE') => new SimfinityError(message, code, 400);

const queryNamedType = (type) => {
  let result = type;
  while (result instanceof GraphQLList || result instanceof GraphQLNonNull) result = result.ofType;
  return result;
};

// Resolve GraphQL paths and storage paths together; supplied models own ID casting.
const resolveQueryPath = (gqltype, path) => {
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
    const fieldType = queryNamedType(field.type);
    const relation = field.extensions?.relation;
    if (fieldType instanceof GraphQLObjectType) {
      if (index === parts.length - 1) throw filterError(`Query path must end in a scalar field: ${path}`, 'INVALID_FILTER_PATH');
      if (!relation || relation.embedded) {
        mongoPath = mongoPath ? `${mongoPath}.${part}` : part;
        schemaPath = schemaPath ? `${schemaPath}.${part}` : part;
      } else {
        const relatedModel = getModel(fieldType);
        if (!relatedModel) throw filterError(`Related model is not available for ${path}`, 'INVALID_FILTER_PATH');
        const isList = unwrapNonNull(field.type) instanceof GraphQLList;
        const declaredField = relation.connectionField || part;
        const connField = isList ? getConnectionStorageName(fieldType, declaredField) : declaredField;
        const localLeaf = isList ? '_id' : connField;
        const alias = mongoPath ? `${mongoPath.replaceAll('.', '_')}_${part}` : part;
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
      const leaf = part === 'id' ? '_id' : part;
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
    const typeName = getEffectiveTypeName(scalar);
    if (isGraphQLisoDate(typeName)) {
      const date = value instanceof Date ? value : new Date(value);
      if (Number.isNaN(date.getTime())) throw new Error('Invalid date');
      return date;
    }
    if (scalar === GraphQLID && !schemaType) return new mongoose.Types.ObjectId(value);
    if (scalar instanceof GraphQLEnumType) {
      const entry = scalar.getValues().find((item) => item.name === value)
        || scalar.getValues().find((item) => item.value === value);
      if (!entry) throw new Error('Invalid enum value');
      const stored = resolved.storesStateName ? entry.name : entry.value;
      return schemaType ? schemaType.cast(stored) : stored;
    }
    const parsed = (scalar.baseScalarType || scalar).parseValue(value);
    return schemaType ? schemaType.cast(parsed) : parsed;
  } catch {
    throw filterError(`Invalid value for ${resolved.mongoPath}`);
  }
};

const buildMatchesClause = (resolved, operator, value) => {
  const op = operator ?? 'EQ';
  if (!QLOperator.getValues().some((entry) => entry.value === op)) {
    throw filterError(`Unsupported filter operator: ${op}`, 'INVALID_FILTER_OPERATOR');
  }
  const collectionOperator = op === 'IN' || op === 'NIN' || op === 'BTW';
  if (collectionOperator && (!Array.isArray(value) || (op === 'BTW' && value.length !== 2))) {
    throw filterError(`${op} requires ${op === 'BTW' ? 'exactly two values' : 'an array value'}`);
  }
  if (op === 'LIKE' && (typeof value !== 'string' || getEffectiveTypeName(resolved.fieldType) !== 'String')) {
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
  return { [resolved.mongoPath]: OP_TO_MONGO[op](coerced) };
};

const buildQueryTerms = async (filterField, qlField, fieldName, gqltype) => {
  const aggregateClauses = {};
  const matchesClauses = [];
  if (!qlField) throw filterError(`Unknown filter field: ${fieldName}`, 'INVALID_FILTER_FIELD');
  if (filterField == null) return { aggregateClauses, matchesClauses };
  if (typeof filterField !== 'object' || Array.isArray(filterField)) throw filterError(`Invalid filter for ${fieldName}`);
  const isObject = queryNamedType(qlField.type) instanceof GraphQLObjectType;
  if (isObject && (!Array.isArray(filterField.terms) || filterField.terms.length === 0)) {
    throw filterError(`Filter on ${fieldName} requires non-empty terms`, 'MISSING_FILTER_PATH');
  }
  const terms = isObject ? filterField.terms : [filterField];
  for (const term of terms) {
    if (!term || typeof term !== 'object' || Array.isArray(term)) throw filterError(`Invalid term for ${fieldName}`);
    if (isObject) assertValidFilterPath(term.path);
    const resolved = resolveQueryPath(gqltype, isObject ? `${fieldName}.${term.path}` : fieldName);
    Object.assign(aggregateClauses, resolved.aggregateClauses);
    matchesClauses.push(buildMatchesClause(resolved, term.operator, term.value));
  }
  return { aggregateClauses, matchesClauses };
};

const MAX_FILTER_GROUP_DEPTH = 5;

const validateLogicalLists = (group) => {
  if (!group || typeof group !== 'object' || Array.isArray(group)) throw filterError('Expected a filter group object');
  for (const key of ['AND', 'OR', 'conditions']) {
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
      const qlField = fields[condition.field];
      if (!qlField) {
        throw new SimfinityError(`Unknown filter field: ${condition.field}`, 'INVALID_FILTER_FIELD', 400);
      }

      const fieldType = unwrapListAndNonNull(qlField.type);
      const isObject = fieldType instanceof GraphQLObjectType || isNonNullOfType(fieldType, GraphQLObjectType);

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

      const result = await buildQueryTerms(filterInput, qlField, condition.field, gqltype);
      if (!result) continue;

      for (const [prop, aggregate] of Object.entries(result.aggregateClauses)) {
        if (!aggregationsIncluded[prop]) {
          aggregateClauses.push(aggregate.lookup, aggregate.unwind);
          aggregationsIncluded[prop] = true;
        }
      }
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

const RESERVED_QUERY_KEYS = new Set(['pagination', 'sort', 'AND', 'OR', 'aggregation']);

const collectFiltersAndLookups = async (input, gqltype, aggregateClauses, aggregationsIncluded) => {
  validateLogicalLists(input);
  const flatMatchConditions = {};
  const repeatedConditions = [];
  let hasFlat = false;
  const fields = gqltype.getFields();

  for (const [key, filterField] of Object.entries(input)) {
    if (RESERVED_QUERY_KEYS.has(key)) continue;
    const qlField = fields[key];
    const result = await buildQueryTerms(filterField, qlField, key, gqltype);
    if (!result) continue;

    for (const [prop, aggregate] of Object.entries(result.aggregateClauses)) {
      if (!aggregationsIncluded[prop]) {
        aggregateClauses.push(aggregate.lookup, aggregate.unwind);
        aggregationsIncluded[prop] = true;
      }
    }
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
    const resolved = resolveQueryPath(gqltype, sort.field);
    for (const [alias, aggregate] of Object.entries(resolved.aggregateClauses)) {
      if (!aggregationsIncluded[alias]) {
        aggregateClauses.push(aggregate.lookup, aggregate.unwind);
        aggregationsIncluded[alias] = true;
      }
    }
    sortExpressions[resolved.mongoPath] = sort.order === 'ASC' ? 1 : -1;
  }
  return { $sort: sortExpressions };
};

const buildQuery = async (input, gqltype, isCount) => {
  const aggregateClauses = [];
  const aggregationsIncluded = {};
  const paging = paginationStages(input.pagination, true);

  const matchStage = await collectFiltersAndLookups(input, gqltype, aggregateClauses, aggregationsIncluded);
  if (matchStage) aggregateClauses.push(matchStage);

  if (isCount) {
    aggregateClauses.push({ $count: 'size' });
    return aggregateClauses;
  }

  if (input.sort) {
    aggregateClauses.push(buildSortClause(validateSortTerms(input.sort), gqltype, aggregateClauses, aggregationsIncluded));
  }

  aggregateClauses.push(...paging);

  return aggregateClauses;
};

const buildFieldPath = (gqltype, fieldPath) => {
  assertValidFilterPath(fieldPath);
  const pathParts = fieldPath.split('.');
  const lookupPairs = [];
  let currentPath = '';
  let currentGQLType = gqltype;

  for (const part of pathParts) {
    const field = currentGQLType.getFields()[part];
    if (!field) {
      throw new Error(`Field ${part} not found in type ${currentGQLType.name}`);
    }

    const fieldType = unwrapListAndNonNull(field.type);
    const relation = field.extensions?.relation;

    if (fieldType instanceof GraphQLObjectType && relation && !relation.embedded) {
      const { collectionName } = getModel(fieldType).collection;
      const lookupAlias = currentPath ? `${currentPath}_${part}` : part;
      const inverseList = isListType(field.type);
      const declaredField = relation.connectionField || part;
      const connField = inverseList
        ? getConnectionStorageName(fieldType, declaredField)
        : declaredField;
      const localField = inverseList
        ? (currentPath ? `${currentPath}._id` : '_id')
        : (currentPath ? `${currentPath}.${connField}` : connField);

      lookupPairs.push(buildRelationLookup({
        collectionName,
        localField,
        foreignField: inverseList ? connField : '_id',
        alias: lookupAlias,
      }));

      currentPath = lookupAlias;
      currentGQLType = fieldType;
    } else if (fieldType instanceof GraphQLObjectType && relation?.embedded) {
      currentPath = currentPath ? `${currentPath}.${part}` : part;
      currentGQLType = fieldType;
    } else {
      const leaf = part === 'id' ? '_id' : part;
      currentPath = currentPath ? `${currentPath}.${leaf}` : leaf;
    }
  }

  return { mongoPath: currentPath, lookupPairs };
};

const appendLookupPairs = (aggregateClauses, aggregationsIncluded, lookupPairs) => {
  for (const { lookup, unwind } of lookupPairs) {
    const alias = lookup.$lookup.as;
    if (!aggregationsIncluded[alias]) {
      aggregateClauses.push(lookup, unwind);
      aggregationsIncluded[alias] = true;
    }
  }
};

const buildAggregationQuery = async (input, gqltype, aggregationExpression) => {
  const aggregateClauses = [];
  const aggregationsIncluded = {};
  const paging = paginationStages(input.pagination, false);

  const matchStage = await collectFiltersAndLookups(input, gqltype, aggregateClauses, aggregationsIncluded);
  if (matchStage) aggregateClauses.push(matchStage);

  const { groupId, facts } = aggregationExpression;
  const groupIdPath = buildFieldPath(gqltype, groupId);
  appendLookupPairs(aggregateClauses, aggregationsIncluded, groupIdPath.lookupPairs);

  const groupStage = { $group: { _id: `$${groupIdPath.mongoPath}` } };

  facts.forEach((fact) => {
    const factPath = buildFieldPath(gqltype, fact.path);
    appendLookupPairs(aggregateClauses, aggregationsIncluded, factPath.lookupPairs);

    const builder = AGG_OP_TO_MONGO[fact.operation];
    if (!builder) {
      throw new Error(`Unknown aggregation operation: ${fact.operation}`);
    }
    groupStage.$group[fact.factName] = builder(factPath.mongoPath);
  });

  aggregateClauses.push(groupStage);

  aggregateClauses.push({
    $project: {
      _id: 0,
      groupId: '$_id',
      facts: Object.fromEntries(facts.map((fact) => [fact.factName, `$${fact.factName}`])),
    },
  });

  const sortTerms = input.sort ? validateSortTerms(input.sort) : null;
  if (sortTerms) {
    const factNames = facts.map((fact) => fact.factName);
    const sortObject = {};
    sortTerms.forEach((sortTerm) => {
      const field = sortTerm.field || 'groupId';
      const sortFieldPath = factNames.includes(field) ? `facts.${field}` : 'groupId';
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
