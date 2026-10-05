import mongoose from 'mongoose';
import { getListShape, normalizeConnectionField } from '@simtlix/simfinity-core/internal/relation-storage';

import { createMongoModel } from './models.js';
import { createMongoQueries } from './queries.js';
import { withMongoTransaction } from './transactions.js';
import { createMongoIntegrity } from './integrity.js';
import {
  castModelId, castObjectId, castPathValue, invalidId, isQueryKeyCastFailure, mapIdCastError,
} from './ids.js';

const withSession = (query, session) => (session ? query.session(session) : query);

// A write that fails only on malformed ObjectId values reports NOT_VALID_ID, not a driver error.
const mapIdCastErrors = async (write) => {
  try {
    return await write();
  } catch (error) {
    throw mapIdCastError(error);
  }
};

// By-ID queries take the raw ID, so the model's setters and key cast run once, in Mongoose's own
// query lifecycle. Keep the chainable Query and map a failed key cast only when it runs; with
// `mapError`, also map other failures, such as malformed ObjectId values in an update.
const mapQueryIdCastErrors = (query, mapError = (error) => error) => {
  const { exec } = query;
  if (typeof exec !== 'function') return query;
  query.exec = async function execMappingIdCasts(...args) {
    try {
      return await exec.apply(this, args);
    } catch (error) {
      throw isQueryKeyCastFailure(this, error) ? invalidId() : mapError(error);
    }
  };
  return query;
};

// Even a shared hook can branch on `this.op` or the filter shape. Preserve findOne semantics
// whenever either query operation has hooks instead of inferring equivalence from function identity.
const hasNoFindHooks = (hooks) => {
  if (!(hooks?._pres instanceof Map) || !(hooks._posts instanceof Map)) return false;
  return ['find', 'findOne'].every((operation) => !hooks._pres.get(operation)?.length
    && !hooks._posts.get(operation)?.length);
};

// getById reads through `findOne` and getByIds through `find`. Mongoose copies the schema's query
// hooks to the model when compiling it, so both registries must allow the batched read.
const batchesFindOne = (Model) => hasNoFindHooks(Model.schema?.s?.hooks)
  && (Model.Query?.prototype?._queryMiddleware == null || hasNoFindHooks(Model.Query.prototype._queryMiddleware));

export const createMongoAdapter = (options) => {
  const integrity = createMongoIntegrity(options);
  let queries;
  const privateConnectionFields = new Map();

  const addPrivateConnectionField = (typeName, fieldName) => {
    if (!privateConnectionFields.has(typeName)) privateConnectionFields.set(typeName, new Set());
    privateConnectionFields.get(typeName).add(fieldName);
  };

  const adapter = {
    bind(binding) {
      integrity.bind(binding);
      queries = createMongoQueries(binding);
      adapter.buildQuery = queries.buildQuery;
      adapter.buildFilterGroupMatch = queries.buildFilterGroupMatch;
    },
    prepare(registrations, preparationOptions) {
      integrity.prepare(registrations, preparationOptions);
      for (const registration of registrations) {
        for (const field of Object.values(registration.gqltype.getFields())) {
          const relation = field.extensions?.relation;
          const listShape = getListShape(field.type);
          if (!relation?.connectionField || relation.embedded || !listShape) continue;
          // Same rule as core: only a direct or aliased singular reference on the child stores the
          // link. Otherwise, including a child collection that reuses the name (chained or
          // self-referencing collections), the child gets a private ObjectId field.
          const connection = normalizeConnectionField(listShape.itemType, relation.connectionField);
          if (!connection.graphqlFieldName) {
            addPrivateConnectionField(listShape.itemType.name, connection.storageFieldName);
          }
        }
      }
    },
    createModel(gqltype, onModelCreated, modelOptions) {
      return createMongoModel(gqltype, (model) => {
        for (const fieldName of privateConnectionFields.get(gqltype.name) || []) {
          model.schema.add({ [fieldName]: mongoose.Schema.Types.ObjectId });
          model.schema.index({ [fieldName]: 1 });
        }
        if (onModelCreated) onModelCreated(model);
      }, integrity.enabled ? { ...modelOptions, createCollection: false } : modelOptions);
    },
    // Relation inputs and batch keys: only an ObjectId or its hex form, never a newly minted one.
    castId: castObjectId,
    initialize: integrity.initialize,
    withTransaction: integrity.enabled ? integrity.withTransaction : withMongoTransaction,
    newRecord(Model, data, session) {
      const record = new Model(data);
      record.$session(session);
      return record;
    },
    saveRecord(Model, record, session) {
      if (integrity.enabled) return integrity.saveRecord(Model, record, session === undefined ? record.$session() : session);
      return mapIdCastErrors(() => record.save());
    },
    toObject(record) {
      return typeof record?.toObject === 'function' ? record.toObject() : record;
    },
    // A hydrated document renders a singular embedded path as an object even when the stored value
    // is an explicit null. Only that stored null reads as null; an absent value keeps Mongoose's
    // materialized object, as legacy documents rely on.
    readEmbeddedValue(value) {
      // The nested accessor's toJSON is called without a receiver on purpose. It reads the schema's
      // toJSON virtuals option from `this` (guarded by `this &&`), and with that option set a stored
      // null renders as `{}`. Without a receiver it reads the raw path value of its own document.
      return value?.$__isNested === true && typeof value.toJSON === 'function' && value.toJSON.call(null) === null
        ? null : value;
    },
    getById(Model, id, session, { projection, plain, requiredId } = {}) {
      integrity.assertReady();
      let query = withSession(requiredId == null ? Model.findById(id, projection)
        : Model.findOne({ $and: [{ _id: requiredId }, { _id: id }] }, projection), session);
      if (plain) query = query.lean();
      return mapQueryIdCastErrors(query);
    },
    getByIds(Model, ids) {
      integrity.assertReady();
      // When `find` middleware could return other records, fail before reading, so the runtime
      // reads each ID once with getById.
      if (!batchesFindOne(Model)) throw new Error(`${Model.modelName} query middleware requires reads by ID`);
      // Trusted, so that the `sanitizeFilter` option does not wrap the operator in `$eq`.
      return Model.find({ _id: mongoose.trusted({ $in: ids }) });
    },
    prepareUpdate(set, unset) {
      return Object.keys(unset).length > 0 ? { ...set, $unset: unset } : set;
    },
    update(Model, id, update, session) {
      if (integrity.enabled) return integrity.updateRecord(Model, id, update, session);
      return mapQueryIdCastErrors(withSession(
        Model.findByIdAndUpdate(id, update, { new: true }), session,
      ), mapIdCastError);
    },
    delete(Model, id, session) {
      if (integrity.enabled) {
        integrity.assertWrite(Model, session);
        return integrity.deleteRecord(Model, id, session);
      }
      return mapQueryIdCastErrors(withSession(Model.findByIdAndDelete(id), session));
    },
    async find(Model, gqltype, args, session, { requiredId } = {}) {
      integrity.assertReady();
      const pipeline = await queries.buildQuery(args, gqltype);
      // Mongoose does not cast aggregation stages, so cast the key type here, without setters.
      if (requiredId != null) pipeline.unshift({ $match: { _id: castModelId(Model, requiredId) } });
      if (pipeline.length === 0) return withSession(Model.find({}), session);
      return withSession(Model.aggregate(pipeline), session);
    },
    async count(Model, gqltype, args, session) {
      integrity.assertReady();
      const pipeline = await queries.buildQuery(args, gqltype, true);
      const result = await withSession(Model.aggregate(pipeline), session);
      return result[0] ? result[0].size : 0;
    },
    async aggregate(Model, gqltype, args, session) {
      integrity.assertReady();
      const pipeline = await queries.buildAggregationQuery(args, gqltype, args.aggregation);
      return withSession(Model.aggregate(pipeline), session);
    },
    async findChildren(Model, gqltype, connectionField, parentId, args, session) {
      integrity.assertReady();
      const pipeline = await queries.buildQuery(args, gqltype);
      let parentKey;
      try {
        parentKey = castPathValue(Model.schema.path(connectionField), parentId);
      } catch (error) {
        // A stored parent key that the connection path cannot cast has no children.
        if (error?.extensions?.code === 'NOT_VALID_ID') return [];
        throw error;
      }
      pipeline.unshift({ $match: { [connectionField]: parentKey } });
      return withSession(Model.aggregate(pipeline), session);
    },
  };

  Object.defineProperty(adapter, 'referentialIntegrity', { value: integrity.mode, enumerable: true });
  return adapter;
};
