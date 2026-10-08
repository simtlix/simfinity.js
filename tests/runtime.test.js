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
  validateSchema,
} from 'graphql';
import mongoose from 'mongoose';

import {
  auth, buildErrorFormatter, createRuntime, InternalServerError, SimfinityError,
} from '../packages/core/src/index.js';
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
      ['without a resolver', withoutResolver, 'Bare'],
      ['with an application resolver', (field) => ({ ...field, resolve: () => null }), 'App'],
      // graphql-js never runs an interface field's resolver, so the generated one is harmless there.
      ['with the generated resolver', (field) => field, 'Generated'],
    ])('accepts an interface field copied from a bound type %s', async (label, copyField, suffix) => {
      const prefix = `OwnedInterfaceCopy${suffix}`;
      const types = createLibraryTypes(prefix);
      const firstAdapter = createStoreAdapter();
      const first = createRuntime(firstAdapter);
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
      expect(firstAdapter.getById).not.toHaveBeenCalled();
      expect(firstAdapter.find).not.toHaveBeenCalled();
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

const cloneRecord = (record) => (record == null ? null : JSON.parse(JSON.stringify(record)));

// Records keep their identity in `_id`, as MongoDB documents do, unless `withId` also sets `id`.
const createKeyedAdapter = ({
  castId = String, firstId = 1, withId = false, getByIds = false,
} = {}) => {
  const records = new Map();
  let nextId = firstId;
  const key = (Model, id) => `${Model.name}:${castId(id)}`;
  const ofModel = (Model) => [...records.entries()]
    .filter(([entry]) => entry.startsWith(`${Model.name}:`)).map(([, record]) => cloneRecord(record));
  const adapter = {
    bind() {},
    prepare: vi.fn(),
    createModel: vi.fn((gqltype) => ({ name: gqltype.name })),
    castId,
    withTransaction: async (session, body) => body(session || {}),
    newRecord(Model, data) {
      const id = castId(nextId++);
      return { ...cloneRecord(data), _id: id, ...(withId ? { id } : {}) };
    },
    saveRecord: vi.fn(async (Model, record) => {
      records.set(key(Model, record._id), record);
      return record;
    }),
    toObject: cloneRecord,
    getById: vi.fn(async (Model, id) => cloneRecord(records.get(key(Model, id)))),
    prepareUpdate: (set, unset) => ({ set, unset }),
    update: vi.fn(async (Model, id, update) => {
      const current = records.get(key(Model, id));
      if (!current) return null;
      for (const field of Object.keys(update.unset)) delete current[field];
      Object.assign(current, cloneRecord(update.set));
      return cloneRecord(current);
    }),
    delete: vi.fn(async () => null),
    find: vi.fn(async (Model) => ofModel(Model)),
    count: async () => 0,
    aggregate: async () => [],
    findChildren: vi.fn(async (Model, gqltype, field, parentId) => ofModel(Model)
      .filter((record) => record[field] === parentId)),
    seed: (typeName, record) => records.set(`${typeName}:${castId(record._id ?? record.id)}`, cloneRecord(record)),
    getRecords: (typeName) => ofModel({ name: typeName }),
  };
  if (getByIds) {
    adapter.getByIds = vi.fn(async (Model, ids) => ids.map((id) => records.get(key(Model, id)))
      .filter(Boolean).map(cloneRecord));
  }
  return adapter;
};

const configurationIssues = (warn) => warn.mock.calls.map(([message]) => message)
  .filter((message) => typeof message === 'string' && message.startsWith('Configuration issue:'));

describe('entity id resolution', () => {
  const createSerieTypes = (prefix, { appId } = {}) => {
    const Person = createType(`${prefix}Person`);
    const Label = createType(`${prefix}Label`);
    // Embedded-only, but with a reference, so it still gets a model.
    const Tag = new GraphQLObjectType({
      name: `${prefix}Tag`,
      fields: {
        id: { type: GraphQLString },
        label: { type: GraphQLString },
        by: { type: Person, extensions: { relation: { embedded: false, connectionField: 'byId' } } },
      },
    });
    const Serie = new GraphQLObjectType({
      name: `${prefix}Serie`,
      fields: () => ({
        id: appId ? { type: GraphQLID, resolve: appId } : { type: GraphQLID },
        title: { type: GraphQLString },
        label: { type: Label, extensions: { relation: { embedded: false } } },
        tags: { type: new GraphQLList(Tag), extensions: { relation: { embedded: true } } },
        episodes: {
          type: new GraphQLList(Episode),
          extensions: { relation: { embedded: false, connectionField: 'serie' } },
        },
      }),
    });
    const Episode = new GraphQLObjectType({
      name: `${prefix}Episode`,
      fields: () => ({
        id: { type: GraphQLID },
        title: { type: GraphQLString },
        serie: { type: Serie, extensions: { relation: { embedded: false, connectionField: 'serie' } } },
      }),
    });
    return {
      Person, Label, Tag, Serie, Episode,
    };
  };

  const register = (runtime, types, prefix) => {
    runtime.connect(null, types.Person, `${prefix}person`, `${prefix}persons`);
    runtime.addNoEndpointType(types.Label);
    runtime.addNoEndpointType(types.Tag);
    runtime.connect(null, types.Serie, `${prefix}serie`, `${prefix}series`);
    runtime.connect(null, types.Episode, `${prefix}episode`, `${prefix}episodes`);
  };

  test('resolves id for referenced no-endpoint types and types left out of the query allowlist', async () => {
    const adapter = createKeyedAdapter();
    const runtime = createRuntime(adapter);
    const types = createSerieTypes('IdEntity');
    register(runtime, types, 'idEntity');
    const schema = runtime.createSchema([types.Serie]);
    adapter.seed('IdEntityLabel', { _id: 'lab1', name: 'Label' });
    const run = (source) => graphql({ schema, source });

    const serie = await run('mutation { addidEntityserie(input: { title: "S", label: { id: "lab1" } }) { id label { id name } } }');
    const serieId = serie.data.addidEntityserie.id;
    const episode = await run(`mutation { addidEntityepisode(input: { title: "E", serie: { id: "${serieId}" } }) { id title } }`);
    const read = await run(`{ idEntityserie(id: "${serieId}") { id label { id } episodes { id title } } }`);

    expect(serie.errors).toBeUndefined();
    expect(serie.data.addidEntityserie.label).toEqual({ id: 'lab1', name: 'Label' });
    expect(episode.errors).toBeUndefined();
    const episodeId = episode.data.addidEntityepisode.id;
    expect(episodeId).toBe(adapter.getRecords('IdEntityEpisode')[0]._id);
    expect(read.errors).toBeUndefined();
    expect(read.data.idEntityserie).toEqual({
      id: serieId, label: { id: 'lab1' }, episodes: [{ id: episodeId, title: 'E' }],
    });
    expect(Object.fromEntries(runtime.getRegistrations()
      .map(({ gqltype, storedIdentity }) => [gqltype.name, storedIdentity]))).toEqual({
      IdEntityPerson: true,
      IdEntityLabel: true,
      IdEntityTag: false,
      IdEntitySerie: true,
      IdEntityEpisode: true,
    });
  });

  test('keeps the declared id of embedded-only types', async () => {
    const adapter = createKeyedAdapter();
    const runtime = createRuntime(adapter);
    const types = createSerieTypes('IdEmbedded');
    register(runtime, types, 'idEmbedded');
    const schema = runtime.createSchema();
    adapter.seed('IdEmbeddedSerie', { _id: 's1', title: 'S', tags: [{ _id: 'automatic', id: 'tag-1', label: 'T' }] });

    const result = await graphql({ schema, source: '{ idEmbeddedseries { id tags { id label } } }' });

    expect(result.errors).toBeUndefined();
    expect(result.data.idEmbeddedseries).toEqual([{ id: 's1', tags: [{ id: 'tag-1', label: 'T' }] }]);
    expect(types.Tag.getFields().id.resolve).toBeUndefined();
  });

  test('keeps an application id resolver, which still restricts id filters', async () => {
    const adapter = createKeyedAdapter();
    const runtime = createRuntime(adapter);
    const appId = (parent) => `app-${parent._id}`;
    const types = createSerieTypes('IdApplication', { appId });
    register(runtime, types, 'idApplication');
    const schema = runtime.createSchema();
    adapter.seed('IdApplicationSerie', { _id: 's1', title: 'S' });

    const read = await graphql({ schema, source: '{ idApplicationseries { id } }' });
    const filtered = await graphql({ schema, source: '{ idApplicationseries(id: { operator: EQ, value: "s1" }) { id } }' });

    expect(types.Serie.getFields().id.resolve).toBe(appId);
    expect(read.data.idApplicationseries).toEqual([{ id: 'app-s1' }]);
    expect(filtered.errors?.[0].extensions.code).toBe('FORBIDDEN_FILTER_PATH');
  });
});

describe('references to zero identifiers', () => {
  const createBookTypes = (prefix) => {
    const Author = new GraphQLObjectType({
      name: `${prefix}Author`,
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        books: {
          type: new GraphQLList(Book),
          extensions: { relation: { embedded: false, connectionField: 'author' } },
        },
      }),
    });
    const Book = new GraphQLObjectType({
      name: `${prefix}Book`,
      fields: () => ({
        id: { type: GraphQLID },
        title: { type: GraphQLString },
        author: { type: Author, extensions: { relation: { embedded: false } } },
        editor: { type: Author, extensions: { relation: { embedded: false, connectionField: 'editorId' } } },
      }),
    });
    return { Author, Book };
  };

  const build = (prefix, options) => {
    const adapter = createKeyedAdapter({
      castId: Number, firstId: 0, withId: true, ...options,
    });
    const runtime = createRuntime(adapter);
    const { Author, Book } = createBookTypes(prefix);
    runtime.connect(null, Author, `${prefix}Author`, `${prefix}Authors`);
    runtime.connect(null, Book, `${prefix}Book`, `${prefix}Books`);
    const schema = runtime.createSchema();
    return { adapter, run: (source) => graphql({ schema, source, contextValue: {} }) };
  };

  test.each([
    ['read by id', 'ZeroDirect', false],
    ['read in batches', 'ZeroBatched', true],
  ])('resolves default and aliased single references to id 0: %s', async (label, prefix, getByIds) => {
    const { adapter, run } = build(prefix, { getByIds });
    const author = await run(`mutation { add${prefix}Author(input: { name: "Zero" }) { id } }`);
    const book = await run(`mutation { add${prefix}Book(input: { title: "T", author: { id: "0" }, editor: { id: "0" } }) { id } }`);
    adapter.getById.mockClear();

    const read = await run(`{ ${prefix}Books { title author { id name } editor { id name } } }`);

    expect(author.data[`add${prefix}Author`].id).toBe('0');
    expect(book.errors).toBeUndefined();
    expect(adapter.getRecords(`${prefix}Book`)[0]).toMatchObject({ author: 0, editorId: 0 });
    expect(read.errors).toBeUndefined();
    expect(read.data[`${prefix}Books`]).toEqual([
      { title: 'T', author: { id: '0', name: 'Zero' }, editor: { id: '0', name: 'Zero' } },
    ]);
    if (getByIds) {
      expect(adapter.getByIds).toHaveBeenCalledOnce();
      expect(adapter.getById).not.toHaveBeenCalled();
    } else {
      expect(adapter.getById).toHaveBeenCalledTimes(2);
    }
  });

  test('keeps empty-string references null without reading them', async () => {
    const { adapter, run } = build('ZeroBlank', { getByIds: true });
    adapter.seed('ZeroBlankBook', { _id: 7, id: 7, title: 'Blank', author: '', editorId: '' });

    const read = await run('{ ZeroBlankBooks { title author { id } editor { id } } }');

    expect(read.errors).toBeUndefined();
    expect(read.data.ZeroBlankBooks).toEqual([{ title: 'Blank', author: null, editor: null }]);
    expect(adapter.getById).not.toHaveBeenCalled();
    expect(adapter.getByIds).not.toHaveBeenCalled();
  });

  test('reads the collection of a parent whose only identity is id 0', async () => {
    const { adapter, run } = build('ZeroParent');
    adapter.seed('ZeroParentAuthor', { id: 0, name: 'Zero' });
    adapter.seed('ZeroParentBook', { _id: 1, id: 1, title: 'T', author: 0 });

    const read = await run('{ ZeroParentAuthors { id name books { id title } } }');

    expect(read.errors).toBeUndefined();
    expect(read.data.ZeroParentAuthors).toEqual([{ id: '0', name: 'Zero', books: [{ id: '1', title: 'T' }] }]);
    expect(adapter.findChildren).toHaveBeenCalledWith(
      expect.anything(), expect.anything(), 'author', 0, expect.anything(), null,
    );
  });
});

describe('stored references the adapter cannot read', () => {
  // Numeric identifiers, as a SQL store keeps them; the adapter rejects any other value as malformed.
  const castNumericId = (value) => {
    if (!/^\d+$/.test(String(value))) throw new SimfinityError('Invalid identifier', 'NOT_VALID_ID', 400);
    return Number(value);
  };

  // The second book stores an author identifier written outside Simfinity.
  const build = (prefix, getByIds) => {
    const adapter = createKeyedAdapter({ castId: castNumericId, withId: true, getByIds });
    const runtime = createRuntime(adapter);
    const Author = createType(`${prefix}Author`);
    const Book = new GraphQLObjectType({
      name: `${prefix}Book`,
      fields: {
        id: { type: GraphQLID },
        title: { type: GraphQLString },
        author: { type: Author, extensions: { relation: { embedded: false, connectionField: 'authorId' } } },
      },
    });
    runtime.connect(null, Author, `${prefix}Author`, `${prefix}Authors`);
    runtime.connect(null, Book, `${prefix}Book`, `${prefix}Books`);
    const schema = runtime.createSchema();
    adapter.seed(`${prefix}Author`, { _id: 1, id: 1, name: 'Ada' });
    adapter.seed(`${prefix}Book`, { _id: 1, id: 1, title: 'Kept', authorId: 1 });
    adapter.seed(`${prefix}Book`, { _id: 2, id: 2, title: 'Legacy', authorId: 'legacy-key' });
    return { adapter, run: (source) => graphql({ schema, source, contextValue: {} }) };
  };

  const format = (result, callback) => result.errors.map(buildErrorFormatter(callback))
    .map(({ path, extensions }) => ({ path, code: extensions.code, status: extensions.status }));

  test.each([
    ['read by id', 'StoredDirect', false],
    ['read in batches', 'StoredBatched', true],
  ])('reports a stored identifier the adapter rejects as an internal error at its field: %s', async (label, prefix, getByIds) => {
    const { adapter, run } = build(prefix, getByIds);
    const callback = vi.fn();

    const read = await run(`{ ${prefix}Books { title author { name } } }`);

    expect(read.data[`${prefix}Books`]).toEqual([
      { title: 'Kept', author: { name: 'Ada' } },
      { title: 'Legacy', author: null },
    ]);
    expect(format(read, callback)).toEqual([
      { path: [`${prefix}Books`, 1, 'author'], code: 'INTERNAL_SERVER_ERROR', status: 500 },
    ]);
    const [[classified]] = callback.mock.calls;
    expect(classified).toBeInstanceOf(InternalServerError);
    expect(classified.getCause()).toBeInstanceOf(SimfinityError);
    expect(classified.getCause().extensions).toMatchObject({ code: 'NOT_VALID_ID', status: 400 });
    expect(adapter.getById).toHaveBeenCalledWith(
      expect.anything(), 'legacy-key', null, expect.objectContaining({ requiredId: 'legacy-key' }),
    );
    if (getByIds) expect(adapter.getByIds).toHaveBeenCalledOnce();
  });

  test('keeps malformed identifiers a client sends bad requests', async () => {
    const { adapter, run } = build('StoredClient', true);

    const byId = await run('{ StoredClientBook(id: "legacy-key") { title } }');
    const added = await run('mutation { addStoredClientBook(input: { title: "N", author: { id: "legacy-key" } }) { id } }');

    expect(format(byId)).toEqual([{ path: ['StoredClientBook'], code: 'NOT_VALID_ID', status: 400 }]);
    expect(format(added)).toEqual([{ path: ['addStoredClientBook'], code: 'NOT_VALID_ID', status: 400 }]);
    expect(adapter.getRecords('StoredClientBook')).toHaveLength(2);
  });

  test.each([
    ['a missing record', 'StoredMissing', new SimfinityError('Author is not valid', 'NOT_VALID_ID', 404)],
    ['another bad request', 'StoredRejected', new SimfinityError('Rejected', 'BAD_REQUEST', 400)],
  ])('passes %s through unchanged', async (label, prefix, failure) => {
    const { adapter, run } = build(prefix, false);
    adapter.getById.mockRejectedValue(failure);
    const callback = vi.fn();

    const read = await run(`{ ${prefix}Books { title author { name } } }`);

    const { code, status } = failure.extensions;
    expect(format(read, callback)).toEqual([
      { path: [`${prefix}Books`, 0, 'author'], code, status },
      { path: [`${prefix}Books`, 1, 'author'], code, status },
    ]);
    expect(callback.mock.calls.map(([error]) => error)).toEqual([failure, failure]);
    expect(callback.mock.calls.every(([error]) => error === failure)).toBe(true);
  });
});

describe('referenced collection connectionField', () => {
  const createOwnerTypes = (prefix, things = {}) => {
    const Thing = new GraphQLObjectType({
      name: `${prefix}Thing`,
      fields: { id: { type: GraphQLID }, label: { type: GraphQLString } },
    });
    const Owner = new GraphQLObjectType({
      name: `${prefix}Owner`,
      fields: {
        id: { type: GraphQLID },
        label: { type: GraphQLString },
        things: {
          type: new GraphQLList(Thing),
          ...things,
          extensions: { ...things.extensions, relation: { embedded: false, ...things.relation } },
        },
      },
    });
    return { Thing, Owner };
  };

  const build = (prefix, things, controller) => {
    const adapter = createKeyedAdapter();
    const runtime = createRuntime(adapter);
    const types = createOwnerTypes(prefix, things);
    runtime.connect(null, types.Thing, `${prefix}thing`, `${prefix}things`);
    runtime.connect(null, types.Owner, `${prefix}owner`, `${prefix}owners`, controller);
    return { adapter, runtime, ...types };
  };

  test.each([
    ['missing', 'MissingConnection', {}],
    ['empty', 'EmptyConnection', { relation: { connectionField: '' } }],
  ])('rejects a writable collection with a %s connectionField before preparing the adapter', (label, prefix, things) => {
    const { adapter, runtime } = build(prefix, things);

    expect(() => runtime.createSchema()).toThrow(expect.objectContaining({
      message: `${prefix}Owner.things requires a child connectionField`,
      extensions: expect.objectContaining({ code: 'INVALID_MODEL', status: 400 }),
    }));
    expect(adapter.prepare).not.toHaveBeenCalled();
    expect(adapter.createModel).not.toHaveBeenCalled();
  });

  test('warns once for a read-only collection without its own resolver', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { runtime } = build('ReadOnlyGenerated', { extensions: { readOnly: true } });

      runtime.createSchema();
      runtime.createSchema();

      expect(configurationIssues(warn)).toEqual([
        'Configuration issue: ReadOnlyGeneratedOwner.things requires a child connectionField; nested writes through it are rejected',
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  test('reads the children of a read-only collection without its own resolver through the field name', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { adapter, runtime, Thing } = build('ReadOnlyFallback', { extensions: { readOnly: true } });
      const schema = runtime.createSchema();
      adapter.seed('ReadOnlyFallbackOwner', { _id: 'o1', label: 'a' });
      adapter.seed('ReadOnlyFallbackThing', { _id: 't1', label: 'x', things: 'o1' });
      adapter.seed('ReadOnlyFallbackThing', { _id: 't2', label: 'y', things: 'o2' });

      const result = await graphql({ schema, source: '{ ReadOnlyFallbackowners { label things { id label } } }' });

      expect(result.errors).toBeUndefined();
      expect(result.data.ReadOnlyFallbackowners).toEqual([{ label: 'a', things: [{ id: 't1', label: 'x' }] }]);
      expect(adapter.findChildren).toHaveBeenCalledTimes(1);
      expect(adapter.findChildren.mock.calls[0].slice(1, 4)).toEqual([Thing, 'things', 'o1']);
    } finally {
      warn.mockRestore();
    }
  });

  test('builds a read-only collection with its own resolver without a warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { runtime } = build('ReadOnlyOwn', { extensions: { readOnly: true }, resolve: () => [] });

      expect(() => runtime.createSchema()).not.toThrow();
      expect(configurationIssues(warn)).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  test('warns for a writable collection with its own resolver and rejects nested items before writing', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const controller = { onSaving: vi.fn(), onUpdating: vi.fn() };
    try {
      const { adapter, runtime } = build('WritableOwn', { resolve: () => [] }, controller);
      const schema = runtime.createSchema();
      const run = (source) => graphql({ schema, source });
      const rejected = {
        message: 'WritableOwnOwner.things cannot store nested items because it has no connectionField',
        extensions: expect.objectContaining({ code: 'INVALID_MODEL', status: 500 }),
      };

      const added = await run('mutation { addWritableOwnowner(input: { label: "a", things: { added: [{ label: "x" }] } }) { id } }');
      expect(added.errors).toEqual([expect.objectContaining(rejected)]);
      expect(adapter.saveRecord).not.toHaveBeenCalled();
      expect(controller.onSaving).not.toHaveBeenCalled();

      const empty = await run(`mutation {
        addWritableOwnowner(input: { label: "b", things: { added: [], updated: [], deleted: [] } }) { id }
      }`);
      const nulls = await run('mutation { addWritableOwnowner(input: { label: "c", things: { added: [null] } }) { id } }');
      expect(empty.errors).toBeUndefined();
      expect(nulls.errors).toBeUndefined();
      const ownerId = empty.data.addWritableOwnowner.id;

      for (const things of ['updated: [{ id: "1", label: "y" }]', 'deleted: ["1"]']) {
        const updated = await run(`mutation { updateWritableOwnowner(input: { id: "${ownerId}", things: { ${things} } }) { id } }`);
        expect(updated.errors).toEqual([expect.objectContaining(rejected)]);
      }
      expect(adapter.update).not.toHaveBeenCalled();
      expect(controller.onUpdating).not.toHaveBeenCalled();
      expect(adapter.getRecords('WritableOwnThing')).toEqual([]);
      expect(adapter.getRecords('WritableOwnOwner').map(({ label }) => label)).toEqual(['b', 'c']);
      expect(configurationIssues(warn)).toEqual([
        'Configuration issue: WritableOwnOwner.things requires a child connectionField; nested writes through it are rejected',
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  test('rejects nested items through a read-only collection in saveObject without writing', async () => {
    const { adapter, runtime } = build('SavedReadOnly', { extensions: { readOnly: true }, resolve: () => [] });
    runtime.createSchema();

    await expect(runtime.saveObject('SavedReadOnlyOwner', {
      label: 'a', things: { added: [{ label: 'x' }] },
    })).rejects.toMatchObject({ extensions: { code: 'INVALID_MODEL', status: 500 } });
    expect(adapter.saveRecord).not.toHaveBeenCalled();
    await expect(runtime.saveObject('SavedReadOnlyOwner', { label: 'b', things: { added: [] } }))
      .resolves.toMatchObject({ label: 'b' });
  });

  test('rejects unlinked items nested below a linked collection before writing the parent', async () => {
    const adapter = createKeyedAdapter();
    const runtime = createRuntime(adapter);
    const { Thing, Owner } = createOwnerTypes('NestedUnlinked', { resolve: () => [] });
    const Root = new GraphQLObjectType({
      name: 'NestedUnlinkedRoot',
      fields: {
        id: { type: GraphQLID },
        owners: { type: new GraphQLList(Owner), extensions: { relation: { embedded: false, connectionField: 'root' } } },
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      runtime.connect(null, Thing, 'nestedUnlinkedThing', 'nestedUnlinkedThings');
      runtime.connect(null, Owner, 'nestedUnlinkedOwner', 'nestedUnlinkedOwners');
      runtime.connect(null, Root, 'nestedUnlinkedRoot', 'nestedUnlinkedRoots');
      const schema = runtime.createSchema();

      const result = await graphql({
        schema,
        source: `mutation {
          addnestedUnlinkedRoot(input: { owners: { added: [{ label: "o", things: { added: [{ label: "x" }] } }] } }) { id }
        }`,
      });

      expect(result.errors?.[0].extensions).toMatchObject({ code: 'INVALID_MODEL', status: 500 });
      expect(adapter.saveRecord).not.toHaveBeenCalled();

      // Items that nested middleware adds after the pre-flight check are rejected before they are written.
      runtime.use(async (params, next) => {
        if (params.type?.gqltype === Owner && params.operation === 'save') {
          params.args.input.things = { added: [{ label: 'late' }] };
        }
        await next();
      });
      const late = await graphql({
        schema,
        source: 'mutation { addnestedUnlinkedRoot(input: { owners: { added: [{ label: "o" }] } }) { id } }',
      });
      expect(late.errors?.[0].extensions).toMatchObject({ code: 'INVALID_MODEL', status: 500 });
      expect(adapter.getRecords('NestedUnlinkedThing')).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  test('builds a one-sided many-to-many whose inverse is a read-only list with its own resolver', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const adapter = createKeyedAdapter();
      const runtime = createRuntime(adapter);
      const Course = new GraphQLObjectType({
        name: 'OneSidedCourse',
        fields: () => ({
          id: { type: GraphQLID },
          title: { type: GraphQLString },
          students: { type: new GraphQLList(Student), extensions: { relation: { embedded: false, connectionField: 'courses' } } },
        }),
      });
      const Student = new GraphQLObjectType({
        name: 'OneSidedStudent',
        fields: () => ({
          id: { type: GraphQLID },
          name: { type: GraphQLString },
          courses: {
            type: new GraphQLList(Course),
            extensions: { relation: { embedded: false }, readOnly: true },
            resolve: () => [],
          },
        }),
      });
      runtime.connect(null, Student, 'oneSidedStudent', 'oneSidedStudents');
      runtime.connect(null, Course, 'oneSidedCourse', 'oneSidedCourses');
      const schema = runtime.createSchema();

      const result = await graphql({
        schema,
        source: 'mutation { addoneSidedCourse(input: { title: "math", students: { added: [{ name: "ana" }] } }) { id } }',
      });

      expect(result.errors).toBeUndefined();
      const courseId = result.data.addoneSidedCourse.id;
      expect(adapter.getRecords('OneSidedStudent')).toEqual([expect.objectContaining({ name: 'ana', courses: courseId })]);
      expect(configurationIssues(warn)).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('nested collection ownership', () => {
  // Identifiers are case-insensitive, as MongoDB ObjectId hex strings and PostgreSQL UUIDs are: the
  // adapter accepts any spelling and keeps the lowercase key.
  const lowerCaseId = (value) => String(value).toLowerCase();

  const build = (prefix, {
    adapter = createKeyedAdapter({ castId: lowerCaseId }), childExtensions, childController,
  } = {}) => {
    const runtime = createRuntime(adapter);
    const Toy = new GraphQLObjectType({
      name: `${prefix}Toy`,
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        child: { type: Child, extensions: { relation: { embedded: false, connectionField: 'childId' } } },
      }),
    });
    const Child = new GraphQLObjectType({
      name: `${prefix}Child`,
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        parent: { type: Parent, extensions: { relation: { embedded: false, connectionField: 'parentId' } } },
        toys: { type: new GraphQLList(Toy), extensions: { relation: { embedded: false, connectionField: 'childId' } } },
      }),
      extensions: childExtensions,
    });
    const Parent = new GraphQLObjectType({
      name: `${prefix}Parent`,
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        children: { type: new GraphQLList(Child), extensions: { relation: { embedded: false, connectionField: 'parentId' } } },
      }),
    });
    runtime.connect(null, Toy, `${prefix}toy`, `${prefix}toys`);
    runtime.connect(null, Child, `${prefix}child`, `${prefix}children`, childController);
    runtime.connect(null, Parent, `${prefix}parent`, `${prefix}parents`);
    const schema = runtime.createSchema();
    adapter.seed(`${prefix}Parent`, { _id: 'abc1', name: 'A' });
    adapter.seed(`${prefix}Parent`, { _id: 'abc2', name: 'B' });
    adapter.seed(`${prefix}Child`, { _id: 'cafe1', name: 'own', parentId: 'abc1' });
    adapter.seed(`${prefix}Child`, { _id: 'cafe2', name: 'foreign', parentId: 'abc2' });
    adapter.seed(`${prefix}Toy`, { _id: 'beef1', name: 'toy', childId: 'cafe1' });
    const run = (source) => graphql({ schema, source, contextValue: {} });
    const updateParent = (id, children) => run(`mutation {
      update${prefix}parent(input: { id: "${id}", children: { ${children} } }) { id }
    }`);
    const childrenOf = async (id) => {
      const result = await run(`{ ${prefix}parent(id: "${id}") { children { name } } }`);
      expect(result.errors).toBeUndefined();
      return result.data[`${prefix}parent`].children.map(({ name }) => name).sort();
    };
    const childRecord = (id) => adapter.getRecords(`${prefix}Child`).find(({ _id }) => _id === id);
    return {
      adapter, runtime, updateParent, childrenOf, childRecord,
    };
  };

  const modelNamed = (name) => expect.objectContaining({ name });

  test.each(['updated', 'deleted'])('accepts %s for its own child when the parent ID differs in case', async (operation) => {
    const prefix = `OwnCase${operation}`;
    const { adapter, updateParent, childRecord } = build(prefix);

    const result = await updateParent('ABC1', operation === 'updated'
      ? 'updated: [{ id: "cafe1", name: "renamed" }]'
      : 'deleted: ["cafe1"]');

    expect(result.errors).toBeUndefined();
    if (operation === 'updated') {
      expect(childRecord('cafe1')).toMatchObject({ name: 'renamed', parentId: 'abc1' });
    } else {
      expect(adapter.delete).toHaveBeenCalledWith(modelNamed(`${prefix}Child`), 'cafe1', expect.anything());
    }
  });

  test('accepts grandchildren of an updated child whose ID differs in case', async () => {
    const { adapter, updateParent } = build('OwnGrandchild');

    const result = await updateParent('abc1', 'updated: [{ id: "CAFE1", name: "renamed", toys: { deleted: ["beef1"] } }]');

    expect(result.errors).toBeUndefined();
    expect(adapter.delete).toHaveBeenCalledWith(modelNamed('OwnGrandchildToy'), 'beef1', expect.anything());
  });

  test('links children added under a parent ID that differs in case with the stored key', async () => {
    const { adapter, updateParent, childrenOf } = build('OwnAdded');

    const result = await updateParent('ABC1', 'added: [{ name: "new" }]');

    expect(result.errors).toBeUndefined();
    const added = adapter.getRecords('OwnAddedChild').find(({ name }) => name === 'new');
    expect(added.parentId).toBe('abc1');
    expect(await childrenOf('abc1')).toEqual(['new', 'own']);
  });

  test('gives validators and hooks of nested children the stored parent key', async () => {
    const seen = [];
    const childExtensions = {
      validations: {
        CREATE: [{ validate: (typeName, args, modelArgs) => { seen.push(['CREATE', modelArgs.parentId]); } }],
        UPDATE: [{ validate: (typeName, args, modelArgs) => { seen.push(['UPDATE', modelArgs.parentId]); } }],
      },
    };
    const childController = {
      onSaving: (record) => { seen.push(['onSaving', record.parentId]); },
      onUpdating: (id, update) => { seen.push(['onUpdating', id, update.set.parentId]); },
    };
    const { updateParent } = build('OwnHooks', { childExtensions, childController });

    const result = await updateParent('ABC1', 'added: [{ name: "new" }], updated: [{ id: "cafe1", name: "renamed" }]');

    expect(result.errors).toBeUndefined();
    expect(seen).toEqual([
      ['CREATE', 'abc1'], ['onSaving', 'abc1'], ['UPDATE', 'abc1'], ['onUpdating', 'cafe1', 'abc1'],
    ]);
  });

  test('uses the id of an update result that has no _id', async () => {
    const adapter = createKeyedAdapter({ castId: lowerCaseId });
    const storedUpdate = adapter.update;
    adapter.update = vi.fn(async (...args) => {
      const record = await storedUpdate(...args);
      return record && { id: record._id };
    });
    const { updateParent } = build('OwnIdOnly', { adapter });

    const result = await updateParent('ABC1', 'deleted: ["cafe1"]');

    expect(result.errors).toBeUndefined();
    expect(adapter.delete).toHaveBeenCalledWith(modelNamed('OwnIdOnlyChild'), 'cafe1', expect.anything());
  });

  test('keeps the requested ID for an update result without _id or id (guard)', async () => {
    const adapter = createKeyedAdapter({ castId: lowerCaseId });
    const storedUpdate = adapter.update;
    adapter.update = vi.fn(async (...args) => {
      const record = await storedUpdate(...args);
      return record && { name: record.name };
    });
    const { updateParent } = build('OwnNoKey', { adapter });

    const canonical = await updateParent('abc1', 'updated: [{ id: "cafe1", name: "renamed" }]');
    const otherCase = await updateParent('ABC1', 'updated: [{ id: "cafe1", name: "again" }]');

    expect(canonical.errors).toBeUndefined();
    expect(otherCase.errors?.[0].extensions).toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });

  test.each(['updated', 'deleted'])('keeps a foreign child in %s FORBIDDEN when the parent ID differs in case (guard)', async (operation) => {
    const { adapter, updateParent, childRecord } = build(`OwnForeign${operation}`);

    const result = await updateParent('ABC1', operation === 'updated'
      ? 'updated: [{ id: "cafe2", name: "stolen" }]'
      : 'deleted: ["cafe2"]');

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].extensions).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(childRecord('cafe2')).toMatchObject({ name: 'foreign', parentId: 'abc2' });
    expect(adapter.delete).not.toHaveBeenCalled();
  });

  test.each(['updated', 'deleted'])('rejects a foreign child in %s with auth.ForbiddenError', async (operation) => {
    const prefix = `OwnDenied${operation}`;
    const { updateParent } = build(prefix);
    const callback = vi.fn();

    const result = await updateParent('abc1', operation === 'updated'
      ? 'updated: [{ id: "cafe2", name: "stolen" }]'
      : 'deleted: ["cafe2"]');

    const [error] = result.errors;
    expect(error.message).toBe('Child does not belong to this parent');
    expect(error.extensions).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(error.originalError).toBeInstanceOf(auth.ForbiddenError);
    expect(error.originalError).toBeInstanceOf(SimfinityError);
    expect(error.originalError.name).toBe('ForbiddenError');
    const formatted = buildErrorFormatter(callback)(error);
    expect(callback).toHaveBeenCalledWith(error.originalError);
    expect(JSON.parse(JSON.stringify(formatted))).toEqual({
      message: 'Child does not belong to this parent',
      locations: [expect.any(Object)],
      path: [`update${prefix}parent`],
      extensions: { code: 'FORBIDDEN', status: 403, timestamp: expect.any(String) },
    });
  });

  test('saveObject runs no middleware for its root record and runs nested children\'s middleware with its context (guard)', async () => {
    const { runtime } = build('OwnSaveObject');
    const calls = [];
    runtime.use(async ({ type, operation, context }, next) => {
      calls.push({ operation, type: type?.gqltype?.name, context });
      await next();
    });
    const context = { user: 'job' };

    await runtime.saveObject('OwnSaveObjectParent', { name: 'root only' });
    expect(calls).toEqual([]);
    await runtime.saveObject('OwnSaveObjectParent', { name: 'no context', children: { added: [{ name: 'kid' }] } });
    await runtime.saveObject('OwnSaveObjectParent', { name: 'context', children: { added: [{ name: 'kid' }] } }, undefined, context);

    expect(calls).toEqual([
      { operation: 'save', type: 'OwnSaveObjectChild', context: undefined },
      { operation: 'save', type: 'OwnSaveObjectChild', context },
    ]);
    expect(calls[1].context).toBe(context);
  });
});

describe('fields named like generated query arguments', () => {
  const queryArgs = (schema, fieldName) => Object.fromEntries(schema.getQueryType().getFields()[fieldName].args
    .map((arg) => [arg.name, String(arg.type)]));

  test('warns once per type and name and keeps aggregation a list filter', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const runtime = createRuntime(createMemoryAdapter());
      const Item = new GraphQLObjectType({
        name: 'ShadowedItem',
        fields: {
          id: { type: GraphQLID },
          sort: { type: GraphQLString },
          OR: { type: GraphQLString },
          aggregation: { type: GraphQLInt },
        },
      });
      runtime.connect(null, Item, 'shadowedItem', 'shadowedItems');

      const schema = runtime.createSchema();
      runtime.createSchema();

      const issues = configurationIssues(warn);
      expect(issues).toHaveLength(3);
      expect(issues[0]).toMatch(/^Configuration issue: ShadowedItem\.sort has the name of a generated list query argument/);
      expect(issues[1]).toMatch(/^Configuration issue: ShadowedItem\.OR /);
      expect(issues[2]).toMatch(/^Configuration issue: ShadowedItem\.aggregation .*shadowedItems_aggregate/);
      expect(queryArgs(schema, 'shadowedItems')).toMatchObject({
        sort: 'QLSortExpression', OR: '[QLFilterGroup]', aggregation: 'QLFilter',
      });
      expect(queryArgs(schema, 'shadowedItems_aggregate')).toMatchObject({
        aggregation: 'QLTypeAggregationExpression!',
      });
    } finally {
      warn.mockRestore();
    }
  });

  test('does not warn for embedded-only types or twice for an endpoint that is also a collection target', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const runtime = createRuntime(createMemoryAdapter());
      const Detail = new GraphQLObjectType({ name: 'ShadowedDetail', fields: { sort: { type: GraphQLString } } });
      const Child = new GraphQLObjectType({
        name: 'ShadowedChild',
        fields: { id: { type: GraphQLID }, sort: { type: GraphQLString }, parentId: { type: GraphQLID } },
      });
      const Parent = new GraphQLObjectType({
        name: 'ShadowedParent',
        fields: {
          id: { type: GraphQLID },
          detail: { type: Detail, extensions: { relation: { embedded: true } } },
          children: { type: new GraphQLList(Child), extensions: { relation: { embedded: false, connectionField: 'parentId' } } },
        },
      });
      runtime.addNoEndpointType(Detail);
      runtime.connect(null, Child, 'shadowedChild', 'shadowedChildren');
      runtime.connect(null, Parent, 'shadowedParent', 'shadowedParents');

      runtime.createSchema();

      const issues = configurationIssues(warn);
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatch(/^Configuration issue: ShadowedChild\.sort /);
    } finally {
      warn.mockRestore();
    }
  });

  test.each([
    ['without a list endpoint', false, 0],
    ['with a list endpoint', true, 1],
  ])('keeps the sort argument of a collection whose connectionField is named sort, child %s', (label, endpoint, warnings) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const runtime = createRuntime(createMemoryAdapter());
      const prefix = endpoint ? 'SortLinkedEndpoint' : 'SortLinkedNoEndpoint';
      const Parent = new GraphQLObjectType({
        name: `${prefix}Parent`,
        fields: () => ({
          id: { type: GraphQLID },
          children: { type: new GraphQLList(Child), extensions: { relation: { embedded: false, connectionField: 'sort' } } },
        }),
      });
      const Child = new GraphQLObjectType({
        name: `${prefix}Child`,
        fields: () => ({
          id: { type: GraphQLID },
          name: { type: GraphQLString },
          sort: { type: Parent, extensions: { relation: { embedded: false, connectionField: 'sort' } } },
        }),
      });
      if (endpoint) runtime.connect(null, Child, `${prefix}child`, `${prefix}children`);
      else runtime.addNoEndpointType(Child);
      runtime.connect(null, Parent, `${prefix}parent`, `${prefix}parents`);

      runtime.createSchema();

      const args = Object.fromEntries(Parent.getFields().children.args.map((arg) => [arg.name, String(arg.type)]));
      expect(args).toEqual({
        id: 'QLFilter',
        name: 'QLFilter',
        pagination: 'QLPagination',
        sort: 'QLSortExpression',
        AND: '[QLFilterGroup]',
        OR: '[QLFilterGroup]',
      });
      const issues = configurationIssues(warn);
      expect(issues).toHaveLength(warnings);
      if (warnings) expect(issues[0]).toMatch(new RegExp(`^Configuration issue: ${prefix}Child\\.sort `));
    } finally {
      warn.mockRestore();
    }
  });

  test('leaves out only the back-reference of each collection, direct or aliased', () => {
    const runtime = createRuntime(createMemoryAdapter());
    const Serie = new GraphQLObjectType({
      name: 'BackReferenceSerie',
      fields: () => ({
        id: { type: GraphQLID },
        seasons: { type: new GraphQLList(Season), extensions: { relation: { embedded: false, connectionField: 'serie' } } },
        aliased: { type: new GraphQLList(Season), extensions: { relation: { embedded: false, connectionField: 'parent_id' } } },
      }),
    });
    const Season = new GraphQLObjectType({
      name: 'BackReferenceSeason',
      fields: () => ({
        id: { type: GraphQLID },
        n: { type: GraphQLInt },
        serie: { type: Serie, extensions: { relation: { embedded: false } } },
        parent: { type: Serie, extensions: { relation: { embedded: false, connectionField: 'parent_id' } } },
      }),
    });
    runtime.connect(null, Season, 'backReferenceSeason', 'backReferenceSeasons');
    runtime.connect(null, Serie, 'backReferenceSerie', 'backReferenceSeries');

    runtime.createSchema();

    const argNames = (fieldName) => Serie.getFields()[fieldName].args.map((arg) => arg.name);
    expect(argNames('seasons')).toEqual(['id', 'n', 'parent', 'pagination', 'sort', 'AND', 'OR']);
    expect(argNames('aliased')).toEqual(['id', 'n', 'serie', 'pagination', 'sort', 'AND', 'OR']);
  });
});

describe('joined scope control arguments', () => {
  const build = (scopeArgs) => {
    const adapter = createStoreAdapter({ JoinedControlHolder: [{ _id: '1', secretId: 's1' }] });
    const runtime = createRuntime(adapter);
    const Secret = new GraphQLObjectType({
      name: 'JoinedControlSecret',
      extensions: { scope: { find: ({ args }) => { Object.assign(args, scopeArgs); } } },
      fields: {
        id: { type: GraphQLID },
        key: { type: GraphQLString },
        sort: { type: GraphQLString },
        aggregation: { type: GraphQLInt },
      },
    });
    const Holder = new GraphQLObjectType({
      name: 'JoinedControlHolder',
      fields: {
        id: { type: GraphQLID },
        secret: { type: Secret, extensions: { relation: { embedded: false, connectionField: 'secretId' } } },
      },
    });
    runtime.addNoEndpointType(Secret);
    runtime.connect(null, Holder, 'joinedControlHolder', 'joinedControlHolders');
    const schema = runtime.createSchema();
    const run = () => graphql({
      schema,
      source: '{ joinedControlHolders(secret: { terms: [{ path: "key", operator: EQ, value: "k" }] }) { id } }',
      contextValue: {},
    });
    return { adapter, run };
  };

  test.each([
    ['sort without terms', { sort: { operator: 'EQ', value: 'A' } }, 'INVALID_SORT'],
    ['a sort term without an order', { sort: { terms: [{ field: 'key' }] } }, 'INVALID_SORT'],
    ['invalid pagination', { pagination: { page: 0, size: 1 } }, 'INVALID_PAGINATION'],
  ])('rejects %s like a direct query', async (label, scopeArgs, code) => {
    const { adapter, run } = build(scopeArgs);

    const result = await run();

    expect(result.errors?.[0].extensions).toMatchObject({ code, status: 400 });
    expect(adapter.find).not.toHaveBeenCalled();
  });

  test('ignores valid sort and pagination and applies an aggregation field filter', async () => {
    const { adapter, run } = build({
      sort: { terms: [{ field: 'key', order: 'ASC' }] },
      pagination: { page: 1, size: 1 },
      aggregation: { operator: 'EQ', value: 1 },
    });

    const result = await run();

    expect(result.errors).toBeUndefined();
    expect(adapter.find.mock.calls[0][2].AND).toEqual([
      { conditions: [{ field: 'secret.aggregation', operator: 'EQ', value: 1 }] },
    ]);
  });
});

describe('embedded value hook', () => {
  const createShopTypes = (prefix) => {
    const customResolve = (parent) => parent.main;
    const Geo = new GraphQLObjectType({ name: `${prefix}Geo`, fields: { lat: { type: GraphQLInt } } });
    const Snapshot = new GraphQLObjectType({
      name: `${prefix}Snapshot`,
      fields: { geo: { type: Geo, extensions: { relation: { embedded: true } } } },
    });
    const Address = new GraphQLObjectType({
      name: `${prefix}Address`,
      fields: {
        street: { type: GraphQLString },
        geo: { type: Geo, extensions: { relation: { embedded: true } } },
        pin: { type: new GraphQLNonNull(Geo), extensions: { relation: { embedded: true } } },
      },
    });
    const Shop = new GraphQLObjectType({
      name: `${prefix}Shop`,
      fields: {
        id: { type: GraphQLID },
        main: { type: Address, extensions: { relation: { embedded: true } } },
        addresses: { type: new GraphQLList(Address), extensions: { relation: { embedded: true } } },
        custom: { type: Address, extensions: { relation: { embedded: true } }, resolve: customResolve },
        // Read-only and unregistered, so only reachable from Shop.
        snapshot: { type: Snapshot, extensions: { relation: { embedded: true }, readOnly: true } },
      },
    });
    return {
      Geo, Snapshot, Address, Shop, customResolve,
    };
  };

  const register = (runtime, types, endpoint) => {
    runtime.addNoEndpointType(types.Geo);
    runtime.addNoEndpointType(types.Address);
    runtime.connect(null, types.Shop, endpoint, `${endpoint}s`);
  };

  const cleared = { cleared: true };
  const createHookAdapter = () => Object.assign(createMemoryAdapter(), {
    readEmbeddedValue: vi.fn((value) => (value?.cleared ? null : value)),
  });

  test('reads nullable singular embedded objects through the adapter', async () => {
    const adapter = createHookAdapter();
    const runtime = createRuntime(adapter);
    const types = createShopTypes('HookRead');
    register(runtime, types, 'hookReadShop');
    const schema = runtime.createSchema();
    await adapter.saveRecord({ name: 'HookReadShop' }, {
      _id: '1',
      main: { street: 'M', geo: cleared, pin: { lat: 1 } },
      addresses: [{ street: 'A', geo: cleared, pin: { lat: 2 } }],
      snapshot: { geo: cleared },
    });

    const result = await graphql({
      schema,
      source: `{ hookReadShops {
        main { street geo { lat } pin { lat } } addresses { geo { lat } } custom { street } snapshot { geo { lat } }
      } }`,
    });

    expect(result.errors).toBeUndefined();
    expect(result.data.hookReadShops).toEqual([{
      main: { street: 'M', geo: null, pin: { lat: 1 } },
      addresses: [{ geo: null }],
      custom: { street: 'M' },
      snapshot: { geo: null },
    }]);
    const generated = (type, field) => typeof type.getFields()[field].resolve === 'function';
    expect([
      generated(types.Shop, 'main'), generated(types.Address, 'geo'), generated(types.Snapshot, 'geo'),
      generated(types.Shop, 'addresses'), generated(types.Address, 'pin'),
    ]).toEqual([true, true, true, false, false]);
    expect(types.Shop.getFields().custom.resolve).toBe(types.customResolve);
  });

  test('keeps embedded filters queryable and leaves the types shareable', async () => {
    const adapter = createHookAdapter();
    const runtime = createRuntime(adapter);
    const types = createShopTypes('HookShareable');
    register(runtime, types, 'hookShareableShop');
    const schema = runtime.createSchema();

    const filtered = await graphql({
      schema,
      source: '{ hookShareableShops(main: { terms: [{ path: "geo.lat", operator: EQ, value: 1 }] }) { id } }',
    });
    expect(filtered.errors).toBeUndefined();

    // The hook reads no data, so another runtime, with or without it, can reach the same types.
    for (const otherAdapter of [createHookAdapter(), createMemoryAdapter()]) {
      const other = createRuntime(otherAdapter);
      register(other, types, 'hookShareableShop');
      const otherSchema = other.createSchema();
      await otherAdapter.saveRecord({ name: 'HookShareableShop' }, { _id: '1', main: { street: 'M', geo: cleared } });
      const read = await graphql({ schema: otherSchema, source: '{ hookShareableShops { main { street geo { lat } } } }' });
      expect(read.errors).toBeUndefined();
      expect(read.data.hookShareableShops).toEqual([{ main: { street: 'M', geo: null } }]);
    }
  });

  test('calls embedded methods of a custom mutation result before reading them through the adapter', async () => {
    const adapter = createHookAdapter();
    const runtime = createRuntime(adapter);
    const types = createShopTypes('HookMethod');
    register(runtime, types, 'hookMethodShop');
    const received = [];
    // Called with the parent as receiver and the resolver arguments, as graphql's default resolver does.
    function main(args, context) {
      received.push({ receiver: this.id, context: context.tenant });
      return { street: `${this.id}-street`, geo: cleared };
    }
    const results = {
      sync: { id: 'sync', main },
      async: { id: 'async', async main() { return { street: `${this.id}-street` }; } },
      asyncCleared: { id: 'asyncCleared', main: async () => cleared },
    };
    const ModeInput = new GraphQLInputObjectType({ name: 'HookMethodInput', fields: { mode: { type: GraphQLString } } });
    runtime.registerMutation('hookMethodShop', 'Returns a shop with embedded methods', ModeInput, types.Shop,
      async ({ mode }) => results[mode]);
    const schema = runtime.createSchema();
    const run = (mode) => graphql({
      schema,
      source: `mutation { hookMethodShop(input: { mode: "${mode}" }) { id main { street geo { lat } } } }`,
      contextValue: { tenant: 't1' },
    });

    const [sync, asynchronous, asyncCleared] = await Promise.all(['sync', 'async', 'asyncCleared'].map(run));

    expect(sync).toEqual({ data: { hookMethodShop: { id: 'sync', main: { street: 'sync-street', geo: null } } } });
    expect(received).toEqual([{ receiver: 'sync', context: 't1' }]);
    expect(asynchronous).toEqual({
      data: { hookMethodShop: { id: 'async', main: { street: 'async-street', geo: null } } },
    });
    expect(asyncCleared).toEqual({ data: { hookMethodShop: { id: 'asyncCleared', main: null } } });
    // The hook reads the value the method settles to, never the method or its promise.
    for (const [value] of adapter.readEmbeddedValue.mock.calls) {
      expect(typeof value === 'function' || value instanceof Promise).toBe(false);
    }
  });

  test('calls the method behind a read-only embedded field of a stored record', async () => {
    const adapter = createHookAdapter();
    const runtime = createRuntime(adapter);
    const types = createShopTypes('HookReadOnlyMethod');
    register(runtime, types, 'hookReadOnlyMethodShop');
    const schema = runtime.createSchema();
    await adapter.saveRecord({ name: 'HookReadOnlyMethodShop' }, {
      _id: '1',
      snapshot() { return { geo: { lat: Number(this._id) } }; },
    });
    await adapter.saveRecord({ name: 'HookReadOnlyMethodShop' }, { _id: '2', snapshot: () => cleared });

    const result = await graphql({ schema, source: '{ hookReadOnlyMethodShops { id snapshot { geo { lat } } } }' });

    expect(result).toEqual({
      data: {
        hookReadOnlyMethodShops: [{ id: '1', snapshot: { geo: { lat: 1 } } }, { id: '2', snapshot: null }],
      },
    });
  });

  test('installs nothing for adapters without the hook, so the types stay shareable', async () => {
    const types = createShopTypes('HookShared');
    for (const adapter of [createMemoryAdapter(), createMemoryAdapter()]) {
      const runtime = createRuntime(adapter);
      register(runtime, types, 'hookSharedShop');
      runtime.createSchema();
    }

    expect(types.Shop.getFields().main.resolve).toBeUndefined();
    expect(types.Address.getFields().geo.resolve).toBeUndefined();
  });
});

describe('fields named like Object.prototype members', () => {
  // A scalar, an embedded object and a reference stored as makerId, each named like a member every
  // plain object inherits; Meta has a scalar list so named next to a normally named one.
  const createGaugeTypes = (prefix, validate = () => {}) => {
    const Maker = createType(`${prefix}Maker`);
    const Meta = new GraphQLObjectType({
      name: `${prefix}Meta`,
      fields: {
        name: { type: GraphQLString },
        length: { type: GraphQLInt },
        tags: { type: new GraphQLList(GraphQLString) },
        toString: { type: new GraphQLList(GraphQLString) },
      },
    });
    // Unregistered and read-only, so only reachable from Gauge.
    const Snapshot = new GraphQLObjectType({ name: `${prefix}Snapshot`, fields: { toString: { type: GraphQLString } } });
    const Gauge = new GraphQLObjectType({
      name: `${prefix}Gauge`,
      fields: {
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        toString: { type: GraphQLString, extensions: { validations: { CREATE: [{ validate }], UPDATE: [{ validate }] } } },
        valueOf: { type: Meta, extensions: { relation: { embedded: true } } },
        constructor: { type: Maker, extensions: { relation: { embedded: false, connectionField: 'makerId' } } },
        snapshot: { type: Snapshot, extensions: { relation: { embedded: true }, readOnly: true } },
      },
    });
    return {
      Maker, Meta, Snapshot, Gauge,
    };
  };

  const register = (runtime, types, endpoint) => {
    runtime.connect(null, types.Maker, `${endpoint}maker`, `${endpoint}makers`);
    runtime.addNoEndpointType(types.Meta);
    runtime.connect(null, types.Gauge, `${endpoint}gauge`, `${endpoint}gauges`);
  };

  test('writes no inherited member for a field a create or an update omits', async () => {
    const adapter = createMemoryAdapter();
    const validate = vi.fn();
    const runtime = createRuntime(adapter);
    const types = createGaugeTypes('ProtoWrite', validate);
    register(runtime, types, 'protoWrite');
    const schema = runtime.createSchema();
    const run = async (source) => {
      const result = await graphql({ schema, source });
      expect(result.errors).toBeUndefined();
      return result.data;
    };

    await run('mutation { addprotoWritegauge(input: { name: "omitted" }) { id } }');
    const kept = await run('mutation { addprotoWritegauge(input: { name: "kept", toString: "t", valueOf: { name: "n" } }) { id } }');
    const id = kept.addprotoWritegauge.id;
    const [omittedRecord, keptRecord] = adapter.getRecords();

    expect(['toString', 'valueOf', 'makerId'].filter((key) => Object.hasOwn(omittedRecord, key))).toEqual([]);
    // The create stores [] for the omitted list so named; the adapter defaults the other one.
    expect(keptRecord.valueOf).toEqual({ name: 'n', toString: [] });

    await run(`mutation { updateprotoWritegauge(input: { id: "${id}", name: "renamed" }) { id } }`);
    expect(keptRecord).toMatchObject({ name: 'renamed', toString: 't' });
    expect(keptRecord.valueOf).toEqual({ name: 'n', toString: [] });
    expect(Object.hasOwn(keptRecord, 'makerId')).toBe(false);

    // A partial embedded update fills omitted lists with [], whatever their names, also in a value
    // stored without them.
    delete keptRecord.valueOf.toString;
    await run(`mutation { updateprotoWritegauge(input: { id: "${id}", valueOf: { length: 2 } }) { id } }`);
    expect(keptRecord.valueOf).toEqual({
      name: 'n', length: 2, tags: [], toString: [],
    });
    expect(keptRecord.toString).toBe('t');
    expect(validate.mock.calls.map(([, , value]) => value)).toEqual([undefined, 't', undefined, undefined]);
  });

  test('a create stores [] for an omitted list so named, at the root and in embedded values', async () => {
    const adapter = createMemoryAdapter();
    const runtime = createRuntime(adapter);
    const Part = new GraphQLObjectType({
      name: 'ProtoListPart',
      fields: { label: { type: GraphQLString }, valueOf: { type: new GraphQLList(GraphQLString) } },
    });
    const Item = new GraphQLObjectType({
      name: 'ProtoListItem',
      fields: { id: { type: GraphQLID }, name: { type: GraphQLString }, boardId: { type: GraphQLID } },
    });
    const Board = new GraphQLObjectType({
      name: 'ProtoListBoard',
      fields: {
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        tags: { type: new GraphQLList(GraphQLString) },
        toString: { type: new GraphQLList(GraphQLString) },
        valueOf: { type: new GraphQLList(GraphQLString) },
        hasOwnProperty: { type: new GraphQLList(Part), extensions: { relation: { embedded: true } } },
        part: { type: Part, extensions: { relation: { embedded: true } } },
        parts: { type: new GraphQLList(Part), extensions: { relation: { embedded: true } } },
        isPrototypeOf: { type: new GraphQLList(Item), extensions: { relation: { embedded: false, connectionField: 'boardId' } } },
      },
    });
    runtime.connect(null, Item, 'protoListitem', 'protoListitems');
    runtime.addNoEndpointType(Part);
    runtime.connect(null, Board, 'protoListboard', 'protoListboards');
    const schema = runtime.createSchema();

    const created = await graphql({
      schema,
      source: `mutation { addprotoListboard(input: { name: "b", valueOf: null, part: { label: "p" }, parts: [{ label: "q" }] }) {
        toString valueOf hasOwnProperty { label } part { valueOf } parts { valueOf } } }`,
    });
    const [record] = adapter.getRecords().filter((stored) => stored.Model.name === 'ProtoListBoard');

    expect(created).toEqual({
      data: {
        addprotoListboard: {
          toString: [], valueOf: [], hasOwnProperty: [], part: { valueOf: [] }, parts: [{ valueOf: [] }],
        },
      },
    });
    expect(['toString', 'valueOf', 'hasOwnProperty', 'part', 'parts'].map((key) => [key, record[key]])).toEqual([
      ['toString', []], ['valueOf', []], ['hasOwnProperty', []], ['part', { label: 'p', valueOf: [] }], ['parts', [{ label: 'q', valueOf: [] }]],
    ]);
    // Lists with other names keep the adapter's default, and collections are not stored on the record.
    expect(['tags', 'isPrototypeOf'].filter((key) => Object.hasOwn(record, key))).toEqual([]);

    // Only a create fills the default: an update that does not mention such a list keeps its value.
    const { id } = await graphql({ schema, source: '{ protoListboards { id } }' }).then(({ data }) => data.protoListboards[0]);
    await graphql({ schema, source: `mutation { updateprotoListboard(input: { id: "${id}", toString: ["t"], valueOf: ["v"] }) { id } }` });
    const updated = await graphql({ schema, source: `mutation { updateprotoListboard(input: { id: "${id}", name: "c" }) { name toString valueOf } }` });
    expect(updated).toEqual({ data: { updateprotoListboard: { name: 'c', toString: ['t'], valueOf: ['v'] } } });
  });

  test.each(['toString', 'code'])('an update that omits the required list item member %s fails as for any name', async (member) => {
    const adapter = createMemoryAdapter();
    const runtime = createRuntime(adapter);
    const prefix = member === 'code' ? 'ProtoRequiredCode' : 'ProtoRequiredMember';
    const Part = new GraphQLObjectType({
      name: `${prefix}Part`,
      fields: {
        label: { type: GraphQLString },
        code: { type: new GraphQLNonNull(GraphQLString) },
        toString: { type: new GraphQLNonNull(GraphQLString) },
      },
    });
    const Gauge = new GraphQLObjectType({
      name: `${prefix}Gauge`,
      fields: {
        id: { type: GraphQLID },
        parts: { type: new GraphQLList(Part), extensions: { relation: { embedded: true } } },
      },
    });
    runtime.addNoEndpointType(Part);
    runtime.connect(null, Gauge, `${prefix}gauge`, `${prefix}gauges`);
    const schema = runtime.createSchema();
    const created = await graphql({
      schema, source: `mutation { add${prefix}gauge(input: { parts: [{ label: "a", code: "c", toString: "t" }] }) { id } }`,
    });
    const { id } = created.data[`add${prefix}gauge`];
    const kept = Object.entries({ label: 'b', code: 'c', toString: 't' }).filter(([name]) => name !== member);

    const updated = await graphql({
      schema,
      source: `mutation { update${prefix}gauge(input: { id: "${id}", parts: [{ ${kept.map(([name, value]) => `${name}: "${value}"`).join(', ')} }] }) { id } }`,
    });

    expect(updated.errors).toEqual([expect.objectContaining({
      message: `Required value ${member} is missing`,
      extensions: expect.objectContaining({ code: 'REQUIRED_VALUE', status: 400 }),
    })]);
    expect(adapter.getRecords()[0].parts).toEqual([{ label: 'a', code: 'c', toString: 't' }]);
  });

  test.each([
    ['read by id', 'ProtoRefDirect', false],
    ['read in batches', 'ProtoRefBatched', true],
  ])('resolves a reference named constructor only from its connectionField: %s', async (label, prefix, getByIds) => {
    const castId = (value) => {
      if (!/^\d+$/.test(String(value))) throw new SimfinityError('Invalid identifier', 'NOT_VALID_ID', 400);
      return Number(value);
    };
    const adapter = createKeyedAdapter({ castId, withId: true, getByIds });
    const runtime = createRuntime(adapter);
    const types = createGaugeTypes(prefix);
    register(runtime, types, prefix);
    // Like a hydrated MongoDB document, it inherits `constructor` from its class.
    class Hydrated {
      constructor(name) {
        this.name = name;
      }
    }
    const ModeInput = new GraphQLInputObjectType({ name: `${prefix}ModeInput`, fields: { mode: { type: GraphQLString } } });
    runtime.registerMutation(`${prefix}hydrated`, 'Returns a gauge instance', ModeInput, types.Gauge,
      async () => new Hydrated('hydrated'));
    const schema = runtime.createSchema();
    adapter.seed(`${prefix}Maker`, { _id: 1, id: 1, name: 'maker' });
    adapter.seed(`${prefix}Gauge`, { _id: 1, id: 1, name: 'linked', makerId: 1 });
    adapter.seed(`${prefix}Gauge`, { _id: 2, id: 2, name: 'cleared', makerId: null });
    adapter.seed(`${prefix}Gauge`, { _id: 3, id: 3, name: 'absent' });
    const run = (source) => graphql({ schema, source, contextValue: {} });

    const list = await run(`{ ${prefix}gauges { name constructor { name } } }`);
    const byId = await run(`{ ${prefix}gauge(id: "3") { name constructor { name } } }`);
    const hydrated = await run(`mutation { ${prefix}hydrated(input: { mode: "x" }) { name constructor { name } } }`);

    expect(list).toEqual({
      data: {
        [`${prefix}gauges`]: [
          { name: 'linked', constructor: { name: 'maker' } },
          { name: 'cleared', constructor: null },
          { name: 'absent', constructor: null },
        ],
      },
    });
    expect(byId).toEqual({ data: { [`${prefix}gauge`]: { name: 'absent', constructor: null } } });
    expect(hydrated).toEqual({ data: { [`${prefix}hydrated`]: { name: 'hydrated', constructor: null } } });
  });

  test.each([
    ['without an embedded value hook', 'ProtoRead', createMemoryAdapter],
    ['with an embedded value hook', 'ProtoReadHook', () => Object.assign(createMemoryAdapter(), {
      readEmbeddedValue: vi.fn((value) => value),
    })],
  ])('reads absent members as null and keeps own values, methods and class members: %s', async (label, prefix, createAdapter) => {
    const adapter = createAdapter();
    const runtime = createRuntime(adapter);
    const types = createGaugeTypes(prefix);
    register(runtime, types, prefix);
    class Reading {
      constructor(name) {
        this.name = name;
      }

      toString() {
        return `class ${this.name}`;
      }
    }
    const results = {
      absent: { id: 'a', name: 'absent', snapshot: {} },
      value: {
        id: 'v', name: 'value', toString: 'stored', valueOf: { name: 'meta', toString: ['x'] },
      },
      method: { id: 'm', name: 'method', toString() { return `own ${this.name}`; } },
      instance: new Reading('instance'),
      // A MongoDB nested path returns the inherited member from an own accessor.
      accessor: {
        id: 'n',
        name: 'accessor',
        valueOf: Object.defineProperty({ name: 'meta' }, 'toString', { get: () => Object.prototype.toString, enumerable: true }),
      },
    };
    const ModeInput = new GraphQLInputObjectType({ name: `${prefix}ModeInput`, fields: { mode: { type: GraphQLString } } });
    runtime.registerMutation(`${prefix}read`, 'Returns a gauge', ModeInput, types.Gauge, async ({ mode }) => results[mode]);
    const schema = runtime.createSchema();
    await adapter.saveRecord({ name: `${prefix}Gauge` }, { _id: '1', name: 'stored', valueOf: { name: 'meta' } });
    const fields = 'name toString valueOf { name tags toString } snapshot { toString }';
    const read = async (mode) => {
      const result = await graphql({ schema, source: `mutation { ${prefix}read(input: { mode: "${mode}" }) { ${fields} } }` });
      expect(result.errors).toBeUndefined();
      return result.data[`${prefix}read`];
    };

    expect(await read('absent')).toEqual({
      name: 'absent', toString: null, valueOf: null, snapshot: { toString: null },
    });
    expect(await read('value')).toEqual({
      name: 'value', toString: 'stored', valueOf: { name: 'meta', tags: null, toString: ['x'] }, snapshot: null,
    });
    expect(await read('method')).toEqual({
      name: 'method', toString: 'own method', valueOf: null, snapshot: null,
    });
    expect(await read('instance')).toEqual({
      name: 'instance', toString: 'class instance', valueOf: null, snapshot: null,
    });
    expect(await read('accessor')).toEqual({
      name: 'accessor', toString: null, valueOf: { name: 'meta', tags: null, toString: null }, snapshot: null,
    });
    const stored = await graphql({ schema, source: `{ ${prefix}gauges { ${fields} } }` });
    expect(stored).toEqual({
      data: {
        [`${prefix}gauges`]: [{
          name: 'stored', toString: null, valueOf: { name: 'meta', tags: null, toString: null }, snapshot: null,
        }],
      },
    });
    const generated = (type, field) => typeof type.getFields()[field].resolve === 'function';
    expect([
      generated(types.Gauge, 'toString'), generated(types.Meta, 'toString'), generated(types.Snapshot, 'toString'),
      generated(types.Gauge, 'name'), generated(types.Meta, 'tags'),
    ]).toEqual([true, true, true, false, false]);
  });

  test('reads a member-named getter once, so a rejected promise it returns is handled once', async () => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const adapter = createMemoryAdapter();
      const runtime = createRuntime(adapter);
      const Note = new GraphQLObjectType({
        name: 'ProtoGetterNote',
        fields: { id: { type: GraphQLID }, name: { type: GraphQLString }, toString: { type: GraphQLString } },
      });
      runtime.connect(null, Note, 'protoGetterNote', 'protoGetterNotes');
      const schema = runtime.createSchema();
      let reads = 0;
      await adapter.saveRecord({ name: 'ProtoGetterNote' }, {
        _id: '1',
        name: 'n',
        get toString() {
          reads += 1;
          return Promise.reject(new Error('lookup failed'));
        },
      });

      const result = await graphql({ schema, source: '{ protoGetterNote(id: "1") { name toString } }' });
      await new Promise((resolve) => { setImmediate(resolve); });

      expect(reads).toBe(1);
      expect(result.errors.map(({ message, path }) => [message, path])).toEqual([['lookup failed', ['protoGetterNote', 'toString']]]);
      expect(result.data).toEqual({ protoGetterNote: { name: 'n', toString: null } });
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('reads the field name of a reference only when its stored identifier is missing', async () => {
    const adapter = createMemoryAdapter();
    const runtime = createRuntime(adapter);
    const Author = new GraphQLObjectType({
      name: 'ProtoLazyAuthor', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } },
    });
    const Book = new GraphQLObjectType({
      name: 'ProtoLazyBook',
      fields: {
        id: { type: GraphQLID },
        title: { type: GraphQLString },
        author: { type: Author, extensions: { relation: { embedded: false, connectionField: 'authorId' } } },
      },
    });
    runtime.connect(null, Author, 'protoLazyAuthor', 'protoLazyAuthors');
    runtime.connect(null, Book, 'protoLazyBook', 'protoLazyBooks');
    const schema = runtime.createSchema();
    await adapter.saveRecord({ name: 'ProtoLazyAuthor' }, { _id: '2', name: 'Ann' });
    let reads = 0;
    await adapter.saveRecord({ name: 'ProtoLazyBook' }, {
      _id: '1',
      title: 'T',
      authorId: '2',
      get author() {
        reads += 1;
        throw new Error('author object not loaded');
      },
    });

    for (const contextValue of [undefined, {}]) {
      const result = await graphql({ schema, contextValue, source: '{ protoLazyBook(id: "1") { title author { name } } }' });
      expect(result).toEqual({ data: { protoLazyBook: { title: 'T', author: { name: 'Ann' } } } });
    }
    expect(reads).toBe(0);
  });

  test('installs a resolver that reads no data, so the types stay shareable', async () => {
    const Meta = new GraphQLObjectType({ name: 'ProtoSharedMeta', fields: { toString: { type: GraphQLString } } });
    const Note = new GraphQLObjectType({
      name: 'ProtoSharedNote',
      fields: {
        id: { type: GraphQLID },
        valueOf: { type: GraphQLString },
        meta: { type: Meta, extensions: { relation: { embedded: true } } },
      },
    });
    for (const adapter of [createMemoryAdapter(), createMemoryAdapter()]) {
      const runtime = createRuntime(adapter);
      runtime.addNoEndpointType(Meta);
      runtime.connect(null, Note, 'protoSharedNote', 'protoSharedNotes');
      const schema = runtime.createSchema();
      await adapter.saveRecord({ name: 'ProtoSharedNote' }, { _id: '1', meta: {} });

      const read = await graphql({ schema, source: '{ protoSharedNotes { valueOf meta { toString } } }' });

      expect(read).toEqual({ data: { protoSharedNotes: [{ valueOf: null, meta: { toString: null } }] } });
    }
  });
});

describe('pagination count reporting', () => {
  // simfinity-mcp passes a function under this key of the root value to collect counts.
  const COUNT_SINK = Symbol.for('simfinity.countSink');
  const source = '{ countReports(pagination: { page: 1, size: 5, count: true }) { id } }';

  const createCountSchema = (wrap) => {
    const adapter = createMemoryAdapter();
    adapter.count = async () => 3;
    const runtime = createRuntime(adapter);
    runtime.connect(null, createType('RuntimeCountReport'), 'countReport', 'countReports');
    const schema = runtime.createSchema();
    if (wrap) {
      const field = schema.getQueryType().getFields().countReports;
      field.resolve = wrap(field.resolve);
    }
    return schema;
  };
  const rootWithSink = () => {
    const counts = [];
    const rootValue = Object.create(null);
    rootValue[COUNT_SINK] = (count) => { counts.push(count); };
    return { rootValue, counts };
  };

  test('marks generated find fields as reporting counts through a sink', () => {
    const fields = createCountSchema().getQueryType().getFields();

    expect(fields.countReports.extensions.simfinityQuery).toEqual({
      typeName: 'RuntimeCountReport', operation: 'find', countSink: true,
    });
    expect(fields.countReports_aggregate.extensions.simfinityQuery.countSink).toBeUndefined();
  });

  test('writes context.count when the root value has no sink (guard)', async () => {
    const schema = createCountSchema();
    for (const rootValue of [undefined, {}, { [COUNT_SINK]: 'not a function' }]) {
      const contextValue = {};
      const result = await graphql({ schema, source, contextValue, rootValue });

      expect(result.errors).toBeUndefined();
      expect(contextValue).toEqual({ count: 3 });
    }
  });

  test('reports to a root-value sink and leaves the context untouched', async () => {
    const schema = createCountSchema();
    const { rootValue, counts } = rootWithSink();
    const contextValue = Object.freeze({});
    const result = await graphql({ schema, source, contextValue, rootValue });

    expect(result.errors).toBeUndefined();
    expect(counts).toEqual([3]);
  });

  test('finds the sink through a wrapper that forwards only parent, args and context', async () => {
    const schema = createCountSchema((resolve) => (parent, args, context) => resolve(parent, args, context));
    const { rootValue, counts } = rootWithSink();
    const contextValue = Object.freeze({});
    const result = await graphql({ schema, source, contextValue, rootValue });

    expect(result.errors).toBeUndefined();
    expect(counts).toEqual([3]);
  });

  test('falls back to info.rootValue when a wrapper replaces the parent', async () => {
    const schema = createCountSchema((resolve) => (parent, args, context, info) => resolve(undefined, args, context, info));
    const { rootValue, counts } = rootWithSink();
    const contextValue = Object.freeze({});
    const result = await graphql({ schema, source, contextValue, rootValue });

    expect(result.errors).toBeUndefined();
    expect(counts).toEqual([3]);
  });

  const createCountedRows = () => {
    const adapter = createMemoryAdapter();
    adapter.find = vi.fn(async () => [{ _id: '1' }, { _id: '2' }]);
    adapter.count = vi.fn(async () => 2);
    const runtime = createRuntime(adapter);
    runtime.connect(null, createType('RuntimeCountRow'), 'countRow', 'countRows');
    return { schema: runtime.createSchema(), adapter };
  };
  const countedRows = '{ countRows(pagination: { page: 1, size: 5, count: true }) { id } }';
  const rows = { data: { countRows: [{ id: '1' }, { id: '2' }] } };

  test.each([
    ['no', undefined], ['a null', null], ['a number', 5], ['a string', 'ctx'], ['a boolean', true],
  ])('returns the rows with %s context and skips the count query', async (label, contextValue) => {
    const { schema, adapter } = createCountedRows();
    const result = await graphql(contextValue === undefined
      ? { schema, source: countedRows }
      : { schema, source: countedRows, contextValue });

    expect(result).toEqual(rows);
    expect(adapter.find).toHaveBeenCalledTimes(1);
    expect(adapter.count).not.toHaveBeenCalled();
  });

  test('still runs the count query for a root-value sink without a context (guard)', async () => {
    const { schema, adapter } = createCountedRows();
    const { rootValue, counts } = rootWithSink();
    const result = await graphql({ schema, source: countedRows, rootValue });

    expect(result).toEqual(rows);
    expect(adapter.count).toHaveBeenCalledTimes(1);
    expect(counts).toEqual([2]);
  });

  test.each([
    ['a frozen', () => Object.freeze({})],
    ['a sealed', () => Object.seal({})],
    ['a non-extensible', () => Object.preventExtensions({})],
    ['a read-only count in a', () => Object.defineProperty({}, 'count', { value: 0, writable: false })],
  ])('returns the rows with %s context and warns once that the count is not reported', async (label, createContext) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { schema } = createCountedRows();
      for (let request = 0; request < 2; request += 1) {
        expect(await graphql({ schema, source: countedRows, contextValue: createContext() })).toEqual(rows);
      }

      expect(warn.mock.calls).toEqual([[
        'Configuration issue: the GraphQL context does not accept a count property (it is frozen, sealed or has '
          + 'a read-only count), so pagination counts are not reported; pass a fresh mutable context object for '
          + 'each request.',
      ]]);
    } finally {
      warn.mockRestore();
    }
  });

  test('writes the count through a context setter and runs the count query once (guard)', async () => {
    const { schema, adapter } = createCountedRows();
    const counts = [];
    const contextValue = { set count(value) { counts.push(value); } };
    const result = await graphql({ schema, source: countedRows, contextValue });

    expect(result).toEqual(rows);
    expect(adapter.count).toHaveBeenCalledTimes(1);
    expect(counts).toEqual([2]);
  });
});

describe('filter values built from variables', () => {
  test('reads a variable that a list literal names but the request leaves unset as null', async () => {
    const adapter = createMemoryAdapter();
    const find = vi.spyOn(adapter, 'find');
    const runtime = createRuntime(adapter);
    const seen = [];
    runtime.use((params, next) => {
      if (params.operation === 'find') seen.push(params.args.year.value);
      return next();
    });
    runtime.connect(null, new GraphQLObjectType({
      name: 'RuntimeVariableItemSerie',
      fields: { id: { type: GraphQLID }, year: { type: GraphQLInt } },
    }), 'variableItemSerie', 'variableItemSeries');
    const result = await graphql({
      schema: runtime.createSchema(),
      source: 'query($a: QLValue, $b: QLValue) { variableItemSeries(year: { operator: BTW, value: [$a, $b] }) { id } }',
      variableValues: { b: 2020 },
    });

    expect(result).toEqual({ data: { variableItemSeries: [] } });
    expect(seen).toEqual([[null, 2020]]);
    expect(find.mock.calls[0][2].year).toEqual({ operator: 'BTW', value: [null, 2020] });
  });
});

describe('interface and union fields', () => {
  const abstractTypes = (prefix) => {
    const Text = new GraphQLObjectType({ name: `${prefix}Text`, fields: { body: { type: GraphQLString } } });
    const Image = new GraphQLObjectType({ name: `${prefix}Image`, fields: { url: { type: GraphQLString } } });
    return {
      Preview: new GraphQLUnionType({ name: `${prefix}Preview`, types: [Text, Image], resolveType: () => `${prefix}Text` }),
      Node: new GraphQLInterfaceType({
        name: `${prefix}Node`, fields: { body: { type: GraphQLString } }, resolveType: () => `${prefix}Text`,
      }),
    };
  };
  const fieldNames = (type) => Object.keys(type.getFields());
  const previewWarning = (typeName, fieldName) => `Configuration issue: ${typeName}.${fieldName} has an interface or `
    + 'union type, so generated inputs leave it out and generated mutations cannot set it; resolve it yourself, '
    + 'and mark it readOnly to state that it is output-only.';

  test.each([
    ['Union', (t) => t.Preview, {}, false],
    ['Interface', (t) => t.Node, {}, false],
    ['ReadOnlyUnion', (t) => t.Preview, { readOnly: true }, false],
    ['NonNullUnion', (t) => new GraphQLNonNull(t.Preview), {}, false],
    ['NonNullListOfNonNullUnions', (t) => new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(t.Preview))), {}, true],
    ['ListOfInterfaces', (t) => new GraphQLList(t.Node), {}, true],
  ])('builds a valid schema for a collection child with a %s field and leaves it out of inputs', (shape, typeOf, extensions, isList) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const prefix = `RuntimeAbstract${shape}`;
      const t = abstractTypes(prefix);
      const runtime = createRuntime(createMemoryAdapter());
      const Child = new GraphQLObjectType({
        name: `${prefix}Child`,
        fields: () => ({
          id: { type: GraphQLID },
          title: { type: GraphQLString },
          preview: { type: typeOf(t), extensions, resolve: () => (isList ? [] : { body: 'b' }) },
          parent: { type: Parent, extensions: { relation: { embedded: false, connectionField: 'parent' } } },
        }),
      });
      const Parent = new GraphQLObjectType({
        name: `${prefix}Parent`,
        fields: () => ({
          id: { type: GraphQLID },
          children: { type: new GraphQLList(Child), extensions: { relation: { embedded: false, connectionField: 'parent' } } },
        }),
      });
      runtime.connect(null, Parent, 'abstractParent', 'abstractParents');
      runtime.connect(null, Child, 'abstractChild', 'abstractChildren');
      const schema = runtime.createSchema();

      expect(validateSchema(schema)).toEqual([]);
      expect(fieldNames(schema.getType(`${prefix}ChildInput`))).toEqual(['title', 'parent']);
      expect(fieldNames(schema.getType(`${prefix}ChildInputForUpdate`))).toEqual(['id', 'title', 'parent']);
      expect(fieldNames(schema.getType(`${prefix}ParentA${prefix}ChildInputForParent`))).toEqual(['title']);
      const query = schema.getQueryType().getFields();
      for (const field of [query.abstractChildren, query.abstractChildren_aggregate, Parent.getFields().children]) {
        expect(field.args.map((arg) => arg.name)).toContain('title');
        // A list keeps the argument it has always had.
        expect(field.args.find((arg) => arg.name === 'preview')?.type.toString())
          .toBe(isList ? 'QLTypeFilterExpression' : undefined);
      }
      expect(warn.mock.calls).toEqual(extensions.readOnly ? [] : [[previewWarning(`${prefix}Child`, 'preview')]]);
    } finally {
      warn.mockRestore();
    }
  });

  test('leaves a writable list of a union out of inputs and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const t = abstractTypes('RuntimeAbstractList');
      const runtime = createRuntime(createMemoryAdapter());
      runtime.connect(null, new GraphQLObjectType({
        name: 'RuntimeAbstractListDoc',
        fields: { id: { type: GraphQLID }, title: { type: GraphQLString }, previews: { type: new GraphQLList(t.Preview) } },
      }), 'abstractListDoc', 'abstractListDocs');
      const schema = runtime.createSchema();
      runtime.createSchema();

      expect(validateSchema(schema)).toEqual([]);
      expect(fieldNames(schema.getType('RuntimeAbstractListDocInput'))).toEqual(['title']);
      expect(fieldNames(schema.getType('RuntimeAbstractListDocInputForUpdate'))).toEqual(['id', 'title']);
      expect(schema.getQueryType().getFields().abstractListDocs.args.find((arg) => arg.name === 'previews').type.toString())
        .toBe('QLTypeFilterExpression');
      expect(warn.mock.calls).toEqual([[previewWarning('RuntimeAbstractListDoc', 'previews')]]);
    } finally {
      warn.mockRestore();
    }
  });

  test('builds embedded types holding lists of unions', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const t = abstractTypes('RuntimeAbstractBox');
      const runtime = createRuntime(createMemoryAdapter());
      const Box = new GraphQLObjectType({
        name: 'RuntimeAbstractBoxBox',
        fields: { label: { type: GraphQLString }, items: { type: new GraphQLList(t.Preview) } },
      });
      runtime.addNoEndpointType(Box);
      runtime.connect(null, new GraphQLObjectType({
        name: 'RuntimeAbstractBoxDoc',
        fields: { id: { type: GraphQLID }, box: { type: Box, extensions: { relation: { embedded: true } } } },
      }), 'abstractBoxDoc', 'abstractBoxDocs');
      const schema = runtime.createSchema();

      expect(validateSchema(schema)).toEqual([]);
      expect(fieldNames(schema.getType('RuntimeAbstractBoxBoxInput'))).toEqual(['label']);
      expect(warn.mock.calls).toEqual([[previewWarning('RuntimeAbstractBoxBox', 'items')]]);
    } finally {
      warn.mockRestore();
    }
  });

  test('keeps the argument of a readOnly list of a union, which accepts null (guard)', async () => {
    const t = abstractTypes('RuntimeAbstractGuard');
    const runtime = createRuntime(createMemoryAdapter());
    runtime.connect(null, new GraphQLObjectType({
      name: 'RuntimeAbstractGuardDoc',
      fields: {
        id: { type: GraphQLID },
        title: { type: GraphQLString },
        previews: { type: new GraphQLList(t.Preview), extensions: { readOnly: true }, resolve: () => [] },
      },
    }), 'abstractGuardDoc', 'abstractGuardDocs');
    const schema = runtime.createSchema();

    expect(printSchema(schema)).toContain('previews: QLTypeFilterExpression');
    expect(await graphql({ schema, source: '{ abstractGuardDocs(previews: null) { id } }', contextValue: {} }))
      .toEqual({ data: { abstractGuardDocs: [] } });
  });

  test.each([
    ['PostgreSQL', () => createPostgres({ pool: { connect: vi.fn(), query: vi.fn() }, schema: 'abstract_fields' })],
    ['transactional MongoDB', () => createRuntime(createMongoAdapter({ referentialIntegrity: 'transactional' }))],
  ])('still rejects interface and union fields on %s (guard)', (label, createApi) => {
    const t = abstractTypes(`RuntimeAbstract${label.replace(/\W/g, '')}`);
    const api = createApi();
    if (!api.initializeDatabase) api.preventCreatingCollection(true);
    const name = `RuntimeAbstract${label.replace(/\W/g, '')}Doc`;
    api.connect(null, new GraphQLObjectType({
      name,
      fields: { id: { type: GraphQLID }, preview: { type: t.Preview, extensions: { readOnly: true }, resolve: () => null } },
    }), 'abstractRejectedDoc', 'abstractRejectedDocs');

    expect(() => api.createSchema()).toThrow(`Unsupported field type at ${name}.preview`);
  });
});

describe('an application scalar named JSON', () => {
  test('serializes aggregation results through the reused scalar', async () => {
    const JSONScalar = new GraphQLScalarType({ name: 'JSON', serialize: (value) => ({ wrapped: value }), parseValue: (value) => value });
    const adapter = createMemoryAdapter();
    adapter.aggregate = vi.fn(async () => [{ groupId: 'x', facts: { n: 2 } }]);
    const runtime = createRuntime(adapter);
    runtime.connect(null, new GraphQLObjectType({
      name: 'RuntimeAppJSONSerie',
      fields: { id: { type: GraphQLID }, name: { type: GraphQLString }, meta: { type: JSONScalar, resolve: () => 1 } },
    }), 'appJSONSerie', 'appJSONSeries');
    const schema = runtime.createSchema();
    const result = await graphql({
      schema,
      source: '{ appJSONSeries_aggregate(aggregation: { groupId: "name", facts: [{ operation: COUNT, factName: "n", path: "id" }] }) { groupId facts } }',
      contextValue: {},
    });

    expect(schema.getType('JSON')).toBe(JSONScalar);
    expect(result).toEqual({ data: { appJSONSeries_aggregate: [{ groupId: { wrapped: 'x' }, facts: { wrapped: { n: 2 } } }] } });
  });
});
