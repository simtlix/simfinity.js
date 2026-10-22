// Declarative optimistic concurrency (#98): the mutation lifecycle of protected types for a caller who
// can read the record, with an in-memory adapter that implements the adapter contract. The version is
// captured once, the record is read once, plain and locked, and a stale or exhausted version is
// reported before any validator, hook or action of that record runs. Unprotected types keep today's
// reads and writes.
import {
  describe, expect, test, vi,
} from 'vitest';
import {
  GraphQLEnumType, GraphQLID, GraphQLInt, GraphQLList, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';
import { createRuntime } from '@simtlix/simfinity-core';
import { createOptimisticMemoryAdapter, transientError } from './helpers/optimistic-memory-adapter.js';

const MAX = Number.MAX_SAFE_INTEGER;
const OPTIMISTIC = { mode: 'optimistic' };
const LOCKED = '{"plain":true,"lock":true}';
const CONFLICT = (type, id) => ({ code: 'VERSION_CONFLICT', status: 409, message: `${type} ${id} was modified by another operation` });
const EXHAUSTED = (type, id) => ({ code: 'VERSION_EXHAUSTED', status: 409, message: `${type} ${id} has reached the maximum version` });
const MISSING_ID = (type, id) => ({ code: 'NOT_VALID_ID', status: 404, message: `${type} ${id} is not valid` });
const MALFORMED_ID = { code: 'NOT_VALID_ID', status: 400, message: 'Invalid identifier' };
const FOREIGN_CHILD = { code: 'FORBIDDEN', status: 403, message: 'Child does not belong to this parent' };
const REQUIRED_VERSION = { code: 'REQUIRED_VALUE', status: 400, message: 'Required value version is missing' };
const INVALID_VERSION = {
  code: 'INVALID_VERSION', status: 400, message: 'Invalid value for version: expected an integer from 1 to 9007199254740991',
};
const MANAGED = (hook) => ({ code: 'VERSION_MANAGED', status: 500, message: `Producto.version is managed by Simfinity; ${hook} cannot set it` });

// The single error of a result, as code, status and message.
const failure = (result) => {
  expect(result.errors, JSON.stringify(result.data)).toHaveLength(1);
  const [error] = result.errors;
  const extensions = error.originalError?.extensions ?? error.extensions;
  return { code: extensions?.code, status: extensions?.status, message: error.message };
};
const thrown = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return { code: error.extensions?.code, status: error.extensions?.status, message: error.message };
  }
  throw new Error('expected the call to fail');
};

// Protected types: Producto, without embedded fields, with field and type validators; Pedido, with a
// state machine, an embedded address and a collection of Items; Item, with an embedded detail. `hooks`
// lets a test act inside validators, actions and middleware; every hook, validator and action adds its
// name to `events`.
const buildProtected = (adapterOptions) => {
  const adapter = createOptimisticMemoryAdapter(adapterOptions);
  const runtime = createRuntime(adapter);
  const events = [];
  const hooks = {};
  const note = (name, ...args) => {
    events.push(name);
    return hooks[name]?.(...args);
  };
  const State = new GraphQLEnumType({ name: 'OcState', values: { OPEN: { value: 'OPEN' }, CLOSED: { value: 'CLOSED' } } });
  const Address = new GraphQLObjectType({
    name: 'OcAddress', fields: { street: { type: GraphQLString }, city: { type: GraphQLString } },
  });
  const Producto = new GraphQLObjectType({
    name: 'Producto',
    extensions: {
      concurrency: OPTIMISTIC,
      validations: {
        CREATE: [{ validate: (typeName, args, modelArgs) => note('Producto create validator', args, modelArgs) }],
        UPDATE: [{ validate: (typeName, args, modelArgs) => note('Producto validator', args, modelArgs) }],
      },
    },
    fields: {
      id: { type: GraphQLID },
      name: {
        type: GraphQLString,
        extensions: { validations: { UPDATE: [{ validate: () => note('Producto.name validator') }] } },
      },
      price: { type: GraphQLInt },
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
  const controller = (type) => ({
    onSaving: (record, args) => note(`${type}.onSaving`, record, args),
    onSaved: (record) => note(`${type}.onSaved`, record),
    onUpdating: (id, update) => note(`${type}.onUpdating`, id, update),
    onUpdated: (record) => note(`${type}.onUpdated`, record),
    onDelete: (record) => note(`${type}.onDelete`, record),
  });
  runtime.use(async (params, next) => {
    await note(`middleware ${params.operation} ${params.type?.gqltype.name}`, params);
    await next();
  });
  runtime.addNoEndpointType(Address);
  runtime.connect(null, Producto, 'producto', 'productos', controller('Producto'));
  runtime.connect(null, Item, 'item', 'items', controller('Item'));
  runtime.connect(null, Pedido, 'pedido', 'pedidos', controller('Pedido'), null, {
    initialState: { name: 'OPEN', value: 'OPEN' },
    actions: {
      close: {
        from: { name: 'OPEN', value: 'OPEN' },
        to: { name: 'CLOSED', value: 'CLOSED' },
        action: (args) => note('close action', args),
      },
    },
  });
  const schema = runtime.createSchema();
  const run = (source, variableValues) => graphql({
    schema, source, variableValues, contextValue: { request: 'oc' },
  });
  const updates = () => adapter.update.mock.calls
    .map(([Model, id, update, , options]) => ({ type: Model.name, id, update, options }));
  const deletes = () => adapter.delete.mock.calls.map(([Model, id, , options]) => ({ type: Model.name, id, options }));
  return {
    adapter, runtime, run, events, hooks, updates, deletes, Pedido,
  };
};

// Pedido 1 (version 2) owns Item 11 (version 4) and Item 12 (version 7); Pedido 2 owns Item 21.
const seedOrders = (adapter, { item11 = 4, item12 = 7, pedido = 2 } = {}) => {
  adapter.seed('Pedido', {
    _id: '1', numero: 'A', state: 'OPEN', address: { street: 's', city: 'c' }, version: pedido,
  });
  adapter.seed('Pedido', { _id: '2', numero: 'B', state: 'OPEN', version: 1 });
  adapter.seed('Item', {
    _id: '11', nombre: 'a', detail: { street: 'd', city: 'e' }, pedido: '1', version: item11,
  });
  adapter.seed('Item', { _id: '12', nombre: 'b', pedido: '1', version: item12 });
  adapter.seed('Item', { _id: '21', nombre: 'c', pedido: '2', version: 1 });
};
const seedProduct = (adapter, version = 3) => adapter.seed('Producto', {
  _id: '1', name: 'a', price: 1, version,
});
// A record stored before its type was protected, as a MongoDB document can be.
const seedLegacyProduct = (adapter) => adapter.seed('Producto', { _id: '1', name: 'a', price: 1 });
// A stored record without its keys.
const storedData = (adapter, type, id) => {
  const record = adapter.stored(type, id);
  if (record) {
    delete record._id;
    delete record.id;
  }
  return record;
};

describe('update of a protected type', () => {
  test('with the current version, it reads the record once, writes on that version and returns the next one', async () => {
    const fixture = buildProtected();
    seedProduct(fixture.adapter);
    const result = await fixture.run('mutation { updateproducto(input: { id: "1", version: 3, name: "b" }) { id name version } }');
    expect(result.errors).toBeUndefined();
    expect(result.data.updateproducto).toEqual({ id: '1', name: 'b', version: 4 });
    expect(fixture.adapter.reads()).toEqual([`Producto 1 ${LOCKED}`]);
    expect(fixture.updates()).toEqual([{
      type: 'Producto', id: '1', update: { id: '1', name: 'b' }, options: { expectedVersion: 3 },
    }]);
    expect(fixture.events).toEqual([
      'middleware update Producto', 'Producto.name validator', 'Producto validator', 'Producto.onUpdating', 'Producto.onUpdated',
    ]);
    expect(storedData(fixture.adapter, 'Producto', '1')).toEqual({ name: 'b', price: 1, version: 4 });
  });

  test('validators receive the version the client sent, onUpdating an update without it, onUpdated the new version', async () => {
    const fixture = buildProtected();
    seedProduct(fixture.adapter);
    const seen = {};
    fixture.hooks['Producto validator'] = (args, modelArgs) => {
      seen.args = { ...args };
      seen.modelArgs = { ...modelArgs };
    };
    fixture.hooks['Producto.onUpdating'] = (id, update) => { seen.update = { ...update }; };
    fixture.hooks['Producto.onUpdated'] = (record) => { seen.updated = record.version; };
    const result = await fixture.run('mutation { updateproducto(input: { id: "1", version: 3, name: null }) { version } }');
    expect(result.errors).toBeUndefined();
    expect(seen).toEqual({
      args: { id: '1', version: 3, name: null },
      modelArgs: { id: '1' },
      update: { id: '1', $unset: { name: '' } },
      updated: 4,
    });
  });

  test('with a stale version, it fails with VERSION_CONFLICT before any validator or hook and writes nothing', async () => {
    const fixture = buildProtected();
    seedProduct(fixture.adapter);
    const result = await fixture.run('mutation { updateproducto(input: { id: "1", version: 2, name: "b" }) { id } }');
    expect(failure(result)).toEqual(CONFLICT('Producto', 1));
    expect(fixture.events).toEqual(['middleware update Producto']);
    expect(fixture.adapter.reads()).toEqual([`Producto 1 ${LOCKED}`]);
    expect(fixture.adapter.update).not.toHaveBeenCalled();
    expect(storedData(fixture.adapter, 'Producto', '1')).toEqual({ name: 'a', price: 1, version: 3 });
  });

  test('at the maximum version, it fails with VERSION_EXHAUSTED before any validator or hook', async () => {
    const fixture = buildProtected();
    seedProduct(fixture.adapter, MAX);
    const result = await fixture.run(`mutation { updateproducto(input: { id: "1", version: ${MAX}, name: "b" }) { id } }`);
    expect(failure(result)).toEqual(EXHAUSTED('Producto', 1));
    expect(fixture.events).toEqual(['middleware update Producto']);
    expect(fixture.adapter.update).not.toHaveBeenCalled();
    expect(storedData(fixture.adapter, 'Producto', '1')).toEqual({ name: 'a', price: 1, version: MAX });
  });

  test('of a missing ID, it still runs validators and onUpdating and fails at the write with NOT_VALID_ID', async () => {
    const fixture = buildProtected();
    const result = await fixture.run('mutation { updateproducto(input: { id: "9", version: 1, name: "b" }) { id } }');
    expect(failure(result)).toEqual(MISSING_ID('Producto', 9));
    expect(fixture.events).toEqual([
      'middleware update Producto', 'Producto.name validator', 'Producto validator', 'Producto.onUpdating',
    ]);
    expect(fixture.adapter.reads()).toEqual([`Producto 9 ${LOCKED}`]);
    expect(fixture.updates()).toEqual([{
      type: 'Producto', id: '9', update: { id: '9', name: 'b' }, options: { expectedVersion: 1 },
    }]);
  });

  test('of a malformed ID, it fails with NOT_VALID_ID at the read, before any validator or hook', async () => {
    const fixture = buildProtected();
    const result = await fixture.run('mutation { updateproducto(input: { id: "x1", version: 1, name: "b" }) { id } }');
    expect(failure(result)).toEqual(MALFORMED_ID);
    expect(fixture.events).toEqual(['middleware update Producto']);
    expect(fixture.adapter.update).not.toHaveBeenCalled();
  });

  test('a validator that changes args.version does not move the precondition', async () => {
    const fixture = buildProtected();
    seedProduct(fixture.adapter);
    fixture.hooks['Producto validator'] = (args) => { args.version = 9; };
    const result = await fixture.run('mutation { updateproducto(input: { id: "1", version: 3, name: "b" }) { version } }');
    expect(result.errors).toBeUndefined();
    expect(result.data.updateproducto).toEqual({ version: 4 });
    expect(fixture.updates()[0].options).toEqual({ expectedVersion: 3 });
  });

  test('a record stored without a version reads as 1 and advances to 2', async () => {
    const fixture = buildProtected();
    seedLegacyProduct(fixture.adapter);
    const stale = await fixture.run('mutation { updateproducto(input: { id: "1", version: 2, name: "b" }) { id } }');
    expect(failure(stale)).toEqual(CONFLICT('Producto', 1));
    const result = await fixture.run('mutation { updateproducto(input: { id: "1", version: 1, name: "b" }) { version } }');
    expect(result.errors).toBeUndefined();
    expect(result.data.updateproducto).toEqual({ version: 2 });
  });
});

describe('state action of a protected type', () => {
  test('with the current version, one plain locked read serves the version check, the from-state check and the update', async () => {
    const fixture = buildProtected();
    seedOrders(fixture.adapter, { pedido: 5 });
    const result = await fixture.run('mutation { close_pedido(input: { id: "1", version: 5 }) { state version } }');
    expect(result.errors).toBeUndefined();
    expect(result.data.close_pedido).toEqual({ state: 'CLOSED', version: 6 });
    expect(fixture.adapter.reads()).toEqual([`Pedido 1 ${LOCKED}`]);
    expect(fixture.updates()).toEqual([{
      type: 'Pedido', id: '1', update: { id: '1', state: 'CLOSED' }, options: { expectedVersion: 5 },
    }]);
    expect(fixture.events).toEqual([
      'middleware state_changed Pedido', 'close action', 'Pedido.onUpdating', 'Pedido.onUpdated',
    ]);
  });

  test('an action that changes args.version does not move the precondition', async () => {
    const fixture = buildProtected();
    seedOrders(fixture.adapter, { pedido: 5 });
    fixture.hooks['close action'] = (args) => { args.version = 99; };
    const result = await fixture.run('mutation { close_pedido(input: { id: "1", version: 5 }) { version } }');
    expect(result.errors).toBeUndefined();
    expect(result.data.close_pedido).toEqual({ version: 6 });
    expect(fixture.updates()[0].options).toEqual({ expectedVersion: 5 });
  });

  test('with a stale version, it fails with VERSION_CONFLICT before the action, also from another state', async () => {
    const fixture = buildProtected();
    seedOrders(fixture.adapter, { pedido: 5 });
    const stale = await fixture.run('mutation { close_pedido(input: { id: "1", version: 4 }) { id } }');
    expect(failure(stale)).toEqual(CONFLICT('Pedido', 1));
    fixture.adapter.seed('Pedido', { _id: '3', state: 'CLOSED', version: 5 });
    const staleClosed = await fixture.run('mutation { close_pedido(input: { id: "3", version: 4 }) { id } }');
    expect(failure(staleClosed)).toEqual(CONFLICT('Pedido', 3));
    expect(fixture.events).toEqual(['middleware state_changed Pedido', 'middleware state_changed Pedido']);
    expect(fixture.adapter.update).not.toHaveBeenCalled();
    // With the current version, the from-state check runs on the plain record.
    const closed = await fixture.run('mutation { close_pedido(input: { id: "3", version: 5 }) { id } }');
    expect(failure(closed)).toEqual({ code: 'BAD_REQUEST', status: 400, message: 'Action is not allowed from state CLOSED' });
  });

  test('at the maximum version, it fails with VERSION_EXHAUSTED before the action', async () => {
    const fixture = buildProtected();
    seedOrders(fixture.adapter, { pedido: MAX });
    const result = await fixture.run(`mutation { close_pedido(input: { id: "1", version: ${MAX} }) { id } }`);
    expect(failure(result)).toEqual(EXHAUSTED('Pedido', 1));
    expect(fixture.events).toEqual(['middleware state_changed Pedido']);
    expect(fixture.adapter.update).not.toHaveBeenCalled();
  });

  test('of a missing ID, it fails with NOT_VALID_ID (404) before the action, and of a malformed one with 400', async () => {
    const fixture = buildProtected();
    const missing = await fixture.run('mutation { close_pedido(input: { id: "9", version: 1 }) { id } }');
    expect(failure(missing)).toEqual(MISSING_ID('Pedido', 9));
    const malformed = await fixture.run('mutation { close_pedido(input: { id: "x1", version: 1 }) { id } }');
    expect(failure(malformed)).toEqual(MALFORMED_ID);
    expect(fixture.events).toEqual(['middleware state_changed Pedido', 'middleware state_changed Pedido']);
    expect(fixture.adapter.reads()).toEqual([`Pedido 9 ${LOCKED}`, `Pedido x1 ${LOCKED}`]);
    expect(fixture.adapter.update).not.toHaveBeenCalled();
  });

  test('with an embedded value and nested entries, it reads each record once, merges from the plain record and checks each child after ownership', async () => {
    const fixture = buildProtected();
    seedOrders(fixture.adapter);
    const result = await fixture.run(`mutation { close_pedido(input: { id: "1", version: 2, address: { city: "new" },
      items: { updated: [{ id: "11", version: 4, detail: { city: "n2" } }], deleted: [{ id: "12", version: 7 }] } }) {
      state version address { street city } items { id version detail { street city } } } }`);
    expect(result.errors).toBeUndefined();
    expect(result.data.close_pedido).toEqual({
      state: 'CLOSED', version: 3, address: { street: 's', city: 'new' },
      items: [{ id: '11', version: 5, detail: { street: 'd', city: 'n2' } }],
    });
    expect(fixture.adapter.reads()).toEqual([`Pedido 1 ${LOCKED}`, `Item 11 ${LOCKED}`, `Item 12 ${LOCKED}`]);
    expect(fixture.updates().map(({ type, id, options }) => ({ type, id, options }))).toEqual([
      { type: 'Pedido', id: '1', options: { expectedVersion: 2 } },
      { type: 'Item', id: '11', options: { expectedVersion: 4 } },
    ]);
    expect(fixture.deletes()).toEqual([{ type: 'Item', id: '12', options: { expectedVersion: 7 } }]);
    expect(storedData(fixture.adapter, 'Pedido', '1')).toEqual({
      numero: 'A', state: 'CLOSED', address: { street: 's', city: 'new' }, version: 3,
    });
    expect(fixture.adapter.stored('Item', '12')).toBeNull();

    // A foreign child with a stale version fails on ownership, after the parent's write, which rolls back.
    const second = buildProtected();
    seedOrders(second.adapter);
    const foreign = await second.run(`mutation { close_pedido(input: { id: "1", version: 2, address: { city: "new" },
      items: { deleted: [{ id: "21", version: 9 }] } }) { id } }`);
    expect(failure(foreign)).toEqual(FOREIGN_CHILD);
    expect(second.adapter.reads()).toEqual([`Pedido 1 ${LOCKED}`, `Item 21 ${LOCKED}`]);
    expect(second.events).toEqual([
      'middleware state_changed Pedido', 'close action', 'Pedido.onUpdating', 'middleware delete Item',
    ]);
    expect(storedData(second.adapter, 'Pedido', '1')).toEqual({
      numero: 'A', state: 'OPEN', address: { street: 's', city: 'c' }, version: 2,
    });
  });
});

describe('delete of a protected type', () => {
  test('with the current version, onDelete receives the stored record and the delete is conditioned on it', async () => {
    const fixture = buildProtected();
    seedProduct(fixture.adapter);
    let seen;
    fixture.hooks['Producto.onDelete'] = (record) => { seen = record; };
    const result = await fixture.run('mutation { deleteproducto(id: "1", version: 3) { id name version } }');
    expect(result.errors).toBeUndefined();
    expect(result.data.deleteproducto).toEqual({ id: '1', name: 'a', version: 3 });
    expect(seen).toMatchObject({ _id: '1', name: 'a', version: 3 });
    expect(fixture.adapter.reads()).toEqual([`Producto 1 ${LOCKED}`]);
    expect(fixture.deletes()).toEqual([{ type: 'Producto', id: '1', options: { expectedVersion: 3 } }]);
    expect(fixture.adapter.stored('Producto', '1')).toBeNull();
  });

  test('with a stale version, it fails with VERSION_CONFLICT before onDelete and the record remains', async () => {
    const fixture = buildProtected();
    seedProduct(fixture.adapter);
    const result = await fixture.run('mutation { deleteproducto(id: "1", version: 2) { id } }');
    expect(failure(result)).toEqual(CONFLICT('Producto', 1));
    expect(fixture.events).toEqual(['middleware delete Producto']);
    expect(fixture.adapter.delete).not.toHaveBeenCalled();
    expect(storedData(fixture.adapter, 'Producto', '1')).toEqual({ name: 'a', price: 1, version: 3 });
  });

  test('at the maximum version, it deletes, since a delete does not advance the version', async () => {
    const fixture = buildProtected();
    seedProduct(fixture.adapter, MAX);
    const result = await fixture.run(`mutation { deleteproducto(id: "1", version: ${MAX}) { version } }`);
    expect(result.errors).toBeUndefined();
    expect(result.data.deleteproducto).toEqual({ version: MAX });
  });

  test('of a missing ID, onDelete runs with null and the mutation returns null; a malformed ID fails before it', async () => {
    const fixture = buildProtected();
    const seen = [];
    fixture.hooks['Producto.onDelete'] = (record) => { seen.push(record); };
    const missing = await fixture.run('mutation { deleteproducto(id: "9", version: 1) { id } }');
    expect(missing.errors).toBeUndefined();
    expect(missing.data.deleteproducto).toBeNull();
    expect(seen).toEqual([null]);
    expect(fixture.deletes()).toEqual([{ type: 'Producto', id: '9', options: { expectedVersion: 1 } }]);
    const malformed = await fixture.run('mutation { deleteproducto(id: "x1", version: 1) { id } }');
    expect(failure(malformed)).toEqual(MALFORMED_ID);
    expect(seen).toEqual([null]);
  });

  test('a record stored without a version reaches onDelete with version 1', async () => {
    const fixture = buildProtected();
    seedLegacyProduct(fixture.adapter);
    let seen;
    fixture.hooks['Producto.onDelete'] = (record) => { seen = record.version; };
    const result = await fixture.run('mutation { deleteproducto(id: "1", version: 1) { version } }');
    expect(result.errors).toBeUndefined();
    expect(result.data.deleteproducto).toEqual({ version: 1 });
    expect(seen).toBe(1);
  });
});

describe('nested entries of protected children', () => {
  test('with current versions, each child is read once, checked and written on its version', async () => {
    const fixture = buildProtected();
    seedOrders(fixture.adapter);
    const result = await fixture.run(`mutation { updatepedido(input: { id: "1", version: 2,
      items: { updated: [{ id: "11", version: 4, nombre: "x" }], deleted: [{ id: "12", version: 7 }] } }) {
      version items { id nombre version } } }`);
    expect(result.errors).toBeUndefined();
    expect(result.data.updatepedido).toEqual({ version: 3, items: [{ id: '11', nombre: 'x', version: 5 }] });
    expect(fixture.adapter.reads()).toEqual([`Pedido 1 ${LOCKED}`, `Item 11 ${LOCKED}`, `Item 12 ${LOCKED}`]);
    expect(fixture.updates().map(({ type, id, options }) => ({ type, id, options }))).toEqual([
      { type: 'Pedido', id: '1', options: { expectedVersion: 2 } },
      { type: 'Item', id: '11', options: { expectedVersion: 4 } },
    ]);
    expect(fixture.deletes()).toEqual([{ type: 'Item', id: '12', options: { expectedVersion: 7 } }]);
  });

  test('a nested update with an embedded value reads the child once and merges from that record', async () => {
    const fixture = buildProtected();
    seedOrders(fixture.adapter);
    const result = await fixture.run(`mutation { updatepedido(input: { id: "1", version: 2,
      items: { updated: [{ id: "11", version: 4, detail: { city: "n" } }] } }) { id } }`);
    expect(result.errors).toBeUndefined();
    expect(fixture.adapter.reads()).toEqual([`Pedido 1 ${LOCKED}`, `Item 11 ${LOCKED}`]);
    expect(storedData(fixture.adapter, 'Item', '11')).toEqual({
      nombre: 'a', detail: { street: 'd', city: 'n' }, pedido: '1', version: 5,
    });
  });

  test.each([
    ['updated', '{ id: "11", version: 3, nombre: "x" }', 11],
    ['deleted', '{ id: "12", version: 6 }', 12],
  ])('a stale %s child fails with VERSION_CONFLICT before its hooks and rolls back the parent', async (key, entry, id) => {
    const fixture = buildProtected();
    seedOrders(fixture.adapter);
    const result = await fixture.run(`mutation { updatepedido(input: { id: "1", version: 2, numero: "Z",
      items: { ${key}: [${entry}] } }) { id } }`);
    expect(failure(result)).toEqual(CONFLICT('Item', id));
    expect(fixture.events).toEqual([
      'middleware update Pedido', 'Pedido.onUpdating', `middleware ${key === 'updated' ? 'update' : 'delete'} Item`,
    ]);
    expect(storedData(fixture.adapter, 'Pedido', '1')).toMatchObject({ numero: 'A', version: 2 });
    expect(fixture.adapter.stored('Item', String(id))).not.toBeNull();
  });

  test('an updated child at the maximum version fails with VERSION_EXHAUSTED; a deleted one is deleted', async () => {
    const fixture = buildProtected();
    seedOrders(fixture.adapter, { item11: MAX, item12: MAX });
    const updated = await fixture.run(`mutation { updatepedido(input: { id: "1", version: 2,
      items: { updated: [{ id: "11", version: ${MAX}, nombre: "x" }] } }) { id } }`);
    expect(failure(updated)).toEqual(EXHAUSTED('Item', 11));
    expect(fixture.events).not.toContain('Item.onUpdating');
    const deleted = await fixture.run(`mutation { updatepedido(input: { id: "1", version: 2,
      items: { deleted: [{ id: "12", version: ${MAX} }] } }) { version } }`);
    expect(deleted.errors).toBeUndefined();
    expect(fixture.adapter.stored('Item', '12')).toBeNull();
  });

  test.each([
    ['updated', '{ id: "99", version: 1, nombre: "x" }'],
    ['deleted', '{ id: "99", version: 1 }'],
  ])('a missing %s child fails with NOT_VALID_ID (404)', async (key, entry) => {
    const fixture = buildProtected();
    seedOrders(fixture.adapter);
    const result = await fixture.run(`mutation { updatepedido(input: { id: "1", version: 2, items: { ${key}: [${entry}] } }) { id } }`);
    expect(failure(result)).toEqual(MISSING_ID('Item', 99));
  });

  test.each([
    ['updated', '{ id: "21", version: 9, nombre: "x" }'],
    ['deleted', '{ id: "21", version: 9 }'],
  ])('a %s child of another parent fails on ownership before its version is looked at', async (key, entry) => {
    const fixture = buildProtected();
    seedOrders(fixture.adapter);
    const result = await fixture.run(`mutation { updatepedido(input: { id: "1", version: 2, items: { ${key}: [${entry}] } }) { id } }`);
    expect(failure(result)).toEqual(FOREIGN_CHILD);
  });

  test('a deleted child stored without a version reaches its onDelete with version 1', async () => {
    const fixture = buildProtected();
    seedOrders(fixture.adapter);
    fixture.adapter.seed('Item', { _id: '13', pedido: '1' });
    let seen;
    fixture.hooks['Item.onDelete'] = (record) => { seen = record.version; };
    const result = await fixture.run(`mutation { updatepedido(input: { id: "1", version: 2,
      items: { deleted: [{ id: "13", version: 1 }] } }) { id } }`);
    expect(result.errors).toBeUndefined();
    expect(seen).toBe(1);
  });
});

describe('versions that skip GraphQL coercion', () => {
  test.each([
    ['removes', (input) => { delete input.version; }, REQUIRED_VERSION],
    ['corrupts', (input) => { input.version = '3'; }, INVALID_VERSION],
  ])('middleware that %s the version fails before anything is read', async (label, change, expected) => {
    const fixture = buildProtected();
    seedProduct(fixture.adapter);
    seedOrders(fixture.adapter, { pedido: 3 });
    fixture.hooks['middleware update Producto'] = (params) => change(params.args.input);
    fixture.hooks['middleware state_changed Pedido'] = (params) => change(params.args.input);
    fixture.hooks['middleware delete Producto'] = (params) => change(params.args);
    expect(failure(await fixture.run('mutation { updateproducto(input: { id: "1", version: 3, name: "b" }) { id } }')))
      .toEqual(expected);
    expect(failure(await fixture.run('mutation { close_pedido(input: { id: "1", version: 3 }) { id } }'))).toEqual(expected);
    expect(failure(await fixture.run('mutation { deleteproducto(id: "1", version: 3) { id } }'))).toEqual(expected);
    expect(fixture.adapter.getById).not.toHaveBeenCalled();
    expect(fixture.events.filter((event) => !event.startsWith('middleware'))).toEqual([]);
  });

  test('a nested entry whose version middleware removes or corrupts fails before the child is read', async () => {
    const fixture = buildProtected();
    seedOrders(fixture.adapter);
    fixture.hooks['middleware update Item'] = (params) => { delete params.args.input.version; };
    fixture.hooks['middleware delete Item'] = (params) => { params.args.version = 0; };
    const updated = await fixture.run(`mutation { updatepedido(input: { id: "1", version: 2,
      items: { updated: [{ id: "11", version: 4 }] } }) { id } }`);
    expect(failure(updated)).toEqual(REQUIRED_VERSION);
    const deleted = await fixture.run(`mutation { updatepedido(input: { id: "1", version: 2,
      items: { deleted: [{ id: "12", version: 7 }] } }) { id } }`);
    expect(failure(deleted)).toEqual(INVALID_VERSION);
    expect(fixture.adapter.reads()).toEqual([`Pedido 1 ${LOCKED}`, `Pedido 1 ${LOCKED}`]);
  });

  test('a legacy string inserted before cloneInput becomes an object without a version and fails before its read', async () => {
    const fixture = buildProtected();
    seedOrders(fixture.adapter);
    fixture.hooks['middleware update Pedido'] = (params) => { params.args.input.items = { deleted: ['12'] }; };
    const result = await fixture.run('mutation { updatepedido(input: { id: "1", version: 2 }) { id } }');
    expect(failure(result)).toEqual(REQUIRED_VERSION);
    expect(fixture.adapter.reads()).toEqual([`Pedido 1 ${LOCKED}`]);
    expect(fixture.adapter.stored('Item', '12')).not.toBeNull();
  });

  test.each([
    ['an updated entry without a version', { updated: [{ id: '11', nombre: 'x' }] }, REQUIRED_VERSION],
    ['an updated entry with a string version', { updated: [{ id: '11', version: '4' }] }, INVALID_VERSION],
    ['a deleted entry without a version', { deleted: [{ id: '12' }] }, REQUIRED_VERSION],
    ['a deleted legacy string ID objectified by cloneInput', { deleted: ['12'] }, REQUIRED_VERSION],
  ])('saveObject() with %s fails before the child is read', async (label, items, expected) => {
    const fixture = buildProtected();
    seedOrders(fixture.adapter);
    expect(await thrown(fixture.runtime.saveObject('Pedido', { numero: 'N', items }))).toEqual(expected);
    expect(fixture.adapter.getById).not.toHaveBeenCalled();
  });
});

describe('the managed version', () => {
  test('a create stores version 1 whatever saveObject() or middleware supplies, and validators see what was supplied', async () => {
    const fixture = buildProtected();
    const seen = [];
    fixture.hooks['Producto create validator'] = (args, modelArgs) => seen.push([args.version, { ...modelArgs }]);
    fixture.hooks['Producto.onSaved'] = (record) => seen.push(record.version);
    const saved = await fixture.runtime.saveObject('Producto', { name: 'n', version: 42 });
    expect(saved.version).toBe(1);
    fixture.hooks['middleware save Producto'] = (params) => { params.args.input.version = 42; };
    const added = await fixture.run('mutation { addproducto(input: { name: "m" }) { id version } }');
    expect(added.errors).toBeUndefined();
    expect(added.data.addproducto.version).toBe(1);
    expect(seen).toEqual([[42, { name: 'n' }], 1, [42, { name: 'm' }], 1]);
    expect(storedData(fixture.adapter, 'Producto', saved._id)).toEqual({ name: 'n', version: 1 });
    expect(storedData(fixture.adapter, 'Producto', added.data.addproducto.id)).toEqual({ name: 'm', version: 1 });
  });

  test('nested added children of a protected type start at 1', async () => {
    const fixture = buildProtected();
    const result = await fixture.run(`mutation { addpedido(input: { numero: "N", items: { added: [{ nombre: "x" }] } }) {
      version items { version } } }`);
    expect(result.errors).toBeUndefined();
    expect(result.data.addpedido).toEqual({ version: 1, items: [{ version: 1 }] });
  });

  test('onSaving that sets the version fails with VERSION_MANAGED and stores nothing', async () => {
    const fixture = buildProtected();
    fixture.hooks['Producto.onSaving'] = (record) => { record.version = 5; };
    const result = await fixture.run('mutation { addproducto(input: { name: "n" }) { id } }');
    expect(failure(result)).toEqual(MANAGED('onSaving'));
    expect(fixture.adapter.records.size).toBe(0);
  });

  test.each([
    ['at the top level', (update) => { update.version = 9; }],
    ['inside $set', (update) => { update.$set = { version: 9 }; }],
    ['inside $unset', (update) => { update.$unset = { version: '' }; }],
  ])('onUpdating that sets the version %s fails with VERSION_MANAGED before the write', async (label, change) => {
    const fixture = buildProtected();
    seedProduct(fixture.adapter);
    fixture.hooks['Producto.onUpdating'] = (id, update) => change(update);
    const result = await fixture.run('mutation { updateproducto(input: { id: "1", version: 3, name: "b" }) { id } }');
    expect(failure(result)).toEqual(MANAGED('onUpdating'));
    expect(fixture.adapter.update).not.toHaveBeenCalled();
  });

  test('an update wrapper that drops the options fails with DATABASE_ERROR and rolls back', async () => {
    const fixture = buildProtected();
    seedProduct(fixture.adapter);
    const { update } = fixture.adapter;
    fixture.adapter.update = vi.fn((Model, id, changes, session) => update(Model, id, changes, session));
    const result = await fixture.run('mutation { updateproducto(input: { id: "1", version: 3, name: "b" }) { id } }');
    expect(failure(result)).toEqual({
      code: 'DATABASE_ERROR', status: 500, message: 'Producto 1 was written without advancing its version',
    });
    expect(fixture.events).not.toContain('Producto.onUpdated');
    expect(storedData(fixture.adapter, 'Producto', '1')).toEqual({ name: 'a', price: 1, version: 3 });
  });

  test('a delete wrapper that drops the options and deletes another version fails with DATABASE_ERROR and rolls back', async () => {
    const fixture = buildProtected();
    seedProduct(fixture.adapter);
    // A write that the pre-read did not see moves the version before the delete.
    fixture.hooks['Producto.onDelete'] = () => { fixture.adapter.records.get('Producto:1').version = 4; };
    const remove = fixture.adapter.delete;
    fixture.adapter.delete = vi.fn((Model, id, session) => remove(Model, id, session));
    const result = await fixture.run('mutation { deleteproducto(id: "1", version: 3) { id } }');
    expect(failure(result)).toEqual({ code: 'DATABASE_ERROR', status: 500, message: 'Producto 1 was deleted at another version' });
    expect(storedData(fixture.adapter, 'Producto', '1')).toEqual({ name: 'a', price: 1, version: 3 });
    // With the options, the adapter's conditional delete reports the conflict.
    fixture.adapter.delete = remove;
    const conflict = await fixture.run('mutation { deleteproducto(id: "1", version: 3) { id } }');
    expect(failure(conflict)).toEqual(CONFLICT('Producto', 1));
    expect(fixture.adapter.stored('Producto', '1')).not.toBeNull();
  });
});

describe('middleware arguments', () => {
  test('a protected delete gives { id, version }, read after middleware', async () => {
    const fixture = buildProtected();
    seedProduct(fixture.adapter);
    const seen = [];
    fixture.hooks['middleware delete Producto'] = (params) => {
      seen.push({ ...params.args });
      params.args.version = 3;
    };
    const result = await fixture.run('mutation { deleteproducto(id: "1", version: 2) { version } }');
    expect(result.errors).toBeUndefined();
    expect(seen).toEqual([{ id: '1', version: 2 }]);
    expect(fixture.deletes()).toEqual([{ type: 'Producto', id: '1', options: { expectedVersion: 3 } }]);
  });

  test('a nested protected delete entry gives { id, version }, built before item middleware and read after it', async () => {
    const fixture = buildProtected();
    seedOrders(fixture.adapter);
    const seen = [];
    fixture.hooks['middleware delete Item'] = (params) => {
      seen.push({ ...params.args });
      params.args.version = 7;
    };
    fixture.hooks['middleware update Item'] = (params) => seen.push(Object.keys(params.args));
    const result = await fixture.run(`mutation { updatepedido(input: { id: "1", version: 2,
      items: { updated: [{ id: "11", version: 4 }], deleted: [{ id: "12", version: 6 }] } }) { id } }`);
    expect(result.errors).toBeUndefined();
    expect(seen).toEqual([['input'], { id: '12', version: 6 }]);
    expect(fixture.deletes()).toEqual([{ type: 'Item', id: '12', options: { expectedVersion: 7 } }]);
  });
});

describe('transaction retries', () => {
  test('a retried attempt checks the version the client sent, whatever the first attempt changed', async () => {
    const fixture = buildProtected();
    seedProduct(fixture.adapter);
    fixture.hooks['Producto validator'] = (args) => { args.version = 9; };
    let failures = 1;
    fixture.hooks['Producto.onUpdating'] = () => {
      if (failures-- > 0) throw transientError();
    };
    const result = await fixture.run('mutation { updateproducto(input: { id: "1", version: 3, name: "b" }) { version } }');
    expect(result.errors).toBeUndefined();
    expect(result.data.updateproducto).toEqual({ version: 4 });
    expect(fixture.adapter.reads()).toEqual([`Producto 1 ${LOCKED}`, `Producto 1 ${LOCKED}`]);
    expect(fixture.updates().map(({ options }) => options)).toEqual([{ expectedVersion: 3 }]);
  });

  test('a retry after the stored version advanced fails with VERSION_CONFLICT before any hook', async () => {
    const fixture = buildProtected();
    seedProduct(fixture.adapter);
    let failures = 1;
    fixture.hooks['Producto.onUpdating'] = () => {
      if (failures-- > 0) throw transientError();
    };
    fixture.adapter.betweenAttempts = () => { fixture.adapter.records.get('Producto:1').version = 4; };
    const result = await fixture.run('mutation { updateproducto(input: { id: "1", version: 3, name: "b" }) { id } }');
    expect(failure(result)).toEqual(CONFLICT('Producto', 1));
    expect(fixture.events.filter((event) => event === 'Producto.onUpdating')).toHaveLength(1);
    expect(fixture.adapter.update).not.toHaveBeenCalled();
  });
});

// Unprotected types: Autor, with a state machine, an embedded address and a collection of Libros.
const buildUnprotected = () => {
  const adapter = createOptimisticMemoryAdapter();
  const runtime = createRuntime(adapter);
  const middleware = [];
  const State = new GraphQLEnumType({ name: 'PinState', values: { OPEN: { value: 'OPEN' }, CLOSED: { value: 'CLOSED' } } });
  const Address = new GraphQLObjectType({ name: 'PinAddress', fields: { street: { type: GraphQLString } } });
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
      address: { type: Address, extensions: { relation: { embedded: true } } },
      libros: { type: new GraphQLList(Libro), extensions: { relation: { embedded: false, connectionField: 'autor' } } },
    }),
  });
  runtime.use(async (params, next) => {
    if (params.type?.gqltype === Libro) middleware.push({ operation: params.operation, args: params.args });
    await next();
  });
  runtime.addNoEndpointType(Address);
  runtime.connect(null, Libro, 'libro', 'libros', {});
  runtime.connect(null, Autor, 'autor', 'autores', {}, null, {
    initialState: { name: 'OPEN', value: 'OPEN' },
    actions: { close: { from: { name: 'OPEN', value: 'OPEN' }, to: { name: 'CLOSED', value: 'CLOSED' } } },
  });
  const schema = runtime.createSchema();
  adapter.seed('Autor', { _id: '1', nombre: 'a', state: 'OPEN', address: { street: 's' } });
  adapter.seed('Libro', { _id: '11', titulo: 'x', autor: '1' });
  adapter.seed('Libro', { _id: '12', titulo: 'y', autor: '1' });
  const run = async (source) => {
    const result = await graphql({ schema, source, contextValue: {} });
    expect(result.errors).toBeUndefined();
    return result.data;
  };
  // Each adapter call by its type, ID, argument count and options, so an extra argument shows.
  const calls = (spy) => spy.mock.calls.map((args) => [args[0].name, args[1], args.length, args.at(-1)]);
  return {
    adapter, run, middleware, calls,
  };
};

describe('pin: unprotected types keep their reads and writes', () => {
  test('pin: update, state action, nested entries and delete make the same adapter calls with the same arguments', async () => {
    const fixture = buildUnprotected();
    const { adapter } = fixture;
    await fixture.run('mutation { updateautor(input: { id: "1", nombre: "b" }) { id } }');
    await fixture.run('mutation { close_autor(input: { id: "1", address: { street: "t" } }) { id } }');
    await fixture.run(`mutation { updateautor(input: { id: "1",
      libros: { updated: [{ id: "11", titulo: "z" }], deleted: ["12"] } }) { id } }`);
    await fixture.run('mutation { deleteautor(id: "1") { id } }');
    expect(adapter.reads()).toEqual([
      'Autor 1 {"projection":{"address":1},"plain":true,"lock":true}',
      'Autor 1 {"lock":true}',
      'Autor 1 {"projection":{"address":1},"plain":true,"lock":true}',
      'Autor 1 {"projection":{"address":1},"plain":true,"lock":true}',
      'Libro 11 {"plain":true,"lock":true}',
      'Libro 12 {"plain":true,"lock":true}',
      'Autor 1 {"plain":true}',
    ]);
    expect(fixture.calls(adapter.update)).toEqual([
      ['Autor', '1', 4, { memory: true, attempt: 1 }],
      ['Autor', '1', 4, { memory: true, attempt: 1 }],
      ['Autor', '1', 4, { memory: true, attempt: 1 }],
      ['Libro', '11', 4, { memory: true, attempt: 1 }],
    ]);
    expect(fixture.calls(adapter.delete)).toEqual([
      ['Libro', '12', 3, { memory: true, attempt: 1 }],
      ['Autor', '1', 3, { memory: true, attempt: 1 }],
    ]);
    expect(adapter.update.mock.calls.map(([, , update]) => update)).toEqual([
      { id: '1', nombre: 'b' },
      { id: '1', address: { street: 't' }, state: 'CLOSED' },
      { id: '1' },
      { id: '11', titulo: 'z', autor: '1' },
    ]);
    // A nested delete entry of an unprotected child keeps { id }.
    expect(fixture.middleware).toEqual([
      { operation: 'update', args: { input: { id: '11', titulo: 'z' } } },
      { operation: 'delete', args: { id: '12' } },
    ]);
  });
});

describe('protected lifecycle closing regressions', () => {
  test('a top-level embedded patch merges from its single protected pre-read', async () => {
    const fixture = buildProtected();
    seedOrders(fixture.adapter);
    const result = await fixture.run('mutation { updatepedido(input: { id: "1", version: 2, address: { city: "n" } }) { version address { street city } } }');
    expect(result.errors).toBeUndefined();
    expect(result.data.updatepedido).toEqual({ version: 3, address: { street: 's', city: 'n' } });
    expect(fixture.adapter.reads()).toEqual([`Pedido 1 ${LOCKED}`]);
    expect(fixture.adapter.stored('Pedido', '1')).toMatchObject({ version: 3, address: { street: 's', city: 'n' } });
  });

  test('a missing protected parent with an embedded patch reaches its hook and write after one pre-read', async () => {
    const fixture = buildProtected();
    const result = await fixture.run('mutation { updatepedido(input: { id: "9", version: 1, address: { city: "n" } }) { id } }');
    expect(failure(result)).toEqual(MISSING_ID('Pedido', 9));
    expect(fixture.events).toEqual(['middleware update Pedido', 'Pedido.onUpdating']);
    expect(fixture.adapter.reads()).toEqual([`Pedido 9 ${LOCKED}`]);
    expect(fixture.updates()).toEqual([{
      type: 'Pedido', id: '9', update: { id: '9', address: { city: 'n' } }, options: { expectedVersion: 1 },
    }]);
    expect(fixture.adapter.records.size).toBe(0);
  });

  test('a protected delete retry retains its submitted version after a competitor advances', async () => {
    const fixture = buildProtected();
    seedProduct(fixture.adapter);
    fixture.hooks['Producto.onDelete'] = (record) => {
      record.version = 4;
      record.name = 'hook edit';
    };
    fixture.adapter.delete.mockRejectedValueOnce(transientError());
    fixture.adapter.betweenAttempts = () => { fixture.adapter.records.get('Producto:1').version = 4; };
    const result = await fixture.run('mutation { deleteproducto(id: "1", version: 3) { id } }');
    expect(failure(result)).toEqual(CONFLICT('Producto', 1));
    expect(fixture.events).toEqual(['middleware delete Producto', 'Producto.onDelete']);
    expect(fixture.adapter.reads()).toEqual([`Producto 1 ${LOCKED}`, `Producto 1 ${LOCKED}`]);
    expect(fixture.adapter.getById.mock.calls.map((call) => call[2].attempt)).toEqual([1, 2]);
    expect(fixture.deletes()).toEqual([{ type: 'Producto', id: '1', options: { expectedVersion: 3 } }]);
    expect(storedData(fixture.adapter, 'Producto', '1')).toEqual({ name: 'a', price: 1, version: 4 });
  });

  test('item middleware inserts a raw primitive after cloning and the protected deleted wrapper has no version', async () => {
    const fixture = buildProtected();
    seedOrders(fixture.adapter);
    let deleted;
    fixture.Pedido.extensions.validations = { UPDATE: [{ validate: (_name, args) => { deleted = args.items.deleted; } }] };
    fixture.hooks['middleware update Item'] = () => { deleted.push('12'); };
    const seen = [];
    fixture.hooks['middleware delete Item'] = ({ args }) => {
      expect(deleted[0]).toBe('12');
      seen.push({ ...args });
    };
    const result = await fixture.run(`mutation { updatepedido(input: { id: "1", version: 2,
      items: { updated: [{ id: "11", version: 4, nombre: "changed" }], deleted: [] } }) { id } }`);
    expect(failure(result)).toEqual(REQUIRED_VERSION);
    expect(seen).toEqual([{ id: undefined, version: undefined }]);
    expect(fixture.adapter.reads()).toEqual([`Pedido 1 ${LOCKED}`, `Item 11 ${LOCKED}`]);
    expect(fixture.adapter.delete).not.toHaveBeenCalled();
    expect(fixture.adapter.stored('Pedido', '1').version).toBe(2);
    expect(fixture.adapter.stored('Item', '11')).toMatchObject({ nombre: 'a', version: 4 });
    expect(fixture.adapter.stored('Item', '12')).not.toBeNull();
  });
});
