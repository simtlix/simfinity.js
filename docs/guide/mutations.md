---
title: Mutations
description: Create, update, and delete records, understand transaction boundaries, and extend your API with custom mutations.
---

# Mutations

Simfinity generates creation, update, and deletion mutations for every connected type. A type without writable fields gets no creation mutation, and, when its `id` is missing or `readOnly`, no update mutation or state machine actions either; see [what gets generated](./schema#what-gets-generated). Simfinity materializes GraphQL inputs, runs validation and controller hooks, and persists each operation in the selected backend's transaction.

Examples use the selected runtime from [database setup](./databases#runtime-setup-for-shared-examples). After `createSchema()`, PostgreSQL also requires awaited storage initialization before operations are served.

## Create a record

```graphql
mutation {
  addserie(input: {
    name: "Northern Lights"
    year: 2024
    category: "Drama"
  }) {
    id
    name
    year
  }
}
```

`SerieInput` is generated from the type. It excludes the entity `id`, fields marked `readOnly`, and a `state` field managed by a state machine. Required scalar, enum, embedded-object, and list fields remain required on creation. Lists preserve item nullability: `[String!]!` becomes `[String!]!` on create and `[String!]` on update.

Nested inputs follow the relationship's storage model: embedded objects accept their fields, references accept `{ id }`, and referenced collections accept `added`, `updated`, and `deleted`. See [relationships](./relationships). To bound how many nested collection operations one mutation may carry, see [limit nested collection operations](#limit-nested-collection-operations). To write a parent and its children, such as an order and its lines, in one transaction from server code, see [server-side operations](./server-side-operations#write-a-parent-and-its-children-together).

## Update selected fields

```graphql
mutation RenameSerie($id: ID!) {
  updateserie(input: {
    id: $id
    name: "Northern Lights: New Chapter"
  }) {
    id
    name
    category
  }
}
```

For a type with `id: GraphQLID`, `SerieInputForUpdate` requires `id`. Send the fields you want to change; omitted fields are left unchanged. A malformed ID, such as one that is not an ObjectId on MongoDB or not a UUID on PostgreSQL, fails with `NOT_VALID_ID` (400) before anything is written; for a type without embedded fields, the controller's `onUpdating` hook runs before that check and receives the raw ID (see [hook signatures](./controllers#hook-signatures)). An update targeting a nonexistent ID throws `NOT_VALID_ID` (404), before child operations or the `onUpdated` hook run.

For nullable scalar, embedded, and single-object reference fields, explicit `null` unsets the stored field. A reference uses its configured `connectionField`, or the GraphQL field name when no override exists. Multiple null fields are cleared together:

```graphql
mutation ClearCategory($id: ID!) {
  updateserie(input: { id: $id, category: null }) {
    id
    category
  }
}
```

::: info Partial updates and values
Generated update inputs remove the outer non-null wrapper so you can omit required fields, while keeping list-item non-null constraints. The entity `id` remains required for `GraphQLID` and `GraphQLID!`; other ID fields are optional. An explicit `null` for an originally non-null field leaves its stored value unchanged; use a custom update validator to reject that input if needed. Empty strings, `false`, `0`, and empty arrays are persisted after validation. Use `""` to store an empty string and `null` to remove a nullable field.
:::

Embedded objects merge supplied fields with their stored value; supplied embedded arrays replace the array. The merge is shallow, so a nested embedded object in the patch replaces the stored nested object. Inside an embedded object patch, an explicit `null` clears a nullable member: a scalar, enum, nested embedded object or single reference is stored as `null`, a reference under its `connectionField` or field name, and a list member is stored as an empty list. Unlike a top-level `null`, which removes the stored field, a cleared member stays in the stored embedded object with a `null` value; GraphQL filters treat `null` and a missing value the same. An explicit `null` for a non-null member keeps the stored value, as at the top level. Each resulting embedded value must still contain every required (non-null) member of its embedded type, including required references and the nested embedded values the patch supplies; otherwise the update fails with `REQUIRED_VALUE` (400) and nothing is stored. Stored nested values that the patch keeps are not checked again. The embedded `id` and `readOnly` members are not checked, and omitted list members of the written embedded values are stored as empty lists on both backends. This check runs before the controller's `onUpdating` hook, so the hook cannot supply a missing required embedded member. The parent update executes before referenced collection operations, which share the parent mutation's session. `onUpdated` then receives the updated backend record (a Mongoose document on MongoDB or a plain PostgreSQL record).

::: info MongoDB embedded objects in hydrated documents
On MongoDB, a nested embedded object cleared with `null` reads as `null` from mutation responses, by-ID reads, reference reads and lists. The Mongoose document that `onUpdated` receives still exposes an object at that path; call `record.toObject()` to read the stored `null`.

An optional embedded object that holds no data, because it was never written, a top-level `null` removed it, or a create omitted it and Mongoose stored only its list defaults (such as `{ phones: [] }`), reads as `null` on every read path, whatever the selection, when a required member would read as `null`. An `id` member, `readOnly` members, interface and union members, members with your own resolver and referenced collections do not count as missing, and a required list that holds `[]` is present, so an object that a generated create or update wrote reads back as written. An absent object whose type has no required member that counts still reads as an object of nulls in by-ID reads, reference reads and update responses, and as `null` in lists and create responses.

One exception: Mongoose minimizes empty objects when it saves a new document, so a create that writes an empty object for a required embedded member, such as `main: { geo: {}, tags: [] }`, stores that member as absent. An object that holds nothing else then reads as `null`, like an omitted one: in the create response and in list reads, and also in by-ID reads, reference reads and update responses when the model declares the member as a single nested subdocument, as generated models do for an embedded member named `type`. When the member is a nested path, as generated models declare every other embedded member, those reads still return the object, because Mongoose renders the absent nested path as `{}`. A generated update stores `geo: {}` and reads back as written. PostgreSQL rejects such a create with `REQUIRED_VALUE`.

Mongoose defaults count as data only on members of the GraphQL type: a default on a nested path that the type does not declare, such as an internal `source` field, does not keep an object that holds nothing else from reading as `null`.

Simfinity decides this from the stored data and never runs a schema getter or virtual of your model to do so: getters run only for the members a query selects, as before. An object whose type has no required member that counts is not read at all. A stored `_id` counts as the object's `id`, so an embedded object whose only stored data is its `_id`, such as a subdocument of an entity type, holds data. A subdocument schema without `_id: false` gives a stored subdocument that has no `_id`, such as `{}`, a new one each time Mongoose hydrates the document, so by-ID reads, reference reads and update responses keep such an object when its type declares `id`. A Mongoose map is read by its stored entries.

When your schema declares a getter, a virtual other than Mongoose's automatic `id`, an alias or a subdocument method on a member anywhere inside the object, including its subdocuments, the items of its lists and the values of its maps, the stored data does not show what the object renders: a getter default, a virtual, a method (GraphQL calls one named like a member) or an alias (which stores the value under its own path) may supply a required member. By-ID reads, reference reads and update responses then keep the object as stored and render it as before, running only the getters of the members a query selects. List reads and create responses return the stored data, which no getter, virtual or alias renders, so there such an object that holds no data and misses a required member reads as `null`; give the member your own resolver or mark it `readOnly` if it must count as present. Generated models declare no getters, virtuals, methods or aliases. If reading the stored data fails, the object is returned unchanged.
:::

### Version preconditions

For a type declaring `extensions.concurrency: { mode: 'optimistic' }`, send the version you read in `input.version`, alongside `id` and the patch; select the returned `version` for the next edit. Every accepted update advances it once, including `{ id, version }`-only patches. Creates exclude the field and initialize it at 1. A conflict means re-read and reapply, rather than replacing the version blindly. See [optimistic concurrency](./concurrency).

## Delete a record

```graphql
mutation RemoveSerie($id: ID!) {
  deleteserie(id: $id) {
    id
    name
  }
}
```

The mutation returns the deleted document, or `null` when no document matches. A controller's `onDelete` hook runs before the deletion and can reject it.

Deleting a parent does not automatically delete referenced children. Choose an application policy—reject deletion, retain children, or remove related records—and implement it using the same transaction session.

Protected deletes take `deletebook(id: ID!, version: RecordVersion!)` and return the deleted record including its stored version. Protected children use `{ id, version }` entries in collection `deleted` and require `version` in `updated`, even with an unprotected parent. A parent version covers only that parent; see [nested writes](./concurrency#deletes-nested-writes-and-state-actions).

## Transaction boundaries

Each generated root mutation field runs in its own backend transaction. Its parent and nested child writes share that transaction. A write or hook failure aborts those writes; a confirmed retryable transaction error can retry the operation, up to five retries after the initial attempt. MongoDB uses the registered model connection; PostgreSQL uses the configured pool and repeatable-read isolation.

Each retry first waits a random delay of less than 10, 20, 40, 80 and 160 ms, so conflicting transactions do not retry in lock-step. On MongoDB the delay starts after the failed attempt is aborted; on PostgreSQL, after it has rolled back and released its pooled connection. A concurrent-write conflict that the retries do not resolve fails with `TRANSACTION_RETRY_EXCEEDED` (409) on both backends: on MongoDB, a `WriteConflict` still present after the last retry, with the driver error available as `error.cause`; on PostgreSQL, a serialization failure or deadlock it does not retry again. Other transient MongoDB errors that outlast the retries are returned unchanged, and a supplied session receives the driver error with its `errorLabels`, because its caller owns retries.

MongoDB's optional [transactional reference integrity](./mongodb-integrity) mode uses snapshot reads and majority commits, checks missing targets and restricts target deletion under coordinated document locks. A reference violation aborts the whole transaction, including a supplied session. The default Mongo mode remains unchanged.

On MongoDB, an `UnknownTransactionCommitResult` retries only the commit, up to five times, without repeating writes or hooks. An expired commit (`MaxTimeMSExpired`) is not retried. PostgreSQL retries confirmed serialization/deadlock aborts as complete transaction attempts. If a driver reports an uncertain outcome, reconcile it before repeating an operation. Session cleanup is awaited, and cleanup failures do not replace an earlier operation error.

Multiple root mutation fields in a GraphQL request are not one shared transaction. If a later field fails, an earlier field may already have committed. Use a custom mutation when a business operation needs a single transaction spanning several writes; or the opt-in [transaction mutation](#run-several-mutations-in-one-transaction), which runs a list of generated mutations in one. [Server-side operations](./server-side-operations) shows which path a job, worker or internal command should take for each kind of write.

Controllers, validators, state actions and the middleware of nested collection children can run again on a retry. Keep their database work on the supplied session and design external side effects separately from the transaction. See [controllers](./controllers#transactions-and-side-effects).

For protected writes, `VERSION_CONFLICT` and `VERSION_EXHAUSTED` roll back the owned mutation without retrying those errors; a stale child also rolls back parent and sibling writes. Driver conflicts can rerun hooks before ending in a version conflict or `TRANSACTION_RETRY_EXCEEDED`. With supplied sessions preserve the caller's ownership: default MongoDB requires its caller to abort, while transactional-integrity mode aborts adapter-detected conflicts but not core-detected early conflicts. Core result diagnostics do not add a universal abort guarantee for supplied sessions. See [transactions and concurrent requests](./concurrency#transactions-and-concurrent-requests).

The optional [committed controller callbacks](./controllers#after-commit-callbacks) run only after a confirmed commit, once for each completed lifecycle operation in the successful attempt, serially and before returning. Their failures are reported independently and do not fail the write. A cleanup failure after commit retains its existing rejection behavior while the confirmed callbacks still run. Calls that borrow an application-owned native transaction do not dispatch these callbacks automatically; registered mutations and SQL's public `withTransaction()` are observed owners.

## Run several mutations in one transaction

::: info Available since 3.16.0
The transaction mutation is available since 3.16.0. A schema has none unless it asks for one, and schemas that do not ask are unchanged.
:::

Each root mutation field runs in its own transaction, so a client that creates a serie and its seasons, changes one record and deletes another, with nothing stored when any step fails, needs a custom mutation. Ask `createSchema()` for one `transaction` field instead: it runs a list of the generated mutations of the types you name, in order, in one database transaction. The examples use `Serie` and `Season` from the [relationships guide](./relationships#referenced-objects-and-collections), registered with `connect()` as `serie` and `season`:

```javascript
const schema = simfinity.createSchema(null, null, null, {
  transaction: { types: [SerieType, SeasonType] },
});
```

`types` is a non-empty array of distinct types registered in this runtime. The operations are the generated add, update, delete and state action mutations of those types that the schema includes, so `includedMutationTypes` still applies. Registered custom mutations, nested entries and controller callbacks are never operations. The optional `name` (default `transaction`) must be a GraphQL name that does not start with `__`. It names the field, and its types take it with the first letter in upper case. These are the additions for the default name, in the order that `printSchema()` prints them, where the keys follow the order of the generated mutations in the schema:

```graphql
type Mutation {
  # …the generated mutations…
  transaction(operations: [TransactionOperation!]!): [TransactionResult!]
}

type TransactionResult {
  id: ID
  addserie: Serie
  deleteserie: Serie
  addseason: Season
  deleteseason: Season
  updateserie: Serie
  updateseason: Season
}

input TransactionOperation @oneOf {
  addserie: SerieInput
  deleteserie: TransactionDeleteInput
  addseason: SeasonInput
  deleteseason: TransactionDeleteInput
  updateserie: SerieInputForUpdate
  updateseason: SeasonInputForUpdate
}

input TransactionDeleteInput {
  id: ID!
}
```

Each item of `operations` holds exactly one key, which `@oneOf` enforces. The key is the name of a generated mutation, and the value is that mutation's `input`: `SerieInput` for `addserie`, and for a state action such as `activate_season`, the update input like its root. A delete takes an object instead of the bare ID: `{ id }` (`TransactionDeleteInput`), or `{ id, version }` (`RecordVersionRef`) for a type with [optimistic concurrency](./concurrency#versions-in-helpers-and-transactions). `TransactionDeleteInput` exists only when the field has a delete of a type without it. GraphQL validates variables, literals, scalars, enums and `@oneOf` before anything runs, so a client sends the list as a variable:

```graphql
mutation LaunchSerie($operations: [TransactionOperation!]!) {
  transaction(operations: $operations) {
    id
    addserie { id name }
    addseason { id number }
    updateserie { id name }
  }
}
```

```json
{
  "operations": [
    { "addserie": { "name": "Northern Lights" } },
    { "addseason": { "number": 1, "year": 2024, "serie": { "id": "$0" } } },
    { "addseason": { "number": 2, "year": 2025, "serie": { "id": "$0" } } },
    { "updateserie": { "id": "$0", "name": "Northern Lights: New Chapter" } }
  ]
}
```

The field returns one result per operation, in order. A result has the record's `id` and one field per operation key; only the field of its own operation is set, with the type that mutation returns, and the others are `null`. A delete of a record that does not exist returns `null` for both its `id` and its field, and the list continues. An empty list returns `[]` without opening a transaction. The field is nullable, so an error nulls it and nothing is stored. As for the roots, the selected output fields are resolved after the commit, so an error there does not undo the writes.

### Reference earlier results

An operation can name the record that an earlier one wrote with `$K`, where `K` is the position of that operation in the list, counted from 0 and without leading zeros. The tokens are recognized only in these positions:

- the `id` of an update, state action or delete operation;
- the `id` of a single reference field, such as `serie: { id: "$0" }`;
- the `id` of a nested `updated` entry and each nested `deleted` item;
- a plain `ID` field of a child type that is the `connectionField` of a collection, when every collection that uses the field is declared on one type, which the referenced operation must write.

Every other string keeps its text, `$` included. In a position above, a value that starts with `$$` loses one `$` and is kept as a literal, so `$$0` stores the text `$0`; any other value that starts with `$` fails with `INVALID_OPERATION_REFERENCE` (400). The source must come before the operation that uses it, must not be a delete and must write the type the position expects, or the whole list fails before the transaction starts, with a message such as `Invalid reference at operations[0].addseason.serie.id: operation 1 does not exist`. Only IDs can be referenced, never children or versions: the expected `version` of every update, action and delete stays explicit, and a record that a list creates starts at version 1, so an update of it later in the list sends `version: 1` and a state action after that update sends `version: 2`. Each attempt resolves the tokens to the IDs that attempt created, so the IDs of a rolled-back attempt are never reused.

### What runs, and how often

One transaction, owned by the field, runs the list; the adapter retries it on a transient conflict as it does for a root, and each attempt repeats the whole list on a fresh copy of the operations. For each operation of an attempt, Simfinity:

1. resolves its `$K` references;
2. runs the authorization checks that a direct call to its root gets, see [authorize the transaction mutation](./authorization#authorize-the-transaction-mutation);
3. runs the root's global [middleware](./middleware) with the same parameters as for the root: `type`, `args` (`{ input }`, or `{ id }` and `{ id, version }` for deletes), `operation`, `context` and, for actions, `actionName` and `actionField`;
4. checks the nested limit and the collection connections of the input middleware left, and runs the operation with the lifecycle of its root: validators, controller hooks, nested entries and version checks.

Later operations see the writes of earlier ones through the shared session. An error in any operation rolls everything back, and the resolver returns only after the adapter confirms the commit. Middleware, validators and hooks run again on every attempt, and the `context` is the same object across operations and attempts, so changes a middleware makes to it are not undone by a retry. Keep side effects in an outbox, as described in [controllers](./controllers#transactions-and-side-effects).

Controller [after-commit callbacks](./controllers#after-commit-callbacks) from every operation, nested write and helper call using the attempt's session share one queue. They run serially only after the whole list commits and cleanup is attempted, in lifecycle completion order (children before their parent), and are awaited before the field returns. A rollback or retried attempt discards its queue. Multiple writes to one record keep separate snapshots; a callback failure is reported through `configureAfterCommit` and never changes the committed result or triggers a retry.

### Limits, errors and requirements

A list may hold at most `maxTransactionOperations` operations, 100 by default; a longer one fails with `TRANSACTION_OPERATIONS_EXCEEDED` (400) before any adapter call. The nested limit is joint: all the operations of one attempt share one `maxNestedOperations` budget. See [limit nested collection operations](#limit-nested-collection-operations).

An error of an operation carries `extensions.operationIndex` (0-based) and `extensions.operation` (the key), next to the code, status and message the same error has on its root: `VALIDATION_ERROR`, `VERSION_CONFLICT`, `NOT_VALID_ID`, `INVALID_INPUT` and the others keep them. Errors about the list as a whole (too many operations, the `NESTED_OPERATIONS_EXCEEDED` of the preflight that counts the nested entries of the whole list, models that cannot share a session) and errors of the transaction itself (begin, commit, rollback) carry no position. See [errors of the transaction mutation](../reference/errors#errors-of-the-transaction-mutation).

The database adapter must implement `assertTransactionModels(models)` to enable the field. The bundled MongoDB, SQL and PostgreSQL adapters do. On MongoDB the models of every type an operation can write, nested collections included, must share one `MongoClient`, such as the models of one `mongoose.createConnection()` connection and its `useDb()` siblings; models that belong to different clients cannot share a transaction, and the list fails with `TRANSACTION_UNSUPPORTED` (500) before a session opens. An adapter without the method makes `createSchema()` fail with the same code when `transaction` is set. See the [`createSchema()` reference](../reference/api#createschema) for the option's checks.

[MCP](./mcp#transaction-tool) can publish the field as one tool, and the [authorization guide](./authorization#authorize-the-transaction-mutation) explains how the rules of the operations apply.

## Limit nested collection operations

Each nested `added`, `updated` or `deleted` entry runs its own middleware, hooks and database writes inside the parent's transaction. A large nested input can therefore hold a long transaction. Entries run one at a time: an `updated` or `deleted` entry first reads its child (locking the row on PostgreSQL), then writes it, and a retried transaction runs every entry again. Cap them once at startup, especially on servers exposed to MCP clients or other untrusted callers:

```javascript
simfinity.configureMutationLimits({ maxNestedOperations: 100 });
```

Simfinity counts the `added`, `updated` and `deleted` entries of non-embedded collection fields at every nesting level of one generated add, update or state-action mutation, including `null` entries. The check runs after root middleware and before the transaction starts. A mutation over the limit fails with `NESTED_OPERATIONS_EXCEEDED` (400) and writes nothing. Since 3.16.0, `updateObject()` and `transitionObject()` check their `input` the same way, with the limit configured when they are called.

The setting is process-wide and shared by every runtime. It is unlimited by default. `0` forbids nested operations, and calling `configureMutationLimits()` without arguments restores the default. Unknown or misspelled options, such as `maxNestedOperation`, throw `INVALID_MUTATION_LIMITS` (400) and keep the current limits, so a typo cannot silently remove them. Root deletes, custom mutations and embedded lists are not counted, and neither is `saveObject()` outside a transaction mutation. See the [API reference](../reference/api#configuremutationlimits).

Since 3.16.0, the same call also sets `maxTransactionOperations`, the most operations one [transaction mutation](#run-several-mutations-in-one-transaction) may run. It is a positive safe integer and defaults to 100; `null`, `0` or a non-integer throw `INVALID_MUTATION_LIMITS` (400) and keep both current limits. Each call replaces both values, so `configureMutationLimits({ maxNestedOperations: 100 })` also restores `maxTransactionOperations` to 100, and the error for an unknown option now reads ``Unknown mutation limit option maxNestedOperation; use maxNestedOperations or maxTransactionOperations``.

Inside a transaction mutation the nested budget is joint. Every nested entry that runs in one attempt counts once against `maxNestedOperations`, whoever adds it: the operations' own inputs, entries that middleware, state actions and controller hooks add, and those of `saveObject()`, `updateObject()` and `transitionObject()` calls that hooks make with the attempt's session. The root records of operations and helper calls never count. A list that is already over the limit fails before the transaction starts, and an entry that crosses it later rolls back the writes of that attempt. A transaction mutation reads both limits once when it starts, so a later call to `configureMutationLimits()` applies from the next invocation.

## Add a custom mutation

Use `registerMutation()` for a write that does not fit the generated CRUD shape. Do not use it for reads: a custom mutation's callback always runs in a transaction, which may retry it, clients must send it in a `mutation` document, and MCP publishes it as a write. For a read of stored records that generated queries cannot express, add a [virtual field](./queries#virtual-fields) to the type it belongs to; for a read whose result is not a stored record, such as a price preview or data from another service, register a [custom query](./queries#custom-queries). A named read of stored records with a fixed predicate is a [named view](./queries#named-views). This example creates a serie through the same materialization and lifecycle pipeline while sharing the custom mutation's transaction:

```javascript
import {
  GraphQLInputObjectType,
  GraphQLNonNull,
  GraphQLString,
} from 'graphql';
import { simfinity } from './runtime.js';

const LaunchSerieInput = new GraphQLInputObjectType({
  name: 'LaunchSerieInput',
  fields: {
    name: { type: new GraphQLNonNull(GraphQLString) },
  },
});

// SerieType is the GraphQLObjectType from the getting-started guide.
simfinity.connect(null, SerieType, 'serie', 'series');

simfinity.registerMutation(
  'launchserie',
  'Create a drama serie in the catalog.',
  LaunchSerieInput,
  SerieType,
  async (input, session, context) => simfinity.saveObject(
    'Serie',
    { name: input.name, category: 'Drama' },
    session,
    context,
  ),
);

const schema = simfinity.createSchema();
```

Register custom mutations before calling `createSchema()`. Their callback receives the inner `input` value, the transaction session, and the GraphQL context.

```graphql
mutation {
  launchserie(input: { name: "Northern Lights" }) {
    id
    name
    category
  }
}
```

`saveObject()` owns a transaction when no session is supplied. Pass the supplied active session when using it inside a registered mutation: it shares that transaction without starting, committing, aborting, retrying, or ending it. On MongoDB the session must come from the MongoDB client of the model that `saveObject()` writes; see [which connection the session uses](#which-connection-the-session-uses-on-mongodb). MongoDB rejects an inactive native Mongoose session with `ACTIVE_TRANSACTION_REQUIRED` (400). PostgreSQL rejects an inactive or foreign Simfinity session with `INVALID_SESSION`. Direct Mongoose or PostgreSQL Model calls must also use the matching session and do not automatically run Simfinity validators, hooks, or authorization rules.

### Which connection the session uses on MongoDB

A MongoDB session belongs to one MongoDB client, and `saveObject()` and native model calls that use it must write models of that client. Generated mutations and `saveObject()` without a session use the connection of the type's model. A custom mutation names no model, so in the default `referentialIntegrity: 'off'` mode its session uses the default Mongoose connection, `mongoose.connection`. The exception is an unused default connection: one that was never opened and on which no model is compiled, neither one of yours nor one that Simfinity generates, also counting models compiled on its `useDb()` descendants at any depth, such as `mongoose.connection.useDb('tenant').useDb('audit')`, which share its client. When, in addition, every registered model uses one MongoDB client, such as the models of one `mongoose.createConnection()` connection and its `useDb()` connections, the session uses that client. With `referentialIntegrity: 'transactional'`, it uses the first protected model's connection. A direct `adapter.withTransaction(null, callback)` call on an off-mode adapter bound to a runtime follows the same rule; an unbound adapter keeps `mongoose.connection`.

An application that opens the default connection after it starts serving keeps it for requests that arrive first only when a model is compiled on it or on one of its `useDb()` descendants; such requests wait for the connection. Simfinity does not see connections created with `useDb(name, { noListener: true })`, nor their `useDb()` descendants, nor native writes such as `mongoose.connection.collection(…)`, which compile no model. Without such a model, a request that arrives before `mongoose.connect()` gets a session from the registered models' client, and a callback that writes default-connection collections with it fails with `ClientSession must be from the same MongoClient`. Compile a model on the default connection, or open it before serving.

When the default connection is in use and the custom mutation writes models of another client, `saveObject()` with the supplied session fails with `ClientSession must be from the same MongoClient`. In the default mode only, open a transaction on the model's connection inside the callback:

```javascript
simfinity.registerMutation(
  'importbook',
  'Import a book whose model uses another connection.',
  ImportBookInput,
  BookType,
  async (input, session, context) => {
    let book;
    await BookModel.db.transaction(async (bookSession) => {
      book = await simfinity.saveObject('Book', input, bookSession, context);
    });
    return book;
  },
);
```

Every write that must be atomic has to happen inside that transaction. It commits on its own, independently of the custom mutation's transaction, so work done after it commits is not rolled back when the custom mutation fails later. Calling `saveObject()` without a session also works, but each call is then atomic only by itself.

Continue with [validation](./validation) to reject invalid data and [authorization](./authorization) to control who can perform an operation.
