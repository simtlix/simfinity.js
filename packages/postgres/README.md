# @simtlix/simfinity-postgres

PostgreSQL 15 or later support for the Simfinity GraphQL runtime. The package requires GraphQL 16 and Node.js 18.18 or later, depends on `pg`, `@simtlix/simfinity-sql`, and `@simtlix/simfinity-core`, and has no Mongoose or MongoDB dependency.

All Simfinity packages are released together. Install from npm and keep their versions aligned. Source and the complete startup guide: [simtlix/simfinity.js](https://github.com/simtlix/simfinity.js), [`docs/guide/postgresql.md`](https://github.com/simtlix/simfinity.js/blob/master/docs/guide/postgresql.md).

## Runtime

Create an instance, register the same GraphQL object type definitions used by Simfinity (each instance needs its own type objects), build the schema, and await database initialization before serving operations:

```javascript
import pg from 'pg';
import { createPostgres } from '@simtlix/simfinity-postgres';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const simfinity = createPostgres({ pool, schema: 'library' });

simfinity.connect(null, BookType, 'book', 'books', bookController);
const schema = simfinity.createSchema();
await simfinity.initializeDatabase({ mode: 'create' });

// Serve `schema`; the application remains responsible for `await pool.end()`.
```

`createPostgres` uses the driver-free SQL runtime with the PostgreSQL plugin. The equivalent explicit entry point is:

```javascript
import { createSQL } from '@simtlix/simfinity-sql';
import { postgresPlugin } from '@simtlix/simfinity-postgres';

const simfinity = createSQL({ plugin: postgresPlugin({ pool, schema: 'library' }) });
```

Install `@simtlix/simfinity-sql@3.7.0` as a direct dependency when importing its factory. PostgreSQL 15 or later is the only supported SQL plugin. The [SQL package guide](https://github.com/simtlix/simfinity.js/tree/master/packages/sql) documents relational planning and the versioned plugin contract.

Both factories permanently bind one pool and schema, and five optional settings: `multiRowInserts: false` keeps one `INSERT` per owned row instead of multi-row statements; `explicitNullsOrder: true` keeps the `NULLS` clause on sorts of `id` and required fields, as 3.5.9 did, instead of letting indexes serve them; `batchedCollections: true` reads the generated collection fields of the parents that share their arguments with one statement per 100 parents, in a transaction that turns JIT off for that transaction only, instead of one statement per field as 3.6.0 did and as the default still does, and can return unsorted and tied rows in another order; the opt-in `refreshTriggers: 'perRoot'` refreshes each changed root's owned shape and unique keys once per transaction, while its guard trigger stays deferred, instead of once per changed row; and the opt-in `ownerIndexes: 'minimal'` leaves out the `(__owner_id)` indexes that the primary key or a unique index covers on new owned and guard tables. An unknown `refreshTriggers` or `ownerIndexes` value throws `INVALID_DATABASE_SCHEMA` (400). Read the [upgrade notes](https://simtlix.github.io/simfinity.js/resources/compatibility.html#upgrade-to-3-6-0) before enabling the opt-ins: versions up to 3.5.9 cannot validate databases created with them. The returned runtime supports registration, generated queries and mutations, middleware and scopes, controllers and validators, custom queries and mutations, state machines, nested relationship writes, embedded reconstruction, and native PostgreSQL model handles. Native handles expose `findById`, `find`, `create`, `update`, and `delete`; they are not Mongoose models. `find(args, { session })` accepts the generated GraphQL list query arguments. Existing `pg.Pool` configuration and `pg.PoolClient` query interfaces remain compatible across both factories. A custom pool or client wrapper should pass `pg`'s `command` through in query results: the plugin reads it from the `COMMIT` result to detect a transaction that PostgreSQL rolled back because one of its statements failed, and without it such a transaction reports success with nothing stored.

Operations attempted before successful initialization fail with `DATABASE_NOT_INITIALIZED`. Call `createSchema` before `initializeDatabase`. Configuration and registrations become immutable once schema preparation begins. `preventCreatingCollection(true)` makes instance initialization validate existing storage without issuing creation DDL. A rejected initialization request leaves readiness as it was; a ready instance keeps serving while it is initialized again, and becomes unavailable if that initialization fails. `create` mode reads the catalog without table locks and locks nothing when nothing is missing. When it creates objects, writers of the tables that it changes, of existing tables that a new foreign key references, or of roots whose keys it rebuilds wait until it commits, so use `mode: 'validate'` to check a live instance. `simfinity.compileDatabaseSchema()` returns the instance's DDL for review or export.

A default module instance is also available when a singleton facade is preferable:

```javascript
import {
  configure,
  connect,
  createSchema,
  initializeDatabase,
} from '@simtlix/simfinity-postgres';

configure({ pool, schema: 'library' });
connect(null, BookType, 'book', 'books');
const schema = createSchema();
await initializeDatabase({ mode: 'validate' });
```

Called without arguments after `createSchema()`, the module's `describeDatabase()` and `compileDatabaseSchema()` describe and compile this default instance in its configured schema.

Transactions use one borrowed `pg` client and repeatable-read isolation. Reads without a session of types without owned embedded tables run as a single statement on a pooled connection instead. With `batchedCollections: true`, the runtime reads the generated collection fields of up to 100 parents that share their arguments in one batch, with one statement, a `UNION ALL` of each parent's own statement with its parent ID as a parameter of its own, so PostgreSQL plans each parent's rows as it plans that parent's own statement; more parents run as several batches, each in its own transaction. Each batch runs in one repeatable-read transaction: `BEGIN`, `SET LOCAL jit = off`, the statement, the owned-row reads, then `COMMIT`. Only a direct `findChildrenBatch` call on the SQL adapter with more than 100 IDs repeats `SET LOCAL` and the statement for each further 100 within its transaction. The batch's plan can cost more than `jit_above_cost` when no parent's own plan does, and JIT compilation of its branches can take longer than the statement itself; `SET LOCAL` ends with the transaction, so pooled connections keep the server's setting. A batch takes these 4 round trips, or more with owned rows, one after another on one connection and runs its parents one after another, where per-parent statements take one round trip each, concurrently on the pool's free connections. It pays off when the pool is saturated or much smaller than the number of parents per level, as with many parents with small child lists; with free connections it can be slower, even on a remote database, so measure before enabling it. Transaction-mode PgBouncer keeps each batch on one server connection, while Amazon RDS Proxy pins the pooled connections that run batches, for their `SET LOCAL` and their statements over 16 KB. See [batched collection reads](https://simtlix.github.io/simfinity.js/guide/relationships.html#batched-collection-reads). A supplied Simfinity PostgreSQL session joins the active transaction. Serialization failures and deadlocks are retried up to five times, each after a short random delay that starts once the client is released; mutation input is reset for each attempt. Unknown commit outcomes are not replayed. The caller owns the pool lifecycle.

The module and every `createPostgres` instance expose the shared `auth`, `validators`, `scalars`, and `plugins` helpers. These are the same helper objects exported by the MongoDB package, so rules, scalar identities, and errors can be shared safely between backends.

MCP integration is an independent opt-in and does not add MCP dependencies to PostgreSQL applications:

```sh
npm install @simtlix/simfinity-mcp@3.7.0 @modelcontextprotocol/sdk@^1.31.0
```

```javascript
import { createMCPServer } from '@simtlix/simfinity-mcp';

const mcpServer = await createMCPServer(schema);
```

## Storage and compatible subset

Entity identities and references use UUIDs. Scalars use native PostgreSQL types, scalar lists (including `[ID]` lists) use arrays without a generated index, reference-free embedded values use JSONB, and embedded values containing references use private owned tables. Foreign keys, inverse collections, explicit linking entities, missing/null markers, nullable embedded-list items, hooks, rollback, and state transitions are supported by the runtime.

Queries support nested scalar/reference paths, logical filter groups, scopes, sort, pagination, count, and grouped `SUM`, `COUNT`, `AVG`, `MIN`, and `MAX` facts. The PostgreSQL implementation preserves root multiplicity when joining collection paths.

Errors that PostgreSQL reports become `SimfinityError`s without SQL details, with the driver error as `getCause()`; errors that application code throws propagate unchanged. Text cannot contain NUL and native date-times start at 4714-11-24 BC: such input fails with `INVALID_VALUE` (400).

PostgreSQL enforces required values, real FKs, JSONB/owned embedded shapes, root and embedded scalar/reference uniqueness, and scalar-list multikey uniqueness. Root unique indexes use `NULLS NOT DISTINCT`; private typed owner-key tables allow repeated keys within one owner but reject the same key across owners. Presence markers preserve missing versus explicit null fields. This is stronger and broader than generated Mongoose storage.

Scalar-list leaves inside nested embedded lists support filters, sorts, ragged group projections, and array-valued facts. Array `MIN`/`MAX` compares complete arrays; result sorting uses immediate extrema. Date parameters use per-query UTC encoding without changing global `pg` behavior.

The following mappings remain unsupported and fail explicitly: implicit many-to-many reciprocal lists, non-embedded collections inside embedded objects, embedded cycles, nested list wrappers, whole embedded-object uniqueness, conflicting relationship metadata, enum values that collide after text conversion, and custom scalars without a recognized base scalar. Query paths cannot sort or group whole embedded objects. Arbitrary MongoDB pipelines and Mongoose-native methods are outside the PostgreSQL contract.

## Low-level schema API

The foundation API remains available independently of a runtime:

```javascript
import {
  compileDatabaseSchema,
  describeDatabase,
  initializeDatabase,
} from '@simtlix/simfinity-postgres';

const description = describeDatabase([{ gqltype: BookType }], { schema: 'library' });
const statements = compileDatabaseSchema(description);
await initializeDatabase(pool, description, { mode: 'validate' });
```

Low-level `describeDatabase(registrations, { schema, refreshTriggers, ownerIndexes })` uses the `public` schema when `schema` is omitted, not the schema of a configured runtime; pass the schema given to `configure()` or `createPostgres()`, or call `describeDatabase()` and `compileDatabaseSchema()` without arguments for the default instance. `compileDatabaseSchema` returns reviewable SQL. Low-level `initializeDatabase(pool, description, { mode })` creates or validates storage transactionally and never closes the pool. Create mode adds missing objects and rejects incompatible definitions; validate mode performs no DDL. Neither mode performs destructive schema synchronization or data migration.
