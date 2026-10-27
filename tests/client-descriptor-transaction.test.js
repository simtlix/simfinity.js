import { describe, expect, test } from 'vitest';
import {
  GraphQLID, GraphQLInputObjectType, GraphQLObjectType, GraphQLSchema, GraphQLString,
} from 'graphql';
import { createRuntime } from '../packages/core/src/index.js';
import { buildClientDescriptor } from '../packages/descriptor/src/index.js';
import { createMongoAdapter } from '../packages/mongodb/src/index.js';
import { createPostgres } from '../packages/postgres/src/index.js';

const fixture = (runtime = createRuntime({
  createModel: (type) => ({ name: type.name }),
  assertTransactionModels() {},
})) => {
  const Book = new GraphQLObjectType({
    name: 'TransactionBook',
    fields: { id: { type: GraphQLID }, title: { type: GraphQLString } },
  });
  runtime.connect(null, Book, 'book', 'books');
  return { runtime, Book };
};

describe('client descriptor transactions', () => {
  test.each([
    ['mongodb', () => createRuntime(createMongoAdapter())],
    ['postgres', () => createPostgres({ pool: {
      connect() { throw new Error('The descriptor must not access a database'); },
      query() { throw new Error('The descriptor must not query a database'); },
    } })],
  ])('describes a generated transaction with the %s adapter', (_engine, create) => {
    const { runtime, Book } = fixture(create());
    runtime.preventCreatingCollection(true);
    const schema = runtime.createSchema(null, null, null, { transaction: { types: [Book] } });
    expect(buildClientDescriptor(schema).operations.mutation.transaction).toMatchObject({
      operation: 'transaction',
      type: null,
      args: [{ name: 'operations', type: '[TransactionOperation!]!', hasDefault: false }],
      returns: '[TransactionResult!]',
    });
  });

  test.each(['transaction', 'saveBooks'])('classifies the generated %s root and describes its actual input and result', (name) => {
    const { runtime, Book } = fixture();
    const schema = runtime.createSchema(null, null, null, { transaction: { name, types: [Book] } });
    const descriptor = buildClientDescriptor(schema);
    const prefix = name === 'transaction' ? 'Transaction' : 'SaveBooks';

    expect(descriptor.operations.mutation[name]).toMatchObject({
      operation: 'transaction',
      type: null,
      args: [{ name: 'operations', type: `[${prefix}Operation!]!`, hasDefault: false }],
      returns: `[${prefix}Result!]`,
    });
    expect(descriptor.types[`${prefix}Operation`]).toMatchObject({ kind: 'input', isOneOf: true });
    expect(Object.isFrozen(descriptor.types[`${prefix}Operation`])).toBe(true);
    expect(descriptor.types.TransactionBookInput).not.toHaveProperty('isOneOf');
    expect(descriptor.types[`${prefix}DeleteInput`]).not.toHaveProperty('isOneOf');
    expect(Object.fromEntries(descriptor.types[`${prefix}Operation`].fields.map((field) => [field.name, field.type]))).toEqual({
      addbook: 'TransactionBookInput',
      updatebook: 'TransactionBookInputForUpdate',
      deletebook: `${prefix}DeleteInput`,
    });
    expect(Object.fromEntries(descriptor.types[`${prefix}Result`].fields.map((field) => [field.name, field.type]))).toEqual({
      id: 'ID', addbook: 'TransactionBook', updatebook: 'TransactionBook', deletebook: 'TransactionBook',
    });
  });

  test('snapshots custom oneOf inputs while omitting the flag from ordinary inputs', () => {
    const { runtime } = fixture();
    const Details = new GraphQLInputObjectType({
      name: 'LookupDetails', fields: { title: { type: GraphQLString } },
    });
    const Choice = new GraphQLInputObjectType({
      name: 'LookupChoice', isOneOf: true,
      fields: { id: { type: GraphQLID }, details: { type: Details } },
    });
    runtime.registerMutation('lookup', 'Choose a lookup', Choice, GraphQLString, () => 'selected');
    const schema = runtime.createSchema();
    const descriptor = buildClientDescriptor(schema);

    expect(descriptor.types.LookupChoice).toMatchObject({ kind: 'input', isOneOf: true });
    expect(descriptor.types.LookupDetails).not.toHaveProperty('isOneOf');
    expect(Object.isFrozen(descriptor.types.LookupChoice)).toBe(true);
    Choice.isOneOf = false;
    Details.isOneOf = true;
    expect(buildClientDescriptor(schema)).toBe(descriptor);
    expect(descriptor.types.LookupChoice.isOneOf).toBe(true);
    expect(descriptor.types.LookupDetails).not.toHaveProperty('isOneOf');
  });

  test('keeps transaction classification and snapshots specific to their owning schemas', () => {
    const { runtime, Book } = fixture();
    const generated = runtime.createSchema(null, null, null, { transaction: { types: [Book] } });
    const plain = runtime.createSchema();
    runtime.registerMutation('transaction', 'Application transaction', null, GraphQLString, () => 'custom');
    const custom = runtime.createSchema();

    const descriptor = buildClientDescriptor(generated);
    expect(descriptor.operations.mutation.transaction.operation).toBe('transaction');
    expect(buildClientDescriptor(plain).operations.mutation.transaction).toBeUndefined();
    expect(buildClientDescriptor(custom).operations.mutation.transaction.operation).toBe('customMutation');
    expect(() => buildClientDescriptor(new GraphQLSchema(generated.toConfig()))).toThrow(/Simfinity schema/);
    generated.getMutationType().getFields().transaction.description = 'Changed after the first build';
    expect(buildClientDescriptor(generated)).toBe(descriptor);
    expect(descriptor.operations.mutation.transaction.description).not.toBe('Changed after the first build');
    expect(Object.isFrozen(descriptor.operations.mutation.transaction)).toBe(true);
  });

  test('recognizes the generated field even when its marker is copied to a custom mutation', () => {
    const { runtime, Book } = fixture();
    runtime.registerMutation('transaction', 'Application transaction', null, GraphQLString, () => 'custom');
    const schema = runtime.createSchema(null, null, null, { transaction: { name: 'saveBooks', types: [Book] } });
    const fields = schema.getMutationType().getFields();
    fields.transaction.extensions.simfinityTransaction = fields.saveBooks.extensions.simfinityTransaction;
    delete fields.saveBooks.extensions.simfinityTransaction;

    const descriptor = buildClientDescriptor(schema);
    expect(descriptor.operations.mutation.saveBooks.operation).toBe('transaction');
    expect(descriptor.operations.mutation.transaction.operation).toBe('customMutation');
  });
});
