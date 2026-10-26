// The lifecycle helpers (#151): updateObject, deleteObject and transitionObject run, from code, the
// lifecycle of the generated update, delete and state action mutations, on the in-memory adapter that
// implements optimistic concurrency. They check their target and their input before anything is read or
// written, skip the root record's global middleware, work on a snapshot of the caller's input, and run
// in the session the caller supplies or in a transaction of their own.
import {
  afterEach, beforeEach, describe, expect, test, vi,
} from 'vitest';
import {
  GraphQLEnumType, GraphQLID, GraphQLInt, GraphQLList, GraphQLObjectType, GraphQLScalarType, GraphQLString, graphql,
} from 'graphql';
import { configureMutationLimits, createRuntime, SimfinityError } from '@simtlix/simfinity-core';
import { createOptimisticMemoryAdapter, transientError } from './helpers/optimistic-memory-adapter.js';

// A transaction attempt (#151, deliverable B) attaches an execution state to its session; nothing public
// creates one. The states these tests build carry TEST_TOKEN instead of the runtime's private token, and
// this mock lets the runtime find them as well, so the helpers' use of a state can be checked before the
// transaction exists. States of the runtime's own token are found as before.
const { TEST_TOKEN } = vi.hoisted(() => ({ TEST_TOKEN: { owner: 'lifecycle-helpers.test.js' } }));
vi.mock('../packages/core/src/execution-state.js', async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...original,
    executionStateOf: (session, runtimeToken) => original.executionStateOf(session, runtimeToken)
      ?? original.executionStateOf(session, TEST_TOKEN),
  };
});
// Imported on use, so that every other test of this file fails on its own reason on a tree without it.
const executionState = () => import('../packages/core/src/execution-state.js');

const OPTIMISTIC = { mode: 'optimistic' };
const LOCKED = '{"plain":true,"lock":true}';
const STRING_KEY = 'pass the ID as a string, for example String(record._id)';
const CONFLICT = (type, id) => ({ code: 'VERSION_CONFLICT', status: 409, message: `${type} ${id} was modified by another operation` });
const MISSING_ID = (type, id) => ({ code: 'NOT_VALID_ID', status: 404, message: `${type} ${id} is not valid` });
const FOREIGN_CHILD = { code: 'FORBIDDEN', status: 403, message: 'Child does not belong to this parent' };
const INVALID_VERSION = {
  code: 'INVALID_VERSION', status: 400, message: 'Invalid value for version: expected an integer from 1 to 9007199254740991',
};
const WRONG_STATE = { code: 'BAD_REQUEST', status: 400, message: 'Action is not allowed from state CLOSED' };
const invalidInput = (path, reason) => ({ code: 'INVALID_INPUT', status: 400, message: `Invalid input at ${path}: ${reason}` });
const required = (path) => ({ code: 'REQUIRED_VALUE', status: 400, message: `Required value ${path} is missing` });
const notStored = (name) => ({
  code: 'INVALID_OPERATION_TARGET', status: 500, message: `Type ${name} is not a stored record type registered in this runtime`,
});
const noUpdateInput = (name) => ({
  code: 'INVALID_OPERATION_TARGET', status: 500, message: `Type ${name} has no prepared update input with an id field`,
});
const unknownAction = (name, action) => ({
  code: 'UNKNOWN_ACTION', status: 500, message: `Type ${name} has no state machine action ${action}`,
});
const nestedExceeded = (limit) => ({
  code: 'NESTED_OPERATIONS_EXCEEDED', status: 400, message: `A mutation may perform at most ${limit} nested collection operations`,
});

// The error a call rejects with, and the same as code, status and message.
const caught = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
};
const thrown = async (promise) => {
  const error = await caught(promise);
  return { code: error.extensions?.code, status: error.extensions?.status, message: error.message };
};

let warn;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  configureMutationLimits({});
});

// Protected types: Producto, with field and type validators, an enum with internal values and a
// readOnly field; Pedido, with a state machine, an embedded address and a collection of Items; Item, with
// an embedded detail and a reference to its Pedido; Ficha, with a list, a date and a JSON value.
// Unprotected types: Autor, with a state machine and a collection of Libros; Estante, whose collection
// has no connectionField; Codigo, with `id: String`. Target cases: LhAddress (embedded only), Nota (no
// endpoint, with a model for its reference), Sealed (a readOnly id) and Hollow (an empty update input,
// #161). Every hook,
// validator, action and middleware adds its name to `events`, and `hooks` lets a test act inside them.
const build = ({ schema = true } = {}) => {
  const adapter = createOptimisticMemoryAdapter();
  const ownTransaction = adapter.withTransaction;
  adapter.withTransaction = vi.fn((session, body, Model) => ownTransaction(session, body, Model));
  adapter.saveRecord = vi.fn(adapter.saveRecord);
  const runtime = createRuntime(adapter);
  const events = [];
  const hooks = {};
  const note = (name, ...args) => {
    events.push(name);
    return hooks[name]?.(...args);
  };
  const State = new GraphQLEnumType({ name: 'LhState', values: { OPEN: { value: 'OPEN' }, CLOSED: { value: 'CLOSED' } } });
  const Priority = new GraphQLEnumType({ name: 'LhPriority', values: { LOW: { value: 1 }, HIGH: { value: 2 } } });
  const JsonValue = new GraphQLScalarType({ name: 'LhJson' });
  const DateValue = new GraphQLScalarType({ name: 'LhDate', serialize: (value) => (value instanceof Date ? value.toISOString() : value) });
  const Address = new GraphQLObjectType({
    name: 'LhAddress', fields: { street: { type: GraphQLString }, city: { type: GraphQLString } },
  });
  const Producto = new GraphQLObjectType({
    name: 'Producto',
    extensions: {
      concurrency: OPTIMISTIC,
      validations: { UPDATE: [{ validate: (typeName, args, modelArgs, session) => note('Producto validator', args, modelArgs, session) }] },
    },
    fields: {
      id: { type: GraphQLID },
      name: {
        type: GraphQLString,
        extensions: { validations: { UPDATE: [{ validate: () => note('Producto.name validator') }] } },
      },
      price: { type: GraphQLInt },
      priority: { type: Priority },
      sku: { type: GraphQLString, extensions: { readOnly: true } },
    },
  });
  const Item = new GraphQLObjectType({
    name: 'Item',
    extensions: { concurrency: OPTIMISTIC },
    fields: () => ({
      id: { type: GraphQLID },
      nombre: { type: GraphQLString },
      detail: { type: Address, extensions: { relation: { embedded: true } } },
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
      address: { type: Address, extensions: { relation: { embedded: true } } },
      items: { type: new GraphQLList(Item), extensions: { relation: { embedded: false, connectionField: 'pedido' } } },
    }),
  });
  const Ficha = new GraphQLObjectType({
    name: 'Ficha',
    extensions: {
      concurrency: OPTIMISTIC,
      validations: { UPDATE: [{ validate: (typeName, args) => note('Ficha validator', args) }] },
    },
    fields: {
      id: { type: GraphQLID },
      tags: { type: new GraphQLList(GraphQLString) },
      when: { type: DateValue },
      meta: { type: JsonValue },
      address: { type: Address, extensions: { relation: { embedded: true } } },
    },
  });
  const Libro = new GraphQLObjectType({
    name: 'Libro',
    fields: () => ({
      id: { type: GraphQLID },
      titulo: { type: GraphQLString },
      autor: { type: Autor, extensions: { relation: { embedded: false } } },
    }),
  });
  const Autor = new GraphQLObjectType({
    name: 'Autor',
    fields: () => ({
      id: { type: GraphQLID },
      nombre: { type: GraphQLString },
      state: { type: State },
      libros: { type: new GraphQLList(Libro), extensions: { relation: { embedded: false, connectionField: 'autor' } } },
    }),
  });
  const Cosa = new GraphQLObjectType({ name: 'Cosa', fields: { id: { type: GraphQLID }, label: { type: GraphQLString } } });
  const Estante = new GraphQLObjectType({
    name: 'Estante',
    fields: {
      id: { type: GraphQLID },
      label: { type: GraphQLString },
      cosas: { type: new GraphQLList(Cosa), resolve: () => [], extensions: { relation: { embedded: false } } },
    },
  });
  const Sealed = new GraphQLObjectType({
    name: 'Sealed',
    fields: { id: { type: GraphQLID, extensions: { readOnly: true } }, label: { type: GraphQLString } },
  });
  const Hollow = new GraphQLObjectType({
    name: 'Hollow', fields: { id: { type: GraphQLID, extensions: { readOnly: true } } },
  });
  // Its update input declares `id: String`, which is nullable.
  const Codigo = new GraphQLObjectType({
    name: 'Codigo', fields: { id: { type: GraphQLString }, label: { type: GraphQLString } },
  });
  const Nota = new GraphQLObjectType({
    name: 'Nota',
    fields: { texto: { type: GraphQLString }, producto: { type: Producto, extensions: { relation: { embedded: false } } } },
  });
  const controller = (type) => ({
    onSaving: (record, args, session, context) => note(`${type}.onSaving`, record, args, session, context),
    onSaved: (record) => note(`${type}.onSaved`, record),
    onUpdating: (id, update, session, context) => note(`${type}.onUpdating`, id, update, session, context),
    onUpdated: (record, session, context) => note(`${type}.onUpdated`, record, session, context),
    onDelete: (record, session, context) => note(`${type}.onDelete`, record, session, context),
  });
  const close = (name) => ({
    initialState: { name: 'OPEN', value: 'OPEN' },
    actions: {
      close: {
        from: { name: 'OPEN', value: 'OPEN' },
        to: { name: 'CLOSED', value: 'CLOSED' },
        action: (args, session) => note(`${name} close action`, args, session),
      },
    },
  });
  runtime.use(async (params, next) => {
    await note(`middleware ${params.operation} ${params.type?.gqltype.name}`, params);
    await next();
  });
  runtime.addNoEndpointType(Address);
  runtime.connect(null, Producto, 'producto', 'productos', controller('Producto'));
  runtime.connect(null, Item, 'item', 'items', controller('Item'));
  runtime.connect(null, Pedido, 'pedido', 'pedidos', controller('Pedido'), null, close('Pedido'));
  runtime.connect(null, Ficha, 'ficha', 'fichas', controller('Ficha'));
  runtime.connect(null, Libro, 'libro', 'libros', controller('Libro'));
  runtime.connect(null, Autor, 'autor', 'autores', controller('Autor'), null, close('Autor'));
  runtime.connect(null, Cosa, 'cosa', 'cosas', {});
  runtime.connect(null, Estante, 'estante', 'estantes', {});
  runtime.connect(null, Sealed, 'sealed', 'sealeds', {});
  runtime.connect(null, Hollow, 'hollow', 'hollows', {});
  runtime.connect(null, Codigo, 'codigo', 'codigos', {});
  runtime.addNoEndpointType(Nota);
  const graphqlSchema = schema ? runtime.createSchema() : null;
  const run = (source) => graphql({ schema: graphqlSchema, source, contextValue: { request: 'root' } });
  const updates = () => adapter.update.mock.calls
    .map(([Model, id, update, , options]) => ({ type: Model.name, id, update, options }));
  const deletes = () => adapter.delete.mock.calls.map(([Model, id, , options]) => ({ type: Model.name, id, options }));
  // Every adapter call core made that reads, writes or opens a transaction.
  const adapterCalls = () => [adapter.withTransaction, adapter.getById, adapter.update, adapter.delete, adapter.find,
    adapter.saveRecord].reduce((total, spy) => total + spy.mock.calls.length, 0);
  return {
    adapter, runtime, run, events, hooks, updates, deletes, adapterCalls,
  };
};

// Pedido 1 (version 2) owns Item 11 (version 4) and Item 12 (version 7); Pedido 2 owns Item 21.
const seedOrders = (adapter, { pedido = 2 } = {}) => {
  adapter.seed('Pedido', {
    _id: '1', numero: 'A', state: 'OPEN', address: { street: 's', city: 'c' }, version: pedido,
  });
  adapter.seed('Pedido', { _id: '2', numero: 'B', state: 'OPEN', version: 1 });
  adapter.seed('Item', {
    _id: '11', nombre: 'a', detail: { street: 'd', city: 'e' }, pedido: '1', version: 4,
  });
  adapter.seed('Item', { _id: '12', nombre: 'b', pedido: '1', version: 7 });
  adapter.seed('Item', { _id: '21', nombre: 'c', pedido: '2', version: 1 });
};
const seedProduct = (adapter, version = 3) => adapter.seed('Producto', {
  _id: '1', name: 'a', price: 1, version,
});
// Autor 1 owns Libro 11 and Libro 12.
const seedAuthors = (adapter) => {
  adapter.seed('Autor', { _id: '1', nombre: 'a', state: 'OPEN' });
  adapter.seed('Libro', { _id: '11', titulo: 'x', autor: '1' });
  adapter.seed('Libro', { _id: '12', titulo: 'y', autor: '1' });
};
// A stored record without its keys.
const storedData = (adapter, type, id) => {
  const record = adapter.stored(type, id);
  if (record) {
    delete record._id;
    delete record.id;
  }
  return record;
};

// One call of each helper on a target, with an input the target would accept.
const callEach = (runtime, typeName) => [
  ['updateObject', () => runtime.updateObject(typeName, { id: '1', version: 1 })],
  ['deleteObject', () => runtime.deleteObject(typeName, { id: '1', version: 1 })],
  ['transitionObject', () => runtime.transitionObject(typeName, 'close', { id: '1', version: 1 })],
];

describe('targets', () => {
  test.each(['Nope', 'constructor', '__proto__', 'toString'])('%s, which is not registered, fails with INVALID_OPERATION_TARGET', async (name) => {
    const fixture = build();
    for (const [, call] of callEach(fixture.runtime, name)) {
      expect(await thrown(call())).toEqual(notStored(name));
    }
    expect(fixture.adapterCalls()).toBe(0);
  });

  test.each([
    ['undefined', undefined, '(undefined)'],
    ['null', null, '(null)'],
    ['a number', 7, '(number)'],
    ['a symbol', Symbol('Producto'), '(symbol)'],
    ['a GraphQL type', new GraphQLObjectType({ name: 'Producto', fields: { id: { type: GraphQLID } } }), '(object)'],
  ])('a type name that is %s fails with a SimfinityError, never a TypeError', async (label, typeName, shown) => {
    const fixture = build();
    for (const [, call] of callEach(fixture.runtime, typeName)) {
      const error = await caught(call());
      expect(error).toBeInstanceOf(SimfinityError);
      expect({ code: error.extensions.code, status: error.extensions.status, message: error.message }).toEqual(notStored(shown));
    }
  });

  test.each([
    ['an embedded-only type', 'LhAddress'],
    ['a type without an endpoint that only needs a model for its reference', 'Nota'],
  ])('%s is not a stored record', async (label, name) => {
    const fixture = build();
    for (const [, call] of callEach(fixture.runtime, name)) {
      expect(await thrown(call())).toEqual(notStored(name));
    }
    expect(fixture.adapterCalls()).toBe(0);
  });

  test.each([
    ['a readOnly id', 'Sealed'],
    ['an empty update input (#161)', 'Hollow'],
  ])('updateObject and transitionObject on a type with %s fail; deleteObject needs no update input', async (label, name) => {
    const fixture = build();
    expect(await thrown(fixture.runtime.updateObject(name, { label: 'x' }))).toEqual(noUpdateInput(name));
    expect(await thrown(fixture.runtime.transitionObject(name, 'close', { label: 'x' }))).toEqual(noUpdateInput(name));
    expect(fixture.adapterCalls()).toBe(0);
    expect(await fixture.runtime.deleteObject(name, { id: '7' })).toBeNull();
  });

  test('before createSchema(), updateObject and transitionObject find no prepared update input, and deleteObject no stored record', async () => {
    const fixture = build({ schema: false });
    expect(await thrown(fixture.runtime.updateObject('Producto', { id: '1', version: 1 }))).toEqual(noUpdateInput('Producto'));
    expect(await thrown(fixture.runtime.transitionObject('Pedido', 'close', { id: '1', version: 1 }))).toEqual(noUpdateInput('Pedido'));
    expect(await thrown(fixture.runtime.deleteObject('Producto', { id: '1', version: 1 }))).toEqual(notStored('Producto'));
    expect(fixture.adapterCalls()).toBe(0);
  });

  test.each([
    ['an action the state machine does not declare', 'Pedido', 'reopen', 'reopen'],
    ['an inherited member of the actions object', 'Pedido', 'toString', 'toString'],
    ['an action name that is not a string', 'Pedido', 7, '(number)'],
    ['a type without a state machine', 'Producto', 'close', 'close'],
  ])('transitionObject with %s fails with UNKNOWN_ACTION', async (label, typeName, action, shown) => {
    const fixture = build();
    seedOrders(fixture.adapter);
    expect(await thrown(fixture.runtime.transitionObject(typeName, action, { id: '1', version: 2 })))
      .toEqual(unknownAction(typeName, shown));
    expect(fixture.adapterCalls()).toBe(0);
  });

  test('the target is checked before the input', async () => {
    const fixture = build();
    expect(await thrown(fixture.runtime.updateObject('Nope', null))).toEqual(notStored('Nope'));
    expect(await thrown(fixture.runtime.deleteObject('LhAddress', null))).toEqual(notStored('LhAddress'));
    expect(await thrown(fixture.runtime.transitionObject('Pedido', 'reopen', null))).toEqual(unknownAction('Pedido', 'reopen'));
  });
});

describe('input structure', () => {
  test('a record a hook received, spread into the input, fails at its first unknown field and nothing is read or written', async () => {
    const fixture = build();
    seedProduct(fixture.adapter);
    const record = await fixture.runtime.updateObject('Producto', { id: '1', version: 3, name: 'b' });
    expect(record).toMatchObject({ _id: '1', version: 4 });
    fixture.adapter.getById.mockClear();
    fixture.adapter.update.mockClear();
    expect(await thrown(fixture.runtime.updateObject('Producto', { ...record, name: 'c' })))
      .toEqual(invalidInput('input._id', 'unknown field'));
    expect(fixture.adapter.getById).not.toHaveBeenCalled();
    expect(fixture.adapter.update).not.toHaveBeenCalled();
    expect(storedData(fixture.adapter, 'Producto', '1')).toEqual({ name: 'b', price: 1, version: 4 });
  });

  class Input {
    constructor() {
      this.id = '1';
      this.version = 3;
    }
  }

  test.each([
    ['an unknown field', 'Producto', { id: '1', version: 3, color: 'red' }, invalidInput('input.color', 'unknown field')],
    ['a readOnly field', 'Producto', { id: '1', version: 3, sku: 'x' }, invalidInput('input.sku', 'unknown field')],
    ['a managed state', 'Pedido', { id: '1', version: 2, state: 'CLOSED' },
      invalidInput('input.state', 'state changes only through transitionObject')],
    ['a class instance', 'Producto', new Input(), invalidInput('input', 'expected a plain object')],
    ['a bare value for a list', 'Pedido', { id: '1', version: 2, items: { updated: { id: '11', version: 4 } } },
      invalidInput('input.items.updated', 'expected a list')],
    ['a value outside the enum', 'Producto', { id: '1', version: 3, priority: 'HIGH' },
      invalidInput('input.priority', 'not a value of enum LhPriority')],
    ['a missing id', 'Producto', { version: 3, name: 'b' }, required('input.id')],
    ['a null id', 'Producto', { id: null, version: 3 }, required('input.id')],
    ['a missing id on a type that declares id: String', 'Codigo', { label: 'x' }, required('input.id')],
    ['a null id on a type that declares id: String', 'Codigo', { id: null, label: 'x' }, required('input.id')],
    ['a missing version', 'Producto', { id: '1', name: 'b' }, required('input.version')],
    ['a null input', 'Producto', null, required('input')],
  ])('updateObject with %s fails before anything runs', async (label, typeName, input, expected) => {
    const fixture = build();
    seedProduct(fixture.adapter);
    seedOrders(fixture.adapter);
    expect(await thrown(fixture.runtime.updateObject(typeName, input))).toEqual(expected);
    expect(fixture.adapterCalls()).toBe(0);
    expect(fixture.events).toEqual([]);
  });

  test('frozen and null-prototype inputs are accepted, an enum keeps its internal value, and an omitted field stays absent', async () => {
    const fixture = build();
    seedProduct(fixture.adapter);
    const input = Object.freeze(Object.assign(Object.create(null), { id: '1', version: 3, priority: 2 }));
    expect(await fixture.runtime.updateObject('Producto', input)).toMatchObject({ priority: 2, version: 4 });
    expect(fixture.updates()[0].update).toEqual({ id: '1', priority: 2 });
    // An own undefined is omitted; a null clears the field.
    await fixture.runtime.updateObject('Producto', { id: '1', version: 4, name: undefined, price: null });
    expect(fixture.updates()[1].update).toEqual({ id: '1', $unset: { price: '' } });
    expect(storedData(fixture.adapter, 'Producto', '1')).toEqual({ name: 'a', priority: 2, version: 5 });
  });
});

describe('record keys (D1)', () => {
  const keyCases = [
    ['the id of an update', (runtime) => runtime.updateObject('Producto', { id: { $ne: null }, version: 1 }), 'input.id'],
    ['the id of a delete', (runtime) => runtime.deleteObject('Producto', { id: { $ne: null }, version: 1 }), 'input.id'],
    ['the id of a transition', (runtime) => runtime.transitionObject('Pedido', 'close', { id: { $ne: null }, version: 1 }), 'input.id'],
    ['a nested updated id', (runtime) => runtime.updateObject('Pedido', {
      id: '1', version: 2, items: { updated: [{ id: { $ne: null }, version: 4 }] },
    }), 'input.items.updated[0].id'],
    ['the id of a nested protected deleted entry', (runtime) => runtime.updateObject('Pedido', {
      id: '1', version: 2, items: { deleted: [{ id: { $ne: null }, version: 7 }] },
    }), 'input.items.deleted[0].id'],
    ['a nested unprotected deleted ID', (runtime) => runtime.updateObject('Autor', {
      id: '1', libros: { deleted: [{ $ne: null }] },
    }), 'input.libros.deleted[0]'],
    ['the id of a single reference', (runtime) => runtime.updateObject('Item', {
      id: '11', version: 4, pedido: { id: { $ne: null } },
    }), 'input.pedido.id'],
    ['the id of a single reference inside a nested entry', (runtime) => runtime.updateObject('Pedido', {
      id: '1', version: 2, items: { updated: [{ id: '11', version: 4, pedido: { id: { $ne: null } } }] },
    }), 'input.items.updated[0].pedido.id'],
  ];

  test.each(keyCases)('%s given as { $ne: null } fails with INVALID_INPUT before any adapter call', async (label, call, path) => {
    const fixture = build();
    seedOrders(fixture.adapter);
    seedProduct(fixture.adapter);
    seedAuthors(fixture.adapter);
    expect(await thrown(call(fixture.runtime))).toEqual(invalidInput(path, STRING_KEY));
    expect(fixture.adapterCalls()).toBe(0);
    expect(fixture.events).toEqual([]);
  });

  test('the id of deleteObject must be a string, as the delete root declares ID!', async () => {
    const fixture = build();
    seedProduct(fixture.adapter);
    expect(await thrown(fixture.runtime.deleteObject('Producto', { id: 1, version: 3 }))).toEqual(invalidInput('input.id', STRING_KEY));
    expect(await thrown(fixture.runtime.deleteObject('Libro', { id: ['11'] }))).toEqual(invalidInput('input.id', STRING_KEY));
    expect(fixture.adapterCalls()).toBe(0);
  });
});

describe('lifecycle', () => {
  test('updateObject runs validators before onUpdating, skips the root middleware and returns the stored record, which onUpdated receives', async () => {
    const fixture = build();
    seedProduct(fixture.adapter);
    const context = { request: 'helper' };
    const seen = {};
    fixture.hooks['Producto.onUpdating'] = (id, update, session, hookContext) => { seen.context = hookContext; };
    fixture.hooks['Producto.onUpdated'] = (record) => { seen.updated = record; };
    const result = await fixture.runtime.updateObject('Producto', { id: '1', version: 3, name: 'b' }, undefined, context);
    expect(fixture.events).toEqual(['Producto.name validator', 'Producto validator', 'Producto.onUpdating', 'Producto.onUpdated']);
    expect(result).toEqual(fixture.adapter.stored('Producto', '1'));
    expect(result).toEqual({
      _id: '1', id: '1', name: 'b', price: 1, version: 4,
    });
    expect(seen).toEqual({ context, updated: result });
    expect(fixture.adapter.reads()).toEqual([`Producto 1 ${LOCKED}`]);
    expect(fixture.updates()).toEqual([{
      type: 'Producto', id: '1', update: { id: '1', name: 'b' }, options: { expectedVersion: 3 },
    }]);
  });

  // The same input through the generated root and through the helper, on two fixtures with the same data.
  const parity = async (rootSource, helperCall, rootMiddleware) => {
    const root = build();
    const helper = build();
    for (const { adapter } of [root, helper]) {
      seedOrders(adapter);
      seedProduct(adapter);
      seedAuthors(adapter);
    }
    const rootResult = await root.run(rootSource);
    expect(rootResult.errors).toBeUndefined();
    await helperCall(helper.runtime);
    expect(root.events[0]).toBe(rootMiddleware);
    expect(helper.events).toEqual(root.events.slice(1));
    expect(helper.adapter.reads()).toEqual(root.adapter.reads());
    expect(helper.updates()).toEqual(root.updates());
    expect(helper.deletes()).toEqual(root.deletes());
    expect([...helper.adapter.records]).toEqual([...root.adapter.records]);
    return helper;
  };

  test('updateObject runs the lifecycle of the update root: embedded merge, nested entries and their middleware', async () => {
    const helper = await parity(`mutation { updatepedido(input: { id: "1", version: 2, address: { city: "new" },
      items: { updated: [{ id: "11", version: 4, detail: { city: "n2" } }], deleted: [{ id: "12", version: 7 }] } }) { id } }`,
    (runtime) => runtime.updateObject('Pedido', {
      id: '1', version: 2, address: { city: 'new' }, items: { updated: [{ id: '11', version: 4, detail: { city: 'n2' } }], deleted: [{ id: '12', version: 7 }] },
    }), 'middleware update Pedido');
    expect(helper.events).toEqual([
      'Pedido.onUpdating', 'middleware update Item', 'Item.onUpdating', 'Item.onUpdated', 'middleware delete Item', 'Item.onDelete',
      'Pedido.onUpdated',
    ]);
    expect(storedData(helper.adapter, 'Pedido', '1')).toEqual({
      numero: 'A', state: 'OPEN', address: { street: 's', city: 'new' }, version: 3,
    });
  });

  test('transitionObject runs the lifecycle of the state action root', async () => {
    const helper = await parity(`mutation { close_pedido(input: { id: "1", version: 2, address: { city: "new" },
      items: { updated: [{ id: "11", version: 4, nombre: "x" }] } }) { id } }`,
    (runtime) => runtime.transitionObject('Pedido', 'close', {
      id: '1', version: 2, address: { city: 'new' }, items: { updated: [{ id: '11', version: 4, nombre: 'x' }] },
    }), 'middleware state_changed Pedido');
    expect(helper.events).toEqual([
      'Pedido close action', 'Pedido.onUpdating', 'middleware update Item', 'Item.onUpdating', 'Item.onUpdated', 'Pedido.onUpdated',
    ]);
  });

  test('deleteObject runs the lifecycle of the delete root', async () => {
    const helper = await parity('mutation { deleteproducto(id: "1", version: 3) { id } }',
      (runtime) => runtime.deleteObject('Producto', { id: '1', version: 3 }), 'middleware delete Producto');
    expect(helper.events).toEqual(['Producto.onDelete']);
  });

  test('a nested middleware rewrite applies to its own entry only, even when the caller shares a value between entries', async () => {
    const fixture = build();
    seedOrders(fixture.adapter);
    const detail = { city: 'shared' };
    fixture.hooks['middleware update Item'] = ({ args, context }) => {
      expect(context).toEqual({ request: 'helper' });
      if (args.input.id === '11') args.input.detail.city = 'rewritten';
    };
    await fixture.runtime.updateObject('Pedido', {
      id: '1', version: 2, items: { updated: [{ id: '11', version: 4, detail }, { id: '12', version: 7, detail }] },
    }, null, { request: 'helper' });
    expect(fixture.adapter.stored('Item', '11').detail).toEqual({ street: 'd', city: 'rewritten' });
    expect(fixture.adapter.stored('Item', '12').detail).toEqual({ city: 'shared' });
    expect(detail).toEqual({ city: 'shared' });
  });

  test('a foreign child fails on ownership with FORBIDDEN and the parent rolls back', async () => {
    const fixture = build();
    seedOrders(fixture.adapter);
    expect(await thrown(fixture.runtime.updateObject('Pedido', {
      id: '1', version: 2, numero: 'Z', items: { deleted: [{ id: '21', version: 1 }] },
    }))).toEqual(FOREIGN_CHILD);
    expect(fixture.adapter.reads()).toEqual([`Pedido 1 ${LOCKED}`, `Item 21 ${LOCKED}`]);
    expect(storedData(fixture.adapter, 'Pedido', '1')).toMatchObject({ numero: 'A', version: 2 });
    expect(fixture.adapter.stored('Item', '21')).not.toBeNull();
  });

  test('deleteObject returns the deleted record, which onDelete receives, or null for a missing ID', async () => {
    const fixture = build();
    seedProduct(fixture.adapter);
    seedAuthors(fixture.adapter);
    const seen = [];
    fixture.hooks['Producto.onDelete'] = (record) => { seen.push(record); };
    const deleted = await fixture.runtime.deleteObject('Producto', { id: '1', version: 3 });
    expect(deleted).toEqual({
      _id: '1', name: 'a', price: 1, version: 3,
    });
    expect(await fixture.runtime.deleteObject('Producto', { id: '9', version: 1 })).toBeNull();
    expect(seen).toEqual([deleted, null]);
    expect(fixture.deletes()).toEqual([
      { type: 'Producto', id: '1', options: { expectedVersion: 3 } },
      { type: 'Producto', id: '9', options: { expectedVersion: 1 } },
    ]);
    // An unprotected type is deleted by its bare ID, without options.
    expect(await fixture.runtime.deleteObject('Libro', { id: '11' })).toEqual({ _id: '11', titulo: 'x', autor: '1' });
    expect(await fixture.runtime.deleteObject('Autor', { id: '9' })).toBeNull();
    expect(fixture.adapter.delete.mock.calls.slice(2).map((call) => [call[0].name, call[1], call.length]))
      .toEqual([['Libro', '11', 3], ['Autor', '9', 3]]);
  });

  test('updateObject of a missing ID runs validators and onUpdating and fails at the write with NOT_VALID_ID (404)', async () => {
    const fixture = build();
    expect(await thrown(fixture.runtime.updateObject('Producto', { id: '9', version: 1, name: 'b' }))).toEqual(MISSING_ID('Producto', 9));
    expect(fixture.events).toEqual(['Producto.name validator', 'Producto validator', 'Producto.onUpdating']);
    expect(fixture.adapter.reads()).toEqual([`Producto 9 ${LOCKED}`]);
  });

  test('an unprotected update keeps the reads and writes of its root, with nested entries by bare ID', async () => {
    const helper = await parity(`mutation { updateautor(input: { id: "1", nombre: "b",
      libros: { updated: [{ id: "11", titulo: "z" }], deleted: ["12"] } }) { id } }`,
    (runtime) => runtime.updateObject('Autor', {
      id: '1', nombre: 'b', libros: { updated: [{ id: '11', titulo: 'z' }], deleted: ['12'] },
    }), 'middleware update Autor');
    expect(helper.events).toEqual([
      'Autor.onUpdating', 'middleware update Libro', 'Libro.onUpdating', 'Libro.onUpdated', 'middleware delete Libro',
      'Libro.onDelete', 'Autor.onUpdated',
    ]);
    expect(helper.adapter.stored('Libro', '12')).toBeNull();
  });

  test('an unprotected transition keeps the locked read of its root', async () => {
    const helper = await parity('mutation { close_autor(input: { id: "1" }) { id } }',
      (runtime) => runtime.transitionObject('Autor', 'close', { id: '1' }), 'middleware state_changed Autor');
    expect(helper.adapter.reads()).toEqual(['Autor 1 {"lock":true}']);
    expect(helper.events).toEqual(['Autor close action', 'Autor.onUpdating', 'Autor.onUpdated']);
  });
});

describe('state transitions', () => {
  test('one plain locked read serves the version and from-state checks; the action runs in the session of the write', async () => {
    const fixture = build();
    seedOrders(fixture.adapter);
    let actionSession;
    fixture.hooks['Pedido close action'] = (args, session) => { actionSession = session; };
    const result = await fixture.runtime.transitionObject('Pedido', 'close', { id: '1', version: 2 });
    expect(result).toMatchObject({ _id: '1', state: 'CLOSED', version: 3 });
    expect(fixture.adapter.reads()).toEqual([`Pedido 1 ${LOCKED}`]);
    expect(fixture.updates()).toEqual([{
      type: 'Pedido', id: '1', update: { id: '1', state: 'CLOSED' }, options: { expectedVersion: 2 },
    }]);
    expect(fixture.events).toEqual(['Pedido close action', 'Pedido.onUpdating', 'Pedido.onUpdated']);
    expect(actionSession).toBe(fixture.adapter.update.mock.calls[0][3]);
    expect(actionSession).toEqual({ memory: true, attempt: 1 });
  });

  test('with a supplied session, the action receives that session', async () => {
    const fixture = build();
    seedOrders(fixture.adapter);
    const session = { external: true };
    let actionSession;
    fixture.hooks['Pedido close action'] = (args, given) => { actionSession = given; };
    await fixture.runtime.transitionObject('Pedido', 'close', { id: '1', version: 2 }, session);
    expect(actionSession).toBe(session);
  });

  test('an action that changes args.version does not move the precondition', async () => {
    const fixture = build();
    seedOrders(fixture.adapter);
    fixture.hooks['Pedido close action'] = (args) => { args.version = 99; };
    expect(await fixture.runtime.transitionObject('Pedido', 'close', { id: '1', version: 2 })).toMatchObject({ version: 3 });
    expect(fixture.updates()[0].options).toEqual({ expectedVersion: 2 });
  });

  test('from another state it fails with BAD_REQUEST before the action; a missing ID fails with NOT_VALID_ID (404)', async () => {
    const fixture = build();
    fixture.adapter.seed('Pedido', { _id: '3', state: 'CLOSED', version: 5 });
    expect(await thrown(fixture.runtime.transitionObject('Pedido', 'close', { id: '3', version: 5 }))).toEqual(WRONG_STATE);
    expect(await thrown(fixture.runtime.transitionObject('Pedido', 'close', { id: '9', version: 1 }))).toEqual(MISSING_ID('Pedido', 9));
    expect(fixture.events).toEqual([]);
    expect(fixture.adapter.update).not.toHaveBeenCalled();
  });

  test('a state in the input is rejected', async () => {
    const fixture = build();
    seedOrders(fixture.adapter);
    expect(await thrown(fixture.runtime.transitionObject('Pedido', 'close', { id: '1', version: 2, state: 'CLOSED' })))
      .toEqual(invalidInput('input.state', 'state changes only through transitionObject'));
    expect(fixture.adapterCalls()).toBe(0);
  });

  test('it returns the record with its new state', async () => {
    const fixture = build();
    seedAuthors(fixture.adapter);
    expect(await fixture.runtime.transitionObject('Autor', 'close', { id: '1' })).toMatchObject({ _id: '1', state: 'CLOSED' });
  });
});

describe('optimistic concurrency', () => {
  const helperCalls = [
    ['updateObject', (runtime, version) => runtime.updateObject('Pedido', { id: '1', version, numero: 'Z' })],
    ['transitionObject', (runtime, version) => runtime.transitionObject('Pedido', 'close', { id: '1', version })],
    ['deleteObject', (runtime, version) => runtime.deleteObject('Pedido', { id: '1', version })],
  ];

  test.each(helperCalls)('%s with a stale version fails with VERSION_CONFLICT before any hook or action', async (label, call) => {
    const fixture = build();
    seedOrders(fixture.adapter);
    expect(await thrown(call(fixture.runtime, 1))).toEqual(CONFLICT('Pedido', 1));
    expect(fixture.events).toEqual([]);
    expect(fixture.adapter.reads()).toEqual([`Pedido 1 ${LOCKED}`]);
    expect(fixture.adapter.update).not.toHaveBeenCalled();
    expect(fixture.adapter.delete).not.toHaveBeenCalled();
  });

  test.each(helperCalls)('%s with version 0 fails with INVALID_VERSION before anything is read', async (label, call) => {
    const fixture = build();
    seedOrders(fixture.adapter);
    expect(await thrown(call(fixture.runtime, 0))).toEqual(INVALID_VERSION);
    expect(fixture.adapter.getById).not.toHaveBeenCalled();
    expect(fixture.events).toEqual([]);
  });

  test.each(helperCalls)('%s without a version fails with REQUIRED_VALUE at input.version', async (label, call) => {
    const fixture = build();
    seedOrders(fixture.adapter);
    expect(await thrown(call(fixture.runtime, undefined))).toEqual(required('input.version'));
    expect(fixture.adapterCalls()).toBe(0);
  });

  test('a version for an unprotected type is an unknown field', async () => {
    const fixture = build();
    seedAuthors(fixture.adapter);
    expect(await thrown(fixture.runtime.updateObject('Autor', { id: '1', version: 1 }))).toEqual(invalidInput('input.version', 'unknown field'));
    expect(await thrown(fixture.runtime.deleteObject('Autor', { id: '1', version: 1 }))).toEqual(invalidInput('input.version', 'unknown field'));
    expect(fixture.adapterCalls()).toBe(0);
  });
});

describe('sessions', () => {
  const failingCalls = [
    ['updateObject', 'Producto.onUpdating', (runtime, session) => runtime.updateObject('Producto', { id: '1', version: 3, name: 'b' }, session)],
    ['transitionObject', 'Pedido close action', (runtime, session) => runtime.transitionObject('Pedido', 'close', { id: '1', version: 2 }, session)],
    ['deleteObject', 'Producto.onDelete', (runtime, session) => runtime.deleteObject('Producto', { id: '1', version: 3 }, session)],
  ];

  test.each(failingCalls)('%s with a supplied session runs once in it and does not retry a transient error', async (label, hook, call) => {
    const fixture = build();
    seedProduct(fixture.adapter);
    seedOrders(fixture.adapter);
    const session = { external: true };
    const error = transientError();
    fixture.hooks[hook] = () => { throw error; };
    expect(await caught(call(fixture.runtime, session))).toBe(error);
    expect(fixture.adapter.withTransaction).toHaveBeenCalledTimes(1);
    const [given, body, Model] = fixture.adapter.withTransaction.mock.calls[0];
    expect(given).toBe(session);
    expect(typeof body).toBe('function');
    expect(Model).toEqual({ name: label === 'transitionObject' ? 'Pedido' : 'Producto' });
    expect(fixture.events.filter((event) => event === hook)).toHaveLength(1);
    expect(fixture.adapter.getById.mock.calls.every((args) => args[2] === session)).toBe(true);
  });

  test('without a session, the helper owns the transaction and a transient error retries from the snapshot', async () => {
    const fixture = build();
    seedProduct(fixture.adapter);
    const input = { id: '1', version: 3, name: 'b', price: 5 };
    const original = structuredClone(input);
    const seen = [];
    fixture.hooks['Producto validator'] = (args) => {
      seen.push(structuredClone(args));
      args.name = 'changed';
      args.version = 9;
    };
    let failures = 1;
    fixture.hooks['Producto.onUpdating'] = () => {
      if (failures-- > 0) throw transientError();
    };
    const result = await fixture.runtime.updateObject('Producto', input);
    expect(result).toMatchObject({ name: 'b', price: 5, version: 4 });
    expect(fixture.adapter.withTransaction).toHaveBeenCalledTimes(1);
    expect(fixture.adapter.withTransaction.mock.calls[0][0]).toBeNull();
    expect(seen).toEqual([original, original]);
    expect(fixture.adapter.reads()).toEqual([`Producto 1 ${LOCKED}`, `Producto 1 ${LOCKED}`]);
    expect(fixture.updates().map(({ options }) => options)).toEqual([{ expectedVersion: 3 }]);
    expect(input).toEqual(original);
  });
});

describe('isolation', () => {
  test('hooks that change lists, embedded objects, dates and JSON values in their args change neither the retry nor the caller input', async () => {
    const fixture = build();
    fixture.adapter.seed('Ficha', {
      _id: '5', tags: ['a'], when: new Date('2020-01-01T00:00:00Z'), meta: { n: 1 }, address: { street: 's', city: 'c' }, version: 1,
    });
    const input = {
      id: '5', version: 1, tags: ['x', 'y'], when: new Date('2021-02-03T00:00:00Z'), meta: { nested: { n: 2 }, list: [3] }, address: { city: 'z' },
    };
    const original = structuredClone(input);
    const seen = [];
    // The first attempt's validator changes every kind of value in its args, and the attempt then fails.
    fixture.hooks['Ficha validator'] = (args) => {
      seen.push(structuredClone(args));
      if (seen.length > 1) return;
      args.tags.push('leak');
      args.when.setUTCFullYear(1999);
      args.meta.nested.n = 99;
      args.meta.list.push(4);
      args.address.city = 'leak';
    };
    let failures = 1;
    fixture.hooks['Ficha.onUpdating'] = () => {
      if (failures-- > 0) throw transientError();
    };
    expect(await fixture.runtime.updateObject('Ficha', input)).toMatchObject({ version: 2 });
    expect(seen).toEqual([original, original]);
    expect(input).toEqual(original);
    expect(input.when.getTime()).toBe(original.when.getTime());
    expect(storedData(fixture.adapter, 'Ficha', '5')).toEqual({
      tags: ['x', 'y'],
      when: new Date('2021-02-03T00:00:00Z'),
      meta: { nested: { n: 2 }, list: [3] },
      address: { street: 's', city: 'z' },
      version: 2,
    });
  });

  test('the snapshot is taken when the helper is called, before it awaits anything', async () => {
    const fixture = build();
    seedProduct(fixture.adapter);
    const input = { id: '1', version: 3, name: 'b' };
    const pending = fixture.runtime.updateObject('Producto', input);
    input.name = 'changed later';
    input.version = 1;
    expect(await pending).toMatchObject({ name: 'b', version: 4 });
  });
});

describe('nested budget', () => {
  const twoEntries = {
    id: '1', version: 2, items: { updated: [{ id: '11', version: 4 }], deleted: [{ id: '12', version: 7 }] },
  };

  test('with maxNestedOperations 1, two nested entries fail before any adapter call; saveObject keeps no limit', async () => {
    const fixture = build();
    seedOrders(fixture.adapter);
    fixture.runtime.configureMutationLimits({ maxNestedOperations: 1 });
    expect(await thrown(fixture.runtime.updateObject('Pedido', twoEntries))).toEqual(nestedExceeded(1));
    expect(await thrown(fixture.runtime.transitionObject('Pedido', 'close', twoEntries))).toEqual(nestedExceeded(1));
    expect(fixture.adapterCalls()).toBe(0);
    expect(fixture.events).toEqual([]);
    const saved = await fixture.runtime.saveObject('Pedido', { numero: 'N', items: { added: [{ nombre: 'x' }, { nombre: 'y' }] } });
    expect(saved).toMatchObject({ numero: 'N', version: 1 });
  });

  test('as many entries as the limit pass, and null means no limit', async () => {
    const fixture = build();
    seedOrders(fixture.adapter);
    fixture.runtime.configureMutationLimits({ maxNestedOperations: 2 });
    expect(await fixture.runtime.updateObject('Pedido', twoEntries)).toMatchObject({ version: 3 });
    fixture.runtime.configureMutationLimits({ maxNestedOperations: null });
    expect(await fixture.runtime.updateObject('Pedido', {
      id: '1', version: 3, items: { updated: [{ id: '11', version: 5 }], added: [{ nombre: 'x' }, { nombre: 'y' }] },
    })).toMatchObject({ version: 4 });
  });
});

describe('collections', () => {
  test('an item for a collection without a connectionField fails before any write or hook', async () => {
    const fixture = build();
    fixture.adapter.seed('Estante', { _id: '1', label: 'a' });
    expect(await thrown(fixture.runtime.updateObject('Estante', { id: '1', cosas: { added: [{ label: 'x' }] } }))).toEqual({
      code: 'INVALID_MODEL', status: 500, message: 'Estante.cosas cannot store nested items because it has no connectionField',
    });
    expect(fixture.adapterCalls()).toBe(0);
  });
});

describe('the execution state of a transaction attempt', () => {
  const stateWith = async ({ limit, used = 0 }) => {
    const { createExecutionState } = await executionState();
    const state = createExecutionState({ runtimeToken: TEST_TOKEN, limits: { maxNestedOperations: limit, maxTransactionOperations: 100 } });
    state.nestedCount = used;
    return state;
  };

  test('a helper on a session with a state checks its nested entries against the remaining budget of the state, without counting them', async () => {
    const { attachExecutionState } = await executionState();
    const fixture = build();
    seedOrders(fixture.adapter);
    const session = { attempt: 'lent' };
    const state = await stateWith({ limit: 3, used: 2 });
    attachExecutionState(session, state);
    // The live limit is not read inside an attempt.
    fixture.runtime.configureMutationLimits({ maxNestedOperations: 100 });
    expect(await thrown(fixture.runtime.updateObject('Pedido', {
      id: '1', version: 2, items: { updated: [{ id: '11', version: 4 }], deleted: [{ id: '12', version: 7 }] },
    }, session))).toEqual(nestedExceeded(3));
    expect(fixture.adapterCalls()).toBe(0);
    expect(state.nestedCount).toBe(2);
    expect(await fixture.runtime.updateObject('Pedido', {
      id: '1', version: 2, items: { updated: [{ id: '11', version: 4 }] },
    }, session)).toMatchObject({ version: 3 });
  });

  test('a state without a nested limit runs no preflight, whatever the live limit', async () => {
    const { attachExecutionState } = await executionState();
    const fixture = build();
    seedOrders(fixture.adapter);
    const session = { attempt: 'lent' };
    attachExecutionState(session, await stateWith({ limit: null }));
    fixture.runtime.configureMutationLimits({ maxNestedOperations: 0 });
    expect(await fixture.runtime.transitionObject('Pedido', 'close', {
      id: '1', version: 2, items: { updated: [{ id: '11', version: 4 }] },
    }, session)).toMatchObject({ state: 'CLOSED' });
  });

  test.each([
    ['updateObject', 'Producto.onUpdating', (runtime, session) => runtime.updateObject('Producto', { id: '1', version: 3, name: 'b' }, session)],
    ['transitionObject', 'Pedido close action', (runtime, session) => runtime.transitionObject('Pedido', 'close', { id: '1', version: 2 }, session)],
    ['deleteObject', 'Producto.onDelete', (runtime, session) => runtime.deleteObject('Producto', { id: '1', version: 3 }, session)],
    ['saveObject', 'Producto.onSaving', (runtime, session) => runtime.saveObject('Producto', { name: 'n' }, session)],
  ])('%s follows the state to a body session the adapter hands over, for the body only', async (label, hook, call) => {
    const { attachExecutionState, executionStateOf } = await executionState();
    const fixture = build();
    seedProduct(fixture.adapter);
    seedOrders(fixture.adapter);
    const session = { attempt: 'lent' };
    const inner = { attempt: 'inner' };
    const state = await stateWith({ limit: null });
    attachExecutionState(session, state);
    const { withTransaction } = fixture.adapter;
    fixture.adapter.withTransaction = vi.fn((given, body, Model) => withTransaction(given === session ? inner : given, body, Model));
    const seen = [];
    fixture.hooks[hook] = () => { seen.push(executionStateOf(inner, TEST_TOKEN)); };
    await call(fixture.runtime, session);
    expect(seen).toEqual([state]);
    expect(executionStateOf(inner, TEST_TOKEN)).toBeUndefined();
    expect(executionStateOf(session, TEST_TOKEN)).toBe(state);
    // It is removed from the body session when the body fails as well.
    const error = new Error('hook failure');
    fixture.hooks[hook] = () => { throw error; };
    seedProduct(fixture.adapter);
    seedOrders(fixture.adapter);
    expect(await caught(call(fixture.runtime, session))).toBe(error);
    expect(executionStateOf(inner, TEST_TOKEN)).toBeUndefined();
    expect(executionStateOf(session, TEST_TOKEN)).toBe(state);
  });

  test('a body session that already carries the state keeps it after the helper returns', async () => {
    const { attachExecutionState, executionStateOf } = await executionState();
    const fixture = build();
    seedProduct(fixture.adapter);
    const session = { attempt: 'lent' };
    const inner = { attempt: 'inner' };
    const state = await stateWith({ limit: null });
    attachExecutionState(session, state);
    attachExecutionState(inner, state);
    const { withTransaction } = fixture.adapter;
    fixture.adapter.withTransaction = vi.fn((given, body, Model) => withTransaction(given === session ? inner : given, body, Model));
    await fixture.runtime.updateObject('Producto', { id: '1', version: 3, name: 'b' }, session);
    expect(executionStateOf(inner, TEST_TOKEN)).toBe(state);
  });
});
