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
An omitted `storage.filter` means no additional predicate; JavaScript callers may
also supply `undefined` with the same behavior.
An empty object is a valid predicate. Other non-object values (including `null`,
`false`, `0` and `''`) and arrays reject with `INVALID_STORAGE_OPERATION` before
transaction, controller or write execution; they never become an ID-only mutation.
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

## Ordinary Mongo-shaped server queries

For existing private server filters, `execute` supports a strict Mongo dialect on
`find`, `count`, `stream` and `page`. It parses and reconstructs accepted predicates
through the normal registered Mongo compiler, not `executeStorage` or a caller
pipeline. The public GraphQL input types, generated LIKE semantics and ordinary
pagination defaults are unchanged.

```js
const query = {
  dialect: 'mongodb',
  filter: {
    'document.links': { $elemMatch: { resourceType: 'Article', resourceId } },
    archivedAt: null,
  },
  sort: { _id: 1 },
  window: { skip: 0, limit: 51 },
  projection: { _id: 1, document: 1 },
};
const rows = await runtime.execute('Article', 'find', {}, {
  query, context, session, observer, readOptions: { maxTimeMS: 5000 },
});
const page = await runtime.execute('Article', 'page', {}, { query, context });
// page = { items: [...], totalCount: number }
const total = await runtime.execute('Article', 'count', {}, {
  query: { dialect: 'mongodb', filter: query.filter }, context,
});
const cursor = await runtime.execute('Article', 'stream', {}, {
  query: { ...query, window: { unbounded: true } }, context, observer,
});
for await (const row of cursor) { /* one compiled cursor; break closes it */ }
```

Pass empty generated arguments with this dialect; combining caller-generated
filters with `query` rejects. Find/stream require an explicit positive safe-integer
`window.limit`, optional nonnegative safe-integer `skip`, or exactly
`{ unbounded: true }`. There is no implicit 100-row page. These private windows do
not use the generated public `maxPageSize`; set server budgets explicitly. Page
requires a finite window and executes one compiler-built facet: totalCount sees
the complete authorized filter, while sort/window/projection apply only to items.
Count rejects window, sort and projection. No-match page returns empty items and
zero total. A page observer receives the physical facet row containing `items`
and `count`; account for `row.items.length` when measuring returned item budgets.

Middleware receives `params.query` and the actual operation (`find`, `count`,
`stream` or `page`). Changes are validated again before execution. All four use
the existing find scope. Scope-generated filters are conjoined with the server
predicate, outside caller OR/NOR/NOT; a caller cannot negate the scope. Scopes that
provide sort/pagination reject with INVALID_SCOPE rather than silently overriding
an explicit window. Context identity and active same-client session adoption are
unchanged. Reads add no transactions/retries. Invalid syntax never falls back to
a native query. Unsupported backends reject UNSUPPORTED_CAPABILITY.

### Fields and values

Only registered stored fields are accepted. `_id` aliases the declared entity
identity. Declared singular reference storage aliases may be compared as keys;
traversing nonembedded relationships is rejected. Use existing generated relation
filters and their joined scopes, or an explicit authorized projection for joins.
Embedded fields resolve through their declarations. Non-queryable fields and
application-resolved fields without `queryable: true` remain forbidden, including
sort/projection paths. Authorization of business-specific custom fields remains
with their owning service.

Dynamic traversal requires opt-in on an actual Mixed/Map-backed scalar field (or
an array of Mixed values):

```js
attributes: {
  type: QLValue,
  extensions: { queryPaths: { dynamic: true } },
}
```

This server-only metadata does not enable arbitrary traversal of every QLValue.
It accepts safe alphanumeric/underscore child segments, including digit-leading
attribute IDs and numeric array indices such as `document.links.0`. Empty,
operator-prefixed, prototype/constructor, NUL and internal `__sf_` segments reject.
Ordinary scalar fields remain nontraversable. Legacy generated filter behavior
is unchanged; use this explicit dialect for the richer stored-value contract.

Values retain BSON-sensitive semantics: an ObjectId and its hex string are not
interchangeable. No generated GraphQL/model coercion is applied to server filter
literals. Supported literals are null, booleans, finite numbers, strings, dense
arrays, plain data records, valid Date, the Mongo adapter's Mongoose ObjectId and
Buffer. Normalize foreign BSON IDs in the owning boundary if needed. Other BSON
classes/custom objects reject until explicitly supported. Structured equality
preserves document key order and array order; it is not rewritten into independent
subfield comparisons. Literals on declared embedded object types also validate
their child field paths; they cannot hide an unknown or non-queryable child inside
an equality value. Sorting a declared object requires a scalar child path.
Functions, symbols, accessors, cycles, undefined, nonfinite
numbers and unsafe/operator-bearing literal keys reject. Strings beginning `$`
remain literal data, never expressions.

### Supported grammar and limits

- Implicit equality and `$eq`, `$ne`, `$lt`, `$lte`, `$gt`, `$gte`.
- `$in`, `$nin`, `$all`, including empty arrays and null members with Mongo semantics.
- `$exists` boolean, `$size` integer from 0 through 2147483647 inclusive (Mongo's
  nonnegative signed 32-bit range), and `$type` aliases `string`,
  `number`, `double`, `int`, `long`, `decimal`, `date`, `objectId`, `bool`, `object`,
  `array`, `null`, `binData`. Numeric type codes and other aliases reject.
- Document `$and`, `$or`, `$nor` with nonempty lists; field `$not` with an operator
  object; `$elemMatch` with object-element predicates or scalar-element operators.
  Correlation is preserved, including nested logic and nested elemMatch.
- `$regex` accepts only escaped literal patterns, optional leading `^` / terminal
  `$`, and `$options` absent/empty or `i`. Mongo anchor semantics are retained.
  This supports exact anchored, prefix and contains search without accepting
  arbitrary regular-expression programs. Existing generated LIKE remains
  case-sensitive. RegExp/BSON regex objects and other flags reject.
- Sort uses 1/-1; projection uses 1/0 inclusion or exclusion, with the normal `_id`
  exception. Unknown, duplicate resolved or overlapping projection paths reject.
  Computed/positional projections and caller pipelines are not accepted.

EMPTY can retain its exact missing/null/empty-string/empty-array OR expression;
NOT_EMPTY retains exists plus NIN(null, '') plus NOT SIZE(0). No truthiness shortcut
is applied. Negating a structured conjunction retains its original NOR semantics.

Complexity is bounded: at most 10,000 structural/path visits, depth 20, 100,000
literal nodes (arrays/records and scalar members), 8 MiB of accounted literal data,
1,048,576 code units per literal string, 1,024 per field path and 4,096 per regex.
Membership values have a separate budget from predicate structure, so 50,001 IDs
are supported. `FILTER_DEPTH_EXCEEDED` covers structural/data budget exhaustion.
Malformed fields/values/operators use INVALID_FILTER_PATH, INVALID_FILTER_FIELD,
INVALID_FILTER_VALUE or INVALID_FILTER_OPERATOR; window errors use
INVALID_PAGINATION and sort errors INVALID_SORT.

Read options accept batchSize, collation, hint, maxTimeMS, timeoutMS, timeoutMode,
signal, allowDiskUse and readConcern. Put sort/projection/paging in the query only;
a second session in readOptions rejects. Normal unobserved reads retain Mongoose
aggregate hooks. As with existing observed reads, cursor/observed execution rejects
models with aggregate hooks instead of bypassing them. Find-limit-one is a list
read and does not promise findOne hooks. Observers retain physical batch accounting
including empty batches, decoded-row observation and awaited error/cancellation
cleanup. Native aggregate hooks are not supported on streams.

`$expr`, `$where`, JavaScript, full regex, text/geo operators, lookup stages and
arbitrary native methods are outside this ordinary grammar. Use explicit owner
capabilities for genuine authorization joins, computed projections, facets beyond
the fixed page shape and field-to-field calculations. Writes, complete CAS
predicates and specialized atomic capabilities are unchanged.
