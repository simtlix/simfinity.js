import { setTimeout } from 'node:timers/promises';

const transientStatus = (status) => status === 429 || (status >= 500 && status <= 599);

/**
 * Whether a failed registry or API read may succeed when repeated. Accepts an HTTP status,
 * an object carrying a numeric `status` (a Response, or an Error a caller tagged with the
 * status it received), or a thrown error. Only 429 and 5xx statuses, fetch's own network
 * failures ('fetch failed' before a response, 'terminated' when the body is cut off) and
 * aborts or timeouts are transient. Every other value, including 4xx, malformed bodies
 * and programming errors, is not.
 */
export const isTransientFailure = (failure) => {
  const status = typeof failure === 'number' ? failure : failure?.status;
  if (typeof status === 'number') return transientStatus(status);
  if (failure instanceof TypeError) return failure.message === 'fetch failed' || failure.message === 'terminated';
  return failure?.name === 'AbortError' || failure?.name === 'TimeoutError';
};

/**
 * An AbortSignal for one request: it fires after `timeoutMs`, or at `deadline` (epoch
 * milliseconds) when that comes first, so no request outlives an overall deadline.
 */
export const requestSignal = ({ deadline = Infinity, timeoutMs = 15000 } = {}) => (
  AbortSignal.timeout(Math.max(1, Math.min(timeoutMs, deadline - Date.now())))
);

/**
 * Call `fn({ attempt, signal })` until it resolves, at most `attempts` times, waiting
 * `delayMs` between calls. Only failures that `retryable` accepts (by default
 * isTransientFailure) are repeated; any other failure, the last attempt's failure, or a
 * failure after which the wait would pass `deadline` (epoch milliseconds) is rethrown
 * unchanged. `signal` times out after `timeoutMs` or at the deadline, whichever is
 * first, so with a deadline the whole call ends by it plus the time `fn` takes to
 * settle after its signal fires.
 */
export const retry = async (fn, { attempts = 3, delayMs = 1000, deadline = Infinity, timeoutMs = 15000, retryable = isTransientFailure } = {}) => {
  if (typeof fn !== 'function' || typeof retryable !== 'function') throw new TypeError('retry requires a function to call and a retryable predicate');
  if (!Number.isInteger(attempts) || attempts < 1 || !Number.isFinite(delayMs) || delayMs < 0
    || typeof deadline !== 'number' || Number.isNaN(deadline) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError('Invalid retry limits');
  }
  if (Date.now() >= deadline) throw new Error('The retry deadline has already passed');
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn({ attempt, signal: requestSignal({ deadline, timeoutMs }) });
    } catch (error) {
      if (attempt >= attempts || !retryable(error) || Date.now() + delayMs >= deadline) throw error;
    }
    await setTimeout(delayMs);
  }
};
