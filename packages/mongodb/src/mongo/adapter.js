import mongoose from 'mongoose';
import { SimfinityError } from '@simtlix/simfinity-core';
import { MAX_RECORD_VERSION, isProtectedType, isVersionField, readStoredVersion, retainStoredVersion } from '@simtlix/simfinity-core/internal/record-version';
import { getListShape, normalizeConnectionField } from '@simtlix/simfinity-core/internal/relation-storage';
import { createTransactionCallbacks } from '@simtlix/simfinity-core/internal/transaction-callbacks';

import { createMongoModel } from './models.js';
import { MONGO_QUERY_OPERATORS, createMongoQueries } from './queries.js';
import { withMongoTransaction } from './transactions.js';
import { createMongoIntegrity, readVersionMiss, versionFilter, versionTypeName, versionedUpdate } from './integrity.js';
import {
  castModelId, castObjectId, castPathValue, invalidId, isQueryKeyCastFailure, mapIdCastError,
} from './ids.js';

const withSession = (query, session) => (session ? query.session(session) : query);

const WRITE_FEATURES = Object.freeze({ optimisticConcurrency: true });
// Every filter operator the query compiler supports, and emptiness through references and collections (#108 part
// 2b); the runtime rejects any other operator.
const QUERY_FEATURES = Object.freeze({ operators: MONGO_QUERY_OPERATORS, referenceEmptiness: true, quantifiers: true, valuePath: true });

const assertVersionModel = ({ gqltype, model }) => {
  if (!model || !isProtectedType(gqltype)) return;
  const path = model.schema?.path('version');
  if (path?.instance !== 'Number' || path.options.immutable || path.options.select === false
    || path.getters.length || path.setters.length
    || (path.defaultValue !== undefined && path.defaultValue !== 1) || model.schema.options.versionKey === 'version') {
    throw new SimfinityError(
      `${gqltype.name} declares optimistic concurrency, so its Mongoose model must declare version: Number without immutable, select: false, getters, setters or a default other than 1`,
      'INVALID_MODEL', 400,
    );
  }
};

// Mongoose 8 casts Number paths before query middleware/transforms. Capture invalid raw versions
// at its private completion seam, then carry them to final same-record results after exec. Stored
// identity, never final array position, associates toObject/toJSON copies and reordered batches.
// Replacements must retain _id or an equivalent id; fabricated same-ID records cannot be distinguished
// from conversions. No document/schema mutation or extra read is needed, including for frozen results.
// Recheck these query-local completion seams when upgrading the Mongoose peer.
const preserveStoredVersion = (query, many) => {
  const method = many ? '_completeMany' : '_completeOne';
  const complete = query?.[method];
  const exec = query?.exec;
  if (typeof complete !== 'function' || typeof exec !== 'function') {
    throw new SimfinityError('Protected MongoDB reads require a Mongoose query with hydration completion support', 'DATABASE_ERROR', 500);
  }
  const captured = new Map();
  const originals = new Map();
  const keyOf = (record) => {
    const key = record?._id ?? record?.id;
    return key == null ? null : String(key);
  };
  const capture = (document) => {
    const value = document?.version;
    try { readStoredVersion(value); return null; }
    catch {
      const key = keyOf(document);
      if (key !== null) captured.set(key, value);
      return { key, value };
    }
  };
  const associate = (record) => {
    if (record === null || typeof record !== 'object') return;
    const key = keyOf(record);
    if (captured.has(key)) retainStoredVersion(record, captured.get(key));
    else if (key === null && originals.has(record)) retainStoredVersion(record, originals.get(record));
    // Middleware can reuse a result object across queries. Its prior raw value is no longer
    // evidence about this result when the current query has no matching invalid storage value.
    else retainStoredVersion(record, undefined);
  };
  if (many) {
    query[method] = async function completeVersions(documents, ...args) {
      const invalid = documents.map(capture);
      const results = await complete.call(this, documents, ...args);
      // Mongoose 8 _completeMany uses Promise.all over the raw documents in order. This
      // establishes provenance only for its original hydrated objects, before transforms;
      // final replacements still require an identifying key and never match by array position.
      results.forEach((record, index) => {
        const stored = invalid[index];
        if (stored && record != null && keyOf(record) === stored.key) originals.set(record, stored.value);
      });
      return results;
    };
  } else {
    query[method] = function completeVersion(document, metadata, projection, callback) {
      const invalid = capture(document);
      return complete.call(this, document, metadata, projection, (error, result) => {
        const record = this.options?.includeResultMetadata ? result?.value : result;
        // This completion callback establishes the original record's provenance even if a
        // projection omits its identity. A later replacement still needs an identifying key.
        if (!error && invalid && record != null && keyOf(record) === invalid.key) {
          originals.set(record, invalid.value);
        }
        callback(error, result);
      });
    };
  }
  query.exec = async function execPreservingVersions(...args) {
    try {
      const result = await exec.apply(this, args);
      if (many && Array.isArray(result)) result.forEach(associate);
      else associate(this.options?.includeResultMetadata ? result?.value : result);
      return result;
    } finally {
      captured.clear();
      originals.clear();
    }
  };
  return query;
};

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

// MongoDB fails a command whose regular expression it cannot compile with Location51091. The query
// compiler escapes every value and bounds every pattern by the 32,764 bytes the server accepts, but
// ignoring case the server compiles each letter that has other case forms (k, K and the Kelvin sign)
// to a class, so only a case-insensitive pattern can still be too large; then the client's filter
// value is the cause. IIN (#108 part 4) sends its patterns as BSON regular expressions, the other
// text operators as $regex with $options.
const REGEX_INVALID = 51091;
const ignoresCase = (options) => typeof options === 'string' && options.includes('i');
const hasCaseInsensitiveRegex = (node) => {
  if (Array.isArray(node)) return node.some(hasCaseInsensitiveRegex);
  if (node === null || typeof node !== 'object') return false;
  if (node._bsontype !== undefined) return node._bsontype === 'BSONRegExp' && ignoresCase(node.options);
  if (typeof node.$regex === 'string' && ignoresCase(node.$options)) return true;
  return Object.values(node).some(hasCaseInsensitiveRegex);
};
// The driver error stays available to logging, as on TRANSACTION_RETRY_EXCEEDED.
const mapRegexError = (error, pipeline) => {
  if (error?.code !== REGEX_INVALID || !hasCaseInsensitiveRegex(pipeline)) return error;
  const tooLarge = new SimfinityError(
    'Case-insensitive text filter value is too long: MongoDB cannot compile its regular expression when ignoring case, because letters such as k and s match more than one character',
    'INVALID_FILTER_VALUE', 400,
  );
  tooLarge.cause = error;
  tooLarge.getCause = () => tooLarge.cause;
  return tooLarge;
};
// Runs an aggregate of a pipeline that the query compiler built from filters.
const mapRegexErrors = async (pipeline, aggregate) => {
  try {
    return await aggregate;
  } catch (error) {
    throw mapRegexError(error, pipeline);
  }
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

// getById reads through `findOne` and getByIds through `find`.
const batchesFindOne = (Model) => hasNoQueryHooks(Model, ['find', 'findOne']);

// Batched collection reads (findChildrenBatch), opt in with `batchedCollections`. Each parent's own
// findChildren pipeline runs as one sub-pipeline of an aggregate command, the first as the command's
// pipeline and the others in $unionWith stages, at most `collectionBatchSize` parents per command;
// the commands of one call run concurrently. A command runs its sub-pipelines one after another.
const DEFAULT_COLLECTION_BATCH_SIZE = 5;
const MAX_COLLECTION_BATCH_SIZE = 100;
// Sub-pipeline bytes per command, well below MongoDB's 16 MiB command limit.
const COLLECTION_COMMAND_BYTES = 8 * 1024 * 1024;
const invalidAdapterOption = (message) => new SimfinityError(message, 'INVALID_MONGO_ADAPTER_OPTIONS', 400);
const readCollectionBatching = (options) => {
  const { batchedCollections = false, collectionBatchSize = DEFAULT_COLLECTION_BATCH_SIZE } = options ?? {};
  if (typeof batchedCollections !== 'boolean') throw invalidAdapterOption('batchedCollections must be true or false');
  if (!Number.isSafeInteger(collectionBatchSize) || collectionBatchSize < 1 || collectionBatchSize > MAX_COLLECTION_BATCH_SIZE) {
    throw invalidAdapterOption(`collectionBatchSize must be an integer from 1 to ${MAX_COLLECTION_BATCH_SIZE}`);
  }
  return { enabled: batchedCollections, parentsPerCommand: collectionBatchSize };
};

// Mongoose applies aggregate middleware, a model's own aggregate static (schema.static, loadClass, or
// a model from another Mongoose copy), a discriminator's key and a wrapper of the model's
// collection.aggregate to the command's pipeline only, never to $unionWith sub-pipelines, so such
// models read their children one parent at a time.
const batchesAggregate = (Model) => Model?.aggregate === mongoose.Model.aggregate
  && hasNoHooks(Model.hooks, ['aggregate']) && hasNoHooks(Model.schema?.s?.hooks, ['aggregate'])
  && !(Model.schema?.discriminatorMapping && !Model.schema.discriminatorMapping.isRoot)
  && Model.collection != null && !Object.hasOwn(Model.collection, 'aggregate');
// MongoDB rejects $unionWith in a multi-document transaction, and the rejection aborts the
// transaction. Inside connection.transaction() with Mongoose's transactionAsyncLocalStorage, an
// aggregate without a session joins the transaction.
const inTransactionStore = (Model) => Model?.db?.base?.transactionAsyncLocalStorage?.getStore()?.session != null;

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
  const callbacks = createTransactionCallbacks();
  const integrity = createMongoIntegrity(options, callbacks);
  const collectionBatching = readCollectionBatching(options);
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
  // The connection and everything its otherDbs reach: its useDb() parent, children and their siblings, at
  // any depth. A child's otherDbs also lists its parent, so the walk visits each connection once, cycles
  // included: a Set iteration also visits the entries added while it runs.
  const connectionFamily = (start) => {
    const seen = new Set([start]);
    for (const connection of seen) {
      for (const other of connection.otherDbs) seen.add(other);
    }
    return seen;
  };
  const defaultClientHasModels = () => {
    for (const connection of connectionFamily(mongoose.connection)) {
      if (hasModels(connection)) return true;
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

  // Whether two connections share one MongoDB client, hence one session. Two resolved clients decide by
  // identity. While either has no client yet (before connect(), or a useDb() child created earlier), the
  // connections of one useDb() family share the client the family will have, so connections whose
  // families meet count as one. A family is found through otherDbs, never Mongoose's private _parent;
  // a useDb(name, { noListener: true }) child lists its parent, which does not list it, so the families
  // meet at the parent.
  const sharesClient = (first, second) => {
    const firstClient = first.getClient?.();
    const secondClient = second.getClient?.();
    if (firstClient && secondClient) return firstClient === secondClient;
    const family = connectionFamily(first);
    for (const connection of connectionFamily(second)) if (family.has(connection)) return true;
    return false;
  };

  // A supplied session or model is used as is; only an owned session without a model looks up
  // the registrations.
  const withOwnedTransaction = (session, body, Model, transactionOptions) => withMongoTransaction(
    session, body, (Model || session) ? Model : sessionModel(), transactionOptions, callbacks,
  );

  const versionedRead = (Model, query, many = false) => getRegistrations().some(
    (registration) => registration.model === Model && isVersionField(registration.gqltype.getFields().version),
  ) ? preserveStoredVersion(query, many) : query;

  const addPrivateConnectionField = (typeName, fieldName) => {
    if (!privateConnectionFields.has(typeName)) privateConnectionFields.set(typeName, new Set());
    privateConnectionFields.get(typeName).add(fieldName);
  };

  const adapter = {
    queryFeatures: QUERY_FEATURES,
    writeFeatures: WRITE_FEATURES,
    bind(binding) {
      integrity.bind(binding);
      getRegistrations = binding.getRegistrations;
      queries = createMongoQueries(binding);
      adapter.buildQuery = queries.buildQuery;
      adapter.buildFilterGroupMatch = queries.buildFilterGroupMatch;
    },
    prepare(registrations, preparationOptions) {
      for (const registration of registrations) assertVersionModel(registration);
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
    // The affinity check of the generated transaction field (#151), before its session opens. Every
    // model must share the first one's client, in both referentialIntegrity modes, which run every write
    // in a transaction. It never writes, and a connection that is still connecting is no error: its
    // session waits for it. The error names the first model's type and the first type that cannot share
    // its session, as the types of the registrations (a model that several types share, or has none, by
    // its modelName), never the connections' addresses.
    assertTransactionModels(models) {
      const [first, ...others] = models.filter((model) => model?.db);
      const conflict = others.find((model) => !sharesClient(first.db, model.db));
      if (!conflict) return;
      const registrations = getRegistrations();
      const names = [first, conflict].map((model) => versionTypeName(model, registrations)).sort();
      throw new SimfinityError(`Types ${names.join(', ')} cannot share one database transaction`, 'TRANSACTION_UNSUPPORTED', 500);
    },
    // Relation inputs and batch keys: only an ObjectId or its hex form, never a newly minted one.
    castId: castObjectId,
    initialize: integrity.initialize,
    withTransaction: integrity.enabled ? integrity.withTransaction : withOwnedTransaction,
    enqueueAfterCommit: callbacks.enqueue,
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
      return mapQueryIdCastErrors(versionedRead(Model, query));
    },
    getByIds(Model, ids) {
      integrity.assertReady();
      // When `find` middleware could return other records, fail before reading, so the runtime
      // reads each ID once with getById.
      if (!batchesFindOne(Model)) throw new Error(`${Model.modelName} query middleware requires reads by ID`);
      // Trusted, so that the `sanitizeFilter` option does not wrap the operator in `$eq`.
      return versionedRead(Model, Model.find({ _id: mongoose.trusted({ $in: ids }) }), true);
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
    update(Model, id, update, session, writeOptions) {
      if (integrity.enabled) return integrity.updateRecord(Model, id, update, session, writeOptions);
      const expected = writeOptions?.expectedVersion;
      if (expected !== undefined) {
        return mapIdCastErrors(async () => {
          const query = mapQueryIdCastErrors(withSession(Model.findOneAndUpdate(
            { _id: id, ...versionFilter(Model, expected) }, versionedUpdate(update, expected), { new: true },
          ), session), mapIdCastError);
          if (expected >= MAX_RECORD_VERSION) {
            try {
              query.cast(Model);
            } catch (error) {
              // The skipped query has no exec/error flag; this cast only processes its filter.
              throw error?.name === 'CastError' && error.path === '_id' ? invalidId() : error;
            }
            return readVersionMiss(Model, query.getFilter()._id, session, expected, true, versionTypeName(Model, getRegistrations()));
          }
          const updated = await query;
          return updated ?? readVersionMiss(Model, query.getFilter()._id, session, expected, true, versionTypeName(Model, getRegistrations()));
        });
      }
      return mapQueryIdCastErrors(withSession(
        Model.findByIdAndUpdate(id, update, { new: true }), session,
      ), mapIdCastError);
    },
    delete(Model, id, session, writeOptions) {
      if (integrity.enabled) {
        integrity.assertWrite(Model, session);
        return integrity.deleteRecord(Model, id, session, writeOptions);
      }
      const expected = writeOptions?.expectedVersion;
      if (expected !== undefined) {
        const query = mapQueryIdCastErrors(withSession(Model.findOneAndDelete(
          { _id: id, ...versionFilter(Model, expected) },
        ), session));
        return query.then((deleted) => deleted ?? readVersionMiss(Model, query.getFilter()._id, session, expected, false,
          versionTypeName(Model, getRegistrations())));
      }
      return mapQueryIdCastErrors(withSession(Model.findByIdAndDelete(id), session));
    },
    async find(Model, gqltype, args, session, { requiredId } = {}) {
      integrity.assertReady();
      const pipeline = await queries.buildQuery(args, gqltype);
      // Mongoose does not cast aggregation stages, so cast the key type here, without setters.
      if (requiredId != null) pipeline.unshift({ $match: { _id: castModelId(Model, requiredId) } });
      if (pipeline.length === 0) return versionedRead(Model, withSession(Model.find({}), session), true);
      return mapRegexErrors(pipeline, withSession(Model.aggregate(pipeline), session));
    },
    async count(Model, gqltype, args, session) {
      integrity.assertReady();
      const pipeline = await queries.buildQuery(args, gqltype, true);
      const result = await mapRegexErrors(pipeline, withSession(Model.aggregate(pipeline), session));
      return result[0] ? result[0].size : 0;
    },
    async aggregate(Model, gqltype, args, session) {
      integrity.assertReady();
      const pipeline = await queries.buildAggregationQuery(args, gqltype, args.aggregation);
      return mapRegexErrors(pipeline, withSession(Model.aggregate(pipeline), session));
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
      return mapRegexErrors(pipeline, withSession(Model.aggregate(pipeline), session));
    },
  };

  // Without the option the adapter has neither batching member, so the runtime reads each
  // collection field with findChildren, as 3.6.0 did.
  if (collectionBatching.enabled) {
    const ownFindChildren = adapter.findChildren;
    // Why `self` (the adapter the runtime called) cannot batch the children of `Model`, or null. A
    // batch reproduces only this adapter's own findChildren, so a copy or an override of findChildren
    // reads one parent at a time with that findChildren.
    const declineReason = (self, Model, session) => {
      if (self?.findChildren !== ownFindChildren) return 'its findChildren is not the adapter\'s own';
      if (!batchesAggregate(Model)) {
        return 'its aggregate reads have middleware, an own aggregate static, a discriminator or a wrapped collection.aggregate';
      }
      if (session != null || inTransactionStore(Model)) return 'it reads in a session or a transaction';
      return null;
    };
    adapter.batchesChildren = function batchesChildren(Model) {
      return declineReason(this, Model, null) === null;
    };
    // One array per parent ID, in order, each equal to findChildren's result for that parent. It
    // declines by throwing before any command, and fails as a whole, never with partial results.
    adapter.findChildrenBatch = async function findChildrenBatch(Model, gqltype, connectionField, parentIds, args, batchOptions) {
      integrity.assertReady();
      const reason = declineReason(this, Model, batchOptions?.session);
      if (reason) throw new Error(`${Model?.modelName} reads children one parent at a time: ${reason}`);
      const pipeline = await queries.buildQuery(args, gqltype);
      const schemaType = Model.schema.path(connectionField);
      const lists = parentIds.map(() => []);
      const subPipelines = [];
      parentIds.forEach((parentId, index) => {
        let parentKey;
        try {
          parentKey = castPathValue(schemaType, parentId);
        } catch (error) {
          // As in findChildren: a parent key that the connection path cannot cast has no children.
          if (error?.extensions?.code === 'NOT_VALID_ID') return;
          throw error;
        }
        // Wrapping each row, instead of adding a field, cannot collide with a stored field.
        subPipelines.push([{ $match: { [connectionField]: parentKey } }, ...pipeline, { $replaceWith: { i: index, d: '$$ROOT' } }]);
      });
      if (subPipelines.length === 0) return lists;
      const parentsPerCommand = Math.max(1, Math.min(collectionBatching.parentsPerCommand,
        Math.floor(COLLECTION_COMMAND_BYTES / mongoose.mongo.BSON.calculateObjectSize({ pipeline: subPipelines[0] }))));
      const limit = pipeline.findLast((stage) => Object.hasOwn(stage, '$limit'))?.$limit;
      const coll = Model.collection.collectionName;
      const commands = [];
      for (let start = 0; start < subPipelines.length; start += parentsPerCommand) {
        const [first, ...others] = subPipelines.slice(start, start + parentsPerCommand);
        const command = Model.aggregate([
          ...first, ...others.map((subPipeline) => ({ $unionWith: { coll, pipeline: subPipeline } })),
        ]);
        // One more than the rows the command can return, so that its first batch closes the cursor.
        if (Number.isSafeInteger(limit)) command.option({ batchSize: limit * (others.length + 1) + 1 });
        commands.push(command);
      }
      // Every command settles before a failure is reported, so per-parent reads that follow it do not
      // overlap the remaining commands.
      const outcomes = await Promise.allSettled(commands);
      const failure = outcomes.find(({ status }) => status === 'rejected');
      if (failure) throw mapRegexError(failure.reason, pipeline);
      for (const { value: rows } of outcomes) {
        for (const { i, d } of rows) lists[i].push(d);
      }
      return lists;
    };
  }

  Object.defineProperty(adapter, 'referentialIntegrity', { value: integrity.mode, enumerable: true });
  return adapter;
};
