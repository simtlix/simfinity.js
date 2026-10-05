import { SimfinityError } from '@simtlix/simfinity-core';

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
      const client = await driver.acquire(getConfiguration());
      let active = true;
      const handle = { client, inTransaction: () => active, query: (text, values) => driver.query(getConfiguration(), { text, values }, requireSession(handle)) };
      // Invalidate before COMMIT/ROLLBACK is queued so late session work cannot run outside the transaction.
      const close = () => { active = false; sessions.delete(handle); };
      sessions.add(handle);
      let rollbackError;
      try {
        await driver.begin(client);
        let result;
        try { result = await body(handle); } finally { close(); }
        await driver.commit(client);
        return result;
      } catch (error) {
        close();
        let rolledBack = true;
        try { await driver.rollback(client); } catch (failure) { rolledBack = false; rollbackError = failure ?? new Error('ROLLBACK failed'); }
        // Only confirmed aborts that rolled back are retried, never unknown commit or rollback outcomes.
        if (rolledBack && driver.isRetryable(error) && attempt < 5) continue;
        throw driver.normalizeError(error);
      } finally { close(); await driver.release(client, rollbackError); }
    }
  };
  return { withTransaction, requireSession };
};
