# @simtlix/simfinity-postgres

PostgreSQL 15 or later support for the Simfinity GraphQL runtime. The package requires GraphQL 16 and Node.js 18.18 or later, depends on `pg` and `@simtlix/simfinity-core`, and has no Mongoose or MongoDB dependency.

Version 3.2.0 is released together with the other Simfinity packages. Install from npm and keep their versions aligned. Source and the complete startup guide: [simtlix/simfinity.js](https://github.com/simtlix/simfinity.js), [`docs/guide/postgresql.md`](https://github.com/simtlix/simfinity.js/blob/master/docs/guide/postgresql.md).

## Runtime

Create an instance, register the same GraphQL object types used by Simfinity, build the schema, and await database initialization before serving operations:

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

`createPostgres` permanently binds one pool and schema. The returned runtime supports registration, generated queries and mutations, middleware and scopes, controllers and validators, custom mutations, state machines, nested relationship writes, embedded reconstruction, and native PostgreSQL model handles. Native handles expose `findById`, `find`, `create`, `update`, and `delete`; they are not Mongoose models.

Operations attempted before successful initialization fail with `DATABASE_NOT_INITIALIZED`. Call `createSchema` before `initializeDatabase`. Configuration and registrations become immutable once schema preparation begins. `preventCreatingCollection(true)` makes instance initialization validate existing storage without issuing creation DDL.

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

Transactions use one borrowed `pg` client and repeatable-read isolation. A supplied Simfinity PostgreSQL session joins the active transaction. Serialization failures and deadlocks are retried up to five times; mutation input is reset for each attempt. The caller owns the pool lifecycle.

The module and every `createPostgres` instance expose the shared `auth`, `validators`, `scalars`, and `plugins` helpers. These are the same helper objects exported by the MongoDB package, so rules, scalar identities, and errors can be shared safely between backends.

MCP integration is an independent opt-in and does not add MCP dependencies to PostgreSQL applications:

```sh
npm install @simtlix/simfinity-mcp @modelcontextprotocol/sdk
```

```javascript
import { createMCPServer } from '@simtlix/simfinity-mcp';

const mcpServer = await createMCPServer(schema);
```

## Storage and compatible subset

Entity identities and references use UUIDs. Scalars use native PostgreSQL types, scalar lists use arrays, reference-free embedded values use JSONB, and embedded values containing references use private owned tables. Foreign keys, inverse collections, explicit linking entities, missing/null markers, nullable embedded-list items, hooks, rollback, and state transitions are supported by the runtime.

Queries support nested scalar/reference paths, logical filter groups, scopes, sort, pagination, count, and grouped `SUM`, `COUNT`, `AVG`, `MIN`, and `MAX` facts. The PostgreSQL implementation preserves root multiplicity when joining collection paths.

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

`compileDatabaseSchema` returns reviewable SQL. Low-level `initializeDatabase(pool, description, { mode })` creates or validates storage transactionally and never closes the pool. Create mode adds missing objects and rejects incompatible definitions; validate mode performs no DDL. Neither mode performs destructive schema synchronization or data migration.
