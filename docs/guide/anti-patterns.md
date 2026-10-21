---
title: Usage anti-patterns
description: Patterns that work against Simfinity's generated API, why they hurt, and what to do instead.
---

# Usage anti-patterns

Simfinity generates one GraphQL API from your types, and that API runs your middleware, query scopes, validators, controllers and transactions on MongoDB and PostgreSQL alike. The patterns on this page bypass or rebuild that API. Each one looks like a shortcut when it is written and costs more later. Every section shows what the pattern looks like, why it hurts, and what to do instead; [server-side operations](./server-side-operations) describes the supported paths in full.

## Using Simfinity as a database driver

**What it looks like.** Every collection gets a flat type without relations, validators or controllers, the generated mutations are deleted from the schema, and a driver-like API is rebuilt on top of what remains:

```javascript
// One flat type per collection.
const OrderRecord = new GraphQLObjectType({
  name: 'OrderRecord',
  fields: { id: { type: GraphQLID }, customerId: { type: GraphQLID }, data: { type: GraphQLString } },
});
simfinity.connect(null, OrderRecord, 'orderRecord', 'orderRecords');
const schema = simfinity.createSchema();

// Generated mutations deleted after construction.
const mutations = schema.getMutationType().getFields();
for (const name of Object.keys(mutations)) {
  if (!allowedMutations.has(name)) delete mutations[name];
}

// A MongoDB-style API emulated over the generated operations.
await orderStore.find({ customerId }).sort({ createdAt: -1 }).limit(20).toArray();
await orderStore.updateMany({ status: 'DRAFT' }, { $set: { status: 'EXPIRED' } });
```

**Why it hurts.** The generated mutations are where Simfinity does its work: input materialization, field and type validators, controller hooks, nested collection writes and one retried transaction per root field. Flat types give it nothing to run, so the application pays for a GraphQL layer and still writes every rule by hand. Deleting fields mutates a schema that graphql-js has already built, while `createSchema()` can choose the generated operations itself. An emulated driver API cannot map upserts or multi-record updates onto generated operations, so it reads and writes record by record: `updateMany()` becomes a read plus one write per match and stops being one atomic statement. Its callers also stay tied to MongoDB's query language, while the generated GraphQL contract is the same on both backends.

**Do this instead.** Model the domain: types with [relationships](./relationships), [validators](./validation) and [controllers](./controllers). Choose which operations exist with the [`createSchema()` include lists](../reference/api#createschema), and reject individual operations in [middleware](./middleware):

```javascript
const schema = simfinity.createSchema(
  [OrderType, CustomerType], // generated queries
  [OrderType], // generated mutations
  ['checkout'], // custom mutations
);

simfinity.use(async ({ operation, type }, next) => {
  if (type?.gqltype === OrderType && operation === 'delete') {
    throw new simfinity.auth.ForbiddenError('Orders are closed, not deleted');
  }
  await next();
});
```

Use [custom mutations](./mutations#add-a-custom-mutation) for operations that are not a create, update or delete, and the [native model](./server-side-operations#use-the-native-model-for-atomic-operations) for collections without a business lifecycle, such as an outbox.

## Calling generated resolvers by hand

**What it looks like.** Server code takes a resolver out of the schema and calls it like a function:

```javascript
const { updateorder } = schema.getMutationType().getFields();
await updateorder.resolve(null, { input: { id, status: 'PLACED' } }, context, undefined);
```

**Why it hurts.** A generated root mutation resolver passes no session to the runtime, so it always opens and commits its own transaction; called inside another transaction, it cannot join it. Its arguments skip GraphQL coercion: an enum value arrives as its name instead of its internal value, defaults are not applied and scalars are not validated, so a record can be stored in a form that the schema then reads back as `null`. Resolvers are also an implementation detail of the GraphQL contract: the [authorization plugin](./authorization) replaces them in place, so a resolver captured before the plugin ran skips its rules.

**Do this instead.** [Execute the generated schema in-process](./server-side-operations#execute-the-generated-schema-in-process) with graphql-js, which coerces variables and runs the same pipeline as a client request. For several writes in one transaction, use a [custom mutation with `saveObject()`](./server-side-operations#create-several-records-in-one-custom-mutation).

## Passing sessions and filters through AsyncLocalStorage

**What it looks like.** Callers put a session, a filter or a pipeline in an `AsyncLocalStorage` store, and copies or overrides of adapter methods read it:

```javascript
const requestState = new AsyncLocalStorage();
const adapter = simfinity.createMongoAdapter();
const runtime = simfinity.createRuntime({
  ...adapter,
  update: (Model, id, changes, session) => Model.findOneAndUpdate(
    requestState.getStore().filter,
    changes,
    { session: requestState.getStore().session ?? session, new: true },
  ),
});
```

**Why it hurts.** The runtime decides which adapter calls run, in which order and with which session. Root reads pass no session, root mutations pass none and open their own transaction, nested children are read in the transaction for their ownership check, with a row lock on PostgreSQL, and one adapter method serves root updates, nested updates and state actions alike. An override that takes its filter or session from async context changes all of these calls, including ones its author never considered, and the GraphQL operation no longer describes what is written. Batched relationship reads run in the async context of the first field of their batch, so a store set for one field can be applied to another field's read. When [batched collection reads](./relationships#batched-collection-reads) are enabled, an adapter copy whose `findChildren` is replaced or wrapped reads collection fields one parent at a time.

**Do this instead.** Put the logic in [controller hooks](./server-side-operations#work-inside-the-transaction-with-controllers), which receive the session and the context, and use [custom mutations](./mutations#add-a-custom-mutation) for multi-step work. Conditional writes belong in a native call with the session.

## Rewriting the compiled pipeline in an aggregate hook

**What it looks like.** A Mongoose `aggregate` middleware replaces or edits the pipeline that Simfinity compiled:

```javascript
orderSchema.pre('aggregate', function replacePipeline() {
  const pipeline = this.pipeline();
  pipeline.splice(0, pipeline.length, ...requestState.getStore().pipeline);
});
```

**Why it hurts.** On MongoDB, generated list, count, aggregate and collection reads compile their arguments into one aggregation pipeline, and the conditions that [query scopes](./query-scope) add are part of those arguments. A hook that replaces or splices the pipeline silently drops them, together with the client's filters, sort and page limits: a list that a scope restricts to one tenant then returns the records of every tenant. When [batched collection reads](./relationships#batched-collection-reads) are enabled, any `aggregate` middleware also makes the adapter read collection fields one parent at a time.

**Do this instead.** Express read restrictions as [query scopes](./query-scope) and argument changes as [middleware](./middleware). For a report that needs a pipeline the generated queries cannot express, run your own `aggregate()` on `simfinity.getModel(Type)`, and authorize it yourself.

## Forcing IDs and explicit nulls in hooks

**What it looks like.** Hooks copy an ID and explicit `null` values from outside the input into the record:

```javascript
const orderController = {
  onSaving: (order) => {
    const pending = requestState.getStore().document;
    order._id = pending._id;
    for (const [key, value] of Object.entries(pending)) {
      if (value === null) order.set(key, null);
    }
  },
  onUpdating: (id, changes) => {
    // Moves $unset entries back into $set as null.
  },
};
```

**Why it hurts.** Generated create inputs exclude the entity ID, because Simfinity assigns it: an ObjectId on MongoDB, a UUID on PostgreSQL. IDs forced from outside the input tie callers to one backend's ID format, and the GraphQL operation no longer describes the stored record. Stored nulls are unnecessary: an explicit `null` in an update removes a nullable field, and generated filters treat `null` and a missing value the same. Hook records also differ by backend, a Mongoose document on MongoDB and a plain record on PostgreSQL, so `order.set()` only works on one of them.

**Do this instead.** Let Simfinity assign IDs. Keep an idempotency key or an external reference in a field of its own, declared with `extensions: { unique: true }` and checked in a validator or `onSaving`. Find records whose field is not set with `{ operator: EQ, value: null }`. See [update selected fields](./mutations#update-selected-fields).

## Writing a parent and its children as separate operations

**What it looks like.** Code saves the parent, reads the stored children, and then deletes, updates and inserts each child with its own call:

```javascript
await saveOrder(order, session);
const stored = await findLines({ order: order.id }, session);
for (const line of stored) {
  if (!lines.some((item) => item.id === line.id)) await deleteLine(line.id, session);
}
for (const line of lines) {
  if (stored.some((item) => item.id === line.id)) await updateLine(line, session);
  else await insertLine({ ...line, order: order.id }, session);
}
```

**Why it hurts.** This loop rewrites what one generated update with nested collection entries already does: in one transaction, it runs each line's middleware, validators, ownership check and controller hooks, then the order's `onUpdated` hook after all lines. The loop must repeat every one of those checks, and some are usually missing; when its calls run as separate operations, a failure in the middle leaves a partial order. Its nested work is also outside [`configureMutationLimits()`](./mutations#limit-nested-collection-operations).

**Do this instead.** Send the lines as `added`, `updated` and `deleted` entries of the order's update, and recompute derived values in the order's `onSaved` and `onUpdated` hooks, which run after the lines and read them with the session:

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

See [write a parent and its children together](./server-side-operations#write-a-parent-and-its-children-together).

## Storing child collections as opaque blobs

**What it looks like.** Child records live inside one text or free-form field of the parent:

```javascript
fields: {
  lines: { type: GraphQLString }, // JSON.stringify(lines), parsed by every reader
  document: { type: JSONScalar }, // a free-form map that holds the lines
}
```

**Why it hurts.** Nothing inside the blob can be validated, filtered, sorted, aggregated, kept unique or checked as a reference, every reader parses it, and every writer rewrites all of it. The schema does not describe the data, so clients and MCP tools cannot see its shape either.

**Do this instead.** Use an [embedded list](./relationships#embedded-objects) for value lines that belong to the parent, with the line type registered through `addNoEndpointType()`, or a [referenced collection](./relationships#referenced-objects-and-collections) when lines have their own lifecycle, permissions or queries:

```javascript
lines: {
  type: new GraphQLList(new GraphQLNonNull(OrderLineValueType)),
  extensions: { relation: { embedded: true } },
},
```

## Forbidding native database access

**What it looks like.** A static check fails the build when code outside a designated layer calls a Mongoose model or the driver, with a growing list of exceptions:

```javascript
if (/\.(updateOne|findOneAndUpdate|bulkWrite|aggregate)\(/.test(source) && !exceptions.has(file)) {
  fail(`${file}: native database access`);
}
```

**Why it hurts.** Simfinity documents native calls with the supplied session as the way to make side writes part of a mutation; see [transactions and side effects](./controllers#transactions-and-side-effects). [Use the native model for atomic operations](./server-side-operations#use-the-native-model-for-atomic-operations) applies the same rule to counters and locks, and the [Barber example](/resources/barber) increments a lock field with `$inc` inside the booking transaction. The documentation says that native calls bypass the lifecycle, which describes a consequence, not a prohibition. A ban pushes the same operations into worse shapes: hand-called resolvers, adapter overrides fed by async context, and driver emulation over generated operations.

**Do this instead.** Allow `simfinity.getModel()` and the driver in infrastructure code, hooks and custom mutations, with the supplied session, and forbid what actually breaks the contract: hand-called generated resolvers, adapter overrides and pipeline-rewriting hooks. See [use the native model for atomic operations](./server-side-operations#use-the-native-model-for-atomic-operations).

## Wrapping non-data work in mutations

**What it looks like.** An email, an HTTP call or another external action becomes a custom mutation, so that "everything goes through Simfinity":

```javascript
simfinity.registerMutation('sendinvoiceemail', 'Email an invoice.', SendInvoiceInput, SendResultType,
  async (input) => {
    await mailer.send(buildInvoiceEmail(input));
    return { sent: true };
  });
```

**Why it hurts.** A custom mutation's callback runs inside a database transaction, which Simfinity retries up to five times on transient errors, running the callback again each time. The email can therefore be sent twice, and an email sent before a later failure is not taken back by the rollback. The transaction also stays open for the duration of a network call, and adds nothing to work that touches no data.

**Do this instead.** Inside the mutation that changes the data, write an outbox record with the session, and deliver it from a worker after commit; see [transactions and side effects](./controllers#transactions-and-side-effects). Work that touches no data does not need a Simfinity operation: run it in your own service code or endpoint.

## Reading stored records through a custom mutation

**What it looks like.** A read of stored records gets a root field of its own, beside the generated queries of the type it reads. The read becomes a custom mutation, whose callback loads the records natively:

```javascript
simfinity.registerMutation(
  'shopBusyTimes',
  'Busy times of a barbershop on a date.',
  ShopBusyTimesInput, // { barbershopId, date }
  new GraphQLList(BusyRangeType),
  async ({ barbershopId, date }, session, context) => {
    await assertBarbershopVisible(barbershopId, context, session); // the shop's scope, again
    return findBusyRanges(barbershopId, date, session);
  },
);
```

**Why it hurts.** The callback receives only its input, a session and the context, so it loads the shop itself and repeats the shop's scope and permission checks in code, where the copy drifts from the scope. Clients cannot select the read with the shop: a query field and a mutation field cannot share one operation, so a page that shows both sends two operations, and the read cannot appear under the shops of a list or a relationship. As a mutation, it runs in a transaction that Simfinity opens and retries for a read, GraphQL runs mutation root fields one at a time, and MCP publishes it with `readOnlyHint: false`, so `exclude: 'mutation'` also hides it from agents that may only read. Registering the read as a [custom query](./queries#custom-queries) instead removes the transaction and the write classification, but not the rest: its callback still repeats the scope and permission checks, and clients still cannot select the read with the shop. Custom queries are for results that are not stored records.

**Do this instead.** Read stored records through generated queries: filters for what the client asks for, [query scopes](./query-scope) for what the caller may see, and [aggregate queries](./queries#aggregate-records) for totals. When a read needs logic that filters cannot express, add a [virtual field](./queries#virtual-fields) to the type it belongs to. The type's generated queries, its scope and the permission rules then decide which records reach the field, clients select it with the record, and generated MCP tools read it through a read-only per-field tool when it has required arguments:

```graphql
query ShopDay($id: ID!, $date: String!) {
  barbershop(id: $id) {
    name
    busyRanges(date: $date) { startTime endTime professionalId }
  }
}
```

Its resolver still runs once per returned record, so batch its reads when lists select it, as that section shows. Keep custom mutations for writes. For a read whose result is not a stored record, such as a price preview, data from another service or a permission evaluation, register a [custom query](./queries#custom-queries): clients send it in a `query` document, and MCP publishes it as a read-only tool.

## Raising the query limit for internal reads

**What it looks like.** A module that needs large internal reads raises the page-size limit for itself:

```javascript
export const createReportRuntime = () => {
  const runtime = simfinity.createRuntime(simfinity.createMongoAdapter());
  runtime.configureQueryLimits({ maxPageSize: 20_000 });
  return runtime;
};
```

**Why it hurts.** The limit is one value for the whole process, and every runtime's `configureQueryLimits()` sets that same value, so the last call wins. A runtime configured with a maximum of 100 accepts pages of 2,000 records once the report runtime has set 20,000, and a module that raises the limit for an internal job raises it for public clients too. See [`configureQueryLimits()`](../reference/api#configurequerylimits).

**Do this instead.** Call `configureQueryLimits()` once at startup with the maximum page size that public clients may request. Internal bulk reads page through the results, or read natively, for example with a Mongoose cursor or your own SQL.

## Editing the generated schema after construction

**What it looks like.** Code deletes or filters generated fields, arguments and types after `createSchema()`:

```javascript
const { orders } = schema.getQueryType().getFields();
orders.args = orders.args.filter((arg) => arg.name !== 'total');
delete schema.getTypeMap().RelationType;
```

**Why it hurts.** graphql-js validates a schema once and caches the result, so later changes to field maps, arguments or the type map are never validated, and a type removed from the type map is still reachable through the fields that use it. Simfinity's introspection metadata is shared by the whole process: Simfinity installs `__Field.extensions` once and reads it again in every `createSchema()` call, so deleting that field makes the next `createSchema()` throw `TypeError`.

**Do this instead.** Select root operations with the [`createSchema()` include lists](../reference/api#createschema), reject an operation such as `aggregate` for a type in [middleware](./middleware), mark fields that clients must not filter, sort or group by with [`queryable: false`](../reference/extensions#field-extensions), declare a field that your resolver computes [virtual](../reference/extensions#virtual) so that it gets no filter argument at all, hide fields with [permission rules](./authorization), and keep storage-only data out of public types.

## Depending on backend-specific shapes and errors

**What it looks like.** Application code reads MongoDB's identifiers and error codes directly:

```javascript
const id = record._id.toHexString();
try {
  await saveOrder(input);
} catch (error) {
  if (error.code === 11000) throw new ConflictError();
}
```

**Why it hurts.** Simfinity runs the same GraphQL contract on both backends, but what lies beneath it differs. MongoDB passes the driver's duplicate-key error (code `11000`) through unchanged, while PostgreSQL reports a unique violation as a `SimfinityError` with code `DUPLICATE_KEY` (409); see [PostgreSQL database errors](../reference/errors#postgresql-database-errors). Hook records are Mongoose documents on MongoDB and plain records on PostgreSQL, and identifiers are ObjectIds or UUIDs. Code built on these shapes cannot move to the other backend, and a check written for one silently misses on the other. GraphQL results are the same on both: IDs are strings and enums are their names.

**Do this instead.** Consume GraphQL-shaped results, for example through [in-process execution](./server-side-operations#execute-the-generated-schema-in-process). Declare uniqueness with `extensions.unique` and check expected conflicts in a validator or hook, so that the error is your own on both backends, or map both codes in one helper. Keep backend-specific code in the infrastructure modules that use the native model.

## Patching driver internals for telemetry

**What it looks like.** Private cursor members and collection methods are wrapped to count reads:

```javascript
const initialize = cursor._initialize;
cursor._initialize = function countRead(...args) {
  metrics.reads += 1;
  return initialize.apply(this, args);
};
OrderModel.collection.aggregate = withTimer(OrderModel.collection.aggregate);
```

**Why it hurts.** Underscore members are private to the driver and change without notice. When [batched collection reads](./relationships#batched-collection-reads) are enabled, a wrapper of `Model.collection.aggregate` also makes the MongoDB adapter read collection fields one parent at a time.

**Do this instead.** Use the MongoDB driver's command monitoring: connect with `monitorCommands: true` and listen to the client's `commandStarted`, `commandSucceeded` and `commandFailed` events, for example on `mongoose.connection.getClient()`. Bound request sizes with `configureQueryLimits()` and `configureMutationLimits()`, and measure requests with your GraphQL server's plugins.

## Treating a second schema or a trusted context as a bypass

**What it looks like.** System work uses a private schema, and every scope skips its rules for context objects marked as trusted:

```javascript
const trustedContexts = new WeakSet();

const tenantScope = async ({ args, context }) => {
  if (trustedContexts.has(context)) return;
  args.AND = [
    ...(args.AND || []),
    { conditions: [{ field: 'tenantId', operator: 'EQ', value: context.user.tenantId }] },
  ];
};
```

**Why it hurts.** Scopes belong to the type, in `extensions.scope`, so every schema built from it runs them, and a second schema is no back door. The bypass therefore moves into every scope, where the permission model does not show it: nothing in the permission rules says which actors skip which restrictions. It is also all or nothing, since a trusted context skips every scope of every type, for every tenant. Scopes restrict reads only, so updates and deletes need their own checks. See [scope boundaries](./query-scope#scope-boundaries).

**Do this instead.** Model system actors explicitly in the context and give each one the narrowest grant it needs. A job that works for one tenant carries that tenant, as in `{ user: { id: 'billing-job', role: 'system', tenantId } }`, so the tenant scope restricts it like any user. When a job must read across tenants, grant that to a named role in your permission rules and in the scopes that allow it, so the exception is visible where access is defined. Create system contexts only in trusted startup or job code, never from request data. Enforce write authorization in middleware or in `onUpdating` and `onDelete`.

## Migrating driver calls to wrappers mechanically

**What it looks like.** A bulk edit replaces each driver call with a wrapper of the same shape that routes through Simfinity, plus an exception list for the calls the wrapper cannot express:

```javascript
// Before
await db.collection('orders').updateOne({ _id: id, version }, { $set: { status }, $inc: { version: 1 } });
// After: the same call, now routed through generated operations
await orderStore.updateOne({ _id: id, version }, { $set: { status }, $inc: { version: 1 } });
```

**Why it hurts.** The wrapper keeps the driver's semantics, such as arbitrary filters, update operators, upserts and multi-record updates, which generated operations do not have, so it emulates them with extra reads, one write per record and lost atomicity. Nothing gains a lifecycle, because the types behind the wrapper have no validators or controllers. The exception list only grows, and the code ends up tied to both the driver's query language and Simfinity's internals.

**Do this instead.** Classify each call site and move it to the matching path in [choose the path](./server-side-operations#choose-the-path): writes of business entities become generated mutations, nested writes or controller hooks; atomic primitives and infrastructure rows stay native with the session; reads by server code use in-process execution. Migrate one domain at a time, with tests that cover the lifecycle you add.
