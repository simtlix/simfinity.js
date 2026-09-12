import {
  GraphQLEnumType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
} from 'graphql';
import mongoose from 'mongoose';

import { SimfinityError } from '@simtlix/simfinity-core';

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

const coerceDateValue = (fieldType, holder, key) => {
  const typeName = getEffectiveTypeName(unwrapListAndNonNull(fieldType));
  if (!isGraphQLisoDate(typeName)) return;
  const raw = holder[key];
  if (Array.isArray(raw)) holder[key] = raw.map((value) => value && new Date(value));
  else holder[key] = raw && new Date(raw);
};

export const createMongoQueries = ({ getModel }) => {
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


const coerceIdArray = (value) => value.map((element) => {
  if (element === null || element === undefined) {
    throw new SimfinityError('ID value cannot be null in collection filter', 'INVALID_FILTER_VALUE', 400);
  }
  return new mongoose.Types.ObjectId(element);
});

const buildMatchesClause = (fieldname, operator, value) => {
  const isIdField = fieldname.endsWith('_id');
  const op = operator || 'EQ';

  if (op === 'EQ') {
    return { [fieldname]: isIdField ? new mongoose.Types.ObjectId(value) : value };
  }
  if (op === 'IN' || op === 'NIN') {
    if (!Array.isArray(value)) {
      throw new SimfinityError(`${op} requires an array value for ${fieldname}`, 'INVALID_FILTER_VALUE', 400);
    }
    const coerced = isIdField ? coerceIdArray(value) : value;
    return { [fieldname]: { [op === 'IN' ? '$in' : '$nin']: coerced } };
  }
  const builder = OP_TO_MONGO[op];
  return builder ? { [fieldname]: builder(value) } : {};
};

const topLevelRelationLookup = (qlField, fieldType, fieldName) => {
  const { collectionName } = getModel(fieldType).collection;
  const isList = isListType(qlField.type);
  const declaredField = qlField.extensions?.relation?.connectionField || fieldName;
  const connField = isList
    ? getConnectionStorageName(fieldType, declaredField)
    : declaredField;
  return buildRelationLookup({
    collectionName,
    localField: isList ? '_id' : connField,
    foreignField: isList ? connField : '_id',
    alias: fieldName,
  });
};

const nestedRelationLookup = (pathField, pathFieldType, currentPath, aliasPath, pathFieldName) => {
  const { collectionName } = getModel(pathFieldType).collection;
  const isList = isListType(pathField.type);
  const declaredField = pathField.extensions?.relation?.connectionField || pathFieldName;
  const connField = isList
    ? getConnectionStorageName(pathFieldType, declaredField)
    : declaredField;
  return buildRelationLookup({
    collectionName,
    localField: isList ? `${currentPath}._id` : `${currentPath}.${connField}`,
    foreignField: isList ? connField : '_id',
    alias: aliasPath,
  });
};

const buildAggregationsForSort = (filterField, qlField, fieldName) => {
  const aggregateClauses = {};
  const fieldType = unwrapListAndNonNull(qlField.type);

  if (!(fieldType instanceof GraphQLObjectType || isNonNullOfType(fieldType, GraphQLObjectType))) {
    return aggregateClauses;
  }

  if (!Array.isArray(filterField?.terms) || filterField.terms.length === 0) {
    return aggregateClauses;
  }

  const resolvedFieldType = unwrapNonNull(fieldType);

  filterField.terms.forEach((term) => {
    assertValidFilterPath(term.path);
    if (qlField.extensions?.relation && !qlField.extensions.relation.embedded
      && !aggregateClauses[fieldName]) {
      aggregateClauses[fieldName] = topLevelRelationLookup(qlField, resolvedFieldType, fieldName);
    }

    let currentGQLPathFieldType = unwrapListAndNonNull(qlField.type);
    let aliasPath = fieldName;
    let embeddedPath = '';

    term.path.split('.').forEach((pathFieldName) => {
      const pathField = currentGQLPathFieldType.getFields()[pathFieldName];
      const pathFieldType = unwrapListAndNonNull(pathField.type);
      if (pathFieldType instanceof GraphQLObjectType) {
        currentGQLPathFieldType = pathFieldType;

        if (pathField.extensions?.relation && !pathField.extensions.relation.embedded) {
          const currentPath = aliasPath + (embeddedPath !== '' ? `.${embeddedPath}` : '');
          aliasPath += (embeddedPath !== '' ? `_${embeddedPath}_` : '_') + pathFieldName;
          embeddedPath = '';

          if (!aggregateClauses[aliasPath]) {
            aggregateClauses[aliasPath] = nestedRelationLookup(
              pathField, pathFieldType, currentPath, aliasPath, pathFieldName,
            );
          }
        } else {
          embeddedPath = embeddedPath === '' ? pathFieldName : `${embeddedPath}.${pathFieldName}`;
        }
      }
    });
  });
  return aggregateClauses;
};

const buildQueryTerms = async (filterField, qlField, fieldName) => {
  const aggregateClauses = {};
  const matchesClauses = {};
  const fieldType = unwrapListAndNonNull(qlField.type);

  if (filterField == null) {
    return { aggregateClauses, matchesClauses };
  }

  if (fieldType instanceof GraphQLScalarType
    || isNonNullOfType(fieldType, GraphQLScalarType)
    || fieldType instanceof GraphQLEnumType
    || isNonNullOfType(fieldType, GraphQLEnumType)) {
    coerceDateValue(fieldType, filterField, 'value');
    matchesClauses[fieldName] = buildMatchesClause(fieldName === 'id' ? '_id' : fieldName, filterField.operator, filterField.value);
    return { aggregateClauses, matchesClauses };
  }

  if (!(fieldType instanceof GraphQLObjectType || isNonNullOfType(fieldType, GraphQLObjectType))) {
    return { aggregateClauses, matchesClauses };
  }

  if (!Array.isArray(filterField.terms) || filterField.terms.length === 0) {
    return { aggregateClauses, matchesClauses };
  }

  const resolvedFieldType = unwrapNonNull(fieldType);

  filterField.terms.forEach((term, termIndex) => {
    assertValidFilterPath(term.path);
    if (qlField.extensions?.relation && !qlField.extensions.relation.embedded
      && !aggregateClauses[fieldName]) {
      aggregateClauses[fieldName] = topLevelRelationLookup(qlField, resolvedFieldType, fieldName);
    }

    if (term.path.indexOf('.') < 0) {
      const { type: leafType } = resolvedFieldType.getFields()[term.path];
      coerceDateValue(leafType, term, 'value');
      const leafName = resolvedFieldType.getFields()[term.path].name === 'id' ? '_id' : term.path;
      matchesClauses[`${fieldName}_${term.path}_${termIndex}`] = buildMatchesClause(
        `${fieldName}.${leafName}`, term.operator, term.value,
      );
      return;
    }

    let currentGQLPathFieldType = unwrapListAndNonNull(qlField.type);
    let aliasPath = fieldName;
    let embeddedPath = '';

    term.path.split('.').forEach((pathFieldName) => {
      const pathField = currentGQLPathFieldType.getFields()[pathFieldName];
      const pathFieldType = unwrapListAndNonNull(pathField.type);
      if (pathFieldType instanceof GraphQLScalarType
        || pathFieldType instanceof GraphQLEnumType) {
        coerceDateValue(pathField.type, term, 'value');
        const leafName = pathFieldName === 'id' ? '_id' : pathFieldName;
        const mongoPath = aliasPath + (embeddedPath !== '' ? `.${embeddedPath}.` : '.') + leafName;
        matchesClauses[`${aliasPath}_${pathFieldName}_${termIndex}`] = buildMatchesClause(mongoPath, term.operator, term.value);
        embeddedPath = '';
      } else if (pathFieldType instanceof GraphQLObjectType) {
        currentGQLPathFieldType = pathFieldType;

        if (pathField.extensions?.relation && !pathField.extensions.relation.embedded) {
          const currentPath = aliasPath + (embeddedPath !== '' ? `.${embeddedPath}` : '');
          aliasPath += (embeddedPath !== '' ? `_${embeddedPath}_` : '_') + pathFieldName;
          embeddedPath = '';

          if (!aggregateClauses[aliasPath]) {
            aggregateClauses[aliasPath] = nestedRelationLookup(
              pathField, pathFieldType, currentPath, aliasPath, pathFieldName,
            );
          }
        } else {
          embeddedPath = embeddedPath === '' ? pathFieldName : `${embeddedPath}.${pathFieldName}`;
        }
      }
    });
  });

  return { aggregateClauses, matchesClauses };
};

const MAX_FILTER_GROUP_DEPTH = 5;

const buildFilterGroupMatch = async (filterGroup, gqltype, aggregateClauses, aggregationsIncluded, depth = 0) => {
  if (depth > MAX_FILTER_GROUP_DEPTH) {
    throw new SimfinityError('Filter nesting too deep', 'FILTER_DEPTH_EXCEEDED', 400);
  }

  const parts = [];
  const fields = gqltype.getFields();

  if (filterGroup.conditions?.length > 0) {
    for (const rawCondition of filterGroup.conditions) {
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
        filterInput = { operator: condition.operator, value: condition.value };
      }

      const result = await buildQueryTerms(filterInput, qlField, condition.field);
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
  const flatMatchConditions = {};
  const repeatedMatchConditions = [];
  let hasFlat = false;
  const fields = gqltype.getFields();

  for (const [key, filterField] of Object.entries(input)) {
    if (RESERVED_QUERY_KEYS.has(key)) continue;
    const qlField = fields[key];
    const result = await buildQueryTerms(filterField, qlField, key);
    if (!result) continue;

    for (const [prop, aggregate] of Object.entries(result.aggregateClauses)) {
      aggregateClauses.push(aggregate.lookup, aggregate.unwind);
      aggregationsIncluded[prop] = true;
    }
    for (const matchClause of Object.values(result.matchesClauses)) {
      for (const [matchKey, match] of Object.entries(matchClause)) {
        if (Object.hasOwn(flatMatchConditions, matchKey)) repeatedMatchConditions.push({ [matchKey]: match });
        else flatMatchConditions[matchKey] = match;
        hasFlat = true;
      }
    }
  }

  const topLevelAndParts = [];
  if (hasFlat) topLevelAndParts.push(flatMatchConditions);
  topLevelAndParts.push(...repeatedMatchConditions);

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

const buildSortClause = (sortTerms, gqltype, aggregateClauses, aggregationsIncluded) => {
  const sortExpressions = {};
  const fields = gqltype.getFields();

  sortTerms.forEach((sort) => {
    assertValidFilterPath(sort.field);
    let fixedSortField = sort.field;
    if (sort.field.indexOf('.') >= 0) {
      const sortParts = sort.field.split('.');
      fixedSortField = sortParts[0];
      for (let i = 1; i < sortParts.length - 1; i++) {
        fixedSortField += `_${sortParts[i]}`;
      }
      fixedSortField += `.${sortParts[sortParts.length - 1]}`;
      const qlField = fields[sortParts[0]];
      const path = sort.field.slice(sort.field.indexOf('.') + 1);
      const sortAggregations = buildAggregationsForSort({ terms: [{ path }] }, qlField, sortParts[0]);
      for (const [prop, aggregate] of Object.entries(sortAggregations)) {
        if (!aggregationsIncluded[prop]) {
          aggregateClauses.push(aggregate.lookup, aggregate.unwind);
        }
      }
    }
    sortExpressions[fixedSortField] = sort.order === 'ASC' ? 1 : -1;
  });

  return { $sort: sortExpressions };
};

const buildQuery = async (input, gqltype, isCount) => {
  const aggregateClauses = [];
  const aggregationsIncluded = {};

  const matchStage = await collectFiltersAndLookups(input, gqltype, aggregateClauses, aggregationsIncluded);
  if (matchStage) aggregateClauses.push(matchStage);

  if (isCount) {
    aggregateClauses.push({ $count: 'size' });
    return aggregateClauses;
  }

  if (input.sort) {
    aggregateClauses.push(buildSortClause(input.sort.terms, gqltype, aggregateClauses, aggregationsIncluded));
  }

  let skipClause = { $skip: 0 };
  let limitClause = { $limit: 100 };
  if (input.pagination?.page && input.pagination?.size) {
    skipClause = { $skip: input.pagination.size * (input.pagination.page - 1) };
    limitClause = { $limit: input.pagination.size };
  }
  aggregateClauses.push(skipClause, limitClause);

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

  const sortTerms = input.sort?.terms?.length > 0 ? input.sort.terms : null;
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

  if (input.pagination?.page && input.pagination?.size) {
    const skip = input.pagination.size * (input.pagination.page - 1);
    aggregateClauses.push({ $skip: skip }, { $limit: input.pagination.size });
  }

  return aggregateClauses;
};

  return { buildQuery, buildFilterGroupMatch, buildAggregationQuery };
};
