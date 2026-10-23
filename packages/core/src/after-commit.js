import SimfinityError from './errors/simfinity.error.js';

const callbackNames = {
  save: 'onSaveCommitted', update: 'onUpdateCommitted', delete: 'onDeleteCommitted',
  state_changed: 'onTransitionCommitted',
};

// Copy ordinary values without JSON coercion, preserving opaque custom scalar instances.
const snapshot = (value, copies = new Map()) => {
  if (!value || typeof value !== 'object') return value;
  if (copies.has(value)) return copies.get(value);
  if (value instanceof Date) return new Date(value.getTime());
  const prototype = Object.getPrototypeOf(value);
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return value;
  const copy = Array.isArray(value) ? [] : Object.create(prototype);
  copies.set(value, copy);
  for (const [key, entry] of Object.entries(value)) {
    Object.defineProperty(copy, key, { value: snapshot(entry, copies), writable: true, enumerable: true, configurable: true });
  }
  return copy;
};

const reportFailure = (typeName, operation, callbackName) => {
  // Never log the record, request, or arbitrary error contents by default.
  try { console.error('After-commit callback failed', { typeName, operation, callbackName }); } catch { /* Best effort. */ }
};

export const createAfterCommit = (adapter) => {
  let onError;
  const warned = new Set();
  const configure = (options = {}) => {
    if (!options || typeof options !== 'object' || Array.isArray(options)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(options))
      || Reflect.ownKeys(options).some((key) => key !== 'onError')
      || (options.onError !== undefined && typeof options.onError !== 'function')) {
      throw new SimfinityError('Invalid after-commit configuration', 'INVALID_AFTER_COMMIT_OPTIONS', 400);
    }
    onError = options.onError;
  };
  const validate = (controller) => {
    for (const name of Object.values(callbackNames)) {
      const callback = controller?.[name];
      if (callback == null) continue;
      if (typeof callback !== 'function') {
        throw new SimfinityError(`${name} must be a function`, 'INVALID_CONTROLLER', 400);
      }
      if (typeof adapter.enqueueAfterCommit !== 'function') {
        throw new SimfinityError('The adapter does not support after-commit callbacks', 'UNSUPPORTED_AFTER_COMMIT', 500);
      }
    }
  };
  const queue = ({ typeName, controller, operation, record, args, context, session, action }) => {
    const callbackName = callbackNames[operation];
    const callback = controller?.[callbackName];
    if (!callback || record == null) return;
    validate(controller);
    const reporter = onError;
    let payload;
    const accepted = adapter.enqueueAfterCommit(session, async () => {
      try {
        let values = [payload.record, context];
        if (operation === 'save') values = [payload.record, payload.args, context];
        if (operation === 'state_changed') values = [payload.record, action, context];
        await callback.apply(controller, values);
      } catch (error) {
        if (reporter) {
          try {
            await reporter(error, { committed: true, typeName, operation, callbackName, context });
            return;
          } catch { /* The reporter cannot fail the committed operation either. */ }
        }
        reportFailure(typeName, operation, callbackName);
      }
    });
    if (accepted) {
      payload = { record: snapshot(adapter.toObject(record)), args: operation === 'save' ? snapshot(args) : undefined };
    } else if (!warned.has(typeName)) {
      warned.add(typeName);
      try { console.warn(`After-commit callbacks for ${typeName} skipped: this adapter does not own the transaction`); } catch { /* Best effort. */ }
    }
  };
  return { configure, validate, queue };
};
