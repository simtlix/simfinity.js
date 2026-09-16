# @simtlix/simfinity-sql

Driver-free relational planning, record reconstruction, and transaction orchestration for Simfinity. Version 3.3.0 requires Node.js 18.18 or later and GraphQL 16. It depends only on `@simtlix/simfinity-core`; it does not install `pg`, MongoDB, Mongoose, MCP, or a database plugin.

PostgreSQL 15 or later is the first and only supported SQL plugin. Install the SQL runtime and PostgreSQL plugin at matching versions:

```sh
npm install @simtlix/simfinity-sql@3.3.0 @simtlix/simfinity-postgres@3.3.0 graphql@^16.11.0 pg@^8.16.3
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

A runtime permanently binds one plugin and configuration. Its methods and capabilities are captured at creation; connection objects remain caller-owned. To configure later, use `createSQL({ plugin: postgresPlugin() })`, then call `configure({ pool, schema })` once before `createSchema()`. Register all types before creating the schema and await successful initialization before serving operations.

`initializeDatabase({ mode: 'create' })` creates missing compatible storage; `mode: 'validate'` validates existing storage. Incompatible definitions are rejected. `preventCreatingCollection(true)` forces validation. PostgreSQL initialization performs no destructive migration or schema synchronization.

The runtime exposes the core registration and GraphQL lifecycle APIs, `configure`, `describeDatabase`, `initializeDatabase`, `withTransaction`, and shared `auth`, `plugins`, `scalars`, and `validators` helpers. Model handles expose `findById`, `find`, `create`, `update`, and `delete`. `find(args, { session })` accepts the generated list query's filters, sorting, and pagination. Native model helpers bypass GraphQL controllers and validators and use storage field names.

`withTransaction(session, callback)` joins an active session belonging to this runtime, or owns a new transaction when no session is supplied. Sessions expose `client`, `query(text, values)`, and `inTransaction()`. PostgreSQL uses repeatable-read isolation and retries confirmed serialization/deadlock aborts up to five times. Unknown commit outcomes are not replayed, and the application-owned pool stays open.

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
| `compileSchema(description)` | Return reviewable DDL statements. |
| `initialize(configuration, description, options)` | Create or validate storage and return `{ mode, created }`. |
| `compileQuery(models, description, queryPlan, extra)` | Return `{ text, values, aggregateFields? }`. Aggregate queries include the group field followed by each fact field in `aggregateFields`. |
| `compileRecord(description, operation)` | Compile one record operation into `{ text, values }`. |
| `values` | Create/cast IDs, encode/decode scalars, and encode embedded values. |
| `driver` | Validate configuration, execute statements, acquire/release clients, begin/commit/rollback transactions, classify retryable aborts, and normalize errors. |

The driver supplies `assertConfiguration`, `query`, `acquire`, `begin`, `commit`, `rollback`, `release`, `isRetryable`, and `normalizeError`. `query(configuration, statement, client?)` returns a promise resolving to `{ rows, rowCount? }`. Value codecs supply `createId()`, `castId(value)`, `encodeScalar(field, value)`, `decodeScalar(field, value, gqlField?)`, and `encodeEmbedded(value)`.

Physical descriptions must preserve the table names, primary keys, column names, presence markers, and ownership metadata needed for record reconstruction. Plugins may extend those shapes with native types, functions, triggers, and other engine metadata. `compileRecord` receives a physical **table object**, with one of these operation shapes:

| `kind` | Additional fields |
| --- | --- |
| `selectById` | `table`, `id`, optional `lock` |
| `selectOwned` | `table`, `ids`, `ordered` |
| `insert` | `table`, `data` |
| `update` | `table`, `id`, `data` |
| `deleteById` | `table`, `id` |
| `deleteOwned` | `table`, `ownerId` |

Every runtime requires `transactions`. Planning adds `foreignKeys`, `deferredForeignKeys`, `embeddedValues`, `ownedRecords`, `scalarLists`, `uniqueValues`, and `nullableUnique` when the model needs those guarantees. Embedded/owned capabilities include presence and shape enforcement. Unsupported guarantees fail before physical schema compilation or initialization; a plugin must not silently omit constraints.

Invalid plugin structure raises `INVALID_SQL_PLUGIN`; unsupported contract versions raise `UNSUPPORTED_SQL_PLUGIN_VERSION`; missing required guarantees raise `UNSUPPORTED_SQL_CAPABILITY`.

`compileQuery` receives `SQLModelDescription`, which extends core model metadata with recursive `SQLFieldDescription` fields. A registered state field may have `stateNames: [{ value, name }]`: `value` is the string form of the stored enum value, and `name` is its GraphQL enum name. Compilers can use this mapping for aggregate state names. Scalar codecs and `aggregateFields` use the same enriched field type.

TypeScript declarations export `SQLPlugin`, `SQLDriver`, `SQLValueCodec`, `RelationalPlan`, discriminated `RelationalCheck` and `SQLRecordOperation` unions, physical storage interfaces, and `SQLRuntime`, `SQLSession`, and `SQLModel`. Plugin generics preserve configuration, native client, physical description, query-result, and ID types through `createSQL`. Application-defined row values use `unknown` until narrowed. The `./internal/*` exports support the PostgreSQL compatibility wrappers and are not plugin-author APIs.
