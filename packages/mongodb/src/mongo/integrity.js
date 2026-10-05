import mongoose from 'mongoose';
import { describeModels, SimfinityError } from '@simtlix/simfinity-core';
import { withMongoTransaction } from './transactions.js';
import { castModelId, mapIdCastError } from './ids.js';

const LOCK_FIELD = '_simfinityReferenceLock';
// Startup audit bounds: distinct target ids checked per query and ids remembered per target.
const AUDIT_BATCH_SIZE = 1000;
const AUDIT_VERIFIED_LIMIT = 100000;
const transactionOptions = { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } };
const violation = () => new SimfinityError('Reference constraint violated', 'REFERENCE_CONSTRAINT_VIOLATION', 409);
const invalid = (message) => new SimfinityError(message, 'INVALID_MONGO_INTEGRITY_CONFIGURATION', 400);

const referencePaths = (fields, prefix = []) => fields.flatMap((field) => {
  const path = [...prefix, ...field.storageName.split('.')];
  if (path.includes(LOCK_FIELD)) throw invalid(`${LOCK_FIELD} is reserved for reference integrity`);
  if (field.kind === 'reference') return [{ path, target: field.target }];
  if (field.kind === 'embedded') return referencePaths(field.fields, path);
  return [];
});

const valuesAt = (value, path) => {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap((item) => valuesAt(item, path));
  if (path.length === 0) return [value];
  return valuesAt(value[path[0]], path.slice(1));
};

export const createMongoIntegrity = (options = {}) => {
  if (!options || typeof options !== 'object' || Array.isArray(options)
    || Object.keys(options).some((key) => key !== 'referentialIntegrity')) {
    throw invalid('Expected Mongo adapter options with referentialIntegrity');
  }
  const mode = options.referentialIntegrity === undefined ? 'off' : options.referentialIntegrity;
  if (!['off', 'transactional'].includes(mode)) {
    throw invalid('referentialIntegrity must be off or transactional');
  }
  const enabled = mode === 'transactional';
  let binding;
  let registrations;
  let entities;
  let createCollection;
  let initialization;
  let ready = false;
  const models = new Map();
  const outgoing = new Map();
  const incoming = new Map();

  const assertRegistry = () => {
    const current = binding.getRegistrations();
    if (current.length !== registrations.length
      || current.some((entry, index) => entry.gqltype !== registrations[index].gqltype)) {
      throw invalid('Register all types before creating the protected schema');
    }
  };

  const assertReady = () => {
    if (!enabled) return;
    if (!ready) {
      throw new SimfinityError('Await Mongo adapter.initialize() before serving operations', 'MONGO_INTEGRITY_NOT_INITIALIZED', 503);
    }
    assertRegistry();
  };

  const assertSession = (session) => {
    if (!session?.inTransaction()) {
      throw new SimfinityError('Reference integrity requires an active transaction', 'ACTIVE_TRANSACTION_REQUIRED', 400);
    }
    if (session.transaction.options.readConcern?.level !== 'snapshot'
      || session.transaction.options.writeConcern?.w !== 'majority') {
      throw new SimfinityError('Reference integrity requires snapshot read concern and majority write concern', 'MONGO_INTEGRITY_TRANSACTION_OPTIONS', 400);
    }
  };

  const assertWrite = (Model, session) => {
    assertReady();
    if (![...models.values()].includes(Model)) throw invalid('Model is outside the protected registry');
    assertSession(session);
    if (session.client !== Model.db.getClient()) {
      throw invalid('The transaction and protected models must use the same MongoDB client');
    }
  };

  const modelReferences = (Model, record) => {
    const references = new Map();
    for (const { path, target } of outgoing.get(Model) || []) {
      for (const id of valuesAt(record, path)) {
        // Strings in native storage do not join an ObjectId key, even if castable.
        if (id?._bsontype !== 'ObjectId') throw violation();
        references.set(`${target}:${id.toHexString()}`, { target, id });
      }
    }
    return [...references.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, value]) => value);
  };

  const lock = async (Model, id, session) => {
    const result = await Model.collection.updateOne(
      { _id: id }, { $set: { [LOCK_FIELD]: new mongoose.Types.ObjectId() } }, { session },
    );
    return result.matchedCount > 0;
  };

  const abortOnWriteError = async (session, body) => {
    try {
      return await body();
    } catch (error) {
      if (session.inTransaction()) {
        // Mongoose post hooks can reject after persisting an unchecked write.
        // A caller must not catch that error and commit a borrowed transaction.
        try { await session.abortTransaction(); } catch { /* Preserve the write error and retry labels. */ }
      }
      // A malformed identifier is reported as NOT_VALID_ID; the transaction is still aborted.
      throw mapIdCastError(error);
    }
  };

  const validateRecord = async (Model, record, session) => abortOnWriteError(session, async () => {
    // Read the stored post-image, including setters/defaults and save middleware changes.
    if (!record?._id) throw violation();
    const stored = await Model.collection.findOne({ _id: record._id }, { session });
    if (!stored) throw violation();
    for (const { target, id } of modelReferences(Model, stored)) {
      if (!await lock(models.get(target), id, session)) throw violation();
    }
  });

  const initialize = async () => {
    if (!enabled) return;
    if (!entities) throw invalid('Create the GraphQL schema before initializing reference integrity');
    assertRegistry();
    const collections = new Set();
    let connection;
    for (const entity of entities) {
      const Model = binding.getModel(entity.gqltype);
      if (!Model?.collection || !Model?.db) throw invalid(`No MongoDB model for ${entity.name}`);
      if (Model.schema.path('_id')?.instance !== 'ObjectId') throw invalid(`Protected model ${entity.name} must use ObjectId primary keys`);
      if (connection && connection !== Model.db) throw invalid('All protected models must share one MongoDB connection');
      connection = Model.db;
      const collection = Model.collection.collectionName;
      if (collections.has(collection)) throw invalid(`Multiple protected models share collection ${collection}`);
      collections.add(collection);
      const reserved = Model.schema.path(LOCK_FIELD);
      if (reserved && !reserved.options.simfinityReferenceLock) throw invalid(`${LOCK_FIELD} is reserved for reference integrity`);
      if (!reserved) Model.schema.add({
        [LOCK_FIELD]: { type: mongoose.Schema.Types.ObjectId, select: false, simfinityReferenceLock: true },
      });
      for (const { path } of referencePaths(entity.fields)) {
        if (Model.schema.path(path.join('.'))?.instance !== 'ObjectId') {
          throw invalid(`Expected an ObjectId storage path for ${entity.name}.${path.join('.')}`);
        }
      }
      models.set(entity.name, Model);
      outgoing.set(Model, referencePaths(entity.fields));
    }
    if (!connection || connection.readyState !== 1) throw invalid('Connect MongoDB before initializing reference integrity');
    for (const [Model, paths] of outgoing) {
      for (const reference of paths) {
        const target = models.get(reference.target);
        if (!incoming.has(target)) incoming.set(target, []);
        incoming.get(target).push({ Model, path: reference.path.join('.') });
      }
    }
    for (const Model of models.values()) {
      if (createCollection) await Model.createCollection();
      else if (!(await connection.db.listCollections({ name: Model.collection.collectionName }).toArray()).length) {
        throw invalid(`Collection ${Model.collection.collectionName} must exist before initialization`);
      }
      // Model compilation may already have scheduled index builds. Finish them
      // before the audit starts, so its transaction does not race our own DDL.
      await Model.init();
    }
    const session = await connection.startSession();
    // Distinct target ids awaiting one batched existence query, and ids already
    // found in this snapshot, per target model.
    const pending = new Map();
    const verified = new Map();
    const verify = async (target) => {
      const ids = pending.get(target);
      pending.delete(target);
      const found = new Set((await models.get(target).collection.find(
        { _id: { $in: [...ids.values()] } }, { session, projection: { _id: 1 }, batchSize: ids.size + 1 },
      ).toArray()).map(({ _id }) => _id.toHexString()));
      for (const key of ids.keys()) if (!found.has(key)) throw violation();
      if ((verified.get(target)?.size || 0) + ids.size > AUDIT_VERIFIED_LIMIT) verified.delete(target);
      if (!verified.has(target)) verified.set(target, new Set());
      for (const key of ids.keys()) verified.get(target).add(key);
    };
    try {
      session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
      for (const Model of models.values()) {
        const projection = { _id: 1, [LOCK_FIELD]: 1 };
        for (const { path } of outgoing.get(Model)) projection[path.join('.')] = 1;
        const cursor = Model.collection.find({}, { session, projection });
        try {
          for await (const record of cursor) {
            if (record[LOCK_FIELD] != null && record[LOCK_FIELD]?._bsontype !== 'ObjectId') {
              throw invalid(`Existing ${LOCK_FIELD} data is incompatible with reference integrity`);
            }
            for (const { target, id } of modelReferences(Model, record)) {
              const key = id.toHexString();
              if (verified.get(target)?.has(key)) continue;
              if (!pending.has(target)) pending.set(target, new Map());
              if (pending.get(target).set(key, id).size >= AUDIT_BATCH_SIZE) await verify(target);
            }
          }
          for (const target of [...pending.keys()]) await verify(target);
        } finally { await cursor.close(); }
      }
      // Read-only startup audit. Mutation attempts use independently owned or supplied sessions.
      await session.abortTransaction();
    } catch (error) {
      if (session.inTransaction()) await session.abortTransaction().catch(() => {});
      if (error.code === 20) {
        throw new SimfinityError('Transactional reference integrity requires a MongoDB replica set or sharded cluster', 'MONGO_TRANSACTIONS_REQUIRED', 503);
      }
      throw error;
    } finally { await session.endSession(); }
    ready = true;
  };

  return {
    mode,
    enabled,
    bind(value) {
      if (!enabled) return;
      if (binding) throw invalid('A protected Mongo adapter can only bind to one runtime');
      binding = value;
    },
    prepare(values, options) {
      if (!enabled) return;
      if (entities) {
        assertRegistry();
        return;
      }
      registrations = values.map(({ gqltype }) => ({ gqltype }));
      entities = describeModels(values).entities;
      for (const entity of entities) referencePaths(entity.fields);
      createCollection = options?.createCollection !== false;
    },
    assertReady,
    assertWrite,
    initialize() {
      if (!initialization) initialization = initialize();
      return initialization;
    },
    withTransaction(session, body, Model) {
      assertReady();
      if (session) assertSession(session);
      return withMongoTransaction(session, body, Model || models.values().next().value, transactionOptions);
    },
    async saveRecord(Model, record, session) {
      assertWrite(Model, session);
      return abortOnWriteError(session, async () => {
        const saved = await record.save({ session });
        await validateRecord(Model, saved, session);
        return saved;
      });
    },
    // Protected writes cast the key before querying, without setters, as 3.5.3 did: the lock, the
    // reference checks and the identity checks must all use the key requested before middleware runs.
    async updateRecord(Model, id, update, session) {
      assertWrite(Model, session);
      return abortOnWriteError(session, async () => {
        const objectId = castModelId(Model, id);
        const updated = await Model.findByIdAndUpdate(objectId, update, { new: true }).session(session);
        if (!updated) {
          // A middleware can hide a completed write with a null result. Abort
          // even on a genuine no-match; core still reports its normal NOT_VALID_ID.
          await session.abortTransaction();
          return null;
        }
        if (!updated._id?.equals(objectId)) throw violation();
        await validateRecord(Model, updated, session);
        return updated;
      });
    },
    async deleteRecord(Model, id, session) {
      return abortOnWriteError(session, async () => {
        const objectId = castModelId(Model, id);
        if (!await lock(Model, objectId, session)) return null;
        for (const reference of incoming.get(Model) || []) {
          const query = reference.Model === Model
            ? { $and: [{ [reference.path]: objectId }, { _id: { $ne: objectId } }] }
            : { [reference.path]: objectId };
          if (await reference.Model.collection.findOne(query, { session, projection: { _id: 1 } })) throw violation();
        }
        const deleted = await Model.findByIdAndDelete(objectId).session(session);
        if (!deleted?._id?.equals(objectId)
          || await Model.collection.findOne({ _id: objectId }, { session, projection: { _id: 1 } })) throw violation();
        return deleted;
      });
    },
  };
};
