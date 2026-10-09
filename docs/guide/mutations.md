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

Nested inputs follow the relationship's storage model: embedded objects accept their fields, references accept `{ id }`, and referenced collections accept `added`, `updated`, and `deleted`. See [relationships](./relationships). To bound how many nested collection operations one mutation may carry, see [limit nested collection operations](#limit-nested-collection-operations).

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
:::

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

## Transaction boundaries

Each generated root mutation field runs in its own backend transaction. Its parent and nested child writes share that transaction. A write or hook failure aborts those writes; a confirmed retryable transaction error can retry the operation, up to five retries after the initial attempt. MongoDB uses the registered model connection; PostgreSQL uses the configured pool and repeatable-read isolation.

Each retry first waits a random delay of less than 10, 20, 40, 80 and 160 ms, so conflicting transactions do not retry in lock-step. On MongoDB the delay starts after the failed attempt is aborted; on PostgreSQL, after it has rolled back and released its pooled connection. A concurrent-write conflict that the retries do not resolve fails with `TRANSACTION_RETRY_EXCEEDED` (409) on both backends: on MongoDB, a `WriteConflict` still present after the last retry, with the driver error available as `error.cause`; on PostgreSQL, a serialization failure or deadlock it does not retry again. Other transient MongoDB errors that outlast the retries are returned unchanged, and a supplied session receives the driver error with its `errorLabels`, because its caller owns retries.

MongoDB's optional [transactional reference integrity](./mongodb-integrity) mode uses snapshot reads and majority commits, checks missing targets and restricts target deletion under coordinated document locks. A reference violation aborts the whole transaction, including a supplied session. The default Mongo mode remains unchanged.

On MongoDB, an `UnknownTransactionCommitResult` retries only the commit, up to five times, without repeating writes or hooks. An expired commit (`MaxTimeMSExpired`) is not retried. PostgreSQL retries confirmed serialization/deadlock aborts as complete transaction attempts. If a driver reports an uncertain outcome, reconcile it before repeating an operation. Session cleanup is awaited, and cleanup failures do not replace an earlier operation error.

Multiple root mutation fields in a GraphQL request are not one shared transaction. If a later field fails, an earlier field may already have committed. Use a custom mutation when a business operation needs a single transaction spanning several writes.

Controllers, validators, and state actions can run again on a retry. Keep their database work on the supplied session and design external side effects separately from the transaction. See [controllers](./controllers#transactions-and-side-effects).

## Limit nested collection operations

Each nested `added`, `updated` or `deleted` entry runs its own middleware, hooks and database writes inside the parent's transaction. A large nested input can therefore hold a long transaction. Cap it once at startup:

```javascript
simfinity.configureMutationLimits({ maxNestedOperations: 100 });
```

Simfinity counts the `added`, `updated` and `deleted` entries of non-embedded collection fields at every nesting level of one generated add, update or state-action mutation, including `null` entries. The check runs after root middleware and before the transaction starts. A mutation over the limit fails with `NESTED_OPERATIONS_EXCEEDED` (400) and writes nothing.

The setting is process-wide and shared by every runtime. It is unlimited by default. `0` forbids nested operations, and calling `configureMutationLimits()` without arguments restores the default. Unknown or misspelled options, such as `maxNestedOperation`, throw `INVALID_MUTATION_LIMITS` (400) and keep the current limit, so a typo cannot silently remove it. Root deletes, `saveObject()`, custom mutations and embedded lists are not counted. See the [API reference](../reference/api#configuremutationlimits).

## Add a custom mutation

Use `registerMutation()` for an operation that does not fit the generated CRUD shape. This example creates a serie through the same materialization and lifecycle pipeline while sharing the custom mutation's transaction:

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

A MongoDB session belongs to one MongoDB client, and `saveObject()` and native model calls that use it must write models of that client. Generated mutations and `saveObject()` without a session use the connection of the type's model. A custom mutation names no model, so in the default `referentialIntegrity: 'off'` mode its session uses the default Mongoose connection, `mongoose.connection`. The exception is an unused default connection: one that was never opened and on which no model is compiled, neither one of yours nor one that Simfinity generates, also counting models compiled on its `useDb()` connections, which share its client. When, in addition, every registered model uses one MongoDB client, such as the models of one `mongoose.createConnection()` connection and its `useDb()` connections, the session uses that client. With `referentialIntegrity: 'transactional'`, it uses the first protected model's connection. A direct `adapter.withTransaction(null, callback)` call on an off-mode adapter bound to a runtime follows the same rule; an unbound adapter keeps `mongoose.connection`.

An application that opens the default connection after it starts serving keeps it for requests that arrive first only when a model is compiled on it or on one of its `useDb()` connections; such requests wait for the connection. Simfinity does not see connections created with `useDb(name, { noListener: true })`, nor native writes such as `mongoose.connection.collection(…)`, which compile no model. Without such a model, a request that arrives before `mongoose.connect()` gets a session from the registered models' client, and a callback that writes default-connection collections with it fails with `ClientSession must be from the same MongoClient`. Compile a model on the default connection, or open it before serving.

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
