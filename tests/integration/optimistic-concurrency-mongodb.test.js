// Atomic adapter writes, raw no-match diagnosis, and supplied-session rollback on real MongoDB.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { GraphQLID, GraphQLObjectType, GraphQLString, graphql } from 'graphql';
import mongoose from 'mongoose';
import { createRuntime } from '../../packages/core/src/index.js';
import { createMongoAdapter } from '../../packages/mongodb/src/mongo/adapter.js';

const uri = process.env.SIMFINITY_MONGODB_URI;
const prefix = `ocmongo_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
let sequence = 0;
const max = 9007199254740991;
const models = [];
const makeType = (protectedType = true) => new GraphQLObjectType({
  name: `${prefix}_${sequence++}`,
  extensions: protectedType ? { concurrency: { mode: 'optimistic' } } : {},
  fields: { id: { type: GraphQLID }, name: { type: GraphQLString } },
});
const modelFor = (type, schema, modelName = type.name) => {
  const Model = mongoose.model(modelName, schema, type.name);
  models.push(Model);
  return Model;
};
const errorCode = (code) => ({ extensions: { code } });
const startSession = async () => {
  const session = await mongoose.startSession();
  session.startTransaction({ readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } });
  return session;
};
const finishSession = async (session) => {
  if (session.inTransaction()) await session.abortTransaction();
  await session.endSession();
};

// A direct adapter caller may request the precondition independently of the GraphQL declaration.
const fixture = async (mode, { protectedType = false, configure, schemaOptions = {}, differentModelName = false } = {}) => {
  const type = makeType(protectedType);
  const mongoSchema = new mongoose.Schema({ name: String, version: Number, hidden: Boolean }, schemaOptions);
  configure?.(mongoSchema);
  const Model = modelFor(type, mongoSchema, differentModelName ? `${type.name}Storage` : type.name);
  const adapter = createMongoAdapter({ referentialIntegrity: mode });
  const runtime = createRuntime(adapter);
  runtime.connect(Model, type, 'item', 'items');
  const schema = runtime.createSchema();
  await Model.createCollection();
  await Model.init();
  await adapter.initialize();
  return { Model, adapter, runtime, schema, type };
};
const insert = async (Model, version = 1, extra = {}) => {
  const document = { _id: new mongoose.Types.ObjectId(), name: 'original', ...extra };
  if (version !== undefined) document.version = version;
  await Model.collection.insertOne(document);
  return document._id;
};
const write = (f, operation, id, session, expectedVersion) => operation === 'update'
  ? f.adapter.update(f.Model, id, { name: 'changed' }, session, { expectedVersion })
  : f.adapter.delete(f.Model, id, session, { expectedVersion });

// Validation stays synchronous and does not need a database.
describe('Mongo optimistic concurrency model validation', () => {
  test.each([
    ['missing', undefined], ['String', String], ['immutable', { type: Number, immutable: true }],
    ['select false', { type: Number, select: false }], ['getter', { type: Number, get: (v) => v }],
    ['setter', { type: Number, set: (v) => v }], ['default zero', { type: Number, default: 0 }],
    ['default function', { type: Number, default: () => 1 }],
  ])('rejects a %s version path in prepare', (label, version) => {
    const type = makeType();
    const Model = modelFor(type, new mongoose.Schema({ name: String, ...(version ? { version } : {}) }, { autoCreate: false, autoIndex: false }));
    expect(() => createMongoAdapter().prepare([{ gqltype: type, model: Model }])).toThrow(expect.objectContaining({ extensions: expect.objectContaining({ code: 'INVALID_MODEL' }) }));
  });
  test('rejects Mongoose versionKey version', () => {
    const type = makeType();
    const Model = modelFor(type, new mongoose.Schema({ name: String, version: Number }, { versionKey: 'version', autoCreate: false, autoIndex: false }));
    expect(() => createMongoAdapter().prepare([{ gqltype: type, model: Model }])).toThrow(expect.objectContaining({ extensions: expect.objectContaining({ code: 'INVALID_MODEL' }) }));
  });
  test('pin: accepts an alias and literal default 1', () => {
    const type = makeType();
    const Model = modelFor(type, new mongoose.Schema({ name: String, version: { type: Number, alias: 'revision', default: 1 } }, { autoCreate: false, autoIndex: false }));
    expect(() => createMongoAdapter().prepare([{ gqltype: type, model: Model }])).not.toThrow();
  });
  test('generates a plain Number version path and validates it on a later prepare', () => {
    const type = makeType();
    const adapter = createMongoAdapter();
    const runtime = createRuntime(adapter);
    runtime.preventCreatingCollection(true);
    runtime.connect(null, type, 'generated', 'generateds');
    runtime.createSchema();
    const Model = runtime.getModel(type);
    models.push(Model);
    expect(Model.schema.path('version')?.instance).toBe('Number');
    expect(Model.schema.indexes().some(([index]) => Object.hasOwn(index, 'version'))).toBe(false);
    Model.schema.path('version').options.select = false;
    expect(() => adapter.prepare(runtime.getRegistrations())).toThrow(expect.objectContaining({ extensions: expect.objectContaining({ code: 'INVALID_MODEL' }) }));
  });
  test.each([true, false])('compiled read protection ignores a changed declaration (protected: %s)', (protectedType) => {
    const type = makeType(protectedType);
    const adapter = createMongoAdapter();
    const runtime = createRuntime(adapter);
    runtime.preventCreatingCollection(true);
    runtime.connect(null, type, 'compiled', 'compileds');
    runtime.createSchema();
    const Model = runtime.getModel(type);
    models.push(Model);
    const id = new mongoose.Types.ObjectId();
    for (const declaration of [{ mode: 'changed' }, { mode: 'optimistic' }, undefined]) {
      type.extensions.concurrency = declaration;
      const single = adapter.getById(Model, id);
      const batch = adapter.getByIds(Model, [id]);
      expect(single).toBeInstanceOf(mongoose.Query);
      expect(batch).toBeInstanceOf(mongoose.Query);
      expect(Object.hasOwn(single, '_completeOne')).toBe(protectedType);
      expect(Object.hasOwn(batch, '_completeMany')).toBe(protectedType);
    }
    type.extensions.concurrency = { mode: 'changed' };
    expect(() => adapter.prepare(runtime.getRegistrations())).toThrow(expect.objectContaining({ extensions: expect.objectContaining({ code: 'INVALID_MODEL', status: 400 }) }));
  });
  test('rejects opt-in after a generated unprotected model was compiled', () => {
    const type = makeType(false);
    const runtime = createRuntime(createMongoAdapter());
    runtime.preventCreatingCollection(true);
    runtime.connect(null, type, 'later', 'laters');
    runtime.createSchema();
    models.push(runtime.getModel(type));
    type.extensions.concurrency = { mode: 'optimistic' };
    expect(() => runtime.createSchema()).toThrow(expect.objectContaining({ extensions: expect.objectContaining({ code: 'INVALID_MODEL' }) }));
    expect(runtime.getModel(type).schema.path('version')).toBeUndefined();
  });
});

describe.skipIf(!uri)('Mongo optimistic concurrency writes', () => {
  beforeAll(async () => {
    // The base Mongo contract drops the URI database; this suite owns a separate database.
    const dbName = `${new URL(uri).pathname.slice(1)}_oc_adapter`;
    await mongoose.connect(uri, { dbName });
  });
  afterAll(async () => {
    for (const Model of models) mongoose.deleteModel(Model.modelName);
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  });

  test.each([1, max])('pin: maps an invalid numeric query key to NOT_VALID_ID at expected version %s', async (expected) => {
    const f = await fixture('off', { configure(schema) { schema.path('_id', Number); } });
    await expect(write(f, 'update', 'invalid-number', null, expected)).rejects.toMatchObject(errorCode('NOT_VALID_ID'));
  });

  test.each(['unbound', 'ambiguous'])('conflict naming falls back to the model for an %s binding', async (bindingKind) => {
    const f = await fixture('off', { differentModelName: true });
    const adapter = createMongoAdapter();
    if (bindingKind === 'ambiguous') adapter.bind({
      getRegistrations: () => [{ model: f.Model, gqltype: f.type }, { model: f.Model, gqltype: makeType(false) }],
      getModel: () => f.Model,
    });
    const id = await insert(f.Model, 3);
    await expect(adapter.update(f.Model, id, { name: 'changed' }, null, { expectedVersion: 1 })).rejects.toMatchObject({
      ...errorCode('VERSION_CONFLICT'), message: `${f.Model.modelName} ${id} was modified by another operation`,
    });
  });

  describe.each(['off', 'transactional'])('%s integrity', (mode) => {
    test.each(['update', 'delete'])('%s conflict names the registered GraphQL type of a differently named model', async (operation) => {
      const f = await fixture(mode, { differentModelName: true });
      const id = await insert(f.Model, 3);
      const session = await startSession();
      try {
        await expect(write(f, operation, id, session, 1)).rejects.toMatchObject({
          ...errorCode('VERSION_CONFLICT'), message: `${f.type.name} ${id} was modified by another operation`,
        });
      } finally { await finishSession(session); }
    });

    test.each([1, null, 'missing', 4])('atomically advances stored version %s, preserving timestamps and sanitizeFilter', async (version) => {
      const f = await fixture(mode, { schemaOptions: { timestamps: true }, configure(schema) {
        schema.pre(/^find/, function () { this.setOptions({ sanitizeFilter: true }); });
      } });
      const id = await insert(f.Model, version === 'missing' ? undefined : version);
      if (version === 'missing') await f.Model.collection.updateOne({ _id: id }, { $unset: { version: '' } });
      const updateSpy = vi.spyOn(f.Model.collection, 'findOneAndUpdate');
      const expectedVersion = version === 4 ? 4 : 1;
      const session = await startSession();
      try {
        const result = await write(f, 'update', String(id), session, expectedVersion);
        expect(result).toMatchObject({ name: 'changed', version: expectedVersion + 1 });
        expect(result.updatedAt).toBeInstanceOf(Date);
        expect(updateSpy.mock.calls[0][0]).toMatchObject({ _id: id, version: expectedVersion === 1 ? { $in: [1, null] } : 4 });
        expect(updateSpy.mock.calls[0][1].$set).toMatchObject({ name: 'changed', version: expectedVersion + 1 });
        expect(updateSpy.mock.calls[0][1].$inc).toBeUndefined();
        await session.commitTransaction();
        expect(await f.Model.collection.findOne({ _id: id })).toMatchObject({ name: 'changed', version: expectedVersion + 1 });
      } finally { updateSpy.mockRestore(); await finishSession(session); }
    });

    test.each([1, null, 'missing', 4])('deletes stored version %s with the atomic version condition', async (version) => {
      const f = await fixture(mode, { configure(schema) {
        schema.pre(/^find/, function () { this.setOptions({ sanitizeFilter: true }); });
      } });
      const id = await insert(f.Model, version === 'missing' ? undefined : version);
      if (version === 'missing') await f.Model.collection.updateOne({ _id: id }, { $unset: { version: '' } });
      const spy = vi.spyOn(f.Model.collection, mode === 'transactional' ? 'updateOne' : 'findOneAndDelete');
      const session = await startSession();
      try {
        const expected = version === 4 ? 4 : 1;
        const deleted = await write(f, 'delete', String(id), session, expected);
        expect(deleted._id).toEqual(id);
        expect(deleted.version).toBe(version === 'missing' ? undefined : version);
        expect(spy.mock.calls[0][0]).toMatchObject({ _id: id, version: expected === 1 ? { $in: [1, null] } : 4 });
        await session.commitTransaction();
        expect(await f.Model.collection.findOne({ _id: id })).toBeNull();
      } finally { spy.mockRestore(); await finishSession(session); }
    });

    test.each([true, 'throw'])('applies a versioned update pipeline with strict %s', async (strict) => {
      const f = await fixture(mode, { schemaOptions: { strict } });
      const id = await insert(f.Model, 6);
      const pipeline = [
        { $set: { name: { $concat: ['$name', ' pipeline'] } } },
        { $set: { version: 99 } },
      ];
      const original = structuredClone(pipeline);
      const session = await startSession();
      try {
        const result = await f.adapter.update(f.Model, id, pipeline, session, { expectedVersion: 6 });
        expect(result).toMatchObject({ name: 'original pipeline', version: 7 });
        expect(pipeline).toEqual(original);
        await session.commitTransaction();
        expect(await f.Model.collection.findOne({ _id: id })).toMatchObject({ name: 'original pipeline', version: 7 });
      } finally { await finishSession(session); }
    });

    test('a middleware no-match keeps equal versions null and reports stale versions directly', async () => {
      const f = await fixture(mode, { configure(schema) {
        schema.pre('findOneAndUpdate', function () { this.where({ hidden: false }); });
      } });
      for (const version of [1, 3]) {
        const id = await insert(f.Model, version, { hidden: true });
        const session = await startSession();
        try {
          if (version === 1) expect(await write(f, 'update', id, session, 1)).toBeNull();
          else await expect(write(f, 'update', id, session, 1)).rejects.toMatchObject(errorCode('VERSION_CONFLICT'));
          expect(session.inTransaction()).toBe(mode === 'off');
          expect(await f.Model.collection.findOne({ _id: id })).toMatchObject({ name: 'original', version });
        } finally { await finishSession(session); }
      }
    });

    test.each(['update', 'delete'])('%s distinguishes stale, absent and corrupt records before aborting a supplied session', async (operation) => {
      const f = await fixture(mode);
      for (const [storedVersion, expectedVersion, code] of [[3, 1, 'VERSION_CONFLICT'], [max, max - 1, 'VERSION_CONFLICT'], ['bad', 1, 'DATABASE_ERROR'], ['absent', 1, null]]) {
        const id = storedVersion === 'absent' ? new mongoose.Types.ObjectId() : await insert(f.Model, storedVersion);
        const session = await startSession();
        const marker = new mongoose.Types.ObjectId();
        await f.Model.collection.insertOne({ _id: marker, name: 'earlier write', version: 1 }, { session });
        const reads = [];
        const original = f.Model.collection.findOne;
        const spy = vi.spyOn(f.Model.collection, 'findOne').mockImplementation(function (...args) {
          reads.push({ filter: args[0], session: args[1]?.session, active: session.inTransaction() });
          return original.apply(this, args);
        });
        try {
          if (code) await expect(write(f, operation, String(id), session, expectedVersion)).rejects.toMatchObject(errorCode(code));
          else expect(await write(f, operation, String(id), session, expectedVersion)).toBeNull();
          expect(reads).toContainEqual({ filter: { _id: id }, session, active: true });
          if (code) expect(session.inTransaction()).toBe(mode === 'off');
          if (mode === 'transactional' && code) expect(await f.Model.collection.findOne({ _id: marker })).toBeNull();
          expect(await f.Model.collection.findOne({ _id: id })).toEqual(storedVersion === 'absent' ? null : expect.objectContaining({ version: storedVersion, name: 'original' }));
        } finally { spy.mockRestore(); await finishSession(session); }
      }
    });

    test('skips exhausted updates, distinguishes stale and missing, and permits delete at maximum', async () => {
      const f = await fixture(mode);
      for (const [stored, code] of [[max, 'VERSION_EXHAUSTED'], [1, 'VERSION_CONFLICT'], ['absent', null]]) {
        const id = stored === 'absent' ? new mongoose.Types.ObjectId() : await insert(f.Model, stored);
        const spy = vi.spyOn(f.Model.collection, 'findOneAndUpdate');
        const session = await startSession();
        try {
          if (code) await expect(write(f, 'update', id, session, max)).rejects.toMatchObject(errorCode(code));
          else expect(await write(f, 'update', id, session, max)).toBeNull();
          expect(spy).not.toHaveBeenCalled();
        } finally { spy.mockRestore(); await finishSession(session); }
      }
      const id = await insert(f.Model, max);
      const session = await startSession();
      try {
        expect(await write(f, 'delete', id, session, max)).toMatchObject({ version: max });
        await session.commitTransaction();
        expect(await f.Model.collection.findOne({ _id: id })).toBeNull();
      } finally { await finishSession(session); }
    });

    test('soft-delete middleware gives NOT_VALID_ID for equal versions and VERSION_CONFLICT for stale ones', async () => {
      const f = await fixture(mode, { protectedType: true, configure(schema) {
        schema.pre(/^find/, function () { this.where({ hidden: false }); });
      } });
      for (const [version, code] of [[1, 'NOT_VALID_ID'], [3, 'VERSION_CONFLICT']]) {
        const id = await insert(f.Model, version, { hidden: true });
        const result = await graphql({ schema: f.schema, source: `mutation { updateitem(input: { id: "${id}", name: "changed", version: 1 }) { name version } }` });
        expect(result.errors?.[0]).toMatchObject(errorCode(code));
        expect(await f.Model.collection.findOne({ _id: id })).toMatchObject({ name: 'original', version });
      }
    });

    test.each([1, max])('raw no-match lookup uses the write query cast key after an ID setter, expected %s', async (expected) => {
      const actual = new mongoose.Types.ObjectId();
      const alias = new mongoose.Types.ObjectId();
      const f = await fixture(mode, { configure(schema) {
        schema.path('_id').set(function (value) {
          return this instanceof mongoose.Query && String(value) === String(alias) ? actual : value;
        });
      } });
      await f.Model.collection.insertOne({ _id: actual, name: 'original', version: 3 });
      const session = await startSession();
      try {
        await expect(write(f, 'update', alias, session, expected)).rejects.toMatchObject(errorCode('VERSION_CONFLICT'));
      } finally { await finishSession(session); }
    });

    test('middleware dropping the increment fails and rolls back the owned mutation', async () => {
      const f = await fixture(mode, { protectedType: true, configure(schema) {
        schema.pre('findOneAndUpdate', function () { this.setUpdate({ name: 'changed' }); });
      } });
      const id = await insert(f.Model);
      const result = await graphql({ schema: f.schema, source: `mutation { updateitem(input: { id: "${id}", name: "changed", version: 1 }) { name version } }` });
      expect(result.errors?.[0]).toMatchObject(errorCode('DATABASE_ERROR'));
      expect(await f.Model.collection.findOne({ _id: id })).toMatchObject({ name: 'original', version: 1 });
      if (mode === 'transactional') {
        const session = await startSession();
        try {
          await expect(write(f, 'update', id, session, 1)).rejects.toMatchObject(errorCode('DATABASE_ERROR'));
          expect(session.inTransaction()).toBe(false);
          expect(await f.Model.collection.findOne({ _id: id })).toMatchObject({ name: 'original', version: 1 });
        } finally { await finishSession(session); }
      }
    });

    test('protected writes use findOne statics, retaining the integrity delete static', async () => {
      const calls = [];
      const f = await fixture(mode, { configure(schema) {
        for (const name of ['findByIdAndUpdate', 'findOneAndUpdate', 'findByIdAndDelete', 'findOneAndDelete']) {
          schema.static(name, function (...args) { calls.push(name); return mongoose.Model[name].apply(this, args); });
        }
      } });
      const id = await insert(f.Model);
      const session = await startSession();
      try {
        expect(await write(f, 'update', id, session, 1)).toMatchObject({ version: 2 });
        expect(calls).toEqual(['findOneAndUpdate']);
        calls.length = 0;
        expect(await write(f, 'delete', id, session, 2)).toMatchObject({ version: 2 });
        expect(calls).toEqual(mode === 'transactional' ? ['findByIdAndDelete', 'findOneAndDelete'] : ['findOneAndDelete']);
      } finally { await finishSession(session); }
    });

    test('pin: unprotected writes retain versions, pipelines and findById statics', async () => {
      const f = await fixture(mode);
      const id = await insert(f.Model, 6);
      const updateSpy = vi.spyOn(f.Model, 'findByIdAndUpdate');
      const deleteSpy = vi.spyOn(f.Model, 'findByIdAndDelete');
      const session = await startSession();
      try {
        expect(await f.adapter.update(f.Model, id, { name: 'plain' }, session)).toMatchObject({ name: 'plain', version: 6 });
        expect(updateSpy).toHaveBeenCalledOnce();
        expect(await f.adapter.update(f.Model, id, [{ $set: { name: 'pipeline' } }], session)).toMatchObject({ name: 'pipeline', version: 6 });
        expect(await f.adapter.delete(f.Model, id, session)).toMatchObject({ version: 6 });
        expect(deleteSpy).toHaveBeenCalledOnce();
      } finally { updateSpy.mockRestore(); deleteSpy.mockRestore(); await finishSession(session); }
    });

    test('pin: find honors requiredId in the supplied transaction snapshot', async () => {
      const f = await fixture(mode);
      const session = await startSession();
      const id = new mongoose.Types.ObjectId();
      try {
        await f.Model.collection.insertOne({ _id: id, name: 'uncommitted', version: 1 }, { session });
        await insert(f.Model, 1);
        const rows = await f.adapter.find(f.Model, f.type, {}, session, { requiredId: String(id), context: {} });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ _id: id, name: 'uncommitted', version: 1 });
        expect(await f.Model.collection.findOne({ _id: id })).toBeNull();
      } finally { await finishSession(session); }
    });
  });
});
