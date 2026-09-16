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
      sessions.add(handle);
      try {
        await driver.begin(client);
        const result = await body(handle);
        await driver.commit(client);
        return result;
      } catch (error) {
        await Promise.resolve().then(() => driver.rollback(client)).catch(() => {});
        // Only confirmed aborted transactions are retried, never unknown commit outcomes.
        if (driver.isRetryable(error) && attempt < 5) continue;
        throw driver.normalizeError(error);
      } finally { active = false; sessions.delete(handle); await driver.release(client); }
    }
  };
  return { withTransaction, requireSession };
};
