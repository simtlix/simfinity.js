import { SimfinityError } from '@simtlix/simfinity-core';
import { createTransactionCallbacks } from '@simtlix/simfinity-core/internal/transaction-callbacks';
import { callDriver, isDriverFailure, isRetryableFailure, normalizeFailure } from './errors.js';

// Full-jitter exponential backoff before each retry, as for MongoDB: a uniform wait below
// 10, 20, 40, 80 and 160 ms, so conflicting transactions do not retry in lock-step.
const RETRY_BASE_DELAY_MS = 10;
const retryDelay = (retry) => Math.random() * RETRY_BASE_DELAY_MS * 2 ** retry;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export const createTransactions = (getConfiguration, assertReady, plugin) => {
  const { driver } = plugin;
  const callbacks = createTransactionCallbacks();
  const sessions = new WeakSet();
  const requireSession = (session) => {
    if (!sessions.has(session) || !session.inTransaction()) throw new SimfinityError(`Session is not an active transaction of this ${plugin.displayName} instance`, 'INVALID_SESSION', 400);
    return session.client;
  };
  const withTransaction = async (session, body) => {
    assertReady();
    if (session) { requireSession(session); return body(session); }
    for (let attempt = 0; attempt <= 5; attempt++) {
      // Wait only once the failed attempt rolled back and released its client, so neither a pooled connection nor its locks are held meanwhile.
      if (attempt > 0) await sleep(retryDelay(attempt - 1));
      let client;
      try { client = await callDriver(() => driver.acquire(getConfiguration())); } catch (error) { throw normalizeFailure(driver, error); }
      let active = true;
      // The session check throws synchronously; a statement error reaches the body unchanged, so a savepoint can recover from it.
      const handle = { client, inTransaction: () => active, query: (text, values) => {
        const session = requireSession(handle);
        return callDriver(() => driver.query(getConfiguration(), { text, values }, session));
      } };
      // Invalidate before COMMIT/ROLLBACK is queued so late session work cannot run outside the transaction.
      const close = () => { active = false; sessions.delete(handle); };
      sessions.add(handle);
      const effects = callbacks.begin(handle);
      let rollbackError;
      try {
        await callDriver(() => driver.begin(client));
        let result;
        try { result = await body(handle); } finally { close(); effects.seal(); }
        await callDriver(() => driver.commit(client));
        effects.confirm();
        return result;
      } catch (error) {
        effects.discard();
        close();
        let rolledBack = true;
        try { await driver.rollback(client); } catch (failure) { rolledBack = false; rollbackError = failure ?? new Error('ROLLBACK failed'); }
        // Only confirmed aborts that rolled back are retried, never unknown commit or rollback outcomes.
        if (rolledBack && isRetryableFailure(driver, error) && attempt < 5) continue;
        // The plugin maps its engine's errors; a failed driver call it leaves unchanged is masked, and
        // any other error the body threw propagates unchanged.
        throw normalizeFailure(driver, error);
      } finally {
        close();
        try { await driver.release(client, rollbackError); } finally { await effects.drain(); }
      }
    }
  };
  // A read that one statement answers needs no transaction when the plugin advertises
  // `singleStatementReads`: it runs on one acquired connection without begin and commit. A confirmed
  // abort is retried with the backoff and limit of an owned transaction, without a rollback step, and
  // every failure is normalized the same way.
  const connections = new WeakSet();
  const withConnection = async (body) => {
    assertReady();
    for (let attempt = 0; attempt <= 5; attempt++) {
      if (attempt > 0) await sleep(retryDelay(attempt - 1));
      let client;
      try { client = await callDriver(() => driver.acquire(getConfiguration())); } catch (error) { throw normalizeFailure(driver, error); }
      // An internal handle, never a session: withTransaction and user code reject it.
      const handle = { client };
      connections.add(handle);
      let probeError;
      try { return await body(handle); } catch (error) {
        connections.delete(handle);
        const retryable = isRetryableFailure(driver, error);
        // A confirmed abort comes from a connection that answered, and an error raised before any statement,
        // such as an invalid ID, leaves the connection untouched. After any other driver failure, such as a
        // terminated backend, rollback probes the connection as after a failed statement in a transaction
        // (PostgreSQL only warns outside one), and a failed probe reaches release, which discards the connection.
        if (!retryable && isDriverFailure(error)) {
          try { await driver.rollback(client); } catch (failure) { probeError = failure ?? new Error('ROLLBACK failed'); }
        }
        if (retryable && attempt < 5) continue;
        throw normalizeFailure(driver, error);
      } finally {
        connections.delete(handle);
        await (probeError === undefined ? driver.release(client) : driver.release(client, probeError));
      }
    }
  };
  // Record statements run on a transaction session or on the connection of a single-statement read.
  const clientOf = (session) => (connections.has(session) ? session.client : requireSession(session));
  return { withTransaction, withConnection, clientOf, requireSession, enqueueAfterCommit: callbacks.enqueue };
};
