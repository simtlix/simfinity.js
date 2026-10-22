---
title: Server-side operations
description: Read and write data from jobs, workers, webhooks, internal commands and seed scripts through nested mutations, controllers, in-process GraphQL, custom mutations and native models.
---

# Server-side operations

The generated GraphQL schema is Simfinity's interface to your data. It is the same on MongoDB and PostgreSQL, and its operations run your middleware, query scopes, validators, controllers and transactions. Server code that does not answer a client request, such as a scheduled job, a queue worker, a webhook handler, an internal command or a seed script, should reach the data through the same paths. This guide shows which path fits which task and what each one runs. For approaches that look convenient and cause trouble later, see [usage anti-patterns](./anti-patterns).

Examples use the selected runtime from [database setup](./databases#runtime-setup-for-shared-examples). After `createSchema()`, PostgreSQL also requires awaited storage initialization before operations are served.

## Choose the path

- A record and the child records that change with it, such as an order and its lines: one [generated mutation with nested collection writes](#write-a-parent-and-its-children-together).
- Writes that must accompany an entity change, such as audit rows, outbox events, counters or derived totals: [controller hooks](#work-inside-the-transaction-with-controllers) that use the session they receive.
- A job, worker or webhook that reads data or runs an existing generated operation: [execute the generated schema in-process](#execute-the-generated-schema-in-process).
- A read that generated filters, scopes and aggregates cannot express, for clients and server code alike: a [virtual field](./queries#virtual-fields) on the type it belongs to, read through the generated queries.
- A frequent list read with a fixed predicate and typed params, shared by web, MCP and in-process callers: a [named view](./queries#named-views).
- A read whose result is not a stored record, such as a price preview, data from another service, a permission evaluation or an export: a [custom query](./queries#custom-queries), registered with `registerCustomQuery()`. Its callback opens its own transaction when it needs one.
- One command that creates several records, of one type or several, in a single transaction: a [custom mutation with `saveObject()`](#create-several-records-in-one-custom-mutation).
- Conditional updates, counters, upserts, leases, bulk changes and infrastructure rows without a business lifecycle: the [native model with the session](#use-the-native-model-for-atomic-operations).
- Updates or deletes of several unrelated records in one transaction: not generated yet; see [what Simfinity does not provide](#what-simfinity-does-not-provide).

## Write a parent and its children together

Model the children as a referenced collection. In this schema, each order line links back to its order through `order`:

```javascript
import {
  GraphQLEnumType,
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from 'graphql';
import { validators } from '@simtlix/simfinity-core';
import { simfinity } from './runtime.js';

const OrderStatusType = new GraphQLEnumType({
  name: 'OrderStatus',
  values: { DRAFT: {}, PLACED: {}, CLOSED: {} },
});

export const OrderType = new GraphQLObjectType({
  name: 'Order',
  fields: () => ({
    id: { type: GraphQLID },
    number: { type: new GraphQLNonNull(GraphQLString), extensions: { unique: true } },
    status: { type: OrderStatusType },
    total: { type: GraphQLInt, extensions: { readOnly: true } },
    lineSequence: { type: GraphQLInt, extensions: { readOnly: true } },
    lines: {
      type: new GraphQLList(OrderLineType),
      extensions: { relation: { embedded: false, connectionField: 'order' } },
    },
  }),
});

export const OrderLineType = new GraphQLObjectType({
  name: 'OrderLine',
  fields: () => ({
    id: { type: GraphQLID },
    sku: { type: new GraphQLNonNull(GraphQLString) },
    quantity: {
      type: new GraphQLNonNull(GraphQLInt),
      extensions: { validations: validators.positive('Quantity') },
    },
    unitPrice: { type: new GraphQLNonNull(GraphQLInt) },
    position: { type: GraphQLInt, extensions: { readOnly: true } },
    order: {
      type: new GraphQLNonNull(OrderType),
      extensions: { relation: { embedded: false, connectionField: 'order' } },
    },
  }),
});

simfinity.connect(null, OrderType, 'order', 'orders');
simfinity.connect(null, OrderLineType, 'orderline', 'orderlines');
```

Create an order and its lines with one mutation:

```graphql
mutation {
  addorder(input: {
    number: "SO-1001"
    status: DRAFT
    lines: {
      added: [
        { sku: "A-100", quantity: 1, unitPrice: 1200 }
        { sku: "B-200", quantity: 2, unitPrice: 450 }
      ]
    }
  }) {
    id
  }
}
```

Add, change and remove lines of an existing order with another:

```graphql
mutation EditOrder($id: ID!, $lineId: ID!, $removedLineId: ID!) {
  updateorder(input: {
    id: $id
    lines: {
      added: [{ sku: "C-300", quantity: 5, unitPrice: 200 }]
      updated: [{ id: $lineId, quantity: 3 }]
      deleted: [$removedLineId]
    }
  }) {
    id
  }
}
```

Each mutation runs in one backend transaction. Simfinity writes the order first: a create validates its input, runs the order's `onSaving` hook and inserts it; an update validates, runs `onUpdating` and updates it. It then processes each collection field's `added`, `updated` and `deleted` entries, in that order and one at a time. Every entry runs the line type's global middleware with the request context, as a `save`, `update` or `delete` operation. An `updated` or `deleted` entry then reads its line in the transaction, locking the row on PostgreSQL, and fails with `ForbiddenError` (403) when the line belongs to another order. Added and updated lines run the line type's validators, and every entry runs the line type's controller hooks with the same session and context. The order's `onSaved` or `onUpdated` hook runs last, after every line. An error anywhere rolls back the order and all of its lines, and a retried transaction runs every step again. See [update a collection](./relationships#update-a-collection) and [transaction boundaries](./mutations#transaction-boundaries).

Server code runs these mutations the same way as a client, through [in-process execution](#execute-the-generated-schema-in-process). To cap how many nested entries one generated mutation may carry, set `configureMutationLimits({ maxNestedOperations })` at startup; see [limit nested collection operations](./mutations#limit-nested-collection-operations).

Three limits shape these inputs. An `added` item has no `id`, because generated create inputs exclude the entity ID: Simfinity assigns it, so keep an external or client reference in a field of its own, with `extensions.unique` when it must be unique. Items added in the same mutation cannot refer to each other, since their IDs do not exist yet; link them in the parent's `onSaved` or `onUpdated` hook, with the session. Root mutation permissions of the [authorization plugin](./authorization) do not authorize nested entries, so authorize them in the child type's middleware or controller.

## Work inside the transaction with controllers

Controller hooks run inside the mutation's transaction and receive its session and the request context; see [hook signatures](./controllers#hook-signatures). Use them for writes that must commit or roll back with the entity: audit rows, outbox events, counters and derived values. This controller recomputes the order total whenever a mutation creates or updates an order, after its lines, and records an outbox event:

::: code-group

```javascript [MongoDB]
import mongoose from 'mongoose';
import { simfinity } from './runtime.js';
import { OrderLineType, OrderType } from './order.js';

// An application-owned collection without a business lifecycle.
const OutboxModel = mongoose.model('Outbox', new mongoose.Schema({
  topic: String,
  orderId: mongoose.Schema.Types.ObjectId,
  actor: String,
}));

const refreshOrder = async (topic, order, session, context) => {
  // Reads the lines as this transaction left them.
  const lines = await simfinity.getModel(OrderLineType)
    .find({ order: order._id })
    .session(session)
    .lean();
  const total = lines.reduce((sum, line) => sum + line.quantity * line.unitPrice, 0);
  await simfinity.getModel(OrderType).updateOne(
    { _id: order._id },
    { $set: { total } },
    { session },
  );
  order.total = total; // The mutation returns this record.
  await OutboxModel.create(
    [{ topic, orderId: order._id, actor: context?.user?.id }],
    { session },
  );
};

export const orderController = {
  onSaved: (order, args, session, context) => refreshOrder('order.created', order, session, context),
  onUpdated: (order, session, context) => refreshOrder('order.updated', order, session, context),
};
```

```javascript [PostgreSQL]
import pg from 'pg';
import { simfinity } from './runtime.js';
import { OrderType } from './order.js';

// Generated tables are named after their types, in the schema given to createPostgres().
const table = (name) => `${pg.escapeIdentifier('series_api')}.${pg.escapeIdentifier(name)}`;

const refreshOrder = async (topic, order, session, context) => {
  // Reads the lines as this transaction left them.
  const { rows } = await session.query(
    `SELECT COALESCE(SUM(quantity * "unitPrice"), 0)::int AS total
       FROM ${table('OrderLine')} WHERE "order" = $1`,
    [order.id],
  );
  await simfinity.getModel(OrderType).update(order.id, { total: rows[0].total }, { session, version: false });
  order.total = rows[0].total; // The mutation returns this record.
  await session.query(
    'INSERT INTO app.outbox (topic, entity_id, actor) VALUES ($1, $2, $3)',
    [topic, order.id, context?.user?.id],
  );
};

export const orderController = {
  onSaved: (order, args, session, context) => refreshOrder('order.created', order, session, context),
  onUpdated: (order, session, context) => refreshOrder('order.updated', order, session, context),
};
```

:::

Pass the controller as the fifth argument of `connect()`, as in `simfinity.connect(null, OrderType, 'order', 'orders', orderController)`. `OutboxModel` and the `app.outbox` table are application-defined.

In the next release, these derived-total writes deliberately preserve the current revision: MongoDB `updateOne` leaves `version` untouched, and PostgreSQL uses `{ session, version: false }`. This option is ignored on unprotected handles and is not in 3.12.0; see [writes made by hooks](./concurrency#writes-made-by-hooks).

A derived value needs both hooks. `onSaved` runs after a create, including `addorder` with its lines and a `saveObject()` call, and `onUpdated` after an update; each receives the stored record, with `_id` on MongoDB and `id` on PostgreSQL. The mutation returns that same record after the hook, so the hook also sets `total` on it; without that line, a client that selects `total` from `addorder`, `updateorder` or `checkout` receives the total as it was before the hook ran. The order's hooks run only when a mutation writes the order. The `addorderline`, `updateorderline` and `deleteorderline` mutations that `connect()` generates for `OrderLineType` change lines without them and leave the total stale. Leave those mutations out of the schema, so that lines change only through their order:

```javascript
// Generated queries for every type, generated mutations only for orders.
const schema = simfinity.createSchema(null, [OrderType]);
```

Nested `lines` entries of `addorder` and `updateorder` still work, because the allowlist selects root fields only; see [`createSchema()`](../reference/api#createschema). If the line mutations must stay, recompute the order's total from the line controller's hooks as well.

On MongoDB, pass the session to every Mongoose call: `.session(session)` on a query, or `{ session }` in the options. On PostgreSQL the hook's `session` runs SQL on the transaction's connection with `session.query(sql, values)`, and the native model's `findById`, `find`, `create`, `update` and `delete` join the transaction when you pass `{ session }`. Generated tables and columns use the GraphQL type and field names, and a reference column uses its `connectionField`; `simfinity.describeDatabase()` returns the exact physical names. The native `find()` takes generated filter arguments, such as `{ order: { terms: [{ path: 'id', operator: 'EQ', value: order.id }] } }`, and without `pagination` returns at most `Math.min(100, maxPageSize)` records, like a list query, so aggregate in SQL instead of loading every row. See [native Model and Session APIs](./postgresql#native-model-and-session-apis).

Reads made with the session see the transaction's own uncommitted writes. A nested line's `onSaving` hook already holds the parent link, so `simfinity.getModel(OrderType).findById(line.order).session(session)` on MongoDB, or `findById(line.order, { session })` on PostgreSQL, returns the order that the same mutation has just written. The order's `onSaved` and `onUpdated` hooks see every line the mutation added, changed or removed. Generated GraphQL reads never run in the caller's transaction: root queries pass no session to the database adapter, so inside a hook a GraphQL query, [in-process](#execute-the-generated-schema-in-process) or not, sees only committed data. Read through the model and the session there.

Await each database call of a session before starting the next one, rather than starting several with `Promise.all()`: Mongoose does not support parallel operations inside a transaction, and a PostgreSQL session is a single connection that runs one statement at a time. Hooks can run again when the transaction is retried, so keep their database work on the session and leave email, webhooks and other external calls to an outbox processed after commit; see [transactions and side effects](./controllers#transactions-and-side-effects).

## Execute the generated schema in-process

A job, worker or webhook that needs to read data or run a generated operation can execute the schema directly with graphql-js, without an HTTP round trip. The operation then runs as a client request does, apart from your GraphQL server's request plugins: GraphQL coerces the variables, so enum names become their internal values and scalars are validated, and the generated resolvers run middleware, scopes, validators, controllers, nested writes, limits and transactions. This helper prepares each document once and runs operations with a new context object each time:

```javascript
// run-operation.js
import { execute, parse, validate } from 'graphql';

// Runs operations of one schema from server code. Each document is parsed and
// validated once; values travel in variables.
export const createOperationRunner = (schema) => {
  const documents = new Map();
  const prepare = (source) => {
    let document = documents.get(source);
    if (!document) {
      document = parse(source);
      const errors = validate(schema, document);
      if (errors.length > 0) throw errors[0];
      documents.set(source, document);
    }
    return document;
  };

  return async (source, variables, context) => {
    // A new context object per operation: the list count lands on it, and
    // batched reads are grouped by it.
    const contextValue = { ...context };
    const result = await execute({
      schema, document: prepare(source), variableValues: variables, contextValue,
    });
    if (result.errors?.length) throw result.errors[0].originalError ?? result.errors[0];
    return { data: result.data, count: contextValue.count };
  };
};
```

A billing job can then list placed orders and close one of them:

```javascript
import { schema } from './schema.js';
import { createOperationRunner } from './run-operation.js';

const runOperation = createOperationRunner(schema);
const billingJob = { user: { id: 'billing-job', role: 'system' } };

const { data, count } = await runOperation(
  `query PlacedOrders($page: Int!) {
    orders(
      status: { operator: EQ, value: "PLACED" }
      sort: { terms: [{ field: "number", order: ASC }] }
      pagination: { page: $page, size: 50, count: true }
    ) { id number }
  }`,
  { page: 1 },
  billingJob,
);

await runOperation(
  `mutation CloseOrder($id: ID!) {
    updateorder(input: { id: $id, status: CLOSED }) { id }
  }`,
  { id: data.orders[0].id },
  billingJob,
);
```

Keep operation sources constant and pass every value in variables, so each document is parsed and validated once and no value is ever spliced into GraphQL text. graphql-js's `execute()` does not validate documents itself, which is why the helper calls `validate()` before caching one. The MCP package runs its in-process tools the same way: each tool's operation is parsed and validated on its first call and then reused, and every call runs graphql-js's `execute()`; see [execution and context](../reference/mcp#execution-and-context).

The context identifies the caller. A system actor, such as the billing job, is a context like any other: your middleware, query scopes, controllers and permission rules must recognize it and grant it what it needs, as they would a user. Pass a new object for every operation, as the helper does. With `pagination: { count: true }`, the generated list resolver writes the matching total to `context.count`, which the helper returns as `count`; one context object holds one count, so request one counted list per operation. Batched relationship reads are also grouped by context object, and middleware may store per-request data on it.

The helper throws the first error. Errors raised by Simfinity are `SimfinityError`s with a code in `extensions.code`, also returned by `getCode()`, such as `VALIDATION_ERROR`, or `DUPLICATE_KEY` on PostgreSQL; document and variable errors are `GraphQLError`s.

Select only `id` from a mutation run by server code. A generated mutation resolver returns after its transaction has committed, and GraphQL resolves the selected fields afterwards. A field that fails then, because a permission rule denies it or a relationship read fails, is reported as an error although the write is already stored, so the helper throws and a caller that retries on errors writes twice. Read whatever else you need with a separate query.

Each root mutation field runs in its own transaction, and several root fields in one document are not one transaction; see [transaction boundaries](./mutations#transaction-boundaries). Do not run operations from inside a hook or a custom mutation: a query there does not see the caller's uncommitted writes, and a mutation opens another transaction, which commits on its own and can conflict with or wait for the caller's.

The [authorization plugin](./authorization) wraps the schema's resolvers in place when its `onSchemaChange` hook runs. When your GraphQL server applied the plugin to the same schema object, in-process operations run the same rules. In a process without a GraphQL server, such as a worker, call the hook once at startup, as the MCP package does with its `schemaPlugins` option:

```javascript
import { createAuthPlugin } from '@simtlix/simfinity-core/auth';
import { permissions } from './permissions.js';

createAuthPlugin(permissions, { defaultPolicy: 'DENY' }).onSchemaChange({ schema });
```

Server request hooks do not run, because the helper calls graphql-js directly rather than through Envelop, Yoga or Apollo Server. The count plugins do not add `extensions.count`, which is why the helper reads `context.count`; error masking, depth or cost limits and tracing plugins do not run either. Add equivalent checks to the helper when server code needs them.

## Create several records in one custom mutation

When one command creates several records, register a custom mutation and create each record with `saveObject()` and the mutation's session. This checkout creates an order with its lines and an invoice for it. It assumes an `Invoice` type with an `amount` and a single reference `order`:

The example uses the `orderController` above, which calculates `order.total` from the stored lines in `onSaved`. The invoice uses that total, including any price or quantity changes made by the line hooks or middleware.

```javascript
import {
  GraphQLInputObjectType,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLString,
} from 'graphql';
import { SimfinityError } from '@simtlix/simfinity-core';
import { simfinity } from './runtime.js';
import { OrderType } from './order.js';

const CheckoutLineInput = new GraphQLInputObjectType({
  name: 'CheckoutLineInput',
  fields: {
    sku: { type: new GraphQLNonNull(GraphQLString) },
    quantity: { type: new GraphQLNonNull(GraphQLInt) },
    unitPrice: { type: new GraphQLNonNull(GraphQLInt) },
  },
});

const CheckoutInput = new GraphQLInputObjectType({
  name: 'CheckoutInput',
  fields: {
    number: { type: new GraphQLNonNull(GraphQLString) },
    lines: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(CheckoutLineInput))) },
  },
});

const MAX_CHECKOUT_LINES = 100;

simfinity.registerMutation(
  'checkout',
  'Create a placed order with its lines and its invoice.',
  CheckoutInput,
  OrderType,
  async (input, session, context) => {
    if (input.lines.length > MAX_CHECKOUT_LINES) {
      throw new SimfinityError(`A checkout takes at most ${MAX_CHECKOUT_LINES} lines`, 'BAD_REQUEST', 400);
    }
    const order = await simfinity.saveObject('Order', {
      number: input.number,
      status: 'PLACED',
      lines: { added: input.lines },
    }, session, context);
    const amount = order.total;
    await simfinity.saveObject('Invoice', { amount, order: { id: String(order._id) } }, session, context);
    return order;
  },
);
```

The callback runs inside one transaction, which Simfinity retries on transient conflicts. `saveObject()` with the supplied session joins it, so if the invoice fails, the order and its lines are not stored either. Each `saveObject()` call runs create materialization, field and type validators, nested collection writes with the child type's middleware and ownership checks, and the create controller hooks. It skips GraphQL input coercion, field authorization, the global middleware of the record itself and the nested operations limit of `configureMutationLimits()`, which counts neither `saveObject()` nor custom mutations; the custom mutation's own `custom_mutation` middleware has already run. Bound client-supplied lists in the callback before writing, as the checkout does with `MAX_CHECKOUT_LINES`. Pass values in their stored form, such as internal enum values and `{ id }` for references, and pass the `context` so that nested children's middleware sees it. On MongoDB, the session must belong to the MongoDB client of the models you write; see [which connection the session uses](./mutations#which-connection-the-session-uses-on-mongodb). See [add a custom mutation](./mutations#add-a-custom-mutation) and [`saveObject()`](../reference/api#saveobject).

`saveObject()` only creates records; Simfinity has no programmatic update or delete that runs the lifecycle. Inside a custom mutation, change existing records with the [native model and the session](#use-the-native-model-for-atomic-operations), with your own checks. From a job, outside any transaction, run the generated update or delete mutation [in-process](#execute-the-generated-schema-in-process). `saveObject()` without a session owns a transaction of its own, so a job can also call it directly, with the same skipped steps.

## Use the native model for atomic operations

`getModel(Type)` returns the type's Mongoose model on MongoDB and its `PostgresModel` on PostgreSQL. Native access with the session is a supported boundary, not a workaround: use it for conditional updates, counters, upserts, leases and claims, bulk changes, and collections or tables of your own without a business lifecycle, such as outbox events, idempotency receipts or sessions. This line controller numbers each new line within its order:

::: code-group

```javascript [MongoDB]
import { simfinity } from './runtime.js';
import { OrderType } from './order.js';

export const orderLineController = {
  onSaving: async (line, args, session) => {
    const order = await simfinity.getModel(OrderType).findOneAndUpdate(
      { _id: line.order },
      { $inc: { lineSequence: 1 } },
      { session, returnDocument: 'after', projection: { lineSequence: 1 } },
    );
    line.position = order.lineSequence;
  },
};
```

```javascript [PostgreSQL]
import pg from 'pg';

const table = (name) => `${pg.escapeIdentifier('series_api')}.${pg.escapeIdentifier(name)}`;

export const orderLineController = {
  onSaving: async (line, args, session) => {
    const { rows } = await session.query(
      `UPDATE ${table('Order')} SET "lineSequence" = COALESCE("lineSequence", 0) + 1
         WHERE id = $1 RETURNING "lineSequence"`,
      [line.order],
    );
    line.position = rows[0].lineSequence;
  },
};
```

:::

The counter changes in the same transaction as the line, so a rollback undoes both. Mutations that add lines to the same order at the same time conflict on the order and are retried, running the hook again, so every line gets its own number.

Simfinity adds nothing to a native call. GraphQL input coercion, global middleware, query scopes, field and type validators, controller hooks, permission rules, state machine transitions, nested-write ownership checks and mutation limits do not run, and on MongoDB [transactional reference integrity](./mongodb-integrity#existing-databases-and-native-writes) does not check native writes. PostgreSQL still enforces its foreign keys, `NOT NULL` columns and unique keys, and maps their violations to the [PostgreSQL database errors](../reference/errors#postgresql-database-errors). The calling code must therefore authorize and validate the change itself, and write values in their stored form: reference fields under their storage names, internal enum values and the backend's identifiers.

Inside a hook or a custom mutation, pass the session you received. A call without it runs outside the transaction: it commits even when the operation later rolls back. A single native statement from a job needs no transaction; to make several native writes atomic, open one with `simfinity.withTransaction(null, callback)` on PostgreSQL, or with Mongoose's `connection.transaction(callback)` on MongoDB, or put them in a custom mutation.

## What Simfinity does not provide

- No generated mutation updates or deletes several unrelated records in one transaction. Each root mutation field runs in its own transaction, and nested writes only reach the children of one parent. Write a custom mutation instead: `saveObject()` for new records and the native model with the session for changes, with your own checks. A generated mutation that runs a list of operations in one transaction is proposed in [#100](https://github.com/simtlix/simfinity.js/issues/100). The next release adds record-level [optimistic concurrency](./concurrency); it does not add operation-list transactions.
- No programmatic update or delete through the lifecycle. `saveObject()` creates records only.
- No generated read inside a caller's transaction. Generated queries never receive a session, so read uncommitted data through the native model. Virtual field resolvers receive no session either.
- No custom root reads of stored records outside a [named view](./queries#named-views): a view names a list read with a fixed predicate and params and runs the type's scope; a [custom query](./queries#custom-queries) is for results that are not stored records, and its callback bypasses the generated scopes and rules. Expose a read of stored records that generated filters, scopes and aggregates cannot express as a [virtual field](./queries#virtual-fields) on the type it belongs to, and read it from server code through [in-process execution](#execute-the-generated-schema-in-process); see [reading stored records through a custom mutation](./anti-patterns#reading-stored-records-through-a-custom-mutation).
- No IDs in nested `added` items, and no references between records added in the same mutation.
- No arbitrary caller-supplied condition on generated updates or deletes. The next release adds an expected-version precondition through declarative [optimistic concurrency](./concurrency); other conditions still require application checks with the session or a native conditional write.

Continue with [usage anti-patterns](./anti-patterns) for the approaches these paths replace.
