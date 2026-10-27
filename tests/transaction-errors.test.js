// The error a generated transaction field reports when an operation ends it (#151, section 4.8). While
// attempts run, the operation's error propagates unchanged, so that the adapter can recognize it. The
// resolver then reports a new error that names the operation (`extensions.operationIndex` and
// `extensions.operation`) and has the code, status and message that buildErrorFormatter gives the same
// value thrown by a root resolver, including the InternalServerError that the documented masking callback
// hides. It keeps the original as a non-enumerable `cause` and never mutates it. Errors that are not an
// operation's of the final attempt, such as those of the begin, the commit, the rollback, the operation
// count and the model affinity, are reported as they are.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  GraphQLError, GraphQLID, GraphQLInt, GraphQLObjectType, GraphQLSchema, GraphQLString, graphql,
} from 'graphql';
import {
  buildErrorFormatter, configureMutationLimits, createRuntime, InternalServerError, SimfinityError,
} from '@simtlix/simfinity-core';
import { createOptimisticMemoryAdapter, transientError } from './helpers/optimistic-memory-adapter.js';

const SECRET = 'connect ECONNREFUSED 10.0.0.5:5432 password=hunter2';

// What the documented masking callback does.
const masking = (callback = vi.fn()) => buildErrorFormatter((error) => {
  callback(error);
  return error instanceof InternalServerError ? new InternalServerError('Unexpected error') : undefined;
});
const serialize = (error) => JSON.parse(JSON.stringify(error));

let warn;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  configureMutationLimits({});
});

// Unprotected Producto. The middleware of every operation calls `hooks.middleware` before the operation
// runs, so a test throws from the operation whose input is named `boom`.
const build = ({ adapterOptions } = {}) => {
  const adapter = createOptimisticMemoryAdapter(adapterOptions);
  vi.spyOn(adapter, 'withTransaction');
  const runtime = createRuntime(adapter);
  const hooks = {};
  const Producto = new GraphQLObjectType({
    name: 'Producto',
    fields: { id: { type: GraphQLID }, name: { type: GraphQLString }, price: { type: GraphQLInt } },
  });
  runtime.use(async (params, next) => {
    await hooks.middleware?.(params);
    await next();
  });
  runtime.connect(null, Producto, 'producto', 'productos', {});
  const schema = runtime.createSchema(null, null, null, { transaction: { types: [Producto] } });
  const transaction = (operationList) => graphql({
    schema,
    source: 'mutation Run($operations: [TransactionOperation!]!) { transaction(operations: $operations) { id } }',
    variableValues: { operations: operationList },
    contextValue: {},
  });
  return {
    adapter, hooks, schema, transaction,
  };
};

// Fails the operation whose input is named `boom` with what `fail()` returns, as a value to throw.
const failBoom = (fixture, fail) => {
  fixture.hooks.middleware = ({ args }) => {
    if (args.input?.name === 'boom') throw fail();
  };
};

// Item 1 is the failing one: an update, named by its root.
const OPERATIONS = [{ addproducto: { name: 'a' } }, { updateproducto: { id: '$0', name: 'boom' } }];
const POSITION = { operationIndex: 1, operation: 'updateproducto' };
const positionOf = (extensions) => ({ operationIndex: extensions?.operationIndex, operation: extensions?.operation });

// A root resolver that throws what `make()` returns, for the formatter's output on a root.
const rootError = async (make, formatter) => {
  const schema = new GraphQLSchema({
    query: new GraphQLObjectType({
      name: 'Query',
      fields: {
        thrown: {
          type: GraphQLString,
          resolve: () => {
            throw make();
          },
        },
      },
    }),
  });
  const result = await graphql({ schema, source: '{ thrown }' });
  return formatter(result.errors[0]);
};

const causes = [
  {
    label: 'a SimfinityError',
    make: () => new SimfinityError('Producto is locked', 'LOCKED', 423),
    message: 'Producto is locked',
    code: 'LOCKED',
    status: 423,
    hidden: false,
  },
  {
    label: 'a plain Error',
    make: () => new Error(SECRET),
    message: SECRET,
    code: 'INTERNAL_SERVER_ERROR',
    status: 500,
    hidden: true,
  },
  {
    label: 'a thrown string',
    make: () => `${SECRET} (a string)`,
    message: 'Unexpected error value',
    code: 'INTERNAL_SERVER_ERROR',
    status: 500,
    hidden: true,
  },
  {
    label: 'a code-less GraphQLError',
    make: () => new GraphQLError(`Lookup failed for ${SECRET}`),
    message: `Lookup failed for ${SECRET}`,
    code: 'INTERNAL_SERVER_ERROR',
    status: 500,
    hidden: true,
  },
  {
    label: 'a GraphQLError with a SimfinityError cause',
    make: () => new GraphQLError('Could not create the product', {
      originalError: new SimfinityError('Duplicate product', 'DUPLICATE_PRODUCT', 409),
    }),
    message: 'Could not create the product',
    code: 'DUPLICATE_PRODUCT',
    status: 409,
    hidden: false,
  },
  {
    label: 'a GraphQLError with its own string code',
    make: () => new GraphQLError('No such shop', { extensions: { code: 'NOT_FOUND', status: 404, shop: 7 } }),
    message: 'No such shop',
    code: 'NOT_FOUND',
    status: 404,
    hidden: false,
  },
  {
    label: 'an InternalServerError',
    make: () => new InternalServerError(`Storage failed: ${SECRET}`, new Error('driver')),
    message: `Storage failed: ${SECRET}`,
    code: 'INTERNAL_SERVER_ERROR',
    status: 500,
    hidden: true,
  },
];

describe('the error of the operation that ended the transaction', () => {
  test.each(causes)('$label keeps the code, status and message it has on a root, and names the operation', async ({
    make, message, code, status, hidden,
  }) => {
    const fixture = build();
    const cause = make();
    failBoom(fixture, () => cause);
    const result = await fixture.transaction(OPERATIONS);

    expect(result.errors).toHaveLength(1);
    expect(result.data).toEqual({ transaction: null });
    const [located] = result.errors;
    const decorated = located.originalError;
    expect(decorated).toBeInstanceOf(SimfinityError);
    expect(decorated).not.toBe(cause);
    expect(decorated.message).toBe(message);
    expect(decorated.extensions).toMatchObject({ code, status, ...POSITION });
    expect(positionOf(located.extensions)).toEqual(POSITION);
    // The original is reachable, and the property is not enumerable, so no copy of the error carries it.
    expect(decorated.cause).toBe(cause);
    expect(Object.getOwnPropertyDescriptor(decorated, 'cause').enumerable).toBe(false);
    expect(Object.keys(decorated)).not.toContain('cause');
    expect(decorated instanceof InternalServerError).toBe(hidden);

    // The formatter reports it as it reports the same value thrown by a root, plus the position.
    for (const formatter of [buildErrorFormatter(), masking()]) {
      const formatted = serialize(formatter(located));
      const onRoot = serialize(await rootError(make, formatter));
      expect(formatted.message).toBe(onRoot.message);
      expect(formatted.extensions).toMatchObject({ code: onRoot.extensions.code, status: onRoot.extensions.status });
      expect(formatted.path).toEqual(['transaction']);
    }
    const plain = serialize(buildErrorFormatter()(located));
    expect(plain.message).toBe(message);
    expect(plain.extensions).toMatchObject({ code, status, ...POSITION });
  });

  test.each(causes)('the masking callback sees $label as it sees it on a root', async ({
    make, message, hidden,
  }) => {
    const fixture = build();
    failBoom(fixture, make);
    const result = await fixture.transaction(OPERATIONS);
    const callback = vi.fn();

    const formatted = masking(callback)(result.errors[0]);

    const [[received]] = callback.mock.calls;
    expect(received instanceof InternalServerError).toBe(hidden);
    // The callback can read the position, and the one that masks may keep it.
    expect(received.extensions).toMatchObject(POSITION);
    if (hidden) {
      expect(serialize(formatted).message).toBe('Unexpected error');
      expect(JSON.stringify(serialize(formatted))).not.toContain('hunter2');
      expect(JSON.stringify(formatted)).not.toContain('hunter2');
    } else {
      expect(serialize(formatted).message).toBe(message);
      expect(serialize(formatted).extensions).toMatchObject(POSITION);
    }
  });

  test('a callback that masks may keep the position', async () => {
    const fixture = build();
    failBoom(fixture, () => new Error(SECRET));
    const result = await fixture.transaction(OPERATIONS);

    const formatted = serialize(buildErrorFormatter((error) => {
      if (!(error instanceof InternalServerError)) return undefined;
      const masked = new InternalServerError('Unexpected error');
      masked.extensions.operationIndex = error.extensions.operationIndex;
      masked.extensions.operation = error.extensions.operation;
      return masked;
    })(result.errors[0]));

    expect(formatted.message).toBe('Unexpected error');
    expect(formatted.extensions).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', status: 500, ...POSITION });
    expect(JSON.stringify(formatted)).not.toContain('hunter2');
  });

  test('copies every extension of a SimfinityError and keeps its timestamp, without adding to the original', async () => {
    const fixture = build();
    const cause = new SimfinityError('Producto is locked', 'LOCKED', 423);
    cause.extensions.reason = 'audit';
    const before = { ...cause.extensions };
    failBoom(fixture, () => cause);
    const result = await fixture.transaction(OPERATIONS);

    const decorated = result.errors[0].originalError;
    expect(decorated.extensions).toEqual({ ...before, ...POSITION });
    expect(decorated.extensions).not.toBe(cause.extensions);
    expect(cause.extensions).toEqual(before);
    expect(decorated.getCode()).toBe('LOCKED');
    expect(decorated.getStatus()).toBe(423);
  });

  test('keeps the extensions that a GraphQLError with a code carries, such as an http status', async () => {
    const fixture = build();
    const cause = new GraphQLError('No such shop', { extensions: { code: 'NOT_FOUND', http: { status: 404 } } });
    failBoom(fixture, () => cause);
    const result = await fixture.transaction(OPERATIONS);

    const formatted = serialize(buildErrorFormatter()(result.errors[0]));
    expect(formatted.extensions).toMatchObject({ code: 'NOT_FOUND', status: 400, http: { status: 404 }, ...POSITION });
    expect(cause.extensions).toEqual({ code: 'NOT_FOUND', http: { status: 404 } });
  });

  test('a non-Error value is not kept as the cause that getCause() returns, as on a root', async () => {
    const fixture = build();
    const payload = { request: { variables: { password: 'Plaintext-Secret' } } };
    failBoom(fixture, () => payload);
    const result = await fixture.transaction(OPERATIONS);

    const decorated = result.errors[0].originalError;
    expect(decorated).toBeInstanceOf(InternalServerError);
    expect(decorated.message).toBe('Unexpected error value');
    expect(decorated.getCause()).toBeUndefined();
    expect(decorated.cause).toBe(payload);
    expect(JSON.stringify(decorated)).not.toContain('Plaintext-Secret');
    expect(JSON.stringify(buildErrorFormatter()(result.errors[0]))).not.toContain('Plaintext-Secret');
  });

  test('the cause of an Error that is not a SimfinityError is the one getCause() returns', async () => {
    const fixture = build();
    const cause = new Error(SECRET);
    failBoom(fixture, () => cause);
    const result = await fixture.transaction(OPERATIONS);

    const callback = vi.fn();
    masking(callback)(result.errors[0]);
    expect(callback.mock.calls[0][0].getCause()).toBe(cause);
  });

  test('names the first operation, an add, and the last one of a list', async () => {
    const first = build();
    failBoom(first, () => new SimfinityError('Rejected', 'REJECTED', 422));
    const early = await first.transaction([{ addproducto: { name: 'boom' } }, { addproducto: { name: 'b' } }]);
    expect(positionOf(early.errors[0].extensions)).toEqual({ operationIndex: 0, operation: 'addproducto' });
    expect(first.adapter.stored('Producto', '1000')).toBeNull();

    const last = build();
    failBoom(last, () => new SimfinityError('Rejected', 'REJECTED', 422));
    const late = await last.transaction([
      { addproducto: { name: 'a' } }, { addproducto: { name: 'b' } }, { updateproducto: { id: '$1', name: 'boom' } },
    ]);
    expect(positionOf(late.errors[0].extensions)).toEqual({ operationIndex: 2, operation: 'updateproducto' });
    expect(last.adapter.records.size).toBe(0);
  });

  test('names a delete by its root', async () => {
    const fixture = build();
    fixture.hooks.middleware = ({ operation }) => {
      if (operation === 'delete') throw new SimfinityError('Not deletable', 'NOT_DELETABLE', 409);
    };
    const result = await fixture.transaction([{ addproducto: { name: 'a' } }, { deleteproducto: { id: '$0' } }]);

    expect(positionOf(result.errors[0].extensions)).toEqual({ operationIndex: 1, operation: 'deleteproducto' });
    expect(result.errors[0].extensions).toMatchObject({ code: 'NOT_DELETABLE', status: 409 });
  });
});

describe('errors that are shared, frozen or not Errors', () => {
  const frozen = [
    ['a frozen SimfinityError', () => {
      const error = new SimfinityError('Producto is locked', 'LOCKED', 423);
      Object.freeze(error.extensions);
      return Object.freeze(error);
    }],
    ['a frozen Error', () => Object.freeze(new Error(SECRET))],
    ['a frozen GraphQLError with a code', () => Object.freeze(new GraphQLError('No such shop', {
      extensions: Object.freeze({ code: 'NOT_FOUND' }),
    }))],
    ['a frozen InternalServerError', () => {
      const error = new InternalServerError(SECRET, new Error('driver'));
      Object.freeze(error.extensions);
      return Object.freeze(error);
    }],
  ];

  test.each(frozen)('%s is not mutated', async (label, make) => {
    const fixture = build();
    const cause = make();
    const message = cause.message;
    const extensions = cause.extensions && { ...cause.extensions };
    const properties = Object.getOwnPropertyNames(cause);
    failBoom(fixture, () => cause);
    const result = await fixture.transaction(OPERATIONS);

    expect(result.errors).toHaveLength(1);
    const decorated = result.errors[0].originalError;
    expect(decorated).not.toBe(cause);
    expect(positionOf(decorated.extensions)).toEqual(POSITION);
    expect(decorated.cause).toBe(cause);
    expect(Object.isFrozen(cause)).toBe(true);
    expect(cause.message).toBe(message);
    if (extensions) expect(cause.extensions).toEqual(extensions);
    expect(Object.getOwnPropertyNames(cause)).toEqual(properties);
  });

  test('one error instance thrown by two invocations carries the position of each', async () => {
    const shared = new SimfinityError('Producto is locked', 'LOCKED', 423);
    const before = { ...shared.extensions };
    const fixture = build();
    failBoom(fixture, () => shared);

    const first = await fixture.transaction(OPERATIONS);
    const second = await fixture.transaction([{ addproducto: { name: 'boom' } }, { addproducto: { name: 'b' } }]);
    const third = await fixture.transaction([
      { addproducto: { name: 'a' } }, { addproducto: { name: 'b' } }, { addproducto: { name: 'boom' } },
    ]);

    expect(positionOf(first.errors[0].extensions)).toEqual(POSITION);
    expect(positionOf(second.errors[0].extensions)).toEqual({ operationIndex: 0, operation: 'addproducto' });
    expect(positionOf(third.errors[0].extensions)).toEqual({ operationIndex: 2, operation: 'addproducto' });
    for (const result of [first, second, third]) expect(result.errors[0].originalError.cause).toBe(shared);
    expect(shared.extensions).toEqual(before);
    expect(Object.hasOwn(shared, 'cause')).toBe(false);
  });
});

describe('errors that do not belong to an operation', () => {
  const unpositioned = (result, expected) => {
    expect(result.errors).toHaveLength(1);
    const [located] = result.errors;
    expect(located.originalError).toBe(expected);
    expect(located.extensions.operationIndex).toBeUndefined();
    expect(located.extensions.operation).toBeUndefined();
    const formatted = serialize(buildErrorFormatter()(located));
    expect(formatted.extensions).not.toHaveProperty('operationIndex');
    expect(formatted.extensions).not.toHaveProperty('operation');
  };

  test('a failure of the commit after every operation ran is reported as it is', async () => {
    const commitFailure = new SimfinityError('Commit failed', 'DATABASE_ERROR', 500);
    const fixture = build();
    fixture.adapter.withTransaction.mockImplementation(async (session, body) => {
      await body({ memory: true });
      throw commitFailure;
    });

    unpositioned(await fixture.transaction(OPERATIONS), commitFailure);
  });

  test('a commit failure that is not a SimfinityError is still an InternalServerError without a position', async () => {
    const commitFailure = new Error(SECRET);
    const fixture = build();
    fixture.adapter.withTransaction.mockImplementation(async (session, body) => {
      await body({ memory: true });
      throw commitFailure;
    });

    const result = await fixture.transaction(OPERATIONS);
    unpositioned(result, commitFailure);
    const callback = vi.fn();
    const formatted = masking(callback)(result.errors[0]);
    expect(callback.mock.calls[0][0]).toBeInstanceOf(InternalServerError);
    expect(callback.mock.calls[0][0].extensions).not.toHaveProperty('operationIndex');
    expect(serialize(formatted).message).toBe('Unexpected error');
  });

  test('a failure to begin is reported as it is', async () => {
    const beginFailure = new SimfinityError('Database operation failed', 'DATABASE_ERROR', 500);
    const fixture = build();
    fixture.adapter.withTransaction.mockImplementation(async () => {
      throw beginFailure;
    });

    unpositioned(await fixture.transaction(OPERATIONS), beginFailure);
    expect(fixture.adapter.stored('Producto', '1000')).toBeNull();
  });

  test('a failure of the rollback that replaces the operation error is reported as it is', async () => {
    const rollbackFailure = new SimfinityError('Rollback failed', 'DATABASE_ERROR', 500);
    const fixture = build();
    failBoom(fixture, () => new SimfinityError('Rejected', 'REJECTED', 422));
    fixture.adapter.withTransaction.mockImplementation(async (session, body) => {
      try {
        return await body({ memory: true });
      } catch {
        throw rollbackFailure;
      }
    });

    unpositioned(await fixture.transaction(OPERATIONS), rollbackFailure);
  });

  test('the operation count error carries no position', async () => {
    const fixture = build();
    const result = await fixture.transaction(Array.from({ length: 101 }, () => ({ addproducto: { name: 'p' } })));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].originalError.extensions).toMatchObject({
      code: 'TRANSACTION_OPERATIONS_EXCEEDED', status: 400,
    });
    expect(result.errors[0].extensions.operationIndex).toBeUndefined();
    expect(result.errors[0].extensions.operation).toBeUndefined();
    expect(fixture.adapter.withTransaction).not.toHaveBeenCalled();
  });

  test('the affinity error carries no position', async () => {
    const fixture = build();
    const affinity = new SimfinityError('Types Pedido, Producto cannot share one database transaction', 'TRANSACTION_UNSUPPORTED', 500);
    fixture.adapter.assertTransactionModels.mockImplementation(() => {
      throw affinity;
    });

    unpositioned(await fixture.transaction(OPERATIONS), affinity);
    expect(fixture.adapter.withTransaction).not.toHaveBeenCalled();
  });

  test('the errors of the preflight checks keep the position they already name', async () => {
    const fixture = build();
    const result = await fixture.transaction([{ updateproducto: { id: '$1', name: 'a' } }, { addproducto: { name: 'b' } }]);

    expect(result.errors[0].originalError.extensions).toMatchObject({
      code: 'INVALID_OPERATION_REFERENCE', operationIndex: 0, operation: 'updateproducto',
    });
    expect(fixture.adapter.withTransaction).not.toHaveBeenCalled();
  });

  test('a cyclic cause chain ends the search and the error is reported as it is', async () => {
    const loop = new Error('loop');
    loop.cause = loop;
    const fixture = build();
    fixture.adapter.withTransaction.mockImplementation(async (session, body) => {
      await body({ memory: true });
      throw loop;
    });

    unpositioned(await fixture.transaction(OPERATIONS), loop);
  });
});

describe('retries', () => {
  test('an operation error of attempt 1 followed by success reports nothing', async () => {
    const fixture = build();
    let seen = 0;
    fixture.hooks.middleware = ({ args }) => {
      if (args.input?.name === 'boom' && (seen += 1) === 1) throw transientError();
    };
    const result = await fixture.transaction(OPERATIONS);

    expect(result.errors).toBeUndefined();
    expect(result.data.transaction).toHaveLength(2);
    expect(seen).toBe(2);
  });

  test('an error of the final attempt names the operation of that attempt, not of an earlier one', async () => {
    const fixture = build();
    const final = new SimfinityError('Rejected', 'REJECTED', 422);
    let calls = 0;
    // Attempt 1 fails at its second operation with a transient error; attempt 2 fails at its first.
    fixture.hooks.middleware = () => {
      calls += 1;
      if (calls === 2) throw transientError();
      if (calls === 3) throw final;
    };
    const result = await fixture.transaction(OPERATIONS);

    expect(result.errors[0].originalError.extensions).toMatchObject({
      code: 'REJECTED', status: 422, operationIndex: 0, operation: 'addproducto',
    });
    expect(result.errors[0].originalError.cause).toBe(final);
  });

  test('a commit failure of attempt 2 after an operation error of attempt 1 carries no position', async () => {
    const commitFailure = new SimfinityError('Commit failed', 'DATABASE_ERROR', 500);
    const fixture = build();
    let seen = 0;
    fixture.hooks.middleware = ({ args }) => {
      if (args.input?.name === 'boom' && (seen += 1) === 1) throw transientError();
    };
    fixture.adapter.withTransaction.mockImplementation(async (session, body) => {
      await body({ memory: true, attempt: 1 }).catch(() => {});
      await body({ memory: true, attempt: 2 });
      throw commitFailure;
    });
    const result = await fixture.transaction(OPERATIONS);

    expect(seen).toBe(2);
    expect(result.errors[0].originalError).toBe(commitFailure);
    expect(result.errors[0].extensions.operationIndex).toBeUndefined();
  });

  test('a begin failure of attempt 2 after an operation error of attempt 1 carries no position', async () => {
    const beginFailure = new SimfinityError('Database operation failed', 'DATABASE_ERROR', 500);
    const fixture = build();
    failBoom(fixture, () => transientError());
    fixture.adapter.withTransaction.mockImplementation(async (session, body) => {
      await body({ memory: true, attempt: 1 }).catch(() => {});
      throw beginFailure;
    });
    const result = await fixture.transaction(OPERATIONS);

    expect(result.errors[0].originalError).toBe(beginFailure);
    expect(result.errors[0].extensions.operationIndex).toBeUndefined();
  });

  test('the error of attempt 1 that an adapter reports after a clean attempt 2 carries no position', async () => {
    const first = new SimfinityError('Rejected', 'REJECTED', 422);
    const fixture = build();
    let seen = 0;
    fixture.hooks.middleware = ({ args }) => {
      if (args.input?.name === 'boom' && (seen += 1) === 1) throw first;
    };
    fixture.adapter.withTransaction.mockImplementation(async (session, body) => {
      await body({ memory: true, attempt: 1 }).catch(() => {});
      await body({ memory: true, attempt: 2 });
      throw first;
    });
    const result = await fixture.transaction(OPERATIONS);

    expect(result.errors[0].originalError).toBe(first);
    expect(first.extensions.operationIndex).toBeUndefined();
    expect(result.errors[0].extensions.operationIndex).toBeUndefined();
  });

  describe('an error that the adapter normalized', () => {
    // As the MongoDB adapter after its last transient retry, and the SQL adapter for a driver error: a new
    // error that keeps the one it replaces as `cause`.
    const normalizing = (fixture, wrap, attempts = 2) => {
      const wrappers = [];
      fixture.adapter.withTransaction.mockImplementation(async (session, body) => {
        let last;
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          try {
            return await body({ memory: true, attempt });
          } catch (error) {
            last = error;
          }
        }
        const wrapper = wrap(last);
        wrappers.push(wrapper);
        throw wrapper;
      });
      return wrappers;
    };
    const retryExceeded = (error) => Object.assign(
      new SimfinityError('Concurrent write could not be completed', 'TRANSACTION_RETRY_EXCEEDED', 409), { cause: error },
    );

    test('TRANSACTION_RETRY_EXCEEDED keeps its code, status and message and names the operation of its cause', async () => {
      const fixture = build();
      failBoom(fixture, () => transientError());
      const wrappers = normalizing(fixture, retryExceeded);
      const result = await fixture.transaction(OPERATIONS);

      expect(wrappers).toHaveLength(1);
      const decorated = result.errors[0].originalError;
      expect(decorated).not.toBe(wrappers[0]);
      expect(decorated.message).toBe('Concurrent write could not be completed');
      expect(decorated.extensions).toMatchObject({ code: 'TRANSACTION_RETRY_EXCEEDED', status: 409, ...POSITION });
      expect(decorated.cause).toBe(wrappers[0]);
      expect(wrappers[0].extensions.operationIndex).toBeUndefined();
      expect(serialize(buildErrorFormatter()(result.errors[0])).extensions).toMatchObject({
        code: 'TRANSACTION_RETRY_EXCEEDED', status: 409, ...POSITION,
      });
    });

    // As the MongoDB and SQL adapters build them: getCause() returns the error the wrapper replaced.
    const withGetCause = (wrapper) => Object.assign(wrapper, { getCause: () => wrapper.cause });
    test.each([
      ['TRANSACTION_RETRY_EXCEEDED', (error) => withGetCause(retryExceeded(error))],
      ['DATABASE_ERROR', (error) => withGetCause(Object.assign(
        new SimfinityError('Database operation failed', 'DATABASE_ERROR', 500), { cause: error },
      ))],
    ])('%s keeps getCause(), which returns what the wrapper\'s own getCause() returns', async (code, wrap) => {
      const fixture = build();
      const driver = transientError(SECRET);
      failBoom(fixture, () => driver);
      const wrappers = normalizing(fixture, wrap);
      const result = await fixture.transaction(OPERATIONS);

      const decorated = result.errors[0].originalError;
      expect(decorated).not.toBeInstanceOf(InternalServerError);
      expect(decorated.extensions).toMatchObject({ code, ...POSITION });
      expect(decorated.cause).toBe(wrappers[0]);
      expect(decorated.getCause()).toBe(driver);
      // It reads the wrapper when it is called.
      const replaced = new Error('replaced');
      wrappers[0].cause = replaced;
      expect(decorated.getCause()).toBe(replaced);
      expect(JSON.stringify(buildErrorFormatter()(result.errors[0]))).not.toContain('hunter2');
    });

    test('a SimfinityError without getCause() gives a decoration without it', async () => {
      const fixture = build();
      failBoom(fixture, () => transientError());
      normalizing(fixture, retryExceeded);
      const result = await fixture.transaction(OPERATIONS);

      expect(result.errors[0].originalError.getCause).toBeUndefined();
    });

    test('a wrapper of a wrapper is followed to the operation error', async () => {
      const fixture = build();
      failBoom(fixture, () => transientError());
      normalizing(fixture, (error) => retryExceeded(retryExceeded(error)));
      const result = await fixture.transaction(OPERATIONS);

      expect(result.errors[0].originalError.extensions).toMatchObject({ code: 'TRANSACTION_RETRY_EXCEEDED', ...POSITION });
    });

    test('a driver error masked as DATABASE_ERROR keeps that code, is not hidden as unexpected and gets the position', async () => {
      const fixture = build();
      const driver = new Error(SECRET);
      failBoom(fixture, () => driver);
      normalizing(fixture, (error) => Object.assign(
        new SimfinityError('Database operation failed', 'DATABASE_ERROR', 500), { cause: error },
      ), 1);
      const result = await fixture.transaction(OPERATIONS);

      const decorated = result.errors[0].originalError;
      expect(decorated).not.toBeInstanceOf(InternalServerError);
      expect(decorated.message).toBe('Database operation failed');
      expect(decorated.extensions).toMatchObject({ code: 'DATABASE_ERROR', status: 500, ...POSITION });
      expect(JSON.stringify(buildErrorFormatter()(result.errors[0]))).not.toContain('hunter2');
    });

    test('a wrapper whose cause is not the operation error of the final attempt carries no position', async () => {
      const fixture = build();
      failBoom(fixture, () => transientError());
      const wrappers = normalizing(fixture, () => retryExceeded(new Error('another error')));
      const result = await fixture.transaction(OPERATIONS);

      expect(result.errors[0].originalError).toBe(wrappers[0]);
      expect(result.errors[0].extensions.operationIndex).toBeUndefined();
    });

    test('a wrapper of the operation error of attempt 1 only carries no position', async () => {
      const fixture = build();
      const first = transientError('first');
      let seen = 0;
      fixture.hooks.middleware = ({ args }) => {
        if (args.input?.name === 'boom' && (seen += 1) === 1) throw first;
      };
      fixture.adapter.withTransaction.mockImplementation(async (session, body) => {
        await body({ memory: true, attempt: 1 }).catch(() => {});
        await body({ memory: true, attempt: 2 });
        throw retryExceeded(first);
      });
      const result = await fixture.transaction(OPERATIONS);

      expect(result.errors[0].originalError.extensions.code).toBe('TRANSACTION_RETRY_EXCEEDED');
      expect(result.errors[0].extensions.operationIndex).toBeUndefined();
    });
  });

  test('the memory adapter itself reports the operation error unchanged after its last attempt', async () => {
    const fixture = build({ adapterOptions: { attempts: 2 } });
    const error = transientError('still failing');
    failBoom(fixture, () => error);
    const result = await fixture.transaction(OPERATIONS);

    const decorated = result.errors[0].originalError;
    expect(decorated.message).toBe('still failing');
    expect(decorated.extensions).toMatchObject({ code: 'INTERNAL_SERVER_ERROR', ...POSITION });
    expect(decorated.cause).toBe(error);
    expect(error.extensions).toBeUndefined();
  });
});
