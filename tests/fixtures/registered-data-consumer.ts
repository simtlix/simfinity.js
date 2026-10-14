import { createRuntime, type ExecuteOptions } from '@simtlix/simfinity-core';
import { createMongoAdapter, type MongoStorageRequest } from '@simtlix/simfinity-js';
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
