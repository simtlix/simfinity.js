// The generated transaction field (#151), authorization side: the entries the official auth plugin
// records on each generated mutation root it wraps, which authorizeOperation runs for an operation on
// that root with the root's rules, default policy and deferral, also in schema copies and with a second
// copy of core; and the deprecated graphql-middleware auth, which denies the transaction field.
// authorizeOperation is tested directly here; the transaction field runs it in
// tests/transaction-execution.test.js.
import { createRequire } from 'node:module';
import {
  describe, expect, test, vi,
} from 'vitest';
import {
  GraphQLEnumType, GraphQLID, GraphQLObjectType, GraphQLSchema, GraphQLString, graphql,
} from 'graphql';
import * as core from '@simtlix/simfinity-core';
import * as authSubpath from '@simtlix/simfinity-core/auth';
import { createRuntime } from '@simtlix/simfinity-core';
import {
  allow, createAuthMiddleware, createAuthPlugin, createFieldMiddleware, deny, ForbiddenError, requireAuth,
} from '../packages/core/src/auth/index.js';
import { createOptimisticMemoryAdapter } from './helpers/optimistic-memory-adapter.js';

const KEY = Symbol.for('simfinity.auth.operationEvaluators');
const FORBIDDEN = (key) => ({ code: 'FORBIDDEN', status: 403, message: `Access denied to ${key}` });
const UNAUTHENTICATED = { code: 'UNAUTHENTICATED', status: 401, message: 'You must be logged in to access this resource' };
const DELETE_PRODUCTO = 'mutation { deleteproducto(id: "1") { id } }';
const SIGNED_IN = { user: { id: 'user-1' } };
const UPDATES_CLOSED = { code: 'FORBIDDEN', status: 403, message: 'Updates are closed' };
const refuse = () => false;

// Loaded on use, so that on a checkout without the module each test that needs it fails on its own.
const loadEntries = () => import('../packages/core/src/auth/operation-entries.js');

// The error a promise rejects with, as code, status and message.
const rejection = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return { code: error.extensions?.code, status: error.extensions?.status, message: error.message };
  }
  throw new Error('expected the call to fail');
};

// The single error of a GraphQL result, as code, status and message.
const failure = (result) => {
  expect(result.errors, JSON.stringify(result.data)).toHaveLength(1);
  const [error] = result.errors;
  const extensions = error.originalError?.extensions ?? error.extensions;
  return { code: extensions?.code, status: extensions?.status, message: error.message };
};

const OPEN = { name: 'OPEN', value: 'OPEN' };
const CLOSED = { name: 'CLOSED', value: 'CLOSED' };

// Producto, and Pedido with a state machine whose close action is a generated root; archiveproducto
// is a registered mutation. The schema has the transaction field over both types.
const buildSchema = () => {
  const runtime = createRuntime(createOptimisticMemoryAdapter());
  const State = new GraphQLEnumType({ name: 'TaState', values: { OPEN: { value: 'OPEN' }, CLOSED: { value: 'CLOSED' } } });
  const Producto = new GraphQLObjectType({
    name: 'Producto', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } },
  });
  const Pedido = new GraphQLObjectType({
    name: 'Pedido', fields: { id: { type: GraphQLID }, numero: { type: GraphQLString }, state: { type: State } },
  });
  runtime.connect(null, Producto, 'producto', 'productos');
  runtime.connect(null, Pedido, 'pedido', 'pedidos', null, null, {
    initialState: OPEN,
    actions: {
      close: {
        from: OPEN, to: CLOSED, description: 'Close the order', action: async () => {},
      },
    },
  });
  runtime.registerMutation('archiveproducto', 'Archive a product', null, Producto, async () => null);
  return runtime.createSchema(null, null, null, { transaction: { types: [Producto, Pedido] } });
};

const roots = (schema) => schema.getMutationType().getFields();
const copyOf = (schema) => new GraphQLSchema(schema.toConfig());
const protect = (schema, permissions, defaultPolicy, auth = { createAuthPlugin }) => {
  const plugin = auth.createAuthPlugin(permissions, { defaultPolicy });
  plugin.onSchemaChange({ schema });
  return plugin;
};

// The info the transaction field passes on: a field of the schema's Mutation type, with a path, field
// nodes and an operation of its own.
const transactionInfo = (schema) => {
  const parentType = schema.getMutationType();
  return {
    fieldName: 'transaction',
    parentType,
    returnType: parentType.getFields().transaction.type,
    schema,
    path: { prev: undefined, key: 'transaction', typename: parentType.name },
    fieldNodes: [{ kind: 'Field', name: { kind: 'Name', value: 'transaction' } }],
    operation: { kind: 'OperationDefinition', operation: 'mutation' },
    variableValues: {},
  };
};

// Authorizes an operation on the root `rootName` as the transaction field of `schema` would.
const authorize = async (schema, rootName, {
  parent = {}, args = {}, ctx = {}, info = transactionInfo(schema), entries,
} = {}) => {
  const { authorizeOperation } = entries ?? await loadEntries();
  return authorizeOperation(roots(schema)[rootName], parent, args, ctx, info);
};

const entriesOf = (field) => field.extensions?.simfinityMutation?.[KEY];

// The error a direct call to deleteproducto reports in `schema`.
const directError = async (schema) => failure(await graphql({ schema, source: DELETE_PRODUCTO, contextValue: {} }));

// A copy without a mutation root that keeps the Mutation type, and its fields, as an ordinary type.
const readOnlyOf = (schema) => new GraphQLSchema({ ...schema.toConfig(), mutation: undefined });

// The schema with its Mutation type rebuilt from `change(config)`, sharing every other type.
const withMutation = (schema, change) => {
  const config = schema.toConfig();
  return new GraphQLSchema({
    ...config,
    mutation: new GraphQLObjectType(change(schema.getMutationType().toConfig())),
    types: config.types.filter((type) => type !== schema.getMutationType()),
  });
};

describe('rule outcomes', () => {
  test('under ALLOW, a rule on Mutation.deleteproducto denies the operation as it denies the root', async () => {
    await loadEntries();
    const schema = buildSchema();
    protect(schema, { Mutation: { deleteproducto: refuse, updateproducto: deny('Updates are closed') } }, 'ALLOW');

    expect(await rejection(authorize(schema, 'deleteproducto'))).toEqual(FORBIDDEN('Mutation.deleteproducto'));
    expect(failure(await graphql({ schema, source: DELETE_PRODUCTO, contextValue: {} })))
      .toEqual(FORBIDDEN('Mutation.deleteproducto'));
    // A rule that throws its own ForbiddenError keeps its message.
    expect(await rejection(authorize(schema, 'updateproducto'))).toEqual(UPDATES_CLOSED);
    await expect(authorize(schema, 'addproducto')).resolves.toBeUndefined();
  });

  test('under ALLOW, a root without a rule has no entry and its operation passes', async () => {
    await loadEntries();
    const schema = buildSchema();
    protect(schema, { Mutation: { deleteproducto: refuse } }, 'ALLOW');

    expect(Object.getOwnPropertySymbols(roots(schema).addproducto.extensions.simfinityMutation)).toEqual([]);
    await expect(authorize(schema, 'addproducto')).resolves.toBeUndefined();
  });

  test('under DENY, a root without a rule denies, and only generated roots get entries', async () => {
    await loadEntries();
    const schema = buildSchema();
    protect(schema, { Mutation: { addproducto: allow() } }, 'DENY');

    expect(await rejection(authorize(schema, 'deleteproducto'))).toEqual(FORBIDDEN('Mutation.deleteproducto'));
    expect(await rejection(authorize(schema, 'close_pedido'))).toEqual(FORBIDDEN('Mutation.close_pedido'));
    await expect(authorize(schema, 'addproducto')).resolves.toBeUndefined();
    const withEntries = Object.entries(roots(schema))
      .filter(([, field]) => entriesOf(field) !== undefined)
      .map(([name]) => name);
    expect(withEntries.sort()).toEqual([
      'addpedido', 'addproducto', 'close_pedido', 'deletepedido', 'deleteproducto', 'updatepedido', 'updateproducto',
    ]);
    // The registered mutation and the transaction field are wrapped, but they are not operations.
    expect(Object.getOwnPropertySymbols(roots(schema).archiveproducto.extensions.simfinityMutation)).toEqual([]);
    expect(roots(schema).transaction.extensions.simfinityMutation).toBeUndefined();
  });

  test('a wildcard rule applies to the operations its exact rules do not name', async () => {
    await loadEntries();
    const schema = buildSchema();
    protect(schema, { Mutation: { '*': requireAuth(), addproducto: allow() } }, 'ALLOW');

    expect(await rejection(authorize(schema, 'deleteproducto'))).toEqual(UNAUTHENTICATED);
    expect(await rejection(authorize(schema, 'updatepedido'))).toEqual(UNAUTHENTICATED);
    await expect(authorize(schema, 'deleteproducto', { ctx: SIGNED_IN })).resolves.toBeUndefined();
    await expect(authorize(schema, 'addproducto')).resolves.toBeUndefined();
  });

  test('a rule receives the parent, args and context unchanged and the identity of the root in info', async () => {
    await loadEntries();
    const schema = buildSchema();
    const rule = vi.fn(() => true);
    protect(schema, { Mutation: { deleteproducto: rule } }, 'DENY');
    const parent = { root: true };
    const args = { id: '1' };
    const ctx = { user: { id: 'user-1' } };
    const info = transactionInfo(schema);
    const field = roots(schema).deleteproducto;

    await expect(authorize(schema, 'deleteproducto', {
      parent, args, ctx, info,
    })).resolves.toBeUndefined();
    expect(rule).toHaveBeenCalledTimes(1);
    const [seenParent, seenArgs, seenCtx, seenInfo] = rule.mock.calls[0];
    expect(seenParent).toBe(parent);
    expect(seenArgs).toBe(args);
    expect(seenCtx).toBe(ctx);
    expect(seenInfo).not.toBe(info);
    expect(seenInfo.fieldName).toBe('deleteproducto');
    expect(seenInfo.parentType).toBe(schema.getMutationType());
    expect(seenInfo.returnType).toBe(field.type);
    // The response location and the operation stay the transaction field's.
    expect(seenInfo.schema).toBe(schema);
    expect(seenInfo.path).toBe(info.path);
    expect(seenInfo.fieldNodes).toBe(info.fieldNodes);
    expect(seenInfo.operation).toBe(info.operation);
    expect(seenInfo.variableValues).toBe(info.variableValues);
    expect(info.fieldName).toBe('transaction');
  });
});

describe('rule semantics', () => {
  test('async rules run in order, and no rule runs after one denies', async () => {
    await loadEntries();
    const schema = buildSchema();
    const calls = [];
    const first = vi.fn(async () => { calls.push('first'); return true; });
    const second = vi.fn(async () => { calls.push('second'); });
    const third = vi.fn(async () => { calls.push('third'); return false; });
    const fourth = vi.fn(() => true);
    protect(schema, { Mutation: { deleteproducto: [first, second, third, fourth], addproducto: [first, second] } }, 'ALLOW');

    await expect(authorize(schema, 'addproducto')).resolves.toBeUndefined();
    expect(calls).toEqual(['first', 'second']);
    calls.length = 0;
    expect(await rejection(authorize(schema, 'deleteproducto'))).toEqual(FORBIDDEN('Mutation.deleteproducto'));
    expect(calls).toEqual(['first', 'second', 'third']);
    expect(fourth).not.toHaveBeenCalled();
  });

  test.each([
    ['false', false], ['null', null], ['a string', 'yes'], ['a number', 1], ['an object', {}], ['a promise of false', Promise.resolve(false)],
  ])('a rule that returns %s denies', async (_label, value) => {
    await loadEntries();
    const schema = buildSchema();
    protect(schema, { Mutation: { deleteproducto: () => value } }, 'ALLOW');

    expect(await rejection(authorize(schema, 'deleteproducto'))).toEqual(FORBIDDEN('Mutation.deleteproducto'));
  });

  test('a thrown UnauthenticatedError keeps 401, and any thrown error propagates unchanged', async () => {
    await loadEntries();
    const schema = buildSchema();
    const error = new Error('rule failed');
    protect(schema, {
      Mutation: { deleteproducto: requireAuth(), updateproducto: () => { throw error; }, addproducto: async () => { throw error; } },
    }, 'ALLOW');

    expect(await rejection(authorize(schema, 'deleteproducto'))).toEqual(UNAUTHENTICATED);
    expect(failure(await graphql({ schema, source: DELETE_PRODUCTO, contextValue: {} }))).toEqual(UNAUTHENTICATED);
    await expect(authorize(schema, 'updateproducto')).rejects.toBe(error);
    await expect(authorize(schema, 'addproducto')).rejects.toBe(error);
  });
});

describe('schema copies and plugin instances', () => {
  test('a toConfig() copy, also with a rebuilt Mutation type, enforces the entries of the instance that processed the original', async () => {
    await loadEntries();
    const schema = buildSchema();
    protect(schema, { Mutation: { deleteproducto: refuse } }, 'ALLOW');
    const copy = copyOf(schema);
    const config = schema.toConfig();
    const rebuilt = new GraphQLSchema({
      ...config,
      mutation: new GraphQLObjectType(schema.getMutationType().toConfig()),
      types: config.types.filter((type) => type !== schema.getMutationType()),
    });
    expect(roots(rebuilt).deleteproducto).not.toBe(roots(schema).deleteproducto);

    for (const target of [copy, rebuilt]) {
      expect(await rejection(authorize(target, 'deleteproducto'))).toEqual(FORBIDDEN('Mutation.deleteproducto'));
      expect(failure(await graphql({ schema: target, source: DELETE_PRODUCTO, contextValue: {} })))
        .toEqual(FORBIDDEN('Mutation.deleteproducto'));
    }
  });

  test('instances on schemas that share types each run on their own schema, and all of them on an unprocessed copy, in the order of a direct call', async () => {
    await loadEntries();
    const first = buildSchema();
    const second = copyOf(first);
    const calls = [];
    const rule = (name) => () => { calls.push(name); return true; };
    protect(first, { Mutation: { deleteproducto: rule('I1') } }, 'ALLOW');
    protect(second, { Mutation: { deleteproducto: rule('I2') } }, 'ALLOW');
    const unprocessed = copyOf(first);

    // The latest entry runs first, as the outermost wrapper does in a direct call.
    for (const [schema, expected] of [[first, ['I1']], [second, ['I2']], [unprocessed, ['I2', 'I1']]]) {
      calls.length = 0;
      await graphql({ schema, source: DELETE_PRODUCTO, contextValue: {} });
      expect(calls).toEqual(expected);
      calls.length = 0;
      await expect(authorize(schema, 'deleteproducto')).resolves.toBeUndefined();
      expect(calls).toEqual(expected);
    }
  });

  test('when two instances on one schema deny with different errors, the operation reports the error of a direct call', async () => {
    await loadEntries();
    const schema = buildSchema();
    const calls = [];
    const throwing = (name, message) => ({
      Mutation: { deleteproducto: () => { calls.push(name); throw new ForbiddenError(message); } },
    });
    protect(schema, throwing('I1', 'first instance'), 'ALLOW');
    protect(schema, throwing('I2', 'second instance'), 'ALLOW');
    const second = { code: 'FORBIDDEN', status: 403, message: 'second instance' };

    expect(await directError(schema)).toEqual(second);
    expect(await rejection(authorize(schema, 'deleteproducto'))).toEqual(second);
    expect(calls).toEqual(['I2', 'I2']);
    expect(entriesOf(roots(schema).deleteproducto).size).toBe(2);
  });

  test('an instance that wraps a root again records its entry again, as the latest', async () => {
    await loadEntries();
    const schema = buildSchema();
    const throwing = (message) => ({ Mutation: { deleteproducto: () => { throw new ForbiddenError(message); } } });
    const first = protect(schema, throwing('first instance'), 'ALLOW');
    protect(schema, throwing('second instance'), 'ALLOW');
    const field = roots(schema).deleteproducto;
    const reported = async (target) => ({
      direct: (await directError(target)).message,
      operation: (await rejection(authorize(target, 'deleteproducto'))).message,
    });
    expect(await reported(copyOf(schema))).toEqual({ direct: 'second instance', operation: 'second instance' });

    // A resolver replaced since then is wrapped again, so the first instance's wrapper is now the outermost.
    const replaced = field.resolve;
    field.resolve = (...args) => replaced(...args);
    first.onSchemaChange({ schema: copyOf(schema) });
    expect(await reported(copyOf(schema))).toEqual({ direct: 'first instance', operation: 'first instance' });
    expect(entriesOf(field).size).toBe(2);
  });

  test('reprocessing a schema or a copy keeps one entry per instance, also when it wraps a replaced resolver', async () => {
    await loadEntries();
    const schema = buildSchema();
    const rule = vi.fn(() => true);
    const plugin = protect(schema, { Mutation: { deleteproducto: rule } }, 'ALLOW');
    const field = roots(schema).deleteproducto;
    const [recorded] = entriesOf(field).values();
    plugin.onSchemaChange({ schema });
    const copy = copyOf(schema);
    plugin.onSchemaChange({ schema: copy });
    expect(entriesOf(field).size).toBe(1);
    expect(entriesOf(field).values().next().value).toBe(recorded);

    // A resolver replaced since then is wrapped again, and the instance's entry replaced.
    const replaced = field.resolve;
    field.resolve = (...args) => replaced(...args);
    plugin.onSchemaChange({ schema: copyOf(schema) });
    expect(entriesOf(field).size).toBe(1);
    expect(entriesOf(field).values().next().value).not.toBe(recorded);

    await expect(authorize(copy, 'deleteproducto')).resolves.toBeUndefined();
    expect(rule).toHaveBeenCalledTimes(1);
  });
});

describe('roots that share a marker, and recording', () => {
  test('an alias of a root in the same Mutation type adds the checks of its key and replaces none', async () => {
    await loadEntries();
    const schema = withMutation(buildSchema(), (config) => ({
      ...config, fields: { ...config.fields, removeproducto: config.fields.deleteproducto },
    }));
    expect(roots(schema).removeproducto.extensions.simfinityMutation)
      .toBe(roots(schema).deleteproducto.extensions.simfinityMutation);
    protect(schema, { Mutation: { deleteproducto: refuse, removeproducto: allow() } }, 'ALLOW');

    expect(await directError(schema)).toEqual(FORBIDDEN('Mutation.deleteproducto'));
    expect(await rejection(authorize(schema, 'deleteproducto'))).toEqual(FORBIDDEN('Mutation.deleteproducto'));
    // An operation on either key runs the checks of both: never fewer than a direct call to it.
    expect(await rejection(authorize(schema, 'removeproducto'))).toEqual(FORBIDDEN('Mutation.deleteproducto'));
    expect(entriesOf(roots(schema).deleteproducto).size).toBe(2);
  });

  test('a copy whose Mutation type is renamed, processed by the same instance, keeps the checks of both names', async () => {
    await loadEntries();
    const schema = buildSchema();
    const plugin = protect(schema, { Mutation: { deleteproducto: refuse }, AdminMutation: { '*': allow() } }, 'ALLOW');
    const renamed = withMutation(schema, (config) => ({ ...config, name: 'AdminMutation' }));
    plugin.onSchemaChange({ schema: renamed });

    for (const target of [schema, renamed]) {
      expect(await directError(target)).toEqual(FORBIDDEN('Mutation.deleteproducto'));
      expect(await rejection(authorize(target, 'deleteproducto'))).toEqual(FORBIDDEN('Mutation.deleteproducto'));
    }
  });

  test('a root wrapped in a schema where its type is not the mutation root gets its entry there, once', async () => {
    await loadEntries();
    const schema = buildSchema();
    const plugin = createAuthPlugin({ Mutation: { deleteproducto: refuse } }, { defaultPolicy: 'ALLOW' });
    plugin.onSchemaChange({ schema: new GraphQLSchema({ query: schema.getQueryType(), types: [schema.getMutationType()] }) });
    expect(entriesOf(roots(schema).deleteproducto).size).toBe(1);
    plugin.onSchemaChange({ schema });
    expect(entriesOf(roots(schema).deleteproducto).size).toBe(1);

    expect(await directError(schema)).toEqual(FORBIDDEN('Mutation.deleteproducto'));
    expect(await rejection(authorize(schema, 'deleteproducto'))).toEqual(FORBIDDEN('Mutation.deleteproducto'));
  });

  test.each([
    ['ALLOW with a rule that denies the root', { Mutation: { deleteproducto: refuse } }, 'ALLOW'],
    ['DENY with a rule only for the transaction field', { Mutation: { transaction: allow() } }, 'DENY'],
  ])('an instance that only processed a copy without a mutation root keeps its checks where the root runs: %s', async (_label, permissions, defaultPolicy) => {
    await loadEntries();
    const schema = buildSchema();
    protect(readOnlyOf(schema), permissions, defaultPolicy);

    for (const target of [schema, copyOf(schema)]) {
      expect(await directError(target)).toEqual(FORBIDDEN('Mutation.deleteproducto'));
      expect(await rejection(authorize(target, 'deleteproducto'))).toEqual(FORBIDDEN('Mutation.deleteproducto'));
    }
  });

  test('such an instance keeps its checks in a schema only a plugin from another core copy processed', async () => {
    await loadEntries();
    const secondAuth = await import('../packages/core/src/auth/index.js?second-evaluation');
    const schema = buildSchema();
    protect(readOnlyOf(schema), { Mutation: { deleteproducto: refuse } }, 'ALLOW');
    protect(schema, { Mutation: { addproducto: allow() } }, 'ALLOW', secondAuth);

    expect(await directError(schema)).toEqual(FORBIDDEN('Mutation.deleteproducto'));
    expect(await rejection(authorize(schema, 'deleteproducto'))).toEqual(FORBIDDEN('Mutation.deleteproducto'));
  });

  test('such an instance that then processes a copy with the Mutation type renamed keeps the checks of both names', async () => {
    await loadEntries();
    const schema = buildSchema();
    const plugin = protect(readOnlyOf(schema), { Mutation: { deleteproducto: refuse }, AdminMutation: { '*': allow() } }, 'ALLOW');
    const renamed = withMutation(schema, (config) => ({ ...config, name: 'AdminMutation' }));
    plugin.onSchemaChange({ schema: renamed });

    for (const target of [renamed, schema]) {
      expect(await directError(target)).toEqual(FORBIDDEN('Mutation.deleteproducto'));
      expect(await rejection(authorize(target, 'deleteproducto'))).toEqual(FORBIDDEN('Mutation.deleteproducto'));
    }
  });

  test('a root whose entry could not be recorded is not wrapped, so a retry records it', async () => {
    await loadEntries();
    const schema = buildSchema();
    const field = roots(schema).deleteproducto;
    const resolve = field.resolve;
    const marker = field.extensions.simfinityMutation;
    Object.defineProperty(marker, KEY, { value: 'not a map', configurable: true });
    const plugin = createAuthPlugin({ Mutation: { deleteproducto: refuse } }, { defaultPolicy: 'ALLOW' });

    expect(() => plugin.onSchemaChange({ schema })).toThrow(TypeError);
    expect(field.resolve).toBe(resolve);
    delete marker[KEY];
    plugin.onSchemaChange({ schema });
    expect(await directError(schema)).toEqual(FORBIDDEN('Mutation.deleteproducto'));
    expect(await rejection(authorize(schema, 'deleteproducto'))).toEqual(FORBIDDEN('Mutation.deleteproducto'));
  });
});

describe('entry protocol and core copies', () => {
  test('entries are a non-enumerable Map under the shared symbol key', async () => {
    const { OPERATION_EVALUATORS } = await loadEntries();
    expect(OPERATION_EVALUATORS).toBe(KEY);
    const schema = buildSchema();
    protect(schema, { Mutation: { deleteproducto: refuse } }, 'ALLOW');
    const marker = roots(schema).deleteproducto.extensions.simfinityMutation;

    expect(Object.keys(marker)).toEqual(['typeName', 'operation']);
    const descriptor = Object.getOwnPropertyDescriptor(marker, KEY);
    expect(descriptor.enumerable).toBe(false);
    expect(descriptor.value).toBeInstanceOf(Map);
    const [entry] = descriptor.value.values();
    expect(entry.protocol).toBe(1);
    expect(entry.isDeferred(schema)).toBe(false);
    expect(typeof entry.run).toBe('function');
  });

  test('an entry with an unknown protocol denies before any entry runs', async () => {
    const { recordOperationEntry } = await loadEntries();
    const schema = buildSchema();
    const rule = vi.fn(() => true);
    protect(schema, { Mutation: { deleteproducto: rule } }, 'ALLOW');
    const run = vi.fn(async () => {});
    recordOperationEntry(roots(schema).deleteproducto, Symbol('a later protocol'), 'Mutation.deleteproducto', {
      protocol: 2, isDeferred: () => false, run,
    });

    expect(await rejection(authorize(schema, 'deleteproducto'))).toEqual(FORBIDDEN('Mutation.deleteproducto'));
    expect(rule).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });

  test('a plugin from a second core copy records entries the first copy runs, and the reverse', async () => {
    const entries = await loadEntries();
    // Distinct URLs evaluate the modules again, as another installed copy of core would.
    const secondAuth = await import('../packages/core/src/auth/index.js?second-evaluation');
    const secondEntries = await import('../packages/core/src/auth/operation-entries.js?second-evaluation');
    expect(secondAuth.createAuthPlugin).not.toBe(createAuthPlugin);
    expect(secondEntries.authorizeOperation).not.toBe(entries.authorizeOperation);

    const fromSecond = buildSchema();
    protect(fromSecond, { Mutation: { deleteproducto: refuse } }, 'ALLOW', secondAuth);
    expect(await rejection(authorize(fromSecond, 'deleteproducto', { entries })))
      .toEqual(FORBIDDEN('Mutation.deleteproducto'));

    const fromFirst = buildSchema();
    protect(fromFirst, { Mutation: { deleteproducto: refuse } }, 'ALLOW');
    expect(await rejection(authorize(fromFirst, 'deleteproducto', { entries: secondEntries })))
      .toEqual(FORBIDDEN('Mutation.deleteproducto'));
  });

  test('the entries are not exported from the package root or the auth subpath', async () => {
    const { OPERATION_EVALUATORS } = await loadEntries();
    expect(OPERATION_EVALUATORS).toBe(KEY);
    for (const name of ['OPERATION_EVALUATORS', 'recordOperationEntry', 'authorizeOperation']) {
      expect(Object.keys(core)).not.toContain(name);
      expect(Object.keys(authSubpath)).not.toContain(name);
      expect(Object.keys(authSubpath.default)).not.toContain(name);
    }
  });
});

describe('the deprecated graphql-middleware auth', () => {
  // graphql-middleware loads the CommonJS graphql build, so its schema must use it too.
  const require = createRequire(import.meta.url);
  const { applyMiddleware } = require('graphql-middleware');
  const cjs = require('graphql');

  // A schema of the CommonJS build with a field marked as a transaction field and a generated root.
  const markedSchema = (calls) => {
    const Producto = new cjs.GraphQLObjectType({
      name: 'Producto', fields: { id: { type: cjs.GraphQLID }, name: { type: cjs.GraphQLString } },
    });
    return new cjs.GraphQLSchema({
      query: new cjs.GraphQLObjectType({ name: 'RootQueryType', fields: { ping: { type: cjs.GraphQLString, resolve: () => 'pong' } } }),
      mutation: new cjs.GraphQLObjectType({
        name: 'Mutation',
        fields: {
          addproducto: {
            type: Producto,
            args: { name: { type: cjs.GraphQLString } },
            extensions: { simfinityMutation: { typeName: 'Producto', operation: 'save' } },
            resolve: (_parent, { name }) => { calls.push('addproducto'); return { id: '1', name }; },
          },
          transaction: {
            type: new cjs.GraphQLList(Producto),
            extensions: { simfinityTransaction: { name: 'transaction', types: [Producto] } },
            resolve: () => { calls.push('transaction'); return []; },
          },
        },
      }),
    });
  };

  test.each([
    ['createAuthMiddleware', createAuthMiddleware],
    ['createFieldMiddleware', createFieldMiddleware],
  ])('%s denies the transaction field, even with a rule that allows it, and still allows addproducto', async (_name, factory) => {
    const calls = [];
    const schema = applyMiddleware(markedSchema(calls), factory({ Mutation: { transaction: allow() } }, { defaultPolicy: 'ALLOW' }));

    const denied = await cjs.graphql({ schema, source: 'mutation { transaction { id } }', contextValue: {} });
    expect(failure(denied)).toEqual(FORBIDDEN('Mutation.transaction'));
    expect(denied.data).toEqual({ transaction: null });
    const added = await cjs.graphql({ schema, source: 'mutation { addproducto(name: "Mate") { id name } }', contextValue: {} });
    expect(added.errors).toBeUndefined();
    expect(added.data).toEqual({ addproducto: { id: '1', name: 'Mate' } });
    expect(calls).toEqual(['addproducto']);
  });

  // graphql-middleware cannot rebuild a schema of the ES module build here, so each Mutation field of a
  // generated schema runs its resolver through the middleware as applyMiddleware would.
  test('on a generated schema, the middleware denies the transaction field before resolving it', async () => {
    const schema = buildSchema();
    const middleware = createAuthMiddleware({ Mutation: { transaction: allow() } }, { defaultPolicy: 'ALLOW' });
    const resolved = [];
    for (const [name, field] of Object.entries(roots(schema))) {
      const resolve = field.resolve;
      field.resolve = (parent, args, ctx, info) => middleware((...rest) => {
        resolved.push(name);
        return resolve(...rest);
      }, parent, args, ctx, info);
    }

    const denied = await graphql({ schema, source: 'mutation { transaction(operations: []) { id } }', contextValue: {} });
    expect(failure(denied)).toEqual(FORBIDDEN('Mutation.transaction'));
    expect(denied.data).toEqual({ transaction: null });
    const added = await graphql({ schema, source: 'mutation { addproducto(input: { name: "Mate" }) { name } }', contextValue: {} });
    expect(added.errors).toBeUndefined();
    expect(added.data).toEqual({ addproducto: { name: 'Mate' } });
    expect(resolved).toEqual(['addproducto']);
  });
});
