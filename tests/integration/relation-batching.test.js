import { randomUUID } from 'node:crypto';
import {
  afterAll, afterEach, beforeAll, describe, expect, it, vi,
} from 'vitest';
import {
  GraphQLBoolean, GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';
import mongoose from 'mongoose';
import pg from 'pg';

import { configureQueryLimits, createRuntime } from '../../packages/core/src/index.js';
import { createMongoAdapter } from '../../packages/mongodb/src/mongo/adapter.js';
import { createSQLAdapter } from '../../packages/sql/src/adapter.js';
import { postgresPlugin } from '../../packages/postgres/src/index.js';

const mongoUri = process.env.SIMFINITY_MONGODB_URI;
const postgresUri = process.env.SIMFINITY_POSTGRES_URI;

const createFixture = () => {
  const Detail = new GraphQLObjectType({
    name: 'RelationBatchDetail',
    fields: { note: { type: GraphQLString } },
  });
  const Owner = new GraphQLObjectType({
    name: 'RelationBatchOwner',
    fields: () => ({ id: { type: GraphQLID }, name: { type: new GraphQLNonNull(GraphQLString) } }),
  });
  // A reference inside embedded items, which PostgreSQL stores in an owned table.
  const Part = new GraphQLObjectType({
    name: 'RelationBatchPart',
    fields: () => ({
      label: { type: new GraphQLNonNull(GraphQLString) },
      owner: { type: Owner, extensions: { relation: { connectionField: 'owner_id' } } },
    }),
  });
  const Target = new GraphQLObjectType({
    name: 'RelationBatchTarget',
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: new GraphQLNonNull(GraphQLString) },
      rank: { type: GraphQLInt },
      tags: { type: new GraphQLList(GraphQLString) },
      detail: { type: Detail, extensions: { relation: { embedded: true } } },
      parts: { type: new GraphQLList(new GraphQLNonNull(Part)), extensions: { relation: { embedded: true } } },
      owner: { type: Owner, extensions: { relation: { connectionField: 'owner_id' } } },
    }),
  });
  const Source = new GraphQLObjectType({
    name: 'RelationBatchSource',
    fields: () => ({
      id: { type: GraphQLID },
      label: { type: new GraphQLNonNull(GraphQLString) },
      target: { type: Target, extensions: { relation: { connectionField: 'target_id' } } },
      backup: { type: Target, extensions: { relation: { connectionField: 'backup_id' } } },
    }),
  });
  return {
    Detail, Owner, Part, Target, Source,
  };
};

const describeWithDatabases = mongoUri && postgresUri ? describe : describe.skip;

describeWithDatabases('relation batching on MongoDB and PostgreSQL', () => {
  const namespace = `relbatch_${randomUUID().replaceAll('-', '')}`;
  let pool;
  let backends;
  const execute = (backend, source, contextValue) => graphql({ schema: backend.schema, source, contextValue });
  const run = async (backend, source, contextValue) => {
    const result = await execute(backend, source, contextValue);
    expect(result.errors).toBeUndefined();
    return result.data;
  };
  const reads = (backend, typeName) => {
    const model = backend.api.getModel(backend.fixture[typeName]);
    return {
      getById: backend.getById.mock.calls.filter(([called]) => called === model),
      getByIds: backend.getByIds.mock.calls.filter(([called]) => called === model),
    };
  };
  const sourcesQuery = (args = '') => `{ relationbatchsources(label: { operator: NE, value: "Z" }, sort: { terms: [{ field: "label", order: ASC }] }${args}) {
    label
    target { id name rank tags detail { note } parts { label owner { name } } owner { id name } }
    backup { name owner { name } }
  } }`;

  beforeAll(async () => {
    await mongoose.connect(mongoUri, { dbName: namespace });
    pool = new pg.Pool({ connectionString: postgresUri });
    backends = [
      { name: 'mongo', adapter: createMongoAdapter() },
      { name: 'postgres', adapter: createSQLAdapter(postgresPlugin({ pool, schema: namespace })) },
    ].map((backend) => ({ ...backend, api: createRuntime(backend.adapter), fixture: createFixture() }));
    for (const backend of backends) {
      const { api, fixture, adapter } = backend;
      if (backend.name === 'mongo') api.preventCreatingCollection(true);
      api.addNoEndpointType(fixture.Detail);
      api.addNoEndpointType(fixture.Part);
      api.connect(null, fixture.Owner, 'relationbatchowner', 'relationbatchowners');
      api.connect(null, fixture.Target, 'relationbatchtarget', 'relationbatchtargets');
      api.connect(null, fixture.Source, 'relationbatchsource', 'relationbatchsources');
      backend.schema = api.createSchema();
      if (backend.name === 'postgres') await adapter.initialize();
      else for (const { model } of api.getRegistrations()) if (model) await model.createCollection();

      const add = async (type, input) => (await run(backend, `mutation { add${type}(input: ${input}) { id } }`))[`add${type}`].id;
      const owners = [await add('relationbatchowner', '{ name: "Owner one" }'), await add('relationbatchowner', '{ name: "Owner two" }')];
      const targets = [];
      for (const [index, input] of [
        `{ name: "Alpha", rank: 1, tags: ["a", "b"], detail: { note: "first" }, parts: [{ label: "p1", owner: { id: "${owners[1]}" } }, { label: "p2" }]`,
        '{ name: "Beta", rank: 2, tags: [], detail: { note: "second" }, parts: []',
        '{ name: "Gamma", tags: ["c"], detail: { note: "third" }',
        '{ name: "Delta", rank: 4',
      ].entries()) {
        targets.push(await add('relationbatchtarget', `${input}, owner: { id: "${owners[index % 2]}" } }`));
      }
      for (let index = 0; index < 12; index++) {
        const label = `S${String(index).padStart(2, '0')}`;
        await add('relationbatchsource', `{ label: "${label}", target: { id: "${targets[index % 3]}" }, backup: { id: "${targets[(index + 1) % 3]}" } }`);
      }
      await add('relationbatchsource', `{ label: "Z", target: { id: "${targets[3]}" } }`);
      backend.targets = targets;
      backend.getById = vi.spyOn(adapter, 'getById');
      backend.getByIds = vi.spyOn(adapter, 'getByIds');
    }
  }, 60000);

  afterEach(() => {
    configureQueryLimits();
    for (const backend of backends || []) {
      backend.getById?.mockClear();
      backend.getByIds?.mockClear();
    }
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    if (mongoose.connection.readyState) {
      await mongoose.connection.db.dropDatabase();
      await mongoose.disconnect();
    }
    mongoose.deleteModel(/^RelationBatch/);
    if (pool) {
      await pool.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`);
      await pool.end();
    }
  });

  it('returns the per-call results with one read per related type and level', async () => {
    const results = [];
    for (const backend of backends) {
      expect(typeof backend.adapter.getByIds).toBe('function');
      const perCall = await run(backend, sourcesQuery());
      expect(reads(backend, 'Target').getById).toHaveLength(24);
      expect(reads(backend, 'Owner').getById).toHaveLength(28);
      expect(backend.getByIds).not.toHaveBeenCalled();
      backend.getById.mockClear();

      const batched = await run(backend, sourcesQuery(), {});
      expect(batched).toEqual(perCall);
      expect(batched.relationbatchsources).toHaveLength(12);
      expect(backend.getById).not.toHaveBeenCalled();
      expect(reads(backend, 'Target').getByIds).toHaveLength(1);
      expect(reads(backend, 'Target').getByIds[0][1]).toHaveLength(3);
      expect(reads(backend, 'Owner').getByIds).toHaveLength(1);
      expect(reads(backend, 'Owner').getByIds[0][1]).toHaveLength(2);
      results.push(batched);
    }
    const withoutIds = (data) => JSON.parse(JSON.stringify(data, (key, value) => (key === 'id' ? undefined : value)));
    expect(withoutIds(results[1])).toEqual(withoutIds(results[0]));
  });

  it('reads records in getById shape, owned records included, and omits missing IDs', async () => {
    for (const backend of backends) {
      const model = backend.api.getModel(backend.fixture.Target);
      const missing = backend.name === 'mongo' ? new mongoose.Types.ObjectId().toString() : randomUUID();
      const ids = [...backend.targets, missing];
      const plain = (record) => (typeof record?.toObject === 'function' ? record.toObject() : record);
      const byId = (records) => Object.fromEntries(records.map((record) => [String(record._id), plain(record)]));
      const expected = (await Promise.all(ids.map((id) => backend.adapter.getById(model, id)))).filter(Boolean);
      const records = await backend.adapter.getByIds(model, ids);
      expect(records).toHaveLength(4);
      expect(records.map((record) => typeof record.toObject)).toEqual(expected.map((record) => typeof record.toObject));
      expect(byId(records)).toEqual(byId(expected));
      const parts = byId(records)[backend.targets[0]].parts.map((part) => [part.label, part.owner_id && String(part.owner_id)]);
      expect(parts).toEqual([['p1', String(expected[1].owner_id)], ['p2', undefined]]);
      expect(await backend.adapter.getByIds(model, [])).toEqual([]);
    }
  });

  it('splits batches by the configured maximum page size', async () => {
    for (const backend of backends) {
      configureQueryLimits({ maxPageSize: 2 });
      const query = sourcesQuery(', pagination: { page: 1, size: 2 }');
      const perCall = await run(backend, query);
      backend.getById.mockClear();
      const batched = await run(backend, query, {});
      expect(batched).toEqual(perCall);
      expect(reads(backend, 'Target').getByIds.map(([, ids]) => ids.length)).toEqual([2, 1]);
      expect(backend.getById).not.toHaveBeenCalled();
    }
  });

  it('resolves missing and non-canonical references as without batching', async () => {
    for (const backend of backends) {
      const field = backend.fixture.Source.getFields().target;
      const [alpha] = backend.targets;
      const missing = backend.name === 'mongo' ? new mongoose.Types.ObjectId().toString() : randomUUID();
      for (const targetId of [alpha.toUpperCase(), missing]) {
        const parent = { target_id: targetId };
        const perCall = await field.resolve(parent, {}, undefined, {});
        const batched = await field.resolve(parent, {}, {}, {});
        expect(batched?.name ?? null).toBe(perCall?.name ?? null);
        expect(batched?.name ?? null).toBe(targetId === missing ? null : 'Alpha');
      }
      // Non-canonical (upper-case) IDs are read alone; only the missing canonical ID is batched.
      expect(backend.getByIds).toHaveBeenCalledTimes(1);
      expect(backend.getById).toHaveBeenCalledTimes(3);
    }
  });

  it('resolves an unset embedded object as without batching', async () => {
    const query = `{
      relationbatchsources(label: { operator: EQ, value: "Z" }) { target { name tags detail { note } parts { label } } backup { name } }
    }`;
    for (const backend of backends) {
      const perCall = await run(backend, query);
      const batched = await run(backend, query, {});
      expect(batched).toEqual(perCall);
      expect(batched.relationbatchsources[0].target.name).toBe('Delta');
      expect(batched.relationbatchsources[0].backup).toBeNull();
    }
  });
});

const describeWithMongo = mongoUri ? describe : describe.skip;

describeWithMongo('relation batching with Mongoose model customizations', () => {
  const dbName = `relbatchmodel_${randomUUID().replaceAll('-', '')}`;
  let adapter;
  let api;
  let schema;
  let hookTypes;
  const guardRuns = { pre: 0, post: 0 };

  beforeAll(async () => {
    await mongoose.connect(mongoUri, { dbName });
    adapter = createMongoAdapter();
    api = createRuntime(adapter);
    api.preventCreatingCollection(true);
    const Detail = new GraphQLObjectType({ name: 'RelationBatchModelDetail', fields: { note: { type: GraphQLString } } });
    const Target = new GraphQLObjectType({
      name: 'RelationBatchModelTarget',
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        price: { type: GraphQLInt },
        label: { type: GraphQLString },
        tags: { type: new GraphQLList(GraphQLString) },
        detail: { type: new GraphQLNonNull(Detail), extensions: { relation: { embedded: true } } },
      }),
    });
    const Source = new GraphQLObjectType({
      name: 'RelationBatchModelSource',
      fields: () => ({
        id: { type: GraphQLID },
        title: { type: GraphQLString },
        target: { type: Target, extensions: { relation: { connectionField: 'target_id' } } },
      }),
    });
    api.addNoEndpointType(Detail);
    api.connect(null, Target, 'relationbatchmodeltarget', 'relationbatchmodeltargets', null, (model) => {
      model.schema.path('price').get((value) => (value == null ? value : value * 100));
      model.schema.path('label').get((value) => value ?? 'default-label');
    });
    api.connect(null, Source, 'relationbatchmodelsource', 'relationbatchmodelsources');

    // Application models whose query middleware hides documents: for `findOne` only, for `find` only,
    // and for both through one function; and one whose post hook, shared by `find` and `findOne`, is
    // written for the single document `findOne` passes.
    const hide = function hide() {
      this.where({ hidden: { $ne: true } });
    };
    const upperCase = function upperCase(doc) {
      if (doc && typeof doc.name === 'string') doc.name = doc.name.toUpperCase();
    };
    const hookModel = (name, register) => {
      const hookSchema = new mongoose.Schema({ name: String, hidden: Boolean });
      register(hookSchema);
      return mongoose.model(name, hookSchema, name);
    };
    const hookType = (name) => new GraphQLObjectType({
      name,
      fields: { id: { type: GraphQLID }, name: { type: GraphQLString }, hidden: { type: GraphQLBoolean } },
    });
    hookTypes = {
      findOne: hookType('RelationBatchModelFindOneHook'),
      find: hookType('RelationBatchModelFindHook'),
      both: hookType('RelationBatchModelBothHook'),
      operation: hookType('RelationBatchModelOperationHook'),
      post: hookType('RelationBatchModelPostHook'),
    };
    const HookSource = new GraphQLObjectType({
      name: 'RelationBatchModelHookSource',
      fields: () => ({
        id: { type: GraphQLID },
        title: { type: GraphQLString },
        ...Object.fromEntries(Object.entries(hookTypes).map(([key, type]) => [
          key, { type, extensions: { relation: { connectionField: `${key}_id` } } },
        ])),
      }),
    });
    api.connect(hookModel('RelationBatchModelFindOneHook', (hookSchema) => hookSchema.pre('findOne', hide)),
      hookTypes.findOne, 'relationbatchmodelfindonehook', 'relationbatchmodelfindonehooks');
    api.connect(hookModel('RelationBatchModelFindHook', (hookSchema) => hookSchema.pre('find', hide)),
      hookTypes.find, 'relationbatchmodelfindhook', 'relationbatchmodelfindhooks');
    api.connect(hookModel('RelationBatchModelBothHook', (hookSchema) => hookSchema.pre(/^find/, hide)),
      hookTypes.both, 'relationbatchmodelbothhook', 'relationbatchmodelbothhooks');
    api.connect(hookModel('RelationBatchModelOperationHook', (hookSchema) => hookSchema.pre(/^find/, function hideByOperation() {
      if (this.op === 'findOne') this.where({ hidden: { $ne: true } });
    })), hookTypes.operation, 'relationbatchmodeloperationhook', 'relationbatchmodeloperationhooks');
    api.connect(hookModel('RelationBatchModelPostHook', (hookSchema) => hookSchema.post(/^find/, upperCase)),
      hookTypes.post, 'relationbatchmodelposthook', 'relationbatchmodelposthooks');
    api.connect(null, HookSource, 'relationbatchmodelhooksource', 'relationbatchmodelhooksources');

    // A model whose `findOne` middleware counts reads and rejects hidden documents.
    const Guard = hookType('RelationBatchModelGuard');
    const GuardSource = new GraphQLObjectType({
      name: 'RelationBatchModelGuardSource',
      fields: () => ({
        id: { type: GraphQLID },
        title: { type: GraphQLString },
        guard: { type: Guard, extensions: { relation: { connectionField: 'guard_id' } } },
      }),
    });
    api.connect(hookModel('RelationBatchModelGuard', (hookSchema) => {
      hookSchema.pre('findOne', function countRead() {
        guardRuns.pre += 1;
      });
      hookSchema.post('findOne', function rejectHidden(doc) {
        guardRuns.post += 1;
        if (doc?.hidden) throw new Error('Hidden guard');
      });
    }), Guard, 'relationbatchmodelguard', 'relationbatchmodelguards');
    api.connect(null, GuardSource, 'relationbatchmodelguardsource', 'relationbatchmodelguardsources');
    schema = api.createSchema();
    for (const { model } of api.getRegistrations()) if (model) await model.createCollection();

    const targets = api.getModel(Target).collection;
    const sources = api.getModel(Source).collection;
    const complete = await targets.insertOne({ name: 'Complete', price: 3, detail: { note: 'x' } });
    // A legacy document without the embedded object or the array.
    const legacy = await targets.insertOne({ name: 'Legacy', price: 4 });
    await sources.insertMany([
      { title: 'a', target_id: complete.insertedId },
      { title: 'b', target_id: legacy.insertedId },
      { title: 'c', target_id: complete.insertedId },
    ]);

    const hookSource = { shown: { title: 'shown' }, hidden: { title: 'hidden' } };
    for (const [key, type] of Object.entries(hookTypes)) {
      const { collection } = api.getModel(type);
      hookSource.shown[`${key}_id`] = (await collection.insertOne({ name: 'Shown' })).insertedId;
      hookSource.hidden[`${key}_id`] = (await collection.insertOne({ name: 'Hidden', hidden: true })).insertedId;
    }
    await api.getModel(HookSource).collection.insertMany([hookSource.shown, hookSource.hidden]);

    const guards = [];
    for (let index = 0; index < 5; index++) {
      guards.push((await api.getModel(Guard).collection.insertOne({ name: `G${index}`, hidden: index === 4 })).insertedId);
    }
    // The last source references the first guard again.
    await api.getModel(GuardSource).collection.insertMany([...guards, guards[0]].map((guardId, index) => ({
      title: `S${index}`, guard_id: guardId,
    })));
  }, 60000);

  afterEach(() => {
    vi.restoreAllMocks();
    mongoose.set('sanitizeFilter', false);
  });

  afterAll(async () => {
    if (mongoose.connection.readyState) {
      await mongoose.connection.db.dropDatabase();
      await mongoose.disconnect();
    }
    mongoose.deleteModel(/^RelationBatchModel/);
  });

  it('keeps getters, defaults and embedded values of hydrated documents', async () => {
    const getById = vi.spyOn(adapter, 'getById');
    const getByIds = vi.spyOn(adapter, 'getByIds');
    const query = '{ relationbatchmodelsources { title target { name price label tags detail { note } } } }';
    const perCall = await graphql({ schema, source: query });
    expect(getById).toHaveBeenCalledTimes(3);
    getById.mockClear();

    const batched = await graphql({ schema, source: query, contextValue: {} });
    expect(batched).toEqual(perCall);
    expect(getById).not.toHaveBeenCalled();
    expect(getByIds).toHaveBeenCalledTimes(1);
    const targets = Object.fromEntries(batched.data.relationbatchmodelsources.map(({ title, target }) => [title, target]));
    expect(targets.a).toMatchObject({ name: 'Complete', price: 300, label: 'default-label' });
    expect(targets.b).toMatchObject({ name: 'Legacy', price: 400, tags: [] });
    expect(targets.b.detail).not.toBeNull();

    // Mongoose's sanitizeFilter option must not disable the batched `$in` read.
    mongoose.set('sanitizeFilter', true);
    expect(await graphql({ schema, source: query, contextValue: {} })).toEqual(perCall);
    expect(getById).not.toHaveBeenCalled();
  });

  it('preserves findOne behavior for every model with find or findOne middleware', async () => {
    const getById = vi.spyOn(adapter, 'getById');
    const getByIds = vi.spyOn(adapter, 'getByIds');
    const query = `{ relationbatchmodelhooksources(sort: { terms: [{ field: "title", order: DESC }] }) {
      title findOne { name } find { name } both { name } operation { name } post { name }
    } }`;
    const perCall = await graphql({ schema, source: query });
    expect(perCall.errors).toBeUndefined();
    // Per-call reads run only findOne middleware.
    expect(perCall.data.relationbatchmodelhooksources).toEqual([
      {
        title: 'shown', findOne: { name: 'Shown' }, find: { name: 'Shown' }, both: { name: 'Shown' }, operation: { name: 'Shown' }, post: { name: 'SHOWN' },
      },
      {
        title: 'hidden', findOne: null, find: { name: 'Hidden' }, both: null, operation: null, post: { name: 'HIDDEN' },
      },
    ]);
    getById.mockClear();

    const batched = await graphql({ schema, source: query, contextValue: {} });
    expect(batched).toEqual(perCall);
    expect(getByIds).toHaveBeenCalledTimes(5);
    const readAlone = new Set(getById.mock.calls.map(([model]) => model.modelName));
    expect(readAlone).toEqual(new Set([
      'RelationBatchModelFindOneHook', 'RelationBatchModelFindHook', 'RelationBatchModelBothHook',
      'RelationBatchModelOperationHook', 'RelationBatchModelPostHook',
    ]));
    expect(getById).toHaveBeenCalledTimes(10);
  });

  it('reads each ID once through findOne middleware when a model cannot batch', async () => {
    const getById = vi.spyOn(adapter, 'getById');
    const getByIds = vi.spyOn(adapter, 'getByIds');
    const query = '{ relationbatchmodelguardsources(sort: { terms: [{ field: "title", order: ASC }] }) { title guard { name } } }';
    const summarize = ({ data, errors }) => ({ data, errors: errors?.map((error) => [error.path.join('.'), error.message]) });
    Object.assign(guardRuns, { pre: 0, post: 0 });
    const perCall = summarize(await graphql({ schema, source: query }));
    expect(perCall.errors).toEqual([['relationbatchmodelguardsources.4.guard', 'Hidden guard']]);
    expect(perCall.data.relationbatchmodelguardsources.map(({ guard }) => guard?.name ?? null))
      .toEqual(['G0', 'G1', 'G2', 'G3', null, 'G0']);
    expect(getById).toHaveBeenCalledTimes(6);
    expect(guardRuns).toEqual({ pre: 6, post: 6 });
    getById.mockClear();
    Object.assign(guardRuns, { pre: 0, post: 0 });

    const batched = summarize(await graphql({ schema, source: query, contextValue: {} }));
    expect(batched).toEqual(perCall);
    expect(getByIds).toHaveBeenCalledTimes(1);
    // A read the hook rejects is not repeated; references to one ID share its read.
    expect(new Set(getById.mock.calls.map(([, id]) => id)).size).toBe(5);
    expect(getById).toHaveBeenCalledTimes(5);
    expect(guardRuns).toEqual({ pre: 5, post: 5 });
  });
});
