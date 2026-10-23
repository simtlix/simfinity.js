import { describe, expect, it, vi } from 'vitest';
import { createTransactionCallbacks } from '../packages/core/src/transaction-callbacks.js';

describe('transaction callback ownership', () => {
  it('discards an aborted attempt even when the next attempt reuses its session', async () => {
    const callbacks = createTransactionCallbacks();
    const session = {};
    const events = [];
    const failed = callbacks.begin(session);
    expect(callbacks.enqueue(session, () => events.push('aborted'))).toBe(true);
    failed.discard();
    const committed = callbacks.begin(session);
    callbacks.enqueue(session, () => events.push('confirmed'));
    committed.seal();
    committed.confirm();
    await failed.drain();
    await committed.drain();
    await committed.drain();
    expect(events).toEqual(['confirmed']);
  });

  it('accepts only the active owned attempt and waits for confirmation', async () => {
    const callbacks = createTransactionCallbacks();
    const session = {};
    const run = vi.fn();
    expect(callbacks.enqueue(session, run)).toBe(false);
    const attempt = callbacks.begin(session);
    callbacks.enqueue(session, run);
    await attempt.drain();
    expect(run).not.toHaveBeenCalled();
    attempt.seal();
    expect(callbacks.enqueue(session, run)).toBe(false);
    await attempt.drain();
    expect(run).not.toHaveBeenCalled();
    attempt.discard();
    attempt.confirm();
    await attempt.drain();
    expect(run).not.toHaveBeenCalled();
  });

  it('drains sequentially once, permitting a callback to run an independent attempt', async () => {
    const callbacks = createTransactionCallbacks();
    const session = {};
    const events = [];
    const outer = callbacks.begin(session);
    callbacks.enqueue(session, async () => {
      events.push('first');
      const inner = callbacks.begin(session);
      callbacks.enqueue(session, () => events.push('inner'));
      inner.seal();
      inner.confirm();
      await inner.drain();
      events.push('first-end');
    });
    callbacks.enqueue(session, () => events.push('second'));
    outer.seal();
    outer.confirm();
    await Promise.all([outer.drain(), outer.drain()]);
    expect(events).toEqual(['first', 'inner', 'first-end', 'second']);
  });

  it('continues after an unguarded task rejects even if fallback logging fails', async () => {
    const callbacks = createTransactionCallbacks();
    const session = {};
    const events = [];
    const attempt = callbacks.begin(session);
    callbacks.enqueue(session, async () => { throw null; });
    callbacks.enqueue(session, () => events.push('next'));
    const logger = vi.spyOn(console, 'error').mockImplementation(() => { throw new Error('logger'); });
    try {
      attempt.seal();
      attempt.confirm();
      await expect(attempt.drain()).resolves.toBeUndefined();
      expect(events).toEqual(['next']);
    } finally { logger.mockRestore(); }
  });
});
