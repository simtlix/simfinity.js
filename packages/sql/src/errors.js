import { SimfinityError } from '@simtlix/simfinity-core';

// Failures of the driver calls SQL makes (acquire, begin, query, commit), so that a failed connection or
// statement is never confused with an error that application code throws inside a transaction.
const driverFailures = new WeakSet();
const isObject = (value) => value !== null && (typeof value === 'object' || typeof value === 'function');

/** Await a driver call and mark its failure as a database failure, keeping the error's identity. */
export const callDriver = async (call) => {
  try {
    return await call();
  } catch (error) {
    // Only objects can be marked; any other rejection value travels as the cause of a marked Error.
    const failure = isObject(error) ? error : new Error('Database driver failed', { cause: error });
    driverFailures.add(failure);
    throw failure;
  }
};

/** The plugin classifies only objects; a thrown null or primitive is never retried. */
export const isRetryableFailure = (driver, error) => isObject(error) && Boolean(driver.isRetryable(error));

// The plugin maps errors of its own engine and returns any other error unchanged. A driver call failure
// that it leaves unchanged, such as a refused or dropped connection, is still masked, keeping the
// original as its cause; every other error, such as one a controller throws, propagates unchanged.
export const normalizeFailure = (driver, error) => {
  if (!isObject(error) || error instanceof SimfinityError) return error;
  const normalized = driver.normalizeError(error);
  if (normalized !== error || !driverFailures.has(error)) return normalized;
  const failure = new SimfinityError('Database operation failed', 'DATABASE_ERROR', 500);
  // Kept for server logging, but non-enumerable as on a native Error, so serializing or spreading the
  // client-facing error never copies driver details such as a host and port.
  Object.defineProperty(failure, 'cause', { value: error, writable: true, configurable: true, enumerable: false });
  failure.getCause = () => failure.cause;
  return failure;
};
