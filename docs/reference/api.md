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
| Register an application operation | [registerMutation](#registermutation) | Custom mutation registration |
| Retrieve a registered type | [getType](#gettype) | Type, `undefined`, or `null` as described below |
| Work with its model | [getModel](#getmodel) | Registered backend-native Model |
| Inspect a create input | [getInputType](#getinputtype) | Generated `GraphQLInputObjectType` |
| Create in an owned or existing transaction | [saveObject](#saveobject) | Saved object |
| Set the maximum query page size | [configureQueryLimits](#configurequerylimits) | Process-wide configuration |
| Cap nested collection operations | [configureMutationLimits](#configuremutationlimits) | Process-wide configuration |

## createMongoAdapter

```javascript
const adapter = simfinity.createMongoAdapter({ referentialIntegrity: 'transactional' });
const runtime = simfinity.createRuntime(adapter);
// Connect MongoDB, register all types and call runtime.createSchema().
await adapter.initialize();
```

`createMongoAdapter(options?: MongoAdapterOptions): MongoAdapter` accepts `referentialIntegrity: 'off' | 'transactional'`, defaulting to `'off'`. The mode is immutable and exposed as readonly `adapter.referentialIntegrity`. Transactional mode checks references and restricts target deletion using coordinated MongoDB transactions. `initialize(): Promise<void>` validates startup and existing data; await it before serving protected operations. It is a no-op in off mode. See [the complete contract](../guide/mongodb-integrity).

## configureQueryLimits

```javascript
simfinity.configureQueryLimits({ maxPageSize: 500 });
```

Sets the process-wide maximum for explicit list and aggregate page sizes. Configure it once at startup. `maxPageSize` must be a positive safe integer and defaults to 1000; calling without arguments resets that default. Invalid configuration throws `INVALID_QUERY_LIMITS` (400). Unpaged lists use `Math.min(100, maxPageSize)` and unpaged aggregate queries remain unbounded. See [pagination](/guide/queries#pagination-and-total-count) for request validation and compatibility details.

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
);
```

Builds models, generated resolvers, input types, and an executable `GraphQLSchema`. The root names are `RootQueryType` and `Mutation`.

Before it creates any model, `createSchema()` validates the scope of every registered type (`INVALID_SCOPE`) and rejects the schema with `TYPE_BOUND_TO_OTHER_RUNTIME` when it reaches, through fields, interfaces, union members or custom mutation results, a type that another runtime bound or reserved, or a field copied with `toConfig()` after another runtime generated its relation resolver. A list relation, embedded object or embedded list whose type is not registered throws `UNREGISTERED_RELATION_TARGET` (500). A writable non-embedded list relation whose child `connectionField` is missing or empty, and whose resolver Simfinity would generate, throws `INVALID_MODEL` (400, `Type.field requires a child connectionField`) before the adapter prepares storage. In default MongoDB mode and with custom adapters, such a collection with its own resolver, or marked `readOnly`, builds and logs a `Configuration issue` warning instead, except a `readOnly` one with its own resolver, which is silent; its nested writes fail with `INVALID_MODEL` (500). PostgreSQL and transactional MongoDB reject every collection without `connectionField`. Fields named like generated query arguments also log a warning; see [fields named like query arguments](/guide/queries#fields-named-like-query-arguments). The first schema binds the types whose relation resolvers it generates to this runtime. It also reserves reachable types that still have an unresolved relation field; see [types belong to one runtime](/guide/schema#types-belong-to-one-runtime).

| Argument | Matching behavior |
| --- | --- |
| `includedQueryTypes` | Array of the exact object-type instances passed to `connect()`. |
| `includedMutationTypes` | Array of the exact object-type instances passed to `connect()`. |
| `includedCustomMutations` | Array of registered custom mutation names. |

Omitting an argument or passing `null` includes all registered entries in that category. An empty array excludes that category's fields. String type names do not work in the first two arrays.

The allowlists select root fields only. Every type registered with `connect()`, and every type that a non-embedded relation of a registered type targets, resolves `id` to its stored identity wherever the schema reaches it, unless `id` has your own resolver: `_id`, falling back to `id`, which is `_id` on MongoDB. Types used only as embedded values return their declared `id` member. Embedded copies of an entity type return their declared `id` too, which is `null` for copies created through add inputs, except that on MongoDB copies in an embedded list report the automatic subdocument `_id`; see [supporting types without endpoints](/guide/schema#supporting-types-without-endpoints).

```javascript
const schema = simfinity.createSchema(
  [SerieType, SeasonType],
  [SerieType],
  ['importSeries'],
);
```

Ensure the resulting schema has fields in both generated roots. `createSchema()` always creates a `Mutation` object; excluding all mutations and all custom mutations leaves an empty root that GraphQL rejects. Allowlists control exposed fields, not whether registered models are initialized.

## registerMutation

```javascript
simfinity.registerMutation(name, description, inputModel, outputModel, callback);
```

Registers a custom mutation before creating the schema. When `inputModel` is a `GraphQLInputObjectType`, the mutation receives a required `input` argument. Passing `null` or `undefined` omits that argument. `outputModel` is a GraphQL output type.

The callback runs as `callback(input, session, context)` inside the mutation transaction. Use the supplied session for related writes.

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

Returns the registered create input type after schema generation. For the generated update input, inspect the schema's `updateserie` field instead of assuming that `getInputType()` returns the update variant.

## saveObject

```javascript
await simfinity.saveObject('Serie', input, session, context);
```

Runs create materialization, field/type validators, collection processing, state initialization, and create controller hooks for a registered type. The type name is a string. Generated models must already exist.

Without `session`, `saveObject()` owns the backend transaction, including bounded retries and cleanup. Parent and nested writes commit or roll back together. MongoDB requires a transaction-capable deployment; PostgreSQL uses repeatable-read isolation.

With `session`, the caller must already have an active session valid for the selected backend and owns commit, retry and cleanup. In default Mongo mode the caller also owns abort. With [transactional Mongo reference integrity](../guide/mongodb-integrity), a reference violation or guarded-write error aborts even the supplied transaction; the mode requires snapshot read concern and majority write concern. MongoDB throws `ACTIVE_TRANSACTION_REQUIRED` (400) for an inactive session. PostgreSQL requires an active Simfinity session from the same runtime and throws `INVALID_SESSION` for inactive sessions, arbitrary `pg.Client` objects, or sessions from another runtime. Pass the provided session inside a controller or custom mutation to share its transaction.

MongoDB-owned transactions retry transient failures up to five times after the first attempt, each after a random delay of less than 10, 20, 40, 80 and 160 ms; uncertain commit results retry only commit up to five times. PostgreSQL retries confirmed serialization failures and deadlocks up to five times, after the same random delays, but never retries an unknown commit outcome. In either case an uncertain commit may already have succeeded. An owned transaction whose concurrent-write conflict outlasts the retries fails with `TRANSACTION_RETRY_EXCEEDED` (409); on MongoDB the driver error is `error.cause`. With a supplied session, these errors reach the caller unchanged, with MongoDB's `errorLabels`, because the caller owns retries. See [transaction boundaries](../guide/mutations#transaction-boundaries). Hooks run before commit and may repeat on a transient transaction retry. Calling `saveObject()` directly bypasses GraphQL input coercion, field authorization, and global middleware; validate and authorize programmatic callers accordingly. Relation inputs need `{ id }`: on MongoDB a missing or malformed `id`, including a lean `{ _id }` document, fails with `NOT_VALID_ID` (400). Nested items through a collection without `connectionField` fail with `INVALID_MODEL` (500) before anything is written.

## Configuration and helpers

| Export | Purpose |
| --- | --- |
| `use(middleware)` | Register a global [pre-operation middleware](/guide/middleware). Throws `INVALID_MIDDLEWARE` (500) for a non-function. |
| `preventCreatingCollection(prevent)` | MongoDB toggles explicit collection creation. On PostgreSQL, call it before `createSchema()` to force read-only storage validation during initialization. |
| `createValidatedScalar(name, description, baseScalarType, validate)` | Create a [validated scalar](/reference/scalars#createvalidatedscalar). |
| `buildErrorFormatter(callback)` | Create an [error formatter](/reference/errors#builderrorformatter) for your GraphQL server. The formatter returns a `GraphQLError` whose `originalError` is the classified Simfinity error. |
| `buildQuery(input, gqltype, isCount = false)` | Build a MongoDB aggregation pipeline from list-query arguments. Does not execute scopes or middleware. Relation lookups use reserved `__sf_lN` aliases, removed by a trailing `$unset` stage. `input.aggregation` is a filter on a field named `aggregation`, and fails with `INVALID_FILTER_FIELD` when the type has none; `buildQuery` never builds the aggregate stage. Embedded `.id` paths use the [embedded `id` rule](/guide/queries#ids-in-paths). |
| `buildFilterGroupMatch(group, gqltype, clauses, included, depth = 0)` | Low-level recursive filter compiler; mutates the supplied lookup accumulators. Use one `included` object per `clauses` array; callers must `$unset` the reserved `__sf_lN` aliases it adds. |

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

`initializeDatabase({ mode: 'create' | 'validate' })` must be awaited after `createSchema()` and before operations are served. Create mode adds missing generated objects without altering incompatible existing objects. Validate mode performs no DDL. Both detect catalog drift and leave schema migrations to the operator. The caller owns `pool` and closes it with `await pool.end()`.

`postgres.withTransaction(session, callback)` joins an active supplied PostgreSQL session or owns a new repeatable-read transaction when `session` is null. The callback receives a `PostgresSession` with `query()`, `inTransaction()`, and a native `client` valid for the callback lifetime. Confirmed serialization failures and deadlocks are retried up to five times for owned transactions, each retry after a random delay of less than 10, 20, 40, 80 and 160 ms. See the [PostgreSQL quick start](/guide/postgresql) for a complete server and native API example.
