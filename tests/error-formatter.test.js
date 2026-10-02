import { describe, expect, test, vi } from 'vitest';
import {
  GraphQLError, GraphQLInputObjectType, GraphQLInt, GraphQLList, GraphQLObjectType, GraphQLScalarType, GraphQLSchema,
  GraphQLString, graphql,
} from 'graphql';

import {
  buildErrorFormatter, InternalServerError, SimfinityError, scalars,
} from '../packages/core/src/index.js';

const notFound = new SimfinityError('Book not found', 'NOT_FOUND', 404);
const databaseDown = new Error('connect ECONNREFUSED 10.0.0.5:5432');
// A stored record whose shape no longer matches the schema; graphql-js prints it in its own errors.
const driftedRecord = { id: 'u1', email: 'alice@example.com', passwordHash: 'SECRET-HASH' };
const Account = new GraphQLObjectType({
  name: 'FormatterAccount',
  isTypeOf: (value) => value.kind === 'account',
  fields: { id: { type: GraphQLString } },
});

const EmailInput = new GraphQLInputObjectType({
  name: 'FormatterEmailInput',
  fields: { address: { type: scalars.EmailScalar } },
});
const Code = new GraphQLScalarType({
  name: 'FormatterCode',
  parseValue: (value) => {
    if (String(value).length < 3) throw new SimfinityError('Code is too short', 'CODE_TOO_SHORT', 422);
    return value;
  },
});

const schema = new GraphQLSchema({
  query: new GraphQLObjectType({
    name: 'Query',
    fields: {
      known: {
        type: GraphQLString,
        resolve: () => {
          throw notFound;
        },
      },
      unknown: {
        type: GraphQLString,
        resolve: () => {
          throw databaseDown;
        },
      },
      application: {
        type: GraphQLString,
        resolve: () => {
          throw new GraphQLError('No such shop', { extensions: { code: 'NOT_FOUND', http: { status: 404 } } });
        },
      },
      hiddenCause: {
        type: GraphQLString,
        resolve: () => {
          throw new GraphQLError('Could not create user', {
            originalError: new Error('duplicate key Key (email)=(secret@example.com)'),
            extensions: { code: 'CONFLICT' },
          });
        },
      },
      internalApplication: {
        type: GraphQLString,
        resolve: () => {
          throw new GraphQLError('Storage unavailable', { extensions: { code: 'INTERNAL_SERVER_ERROR' } });
        },
      },
      codeless: {
        type: GraphQLString,
        resolve: () => {
          throw new GraphQLError('Lookup failed for alice@example.com');
        },
      },
      simfinityCause: {
        type: GraphQLString,
        resolve: () => {
          throw new GraphQLError('Book not found', { originalError: notFound });
        },
      },
      driftedString: { type: GraphQLString, resolve: () => driftedRecord },
      driftedAccount: { type: Account, resolve: () => driftedRecord },
      driftedAccounts: { type: new GraphQLList(Account), resolve: () => [driftedRecord] },
      nonError: {
        type: GraphQLString,
        resolve: () => {
          throw { password: 'Plaintext-Secret' };
        },
      },
      withArgument: {
        type: GraphQLString,
        args: { n: { type: GraphQLInt } },
        resolve: () => 'value',
      },
      withEmail: {
        type: GraphQLString,
        args: { input: { type: EmailInput } },
        resolve: () => 'value',
      },
      withCode: {
        type: GraphQLString,
        args: { code: { type: Code } },
        resolve: () => 'value',
      },
    },
  }),
});

const firstError = async (source, variableValues) => {
  const result = await graphql({ schema, source, variableValues });
  return result.errors[0];
};
const serialize = (error) => JSON.parse(JSON.stringify(error));

describe('buildErrorFormatter', () => {
  test('keeps the code of a SimfinityError a resolver threw', async () => {
    const callback = vi.fn();

    const formatted = buildErrorFormatter(callback)(await firstError('{ known }'));

    expect(callback).toHaveBeenCalledWith(notFound);
    expect(formatted).toBeInstanceOf(GraphQLError);
    expect(formatted.originalError).toBe(notFound);
    const json = serialize(formatted);
    expect(Object.keys(json).sort()).toEqual(['extensions', 'locations', 'message', 'path']);
    expect(json).toMatchObject({
      message: 'Book not found',
      locations: [{ line: 1, column: 3 }],
      path: ['known'],
      extensions: { code: 'NOT_FOUND', status: 404 },
    });
  });

  test('wraps other errors as internal server errors without serializing the cause', async () => {
    const callback = vi.fn();

    const formatted = buildErrorFormatter(callback)(await firstError('{ unknown }'));

    const [[received]] = callback.mock.calls;
    expect(received).toBeInstanceOf(InternalServerError);
    expect(received.getCause()).toBe(databaseDown);
    const json = serialize(formatted);
    expect(Object.keys(json).sort()).toEqual(['extensions', 'locations', 'message', 'path']);
    expect(json.message).toBe(databaseDown.message);
    expect(json.extensions.code).toBe('INTERNAL_SERVER_ERROR');
  });

  test('replaces the error with the callback result and keeps its location', async () => {
    const masking = buildErrorFormatter((error) => (error instanceof InternalServerError
      ? new SimfinityError('Internal error', 'INTERNAL_SERVER_ERROR', 500)
      : undefined));

    const json = serialize(masking(await firstError('{ unknown }')));

    expect(json).toMatchObject({
      message: 'Internal error',
      locations: [{ line: 1, column: 3 }],
      path: ['unknown'],
      extensions: { code: 'INTERNAL_SERVER_ERROR', status: 500 },
    });
  });

  test('returns a GraphQLError the callback returns unchanged', async () => {
    const replacement = new GraphQLError('Replaced');

    expect(buildErrorFormatter(() => replacement)(await firstError('{ known }'))).toBe(replacement);
  });

  test.each([
    ['validation', '{ missing }', undefined],
    ['syntax', '{ known', undefined],
    ['variable', 'query ($n: Int) { withArgument(n: $n) }', { n: 'abc' }],
    ['validated scalar variable', 'query ($i: FormatterEmailInput) { withEmail(input: $i) }', {
      i: { address: 'not-an-email' },
    }],
    ['validated scalar literal', '{ withEmail(input: { address: "not-an-email" }) }', undefined],
  ])('classifies %s errors as bad requests with their own message', async (label, source, variables) => {
    const callback = vi.fn();
    const error = await firstError(source, variables);

    const json = serialize(buildErrorFormatter(callback)(error));

    expect(callback.mock.calls[0][0]).toBeInstanceOf(SimfinityError);
    expect(callback.mock.calls[0][0]).not.toBeInstanceOf(InternalServerError);
    expect(callback.mock.calls[0][0].getCode()).toBe('BAD_REQUEST');
    expect(json.message).toBe(error.message);
    expect(json.extensions).toMatchObject({ code: 'BAD_REQUEST', status: 400 });
    expect(json.locations).toEqual([expect.objectContaining({ line: 1 })]);
  });

  test('keeps the variable name and input path of a validated scalar error', async () => {
    const source = 'query ($i: FormatterEmailInput) { withEmail(input: $i) }';

    const json = serialize(buildErrorFormatter()(await firstError(source, { i: { address: 'not-an-email' } })));

    expect(json.message).toMatch(/^Variable "\$i" got invalid value "not-an-email" at "i\.address"; /);
  });

  test('keeps the HTTP status a server adds to a variable error', async () => {
    const error = await firstError('query ($n: Int) { withArgument(n: $n) }', { n: 'abc' });
    // What @graphql-tools/executor, used by GraphQL Yoga, does to request errors before formatting.
    Object.defineProperty(error, 'extensions', {
      value: { ...error.extensions, http: { ...error.extensions?.http, status: 400 } },
    });

    const formatted = buildErrorFormatter()(error);

    expect(formatted.extensions.http).toEqual({ status: 400 });
    expect(serialize(formatted)).toMatchObject({
      message: error.message,
      extensions: { code: 'BAD_REQUEST', status: 400, http: { status: 400 } },
    });
  });

  test('takes the code of a SimfinityError a scalar threw and keeps the request error message', async () => {
    const error = await firstError('query ($c: FormatterCode) { withCode(code: $c) }', { c: 'ab' });

    const json = serialize(buildErrorFormatter()(error));

    expect(json.message).toBe(error.message);
    expect(json.message).toMatch(/^Variable "\$c" got invalid value "ab"; /);
    expect(json.extensions).toMatchObject({ code: 'CODE_TOO_SHORT', status: 422 });
  });

  test('keeps the code and extensions of application GraphQL errors', async () => {
    const json = serialize(buildErrorFormatter()(await firstError('{ application }')));

    expect(json.message).toBe('No such shop');
    expect(json.path).toEqual(['application']);
    expect(json.extensions).toMatchObject({ code: 'NOT_FOUND', http: { status: 404 } });
  });

  test('keeps the message and code of an application GraphQL error and hides its cause', async () => {
    const callback = vi.fn();

    const formatted = buildErrorFormatter(callback)(await firstError('{ hiddenCause }'));

    const [[received]] = callback.mock.calls;
    expect(received).not.toBeInstanceOf(InternalServerError);
    expect(received.message).toBe('Could not create user');
    expect(received.getCode()).toBe('CONFLICT');
    expect(serialize(formatted)).toMatchObject({
      message: 'Could not create user',
      path: ['hiddenCause'],
      extensions: { code: 'CONFLICT', status: 400 },
    });
    expect(JSON.stringify(formatted)).not.toContain('secret');
    expect(formatted.originalError).toBe(received);
  });

  test('gives application GraphQL errors with an internal code status 500', async () => {
    const json = serialize(buildErrorFormatter()(await firstError('{ internalApplication }')));

    expect(json).toMatchObject({
      message: 'Storage unavailable',
      extensions: { code: 'INTERNAL_SERVER_ERROR', status: 500 },
    });
  });

  describe('with the documented masking callback', () => {
    const masking = (callback = vi.fn()) => buildErrorFormatter((error) => {
      callback(error);
      return error instanceof InternalServerError ? new InternalServerError('Unexpected error') : undefined;
    });

    test.each([
      ['a String field that resolves to an object', '{ driftedString }', ['driftedString']],
      ['an isTypeOf mismatch', '{ driftedAccount { id } }', ['driftedAccount']],
      ['a list item', '{ driftedAccounts { id } }', ['driftedAccounts', 0]],
    ])('masks the error graphql-js raises for %s', async (label, source, path) => {
      const callback = vi.fn();
      const error = await firstError(source);
      expect(error.message).toContain('SECRET-HASH');

      const formatted = masking(callback)(error);

      const [[received]] = callback.mock.calls;
      expect(received).toBeInstanceOf(InternalServerError);
      expect(received.getCause()).toBe(error.originalError);
      expect(serialize(formatted)).toMatchObject({
        message: 'Unexpected error',
        path,
        extensions: { code: 'INTERNAL_SERVER_ERROR' },
      });
      expect(JSON.stringify(formatted)).not.toContain('SECRET-HASH');
    });

    test('masks a GraphQLError a resolver threw without a code', async () => {
      const callback = vi.fn();

      const formatted = masking(callback)(await firstError('{ codeless }'));

      expect(callback.mock.calls[0][0]).toBeInstanceOf(InternalServerError);
      expect(serialize(formatted)).toMatchObject({ message: 'Unexpected error', path: ['codeless'] });
      expect(JSON.stringify(formatted)).not.toContain('alice@example.com');
    });

    test.each([
      ['its own code', '{ application }', 'No such shop', { code: 'NOT_FOUND', http: { status: 404 } }],
      ['a SimfinityError cause', '{ simfinityCause }', 'Book not found', { code: 'NOT_FOUND', status: 404 }],
    ])('keeps the message and code of an application GraphQLError with %s', async (label, source, message, extensions) => {
      const callback = vi.fn();

      const formatted = masking(callback)(await firstError(source));

      expect(callback.mock.calls[0][0]).not.toBeInstanceOf(InternalServerError);
      expect(serialize(formatted)).toMatchObject({ message, extensions });
    });
  });

  test('does not keep or print a non-Error value a resolver threw', async () => {
    const callback = vi.fn();

    const formatted = buildErrorFormatter(callback)(await firstError('{ nonError }'));

    const [[received]] = callback.mock.calls;
    expect(received).toBeInstanceOf(InternalServerError);
    expect(received.getCause()).toBeUndefined();
    expect(serialize(formatted)).toMatchObject({ message: 'Unexpected error value', path: ['nonError'] });
    expect(JSON.stringify(formatted)).not.toContain('Plaintext-Secret');
  });

  test('formats errors passed directly', () => {
    const format = buildErrorFormatter();

    const known = format(notFound);
    const unknown = format(new Error('plain'));

    expect(known).toBeInstanceOf(GraphQLError);
    expect(known.originalError).toBe(notFound);
    expect(known.toJSON()).toEqual({ message: 'Book not found', extensions: { ...notFound.extensions } });
    expect(unknown.originalError).toBeInstanceOf(InternalServerError);
    expect(unknown.originalError.getCause().message).toBe('plain');
  });

  test('does not keep non-Error values as the cause', () => {
    const callback = vi.fn();
    const payload = { errors: [], context: { variableValues: { password: 'Plaintext-Secret' } }, phase: 'execution' };

    const formatted = buildErrorFormatter(callback)(payload);

    const [[received]] = callback.mock.calls;
    expect(received).toBeInstanceOf(InternalServerError);
    expect(received.getCause()).toBeUndefined();
    expect(formatted.message).toBe('Unexpected error value');
    expect(JSON.stringify(formatted)).not.toContain('Plaintext-Secret');
  });
});
