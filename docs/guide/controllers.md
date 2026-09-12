---
title: Controllers and lifecycle hooks
description: Add application behavior around record creation, updates, and deletion while preserving transaction and request context.
---

# Controllers and lifecycle hooks

A controller attaches application behavior to a connected type. Use it to populate server-managed fields, validate ownership, or coordinate database writes in the mutation's transaction.

## Attach a controller

This example assumes `SerieType` has read-only `createdAt` and `updatedAt` string fields. It sets timestamps without accepting those values from clients:

```javascript
import * as simfinity from '@simtlix/simfinity-js';

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
| `onSaving(document, args, session, context)` | Before inserting the parent document | Unsaved Mongoose document |
| `onSaved(document, args, session, context)` | After saving the parent and processing its collection inputs | Plain object snapshot of the saved parent |
| `onUpdating(id, changes, session, context)` | Before preparing the database update | Materialized update object |
| `onUpdated(document, session, context)` | After awaiting the parent update and processing collection inputs | Updated Mongoose document |
| `onDelete(document, session, context)` | Before deleting the record | Existing plain object, or `null` |

For create hooks, `args` is the inner mutation input. For update hooks, `changes` contains the materialized values, may contain `$unset`, and may include merged embedded data. It is not a complete copy of the stored document.

The parent update completes before collection writes. If no parent matches, the mutation throws `NOT_VALID_ID` (404) before processing children or calling `onUpdated`. The hook receives the updated Mongoose document, so it can read its fields or perform additional session-bound database work without executing the update query again.

## Check request context

The GraphQL context is passed to each hook. Your server is responsible for authenticating a request and supplying trusted identity information.

For a `SerieType` with a stored `ownerId` field, a controller can verify update ownership:

```javascript
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

`AuditModel` is an application-defined Mongoose model. This write can participate in the same transaction as the entity change.

Transient transaction retries can execute hooks more than once, up to five retries after the initial attempt. An uncertain commit result retries only the commit, up to five times, without repeating hooks. If uncertainty remains, the error is returned even though the database may already have committed; reconcile the outcome before repeating the mutation. For email, webhooks, or other irreversible external actions, store an outbox event within the transaction and process it after commit. Calling an external service inside a hook does not make that call transactional.

## Nested writes and direct model access

Referenced collection changes call the child type's controller with the same session and request context. Direct calls to a Mongoose model bypass Simfinity's controller and validation pipeline.

Use [`saveObject()`](../reference/api#saveobject) when you need Simfinity's creation pipeline programmatically. Pass the supplied active session inside a hook or custom mutation to share its transaction; without a session, `saveObject()` owns a separate transaction. Use [custom mutations](./mutations#add-a-custom-mutation) when you need to coordinate an explicit sequence of operations.
