import mongoose from 'mongoose';

import { SimfinityError } from '@simtlix/simfinity-core';

const MAX_TRANSIENT_RETRIES = 5;

export const withMongoTransaction = async (session, body) => {
  const ownsSession = !session;
  const mySession = session || await mongoose.startSession();
  try {
    for (let attempt = 0; attempt <= MAX_TRANSIENT_RETRIES; attempt++) {
      await mySession.startTransaction();
      try {
        const result = await body(mySession);
        await mySession.commitTransaction();
        return result;
      } catch (error) {
        await mySession.abortTransaction();
        const isTransient = error.errorLabels?.includes('TransientTransactionError');
        if (isTransient && attempt < MAX_TRANSIENT_RETRIES) continue;
        throw error;
      }
    }
    throw new SimfinityError(
      'Transaction exceeded retry limit',
      'TRANSACTION_RETRY_EXCEEDED',
      500,
    );
  } finally {
    if (ownsSession) mySession.endSession();
  }
};
