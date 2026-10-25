// Declarative optimistic concurrency (#98), decision 9: a stale or exhausted version is reported before
// the record's validators and hooks only to a caller who can read the record through the type's
// get_by_id scope. A caller the scope hides, or whose scope function throws, reaches the same hooks,
// in the same order and with the same stored record, for any version it sends; the conditional write
// then reports the conflict, and only if the hooks let the write through. The read that decides it runs
// the get_by_id scope, the query gates and adapter.find as a by-ID read does, in the operation's
// transaction.
import {
  describe, expect, test,
} from 'vitest';
import {
  GraphQLEnumType, GraphQLID, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';
import { QLOperator, SimfinityError, createRuntime } from '@simtlix/simfinity-core';
import { createOptimisticMemoryAdapter } from './helpers/optimistic-memory-adapter.js';

const MAX = Number.MAX_SAFE_INTEGER;
const OPTIMISTIC = { mode: 'optimistic' };
const CONFLICT = (type, id) => ({ code: 'VERSION_CONFLICT', status: 409, message: `${type} ${id} was modified by another operation` });
const EXHAUSTED = (type, id) => ({ code: 'VERSION_EXHAUSTED', status: 409, message: `${type} ${id} has reached the maximum version` });
const REFUSED = { code: 'FORBIDDEN', status: 403, message: 'Not allowed' };
const refuse = () => {
  throw new SimfinityError('Not allowed', 'FORBIDDEN', 403);
};
const DECLARED = { operators: QLOperator.getValues().map((entry) => entry.value), referenceEmptiness: true };
// The transaction the memory adapter opens for an operation's first attempt.
const SESSION = { memory: true, attempt: 1 };

// Every record belongs to tenant A, and the default get_by_id scope shows a caller its tenant's records.
const READER = () => ({ tenant: 'A' });
const HIDDEN = () => ({ tenant: 'B' });
const tenantScope = ({ args, context }) => {
  args.tenant = { operator: 'EQ', value: context.tenant };
};
const byTenant = (tenant, id) => ({ id: { operator: 'EQ', value: id }, tenant: { operator: 'EQ', value: tenant } });

// The single error of a result, as code, status and message.
const failure = (result) => {
  expect(result.errors, JSON.stringify(result.data)).toHaveLength(1);
  const [error] = result.errors;
  const extensions = error.originalError?.extensions ?? error.extensions;
  return { code: extensions?.code, status: extensions?.status, message: error.message };
};

// Protected types: Producto; Pedido, with a validator, a state machine, an embedded address and a
// collection of Items; Item, with a validator and its reference to Pedido. Each declares `scope` for
// `scopeOperations`, which records the call and runs `scope(params, typeName)`. `trace` holds every
// middleware, validator, action and hook call with a copy of what it received, `steps` the names of
// those calls and of the scope calls in order, and `hooks` lets a test act in any of them.
const buildFixture = ({
  scope = tenantScope, scopeOperations = ['get_by_id'], queryFeatures, virtualField = false, requiredEmbeddedList = false,
} = {}) => {
  const adapter = createOptimisticMemoryAdapter();
  if (queryFeatures) adapter.queryFeatures = queryFeatures;
  const runtime = createRuntime(adapter);
  const trace = [];
  const steps = [];
  const hooks = {};
  const note = (name, payload) => {
    trace.push([name, structuredClone(payload)]);
    steps.push(name);
    return hooks[name]?.(payload);
  };
  const scopes = (typeName) => Object.fromEntries(scopeOperations.map((operation) => [operation, (params) => {
    steps.push(`scope ${operation} ${typeName}`);
    return scope(params, typeName);
  }]));
  const validations = (typeName) => ({ UPDATE: [{ validate: (_name, args) => note(`${typeName} validator`, args) }] });
  const State = new GraphQLEnumType({ name: 'VsState', values: { OPEN: { value: 'OPEN' }, CLOSED: { value: 'CLOSED' } } });
  const Address = new GraphQLObjectType({
    name: 'VsAddress', fields: { street: { type: requiredEmbeddedList ? new GraphQLNonNull(GraphQLString) : GraphQLString }, city: { type: GraphQLString } },
  });
  const Producto = new GraphQLObjectType({
    name: 'Producto',
    extensions: { concurrency: OPTIMISTIC, scope: scopes('Producto') },
    fields: {
      id: { type: GraphQLID },
      tenant: { type: GraphQLString },
      name: { type: GraphQLString },
      price: { type: GraphQLInt },
      ...(virtualField ? { label: { type: GraphQLString, resolve: () => 'label', extensions: { virtual: true } } } : {}),
    },
  });
  const Item = new GraphQLObjectType({
    name: 'Item',
    extensions: { concurrency: OPTIMISTIC, scope: scopes('Item'), validations: validations('Item') },
    fields: () => ({
      id: { type: GraphQLID },
      tenant: { type: GraphQLString },
      nombre: { type: GraphQLString },
      pedido: { type: Pedido, extensions: { relation: { embedded: false } } },
    }),
  });
  const Pedido = new GraphQLObjectType({
    name: 'Pedido',
    extensions: { concurrency: OPTIMISTIC, scope: scopes('Pedido'), validations: validations('Pedido') },
    fields: () => ({
      id: { type: GraphQLID },
      tenant: { type: GraphQLString },
      numero: { type: GraphQLString },
      state: { type: State },
      address: { type: Address, extensions: { relation: { embedded: true } } },
      ...(requiredEmbeddedList ? { addresses: { type: new GraphQLList(Address), extensions: { relation: { embedded: true } } } } : {}),
      items: { type: new GraphQLList(Item), extensions: { relation: { embedded: false, connectionField: 'pedido' } } },
    }),
  });
  const controller = (typeName) => ({
    onUpdating: (id, update) => note(`${typeName}.onUpdating`, { id, update }),
    onUpdated: (record) => note(`${typeName}.onUpdated`, { version: record.version }),
    onDelete: (record) => note(`${typeName}.onDelete`, record),
  });
  runtime.use(async (params, next) => {
    await note(`middleware ${params.operation} ${params.type?.gqltype.name}`, params.args);
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
  const run = (source, contextValue) => graphql({ schema, source, contextValue });
  const finds = () => adapter.find.mock.calls;
  const updates = () => adapter.update.mock.calls.map(([Model, id, , , options]) => ({ type: Model.name, id, options }));
  const deletes = () => adapter.delete.mock.calls.map(([Model, id, , options]) => ({ type: Model.name, id, options }));
  return {
    adapter, run, trace, steps, hooks, finds, updates, deletes,
  };
};

// Producto 1, Pedido 1 and its Items 11 and 12, all of tenant A, at the given versions (5 by default).
const seedRecords = (adapter, {
  producto = 5, pedido = 5, item11 = 5, item12 = 5, state = 'OPEN',
} = {}) => {
  adapter.seed('Producto', {
    _id: '1', tenant: 'A', name: 'a', price: 1, version: producto,
  });
  adapter.seed('Pedido', {
    _id: '1', tenant: 'A', numero: 'A', state, address: { street: 's', city: 'c' }, version: pedido,
  });
  adapter.seed('Item', {
    _id: '11', tenant: 'A', nombre: 'a', pedido: '1', version: item11,
  });
  adapter.seed('Item', {
    _id: '12', tenant: 'A', nombre: 'b', pedido: '1', version: item12,
  });
};

// The version a hidden caller sends and the one stored. An update cannot be current at the maximum, so
// the exhausted case stores a record at the maximum; a delete at the maximum is not exhausted.
const UPDATE_VERSIONS = [['current', 5, 5], ['stale', 4, 5], ['exhausted', MAX, MAX]];
const DELETE_VERSIONS = [['current', 5, 5], ['stale', 4, 5], ['maximum', MAX, MAX]];

describe('a caller the get_by_id scope hides', () => {
  test('update: validators, the merge from the stored record and onUpdating run alike for any version, and the write tells the versions apart', async () => {
    for (const [label, sent, stored] of UPDATE_VERSIONS) {
      const source = `mutation { updatepedido(input: { id: "1", version: ${sent}, numero: "Z", address: { city: "new" } }) {
        id version } }`;
      const before = [
        ['middleware update Pedido', { input: { id: '1', version: sent, numero: 'Z', address: { city: 'new' } } }],
        ['Pedido validator', { id: '1', version: sent, numero: 'Z', address: { city: 'new' } }],
        ['Pedido.onUpdating', { id: '1', update: { id: '1', numero: 'Z', address: { street: 's', city: 'new' } } }],
      ];
      // Hooks that refuse the write give the same outcome whatever version was sent.
      const refused = buildFixture();
      seedRecords(refused.adapter, { pedido: stored });
      refused.hooks['Pedido.onUpdating'] = refuse;
      expect(failure(await refused.run(source, HIDDEN())), label).toEqual(REFUSED);
      expect(refused.trace, label).toEqual(before);
      expect(refused.adapter.update, label).not.toHaveBeenCalled();

      // Hooks that accept it reach the conditional write, which reports the conflict.
      const accepted = buildFixture();
      seedRecords(accepted.adapter, { pedido: stored });
      const result = await accepted.run(source, HIDDEN());
      expect(accepted.updates(), label).toEqual([{ type: 'Pedido', id: '1', options: { expectedVersion: sent } }]);
      if (label === 'current') {
        expect(result.errors).toBeUndefined();
        expect(result.data.updatepedido).toEqual({ id: '1', version: 6 });
        expect(accepted.trace).toEqual([...before, ['Pedido.onUpdated', { version: 6 }]]);
      } else {
        expect(failure(result), label).toEqual((label === 'stale' ? CONFLICT : EXHAUSTED)('Pedido', 1));
        expect(accepted.trace, label).toEqual(before);
        expect(accepted.adapter.stored('Pedido', '1'), label).toMatchObject({ numero: 'A', version: stored });
      }
      // Only a version that differs makes core ask whether the caller can read the record.
      expect(accepted.finds(), label).toHaveLength(label === 'current' ? 0 : 1);
    }
  });

  test('state action: the from-state check and the action run alike for any version, and the write tells the versions apart', async () => {
    for (const [label, sent, stored] of UPDATE_VERSIONS) {
      const source = `mutation { close_pedido(input: { id: "1", version: ${sent} }) { state version } }`;
      const before = [
        ['middleware state_changed Pedido', { input: { id: '1', version: sent } }],
        ['close action', { id: '1', version: sent }],
        ['Pedido validator', { id: '1', version: sent, state: 'CLOSED' }],
        ['Pedido.onUpdating', { id: '1', update: { id: '1', state: 'CLOSED' } }],
      ];
      const refused = buildFixture();
      seedRecords(refused.adapter, { pedido: stored });
      refused.hooks['Pedido.onUpdating'] = refuse;
      expect(failure(await refused.run(source, HIDDEN())), label).toEqual(REFUSED);
      expect(refused.trace, label).toEqual(before);
      expect(refused.adapter.update, label).not.toHaveBeenCalled();

      const accepted = buildFixture();
      seedRecords(accepted.adapter, { pedido: stored });
      const result = await accepted.run(source, HIDDEN());
      expect(accepted.updates(), label).toEqual([{ type: 'Pedido', id: '1', options: { expectedVersion: sent } }]);
      if (label === 'current') {
        expect(result.errors).toBeUndefined();
        expect(result.data.close_pedido).toEqual({ state: 'CLOSED', version: 6 });
        expect(accepted.trace).toEqual([...before, ['Pedido.onUpdated', { version: 6 }]]);
      } else {
        expect(failure(result), label).toEqual((label === 'stale' ? CONFLICT : EXHAUSTED)('Pedido', 1));
        expect(accepted.trace, label).toEqual(before);
        expect(accepted.adapter.stored('Pedido', '1'), label).toMatchObject({ state: 'OPEN', version: stored });
      }

      // From another state, the from-state check fails alike for any version, before the action.
      const closed = buildFixture();
      seedRecords(closed.adapter, { pedido: stored, state: 'CLOSED' });
      expect(failure(await closed.run(source, HIDDEN())), label)
        .toEqual({ code: 'BAD_REQUEST', status: 400, message: 'Action is not allowed from state CLOSED' });
      expect(closed.trace, label).toEqual(before.slice(0, 1));
    }
  });

  test.each([
    {
      key: 'updated',
      versions: UPDATE_VERSIONS,
      id: '11',
      entry: (sent) => ({ id: '11', version: sent, nombre: 'x' }),
      childHooks: (sent) => [
        ['middleware update Item', { input: { id: '11', version: sent, nombre: 'x' } }],
        ['Item validator', { id: '11', version: sent, nombre: 'x' }],
        ['Item.onUpdating', { id: '11', update: { id: '11', nombre: 'x', pedido: '1' } }],
      ],
      childHook: 'Item.onUpdating',
    },
    {
      key: 'deleted',
      versions: DELETE_VERSIONS,
      id: '12',
      entry: (sent) => ({ id: '12', version: sent }),
      childHooks: (sent, stored) => [
        ['middleware delete Item', { id: '12', version: sent }],
        ['Item.onDelete', {
          _id: '12', tenant: 'A', nombre: 'b', pedido: '1', version: stored,
        }],
      ],
      childHook: 'Item.onDelete',
    },
  ])('nested $key entry: ownership and the child\'s hooks run alike for any version, and a conflict at its write rolls back the mutation', async ({
    key, versions, id, entry, childHooks, childHook,
  }) => {
    for (const [label, sent, stored] of versions) {
      const literal = Object.entries(entry(sent)).map(([field, value]) => `${field}: ${JSON.stringify(value)}`).join(', ');
      const source = `mutation { updatepedido(input: { id: "1", version: 5, numero: "Z", items: { ${key}: [{ ${literal} }] } }) {
        id version } }`;
      const input = {
        id: '1', version: 5, numero: 'Z', items: { [key]: [entry(sent)] },
      };
      const before = [
        ['middleware update Pedido', { input }],
        ['Pedido validator', input],
        ['Pedido.onUpdating', { id: '1', update: { id: '1', numero: 'Z' } }],
        ...childHooks(sent, stored),
      ];
      const seeded = key === 'updated' ? { item11: stored } : { item12: stored };
      const refused = buildFixture();
      seedRecords(refused.adapter, seeded);
      refused.hooks[childHook] = refuse;
      expect(failure(await refused.run(source, HIDDEN())), label).toEqual(REFUSED);
      expect(refused.trace, label).toEqual(before);
      expect(refused.adapter.stored('Pedido', '1'), label).toMatchObject({ numero: 'A', version: 5 });
      expect(refused.adapter.stored('Item', id), label).toMatchObject({ version: stored });

      const accepted = buildFixture();
      seedRecords(accepted.adapter, seeded);
      const result = await accepted.run(source, HIDDEN());
      const written = key === 'updated'
        ? accepted.updates().filter(({ type }) => type === 'Item') : accepted.deletes();
      expect(written, label).toEqual([{ type: 'Item', id, options: { expectedVersion: sent } }]);
      // A delete at the maximum matches; only a version that differs makes core read the record again.
      const conflicting = label === 'stale' || label === 'exhausted';
      if (conflicting) {
        expect(failure(result), label).toEqual((label === 'stale' ? CONFLICT : EXHAUSTED)('Item', id));
        expect(accepted.trace, label).toEqual(before);
        expect(accepted.adapter.stored('Pedido', '1'), label).toMatchObject({ numero: 'A', version: 5 });
        expect(accepted.adapter.stored('Item', id), label).toMatchObject({ version: stored });
      } else {
        expect(result.errors, label).toBeUndefined();
        expect(result.data.updatepedido, label).toEqual({ id: '1', version: 6 });
      }
      expect(accepted.finds().map(([Model]) => Model.name), label).toEqual(conflicting ? ['Item'] : []);
    }
  });

  test('delete: onDelete receives the stored record alike for any version, and the conditional delete tells the versions apart', async () => {
    for (const [label, sent, stored] of DELETE_VERSIONS) {
      const source = `mutation { deleteproducto(id: "1", version: ${sent}) { id version } }`;
      const before = [
        ['middleware delete Producto', { id: '1', version: sent }],
        ['Producto.onDelete', {
          _id: '1', tenant: 'A', name: 'a', price: 1, version: stored,
        }],
      ];
      const refused = buildFixture();
      seedRecords(refused.adapter, { producto: stored });
      refused.hooks['Producto.onDelete'] = refuse;
      expect(failure(await refused.run(source, HIDDEN())), label).toEqual(REFUSED);
      expect(refused.trace, label).toEqual(before);
      expect(refused.adapter.delete, label).not.toHaveBeenCalled();

      const accepted = buildFixture();
      seedRecords(accepted.adapter, { producto: stored });
      const result = await accepted.run(source, HIDDEN());
      expect(accepted.trace, label).toEqual(before);
      expect(accepted.deletes(), label).toEqual([{ type: 'Producto', id: '1', options: { expectedVersion: sent } }]);
      if (label === 'stale') {
        expect(failure(result)).toEqual(CONFLICT('Producto', 1));
        expect(accepted.adapter.stored('Producto', '1')).toMatchObject({ version: stored });
        expect(accepted.finds()).toHaveLength(1);
      } else {
        expect(result.errors, label).toBeUndefined();
        expect(result.data.deleteproducto, label).toEqual({ id: '1', version: stored });
        expect(accepted.finds(), label).toEqual([]);
      }
    }
  });
});

describe('the get_by_id scope function', () => {
  test.each([
    ['throws', () => {
      throw new Error('scope failed');
    }],
    ['rejects', async () => {
      throw new Error('scope failed');
    }],
  ])('one that %s counts as hiding the record: the hooks run and the write reports the conflict', async (_label, scope) => {
    for (const [source, typeName, events, written] of [
      ['mutation { updatepedido(input: { id: "1", version: 4, numero: "Z" }) { id } }', 'Pedido',
        ['middleware update Pedido', 'scope get_by_id Pedido', 'Pedido validator', 'Pedido.onUpdating'], 'updates'],
      ['mutation { deleteproducto(id: "1", version: 4) { id } }', 'Producto',
        ['middleware delete Producto', 'scope get_by_id Producto', 'Producto.onDelete'], 'deletes'],
    ]) {
      const fixture = buildFixture({ scope });
      seedRecords(fixture.adapter);
      expect(failure(await fixture.run(source, READER()))).toEqual(CONFLICT(typeName, 1));
      expect(fixture.steps).toEqual(events);
      expect(fixture.finds()).toEqual([]);
      expect(fixture[written]()).toEqual([{ type: typeName, id: '1', options: { expectedVersion: 4 } }]);
    }
  });

  test.each([
    ['the stored-path gate', { virtualField: true, scope: ({ args }) => { args.label = { operator: 'EQ', value: 'x' }; } }, {
      code: 'INVALID_MODEL',
      status: 500,
      message: 'Query path label, added by middleware or a scope, uses the virtual field Producto.label, which is not stored',
    }],
    ['the condition gate', { scope: ({ args }) => { args.name = { operator: 'IS_EMPTY' }; } }, {
      code: 'UNSUPPORTED_QUERY', status: 400, message: 'The database adapter does not support the IS_EMPTY filter operator, used on Producto.name',
    }],
  ])('one that %s rejects fails the operation with that error, before any hook', async (_label, options, expected) => {
    for (const context of [READER(), HIDDEN()]) {
      const fixture = buildFixture(options);
      seedRecords(fixture.adapter);
      expect(failure(await fixture.run('mutation { deleteproducto(id: "1", version: 4) { id } }', context))).toEqual(expected);
      expect(fixture.steps).toEqual(['middleware delete Producto', 'scope get_by_id Producto']);
      expect(fixture.finds()).toEqual([]);
      expect(fixture.adapter.delete).not.toHaveBeenCalled();
    }
  });

  test('an error of adapter.find fails the operation with that error, before any hook', async () => {
    const fixture = buildFixture();
    seedRecords(fixture.adapter);
    fixture.adapter.find.mockRejectedValueOnce(new SimfinityError('read failed', 'DATABASE_ERROR', 500));
    expect(failure(await fixture.run('mutation { deleteproducto(id: "1", version: 4) { id } }', HIDDEN())))
      .toEqual({ code: 'DATABASE_ERROR', status: 500, message: 'read failed' });
    expect(fixture.steps).toEqual(['middleware delete Producto', 'scope get_by_id Producto']);
    expect(fixture.adapter.delete).not.toHaveBeenCalled();
  });
});

describe('the read that decides whether a conflict is reported early', () => {
  test.each([
    ['an update', 'mutation { updatepedido(input: { id: "1", version: 4, numero: "Z" }) { id } }', 'Pedido', '1',
      ['middleware update Pedido']],
    ['a state action', 'mutation { close_pedido(input: { id: "1", version: 4 }) { id } }', 'Pedido', '1',
      ['middleware state_changed Pedido']],
    ['a nested updated entry', `mutation { updatepedido(input: { id: "1", version: 5,
      items: { updated: [{ id: "11", version: 4, nombre: "x" }] } }) { id } }`, 'Item', '11',
    ['middleware update Pedido', 'Pedido validator', 'Pedido.onUpdating', 'middleware update Item']],
    ['a nested deleted entry', `mutation { updatepedido(input: { id: "1", version: 5,
      items: { deleted: [{ id: "12", version: 4 }] } }) { id } }`, 'Item', '12',
    ['middleware update Pedido', 'Pedido validator', 'Pedido.onUpdating', 'middleware delete Item']],
    ['a delete', 'mutation { deleteproducto(id: "1", version: 4) { id } }', 'Producto', '1', ['middleware delete Producto']],
  ])('gives a caller who can read the record the conflict of %s before its validators and hooks', async (_label, source, typeName, id, events) => {
    const fixture = buildFixture();
    seedRecords(fixture.adapter);
    const context = READER();
    expect(failure(await fixture.run(source, context))).toEqual(CONFLICT(typeName, id));
    expect(fixture.steps).toEqual([...events, `scope get_by_id ${typeName}`]);
    expect(fixture.finds()).toEqual([[
      { name: typeName }, expect.objectContaining({ name: typeName }), byTenant('A', id), SESSION, { requiredId: id, context },
    ]]);
    expect(fixture.adapter.stored(typeName, id)).toMatchObject({ version: 5 });
    expect(fixture.adapter.stored('Pedido', '1')).toMatchObject({ numero: 'A', state: 'OPEN', version: 5 });
  });

  test('gives a caller who can read the record VERSION_EXHAUSTED before its validators and hooks', async () => {
    const fixture = buildFixture();
    seedRecords(fixture.adapter, { pedido: MAX });
    expect(failure(await fixture.run(`mutation { updatepedido(input: { id: "1", version: ${MAX}, numero: "Z" }) { id } }`, READER())))
      .toEqual(EXHAUSTED('Pedido', 1));
    expect(fixture.steps).toEqual(['middleware update Pedido', 'scope get_by_id Pedido']);
    expect(fixture.adapter.update).not.toHaveBeenCalled();
  });

  test('passes find the session of the operation\'s transaction and the request context, at every call site', async () => {
    for (const source of [
      'mutation { updatepedido(input: { id: "1", version: 4, numero: "Z" }) { id } }',
      'mutation { close_pedido(input: { id: "1", version: 4 }) { id } }',
      'mutation { updatepedido(input: { id: "1", version: 5, items: { updated: [{ id: "11", version: 4 }] } }) { id } }',
      'mutation { updatepedido(input: { id: "1", version: 5, items: { deleted: [{ id: "12", version: 4 }] } }) { id } }',
      'mutation { deleteproducto(id: "1", version: 4) { id } }',
    ]) {
      const fixture = buildFixture();
      seedRecords(fixture.adapter);
      const context = HIDDEN();
      await fixture.run(source, context);
      expect(fixture.finds(), source).toHaveLength(1);
      const [, , , session, options] = fixture.finds()[0];
      const preRead = fixture.adapter.getById.mock.calls.at(-1);
      expect(session, source).toBe(preRead[2]);
      expect(session, source).toEqual(SESSION);
      expect(options.context, source).toBe(context);
    }
  });

  test('reads the record by its stored key, so a spelling of the ID that the adapter accepts does not hide it', async () => {
    for (const [label, readAs] of [
      // As a MongoDB _id setter can, the adapter reads "0001" as the record stored under "1".
      ['an _id setter', (record) => record],
      // A record keyed by `id`, as SQL adapters return it.
      ['an id key', (record) => record && Object.fromEntries(Object.entries(record).map(([field, value]) => [field === '_id' ? 'id' : field, value]))],
    ]) {
      const fixture = buildFixture();
      seedRecords(fixture.adapter);
      const read = fixture.adapter.getById.getMockImplementation();
      fixture.adapter.getById.mockImplementation(async (Model, id, ...rest) => readAs(await read(Model, String(Number(id)), ...rest)));
      const context = READER();
      const result = await fixture.run('mutation { updatepedido(input: { id: "0001", version: 4, numero: "Z" }) { id } }', context);
      expect(failure(result), label).toEqual(CONFLICT('Pedido', '0001'));
      expect(fixture.steps, label).toEqual(['middleware update Pedido', 'scope get_by_id Pedido']);
      expect(fixture.finds().map((call) => call.slice(2)), label).toEqual([[byTenant('A', '1'), SESSION, { requiredId: '1', context }]]);
    }
  });

  test('does not run when the version matches, for a caller who can read the record or one who cannot', async () => {
    for (const context of [READER(), HIDDEN()]) {
      const fixture = buildFixture();
      seedRecords(fixture.adapter);
      for (const source of [
        `mutation { updatepedido(input: { id: "1", version: 5, numero: "Z",
          items: { updated: [{ id: "11", version: 5, nombre: "x" }], deleted: [{ id: "12", version: 5 }] } }) { id } }`,
        'mutation { close_pedido(input: { id: "1", version: 6 }) { id } }',
        'mutation { deleteproducto(id: "1", version: 5) { id } }',
      ]) {
        expect((await fixture.run(source, context)).errors, source).toBeUndefined();
      }
      expect(fixture.steps.filter((step) => step.startsWith('scope'))).toEqual([]);
      expect(fixture.finds()).toEqual([]);
    }
  });

  test('a type without a get_by_id scope gives every caller the conflict early, even one its find scope hides', async () => {
    const fixture = buildFixture({ scopeOperations: ['find'], scope: ({ args }) => { args.tenant = { operator: 'EQ', value: 'nobody' }; } });
    seedRecords(fixture.adapter);
    for (const [source, typeName] of [
      ['mutation { updatepedido(input: { id: "1", version: 4, numero: "Z" }) { id } }', 'Pedido'],
      ['mutation { deleteproducto(id: "1", version: 4) { id } }', 'Producto'],
    ]) {
      expect(failure(await fixture.run(source, HIDDEN()))).toEqual(CONFLICT(typeName, 1));
    }
    expect(fixture.steps).toEqual(['middleware update Pedido', 'middleware delete Producto']);
    expect(fixture.finds()).toEqual([]);
    expect(fixture.adapter.update).not.toHaveBeenCalled();
    expect(fixture.adapter.delete).not.toHaveBeenCalled();
  });
});

// A by-ID read gives find no session and no requiredId; the read on the conflict path runs in the
// operation's transaction and pins the stored key. Everything else is the same.
const expectSameRead = (readCall, conflictCall, key) => {
  const [readModel, readType, readArgs, readSession, readOptions] = readCall;
  const [model, type, args, session, options] = conflictCall;
  expect(model).toBe(readModel);
  expect(type).toBe(readType);
  expect(args).toStrictEqual(readArgs);
  expect(readSession).toBeNull();
  expect(session).toEqual(SESSION);
  expect(readOptions).toStrictEqual({ requiredId: undefined, context: readOptions.context });
  expect(options).toStrictEqual({ requiredId: key, context: readOptions.context });
  expect(options.context).toBe(readOptions.context);
};

describe('the read on the conflict path matches the <entity>(id:) read of the same caller', () => {
  test('with an async get_by_id scope: the same find arguments, and the same visibility', async () => {
    const scope = async ({ args, context }) => {
      await new Promise((resolve) => { setImmediate(resolve); });
      args.tenant = { operator: 'EQ', value: context.tenant };
    };
    for (const [context, visible] of [[READER(), true], [HIDDEN(), false]]) {
      const fixture = buildFixture({ scope });
      seedRecords(fixture.adapter);
      const read = await fixture.run('{ producto(id: "1") { id } }', context);
      expect(read.errors).toBeUndefined();
      expect(read.data.producto).toEqual(visible ? { id: '1' } : null);
      const write = await fixture.run('mutation { deleteproducto(id: "1", version: 4) { id } }', context);
      expect(failure(write)).toEqual(CONFLICT('Producto', 1));
      const [readCall, conflictCall, ...rest] = fixture.finds();
      expect(rest).toEqual([]);
      expect(readCall[2]).toEqual(byTenant(context.tenant, '1'));
      expectSameRead(readCall, conflictCall, '1');
      // A caller who can read the record gets the conflict before onDelete; one who cannot, at the write.
      expect(fixture.steps).toEqual([
        'middleware get_by_id Producto', 'scope get_by_id Producto', 'middleware delete Producto', 'scope get_by_id Producto',
        ...(visible ? [] : ['Producto.onDelete']),
      ]);
      expect(fixture.adapter.delete).toHaveBeenCalledTimes(visible ? 0 : 1);
    }
  });

  test('with a get_by_id scope that adds a trusted emptiness condition on a reference: the same find arguments, and the same visibility', async () => {
    for (const [id, visible] of [['30', true], ['11', false]]) {
      const fixture = buildFixture({
        queryFeatures: DECLARED,
        scope: ({ args }, typeName) => {
          if (typeName === 'Item') args.pedido = { terms: [{ operator: 'IS_EMPTY' }] };
        },
      });
      seedRecords(fixture.adapter);
      fixture.adapter.seed('Item', {
        _id: '30', tenant: 'A', nombre: 'c', version: 5,
      });
      // The memory adapter compiles EQ conditions only; here its find also evaluates the scope's
      // condition, an Item without pedido, so that results can be compared too.
      const find = fixture.adapter.find.getMockImplementation();
      fixture.adapter.find.mockImplementation(async (Model, gqltype, { pedido, ...args }, session, options) => {
        expect(pedido).toEqual({ terms: [{ operator: 'IS_EMPTY' }] });
        return (await find(Model, gqltype, args, session, options)).filter((record) => record.pedido == null);
      });
      const context = READER();
      const read = await fixture.run(`{ item(id: "${id}") { id } }`, context);
      expect(read.errors).toBeUndefined();
      expect(read.data.item).toEqual(visible ? { id } : null);
      const write = await fixture.run(`mutation { deleteitem(id: "${id}", version: 4) { id } }`, context);
      expect(failure(write)).toEqual(CONFLICT('Item', id));
      const [readCall, conflictCall, ...rest] = fixture.finds();
      expect(rest).toEqual([]);
      expect(readCall[2]).toEqual({ id: { operator: 'EQ', value: id }, pedido: { terms: [{ operator: 'IS_EMPTY' }] } });
      expectSameRead(readCall, conflictCall, id);
      expect(fixture.steps).toEqual([
        'middleware get_by_id Item', 'scope get_by_id Item', 'middleware delete Item', 'scope get_by_id Item',
        ...(visible ? [] : ['Item.onDelete']),
      ]);
    }
  });
});

describe('pin: by-ID reads', () => {
  test('pin: an <entity>(id:) read and a reference read run get_by_id middleware, then the scope, then find without a session', async () => {
    const fixture = buildFixture();
    seedRecords(fixture.adapter);
    const context = READER();
    const result = await fixture.run('{ item(id: "11") { id pedido { id } } }', context);
    expect(result.errors).toBeUndefined();
    expect(result.data.item).toEqual({ id: '11', pedido: { id: '1' } });
    expect(fixture.trace).toEqual([['middleware get_by_id Item', { id: '11' }], ['middleware get_by_id Pedido', { id: '1' }]]);
    expect(fixture.steps).toEqual([
      'middleware get_by_id Item', 'scope get_by_id Item', 'middleware get_by_id Pedido', 'scope get_by_id Pedido',
    ]);
    const calls = fixture.finds();
    expect(calls.map((call) => call.length)).toEqual([5, 5]);
    expect(calls).toEqual([
      [{ name: 'Item' }, expect.objectContaining({ name: 'Item' }), byTenant('A', '11'), null, { requiredId: undefined, context }],
      [{ name: 'Pedido' }, expect.objectContaining({ name: 'Pedido' }), byTenant('A', '1'), null, { requiredId: '1', context }],
    ]);
    expect(Object.keys(calls[0][4])).toEqual(['requiredId', 'context']);
    expect(calls[0][4].context).toBe(context);
    expect((await fixture.run('{ item(id: "11") { id } }', HIDDEN())).data.item).toBeNull();
    expect(fixture.adapter.getById).not.toHaveBeenCalled();
  });
});

describe('protected visibility closing regressions', () => {
  test.each(['updated', 'deleted'])('foreign corrupt %s child fails ownership before normalization and rolls back prior writes', async (operation) => {
    const fixture = buildFixture();
    seedRecords(fixture.adapter);
    fixture.adapter.seed('Item', { _id: '21', pedido: '2', tenant: 'A', version: 'bad' });
    const before = structuredClone([...fixture.adapter.records]);
    const prior = '{ id: "11", version: 5 }';
    const foreign = '{ id: "21", version: 1 }';
    const entries = operation === 'updated' ? `updated: [${prior}, ${foreign}]` : `updated: [${prior}], deleted: [${foreign}]`;
    const result = await fixture.run(`mutation { updatepedido(input: { id: "1", version: 5,
      numero: "changed", items: { ${entries} } }) { id } }`, HIDDEN());
    expect(failure(result)).toEqual({ code: 'FORBIDDEN', status: 403, message: 'Child does not belong to this parent' });
    expect(fixture.steps).toEqual([
      'middleware update Pedido', 'Pedido validator', 'Pedido.onUpdating',
      'middleware update Item', 'Item validator', 'Item.onUpdating', 'Item.onUpdated',
      `middleware ${operation === 'updated' ? 'update' : 'delete'} Item`,
    ]);
    expect(fixture.finds()).toHaveLength(0);
    expect(fixture.adapter.getById.mock.calls.map(([Model, id, , options]) => [Model.name, id, options])).toEqual([
      ['Pedido', '1', { plain: true, lock: true }],
      ['Item', '11', { plain: true, lock: true }],
      ['Item', '21', { plain: true, lock: true }],
    ]);
    expect(fixture.updates().map(({ type, id }) => [type, id])).toEqual([['Pedido', '1'], ['Item', '11']]);
    expect(fixture.deletes()).toEqual([]);
    expect([...fixture.adapter.records]).toEqual(before);
  });

  test.each(['updated', 'deleted'])('an owned corrupt %s child still fails before its hooks', async (operation) => {
    const fixture = buildFixture();
    seedRecords(fixture.adapter, { item11: 'bad' });
    const before = structuredClone([...fixture.adapter.records]);
    const result = await fixture.run(`mutation { updatepedido(input: { id: "1", version: 5,
      items: { ${operation}: [{ id: "11", version: 1 }] } }) { id } }`, HIDDEN());
    expect(failure(result)).toEqual({ code: 'DATABASE_ERROR', status: 500, message: 'Item 11 stores an invalid version' });
    expect(fixture.steps).not.toContain('Item validator');
    expect(fixture.steps).not.toContain('Item.onDelete');
    expect(fixture.finds()).toHaveLength(0);
    expect([...fixture.adapter.records]).toEqual(before);
  });

  test.each([
    ['top-level', 'Pedido', '1', 'Pedido validator', 'mutation { updatepedido(input: { id: "1", version: 3, numero: "changed" }) { id } }'],
    ['state action', 'Pedido', '1', 'close action', 'mutation { close_pedido(input: { id: "1", version: 3 }) { id } }'],
    ['nested', 'Item', '11', 'Item validator', 'mutation { updatepedido(input: { id: "1", version: 4, numero: "changed", items: { updated: [{ id: "12", version: 5, nombre: "prior" }, { id: "11", version: 3, nombre: "changed" }] } }) { id } }'],
  ])('%s update detects a dropped precondition using an immutable observed version', async (_label, typeName, id, mutateAt, source) => {
    for (const mutateRecord of [false, true]) {
      const fixture = buildFixture();
      seedRecords(fixture.adapter, { pedido: 4, item11: 4 });
      const before = structuredClone([...fixture.adapter.records]);
      let observed;
      const read = fixture.adapter.getById.getMockImplementation();
      fixture.adapter.getById.mockImplementation(async (Model, key, ...rest) => {
        const record = await read(Model, key, ...rest);
        if (Model.name === typeName && key === id) observed = record;
        return record;
      });
      if (mutateRecord) fixture.hooks[mutateAt] = (args) => {
        if (args.id === id) observed.version = 2;
      };
      const update = fixture.adapter.update.getMockImplementation();
      // Only the target's four-argument wrapper drops options; parent/prior sibling writes conform.
      const dropsOptions = (Model, key, changes, session) => update(Model, key, changes, session);
      fixture.adapter.update.mockImplementation((Model, key, changes, session, options) => (
        Model.name === typeName && key === id
          ? dropsOptions(Model, key, changes, session) : update(Model, key, changes, session, options)
      ));
      const result = await fixture.run(source, HIDDEN());
      expect(failure(result)).toEqual({
        code: 'DATABASE_ERROR', status: 500, message: `${typeName} ${id} was written without advancing its version`,
      });
      expect(fixture.steps).toContain(mutateAt);
      expect(fixture.trace.filter(([step, payload]) => step === `${typeName}.onUpdating` && payload.id === id)).toHaveLength(1);
      expect(fixture.trace.filter(([step]) => step === `${typeName}.onUpdated`)).toHaveLength(typeName === 'Item' ? 1 : 0);
      expect(fixture.finds()).toHaveLength(1);
      expect(fixture.adapter.getById.mock.calls.filter(([Model, key]) => Model.name === typeName && key === id)).toHaveLength(1);
      expect([...fixture.adapter.records]).toEqual(before);
    }
  });

  test('a conforming same-session hook can advance a lower observed version to the submitted version', async () => {
    const fixture = buildFixture();
    seedRecords(fixture.adapter, { pedido: 3 });
    let session;
    const read = fixture.adapter.getById.getMockImplementation();
    fixture.adapter.getById.mockImplementation(async (Model, id, currentSession, options) => {
      session = currentSession;
      return read(Model, id, currentSession, options);
    });
    fixture.hooks['Pedido.onUpdating'] = async () => {
      await fixture.adapter.update({ name: 'Pedido' }, '1', { numero: 'intermediate' }, session, { expectedVersion: 3 });
    };
    const result = await fixture.run('mutation { updatepedido(input: { id: "1", version: 4, numero: "final" }) { version } }', HIDDEN());
    expect(result.errors).toBeUndefined();
    expect(result.data.updatepedido).toEqual({ version: 5 });
    expect(fixture.updates().map(({ options }) => options)).toEqual([{ expectedVersion: 3 }, { expectedVersion: 4 }]);
    expect(fixture.adapter.update.mock.calls.every((call) => call[3] === session)).toBe(true);
    expect(fixture.adapter.getById).toHaveBeenCalledTimes(1);
    expect(fixture.adapter.stored('Pedido', '1')).toMatchObject({ numero: 'final', version: 5 });
  });

  test('hidden stale, current and exhausted versions get the same embedded REQUIRED_VALUE before hooks or writes', async () => {
    for (const [label, sent, stored] of UPDATE_VERSIONS) {
      const fixture = buildFixture({ requiredEmbeddedList: true });
      seedRecords(fixture.adapter, { pedido: stored });
      // Update inputs allow an omitted required embedded member; the completed list must reject it.
      const result = await fixture.run(`mutation { updatepedido(input: { id: "1", version: ${sent},
        addresses: [{ city: "new" }] }) { id } }`, HIDDEN());
      expect(failure(result), label).toEqual({ code: 'REQUIRED_VALUE', status: 400, message: 'Required value street is missing' });
      expect(fixture.steps).toContain('Pedido validator');
      expect(fixture.steps).not.toContain('Pedido.onUpdating');
      expect(fixture.adapter.update).not.toHaveBeenCalled();
      expect(fixture.adapter.getById).toHaveBeenCalledTimes(1);
      expect(fixture.finds()).toHaveLength(label === 'current' ? 0 : 1);
      expect(fixture.adapter.stored('Pedido', '1')).toMatchObject({ numero: 'A', version: stored });
    }
  });
});
