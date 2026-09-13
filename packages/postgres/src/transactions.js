import { SimfinityError } from '@simtlix/simfinity-core';
import { normalizeDatabaseError } from './codecs.js';

export const createTransactions = (getPool, assertReady) => {
  const sessions = new WeakSet();
  const requireSession = (session) => {
    if (!sessions.has(session) || !session.inTransaction()) throw new SimfinityError('Session is not an active transaction of this PostgreSQL instance', 'INVALID_SESSION', 400);
    return session.client;
  };
  const withTransaction = async (session, body) => {
    assertReady();
    if (session) { requireSession(session); return body(session); }
    for (let attempt = 0; attempt <= 5; attempt++) {
      const client = await getPool().connect();
      let active = true;
      const handle = { client, inTransaction: () => active, query: (...args) => requireSession(handle).query(...args) };
      sessions.add(handle);
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
        const result = await body(handle);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        // Only confirmed aborted transactions are retried, never unknown commit outcomes.
        if (['40001', '40P01'].includes(error.code) && attempt < 5) continue;
        throw normalizeDatabaseError(error);
      } finally { active = false; sessions.delete(handle); client.release(); }
    }
  };
  return { withTransaction, requireSession };
};
