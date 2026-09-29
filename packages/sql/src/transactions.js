import { SimfinityError } from '@simtlix/simfinity-core';

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
