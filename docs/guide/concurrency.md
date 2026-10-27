---
title: Optimistic concurrency
description: Opt-in record versions for conditional updates, state actions and deletes on MongoDB and PostgreSQL.
---

# Optimistic concurrency

Optimistic concurrency uses a record's observed version to reject writes based on stale data. See the [upgrade notes](/resources/compatibility#upgrade-to-3-13-0) before enabling it on existing storage.

## Declare a protected entity

Declare `extensions.concurrency` before the first `createSchema()` that contains the type. The only accepted value is `{ mode: 'optimistic' }`; protection is fixed once a schema containing that type succeeds. A failed call that already built the type's inputs or generated model without the managed field also prevents enabling protection on that registration; recreate the runtime and type objects before trying again. Use one copy of `@simtlix/simfinity-core` per process, and import `RecordVersion` or `MAX_RECORD_VERSION` from the facade your application uses when you need them in custom operations.

```javascript
import { GraphQLID, GraphQLObjectType, GraphQLString } from 'graphql';

const BookType = new GraphQLObjectType({
  name: 'Book',
  fields: {
    id: { type: GraphQLID },
    title: { type: GraphQLString },
  },
  extensions: { concurrency: { mode: 'optimistic' } },
});
simfinity.connect(null, BookType, 'book', 'books');
const schema = simfinity.createSchema();
```

Simfinity adds `version: RecordVersion!`; do not declare it yourself. A protected type must be registered in this runtime as an entity (`connect()` or a non-embedded relation target), cannot be embedded, and cannot have another field or relationship storage name `version`. Other stored fields cannot use `RecordVersion`. In a protected schema, `RecordVersion` and `RecordVersionRef` are reserved names. Startup also rejects an adapter without optimistic-concurrency support. These core checks run before adapter preparation, except the final reserved-name check during schema construction. The MongoDB adapter validates supplied Mongoose models during adapter preparation. A failure after field injection leaves the field on that type object for the rest of the process; rebuild type objects to correct such a startup failure.

## Read, edit and send the version back

A create, including a nested `added` item or `saveObject()` call, starts at version 1. An accepted update, state action or nested `updated` entry advances that record's version once, even with no data-field changes. Deletion does not advance it. Versions are integers from 1 to `MAX_RECORD_VERSION` (`9007199254740991`), beyond GraphQL `Int`'s range; send JSON numbers, never numeric strings. Clients identify the field by its `RecordVersion` type and send it back on writes even though introspection reports `extensions.readOnly: true`. The create input excludes it.

```graphql
query ReadBook($id: ID!) {
  book(id: $id) { id title version }
}

mutation EditBook($input: BookInputForUpdate!) {
  updatebook(input: $input) { id title version }
}
```

For a record read as `{ "id": "…", "title": "First", "version": 2 }`, send `{ "input": { "id": "…", "title": "Edited", "version": 2 } }`. A successful result has version 3. Keep that returned version for the next edit. The precondition is captured after middleware, before validators, hooks or state actions can change the input, and is kept across transaction retries.

| Error | Client reaction |
| --- | --- |
| `VERSION_CONFLICT` (409), `Book <id> was modified by another operation` | Re-read, reconcile the new record and reapply the intended edit with its version. An earlier call might already have applied it. |
| `TRANSACTION_RETRY_EXCEEDED` (409) | Re-read and reapply as for a version conflict; contention exhausted the owned transaction's retries. |
| `VERSION_EXHAUSTED` (409), `Book <id> has reached the maximum version` | An update cannot advance this record further. Deletion with the current version remains possible. |
| Missing or invalid GraphQL version | GraphQL coercion fails, normally formatted as `BAD_REQUEST` (400). |
| Missing or invalid version on a path that bypasses coercion | `REQUIRED_VALUE` or `INVALID_VERSION` (400); supply a safe integer in range. |
| `VERSION_MANAGED` (500) | Correct a controller that assigns the managed version. |
| `DATABASE_ERROR` (500) | Investigate invalid stored versions or an adapter/plugin result that violates the write contract. |

## Deletes, nested writes and state actions

```graphql
mutation RemoveBook($id: ID!, $version: RecordVersion!) {
  deletebook(id: $id, version: $version) { id version }
}
```

A protected delete returns the deleted record with its stored version. An unprotected delete still takes only `id`. A protected child's collection input uses `deleted: [RecordVersionRef]`, where each non-null entry has `id: ID!` and `version: RecordVersion!`; `updated` entries use that child's update input and require its version. Null delete entries remain ignored. This changes the parent's inputs even when the parent itself is unprotected, in both its create and update collection inputs.

```javascript
const collectionPatch = {
  updated: [{ id: childId, title: 'Changed', version: childVersion }],
  deleted: [{ id: removedChildId, version: removedChildVersion }],
};
```

Send `input.version` to a state action such as `publish_book`, just as to `updatebook`. For a readable caller, a stale version fails before the source-state check, action and validators. A protected type with no writable update fields or writable `id` gets no update input or state-action mutation merely because it has a version; deletion remains available.

Each check protects one record. A parent version does not observe or protect changes made directly to its children. Child ownership is checked before its version. Nested entries run after the parent's write, field by field in `added`, `updated`, `deleted` order. A stale child rolls back the whole mutation's database writes; parent hooks and earlier sibling hooks may already have run. There is no graph-level version or tracking of records a client has read.

## Hooks, scopes and authorization

Hook signatures stay unchanged. `onSaving(document, args, session, context)` receives a record initialized to version 1, while `args` retains what the caller supplied. It must leave the managed value at 1. The `changes` passed to `onUpdating(id, changes, session, context)` excludes `version`; setting it directly or through a `$` operator raises `VERSION_MANAGED`. `onSaved` and `onUpdated` receive the stored new version. `onDelete(document, session, context)` receives a plain record with its normalized stored version, or `null` for a missing record.

Keep write authorization in root mutation rules and in `onUpdating`/`onDelete` as appropriate. Declare record visibility in the protected type's `get_by_id` scope when some callers must not receive an early stale/exhausted-version error. A readable caller receives that error before the record's own validators, hooks or action. A hidden caller, including one whose scope throws, continues through the usual merge, validators, source-state check, action and hooks; only if they accept the write does the adapter report the conflict. The visibility check runs the scope, without `get_by_id` middleware, only for stale or exhausted versions. Errors from its query gates or adapter still propagate.

Root mutation authorization and middleware run before the protected pre-read. The visibility rule covers stale or exhausted valid versions, not every storage error: a malformed stored version can raise `DATABASE_ERROR` before controller authorization. Hiding a root query with an auth-plugin rule alone does not establish this visibility boundary; use `get_by_id` scope as well. Missing-record behavior is preserved: updates, state actions and nested entries return `NOT_VALID_ID` (404), while a top-level delete runs `onDelete(null)` and returns `null`. Protected malformed IDs fail in the pre-read before controller hooks. On MongoDB, the no-match existence read uses the raw collection and bypasses query middleware, so a record hidden only by that middleware can still produce `VERSION_CONFLICT`; express its visibility in `get_by_id` scope instead of relying on middleware hiding.

Middleware for updates and actions still receives `{ input }`, including `input.version`. A protected root or nested delete receives `{ id, version }`; an unprotected one receives `{ id }`. Middleware may prepare the version before capture, but later input changes never replace the captured precondition.

## Transactions and concurrent requests

Simfinity-owned transactions roll back all writes on a conflict and do not retry `VERSION_CONFLICT` or `VERSION_EXHAUSTED` themselves. Driver serialization conflicts can retry the complete callback, always with the original supplied version. Under sustained contention they can end in `TRANSACTION_RETRY_EXCEEDED`.

PostgreSQL takes a `FOR UPDATE` pre-read in its repeatable-read transaction and holds the row lock through validators and `onUpdating`. Competing writes wait; serialization failure (`40001`) retries the owned transaction, which then reports the stale version before hooks for a readable caller. Hooks that lock other protected rows can also encounter retryable deadlocks (`40P01`). Even an update containing only `id` and `version` executes a root-row update and fires the touch/refresh triggers of maintained roots with owned tables or embedded unique keys.

MongoDB uses a plain snapshot pre-read, without a claim lock. If a competitor committed after that snapshot, the losing attempt's validators and `onUpdating`/`onDelete` may run before the conditional write encounters `WriteConflict`. Those hooks can repeat across retries; `onUpdated` never runs for the rejected edit. Keep checks in these hooks. Use [after-commit callbacks](./controllers#after-commit-callbacks) for best-effort external effects; failed or retried attempts do not dispatch them. Use a transactional outbox and worker when delivery must survive a process failure.

With an active supplied session, its caller owns the transaction, commit and retry policy. Let a driver's `40001` or `WriteConflict` propagate so the owner can retry the whole transaction with a new snapshot; retrying at a savepoint keeps the stale snapshot. An outer `withTransaction(null, callback)` can own that retry. In default MongoDB mode the caller also owns aborts. With [transactional reference integrity](./mongodb-integrity), an adapter-detected conflict aborts even a supplied transaction; a core-detected early conflict does not. Hidden callers' version conflicts are adapter-detected. Core result diagnostics retain existing supplied-session ownership; do not assume every invalid wrapper or result automatically aborts a transaction you supplied.

## Versions in helpers and transactions

The lifecycle helpers and the [transaction mutation](./mutations#run-several-mutations-in-one-transaction) run the same protected lifecycle as the roots, so they need the version you read, explicitly, in the same places:

- `updateObject(typeName, input)` and `transitionObject(typeName, actionName, input)` take `input.version`, as the generated update input declares it. A missing or `null` version is `REQUIRED_VALUE` (400) before anything runs, a present version that is not a safe integer from 1 up is `INVALID_VERSION` (400), and a stale one is `VERSION_CONFLICT` (409), with the same visibility rules as the roots.
- `deleteObject(typeName, { id, version })` requires `version` on a protected type. On any other type, `version` is an unknown field and fails with `INVALID_INPUT`.
- Nested entries of `input` follow the collection inputs: `updated` items of a protected child carry their version and `deleted` items are `{ id, version }`.
- In a transaction, every update, state action and delete of a protected type carries its `version` in its operation, and a nested protected child carries its own, as it does in the root mutation.

A helper captures the expected version from the snapshot of your input before any hook, middleware or state action runs. It carries that version to the write on every attempt of a retried transaction, and neither a hook nor the action can change it. Nothing refreshes it either: after a conflict, re-read and call again with the version you read.

A transaction never infers or refreshes versions, and a `$K` reference carries an ID only. A record that a list creates starts at version 1, so an update of it later in the same list must send `version: 1`, and a state action that follows that update `version: 2`; repeating `version: 1` there fails with `VERSION_CONFLICT`, names the operation and stores nothing. Read the new versions from the selected result fields, such as `updatebook { id version }`, after the commit. A conflict in any operation rolls back the whole list. An early conflict follows the same `get_by_id` visibility rule as for the roots, and a retry of the transaction repeats the whole list with the versions you sent.

## Writes made by hooks

A derived value maintained within the current revision should not create another revision. On MongoDB, use a session-bound `updateOne` without touching `version`. On PostgreSQL, use the model handle's explicit bypass:

```javascript
await simfinity.getModel(OrderType).update(order.id, { total }, {
  session,
  version: false,
});
order.total = total; // Keep the mutation result in sync without changing its version.
```

`version: false` skips both the check and increment and ignores `changes.version`. These native calls bypass validators, controllers, scopes and authorization. If a hook intentionally creates a new revision of another record, read that record's version in the session immediately before the write, then call `model.update(id, { ...changes, version: record.version }, { session })` or `model.delete(id, { session, version: record.version })`. Never use that versioned write on the record the mutation returns, or on a record a later entry of the same mutation will write: it invalidates the result or later precondition. Use the bypass for derived values in that same revision.

## Custom operations, adapters and native writers

Custom operations that return a protected type must return its stored `version`; an omitted or null value reads as 1 for legacy compatibility. The field has no generated filter argument, and client conditions, sorts, grouping and aggregation facts on it are rejected. Conditions on `version` supplied by middleware, scopes or a named view's `where` are unsupported too: missing MongoDB versions cannot reproduce the read-as-1 rule in filters.

Adapters opt in with `writeFeatures: { optimisticConcurrency: true }`, honor `expectedVersion` atomically in `update`/`delete`, and run the visibility `find` in the supplied session with `requiredId` and `context`. Wrappers must forward every argument, including options. Core checks returned update versions against `expected + 1` and the immutable version observed before hooks, and checks a deleted record against the expected version. SQL model handles also check the returned increment. These are defensive diagnostics, not proof that an arbitrary wrapper or compiler preserved the atomic predicate. See the [adapter contract](https://github.com/simtlix/simfinity.js/blob/master/packages/core/README.md) and [SQL plugin contract](./sql-plugins#optimistic-concurrency).

Native writers must implement the protocol themselves. For MongoDB's raw collection API, using an expected safe integer:

```javascript
const versionFilter = expected === 1 ? { $in: [1, null] } : expected;
const updated = await collection.findOneAndUpdate(
  { _id, version: versionFilter },
  { $set: { ...changes, version: expected + 1 } },
  { session, returnDocument: 'after' },
);
// Delete: collection.findOneAndDelete({ _id, version: versionFilter }, { session }).
```

Check the matched result and handle missing, stale and exhausted records; never advance past `MAX_RECORD_VERSION`. With Mongoose `sanitizeFilter`, mark the operator with the model's own `Model.base.trusted({ $in: [1, null] })`. Never use `$inc` for versioning: a missing field would become 1 instead of advancing to 2, and `null` fails. A native writer that skips the protocol is not detected.

Protected MongoDB reads preserve malformed raw versions through hydration and ordinary result conversions that retain the stored `_id` or an equivalent `id`, including `toObject()` results and non-extensible records. Only the managed version field consumes this information; native hydrated values and unprotected aliases keep their existing behavior. Replacement results with neither identifying key cannot be associated with the stored record, and fabricated results that reuse the same ID cannot be distinguished from conversions. Custom read-result replacements must preserve record identity; this mechanism is not a guarantee for arbitrary fabricated results.

Protected default-mode MongoDB writes call `findOneAndUpdate` and `findOneAndDelete`, so overrides of `findByIdAndUpdate` and `findByIdAndDelete` no longer intercept them. Transactional-integrity updates also use `findOneAndUpdate`; transactional deletes still use `findByIdAndDelete` after the conditional lock. Query middleware must preserve both the atomic version predicate and the managed increment. Supplied-model pre/post save middleware must preserve initialized version 1 and the returned managed value: core checks `onSaving` before native save middleware and adds no post-save guard. Result checks cannot enforce every native hook or override.

## Enable it on existing MongoDB data

Missing or null `version` reads as 1, and the first successful update writes 2. Before enabling protection, move any business field named `version` to another name, using a migration appropriate for the application; for example:

```javascript
await collection.updateMany(
  { version: { $exists: true } },
  { $rename: { version: 'businessVersion' } },
);
```

Inspect malformed stored values before enabling. This query reports values the managed reader rejects under default BSON decoding, including Decimal128, NaN, infinities and unsafe long integers; it accepts missing/null values and safe integral BSON double/int/long values:

```javascript
const invalidVersions = await collection.find({
  $expr: {
    $cond: [
      { $in: [{ $type: '$version' }, ['double', 'int', 'long']] },
      {
        $or: [
          { $lt: ['$version', 1] },
          { $gt: ['$version', 9007199254740991] },
          { $ne: ['$version', { $trunc: ['$version', 0] }] },
        ],
      },
      { $ne: [{ $ifNull: ['$version', null] }, null] },
    ],
  },
}).toArray();
```

Do not replace the type gate with `$isNumber`, which accepts Decimal128 even though the managed reader rejects its object representation. Custom BSON decoding, such as `promoteLongs: false` returning `Long` objects for safe integers, requires application-specific inspection. Supplied Mongoose models must declare `version: Number` without `immutable`, `select: false`, getters, setters or a default other than 1; an absent default and an alias are allowed. Do not use `versionKey: 'version'`. Simfinity does not alter compiled model schemas.

## Enable it on existing PostgreSQL tables

The managed root column is `bigint NOT NULL DEFAULT 1`. Initialization validates storage and explains missing columns, differing definitions and leftover version columns; it never migrates them automatically. For a missing column, review and run the migration using the actual names from `describeDatabase()`:

```sql
ALTER TABLE "app"."Book" ADD COLUMN "version" bigint NOT NULL DEFAULT 1;
```

A differing definition needs correction to `bigint NOT NULL DEFAULT 1`, without adding another column. Run the migration immediately before the first protected instance starts. Once the column exists, instances without the declaration cannot start, even during rollback. To roll back, stop the protected instances, drop the version column only once no instance declares protection, then start the old build:

```sql
ALTER TABLE "app"."Book" DROP COLUMN "version";
```

There is a rolling-deployment gap on both engines: already-running old instances can keep writing without checking or advancing versions. PostgreSQL's startup validation blocks new unprotected instances, not ones already serving. Coordinate the cutover so every writer follows the protocol before relying on it. On MongoDB there is no matching startup storage-column gate. Neither database detects direct driver writes that omit the protocol.
