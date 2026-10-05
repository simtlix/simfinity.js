import mongoose from 'mongoose';
import { SimfinityError } from '@simtlix/simfinity-core';

const MAX_TRANSIENT_RETRIES = 5;
const MAX_COMMIT_RETRIES = 5;
// Full-jitter exponential backoff before each complete-transaction retry: a uniform wait below
// 10, 20, 40, 80 and 160 ms, so conflicting transactions do not retry in lock-step.
const RETRY_BASE_DELAY_MS = 10;
const WRITE_CONFLICT = 112;

const retryDelay = (attempt) => Math.random() * RETRY_BASE_DELAY_MS * 2 ** attempt;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const isWriteConflict = (error) => error?.code === WRITE_CONFLICT || error?.codeName === 'WriteConflict';

// Same code and status as PostgreSQL's exhausted serialization and deadlock retries. The driver
// error stays available to logging, as on InternalServerError.
const retryExceeded = (error) => {
  const exceeded = new SimfinityError('Concurrent write could not be completed', 'TRANSACTION_RETRY_EXCEEDED', 409);
  exceeded.cause = error;
  exceeded.getCause = () => exceeded.cause;
  return exceeded;
};

const commitWithRetry = async (session) => {
  for (let attempt = 0; ; attempt++) {
    try {
      await session.commitTransaction();
      return;
    } catch (error) {
      const isUnknown = error?.errorLabels?.includes('UnknownTransactionCommitResult');
      const isExpired = error?.code === 50 || error?.writeConcernError?.code === 50;
      if (!isUnknown || isExpired || attempt >= MAX_COMMIT_RETRIES) {
        throw error;
      }
      // An uncertain commit can already have succeeded. Retry only the commit,
      // never the writes or hooks, even if this error also carries a transient label.
    }
  }
};

const endOwnedSession = async (session, failed) => {
  try {
    await session.endSession();
  } catch (error) {
    if (!failed) throw error;
  }
};

export const withMongoTransaction = async (session, body, model, transactionOptions) => {
  const connection = model?.db || mongoose.connection;
  if (session) {
    if (!session.inTransaction()) {
      throw new SimfinityError(
        'A supplied session must have an active transaction', 'ACTIVE_TRANSACTION_REQUIRED', 400,
      );
    }
    // The caller owns retries, commit, abort, and cleanup for a borrowed session.
    return body(session);
  }

  const mySession = connection === mongoose.connection
    ? await mongoose.startSession() : await connection.startSession();
  let failed = false;
  try {
    for (let attempt = 0; ; attempt++) {
      if (transactionOptions) await mySession.startTransaction(transactionOptions);
      else await mySession.startTransaction();
      try {
        const result = await body(mySession);
        await commitWithRetry(mySession);
        return result;
      } catch (error) {
        if (error?.errorLabels?.includes('UnknownTransactionCommitResult')) {
          throw error;
        }
        if (mySession.inTransaction()) {
          try {
            await mySession.abortTransaction();
          } catch {
            // Do not replace the operation error or retry on a session whose
            // previous transaction could not be aborted.
            throw error;
          }
        }
        if (!error?.errorLabels?.includes('TransientTransactionError')) throw error;
        if (attempt < MAX_TRANSIENT_RETRIES) {
          // Wait only once the failed attempt is aborted, so its locks are not held meanwhile.
          await sleep(retryDelay(attempt));
          continue;
        }
        // Other exhausted transient failures (network, NoSuchTransaction) are not concurrency.
        throw isWriteConflict(error) ? retryExceeded(error) : error;
      }
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await endOwnedSession(mySession, failed);
  }
};
