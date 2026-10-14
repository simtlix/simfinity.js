# Registered server data operations

`createRuntime(adapter)` exposes server-side operations after `connect()` and
`createSchema()`. They resolve the entity from that runtime's registrations; callers
cannot substitute a model or collection. They do not call GraphQL resolver functions
or construct fake GraphQL execution information.

```js
const row = await runtime.execute('Item', 'update', {
  input: { id: 'item-17', title: null },
}, {
  context: { actor },
  session, // active transaction on this model's MongoClient
  storage: {
    filter: { tenantId, version: expectedVersion },
    increments: { version: 1 },
    nulls: 'preserve',
  },
});
```

## Generated lifecycle

`execute(typeName, operation, args, options)` accepts `save`, `update`, `delete`,
`get_by_id`, `find`, `count` and `aggregate`. Save/update take `{ input }`,
delete/by-ID take `{ id }`, and queries take the generated query arguments.
Save/update/delete reuse the existing materializer, field/type validators,
controllers, nested-write checks and transaction/retry implementation. Input values
are coerced against generated GraphQL input types before middleware. List/count and
aggregation use the existing query compiler, runtime middleware, query-path checks,
owner scope and joined-type scopes. Count runs the owner's find scope. By-ID reads
run get_by_id middleware/scope. Results are adapter records, not GraphQL-selected or
serialized output; field resolvers and schema-installed auth plugins do not run.
Install server authorization with runtime middleware and retain domain authorization
in the owning service. Query scopes do not authorize mutations.

`options.context` reaches middleware/controllers unchanged. `options.session` is
adopted, never committed, aborted, closed or retried by the ordinary Mongo adapter;
it must be active and belong to the registered model's MongoClient. Without a
session generated writes own their existing transaction/retry lifecycle. Controllers
run inside that transaction and may repeat; keep external effects outside them.

Mongo supports explicit `storage` write options: `id` on save; `filter` on update
and delete (ANDed with the requested ID, never replacing it); `increments` on update;
and `nulls: 'preserve'` on save/update. The default generated null behavior is unchanged.
Increments must target registered writable built-in GraphQL Int or Float fields, cannot
overlap the normal update, and cannot bypass type/field validators (use absolute
validated updates there). Int deltas must be 32-bit integers. Atomic range predicates
keep the existing and resulting Int values in [-2147483648, 2147483647] and Float
values finite, even in adopted transactions. A range miss has the same NOT_VALID_ID
conflict behavior as any conditional update. Opaque/custom scalars are rejected.
A conditional update that matches nothing throws `NOT_VALID_ID` as generated updates
do; conditional deletion returns null. Native matched counts are available below.
Backend storage options fail with `UNSUPPORTED_CAPABILITY` on adapters without that
capability and on Mongo transactional-reference-integrity mode.

## Registered custom operations

`executeMutation(name, input, { context, session })` runs registered custom-mutation
middleware (`custom_mutation`, with `entry`) and the same transaction callback as the
generated custom mutation. With an input model it coerces GraphQL input and uses the
existing retry-input copies. Without an input model it preserves the exact input,
context and session identities, including Buffer/provider request objects. The
selected adapter owns transaction semantics; an ingress-only adapter can deliberately
provide caller-owned execution without retries. Missing names fail with
`UNREGISTERED_OPERATION`. No captured resolver, schema inclusion or fake info is needed.

## Trusted Mongo capabilities

`executeStorage(typeName, request, { context, session, observer })` accepts only the
Mongo adapter's discriminated `MongoStorageRequest`. It is a private server
infrastructure API, never a public client payload. Every call runs runtime middleware
with the registered entity and `storage.<operation>`. Unsupported backends fail with
`UNSUPPORTED_CAPABILITY`; unknown operations/options/fields fail closed.

Supported reads are `find` (filter/projection/sort/pagination), `aggregate` and `stream`
(pipeline). They compile the owner's find scope and prepend it to the native request.
Scope compilation includes filters/lookups only: it does not add generated default
pagination. Caller filters precede explicit sorting/pagination, and projections and
streams can cover more than 100 rows. Scopes containing sort/pagination are rejected;
put those controls on the operation. Explicit read options are applied once, after
the supplied pipeline. Projection pipelines cannot write collections, add unrelated root streams, or run
server JavaScript. Trusted lookup pipelines are caller-owned: this API does not apply
a joined entity's authorization to arbitrary Mongo expressions. Use generated queries
when those joins need generated path authorization.

Supported writes are `updateOne`, `updateMany`, `replaceOne`, `findOneAndUpdate`,
`findOneAndDelete`, `deleteMany`, `insertMany` and `bulkWrite`. Required payloads differ
by operation. Filters and updates retain BSON values, null/missing distinctions,
complete fencing predicates and native result shapes/counts. Supported modifier
updates include set/unset, increment, max/min, setOnInsert and array modifiers;
update pipelines accept set/addFields/unset. Top-level field paths must exist in the
registered Mongoose schema; Mixed/map/array descendants remain server-owned. No
collection/model/operation callback can be supplied. Native primitives deliberately
skip Mongoose query hooks, entity controllers and GraphQL field validation. They
cannot be used with transactional reference integrity. Authorization, receipts and
audit stay with the owner; ordinary CRUD should use `execute`.

A native primitive is one driver operation, without an enclosing callback retry.
An explicit session remains caller-owned; batches preserve driver ordered/unordered
semantics. Without a transaction, multi-operation batches can partially succeed as
MongoDB documents. There is no SQL portability claim for these capabilities.

## Bounded reads and cursors

Generated execute reads accept `readOptions` for Mongo driver deadlines/cancellation,
plus `observer`. Storage reads take the same deadlines in `request.options`.
Set both `maxTimeMS` and `timeoutMS`, with `timeoutMode: 'cursorLifetime'`, to bound
aggregate and subsequent getMore work. Pass an AbortSignal for cancellation.

Observers expose `beforeFetch()` (every physical initialize/getMore, including empty
batches), `beforeRead()`, `onRows(batch)` (the entire fetched batch before another
fetch), and `track(promise)` (pending fetch, read and cleanup). Hooks may throw to
stop work; error cleanup closes the cursor while preserving the primary read error.
A tracking callback failure can stop a read but can never suppress native close.
A caller can count rows, apply weighted measurements to count/group projections and
track/drain outstanding work without patching model collections or driver methods.
`stream` returns a closeable async iterator; early iteration exit closes it.
The adapter encapsulates Mongo driver-specific fetch instrumentation and fails closed
when the required cursor protocol is unavailable. Observed/native-pipeline reads
reject models with aggregate hooks, and observed by-ID reads reject findOne hooks,
rather than silently skipping an authorization hook. Default unobserved generated
reads preserve their existing Mongoose behavior.

## Standard introspection

`configureIntrospection({ fieldExtensions: false })`, exported from
`@simtlix/simfinity-core`, disables Simfinity's
optional `__Field.extensions` metadata process-wide, before any Simfinity schema is
created. Repeat calls after disabling are idempotent. Enabling it again or disabling
it after an enabled schema was built is unsupported. The setting survives repeated
module evaluation and supports standard `buildClientSchema` introspection roundtrips.
`runtime.configureIntrospection` remains an alias for the same function. No dummy
runtime is needed. Do not directly delete fields from GraphQL's shared introspection types. Configure
this once during process initialization; it affects all runtimes sharing GraphQL.

## Errors and limits

Unregistered/uninitialized entities: `UNREGISTERED_ENTITY`. Unsupported operation:
`INVALID_OPERATION`. Invalid native payload/fields/options: `INVALID_STORAGE_OPERATION`.
Unsupported backend, integrity mode or observed hooked model: `UNSUPPORTED_CAPABILITY`.
Foreign session: `INVALID_SESSION`. Inactive supplied session:
`ACTIVE_TRANSACTION_REQUIRED`. Input coercion retains GraphQL coercion errors;
backend and lifecycle errors retain existing behavior.

These APIs do not grant access through schema auth wrappers, deliver effects, invent
transaction policies, or expose native methods to clients. Keep them inside trusted
server infrastructure with runtime middleware and explicit ownership.
