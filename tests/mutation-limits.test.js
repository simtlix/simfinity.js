import {
  afterEach, describe, expect, test, vi,
} from 'vitest';
import {
  GraphQLEnumType, GraphQLID, GraphQLInputObjectType, GraphQLInt, GraphQLList, GraphQLObjectType,
  GraphQLString, graphql,
} from 'graphql';

import { configureMutationLimits, createRuntime } from '../packages/core/src/index.js';
import * as mongo from '../packages/mongodb/src/index.js';
import { createPostgres } from '../packages/postgres/src/index.js';

const createMemoryAdapter = () => {
  const records = new Map();
  let nextId = 1;
  return {
    records,
    prepare() {},
    createModel: (gqltype) => ({ name: gqltype.name }),
    castId: String,
    withTransaction: vi.fn(async (session, body) => body(session || {})),
    newRecord: (Model, data) => ({ ...data, _id: String(nextId++) }),
    saveRecord: vi.fn(async (Model, record) => {
      records.set(record._id, record);
      return record;
    }),
    toObject: (record) => ({ ...record }),
    getById: vi.fn(async (Model, id) => records.get(String(id)) || null),
    prepareUpdate: (set, unset) => ({ set, unset }),
    async update(Model, id, update) {
      const current = records.get(String(id));
      Object.assign(current, update.set);
      return current;
    },
    delete: vi.fn(async (Model, id) => {
      const record = records.get(String(id)) || null;
      records.delete(String(id));
      return record;
    }),
    find: async () => [],
    count: async () => 0,
    aggregate: async () => [],
    findChildren: async () => [],
  };
};

const State = new GraphQLEnumType({
  name: 'LimitState',
  values: { DRAFT: { value: 'DRAFT' }, PUBLISHED: { value: 'PUBLISHED' } },
});

const stateMachine = {
  initialState: { name: 'DRAFT', value: 'DRAFT' },
  actions: {
    publish: { from: { name: 'DRAFT', value: 'DRAFT' }, to: { name: 'PUBLISHED', value: 'PUBLISHED' } },
  },
};

const build = ({ customMutation = false } = {}) => {
  const adapter = createMemoryAdapter();
  const runtime = createRuntime(adapter);
  const middleware = vi.fn((params, next) => next());
  const Parent = new GraphQLObjectType({
    name: 'LimitParent',
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      state: { type: State },
      children: { type: new GraphQLList(Child), extensions: { relation: { connectionField: 'parent' } } },
    }),
  });
  const Child = new GraphQLObjectType({
    name: 'LimitChild',
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      parent: { type: Parent, extensions: { relation: { connectionField: 'parent' } } },
      subs: { type: new GraphQLList(Child), extensions: { relation: { connectionField: 'owner' } } },
    }),
  });
  runtime.connect(null, Parent, 'limitParent', 'limitParents', null, null, stateMachine);
  runtime.connect(null, Child, 'limitChild', 'limitChildren');
  runtime.use(middleware);
  if (customMutation) {
    runtime.registerMutation('importParent', 'Creates a parent with children', new GraphQLInputObjectType({
      name: 'LimitImportInput',
      fields: { children: { type: GraphQLInt } },
    }), Parent, (input, session, context) => runtime.saveObject('LimitParent', {
      name: 'imported',
      children: { added: Array.from({ length: input.children }, (_, index) => ({ name: `c${index}` })) },
    }, session, context));
  }
  return {
    adapter, runtime, middleware, schema: runtime.createSchema(),
  };
};

const execute = (schema, source, variableValues) => graphql({
  schema, source, variableValues, contextValue: {},
});
const addParent = 'mutation ($input: LimitParentInput!) { addlimitParent(input: $input) { id } }';
const children = (count, extra = {}) => Array.from({ length: count }, (_, index) => ({ name: `c${index}`, ...extra }));
const exceeded = (limit) => ({
  message: `A mutation may perform at most ${limit} nested collection operations`,
  extensions: expect.objectContaining({ code: 'NESTED_OPERATIONS_EXCEEDED', status: 400 }),
});

describe('configureMutationLimits', () => {
  afterEach(() => {
    configureMutationLimits();
  });

  test('leaves nested collection operations unlimited by default', async () => {
    const { schema, adapter } = build();

    const result = await execute(schema, addParent, {
      input: { name: 'p', children: { added: children(3, { subs: { added: children(3) } }) } },
    });

    expect(result.errors).toBeUndefined();
    expect(adapter.saveRecord).toHaveBeenCalledTimes(13);
  });

  test('allows exactly the configured number of operations', async () => {
    const { schema, adapter } = build();
    const added = await execute(schema, addParent, { input: { name: 'p', children: { added: children(2) } } });
    const parentId = added.data.addlimitParent.id;
    const [kept, removed] = [...adapter.records.values()].filter((record) => record.parent === parentId);
    configureMutationLimits({ maxNestedOperations: 3 });

    const result = await execute(schema, `mutation ($input: LimitParentInputForUpdate!) {
      updatelimitParent(input: $input) { id }
    }`, {
      input: {
        id: parentId,
        children: { added: children(1), updated: [{ id: kept._id, name: 'renamed' }], deleted: [removed._id] },
      },
    });

    expect(result.errors).toBeUndefined();
    expect(kept.name).toBe('renamed');
    expect(adapter.records.has(removed._id)).toBe(false);
  });

  test('rejects more operations before opening a transaction', async () => {
    configureMutationLimits({ maxNestedOperations: 3 });
    const { schema, adapter, middleware } = build();

    const result = await execute(schema, addParent, { input: { name: 'p', children: { added: children(4) } } });

    expect(result.errors).toEqual([expect.objectContaining(exceeded(3))]);
    expect(adapter.withTransaction).not.toHaveBeenCalled();
    expect(adapter.saveRecord).not.toHaveBeenCalled();
    expect(adapter.getById).not.toHaveBeenCalled();
    expect(middleware).toHaveBeenCalledOnce();
  });

  test('counts operations across nesting levels', async () => {
    configureMutationLimits({ maxNestedOperations: 3 });
    const { schema, adapter } = build();

    const result = await execute(schema, addParent, {
      input: { name: 'p', children: { added: children(1, { subs: { added: children(3) } }) } },
    });

    expect(result.errors).toEqual([expect.objectContaining(exceeded(3))]);
    expect(adapter.saveRecord).not.toHaveBeenCalled();
  });

  test('counts null entries', async () => {
    configureMutationLimits({ maxNestedOperations: 1 });
    const { schema, adapter } = build();

    const result = await execute(schema, addParent, {
      input: { name: 'p', children: { added: [null, null] } },
    });

    expect(result.errors).toEqual([expect.objectContaining(exceeded(1))]);
    expect(adapter.saveRecord).not.toHaveBeenCalled();
  });

  test('caps state actions and leaves root deletes unaffected', async () => {
    const { schema, adapter } = build();
    const added = await execute(schema, addParent, { input: { name: 'p' } });
    const parentId = added.data.addlimitParent.id;
    configureMutationLimits({ maxNestedOperations: 0 });

    const published = await execute(schema, `mutation ($input: LimitParentInputForUpdate!) {
      publish_limitParent(input: $input) { id }
    }`, { input: { id: parentId, children: { added: children(1) } } });
    const deleted = await execute(schema, `mutation { deletelimitParent(id: "${parentId}") { id } }`);

    expect(published.errors).toEqual([expect.objectContaining(exceeded(0))]);
    expect(deleted.errors).toBeUndefined();
    expect(adapter.records.has(parentId)).toBe(false);
  });

  test('forbids nested operations with zero while plain creates pass', async () => {
    configureMutationLimits({ maxNestedOperations: 0 });
    const { schema } = build();

    const plain = await execute(schema, addParent, { input: { name: 'p', children: {} } });
    const nested = await execute(schema, addParent, { input: { name: 'p', children: { added: children(1) } } });

    expect(plain.errors).toBeUndefined();
    expect(nested.errors).toEqual([expect.objectContaining(exceeded(0))]);
  });

  test('does not cap saveObject or custom mutations', async () => {
    configureMutationLimits({ maxNestedOperations: 0 });
    const { schema, adapter } = build({ customMutation: true });

    const result = await execute(schema, 'mutation { importParent(input: { children: 2 }) { id } }');

    expect(result.errors).toBeUndefined();
    expect(adapter.saveRecord).toHaveBeenCalledTimes(3);
  });

  test.each([
    ['a negative number', { maxNestedOperations: -1 }],
    ['a fraction', { maxNestedOperations: 1.5 }],
    ['a string', { maxNestedOperations: '3' }],
    ['NaN', { maxNestedOperations: Number.NaN }],
    ['Infinity', { maxNestedOperations: Number.POSITIVE_INFINITY }],
    ['an array of options', []],
    ['null options', null],
    ['a Date', new Date()],
    ['a misspelled option', { maxNestedOperation: 2 }],
    ['an unknown option next to a valid limit', { maxNestedOperations: 2, maxDepth: 3 }],
  ])('rejects %s', (label, options) => {
    expect(() => configureMutationLimits(options)).toThrow(expect.objectContaining({
      extensions: expect.objectContaining({ code: 'INVALID_MUTATION_LIMITS', status: 400 }),
    }));
  });

  test('keeps the current limit when options are rejected', async () => {
    configureMutationLimits({ maxNestedOperations: 1 });
    const { schema } = build();

    expect(() => configureMutationLimits({ maxNestedOps: 100 })).toThrow('maxNestedOps');
    const result = await execute(schema, addParent, { input: { name: 'p', children: { added: children(2) } } });

    expect(result.errors).toEqual([expect.objectContaining(exceeded(1))]);
  });

  test.each([
    ['no arguments', []],
    ['empty options', [{}]],
    ['a null limit', [{ maxNestedOperations: null }]],
  ])('resets to unlimited with %s', async (label, args) => {
    configureMutationLimits({ maxNestedOperations: 1 });
    configureMutationLimits(...args);
    const { schema } = build();

    const result = await execute(schema, addParent, { input: { name: 'p', children: { added: children(4) } } });

    expect(result.errors).toBeUndefined();
  });

  test('applies one process-wide limit to every runtime', async () => {
    mongo.configureMutationLimits({ maxNestedOperations: 1 });
    const { schema } = build();

    const result = await execute(schema, addParent, { input: { name: 'p', children: { added: children(2) } } });

    expect(result.errors).toEqual([expect.objectContaining(exceeded(1))]);
    expect(createPostgres().configureMutationLimits).toBe(configureMutationLimits);
  });
});
