// An in-memory database adapter that declares optimistic concurrency (#98) and follows the adapter
// contract of the spec, section 6:
// - with `options.expectedVersion`, `update` and `delete` write only a record stored at that version, and
//   `update` sets it to the next one; at MAX_RECORD_VERSION `update` skips the write;
// - a conditional write that matched nothing reads the record again and returns null when it is
//   missing, throws VERSION_CONFLICT when its version differs, VERSION_EXHAUSTED when an update found
//   it at the maximum, and returns null otherwise;
// - with `missingVersionCountsAsOne` (the default, as on MongoDB), a record without a version matches 1.
// Without `options.expectedVersion`, writes behave as an adapter without the feature. IDs are decimal
// strings; any other ID fails as the MongoDB adapter fails a malformed ObjectId.
//
// Every transaction the adapter owns works on the stored records and restores them when it fails, and an
// error labeled TransientTransactionError retries it, up to `attempts` times; `betweenAttempts` runs after
// a failed attempt is rolled back and before the retry. A transaction the caller supplies runs once, and
// its body receives that session, or what `bodySession(session)` returns, so a test can hand the body
// another object than the session it supplied, as some adapters do.
// getById, update, delete and find are spies, so tests read the calls and options core made.
// assertTransactionModels, the check the generated transaction field requires (#151), is a spy that
// accepts any models; `transactions: false` leaves it out, as an adapter without the method.
import { vi } from 'vitest';
import { SimfinityError } from '@simtlix/simfinity-core';

// Loaded on use, so that on a checkout without the subpath only the writes that carry a version fail.
const RECORD_VERSION_MODULE = '@simtlix/simfinity-core/internal/record-version';
const loadRecordVersion = () => import(/* @vite-ignore */ RECORD_VERSION_MODULE);

const MAX_VERSION = Number.MAX_SAFE_INTEGER;

export const transientError = (message = 'transient failure') => Object.assign(new Error(message), {
  errorLabels: ['TransientTransactionError'],
});

export const createOptimisticMemoryAdapter = ({
  missingVersionCountsAsOne = true, attempts = 3, transactions = true, bodySession = null,
} = {}) => {
  const records = new Map();
  let nextId = 1000;
  const key = (typeName, id) => `${typeName}:${id}`;
  const copy = (record) => (record == null ? null : structuredClone(record));
  const castId = (id) => {
    if (!/^\d+$/.test(String(id))) throw new SimfinityError('Invalid identifier', 'NOT_VALID_ID', 400);
    return String(id);
  };
  const matches = (stored, expected) => stored === expected
    || (missingVersionCountsAsOne && expected === 1 && stored == null);
  const applyUpdate = (record, update) => {
    for (const [field, value] of Object.entries(update)) {
      if (field === '$unset') {
        for (const member of Object.keys(value)) delete record[member];
      } else if (field === '$set') {
        Object.assign(record, structuredClone(value));
      } else if (field.startsWith('$')) {
        throw new Error(`The memory adapter does not apply ${field}`);
      } else {
        record[field] = structuredClone(value);
      }
    }
  };
  // The read after a conditional write that matched nothing, with the key the write used.
  const disambiguate = async (Model, id, current, expectedVersion, operation) => {
    if (!current) return null;
    const {
      readStoredVersion, versionConflictError, versionExhaustedError,
    } = await loadRecordVersion();
    const stored = readStoredVersion(current.version, { typeName: Model.name, id });
    if (stored !== expectedVersion) throw versionConflictError(Model.name, id);
    if (operation === 'update' && stored === MAX_VERSION) throw versionExhaustedError(Model.name, id);
    return null;
  };

  const adapter = {
    writeFeatures: { optimisticConcurrency: true },
    betweenAttempts: null,
    prepare() {},
    createModel: (gqltype) => ({ name: gqltype.name }),
    castId,
    ...(transactions ? { assertTransactionModels: vi.fn() } : {}),
    async withTransaction(session, body) {
      if (session) return body(bodySession ? bodySession(session) : session);
      for (let attempt = 1; ; attempt += 1) {
        const snapshot = new Map([...records].map(([entry, record]) => [entry, copy(record)]));
        try {
          return await body({ memory: true, attempt });
        } catch (error) {
          records.clear();
          for (const [entry, record] of snapshot) records.set(entry, record);
          if (!error?.errorLabels?.includes('TransientTransactionError') || attempt >= attempts) throw error;
          await adapter.betweenAttempts?.(attempt);
        }
      }
    },
    newRecord: (Model, data) => ({ ...data, _id: String(nextId++) }),
    async saveRecord(Model, record) {
      records.set(key(Model.name, record._id), copy(record));
      return copy(record);
    },
    toObject: (record) => ({ ...record }),
    getById: vi.fn(async (Model, id, session, { projection, requiredId } = {}) => {
      if (id == null) return null;
      const cast = castId(id);
      if (requiredId != null && castId(requiredId) !== cast) return null;
      const record = copy(records.get(key(Model.name, cast)));
      if (!record || !projection) return record;
      return Object.fromEntries(Object.entries(record)
        .filter(([field]) => field === '_id' || field === 'id' || Object.hasOwn(projection, field)));
    }),
    prepareUpdate: (set, unset) => (Object.keys(unset).length > 0 ? { ...set, $unset: unset } : set),
    update: vi.fn(async (Model, id, update, session, options) => {
      const cast = castId(id);
      const current = records.get(key(Model.name, cast));
      const expectedVersion = options?.expectedVersion;
      if (expectedVersion === undefined) {
        if (!current) return null;
        applyUpdate(current, update);
        return copy(current);
      }
      if (current && expectedVersion < MAX_VERSION && matches(current.version, expectedVersion)) {
        applyUpdate(current, update);
        current.version = expectedVersion + 1;
        return copy(current);
      }
      return disambiguate(Model, id, current, expectedVersion, 'update');
    }),
    delete: vi.fn(async (Model, id, session, options) => {
      if (id == null) return null;
      const cast = castId(id);
      const current = records.get(key(Model.name, cast));
      const expectedVersion = options?.expectedVersion;
      if (expectedVersion !== undefined && !(current && matches(current.version, expectedVersion))) {
        return disambiguate(Model, id, current, expectedVersion, 'delete');
      }
      if (!current) return null;
      records.delete(key(Model.name, cast));
      return copy(current);
    }),
    // Compiles EQ conditions on stored fields, `id` included, and honors `requiredId`; list controls are
    // ignored and anything else fails, so a test never passes on a condition the adapter skipped.
    find: vi.fn(async (Model, gqltype, args, session, { requiredId } = {}) => {
      let found = [...records].filter(([entry]) => entry.startsWith(`${Model.name}:`)).map(([, record]) => record);
      if (requiredId != null) found = found.filter((record) => record._id === castId(requiredId));
      for (const [field, condition] of Object.entries(args ?? {})) {
        if (field === 'pagination' || field === 'sort') continue;
        if (condition?.operator !== 'EQ') throw new Error(`The memory adapter compiles only EQ conditions (${field})`);
        const storageName = field === 'id' ? '_id' : field;
        found = found.filter((record) => String(record[storageName]) === String(condition.value));
      }
      return found.map(copy);
    }),
    count: async () => 0,
    aggregate: async () => [],
    findChildren: async (Model, gqltype, field, parentId) => [...records]
      .filter(([entry, record]) => entry.startsWith(`${Model.name}:`) && String(record[field]) === String(parentId))
      .map(([, record]) => copy(record)),
    records,
    seed(typeName, record) {
      records.set(key(typeName, record._id), copy(record));
    },
    stored: (typeName, id) => copy(records.get(key(typeName, id))),
    // The reads by ID core made, as `Type id options`.
    reads: () => adapter.getById.mock.calls
      .map(([Model, id, , options]) => `${Model.name} ${id} ${JSON.stringify(options ?? {})}`),
  };
  return adapter;
};
