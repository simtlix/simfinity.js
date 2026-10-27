// The generated transaction field (#151) in a served copy of a schema whose Mutation type was rebuilt. An
// operation runs only where the Mutation type that runs the transaction exposes the operation's generated
// root: a field whose marker is the root's, or a copy of it, under any name. Otherwise the operation fails
// with FORBIDDEN, naming it, before the transaction opens, as a direct call cannot reach a root the schema
// does not expose. Where it runs, it gets the checks of every field that exposes the root there and of the
// root the field was built with. Real graphql() execution, the official auth plugin and the in-memory
// adapter.
import { describe, expect, test, vi } from 'vitest';
import {
  GraphQLDirective, GraphQLEnumType, GraphQLID, GraphQLInputObjectType, GraphQLInterfaceType, GraphQLList, GraphQLNonNull,
  GraphQLObjectType, GraphQLScalarType, GraphQLSchema, GraphQLString, GraphQLUnionType, getNamedType, graphql, isEnumType,
  isInputObjectType, isInterfaceType, isListType, isNonNullType, isObjectType, isSpecifiedDirective, isSpecifiedScalarType,
  isUnionType,
} from 'graphql';
import { createRuntime } from '@simtlix/simfinity-core';
import { allow, createAuthPlugin, requireRole } from '@simtlix/simfinity-core/auth';
import { createOptimisticMemoryAdapter } from './helpers/optimistic-memory-adapter.js';

const FORBIDDEN = (key) => ({ code: 'FORBIDDEN', status: 403, message: `Access denied to ${key}` });
// Under DENY, the output fields a transaction selects need rules too.
const OUTPUTS = { TransactionResult: { '*': allow() }, Producto: { '*': allow() }, Pedido: { '*': allow() } };
const DELETE_STORED = [{ deleteproducto: { id: '1' } }];
const STORED = ['Pedido:1', 'Producto:1'];
const refuse = () => false;

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

// Unprotected Producto, and Pedido with a state machine whose close action is a generated root. The
// transaction field covers both types. Producto 1 and the open Pedido 1 are stored.
const build = () => {
  const adapter = createOptimisticMemoryAdapter();
  vi.spyOn(adapter, 'withTransaction');
  const runtime = createRuntime(adapter);
  const State = new GraphQLEnumType({ name: 'TxState', values: { OPEN: { value: 'OPEN' }, CLOSED: { value: 'CLOSED' } } });
  const Producto = new GraphQLObjectType({
    name: 'Producto', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } },
  });
  const Pedido = new GraphQLObjectType({
    name: 'Pedido', fields: { id: { type: GraphQLID }, numero: { type: GraphQLString }, state: { type: State } },
  });
  runtime.connect(null, Producto, 'producto', 'productos');
  runtime.connect(null, Pedido, 'pedido', 'pedidos', null, null, {
    initialState: { name: 'OPEN', value: 'OPEN' },
    actions: {
      close: {
        from: { name: 'OPEN', value: 'OPEN' }, to: { name: 'CLOSED', value: 'CLOSED' }, action: async () => {},
      },
    },
  });
  const schema = runtime.createSchema(null, null, null, { transaction: { types: [Producto, Pedido] } });
  adapter.seed('Producto', { _id: '1', name: 'kept' });
  adapter.seed('Pedido', { _id: '1', numero: 'P', state: 'OPEN' });
  const run = (target, source, contextValue = {}) => graphql({ schema: target, source, contextValue });
  const transaction = (target, operationList, contextValue = {}) => graphql({
    schema: target,
    source: 'mutation Run($operations: [TransactionOperation!]!) { transaction(operations: $operations) { id } }',
    variableValues: { operations: operationList },
    contextValue,
  });
  const storedKeys = () => [...adapter.records.keys()].sort();
  return {
    adapter, schema, run, transaction, storedKeys,
  };
};

const protect = (schema, permissions, defaultPolicy) => {
  const plugin = createAuthPlugin(permissions, { defaultPolicy });
  plugin.onSchemaChange({ schema });
  return plugin;
};

// The schema with its Mutation type rebuilt from `change(config)`, sharing every other type.
const withMutation = (schema, change) => {
  const config = schema.toConfig();
  return new GraphQLSchema({
    ...config,
    mutation: new GraphQLObjectType(change(schema.getMutationType().toConfig())),
    types: config.types.filter((type) => type !== schema.getMutationType()),
  });
};
const without = (fields, name) => Object.fromEntries(Object.entries(fields).filter(([key]) => key !== name));
const withoutRoot = (schema) => withMutation(schema, (config) => ({ ...config, fields: without(config.fields, 'deleteproducto') }));

describe('an operation whose root the executing Mutation type does not expose', () => {
  test('a copy without the root refuses it before the transaction, also where only that copy was processed under DENY', async () => {
    const fixture = build();
    const copy = withoutRoot(fixture.schema);
    protect(copy, { Mutation: { transaction: allow(), addproducto: allow() }, ...OUTPUTS }, 'DENY');

    const direct = await fixture.run(copy, 'mutation { deleteproducto(id: "1") { id } }');
    expect(direct.errors[0].message).toContain('Cannot query field "deleteproducto"');
    const result = await fixture.transaction(copy, [{ addproducto: { name: 'a' } }, { deleteproducto: { id: '1' } }]);
    expect(failure(result)).toEqual(FORBIDDEN('Mutation.deleteproducto'));
    expect(positionOf(result)).toEqual({ operationIndex: 1, operation: 'deleteproducto' });
    expect(fixture.adapter.withTransaction).not.toHaveBeenCalled();
    expect(fixture.adapter.delete).not.toHaveBeenCalled();
    expect(fixture.storedKeys()).toEqual(STORED);
    // The roots the copy exposes still run through it.
    expect((await fixture.transaction(copy, [{ addproducto: { name: 'b' } }])).errors).toBeUndefined();
    expect(fixture.storedKeys()).toEqual([...STORED, 'Producto:1000']);
  });

  test.each(['DENY', 'ALLOW'])('a copy that replaces the root with an unmarked field refuses it under %s, as the rule on that field refuses a direct call', async (policy) => {
    const fixture = build();
    const softDelete = vi.fn(() => null);
    const copy = withMutation(fixture.schema, (config) => ({
      ...config,
      fields: {
        ...config.fields,
        deleteproducto: {
          type: config.fields.deleteproducto.type, args: { id: { type: new GraphQLNonNull(GraphQLID) } }, resolve: softDelete,
        },
      },
    }));
    protect(copy, { Mutation: { transaction: allow(), addproducto: allow(), deleteproducto: refuse }, ...OUTPUTS }, policy);

    expect(failure(await fixture.run(copy, 'mutation { deleteproducto(id: "1") { id } }')))
      .toEqual(FORBIDDEN('Mutation.deleteproducto'));
    const result = await fixture.transaction(copy, DELETE_STORED);
    expect(failure(result)).toEqual(FORBIDDEN('Mutation.deleteproducto'));
    expect(positionOf(result)).toEqual({ operationIndex: 0, operation: 'deleteproducto' });
    expect(softDelete).not.toHaveBeenCalled();
    expect(fixture.adapter.withTransaction).not.toHaveBeenCalled();
    expect(fixture.adapter.delete).not.toHaveBeenCalled();
    expect(fixture.storedKeys()).toEqual(STORED);
  });

  test('a public copy without the root never runs it, although the admin instance that protects the original defers there', async () => {
    const fixture = build();
    protect(fixture.schema, { Mutation: { '*': requireRole('admin') }, ...OUTPUTS }, 'DENY');
    const publicCopy = withoutRoot(fixture.schema);
    protect(publicCopy, { Mutation: { transaction: allow(), addproducto: allow() }, ...OUTPUTS }, 'DENY');
    const visitor = { user: { id: 'visitor' } };

    expect(failure(await fixture.transaction(fixture.schema, DELETE_STORED, visitor)))
      .toEqual({ code: 'FORBIDDEN', status: 403, message: 'Requires role: admin' });
    const result = await fixture.transaction(publicCopy, DELETE_STORED, visitor);
    expect(failure(result)).toEqual(FORBIDDEN('Mutation.deleteproducto'));
    expect(positionOf(result)).toEqual({ operationIndex: 0, operation: 'deleteproducto' });
    expect(fixture.adapter.withTransaction).not.toHaveBeenCalled();
    expect(fixture.storedKeys()).toEqual(STORED);

    // The original still runs it for an admin.
    const admin = { user: { id: 'admin', role: 'admin' } };
    expect((await fixture.transaction(fixture.schema, DELETE_STORED, admin)).errors).toBeUndefined();
    expect(fixture.storedKeys()).toEqual(['Pedido:1']);
  });

  test.each([
    ['another type', 'deleteproducto', 'deletepedido', DELETE_STORED],
    ['another operation of the same type', 'updateproducto', 'addproducto', [{ updateproducto: { id: '1', name: 'changed' } }]],
  ])('a copy whose field of the operation name holds the generated root of %s refuses the operation', async (_label, key, other, operationList) => {
    const fixture = build();
    const swapped = withMutation(fixture.schema, (config) => ({ ...config, fields: { ...config.fields, [key]: config.fields[other] } }));

    const result = await fixture.transaction(swapped, operationList);
    expect(failure(result)).toEqual(FORBIDDEN(`Mutation.${key}`));
    expect(positionOf(result)).toEqual({ operationIndex: 0, operation: key });
    expect(fixture.adapter.withTransaction).not.toHaveBeenCalled();
    expect(fixture.storedKeys()).toEqual(STORED);
    expect(fixture.adapter.stored('Producto', '1')).toEqual({ _id: '1', name: 'kept' });
  });
});

describe('an operation whose root the executing Mutation type exposes under another name', () => {
  // The root exposed only as removeproducto.
  const renamedRoot = (schema) => withMutation(schema, (config) => ({
    ...config, fields: { ...without(config.fields, 'deleteproducto'), removeproducto: config.fields.deleteproducto },
  }));

  test('a copy that exposes the root only under a new name runs the rules of that name: a rule that denies it denies the operation', async () => {
    const fixture = build();
    const renamed = renamedRoot(fixture.schema);
    protect(renamed, { Mutation: { transaction: allow(), removeproducto: refuse }, ...OUTPUTS }, 'DENY');

    expect(failure(await fixture.run(renamed, 'mutation { removeproducto(id: "1") { id } }')))
      .toEqual(FORBIDDEN('Mutation.removeproducto'));
    const result = await fixture.transaction(renamed, DELETE_STORED);
    expect(failure(result)).toEqual(FORBIDDEN('Mutation.removeproducto'));
    expect(positionOf(result)).toEqual({ operationIndex: 0, operation: 'deleteproducto' });
    expect(fixture.adapter.delete).not.toHaveBeenCalled();
    expect(fixture.storedKeys()).toEqual(STORED);
  });

  test('a rule that allows the new name allows the operation, and sees the operation key with the type of the field that exposes it', async () => {
    const fixture = build();
    const renamed = renamedRoot(fixture.schema);
    const rule = vi.fn(() => true);
    protect(renamed, { Mutation: { transaction: allow(), removeproducto: rule }, ...OUTPUTS }, 'DENY');

    const result = await fixture.transaction(renamed, DELETE_STORED);
    expect(result.errors).toBeUndefined();
    expect(fixture.storedKeys()).toEqual(['Pedido:1']);
    expect(rule).toHaveBeenCalledTimes(1);
    const [, args, , info] = rule.mock.calls[0];
    expect(args).toEqual({ id: '1' });
    expect(info.fieldName).toBe('deleteproducto');
    expect(info.parentType).toBe(renamed.getMutationType());
    expect(info.returnType).toBe(renamed.getMutationType().getFields().removeproducto.type);
  });

  describe('a copy that keeps the root next to an alias', () => {
    const aliased = (schema) => withMutation(schema, (config) => ({
      ...config, fields: { ...config.fields, removeproducto: config.fields.deleteproducto },
    }));

    test.each([
      ['the original', { deleteproducto: refuse, removeproducto: allow() }, 'Mutation.deleteproducto'],
      ['the alias', { deleteproducto: allow(), removeproducto: refuse }, 'Mutation.removeproducto'],
    ])('runs the rules of both names: a rule that denies %s denies the operation', async (_label, rules, deniedKey) => {
      const fixture = build();
      const copy = aliased(fixture.schema);
      protect(copy, { Mutation: { transaction: allow(), ...rules }, ...OUTPUTS }, 'DENY');

      const result = await fixture.transaction(copy, DELETE_STORED);
      expect(failure(result)).toEqual(FORBIDDEN(deniedKey));
      expect(positionOf(result)).toEqual({ operationIndex: 0, operation: 'deleteproducto' });
      expect(fixture.storedKeys()).toEqual(STORED);
    });

    test('runs the operation when the rules of both names allow it, each once', async () => {
      const fixture = build();
      const copy = aliased(fixture.schema);
      const original = vi.fn(() => true);
      const alias = vi.fn(() => true);
      protect(copy, { Mutation: { transaction: allow(), deleteproducto: original, removeproducto: alias }, ...OUTPUTS }, 'DENY');

      expect((await fixture.transaction(copy, DELETE_STORED)).errors).toBeUndefined();
      expect(fixture.storedKeys()).toEqual(['Pedido:1']);
      expect(original).toHaveBeenCalledTimes(1);
      expect(alias).toHaveBeenCalledTimes(1);
    });
  });
});

describe('controls', () => {
  // An add, an update and an action of a new Pedido, and a delete of the stored Producto.
  const OPERATIONS = [
    { addpedido: { numero: 'A' } }, { updatepedido: { id: '$0', numero: 'B' } }, { close_pedido: { id: '$0' } },
    { deleteproducto: { id: '1' } },
  ];
  const RULES = {
    transaction: allow(), addpedido: allow(), updatepedido: allow(), close_pedido: allow(), deleteproducto: allow(),
  };
  const renamedType = (schema) => withMutation(schema, (config) => ({ ...config, name: 'RootMutation' }));

  test.each([
    ['the schema the field was built in, without a plugin', (schema) => schema, null],
    ['that schema, under a DENY instance with a rule for each root', (schema) => schema, { Mutation: RULES, ...OUTPUTS }],
    ['a toConfig() copy, under a DENY instance that processed the copy', (schema) => new GraphQLSchema(schema.toConfig()), { Mutation: RULES, ...OUTPUTS }],
    ['a copy whose Mutation type is renamed, under rules for that name', renamedType, { RootMutation: RULES, ...OUTPUTS }],
  ])('%s runs an add, an update, an action and a delete', async (_label, serve, permissions) => {
    const fixture = build();
    const served = serve(fixture.schema);
    if (permissions !== null) protect(served, permissions, 'DENY');

    const result = await fixture.transaction(served, OPERATIONS);
    expect(result.errors).toBeUndefined();
    expect(result.data.transaction).toEqual([{ id: '1000' }, { id: '1000' }, { id: '1000' }, { id: '1' }]);
    expect(fixture.storedKeys()).toEqual(['Pedido:1', 'Pedido:1000']);
    expect(fixture.adapter.stored('Pedido', '1000')).toMatchObject({ numero: 'B', state: 'CLOSED' });
  });

  test('a toConfig() copy served unprocessed keeps the checks of the instance that processed the original', async () => {
    const fixture = build();
    protect(fixture.schema, { Mutation: { ...RULES, close_pedido: refuse }, ...OUTPUTS }, 'DENY');
    const copy = new GraphQLSchema(fixture.schema.toConfig());

    const result = await fixture.transaction(copy, OPERATIONS);
    expect(failure(result)).toEqual(FORBIDDEN('Mutation.close_pedido'));
    expect(positionOf(result)).toEqual({ operationIndex: 2, operation: 'close_pedido' });
    expect(fixture.storedKeys()).toEqual(STORED);
  });

  test('a copy whose Mutation type is renamed reports a denial under that name', async () => {
    const fixture = build();
    const renamed = renamedType(fixture.schema);
    protect(renamed, { RootMutation: { ...RULES, deleteproducto: refuse }, ...OUTPUTS }, 'DENY');

    const result = await fixture.transaction(renamed, OPERATIONS);
    expect(failure(result)).toEqual(FORBIDDEN('RootMutation.deleteproducto'));
    expect(positionOf(result)).toEqual({ operationIndex: 3, operation: 'deleteproducto' });
    expect(fixture.storedKeys()).toEqual(STORED);
  });
});

// A copy of the schema in which every named type is a new object built from its config, so that a plugin
// applied to the copy wraps none of the original's fields. `rename` maps a type name to the copy's name for
// it, and `omit` a type name to the fields the copy leaves out. Resolvers and markers are shared.
const rebuilt = (schema, { rename = {}, omit = {} } = {}) => {
  const copies = new Map();
  const ref = (type) => {
    if (isNonNullType(type)) return new GraphQLNonNull(ref(type.ofType));
    if (isListType(type)) return new GraphQLList(ref(type.ofType));
    return copies.get(type.name);
  };
  const argsOf = (config) => Object.fromEntries(Object.entries(config).map(([name, arg]) => [name, { ...arg, type: ref(arg.type) }]));
  const fieldsOf = (typeName, config, withArgs) => () => Object.fromEntries(Object.entries(config)
    .filter(([fieldName]) => !(omit[typeName] ?? []).includes(fieldName))
    .map(([fieldName, field]) => [fieldName, { ...field, type: ref(field.type), ...(withArgs ? { args: argsOf(field.args) } : {}) }]));
  // The introspection types and the types they reach, such as core's field metadata types, stay shared.
  const shared = new Set();
  const share = (type) => {
    const named = getNamedType(type);
    if (shared.has(named.name)) return;
    shared.add(named.name);
    if (isObjectType(named) || isInterfaceType(named)) {
      for (const field of Object.values(named.getFields())) {
        share(field.type);
        for (const arg of field.args) share(arg.type);
      }
    }
  };
  for (const type of Object.values(schema.getTypeMap())) if (type.name.startsWith('__')) share(type);
  for (const type of Object.values(schema.getTypeMap())) {
    if (shared.has(type.name) || isSpecifiedScalarType(type)) {
      copies.set(type.name, type);
      continue;
    }
    const config = { ...type.toConfig(), name: rename[type.name] ?? type.name };
    let copy;
    if (isObjectType(type) || isInterfaceType(type)) {
      const Type = isObjectType(type) ? GraphQLObjectType : GraphQLInterfaceType;
      copy = new Type({ ...config, interfaces: () => config.interfaces.map(ref), fields: fieldsOf(type.name, config.fields, true) });
    } else if (isUnionType(type)) {
      copy = new GraphQLUnionType({ ...config, types: () => config.types.map(ref) });
    } else if (isInputObjectType(type)) {
      copy = new GraphQLInputObjectType({ ...config, fields: fieldsOf(type.name, config.fields, false) });
    } else {
      copy = isEnumType(type) ? new GraphQLEnumType(config) : new GraphQLScalarType(config);
    }
    copies.set(type.name, copy);
  }
  const root = (type) => (type ? copies.get(type.name) : undefined);
  return new GraphQLSchema({
    query: root(schema.getQueryType()),
    mutation: root(schema.getMutationType()),
    subscription: root(schema.getSubscriptionType()),
    types: [...copies.values()],
    directives: schema.getDirectives().map((directive) => (isSpecifiedDirective(directive)
      ? directive
      : new GraphQLDirective({ ...directive.toConfig(), args: argsOf(directive.toConfig().args) }))),
  });
};

describe('the id of a result in a copy whose types are new objects', () => {
  const ADD = [{ addproducto: { name: 'a' } }];
  const USER = { user: { role: 'user' } };
  const ADMIN = { user: { role: 'admin' } };
  const REQUIRES_ADMIN = { code: 'FORBIDDEN', status: 403, message: 'Requires role: admin' };

  // The id of the single result of an add, for a non-admin and then for an admin: `{ id, error }`.
  const idsOf = async (fixture, served) => {
    const read = (result) => ({
      id: result.data?.transaction?.[0]?.id ?? null,
      error: result.errors === undefined ? undefined : { ...failure(result), path: result.errors[0].path },
    });
    return { user: read(await fixture.transaction(served, ADD, USER)), admin: read(await fixture.transaction(served, ADD, ADMIN)) };
  };
  const deniedAt = (error) => ({ ...error, path: ['transaction', 0, 'id'] });

  test.each([
    ['the schema the field was built in', (schema) => schema],
    ['an unmodified copy', (schema) => rebuilt(schema)],
  ])('%s, processed under Producto.id restricted to admins, gives the id to an admin only', async (_label, serve) => {
    const fixture = build();
    const served = serve(fixture.schema);
    protect(served, { Producto: { id: requireRole('admin') } }, 'ALLOW');

    expect(await idsOf(fixture, served)).toEqual({
      user: { id: null, error: deniedAt(REQUIRES_ADMIN) }, admin: { id: '1001', error: undefined },
    });
    // A denied id is an output error after the commit: both adds were written.
    expect(fixture.storedKeys()).toEqual([...STORED, 'Producto:1000', 'Producto:1001']);
  });

  test('a copy whose result type lacks the operation key resolves the id through the copy\'s type of the record\'s name', async () => {
    const fixture = build();
    const served = rebuilt(fixture.schema, { omit: { TransactionResult: ['addproducto'] } });
    expect(served.getType('TransactionResult').getFields()).not.toHaveProperty('addproducto');
    protect(served, { Producto: { id: requireRole('admin') } }, 'ALLOW');

    expect(await idsOf(fixture, served)).toEqual({
      user: { id: null, error: deniedAt(REQUIRES_ADMIN) }, admin: { id: '1001', error: undefined },
    });
  });

  test('a copy that renames the record type runs the id rule of the new name', async () => {
    const fixture = build();
    const served = rebuilt(fixture.schema, { rename: { Producto: 'Product' } });
    expect(served.getType('Producto')).toBeUndefined();
    expect(served.getType('TransactionResult').getFields().addproducto.type).toBe(served.getType('Product'));
    protect(served, { Product: { id: requireRole('admin') } }, 'ALLOW');

    expect(await idsOf(fixture, served)).toEqual({
      user: { id: null, error: deniedAt(REQUIRES_ADMIN) }, admin: { id: '1001', error: undefined },
    });
  });

  test('a copy with neither the operation key in its result type nor a type of the record\'s name refuses the id', async () => {
    const fixture = build();
    const served = rebuilt(fixture.schema, { rename: { Producto: 'Product' }, omit: { TransactionResult: ['addproducto'] } });
    protect(served, { Product: { id: requireRole('admin') } }, 'ALLOW');

    const refusedId = deniedAt(FORBIDDEN('TransactionResult.id'));
    expect(await idsOf(fixture, served)).toEqual({ user: { id: null, error: refusedId }, admin: { id: null, error: refusedId } });
    // The operations ran: the refusal is an output error after the commit.
    expect(fixture.storedKeys()).toEqual([...STORED, 'Producto:1000', 'Producto:1001']);
  });
});
