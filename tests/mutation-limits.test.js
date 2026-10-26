import {
  afterEach, describe, expect, test, vi,
} from 'vitest';
import {
  GraphQLEnumType, GraphQLID, GraphQLInputObjectType, GraphQLInt, GraphQLList, GraphQLObjectType,
  GraphQLString, graphql,
} from 'graphql';

import { configureMutationLimits, createRuntime } from '../packages/core/src/index.js';
import { getMaxNestedOperations, getMaxTransactionOperations } from '../packages/core/src/mutation-limits.js';
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
const invalidLimits = (message) => expect.objectContaining({
  message,
  extensions: expect.objectContaining({ code: 'INVALID_MUTATION_LIMITS', status: 400 }),
});
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

    expect(() => configureMutationLimits({ maxNestedOps: 100 })).toThrow(invalidLimits(
      'Unknown mutation limit option maxNestedOps; use maxNestedOperations or maxTransactionOperations',
    ));
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

  describe('maxTransactionOperations', () => {
    const transactionMessage = 'maxTransactionOperations must be a positive safe integer';
    const unknownMessage = (key) => `Unknown mutation limit option ${key}; use maxNestedOperations or maxTransactionOperations`;

    test('defaults to 100 next to an unlimited nested limit', () => {
      expect(getMaxTransactionOperations()).toBe(100);
      expect(getMaxNestedOperations()).toBeNull();
    });

    test('sets the limit and replaces the nested one', () => {
      configureMutationLimits({ maxNestedOperations: 2 });
      configureMutationLimits({ maxTransactionOperations: 5 });

      expect(getMaxTransactionOperations()).toBe(5);
      expect(getMaxNestedOperations()).toBeNull();
    });

    test('sets both limits in one call', () => {
      configureMutationLimits({ maxNestedOperations: 0, maxTransactionOperations: 1 });

      expect(getMaxNestedOperations()).toBe(0);
      expect(getMaxTransactionOperations()).toBe(1);
    });

    test('accepts the largest safe integer', () => {
      configureMutationLimits({ maxTransactionOperations: Number.MAX_SAFE_INTEGER });

      expect(getMaxTransactionOperations()).toBe(Number.MAX_SAFE_INTEGER);
    });

    test.each([
      ['no arguments', []],
      ['empty options', [{}]],
      ['undefined options', [undefined]],
      ['undefined values', [{ maxNestedOperations: undefined, maxTransactionOperations: undefined }]],
      ['a null nested limit', [{ maxNestedOperations: null }]],
      ['a null-prototype empty object', [Object.create(null)]],
    ])('restores both defaults with %s', (label, args) => {
      configureMutationLimits({ maxNestedOperations: 2, maxTransactionOperations: 5 });

      configureMutationLimits(...args);

      expect(getMaxNestedOperations()).toBeNull();
      expect(getMaxTransactionOperations()).toBe(100);
    });

    test('restores only the omitted value to its default', () => {
      configureMutationLimits({ maxNestedOperations: 2, maxTransactionOperations: 5 });

      configureMutationLimits({ maxNestedOperations: 3 });
      expect(getMaxNestedOperations()).toBe(3);
      expect(getMaxTransactionOperations()).toBe(100);

      configureMutationLimits({ maxTransactionOperations: 7, maxNestedOperations: undefined });
      expect(getMaxNestedOperations()).toBeNull();
      expect(getMaxTransactionOperations()).toBe(7);
    });

    test.each([
      ['null', null],
      ['zero', 0],
      ['a fraction', 1.5],
      ['a negative number', -1],
      ['a string', '5'],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['an unsafe integer', 2 ** 53],
      ['a bigint', 5n],
    ])('rejects %s and keeps the current limits', (label, value) => {
      configureMutationLimits({ maxNestedOperations: 2, maxTransactionOperations: 5 });

      expect(() => configureMutationLimits({ maxTransactionOperations: value })).toThrow(invalidLimits(transactionMessage));

      expect(getMaxNestedOperations()).toBe(2);
      expect(getMaxTransactionOperations()).toBe(5);
    });

    test('validates every value before assigning any', () => {
      configureMutationLimits({ maxNestedOperations: 2, maxTransactionOperations: 5 });

      expect(() => configureMutationLimits({ maxNestedOperations: 3, maxTransactionOperations: 0 }))
        .toThrow(invalidLimits(transactionMessage));
      expect(getMaxNestedOperations()).toBe(2);
      expect(getMaxTransactionOperations()).toBe(5);

      expect(() => configureMutationLimits({ maxNestedOperations: -1, maxTransactionOperations: 7 }))
        .toThrow(invalidLimits('maxNestedOperations must be null or a non-negative safe integer'));
      expect(getMaxNestedOperations()).toBe(2);
      expect(getMaxTransactionOperations()).toBe(5);
    });

    test('names both options in the unknown-option message and keeps the current limits', () => {
      configureMutationLimits({ maxNestedOperations: 2, maxTransactionOperations: 5 });

      expect(() => configureMutationLimits({ maxNestedOperation: 2 })).toThrow(invalidLimits(unknownMessage('maxNestedOperation')));
      expect(() => configureMutationLimits({ maxTransactionOperation: 2 }))
        .toThrow(invalidLimits(unknownMessage('maxTransactionOperation')));
      expect(() => configureMutationLimits({ maxTransactionOperations: 9, maxDepth: 3 }))
        .toThrow(invalidLimits(unknownMessage('maxDepth')));
      expect(() => configureMutationLimits({ [Symbol('maxDepth')]: 3 }))
        .toThrow(invalidLimits(unknownMessage('Symbol(maxDepth)')));

      expect(getMaxNestedOperations()).toBe(2);
      expect(getMaxTransactionOperations()).toBe(5);
    });

    test('is shared by every facade', () => {
      mongo.configureMutationLimits({ maxTransactionOperations: 4 });

      expect(getMaxTransactionOperations()).toBe(4);
      expect(getMaxNestedOperations()).toBeNull();
    });

    test('does not change the nested budget of generated mutations', async () => {
      configureMutationLimits({ maxTransactionOperations: 1 });
      const { schema } = build();

      const result = await execute(schema, addParent, { input: { name: 'p', children: { added: children(4) } } });

      expect(result.errors).toBeUndefined();
    });

    test('pin: maxNestedOperations keeps its values, getter and messages', () => {
      expect(getMaxNestedOperations()).toBeNull();
      configureMutationLimits({ maxNestedOperations: 0 });
      expect(getMaxNestedOperations()).toBe(0);
      configureMutationLimits({ maxNestedOperations: 3 });
      expect(getMaxNestedOperations()).toBe(3);
      configureMutationLimits({ maxNestedOperations: null });
      expect(getMaxNestedOperations()).toBeNull();

      configureMutationLimits({ maxNestedOperations: 3 });
      expect(() => configureMutationLimits({ maxNestedOperations: -1 }))
        .toThrow(invalidLimits('maxNestedOperations must be null or a non-negative safe integer'));
      expect(() => configureMutationLimits([])).toThrow(invalidLimits('Mutation limit options must be a plain object'));
      expect(() => configureMutationLimits(null)).toThrow(invalidLimits('Mutation limit options must be a plain object'));
      expect(getMaxNestedOperations()).toBe(3);
    });
  });
});
