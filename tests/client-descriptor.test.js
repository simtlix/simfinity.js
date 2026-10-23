import { describe, expect, test, vi } from 'vitest';
import {
  GraphQLEnumType, GraphQLID, GraphQLInputObjectType, GraphQLList, GraphQLNonNull,
  GraphQLObjectType, GraphQLScalarType, GraphQLSchema, GraphQLString, introspectionFromSchema, printSchema,
} from 'graphql';
import * as core from '../packages/core/src/index.js';

const runtime = () => core.createRuntime({ createModel: (type) => ({ name: type.name }) });
const book = (name = 'Book') => new GraphQLObjectType({ name, fields: {
  id: { type: GraphQLID }, title: { type: new GraphQLNonNull(GraphQLString) },
  preview: { type: GraphQLString, extensions: { virtual: true }, resolve: () => 'preview' },
  secret: { type: GraphQLString, extensions: { queryable: false, readOnly: true, privateHint: 'never copy' } },
} });
const describeSchema = (schema) => core.buildClientDescriptor(schema);

describe('client descriptor', () => {
  test('isolates roots on shared types, snapshots registrations, and distinguishes same-name operations', () => {
    const api = runtime(); const Book = book();
    api.connect(null, Book, 'book', 'books');
    api.registerCustomQuery('same', 'query', null, GraphQLString, () => 'q');
    api.registerMutation('same', 'update', null, GraphQLString, () => 'm');
    api.registerView('recent', { type: Book, description: 'Recent books', where: () => [] });
    const full = api.createSchema();
    const read = api.createSchema([Book], [], [], { includedCustomQueries: [] });
    api.connect(null, book(), 'replacement', 'replacements');
    const a = describeSchema(full); const b = describeSchema(read);
    expect(a.operations.query.same.operation).toBe('customQuery');
    expect(a.operations.mutation.same).toMatchObject({ operation: 'customMutation', description: 'update' });
    expect(a.types.Book.endpoints).toEqual({ get: 'book', list: 'books', aggregate: 'books_aggregate', add: 'addbook', update: 'updatebook', delete: 'deletebook' });
    expect(a.operations.query.recent).toMatchObject({ operation: 'list', view: 'recent' });
    expect(b.roots.mutation).toBeNull();
    expect(b.operations.mutation).toEqual({});
    expect(b.operations.query.same).toBeUndefined();
    expect(b.types.Book.endpoints.add).toBeUndefined();
    expect(b.types.Book.inputs).toBeUndefined();
    expect(describeSchema(full)).toBe(a);
    expect(Object.isFrozen(a.types.Book.fields)).toBe(true);
    const other = runtime(); other.connect(null, book(), 'other', 'others');
    expect(describeSchema(other.createSchema()).types.Book.endpoints.get).toBe('other');
  });

  test('captures virtual/queryable hints without altering schema or auth behavior', () => {
    const api = runtime(); const Book = book(); api.connect(null, Book, 'book', 'books');
    const schema = api.createSchema();
    const sdl = printSchema(schema); const introspection = introspectionFromSchema(schema);
    const extensions = Book.getFields().secret.extensions;
    core.auth.createAuthPlugin({}, { defaultPolicy: 'ALLOW' }).onSchemaChange({ schema });
    const d = describeSchema(schema); const fields = Object.fromEntries(d.types.Book.fields.map((field) => [field.name, field]));
    expect(fields.preview).toMatchObject({ readOnly: true, virtual: { mcp: 'tool' }, queryable: false });
    expect(fields.title).toMatchObject({ type: 'String!', queryable: true, readOnly: false });
    expect(fields.secret).toMatchObject({ readOnly: true, queryable: false });
    expect(JSON.stringify(d)).not.toContain('privateHint');
    expect(d.types.FieldExtensionsType).toBeUndefined();
    expect(schema.getQueryType().getFields().book.extensions.simfinityQuery).toBeUndefined();
    expect(Book.getFields().secret.extensions).toBe(extensions);
    expect(printSchema(schema)).toBe(sdl); expect(introspectionFromSchema(schema)).toEqual(introspection);
  });

  test.each([false, true])('does not classify a custom query using an excluded entity endpoint (entity result: %s)', (entityResult) => {
    const api = runtime(); const Book = book();
    api.connect(null, Book, 'book', 'books');
    api.registerCustomQuery('book', 'Custom result', null, entityResult ? Book : GraphQLString, () => null);
    const descriptor = describeSchema(api.createSchema([], [], []));
    expect(descriptor.operations.query.book).toMatchObject({ operation: 'customQuery', type: null, returns: entityResult ? 'Book' : 'String' });
    if (entityResult) expect(descriptor.types.Book.endpoints).toBeUndefined();
    else expect(descriptor.types.Book).toBeUndefined();
  });

  test('describes the actual root when generated singular names overlap', () => {
    const api = runtime(); const First = book('First'); const Last = book('Last');
    api.connect(null, First, 'item', 'firsts'); api.connect(null, Last, 'item', 'lasts');
    const descriptor = describeSchema(api.createSchema());
    expect(descriptor.operations.query.item).toMatchObject({ operation: 'get', type: 'Last', returns: 'Last' });
    expect(descriptor.types.First.endpoints.get).toBeUndefined();
    expect(descriptor.types.Last.endpoints.get).toBe('item');
  });

  test('describes inverse GraphQL names and contextual collection inputs', () => {
    const api = runtime();
    const Parent = new GraphQLObjectType({ name: 'Parent', fields: () => ({
      id: { type: GraphQLID }, title: { type: GraphQLString },
      children: { type: new GraphQLList(Child), extensions: { relation: { connectionField: 'parent_key' } } },
    }) });
    const Child = new GraphQLObjectType({ name: 'Child', fields: () => ({
      id: { type: GraphQLID }, title: { type: GraphQLString },
      parent: { type: Parent, extensions: { relation: { connectionField: 'parent_key', displayField: 'title' } } },
    }) });
    api.connect(null, Parent, 'parent', 'parents'); api.connect(null, Child, 'child', 'children');
    const d = describeSchema(api.createSchema());
    expect(d.types.Parent.fields.find((f) => f.name === 'children').relation).toMatchObject({ inverseField: 'parent', connectionField: 'parent_key' });
    expect(d.types.Child.fields.find((f) => f.name === 'parent').relation.inverseField).toBe('children');
    expect(d.types.Child.inputs.add).toBe('ChildInput');
    expect(d.types.ChildInput.fields.some((f) => f.name === 'parent')).toBe(true);
    const nested = Object.values(d.types).find((t) => t.kind === 'input' && t.fields?.some((f) => f.name === 'added'));
    const addedType = nested.fields.find((f) => f.name === 'added').type.replace(/[[\]!]/g, '');
    expect(d.types[addedType].fields.some((f) => f.name === 'parent')).toBe(false);
  });

  test('uses external default literals, preserves nested wrappers and tolerates opaque scalars', () => {
    const api = runtime();
    const State = new GraphQLEnumType({ name: 'State', values: { OPEN: { value: 17 }, CLOSED: { value: 42 } } });
    const serialize = vi.fn(() => { throw new Error('opaque'); });
    const Money = new GraphQLScalarType({ name: 'Money', serialize });
    const Input = new GraphQLInputObjectType({ name: 'Args', fields: { state: { type: State, defaultValue: 17 }, money: { type: Money, defaultValue: {} } } });
    api.registerCustomQuery('constructor', 'custom', Input, new GraphQLList(new GraphQLList(Money)), () => []);
    const schema = api.createSchema([], [], []);
    expect(serialize).not.toHaveBeenCalled();
    const d = describeSchema(schema);
    expect(d.operations.query.constructor).toMatchObject({ operation: 'customQuery', returns: '[[Money]]' });
    expect(d.types.Args.fields[0]).toMatchObject({ hasDefault: true, defaultValue: 'OPEN' });
    expect(d.types.Args.fields[1]).toMatchObject({ hasDefault: true });
    expect(d.types.Args.fields[1]).not.toHaveProperty('defaultValue');
    expect(d.types.Money.baseScalar).toBeNull();
    expect(JSON.parse(JSON.stringify(d)).operations.query.constructor.operation).toBe('customQuery');
  });

  test('captures state transitions by enum name and rejects foreign schema ownership', () => {
    const api = runtime();
    const State = new GraphQLEnumType({ name: 'BookState', values: { OPEN: { value: 1 }, CLOSED: { value: 2 } } });
    const Book = new GraphQLObjectType({ name: 'StateBook', fields: { id: { type: GraphQLID }, title: { type: GraphQLString }, state: { type: State } } });
    api.connect(null, Book, 'book', 'books', null, null, { initialState: State.getValue('OPEN'), actions: { close: { from: State.getValue('OPEN'), to: State.getValue('CLOSED') }, activate: { from: State.getValue('CLOSED'), to: State.getValue('OPEN') } } });
    const schema = api.createSchema(); const d = describeSchema(schema);
    expect(d.types.StateBook.stateMachine).toMatchObject({ initialState: 'OPEN', states: ['OPEN', 'CLOSED'], actions: [{ name: 'close', mutation: 'close_book', from: 'OPEN', to: 'CLOSED' }, { name: 'activate', mutation: 'activate_book', from: 'CLOSED', to: 'OPEN' }] });
    expect(d.operations.mutation.close_book).toMatchObject({ operation: 'transition', from: 'OPEN', to: 'CLOSED' });
    expect(() => describeSchema(new GraphQLSchema(schema.toConfig()))).toThrow(/Simfinity schema/);
  });
});

test('serializes a shared argument default once for operation and root-field metadata', () => {
  const api = runtime();
  const serialize = vi.fn((value) => value);
  const Scalar = new GraphQLScalarType({ name: 'Hint', serialize });
  const Book = book(); api.connect(null, Book, 'book', 'books');
  api.registerView('hinted', { type: Book, description: 'Hinted', params: { hint: { type: Scalar, defaultValue: 'x' } }, where: () => [] });
  const schema = api.createSchema();
  expect(serialize).not.toHaveBeenCalled();
  const d = describeSchema(schema);
  expect(serialize).toHaveBeenCalledTimes(1);
  expect(d.operations.query.hinted.args[0].defaultValue).toBe('"x"');
});
