---
title: MongoDB reference integrity
description: Opt into transactional reference checks and restrict-delete behavior when initializing a MongoDB adapter.
---

# MongoDB reference integrity

Available from **Simfinity 3.4.0**. Install `@simtlix/simfinity-js@3.4.0` and keep any directly installed Simfinity packages at the same version.

MongoDB applications can opt into transactional reference integrity when creating their adapter. The setting is fixed for that runtime. Queries, mutation inputs, scopes, authorization and MCP schemas keep their existing shape.

| Mode | Behavior |
| --- | --- |
| `'off'` (default) | Existing Mongo behavior: a well-formed reference ID may point to a missing document. |
| `'transactional'` | Check referenced documents, coordinate concurrent creation/deletion, and reject deletion of referenced targets. Requires awaited initialization. |

PostgreSQL continues to enforce its generated foreign keys in the database. This Mongo option enforces reference integrity through coordinated adapter writes; it does not install a database FK or change MongoDB's general isolation semantics.

## Configure once at startup

Create and export one runtime for the application. Register every persistent type and supporting type before creating the schema; use that same runtime in controllers, HTTP and MCP entry points.

```javascript
import mongoose from 'mongoose';
import { createMongoAdapter, createRuntime } from '@simtlix/simfinity-js';
import { ServiceType, ShopType } from './types.js';

const adapter = createMongoAdapter({
  referentialIntegrity: 'transactional',
});
export const simfinity = createRuntime(adapter);

await mongoose.connect(process.env.MONGODB_URI);
simfinity.connect(null, ServiceType, 'service', 'services');
simfinity.connect(null, ShopType, 'shop', 'shops');
export const schema = simfinity.createSchema();

await adapter.initialize();
// Start your GraphQL/MCP server only after this resolves.
```

`createMongoAdapter()` and the existing namespace facade remain in `'off'` mode. The options object is read once; mutating it later does not reconfigure the adapter. `adapter.referentialIntegrity` is readonly. A protected adapter binds to one runtime and its registration set cannot change after schema preparation.

`initialize()` is asynchronous and idempotent. It finishes Mongoose model initialization, creates collections when enabled, and audits existing references in a real snapshot transaction. It requires a connected replica set or sharded cluster. A standalone MongoDB server is rejected, and operations remain unavailable after a failed initialization. There is no fallback to `'off'`.

Calling `preventCreatingCollection(true)` before `createSchema()` suppresses the adapter's explicit collection creation; required collections must already exist. Mongoose's own model/index initialization still applies. Initialization does not repair or delete data.

## Relationships covered

The protected graph comes from `extensions.relation`, using the same metadata description as the SQL planner:

- Single references, including renamed and dotted Mongo storage keys.
- References inside embedded objects and arbitrarily deep supported embedded lists, including nullable items.
- One-to-many child keys, including inferred scalar `GraphQLID` fields and private connection fields.
- Explicit many-to-many link entities and self-references.
- Referenced supporting types registered without root endpoints.

Plain scalar IDs without a declared or inferred relationship remain ordinary values. Optional absent/null references do not require a target. An embedded document itself belongs to its owner and disappears when its owner is deleted; references within it still protect their separate targets.

A missing target returns `REFERENCE_CONSTRAINT_VIOLATION` with status metadata `409`, matching PostgreSQL's FK error. The entire generated mutation rolls back, including its parent and earlier nested children. Deleting a target still referenced by another stored document returns the same error. Deleting a self-referencing document is allowed when no other document references it.

Checks are immediate within the transaction. Create the target before referencing it; remove incoming references before deleting the target. This mode does not add deferred constraints or automatic cascades between independent entities. It does not replace other scalar/required/unique validations.

## Concurrent transactions

After a save or update, the adapter checks the stored document, including controller changes, against its declared references. For each distinct target, it writes a fresh ObjectId to reserved storage field `_simfinityReferenceLock`. A target deletion modifies the same field before checking incoming references. These writes take MongoDB document locks until commit or abort.

If a creation commits first, deletion rejects its reference. If deletion commits first, creation rejects its missing target. A transaction with an older snapshot conflicts with the target modification and must retry from a fresh transaction. A simple `exists()` read would not provide this guarantee.

The reserved field is not part of GraphQL or mutation inputs and uses `select: false` on Mongoose models. Native collection reads/aggregations and backups can see it. Lock writes bypass domain hooks, timestamps and version counters. Concurrent writes that reference a popular target contend on that document; this adds reads, writes and possible retries.

Owned transactions use `readConcern: 'snapshot'` and `writeConcern: 'majority'`. Confirmed transient failures retry the complete mutation up to five times; uncertain commit results retry only commit. Controllers may therefore execute more than once. Keep external side effects in a transactional outbox; see [transaction boundaries](./mutations#transaction-boundaries).

## Supplied sessions

An existing session must belong to the models' MongoDB client and already have these transaction options:

```javascript
const session = await mongoose.startSession();
try {
  session.startTransaction({
    readConcern: { level: 'snapshot' },
    writeConcern: { w: 'majority' },
  });
  await simfinity.saveObject('Shop', input, session);
  await session.commitTransaction();
} catch (error) {
  if (session.inTransaction()) await session.abortTransaction();
  throw error;
} finally {
  await session.endSession();
}
```

Healthy supplied sessions remain caller-owned: the adapter does not commit, end or retry them. **A reference violation or guarded-write error aborts even a supplied transaction**, so catching the error cannot commit an invalid preceding write. This includes normal Mongoose post-save/update hooks that throw after the database operation; the original error is preserved. An ambiguous/missing update result also aborts the supplied transaction; the generated update keeps its normal `NOT_VALID_ID` result for a nonexistent record. Callers own any retry using a fresh transaction.

## Existing databases and native writes

Before first enabling protection, stop uncoordinated writers and resolve existing orphan references. The startup audit scans the registered persistent graph, rejects missing targets, and leaves existing data unchanged. For a large database, account for the audit cost and MongoDB transaction lifetime limits. Failed initialization leaves that adapter unavailable; fix the data/configuration and restart with a fresh adapter.

All instances and writing scripts must use the same complete relationship graph and protection setting. Supplied models must share one MongoDB connection, have distinct physical collections, and use ObjectId primary keys and reference paths. Conflicting reserved field definitions or unsupported relation metadata fail initialization.

Protection covers generated GraphQL mutations, the same operations exposed through MCP, `saveObject()` and guarded adapter writes. Direct `getModel()` writes, raw driver/collection calls, external clients and native writes inside controllers/custom mutations bypass these checks. Those writers must implement the same protocol or use the protected runtime. Putting a native write in a transaction alone is insufficient.

Custom Mongoose middleware must preserve the transaction session and operation identity. The adapter rejects redirected deletion identities and unreadable/hidden write results, but arbitrary hooks that perform separate writes or escape the transaction are outside the guarantee. Integrity checks use native storage, not query scopes; scopes continue to control which related records a caller can read.

## Errors

| Code | Meaning |
| --- | --- |
| `INVALID_MONGO_INTEGRITY_CONFIGURATION` | Invalid option, unsupported model/registry, conflicting field, missing collection, connection or key configuration. |
| `MONGO_INTEGRITY_NOT_INITIALIZED` | Protected operations attempted before successful initialization. |
| `MONGO_TRANSACTIONS_REQUIRED` | The server cannot run the required transactions. |
| `MONGO_INTEGRITY_TRANSACTION_OPTIONS` | A supplied transaction lacks snapshot/majority options. |
| `ACTIVE_TRANSACTION_REQUIRED` | A direct guarded write or supplied session has no active transaction. |
| `REFERENCE_CONSTRAINT_VIOLATION` | Missing reference, restricted deletion or a write result whose guarded identity cannot be verified. |

GraphQL may carry these errors in an HTTP 200 response; `extensions.status` is metadata, not a transport status override.
