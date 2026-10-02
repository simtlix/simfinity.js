/** Internal: true for promises and other values that `await` would wait for. */
export const isThenable = value => value !== null && (typeof value === 'object' || typeof value === 'function')
  && typeof value.then === 'function';

/**
 * Internal: handle a native promise from any realm whose result is never used, so its rejection
 * cannot crash the process. The built-in then() is called directly: it throws for anything that is
 * not a native promise without running its code, and skips an overriding then(). Other thenables are
 * left untouched, because calling their then() can start work, such as a lazy query builder.
 */
export const discardThenable = (value) => {
  try {
    Promise.prototype.then.call(value, undefined, () => {});
  } catch {
    // Not a native promise: there is no rejection to handle without running its own then().
  }
};
