// The references of the generated transaction (#151, spec section 4.3), without running it: planReferences
// checks the `$K` tokens of a snapshot of operations against the types of a runtime-built schema, and
// resolveReferences writes the result IDs of one attempt into that attempt's copy. Execution, through the
// field itself, is tested in tests/transaction-execution.test.js.
import {
  beforeAll, describe, expect, test,
} from 'vitest';
import {
  GraphQLEnumType, GraphQLID, GraphQLInputObjectType, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString,
} from 'graphql';
import { createRuntime } from '@simtlix/simfinity-core';
import { createOptimisticMemoryAdapter } from './helpers/optimistic-memory-adapter.js';
import { transactionStateOf } from '../packages/core/src/transaction-schema.js';
import { planReferences, resolveReferences } from '../packages/core/src/transaction-references.js';

const OPTIMISTIC = { mode: 'optimistic' };
const reference = { relation: { embedded: false } };
const collection = (connectionField) => ({ relation: { embedded: false, connectionField } });
const listOf = (type) => new GraphQLList(type);

// Protected Pedido, with a state machine, a reference to a Cliente, an embedded Contacto (alone and in a
// list) that references a Cliente too, and a collection of protected Items; each Item has a collection of
// unprotected Notas and a list of IDs. Serie has two collections of Episodio through one connectionField
// that is a plain ID of Episodio; Categoria is a self-collection; Archivo is claimed by the collections of
// both Carpeta and Caja through one field name. Contacto has no endpoint.
const defineTypes = () => {
  const State = new GraphQLEnumType({ name: 'RefState', values: { OPEN: { value: 'OPEN' }, CLOSED: { value: 'CLOSED' } } });
  const Cliente = new GraphQLObjectType({
    name: 'Cliente',
    fields: { id: { type: GraphQLID }, nombre: { type: GraphQLString }, codigo: { type: GraphQLID } },
  });
  const Contacto = new GraphQLObjectType({
    name: 'Contacto',
    fields: () => ({ nombre: { type: GraphQLString }, cliente: { type: Cliente, extensions: reference } }),
  });
  const Nota = new GraphQLObjectType({
    name: 'Nota',
    fields: () => ({ id: { type: GraphQLID }, texto: { type: GraphQLString }, item: { type: Item, extensions: reference } }),
  });
  const Item = new GraphQLObjectType({
    name: 'Item',
    extensions: { concurrency: OPTIMISTIC },
    fields: () => ({
      id: { type: GraphQLID },
      nombre: { type: GraphQLString },
      tags: { type: listOf(GraphQLID) },
      pedido: { type: Pedido, extensions: reference },
      notas: { type: listOf(Nota), extensions: collection('item') },
    }),
  });
  const Pedido = new GraphQLObjectType({
    name: 'Pedido',
    extensions: { concurrency: OPTIMISTIC },
    fields: () => ({
      id: { type: GraphQLID },
      numero: { type: GraphQLString },
      state: { type: State },
      cliente: { type: Cliente, extensions: reference },
      contacto: { type: Contacto, extensions: { relation: { embedded: true } } },
      contactos: { type: listOf(Contacto), extensions: { relation: { embedded: true } } },
      items: { type: listOf(Item), extensions: collection('pedido') },
    }),
  });
  const Episodio = new GraphQLObjectType({
    name: 'Episodio',
    fields: { id: { type: GraphQLID }, title: { type: GraphQLString }, serie: { type: GraphQLID } },
  });
  const Serie = new GraphQLObjectType({
    name: 'Serie',
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      episodes: { type: listOf(Episodio), extensions: collection('serie') },
      featured: { type: listOf(Episodio), extensions: collection('serie') },
    }),
  });
  const Categoria = new GraphQLObjectType({
    name: 'Categoria',
    fields: () => ({
      id: { type: GraphQLID },
      nombre: { type: GraphQLString },
      parent: { type: GraphQLID },
      children: { type: listOf(Categoria), extensions: collection('parent') },
    }),
  });
  const Archivo = new GraphQLObjectType({
    name: 'Archivo',
    fields: { id: { type: GraphQLID }, nombre: { type: GraphQLString }, dueno: { type: new GraphQLNonNull(GraphQLID) } },
  });
  const Carpeta = new GraphQLObjectType({
    name: 'Carpeta',
    fields: () => ({ id: { type: GraphQLID }, nombre: { type: GraphQLString }, archivos: { type: listOf(Archivo), extensions: collection('dueno') } }),
  });
  const Caja = new GraphQLObjectType({
    name: 'Caja',
    fields: () => ({ id: { type: GraphQLID }, nombre: { type: GraphQLString }, archivos: { type: listOf(Archivo), extensions: collection('dueno') } }),
  });
  return {
    Cliente, Contacto, Nota, Item, Pedido, Episodio, Serie, Categoria, Archivo, Carpeta, Caja,
  };
};

// A schema with the transaction field over every type with an endpoint, and what planReferences takes:
// the state of the field and the registry the runtime hands over.
const build = () => {
  const runtime = createRuntime(createOptimisticMemoryAdapter());
  const types = defineTypes();
  runtime.addNoEndpointType(types.Contacto);
  runtime.connect(null, types.Cliente, 'cliente', 'clientes');
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
  runtime.connect(null, types.Episodio, 'episodio', 'episodios');
  runtime.connect(null, types.Serie, 'serie', 'series');
  runtime.connect(null, types.Categoria, 'categoria', 'categorias');
  runtime.connect(null, types.Archivo, 'archivo', 'archivos');
  runtime.connect(null, types.Carpeta, 'carpeta', 'carpetas');
  runtime.connect(null, types.Caja, 'caja', 'cajas');
  const endpoints = Object.values(types).filter((type) => type !== types.Contacto);
  const schema = runtime.createSchema(null, null, null, { transaction: { types: endpoints } });
  const state = transactionStateOf(schema.getMutationType().getFields().transaction);
  const registry = { registeredTypes: () => runtime.getRegistrations().map(({ gqltype }) => gqltype) };
  return {
    types, state, registry, plan: (operations) => planReferences(operations, state, registry),
  };
};

const { state, registry, plan } = build();

// The error a call throws, as code, status, message and the operation it names.
const thrown = (call) => {
  try {
    call();
  } catch (error) {
    return {
      code: error.extensions?.code,
      status: error.extensions?.status,
      message: error.message,
      operationIndex: error.extensions?.operationIndex,
      operation: error.extensions?.operation,
    };
  }
  throw new Error('expected the call to throw');
};

const invalid = (path, reason, operationIndex, operation) => ({
  code: 'INVALID_OPERATION_REFERENCE',
  status: 400,
  message: `Invalid reference at ${path}: ${reason}`,
  operationIndex,
  operation,
});

const positionsOf = (positions) => positions.map(({ index, path, source }) => ({ index, path, source }));
const copyOf = (operations) => structuredClone(operations);

describe('eligible positions', () => {
  test('the id of an update, an action and a delete (item 1)', () => {
    const operations = [
      { addpedido: { numero: 'A' } },
      { updatepedido: { id: '$0', version: 1, numero: 'B' } },
      { close_pedido: { id: '$0', version: 2 } },
      { deletepedido: { id: '$0', version: 3 } },
    ];
    const positions = plan(operations);
    expect(positionsOf(positions)).toEqual([
      { index: 1, path: 'operations[1].updatepedido.id', source: 0 },
      { index: 2, path: 'operations[2].close_pedido.id', source: 0 },
      { index: 3, path: 'operations[3].deletepedido.id', source: 0 },
    ]);
    // The tokens stay in the snapshot; each attempt's copy gets the IDs.
    expect(operations[1].updatepedido.id).toBe('$0');
    const attempt = copyOf(operations);
    resolveReferences(attempt, positions, [{ id: '1001' }]);
    expect(attempt[1].updatepedido).toEqual({ id: '1001', version: 1, numero: 'B' });
    expect(attempt[2].close_pedido.id).toBe('1001');
    expect(attempt[3].deletepedido).toEqual({ id: '1001', version: 3 });
    expect(operations[3].deletepedido.id).toBe('$0');
  });

  test('the id of a single reference, alone, in an embedded value and in an embedded list (item 2)', () => {
    const operations = [
      { addcliente: { nombre: 'Ana' } },
      {
        addpedido: {
          numero: 'A',
          cliente: { id: '$0' },
          contacto: { nombre: 'x', cliente: { id: '$0' } },
          contactos: [{ nombre: 'y' }, { cliente: { id: '$0' } }],
        },
      },
    ];
    const positions = plan(operations);
    expect(positionsOf(positions)).toEqual([
      { index: 1, path: 'operations[1].addpedido.cliente.id', source: 0 },
      { index: 1, path: 'operations[1].addpedido.contacto.cliente.id', source: 0 },
      { index: 1, path: 'operations[1].addpedido.contactos[1].cliente.id', source: 0 },
    ]);
    const attempt = copyOf(operations);
    resolveReferences(attempt, positions, [{ id: '7' }]);
    expect(attempt[1].addpedido).toEqual({
      numero: 'A',
      cliente: { id: '7' },
      contacto: { nombre: 'x', cliente: { id: '7' } },
      contactos: [{ nombre: 'y' }, { cliente: { id: '7' } }],
    });
  });

  test('the id of a reference expects the referenced type', () => {
    const operations = [{ addpedido: { numero: 'A' } }, { additem: { nombre: 'i', pedido: { id: '$0' } } }];
    expect(positionsOf(plan(operations))).toEqual([{ index: 1, path: 'operations[1].additem.pedido.id', source: 0 }]);
    expect(thrown(() => plan([{ addcliente: { nombre: 'Ana' } }, { additem: { nombre: 'i', pedido: { id: '$0' } } }])))
      .toEqual(invalid('operations[1].additem.pedido.id', 'operation 0 writes Cliente, expected Pedido', 1, 'additem'));
  });

  test('the id of nested updated entries and each deleted entry, with an ID or a version reference (item 3)', () => {
    const operations = [
      { addpedido: { numero: 'A' } },
      { additem: { nombre: 'i' } },
      { addnota: { texto: 't' } },
      {
        updatepedido: {
          id: '$0',
          version: 1,
          items: {
            added: [{ nombre: 'z', notas: { added: [{ texto: 'w' }] } }],
            updated: [{
              id: '$1',
              version: 1,
              nombre: 'x',
              notas: { updated: [{ id: '$2', texto: 'y' }], deleted: [null, '$2'] },
            }],
            deleted: [{ id: '$1', version: 2 }, null],
          },
        },
      },
    ];
    const positions = plan(operations);
    expect(positionsOf(positions)).toEqual([
      { index: 3, path: 'operations[3].updatepedido.id', source: 0 },
      { index: 3, path: 'operations[3].updatepedido.items.updated[0].id', source: 1 },
      { index: 3, path: 'operations[3].updatepedido.items.updated[0].notas.updated[0].id', source: 2 },
      { index: 3, path: 'operations[3].updatepedido.items.updated[0].notas.deleted[1]', source: 2 },
      { index: 3, path: 'operations[3].updatepedido.items.deleted[0].id', source: 1 },
    ]);
    const attempt = copyOf(operations);
    resolveReferences(attempt, positions, [{ id: '10' }, { id: '11' }, { id: '12' }]);
    expect(attempt[3].updatepedido).toEqual({
      id: '10',
      version: 1,
      items: {
        added: [{ nombre: 'z', notas: { added: [{ texto: 'w' }] } }],
        updated: [{
          id: '11',
          version: 1,
          nombre: 'x',
          notas: { updated: [{ id: '12', texto: 'y' }], deleted: [null, '12'] },
        }],
        deleted: [{ id: '11', version: 2 }, null],
      },
    });
  });

  test('nested entries expect the item type', () => {
    expect(thrown(() => plan([
      { addpedido: { numero: 'A' } },
      { updatepedido: { id: '1', version: 1, items: { updated: [{ id: '$0', version: 1 }] } } },
    ]))).toEqual(invalid('operations[1].updatepedido.items.updated[0].id', 'operation 0 writes Pedido, expected Item', 1,
      'updatepedido'));
    expect(thrown(() => plan([
      { addcliente: { nombre: 'Ana' } },
      { updatepedido: { id: '1', version: 1, items: { deleted: [{ id: '5', version: 1 }, { id: '$0', version: 1 }] } } },
    ]))).toEqual(invalid('operations[1].updatepedido.items.deleted[1].id', 'operation 0 writes Cliente, expected Item', 1,
      'updatepedido'));
    expect(thrown(() => plan([
      { addcliente: { nombre: 'Ana' } },
      { updateitem: { id: '1', version: 1, notas: { deleted: ['2', '$0'] } } },
    ]))).toEqual(invalid('operations[1].updateitem.notas.deleted[1]', 'operation 0 writes Cliente, expected Nota', 1,
      'updateitem'));
  });

  test('a connectionField that is an ID of the child, shared by two collections of one type (item 4)', () => {
    const operations = [
      { addserie: { name: 'S' } },
      { addepisodio: { title: 'E', serie: '$0' } },
      { updateepisodio: { id: '5', serie: '$0' } },
      {
        updateserie: {
          id: '$0',
          episodes: { added: [{ title: 'n' }] },
          featured: { updated: [{ id: '6', serie: '$0' }] },
        },
      },
    ];
    const positions = plan(operations);
    expect(positionsOf(positions)).toEqual([
      { index: 1, path: 'operations[1].addepisodio.serie', source: 0 },
      { index: 2, path: 'operations[2].updateepisodio.serie', source: 0 },
      { index: 3, path: 'operations[3].updateserie.id', source: 0 },
      { index: 3, path: 'operations[3].updateserie.featured.updated[0].serie', source: 0 },
    ]);
    const attempt = copyOf(operations);
    resolveReferences(attempt, positions, [{ id: '21' }]);
    expect(attempt[1].addepisodio).toEqual({ title: 'E', serie: '21' });
    expect(attempt[2].updateepisodio).toEqual({ id: '5', serie: '21' });
    expect(attempt[3].updateserie.featured.updated[0]).toEqual({ id: '6', serie: '21' });
    expect(thrown(() => plan([{ addepisodio: { title: 'E' } }, { addepisodio: { title: 'F', serie: '$0' } }])))
      .toEqual(invalid('operations[1].addepisodio.serie', 'operation 0 writes Episodio, expected Serie', 1, 'addepisodio'));
  });

  test('a self-collection expects its own type', () => {
    const operations = [
      { addcategoria: { nombre: 'raiz' } },
      { addcategoria: { nombre: 'hija', parent: '$0' } },
      { updatecategoria: { id: '$1', children: { updated: [{ id: '$0', parent: '$1' }] } } },
    ];
    expect(positionsOf(plan(operations))).toEqual([
      { index: 1, path: 'operations[1].addcategoria.parent', source: 0 },
      { index: 2, path: 'operations[2].updatecategoria.id', source: 1 },
      { index: 2, path: 'operations[2].updatecategoria.children.updated[0].id', source: 0 },
      { index: 2, path: 'operations[2].updatecategoria.children.updated[0].parent', source: 1 },
    ]);
    expect(thrown(() => plan([{ addserie: { name: 'S' } }, { addcategoria: { nombre: 'c', parent: '$0' } }])))
      .toEqual(invalid('operations[1].addcategoria.parent', 'operation 0 writes Serie, expected Categoria', 1, 'addcategoria'));
  });

  test('two declaring types sharing a field name make a token there ambiguous', () => {
    const operations = [{ addcarpeta: { nombre: 'c' } }, { addarchivo: { nombre: 'a', dueno: '$0' } }];
    expect(thrown(() => plan(operations)))
      .toEqual(invalid('operations[1].addarchivo.dueno', 'ambiguous inverse reference', 1, 'addarchivo'));
    // The same position keeps its text when it holds none.
    const literal = [{ addcarpeta: { nombre: 'c' } }, { addarchivo: { nombre: 'a', dueno: 'plain' } }];
    expect(plan(literal)).toEqual([]);
    expect(literal[1].addarchivo.dueno).toBe('plain');
    const escaped = [{ addarchivo: { nombre: 'a', dueno: '$$0' } }];
    expect(plan(escaped)).toEqual([]);
    expect(escaped[0].addarchivo.dueno).toBe('$0');
  });

  test('the connectionField is resolved through its alias', () => {
    // `owner` is stored as `ownerRef`, which is what the collection declares as its connectionField.
    const Child = new GraphQLObjectType({
      name: 'AliasChild',
      fields: {
        id: { type: GraphQLID },
        owner: { type: GraphQLID, extensions: { relation: { embedded: false, connectionField: 'ownerRef' } } },
      },
    });
    const Parent = new GraphQLObjectType({
      name: 'AliasParent',
      fields: () => ({
        id: { type: GraphQLID },
        children: { type: listOf(Child), extensions: collection('ownerRef') },
      }),
    });
    const input = (name, fields) => new GraphQLInputObjectType({ name, fields });
    const aliasState = {
      operations: new Map([
        ['addparent', { type: { gqltype: Parent, inputType: input('AliasParentInput', { id: { type: GraphQLID } }) }, operation: 'save' }],
        ['addchild', { type: { gqltype: Child, inputType: input('AliasChildInput', { owner: { type: GraphQLID } }) }, operation: 'save' }],
      ]),
    };
    const aliasRegistry = { registeredTypes: () => [Parent, Child] };
    expect(positionsOf(planReferences([{ addparent: {} }, { addchild: { owner: '$0' } }], aliasState, aliasRegistry)))
      .toEqual([{ index: 1, path: 'operations[1].addchild.owner', source: 0 }]);
    expect(thrown(() => planReferences([{ addchild: {} }, { addchild: { owner: '$0' } }], aliasState, aliasRegistry)))
      .toEqual(invalid('operations[1].addchild.owner', 'operation 0 writes AliasChild, expected AliasParent', 1, 'addchild'));
    // Without a collection that claims the field, the text stays.
    const unclaimed = { registeredTypes: () => [Child] };
    const literal = [{ addchild: {} }, { addchild: { owner: '$0' } }];
    expect(planReferences(literal, aliasState, unclaimed)).toEqual([]);
    expect(literal[1].addchild.owner).toBe('$0');
  });

  test('positions are found by type: values of any other field keep their text', () => {
    const operations = [
      {
        addcliente: { nombre: '$0', codigo: '$1' },
      },
      {
        additem: { nombre: '$$0', tags: ['$0', '$$0'] },
      },
    ];
    const before = copyOf(operations);
    expect(plan(operations)).toEqual([]);
    expect(operations).toEqual(before);
  });

  test('objects without a prototype, as GraphQL coerces them, are walked as any other', () => {
    const withoutPrototype = (value) => {
      if (Array.isArray(value)) return value.map(withoutPrototype);
      if (value === null || typeof value !== 'object') return value;
      return Object.assign(Object.create(null), Object.fromEntries(Object.entries(value)
        .map(([key, item]) => [key, withoutPrototype(item)])));
    };
    const operations = withoutPrototype([
      { addcliente: { nombre: 'Ana' } },
      { addpedido: { numero: 'A', cliente: { id: '$0' }, items: { added: [{ nombre: 'i' }] } } },
    ]);
    expect(positionsOf(plan(operations))).toEqual([{ index: 1, path: 'operations[1].addpedido.cliente.id', source: 0 }]);
  });

  test('a plan without tokens is empty', () => {
    expect(plan([{ addcliente: { nombre: 'Ana' } }, { updatepedido: { id: '5', version: 1 } }])).toEqual([]);
  });
});

describe('syntax', () => {
  test.each(['$01', '$00', '$-1', '$x', '$', '$ 0', '$0 ', '$1.5', '$0x1', '$٣'])('%s is malformed', (token) => {
    expect(thrown(() => plan([{ addpedido: { numero: 'A' } }, { updatepedido: { id: token, version: 1 } }])))
      .toEqual(invalid('operations[1].updatepedido.id', 'malformed reference', 1, 'updatepedido'));
    expect(thrown(() => plan([
      { addcliente: { nombre: 'Ana' } },
      { addpedido: { numero: 'A', contactos: [{ cliente: { id: token } }] } },
    ]))).toEqual(invalid('operations[1].addpedido.contactos[0].cliente.id', 'malformed reference', 1, 'addpedido'));
    expect(thrown(() => plan([{ addserie: { name: 'S' } }, { addepisodio: { title: 'E', serie: token } }])))
      .toEqual(invalid('operations[1].addepisodio.serie', 'malformed reference', 1, 'addepisodio'));
  });

  test('K is 0 or a number without leading zeros, of any length', () => {
    const operations = Array.from({ length: 12 }, () => ({ addpedido: { numero: 'A' } }));
    operations.push({ updatepedido: { id: '$10', version: 1 } });
    expect(positionsOf(plan(operations))).toEqual([{ index: 12, path: 'operations[12].updatepedido.id', source: 10 }]);
  });

  test('$$ loses one $ and is a literal that is not read again', () => {
    const operations = [
      { addpedido: { numero: '$$0' } },
      { updatepedido: { id: '$$0', version: 1 } },
      { additem: { nombre: 'x', pedido: { id: '$$$0' } } },
      { updatepedido: { id: '$$', version: 1 } },
    ];
    const positions = plan(operations);
    expect(positions).toEqual([]);
    // numero is no ID position, so it keeps both signs.
    expect(operations[0].addpedido.numero).toBe('$$0');
    expect(operations[1].updatepedido.id).toBe('$0');
    expect(operations[2].additem.pedido.id).toBe('$$0');
    expect(operations[3].updatepedido.id).toBe('$');
    const attempt = copyOf(operations);
    resolveReferences(attempt, positions, [{ id: '1' }]);
    expect(attempt).toEqual(operations);
  });

  test('a token and a literal mix in one plan', () => {
    const operations = [
      { addpedido: { numero: 'A' } },
      { additem: { nombre: 'x', pedido: { id: '$$0' } } },
      { additem: { nombre: 'y', pedido: { id: '$0' } } },
    ];
    const positions = plan(operations);
    expect(positionsOf(positions)).toEqual([{ index: 2, path: 'operations[2].additem.pedido.id', source: 0 }]);
    const attempt = copyOf(operations);
    resolveReferences(attempt, positions, [{ id: '9' }]);
    expect(attempt[1].additem.pedido.id).toBe('$0');
    expect(attempt[2].additem.pedido.id).toBe('9');
  });

  test('a failed plan leaves the snapshot as it was', () => {
    const operations = [
      { addpedido: { numero: 'A' } },
      { updatepedido: { id: '$$0', version: 1 } },
      { updatepedido: { id: '$x', version: 1 } },
    ];
    const before = copyOf(operations);
    expect(thrown(() => plan(operations)).code).toBe('INVALID_OPERATION_REFERENCE');
    expect(operations).toEqual(before);
  });
});

describe('checks before the transaction', () => {
  test('a forward reference and a reference to itself do not precede', () => {
    expect(thrown(() => plan([{ updatepedido: { id: '$1', version: 1 } }, { addpedido: { numero: 'A' } }])))
      .toEqual(invalid('operations[0].updatepedido.id', 'operation 1 does not precede it', 0, 'updatepedido'));
    expect(thrown(() => plan([{ addpedido: { numero: 'A' } }, { updatepedido: { id: '$1', version: 1 } }])))
      .toEqual(invalid('operations[1].updatepedido.id', 'operation 1 does not precede it', 1, 'updatepedido'));
    expect(thrown(() => plan([{ updatepedido: { id: '$0', version: 1 } }])))
      .toEqual(invalid('operations[0].updatepedido.id', 'operation 0 does not precede it', 0, 'updatepedido'));
  });

  test('an index past the end of the list does not exist', () => {
    expect(thrown(() => plan([{ addpedido: { numero: 'A' } }, { updatepedido: { id: '$5', version: 1 } }])))
      .toEqual(invalid('operations[1].updatepedido.id', 'operation 5 does not exist', 1, 'updatepedido'));
    expect(thrown(() => plan([{ addpedido: { numero: 'A' } }, { updatepedido: { id: '$2', version: 1 } }])))
      .toEqual(invalid('operations[1].updatepedido.id', 'operation 2 does not exist', 1, 'updatepedido'));
    const huge = '9'.repeat(40);
    expect(thrown(() => plan([{ addpedido: { numero: 'A' } }, { updatepedido: { id: `$${huge}`, version: 1 } }])))
      .toEqual(invalid('operations[1].updatepedido.id', `operation ${huge} does not exist`, 1, 'updatepedido'));
  });

  test('a delete has no ID to give', () => {
    expect(thrown(() => plan([{ deletepedido: { id: '1', version: 1 } }, { updatepedido: { id: '$0', version: 1 } }])))
      .toEqual(invalid('operations[1].updatepedido.id', 'operation 0 is a delete', 1, 'updatepedido'));
    expect(thrown(() => plan([{ deleteserie: { id: '1' } }, { addepisodio: { title: 'E', serie: '$0' } }])))
      .toEqual(invalid('operations[1].addepisodio.serie', 'operation 0 is a delete', 1, 'addepisodio'));
  });

  test('an update and an action give the ID of the record they write', () => {
    const operations = [
      { updatepedido: { id: '5', version: 1, numero: 'B' } },
      { close_pedido: { id: '5', version: 2 } },
      { additem: { nombre: 'i', pedido: { id: '$0' } } },
      { additem: { nombre: 'j', pedido: { id: '$1' } } },
    ];
    expect(positionsOf(plan(operations))).toEqual([
      { index: 2, path: 'operations[2].additem.pedido.id', source: 0 },
      { index: 3, path: 'operations[3].additem.pedido.id', source: 1 },
    ]);
  });

  test('the type of the source must be the expected type', () => {
    expect(thrown(() => plan([{ addcliente: { nombre: 'Ana' } }, { updatepedido: { id: '$0', version: 1 } }])))
      .toEqual(invalid('operations[1].updatepedido.id', 'operation 0 writes Cliente, expected Pedido', 1, 'updatepedido'));
    expect(thrown(() => plan([{ addcliente: { nombre: 'Ana' } }, { close_pedido: { id: '$0', version: 1 } }])))
      .toEqual(invalid('operations[1].close_pedido.id', 'operation 0 writes Cliente, expected Pedido', 1, 'close_pedido'));
    expect(thrown(() => plan([{ addcliente: { nombre: 'Ana' } }, { deletepedido: { id: '$0', version: 1 } }])))
      .toEqual(invalid('operations[1].deletepedido.id', 'operation 0 writes Cliente, expected Pedido', 1, 'deletepedido'));
  });

  test('the first failure in operation order is the one reported', () => {
    expect(thrown(() => plan([
      { addpedido: { numero: 'A' } },
      { updatepedido: { id: '$0', version: 1 } },
      { updatepedido: { id: '$7', version: 1 } },
      { updatepedido: { id: '$x', version: 1 } },
    ]))).toEqual(invalid('operations[2].updatepedido.id', 'operation 7 does not exist', 2, 'updatepedido'));
  });

  test('the error is a SimfinityError that names the operation', () => {
    let error;
    try {
      plan([{ updatepedido: { id: '$x', version: 1 } }]);
    } catch (thrownError) {
      error = thrownError;
    }
    expect(error.extensions).toMatchObject({
      code: 'INVALID_OPERATION_REFERENCE', status: 400, operationIndex: 0, operation: 'updatepedido',
    });
    expect(error.getCode()).toBe('INVALID_OPERATION_REFERENCE');
    expect(error.getStatus()).toBe(400);
  });

  test('the registry is read for item 4 only', () => {
    let calls = 0;
    const counting = { registeredTypes: () => { calls += 1; return registry.registeredTypes(); } };
    planReferences([{ addpedido: { numero: 'A' } }, { updatepedido: { id: '$0', version: 1 } }], state, counting);
    expect(calls).toBe(0);
    planReferences([{ addserie: { name: 'S' } }, { addepisodio: { title: 'E', serie: '$0' } },
      { addepisodio: { title: 'F', serie: '$0' } }], state, counting);
    expect(calls).toBe(1);
  });
});

describe('resolution', () => {
  const operations = [
    { addserie: { name: 'S' } },
    { addpedido: { numero: 'A' } },
    { addepisodio: { title: 'E', serie: '$0' } },
    { updatepedido: { id: '$1', version: 1, numero: 'B' } },
  ];
  let positions;
  beforeAll(() => {
    positions = plan(operations);
  });

  test('it writes the IDs given to it, so a second call with new results writes the new IDs', () => {
    const first = copyOf(operations);
    resolveReferences(first, positions, [{ id: '100' }, { id: '101' }]);
    expect(first[2].addepisodio.serie).toBe('100');
    expect(first[3].updatepedido.id).toBe('101');
    const second = copyOf(operations);
    resolveReferences(second, positions, [{ id: '200' }, { id: '201' }]);
    expect(second[2].addepisodio.serie).toBe('200');
    expect(second[3].updatepedido.id).toBe('201');
    // The first attempt's copy and the snapshot are not touched by the second.
    expect(first[2].addepisodio.serie).toBe('100');
    expect(operations[2].addepisodio.serie).toBe('$0');
    // A copy that already holds IDs takes new ones as well.
    resolveReferences(first, positions, [{ id: '300' }, { id: '301' }]);
    expect(first[2].addepisodio.serie).toBe('300');
    expect(first[3].updatepedido.id).toBe('301');
  });

  test('the ID is serialized like the ID scalar', () => {
    const objectId = { toJSON: () => '64b7f0c2a1b2c3d4e5f60718', valueOf() { return this; } };
    const attempt = copyOf(operations);
    resolveReferences(attempt, positions, [{ id: objectId }, { id: 42 }]);
    expect(attempt[2].addepisodio.serie).toBe('64b7f0c2a1b2c3d4e5f60718');
    expect(attempt[3].updatepedido.id).toBe('42');
    expect(typeof attempt[3].updatepedido.id).toBe('string');
  });

  test('without an index, positions whose source has no result yet keep their token', () => {
    const attempt = copyOf(operations);
    resolveReferences(attempt, positions, [{ id: '100' }]);
    expect(attempt[2].addepisodio.serie).toBe('100');
    expect(attempt[3].updatepedido.id).toBe('$1');
    resolveReferences(attempt, positions, [{ id: '100' }, { id: '101' }]);
    expect(attempt[3].updatepedido.id).toBe('101');
  });

  test('with an operation index, only that operation is written, and a missing result is an error', () => {
    const attempt = copyOf(operations);
    resolveReferences(attempt, positions, [{ id: '100' }, { id: '101' }], 3);
    expect(attempt[2].addepisodio.serie).toBe('$0');
    expect(attempt[3].updatepedido.id).toBe('101');
    resolveReferences(attempt, positions, [{ id: '100' }, { id: '101' }], 2);
    expect(attempt[2].addepisodio.serie).toBe('100');
    expect(() => resolveReferences(copyOf(operations), positions, [{ id: '100' }], 3))
      .toThrow('The result of operation 1 has no ID to reference');
    expect(() => resolveReferences(copyOf(operations), positions, [{ id: '100' }, { id: null }], 3))
      .toThrow('The result of operation 1 has no ID to reference');
    // An operation without tokens needs nothing.
    resolveReferences(copyOf(operations), positions, [], 1);
  });

  test('a copy that lost the structure of the plan is an error, not a silent skip', () => {
    const attempt = copyOf(operations);
    delete attempt[2].addepisodio;
    expect(() => resolveReferences(attempt, positions, [{ id: '100' }, { id: '101' }]))
      .toThrow('The copy of operation 2 has no value at operations[2].addepisodio.serie');
  });

  test('an empty plan writes nothing', () => {
    const attempt = copyOf(operations);
    resolveReferences(attempt, [], []);
    expect(attempt).toEqual(operations);
  });
});
