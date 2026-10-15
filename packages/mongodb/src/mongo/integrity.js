import mongoose from 'mongoose';
import { describeModels, SimfinityError } from '@simtlix/simfinity-core';
import { withMongoTransaction } from './transactions.js';
import { castModelId, mapIdCastError } from './ids.js';

const ADAPTER_OPTIONS = new Set(['referentialIntegrity', 'database', 'models', 'queryObserver']);
const LOCK_FIELD = '_simfinityReferenceLock';
// Distinct target ids per startup-audit query and per lock write, and ids the audit remembers per target.
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
    || Object.keys(options).some((key) => !ADAPTER_OPTIONS.has(key))) {
    throw invalid('Expected Mongo adapter options with referentialIntegrity, database, models or queryObserver');
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
  // Per target model: each referencing model once, with its paths to the target in declaration order.
  const incoming = new Map();
  // Per model: _id and its reference paths, the fields modelReferences reads.
  const projections = new Map();

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

  // Lock the distinct targets of one record with one write per target collection (up to
  // AUDIT_BATCH_SIZE ids each). A batch of several ids is read first in the transaction snapshot,
  // so a missing target is a violation before the batch's write, whatever its position, and never
  // a retried conflict with a concurrently locked target of the same batch. A single id keeps its
  // single updateOne.
  const lockTargets = async (references, session) => {
    const byTarget = new Map();
    for (const { target, id } of references) {
      if (!byTarget.has(target)) byTarget.set(target, []);
      byTarget.get(target).push(id);
    }
    for (const [target, ids] of byTarget) {
      const Target = models.get(target);
      for (let start = 0; start < ids.length; start += AUDIT_BATCH_SIZE) {
        const batch = ids.slice(start, start + AUDIT_BATCH_SIZE);
        if (batch.length === 1) {
          if (!await lock(Target, batch[0], session)) throw violation();
          continue;
        }
        const found = await Target.collection.find(
          { _id: { $in: batch } }, { session, projection: { _id: 1 }, batchSize: batch.length + 1 },
        ).toArray();
        if (found.length !== batch.length) throw violation();
        const result = await Target.collection.updateMany(
          { _id: { $in: batch } }, { $set: { [LOCK_FIELD]: new mongoose.Types.ObjectId() } }, { session },
        );
        if (result.matchedCount !== batch.length) throw violation();
      }
    }
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
    // Read the stored post-image, including setters/defaults and save middleware changes:
    // only _id and the reference paths.
    if (!record?._id) throw violation();
    const stored = await Model.collection.findOne({ _id: record._id }, { session, projection: projections.get(Model) });
    if (!stored) throw violation();
    await lockTargets(modelReferences(Model, stored), session);
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
      const projection = { _id: 1 };
      for (const reference of paths) {
        const path = reference.path.join('.');
        projection[path] = 1;
        const target = models.get(reference.target);
        if (!incoming.has(target)) incoming.set(target, new Map());
        if (!incoming.get(target).has(Model)) incoming.get(target).set(Model, []);
        if (!incoming.get(target).get(Model).includes(path)) incoming.get(target).get(Model).push(path);
      }
      projections.set(Model, projection);
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
        const cursor = Model.collection.find({}, { session, projection: { ...projections.get(Model), [LOCK_FIELD]: 1 } });
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
        // One query per referencing collection: the $or of its per-path queries, each branch served
        // by its own path index. A self-reference ignores the deleted document itself. The $ne stays
        // inside each branch: hoisted, the planner can pick a scan of the _id index instead.
        for (const [Source, paths] of incoming.get(Model) || []) {
          const matches = paths.map((path) => (Source === Model
            ? { $and: [{ [path]: objectId }, { _id: { $ne: objectId } }] }
            : { [path]: objectId }));
          const query = matches.length === 1 ? matches[0] : { $or: matches };
          if (await Source.collection.findOne(query, { session, projection: { _id: 1 } })) throw violation();
        }
        const deleted = await Model.findByIdAndDelete(objectId).session(session);
        if (!deleted?._id?.equals(objectId)
          || await Model.collection.findOne({ _id: objectId }, { session, projection: { _id: 1 } })) throw violation();
        return deleted;
      });
    },
  };
};
