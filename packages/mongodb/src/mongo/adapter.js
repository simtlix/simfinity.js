import mongoose from 'mongoose';
import { getNamedType, isListType, isNonNullType } from 'graphql';

import { createMongoModel } from './models.js';
import { createMongoQueries } from './queries.js';
import { withMongoTransaction } from './transactions.js';
import { createMongoIntegrity } from './integrity.js';

mongoose.set('strictQuery', false);

const withSession = (query, session) => (session ? query.session(session) : query);

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
          const listType = isNonNullType(field.type) ? field.type.ofType : field.type;
          if (!relation?.connectionField || relation.embedded || !isListType(listType)) continue;
          const childType = getNamedType(field.type);
          const childFields = childType.getFields();
          const connectionExists = childFields[relation.connectionField]
            || Object.entries(childFields).some(([fieldName, childField]) => {
              const childRelation = childField.extensions?.relation;
              return childRelation && !childRelation.embedded
                && (childRelation.connectionField || fieldName) === relation.connectionField;
            });
          if (!connectionExists) addPrivateConnectionField(
            childType.name,
            relation.connectionField,
          );
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
    castId(value) {
      return new mongoose.Types.ObjectId(value);
    },
    initialize: integrity.initialize,
    withTransaction: integrity.enabled ? integrity.withTransaction : withMongoTransaction,
    newRecord(Model, data, session) {
      const record = new Model(data);
      record.$session(session);
      return record;
    },
    saveRecord(Model, record, session) {
      if (integrity.enabled) return integrity.saveRecord(Model, record, session === undefined ? record.$session() : session);
      return record.save();
    },
    toObject(record) {
      return typeof record?.toObject === 'function' ? record.toObject() : record;
    },
    getById(Model, id, session, { projection, plain, requiredId } = {}) {
      integrity.assertReady();
      let query = withSession(requiredId == null ? Model.findById(id, projection)
        : Model.findOne({ $and: [{ _id: requiredId }, { _id: id }] }, projection), session);
      if (plain) query = query.lean();
      return query;
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
      return withSession(Model.findByIdAndUpdate(id, update, { new: true }), session);
    },
    delete(Model, id, session) {
      if (integrity.enabled) {
        integrity.assertWrite(Model, session);
        return integrity.deleteRecord(Model, id, session);
      }
      return withSession(Model.findByIdAndDelete(id), session);
    },
    async find(Model, gqltype, args, session, { requiredId } = {}) {
      integrity.assertReady();
      const pipeline = await queries.buildQuery(args, gqltype);
      if (requiredId != null) pipeline.unshift({ $match: { _id: Model.schema.path('_id').cast(requiredId) } });
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
      const path = Model.schema.path(connectionField);
      pipeline.unshift({ $match: { [connectionField]: path ? path.cast(parentId) : parentId } });
      return withSession(Model.aggregate(pipeline), session);
    },
  };

  Object.defineProperty(adapter, 'referentialIntegrity', { value: integrity.mode, enumerable: true });
  return adapter;
};
