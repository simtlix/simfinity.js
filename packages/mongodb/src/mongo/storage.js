import { SimfinityError } from '@simtlix/simfinity-core';
import { readMongoPipeline } from './cursor.js';
import { READ_OPTION_NAMES } from './read-options.js';
import { validateMongoSession } from './storage-options.js';
import {
  assertStorageFilter,
  assertStoragePipeline,
  invalidStorage,
  assertFilteredUpdate,
  assertReplacement,
  assertDeletion,
  assertBulkWrite,
  assertInsertMany,
} from './storage-validation.js';

export { validateMongoSession, validateStorageOptions } from './storage-options.js';

const BASE_REQUEST_FIELDS = ['backend', 'operation', 'options'];
const UPDATE_FIELDS = ['filter', 'update'];
const PIPELINE_FIELDS = ['filter', 'pipeline'];

// Payload, validation and execution are declared together for each capability.
const STORAGE_OPERATIONS = {
  find: { fields: ['filter'] },
  aggregate: { fields: PIPELINE_FIELDS },
  stream: { fields: PIPELINE_FIELDS },
  updateOne: {
    fields: UPDATE_FIELDS,
    validate: assertFilteredUpdate,
    execute: (collection, request, options) =>
      collection.updateOne(request.filter, request.update, options),
  },
  updateMany: {
    fields: UPDATE_FIELDS,
    validate: assertFilteredUpdate,
    execute: (collection, request, options) =>
      collection.updateMany(request.filter, request.update, options),
  },
  replaceOne: {
    fields: ['filter', 'replacement'],
    validate: assertReplacement,
    execute: (collection, request, options) =>
      collection.replaceOne(request.filter, request.replacement, options),
  },
  findOneAndUpdate: {
    fields: UPDATE_FIELDS,
    validate: assertFilteredUpdate,
    execute: (collection, request, options) =>
      collection.findOneAndUpdate(request.filter, request.update, options),
  },
  findOneAndDelete: {
    fields: ['filter'],
    validate: assertDeletion,
    execute: (collection, request, options) => collection.findOneAndDelete(request.filter, options),
  },
  deleteMany: {
    fields: ['filter'],
    validate: assertDeletion,
    execute: (collection, request, options) => collection.deleteMany(request.filter, options),
  },
  insertMany: {
    fields: ['documents'],
    validate: assertInsertMany,
    execute: (collection, request, options) => collection.insertMany(request.documents, options),
  },
  bulkWrite: {
    fields: ['operations'],
    validate: assertBulkWrite,
    execute: (collection, request, options) => collection.bulkWrite(request.operations, options),
  },
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

const validateRequest = (request, definition) => {
  const { operation } = request;
  if (!definition) {
    throw invalidStorage('Unsupported MongoDB storage operation');
  }
  const fields = new Set([...BASE_REQUEST_FIELDS, ...definition.fields]);
  for (const key of Object.keys(request)) {
    if (!fields.has(key)) {
      throw invalidStorage('Unsupported request field: ' + key);
    }
  }
  const allowed = definition.execute ? WRITE_OPTIONS : READ_OPTIONS;
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

// Server-only backend primitives use registered models and pre-encoded BSON.
// They preserve middleware/scopes, but do not run generated entity controllers.
export const createStorageExecutor =
  (queries, integrity) =>
  async (Model, gqltype, request, { session, queryArgs, observer }) => {
    const { operation } = request;
    const definition = Object.hasOwn(STORAGE_OPERATIONS, operation) && STORAGE_OPERATIONS[operation];
    const write = Boolean(definition?.execute);
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
    validateRequest(request, definition);

    const options = { ...request.options, session };
    if (!write) {
      return readStorage(queries, Model, gqltype, request, queryArgs, options, observer);
    }

    definition.validate(Model, request);
    return definition.execute(Model.collection, request, options);
  };
