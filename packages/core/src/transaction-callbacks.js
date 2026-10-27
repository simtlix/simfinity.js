// The transaction owner creates a new queue for every attempt, even when the driver reuses the
// session. No session is adopted merely because it reports an active transaction.
export const createTransactionCallbacks = () => {
  const active = new WeakMap();
  const enqueue = (session, run) => {
    const jobs = active.get(session);
    if (!jobs) return false;
    jobs.push(run);
    return true;
  };
  const begin = (session) => {
    const jobs = [];
    let state = 'active';
    const detach = () => { if (active.get(session) === jobs) active.delete(session); };
    active.set(session, jobs);
    return {
      seal() { if (state === 'active') { state = 'sealed'; detach(); } },
      confirm() { if (state === 'sealed') state = 'confirmed'; },
      discard() { if (state !== 'confirmed' && state !== 'drained') { state = 'discarded'; detach(); jobs.length = 0; } },
      async drain() {
        if (state !== 'confirmed') return;
        state = 'drained';
        for (const run of jobs.splice(0)) {
          try { await run(); } catch {
            // Runtime jobs report their own failures. A faulty adapter consumer cannot change an
            // already committed result, stop later jobs, or enter the driver's retry classifier.
            try { console.error('After-commit callback failed'); } catch { /* Logging is best effort. */ }
          }
        }
      },
    };
  };
  return { begin, enqueue };
};
