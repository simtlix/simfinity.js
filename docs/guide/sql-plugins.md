---
title: SQL core and plugins
description: Use the driver-free Simfinity SQL runtime with its PostgreSQL plugin, preserve existing APIs, and understand the versioned plugin contract.
---

# SQL core and plugins

Simfinity 3.3.0 separates shared relational behavior into `@simtlix/simfinity-sql`. PostgreSQL is the first and currently only supported SQL plugin. Existing applications can keep `createPostgres({ pool, schema })` and the PostgreSQL namespace API; both use the SQL runtime internally.

Choose a plugin when constructing a runtime. Its configuration is bound once, and its types must be registered before `createSchema()`. This selection does not migrate an application's data or change its backend while running.

## Create a runtime

Install the SQL core and the PostgreSQL plugin as direct dependencies when importing both:

```sh
npm install @simtlix/simfinity-sql@3.6.0 \
  @simtlix/simfinity-postgres@3.6.0 graphql@^16.11.0 pg@^8.16.3
```

```javascript
import pg from 'pg';
import { GraphQLID, GraphQLObjectType, GraphQLString } from 'graphql';
import { createSQL } from '@simtlix/simfinity-sql';
import { postgresPlugin } from '@simtlix/simfinity-postgres';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const simfinity = createSQL({ plugin: postgresPlugin({ pool, schema: 'series_api' }) });
const Serie = new GraphQLObjectType({
  name: 'Serie',
  fields: { id: { type: GraphQLID }, name: { type: GraphQLString } },
});

simfinity.connect(null, Serie, 'serie', 'series');
export const schema = simfinity.createSchema();
await simfinity.initializeDatabase({ mode: 'create' });
// Serve schema only after initialization. Close pool during application shutdown.
```

The equivalent convenience entry point remains:

```javascript
import { createPostgres } from '@simtlix/simfinity-postgres';

const simfinity = createPostgres({ pool, schema: 'series_api' });
```

You can defer connection configuration with `createSQL({ plugin: postgresPlugin() })`, followed by one `simfinity.configure({ pool, schema })` before building the schema. A second configuration is rejected. The application owns and closes its pool.

Operations fail with `DATABASE_NOT_INITIALIZED` (503) until the first `initializeDatabase()` call succeeds. Before it calls the plugin, the runtime rejects modes other than `create` and `validate` with `INVALID_INITIALIZATION_MODE` (400). On a validation-only runtime (`preventCreatingCollection(true)`), a missing or false mode validates and every other mode except `validate` is rejected with `DATABASE_CREATION_DISABLED` (409) instead. A rejected request leaves readiness as it was. A ready runtime keeps serving while it is initialized again; any failure of the initialization started last makes storage unavailable until a later one succeeds. After `createSchema()`, `simfinity.compileDatabaseSchema()` returns the plugin's DDL for the runtime's schema, for review or export, without touching storage.

Both forms expose the same generated GraphQL operations, scopes, controllers, validators, authorization, state machines, native model/session methods and optional MCP integration. Follow the [PostgreSQL quick start](./postgresql) for initialization, transactions and storage details, and the [MCP guide](./mcp) for the independent MCP package.

## Package responsibilities

| Package | Responsibility | Runtime dependencies |
| --- | --- | --- |
| `@simtlix/simfinity-core` | GraphQL generation, metadata, query plans, lifecycle and shared helpers | GraphQL peer; no database driver |
| `@simtlix/simfinity-sql` | Logical relational layout, record normalization/reconstruction, model handles and session orchestration | Core and GraphQL peer; no `pg`, Mongoose or MCP |
| `@simtlix/simfinity-postgres` | PostgreSQL plugin and compatible facade; physical types, queries, DDL, functions, triggers, catalog validation and driver operations | SQL, core, `pg` and GraphQL peer |
| `@simtlix/simfinity-mcp` | Tools and optional protocol transports generated from GraphQL | Core; optional MCP SDK |
| `@simtlix/simfinity-js` | MongoDB/Mongoose facade and compatibility exports | Core, MCP and MongoDB-specific dependencies |

The SQL core alone cannot execute queries against a database. Installing it does not install a concrete SQL engine. PostgreSQL-specific UUIDs, JSONB, arrays, casts, parameter syntax, locking, catalog inspection and deferred constraint triggers belong to the PostgreSQL plugin.

## Logical schema and physical constraints

`planRelationalSchema(models, { schema, naming })` accepts the result of core's `describeModels(registrations)`. It returns serializable logical metadata: `schema`, `tables`, `checkOrder`, `uniqueValues` and `requirements`. Each table describes columns, primary keys, foreign keys, indexes, checks and any embedded ownership. Columns carry a logical `scalar`, `list`, `nullable`, optional identity/value `default`, and optional `presenceColumn`; they contain no SQL type declarations or SQL expressions.

The plugin lowers that plan to its physical schema. The PostgreSQL lowering preserves the generated descriptions and DDL from 3.2.0, including private names and constraints, except that `[ID]` list columns no longer get a generated index since 3.5.6; databases that already have that index keep it and still validate. Upgrading an unchanged model from 3.2.0 to 3.3.0 does not require a generated-schema migration. Existing drift or a changed domain model still requires an explicit migration; initialization never silently alters incompatible storage.

| Domain metadata | Shared relational plan | PostgreSQL implementation |
| --- | --- | --- |
| ID, scalar, enum and scalar list | Logical type, item nullability, default and checks | UUID, scalar/array types, enum and list checks |
| Single reference | Reference column, index and foreign key | Real deferrable FK to the target identity |
| One-to-many inverse collection | Child's reference supplies the relationship | Resolver joins the child's FK; no parent array column |
| Many-to-many | Explicit link entity with two references | Link table with two real FKs |
| Ordinary embedded object/list | Embedded value with shape and presence metadata | JSONB with shape checks |
| Embedded tree containing references or unique fields | Private owned records with ownership and presence/state checks | Owned tables, cascading owner FKs, external FKs, private uniqueness keys and integrity triggers |
| Unique scalar, list leaf or compound index | Unique requirements and logical index/key metadata | NULL-equal indexes and owner-aware multikey enforcement |

References inside embedded data remain database-enforced foreign keys. A plugin cannot claim compatibility by dropping constraints it cannot implement. The existing [storage rules](../postgresql), including absent/null/empty distinctions, list order and duplicates, remain in force.

## Plugin contract version 1

The exported `SQLPlugin` TypeScript interface documents the complete contract. A plugin supplies these members:

| Member | Contract |
| --- | --- |
| `apiVersion`, `name`, `displayName`, `defaultSchema` | Version `1` and nonempty identifying/default-schema strings |
| `options`, `capabilities` | Initial connection configuration or null, and supported capability names |
| `naming.validateIdentifier(value)`, `naming.generatedName(...parts)` | Enforce the engine's identifier rules and deterministic generated names |
| `describeSchema(logicalPlan, configuration)` | Lower logical storage into physical table/column/ownership metadata used by the record store. The bound configuration, or `null`, is the last argument; a plugin may ignore it |
| `compileSchema(description)` | Return physical DDL statements for review or export. The runtime calls it only from `runtime.compileDatabaseSchema()`; storage is created and validated through `initialize` |
| `initialize(configuration, description, options)` | Create or validate storage in the mode it receives, detecting incompatible existing definitions. The runtime rejects modes other than `create` and `validate` before calling it, and passes `validate` on a validation-only runtime. Match existing columns by name, and keep accepting indexes that earlier versions generated, such as the `[ID]` list index |
| `compileQuery(models, description, queryPlan, extra, configuration)` | Return `{ text, values, aggregateFields? }`; aggregate decoding requires metadata for the group and each fact. The bound configuration, or `null`, is the last argument |
| `compileRecord(description, operation)` | Compile one record operation into `{ text, values }` |
| `compileRecordBatch(description, operation)`, `maxRecordBatchValues` | Optional, together: compile `{ kind: 'insertMany', table, rows }` into one statement that inserts every row, and bound the values (rows times columns) of such a statement with a positive safe integer |
| `values` | Create/cast IDs, encode/decode scalars, encode embedded values |
| `driver` | Validate configuration, execute statements, acquire/release connections, begin/commit/rollback transactions, classify retries and normalize errors |

`compileQuery` receives `SQLModelDescription`. State-machine fields can include `stateNames`, an array of `{ value, name }` entries mapping persisted enum values to GraphQL state names for aggregate output. SQL runtimes require state-machine `state` fields to be GraphQL enums and reject any other with `INVALID_MODEL` (400) at `createSchema()`, so every state field has `stateNames`. `SQLFieldDescription` exposes this metadata to typed compilers and codecs. Compiled SQL must not depend on the physical column order of a table, for example through `SELECT *` in a `UNION`: a migration that appends columns changes it.

`compileRecord` receives a physical table metadata object in `operation.table`. Supported operations are listed below; the union, `SQLRecordOperation`, does not include batches, so exhaustive switches keep compiling:

| `operation.kind` | Additional fields |
| --- | --- |
| `selectById` | `id`, optional `lock` |
| `selectOwned` | `ids`, `ordered` |
| `insert` | `data` |
| `update` | `id`, `data` |
| `deleteById` | `id` |
| `deleteOwned` | `ownerId` |

With both `compileRecordBatch` and `maxRecordBatchValues`, the record store inserts the owned rows of a write in runs: consecutive rows of one table with the same columns in the same order, split so that rows times columns stay within the limit, and ended before a row of another table, before owned rows are deleted and before a validation error is thrown, so the rows reach the database in the per-row order. The operation, typed `SQLInsertManyOperation`, is `{ kind: 'insertMany', table, rows }`; no result rows are needed. A single row goes through `compileRecord` as an `insert`, and the configuration `multiRowInserts: false` keeps one `insert` per row. PostgreSQL sets the limit to 32,767 values. `bindPlugin` rejects a `compileRecordBatch` that is not a function, or a `maxRecordBatchValues` that is not a positive safe integer, `null` included, with `INVALID_SQL_PLUGIN`. A copy of a plugin that overrides `compileRecord` for `insert`, such as `{ ...postgresPlugin(options), compileRecord }`, inherits `compileRecordBatch` and `maxRecordBatchValues`, so owned rows inserted in runs of two or more do not reach the override: also override `compileRecordBatch`, set both members to `undefined`, or set `multiRowInserts: false`.

The driver provides `assertConfiguration(configuration)`, `query(configuration, statement, client?)`, `acquire(configuration)`, `begin(client)`, `commit(client)`, `rollback(client)`, `release(client, error?)`, `isRetryable(error)` and `normalizeError(error)`. Queries resolve to `{ rows }`. `client` is the connection of a transaction or of a single-statement read; counts and aggregates omit it. `release` receives the rollback failure when ROLLBACK did not complete, whether after a failed transaction or as the probe after a failed single-statement read; discard that connection instead of returning it to a pool. The value hooks are `createId()`, `castId(value)`, `encodeScalar(field, value)`, `decodeScalar(field, value, gqlField)` and `encodeEmbedded(value)`. `createId()` and `castId()` may produce any identifier, including `0`; generated references to it resolve like any other ID, and only a stored `null`, missing value or empty string reads as no reference. For a malformed value, `castId()` should throw a `SimfinityError` with code `NOT_VALID_ID` and status 400, as the PostgreSQL plugin does; it must not create a new identifier.

`commit(client)` must reject when the engine did not commit, for example when it rolled the transaction back because a statement had failed; PostgreSQL resolves such a `COMMIT` without an error, so its plugin rejects when the result reports the `ROLLBACK` command. A rejected commit is retried, like any other confirmed abort, only when `isRetryable()` accepts its error: reject with an error that it does not accept when a failed statement caused the rollback, and with a retryable one only for an abort that is safe to replay, such as a serialization failure reported at `COMMIT`. `isRetryable(error)` and `normalizeError(error)` receive any object thrown in an owned transaction or operation, application errors included, but never `null` or another value that is not an object; `normalizeError` never receives a `SimfinityError`. `normalizeError` must map its own engine's errors and return every other error unchanged, so application errors propagate as thrown. When it returns a failed `acquire`, `begin`, `query` or `commit` call's error unchanged, the runtime masks it as `DATABASE_ERROR` (500), with the original as its non-enumerable `cause` and `getCause()`; return a new object or a `SimfinityError` to keep your own mapping. Statement errors that `session.query()` returns inside a callback are the driver's own, so a savepoint can recover from them.

SQL owns session validity and transaction orchestration; the plugin owns connection operations and error classification. PostgreSQL begins repeatable-read transactions and permits at most five retries of confirmed serialization/deadlock aborts. SQL retries an owned transaction only for errors that `isRetryable()` accepts, and waits a random delay of less than 10, 20, 40, 80 and 160 ms before each retry, once the failed attempt has rolled back and `release()` has completed, so conflicting transactions do not retry in lock-step. Unknown commit outcomes and attempts whose rollback failed are not replayed. Supplied active sessions join the existing transaction; foreign and expired sessions are rejected. A session expires as soon as its callback settles, before COMMIT or ROLLBACK is sent, so un-awaited session work fails with `INVALID_SESSION` instead of running outside the transaction.

When the plugin advertises `singleStatementReads`, as PostgreSQL does, a read without a session and without a lock that one statement answers, of a type without owned tables, runs on one acquired connection: `acquire`, `query` and `release`, without `begin` or `commit`. SQL retries it, with the same delays and limit, for an error that `isRetryable()` accepts, without a rollback step. After any other failed driver call, SQL calls `rollback(client)` on that connection, outside a transaction, to probe it, as after a failed statement in a transaction, and passes a probe failure to `release(client, error)`, so the driver discards the connection instead of returning it to a pool. The read's own error is reported, normalized the same way; the connection is never accepted as a session. Reads that hydrate owned rows keep one transaction. To keep a transaction around every PostgreSQL read, for example in a wrapper whose `begin()` sets per-transaction settings, pass a copy of the plugin without the capability:

```javascript
const plugin = postgresPlugin({ pool, schema: 'library' });
const simfinity = createSQL({
  plugin: { ...plugin, capabilities: plugin.capabilities.filter((name) => name !== 'singleStatementReads') },
});
```

### Capabilities and failure behavior

| Capability | Required when |
| --- | --- |
| `transactions` | Every SQL runtime |
| `foreignKeys`, `deferredForeignKeys` | The relational layout contains references or ownership FKs |
| `embeddedValues` | Inline embedded values need shape and presence guarantees |
| `ownedRecords` | Embedded data needs private owned storage |
| `scalarLists` | A scalar list is stored as a relational column |
| `uniqueValues`, `nullableUnique` | Generated uniqueness must preserve NULL-equal semantics |
| `singleStatementReads` | Never required. Advertise it only when one statement reads one consistent snapshot without a transaction, and `rollback(client)` resolves on a usable connection that has no open transaction and rejects on an unusable one; sessionless reads then skip `begin` and `commit`, as described above |

Malformed plugins fail at runtime construction with `INVALID_SQL_PLUGIN`; unknown contract versions raise `UNSUPPORTED_SQL_PLUGIN_VERSION`. After logical planning, missing required guarantees raise `UNSUPPORTED_SQL_CAPABILITY` before physical schema compilation and initialization. Driver configuration validation must be synchronous and perform no database I/O.

The runtime snapshots contract members, option properties and capability arrays. Connection objects remain caller-owned references. Plugin authors should use explicit arguments or stable closures rather than replacing methods/configuration after construction.

## Implement another engine

Implement the contract and export a factory from a separate package depending on SQL/core plus that engine's driver. Reuse the relational plan and typed core query plans; implement the engine's complete storage lowering, query and record compiler, codecs, initialization and transaction guarantees. Reusing only PostgreSQL's parameter syntax is insufficient.

Run the shared query/lifecycle/relationship corpus against a disposable instance of the engine. Include raw-database tests proving FKs, required values, nullable lists, embedded ownership/presence, uniqueness, rollback and schema-drift detection. Verify packed installation and strict TypeScript consumers without PostgreSQL dependencies. The recording plugin in Simfinity's tests verifies delegation only; it is not another supported database adapter.
