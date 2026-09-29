import { describe, expect, it, vi } from 'vitest';
import { createTransactions } from '../packages/sql/src/transactions.js';
import { bindPlugin } from '../packages/sql/src/plugin.js';
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
