import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTransactionCallbacks } from '../packages/core/src/transaction-callbacks.js';
import { withMongoTransaction } from '../packages/mongodb/src/mongo/transactions.js';
import { createTransactions } from '../packages/sql/src/transactions.js';

beforeEach(() => { vi.spyOn(Math, 'random').mockReturnValue(0); });
afterEach(() => { vi.restoreAllMocks(); });

const transient = () => Object.assign(new Error('retry'), {
  errorLabels: ['TransientTransactionError'], retryable: true,
});
const setup = (backend) => {
  const events = [];
  let active = false;
  const commit = vi.fn(async () => { events.push('commit'); active = false; });
  const cleanup = vi.fn(async () => { events.push('cleanup'); });
  const rollback = vi.fn(async () => { events.push('rollback'); active = false; });
  if (backend === 'mongo') {
    const queue = createTransactionCallbacks();
    const session = {
      startTransaction: () => { active = true; }, inTransaction: () => active,
      commitTransaction: commit, abortTransaction: rollback, endSession: cleanup,
    };
    const model = { db: { startSession: async () => session } };
    return { events, commit, cleanup, rollback, enqueue: queue.enqueue,
      run: (body, supplied) => withMongoTransaction(supplied, body, model, undefined, queue) };
  }
  const driver = {
    acquire: async () => ({}), begin: async () => {}, commit, rollback, release: cleanup,
    isRetryable: (error) => error?.retryable === true, normalizeError: (error) => error,
  };
  const tx = createTransactions(() => ({}), () => {}, { driver, displayName: 'Test SQL' });
  return { events, commit, cleanup, rollback, enqueue: (session, run) => tx.enqueueAfterCommit(session, run),
    run: (body, supplied) => tx.withTransaction(supplied, body) };
};

describe.each(['mongo', 'sql'])('%s after-commit transaction boundary', (backend) => {
  it('drains nested joins after commit and cleanup, preserving the result', async () => {
    const tx = setup(backend);
    const result = await tx.run(async (session) => {
      await tx.run(async (joined) => {
        expect(joined).toBe(session);
        expect(tx.enqueue(joined, () => tx.events.push('child'))).toBe(true);
      }, session);
      expect(tx.events).toEqual([]);
      tx.enqueue(session, () => tx.events.push('parent'));
      return 'result';
    });
    expect(result).toBe('result');
    expect(tx.events).toEqual(['commit', 'cleanup', 'child', 'parent']);
  });

  it.each(['body', 'commit'])('discards the queue of a retryable %s failure', async (where) => {
    const tx = setup(backend);
    let attempts = 0;
    if (where === 'commit') tx.commit.mockRejectedValueOnce(transient());
    await tx.run(async (session) => {
      const n = ++attempts;
      tx.enqueue(session, () => tx.events.push(`effect-${n}`));
      if (where === 'body' && n === 1) throw transient();
    });
    expect(attempts).toBe(2);
    expect(tx.events.filter((event) => event.startsWith('effect'))).toEqual(['effect-2']);
    expect(tx.events.slice(-3)).toEqual(['commit', 'cleanup', 'effect-2']);
  });

  it('discards failed and exhausted attempts', async () => {
    const tx = setup(backend);
    let attempts = 0;
    await expect(tx.run(async (session) => {
      attempts++;
      tx.enqueue(session, () => tx.events.push('effect'));
      throw transient();
    })).rejects.toBeDefined();
    expect(attempts).toBe(6);
    expect(tx.events).not.toContain('effect');
  });

  it('drains a confirmed commit despite cleanup failure, keeping that error', async () => {
    const tx = setup(backend);
    const failure = new Error('cleanup');
    tx.cleanup.mockRejectedValueOnce(failure);
    await expect(tx.run(async (session) => {
      tx.enqueue(session, () => tx.events.push('effect'));
    })).rejects.toBe(failure);
    expect(tx.events).toEqual(['commit', 'effect']);
    expect(tx.rollback).not.toHaveBeenCalled();
  });

  it('cannot retry or roll back a confirmed write because an effect throws', async () => {
    const tx = setup(backend);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let attempts = 0;
    await expect(tx.run(async (session) => {
      attempts++;
      tx.enqueue(session, () => { throw transient(); });
      tx.enqueue(session, () => tx.events.push('next'));
      return 42;
    })).resolves.toBe(42);
    expect(attempts).toBe(1);
    expect(tx.events).toEqual(['commit', 'cleanup', 'next']);
    expect(tx.rollback).not.toHaveBeenCalled();
  });

  it('does not retry or dispatch when rollback fails', async () => {
    const tx = setup(backend);
    tx.rollback.mockRejectedValueOnce(new Error('rollback'));
    let attempts = 0;
    await expect(tx.run(async (session) => {
      attempts++;
      tx.enqueue(session, () => tx.events.push('effect'));
      throw transient();
    })).rejects.toBeDefined();
    expect(attempts).toBe(1);
    expect(tx.events).not.toContain('effect');
  });
});

describe('MongoDB uncertain commits', () => {
  it.each([false, true])('dispatches only after confirmation (exhausted=%s)', async (exhausted) => {
    const tx = setup('mongo');
    const unknown = Object.assign(transient(), { errorLabels: ['UnknownTransactionCommitResult', 'TransientTransactionError'] });
    if (exhausted) tx.commit.mockRejectedValue(unknown);
    else tx.commit.mockRejectedValueOnce(unknown);
    let attempts = 0;
    const result = tx.run(async (session) => {
      attempts++;
      tx.enqueue(session, () => tx.events.push('effect'));
      return 'ok';
    });
    if (exhausted) await expect(result).rejects.toBe(unknown);
    else await expect(result).resolves.toBe('ok');
    expect(attempts).toBe(1);
    expect(tx.events.filter((event) => event === 'effect')).toHaveLength(exhausted ? 0 : 1);
    expect(tx.rollback).not.toHaveBeenCalled();
  });
});
