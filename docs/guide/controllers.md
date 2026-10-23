---
title: Controllers and lifecycle hooks
description: Add application behavior around record creation, updates, and deletion while preserving transaction and request context.
---

# Controllers and lifecycle hooks

A controller attaches application behavior to a connected type. Use it to populate server-managed fields, validate ownership, or coordinate database writes in the mutation's transaction.

Examples use the selected runtime from [database setup](./databases#runtime-setup-for-shared-examples). After `createSchema()`, PostgreSQL also requires awaited storage initialization before operations are served.

## Attach a controller

This example assumes `SerieType` has read-only `createdAt` and `updatedAt` string fields. It sets timestamps without accepting those values from clients:

```javascript
import { simfinity } from './runtime.js';

const serieController = {
  onSaving: async (document) => {
    const now = new Date().toISOString();
    document.createdAt = now;
    document.updatedAt = now;
  },

  onUpdating: async (id, changes) => {
    changes.updatedAt = new Date().toISOString();
  },
};

simfinity.connect(null, SerieType, 'serie', 'series', serieController);
const schema = simfinity.createSchema();
```

The controller is the fifth `connect()` argument. Register it before building the schema. Every hook is optional and may be asynchronous.

## Hook signatures

| Hook | When it runs | Main value |
| --- | --- | --- |
| `onSaving(document, args, session, context)` | Before inserting the parent record | Mutable backend record |
| `onSaved(document, args, session, context)` | After saving the parent and processing its collection inputs | Plain object snapshot of the saved parent |
| `onUpdating(id, changes, session, context)` | Before preparing the database update | Materialized update object |
| `onUpdated(document, session, context)` | After awaiting the parent update and processing collection inputs | Updated backend record |
| `onDelete(document, session, context)` | Before deleting the record | Existing plain object, or `null` |

For create hooks, `args` is the inner mutation input. For update hooks, `changes` contains the materialized values, may contain `$unset`, and may include merged embedded data, where members the update clears are `null`, or `[]` for lists. It is not a complete copy of the stored document.

The parent update completes before collection writes. A malformed ID fails with `NOT_VALID_ID` (400) before anything is written. In an update of a type without embedded fields, `onUpdating` runs before that check and receives the raw ID; the error then rolls back the hook's session writes. If no parent matches, the mutation throws `NOT_VALID_ID` (404) before processing children or calling `onUpdated`. The hook receives the updated record, so it can read its fields or perform additional session-bound database work without executing the update query again. MongoDB supplies a Mongoose document; PostgreSQL supplies a plain record.

## Check request context

The GraphQL context is passed to each hook. Your server is responsible for authenticating a request and supplying trusted identity information.

For a `SerieType` with a stored `ownerId` field, a controller can verify update ownership:

```javascript
// MongoDB facade example
const serieController = {
  onUpdating: async (id, changes, session, context) => {
    if (!context?.user?.id) {
      throw new simfinity.SimfinityError(
        'Authentication required',
        'UNAUTHENTICATED',
        401,
      );
    }

    const current = await simfinity.getModel(SerieType)
      .findById(id)
      .session(session)
      .lean();

    if (!current || String(current.ownerId) !== String(context.user.id)) {
      throw new simfinity.SimfinityError(
        'You cannot update this serie',
        'FORBIDDEN',
        403,
      );
    }

    changes.updatedAt = new Date().toISOString();
  },
};
```

Because `onUpdating` can receive a malformed ID, a hook that looks the record up must handle one. On MongoDB, `findById()` throws a Mongoose `CastError` for it, and the mutation fails with that error instead of `NOT_VALID_ID`; check the value first, for example with `mongoose.isObjectIdOrHexString(id)` for a generated model, and throw `NOT_VALID_ID` (400) yourself. On PostgreSQL, `findById()` already fails with `NOT_VALID_ID` (400).

Define `ownerId` as a server-managed field and set it from trusted context during creation. Add equivalent checks for other write paths, including deletion and custom mutations, according to your policy. [Query scope](./query-scope) governs read filtering; it does not automatically authorize writes.

## Enforce a deletion policy

For the schema in the [relationships guide](./relationships), reject deletion while seasons still reference the serie:

```javascript
const serieController = {
  onDelete: async (document, session) => {
    if (!document) return;

    const hasSeasons = await simfinity.getModel(SeasonType)
      .exists({ serie: document._id })
      .session(session);

    if (hasSeasons) {
      throw new simfinity.SimfinityError(
        'Remove the seasons before deleting this serie',
        'SERIE_HAS_SEASONS',
        400,
      );
    }
  },
};
```

The hook throws before the delete executes. A controller does not supply automatic cascade semantics; choose them explicitly for your domain.

## Transactions and side effects

All these hooks run inside the mutation transaction, before it commits. Neither `onSaved` nor `onUpdated` is an after-commit notification. If a later step fails, the transaction can still be rolled back.

Use the supplied session for additional database operations:

```javascript
await AuditModel.create(
  [{ entityId: document._id, action: 'created' }],
  { session },
);
```

`AuditModel` is an application-defined Mongoose model. This write can participate in the same MongoDB transaction as the entity change. PostgreSQL controllers use `session.query(sql, values)` or a PostgreSQL Model method with `{ session }` instead. [Server-side operations](./server-side-operations#work-inside-the-transaction-with-controllers) shows both backends side by side, including reads of the transaction's uncommitted writes and counters kept with native calls.

On PostgreSQL, a statement that fails aborts the whole transaction, even when the hook catches its error: the mutation then fails with `DATABASE_ERROR` (500) and nothing is stored. When another statement runs in the aborted transaction, such as Simfinity's own write after `onSaving`, `onUpdating` or `onDelete`, or a later query of the hook, that statement fails and the message is `Database operation failed`. When nothing runs after the failure, as after `onSaved` or `onUpdated`, PostgreSQL rolls the transaction back at `COMMIT` and the message is `Transaction was rolled back because one of its statements failed`. To make a statement optional, wrap it in a savepoint:

```javascript
await session.query('SAVEPOINT audit');
try {
  await session.query('INSERT INTO audit_log (entity_id) VALUES ($1)', [document.id]);
} catch (error) {
  await session.query('ROLLBACK TO SAVEPOINT audit');
}
```

`session.query()` rejects with the `pg` error itself, so the hook can inspect its `code` before deciding to continue. Errors that a hook throws propagate unchanged, as on MongoDB.

Transaction retries can execute hooks, and the middleware of nested collection children, more than once, up to five retries after the initial attempt. Each complete retry first waits a short random delay. On MongoDB, an uncertain commit result retries only the commit without repeating hooks; PostgreSQL retries confirmed serialization/deadlock aborts as complete attempts. When a concurrent write still conflicts after the retries, the mutation fails with `TRANSACTION_RETRY_EXCEEDED` (409) and its hooks' database work is rolled back; see [transaction boundaries](./mutations#transaction-boundaries). If an outcome remains uncertain, reconcile it before repeating the mutation. For email, webhooks, or other irreversible external actions, store an outbox event within the transaction and process it after commit. Calling an external service inside a hook does not make that call transactional.

## After-commit callbacks

Controllers can also declare optional callbacks for work that should run only after the owning transaction has committed:

| Callback | Arguments | Operation |
| --- | --- | --- |
| `onSaveCommitted` | `record, args, context` | Creation, including initialization of a state machine |
| `onUpdateCommitted` | `record, context` | Ordinary update |
| `onDeleteCommitted` | `record, context` | Actual deletion; not a missing record |
| `onTransitionCommitted` | `record, action, context` | State action; `action` is the registered name |

These callbacks receive no session. A state action calls only `onTransitionCommitted` as its committed notification, while its existing `onUpdating` and `onUpdated` hooks still run inside the transaction.

```javascript
const controller = {
  onUpdateCommitted: async (record, context) => {
    await notifications.sendUpdated(String(record._id ?? record.id), context?.requestId);
  },
  onTransitionCommitted: async (record, action, context) => {
    await notifications.sendTransition(String(record._id ?? record.id), action, context?.requestId);
  },
};

simfinity.configureAfterCommit({
  onError: async (error, details) => {
    await monitoring.report(error, {
      typeName: details.typeName,
      operation: details.operation,
      committed: details.committed,
    });
  },
});
```

`notifications` and `monitoring` are application services. Register the controller with `connect()` as above. Configuration belongs to the selected runtime; it does not configure other instances. Call `configureAfterCommit()` to restore default reporting. The reporter receives the original thrown value and `{ committed: true, typeName, operation, callbackName, context }`; `operation` is `save`, `update`, `delete`, or `state_changed`. Default reporting logs only static operation metadata. Reporter and logger failures are guarded too.

**Ordering and completion.** Notifications queue when each lifecycle operation completes. Collection children precede their parent; within each collection, existing traversal processes `added`, `updated`, then `deleted`, in item order. Callbacks run serially after commit and after cleanup is attempted, and are awaited before the owning call returns. An error is reported and later callbacks continue; the callback error does not fail the committed mutation, become a GraphQL error, or retry the transaction. Bound external I/O in the application: Simfinity adds no callback timeout or background delivery. Separate transactions have no shared notification order.

**Retries and rollback.** Every attempt has its own queue. Aborted attempts dispatch nothing. Only the successful attempt dispatches; an uncertain MongoDB commit retains its queue through commit-only retries and dispatches only upon confirmation. If uncertainty remains, nothing dispatches, although the write might have committed. An existing cleanup failure after a confirmed commit still rejects the owning call under the existing cleanup contract; its confirmed queue nevertheless runs. Such a rejection is not a rollback and must not prompt blind write retries.

**Values.** `record` is a detached plain representation of the operation result, captured after its legacy hooks and state normalization. It is not a GraphQL selection, does not re-read the database, and retains backend ID, scalar and storage-field representations. Creation `args` is the successful attempt's inner input at completion. Ordinary objects, arrays and Dates are copied; opaque custom scalar instances retain identity and must be treated as immutable. The original context reference, possibly `undefined`, is passed unchanged. Multiple operations on one record produce separate notifications with their respective results, not the transaction's final record image. Embedded values and native cascades do not invent child controller events.

**Ownership.** Generated mutations, sessionless `saveObject()`, registered mutations, and SQL's `withTransaction(null, callback)` have a Simfinity owner. A lifecycle write using that owner's supplied session joins its queue and waits for the outer commit. A native MongoDB transaction supplied by the application has no observed owner: new callbacks are skipped, with one warning per runtime/type. Simfinity does not watch or patch external `commitTransaction()`, adopt another adapter instance's queue, or offer a manual notification-flush API. SQL keeps rejecting foreign/native clients as sessions. Direct native writes invoke no controller callbacks.

The owner must control transaction completion. Manual commits/aborts, restarting its transaction, or rolling back successful lifecycle operations to native savepoints cannot synchronize this queue. Statement-only savepoints that do not undo queued lifecycle writes remain usable. Let lifecycle failures propagate to the owner; catching one and committing does not give its partial writes nested atomicity.

Callbacks are best-effort process-local effects. A process can exit after commit and before delivery; a caller can submit the same write again. Use a transactional outbox and delivery worker for durable intent, idempotency and delivery retries. These callbacks provide neither exactly-once delivery nor a replacement for workers.

Custom database adapters must implement the optional `DatabaseAdapter.enqueueAfterCommit(session, run)` contract to support these callbacks. Configuring them against an unsupported adapter throws `UNSUPPORTED_AFTER_COMMIT` (500), including when a controller is changed after schema creation. Non-function callback members throw `INVALID_CONTROLLER` (400).

## Nested writes and direct model access

Referenced collection changes call the child type's controller with the same session and request context. Direct calls to a Mongoose or PostgreSQL native model bypass Simfinity's controller and validation pipeline.

Use [`saveObject()`](../reference/api#saveobject) when you need Simfinity's creation pipeline programmatically. Pass the supplied active session inside a hook or custom mutation to share its transaction; without a session, `saveObject()` owns a separate transaction. On MongoDB the session must come from the MongoDB client of the model that `saveObject()` writes, which a custom mutation's session may not; see [which connection the session uses](./mutations#which-connection-the-session-uses-on-mongodb). Pass the hook's `context` as the fourth argument as well, so that nested collection children's middleware sees the request context. Use [custom mutations](./mutations#add-a-custom-mutation) when you need to coordinate an explicit sequence of operations.
