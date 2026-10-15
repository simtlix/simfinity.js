import { SimfinityError } from '@simtlix/simfinity-core';
import { READ_OPTION_NAMES } from './read-options.js';
import { buildReadStages } from './pipeline-stages.js';

const READ_OPTIONS = new Set(['session', ...READ_OPTION_NAMES]);
const FETCH_METHODS = ['_initialize', 'getMore'];

// Always await cleanup. A failed read keeps its exact rejection (including a
// non-Error value); a close failure propagates when the read itself succeeded.
const finishCursor = async (close, readFailure) => {
  const [cleanup] = await Promise.allSettled([Promise.resolve().then(close)]);
  if (readFailure) {
    throw readFailure.reason;
  }
  if (cleanup.status === 'rejected') {
    throw cleanup.reason;
  }
};

const createTracker =
  (observer, close) =>
  (body, cleanup = false) => {
    let trackingFailure;
    const promise = Promise.resolve().then(() => {
      if (trackingFailure) {
        return finishCursor(close, trackingFailure);
      }
      return body();
    });
    try {
      observer.track?.(promise);
    } catch (reason) {
      // Cleanup must still run if the observer refuses to track its promise.
      if (!cleanup) {
        trackingFailure = { reason };
      }
    }
    return promise;
  };

const observeFetches = (cursor, observer, track) => {
  for (const method of FETCH_METHODS) {
    const original = cursor[method];
    cursor[method] = function observedFetch(...args) {
      return track(async () => {
        await observer.beforeFetch?.();
        return original.apply(this, args);
      });
    };
  }
};

const iterateCursor = async function* (cursor) {
  let readFailure;
  try {
    for (;;) {
      const row = await cursor.next();
      if (row === null) {
        return;
      }
      yield row;
    }
  } catch (reason) {
    readFailure = { reason };
  } finally {
    await finishCursor(() => cursor.close(), readFailure);
  }
};

// This adapter owns driver-specific physical fetch observation: next() alone
// misses empty getMore batches consumed internally by the driver.
export const observeMongoCursor = (cursor, observer) => {
  if (!observer) {
    return cursor;
  }
  if (FETCH_METHODS.some((method) => typeof cursor[method] !== 'function')) {
    throw new SimfinityError(
      'MongoDB cursor does not support fetch observation',
      'UNSUPPORTED_CAPABILITY',
      500,
    );
  }
  const next = cursor.next.bind(cursor);
  const close = cursor.close.bind(cursor);
  const track = createTracker(observer, close);
  observeFetches(cursor, observer, track);
  let buffered = [];

  cursor.next = () =>
    track(async () => {
      try {
        await observer.beforeRead?.();
        if (buffered.length) {
          return buffered.shift();
        }
        const first = await next();
        if (first === null) {
          return null;
        }
        const batch = [first, ...cursor.readBufferedDocuments()];
        await observer.onRows?.(batch);
        buffered = [...batch];
        return buffered.shift();
      } catch (reason) {
        return finishCursor(close, { reason });
      }
    });
  cursor.close = () =>
    track(() => {
      buffered = [];
      return close();
    }, true);
  cursor[Symbol.asyncIterator] = () => iterateCursor(cursor);
  cursor.toArray = async () => {
    const rows = [];
    for await (const row of cursor) {
      rows.push(row);
    }
    return rows;
  };
  return cursor;
};

const assertReadOptions = (options) => {
  for (const key of Object.keys(options)) {
    if (!READ_OPTIONS.has(key)) {
      throw new SimfinityError('Unsupported read option: ' + key, 'INVALID_STORAGE_OPERATION', 400);
    }
  }
};

export const readMongoPipeline = (Model, pipeline, options, observer, stream = false) => {
  // Native cursors cannot safely bypass Mongoose aggregate authorization hooks.
  const hooks = Model.schema.s.hooks;
  if (hooks._pres.get('aggregate')?.length || hooks._posts.get('aggregate')?.length) {
    throw new SimfinityError(
      'Observed reads require a model without aggregate hooks',
      'UNSUPPORTED_CAPABILITY',
      400,
    );
  }
  assertReadOptions(options || {});
  const { projection, sort, skip, limit, ...nativeOptions } = options || {};
  const stages = [...pipeline, ...buildReadStages({ sort, skip, limit, projection })];
  const cursor = observeMongoCursor(Model.collection.aggregate(stages, nativeOptions), observer);
  return stream ? cursor : cursor.toArray();
};
