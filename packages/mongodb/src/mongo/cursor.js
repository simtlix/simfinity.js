import { SimfinityError } from '@simtlix/simfinity-core';

const closeAfterRead = async (cursor, failed) => {
  try { await cursor.close(); } catch (error) { if (!failed) throw error; }
};

// The supported observation boundary owns driver-specific fetch instrumentation. Watching next()
// alone misses empty getMore batches consumed inside the driver. Fail closed on an unknown driver.
export const observeMongoCursor = (cursor, observer) => {
  if (!observer) return cursor;
  if (typeof cursor._initialize !== 'function' || typeof cursor.getMore !== 'function') {
    throw new SimfinityError('MongoDB cursor does not support fetch observation', 'UNSUPPORTED_CAPABILITY', 500);
  }
  const track = (body) => {
    let trackingError;
    const promise = Promise.resolve().then(() => { if (trackingError) throw trackingError; return body(); });
    try { observer.track?.(promise); } catch (error) { trackingError = error; }
    return promise;
  };
  for (const method of ['_initialize', 'getMore']) {
    const original = cursor[method];
    cursor[method] = function observedFetch(...args) {
      return track(async () => { await observer.beforeFetch?.(); return original.apply(this, args); });
    };
  }
  const next = cursor.next.bind(cursor), close = cursor.close.bind(cursor);
  let buffered = [];
  cursor.next = () => track(async () => {
    try {
      await observer.beforeRead?.();
      if (buffered.length) return buffered.shift();
      const first = await next();
      if (first === null) return null;
      const batch = [first, ...cursor.readBufferedDocuments()];
      await observer.onRows?.(batch);
      buffered = [...batch];
      return buffered.shift();
    } catch (error) {
      try { await close(); } catch { /* Preserve the query failure. */ }
      throw error;
    }
  });
  cursor.close = () => track(() => { buffered = []; return close(); });
  cursor.toArray = async () => {
    const result = [];
    let failed = false;
    try {
      for (;;) {
        const row = await cursor.next();
        if (row === null) return result;
        result.push(row);
      }
    } catch (error) { failed = true; throw error; }
    finally { await closeAfterRead(cursor, failed); }
  };
  cursor[Symbol.asyncIterator] = async function* observedIterator() {
    let failed = false;
    try { for (;;) { const row = await cursor.next(); if (row === null) return; yield row; } }
    catch (error) { failed = true; throw error; }
    finally { await closeAfterRead(cursor, failed); }
  };
  return cursor;
};

export const readMongoPipeline = (Model, pipeline, options, observer, stream = false) => {
  // Observed reads intentionally use the native cursor. Silently bypassing model hooks would
  // change authorization; reject a hooked model instead. Ordinary unobserved reads retain hooks.
  if (Model.schema.s.hooks._pres.get('aggregate')?.length || Model.schema.s.hooks._posts.get('aggregate')?.length) {
    throw new SimfinityError('Observed reads require a model without aggregate hooks', 'UNSUPPORTED_CAPABILITY', 400);
  }
  const allowed = ['session', 'projection', 'sort', 'skip', 'limit', 'batchSize', 'collation', 'hint', 'maxTimeMS', 'timeoutMS', 'timeoutMode', 'signal', 'allowDiskUse', 'readConcern'];
  for (const key of Object.keys(options || {})) {
    if (!allowed.includes(key)) throw new SimfinityError('Unsupported read option: ' + key, 'INVALID_STORAGE_OPERATION', 400);
  }
  const { projection, sort, skip, limit, ...nativeOptions } = options || {};
  const stages = [...pipeline];
  if (sort) stages.push({ $sort: sort });
  if (skip) stages.push({ $skip: skip });
  if (limit) stages.push({ $limit: limit });
  if (projection) stages.push({ $project: projection });
  const cursor = observeMongoCursor(Model.collection.aggregate(stages, nativeOptions), observer);
  return stream ? cursor : cursor.toArray();
};
