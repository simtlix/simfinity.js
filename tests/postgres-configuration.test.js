import { describe, expect, it, vi } from 'vitest';
import {
  GraphQLID, GraphQLList, GraphQLObjectType, GraphQLString, graphql, printSchema,
} from 'graphql';
import { createPostgres, postgresPlugin, SimfinityError } from '../packages/postgres/src/index.js';

describe('PostgreSQL instance configuration', () => {
  it('binds a snapshot of the pool and schema and rejects reconfiguration and late registration', () => {
    const original = { connect: vi.fn(), query: vi.fn() };
    const options = { pool: original, schema: 'original' };
    const api = createPostgres(options);
    options.schema = 'changed';
    options.pool = null;
    const Item = new GraphQLObjectType({ name: 'ConfigurationItem', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
    api.connect(null, Item, 'item', 'items');
    api.createSchema();
    expect(api.describeDatabase().schema).toBe('original');
    expect(() => api.configure({ pool: original })).toThrow('already bound');
    expect(() => api.addNoEndpointType(new GraphQLObjectType({ name: 'LateItem', fields: { name: { type: GraphQLString } } }))).toThrow('before creating');
    expect(api.getRegistrations()).toHaveLength(1);
  });

  it('rejects operations before initialization without opening a connection', async () => {
    const pool = { connect: vi.fn(), query: vi.fn() };
    const api = createPostgres();
    api.configure({ pool });
    api.connect(null, new GraphQLObjectType({ name: 'UninitializedItem', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } }), 'item', 'items');
    const result = await graphql({ schema: api.createSchema(), source: '{items{id}}' });
    expect(result.errors?.[0].extensions.code).toBe('DATABASE_NOT_INITIALIZED');
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });
});

const libraryTypes = (prefix) => {
  const Author = new GraphQLObjectType({
    name: `${prefix}Author`,
    fields: () => ({
      id: { type: GraphQLID },
      name: { type: GraphQLString },
      books: { type: new GraphQLList(Book), extensions: { relation: { embedded: false, connectionField: 'author' } } },
    }),
  });
  const Book = new GraphQLObjectType({
    name: `${prefix}Book`,
    fields: () => ({
      id: { type: GraphQLID },
      title: { type: GraphQLString },
      author: { type: Author, extensions: { relation: { embedded: false, connectionField: 'author' } } },
    }),
  });
  return { Author, Book };
};
const instance = (schema) => createPostgres({ pool: { connect: vi.fn(), query: vi.fn() }, schema });
const registerLibrary = (api, { Author, Book }) => {
  api.connect(null, Author, 'author', 'authors');
  api.connect(null, Book, 'book', 'books');
};

describe('PostgreSQL instances and GraphQL types', () => {
  it('rejects types whose relations another instance resolves', () => {
    const types = libraryTypes('TenantShared');
    const first = instance('tenant_a');
    registerLibrary(first, types);
    first.createSchema();
    const second = instance('tenant_b');

    expect(() => second.connect(null, types.Author, 'author', 'authors'))
      .toThrow(expect.objectContaining({ extensions: expect.objectContaining({ code: 'TYPE_BOUND_TO_OTHER_RUNTIME' }) }));
    expect(second.getRegistrations()).toHaveLength(0);
  });

  it('builds identical schemas for instances with their own type objects', () => {
    const schemas = ['tenant_a', 'tenant_b'].map((name) => {
      const api = instance(name);
      registerLibrary(api, libraryTypes('TenantOwn'));
      return api.createSchema();
    });

    expect(printSchema(schemas[1])).toBe(printSchema(schemas[0]));
  });
});

describe('PostgreSQL error normalization', () => {
  const { normalizeError, isRetryable } = postgresPlugin().driver;
  const pgError = (code, extra = {}) => Object.assign(new Error(`server message for ${code}`), { code, severity: 'ERROR', ...extra });

  it.each([
    ['22001', 'Value is too long'],
    ['22008', 'Date or time value is out of range'],
    ['22021', 'Text contains a character the database cannot store'],
    ['22P05', 'Text contains a character the database cannot store'],
    ['22003', 'Numeric value is out of range'],
    ['22P02', 'Invalid stored value'],
    ['23514', 'A value violates the generated schema'],
  ])('maps input data exception %s to INVALID_VALUE (400)', (code, message) => {
    const failure = pgError(code);
    const normalized = normalizeError(failure);
    expect(normalized).toBeInstanceOf(SimfinityError);
    expect(normalized).toMatchObject({ message, extensions: { code: 'INVALID_VALUE', status: 400 } });
    expect(normalized.cause).toBe(failure);
    expect(normalized.getCause()).toBe(failure);
  });

  it.each(['22023', '42P01', '54000', '57P01', '3D000'])('keeps other PostgreSQL errors such as %s a masked DATABASE_ERROR (500)', (code) => {
    const normalized = normalizeError(pgError(code, { severity: code === '3D000' ? 'FATAL' : 'ERROR' }));
    expect(normalized).toMatchObject({ message: 'Database operation failed', extensions: { code: 'DATABASE_ERROR', status: 500 } });
    expect(normalized.getCause().code).toBe(code);
  });

  it('keeps the driver error out of serialized and spread copies of the mapped error', () => {
    const failure = pgError('23505', { detail: 'Key (email)=(alice@example.com) already exists.', table: 'User', constraint: 'User_email_key' });
    const normalized = normalizeError(failure);
    expect(normalized).toMatchObject({ message: 'Unique value already exists', extensions: { code: 'DUPLICATE_KEY', status: 409 } });
    expect(normalized.getCause()).toBe(failure);
    expect(Object.getOwnPropertyDescriptor(normalized, 'cause')).toMatchObject({ enumerable: false, writable: true, configurable: true });
    expect(Object.keys({ ...normalized })).not.toContain('cause');
    const json = JSON.stringify(normalized);
    for (const secret of ['alice@example.com', 'User_email_key', 'detail']) expect(json).not.toContain(secret);
  });

  it('returns errors that are not PostgreSQL errors unchanged and tolerates non-object values', () => {
    const values = [
      null, undefined, 'text', 0, new Error('plain'),
      Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:5432'), { code: 'ECONNREFUSED', errno: -111, syscall: 'connect' }),
      Object.assign(new Error('Card declined'), { code: 'PAYMENT_DECLINED' }),
      // An application error with a SQLSTATE-like code but no severity is not a server error.
      Object.assign(new Error('duplicate'), { code: '23505' }),
      new DOMException('The operation timed out', 'TimeoutError'),
      new SimfinityError('Card declined', 'PAYMENT_DECLINED', 402),
    ];
    for (const value of values) {
      expect(normalizeError(value)).toBe(value);
      expect(isRetryable(value)).toBe(false);
    }
  });

  it.each(['40001', '40P01'])('retries %s and maps an exhausted retry whether or not the server raised it', (code) => {
    for (const failure of [pgError(code), Object.assign(new Error('serialization failure'), { code })]) {
      expect(isRetryable(failure)).toBe(true);
      const normalized = normalizeError(failure);
      expect(normalized).toMatchObject({ message: 'Concurrent write could not be completed', extensions: { code: 'TRANSACTION_RETRY_EXCEEDED', status: 409 } });
      expect(normalized.getCause()).toBe(failure);
    }
  });
});

describe('PostgreSQL commit', () => {
  // A result without a command comes from a pool wrapper or test double that follows the declared
  // { rows, rowCount } result, as 3.5.5 accepted.
  it.each([
    ['COMMIT', { command: 'COMMIT', rows: [], rowCount: null }],
    ['no command', { rows: [], rowCount: null }],
    ['no result', undefined],
  ])('resolves when the COMMIT result reports %s', async (label, result) => {
    const committed = { query: vi.fn(async () => result) };
    await expect(postgresPlugin().driver.commit(committed)).resolves.toBeUndefined();
    expect(committed.query).toHaveBeenCalledWith('COMMIT');
  });

  // After a failed statement that the caller caught, PostgreSQL ends the transaction with a rollback
  // and still answers COMMIT without an error.
  it('rejects with DATABASE_ERROR (500) when PostgreSQL answered COMMIT with ROLLBACK', async () => {
    const error = await postgresPlugin().driver.commit({ query: async () => ({ command: 'ROLLBACK', rows: [], rowCount: null }) }).catch((caught) => caught);
    expect(error).toBeInstanceOf(SimfinityError);
    expect(error).toMatchObject({ message: 'Transaction was rolled back because one of its statements failed', extensions: { code: 'DATABASE_ERROR', status: 500 } });
    expect(error.getCause()).toBe(error.cause);
    expect(error.getCause()).toBeInstanceOf(Error);
    expect(error.getCause().message).toBe('COMMIT reported ROLLBACK');
    expect(Object.keys(error)).not.toContain('cause');
  });
});
