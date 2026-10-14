import { GraphQLInt, GraphQLFloat, getNullableType } from 'graphql';
import { SimfinityError } from '@simtlix/simfinity-core';
import { readMongoPipeline } from './cursor.js';

const invalid = (message) => new SimfinityError(message, 'INVALID_STORAGE_OPERATION', 400);
const writes = new Set(['updateOne', 'updateMany', 'replaceOne', 'findOneAndUpdate', 'findOneAndDelete', 'deleteMany', 'insertMany', 'bulkWrite']);
const reads = new Set(['find', 'aggregate', 'stream']);
const updateOperators = new Set(['$set', '$unset', '$inc', '$max', '$min', '$setOnInsert', '$push', '$pull', '$addToSet', '$pop', '$currentDate', '$mul']);
const optionNames = new Set(['projection', 'sort', 'limit', 'skip', 'collation', 'hint', 'maxTimeMS', 'batchSize', 'allowDiskUse', 'readConcern', 'upsert', 'returnDocument', 'includeResultMetadata', 'ordered', 'arrayFilters', 'timeoutMS', 'timeoutMode', 'signal']);

// Backend capabilities are intentionally server-only. No model/collection/callback is accepted.
// BSON is already encoded by the server; unlike generated writes these primitives do not run
// entity controllers or GraphQL validators. Runtime middleware remains the authorization boundary.
export const validateMongoSession = (Model, session) => {
  if (session.client !== Model.db.getClient()) throw new SimfinityError('Session belongs to another MongoDB client', 'INVALID_SESSION', 400);
  if (!session.inTransaction()) throw new SimfinityError('A supplied session must have an active transaction', 'ACTIVE_TRANSACTION_REQUIRED', 400);
};

const assertObject = (value, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${name} must be an object`);
};
const assertPath = (Model, path) => {
  if (typeof path !== 'string' || !path || path.split('.').some((part) => ['__proto__', 'prototype', 'constructor'].includes(part))) throw invalid('Invalid storage field');
  if (Model.schema.path(path)) return;
  const parts = path.split('.');
  while (parts.length > 1) {
    parts.pop();
    const parent = Model.schema.path(parts.join('.'));
    if (parent?.instance === 'Mixed' || parent?.instance === 'Map' || parent?.instance === 'Array') return;
  }
  throw invalid(`Unregistered storage field: ${path}`);
};
const assertDocument = (Model, document) => {
  assertObject(document, 'document');
  for (const path of Object.keys(document)) assertPath(Model, path);
};
const assertFilter = (Model, filter) => {
  assertObject(filter, 'filter');
  for (const [key, value] of Object.entries(filter)) {
    if (['$and', '$or', '$nor'].includes(key)) {
      if (!Array.isArray(value) || !value.length) throw invalid('Filter groups must be nonempty arrays');
      value.forEach((part) => assertFilter(Model, part));
    } else if (key === '$expr') {
      assertExpression(Model, value);
    } else {
      assertPath(Model, key);
    }
  }
};
const assertExpression = (Model, value) => {
  if (typeof value === 'string' && value.startsWith('$') && !value.startsWith('$$')) assertPath(Model, value.slice(1));
  else if (Array.isArray(value)) value.forEach((part) => assertExpression(Model, part));
  else if (value && typeof value === 'object') {
    for (const [key, part] of Object.entries(value)) {
      if (key === '$function' || key === '$accumulator') throw invalid('Server JavaScript is not supported');
      if (key !== '$literal') assertExpression(Model, part);
    }
  }
};
const assertUpdate = (Model, update) => {
  if (Array.isArray(update)) {
    if (!update.length) throw invalid('Empty update pipeline');
    for (const stage of update) {
      const keys = Object.keys(stage);
      if (keys.length !== 1 || !['$set', '$addFields', '$unset'].includes(keys[0])) throw invalid('Unsupported update pipeline stage');
      if (keys[0] === '$unset') {
        for (const path of [stage.$unset].flat()) assertPath(Model, path);
      } else {
        assertDocument(Model, stage[keys[0]]);
        assertExpression(Model, stage[keys[0]]);
      }
    }
    return;
  }
  assertObject(update, 'update');
  if (!Object.keys(update).length) throw invalid('Empty update');
  for (const [operator, fields] of Object.entries(update)) {
    if (!updateOperators.has(operator)) throw invalid(`Unsupported update operator: ${operator}`);
    assertDocument(Model, fields);
  }
};
const validateWrite = (Model, request) => {
  if (request.operation === 'insertMany') {
    if (!Array.isArray(request.documents) || !request.documents.length) throw invalid('documents must be a nonempty array');
    request.documents.forEach((document) => assertDocument(Model, document));
  } else if (request.operation === 'bulkWrite') {
    if (!Array.isArray(request.operations) || !request.operations.length) throw invalid('operations must be a nonempty array');
    for (const operation of request.operations) {
      const keys = Object.keys(operation);
      if (keys.length !== 1 || !['insertOne', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany'].includes(keys[0])) throw invalid('Unsupported bulk operation');
      const name = keys[0];
      if (name === 'insertOne') assertDocument(Model, operation[name].document);
      else validateWrite(Model, { ...operation[name], operation: name });
    }
  } else {
    assertFilter(Model, request.filter);
    if (request.operation === 'replaceOne') assertDocument(Model, request.replacement);
    else if (['updateOne', 'updateMany', 'findOneAndUpdate'].includes(request.operation)) assertUpdate(Model, request.update);
  }
};

export const validateStorageOptions = (Model, gqltype, operation, storage, integrity) => {
  if (integrity.enabled) throw new SimfinityError('Storage options cannot bypass transactional reference integrity', 'UNSUPPORTED_CAPABILITY', 400);
  for (const name of Object.keys(storage)) if (!['filter', 'increments', 'nulls', 'id'].includes(name)) throw invalid(`Unknown storage option: ${name}`);
  if (storage.nulls !== undefined && storage.nulls !== 'preserve') throw invalid('Only preserve null semantics are supported');
  if (!['save', 'update', 'delete'].includes(operation)) throw invalid('Storage options require a mutation');
  if (storage.id !== undefined && operation !== 'save') throw invalid('A storage identity is only supported on save');
  if (storage.filter) {
    if (operation === 'save') throw invalid('Save does not accept a conditional filter');
    assertFilter(Model, storage.filter);
  }
  const guards = [];
  if (storage.increments) {
    if (operation !== 'update') throw invalid('Increments require update');
    if (gqltype.extensions?.validations) throw invalid('Types with validators require a generated absolute update');
    assertDocument(Model, storage.increments);
    for (const [path, value] of Object.entries(storage.increments)) {
      const field = gqltype.getFields()[path];
      if (!field || field.extensions?.readOnly || !['Number', 'Decimal128'].includes(Model.schema.path(path)?.instance)
        || typeof value !== 'number' || !Number.isFinite(value)) throw invalid('Increments require registered writable numeric fields and finite amounts');
      if (field.extensions?.validations) throw invalid('Fields with validators require a generated absolute update');
      const scalar = getNullableType(field.type);
      if (scalar !== GraphQLInt && scalar !== GraphQLFloat) throw invalid('Increments require built-in Int or Float fields');
      try { scalar.parseValue(value); } catch { throw invalid('Increment does not match its declared numeric scalar'); }
      const min = scalar === GraphQLInt ? -2147483648 : -Number.MAX_VALUE;
      const max = scalar === GraphQLInt ? 2147483647 : Number.MAX_VALUE;
      // Check the old and resulting range in the atomic predicate, not after writing: a caller
      // may catch an error and commit its adopted transaction. Missing fields start at zero.
      const range = { $type: 'number', $gte: Math.max(min, min - value), $lte: Math.min(max, max - value) };
      // Query $mod truncates stored doubles; expression $mod retains their fractional part.
      const numeric = scalar === GraphQLInt ? { $and: [{ [path]: range }, { $expr: { $cond: [
        { $isNumber: '$' + path }, { $eq: [{ $mod: ['$' + path, 1] }, 0] }, false,
      ] } }] } : { [path]: range };
      guards.push({ $or: [{ [path]: { $exists: false } }, numeric] });
    }
  }
  return guards.length ? { ...storage, filter: { $and: [...(storage.filter ? [storage.filter] : []), ...guards] } } : storage;
};

export const createStorageExecutor = (queries, integrity) => async (Model, gqltype, request, { session, queryArgs, observer }) => {
  if (integrity.enabled && writes.has(request.operation)) throw new SimfinityError('Native primitives cannot bypass transactional reference integrity', 'UNSUPPORTED_CAPABILITY', 400);
  integrity.assertReady();
  if (session) validateMongoSession(Model, session);
  const { operation } = request;
  const fields = new Set(['backend', 'operation', 'options',
    ...(reads.has(operation) ? ['filter', ...(operation === 'find' ? [] : ['pipeline'])]
      : operation === 'insertMany' ? ['documents'] : operation === 'bulkWrite' ? ['operations']
        : ['filter', ...(operation === 'replaceOne' ? ['replacement'] : ['updateOne', 'updateMany', 'findOneAndUpdate'].includes(operation) ? ['update'] : [])])]);
  for (const key of Object.keys(request)) if (!fields.has(key)) throw invalid('Unsupported request field: ' + key);
  if (!reads.has(operation) && !writes.has(operation)) throw invalid('Unsupported MongoDB storage operation');
  const options = { ...request.options, session };
  const readOnlyOptions = ['skip', 'limit', 'batchSize', 'allowDiskUse', 'readConcern', 'timeoutMode'];
  const writeOnlyOptions = ['upsert', 'returnDocument', 'includeResultMetadata', 'ordered', 'arrayFilters'];
  for (const key of Object.keys(request.options || {})) {
    if (!optionNames.has(key) || (reads.has(operation) ? writeOnlyOptions : readOnlyOptions).includes(key)) throw invalid('Unsupported MongoDB option: ' + key);
    if (['returnDocument', 'includeResultMetadata'].includes(key) && !['findOneAndUpdate', 'findOneAndDelete'].includes(operation)) throw invalid('Return options require a find-and-modify operation');
    if (key === 'ordered' && !['bulkWrite', 'insertMany'].includes(operation)) throw invalid('ordered requires a batch operation');
    if (key === 'upsert' && !['updateOne', 'updateMany', 'replaceOne', 'findOneAndUpdate'].includes(operation)) throw invalid('upsert requires an update operation');
  }
  if (reads.has(operation)) {
    const pipeline = await queries.buildFilterQuery(queryArgs, gqltype);
    if (request.filter) {
      assertFilter(Model, request.filter);
      pipeline.push({ $match: request.filter });
    }
    if (operation !== 'find') {
      if (!Array.isArray(request.pipeline)) throw invalid('pipeline must be an array');
      const inspect = (value) => {
        if (!value || typeof value !== 'object') return;
        for (const [key, part] of Object.entries(value)) {
          if (['$out', '$merge', '$unionWith', '$documents', '$changeStream', '$function', '$accumulator'].includes(key)) throw invalid(`Unsupported projection stage: ${key}`);
          inspect(part);
        }
      };
      inspect(request.pipeline);
      pipeline.push(...request.pipeline);
    }
    return readMongoPipeline(Model, pipeline, options, observer, operation === 'stream');
  }
  validateWrite(Model, request);
  // Each primitive is one native operation. No user effects/callbacks are enclosed or replayed.
  switch (operation) {
    case 'updateOne': return Model.collection.updateOne(request.filter, request.update, options);
    case 'updateMany': return Model.collection.updateMany(request.filter, request.update, options);
    case 'replaceOne': return Model.collection.replaceOne(request.filter, request.replacement, options);
    case 'findOneAndUpdate': return Model.collection.findOneAndUpdate(request.filter, request.update, options);
    case 'findOneAndDelete': return Model.collection.findOneAndDelete(request.filter, options);
    case 'deleteMany': return Model.collection.deleteMany(request.filter, options);
    case 'insertMany': return Model.collection.insertMany(request.documents, options);
    case 'bulkWrite': return Model.collection.bulkWrite(request.operations, options);
    default: throw invalid('Unsupported MongoDB storage operation');
  }
};
