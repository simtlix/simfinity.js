# @simtlix/simfinity-sql

Driver-free relational planning, record reconstruction, and transaction orchestration for Simfinity. It requires Node.js 18.18 or later and GraphQL 16. It depends only on `@simtlix/simfinity-core`; it does not install `pg`, MongoDB, Mongoose, MCP, or a database plugin.

PostgreSQL 15 or later is the first and only supported SQL plugin. Install the SQL runtime and PostgreSQL plugin at matching versions:

```sh
npm install @simtlix/simfinity-sql@3.5.9 @simtlix/simfinity-postgres@3.5.9 graphql@^16.11.0 pg@^8.16.3
```

## Runtime

```javascript
import pg from 'pg';
import { createSQL } from '@simtlix/simfinity-sql';
import { postgresPlugin } from '@simtlix/simfinity-postgres';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const simfinity = createSQL({ plugin: postgresPlugin({ pool, schema: 'library' }) });

simfinity.connect(null, BookType, 'book', 'books', bookController);
const schema = simfinity.createSchema();
await simfinity.initializeDatabase({ mode: 'create' });

// Serve schema. The application owns the pool and calls pool.end() at shutdown.
```

`createPostgres({ pool, schema })` remains a convenience factory for this same implementation. Both entry points preserve PostgreSQL descriptions, generated SQL, GraphQL operations, scopes, hooks, state machines, model handles, and session behavior. The [PostgreSQL package guide](https://github.com/simtlix/simfinity.js/tree/master/packages/postgres) describes the supported storage and query shapes.

A runtime permanently binds one plugin and configuration. Its methods and capabilities are captured at creation; connection objects remain caller-owned. To configure later, use `createSQL({ plugin: postgresPlugin() })`, then call `configure({ pool, schema })` once before `createSchema()`. Register all types before creating the schema and await successful initialization before serving operations. Give each runtime its own GraphQL type objects: a type whose relation resolvers one runtime generated, a `toConfig()` copy of it made afterwards, or a shared custom mutation result type with an unresolved relation field throws `TYPE_BOUND_TO_OTHER_RUNTIME` in another.

`initializeDatabase({ mode: 'create' })` creates missing compatible storage; `mode: 'validate'` validates existing storage. Incompatible definitions are rejected. `preventCreatingCollection(true)` forces validation: a missing or false mode validates, and every other mode except `validate` fails with `DATABASE_CREATION_DISABLED` (409). On a runtime that allows creation, any mode other than `create`, `validate` or an omitted one, including `null` and `''`, fails with `INVALID_INITIALIZATION_MODE` (400). Both are rejected before the plugin is called. PostgreSQL initialization performs no destructive migration or schema synchronization.

Operations fail with `DATABASE_NOT_INITIALIZED` (503) until the first initialization succeeds. A rejected request leaves readiness as it was, a ready runtime keeps serving while it is initialized again, and any failure of the initialization started last makes storage unavailable until a later one succeeds. Check a live runtime with `mode: 'validate'`: PostgreSQL's `create` mode locks the managed tables against writes until it commits.

The runtime exposes the core registration and GraphQL lifecycle APIs, `configure`, `describeDatabase`, `compileDatabaseSchema` (the plugin's DDL for this runtime's schema, for review or export; it does not touch storage), `initializeDatabase`, `withTransaction`, and shared `auth`, `plugins`, `scalars`, and `validators` helpers. Model handles expose `findById`, `find`, `create`, `update`, and `delete`. `find(args, { session })` accepts the generated list query's filters, sorting, and pagination. Native model helpers bypass GraphQL controllers and validators and use storage field names.

`withTransaction(session, callback)` joins an active session belonging to this runtime, or owns a new transaction when no session is supplied. Sessions expose `client`, `query(text, values)`, and `inTransaction()`. PostgreSQL uses repeatable-read isolation and retries confirmed serialization/deadlock aborts up to five times, each after a random delay of less than 10, 20, 40, 80 and 160 ms. Unknown commit outcomes are not replayed, and the application-owned pool stays open.

## Relational planning

```javascript
import { describeModels } from '@simtlix/simfinity-core';
import { planRelationalSchema } from '@simtlix/simfinity-sql';

const models = describeModels([{ gqltype: BookType }]);
const plan = planRelationalSchema(models, { schema: 'library' });
```

`planRelationalSchema(models, { schema, naming })` is pure: it returns serializable logical tables, scalar columns, foreign keys, indexes, checks, owned-record metadata, and `requirements`. Logical columns have `scalar`, `list`, and `nullable` properties. They contain no physical SQL types, SQL expressions, or driver objects. An optional `naming` object provides `validateIdentifier(value)` and `generatedName(...parts)` to enforce engine naming limits.

## Plugin contract, version 1

A plugin factory returns an object with `apiVersion: 1`, `name`, `displayName`, `defaultSchema`, configuration `options` or `null`, a `capabilities` array, and these members:

| Member | Responsibility |
| --- | --- |
| `naming` | Validate identifiers and generate engine-compatible names. |
| `describeSchema(plan)` | Lower the logical plan into physical storage metadata. |
| `compileSchema(description)` | Return reviewable DDL statements. The runtime calls it only from `compileDatabaseSchema()`. |
| `initialize(configuration, description, options)` | Create or validate storage and return `{ mode, created }`. Receives only `create`, `validate` or no mode, and must keep accepting indexes that earlier versions generated on its databases, such as the `[ID]` list index. |
| `compileQuery(models, description, queryPlan, extra)` | Return `{ text, values, aggregateFields? }`. Aggregate queries include the group field followed by each fact field in `aggregateFields`. |
| `compileRecord(description, operation)` | Compile one record operation into `{ text, values }`. |
| `values` | Create/cast IDs, encode/decode scalars, and encode embedded values. |
| `driver` | Validate configuration, execute statements, acquire/release clients, begin/commit/rollback transactions, classify retryable aborts, and normalize errors. |

The driver supplies `assertConfiguration`, `query`, `acquire`, `begin`, `commit`, `rollback`, `release`, `isRetryable`, and `normalizeError`. `query(configuration, statement, client?)` returns a promise resolving to `{ rows, rowCount? }`. `release(client, error?)` receives the rollback failure when ROLLBACK did not complete; the driver must then discard the connection instead of returning it to a pool, and SQL does not retry that attempt. For an error that `isRetryable` accepts, SQL waits its retry delay only after `release` has completed, so the failed attempt holds no connection meanwhile. A transaction session stops accepting statements as soon as its callback settles, before COMMIT or ROLLBACK is sent, so un-awaited session work fails with `INVALID_SESSION`. `commit(client)` must reject when the engine did not commit, for example when it rolled the transaction back because a statement had failed; SQL retries a rejected commit only when `isRetryable` accepts its error, so reject with a non-retryable error in that case. `isRetryable` and `normalizeError` receive any object thrown in an owned transaction or operation, application errors included, and never `null` or a primitive; `normalizeError` never receives a `SimfinityError`. `normalizeError` must map its own engine's errors and return every other error unchanged. A failed `acquire`, `begin`, `query` or `commit` that it returns unchanged becomes `DATABASE_ERROR` (500), with the driver error as its non-enumerable `cause` and `getCause()`. `session.query()` rejects with the driver's own error, so a savepoint can recover from it. Value codecs supply `createId()`, `castId(value)`, `encodeScalar(field, value)`, `decodeScalar(field, value, gqlField?)`, and `encodeEmbedded(value)`.

Physical descriptions must preserve the table names, primary keys, column names, presence markers, and ownership metadata needed for record reconstruction. Plugins may extend those shapes with native types, functions, triggers, and other engine metadata. `compileRecord` receives a physical **table object**, with one of these operation shapes:

| `kind` | Additional fields |
| --- | --- |
| `selectById` | `table`, `id`, optional `lock` |
| `selectOwned` | `table`, `ids`, `ordered` |
| `insert` | `table`, `data` |
| `update` | `table`, `id`, `data` |
| `deleteById` | `table`, `id` |
| `deleteOwned` | `table`, `ownerId` |

`planRelationalSchema` indexes single `ID` columns but not `[ID]` lists. Compiled SQL must not depend on the physical column order of a table.

Every runtime requires `transactions`. Planning adds `foreignKeys`, `deferredForeignKeys`, `embeddedValues`, `ownedRecords`, `scalarLists`, `uniqueValues`, and `nullableUnique` when the model needs those guarantees. Embedded/owned capabilities include presence and shape enforcement. Unsupported guarantees fail before physical schema compilation or initialization; a plugin must not silently omit constraints.

Invalid plugin structure raises `INVALID_SQL_PLUGIN`; unsupported contract versions raise `UNSUPPORTED_SQL_PLUGIN_VERSION`; missing required guarantees raise `UNSUPPORTED_SQL_CAPABILITY`.

`compileQuery` receives `SQLModelDescription`, which extends core model metadata with recursive `SQLFieldDescription` fields. The `state` field of a type with a state machine has `stateNames: [{ value, name }]`: `value` is the string form of the stored enum value, and `name` is its GraphQL enum name. Compilers can use this mapping for aggregate state names. SQL runtimes require the `state` field of a state machine to be a GraphQL enum and reject any other with `INVALID_MODEL` (400) at `createSchema()`. Scalar codecs and `aggregateFields` use the same enriched field type.

TypeScript declarations export `SQLPlugin`, `SQLDriver`, `SQLValueCodec`, `RelationalPlan`, discriminated `RelationalCheck` and `SQLRecordOperation` unions, physical storage interfaces, and `SQLRuntime`, `SQLSession`, and `SQLModel`. Plugin generics preserve configuration, native client, physical description, query-result, and ID types through `createSQL`. Application-defined row values use `unknown` until narrowed. The `./internal/adapter`, `./internal/records` and `./internal/transactions` subpaths are deprecated: they are not plugin-author APIs, have no type declarations, are no longer used by Simfinity's packages, and will be removed in 4.0.
