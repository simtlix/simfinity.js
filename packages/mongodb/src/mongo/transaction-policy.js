import { SimfinityError } from '@simtlix/simfinity-core';

const TRANSIENT = 'TransientTransactionError';
const UNKNOWN_COMMIT = 'UnknownTransactionCommitResult';
const MAX_BUSINESS_TIMEOUT_MS = 45_000;
class UnknownCommitOutcome extends Error {}

const hasLabel = (error, label) => {
  if (error === null || typeof error !== 'object') return false;
  return typeof error.hasErrorLabel === 'function' && error.hasErrorLabel(label) === true;
};

/** Own sessions or adopt an active same-client transaction without taking its lifecycle. */
export class MongoTransactionPolicy {
  constructor(client, options = {}) {
    this.client = client;
    this.hooks = options;
    this.timeoutMs = options.businessTimeoutMs ?? 5_000;
    this.maximumCommitAttempts = options.maximumCommitAttempts ?? 3;
    this.now = options.now ?? Date.now;
  }

  assertBorrowed(session) {
    if (!session || typeof session.inTransaction !== 'function' || !session.inTransaction()) {
      throw new Error('An active MongoDB transaction is required');
    }
    if (session.client !== this.client()) {
      throw new Error('Borrowed MongoDB session belongs to another client');
    }
  }

  async runAdopted(session, work) {
    this.assertBorrowed(session);
    return work(session);
  }

  async waitForRetry(attempt, deadline) {
    const delay = Math.max(1, Math.ceil(Math.random() * Math.min(5 * 1.5 ** attempt, 500)));
    if (this.now() + delay >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, delay));
    return this.now() < deadline;
  }

  async commit(session, deadline) {
    let uncertain = false;
    for (let attempt = 1; ; attempt += 1) {
      try {
        const work = () => session.commitTransaction();
        if (this.hooks.commit) await this.hooks.commit(work, attempt);
        else await work();
        return;
      } catch (error) {
        uncertain ||= hasLabel(error, UNKNOWN_COMMIT);
        if (!uncertain) throw error;
        if (attempt < this.maximumCommitAttempts && this.now() < deadline) continue;
        throw new UnknownCommitOutcome('Transaction commit outcome is unknown', { cause: error });
      }
    }
  }

  transactionTimeout(options) {
    const timeoutMs = options?.businessTimeoutMs ?? this.timeoutMs;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_BUSINESS_TIMEOUT_MS) {
      throw new Error('A business transaction requires a bounded timeout of at most 45 seconds');
    }
    return timeoutMs;
  }

  async recoverAbortedAttempt(session, error, attempt, deadline, settleRejection) {
    if (session.inTransaction()) await session.abortTransaction();
    if (settleRejection) await this.hooks.afterRollback?.(error);
    const retry = hasLabel(error, TRANSIENT) && await this.waitForRetry(attempt, deadline);
    if (!retry) throw error;
    return { retry: true };
  }

  unknownCommitError(error) {
    return this.hooks.unknownCommit?.(error.cause) ?? new SimfinityError(
      error.message, 'TRANSACTION_OUTCOME_UNKNOWN', 500, { cause: error.cause },
    );
  }

  async runAttempt(session, work, attempt, deadline) {
    session.startTransaction({
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
      readPreference: 'primary',
      maxCommitTimeMS: Math.max(1, deadline - this.now()),
    });
    let value;
    try {
      value = await work(session);
      if (this.now() >= deadline) throw new Error('MongoDB business transaction exceeded its deadline');
    } catch (error) {
      return this.recoverAbortedAttempt(session, error, attempt, deadline, true);
    }
    try {
      await this.commit(session, deadline);
    } catch (error) {
      if (error instanceof UnknownCommitOutcome) throw this.unknownCommitError(error);
      return this.recoverAbortedAttempt(session, error, attempt, deadline, false);
    }
    return { retry: false, value };
  }

  async runOwned(work, options) {
    const timeoutMs = this.transactionTimeout(options);
    const session = this.client().startSession();
    const deadline = this.now() + timeoutMs;
    try {
      for (let attempt = 1; ; attempt += 1) {
        const result = await this.runAttempt(session, work, attempt, deadline);
        if (!result.retry) return result.value;
      }
    } finally {
      await session.endSession();
    }
  }
}
