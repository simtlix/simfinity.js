import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GraphQLID, GraphQLInputObjectType, GraphQLNonNull, GraphQLObjectType, GraphQLString, graphql,
} from 'graphql';
import { createTransactions } from '../packages/sql/src/transactions.js';
import { bindPlugin } from '../packages/sql/src/plugin.js';
import { createSQL, SimfinityError } from '../packages/sql/src/index.js';
import { postgresPlugin } from '../packages/postgres/src/index.js';
import { initializeDatabase } from '../packages/postgres/src/schema/initialize.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A FIFO fake connection: the log records statements in the order the client would execute them.
const fakePlugin = (overrides = {}) => {
  const log = [];
  const client = { log };
  const driver = {
    assertConfiguration() {},
    acquire: vi.fn(async () => client),
    begin: vi.fn(async () => { log.push('BEGIN'); }),
    query: vi.fn(async (configuration, statement) => { log.push(statement.text); await delay(5); return { rows: [] }; }),
    commit: vi.fn(async () => { log.push('COMMIT'); await delay(20); }),
    rollback: vi.fn(async () => { log.push('ROLLBACK'); await delay(20); }),
    release: vi.fn(async () => {}),
    isRetryable: (error) => error.retryable === true,
    normalizeError: (error) => Object.assign(new Error(`normalized: ${error.message}`), { cause: error }),
    ...overrides,
  };
  const plugin = bindPlugin({
    apiVersion: 1, name: 'fake', displayName: 'Fake', defaultSchema: 'main', options: null, capabilities: ['transactions'],
    naming: { validateIdentifier() {}, generatedName: (...parts) => parts.join('_') },
    describeSchema() {}, initialize() {}, compileSchema() {}, compileQuery() {}, compileRecord() {},
    values: { createId() {}, castId() {}, encodeScalar() {}, decodeScalar() {}, encodeEmbedded() {} },
    driver,
  });
  return { client, log, driver, transactions: createTransactions(() => ({}), () => {}, plugin) };
};

// A zero jitter keeps retry tests immediate and deterministic.
beforeEach(() => { vi.spyOn(Math, 'random').mockReturnValue(0); });
// Restore spies before real timers, so a spy on a fake setTimeout is not left installed.
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('SQL withTransaction rollback failures', () => {
  it.each([
    ['rejected', (failure) => async () => { throw failure; }],
    ['thrown synchronously', (failure) => () => { throw failure; }],
  ])('releases the client with a %s rollback error and never retries that attempt', async (label, rollbackWith) => {
    const rollbackError = new Error('Query read timeout');
    const { client, driver, transactions } = fakePlugin();
    driver.rollback.mockImplementation(rollbackWith(rollbackError));
    const body = vi.fn(async () => { throw Object.assign(new Error('serialization failure'), { retryable: true }); });
    const failure = await transactions.withTransaction(null, body).catch((error) => error);
    expect(failure.message).toBe('normalized: serialization failure');
    expect(failure.cause).not.toBe(rollbackError);
    expect(body).toHaveBeenCalledOnce();
    expect(driver.acquire).toHaveBeenCalledOnce();
    expect(driver.release).toHaveBeenCalledOnce();
    expect(driver.release).toHaveBeenCalledWith(client, rollbackError);
  });

  it('releases without an error after a successful commit or rollback', async () => {
    const { client, driver, transactions } = fakePlugin();
    await transactions.withTransaction(null, async () => 'done');
    await expect(transactions.withTransaction(null, async () => { throw new Error('body failed'); })).rejects.toThrow('normalized: body failed');
    expect(driver.release.mock.calls.map(([released, error]) => [released, error])).toEqual([[client, undefined], [client, undefined]]);
  });

  it('still retries a confirmed abort whose rollback succeeded', async () => {
    const { driver, transactions } = fakePlugin();
    let attempts = 0;
    const result = await transactions.withTransaction(null, async () => {
      if (++attempts === 1) throw Object.assign(new Error('deadlock'), { retryable: true });
      return 'second attempt';
    });
    expect(result).toBe('second attempt');
    expect(driver.release.mock.calls.map(([, error]) => error)).toEqual([undefined, undefined]);
  });
});

describe('SQL withTransaction retry backoff', () => {
  // PostgreSQL's own classification and mapping, with no fake latency left in ROLLBACK or COMMIT,
  // so every setTimeout call is a retry wait and the log shows when it happens.
  const conflictPlugin = () => {
    const { isRetryable, normalizeError } = postgresPlugin().driver;
    const fake = fakePlugin({ isRetryable, normalizeError });
    const { client, log, driver } = fake;
    driver.acquire.mockImplementation(async () => { log.push('ACQUIRE'); return client; });
    driver.commit.mockImplementation(async () => { log.push('COMMIT'); });
    driver.rollback.mockImplementation(async () => { log.push('ROLLBACK'); });
    // Logged only once the release settles, so a wait that does not await it shows up first.
    driver.release.mockImplementation(async () => { await Promise.resolve(); log.push('RELEASE'); });
    const setTimeout = globalThis.setTimeout;
    const timer = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, ms) => { log.push(`WAIT ${ms}`); return setTimeout(callback, ms); });
    return { ...fake, timer };
  };
  const conflict = (code = '40001') => Object.assign(new Error('could not serialize access'), { code });

  it.each(['40001', '40P01'])('waits a full-jitter exponential backoff after release and before each %s retry', async (code) => {
    Math.random.mockReturnValue(0.5);
    vi.useFakeTimers();
    const { log, timer, transactions } = conflictPlugin();
    const body = vi.fn(async () => { throw conflict(code); });
    // Attach the expectation before running timers, so the rejection is never unhandled.
    const outcome = expect(transactions.withTransaction(null, body)).rejects.toMatchObject({
      message: 'Concurrent write could not be completed', extensions: { code: 'TRANSACTION_RETRY_EXCEEDED', status: 409 },
    });
    await vi.runAllTimersAsync();
    await outcome;
    expect(timer.mock.calls.map(([, ms]) => ms)).toEqual([5, 10, 20, 40, 80]);
    expect(body).toHaveBeenCalledTimes(6);
    const attempt = ['ACQUIRE', 'BEGIN', 'ROLLBACK', 'RELEASE'];
    expect(log).toEqual([5, 10, 20, 40, 80].flatMap((ms) => [...attempt, `WAIT ${ms}`]).concat(attempt));
  });

  it('commits a retry that clears after one wait', async () => {
    const { log, transactions } = conflictPlugin();
    let attempts = 0;
    const result = await transactions.withTransaction(null, async () => {
      if (++attempts === 1) throw conflict('40P01');
      return 'second attempt';
    });
    expect(result).toBe('second attempt');
    expect(log).toEqual(['ACQUIRE', 'BEGIN', 'ROLLBACK', 'RELEASE', 'WAIT 0', 'ACQUIRE', 'BEGIN', 'COMMIT', 'RELEASE']);
  });

  it('does not wait before rethrowing an error that is not retryable', async () => {
    const { log, timer, transactions } = conflictPlugin();
    const body = vi.fn(async () => { throw Object.assign(new Error('duplicate key'), { code: '23505', severity: 'ERROR' }); });
    await expect(transactions.withTransaction(null, body)).rejects.toMatchObject({ extensions: { code: 'DUPLICATE_KEY', status: 409 } });
    expect(body).toHaveBeenCalledOnce();
    expect(timer).not.toHaveBeenCalled();
    expect(log).toEqual(['ACQUIRE', 'BEGIN', 'ROLLBACK', 'RELEASE']);
  });

  it('does not wait or retry when ROLLBACK fails', async () => {
    const { client, driver, timer, transactions } = conflictPlugin();
    const rollbackError = new Error('ROLLBACK timed out');
    driver.rollback.mockRejectedValue(rollbackError);
    const body = vi.fn(async () => { throw conflict(); });
    await expect(transactions.withTransaction(null, body)).rejects.toMatchObject({ extensions: { code: 'TRANSACTION_RETRY_EXCEEDED' } });
    expect(body).toHaveBeenCalledOnce();
    expect(timer).not.toHaveBeenCalled();
    expect(driver.release).toHaveBeenCalledWith(client, rollbackError);
  });

  it('returns a borrowed-session conflict unchanged without retry, wait or rollback', async () => {
    const { log, timer, transactions } = conflictPlugin();
    const failure = conflict();
    const borrowed = vi.fn(async () => { throw failure; });
    await transactions.withTransaction(null, async (session) => {
      await expect(transactions.withTransaction(session, borrowed)).rejects.toBe(failure);
      expect(session.inTransaction()).toBe(true);
    });
    expect(borrowed).toHaveBeenCalledOnce();
    expect(timer).not.toHaveBeenCalled();
    expect(log).toEqual(['ACQUIRE', 'BEGIN', 'COMMIT', 'RELEASE']);
  });
});

describe('SQL withTransaction session lifetime', () => {
  it('rejects session statements issued while ROLLBACK is in flight', async () => {
    const { log, driver, transactions } = fakePlugin();
    let session;
    let lateBranch;
    driver.rollback.mockImplementation(async () => { expect(session.inTransaction()).toBe(false); log.push('ROLLBACK'); await delay(20); });
    const outcome = transactions.withTransaction(null, async (handle) => {
      session = handle;
      lateBranch = (async () => { await handle.query('UPDATE root'); await handle.query('DELETE owned'); })();
      await Promise.all([lateBranch, Promise.reject(new Error('sibling validation failed'))]);
    });
    await expect(outcome).rejects.toThrow('normalized: sibling validation failed');
    await expect(lateBranch).rejects.toMatchObject({ extensions: expect.objectContaining({ code: 'INVALID_SESSION' }) });
    expect(log).toEqual(['BEGIN', 'UPDATE root', 'ROLLBACK']);
    expect(() => transactions.requireSession(session)).toThrow('active transaction');
  });

  it('rejects un-awaited session statements issued while COMMIT is in flight', async () => {
    const { log, driver, transactions } = fakePlugin();
    let session;
    let pending;
    driver.commit.mockImplementation(async () => { expect(session.inTransaction()).toBe(false); log.push('COMMIT'); await delay(20); });
    const result = await transactions.withTransaction(null, async (handle) => {
      session = handle;
      pending = (async () => { await handle.query('SELECT probe'); return handle.query('INSERT late'); })();
      pending.catch(() => {});
      return 'returned early';
    });
    expect(result).toBe('returned early');
    await expect(pending).rejects.toMatchObject({ extensions: expect.objectContaining({ code: 'INVALID_SESSION' }) });
    expect(log).toEqual(['BEGIN', 'SELECT probe', 'COMMIT']);
    expect(driver.query).toHaveBeenCalledOnce();
  });

  it('keeps nested joins and in-body statements inside the transaction', async () => {
    const { log, transactions } = fakePlugin();
    await transactions.withTransaction(null, async (session) => {
      await session.query('INSERT outer');
      await transactions.withTransaction(session, (joined) => joined.query('INSERT nested'));
      expect(session.inTransaction()).toBe(true);
    });
    expect(log).toEqual(['BEGIN', 'INSERT outer', 'INSERT nested', 'COMMIT']);
  });

  it('keeps throwing INVALID_SESSION synchronously for a session statement issued after the callback settled', async () => {
    const { transactions } = fakePlugin();
    let session;
    await transactions.withTransaction(null, async (active) => { session = active; });
    expect(() => session.query('SELECT 1')).toThrow(expect.objectContaining({ extensions: expect.objectContaining({ code: 'INVALID_SESSION' }) }));
  });
});

describe('SQL error classification', () => {
  // PostgreSQL's own classification and mapping over a fake connection.
  const postgres = () => {
    const { isRetryable, normalizeError } = postgresPlugin().driver;
    return fakePlugin({ isRetryable, normalizeError });
  };
  class DomainError extends Error { code = 'PAYMENT_DECLINED'; }
  const refused = () => Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:5432'), { code: 'ECONNREFUSED', errno: -111, syscall: 'connect' });
  const serverError = (code, severity = 'ERROR') => Object.assign(new Error(`server message for ${code}`), { code, severity });
  const masked = { message: 'Database operation failed', extensions: { code: 'DATABASE_ERROR', status: 500 } };

  it.each([
    ['a domain error with a code', () => new DomainError('Card declined')],
    ['a Node system error', refused],
    ['a DOMException with a numeric code', () => new DOMException('The operation timed out', 'TimeoutError')],
    ['a Node programming error', () => { try { Buffer.from(undefined); } catch (error) { return error; } return null; }],
    ['an error with a SQLSTATE-like code but no severity', () => Object.assign(new Error('my duplicate'), { code: '23505' })],
  ])('rethrows %s from the transaction body unchanged, after rolling back', async (label, create) => {
    const { log, transactions } = postgres();
    const failure = create();
    await expect(transactions.withTransaction(null, async () => { throw failure; })).rejects.toBe(failure);
    expect(log).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it.each([null, undefined, 'failed', 0])('rethrows a thrown non-object value unchanged: %j', async (value) => {
    const { log, transactions } = postgres();
    const outcome = await transactions.withTransaction(null, async () => { throw value; }).then(() => 'resolved', (error) => ({ error }));
    expect(outcome).toEqual({ error: value });
    expect(log).toEqual(['BEGIN', 'ROLLBACK']);
  });

  // A third-party plugin may classify like 3.5.4's PostgreSQL driver, reading error.code without a guard.
  it.each([null, undefined, 'failed', 0])('never passes a thrown non-object value to the plugin classifiers: %j', async (value) => {
    const isRetryable = vi.fn((error) => ['40001', '40P01'].includes(error.code));
    const normalizeError = vi.fn((error) => (error.code === '23505' ? new Error('duplicate') : error));
    const { log, transactions } = fakePlugin({ isRetryable, normalizeError });
    const outcome = await transactions.withTransaction(null, async () => { throw value; }).then(() => 'resolved', (error) => ({ error }));
    expect(outcome).toEqual({ error: value });
    expect(log).toEqual(['BEGIN', 'ROLLBACK']);
    expect(isRetryable).not.toHaveBeenCalled();
    expect(normalizeError).not.toHaveBeenCalled();
  });

  it('maps a PostgreSQL error from a session statement and keeps the driver error as a non-enumerable cause', async () => {
    const { driver, transactions } = postgres();
    const failure = Object.assign(serverError('23505'), { detail: 'Key (email)=(alice@example.com) already exists.', constraint: 'item_email_key' });
    driver.query.mockRejectedValueOnce(failure);
    const error = await transactions.withTransaction(null, (session) => session.query('INSERT')).catch((caught) => caught);
    expect(error).toMatchObject({ message: 'Unique value already exists', extensions: { code: 'DUPLICATE_KEY', status: 409 } });
    expect(error.cause).toBe(failure);
    expect(error.getCause()).toBe(failure);
    expect(Object.keys(error)).not.toContain('cause');
    expect(JSON.stringify(error)).not.toMatch(/alice|item_email_key/);
  });

  it.each(['acquire', 'begin', 'query', 'commit'])('masks a %s failure that is not a PostgreSQL error and keeps it as the cause', async (step) => {
    const { driver, log, transactions } = postgres();
    const failure = refused();
    driver[step].mockRejectedValueOnce(failure);
    const body = vi.fn((session) => session.query('SELECT 1'));
    const error = await transactions.withTransaction(null, body).catch((caught) => caught);
    expect(error).toMatchObject(masked);
    expect(error.getCause()).toBe(failure);
    expect(Object.keys(error)).not.toContain('cause');
    expect(JSON.stringify(error)).not.toContain('10.1.2.3');
    expect(driver.release).toHaveBeenCalledTimes(step === 'acquire' ? 0 : 1);
    if (step === 'acquire') expect(body).not.toHaveBeenCalled();
    if (step === 'commit') expect(log).toEqual(['BEGIN', 'SELECT 1', 'ROLLBACK']);
  });

  it('maps a PostgreSQL error from acquire, such as too many connections, without running the body', async () => {
    const { driver, transactions } = postgres();
    const failure = serverError('53300', 'FATAL');
    driver.acquire.mockRejectedValueOnce(failure);
    const body = vi.fn();
    const error = await transactions.withTransaction(null, body).catch((caught) => caught);
    expect(error).toMatchObject(masked);
    expect(error.getCause()).toBe(failure);
    expect(body).not.toHaveBeenCalled();
    expect(driver.release).not.toHaveBeenCalled();
  });

  it('masks a driver rejection that is not an object and keeps the rejected value', async () => {
    const { driver, transactions } = postgres();
    driver.query.mockRejectedValueOnce('socket closed by proxy');
    const error = await transactions.withTransaction(null, (session) => session.query('SELECT 1')).catch((caught) => caught);
    expect(error).toMatchObject(masked);
    expect(error.getCause().cause).toBe('socket closed by proxy');
  });

  it('keeps the driver error of a session statement unchanged, so the body can recover through a savepoint', async () => {
    const { driver, log, transactions } = postgres();
    const failure = serverError('23505');
    const query = driver.query.getMockImplementation();
    driver.query.mockImplementation(async (configuration, statement) => {
      if (statement.text === 'INSERT duplicate') throw failure;
      return query(configuration, statement);
    });
    const result = await transactions.withTransaction(null, async (session) => {
      await session.query('SAVEPOINT recover');
      await expect(session.query('INSERT duplicate')).rejects.toBe(failure);
      await session.query('ROLLBACK TO SAVEPOINT recover');
      await session.query('INSERT second');
      return 'recovered';
    });
    expect(result).toBe('recovered');
    expect(log).toEqual(['BEGIN', 'SAVEPOINT recover', 'ROLLBACK TO SAVEPOINT recover', 'INSERT second', 'COMMIT']);
  });

  it('still retries an exhausted application conflict as TRANSACTION_RETRY_EXCEEDED', async () => {
    const { transactions } = postgres();
    const body = vi.fn(async () => { throw Object.assign(new Error('serialization failure'), { code: '40001' }); });
    await expect(transactions.withTransaction(null, body)).rejects.toMatchObject({ extensions: { code: 'TRANSACTION_RETRY_EXCEEDED', status: 409 } });
    expect(body).toHaveBeenCalledTimes(6);
  });
});

describe('SQL runtime error propagation', () => {
  class DomainError extends Error { code = 'PAYMENT_DECLINED'; }
  const refused = () => Object.assign(new Error('connect ECONNREFUSED 10.1.2.3:5432'), { code: 'ECONNREFUSED', errno: -111, syscall: 'connect' });
  // A pg.Pool stand-in whose connections answer every statement with no rows and commit; storage
  // initialization is skipped.
  const createRuntime = () => {
    const statements = [];
    const client = { query: vi.fn(async (text) => { statements.push(text); return { rows: [], rowCount: 0, command: text.split(' ')[0] }; }), release: vi.fn() };
    const pool = { connect: vi.fn(async () => client), query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
    const api = createSQL({ plugin: { ...postgresPlugin({ pool, schema: 'app' }), initialize: async () => ({ mode: 'validate', created: [] }) } });
    const Payment = new GraphQLObjectType({ name: 'ErrorPayment', fields: { id: { type: GraphQLID }, title: { type: GraphQLString } } });
    const controller = { onSaving: (record, args, session, context) => { if (Object.hasOwn(context, 'failure')) throw context.failure; } };
    api.connect(null, Payment, 'payment', 'payments', controller);
    const Input = new GraphQLInputObjectType({ name: 'ErrorChargeInput', fields: { title: { type: new GraphQLNonNull(GraphQLString) } } });
    api.registerMutation('charge', 'Charge', Input, Payment, async (args, session, context) => { throw context.failure; });
    const schema = api.createSchema();
    return { api, client, pool, schema, statements };
  };
  const add = (schema, contextValue = {}) => graphql({ schema, source: 'mutation{addpayment(input:{title:"x"}){id}}', contextValue });
  // A refused connection carries the host in its message; a dropped one carries no code at all.
  const connectionFailures = [
    ['a refused connection', refused],
    ['a dropped connection', () => new Error('Connection terminated unexpectedly')],
  ];
  const expectMasked = (error, failure) => {
    expect(error).toMatchObject({ message: 'Database operation failed', extensions: { code: 'DATABASE_ERROR', status: 500 } });
    expect(error.originalError.getCause()).toBe(failure);
    const serialized = JSON.stringify(error);
    for (const detail of ['10.1.2.3', failure.message]) expect(serialized).not.toContain(detail);
  };

  it.each([
    ['a domain error with a code', () => new DomainError('Card declined')],
    ['a Node system error', refused],
    ['a DOMException', () => new DOMException('The operation timed out', 'TimeoutError')],
    ['a SimfinityError', () => new SimfinityError('Card declined', 'PAYMENT_DECLINED', 402)],
  ])('propagates %s thrown by a controller, a custom mutation or withTransaction unchanged', async (label, create) => {
    const { api, schema, statements } = createRuntime();
    await api.initializeDatabase();
    for (const source of ['mutation{addpayment(input:{title:"x"}){id}}', 'mutation{charge(input:{title:"x"}){id}}']) {
      const failure = create();
      const result = await graphql({ schema, source, contextValue: { failure } });
      expect(result.errors[0].originalError).toBe(failure);
      expect(result.errors[0].message).toBe(failure.message);
    }
    const failure = create();
    await expect(api.withTransaction(null, async () => { throw failure; })).rejects.toBe(failure);
    expect(statements.filter((text) => text === 'ROLLBACK')).toHaveLength(3);
  });

  it('propagates a thrown null as a non-Error value instead of a TypeError', async () => {
    const { api, schema } = createRuntime();
    await api.initializeDatabase();
    const result = await add(schema, { failure: null });
    expect(result.errors[0].message).toBe('Unexpected error value: null');
  });

  it('masks a connection that cannot be acquired in mutations, queries and withTransaction, keeping the driver error as the cause', async () => {
    const { api, pool, schema } = createRuntime();
    await api.initializeDatabase();
    const failure = refused();
    pool.connect.mockRejectedValue(failure);
    for (const result of [await add(schema), await graphql({ schema, source: '{payments{id}}' })]) {
      expect(result.errors).toHaveLength(1);
      expectMasked(result.errors[0], failure);
    }
    const error = await api.withTransaction(null, async () => 'never').catch((caught) => caught);
    expect(error).toMatchObject({ extensions: { code: 'DATABASE_ERROR', status: 500 } });
    expect(error.getCause()).toBe(failure);
    expect(pool.query).not.toHaveBeenCalled();
  });

  // Count and aggregate statements run on the pool, outside any transaction.
  it.each(connectionFailures)('masks %s in count and aggregate statements, keeping the driver error as the cause', async (label, create) => {
    const { api, pool, schema } = createRuntime();
    await api.initializeDatabase();
    const failure = create();
    pool.query.mockRejectedValue(failure);
    for (const source of [
      '{payments(pagination:{page:1,size:1,count:true}){id}}',
      '{payments_aggregate(aggregation:{groupId:"title",facts:[{operation:COUNT,path:"id",factName:"n"}]}){groupId}}',
    ]) {
      const result = await graphql({ schema, source });
      expect(result.errors).toHaveLength(1);
      expectMasked(result.errors[0], failure);
    }
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it.each(connectionFailures)('masks %s in a find statement inside its transaction, keeping the driver error as the cause', async (label, create) => {
    const { api, client, schema, statements } = createRuntime();
    await api.initializeDatabase();
    const failure = create();
    const answer = client.query.getMockImplementation();
    client.query.mockImplementation(async (text, values) => {
      if (text.startsWith('SELECT')) throw failure;
      return answer(text, values);
    });
    const result = await graphql({ schema, source: '{payments{id}}' });
    expect(result.errors).toHaveLength(1);
    expectMasked(result.errors[0], failure);
    expect(statements).toEqual(['BEGIN ISOLATION LEVEL REPEATABLE READ', 'ROLLBACK']);
  });
});

describe('PostgreSQL connection release after rollback failures', () => {
  it('passes the release error to pg so the pool destroys the connection', () => {
    const client = { release: vi.fn() };
    const error = new Error('rollback failed');
    postgresPlugin().driver.release(client, error);
    expect(client.release).toHaveBeenCalledWith(error);
    postgresPlugin().driver.release(client);
    expect(client.release).toHaveBeenLastCalledWith(undefined);
  });

  it('releases the initialization client with the ROLLBACK error', async () => {
    const statementError = new Error('Query read timeout');
    const rollbackError = new Error('ROLLBACK timed out');
    const client = {
      query: vi.fn(async (text) => {
        if (text === 'ROLLBACK') throw rollbackError;
        if (text.startsWith('SET LOCAL search_path')) throw statementError;
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    await expect(initializeDatabase({ connect: async () => client }, { schema: 'app', tables: [] })).rejects.toBe(statementError);
    expect(client.release).toHaveBeenCalledOnce();
    expect(client.release).toHaveBeenCalledWith(rollbackError);
  });

  it('releases the initialization client normally after a successful ROLLBACK', async () => {
    const statementError = new Error('statement failed');
    const client = {
      query: vi.fn(async (text) => {
        if (text.startsWith('SET LOCAL search_path')) throw statementError;
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    await expect(initializeDatabase({ connect: async () => client }, { schema: 'app', tables: [] })).rejects.toBe(statementError);
    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalledOnce();
    expect(client.release.mock.calls[0][0]).toBeUndefined();
  });
});
