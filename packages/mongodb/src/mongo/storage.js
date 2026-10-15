import { SimfinityError } from '@simtlix/simfinity-core';
import { readMongoPipeline } from './cursor.js';
import { READ_OPTION_NAMES } from './read-options.js';
import { validateMongoSession } from './storage-options.js';
import {
  assertStorageFilter,
  assertStoragePipeline,
  invalidStorage,
  storageWriteValidators,
} from './storage-validation.js';

export { validateMongoSession, validateStorageOptions } from './storage-options.js';

const READ_OPERATIONS = new Set(['find', 'aggregate', 'stream']);
const BASE_REQUEST_FIELDS = ['backend', 'operation', 'options'];
const REQUEST_FIELDS = {
  find: ['filter'],
  aggregate: ['filter', 'pipeline'],
  stream: ['filter', 'pipeline'],
  updateOne: ['filter', 'update'],
  updateMany: ['filter', 'update'],
  replaceOne: ['filter', 'replacement'],
  findOneAndUpdate: ['filter', 'update'],
  findOneAndDelete: ['filter'],
  deleteMany: ['filter'],
  insertMany: ['documents'],
  bulkWrite: ['operations'],
};
const COMMON_OPTIONS = [
  'projection',
  'sort',
  'collation',
  'hint',
  'maxTimeMS',
  'timeoutMS',
  'signal',
];
const READ_OPTIONS = new Set(READ_OPTION_NAMES);
const WRITE_OPTIONS = new Set([
  ...COMMON_OPTIONS,
  'upsert',
  'returnDocument',
  'includeResultMetadata',
  'ordered',
  'arrayFilters',
]);
const FIND_AND_MODIFY = new Set(['findOneAndUpdate', 'findOneAndDelete']);
const RETURN_OPTION_RULE = {
  operations: FIND_AND_MODIFY,
  message: 'Return options require a find-and-modify operation',
};
const OPTION_RULES = {
  returnDocument: RETURN_OPTION_RULE,
  includeResultMetadata: RETURN_OPTION_RULE,
  ordered: {
    operations: new Set(['bulkWrite', 'insertMany']),
    message: 'ordered requires a batch operation',
  },
  upsert: {
    operations: new Set(['updateOne', 'updateMany', 'replaceOne', 'findOneAndUpdate']),
    message: 'upsert requires an update operation',
  },
};

const validateRequest = (request) => {
  const { operation } = request;
  if (!Object.hasOwn(REQUEST_FIELDS, operation)) {
    throw invalidStorage('Unsupported MongoDB storage operation');
  }
  const fields = new Set([...BASE_REQUEST_FIELDS, ...REQUEST_FIELDS[operation]]);
  for (const key of Object.keys(request)) {
    if (!fields.has(key)) {
      throw invalidStorage('Unsupported request field: ' + key);
    }
  }
  const allowed = READ_OPERATIONS.has(operation) ? READ_OPTIONS : WRITE_OPTIONS;
  for (const key of Object.keys(request.options || {})) {
    if (!allowed.has(key)) {
      throw invalidStorage('Unsupported MongoDB option: ' + key);
    }
    const rule = Object.hasOwn(OPTION_RULES, key) ? OPTION_RULES[key] : null;
    if (rule && !rule.operations.has(operation)) {
      throw invalidStorage(rule.message);
    }
  }
};

const readStorage = async (queries, Model, gqltype, request, queryArgs, options, observer) => {
  const pipeline = await queries.buildFilterQuery(queryArgs, gqltype);
  if (request.filter) {
    assertStorageFilter(Model, request.filter);
    pipeline.push({ $match: request.filter });
  }
  if (request.operation !== 'find') {
    assertStoragePipeline(request.pipeline);
    pipeline.push(...request.pipeline);
  }
  return readMongoPipeline(Model, pipeline, options, observer, request.operation === 'stream');
};

// Each entry is one native call. No caller effects or callbacks are replayed.
const WRITE_EXECUTORS = {
  updateOne: (collection, request, options) =>
    collection.updateOne(request.filter, request.update, options),
  updateMany: (collection, request, options) =>
    collection.updateMany(request.filter, request.update, options),
  replaceOne: (collection, request, options) =>
    collection.replaceOne(request.filter, request.replacement, options),
  findOneAndUpdate: (collection, request, options) =>
    collection.findOneAndUpdate(request.filter, request.update, options),
  findOneAndDelete: (collection, request, options) =>
    collection.findOneAndDelete(request.filter, options),
  deleteMany: (collection, request, options) => collection.deleteMany(request.filter, options),
  insertMany: (collection, request, options) => collection.insertMany(request.documents, options),
  bulkWrite: (collection, request, options) => collection.bulkWrite(request.operations, options),
};

// Server-only backend primitives use registered models and pre-encoded BSON.
// They preserve middleware/scopes, but do not run generated entity controllers.
export const createStorageExecutor =
  (queries, integrity) =>
  async (Model, gqltype, request, { session, queryArgs, observer }) => {
    const { operation } = request;
    const write = Object.hasOwn(WRITE_EXECUTORS, operation);
    if (integrity.enabled && write) {
      throw new SimfinityError(
        'Native primitives cannot bypass transactional reference integrity',
        'UNSUPPORTED_CAPABILITY',
        400,
      );
    }
    integrity.assertReady();
    if (session) {
      validateMongoSession(Model, session);
    }
    validateRequest(request);

    const options = { ...request.options, session };
    if (!write) {
      return readStorage(queries, Model, gqltype, request, queryArgs, options, observer);
    }

    storageWriteValidators[operation](Model, request);
    return WRITE_EXECUTORS[operation](Model.collection, request, options);
  };
