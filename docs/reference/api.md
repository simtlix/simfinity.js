---
title: Core API
description: Public schema registration, model access, mutation, and configuration APIs.
---

# Core API

Import the MongoDB facade as an ES module:

```javascript
import * as simfinity from '@simtlix/simfinity-js';
```

For PostgreSQL, import `createPostgres` from `@simtlix/simfinity-postgres` and use the returned runtime instance. Both packages provide named exports and TypeScript declarations. Registrations and middleware belong to a runtime instance; register application types once during startup.

Shared examples can import the selected instance from [your application’s runtime module](/guide/databases#runtime-setup-for-shared-examples). Build the schema once after registrations; PostgreSQL must initialize its generated storage before serving operations.

## Find an operation

| Task | API | Result |
| --- | --- | --- |
| Register a domain type | [connect](#connect) | Type registration; no return value |
| Build the executable API | [createSchema](#createschema) | `GraphQLSchema` |
| Register a read whose result is not a stored record | [registerCustomQuery](#registercustomquery) | Custom query registration |
| Name a list read with params and a fixed predicate | [registerView](#registerview) | Named view registration |
| Register an application operation | [registerMutation](#registermutation) | Custom mutation registration |
| Retrieve a registered type | [getType](#gettype) | Type, `undefined`, or `null` as described below |
| Work with its model | [getModel](#getmodel) | Registered backend-native Model |
| Inspect a create input | [getInputType](#getinputtype) | Generated `GraphQLInputObjectType` |
| Create in an owned or existing transaction | [saveObject](#saveobject) | Saved object |
| Set the maximum query page size and reference frames | [configureQueryLimits](#configurequerylimits) | Process-wide configuration |
| Cap nested collection operations | [configureMutationLimits](#configuremutationlimits) | Process-wide configuration |
| Index a PostgreSQL column for case-insensitive filters | [caseFoldExpression](#casefoldexpression) | SQL expression text |

## createMongoAdapter

```javascript
const adapter = simfinity.createMongoAdapter({ referentialIntegrity: 'transactional' });
const runtime = simfinity.createRuntime(adapter);
// Connect MongoDB, register all types and call runtime.createSchema().
await adapter.initialize();
```

`createMongoAdapter(options?: MongoAdapterOptions): MongoAdapter` accepts `referentialIntegrity: 'off' | 'transactional'`, defaulting to `'off'`. The mode is immutable and exposed as readonly `adapter.referentialIntegrity`. Transactional mode checks references and restricts target deletion using coordinated MongoDB transactions. `initialize(): Promise<void>` validates startup and existing data; await it before serving protected operations. It is a no-op in off mode. See [the complete contract](../guide/mongodb-integrity).

`batchedCollections: boolean` (default `false`) and `collectionBatchSize: number` (an integer from 1 to 100, default 5) turn on [batched collection reads](/guide/relationships#batched-collection-reads): aggregate commands of up to `collectionBatchSize` parents each, sent concurrently. Both are fixed at creation. Invalid values throw `INVALID_MONGO_ADAPTER_OPTIONS` (400); unknown option names still throw `INVALID_MONGO_INTEGRITY_CONFIGURATION` (400). The package-root runtime keeps one read per parent.

## configureQueryLimits

```javascript
simfinity.configureQueryLimits({ maxPageSize: 500, maxReferenceFrames: 10, maxFrameNesting: 3 });
```

Sets the process-wide query limits. Configure them once at startup; every runtime and facade shares them. `configureQueryLimits(options?: QueryLimitsOptions): void` takes three options, each a positive safe integer:

- `maxPageSize`, default 1000, the maximum for explicit list and aggregate page sizes. Unpaged lists use `Math.min(100, maxPageSize)` and unpaged aggregate queries remain unbounded. See [pagination](/guide/queries#pagination-and-total-count) for request validation and compatibility details.
- `maxReferenceFrames`, default 10, the compiled client frames and scoped joins per resolver call. Shorthand frames count per group and absolute prefix, explicit frames separately, scoped joins per containing frame/path/scope chain, and emptiness frames per path and shape, independent of markers. More fail with `FILTER_DEPTH_EXCEEDED` before middleware, after all client 400 checks. Trusted constructs do not count toward this total. A named view checks its `where` groups against a separate budget of the same size after middleware, using the same compiled units.
- `maxFrameNesting`, default 3, the collection and reference frames nested along any one chain, including shorthand and trusted constructs. More fail with `FILTER_DEPTH_EXCEEDED`; explicit quantified groups also count toward the existing five-level Boolean-group depth, while implicit shorthand groups add no Boolean level.

The call checks every option before it sets any: an invalid one throws `INVALID_QUERY_LIMITS` (400) and keeps all limits. An option that a call omits takes its default again, so `configureQueryLimits({ maxPageSize: 500 })` also restores the default `maxReferenceFrames` and `maxFrameNesting`, and calling without arguments restores all defaults. The TypeScript type of the options is `QueryLimitsOptions`.

## configureMutationLimits

```javascript
simfinity.configureMutationLimits({ maxNestedOperations: 100 });
```

Caps the nested collection operations of one generated mutation. Configure it once at startup. Like `configureQueryLimits`, the setting is process-wide: every runtime and facade shares it.

`maxNestedOperations` is a non-negative safe integer, or `null` for no limit, which is the default. `0` forbids nested operations while plain creates and updates still work. Calling the function without arguments, with `{}` or with `{ maxNestedOperations: null }` restores the default. Options that are not a plain object, any option other than `maxNestedOperations` (such as the misspelled `maxNestedOperation`), or an invalid value throw `INVALID_MUTATION_LIMITS` (400) and keep the current limit.

The limit applies to generated add, update and state-action mutations. Simfinity counts the `added`, `updated` and `deleted` entries of non-embedded collection fields at every nesting level, including `null` entries. It counts after root middleware and before the transaction starts, and a mutation over the limit fails with `NESTED_OPERATIONS_EXCEEDED` (400) without writing anything. Root deletes, `saveObject()`, custom mutations and embedded lists are not counted. See [limit nested collection operations](/guide/mutations#limit-nested-collection-operations).

## connect

```javascript
simfinity.connect(
  model,
  gqltype,
  simpleEntityEndpointName,
  listEntitiesEndpointName,
  controller,
  onModelCreated,
  stateMachine,
);
```

Registers a `GraphQLObjectType` and its generated operations. Returns `undefined`. It throws `INVALID_SCOPE` (500) for an invalid [`extensions.scope`](/guide/query-scope#callback-contract) and `TYPE_BOUND_TO_OTHER_RUNTIME` (409) for a type that another runtime bound or reserved; a rejected type is not registered.

| Parameter | Type | Required | Behavior |
| --- | --- | --- | --- |
| `model` | Mongoose model or `null` | Yes | MongoDB accepts an existing model; pass `null` to generate storage. PostgreSQL requires `null`. |
| `gqltype` | `GraphQLObjectType` | Yes | The exact type instance to register. A type is bound to the first runtime whose schema generates its relation resolvers, or reserved by the first schema that reaches it with an unresolved relation field. |
| `simpleEntityEndpointName` | `string` | Yes | Single-record query name and CRUD suffix; no inferred default. |
| `listEntitiesEndpointName` | `string` | Yes | List query name and aggregation prefix; no inferred default. |
| `controller` | Controller object or `null` | No | [Lifecycle hooks](/guide/controllers); omitted hooks add no application behavior. |
| `onModelCreated` | `(model) => void` or `null` | No | Synchronous callback for a generated model, not a supplied model. |
| `stateMachine` | State machine object or `null` | No | [State transitions](/guide/state-machines); omitted means no configured machine. |

```javascript
simfinity.connect(null, SerieType, 'serie', 'series');
```

This creates `serie`, `series`, `series_aggregate`, `addserie`, `updateserie`, and `deleteserie`. Names are used as supplied; Simfinity does not pluralize them for you. Generated models/tables use the GraphQL type name, such as `Serie`.

## addNoEndpointType

```javascript
simfinity.addNoEndpointType(gqltype);
```

Registers a supporting object type without root CRUD endpoints. Use it for embedded or supporting types needed by connected types. It validates the type like `connect()`. Model creation is conditional on the persistent graph: a scalar-only value type embedded in an owner stays inline, while a supporting type referenced by a connected type receives backend storage without gaining root operations. A referenced supporting type is an entity, so its `id` resolves to its stored identity; a type used only as an embedded value returns its declared `id` member.

## createSchema

```javascript
const schema = simfinity.createSchema(
  includedQueryTypes,
  includedMutationTypes,
  includedCustomMutations,
  { includedCustomQueries },
);
```

Builds models, generated resolvers, input types, and an executable `GraphQLSchema`. The root names are `RootQueryType` and `Mutation`. When no mutation fields are included, the schema omits `Mutation`; generated inputs are still prepared.

Before it creates any model, `createSchema()` validates the scope of every registered type (`INVALID_SCOPE`) and rejects the schema with `TYPE_BOUND_TO_OTHER_RUNTIME` when it reaches, through fields, interfaces, union members or custom query and mutation results, a type that another runtime bound or reserved, or a field copied with `toConfig()` after another runtime generated its relation resolver. A list relation, embedded object or embedded list whose type is not registered throws `UNREGISTERED_RELATION_TARGET` (500). A writable non-embedded list relation whose child `connectionField` is missing or empty, and whose resolver Simfinity would generate, throws `INVALID_MODEL` (400, `Type.field requires a child connectionField`) before the adapter prepares storage. In default MongoDB mode and with custom adapters, such a collection with its own resolver, or marked `readOnly`, builds and logs a `Configuration issue` warning instead, except a `readOnly` one with its own resolver, which is silent; its nested writes fail with `INVALID_MODEL` (500). PostgreSQL and transactional MongoDB reject every collection without `connectionField`. Fields named like generated query arguments also log a warning; see [fields named like query arguments](/guide/queries#fields-named-like-query-arguments). Invalid [virtual field](/reference/extensions#virtual) declarations of any object type the schema reaches throw `INVALID_MODEL` (400) before the adapter prepares storage, and a `readOnly` field of a registered type with arguments and its own resolver that is not virtual, a reference or a collection logs a `Configuration issue` warning once. Interface and union fields build on default MongoDB and custom adapters as output-only fields, with a `Configuration issue` warning when they are not `readOnly`; PostgreSQL and transactional MongoDB reject them with `INVALID_MODEL`, unless they are virtual. See [what gets generated](/guide/schema#what-gets-generated). Generated inputs that would have no fields are left out with a warning, together with the `added` or `updated` collection operations, embedded fields and add, update or state-action mutations that would take them; a non-null embedded field whose embedded type has no writable fields throws `INVALID_MODEL` (400) instead when the generated mutations reach its owner. PostgreSQL and transactional MongoDB reject embedded types that contain each other with `INVALID_MODEL` (`Embedded cycle at …`); default MongoDB mode rejects them when Simfinity generates a model whose embedded fields reach them, and does not check a cycle that only supplied models reach. An application type named `FieldExtensionsType` or `RelationType` in the first Simfinity schema of a process renames Simfinity's introspection metadata types to `SimfinityFieldExtensionsType` and `SimfinityRelationType`. That first schema fixes the names: a later `createSchema()` with an application type that has one of the current names, `FieldExtensionsType` and `RelationType` or the fallback names after a rename, throws `RESERVED_TYPE_NAME` (500), before any model is created when the type is an included endpoint type, an included custom query's or a registered mutation's input or output type, an output type they reach or a field argument's type, and when the schema is constructed otherwise. The first schema binds the types whose relation resolvers it generates to this runtime. It also reserves reachable types that still have an unresolved relation field; see [types belong to one runtime](/guide/schema#types-belong-to-one-runtime).

| Argument | Matching behavior |
| --- | --- |
| `includedQueryTypes` | Array of the exact object-type instances passed to `connect()`. |
| `includedMutationTypes` | Array of the exact object-type instances passed to `connect()`. |
| `includedCustomMutations` | Array of registered custom mutation names. |
| `options` | Optional plain object. Its only option, `includedCustomQueries`, is an array of registered custom query names. |

Omitting an allowlist or passing `null` includes all registered entries in that category, and so does omitting `includedCustomQueries` or setting it to `null`. An empty array excludes that category's fields. Names that are not registered are ignored. String type names do not work in the first two arrays.

A fourth argument that is not a plain object, such as an array or `null`, an option other than `includedCustomQueries`, and an `includedCustomQueries` that is not an array of strings, `null` or `undefined` throw `INVALID_SCHEMA_OPTIONS` (500) before any other check, so no model is prepared.

The allowlists select root fields only. Every type registered with `connect()`, and every type that a non-embedded relation of a registered type targets, resolves `id` to its stored identity wherever the schema reaches it, unless `id` has your own resolver: `_id`, falling back to `id`, which is `_id` on MongoDB. Types used only as embedded values return their declared `id` member. Embedded copies of an entity type return their declared `id` too, which is `null` for copies created through add inputs, except that on MongoDB copies in an embedded list report the automatic subdocument `_id`; see [supporting types without endpoints](/guide/schema#supporting-types-without-endpoints).

```javascript
const schema = simfinity.createSchema(
  [SerieType, SeasonType],
  [SerieType],
  ['importSeries'],
);
```

An executable schema needs at least one query field. Allowlists control exposed fields, not whether registered models are initialized; excluding every query still prepares storage, but leaves a query root that GraphQL rejects for execution.

An included custom query cannot take the name of an included generated single-record, list or aggregate query or an included view: `createSchema()` throws `QUERY_NAME_CONFLICT` (500) before model preparation. An included view cannot take an included generated query's name either. Exclude one of the conflicting fields with the allowlists, or choose another name.

```javascript
// Generated queries of SerieType only, no mutations, and one custom query.
const schema = simfinity.createSchema([SerieType], [], [], {
  includedCustomQueries: ['estimateServiceDuration'],
});
```

## registerCustomQuery

```javascript
simfinity.registerCustomQuery(name, description, inputModel, outputModel, callback);
```

Registers a custom query, a field of `RootQueryType` whose result is not a stored record, such as a computation without storage, data from another source, a permission evaluation or a result assembled from several sources, and returns `undefined`. Register it before building the schema that should expose it. Reads of stored records belong to generated queries, query scopes, aggregates and [virtual fields](/guide/queries#virtual-fields). It takes the same arguments as [registerMutation](#registermutation); its result type needs no registration or storage model. See [custom queries](/guide/queries#custom-queries) for an example. It is available on core runtimes, SQL instances (`createSQL()`, `createPostgres()`), the MongoDB package and the PostgreSQL default instance.

| Parameter | Contract |
| --- | --- |
| `name` | A valid GraphQL field name without the `__` prefix, unique among this runtime's custom queries. |
| `description` | A string describing the query, or `null`/`undefined`. MCP uses it as the tool description. |
| `inputModel` | A `GraphQLInputObjectType`, or `null`/`undefined`. With a type, the root field has one required `input` argument. Without one, it has no arguments and the callback receives `undefined` as input. |
| `outputModel` | A GraphQL output type, including scalars, enums, objects, interfaces, unions, lists and nullability wrappers. |
| `callback` | `(input, context) => valueOrPromise`. Receives a copy of the input and the request context. |

Simfinity opens no transaction around the callback and passes it no session; unlike a custom mutation's `(input, session, context)`, a callback ported from `registerMutation()` drops its session parameter. A callback that needs a transaction opens it with the engine's API: `simfinity.withTransaction(null, callback)` on PostgreSQL, or the Mongoose connection's `transaction()` on MongoDB. Errors the callback throws reach the client with their code and status. The callback is engine-specific application code, like a custom mutation's.

The callback receives a typed copy of the input after middleware. GraphQL input objects, lists and scalar `Date` values are copied; enum values, other custom scalar values and request context keep their identity.

Middleware runs before the callback with `operation: 'custom_query'`, `entry: name`, `args` and `context`, without an entity `type`. Modify `args.input` on the existing arguments object; replacing `params.args` does not replace the callback's input. With the authorization plugin, the rule for `RootQueryType.<name>` authorizes the field before middleware runs, and the default policy applies without one; its output type's fields are authorized by their own rules. The callback authorizes its own reads: registration applies no query scopes, controllers, filters or pagination to them.

Custom query input and output types follow the [runtime ownership rules](/guide/schema#types-belong-to-one-runtime) and participate in schema name validation. Invalid registration arguments throw `INVALID_QUERY_REGISTRATION` (500), and a name already registered throws `QUERY_NAME_CONFLICT` (500); the entry is not registered or replaced. See [createSchema](#createschema) for `includedCustomQueries` and conflicts with generated queries.

## registerView

```javascript
simfinity.registerView(name, { type, description, params, where });
```

Registers a [named view](/guide/queries#named-views) over one connected type and returns `undefined`. Register it before `createSchema()`. It is available on core runtimes, SQL instances (`createSQL()`, `createPostgres()`), the MongoDB package and the PostgreSQL default instance.

`name` is a valid GraphQL field name without the `__` prefix or the reserved `_aggregate` suffix. It must be unique among the runtime's views and the other included root query fields.

| Option | Contract |
| --- | --- |
| `type` | Required `GraphQLObjectType`, registered with `connect()` in the same runtime. The view returns a list of this type with its generated list arguments. It is included exactly when this type is in `includedQueryTypes`. |
| `description` | Required non-empty string. Describes the root field. MCP appends its generated filter sentence to this description. |
| `params` | Optional object of `{ name: { type, description?, defaultValue? } }`. Each type is a GraphQL scalar, enum or list of those, with nullability wrappers allowed; input objects are rejected. A `NonNull` param without a default is required. Param names must be GraphQL names without the `__` prefix and cannot match any base-type field or `AND`, `OR`, `sort` or `pagination`. |
| `where` | Required function `({ params, context }) => groupsOrPromise`. Returns an array of `AND` groups in the generated filter language over stored fields. `[]` adds nothing. It receives no client list arguments. Keep it free of database reads and do not write to `context`. |

GraphQL coerces the params, then the resolver removes them from the list arguments. Middleware runs with `{ type, args, operation: 'find', entry: name, context }` before `where` runs. The returned groups are copied and appended after middleware, so replacing `params.args` cannot drop them. They are inspected as client paths and conditions: references receive joined scopes and hidden records read as missing. Their paths are the author's, so authorization field rules and `queryable` do not restrict them. Virtual fields still fail. The type's `find` scope runs with its usual payload. `pagination.count: true` uses the generated list's count sink.

There is no separate `includedViews` option. A view fixes no order or page size and creates no aggregate root. Clients can add generated filters, sorting and pagination to its predicate. The five-level group limit applies, and `maxReferenceFrames` holds the client's arguments and the `where` groups to the limit separately. The authorization plugin checks `RootQueryType.<name>` and the base type's returned fields as usual.

`INVALID_VIEW` (500) is raised synchronously at `registerView()` for an invalid declaration, including unknown options. At `createSchema()`, it rejects a type not registered with `connect()` in this runtime, an invalid param name or a param name collision. At request time, it rejects a `where` that does not return an array of groups, a group or condition that is not a plain object, an unknown structural key, a cyclic group, a condition without `field`, an unknown field, a path past a scalar, a virtual field or the reserved `__scope` key on conditions or quantified groups. Groups accept only `conditions`, `AND`, `OR`, `ANY`, `ALL` and `NONE`; quantified group members also require a non-empty `path` relative to their containing frame. Conditions accept only `field`, `operator`, `value` and `path`. Empty groups and shared acyclic groups are valid, and this structural check does not inspect the contents of `value`. Application errors thrown by `where` keep their code and status. Other condition and value errors follow the generated list.

`QUERY_NAME_CONFLICT` (500) rejects a duplicate view name at registration and keeps the first declaration. At `createSchema()`, it rejects a view named like an included generated root or custom query before any model is prepared.

## registerMutation

```javascript
simfinity.registerMutation(name, description, inputModel, outputModel, callback);
```

Registers a custom mutation before creating the schema. When `inputModel` is a `GraphQLInputObjectType`, the mutation receives a required `input` argument. Passing `null` or `undefined` omits that argument. `outputModel` is a GraphQL output type.

The callback runs as `callback(input, session, context)` inside the mutation transaction. Use the supplied session for related writes. On MongoDB, in the default `referentialIntegrity: 'off'` mode, a custom mutation's session uses the default Mongoose connection, or the one MongoDB client of the registered models while the default connection is unused; with transactional reference integrity it uses the first protected model's connection. See [which connection the session uses](/guide/mutations#which-connection-the-session-uses-on-mongodb).

```javascript
import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';
import { simfinity } from './runtime.js';

const ImportSerieInput = new GraphQLInputObjectType({
  name: 'ImportSerieInput',
  fields: { name: { type: new GraphQLNonNull(GraphQLString) } },
});

simfinity.registerMutation(
  'importSeries',
  'Create a series through the import workflow.',
  ImportSerieInput,
  SerieType,
  (input, session, context) => simfinity.saveObject('Serie', input, session, context),
);
```

## getType

```javascript
simfinity.getType('Serie');
simfinity.getType({ name: 'Serie' });
```

Returns the registered `GraphQLObjectType`. A missing registered name returns `undefined`; an unsupported argument returns `null`. For circular imports, perform lookups inside GraphQL's lazy `fields: () => ({ ... })` function after the referenced types have been registered.

## getModel

```javascript
const SerieModel = simfinity.getModel(SerieType);
```

Returns the model associated with a registered type. Retrieve generated models after `createSchema()`. The argument must have a `name` property; this function does not take a string name.

The MongoDB facade returns a Mongoose model. PostgreSQL returns a `PostgresModel` with `findById`, `find`, `create`, `update`, and `delete`; records are plain objects with one UUID exposed as both `id` and `_id`. It has no Mongoose query chaining or `.lean()`. Direct native calls on either backend bypass generated GraphQL permissions, scopes, middleware, validators, and controller pipelines.

## getInputType

```javascript
const SerieInput = simfinity.getInputType(SerieType);
```

Returns the registered create input type after schema generation. For a type without writable fields it has no fields, and generated schemas do not use it; give a registered mutation that creates such records no input or one of its own. For the generated update input, inspect the schema's `updateserie` field instead of assuming that `getInputType()` returns the update variant.

## saveObject

```javascript
await simfinity.saveObject('Serie', input, session, context);
```

Runs create materialization, field/type validators, collection processing, state initialization, and create controller hooks for a registered type. The type name is a string. Generated models must already exist.

Without `session`, `saveObject()` owns the backend transaction, including bounded retries and cleanup. Parent and nested writes commit or roll back together. MongoDB requires a transaction-capable deployment; PostgreSQL uses repeatable-read isolation.

With `session`, the caller must already have an active session valid for the selected backend and owns commit, retry and cleanup. In default Mongo mode the caller also owns abort. With [transactional Mongo reference integrity](../guide/mongodb-integrity), a reference violation or guarded-write error aborts even the supplied transaction; the mode requires snapshot read concern and majority write concern. MongoDB throws `ACTIVE_TRANSACTION_REQUIRED` (400) for an inactive session. PostgreSQL requires an active Simfinity session from the same runtime and throws `INVALID_SESSION` for inactive sessions, arbitrary `pg.Client` objects, or sessions from another runtime. Pass the provided session inside a controller or custom mutation to share its transaction.

MongoDB-owned transactions retry transient failures up to five times after the first attempt, each after a random delay of less than 10, 20, 40, 80 and 160 ms; uncertain commit results retry only commit up to five times. PostgreSQL retries confirmed serialization failures and deadlocks up to five times, after the same random delays, but never retries an unknown commit outcome. In either case an uncertain commit may already have succeeded. An owned transaction whose concurrent-write conflict outlasts the retries fails with `TRANSACTION_RETRY_EXCEEDED` (409); on MongoDB the driver error is `error.cause`. With a supplied session, these errors reach the caller unchanged, with MongoDB's `errorLabels`, because the caller owns retries. See [transaction boundaries](../guide/mutations#transaction-boundaries). Hooks run before commit and may repeat on a transient transaction retry. Calling `saveObject()` directly skips GraphQL input coercion, field authorization and the global middleware of the root record. Nested non-embedded collection children (`added`, `updated`, `deleted`) still run their target type's global middleware, controllers and ownership checks, with the `context` you pass, which is `undefined` when omitted. Without a session, a rejection rolls back the whole workflow; with a supplied session the error reaches the caller, who owns the abort in default MongoDB mode. Validate and authorize programmatic callers accordingly. Relation inputs need `{ id }`: on MongoDB a missing or malformed `id`, including a lean `{ _id }` document, fails with `NOT_VALID_ID` (400). Nested items through a collection without `connectionField` fail with `INVALID_MODEL` (500) before anything is written.

## Configuration and helpers

| Export | Purpose |
| --- | --- |
| `use(middleware)` | Register a global [pre-operation middleware](/guide/middleware). Throws `INVALID_MIDDLEWARE` (500) for a non-function. |
| `preventCreatingCollection(prevent)` | MongoDB toggles explicit collection creation. On PostgreSQL, call it before `createSchema()` to force read-only storage validation during initialization. |
| `createValidatedScalar(name, description, baseScalarType, validate)` | Create a [validated scalar](/reference/scalars#createvalidatedscalar). |
| `buildErrorFormatter(callback)` | Create an [error formatter](/reference/errors#builderrorformatter) for your GraphQL server. The formatter returns a `GraphQLError` whose `originalError` is the classified Simfinity error. |
| `buildQuery(input, gqltype, isCount = false)` | Build a MongoDB aggregation pipeline without executing scopes or middleware. Collection filter paths emit `__sf_qN` frames; marked client constructs can emit `__sf_jN` scoped joins, beside legacy `__sf_lN` lookups. Its trailing `$unset` removes every key in its `included` accumulator. Sorts through collections are rejected, also in count mode. `input.aggregation` filters a field named `aggregation`; this helper never builds the aggregate stage. Embedded IDs follow the [embedded ID rule](/guide/queries#ids-in-paths). |
| `buildFilterGroupMatch(group, gqltype, clauses, included, depth = 0)` | Low-level filter compiler; mutates lookup accumulators. Use one `included` per `clauses` array and `$unset` every reserved alias it adds, using `Object.keys(included)`, as `buildQuery` does. `__scope`, `__implicit` and `__anchor` are reserved internal rewrite metadata, never application input. |

The `auth`, `validators`, `scalars`, and `plugins` helper objects are shared by both database facades. The MongoDB facade retains its `mcp` compatibility namespace. PostgreSQL applications import MCP factories from the opt-in `@simtlix/simfinity-mcp` package; see the [MCP API](/reference/mcp).

## PostgreSQL initialization and transactions

```javascript
import pg from 'pg';
import { createPostgres } from '@simtlix/simfinity-postgres';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const postgres = createPostgres({ pool, schema: 'series_api' });
postgres.connect(null, SerieType, 'serie', 'series');
const schema = postgres.createSchema();
await postgres.initializeDatabase({ mode: 'create' });
```

`initializeDatabase({ mode: 'create' | 'validate' })` must be awaited after `createSchema()` and before operations are served. Create mode adds missing generated objects without altering incompatible existing objects; it locks no table when nothing is missing. Otherwise it locks the tables of roots whose keys it rebuilds, and its DDL locks the tables it changes and the existing tables that a new foreign key references. Validate mode performs no DDL. Both detect catalog drift and leave schema migrations to the operator. Other modes fail with `INVALID_INITIALIZATION_MODE` (400). After `preventCreatingCollection(true)`, a missing or false mode validates and every other mode except `validate` fails with `DATABASE_CREATION_DISABLED` (409) instead. A rejected request leaves readiness as it was; a ready instance keeps serving while it is initialized again, and any failure of the initialization started last makes operations fail with `DATABASE_NOT_INITIALIZED` (503) until a later one succeeds. `postgres.compileDatabaseSchema()` returns the instance's DDL for review or export without touching storage, and `postgres.describeDatabase()` its physical description. The caller owns `pool` and closes it with `await pool.end()`.

`postgres.withTransaction(session, callback)` joins an active supplied PostgreSQL session or owns a new repeatable-read transaction when `session` is null. The callback receives a `PostgresSession` with `query()`, `inTransaction()`, and a native `client` valid for the callback lifetime. Confirmed serialization failures and deadlocks are retried up to five times for owned transactions, each retry after a random delay of less than 10, 20, 40, 80 and 160 ms. Errors the callback throws propagate unchanged, and PostgreSQL errors are mapped as described in [PostgreSQL database errors](/reference/errors#postgresql-database-errors). A statement that fails aborts an owned transaction, even when the callback catches its error, and the call then fails with `DATABASE_ERROR` (500); roll back to a savepoint to continue after an expected error. See the [PostgreSQL quick start](/guide/postgresql) for a complete server and native API example.

### PostgreSQL options

`createPostgres(options)`, `postgresPlugin(options)` and the module's `configure(options)` take `pool`, `schema` and these optional settings, bound once per runtime:

| Option | Default | Effect |
| --- | --- | --- |
| `multiRowInserts` | `true` | The owned rows of a write are inserted with multi-row `INSERT` statements of at most 32,767 values. `false` keeps one `INSERT` per row. |
| `explicitNullsOrder` | `false` | Sorts on `id` and required root fields omit the `NULLS` clause, so indexes can serve them. `true` keeps the clause on every sort term, as 3.5.9 did. |
| `batchedCollections` | `false` | Each generated collection field is read with its own statement, as 3.6.0 did. `true` reads the collection fields of many parents that share their arguments with one statement per 100 parents, in a repeatable-read transaction that first runs `SET LOCAL jit = off`, so a batch whose plan crosses `jit_above_cost` is not JIT-compiled; unsorted and tied rows can come in another order. Only `true` enables it. It saves statements and pool connections, but each batch takes 4 round trips one after another on one connection and runs the parents one after another, so it pays off when the pool is saturated or much smaller than the number of parents per level; measure before enabling it. See [batched collection reads](/guide/relationships#batched-collection-reads). |
| `refreshTriggers` | `'perRow'` | For roots created while it is set, `'perRoot'` refreshes the owned shape and unique keys of each changed root once per transaction instead of once per changed row, as long as the root's guard trigger stays deferred (the default). |
| `ownerIndexes` | `'all'` | `'minimal'` leaves out the `(__owner_id)` index of new owned and guard tables, which their primary key or a unique index covers. |

`refreshTriggers` and `ownerIndexes` change the generated description and DDL, also through the low-level `describeDatabase(registrations, { schema, refreshTriggers, ownerIndexes })`. An unknown value throws `INVALID_DATABASE_SCHEMA` (400) from `createSchema()` or `describeDatabase()`. Initialization keeps each existing root on the refresh-trigger layout its database holds and accepts both layouts. With `ownerIndexes: 'minimal'` it accepts existing owner indexes; a database created with `'minimal'` fails validation under the default `'all'` (`SCHEMA_MISMATCH`, `index is missing`), and create mode adds the indexes back. Versions up to 3.5.9 cannot validate databases created with the opt-in values; read the [upgrade notes](/resources/compatibility#upgrade-to-3-6-0) before enabling them.

### caseFoldExpression

`caseFoldExpression(sqlExpression)`, exported by `@simtlix/simfinity-postgres`, returns the SQL text with which `ILIKE`, `ISTARTS_WITH`, `IENDS_WITH` and `IEQ` fold both sides of their comparison: `translate(lower((<sqlExpression>) COLLATE "pg_catalog"."und-x-icu"), from, to)`, where `from` and `to` are the 22 lowercase variants that ICU `lower()` keeps and their Unicode simple case foldings; see [case folding](/guide/queries#case-folding). PostgreSQL uses an index for these operators only when it is on exactly this expression, so build it with the function, as in `CREATE INDEX series_name_ci ON "app"."Serie" (${caseFoldExpression('"name"')} text_pattern_ops)`; [indexes for text filters](/guide/queries#indexes-for-text-filters) gives the statements. The expression is inserted as given, in parentheses, so that `COLLATE`, which binds more tightly than `->>` and the other binary operators, applies to all of it: `caseFoldExpression('"details" ->> \'label\'')` folds the whole jsonb member, with or without parentheses of its own, and an index on it serves the compiled conditions on that member. Pass trusted SQL with quoted identifiers, never request input. Anything other than a non-empty string throws a `TypeError`.
