import mongoose from 'mongoose';
import { SimfinityError } from '@simtlix/simfinity-core';

const MAX_TRANSIENT_RETRIES = 5;
const MAX_COMMIT_RETRIES = 5;

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
    for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
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
        const isTransient = error?.errorLabels?.includes('TransientTransactionError');
        if (isTransient && attempt < MAX_TRANSIENT_RETRIES) {
          continue;
        }
        throw error;
      }
    }
    throw new SimfinityError('Transaction exceeded retry limit', 'TRANSACTION_RETRY_EXCEEDED', 500);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    await endOwnedSession(mySession, failed);
  }
};
