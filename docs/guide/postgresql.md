---
title: PostgreSQL quick start
description: Build and run a Simfinity GraphQL API with PostgreSQL, GraphQL Yoga, generated foreign keys, and explicit schema initialization.
---

# PostgreSQL quick start

Use `@simtlix/simfinity-postgres` when a new application will store Simfinity entities in PostgreSQL. The GraphQL registrations and generated operations match the MongoDB facade, while PostgreSQL uses UUID identities, native tables, real foreign keys, and its own Model and Session APIs. Choose the backend in application startup code; Simfinity does not switch a populated application between databases or migrate MongoDB data.

For a complete application alongside this small starter, run the [Barber example app](/resources/barber). It includes a shared Next.js frontend, booking flow, GraphQL and MCP endpoints, and a PostgreSQL schema export with real foreign-key catalog data.

Version 3.3.0 also exposes a [driver-free SQL core and PostgreSQL plugin](./sql-plugins). `createPostgres` remains supported and uses the same implementation; the plugin extraction preserves generated storage from 3.2.0.

## Download and install

[Download the v3.5.8 starters](/releases/simfinity-3.5.8-starters.zip), extract them, and install the PostgreSQL application from npm:

```sh
cd simfinity-3.5.8-starters/postgres
npm install
```

The starter uses `createSQL` with `postgresPlugin` and installs released core, SQL and PostgreSQL packages plus GraphQL, Yoga, and `pg`; it does not install Mongoose or MCP. See [download verification and package versions](./databases#download-the-starters). Use Node.js 22.15.0 or newer for the starter. The library supports Node.js `>=18.18.0`, GraphQL 16, and PostgreSQL 15, 16, and 18.

## Start a disposable database

```sh
docker run --name simfinity-postgres \
  -e POSTGRES_PASSWORD=simfinity \
  -e POSTGRES_DB=series \
  -p 127.0.0.1:5432:5432 \
  -d postgres:18-alpine
```

Set the connection string before starting the application:

```sh
export DATABASE_URL='postgresql://postgres:simfinity@127.0.0.1:5432/series'
```

Use separate credentials and network controls for a deployed database. The example schema name is `series_api`; it does not modify other PostgreSQL schemas.

## Define and serve the API

The downloaded `server.js` is the complete file below. It registers GraphQL types and endpoint names, builds the schema, awaits storage initialization, supplies request context to a controller, starts Yoga, and closes both the HTTP server and pool during shutdown. This example uses separate seasons to demonstrate a generated FK; the MongoDB quick start demonstrates embedded seasons. Both relationship shapes work with either backend.

<<< @/examples/postgresql-server.js

Run `node server.js`, open `http://127.0.0.1:4000/graphql`, and create a serie with a nested season:

```graphql
mutation {
  addserie(input: {
    name: "The Expanse"
    seasons: { added: [{ number: 1 }] }
  }) {
    id
    name
    createdBy
    seasons { id number }
  }
}
```

The runtime fills the child's `serie` reference and commits the parent, child, controller work, and hooks in one transaction. The controller receives a plain PostgreSQL record and a Simfinity PostgreSQL session. It does not receive a Mongoose document or session.

## Create or validate storage

Call `createSchema()` before `initializeDatabase()` and await initialization before serving GraphQL operations.

- `mode: 'create'` creates missing generated schemas, tables, indexes, functions, triggers, and constraints. It checks every existing managed object first and never replaces incompatible definitions. It may transactionally backfill generated uniqueness keys after validating existing rows.
- `mode: 'validate'` opens a read-only transaction and performs no DDL. Missing objects or drift raise `SCHEMA_MISMATCH`.
- `preventCreatingCollection(true)` must be called before `createSchema()` when an instance must remain validation-only. An explicit create request is then rejected.

Operations fail with `DATABASE_NOT_INITIALIZED` (503) until the first initialization succeeds. A rejected request, such as an unknown mode, leaves readiness as it was. A ready instance keeps serving while `initializeDatabase()` runs again, and any failed initialization makes operations fail until a later one succeeds. `create` mode locks the existing managed tables against writes until it commits, so use `mode: 'validate'` to check a live instance.

Neither mode drops source data, alters existing columns, runs application data migrations, or continuously monitors later administrator changes. Evolve a deployed schema with an explicit operator-reviewed migration, then run validation at startup. Columns are matched by name, so their physical order does not matter, but the migration must bring every generated object, including generated functions, in line with the new schema; `simfinity.compileDatabaseSchema()` returns the DDL that the instance expects, for review.

## Native Model and Session APIs

`getModel(Type)` returns a `PostgresModel` with `findById`, `find`, `create`, `update`, and `delete`. Records are plain objects whose `id` and `_id` are the same UUID. Native methods do not provide Mongoose query chaining, `.lean()`, population, middleware, or aggregation pipelines. Native writes bypass GraphQL input coercion, scopes, authorization, validators, and controllers, and use storage names for reference fields.

Use the runtime creation pipeline when validators, controllers, nested-write orchestration, and one shared transaction matter. A direct `saveObject()` call skips GraphQL coercion, field authorization, query scope and the root record's global middleware. Nested collection children still run their type's middleware with the supplied context. So the programmatic caller must validate and authorize its own request boundary, and pass a context that its middleware accepts:

```javascript
await simfinity.withTransaction(null, async (session) => {
  await simfinity.saveObject(
    'Serie',
    { name: 'Foundation' },
    session,
    { user: { id: 'import-job' } },
  );
  await session.query('SELECT 1');
});
```

`withTransaction` uses repeatable-read isolation and retries confirmed serialization failures and deadlocks up to five times, each after a short random delay. The supplied session is active only inside its callback. A nested `withTransaction(session, callback)` or `saveObject(..., session, ...)` joins it without committing or releasing it. Arbitrary `pg.Client` objects and sessions from another runtime are rejected. A statement that fails aborts the transaction even when the callback catches its error, so the call fails with `DATABASE_ERROR` (500); run the statement inside a savepoint to continue after an expected error. Simfinity detects a `COMMIT` that PostgreSQL turned into a rollback from the `command` that `pg` reports, so a custom pool or client wrapper must pass `command` through in its query results.

## Relationship foreign keys

PostgreSQL derives physical relationships from the same `extensions.relation` metadata:

| GraphQL shape | Generated storage |
| --- | --- |
| Single reference, such as `Season.serie` | A UUID column at `connectionField` (or the GraphQL field name when omitted), a referencing index, and a real FK to the target `id`. |
| Inverse collection, such as `Serie.seasons` | No parent array column; the child reference supplies the FK used by the generated collection resolver. |
| Explicit link entity, such as `Assignment { serie, star }` | Its own table and identity with one FK for each reference. Add `extensions.indexes` when a pair must be unique. |
| Embedded object/list containing a reference, such as `Serie.credits[].star` | Private owned tables with an owner FK using `ON DELETE CASCADE`, plus a real `NO ACTION` FK to the external entity. |

Entity-reference FKs use `ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE`. Only private ownership links cascade. Reciprocal lists that imply an unmodeled many-to-many relation are rejected; represent many-to-many relationships with an explicit link type.

## PostgreSQL storage rules

PostgreSQL uses stronger physical constraints than generated Mongoose storage. Required persisted scalars and references become `NOT NULL`; UUID, scalar type, enum, embedded shape, list-item nullability, ownership consistency, and foreign keys are checked in the database. JSONB stores embedded subtrees with no references or unique fields. Reference-bearing and unique embedded trees use private owned tables, presence markers, owner guard rows, and deferred integrity triggers.

`unique: true` uses PostgreSQL 15+ `NULLS NOT DISTINCT`. A nullable unique root value therefore permits at most one null. Embedded scalar/reference uniqueness and scalar-list multikey uniqueness use private typed keys: values may repeat within one root owner, while another root cannot claim the same value. Missing/null scalar leaves and missing/null/empty ancestor lists share one null key; an empty terminal scalar list contributes a distinct empty-array key. This behavior is stronger and broader than the indexes generated by the MongoDB facade.

Scalar lists, including `[ID]` lists, are native arrays without a generated index; element filters scan them. Databases created by earlier versions keep a btree index on `[ID]` list columns, which limits each list to about 167 identifiers until you drop it; startup logs a warning that names it. Native date-time values start at 4714-11-24 BC, and text cannot contain NUL (U+0000): such input fails with `INVALID_VALUE` (400). A text value of more than about 2.7 KB after compression cannot be stored in a unique field or another btree index. See [the storage reference](../postgresql#attributes-and-relationships).

The runtime preserves absent versus explicit-null embedded fields, null list items, list order, duplicates, descendant list defaults, and minimized empty inline objects. An omitted optional inline parent may become present when a descendant list has a default; if that parent also contains a required scalar, creation must provide it. MongoDB instead stores the defaulted parent without the required scalar and reads it as `null`. GraphQL create omits an explicit null object before defaults apply, while native `create` can store an explicit-null parent.

## Query support and boundaries

The shared query API supports typed scalar/reference/embedded filters, AND/OR groups, scopes, pagination, sorting, joined counts, and `SUM`, `COUNT`, `AVG`, `MIN`, and `MAX`. Nested scalar-list leaves support filters, sorts, ragged group projections, and array facts. Array MIN/MAX compares complete arrays; result sorting selects immediate extrema. Date parameters are encoded per query in UTC, including historical years, without changing global `pg` or process timezone defaults.

Unsupported shapes fail explicitly: implicit many-to-many reciprocal lists, non-embedded collections inside embedded objects, embedded cycles, nested list wrappers, whole embedded-object uniqueness, conflicting relationship metadata, enum values that collide after text conversion, and custom scalars without a recognized base storage type. Whole embedded objects cannot be sorted or grouped. Arbitrary MongoDB pipelines and Mongoose-native methods have no PostgreSQL equivalent.

Read the [detailed PostgreSQL storage and compatibility reference](../postgresql) and [database compatibility contract](../compatibility) before adopting PostgreSQL in an existing domain.

## Optional MCP integration

MCP is a separate package so PostgreSQL and core do not install its SDK chain. Install both the MCP package and SDK only when the application exposes tools:

```sh
npm install @simtlix/simfinity-mcp@3.5.8 \
  @modelcontextprotocol/sdk@^1.31.0
```

```javascript
import {
  createMCPServer,
  generateMCPTools,
} from '@simtlix/simfinity-mcp';

const { tools, callTool } = generateMCPTools(schema);
const server = await createMCPServer(schema);
```

`generateMCPTools` needs only GraphQL. Server and transport constructors load the optional SDK and report `MCP_SDK_NOT_INSTALLED` when it is absent. Close the MCP server with `await server.close()` during application shutdown. See [MCP integration](./mcp) for authorization, limits, cancellation, and transport behavior.
