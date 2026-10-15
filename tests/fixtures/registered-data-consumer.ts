import { configureIntrospection, createRuntime, type ExecuteOptions } from '@simtlix/simfinity-core';
import { createMongoAdapter, type MongoStorageRequest } from '@simtlix/simfinity-js';
configureIntrospection({ fieldExtensions: false });
const runtime = createRuntime(createMongoAdapter());
runtime.configureIntrospection({ fieldExtensions: false });
const options: ExecuteOptions = { storage: { nulls: 'preserve', filter: { version: 1 }, increments: { version: 1 } }, observer: { onRows(rows) { void rows; } } };
void runtime.execute('Item', 'update', { input: { id: 'a', title: null } }, options);
void runtime.executeMutation('ingress', Buffer.from('request'), { context: {} });
const request: MongoStorageRequest = { backend: 'mongodb', operation: 'findOneAndUpdate', filter: { version: 1 }, update: { $inc: { version: 1 } }, options: { returnDocument: 'after' } };
void runtime.executeStorage('Item', request);
void runtime.executeStorage('Item', { backend: 'mongodb', operation: 'stream', pipeline: [] }, { observer: { beforeFetch() {} } });
// @ts-expect-error conditional update requires a complete predicate
void runtime.executeStorage('Item', { backend: 'mongodb', operation: 'updateOne', update: { $inc: { version: 1 } } });
// @ts-expect-error wrong payload for insertMany
void runtime.executeStorage('Item', { backend: 'mongodb', operation: 'insertMany', update: {} });
// @ts-expect-error no arbitrary native method name
void runtime.executeStorage('Item', { backend: 'mongodb', operation: 'drop' });
// @ts-expect-error options cannot replace the adopted session
void runtime.executeStorage('Item', { backend: 'mongodb', operation: 'find', options: { session: {} } });
// @ts-expect-error unsupported operation
void runtime.execute('Item', 'drop');
// @ts-expect-error opt-out only, cannot re-enable shared introspection
runtime.configureIntrospection({ fieldExtensions: true });

void runtime.execute('Item', 'find', {}, { query: { dialect: 'mongodb', filter: { 'data.507f1f77bcf86cd799439011': { $exists: true } }, window: { unbounded: true }, projection: { _id: 1 } } });
void runtime.execute('Item', 'stream', {}, { query: { dialect: 'mongodb', window: { limit: 200 } }, observer: { onRows(rows) { void rows; } } });
void runtime.execute('Item', 'count', {}, { query: { dialect: 'mongodb', filter: { version: { $gt: 1 } } } });
void runtime.execute('Item', 'page', {}, { query: { dialect: 'mongodb', window: { skip: 10, limit: 20 } } }).then(page => { const count: number = page.totalCount; void count; });
// @ts-expect-error stream requires an explicit server query
void runtime.execute('Item', 'stream');
// @ts-expect-error find requires an explicit window
void runtime.execute('Item', 'find', {}, { query: { dialect: 'mongodb' } });
// @ts-expect-error count does not accept a window
void runtime.execute('Item', 'count', {}, { query: { dialect: 'mongodb', window: { limit: 10 } } });
// @ts-expect-error a page must be finite
void runtime.execute('Item', 'page', {}, { query: { dialect: 'mongodb', window: { unbounded: true } } });
// @ts-expect-error no caller-authored pipeline
void runtime.execute('Item', 'find', {}, { query: { dialect: 'mongodb', window: { limit: 10 }, pipeline: [] } });
// @ts-expect-error no unknown dialect
void runtime.execute('Item', 'find', {}, { query: { dialect: 'sql', window: { limit: 10 } } });
