---
title: Mutations
description: Create, update, and delete records, understand transaction boundaries, and extend your API with custom mutations.
---

# Mutations

Simfinity generates creation, update, and deletion mutations for every connected type. It materializes GraphQL inputs, runs validation and controller hooks, and persists the operation in a MongoDB transaction.

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

`SerieInput` is generated from the type. It excludes the entity `id`, fields marked `readOnly`, and a `state` field managed by a state machine. Required scalar fields remain required on creation.

Nested inputs follow the relationship's storage model: embedded objects accept their fields, references accept `{ id }`, and referenced collections accept `added`, `updated`, and `deleted`. See [relationships](./relationships).

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

For a type with `id: GraphQLID`, `SerieInputForUpdate` requires `id`. Send the fields you want to change; omitted fields are left unchanged. An update targeting a nonexistent ID throws `NOT_VALID_ID` (404), before child operations or the `onUpdated` hook run.

For ordinary nullable scalar fields, explicit `null` unsets the stored field:

```graphql
mutation ClearCategory($id: ID!) {
  updateserie(input: { id: $id, category: null }) {
    id
    category
  }
}
```

::: info Partial updates and values
Generated update inputs relax required scalar fields so you can omit them. That does not enforce the original non-null constraint when an explicit `null` is supplied: use a custom update validator when clearing must be rejected. The materialization pipeline skips empty strings, so use `null` to clear a nullable scalar instead of relying on `""` being stored.
:::

Embedded objects merge supplied fields with their stored value; supplied embedded arrays replace the array. The parent update executes before referenced collection operations, which share the parent mutation's session. `onUpdated` then receives the updated Mongoose document.

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

Each generated root mutation field runs in its own transaction on the registered model's connection. Its parent and nested child writes share that transaction. A write or hook failure aborts those writes; a transient transaction error can retry the operation, up to five retries after the initial attempt. A custom mutation uses the default Mongoose connection.

An `UnknownTransactionCommitResult` retries only the commit, up to five retries, without repeating writes or hooks. An expired commit (`MaxTimeMSExpired`) is not retried. If uncertainty remains after the limit, the original error is returned; the data may already have committed. Reconcile that outcome before repeating the mutation. Session cleanup is awaited, and abort/cleanup failures do not replace an earlier operation error. A cleanup failure after a successful commit is reported, but does not undo the committed data.

Multiple root mutation fields in a GraphQL request are not one shared transaction. If a later field fails, an earlier field may already have committed. Use a custom mutation when a business operation needs a single transaction spanning several writes.

Controllers, validators, and state actions can run again on a retry. Keep their database work on the supplied session and design external side effects separately from the transaction. See [controllers](./controllers#transactions-and-side-effects).

## Add a custom mutation

Use `registerMutation()` for an operation that does not fit the generated CRUD shape. This example creates a serie through the same materialization and lifecycle pipeline while sharing the custom mutation's transaction:

```javascript
import {
  GraphQLInputObjectType,
  GraphQLNonNull,
  GraphQLString,
} from 'graphql';
import * as simfinity from '@simtlix/simfinity-js';

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

`saveObject()` owns a transaction when no session is supplied. Pass the supplied active session when using it inside a registered mutation: it shares that transaction without starting, committing, aborting, retrying, or ending it. An inactive supplied session is rejected with `ACTIVE_TRANSACTION_REQUIRED` (400). Direct Mongoose calls must also use that session and do not automatically run Simfinity validators, hooks, or authorization rules.

Continue with [validation](./validation) to reject invalid data and [authorization](./authorization) to control who can perform an operation.
