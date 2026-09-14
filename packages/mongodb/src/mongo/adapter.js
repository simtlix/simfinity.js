import mongoose from 'mongoose';
import { getNamedType, isListType, isNonNullType } from 'graphql';

import { createMongoModel } from './models.js';
import { createMongoQueries } from './queries.js';
import { withMongoTransaction } from './transactions.js';

mongoose.set('strictQuery', false);

const withSession = (query, session) => (session ? query.session(session) : query);

export const createMongoAdapter = () => {
  let queries;
  const privateConnectionFields = new Map();

  const addPrivateConnectionField = (typeName, fieldName) => {
    if (!privateConnectionFields.has(typeName)) privateConnectionFields.set(typeName, new Set());
    privateConnectionFields.get(typeName).add(fieldName);
  };

  const adapter = {
    bind(binding) {
      queries = createMongoQueries(binding);
      adapter.buildQuery = queries.buildQuery;
      adapter.buildFilterGroupMatch = queries.buildFilterGroupMatch;
    },
    prepare(registrations) {
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
    createModel(gqltype, onModelCreated, options) {
      return createMongoModel(gqltype, (model) => {
        for (const fieldName of privateConnectionFields.get(gqltype.name) || []) {
          model.schema.add({ [fieldName]: mongoose.Schema.Types.ObjectId });
          model.schema.index({ [fieldName]: 1 });
        }
        if (onModelCreated) onModelCreated(model);
      }, options);
    },
    castId(value) {
      return new mongoose.Types.ObjectId(value);
    },
    withTransaction: withMongoTransaction,
    newRecord(Model, data, session) {
      const record = new Model(data);
      record.$session(session);
      return record;
    },
    saveRecord(Model, record) {
      return record.save();
    },
    toObject(record) {
      return typeof record?.toObject === 'function' ? record.toObject() : record;
    },
    getById(Model, id, session, { projection, plain, requiredId } = {}) {
      let query = withSession(requiredId == null ? Model.findById(id, projection)
        : Model.findOne({ $and: [{ _id: requiredId }, { _id: id }] }, projection), session);
      if (plain) query = query.lean();
      return query;
    },
    prepareUpdate(set, unset) {
      return Object.keys(unset).length > 0 ? { ...set, $unset: unset } : set;
    },
    update(Model, id, update, session) {
      return withSession(Model.findByIdAndUpdate(id, update, { new: true }), session);
    },
    delete(Model, id, session) {
      return withSession(Model.findByIdAndDelete(id), session);
    },
    async find(Model, gqltype, args, session, { requiredId } = {}) {
      const pipeline = await queries.buildQuery(args, gqltype);
      if (requiredId != null) pipeline.unshift({ $match: { _id: Model.schema.path('_id').cast(requiredId) } });
      if (pipeline.length === 0) return withSession(Model.find({}), session);
      return withSession(Model.aggregate(pipeline), session);
    },
    async count(Model, gqltype, args, session) {
      const pipeline = await queries.buildQuery(args, gqltype, true);
      const result = await withSession(Model.aggregate(pipeline), session);
      return result[0] ? result[0].size : 0;
    },
    async aggregate(Model, gqltype, args, session) {
      const pipeline = await queries.buildAggregationQuery(args, gqltype, args.aggregation);
      return withSession(Model.aggregate(pipeline), session);
    },
    async findChildren(Model, gqltype, connectionField, parentId, args, session) {
      const pipeline = await queries.buildQuery(args, gqltype);
      const path = Model.schema.path(connectionField);
      pipeline.unshift({ $match: { [connectionField]: path ? path.cast(parentId) : parentId } });
      return withSession(Model.aggregate(pipeline), session);
    },
  };

  return adapter;
};
