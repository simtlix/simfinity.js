import {
  afterAll, afterEach, describe, expect, test, vi,
} from 'vitest';
import {
  GraphQLID, GraphQLList, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';
import mongoose from 'mongoose';

import { configureQueryLimits, createRuntime, paginationStages, SimfinityError } from '../packages/core/src/index.js';
import { createMongoAdapter } from '../packages/mongodb/src/mongo/adapter.js';

const isValidId = (id) => !String(id).startsWith('bad');
const invalidId = () => new SimfinityError('Invalid ID', 'NOT_VALID_ID', 400);
const tenantOf = (args) => args.tenant?.value;
// Like the real adapters, IDs are matched after casting, which here ignores case and rejects `bad` IDs.
const castId = (value) => {
  if (!isValidId(value)) throw invalidId();
  return String(value).toLowerCase();
};

// Adapter double that counts reads. Like the real adapters, `getById` applies the `requiredId` guard.
// Without `batching`, it has no `getByIds`, so relation reads stay per call; with `failBatch`, every
// `getByIds` read fails.
const createAdapter = (rows, { batching = true, failBatch = false } = {}) => {
  const calls = {
    find: [], getById: [], getByIds: [], findChildren: [],
  };
  const table = (Model) => rows[Model.name] || [];
  const adapter = {
    calls,
    bind() {},
    createModel: (gqltype) => ({ name: gqltype.name }),
    castId,
    withTransaction: async (session, body) => body(session || {}),
    async getById(Model, id, session, { requiredId, context } = {}) {
      calls.getById.push({
        model: Model.name, id, requiredId, context,
      });
      await Promise.resolve();
      if (!isValidId(id)) throw invalidId();
      if (requiredId != null && castId(requiredId) !== castId(id)) return null;
      const record = table(Model).find((row) => row._id === castId(id));
      return record ? { ...record } : null;
    },
    async find(Model, gqltype, args, session, { requiredId } = {}) {
      calls.find.push({ model: Model.name, args, requiredId });
      paginationStages(args.pagination, true);
      await Promise.resolve();
      let result = table(Model);
      if (args.id?.operator === 'EQ') result = result.filter((row) => row._id === args.id.value);
      if (requiredId != null) result = result.filter((row) => row._id === String(requiredId));
      if (tenantOf(args)) result = result.filter((row) => row.tenant === tenantOf(args));
      return result.map((row) => ({ ...row }));
    },
    async count(Model) {
      return table(Model).length;
    },
    async aggregate() {
      return [];
    },
    async findChildren(Model, gqltype, connectionField, parentId) {
      calls.findChildren.push({ model: Model.name, parentId });
      return table(Model).filter((row) => row[connectionField] === String(parentId)).map((row) => ({ ...row }));
    },
  };
  if (batching) {
    adapter.getByIds = async (Model, ids, { context } = {}) => {
      calls.getByIds.push({ model: Model.name, ids, context });
      await Promise.resolve();
      if (failBatch) throw new Error('Batch read failed');
      const wanted = ids.map(castId);
      return table(Model).filter((row) => wanted.includes(row._id)).map((row) => ({ ...row }));
    };
  }
  return adapter;
};

const createFixture = (rows, { middleware, batching, failBatch } = {}) => {
  const adapter = createAdapter(rows, { batching, failBatch });
  const runtime = createRuntime(adapter);
  const middlewareCalls = [];
  runtime.use(async (params, next) => {
    middlewareCalls.push({ operation: params.operation, type: params.type?.gqltype?.name, context: params.context });
    if (middleware) await middleware(params);
    await next();
  });
  const Owner = new GraphQLObjectType({
    name: 'BatchOwner',
    fields: () => ({ id: { type: GraphQLID }, name: { type: GraphQLString } }),
  });
  const Target = new GraphQLObjectType({
    name: 'BatchTarget',
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      owner: { type: Owner, extensions: { relation: { connectionField: 'ownerId' } } },
      sources: { type: new GraphQLList(Source), extensions: { relation: { connectionField: 'targetId' } } },
    }),
  });
  const Scoped = new GraphQLObjectType({
    name: 'BatchScoped',
    extensions: {
      scope: {
        get_by_id: async ({ args, context }) => {
          args.tenant = { operator: 'EQ', value: context.tenant };
        },
      },
    },
    fields: () => ({ id: { type: GraphQLID }, name: { type: GraphQLString }, tenant: { type: GraphQLString } }),
  });
  const Source = new GraphQLObjectType({
    name: 'BatchSource',
    fields: () => ({
      id: { type: GraphQLID },
      label: { type: GraphQLString },
      target: { type: Target, extensions: { relation: { connectionField: 'targetId' } } },
      backup: { type: Target, extensions: { relation: { connectionField: 'backupId' } } },
      scoped: { type: Scoped, extensions: { relation: { connectionField: 'scopedId' } } },
    }),
  });
  runtime.connect(null, Owner, 'batchowner', 'batchowners');
  runtime.connect(null, Target, 'batchtarget', 'batchtargets');
  runtime.connect(null, Scoped, 'batchscoped', 'batchscopeds');
  runtime.connect(null, Source, 'batchsource', 'batchsources');
  const schema = runtime.createSchema();
  const execute = (source, contextValue) => graphql({ schema, source, contextValue });
  return { adapter, middlewareCalls, execute };
};

const createRows = (sourceCount, targetOf = (index) => `t${index % 3}`) => ({
  BatchOwner: [{ _id: 'o1', name: 'Owner' }],
  BatchTarget: ['t0', 't1', 't2'].map((id) => ({ _id: id, name: `Target ${id}`, ownerId: 'o1' })),
  BatchScoped: [{ _id: 'k1', name: 'Scoped A', tenant: 'A' }, { _id: 'k2', name: 'Scoped B', tenant: 'B' }],
  BatchSource: Array.from({ length: sourceCount }, (_, index) => ({
    _id: `s${index}`,
    label: `Source ${index}`,
    targetId: targetOf(index),
    backupId: `t${(index + 1) % 3}`,
    scopedId: index % 2 ? 'k2' : 'k1',
  })),
});

const reads = (adapter, model) => ({
  find: adapter.calls.find.filter((call) => call.model === model),
  getById: adapter.calls.getById.filter((call) => call.model === model),
  getByIds: adapter.calls.getByIds.filter((call) => call.model === model),
});

// Middleware that awaits several promise jobs, as async authorization checks do, before continuing.
const asyncMiddleware = async () => {
  await Promise.resolve();
  await (async () => {
    await null;
    await Promise.resolve();
  })();
};

describe('relation batching', () => {
  afterEach(() => configureQueryLimits());

  test('reads sibling references in one adapter read after async middleware', async () => {
    const query = '{ batchsources { id label target { id name } } }';
    const perCall = createFixture(createRows(100), { middleware: asyncMiddleware, batching: false });
    const expected = await perCall.execute(query, {});
    expect(expected.errors).toBeUndefined();
    expect(reads(perCall.adapter, 'BatchTarget').getById).toHaveLength(100);

    const batched = createFixture(createRows(100), { middleware: asyncMiddleware });
    const context = {};
    const result = await batched.execute(query, context);
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual(expected.data);
    const targetReads = reads(batched.adapter, 'BatchTarget');
    expect(targetReads.getById).toHaveLength(0);
    expect(targetReads.find).toHaveLength(0);
    expect(targetReads.getByIds).toHaveLength(1);
    expect(targetReads.getByIds[0].ids).toEqual(['t0', 't1', 't2']);
    expect(targetReads.getByIds[0].context).toBe(context);
    expect(batched.middlewareCalls.filter((call) => call.operation === 'get_by_id')).toHaveLength(100);
  });

  test('reads per call without a context object or an adapter getByIds', async () => {
    const query = '{ batchsources { target { name } } }';
    const withoutContext = createFixture(createRows(6));
    const expected = await withoutContext.execute(query);
    expect(expected.errors).toBeUndefined();
    expect(reads(withoutContext.adapter, 'BatchTarget').getById).toHaveLength(6);
    expect(reads(withoutContext.adapter, 'BatchTarget').getByIds).toHaveLength(0);

    const withoutBatching = createFixture(createRows(6), { batching: false });
    expect(await withoutBatching.execute(query, {})).toEqual(expected);
    expect(reads(withoutBatching.adapter, 'BatchTarget').getById.map((call) => call.id))
      .toEqual(['t0', 't1', 't2', 't0', 't1', 't2']);
  });

  test('batches each related type and nesting level, without caching between requests', async () => {
    const query = '{ batchsources { target { name owner { name } } backup { name owner { name } } } }';
    const perCall = createFixture(createRows(12), { batching: false });
    const expected = await perCall.execute(query, {});
    const { adapter, execute } = createFixture(createRows(12));
    const context = {};
    const result = await execute(query, context);
    expect(result.errors).toBeUndefined();
    expect(result.data).toEqual(expected.data);
    expect(reads(adapter, 'BatchTarget').getByIds).toHaveLength(1);
    expect(reads(adapter, 'BatchOwner').getByIds).toHaveLength(1);
    expect(adapter.calls.getById).toHaveLength(0);

    expect((await execute(query, context)).data).toEqual(expected.data);
    expect(reads(adapter, 'BatchTarget').getByIds).toHaveLength(2);
    expect(reads(adapter, 'BatchOwner').getByIds).toHaveLength(2);
  });

  test('keeps concurrent requests in separate batches', async () => {
    const { adapter, middlewareCalls, execute } = createFixture(createRows(6));
    const first = { name: 'first' };
    const second = { name: 'second' };
    const [one, two] = await Promise.all([
      execute('{ batchsources { target { name } } }', first),
      execute('{ batchsources { backup { name } } }', second),
    ]);
    expect(one.errors).toBeUndefined();
    expect(two.errors).toBeUndefined();
    expect(one.data.batchsources.map((source) => source.target.name)).toEqual(
      ['t0', 't1', 't2', 't0', 't1', 't2'].map((id) => `Target ${id}`),
    );
    expect(two.data.batchsources.map((source) => source.backup.name)).toEqual(
      ['t1', 't2', 't0', 't1', 't2', 't0'].map((id) => `Target ${id}`),
    );
    expect(reads(adapter, 'BatchTarget').getByIds.map((call) => call.context)).toEqual([first, second]);
    const contexts = middlewareCalls.filter((call) => call.operation === 'get_by_id').map((call) => call.context);
    expect(contexts.filter((context) => context === first)).toHaveLength(6);
    expect(contexts.filter((context) => context === second)).toHaveLength(6);
  });

  test('reads alone when middleware changes the ID, keeping the required identity', async () => {
    const redirect = async ({ operation, args, context }) => {
      if (operation === 'get_by_id' && context.redirect && args.id === 't0') args.id = 't1';
    };
    const { adapter, execute } = createFixture(createRows(6), { middleware: redirect });
    const result = await execute('{ batchsources { target { name } } }', { redirect: true });
    expect(result.errors).toBeUndefined();
    expect(result.data.batchsources.map((source) => source.target?.name ?? null)).toEqual(
      [null, 'Target t1', 'Target t2', null, 'Target t1', 'Target t2'],
    );
    const targetReads = reads(adapter, 'BatchTarget');
    expect(targetReads.getById.map((call) => [call.id, call.requiredId])).toEqual([['t1', 't0'], ['t1', 't0']]);
    expect(targetReads.getByIds).toHaveLength(1);
    expect(targetReads.getByIds[0].ids).toEqual(['t1', 't2']);
  });

  test('keeps one scoped read per call for types with a get_by_id scope', async () => {
    const { adapter, execute } = createFixture(createRows(4));
    const result = await execute('{ batchsources { scoped { name } } }', { tenant: 'A' });
    expect(result.errors).toBeUndefined();
    expect(result.data.batchsources.map((source) => source.scoped?.name ?? null)).toEqual(
      ['Scoped A', null, 'Scoped A', null],
    );
    const scopedReads = reads(adapter, 'BatchScoped');
    expect(scopedReads.getByIds).toHaveLength(0);
    expect(scopedReads.find).toHaveLength(4);
    expect(scopedReads.find.map((call) => call.requiredId)).toEqual(['k1', 'k2', 'k1', 'k2']);
  });

  test('reads an ID the adapter cannot cast alone and batches the others', async () => {
    const rows = createRows(4, (index) => (index === 2 ? 'bad-id' : `t${index % 3}`));
    const { adapter, execute } = createFixture(rows);
    const result = await execute('{ batchsources { label target { name } } }', {});
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].path).toEqual(['batchsources', 2, 'target']);
    // A stored value the adapter cannot cast is a data problem, not the client's input.
    expect(result.errors[0].extensions.code).toBe('INTERNAL_SERVER_ERROR');
    expect(result.errors[0].originalError.getCause().extensions).toMatchObject({ code: 'NOT_VALID_ID', status: 400 });
    expect(result.data.batchsources.map((source) => source.target?.name ?? null)).toEqual(
      ['Target t0', 'Target t1', null, 'Target t0'],
    );
    const targetReads = reads(adapter, 'BatchTarget');
    expect(targetReads.getByIds.map((call) => call.ids)).toEqual([['t0', 't1']]);
    expect(targetReads.getById.map((call) => [call.id, call.requiredId])).toEqual([['bad-id', 'bad-id']]);
  });

  test('reads each ID alone, once, when a batch read fails', async () => {
    const query = '{ batchsources { label target { name } } }';
    const expected = await createFixture(createRows(6), { batching: false }).execute(query, {});
    const { adapter, execute } = createFixture(createRows(6), { failBatch: true });
    expect(await execute(query, {})).toEqual(expected);
    const targetReads = reads(adapter, 'BatchTarget');
    expect(targetReads.getByIds).toHaveLength(1);
    expect(targetReads.getById.map((call) => [call.id, call.requiredId])).toEqual([['t0', 't0'], ['t1', 't1'], ['t2', 't2']]);
  });

  test('splits a batch by the configured maximum page size', async () => {
    configureQueryLimits({ maxPageSize: 2 });
    const { adapter, execute } = createFixture(createRows(2));
    const result = await execute('{ batchsources { target { name } backup { name } } }', {});
    expect(result.errors).toBeUndefined();
    expect(result.data.batchsources).toEqual([
      { target: { name: 'Target t0' }, backup: { name: 'Target t1' } },
      { target: { name: 'Target t1' }, backup: { name: 'Target t2' } },
    ]);
    const targetReads = reads(adapter, 'BatchTarget');
    expect(targetReads.getByIds.map((call) => call.ids)).toEqual([['t0', 't1'], ['t2']]);
    expect(targetReads.getById).toHaveLength(0);
  });

  test('reads non-canonical IDs alone and resolves missing ones to null without another read', async () => {
    const rows = createRows(4, (index) => ['t0', 'missing', 'T1', 't1'][index]);
    const query = '{ batchsources { target { name } } }';
    const expected = await createFixture(rows, { batching: false }).execute(query, {});
    expect(expected.data.batchsources.map((source) => source.target?.name ?? null)).toEqual(
      ['Target t0', null, 'Target t1', 'Target t1'],
    );
    const { adapter, execute } = createFixture(rows);
    const result = await execute(query, {});
    expect(result).toEqual(expected);
    const targetReads = reads(adapter, 'BatchTarget');
    expect(targetReads.getByIds.map((call) => call.ids)).toEqual([['t0', 'missing', 't1']]);
    expect(targetReads.getById.map((call) => call.id)).toEqual(['T1']);
  });

  test('keeps collection relations and root reads per call', async () => {
    const { adapter, execute } = createFixture(createRows(6));
    const result = await execute('{ batchtargets { name sources { label } } batchtarget(id: "t1") { name } }', {});
    expect(result.errors).toBeUndefined();
    expect(result.data.batchtargets.map((target) => target.sources.length)).toEqual([2, 2, 2]);
    expect(result.data.batchtarget).toEqual({ name: 'Target t1' });
    expect(adapter.calls.findChildren).toHaveLength(3);
    expect(adapter.calls.getByIds).toHaveLength(0);
    expect(reads(adapter, 'BatchTarget').getById.map((call) => [call.id, call.requiredId])).toEqual([['t1', undefined]]);
  });
});

describe('MongoDB adapter getByIds', () => {
  const adapter = createMongoAdapter();
  const ids = [new mongoose.Types.ObjectId().toString()];
  // No database: the models neither create collections nor wait for a connection.
  const hookModel = (name, register) => {
    const schema = new mongoose.Schema({ name: String, hidden: Boolean }, { autoCreate: false, autoIndex: false });
    register(schema);
    return mongoose.model(name, schema);
  };
  const upperCase = function upperCase(doc) {
    if (doc && typeof doc.name === 'string') doc.name = doc.name.toUpperCase();
  };

  afterEach(() => vi.restoreAllMocks());
  afterAll(() => mongoose.deleteModel(/^BatchHook/));

  test('reads through find when find and findOne have no query hooks', () => {
    const Model = hookModel('BatchHookPlain', () => {});
    const query = adapter.getByIds(Model, ids);
    expect(query.op).toBe('find');
    expect(query.getFilter()._id.$in).toEqual(ids);
  });

  test('preserves findOne restrictions when a shared hook depends on the operation', async () => {
    const TargetModel = hookModel('BatchHookOperationTarget', (schema) => schema.pre(/^find/, function hide() {
      if (this.op === 'findOne') this.where({ hidden: { $ne: true } });
    }));
    const hidden = { _id: new mongoose.Types.ObjectId(), name: 'Hidden', hidden: true };
    vi.spyOn(TargetModel.collection, 'findOne').mockImplementation(async (filter) => (filter.hidden ? null : hidden));
    vi.spyOn(TargetModel.collection, 'find').mockImplementation((filter) => ({ toArray: async () => (filter.hidden ? [] : [hidden]) }));
    const SourceModel = hookModel('BatchHookOperationSource', (schema) => schema.add({ target: mongoose.Schema.Types.ObjectId }));
    vi.spyOn(SourceModel.collection, 'findOne').mockResolvedValue({ _id: new mongoose.Types.ObjectId(), target: hidden._id });
    const Target = new GraphQLObjectType({
      name: 'BatchHookOperationTarget', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } },
    });
    const Source = new GraphQLObjectType({
      name: 'BatchHookOperationSource',
      fields: { id: { type: GraphQLID }, target: { type: Target, extensions: { relation: { connectionField: 'target' } } } },
    });
    const runtime = createRuntime(createMongoAdapter());
    runtime.connect(TargetModel, Target, 'hooktarget', 'hooktargets');
    runtime.connect(SourceModel, Source, 'hooksource', 'hooksources');
    const schema = runtime.createSchema();
    const source = `{hooksource(id: "${ids[0]}") {target {name}}}`;
    const perCall = await graphql({ schema, source });
    expect(perCall.errors).toBeUndefined();
    expect(perCall.data.hooksource.target).toBeNull();
    expect(await graphql({ schema, source, contextValue: {} })).toEqual(perCall);
  });

  test('rejects before reading when find and findOne hooks could return different records', () => {
    const getById = vi.spyOn(adapter, 'getById').mockResolvedValue(null);
    const noop = function noop() {};
    for (const Model of [
      // One function written for the single document findOne passes; find passes an array.
      hookModel('BatchHookSharedPost', (schema) => schema.post(/^find/, upperCase)),
      hookModel('BatchHookFindPost', (schema) => schema.post('find', noop)),
      hookModel('BatchHookFindOnePost', (schema) => schema.post('findOne', noop)),
      hookModel('BatchHookFindOnePre', (schema) => schema.pre('findOne', noop)),
      hookModel('BatchHookFindPre', (schema) => schema.pre('find', noop)),
      hookModel('BatchHookSharedPre', (schema) => schema.pre(/^find/, noop)),
    ]) {
      expect(() => adapter.getByIds(Model, ids)).toThrow(Model.modelName);
    }
    expect(getById).not.toHaveBeenCalled();
  });
});
