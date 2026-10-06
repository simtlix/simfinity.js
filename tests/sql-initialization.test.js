import { describe, expect, it, vi } from 'vitest';
import { GraphQLID, GraphQLObjectType, GraphQLString } from 'graphql';
import { createSQL, SimfinityError } from '../packages/sql/src/index.js';

const deferred = () => {
  let resolve; let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

// A runtime over a recording plugin whose reads return no rows; each test controls plugin.initialize.
const createRuntime = ({ allowCreation = true } = {}) => {
  const plugin = {
    apiVersion: 1, name: 'recording', displayName: 'Recording', defaultSchema: 'main', options: {},
    capabilities: ['transactions'],
    naming: { validateIdentifier() {}, generatedName: (...parts) => parts.join('_') },
    describeSchema: (plan) => plan,
    initialize: vi.fn(async (configuration, description, options) => ({ mode: options.mode ?? 'create', created: [] })),
    compileSchema() {}, compileQuery: () => ({ text: 'read', values: [] }), compileRecord() {},
    values: { createId() {}, castId: (value) => value, encodeScalar: (field, value) => value, decodeScalar: (field, value) => value, encodeEmbedded: (value) => value },
    driver: {
      assertConfiguration() {}, query: async () => ({ rows: [] }), acquire: async () => ({}), begin() {}, commit() {}, rollback() {}, release() {},
      isRetryable: () => false, normalizeError: (error) => error,
    },
  };
  const runtime = createSQL({ plugin });
  const Item = new GraphQLObjectType({ name: 'InitializedItem', fields: { id: { type: GraphQLID }, name: { type: GraphQLString } } });
  runtime.connect(null, Item, 'item', 'items');
  if (!allowCreation) runtime.preventCreatingCollection(true);
  runtime.createSchema();
  const find = () => runtime.getModel(Item).find();
  return { plugin, runtime, find };
};
const unavailable = { extensions: expect.objectContaining({ code: 'DATABASE_NOT_INITIALIZED', status: 503 }) };

describe('SQL storage readiness', () => {
  it('keeps a ready runtime serving when an initialization request is rejected before storage', async () => {
    const validating = createRuntime({ allowCreation: false });
    await validating.runtime.initializeDatabase();
    await expect(validating.runtime.initializeDatabase({ mode: 'create' })).rejects.toMatchObject({ extensions: { code: 'DATABASE_CREATION_DISABLED', status: 409 } });
    expect(validating.plugin.initialize).toHaveBeenCalledOnce();
    await expect(validating.find()).resolves.toEqual([]);

    const creating = createRuntime();
    await creating.runtime.initializeDatabase();
    await expect(creating.runtime.initializeDatabase({ mode: 'validation' })).rejects.toMatchObject({
      message: 'Unknown initialization mode: validation', extensions: { code: 'INVALID_INITIALIZATION_MODE', status: 400 },
    });
    expect(creating.plugin.initialize).toHaveBeenCalledOnce();
    await expect(creating.find()).resolves.toEqual([]);
  });

  it('checks the mode that reaches the plugin: validation-only runtimes still validate on a falsy mode', async () => {
    const validating = createRuntime({ allowCreation: false });
    for (const mode of [null, '', false, 0]) {
      await expect(validating.runtime.initializeDatabase({ mode })).resolves.toEqual({ mode: 'validate', created: [] });
    }
    expect(validating.plugin.initialize.mock.calls.map(([, , options]) => options)).toEqual(Array(4).fill({ mode: 'validate' }));

    const creating = createRuntime();
    for (const mode of [null, '', 'drop']) {
      await expect(creating.runtime.initializeDatabase({ mode })).rejects.toMatchObject({ extensions: { code: 'INVALID_INITIALIZATION_MODE', status: 400 } });
    }
    expect(creating.plugin.initialize).not.toHaveBeenCalled();
    await expect(creating.runtime.initializeDatabase({ mode: 'validate' })).resolves.toEqual({ mode: 'validate', created: [] });
    expect(creating.plugin.initialize).toHaveBeenCalledWith({}, expect.objectContaining({ schema: 'main' }), { mode: 'validate' });
  });

  it('fails closed until the first initialization succeeds, keeps serving while it runs again and fails closed after a failure', async () => {
    const { plugin, runtime, find } = createRuntime();
    const first = deferred();
    plugin.initialize.mockReturnValueOnce(first.promise);
    const initializing = runtime.initializeDatabase();
    await expect(find()).rejects.toMatchObject(unavailable);
    first.resolve({ mode: 'create', created: ['InitializedItem'] });
    await initializing;
    await expect(find()).resolves.toEqual([]);

    const revalidation = deferred();
    plugin.initialize.mockReturnValueOnce(revalidation.promise);
    const revalidating = runtime.initializeDatabase({ mode: 'validate' });
    await expect(find()).resolves.toEqual([]);
    revalidation.reject(new SimfinityError('Schema mismatch', 'SCHEMA_MISMATCH', 500));
    await expect(revalidating).rejects.toMatchObject({ extensions: { code: 'SCHEMA_MISMATCH' } });
    await expect(find()).rejects.toMatchObject(unavailable);

    await runtime.initializeDatabase({ mode: 'validate' });
    await expect(find()).resolves.toEqual([]);
    // Any failure of the plugin, such as a refused connection, fails closed too.
    plugin.initialize.mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }));
    await expect(runtime.initializeDatabase({ mode: 'validate' })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    await expect(find()).rejects.toMatchObject(unavailable);
  });

  it('lets the most recently started initialization decide readiness', async () => {
    const { plugin, runtime, find } = createRuntime();
    const [older, newer] = [deferred(), deferred()];
    plugin.initialize.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const settled = [runtime.initializeDatabase({ mode: 'validate' }), runtime.initializeDatabase({ mode: 'validate' })].map((promise) => promise.catch((error) => error));
    newer.reject(new SimfinityError('Schema mismatch', 'SCHEMA_MISMATCH', 500));
    await settled[1];
    older.resolve({ mode: 'validate', created: [] });
    await settled[0];
    await expect(find()).rejects.toMatchObject(unavailable);

    const [stale, latest] = [deferred(), deferred()];
    plugin.initialize.mockReturnValueOnce(stale.promise).mockReturnValueOnce(latest.promise);
    const again = [runtime.initializeDatabase({ mode: 'validate' }), runtime.initializeDatabase({ mode: 'validate' })].map((promise) => promise.catch((error) => error));
    latest.resolve({ mode: 'validate', created: [] });
    await again[1];
    stale.reject(new SimfinityError('Schema mismatch', 'SCHEMA_MISMATCH', 500));
    expect(await again[0]).toMatchObject({ extensions: { code: 'SCHEMA_MISMATCH' } });
    await expect(find()).resolves.toEqual([]);
  });
});
