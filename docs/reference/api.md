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

Registers a `GraphQLObjectType` and its generated operations. Returns `undefined`.

| Parameter | Type | Required | Behavior |
| --- | --- | --- | --- |
| `model` | Mongoose model or `null` | Yes | MongoDB accepts an existing model; pass `null` to generate storage. PostgreSQL requires `null`. |
| `gqltype` | `GraphQLObjectType` | Yes | The exact type instance to register. |
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

Registers a supporting object type without root CRUD endpoints. Use it for embedded or supporting types needed by connected types. Model creation is conditional on the persistent graph: a scalar-only value type embedded in an owner stays inline, while a supporting type referenced by a connected type receives backend storage without gaining root operations.

## createSchema

```javascript
const schema = simfinity.createSchema(
  includedQueryTypes,
  includedMutationTypes,
  includedCustomMutations,
);
```

Builds models, generated resolvers, input types, and an executable `GraphQLSchema`. The root names are `RootQueryType` and `Mutation`.

| Argument | Matching behavior |
| --- | --- |
| `includedQueryTypes` | Array of the exact object-type instances passed to `connect()`. |
| `includedMutationTypes` | Array of the exact object-type instances passed to `connect()`. |
| `includedCustomMutations` | Array of registered custom mutation names. |

Omitting an argument or passing `null` includes all registered entries in that category. An empty array excludes that category's fields. String type names do not work in the first two arrays.

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

MongoDB-owned transactions retry transient failures up to five times after the first attempt; uncertain commit results retry only commit up to five times. PostgreSQL retries confirmed serialization failures and deadlocks, but never retries an unknown commit outcome. In either case an uncertain commit may already have succeeded. See [transaction boundaries](../guide/mutations#transaction-boundaries). Hooks run before commit and may repeat on a transient transaction retry. Calling `saveObject()` directly bypasses GraphQL input coercion, field authorization, and global middleware; validate and authorize programmatic callers accordingly.

## Configuration and helpers

| Export | Purpose |
| --- | --- |
| `use(middleware)` | Register a global [pre-operation middleware](/guide/middleware). |
| `preventCreatingCollection(prevent)` | MongoDB toggles explicit collection creation. On PostgreSQL, call it before `createSchema()` to force read-only storage validation during initialization. |
| `createValidatedScalar(name, description, baseScalarType, validate)` | Create a [validated scalar](/reference/scalars#createvalidatedscalar). |
| `buildErrorFormatter(callback)` | Create an [error normalization function](/reference/errors#builderrorformatter). |
| `buildQuery(input, gqltype, isCount = false)` | Build a MongoDB aggregation pipeline from list-query arguments. Does not execute scopes or middleware. |
| `buildFilterGroupMatch(group, gqltype, clauses, included, depth = 0)` | Low-level recursive filter compiler; mutates the supplied lookup accumulators. |

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

`postgres.withTransaction(session, callback)` joins an active supplied PostgreSQL session or owns a new repeatable-read transaction when `session` is null. The callback receives a `PostgresSession` with `query()`, `inTransaction()`, and a native `client` valid for the callback lifetime. Confirmed serialization failures and deadlocks are retried up to five times for owned transactions. See the [PostgreSQL quick start](/guide/postgresql) for a complete server and native API example.
