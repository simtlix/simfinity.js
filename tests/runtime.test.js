import { describe, expect, test, vi } from 'vitest';
import {
  GraphQLID,
  GraphQLInt,
  GraphQLInputObjectType,
  GraphQLEnumType,
  GraphQLInterfaceType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLScalarType,
  GraphQLString,
  GraphQLUnionType,
  graphql,
  printSchema,
} from 'graphql';
import mongoose from 'mongoose';

import { auth, createRuntime } from '../packages/core/src/index.js';
import { createMongoAdapter } from '../packages/mongodb/src/mongo/adapter.js';
import { createMongoModel } from '../packages/mongodb/src/mongo/models.js';
import { createMongoQueries } from '../packages/mongodb/src/mongo/queries.js';
import { createPostgres } from '../packages/postgres/src/index.js';

const createType = (name) => new GraphQLObjectType({
  name,
  fields: {
    id: { type: GraphQLID },
    name: { type: GraphQLString },
  },
});

const createMemoryAdapter = () => {
  const records = new Map();
  let nextId = 1;
  let binding;

  return {
    bind(value) {
      binding = value;
    },
    prepare: vi.fn(),
    createModel: vi.fn((gqltype, onModelCreated) => {
      const model = { name: gqltype.name };
      if (onModelCreated) onModelCreated(model);
      return model;
    }),
    castId: (value) => String(value),
    withTransaction: async (session, body) => body(session || { adapter: 'memory' }),
    newRecord(Model, data, session) {
      return { ...data, _id: String(nextId++), Model, session };
    },
    async saveRecord(Model, record) {
      records.set(record._id, record);
      return record;
    },
    toObject: (record) => ({ ...record }),
    async getById(Model, id) {
      return records.get(String(id)) || null;
    },
    prepareUpdate(set, unset) {
      return { set, unset };
    },
    async update(Model, id, update) {
      const current = records.get(String(id));
      for (const key of Object.keys(update.unset)) delete current[key];
      Object.assign(current, update.set);
      return current;
    },
    async delete(Model, id) {
      const record = records.get(String(id)) || null;
      records.delete(String(id));
      return record;
    },
    async find() {
      return [...records.values()];
    },
    async count() {
      return records.size;
    },
    async aggregate() {
      return [];
    },
    async findChildren() {
      return [];
    },
    getBinding: () => binding,
    getRecords: () => [...records.values()],
  };
};

const createWrappedListFixture = () => {
  const EmbeddedType = new GraphQLObjectType({
    name: 'RuntimeWrappedEmbedded',
    fields: {
      value: { type: GraphQLString },
    },
  });
  const ChildType = new GraphQLObjectType({
    name: 'RuntimeWrappedChild',
    fields: {
      id: { type: GraphQLID },
      value: { type: GraphQLString },
      parentKey: { type: GraphQLID, extensions: { readOnly: true } },
    },
  });
  const ParentType = new GraphQLObjectType({
    name: 'RuntimeWrappedParent',
    fields: {
      id: { type: GraphQLID },
      requiredTags: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))),
      },
      requiredEmbeds: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(EmbeddedType))),
        extensions: { relation: { embedded: true } },
      },
      nullableEmbeds: {
        type: new GraphQLList(EmbeddedType),
        extensions: { relation: { embedded: true } },
      },
      requiredChildren: {
        type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(ChildType))),
        extensions: { relation: { embedded: false, connectionField: 'parentKey' } },
      },
    },
  });
  return { EmbeddedType, ChildType, ParentType };
};

const configureSyntheticRetry = (adapter) => {
  adapter.withTransaction = async (session, body) => {
    try {
      return await body({ adapter: 'memory', attempt: 1 });
    } catch (error) {
      if (error.message !== 'synthetic retry') throw error;
      return body({ adapter: 'memory', attempt: 2 });
    }
  };
};

const createRetryInputTypes = (prefix) => {
  const modeValue = { storage: 'draft' };
  const Mode = new GraphQLEnumType({
    name: `${prefix}Mode`,
    values: { DRAFT: { value: modeValue } },
  });
  const DateTime = new GraphQLScalarType({
    name: `${prefix}DateTime`,
    serialize: (value) => value.toISOString(),
    parseValue: (value) => new Date(value),
    parseLiteral: (node) => new Date(node.value),
  });
  return { modeValue, Mode, DateTime };
};

describe('createRuntime', () => {
  test('replaces embedded lists after missing or explicitly cleared storage', async () => {
    const runtime = createRuntime(createMemoryAdapter());
    const EmbeddedType = new GraphQLObjectType({
      name: 'RuntimeRestoredEmbedded',
      fields: { value: { type: GraphQLString } },
    });
    const ParentType = new GraphQLObjectType({
      name: 'RuntimeRestoredParent',
      fields: {
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        items: {
          type: new GraphQLList(EmbeddedType),
          extensions: { relation: { embedded: true } },
        },
      },
    });
    runtime.addNoEndpointType(EmbeddedType);
    runtime.connect(null, ParentType, 'runtimeRestoredParent', 'runtimeRestoredParents');
    const schema = runtime.createSchema();
    const added = await graphql({
      schema,
      source: 'mutation { addruntimeRestoredParent(input: { name: "item" }) { id } }',
    });
    const id = added.data.addruntimeRestoredParent.id;

    const afterMissing = await graphql({
      schema,
      source: `mutation {
        updateruntimeRestoredParent(input: {
          id: "${id}", items: [{ value: "after-missing" }]
        }) { items { value } }
      }`,
    });
    const cleared = await graphql({
      schema,
      source: `mutation {
        updateruntimeRestoredParent(input: { id: "${id}", items: null }) { id }
      }`,
    });
    const afterClear = await graphql({
      schema,
      source: `mutation {
        updateruntimeRestoredParent(input: {
          id: "${id}", items: [{ value: "after-clear" }]
        }) { items { value } }
      }`,
    });

    expect(afterMissing.errors).toBeUndefined();
    expect(afterMissing.data.updateruntimeRestoredParent.items).toEqual([
      { value: 'after-missing' },
    ]);
    expect(cleared.errors).toBeUndefined();
    expect(afterClear.errors).toBeUndefined();
    expect(afterClear.data.updateruntimeRestoredParent.items).toEqual([
      { value: 'after-clear' },
    ]);
  });

  test('clones generated mutation input for each transaction attempt', async () => {
    const adapter = createMemoryAdapter();
    configureSyntheticRetry(adapter);
    const runtime = createRuntime(adapter);
    const middleware = vi.fn((params, next) => next());
    const { modeValue, Mode, DateTime } = createRetryInputTypes('RuntimeGeneratedRetry');
    const DetailType = new GraphQLObjectType({
      name: 'RuntimeGeneratedRetryDetail',
      fields: { name: { type: GraphQLString } },
    });
    const ItemType = new GraphQLObjectType({
      name: 'RuntimeGeneratedRetryItem',
      fields: {
        id: { type: GraphQLID },
        detail: {
          type: DetailType,
          extensions: { relation: { embedded: true } },
        },
        tags: { type: new GraphQLList(GraphQLString) },
        mode: { type: Mode },
        when: { type: DateTime },
      },
    });
    const attempts = [];
    const controller = {
      onSaving(record, args, session) {
        attempts.push({
          attempt: session.attempt,
          detail: args.detail.name,
          tags: [...args.tags],
          year: args.when.getUTCFullYear(),
          enumIdentity: args.mode === modeValue,
        });
        args.detail.name = 'mutated';
        args.tags.push('mutated');
        args.when.setUTCFullYear(2040);
        if (session.attempt === 1) throw new Error('synthetic retry');
      },
    };
    runtime.use(middleware);
    runtime.addNoEndpointType(DetailType);
    runtime.connect(null, ItemType, 'runtimeGeneratedRetryItem',
      'runtimeGeneratedRetryItems', controller);

    const result = await graphql({
      schema: runtime.createSchema(),
      source: `mutation {
        addruntimeGeneratedRetryItem(input: {
          detail: { name: "original" }
          tags: ["one"]
          mode: DRAFT
          when: "2026-09-10T00:00:00.000Z"
        }) { id mode }
      }`,
    });

    expect(result.errors).toBeUndefined();
    expect(attempts).toEqual([
      { attempt: 1, detail: 'original', tags: ['one'], year: 2026, enumIdentity: true },
      { attempt: 2, detail: 'original', tags: ['one'], year: 2026, enumIdentity: true },
    ]);
    expect(middleware).toHaveBeenCalledOnce();
  });

  test('clones custom mutation input for each transaction attempt', async () => {
    const adapter = createMemoryAdapter();
    configureSyntheticRetry(adapter);
    const runtime = createRuntime(adapter);
    const { modeValue, Mode, DateTime } = createRetryInputTypes('RuntimeCustomRetry');
    const DetailInput = new GraphQLInputObjectType({
      name: 'RuntimeCustomRetryDetailInput',
      fields: { name: { type: GraphQLString } },
    });
    const MutationInput = new GraphQLInputObjectType({
      name: 'RuntimeCustomRetryInput',
      fields: {
        detail: { type: DetailInput },
        tags: { type: new GraphQLList(GraphQLString) },
        mode: { type: Mode },
        when: { type: DateTime },
      },
    });
    const MutationOutput = new GraphQLObjectType({
      name: 'RuntimeCustomRetryOutput',
      fields: { ok: { type: GraphQLString } },
    });
    const attempts = [];
    runtime.connect(null, createType('RuntimeCustomRetryEntity'),
      'runtimeCustomRetryEntity', 'runtimeCustomRetryEntities');
    runtime.registerMutation('runtimeCustomRetry', 'retry', MutationInput, MutationOutput,
      async (args, session) => {
        attempts.push({
          attempt: session.attempt,
          detail: args.detail.name,
          tags: [...args.tags],
          year: args.when.getUTCFullYear(),
          enumIdentity: args.mode === modeValue,
        });
        args.detail.name = 'mutated';
        args.tags.push('mutated');
        args.when.setUTCFullYear(2040);
        if (session.attempt === 1) throw new Error('synthetic retry');
        return { ok: 'yes' };
      });

    const result = await graphql({
      schema: runtime.createSchema(),
      source: `mutation {
        runtimeCustomRetry(input: {
          detail: { name: "original" }
          tags: ["one"]
          mode: DRAFT
          when: "2026-09-10T00:00:00.000Z"
        }) { ok }
      }`,
    });

    expect(result.errors).toBeUndefined();
    expect(result.data.runtimeCustomRetry).toEqual({ ok: 'yes' });
    expect(attempts).toEqual([
      { attempt: 1, detail: 'original', tags: ['one'], year: 2026, enumIdentity: true },
      { attempt: 2, detail: 'original', tags: ['one'], year: 2026, enumIdentity: true },
    ]);
  });

  test('builds Mongo paths for wrapped scalar and embedded lists', () => {
    const { ParentType } = createWrappedListFixture();
    const Model = createMongoModel(ParentType, null, { createCollection: false });

    try {
      expect(Model.schema.path('requiredTags')).toBeDefined();
      expect(Model.schema.path('requiredEmbeds')).toBeDefined();
    } finally {
      mongoose.deleteModel(ParentType.name);
    }
  });

  test('builds Mongo filters for required scalar and relationship lists', async () => {
    const { ChildType, ParentType } = createWrappedListFixture();
    const queries = createMongoQueries({
      getModel: (type) => ({ collection: { collectionName: type.name } }),
    });

    const pipeline = await queries.buildQuery({
      requiredTags: { operator: 'EQ', value: 'one' },
      requiredChildren: { terms: [{ path: 'value', operator: 'EQ', value: 'child' }] },
    }, ParentType);

    expect(pipeline).toContainEqual({
      $lookup: {
        from: ChildType.name,
        foreignField: 'parentKey',
        localField: '_id',
        as: '__sf_l0',
      },
    });
    expect(pipeline).toContainEqual({
      $match: {
        requiredTags: 'one',
        '__sf_l0.value': 'child',
      },
    });
  });

  test('coerces filters for wrapped date lists', async () => {
    const DateTime = new GraphQLScalarType({ name: 'DateTime' });
    const EventType = new GraphQLObjectType({
      name: 'RuntimeWrappedEvent',
      fields: {
        dates: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(DateTime))) },
      },
    });
    const queries = createMongoQueries({ getModel: () => null });

    const pipeline = await queries.buildQuery({
      dates: { operator: 'EQ', value: '2026-09-10T12:00:00.000Z' },
    }, EventType);

    expect(pipeline).toContainEqual({
      $match: { dates: new Date('2026-09-10T12:00:00.000Z') },
    });
  });

  test('builds nested Mongo lookups through required relationship lists', async () => {
    const GrandchildType = new GraphQLObjectType({
      name: 'RuntimeWrappedGrandchild',
      fields: { value: { type: GraphQLString } },
    });
    const ChildType = new GraphQLObjectType({
      name: 'RuntimeNestedWrappedChild',
      fields: {
        requiredGrandchildren: {
          type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GrandchildType))),
          extensions: { relation: { embedded: false, connectionField: 'childKey' } },
        },
      },
    });
    const ParentType = new GraphQLObjectType({
      name: 'RuntimeNestedWrappedParent',
      fields: {
        requiredChildren: {
          type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(ChildType))),
          extensions: { relation: { embedded: false, connectionField: 'parentKey' } },
        },
      },
    });
    const queries = createMongoQueries({
      getModel: (type) => ({ collection: { collectionName: type.name } }),
    });

    const pipeline = await queries.buildQuery({
      requiredChildren: {
        terms: [{ path: 'requiredGrandchildren.value', operator: 'EQ', value: 'nested' }],
      },
    }, ParentType);

    expect(pipeline).toContainEqual({
      $lookup: {
        from: GrandchildType.name,
        foreignField: 'childKey',
        localField: '__sf_l0._id',
        as: '__sf_l1',
      },
    });
    expect(pipeline).toContainEqual({
      $match: { '__sf_l1.value': 'nested' },
    });
  });

  test('aggregates inverse-list facts with parent-to-child lookup direction and reuse', async () => {
    const ChildType = new GraphQLObjectType({
      name: 'RuntimeAggregateChild',
      fields: {
        id: { type: GraphQLID },
        number: { type: GraphQLInt },
      },
    });
    const ParentType = new GraphQLObjectType({
      name: 'RuntimeAggregateParent',
      fields: {
        tenant: { type: GraphQLString },
        children: {
          type: new GraphQLList(ChildType),
          extensions: { relation: { embedded: false, connectionField: 'parentKey' } },
        },
      },
    });
    const queries = createMongoQueries({
      getModel: (type) => ({ collection: { collectionName: type.name } }),
    });

    const pipeline = await queries.buildAggregationQuery({}, ParentType, {
      groupId: 'tenant',
      facts: [
        { operation: 'COUNT', factName: 'count', path: 'children.id' },
        { operation: 'SUM', factName: 'sum', path: 'children.number' },
      ],
    });

    expect(pipeline.filter((stage) => stage.$lookup)).toEqual([{
      $lookup: {
        from: ChildType.name,
        foreignField: 'parentKey',
        localField: '_id',
        as: '__sf_l0',
      },
    }]);
    expect(pipeline).toContainEqual({
      $group: {
        _id: '$tenant',
        fact_0: { $sum: 1 },
        fact_1: { $sum: '$__sf_l0.number' },
      },
    });
  });

  test('prepends scalar inverse ownership to caller filters without a lookup', async () => {
    const parentId = '507f1f77bcf86cd799439011';
    const ChildType = new GraphQLObjectType({
      name: 'RuntimeScalarInverseChild',
      fields: {
        serie_id: { type: GraphQLID },
        label: { type: GraphQLString },
      },
    });
    const adapter = createMongoAdapter();
    adapter.bind({ getModel: () => null });
    const Model = {
      schema: new mongoose.Schema({ serie_id: mongoose.Schema.Types.ObjectId }),
      aggregate: async (pipeline) => pipeline,
    };

    const pipeline = await adapter.findChildren(
      Model,
      ChildType,
      'serie_id',
      parentId,
      { label: { value: 'wanted' } },
      null,
    );

    expect(pipeline[0]).toEqual({
      $match: { serie_id: new mongoose.Types.ObjectId(parentId) },
    });
    expect(pipeline).toContainEqual({ $match: { label: 'wanted' } });
    expect(pipeline.some((stage) => stage.$lookup)).toBe(false);
  });

  test('preserves required and item-nullable list wrappers in generated inputs', () => {
    const runtime = createRuntime(createMemoryAdapter());
    const { EmbeddedType, ChildType, ParentType } = createWrappedListFixture();
    runtime.addNoEndpointType(EmbeddedType);
    runtime.addNoEndpointType(ChildType);
    runtime.connect(null, ParentType, 'runtimeWrappedParent', 'runtimeWrappedParents');

    const sdl = printSchema(runtime.createSchema());
    const addInput = sdl.match(/input RuntimeWrappedParentInput \{[^}]+\}/s)[0];
    const updateInput = sdl.match(/input RuntimeWrappedParentInputForUpdate \{[^}]+\}/s)[0];

    expect(addInput).toContain('requiredTags: [String!]!');
    expect(updateInput).toContain('requiredTags: [String!]');
    expect(addInput).toContain('requiredEmbeds: [RuntimeWrappedEmbeddedInput!]!');
    expect(updateInput).toContain('requiredEmbeds: [RuntimeWrappedEmbeddedInputForUpdate!]');
    expect(addInput).toContain('nullableEmbeds: [RuntimeWrappedEmbeddedInput]');
    expect(updateInput).toContain('nullableEmbeds: [RuntimeWrappedEmbeddedInputForUpdate]');
    expect(addInput).toContain('requiredChildren: OneToManyRuntimeWrappedParentArequiredChildren!');
    expect(updateInput).toContain('requiredChildren: OneToManyRuntimeWrappedParentUrequiredChildren');
    expect(sdl).toContain('added: [RuntimeWrappedParentARuntimeWrappedChildInputForParentKey!]');
    expect(sdl).toMatch(/requiredChildren\([^)]*\): \[RuntimeWrappedChild!]!/);
  });

  test('materializes wrapped lists and retains null embedded list items', async () => {
    const adapter = createMemoryAdapter();
    const runtime = createRuntime(adapter);
    const { EmbeddedType, ChildType, ParentType } = createWrappedListFixture();
    runtime.addNoEndpointType(EmbeddedType);
    runtime.addNoEndpointType(ChildType);
    runtime.connect(null, ParentType, 'runtimeWrappedParent', 'runtimeWrappedParents');
    const schema = runtime.createSchema();

    const result = await graphql({
      schema,
      source: `
        mutation {
          addruntimeWrappedParent(input: {
            requiredTags: ["one", "two"]
            requiredEmbeds: [{ value: "required" }]
            nullableEmbeds: [null, { value: "nullable" }]
            requiredChildren: { added: [{ value: "child" }] }
          }) {
            id
            requiredTags
            requiredEmbeds { value }
            nullableEmbeds { value }
          }
        }
      `,
    });

    expect(result.errors).toBeUndefined();
    expect(result.data.addruntimeWrappedParent).toEqual({
      id: '1',
      requiredTags: ['one', 'two'],
      requiredEmbeds: [{ value: 'required' }],
      nullableEmbeds: [null, { value: 'nullable' }],
    });
    expect(adapter.getRecords()).toEqual([
      expect.objectContaining({
        _id: '1',
        requiredTags: ['one', 'two'],
        requiredEmbeds: [{ value: 'required' }],
        nullableEmbeds: [null, { value: 'nullable' }],
      }),
      expect.objectContaining({ _id: '2', value: 'child', parentKey: '1' }),
    ]);
  });

  test('does not retain a registration rejected by the adapter', () => {
    const adapter = createMemoryAdapter();
    adapter.validateRegistration = () => {
      throw new Error('unsupported registration');
    };
    const runtime = createRuntime(adapter);

    expect(() => runtime.connect(
      null,
      createType('RejectedRuntimeItem'),
      'rejectedItem',
      'rejectedItems',
    )).toThrow('unsupported registration');
    expect(runtime.getRegistrations()).toEqual([]);
  });

  test('passes collection creation policy to adapter preparation', () => {
    const adapter = createMemoryAdapter();
    const runtime = createRuntime(adapter);
    runtime.preventCreatingCollection(true);
    runtime.connect(null, createType('PreparedRuntimeItem'), 'preparedItem', 'preparedItems');

    runtime.createSchema();

    expect(adapter.prepare).toHaveBeenCalledWith(runtime.getRegistrations(), {
      createCollection: false,
    });
  });

  test('keeps registrations and middleware isolated between instances', async () => {
    const firstAdapter = createMemoryAdapter();
    const secondAdapter = createMemoryAdapter();
    const first = createRuntime(firstAdapter);
    const second = createRuntime(secondAdapter);
    const FirstType = createType('FirstRuntimeItem');
    const SecondType = createType('SecondRuntimeItem');
    const firstMiddleware = vi.fn((params, next) => next());
    const secondMiddleware = vi.fn((params, next) => next());

    first.use(firstMiddleware);
    second.use(secondMiddleware);
    first.connect(null, FirstType, 'firstItem', 'firstItems');
    second.connect(null, SecondType, 'secondItem', 'secondItems');

    const firstSchema = first.createSchema();
    const secondSchema = second.createSchema();
    await graphql({ schema: firstSchema, source: '{ firstItems { name } }' });

    expect(firstSchema.getQueryType().getFields()).toHaveProperty('firstItems');
    expect(firstSchema.getQueryType().getFields()).not.toHaveProperty('secondItems');
    expect(secondSchema.getQueryType().getFields()).toHaveProperty('secondItems');
    expect(secondSchema.getQueryType().getFields()).not.toHaveProperty('firstItems');
    expect(first.getRegistrations()).toEqual([
      expect.objectContaining({ gqltype: FirstType, endpoint: true }),
    ]);
    expect(second.getRegistrations()).toEqual([
      expect.objectContaining({ gqltype: SecondType, endpoint: true }),
    ]);
    expect(firstMiddleware).toHaveBeenCalledOnce();
    expect(secondMiddleware).not.toHaveBeenCalled();
    expect(firstAdapter.getBinding().getType('FirstRuntimeItem')).toBe(FirstType);
    expect(secondAdapter.getBinding().getType('FirstRuntimeItem')).toBeUndefined();
  });

  test('runs generated mutations through the adapter record contract', async () => {
    const adapter = createMemoryAdapter();
    const runtime = createRuntime(adapter);
    const ItemType = createType('RuntimeMutationItem');
    const events = [];
    const controller = {
      onSaving(record, args, session) {
        events.push(['saving', record._id, args.name, session.adapter]);
      },
      onSaved(record, args, session) {
        events.push(['saved', record._id, args.name, session.adapter]);
      },
      onUpdating(id, update, session) {
        events.push(['updating', id, update.set.name, session.adapter]);
      },
    };

    runtime.connect(null, ItemType, 'runtimeItem', 'runtimeItems', controller);
    const schema = runtime.createSchema();
    const added = await graphql({
      schema,
      source: 'mutation { addruntimeItem(input: { name: "before" }) { id name } }',
    });
    const id = added.data.addruntimeItem.id;
    const updated = await graphql({
      schema,
      source: `mutation { updateruntimeItem(input: { id: "${id}", name: "after" }) { id name } }`,
    });
    const deleted = await graphql({
      schema,
      source: `mutation { deleteruntimeItem(id: "${id}") { id name } }`,
    });

    expect(added.errors).toBeUndefined();
    expect(added.data.addruntimeItem).toEqual({ id: '1', name: 'before' });
    expect(updated.errors).toBeUndefined();
    expect(updated.data.updateruntimeItem).toEqual({ id: '1', name: 'after' });
    expect(deleted.errors).toBeUndefined();
    expect(deleted.data.deleteruntimeItem).toEqual({ id: '1', name: 'after' });
    expect(events).toEqual([
      ['saving', '1', 'before', 'memory'],
      ['saved', '1', 'before', 'memory'],
      ['updating', '1', 'after', 'memory'],
    ]);
  });

  test('accepts adapter-decoded enum values when checking state transitions', async () => {
    const adapter = createMemoryAdapter();
    adapter.stateValue = (state) => state.value;
    const saveRecord = adapter.saveRecord;
    adapter.saveRecord = async (...args) => {
      const record = await saveRecord(...args);
      if (record.state === 'DRAFT') record.state = 'draft';
      return record;
    };
    const runtime = createRuntime(adapter);
    const State = new GraphQLEnumType({
      name: 'RuntimeState',
      values: {
        DRAFT: { value: 'draft' },
        PUBLISHED: { value: 'published' },
      },
    });
    const ItemType = new GraphQLObjectType({
      name: 'RuntimeStateItem',
      fields: {
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        state: { type: State },
      },
    });
    const stateMachine = {
      initialState: { name: 'DRAFT', value: 'draft' },
      actions: {
        publish: {
          from: { name: 'DRAFT', value: 'draft' },
          to: { name: 'PUBLISHED', value: 'published' },
        },
      },
    };

    runtime.connect(null, ItemType, 'runtimeStateItem', 'runtimeStateItems', null, null, stateMachine);
    const schema = runtime.createSchema();
    const added = await graphql({
      schema,
      source: 'mutation { addruntimeStateItem(input: { name: "item" }) { id state } }',
    });
    const transitioned = await graphql({
      schema,
      source: `mutation { publish_runtimeStateItem(input: { id: "${added.data.addruntimeStateItem.id}" }) { id state } }`,
    });

    expect(transitioned.errors).toBeUndefined();
    expect(transitioned.data.publish_runtimeStateItem).toEqual({ id: '1', state: 'PUBLISHED' });
  });

  test('uses one adapter state representation when enum names and values overlap', async () => {
    const adapter = createMemoryAdapter();
    adapter.stateValue = (state) => state.value;
    const saveRecord = adapter.saveRecord;
    adapter.saveRecord = async (...args) => {
      const record = await saveRecord(...args);
      if (record.state === 'DRAFT') record.state = 'PUBLISHED';
      return record;
    };
    const runtime = createRuntime(adapter);
    const State = new GraphQLEnumType({
      name: 'RuntimeOverlappingState',
      values: {
        DRAFT: { value: 'PUBLISHED' },
        PUBLISHED: { value: 'FINAL' },
        FINAL: { value: 'DONE' },
      },
    });
    const ItemType = new GraphQLObjectType({
      name: 'RuntimeOverlappingStateItem',
      fields: {
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        state: { type: State },
      },
    });
    const stateMachine = {
      initialState: { name: 'DRAFT', value: 'PUBLISHED' },
      actions: {
        publish: {
          from: { name: 'DRAFT', value: 'PUBLISHED' },
          to: { name: 'PUBLISHED', value: 'FINAL' },
        },
        finish: {
          from: { name: 'PUBLISHED', value: 'FINAL' },
          to: { name: 'FINAL', value: 'DONE' },
        },
      },
    };

    runtime.connect(
      null,
      ItemType,
      'runtimeOverlappingStateItem',
      'runtimeOverlappingStateItems',
      null,
      null,
      stateMachine,
    );
    const schema = runtime.createSchema();
    const added = await graphql({
      schema,
      source: 'mutation { addruntimeOverlappingStateItem(input: { name: "item" }) { id state } }',
    });
    const id = added.data.addruntimeOverlappingStateItem.id;
    const invalidFinish = await graphql({
      schema,
      source: `mutation { finish_runtimeOverlappingStateItem(input: { id: "${id}" }) { state } }`,
    });
    const published = await graphql({
      schema,
      source: `mutation { publish_runtimeOverlappingStateItem(input: { id: "${id}" }) { state } }`,
    });
    const finished = await graphql({
      schema,
      source: `mutation { finish_runtimeOverlappingStateItem(input: { id: "${id}" }) { state } }`,
    });

    expect(invalidFinish.errors?.[0].extensions.code).toBe('BAD_REQUEST');
    expect(published.errors).toBeUndefined();
    expect(published.data.publish_runtimeOverlappingStateItem.state).toBe('PUBLISHED');
    expect(finished.errors).toBeUndefined();
    expect(finished.data.finish_runtimeOverlappingStateItem.state).toBe('FINAL');
  });
});

const BOUND_TO_OTHER_RUNTIME = expect.objectContaining({
  extensions: expect.objectContaining({ code: 'TYPE_BOUND_TO_OTHER_RUNTIME', status: 409 }),
});

const createLibraryTypes = (prefix, { listRelation = false } = {}) => {
  const Author = new GraphQLObjectType({
    name: `${prefix}Author`,
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      ...(listRelation ? {
        books: {
          type: new GraphQLList(Book),
          extensions: { relation: { embedded: false, connectionField: 'author' } },
        },
      } : {}),
    }),
  });
  const Book = new GraphQLObjectType({
    name: `${prefix}Book`,
    fields: () => ({
      id: { type: GraphQLID },
      title: { type: GraphQLString },
      author: { type: Author, extensions: { relation: { embedded: false, connectionField: 'authorId' } } },
    }),
  });
  return { Author, Book };
};

const createStoreAdapter = (records = {}) => ({
  prepare: vi.fn(),
  validateRegistration: vi.fn(),
  createModel: vi.fn((gqltype) => ({ name: gqltype.name })),
  castId: (value) => String(value),
  withTransaction: async (session, body) => body(session || {}),
  getById: vi.fn(async (Model, id) => (records[Model.name] ?? []).find((record) => record._id === String(id)) ?? null),
  find: vi.fn(async (Model) => records[Model.name] ?? []),
  count: async () => 0,
  aggregate: async () => [],
  findChildren: vi.fn(async () => []),
});

const tenantRecords = (tenant, prefix) => ({
  [`${prefix}Author`]: [{ _id: '1', name: `${tenant} author` }],
  [`${prefix}Book`]: [{ _id: '10', title: `${tenant} book`, authorId: '1' }],
});

const registerLibrary = (runtime, { Author, Book }) => {
  runtime.connect(null, Author, 'author', 'authors');
  runtime.connect(null, Book, 'book', 'books');
};

describe('runtime type ownership', () => {
  test('rejects a schema whose relation resolvers another runtime generated', async () => {
    const types = createLibraryTypes('OwnedSingle');
    const firstAdapter = createStoreAdapter(tenantRecords('first', 'OwnedSingle'));
    const secondAdapter = createStoreAdapter(tenantRecords('second', 'OwnedSingle'));
    const first = createRuntime(firstAdapter);
    const second = createRuntime(secondAdapter);
    registerLibrary(first, types);
    registerLibrary(second, types);

    const schema = first.createSchema();

    expect(() => second.createSchema()).toThrow(BOUND_TO_OTHER_RUNTIME);
    expect(secondAdapter.prepare).not.toHaveBeenCalled();
    expect(secondAdapter.createModel).not.toHaveBeenCalled();
    const result = await graphql({ schema, source: '{ books { title author { name } } }', contextValue: {} });
    expect(result.errors).toBeUndefined();
    expect(result.data.books).toEqual([{ title: 'first book', author: { name: 'first author' } }]);
    expect(secondAdapter.getById).not.toHaveBeenCalled();
  });

  test('reports a shared list relation as a bound type instead of duplicate filter types', () => {
    const types = createLibraryTypes('OwnedList', { listRelation: true });
    const first = createRuntime(createStoreAdapter());
    const second = createRuntime(createStoreAdapter());
    registerLibrary(first, types);
    registerLibrary(second, types);
    first.createSchema();

    expect(() => second.createSchema()).toThrow(BOUND_TO_OTHER_RUNTIME);
    expect(() => second.createSchema()).toThrow('OwnedListAuthor');
  });

  test('binds types to the runtime that creates a schema first', async () => {
    const types = createLibraryTypes('OwnedOrder');
    const first = createRuntime(createStoreAdapter(tenantRecords('first', 'OwnedOrder')));
    const second = createRuntime(createStoreAdapter(tenantRecords('second', 'OwnedOrder')));
    registerLibrary(first, types);
    registerLibrary(second, types);

    const schema = second.createSchema();

    expect(() => first.createSchema()).toThrow(BOUND_TO_OTHER_RUNTIME);
    const result = await graphql({ schema, source: '{ books { author { name } } }', contextValue: {} });
    expect(result.data.books).toEqual([{ author: { name: 'second author' } }]);
  });

  test('rejects registering a bound type in another runtime without recording it', () => {
    const types = createLibraryTypes('OwnedRegistration');
    const first = createRuntime(createStoreAdapter());
    registerLibrary(first, types);
    first.createSchema();
    const secondAdapter = createStoreAdapter();
    const second = createRuntime(secondAdapter);

    second.connect(null, types.Author, 'author', 'authors');

    expect(() => second.connect(null, types.Book, 'book', 'books')).toThrow(BOUND_TO_OTHER_RUNTIME);
    expect(() => second.addNoEndpointType(types.Book)).toThrow(BOUND_TO_OTHER_RUNTIME);
    expect(second.getRegistrations().map(({ gqltype }) => gqltype)).toEqual([types.Author]);
    expect(secondAdapter.validateRegistration).toHaveBeenCalledTimes(1);
  });

  test('rejects bound types reached through relations or custom mutation results', () => {
    const types = createLibraryTypes('OwnedReach');
    const first = createRuntime(createStoreAdapter());
    registerLibrary(first, types);
    first.createSchema();

    const viaMutation = createRuntime(createStoreAdapter());
    viaMutation.connect(null, new GraphQLObjectType({
      name: 'OwnedReachOther',
      fields: { id: { type: GraphQLID }, label: { type: GraphQLString } },
    }), 'other', 'others');
    viaMutation.registerMutation('pickBook', 'Returns a book', new GraphQLInputObjectType({
      name: 'OwnedReachPick',
      fields: { id: { type: GraphQLID } },
    }), types.Book, async () => null);
    expect(() => viaMutation.createSchema()).toThrow(BOUND_TO_OTHER_RUNTIME);

    const viaRelation = createRuntime(createStoreAdapter());
    viaRelation.connect(null, new GraphQLObjectType({
      name: 'OwnedReachReview',
      fields: {
        id: { type: GraphQLID },
        book: { type: types.Book, extensions: { relation: { embedded: false, connectionField: 'bookId' } } },
      },
    }), 'review', 'reviews');
    expect(() => viaRelation.createSchema()).toThrow(BOUND_TO_OTHER_RUNTIME);
  });

  test('rejects bound types reached through the interfaces of a custom mutation result', () => {
    const types = createLibraryTypes('OwnedInterface');
    const first = createRuntime(createStoreAdapter());
    registerLibrary(first, types);
    first.createSchema();
    const Other = new GraphQLObjectType({ name: 'OwnedInterfaceOther', fields: { label: { type: GraphQLString } } });
    const Pick = new GraphQLUnionType({ name: 'OwnedInterfacePick', types: [Other, types.Book] });
    const HasPick = new GraphQLInterfaceType({ name: 'OwnedInterfaceHasPick', fields: { pick: { type: Pick } } });
    const Wrapper = new GraphQLObjectType({
      name: 'OwnedInterfaceWrapper',
      interfaces: [HasPick],
      fields: { pick: { type: Other } },
    });
    const secondAdapter = createStoreAdapter();
    const second = createRuntime(secondAdapter);
    second.connect(null, createType('OwnedInterfaceThing'), 'thing', 'things');
    second.registerMutation('wrap', 'Wraps a pick', new GraphQLInputObjectType({
      name: 'OwnedInterfaceInput',
      fields: { id: { type: GraphQLID } },
    }), Wrapper, async () => null);

    expect(() => second.createSchema()).toThrow(BOUND_TO_OTHER_RUNTIME);
    expect(() => second.createSchema()).toThrow('OwnedInterfaceBook');
    expect(secondAdapter.prepare).not.toHaveBeenCalled();
  });

  describe('copied relation fields', () => {
    const spreadFields = (Book) => new GraphQLObjectType({
      name: `${Book.name}Admin`,
      fields: () => ({ ...Book.toConfig().fields, notes: { type: GraphQLString } }),
    });
    const copyType = (Book) => new GraphQLObjectType(Book.toConfig());
    const wrapWithAuth = (schema) => auth.createAuthPlugin({}, { defaultPolicy: 'DENY' }).onSchemaChange({ schema });
    const withoutResolver = (field) => {
      const copy = { ...field };
      delete copy.resolve;
      return copy;
    };

    test.each([
      ['a type that spreads the fields in a thunk defined at module load', 'OwnedSpread', spreadFields, true],
      ['a toConfig() copy', 'OwnedClone', copyType, false],
    ])('rejects %s once another runtime generated the resolvers', (label, prefix, copy, defineEarly) => {
      const types = createLibraryTypes(prefix);
      const early = defineEarly ? copy(types.Book) : null;
      const firstAdapter = createStoreAdapter(tenantRecords('first', prefix));
      const first = createRuntime(firstAdapter);
      registerLibrary(first, types);
      first.createSchema();
      const Copy = early ?? copy(types.Book);
      const secondAdapter = createStoreAdapter(tenantRecords('second', prefix));
      const second = createRuntime(secondAdapter);
      second.connect(null, types.Author, 'author', 'authors');
      second.connect(null, Copy, 'book', 'books');

      expect(() => second.createSchema()).toThrow(BOUND_TO_OTHER_RUNTIME);
      expect(() => second.createSchema()).toThrow(`Field ${Copy.name}.author`);
      expect(secondAdapter.prepare).not.toHaveBeenCalled();
      expect(secondAdapter.createModel).not.toHaveBeenCalled();
      expect(firstAdapter.getById).not.toHaveBeenCalled();
    });

    test('rejects copies of single and list relations after an auth plugin wrapped their resolvers', () => {
      const types = createLibraryTypes('OwnedWrapped');
      const Item = createType('OwnedWrappedItem');
      const Shelf = new GraphQLObjectType({
        name: 'OwnedWrappedShelf',
        fields: () => ({
          id: { type: GraphQLID },
          items: { type: new GraphQLList(Item), extensions: { relation: { embedded: false, connectionField: 'shelf' } } },
        }),
      });
      const first = createRuntime(createStoreAdapter());
      registerLibrary(first, types);
      first.connect(null, Item, 'item', 'items');
      first.connect(null, Shelf, 'shelf', 'shelves');
      const schema = first.createSchema();
      const generatedAuthor = types.Book.getFields().author.resolve;
      const generatedItems = Shelf.getFields().items.resolve;
      wrapWithAuth(schema);

      const BookCopy = copyType(types.Book);
      const ShelfCopy = copyType(Shelf);
      expect(BookCopy.getFields().author.resolve).not.toBe(generatedAuthor);
      expect(ShelfCopy.getFields().items.resolve).not.toBe(generatedItems);
      const books = createRuntime(createStoreAdapter());
      books.connect(null, types.Author, 'author', 'authors');
      books.connect(null, BookCopy, 'book', 'books');
      const shelves = createRuntime(createStoreAdapter());
      shelves.connect(null, Item, 'item', 'items');
      shelves.connect(null, ShelfCopy, 'shelf', 'shelves');

      expect(() => books.createSchema()).toThrow(BOUND_TO_OTHER_RUNTIME);
      expect(() => books.createSchema()).toThrow('Field OwnedWrappedBook.author');
      expect(() => shelves.createSchema()).toThrow(BOUND_TO_OTHER_RUNTIME);
      expect(() => shelves.createSchema()).toThrow('Field OwnedWrappedShelf.items');
    });

    test('rejects copies that rebuild relation extensions after an auth plugin wrapped the resolvers', () => {
      const types = createLibraryTypes('OwnedRebuilt');
      const Item = createType('OwnedRebuiltItem');
      const Shelf = new GraphQLObjectType({
        name: 'OwnedRebuiltShelf',
        fields: () => ({
          id: { type: GraphQLID },
          items: { type: new GraphQLList(Item), extensions: { relation: { embedded: false, connectionField: 'shelf' } } },
        }),
      });
      const firstAdapter = createStoreAdapter(tenantRecords('first', 'OwnedRebuilt'));
      const first = createRuntime(firstAdapter);
      registerLibrary(first, types);
      first.connect(null, Item, 'item', 'items');
      first.connect(null, Shelf, 'shelf', 'shelves');
      wrapWithAuth(first.createSchema());
      const rebuild = (type, fieldName) => new GraphQLObjectType({
        name: `${type.name}Admin`,
        fields: () => {
          const fields = type.toConfig().fields;
          const field = fields[fieldName];
          return { ...fields, [fieldName]: { ...field, extensions: { ...field.extensions, readOnly: true } } };
        },
      });
      const BookAdmin = rebuild(types.Book, 'author');
      const ShelfAdmin = rebuild(Shelf, 'items');
      const secondAdapter = createStoreAdapter();
      const books = createRuntime(secondAdapter);
      books.connect(null, types.Author, 'author', 'authors');
      books.connect(null, BookAdmin, 'bookAdmin', 'bookAdmins');
      const shelves = createRuntime(createStoreAdapter());
      shelves.connect(null, Item, 'item', 'items');
      shelves.connect(null, ShelfAdmin, 'shelfAdmin', 'shelfAdmins');

      expect(BookAdmin.getFields().author.extensions).not.toBe(types.Book.getFields().author.extensions);
      expect(() => books.createSchema()).toThrow(BOUND_TO_OTHER_RUNTIME);
      expect(() => books.createSchema()).toThrow('Field OwnedRebuiltBookAdmin.author');
      expect(() => shelves.createSchema()).toThrow(BOUND_TO_OTHER_RUNTIME);
      expect(() => shelves.createSchema()).toThrow('Field OwnedRebuiltShelfAdmin.items');
      expect(secondAdapter.prepare).not.toHaveBeenCalled();
      expect(firstAdapter.getById).not.toHaveBeenCalled();
    });

    test('accepts a copy without resolvers and generates its own', async () => {
      const types = createLibraryTypes('OwnedStripped');
      const firstAdapter = createStoreAdapter(tenantRecords('first', 'OwnedStripped'));
      const first = createRuntime(firstAdapter);
      registerLibrary(first, types);
      first.createSchema();
      const BookCopy = new GraphQLObjectType({
        name: 'OwnedStrippedBookCopy',
        fields: () => Object.fromEntries(Object.entries(types.Book.toConfig().fields)
          .map(([name, field]) => [name, withoutResolver(field)])),
      });
      const second = createRuntime(createStoreAdapter({
        OwnedStrippedAuthor: [{ _id: '1', name: 'second author' }],
        OwnedStrippedBookCopy: [{ _id: '10', title: 'second book', authorId: '1' }],
      }));
      second.connect(null, types.Author, 'author', 'authors');
      second.connect(null, BookCopy, 'bookCopy', 'bookCopies');

      expect(BookCopy.getFields().author.extensions).toBe(types.Book.getFields().author.extensions);
      const schema = second.createSchema();

      const result = await graphql({ schema, source: '{ bookCopies { title author { name } } }', contextValue: {} });
      expect(result.errors).toBeUndefined();
      expect(result.data.bookCopies).toEqual([{ title: 'second book', author: { name: 'second author' } }]);
      expect(firstAdapter.getById).not.toHaveBeenCalled();
      expect(() => second.createSchema()).not.toThrow();
    });

    test.each([
      ['without a resolver', withoutResolver],
      ['with an application resolver', (field) => ({ ...field, resolve: () => null })],
    ])('accepts an interface field copied from a bound type %s', async (label, copyField) => {
      const prefix = `OwnedInterfaceCopy${label.includes('application') ? 'App' : 'Bare'}`;
      const types = createLibraryTypes(prefix);
      const first = createRuntime(createStoreAdapter());
      registerLibrary(first, types);
      first.createSchema();
      const BookLike = new GraphQLInterfaceType({
        name: `${prefix}BookLike`,
        fields: () => ({ author: copyField(types.Book.toConfig().fields.author) }),
      });
      const Paper = new GraphQLObjectType({
        name: `${prefix}Paper`,
        interfaces: [BookLike],
        fields: () => ({
          id: { type: GraphQLID },
          title: { type: GraphQLString },
          author: { type: types.Author, resolve: () => ({ name: 'paper author' }) },
        }),
      });
      const second = createRuntime(createStoreAdapter({ [`${prefix}Paper`]: [{ _id: '1', title: 'paper' }] }));
      second.connect(null, types.Author, 'author', 'authors');
      second.connect(null, Paper, 'paper', 'papers');

      expect(BookLike.getFields().author.extensions).toBe(types.Book.getFields().author.extensions);
      const schema = second.createSchema();

      const result = await graphql({ schema, source: '{ papers { title author { name } } }', contextValue: {} });
      expect(result.errors).toBeUndefined();
      expect(result.data.papers).toEqual([{ title: 'paper', author: { name: 'paper author' } }]);
    });

    test('accepts a copy made before another runtime generated the resolvers', async () => {
      const types = createLibraryTypes('OwnedEarlyCopy');
      const Copy = copyType(types.Book);
      const firstAdapter = createStoreAdapter(tenantRecords('first', 'OwnedEarlyCopy'));
      const first = createRuntime(firstAdapter);
      registerLibrary(first, types);
      first.createSchema();
      const second = createRuntime(createStoreAdapter(tenantRecords('second', 'OwnedEarlyCopy')));
      second.connect(null, types.Author, 'author', 'authors');
      second.connect(null, Copy, 'book', 'books');

      const schema = second.createSchema();

      const result = await graphql({ schema, source: '{ books { title author { name } } }', contextValue: {} });
      expect(result.errors).toBeUndefined();
      expect(result.data.books).toEqual([{ title: 'second book', author: { name: 'second author' } }]);
      expect(firstAdapter.getById).not.toHaveBeenCalled();
      expect(() => second.createSchema()).not.toThrow();
    });
  });

  test('reserves unregistered relation types that an earlier schema reaches', async () => {
    const types = createLibraryTypes('OwnedReserved');
    const first = createRuntime(createStoreAdapter(tenantRecords('first', 'OwnedReserved')));
    first.connect(null, new GraphQLObjectType({
      name: 'OwnedReservedOther',
      fields: { id: { type: GraphQLID }, label: { type: GraphQLString } },
    }), 'other', 'others');
    first.registerMutation('pickBook', 'Returns a book', new GraphQLInputObjectType({
      name: 'OwnedReservedPick',
      fields: { id: { type: GraphQLID } },
    }), types.Book, async () => ({ _id: '10', title: 'first book', authorId: '1' }));
    const schema = first.createSchema();
    const secondAdapter = createStoreAdapter(tenantRecords('second', 'OwnedReserved'));
    const second = createRuntime(secondAdapter);
    second.connect(null, types.Author, 'author', 'authors');

    expect(() => second.connect(null, types.Book, 'book', 'books')).toThrow(BOUND_TO_OTHER_RUNTIME);
    expect(() => second.addNoEndpointType(types.Book)).toThrow(BOUND_TO_OTHER_RUNTIME);
    const source = 'mutation { pickBook(input: { id: "10" }) { title author { name } } }';
    const result = await graphql({ schema, source, contextValue: {} });
    expect(result.data.pickBook).toEqual({ title: 'first book', author: null });
    expect(secondAdapter.getById).not.toHaveBeenCalled();
    expect(types.Book.getFields().author.resolve).toBeUndefined();
  });

  test('lets the reserving runtime register the type and rebuild its schema', async () => {
    const types = createLibraryTypes('OwnedReclaimed');
    const runtime = createRuntime(createStoreAdapter(tenantRecords('first', 'OwnedReclaimed')));
    runtime.connect(null, types.Author, 'author', 'authors');
    runtime.registerMutation('pickBook', 'Returns a book', new GraphQLInputObjectType({
      name: 'OwnedReclaimedPick',
      fields: { id: { type: GraphQLID } },
    }), types.Book, async () => ({ _id: '10', title: 'first book', authorId: '1' }));
    runtime.createSchema();
    runtime.connect(null, types.Book, 'book', 'books');

    const schema = runtime.createSchema();

    const result = await graphql({ schema, source: '{ books { title author { name } } }', contextValue: {} });
    expect(result.errors).toBeUndefined();
    expect(result.data.books).toEqual([{ title: 'first book', author: { name: 'first author' } }]);
  });

  test('keeps the binding after an auth plugin wraps generated resolvers', () => {
    const types = createLibraryTypes('OwnedAuth');
    const first = createRuntime(createStoreAdapter());
    registerLibrary(first, types);
    const schema = first.createSchema();
    const generated = types.Book.getFields().author.resolve;

    auth.createAuthPlugin({}, { defaultPolicy: 'DENY' }).onSchemaChange({ schema });

    expect(types.Book.getFields().author.resolve).not.toBe(generated);
    const second = createRuntime(createStoreAdapter());
    expect(() => second.connect(null, types.Book, 'book', 'books')).toThrow(BOUND_TO_OTHER_RUNTIME);
  });

  test('shares types without generated relation resolvers', async () => {
    const Item = new GraphQLObjectType({
      name: 'OwnedSharedItem',
      fields: { id: { type: GraphQLID }, name: { type: GraphQLString } },
    });
    const Tag = new GraphQLObjectType({ name: 'OwnedSharedTag', fields: { label: { type: GraphQLString } } });
    const Note = new GraphQLObjectType({
      name: 'OwnedSharedNote',
      fields: {
        id: { type: GraphQLID },
        tags: { type: new GraphQLList(Tag), extensions: { relation: { embedded: true } } },
        item: {
          type: Item,
          extensions: { relation: { embedded: false, connectionField: 'itemId' } },
          resolve: () => null,
        },
      },
    });
    const schemas = ['first', 'second'].map((tenant) => {
      const runtime = createRuntime(createStoreAdapter({ OwnedSharedItem: [{ _id: '1', name: tenant }] }));
      runtime.connect(null, Item, 'item', 'items');
      runtime.addNoEndpointType(Tag);
      runtime.connect(null, Note, 'note', 'notes');
      return runtime.createSchema();
    });

    const results = await Promise.all(schemas.map((schema) => graphql({
      schema, source: '{ items { name } }', contextValue: {},
    })));

    expect(results.map(({ data }) => data.items)).toEqual([[{ name: 'first' }], [{ name: 'second' }]]);
  });

  test('rebuilds schemas of the runtime that bound the types', () => {
    const types = createLibraryTypes('OwnedRepeat', { listRelation: true });
    const runtime = createRuntime(createStoreAdapter());
    registerLibrary(runtime, types);

    const first = runtime.createSchema();
    const second = runtime.createSchema();

    expect(printSchema(second)).toBe(printSchema(first));
  });

  test('rejects types the MongoDB runtime bound in a PostgreSQL runtime', () => {
    const types = createLibraryTypes('OwnedMixed');
    const mongo = createRuntime(createMongoAdapter());
    mongo.preventCreatingCollection(true);
    try {
      registerLibrary(mongo, types);
      mongo.createSchema();
      const postgres = createPostgres({ pool: { connect: vi.fn(), query: vi.fn() }, schema: 'owned_mixed' });

      expect(() => postgres.connect(null, types.Book, 'book', 'books')).toThrow(BOUND_TO_OTHER_RUNTIME);
    } finally {
      for (const { name } of Object.values(types)) {
        if (mongoose.models[name]) mongoose.deleteModel(name);
      }
    }
  });
});
