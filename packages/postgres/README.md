[![Simfinity.js — Define once. Build beyond. GraphQL, MongoDB, PostgreSQL, and optional MCP.](https://raw.githubusercontent.com/simtlix/simfinity.js/master/.github/assets/readme-cover.png)](https://simtlix.github.io/simfinity.js/)

# @simtlix/simfinity-postgres

[![npm version](https://img.shields.io/npm/v/@simtlix/simfinity-postgres.svg)](https://www.npmjs.com/package/@simtlix/simfinity-postgres)
[![Node.js](https://img.shields.io/node/v/@simtlix/simfinity-postgres.svg)](https://nodejs.org/)
[![License](https://img.shields.io/npm/l/@simtlix/simfinity-postgres.svg)](https://github.com/simtlix/simfinity.js/blob/master/LICENSE)
[![Documentation](https://img.shields.io/badge/docs-simtlix.github.io-2563eb.svg)](https://simtlix.github.io/simfinity.js/)

**Simfinity.js turns GraphQL object types into a complete API: generated queries, mutations, relationships, validation and database storage.** This package is the PostgreSQL edition: native tables, UUID identities and real foreign keys on PostgreSQL 15 or later. For MongoDB, install [`@simtlix/simfinity-js`](https://www.npmjs.com/package/@simtlix/simfinity-js) instead; both expose the same GraphQL contract.

**[Documentation](https://simtlix.github.io/simfinity.js/)** ·
**[PostgreSQL quick start](https://simtlix.github.io/simfinity.js/guide/postgresql.html)** ·
**[API reference](https://simtlix.github.io/simfinity.js/reference/api.html)** ·
**[Example app](https://simtlix.github.io/simfinity.js/resources/barber.html)** ·
**[Releases](https://github.com/simtlix/simfinity.js/releases)**

## Install

```sh
npm install @simtlix/simfinity-postgres graphql@^16.11.0 pg@^8.16.3
```

| Requirement | Version |
| --- | --- |
| Node.js | 18.18 or later, ES modules |
| `graphql` (peer) | `^16.11.0` |
| PostgreSQL | 15 or later |
| `pg` | `^8.16.3`; your application creates and owns the pool |
| `@simtlix/simfinity-mcp` | Optional, only when you expose MCP tools |

The shared runtime packages install automatically. This package does not pull in Mongoose, MongoDB or MCP dependencies.

## Quick start

Set `"type": "module"` in your `package.json`, add `graphql-yoga` (or any GraphQL server), and create `server.js`:

```javascript
import { createServer } from 'node:http';
import { GraphQLID, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { createYoga } from 'graphql-yoga';
import pg from 'pg';
import { createPostgres } from '@simtlix/simfinity-postgres';

const BookType = new GraphQLObjectType({
  name: 'Book',
  fields: {
    id: { type: GraphQLID },
    title: { type: new GraphQLNonNull(GraphQLString) },
  },
});

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const simfinity = createPostgres({ pool, schema: 'library' });

simfinity.connect(null, BookType, 'book', 'books');
const schema = simfinity.createSchema();
await simfinity.initializeDatabase({ mode: 'create' });

createServer(createYoga({ schema })).listen(4000, '127.0.0.1', () => {
  console.log('GraphQL ready at http://127.0.0.1:4000/graphql');
});
```

`connect()` registers the type with its singular and plural endpoint names, and `createSchema()` returns an executable schema with the generated operations:

```graphql
mutation {
  addbook(input: { title: "Dune" }) {
    id
    title
  }
}
```

```graphql
query {
  books(title: { operator: LIKE, value: "Dune" }) {
    id
    title
  }
}
```

Await `initializeDatabase()` after `createSchema()` and before serving requests:

- `mode: 'create'` creates the missing schemas, tables, indexes and constraints. It never replaces an incompatible definition.
- `mode: 'validate'` performs no DDL and fails with `SCHEMA_MISMATCH` when storage has drifted.

Neither mode drops data or alters existing columns. Your application closes the pool with `pool.end()` at shutdown.

The [PostgreSQL quick start](https://simtlix.github.io/simfinity.js/guide/postgresql.html) covers a disposable database, the downloadable starter, relationships with generated foreign keys, and controllers.

## Other entry points

`createPostgres()` is the shortest setup. The same runtime is available through explicit composition, which selects the database plugin by name:

```javascript
import { createSQL } from '@simtlix/simfinity-sql';
import { postgresPlugin } from '@simtlix/simfinity-postgres';

const simfinity = createSQL({ plugin: postgresPlugin({ pool, schema: 'library' }) });
```

Install `@simtlix/simfinity-sql` directly when you import it. See [SQL core & plugins](https://simtlix.github.io/simfinity.js/guide/sql-plugins.html).

Module-level functions mirror the MongoDB package for applications that keep one runtime:

```javascript
import { configure, connect, createSchema, initializeDatabase } from '@simtlix/simfinity-postgres';

configure({ pool, schema: 'library' });
connect(null, BookType, 'book', 'books');
const schema = createSchema();
await initializeDatabase({ mode: 'validate' });
```

To review or export the generated DDL without a runtime:

```javascript
import { compileDatabaseSchema, describeDatabase, initializeDatabase } from '@simtlix/simfinity-postgres';

const description = describeDatabase([{ gqltype: BookType }], { schema: 'library' });
const statements = compileDatabaseSchema(description);
await initializeDatabase(pool, description, { mode: 'validate' });
```

## What you get

| Capability | What it does | Guide |
| --- | --- | --- |
| Storage | Tables, UUID identities, indexes and real foreign keys, including many-to-many linking entities | [Relationship foreign keys](https://simtlix.github.io/simfinity.js/guide/postgresql.html#relationship-foreign-keys), [storage rules](https://simtlix.github.io/simfinity.js/guide/postgresql.html#postgresql-storage-rules) |
| Schema initialization | Create or validate storage at startup | [Create or validate storage](https://simtlix.github.io/simfinity.js/guide/postgresql.html#create-or-validate-storage) |
| Native access | `getModel()`, `withTransaction()` and `session.query()` for your own SQL | [Native Model and Session APIs](https://simtlix.github.io/simfinity.js/guide/postgresql.html#native-model-and-session-apis) |
| Queries | Typed filters, nested paths, quantifiers, sorting, pagination and counts | [Queries & filtering](https://simtlix.github.io/simfinity.js/guide/queries.html) |
| Mutations | Add, update and delete with nested writes in one transaction | [Mutations](https://simtlix.github.io/simfinity.js/guide/mutations.html) |
| Relationships | Embedded and referenced relations with generated resolvers | [Relationships](https://simtlix.github.io/simfinity.js/guide/relationships.html) |
| Aggregation | Group-by queries with SUM, COUNT, AVG, MIN and MAX | [Aggregation](https://simtlix.github.io/simfinity.js/reference/aggregation.html) |
| Validation | Field and type validators, validated scalars | [Validation](https://simtlix.github.io/simfinity.js/guide/validation.html) |
| Controllers and hooks | Business logic before and after each write, plus after-commit callbacks | [Controllers & hooks](https://simtlix.github.io/simfinity.js/guide/controllers.html) |
| State machines | Declarative states and transitions as generated mutations | [State machines](https://simtlix.github.io/simfinity.js/guide/state-machines.html) |
| Optimistic concurrency | A managed `version` field that rejects stale writes | [Optimistic concurrency](https://simtlix.github.io/simfinity.js/guide/concurrency.html) |
| Authorization | Role, attribute and policy rules, as a Yoga/Envelop plugin | [Authorization](https://simtlix.github.io/simfinity.js/guide/authorization.html) |
| Query scope | Per-request visibility rules applied to every read | [Query scope](https://simtlix.github.io/simfinity.js/guide/query-scope.html) |
| Middleware | Cross-cutting logic around every generated operation | [Middleware](https://simtlix.github.io/simfinity.js/guide/middleware.html) |
| Server-side operations | `saveObject`, `updateObject`, `deleteObject` and `transitionObject` from your own code | [Server-side operations](https://simtlix.github.io/simfinity.js/guide/server-side-operations.html) |
| MCP tools | Generated tools for AI agents, through `@simtlix/simfinity-mcp` | [Optional MCP integration](https://simtlix.github.io/simfinity.js/guide/postgresql.html#optional-mcp-integration) |

## Documentation

| I want to… | Read |
| --- | --- |
| Decide between MongoDB and PostgreSQL | [Choose a database](https://simtlix.github.io/simfinity.js/guide/databases.html) |
| Build a first API | [PostgreSQL quick start](https://simtlix.github.io/simfinity.js/guide/postgresql.html) |
| Know what PostgreSQL supports and where it differs | [Query support and boundaries](https://simtlix.github.io/simfinity.js/guide/postgresql.html#query-support-and-boundaries) |
| Look up a function or option | [Core API](https://simtlix.github.io/simfinity.js/reference/api.html), [field extensions](https://simtlix.github.io/simfinity.js/reference/extensions.html) |
| Understand an error code | [Errors](https://simtlix.github.io/simfinity.js/reference/errors.html), [troubleshooting](https://simtlix.github.io/simfinity.js/resources/troubleshooting.html) |
| See a complete application | [Barber example app](https://simtlix.github.io/simfinity.js/resources/barber.html) |
| Upgrade between versions | [Compatibility & releases](https://simtlix.github.io/simfinity.js/resources/compatibility.html) |

## Packages

All Simfinity packages are released together under the same version. Keep the ones you install aligned. The ESLint plugin has its own version.

| Package | Use it for |
| --- | --- |
| [`@simtlix/simfinity-js`](https://www.npmjs.com/package/@simtlix/simfinity-js) | MongoDB/Mongoose applications |
| **`@simtlix/simfinity-postgres`** | PostgreSQL 15+ applications, with real tables and foreign keys (this package) |
| [`@simtlix/simfinity-mcp`](https://www.npmjs.com/package/@simtlix/simfinity-mcp) | MCP tools and transports for any Simfinity schema |
| [`@simtlix/simfinity-js-client`](https://www.npmjs.com/package/@simtlix/simfinity-js-client) | JavaScript client for Simfinity APIs |
| [`@simtlix/simfinity-descriptor`](https://www.npmjs.com/package/@simtlix/simfinity-descriptor) | Client metadata endpoint for a schema |
| [`@simtlix/simfinity-core`](https://www.npmjs.com/package/@simtlix/simfinity-core) | Shared GraphQL runtime, installed automatically |
| [`@simtlix/simfinity-sql`](https://www.npmjs.com/package/@simtlix/simfinity-sql) | Relational runtime and database plugin contract |
| [`@simtlix/eslint-plugin-simfinity`](https://www.npmjs.com/package/@simtlix/eslint-plugin-simfinity) | Optional lint rules for Simfinity applications |

## Contributing

Source, issues and the contribution guide live in the [simtlix/simfinity.js](https://github.com/simtlix/simfinity.js) monorepo, under `packages/postgres`. See [Contributing](https://simtlix.github.io/simfinity.js/resources/contributing.html).

## License

[Apache-2.0](https://github.com/simtlix/simfinity.js/blob/master/LICENSE)
