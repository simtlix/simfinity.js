// The generated transaction field (#151), schema side: the createSchema() option and its checks before
// and after the generated mutations are built, the derived types and the operation keys, GraphQL's
// @oneOf validation of operation items, the empty list, and the models the field's transactions use.
// Execution is tested in tests/transaction-execution.test.js.
import { createHash } from 'node:crypto';
import {
  describe, expect, test, vi,
} from 'vitest';
import {
  GraphQLEnumType, GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString,
  getNamedType, graphql, printSchema,
} from 'graphql';
import { createRuntime } from '@simtlix/simfinity-core';
import { createOptimisticMemoryAdapter } from './helpers/optimistic-memory-adapter.js';

const OPTIMISTIC = { mode: 'optimistic' };
const MARKER = 'Simfinity transaction: runs the listed generated mutations in order in one database transaction.';
const GENERATED_OPERATIONS = ['save', 'update', 'delete', 'state_changed'];
const invalid = (reason) => ({ code: 'INVALID_SCHEMA_OPTIONS', status: 500, message: `Invalid transaction option: ${reason}` });
const UNSUPPORTED = {
  code: 'TRANSACTION_UNSUPPORTED', status: 500, message: 'The database adapter does not support generated transactions',
};

// Loaded on use, so that on a checkout without the module only the test that reads the state fails.
const loadTransactionSchema = () => import('../packages/core/src/transaction-schema.js');

// The error a call throws, as code, status and message.
const thrown = (call) => {
  try {
    call();
  } catch (error) {
    return { code: error.extensions?.code, status: error.extensions?.status, message: error.message };
  }
  throw new Error('expected the call to throw');
};

// Unprotected Producto, with a required name; protected Pedido, with a state machine, an embedded
// Direccion and a collection of protected Items; each Item has a collection of unprotected Notas.
// Direccion has no endpoint.
const defineTypes = () => {
  const State = new GraphQLEnumType({ name: 'TxState', values: { OPEN: { value: 'OPEN' }, CLOSED: { value: 'CLOSED' } } });
  const Direccion = new GraphQLObjectType({ name: 'Direccion', fields: { calle: { type: GraphQLString } } });
  const Producto = new GraphQLObjectType({
    name: 'Producto',
    fields: { id: { type: GraphQLID }, name: { type: new GraphQLNonNull(GraphQLString) }, price: { type: GraphQLInt } },
  });
  const Nota = new GraphQLObjectType({
    name: 'Nota',
    fields: () => ({
      id: { type: GraphQLID },
      texto: { type: GraphQLString },
      item: { type: Item, extensions: { relation: { embedded: false } } },
    }),
  });
  const Item = new GraphQLObjectType({
    name: 'Item',
    extensions: { concurrency: OPTIMISTIC },
    fields: () => ({
      id: { type: GraphQLID },
      nombre: { type: GraphQLString },
      pedido: { type: Pedido, extensions: { relation: { embedded: false } } },
      notas: { type: new GraphQLList(Nota), extensions: { relation: { embedded: false, connectionField: 'item' } } },
    }),
  });
  const Pedido = new GraphQLObjectType({
    name: 'Pedido',
    extensions: { concurrency: OPTIMISTIC },
    fields: () => ({
      id: { type: GraphQLID },
      numero: { type: GraphQLString },
      state: { type: State },
      direccion: { type: Direccion, extensions: { relation: { embedded: true } } },
      items: { type: new GraphQLList(Item), extensions: { relation: { embedded: false, connectionField: 'pedido' } } },
    }),
  });
  return {
    Direccion, Producto, Nota, Item, Pedido,
  };
};

// `options(types)` returns the fourth createSchema() argument; `included(types)` the mutation allowlist.
// `before(runtime, types)` runs after the types are registered.
const build = ({
  adapterOptions, options, included, includedCustomMutations = null, before,
} = {}) => {
  const adapter = createOptimisticMemoryAdapter(adapterOptions);
  vi.spyOn(adapter, 'prepare');
  vi.spyOn(adapter, 'withTransaction');
  vi.spyOn(adapter, 'saveRecord');
  const runtime = createRuntime(adapter);
  const types = defineTypes();
  runtime.addNoEndpointType(types.Direccion);
  runtime.connect(null, types.Producto, 'producto', 'productos');
  runtime.connect(null, types.Pedido, 'pedido', 'pedidos', null, null, {
    initialState: { name: 'OPEN', value: 'OPEN' },
    actions: {
      close: {
        from: { name: 'OPEN', value: 'OPEN' },
        to: { name: 'CLOSED', value: 'CLOSED' },
        description: 'Close the order',
        action: async () => {},
      },
    },
  });
  runtime.connect(null, types.Item, 'item', 'items');
  runtime.connect(null, types.Nota, 'nota', 'notas');
  before?.(runtime, types);
  const create = () => runtime.createSchema(null, included ? included(types) : null, includedCustomMutations,
    options ? options(types) : undefined);
  return {
    adapter, runtime, types, create,
  };
};

// Every call core made to the adapter's data methods, its transactions and the affinity check.
const adapterCalls = (adapter) => ['getById', 'update', 'delete', 'find', 'saveRecord', 'withTransaction', 'assertTransactionModels']
  .reduce((total, method) => total + (adapter[method]?.mock?.calls.length ?? 0), 0);

// The generated mutation roots of these types, as the transaction field's operation keys are expected.
const generatedRoots = (schema, typeNames) => Object.entries(schema.getMutationType().getFields())
  .filter(([, field]) => GENERATED_OPERATIONS.includes(field.extensions?.simfinityMutation?.operation)
    && typeNames.includes(field.extensions.simfinityMutation.typeName))
  .map(([name]) => name);

const fieldTypes = (type) => Object.fromEntries(Object.entries(type.getFields())
  .map(([name, field]) => [name, String(field.type)]));

describe('the transaction field and its types', () => {
  test('by default the field is named transaction, with derived type names, the marker and its extensions', () => {
    const fixture = build({ options: ({ Producto, Pedido }) => ({ transaction: { types: [Producto, Pedido] } }) });
    const schema = fixture.create();
    const sdl = printSchema(schema);
    expect(sdl).toContain('transaction(operations: [TransactionOperation!]!): [TransactionResult!]');
    expect(sdl).toContain('input TransactionOperation @oneOf {');
    expect(sdl).toContain('type TransactionResult {');
    expect(sdl).toContain('input TransactionDeleteInput {\n  id: ID!\n}');
    expect(sdl).toContain(MARKER);
    const field = schema.getMutationType().getFields().transaction;
    expect(field.description).toBe(MARKER);
    expect(field.extensions.simfinityTransaction).toEqual({ name: 'transaction', types: [fixture.types.Producto, fixture.types.Pedido] });
    expect(String(field.type)).toBe('[TransactionResult!]');
    expect(field.args.map((arg) => [arg.name, String(arg.type)])).toEqual([['operations', '[TransactionOperation!]!']]);
    expect(schema.getType('TransactionOperation').isOneOf).toBe(true);
  });

  test('a custom name derives its own type names', () => {
    const fixture = build({ options: ({ Producto }) => ({ transaction: { name: 'batch', types: [Producto] } }) });
    const schema = fixture.create();
    const sdl = printSchema(schema);
    expect(sdl).toContain('batch(operations: [BatchOperation!]!): [BatchResult!]');
    expect(sdl).toContain('input BatchOperation @oneOf {');
    expect(sdl).toContain('type BatchResult {');
    expect(sdl).toContain('input BatchDeleteInput {\n  id: ID!\n}');
    expect(schema.getMutationType().getFields().batch.extensions.simfinityTransaction.name).toBe('batch');
    expect(schema.getMutationType().getFields().transaction).toBeUndefined();
    expect(Object.keys(schema.getTypeMap()).filter((name) => name.startsWith('Transaction'))).toEqual([]);
  });

  test('TransactionDeleteInput exists only for an unprotected delete; a protected delete takes RecordVersionRef', () => {
    const onlyProtected = build({ options: ({ Pedido }) => ({ transaction: { types: [Pedido] } }) }).create();
    expect(onlyProtected.getType('TransactionDeleteInput')).toBeUndefined();
    expect(fieldTypes(onlyProtected.getType('TransactionOperation')).deletepedido).toBe('RecordVersionRef');
    expect(printSchema(onlyProtected)).toContain('  deletepedido: RecordVersionRef\n');

    const unprotected = build({ options: ({ Producto }) => ({ transaction: { types: [Producto] } }) }).create();
    expect(fieldTypes(unprotected.getType('TransactionOperation')).deleteproducto).toBe('TransactionDeleteInput');
    expect(fieldTypes(unprotected.getType('TransactionDeleteInput'))).toEqual({ id: 'ID!' });
  });

  test('a null option builds the same schema as no option', () => {
    const without = printSchema(build().create());
    expect(printSchema(build({ options: () => ({ transaction: null }) }).create())).toBe(without);
    expect(printSchema(build({ options: () => ({ transaction: undefined }) }).create())).toBe(without);
  });

  // The SDL hash of this fixture's schema without the option, as created before the option existed.
  test('pin: a schema without the option is byte-identical in SDL', () => {
    const schema = build().create();
    const sdl = printSchema(schema);
    expect(createHash('sha256').update(sdl).digest('hex')).toBe('b4516dfe64275698da07fca8bc8378c7fb452000bbfd977bf443f5591d7efd3c');
    expect(schema.getMutationType().getFields().transaction).toBeUndefined();
    expect(Object.keys(schema.getTypeMap()).filter((name) => name.startsWith('Transaction'))).toEqual([]);
  });
});

describe('operation keys', () => {
  test('they are the generated roots of the configured types, state machine actions included', () => {
    const fixture = build({ options: ({ Producto, Pedido }) => ({ transaction: { types: [Producto, Pedido] } }) });
    const schema = fixture.create();
    const keys = ['addproducto', 'deleteproducto', 'addpedido', 'deletepedido', 'updateproducto', 'updatepedido', 'close_pedido'];
    expect(generatedRoots(schema, ['Producto', 'Pedido'])).toEqual(keys);
    expect(fieldTypes(schema.getType('TransactionOperation'))).toEqual({
      addproducto: 'ProductoInput',
      deleteproducto: 'TransactionDeleteInput',
      addpedido: 'PedidoInput',
      deletepedido: 'RecordVersionRef',
      updateproducto: 'ProductoInputForUpdate',
      updatepedido: 'PedidoInputForUpdate',
      close_pedido: 'PedidoInputForUpdate',
    });
    // The values are the roots' own input types, without their non-null wrapper.
    const roots = schema.getMutationType().getFields();
    const operationFields = schema.getType('TransactionOperation').getFields();
    for (const key of ['addproducto', 'addpedido', 'updateproducto', 'updatepedido', 'close_pedido']) {
      expect(operationFields[key].type).toBe(roots[key].args[0].type.ofType);
    }
    expect(fieldTypes(schema.getType('TransactionResult'))).toEqual({
      id: 'ID',
      addproducto: 'Producto',
      deleteproducto: 'Producto',
      addpedido: 'Pedido',
      deletepedido: 'Pedido',
      updateproducto: 'Producto',
      updatepedido: 'Pedido',
      close_pedido: 'Pedido',
    });
  });

  test('the mutation allowlist leaves out the roots of the types it excludes', () => {
    const fixture = build({
      options: ({ Producto, Pedido }) => ({ transaction: { types: [Producto, Pedido] } }),
      included: ({ Pedido }) => [Pedido],
    });
    const schema = fixture.create();
    expect(Object.keys(schema.getType('TransactionOperation').getFields()))
      .toEqual(['addpedido', 'deletepedido', 'updatepedido', 'close_pedido']);
  });

  test('a configured type without an endpoint gives no keys', () => {
    const fixture = build({ options: ({ Producto, Direccion }) => ({ transaction: { types: [Producto, Direccion] } }) });
    const schema = fixture.create();
    expect(Object.keys(schema.getType('TransactionOperation').getFields()))
      .toEqual(['addproducto', 'deleteproducto', 'updateproducto']);
    expect(schema.getMutationType().getFields().transaction.extensions.simfinityTransaction.types)
      .toEqual([fixture.types.Producto, fixture.types.Direccion]);
  });

  test('a registered mutation that replaces a generated root shadows its key, with one warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const fixture = build({
        options: ({ Producto }) => ({ transaction: { types: [Producto] } }),
        before: (runtime, { Producto }) => runtime.registerMutation('addproducto', 'Custom add', null, Producto, async () => null),
      });
      const schema = fixture.create();
      expect(schema.getMutationType().getFields().addproducto.extensions.simfinityMutation.operation).toBe('custom_mutation');
      expect(Object.keys(schema.getType('TransactionOperation').getFields())).toEqual(['deleteproducto', 'updateproducto']);
      expect(Object.keys(schema.getType('TransactionResult').getFields())).toEqual(['id', 'deleteproducto', 'updateproducto']);
      expect(warn.mock.calls.filter(([message]) => String(message).includes('addproducto'))).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('checks before models are prepared', () => {
  test.each([
    ['a string option', () => 'transaction', invalid('must be a plain object')],
    ['an array option', ({ Producto }) => [Producto], invalid('must be a plain object')],
    ['an option with a prototype', ({ Producto }) => Object.create({ types: [Producto] }), invalid('must be a plain object')],
    ['an unknown key', ({ Producto }) => ({ types: [Producto], extra: true }), invalid('unknown key extra')],
    ['an unknown undefined key', ({ Producto }) => ({ types: [Producto], nmae: undefined }), invalid('unknown key nmae')],
    ['a symbol key', ({ Producto }) => ({ types: [Producto], [Symbol('extra')]: true }), invalid('unknown key Symbol(extra)')],
    ['a non-string name', ({ Producto }) => ({ name: 1, types: [Producto] }), invalid('name must be a GraphQL name that does not start with __')],
    ['a null name', ({ Producto }) => ({ name: null, types: [Producto] }), invalid('name must be a GraphQL name that does not start with __')],
    ['an invalid name', ({ Producto }) => ({ name: 'my-batch', types: [Producto] }), invalid('name must be a GraphQL name that does not start with __')],
    ['a __-prefixed name', ({ Producto }) => ({ name: '__batch', types: [Producto] }), invalid('name must be a GraphQL name that does not start with __')],
    ['missing types', () => ({ name: 'batch' }), invalid('types must be a non-empty array of GraphQLObjectType')],
    ['empty types', () => ({ types: [] }), invalid('types must be a non-empty array of GraphQLObjectType')],
    ['a single type', ({ Producto }) => ({ types: Producto }), invalid('types must be a non-empty array of GraphQLObjectType')],
    ['a type name', () => ({ types: ['Producto'] }), invalid('types must be a non-empty array of GraphQLObjectType')],
    // eslint-disable-next-line no-sparse-arrays
    ['a sparse array', ({ Producto }) => ({ types: [, Producto] }), invalid('types must be a non-empty array of GraphQLObjectType')],
    ['a duplicated type', ({ Producto, Pedido }) => ({ types: [Producto, Pedido, Producto] }), invalid('types lists Producto more than once')],
    ['an unregistered type', ({ Producto }) => ({
      types: [Producto, new GraphQLObjectType({ name: 'Ajeno', fields: { id: { type: GraphQLID } } })],
    }), invalid('Ajeno is not registered in this runtime')],
    ['another object with a registered name', ({ Producto }) => ({
      types: [Producto, new GraphQLObjectType({ name: 'Pedido', fields: { id: { type: GraphQLID } } })],
    }), invalid('Pedido is not registered in this runtime')],
    ['a name of a generated mutation', ({ Producto }) => ({ name: 'addproducto', types: [Producto] }),
      invalid('name addproducto conflicts with a generated mutation')],
    ['a name of a state machine action', ({ Producto }) => ({ name: 'close_pedido', types: [Producto] }),
      invalid('name close_pedido conflicts with a generated mutation')],
    ['a name of a generated mutation of a type it does not list', ({ Producto }) => ({ name: 'deletenota', types: [Producto] }),
      invalid('name deletenota conflicts with a generated mutation')],
    ['only a type without an endpoint', ({ Direccion }) => ({ types: [Direccion] }),
      invalid('none of its types has generated mutations in this schema')],
  ])('rejects %s with INVALID_SCHEMA_OPTIONS before adapter.prepare()', (label, transaction, expected) => {
    const fixture = build({ options: (types) => ({ transaction: transaction(types) }) });
    expect(thrown(fixture.create)).toEqual(expected);
    expect(fixture.adapter.prepare).not.toHaveBeenCalled();
    // Nothing of the rejected option remains.
    expect(fixture.runtime.createSchema().getMutationType().getFields().transaction).toBeUndefined();
  });

  test('rejects a name taken by a registered mutation', () => {
    const fixture = build({
      options: ({ Producto }) => ({ transaction: { types: [Producto] } }),
      before: (runtime, { Producto }) => runtime.registerMutation('transaction', 'Mine', null, Producto, async () => null),
    });
    expect(thrown(fixture.create)).toEqual(invalid('name transaction conflicts with the registered mutation transaction'));
    expect(fixture.adapter.prepare).not.toHaveBeenCalled();
  });

  test('a registered mutation the schema leaves out takes no name', () => {
    const fixture = build({
      options: ({ Producto }) => ({ transaction: { types: [Producto] } }),
      includedCustomMutations: [],
      before: (runtime, { Producto }) => runtime.registerMutation('transaction', 'Mine', null, Producto, async () => null),
    });
    expect(fixture.create().getMutationType().getFields().transaction.description).toBe(MARKER);
  });

  test('rejects types that the mutation allowlist leaves out', () => {
    const fixture = build({
      options: ({ Producto }) => ({ transaction: { types: [Producto] } }),
      included: ({ Pedido }) => [Pedido],
    });
    expect(thrown(fixture.create)).toEqual(invalid('none of its types has generated mutations in this schema'));
    expect(fixture.adapter.prepare).not.toHaveBeenCalled();
  });

  test('a type bound to another runtime throws TYPE_BOUND_TO_OTHER_RUNTIME', () => {
    const other = build();
    other.create();
    const fixture = build({ options: () => ({ transaction: { types: [other.types.Item] } }) });
    expect(thrown(fixture.create)).toMatchObject({ code: 'TYPE_BOUND_TO_OTHER_RUNTIME', status: 409 });
    expect(fixture.adapter.prepare).not.toHaveBeenCalled();
  });

  test('an adapter without assertTransactionModels throws TRANSACTION_UNSUPPORTED', () => {
    const fixture = build({
      adapterOptions: { transactions: false },
      options: ({ Producto }) => ({ transaction: { types: [Producto] } }),
    });
    expect(fixture.adapter.assertTransactionModels).toBeUndefined();
    expect(thrown(fixture.create)).toEqual(UNSUPPORTED);
    expect(fixture.adapter.prepare).not.toHaveBeenCalled();
    expect(fixture.runtime.createSchema().getMutationType().getFields().transaction).toBeUndefined();
  });
});

describe('checks after the generated mutations are built', () => {
  test('a type named like a derived type fails, and a later schema without the option has no transaction types', () => {
    const fixture = build({
      options: ({ Producto }) => ({ transaction: { types: [Producto] } }),
      before: (runtime) => runtime.connect(null, new GraphQLObjectType({
        name: 'TransactionDelete', fields: { id: { type: GraphQLID }, motivo: { type: GraphQLString } },
      }), 'transactiondelete', 'transactiondeletes'),
    });
    expect(thrown(fixture.create)).toEqual(invalid('the schema already has a type named TransactionDeleteInput'));
    expect(fixture.adapter.prepare).toHaveBeenCalledTimes(1);
    const later = fixture.runtime.createSchema();
    expect(later.getMutationType().getFields().transaction).toBeUndefined();
    expect(later.getType('TransactionOperation')).toBeUndefined();
    expect(later.getType('TransactionResult')).toBeUndefined();
    expect(later.getType('TransactionDeleteInput').getFields().motivo).toBeDefined();
  });

  test('a configured type whose generated roots registered mutations all replace leaves no operation', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const fixture = build({
        options: ({ Producto }) => ({ transaction: { types: [Producto] } }),
        before: (runtime, { Producto }) => {
          for (const name of ['addproducto', 'deleteproducto', 'updateproducto']) {
            runtime.registerMutation(name, 'Custom', null, Producto, async () => null);
          }
        },
      });
      expect(thrown(fixture.create)).toEqual(invalid('none of its types has generated mutations in this schema'));
      expect(fixture.runtime.createSchema().getMutationType().getFields().transaction).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('GraphQL validation of operation items (@oneOf)', () => {
  const schemaFixture = () => {
    const fixture = build({ options: ({ Producto, Pedido }) => ({ transaction: { types: [Producto, Pedido] } }) });
    const schema = fixture.create();
    const run = (source, variableValues) => graphql({
      schema, source, variableValues, contextValue: {},
    });
    return { ...fixture, run };
  };
  const malformed = [
    ['two keys in one item', '{ addproducto: { name: "a" }, deleteproducto: { id: "1" } }',
      { addproducto: { name: 'a' }, deleteproducto: { id: '1' } }],
    ['a null value', '{ addproducto: null }', { addproducto: null }],
    ['an unknown key', '{ addnota: { texto: "a" } }', { addnota: { texto: 'a' } }],
    ['a missing required field of the input', '{ addproducto: { price: 1 } }', { addproducto: { price: 1 } }],
    ['a missing id of a delete', '{ deleteproducto: {} }', { deleteproducto: {} }],
    ['a missing version of a protected delete', '{ deletepedido: { id: "1" } }', { deletepedido: { id: '1' } }],
    ['an empty item', '{}', {}],
  ];

  test.each(malformed)('rejects %s in a literal before the resolver', async (label, literal) => {
    const fixture = schemaFixture();
    const result = await fixture.run(`mutation { transaction(operations: [${literal}]) { id } }`);
    expect(result.errors?.length).toBeGreaterThan(0);
    expect(result.errors.map((error) => error.message).join('\n')).toMatch(/TransactionOperation|TransactionDeleteInput|ProductoInput|RecordVersionRef/);
    expect(result.data).toBeUndefined();
    expect(adapterCalls(fixture.adapter)).toBe(0);
  });

  test.each(malformed)('rejects %s in variables before the resolver', async (label, literal, value) => {
    const fixture = schemaFixture();
    const result = await fixture.run(
      'mutation Run($operations: [TransactionOperation!]!) { transaction(operations: $operations) { id } }',
      { operations: [{ addproducto: { name: 'ok' } }, value] },
    );
    expect(result.errors?.length).toBeGreaterThan(0);
    for (const error of result.errors) {
      expect(error.message).toMatch(/^Variable "\$operations" got invalid value .* at "operations\[1\]/);
    }
    expect(result.data).toBeUndefined();
    expect(adapterCalls(fixture.adapter)).toBe(0);
  });
});

describe('an empty list', () => {
  test('returns [] without a transaction or an affinity check, in a literal and in variables', async () => {
    const fixture = build({ options: ({ Producto }) => ({ transaction: { types: [Producto] } }) });
    const schema = fixture.create();
    const literal = await graphql({ schema, source: 'mutation { transaction(operations: []) { id addproducto { id } } }' });
    expect(literal).toEqual({ data: { transaction: [] } });
    const variables = await graphql({
      schema,
      source: 'mutation Run($operations: [TransactionOperation!]!) { transaction(operations: $operations) { id } }',
      variableValues: { operations: [] },
    });
    expect(variables).toEqual({ data: { transaction: [] } });
    expect(fixture.adapter.withTransaction).not.toHaveBeenCalled();
    expect(fixture.adapter.assertTransactionModels).not.toHaveBeenCalled();
    expect(adapterCalls(fixture.adapter)).toBe(0);
  });
});

describe('the transaction state', () => {
  test('models are those of the types with operations and their nested collection targets, transitively', async () => {
    const fixture = build({
      options: ({ Producto, Pedido }) => ({ transaction: { types: [Pedido, Producto] } }),
      included: ({ Pedido, Item }) => [Pedido, Item],
    });
    const schema = fixture.create();
    const { transactionStateOf } = await loadTransactionSchema();
    const state = transactionStateOf(schema.getMutationType().getFields().transaction);
    const { getModel } = fixture.runtime;
    const {
      Producto, Pedido, Item, Nota,
    } = fixture.types;
    expect(state.models).toHaveLength(3);
    expect(state.models[0]).toBe(getModel(Pedido));
    expect(state.models[1]).toBe(getModel(Item));
    expect(state.models[2]).toBe(getModel(Nota));
    expect(state.models).not.toContain(getModel(Producto));
    expect(state.name).toBe('transaction');
    expect(state.typeNames).toEqual(['Pedido', 'Producto']);
    expect([...state.operations.keys()]).toEqual(['addpedido', 'deletepedido', 'updatepedido', 'close_pedido']);
    const registration = fixture.runtime.getRegistrations().find(({ gqltype }) => gqltype === Pedido);
    const add = state.operations.get('addpedido');
    expect(add).toMatchObject({ type: registration, operation: 'save', protected: true });
    expect(state.operations.get('deletepedido')).toMatchObject({ type: registration, operation: 'delete', protected: true });
    const update = state.operations.get('updatepedido');
    expect(update.operation).toBe('update');
    expect(update.type.gqltype).toBe(Pedido);
    expect(update.type.inputType.name).toBe('PedidoInputForUpdate');
    const close = state.operations.get('close_pedido');
    expect(close).toMatchObject({ operation: 'state_changed', actionName: 'close', protected: true });
    expect(close.type).toBe(update.type);
    expect(close.actionField).toBe(registration.stateMachine.actions.close);
    expect(add.actionName).toBeUndefined();
    // The state is reachable from a copy of the field, as the auth plugin's copies are.
    const copied = schema.getMutationType().toConfig().fields.transaction;
    expect(transactionStateOf(copied)).toBe(state);
    expect(getNamedType(copied.type).name).toBe('TransactionResult');
  });
});
