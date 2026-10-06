import { SimfinityError } from '@simtlix/simfinity-core';
import { callDriver, isRetryableFailure, normalizeFailure } from './errors.js';

// Full-jitter exponential backoff before each retry, as for MongoDB: a uniform wait below
// 10, 20, 40, 80 and 160 ms, so conflicting transactions do not retry in lock-step.
const RETRY_BASE_DELAY_MS = 10;
const retryDelay = (retry) => Math.random() * RETRY_BASE_DELAY_MS * 2 ** retry;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export const createTransactions = (getConfiguration, assertReady, plugin) => {
  const { driver } = plugin;
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
      let rollbackError;
      try {
        await callDriver(() => driver.begin(client));
        let result;
        try { result = await body(handle); } finally { close(); }
        await callDriver(() => driver.commit(client));
        return result;
      } catch (error) {
        close();
        let rolledBack = true;
        try { await driver.rollback(client); } catch (failure) { rolledBack = false; rollbackError = failure ?? new Error('ROLLBACK failed'); }
        // Only confirmed aborts that rolled back are retried, never unknown commit or rollback outcomes.
        if (rolledBack && isRetryableFailure(driver, error) && attempt < 5) continue;
        // The plugin maps its engine's errors; a failed driver call it leaves unchanged is masked, and
        // any other error the body threw propagates unchanged.
        throw normalizeFailure(driver, error);
      } finally { close(); await driver.release(client, rollbackError); }
    }
  };
  return { withTransaction, requireSession };
};
