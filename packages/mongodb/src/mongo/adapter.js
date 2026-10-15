import mongoose from 'mongoose';
import { SimfinityError } from '@simtlix/simfinity-core';
import { getListShape, normalizeConnectionField } from '@simtlix/simfinity-core/internal/relation-storage';

import { createMongoModel } from './models.js';
import { createMongoQueries } from './queries.js';
import { withMongoTransaction } from './transactions.js';
import { readMongoPipeline } from './cursor.js';
import { SERVER_READ_OPTION_NAMES } from './read-options.js';
import { createStorageExecutor, validateMongoSession, validateStorageOptions } from './storage.js';
import { createMongoIntegrity } from './integrity.js';
import {
  buildRecordReadPipeline, createRecordRead, createRecordUpdate, createRecordDelete,
} from './record-queries.js';
import { prepareStorageUpdate } from './storage-update.js';
import {
  castModelId, castObjectId, castPathValue, invalidId, isQueryKeyCastFailure, mapIdCastError,
} from './ids.js';

const SERVER_READ_OPTIONS = new Set(SERVER_READ_OPTION_NAMES);

const validateServerReadOptions = (options) => {
  for (const key of Object.keys(options || {})) {
    if (!SERVER_READ_OPTIONS.has(key)) {
      throw new SimfinityError('Unsupported server read option: ' + key, 'INVALID_FILTER_VALUE', 400);
    }
  }
};

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
const hasNoHooks = (hooks, operations) => {
  if (!(hooks?._pres instanceof Map) || !(hooks._posts instanceof Map)) return false;
  return operations.every((operation) => !hooks._pres.get(operation)?.length
    && !hooks._posts.get(operation)?.length);
};

// Mongoose copies the schema's query hooks to the model when compiling it, so both registries must
// be free of hooks for the operations.
const hasNoQueryHooks = (Model, operations) => hasNoHooks(Model.schema?.s?.hooks, operations)
  && (Model.Query?.prototype?._queryMiddleware == null || hasNoHooks(Model.Query.prototype._queryMiddleware, operations));

const firstRecord = (rows) => rows[0] || null;

const readObservedRecord = (Model, id, session, options) => {
  if (!hasNoQueryHooks(Model, ['findOne'])) {
    throw new SimfinityError(
      'Observed by-ID reads require a model without findOne hooks', 'UNSUPPORTED_CAPABILITY', 400,
    );
  }
  const pipeline = buildRecordReadPipeline(Model, id, options);
  return readMongoPipeline(
    Model, pipeline, { ...options.readOptions, session }, options.observer,
  ).then(firstRecord);
};

// getById reads through `findOne` and getByIds through `find`.
const batchesFindOne = (Model) => hasNoQueryHooks(Model, ['find', 'findOne']);

// The statics that getById, update and delete call, directly or through each other.
const BY_ID_STATICS = ['findById', 'findOne', 'findByIdAndUpdate', 'findOneAndUpdate', 'findByIdAndDelete', 'findOneAndDelete'];
// Mongoose's automatic ObjectId setter only changes document assignments, never query filters.
const autoIdSetter = new mongoose.Schema.Types.ObjectId('_id').auto(true).setters.at(-1);

// update and delete write through findByIdAndUpdate and findByIdAndDelete, whose findOneAndUpdate and
// findOneAndDelete middleware runs before Mongoose casts the ID. Such middleware, or an application
// override of one of these statics (schema.static, loadClass), could guard the read or act on a
// malformed ID that the read by ID rejects first, so the runtime keeps that read. ID setters also
// run before casting and can branch on the query operation. A model from another Mongoose copy
// has other statics and keeps the read too.
const readsByIdAreInert = (Model) => BY_ID_STATICS.every((name) => Model[name] === mongoose.Model[name])
  && Model.schema?.path('_id')?.setters?.every((setter) => setter === autoIdSetter)
  && hasNoQueryHooks(Model, ['find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete']);

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
  // Each supplied database gets a private model namespace on its existing client.
  // Only the database owner opens/closes that client. Schema-only runtimes remain disconnected.
  const namespace = options && Object.hasOwn(options, 'database') ? new mongoose.Mongoose() : null;
  const connection = namespace ? namespace.createConnection() : mongoose.connection;
  const database = options?.database;
  const modelConnection = database
    ? connection.setClient(database.client).useDb(database.databaseName)
    : connection;
  let queries;
  let executeStorage;
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
      executeStorage = createStorageExecutor(queries, integrity);
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
      }, { ...modelOptions, connection: modelConnection, storage: options?.models?.[gqltype.name], ...(integrity.enabled ? { createCollection: false } : {}) });
    },
    // Keep the delegate present before bind so adapter decorators can copy it safely.
    async executeStorage(...args) {
      if (!executeStorage) {
        throw new SimfinityError(
          'MongoDB adapter must be bound to a runtime before storage operations', 'ADAPTER_NOT_BOUND', 500,
        );
      }
      return executeStorage(...args);
    },
    compileServerQuery(gqltype, query, operation) {
      if (!queries) {
        throw new SimfinityError('MongoDB adapter must be bound to a runtime before queries', 'ADAPTER_NOT_BOUND', 500);
      }
      return queries.compileServerQuery(gqltype, query, operation);
    },
    storageBackend: 'mongodb',
    supportsObservedReads: true,
    validateSession: validateMongoSession,
    validateStorageOptions(Model, gqltype, operation, storage) {
      return validateStorageOptions(Model, gqltype, operation, storage, integrity);
    },
    setRecordIdentity(Model, record, id) {
      record._id = castModelId(Model, id);
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
    getById(Model, id, session, { projection, plain, requiredId, storage, readOptions, observer } = {}) {
      integrity.assertReady();
      const observation = observer || options?.queryObserver?.();
      if (observation || readOptions) {
        return readObservedRecord(Model, id, session, {
          projection, requiredId, storage, readOptions, observer: observation,
        });
      }
      const query = createRecordRead(Model, id, { projection, requiredId, storage });
      let result = withSession(query, session);
      if (plain) result = result.lean();
      return mapQueryIdCastErrors(result);
    },
    getByIds(Model, ids) {
      integrity.assertReady();
      // When `find` middleware could return other records, fail before reading, so the runtime
      // reads each ID once with getById.
      if (!batchesFindOne(Model)) throw new Error(`${Model.modelName} query middleware requires reads by ID`);
      // Trusted, so that the `sanitizeFilter` option does not wrap the operator in `$eq`.
      return Model.find({ _id: mongoose.trusted({ $in: ids }) });
    },
    // Without middleware or overrides of the by-ID statics (see readsByIdAreInert), a read by ID has
    // no side effects, and a malformed ID fails the update or delete before application code runs,
    // as it fails the read.
    readByIdIsInert(Model) {
      return readsByIdAreInert(Model);
    },
    prepareUpdate(set, unset) {
      return Object.keys(unset).length > 0 ? { ...set, $unset: unset } : set;
    },
    prepareStorageUpdate,
    update(Model, id, update, session, storage) {
      if (integrity.enabled) return integrity.updateRecord(Model, id, update, session);
      const query = createRecordUpdate(Model, id, update, storage);
      return mapQueryIdCastErrors(withSession(query, session), mapIdCastError);
    },
    delete(Model, id, session, storage) {
      if (integrity.enabled) {
        integrity.assertWrite(Model, session);
        return integrity.deleteRecord(Model, id, session);
      }
      const query = createRecordDelete(Model, id, storage);
      return mapQueryIdCastErrors(withSession(query, session));
    },
    async find(Model, gqltype, args, session, { requiredId, readOptions, observer, serverPlan } = {}) {
      integrity.assertReady();
      const pipeline = await queries.buildQuery(args, gqltype, false, serverPlan);
      if (serverPlan) validateServerReadOptions(readOptions);
      // Mongoose does not cast aggregation stages, so cast the key type here, without setters.
      if (requiredId != null) pipeline.unshift({ $match: { _id: castModelId(Model, requiredId) } });
      const observation = observer || options?.queryObserver?.();
      if (observation || readOptions) return readMongoPipeline(Model, pipeline, { ...readOptions, session }, observation);
      if (pipeline.length === 0) return withSession(Model.find({}), session);
      return withSession(Model.aggregate(pipeline), session);
    },
    async count(Model, gqltype, args, session, { readOptions, observer, serverPlan } = {}) {
      integrity.assertReady();
      const pipeline = await queries.buildQuery(args, gqltype, true, serverPlan);
      if (serverPlan) validateServerReadOptions(readOptions);
      const observation = observer || options?.queryObserver?.();
      const result = observation || readOptions
        ? await readMongoPipeline(Model, pipeline, { ...readOptions, session }, observation)
        : await withSession(Model.aggregate(pipeline), session);
      return result[0] ? result[0].size : 0;
    },
    async page(Model, gqltype, args, session, read = {}) {
      const rows = await adapter.find(Model, gqltype, args, session, read);
      return { items: rows[0]?.items || [], totalCount: rows[0]?.count?.[0]?.total || 0 };
    },
    async stream(Model, gqltype, args, session, { readOptions, observer, serverPlan } = {}) {
      integrity.assertReady();
      validateServerReadOptions(readOptions);
      const pipeline = await queries.buildQuery(args, gqltype, false, serverPlan);
      return readMongoPipeline(Model, pipeline, { ...readOptions, session }, observer || options?.queryObserver?.(), true);
    },
    async aggregate(Model, gqltype, args, session, { readOptions, observer } = {}) {
      integrity.assertReady();
      const pipeline = await queries.buildAggregationQuery(args, gqltype, args.aggregation);
      const observation = observer || options?.queryObserver?.();
      if (observation || readOptions) return readMongoPipeline(Model, pipeline, { ...readOptions, session }, observation);
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
