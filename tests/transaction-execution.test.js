// The generated transaction field (#151), execution side: the resolver runs the listed operations in
// order in one database transaction, with real GraphQL execution, the official auth plugin and the
// in-memory adapter that implements optimistic concurrency. Before the transaction it snapshots the
// mutation limits, checks the operation count and the models, walks the coerced inputs, plans the
// references and counts the nested entries of the whole list. Each attempt resolves the references of
// each operation on its own copy, authorizes it as its root, runs the root's middleware, checks the
// operation's nested entries against what the attempt has left, and runs it. Every nested entry on the
// attempt's session counts against one joint budget.
import {
  afterEach, beforeEach, describe, expect, test, vi,
} from 'vitest';
import {
  GraphQLEnumType, GraphQLID, GraphQLInt, GraphQLList, GraphQLObjectType, GraphQLScalarType, GraphQLSchema,
  GraphQLString, graphql,
} from 'graphql';
import { configureMutationLimits, createRuntime, SimfinityError } from '@simtlix/simfinity-core';
import { allow, createAuthPlugin, requireRole } from '@simtlix/simfinity-core/auth';
import { resolveReferences } from '../packages/core/src/transaction-references.js';
import { createOptimisticMemoryAdapter, transientError } from './helpers/optimistic-memory-adapter.js';

// A pass-through spy on resolveReferences, which the runtime calls as each operation of an attempt runs.
// vi.mock is hoisted and file-scoped, so the runtime's own import gets the spy.
vi.mock('../packages/core/src/transaction-references.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, resolveReferences: vi.fn(actual.resolveReferences) };
});

const OPTIMISTIC = { mode: 'optimistic' };
const FORBIDDEN = (key) => ({ code: 'FORBIDDEN', status: 403, message: `Access denied to ${key}` });
const NESTED_EXCEEDED = (limit) => ({
  code: 'NESTED_OPERATIONS_EXCEEDED', status: 400, message: `A mutation may perform at most ${limit} nested collection operations`,
});
const OPERATIONS_EXCEEDED = (limit) => ({
  code: 'TRANSACTION_OPERATIONS_EXCEEDED', status: 400, message: `A transaction may run at most ${limit} operations`,
});
const SYNCHRONOUS_ONLY = { code: 'TRANSACTION_UNSUPPORTED', status: 500, message: 'assertTransactionModels must be synchronous' };
const UNLINKED = { code: 'INVALID_MODEL', status: 500, message: 'Estante.cosas cannot store nested items because it has no connectionField' };
const invalidInput = (path, reason) => ({ code: 'INVALID_INPUT', status: 400, message: `Invalid input at ${path}: ${reason}` });

// Loaded on use, so that on a checkout without the module only the test that reads the state fails.
const loadTransactionSchema = () => import('../packages/core/src/transaction-schema.js');

// The single error of a result, as code, status and message.
const failure = (result) => {
  expect(result.errors, JSON.stringify(result.data)).toHaveLength(1);
  const [error] = result.errors;
  const extensions = error.originalError?.extensions ?? error.extensions;
  return { code: extensions?.code, status: extensions?.status, message: error.message };
};

// The operation the single error of a result names.
const positionOf = (result) => {
  const extensions = result.errors[0].originalError?.extensions ?? result.errors[0].extensions;
  return { operationIndex: extensions?.operationIndex, operation: extensions?.operation };
};

// A value a custom scalar's parseValue returns: an instance of a class, which no operation may carry.
class Money {
  constructor(amount) {
    this.amount = amount;
  }
}

let warn;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  configureMutationLimits({});
});

// Unprotected Producto, with a custom scalar `cost` whose values are Money instances; protected Pedido,
// with a state machine (close) and a collection of unprotected Items; protected Estante, whose collection
// of Cosas has no connectionField; Codigo, whose id is a nullable String. The transaction field covers
// Producto, Pedido, Estante and Codigo. Every hook and action adds its name to `events`, and every
// middleware run adds `middleware <operation> <type>`; `hooks` lets a test act inside them.
const build = ({ adapterOptions } = {}) => {
  const adapter = createOptimisticMemoryAdapter(adapterOptions);
  vi.spyOn(adapter, 'withTransaction');
  vi.spyOn(adapter, 'saveRecord');
  const runtime = createRuntime(adapter);
  const events = [];
  const hooks = {};
  const note = (name, ...args) => {
    events.push(name);
    return hooks[name]?.(...args);
  };
  const State = new GraphQLEnumType({ name: 'TeState', values: { OPEN: { value: 'OPEN' }, CLOSED: { value: 'CLOSED' } } });
  const MoneyScalar = new GraphQLScalarType({
    name: 'TeMoney',
    serialize: (value) => (value !== null && typeof value === 'object' ? value.amount : value),
    parseValue: (value) => new Money(value),
    parseLiteral: (ast) => new Money(ast.value),
  });
  const Producto = new GraphQLObjectType({
    name: 'Producto',
    fields: {
      id: { type: GraphQLID }, name: { type: GraphQLString }, price: { type: GraphQLInt }, cost: { type: MoneyScalar },
    },
  });
  const Item = new GraphQLObjectType({
    name: 'Item',
    fields: () => ({
      id: { type: GraphQLID },
      nombre: { type: GraphQLString },
      pedido: { type: Pedido, extensions: { relation: { embedded: false } } },
    }),
  });
  const Pedido = new GraphQLObjectType({
    name: 'Pedido',
    extensions: { concurrency: OPTIMISTIC },
    fields: () => ({
      id: { type: GraphQLID },
      numero: { type: GraphQLString },
      state: { type: State },
      items: { type: new GraphQLList(Item), extensions: { relation: { embedded: false, connectionField: 'pedido' } } },
    }),
  });
  const Cosa = new GraphQLObjectType({ name: 'Cosa', fields: { id: { type: GraphQLID }, label: { type: GraphQLString } } });
  const Estante = new GraphQLObjectType({
    name: 'Estante',
    extensions: { concurrency: OPTIMISTIC },
    fields: {
      id: { type: GraphQLID },
      label: { type: GraphQLString },
      cosas: { type: new GraphQLList(Cosa), resolve: () => [], extensions: { relation: { embedded: false } } },
    },
  });
  const Codigo = new GraphQLObjectType({
    name: 'Codigo', fields: { id: { type: GraphQLString }, label: { type: GraphQLString } },
  });
  const controller = (type) => ({
    onSaving: (record, args, session, context) => note(`${type}.onSaving`, record, args, session, context),
    onSaved: (record, args, session, context) => note(`${type}.onSaved`, record, args, session, context),
    onUpdating: (id, update, session, context) => note(`${type}.onUpdating`, id, update, session, context),
    onUpdated: (record, session, context) => note(`${type}.onUpdated`, record, session, context),
    onDelete: (record, session, context) => note(`${type}.onDelete`, record, session, context),
  });
  runtime.use(async (params, next) => {
    events.push(`middleware ${params.operation} ${params.type.gqltype.name}`);
    await hooks.middleware?.(params);
    await next();
  });
  runtime.connect(null, Producto, 'producto', 'productos', controller('Producto'));
  runtime.connect(null, Item, 'item', 'items', controller('Item'));
  runtime.connect(null, Pedido, 'pedido', 'pedidos', controller('Pedido'), null, {
    initialState: { name: 'OPEN', value: 'OPEN' },
    actions: {
      close: {
        from: { name: 'OPEN', value: 'OPEN' },
        to: { name: 'CLOSED', value: 'CLOSED' },
        action: (args, session) => note('Pedido close action', args, session),
      },
    },
  });
  runtime.connect(null, Cosa, 'cosa', 'cosas', {});
  runtime.connect(null, Estante, 'estante', 'estantes', {});
  runtime.connect(null, Codigo, 'codigo', 'codigos', {});
  const schema = runtime.createSchema(null, null, null, { transaction: { types: [Producto, Pedido, Estante, Codigo] } });
  const run = (source, {
    variableValues, contextValue = {}, rootValue, schema: target = schema,
  } = {}) => graphql({
    schema: target, source, variableValues, contextValue, rootValue,
  });
  const transaction = (operationList, { selection = 'id', ...options } = {}) => run(
    `mutation Run($operations: [TransactionOperation!]!) { transaction(operations: $operations) { ${selection} } }`,
    { variableValues: { operations: operationList }, ...options },
  );
  const callsOf = (methods) => methods.reduce((total, method) => total + (adapter[method]?.mock?.calls.length ?? 0), 0);
  // Every call core made to the adapter's data methods.
  const dataCalls = () => callsOf(['getById', 'update', 'delete', 'find', 'saveRecord']);
  // Those, its transactions and the affinity check.
  const adapterCalls = () => dataCalls() + callsOf(['withTransaction', 'assertTransactionModels']);
  const storedKeys = (prefix = '') => [...adapter.records.keys()].filter((entry) => entry.startsWith(prefix)).sort();
  return {
    adapter, runtime, schema, events, hooks, run, transaction, dataCalls, adapterCalls, storedKeys,
    types: {
      Producto, Pedido, Item, Estante, Codigo,
    },
  };
};

const protect = (schema, permissions, defaultPolicy) => {
  const plugin = createAuthPlugin(permissions, { defaultPolicy });
  plugin.onSchemaChange({ schema });
  return plugin;
};

describe('runs', () => {
  test('an add and an update of its result by $0 run in one transaction, and the update reads what the add wrote', async () => {
    const fixture = build();
    const result = await fixture.transaction([
      { addproducto: { name: 'a', price: 1 } },
      { updateproducto: { id: '$0', name: 'b' } },
    ], { selection: 'id addproducto { id name price } updateproducto { id name price }' });

    expect(result.errors).toBeUndefined();
    expect(result.data.transaction).toEqual([
      { id: '1000', addproducto: { id: '1000', name: 'a', price: 1 }, updateproducto: null },
      { id: '1000', addproducto: null, updateproducto: { id: '1000', name: 'b', price: 1 } },
    ]);
    expect(fixture.adapter.withTransaction).toHaveBeenCalledTimes(1);
    const [given, , Model] = fixture.adapter.withTransaction.mock.calls[0];
    expect(given).toBeNull();
    expect(Model).toBe(fixture.runtime.getModel(fixture.types.Producto));
    // Both operations work on the session of the one attempt.
    const session = fixture.adapter.saveRecord.mock.calls[0][2];
    expect(session).toMatchObject({ memory: true, attempt: 1 });
    expect(fixture.adapter.update.mock.calls.map((call) => call[3])).toEqual([session]);
    expect(fixture.adapter.stored('Producto', '1000')).toMatchObject({ name: 'b', price: 1 });
  });

  test('a failure in the last operation stores nothing', async () => {
    const fixture = build();
    fixture.adapter.seed('Producto', { _id: '1', name: 'kept' });
    const result = await fixture.transaction([
      { addproducto: { name: 'a' } },
      { addpedido: { numero: 'A', items: { added: [{ nombre: 'x' }] } } },
      { deleteproducto: { id: '1' } },
      { updateproducto: { id: '999', name: 'x' } },
    ]);

    expect(failure(result)).toEqual({ code: 'NOT_VALID_ID', status: 404, message: 'Producto 999 is not valid' });
    expect(result.data).toEqual({ transaction: null });
    expect(fixture.adapter.saveRecord).toHaveBeenCalledTimes(3);
    expect(fixture.storedKeys()).toEqual(['Producto:1']);
  });

  test('a delete of a missing record gives a null id and field, and the list continues', async () => {
    const fixture = build();
    fixture.adapter.seed('Producto', { _id: '1', name: 'gone' });
    const result = await fixture.transaction([
      { deleteproducto: { id: '999' } },
      { deletepedido: { id: '998', version: 1 } },
      { deleteproducto: { id: '1' } },
      { addproducto: { name: 'a' } },
    ], { selection: 'id deleteproducto { id name } deletepedido { id } addproducto { id name }' });

    expect(result.errors).toBeUndefined();
    expect(result.data.transaction).toEqual([
      {
        id: null, deleteproducto: null, deletepedido: null, addproducto: null,
      },
      {
        id: null, deleteproducto: null, deletepedido: null, addproducto: null,
      },
      {
        id: '1', deleteproducto: { id: '1', name: 'gone' }, deletepedido: null, addproducto: null,
      },
      {
        id: '1000', deleteproducto: null, deletepedido: null, addproducto: { id: '1000', name: 'a' },
      },
    ]);
    expect(fixture.storedKeys()).toEqual(['Producto:1000']);
  });

  test('each result sets only the field of its own operation, typed as that root', async () => {
    const fixture = build();
    const keys = ['addproducto', 'addpedido', 'updatepedido', 'close_pedido', 'deleteproducto'];
    const result = await fixture.transaction([
      { addproducto: { name: 'a' } },
      { addpedido: { numero: 'A' } },
      { updatepedido: { id: '$1', version: 1, numero: 'B' } },
      { close_pedido: { id: '$1', version: 2 } },
      { deleteproducto: { id: '$0' } },
    ], {
      selection: 'id addproducto { name } addpedido { numero state version } updatepedido { numero version } '
        + 'close_pedido { state version } deleteproducto { name }',
    });

    expect(result.errors).toBeUndefined();
    const only = (id, key, value) => ({
      id, ...Object.fromEntries(keys.map((name) => [name, null])), [key]: value,
    });
    expect(result.data.transaction).toEqual([
      only('1000', 'addproducto', { name: 'a' }),
      only('1001', 'addpedido', { numero: 'A', state: 'OPEN', version: 1 }),
      only('1001', 'updatepedido', { numero: 'B', version: 2 }),
      only('1001', 'close_pedido', { state: 'CLOSED', version: 3 }),
      only('1000', 'deleteproducto', { name: 'a' }),
    ]);
    expect(fixture.storedKeys()).toEqual(['Pedido:1001']);
  });

  test('an inline literal list runs: a reference by $0, a $$ literal and a null nested entry', async () => {
    // Autor has a collection of Libros linked through their autor; the field covers both types.
    configureMutationLimits({ maxNestedOperations: 2 });
    const adapter = createOptimisticMemoryAdapter();
    // The memory adapter's ids are digits; references keep any other text as it is.
    adapter.castId = (id) => String(id);
    vi.spyOn(adapter, 'withTransaction');
    const runtime = createRuntime(adapter);
    const Autor = new GraphQLObjectType({
      name: 'Autor',
      fields: () => ({
        id: { type: GraphQLID },
        nombre: { type: GraphQLString },
        libros: { type: new GraphQLList(Libro), extensions: { relation: { embedded: false, connectionField: 'autor' } } },
      }),
    });
    const Libro = new GraphQLObjectType({
      name: 'Libro',
      fields: () => ({
        id: { type: GraphQLID }, titulo: { type: GraphQLString }, autor: { type: Autor, extensions: { relation: { embedded: false } } },
      }),
    });
    runtime.connect(null, Autor, 'autor', 'autores');
    runtime.connect(null, Libro, 'libro', 'libros');
    const schema = runtime.createSchema(null, null, null, { transaction: { types: [Autor, Libro] } });
    // GraphQL coerces literal input objects into containers with a null prototype, which the nested count
    // reads before the input walk copies them.
    const run = () => graphql({
      schema,
      contextValue: {},
      source: `mutation {
        transaction(operations: [
          { addautor: { nombre: "A", libros: { added: [{ titulo: "uno" }, null] } } },
          { updateautor: { id: "$0", nombre: "B" } },
          { addlibro: { titulo: "$$0 stays", autor: { id: "$$0" } } }
        ]) { id addautor { id nombre } updateautor { id nombre } addlibro { id titulo } }
      }`,
    });
    const result = await run();

    expect(result.errors, JSON.stringify(result.errors)).toBeUndefined();
    expect(result.data.transaction).toEqual([
      {
        id: '1000', addautor: { id: '1000', nombre: 'A' }, updateautor: null, addlibro: null,
      },
      {
        id: '1000', addautor: null, updateautor: { id: '1000', nombre: 'B' }, addlibro: null,
      },
      {
        id: '1002', addautor: null, updateautor: null, addlibro: { id: '1002', titulo: '$$0 stays' },
      },
    ]);
    expect(adapter.withTransaction).toHaveBeenCalledTimes(1);
    expect([...adapter.records.keys()].sort()).toEqual(['Autor:1000', 'Libro:1001', 'Libro:1002']);
    expect(adapter.stored('Autor', '1000')).toMatchObject({ nombre: 'B' });
    expect(adapter.stored('Libro', '1001')).toMatchObject({ titulo: 'uno', autor: '1000' });
    // `$$0` at the reference is the literal `$0`, not operation 0's ID; a string field keeps its text.
    expect(adapter.stored('Libro', '1002')).toMatchObject({ titulo: '$$0 stays', autor: '$0' });

    // The null entry counts against the limit like the other one.
    configureMutationLimits({ maxNestedOperations: 1 });
    expect(failure(await run())).toEqual(NESTED_EXCEEDED(1));
    expect(adapter.withTransaction).toHaveBeenCalledTimes(1);
    expect([...adapter.records.keys()].sort()).toEqual(['Autor:1000', 'Libro:1001', 'Libro:1002']);
  });

  test('a reference to a later operation fails before the transaction, naming its operation', async () => {
    const fixture = build();
    const result = await fixture.transaction([
      { updateproducto: { id: '$1', name: 'b' } },
      { addproducto: { name: 'a' } },
    ]);

    expect(failure(result)).toEqual({
      code: 'INVALID_OPERATION_REFERENCE', status: 400, message: 'Invalid reference at operations[0].updateproducto.id: operation 1 does not precede it',
    });
    expect(positionOf(result)).toEqual({ operationIndex: 0, operation: 'updateproducto' });
    expect(fixture.adapter.withTransaction).not.toHaveBeenCalled();
    expect(fixture.dataCalls()).toBe(0);
  });
});

describe('one record written several times in one list', () => {
  const operationsWith = (closeVersion) => [
    { addpedido: { numero: 'A' } },
    { updatepedido: { id: '$0', version: 1, numero: 'B' } },
    { close_pedido: { id: '$0', version: closeVersion } },
  ];

  test('an add, an update and an action of one record end at version 3', async () => {
    const fixture = build();
    const result = await fixture.transaction(operationsWith(2), { selection: 'id close_pedido { id numero state version }' });

    expect(result.errors).toBeUndefined();
    expect(result.data.transaction[2]).toEqual({
      id: '1000',
      close_pedido: {
        id: '1000', numero: 'B', state: 'CLOSED', version: 3,
      },
    });
    expect(fixture.adapter.stored('Pedido', '1000')).toMatchObject({ numero: 'B', state: 'CLOSED', version: 3 });
  });

  test('repeating version 1 in the action fails with VERSION_CONFLICT and stores nothing', async () => {
    const fixture = build();
    const result = await fixture.transaction(operationsWith(1));

    expect(failure(result)).toEqual({ code: 'VERSION_CONFLICT', status: 409, message: 'Pedido 1000 was modified by another operation' });
    expect(positionOf(result)).toEqual({ operationIndex: 2, operation: 'close_pedido' });
    expect(fixture.storedKeys()).toEqual([]);
  });
});

describe('the operation limit', () => {
  const products = (count) => Array.from({ length: count }, (_, index) => ({ addproducto: { name: `p${index}` } }));

  test('exactly maxTransactionOperations operations run, and one more fails before any adapter call', async () => {
    const fixture = build();
    const result = await fixture.transaction(products(100));
    expect(result.errors).toBeUndefined();
    expect(result.data.transaction).toHaveLength(100);
    expect(fixture.adapter.saveRecord).toHaveBeenCalledTimes(100);

    const other = build();
    const exceeded = await other.transaction(products(101));
    expect(failure(exceeded)).toEqual(OPERATIONS_EXCEEDED(100));
    expect(exceeded.data).toEqual({ transaction: null });
    expect(other.adapterCalls()).toBe(0);
  });

  test('a configured maximum applies the same way', async () => {
    configureMutationLimits({ maxTransactionOperations: 2 });
    const fixture = build();
    expect(failure(await fixture.transaction(products(3)))).toEqual(OPERATIONS_EXCEEDED(2));
    expect(fixture.adapterCalls()).toBe(0);
    expect((await fixture.transaction(products(2))).errors).toBeUndefined();
  });

  test('limits changed while an invocation runs apply from the next invocation on, also to helpers inside it', async () => {
    configureMutationLimits({ maxNestedOperations: 3, maxTransactionOperations: 3 });
    const fixture = build();
    let pedidoId;
    let changed = false;
    fixture.hooks.middleware = () => {
      if (changed) return;
      changed = true;
      configureMutationLimits({ maxNestedOperations: 0, maxTransactionOperations: 1 });
    };
    fixture.hooks['Pedido.onSaved'] = (record) => { pedidoId = record._id; };
    // The helper's entry fits what the snapshotted limit leaves, never the live one.
    fixture.hooks['Producto.onSaved'] = async (record, args, session, context) => {
      if (record.name !== 'b') return;
      await fixture.runtime.updateObject('Pedido', { id: pedidoId, version: 1, items: { added: [{ nombre: 'z' }] } }, session, context);
    };
    const operationList = [
      { addproducto: { name: 'a' } },
      { addpedido: { numero: 'A', items: { added: [{ nombre: 'x' }, { nombre: 'y' }] } } },
      { addproducto: { name: 'b' } },
    ];
    const result = await fixture.transaction(operationList);

    expect(result.errors).toBeUndefined();
    expect(fixture.storedKeys('Item:')).toHaveLength(3);
    expect(fixture.adapter.stored('Pedido', pedidoId)).toMatchObject({ version: 2 });
    expect(failure(await fixture.transaction(operationList))).toEqual(OPERATIONS_EXCEEDED(1));
  });
});

describe('retries', () => {
  test('middleware runs once per operation per attempt on a fresh copy, and the results come from the last attempt', async () => {
    const fixture = build();
    // It replaces the first input and changes the second in place.
    fixture.hooks.middleware = ({ args, context }) => {
      context.calls = (context.calls ?? 0) + 1;
      if (args.input.name === 'a') args.input = { ...args.input, name: 'a!' };
      else args.input.name = `${args.input.name}!`;
    };
    let failures = 1;
    fixture.hooks['Producto.onSaved'] = (record) => {
      if (record.name === 'b!' && failures-- > 0) throw transientError();
    };
    const context = {};
    const result = await fixture.transaction([{ addproducto: { name: 'a' } }, { addproducto: { name: 'b' } }],
      { selection: 'id addproducto { id name }', contextValue: context });

    expect(result.errors).toBeUndefined();
    expect(context.calls).toBe(4);
    expect(result.data.transaction).toEqual([
      { id: '1002', addproducto: { id: '1002', name: 'a!' } },
      { id: '1003', addproducto: { id: '1003', name: 'b!' } },
    ]);
    expect(fixture.storedKeys()).toEqual(['Producto:1002', 'Producto:1003']);
    expect(fixture.adapter.withTransaction).toHaveBeenCalledTimes(1);
  });

  test('a reference resolves to the ID of the current attempt', async () => {
    const fixture = build();
    let failures = 1;
    fixture.hooks['Producto.onUpdated'] = () => {
      if (failures-- > 0) throw transientError();
    };
    const result = await fixture.transaction([{ addproducto: { name: 'a' } }, { updateproducto: { id: '$0', price: 2 } }],
      { selection: 'id updateproducto { id price }' });

    expect(result.errors).toBeUndefined();
    expect(result.data.transaction).toEqual([{ id: '1001', updateproducto: null }, { id: '1001', updateproducto: { id: '1001', price: 2 } }]);
    expect(fixture.adapter.update.mock.calls.map(([, id]) => id)).toEqual(['1000', '1001']);
  });

  test('each operation reads only its own references, once per attempt, not those of the whole list', async () => {
    const fixture = build();
    let failures = 1;
    // The last operation fails once, so the first attempt reaches every reference.
    fixture.hooks['Pedido close action'] = () => {
      if (failures-- > 0) throw transientError();
    };
    // Five references, one in each operation after the adds.
    const operationList = [
      { addpedido: { numero: 'A' } },
      { addproducto: { name: 'a' } },
      { updateproducto: { id: '$1', name: 'b' } },
      { updateproducto: { id: '$1', price: 2 } },
      { deleteproducto: { id: '$1' } },
      { updatepedido: { id: '$0', version: 1, numero: 'B' } },
      { close_pedido: { id: '$0', version: 2 } },
    ];
    resolveReferences.mockClear();
    const result = await fixture.transaction(operationList);

    expect(result.errors).toBeUndefined();
    expect(result.data.transaction.map(({ id }) => id)).toEqual(['1002', '1003', '1003', '1003', '1003', '1002', '1002']);
    const calls = resolveReferences.mock.calls.map(([, positions, , operationIndex]) => ({
      operationIndex, indexes: positions.map(({ index }) => index),
    }));
    expect(calls.length).toBeGreaterThan(0);
    for (const { operationIndex, indexes } of calls) expect(indexes.every((index) => index === operationIndex)).toBe(true);
    // Each attempt passes each position once: two attempts, five references.
    expect(calls.reduce((total, { indexes }) => total + indexes.length, 0)).toBe(10);
  });

  test('a shared input that middleware puts in an operation is copied for it, so a retry starts from that same value', async () => {
    const fixture = build();
    const shared = { name: 'shared', price: 1 };
    fixture.hooks.middleware = ({ operation, args }) => {
      if (operation === 'save') args.input = shared;
    };
    fixture.hooks['Producto.onSaving'] = (record, args) => {
      args.price += 1;
      record.price = args.price;
    };
    let failures = 1;
    fixture.hooks['Producto.onSaved'] = () => {
      if (failures-- > 0) throw transientError();
    };
    const result = await fixture.transaction([{ addproducto: { name: 'a' } }], { selection: 'id addproducto { name price }' });

    expect(result.errors).toBeUndefined();
    expect(shared).toEqual({ name: 'shared', price: 1 });
    expect(result.data.transaction).toEqual([{ id: '1001', addproducto: { name: 'shared', price: 2 } }]);
    expect(fixture.adapter.stored('Producto', '1001')).toMatchObject({ name: 'shared', price: 2 });
    expect(fixture.adapter.withTransaction).toHaveBeenCalledTimes(1);
  });
});

describe('authorization', () => {
  test('under ALLOW, a rule that denies deleteproducto denies it directly and through transaction, also in a toConfig() copy', async () => {
    const fixture = build();
    fixture.adapter.seed('Producto', { _id: '1', name: 'kept' });
    protect(fixture.schema, { Mutation: { deleteproducto: () => false } }, 'ALLOW');
    const copy = new GraphQLSchema(fixture.schema.toConfig());

    for (const schema of [fixture.schema, copy]) {
      expect(failure(await fixture.run('mutation { deleteproducto(id: "1") { id } }', { schema })))
        .toEqual(FORBIDDEN('Mutation.deleteproducto'));
      const result = await fixture.transaction([{ addproducto: { name: 'a' } }, { deleteproducto: { id: '1' } }], { schema });
      expect(failure(result)).toEqual(FORBIDDEN('Mutation.deleteproducto'));
    }
    expect(fixture.adapter.delete).not.toHaveBeenCalled();
    expect(fixture.storedKeys()).toEqual(['Producto:1']);
    // The other roots are not denied, in the copy either.
    expect((await fixture.transaction([{ addproducto: { name: 'b' } }], { schema: copy })).errors).toBeUndefined();
  });

  test('a copy whose Mutation type clones the root markers keeps the checks of the schema the field was built in', async () => {
    const fixture = build();
    fixture.adapter.seed('Producto', { _id: '1', name: 'kept' });
    protect(fixture.schema, { Mutation: { deleteproducto: () => false } }, 'ALLOW');
    const config = fixture.schema.toConfig();
    const mutationConfig = fixture.schema.getMutationType().toConfig();
    const fields = Object.fromEntries(Object.entries(mutationConfig.fields).map(([name, field]) => {
      const marker = field.extensions?.simfinityMutation;
      return [name, marker ? { ...field, extensions: { ...field.extensions, simfinityMutation: { ...marker } } } : field];
    }));
    const copy = new GraphQLSchema({
      ...config,
      mutation: new GraphQLObjectType({ ...mutationConfig, fields }),
      types: config.types.filter((type) => type !== fixture.schema.getMutationType()),
    });
    // The cloned marker carries no entries of its own.
    const cloned = copy.getMutationType().getFields().deleteproducto.extensions.simfinityMutation;
    expect(cloned).not.toBe(fixture.schema.getMutationType().getFields().deleteproducto.extensions.simfinityMutation);
    expect(Object.getOwnPropertySymbols(cloned)).toEqual([]);

    const result = await fixture.transaction([{ deleteproducto: { id: '1' } }], { schema: copy });
    expect(failure(result)).toEqual(FORBIDDEN('Mutation.deleteproducto'));
    expect(fixture.adapter.delete).not.toHaveBeenCalled();
  });

  test('under DENY, the transaction field and each operation need a rule', async () => {
    const outputs = { TransactionResult: { '*': allow() }, Producto: { '*': allow() } };
    const fixture = build();
    protect(fixture.schema, { Mutation: { transaction: allow(), addproducto: allow(), updateproducto: allow() }, ...outputs }, 'DENY');
    const allowed = await fixture.transaction([{ addproducto: { name: 'a' } }, { updateproducto: { id: '$0', name: 'b' } }],
      { selection: 'id updateproducto { name }' });
    expect(allowed.errors).toBeUndefined();
    expect(allowed.data.transaction[1]).toEqual({ id: '1000', updateproducto: { name: 'b' } });

    const denied = await fixture.transaction([{ addproducto: { name: 'c' } }, { deleteproducto: { id: '$0' } }]);
    expect(failure(denied)).toEqual(FORBIDDEN('Mutation.deleteproducto'));
    expect(fixture.storedKeys()).toEqual(['Producto:1000']);

    const other = build();
    protect(other.schema, { Mutation: { addproducto: allow() }, ...outputs }, 'DENY');
    expect(failure(await other.transaction([{ addproducto: { name: 'a' } }]))).toEqual(FORBIDDEN('Mutation.transaction'));
    expect(other.adapterCalls()).toBe(0);
  });

  test('rules see the root value, the resolved ID and the args middleware gets, before middleware and again on a retry', async () => {
    const fixture = build();
    const seen = [];
    const rule = (name) => (parent, args, ctx, info) => {
      fixture.events.push(`rule ${name}`);
      seen.push({
        name, parent, args, copy: structuredClone(args), ctx, fieldName: info.fieldName,
      });
      return true;
    };
    protect(fixture.schema, {
      Mutation: { addpedido: rule('addpedido'), updatepedido: rule('updatepedido'), deletepedido: rule('deletepedido') },
    }, 'ALLOW');
    const middlewareArgs = [];
    fixture.hooks.middleware = ({ args }) => { middlewareArgs.push(args); };
    let failures = 1;
    fixture.hooks['Pedido.onDelete'] = () => {
      if (failures-- > 0) throw transientError();
    };
    const rootValue = { root: true };
    const context = { request: 'transaction' };
    const result = await fixture.transaction([
      { addpedido: { numero: 'A' } },
      { updatepedido: { id: '$0', version: 1, numero: 'B' } },
      { deletepedido: { id: '$0', version: 2 } },
    ], { rootValue, contextValue: context });

    expect(result.errors).toBeUndefined();
    const attempt = (id) => [
      ['addpedido', { input: { numero: 'A' } }],
      ['updatepedido', { input: { id, version: 1, numero: 'B' } }],
      ['deletepedido', { id, version: 2 }],
    ];
    expect(seen.map(({ name, copy }) => [name, copy])).toEqual([...attempt('1000'), ...attempt('1001')]);
    expect(seen.map(({ fieldName }) => fieldName)).toEqual(seen.map(({ name }) => name));
    expect(seen.every(({ parent, ctx }) => parent === rootValue && ctx === context)).toBe(true);
    expect(middlewareArgs).toHaveLength(6);
    middlewareArgs.forEach((args, index) => expect(args).toBe(seen[index].args));
    const order = ['rule addpedido', 'middleware save Pedido', 'rule updatepedido', 'middleware update Pedido',
      'rule deletepedido', 'middleware delete Pedido'];
    expect(fixture.events.filter((event) => /^(rule|middleware) /.test(event))).toEqual([...order, ...order]);
  });

  test('an operation whose root marker cannot carry entries is refused, positioned, and nothing is written', async () => {
    const fixture = build();
    Object.values(fixture.schema.getMutationType().getFields()).forEach((field) => {
      if (field.extensions?.simfinityMutation) Object.freeze(field.extensions.simfinityMutation);
    });
    // The plugin skips the entries it cannot record, and the roots keep their rules when called directly.
    protect(fixture.schema, { Mutation: { deleteproducto: () => false } }, 'ALLOW');
    expect(failure(await fixture.run('mutation { deleteproducto(id: "1") { id } }'))).toEqual(FORBIDDEN('Mutation.deleteproducto'));

    const result = await fixture.transaction([{ addproducto: { name: 'a' } }]);
    expect(failure(result)).toEqual(FORBIDDEN('Mutation.addproducto'));
    expect(positionOf(result)).toEqual({ operationIndex: 0, operation: 'addproducto' });
    expect(fixture.dataCalls()).toBe(0);
    expect(fixture.storedKeys()).toEqual([]);
    expect((await fixture.run('mutation { addproducto(input: { name: "b" }) { name } }')).errors).toBeUndefined();
  });
});

describe('the id of a result', () => {
  const REQUIRES_ADMIN = { code: 'FORBIDDEN', status: 403, message: 'Requires role: admin' };
  const USER = { user: { role: 'user' } };
  const ADMIN = { user: { role: 'admin' } };

  // A schema with the transaction field over Serie only, protected under DENY as the authorization guide
  // suggests: every field of TransactionResult allowed, and Serie.id restricted.
  const buildSeries = () => {
    const adapter = createOptimisticMemoryAdapter();
    const runtime = createRuntime(adapter);
    const Serie = new GraphQLObjectType({ name: 'Serie', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
    runtime.connect(null, Serie, 'serie', 'series');
    const schema = runtime.createSchema(null, null, null, { transaction: { types: [Serie] } });
    protect(schema, {
      Mutation: { transaction: allow(), addserie: allow(), deleteserie: allow() },
      TransactionResult: { '*': allow() },
      Serie: { '*': allow(), id: requireRole('admin') },
    }, 'DENY');
    return { adapter, schema };
  };
  const underAllow = () => {
    const { adapter, schema } = build();
    protect(schema, { Producto: { id: requireRole('admin') } }, 'ALLOW');
    return { adapter, schema };
  };

  test.each([
    ['under ALLOW, Producto.id', underAllow, 'producto'],
    ['under DENY, Serie.id', buildSeries, 'serie'],
  ])('%s restricted to admins applies to the id of each result as it does to a direct call', async (_label, setUp, name) => {
    const { adapter, schema } = setUp();
    const run = (source, contextValue) => graphql({ schema, source, contextValue });
    const direct = (contextValue) => run(`mutation { add${name}(input: { name: "d" }) { id name } }`, contextValue);
    const transaction = (contextValue) => run(`mutation { transaction(operations: [{ add${name}: { name: "t" } }]) { id add${name} { name } } }`,
      contextValue);

    const deniedDirect = await direct(USER);
    expect(failure(deniedDirect)).toEqual(REQUIRES_ADMIN);
    expect(deniedDirect.errors[0].path).toEqual([`add${name}`, 'id']);
    expect(deniedDirect.data).toEqual({ [`add${name}`]: { id: null, name: 'd' } });
    const denied = await transaction(USER);
    expect(failure(denied)).toEqual(REQUIRES_ADMIN);
    expect(denied.errors[0].path).toEqual(['transaction', 0, 'id']);
    expect(denied.data).toEqual({ transaction: [{ id: null, [`add${name}`]: { name: 't' } }] });

    expect(await direct(ADMIN)).toEqual({ data: { [`add${name}`]: { id: '1002', name: 'd' } } });
    expect(await transaction(ADMIN)).toEqual({ data: { transaction: [{ id: '1003', [`add${name}`]: { name: 't' } }] } });
    // A denied id is an output error after the commit: every add was written.
    const typeName = `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
    expect([...adapter.records.keys()].sort()).toEqual(['1000', '1001', '1002', '1003'].map((id) => `${typeName}:${id}`));
  });

  test('the record type\'s id field resolves it, with the record as parent and the info of that field', async () => {
    const fixture = build();
    fixture.adapter.seed('Producto', { _id: '1', name: 'kept' });
    const seen = [];
    protect(fixture.schema, {
      Producto: {
        id: (parent, args, ctx, info) => {
          seen.push({
            parent, args, ctx, fieldName: info.fieldName, parentType: info.parentType, returnType: info.returnType, path: info.path,
          });
          return true;
        },
      },
    }, 'ALLOW');
    const context = { request: 'transaction' };
    const result = await fixture.transaction([
      { updateproducto: { id: '1', name: 'renamed' } },
      { deleteproducto: { id: '999' } },
    ], { selection: 'id', contextValue: context });

    expect(result).toEqual({ data: { transaction: [{ id: '1' }, { id: null }] } });
    // A delete of a missing record has no record, and its id is null without a call.
    expect(seen).toHaveLength(1);
    const [call] = seen;
    expect(call.parent).toMatchObject({ _id: '1', name: 'renamed' });
    expect(call.args).toEqual({});
    expect(call.ctx).toBe(context);
    expect(call.fieldName).toBe('id');
    expect(call.parentType).toBe(fixture.types.Producto);
    expect(call.returnType).toBe(fixture.types.Producto.getFields().id.type);
    expect(call.path).toMatchObject({ key: 'id', prev: { key: 0, prev: { key: 'transaction' } } });
  });
});

describe('the joint nested budget', () => {
  const items = (...names) => names.map((nombre) => (nombre === null ? null : { nombre }));

  test('entries of all operations count together, nulls included, before the transaction', async () => {
    configureMutationLimits({ maxNestedOperations: 3 });
    const fixture = build();
    const allowed = await fixture.transaction([
      { addpedido: { numero: 'A', items: { added: items('x', 'y') } } },
      { addpedido: { numero: 'B', items: { added: items('z') } } },
    ]);
    expect(allowed.errors).toBeUndefined();
    expect(fixture.storedKeys('Item:')).toHaveLength(3);

    const exceeded = await fixture.transaction([
      { addpedido: { numero: 'C', items: { added: items('x', null) } } },
      { addpedido: { numero: 'D', items: { added: items('z', null) } } },
    ]);
    expect(failure(exceeded)).toEqual(NESTED_EXCEEDED(3));
    expect(fixture.adapter.withTransaction).toHaveBeenCalledTimes(1);
  });

  test('null entries that no preflight sees count against the joint budget', async () => {
    // Producto.onSaved saves a Pedido with two null items and one item; saveObject has no preflight.
    const setUp = (limit) => {
      configureMutationLimits({ maxNestedOperations: limit });
      const fixture = build();
      fixture.hooks['Producto.onSaved'] = (record, args, session, context) => fixture.runtime.saveObject('Pedido',
        { numero: 'S', items: { added: items(null, null, 'a') } }, session, context);
      return fixture;
    };
    const operationList = [{ addproducto: { name: 'trigger' } }];

    const allowed = setUp(3);
    expect((await allowed.transaction(operationList)).errors).toBeUndefined();
    expect(allowed.storedKeys('Item:')).toHaveLength(1);
    const exceeded = setUp(2);
    expect(failure(await exceeded.transaction(operationList))).toEqual(NESTED_EXCEEDED(2));
    expect(exceeded.storedKeys()).toEqual([]);
  });

  test('entries that middleware adds are counted', async () => {
    configureMutationLimits({ maxNestedOperations: 3 });
    const fixture = build();
    fixture.hooks.middleware = ({ operation, type, args }) => {
      if (operation === 'save' && type.gqltype.name === 'Pedido' && args.input.numero === 'A') {
        args.input.items.added.push({ nombre: 'from middleware' });
      }
    };
    const first = { addpedido: { numero: 'A', items: { added: items('x') } } };
    expect((await fixture.transaction([first])).errors).toBeUndefined();
    expect(fixture.storedKeys('Item:')).toHaveLength(2);

    const exceeded = await fixture.transaction([first, { addpedido: { numero: 'B', items: { added: items('y', 'z') } } }]);
    expect(failure(exceeded)).toEqual(NESTED_EXCEEDED(3));
    expect(fixture.storedKeys('Item:')).toHaveLength(2);
  });

  test('entries that a state action adds are counted', async () => {
    configureMutationLimits({ maxNestedOperations: 3 });
    const fixture = build();
    fixture.hooks['Pedido close action'] = (args) => {
      args.items = { added: items('from action') };
    };
    const allowed = await fixture.transaction([
      { addpedido: { numero: 'A', items: { added: items('x', 'y') } } },
      { close_pedido: { id: '$0', version: 1 } },
    ]);
    expect(allowed.errors).toBeUndefined();
    expect(fixture.storedKeys('Item:')).toHaveLength(3);

    const exceeded = await fixture.transaction([
      { addpedido: { numero: 'B', items: { added: items('x', 'y', 'z') } } },
      { close_pedido: { id: '$0', version: 1 } },
    ]);
    expect(failure(exceeded)).toEqual(NESTED_EXCEEDED(3));
    expect(fixture.storedKeys('Pedido:')).toEqual(['Pedido:1000']);
  });

  describe.each([
    ['on the attempt session', undefined],
    ['when the adapter hands the helper body another object', { bodySession: (session) => ({ lentFrom: session }) }],
  ])('a controller that calls saveObject and updateObject %s', (_label, adapterOptions) => {
    // Producto.onSaved saves a Pedido with `saved` entries, then updates Pedido 1 with `updated` entries.
    const withHelpers = (saved, updated) => {
      const fixture = build({ adapterOptions });
      fixture.adapter.seed('Pedido', {
        _id: '1', numero: 'P', state: 'OPEN', version: 1,
      });
      fixture.hooks['Producto.onSaved'] = async (record, args, session, context) => {
        await fixture.runtime.saveObject('Pedido', { numero: 'S', items: { added: items(...saved) } }, session, context);
        await fixture.runtime.updateObject('Pedido', { id: '1', version: 1, items: { added: items(...updated) } }, session, context);
      };
      return fixture;
    };
    const run = (fixture) => fixture.transaction([{ addproducto: { name: 'trigger' } }]);

    test('runs entries up to the limit', async () => {
      configureMutationLimits({ maxNestedOperations: 3 });
      const fixture = withHelpers(['a', 'b'], ['c']);
      expect((await run(fixture)).errors).toBeUndefined();
      expect(fixture.storedKeys('Item:')).toHaveLength(3);
      expect(fixture.adapter.stored('Pedido', '1')).toMatchObject({ version: 2 });
    });

    test('counts the entries saveObject runs, which has no preflight', async () => {
      configureMutationLimits({ maxNestedOperations: 3 });
      const fixture = withHelpers(['a', 'b', 'c', 'd'], []);
      expect(failure(await run(fixture))).toEqual(NESTED_EXCEEDED(3));
      expect(fixture.storedKeys()).toEqual(['Pedido:1']);
    });

    test('checks the entries of updateObject against what the attempt has left', async () => {
      configureMutationLimits({ maxNestedOperations: 3 });
      const fixture = withHelpers(['a', 'b'], ['c', 'd']);
      expect(failure(await run(fixture))).toEqual(NESTED_EXCEEDED(3));
      expect(fixture.storedKeys()).toEqual(['Pedido:1']);
      expect(fixture.adapter.stored('Pedido', '1')).toMatchObject({ version: 1 });
    });
  });

  test('no entry is counted twice, wherever it was checked first', async () => {
    // One entry of the operation, one its middleware adds, one of a helper and one of saveObject.
    const setUp = (limit) => {
      configureMutationLimits({ maxNestedOperations: limit });
      const fixture = build();
      fixture.hooks.middleware = ({ operation, type, args }) => {
        if (operation === 'save' && type.gqltype.name === 'Pedido') args.input.items.added.push({ nombre: 'from middleware' });
      };
      fixture.hooks['Pedido.onSaved'] = async (record, args, session, context) => {
        if (record.numero !== 'A') return;
        await fixture.runtime.updateObject('Pedido', { id: record._id, version: 1, items: { added: items('helper') } }, session, context);
        await fixture.runtime.saveObject('Pedido', { numero: 'S', items: { added: items('saveObject') } }, session, context);
      };
      return fixture;
    };
    const operationList = [{ addpedido: { numero: 'A', items: { added: items('own') } } }];

    const fixture = setUp(4);
    expect((await fixture.transaction(operationList)).errors).toBeUndefined();
    expect(fixture.storedKeys('Item:')).toHaveLength(4);
    const tighter = setUp(3);
    expect(failure(await tighter.transaction(operationList))).toEqual(NESTED_EXCEEDED(3));
  });
});

describe('order inside an operation', () => {
  test('the nested limit fails before the locked pre-read, so an early version conflict is not reported', async () => {
    configureMutationLimits({ maxNestedOperations: 1 });
    const fixture = build();
    fixture.adapter.seed('Pedido', {
      _id: '1', numero: 'P', state: 'OPEN', version: 5,
    });
    fixture.hooks.middleware = ({ operation, args }) => {
      if (operation === 'update') args.input.items.added.push({ nombre: 'from middleware' });
    };
    const result = await fixture.transaction([{ updatepedido: { id: '1', version: 1, items: { added: [{ nombre: 'x' }] } } }]);

    expect(failure(result)).toEqual(NESTED_EXCEEDED(1));
    expect(fixture.adapter.withTransaction).toHaveBeenCalledTimes(1);
    expect(fixture.adapter.getById).not.toHaveBeenCalled();
  });

  test('an item for a collection without a connectionField fails before the locked pre-read', async () => {
    const fixture = build();
    fixture.adapter.seed('Estante', { _id: '1', label: 'a', version: 1 });
    const result = await fixture.transaction([{ updateestante: { id: '1', version: 1, cosas: { added: [{ label: 'x' }] } } }]);

    expect(failure(result)).toEqual(UNLINKED);
    expect(fixture.adapter.withTransaction).toHaveBeenCalledTimes(1);
    expect(fixture.adapter.getById).not.toHaveBeenCalled();
  });
});

describe('preflight', () => {
  test('it checks the count, the models, the nested entries, the inputs and the references, in that order', async () => {
    configureMutationLimits({ maxNestedOperations: 1, maxTransactionOperations: 2 });
    const badScalar = { addproducto: { name: 'b', cost: '5' } };
    const badReference = { updateproducto: { id: '$1', name: 'x' } };
    const tooManyEntries = { addpedido: { numero: 'A', items: { added: [{ nombre: 'x' }, { nombre: 'y' }] } } };
    const affinityError = new SimfinityError('Types Pedido, Producto cannot share one database transaction', 'TRANSACTION_UNSUPPORTED', 500);

    const counted = build();
    counted.adapter.assertTransactionModels.mockImplementation(() => { throw affinityError; });
    expect(failure(await counted.transaction([badReference, badScalar, tooManyEntries]))).toEqual(OPERATIONS_EXCEEDED(2));
    expect(counted.adapter.assertTransactionModels).not.toHaveBeenCalled();

    const affinity = build();
    affinity.adapter.assertTransactionModels.mockImplementation(() => { throw affinityError; });
    const refused = await affinity.transaction([badScalar, tooManyEntries]);
    expect(refused.errors[0].originalError).toBe(affinityError);

    // The nested entries of the list are counted on what GraphQL coerced, before the input walk, so a list past
    // the limit fails as a root past it does, whatever else is wrong with it.
    const nested = build();
    expect(failure(await nested.transaction([badScalar, tooManyEntries]))).toEqual(NESTED_EXCEEDED(1));
    expect(failure(await nested.transaction([badReference, tooManyEntries]))).toEqual(NESTED_EXCEEDED(1));
    expect(nested.adapter.assertTransactionModels).toHaveBeenCalledTimes(2);

    const walked = build();
    const invalid = await walked.transaction([badReference, badScalar]);
    expect(failure(invalid)).toEqual(invalidInput('operations[1].addproducto.cost', 'unsupported scalar value'));
    expect(walked.adapter.assertTransactionModels).toHaveBeenCalledTimes(1);

    const planned = build();
    const reference = await planned.transaction([badReference]);
    expect(failure(reference).code).toBe('INVALID_OPERATION_REFERENCE');
    for (const fixture of [counted, affinity, nested, walked, planned]) {
      expect(fixture.adapter.withTransaction).not.toHaveBeenCalled();
      expect(fixture.dataCalls()).toBe(0);
    }
  });
});

describe('deep inputs', () => {
  const NESTED = 'input is nested too deeply';

  // Nodo has a collection of Nodos linked through their parent: each level of an input is a Nodo input, its
  // `children` collection input and the list `added`, three containers.
  const buildNodos = () => {
    const adapter = createOptimisticMemoryAdapter();
    vi.spyOn(adapter, 'withTransaction');
    vi.spyOn(adapter, 'saveRecord');
    const runtime = createRuntime(adapter);
    const Nodo = new GraphQLObjectType({
      name: 'Nodo',
      fields: () => ({
        id: { type: GraphQLID },
        name: { type: GraphQLString },
        parent: { type: Nodo, extensions: { relation: { embedded: false } } },
        children: { type: new GraphQLList(Nodo), extensions: { relation: { embedded: false, connectionField: 'parent' } } },
      }),
    });
    runtime.connect(null, Nodo, 'nodo', 'nodos');
    const schema = runtime.createSchema(null, null, null, { transaction: { types: [Nodo] } });
    adapter.seed('Nodo', { _id: '1', name: 'root' });
    const run = (source, variableValues) => graphql({
      schema, source, variableValues, contextValue: {},
    });
    return {
      adapter,
      runtime,
      root: (input) => run('mutation Add($input: NodoInput!) { addnodo(input: $input) { id } }', { input }),
      transaction: (operations) => run('mutation Run($operations: [TransactionOperation!]!) { transaction(operations: $operations) { id } }',
        { operations }),
      storedNodos: () => [...adapter.records.keys()].filter((key) => key.startsWith('Nodo:')).length,
    };
  };
  // `levels` Nodos, each the only item its parent adds; the deepest one is `leaf`.
  const chain = (levels, leaf = {}) => {
    let node = { name: `n${levels}`, ...leaf };
    for (let level = levels - 1; level >= 1; level -= 1) node = { name: `n${level}`, children: { added: [node] } };
    return node;
  };
  // The path of the container at `level` of an input whose top-level Nodo input is at level 1, below `root`.
  const pathAt = (root, level) => `${root}${'.children.added[0]'.repeat(Math.floor((level - 1) / 3))}${['', '.children', '.children.added'][(level - 1) % 3]}`;

  test('an input 300 levels deep fails with INVALID_INPUT in a helper and in the transaction, before any write', async () => {
    const fixture = buildNodos();
    // The update input is level 1, so its first added Nodo is at level 4.
    const helper = await fixture.runtime.updateObject('Nodo', { id: '1', children: { added: [chain(300)] } }).catch((error) => error);
    expect(helper).toBeInstanceOf(SimfinityError);
    expect({ code: helper.getCode(), status: helper.getStatus(), message: helper.message })
      .toEqual(invalidInput(pathAt('input', 257), NESTED));

    const result = await fixture.transaction([{ addnodo: chain(300) }]);
    expect(failure(result)).toEqual(invalidInput(pathAt('operations[0].addnodo', 257), NESTED));
    expect(positionOf(result)).toEqual({ operationIndex: 0, operation: 'addnodo' });
    expect(fixture.adapter.withTransaction).not.toHaveBeenCalled();
    expect(fixture.adapter.saveRecord).not.toHaveBeenCalled();
    expect(fixture.storedNodos()).toBe(1);
  });

  test('with maxNestedOperations, an input 600 levels deep fails with NESTED_OPERATIONS_EXCEEDED, as the root does', async () => {
    configureMutationLimits({ maxNestedOperations: 5 });
    const fixture = buildNodos();
    expect(failure(await fixture.root(chain(600)))).toEqual(NESTED_EXCEEDED(5));
    expect(failure(await fixture.transaction([{ addnodo: chain(600) }]))).toEqual(NESTED_EXCEEDED(5));
    expect(fixture.adapter.saveRecord).not.toHaveBeenCalled();
    expect(fixture.storedNodos()).toBe(1);
  });

  test('an input nested 256 levels runs, and one more level is refused', async () => {
    const fixture = buildNodos();
    // 86 Nodos: the deepest is at level 3 * 85 + 1 = 256.
    const result = await fixture.transaction([{ addnodo: chain(86) }]);
    expect(result.errors).toBeUndefined();
    expect(fixture.storedNodos()).toBe(1 + 86);
    // Its update input adds a level, so 85 Nodos below it reach 256.
    const updated = await fixture.runtime.updateObject('Nodo', { id: '1', children: { added: [chain(85)] } });
    expect(updated).toMatchObject({ _id: '1' });
    expect(fixture.storedNodos()).toBe(1 + 86 + 85);

    const deeper = await fixture.transaction([{ addnodo: chain(86, { children: {} }) }]);
    expect(failure(deeper)).toEqual(invalidInput(pathAt('operations[0].addnodo', 257), NESTED));
    expect(fixture.storedNodos()).toBe(1 + 86 + 85);
  });
});

describe('context and output', () => {
  test('rules, middleware and controllers of every operation and attempt get the context object itself', async () => {
    const fixture = build();
    const contexts = [];
    protect(fixture.schema, { Mutation: { addproducto: (parent, args, ctx) => { contexts.push(ctx); return true; } } }, 'ALLOW');
    fixture.hooks.middleware = ({ context }) => { contexts.push(context); };
    fixture.hooks['Producto.onSaved'] = (record, args, session, context) => { contexts.push(context); };
    let failures = 1;
    fixture.hooks['Pedido.onSaved'] = (record, args, session, context) => {
      contexts.push(context);
      if (failures-- > 0) throw transientError();
    };
    const context = { request: 'transaction' };
    const result = await fixture.transaction([{ addproducto: { name: 'a' } }, { addpedido: { numero: 'A' } }], { contextValue: context });

    expect(result.errors).toBeUndefined();
    // Per attempt: the rule, middleware and onSaved of addproducto, and the middleware and onSaved of addpedido.
    expect(contexts).toHaveLength(10);
    expect(contexts.every((seen) => seen === context)).toBe(true);
  });

  test('an output field error after the commit keeps the write', async () => {
    const fixture = build();
    protect(fixture.schema, { Producto: { name: () => false } }, 'ALLOW');
    const result = await fixture.transaction([{ addproducto: { name: 'a' } }], { selection: 'id addproducto { id name }' });

    expect(failure(result)).toEqual(FORBIDDEN('Producto.name'));
    expect(result.data).toEqual({ transaction: [{ id: '1000', addproducto: { id: '1000', name: null } }] });
    expect(fixture.adapter.stored('Producto', '1000')).toMatchObject({ name: 'a' });
  });
});

describe('coerced inputs', () => {
  test('a custom scalar whose value is a class instance fails with INVALID_INPUT and its operation, before any adapter call', async () => {
    const fixture = build();
    const result = await fixture.transaction([{ addproducto: { name: 'a' } }, { addproducto: { name: 'b', cost: '5' } }]);

    expect(failure(result)).toEqual(invalidInput('operations[1].addproducto.cost', 'unsupported scalar value'));
    expect(positionOf(result)).toEqual({ operationIndex: 1, operation: 'addproducto' });
    expect(result.errors[0].originalError).toBeInstanceOf(SimfinityError);
    expect(fixture.adapter.withTransaction).not.toHaveBeenCalled();
    expect(fixture.dataCalls()).toBe(0);

    // Its own root still takes it.
    const direct = await fixture.run('mutation { addproducto(input: { name: "c", cost: "5" }) { id cost } }');
    expect(direct.errors).toBeUndefined();
    expect(direct.data).toEqual({ addproducto: { id: '1000', cost: '5' } });
  });

  test('a missing id where the update input declares it nullable fails with REQUIRED_VALUE and its operation', async () => {
    const fixture = build();
    const result = await fixture.transaction([{ addproducto: { name: 'a' } }, { updatecodigo: { label: 'x' } }]);

    expect(failure(result)).toEqual({ code: 'REQUIRED_VALUE', status: 400, message: 'Required value operations[1].updatecodigo.id is missing' });
    expect(positionOf(result)).toEqual({ operationIndex: 1, operation: 'updatecodigo' });
    expect(fixture.adapter.withTransaction).not.toHaveBeenCalled();
  });
});

describe('model affinity', () => {
  test('the adapter check receives the models of the field, at each invocation, before the transaction opens', async () => {
    const fixture = build();
    const { transactionStateOf } = await loadTransactionSchema();
    const state = transactionStateOf(fixture.schema.getMutationType().getFields().transaction);
    const check = fixture.adapter.assertTransactionModels;

    expect((await fixture.transaction([{ addproducto: { name: 'a' } }])).errors).toBeUndefined();
    expect(check).toHaveBeenCalledTimes(1);
    expect(check.mock.calls[0]).toHaveLength(1);
    expect(check.mock.calls[0][0]).toBe(state.models);
    expect(check.mock.invocationCallOrder[0]).toBeLessThan(fixture.adapter.withTransaction.mock.invocationCallOrder[0]);
    expect((await fixture.transaction([{ addproducto: { name: 'b' } }])).errors).toBeUndefined();
    expect(check).toHaveBeenCalledTimes(2);
  });

  test('an error the check throws stops the invocation before the transaction, unchanged', async () => {
    const fixture = build();
    const error = new SimfinityError('Types Pedido, Producto cannot share one database transaction', 'TRANSACTION_UNSUPPORTED', 500);
    fixture.adapter.assertTransactionModels.mockImplementation(() => { throw error; });
    const result = await fixture.transaction([{ addproducto: { name: 'a' } }]);

    expect(result.errors[0].originalError).toBe(error);
    expect(fixture.adapter.withTransaction).not.toHaveBeenCalled();
    expect(fixture.dataCalls()).toBe(0);
  });

  test('a check that returns a thenable gives TRANSACTION_UNSUPPORTED, and a rejected promise is handled', async () => {
    const fixture = build();
    // A plain function: a spy would handle the rejection itself, to record how the promise settled. Vitest
    // fails the run on an unhandled rejection, so this one passes only if core handles it.
    fixture.adapter.assertTransactionModels = () => Promise.reject(new Error('asynchronous check'));
    expect(failure(await fixture.transaction([{ addproducto: { name: 'a' } }]))).toEqual(SYNCHRONOUS_ONLY);

    // The then() of a thenable that is not a promise is never called.
    const then = vi.fn();
    fixture.adapter.assertTransactionModels = () => ({ then });
    expect(failure(await fixture.transaction([{ addproducto: { name: 'a' } }]))).toEqual(SYNCHRONOUS_ONLY);
    expect(then).not.toHaveBeenCalled();
    expect(fixture.adapter.withTransaction).not.toHaveBeenCalled();
    expect(fixture.dataCalls()).toBe(0);
  });

  test('an attempt whose session cannot carry its state runs nothing', async () => {
    const fixture = build();
    fixture.adapter.withTransaction.mockImplementation((session, body) => body(null));
    const result = await fixture.transaction([{ addproducto: { name: 'a' } }]);

    expect(failure(result)).toEqual({
      code: 'TRANSACTION_UNSUPPORTED', status: 500, message: 'The database adapter does not support generated transactions',
    });
    expect(fixture.dataCalls()).toBe(0);
  });
});
