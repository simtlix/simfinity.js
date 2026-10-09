import mongoose from 'mongoose';
import { SimfinityError } from '@simtlix/simfinity-core';
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

// `useDb()` connections share their parent's MongoClient, and a session belongs to a client.
const clientOf = (connection) => connection.getClient?.() || connection;

// Whether a schema lets Mongoose render a member inside an embedded object from something other
// than its stored value: a getter on a path, a virtual, an alias or, on a subdocument, a method
// (GraphQL's default resolver calls one named like a member), at any depth (nested paths,
// subdocuments, document arrays, map values). Core cannot tell such an object's data without
// running them, so rawEmbeddedValue leaves it unconverted and core keeps it. Read from schema
// metadata only. The `id` virtual that Mongoose adds to a schema with an `_id` renders that `_id`,
// which core reads itself, so it does not count; one the application declares does: it has another
// getter, or the schema disables the automatic one.
const isAutomaticIdVirtual = (schema, name, virtual) => name === 'id' && virtual?.getters?.length === 1
  && schema.options?.id !== false && schema.paths._id !== undefined && schema.paths.id === undefined;
const schemaTypeComputes = (schemaType, seen) => {
  if (!(schemaType instanceof mongoose.SchemaType) || seen.has(schemaType)) return false;
  seen.add(schemaType);
  if (schemaType.getters?.length > 0) return true;
  // schemaComputes is defined below: schemas and their paths contain each other.
  if (schemaType.schema && schemaComputes(schemaType.schema, '', seen)) return true;
  // Map values, array items and document array elements.
  return [schemaType.$__schemaType, schemaType.$embeddedSchemaType, schemaType.caster]
    .some((inner) => schemaTypeComputes(inner, seen));
};
// `prefix` is a nested path of the schema; '' is the whole schema, as a subdocument's own.
const schemaComputes = (schema, prefix, seen) => {
  if (prefix === '') {
    if (seen.has(schema)) return false;
    seen.add(schema);
    // Nested paths get no schema methods; a subdocument's own schema can.
    if (Object.keys(schema.methods ?? {}).length > 0) return true;
  }
  const inside = (path) => prefix === '' || path.startsWith(`${prefix}.`);
  return Object.entries(schema.paths ?? {}).some(([path, schemaType]) => inside(path) && schemaTypeComputes(schemaType, seen))
    || Object.entries(schema.virtuals ?? {}).some(([name, virtual]) => inside(name)
      && !(prefix === '' && isAutomaticIdVirtual(schema, name, virtual)))
    // An alias stores its value under another path, and may be declared outside a nested path.
    || Object.entries(schema.aliases ?? {}).some(([alias, path]) => inside(alias) || inside(path));
};
// Schemas do not change once their models are compiled, so each answer is computed once.
const computesCache = new WeakMap();
const cachedComputes = (key, prefix, compute) => {
  let byPrefix = computesCache.get(key);
  if (!byPrefix) {
    byPrefix = new Map();
    computesCache.set(key, byPrefix);
  }
  if (!byPrefix.has(prefix)) byPrefix.set(prefix, compute());
  return byPrefix.get(prefix);
};
const declaresComputedMembers = (schema, prefix) => cachedComputes(schema, prefix, () => schemaComputes(schema, prefix, new Set()));
const declaresComputedValues = (schemaType) => cachedComputes(schemaType, '', () => schemaTypeComputes(schemaType, new Set()));
// A hydrated nested path is cached by its full path in its document's internal getters cache, which
// it shares; '' (the whole schema) if it is not found there.
const nestedPathOf = (nested) => {
  const cache = nested.$__?.getters;
  return (cache && Object.keys(cache).find((path) => cache[path] === nested)) ?? '';
};

export const createMongoAdapter = (options) => {
  const integrity = createMongoIntegrity(options);
  let queries;
  let getRegistrations = () => [];
  const privateConnectionFields = new Map();

  // A registered custom mutation passes no model, so its owned session stays on the default
  // mongoose.connection, as before. While that connection has never been opened (no client), a
  // session there can only wait and time out. Use the one MongoDB client of the registered models
  // instead, but only when nothing can need the default connection:
  // - any model compiled on it, generated or the application's, registered or not, means the
  //   application opens it, maybe after the request arrived, and the callback may write that
  //   model with the session, which must then come from the default connection's client. The
  //   same holds for a model compiled on any useDb() descendant of it, such as
  //   mongoose.connection.useDb('tenant').useDb('audit'), which shares its client. A connection's
  //   otherDbs lists its direct useDb() children, not theirs, so the walk follows otherDbs at any
  //   depth.
  //   useDb(name, { noListener: true }) leaves a connection out of its parent's otherDbs, so neither
  //   it nor its descendants are seen, and native collection writes
  //   (mongoose.connection.collection()) compile no model;
  // - registered models on several clients have no single client to choose.
  // Once the default connection has a client, nothing changes.
  const hasModels = (connection) => Object.keys(connection.models).length > 0;
  // A child's otherDbs also lists its parent, so the walk visits each connection once, cycles
  // included: a Set iteration also visits the entries added while it runs.
  const defaultClientHasModels = () => {
    const seen = new Set([mongoose.connection]);
    for (const connection of seen) {
      if (hasModels(connection)) return true;
      for (const other of connection.otherDbs) seen.add(other);
    }
    return false;
  };
  const sessionModel = () => {
    if (mongoose.connection.getClient() || defaultClientHasModels()) return undefined;
    let found;
    for (const { model } of getRegistrations()) {
      const connection = model?.db;
      if (!connection) continue;
      if (connection === mongoose.connection) return undefined;
      if (!found) found = model;
      else if (clientOf(found.db) !== clientOf(connection)) return undefined;
    }
    return found;
  };

  // A supplied session or model is used as is; only an owned session without a model looks up
  // the registrations.
  const withOwnedTransaction = (session, body, Model, ...rest) => withMongoTransaction(
    session, body, (Model || session) ? Model : sessionModel(), ...rest,
  );

  const addPrivateConnectionField = (typeName, fieldName) => {
    if (!privateConnectionFields.has(typeName)) privateConnectionFields.set(typeName, new Set());
    privateConnectionFields.get(typeName).add(fieldName);
  };

  const adapter = {
    bind(binding) {
      integrity.bind(binding);
      getRegistrations = binding.getRegistrations;
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
            // Mongoose drops a stored path named constructor, so the link would never be written.
            if (connection.storageFieldName === 'constructor') {
              throw new SimfinityError(
                `${listShape.itemType.name}.constructor cannot be stored on MongoDB: Mongoose drops a stored path named constructor`,
                'INVALID_MODEL', 400,
              );
            }
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
    withTransaction: integrity.enabled ? integrity.withTransaction : withOwnedTransaction,
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
    // materialized object; core then reads it as null when its stored members (rawEmbeddedValue)
    // hold no data and miss a required member (runtime.js readEmbeddedObject).
    readEmbeddedValue(value) {
      // The nested accessor's toJSON is called without a receiver on purpose. It reads the schema's
      // toJSON virtuals option from `this` (guarded by `this &&`), and with that option set a stored
      // null renders as `{}`. Without a receiver it reads the raw path value of its own document.
      return value?.$__isNested === true && typeof value.toJSON === 'function' && value.toJSON.call(null) === null
        ? null : value;
    },
    // The stored data of a hydrated embedded value, which core reads to tell whether it holds data
    // without running schema getters or virtuals: a nested path's raw value (its toJSON without a
    // receiver, as above), a subdocument's _doc or a Mongoose map's entries. The first two hold an
    // absent nested path as {}, as Mongoose renders it, and keep subdocuments and maps hydrated,
    // which core passes back here. A subdocument's automatic `id` virtual is not in _doc; core reads
    // `_id` for `id`. A value whose schema declares a getter, a virtual, an alias or a subdocument
    // method on a member at any depth inside it (declaresComputedMembers) is returned unchanged, so core counts it as data
    // and keeps it, as 3.5.8 rendered it; no getter runs. Generated models declare none. Any other
    // value is returned unchanged too.
    rawEmbeddedValue(value) {
      if (value?.$__isNested === true) {
        // A schema from another Mongoose copy cannot be inspected; keep the value as 3.5.8 did.
        if (typeof value.toJSON !== 'function' || !(value.$__schema instanceof mongoose.Schema)
          || declaresComputedMembers(value.$__schema, nestedPathOf(value))) return value;
        return value.toJSON.call(null);
      }
      // Iterating a map reads its stored values; its get() would run the value getters.
      if (value instanceof mongoose.Types.Map) {
        return declaresComputedValues(value.$__schemaType) ? value : Object.fromEntries(value);
      }
      if (!(value instanceof mongoose.Document) || !value._doc) return value;
      const schema = value.$__schema ?? value.schema;
      return !schema || declaresComputedMembers(schema, '') ? value : value._doc;
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
