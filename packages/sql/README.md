[![Simfinity.js — Define once. Build beyond. GraphQL, MongoDB, PostgreSQL, and optional MCP.](https://raw.githubusercontent.com/simtlix/simfinity.js/master/.github/assets/readme-cover.png)](https://simtlix.github.io/simfinity.js/)

# @simtlix/simfinity-sql

[![npm version](https://img.shields.io/npm/v/@simtlix/simfinity-sql.svg)](https://www.npmjs.com/package/@simtlix/simfinity-sql)
[![Node.js](https://img.shields.io/node/v/@simtlix/simfinity-sql.svg)](https://nodejs.org/)
[![License](https://img.shields.io/npm/l/@simtlix/simfinity-sql.svg)](https://github.com/simtlix/simfinity.js/blob/master/LICENSE)
[![Documentation](https://img.shields.io/badge/docs-simtlix.github.io-2563eb.svg)](https://simtlix.github.io/simfinity.js/)

**The driver-free relational runtime of [Simfinity.js](https://simtlix.github.io/simfinity.js/).** It plans the relational schema, rebuilds records and orchestrates transactions, and delegates every physical database decision to a plugin. PostgreSQL 15 or later is the first and only supported plugin.

Most applications install [`@simtlix/simfinity-postgres`](https://www.npmjs.com/package/@simtlix/simfinity-postgres), which brings this package in. Install it directly when you compose the runtime and the plugin yourself, or when you write a plugin for another engine.

**[Documentation](https://simtlix.github.io/simfinity.js/)** ·
**[SQL core & plugins](https://simtlix.github.io/simfinity.js/guide/sql-plugins.html)** ·
**[Plugin authoring](https://simtlix.github.io/simfinity.js/guide/plugin-authoring.html)** ·
**[PostgreSQL quick start](https://simtlix.github.io/simfinity.js/guide/postgresql.html)** ·
**[Releases](https://github.com/simtlix/simfinity.js/releases)**

## Install

```sh
npm install @simtlix/simfinity-sql @simtlix/simfinity-postgres graphql@^16.11.0 pg@^8.16.3
```

| Requirement | Version |
| --- | --- |
| Node.js | 18.18 or later, ES modules |
| `graphql` (peer) | `^16.11.0` |
| A database plugin | `@simtlix/simfinity-postgres`, at the same version |

This package depends only on `@simtlix/simfinity-core`. It does not install `pg`, MongoDB, Mongoose, MCP or a database plugin.

## Create a runtime

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

The runtime exposes the same registration, schema and server-side API as the database packages. See [Create a runtime](https://simtlix.github.io/simfinity.js/guide/sql-plugins.html#create-a-runtime).

## Plan a relational schema

`planRelationalSchema()` is pure: it turns model metadata into a serializable plan of logical tables, columns, foreign keys, indexes and checks, with no physical SQL types or driver objects:

```javascript
import { describeModels } from '@simtlix/simfinity-core';
import { planRelationalSchema } from '@simtlix/simfinity-sql';

const models = describeModels([{ gqltype: BookType }]);
const plan = planRelationalSchema(models, { schema: 'library' });
```

See [Logical schema and physical constraints](https://simtlix.github.io/simfinity.js/guide/sql-plugins.html#logical-schema-and-physical-constraints).

## Write a plugin

A plugin owns physical SQL, types, schema initialization and the driver. The runtime validates a plugin when it is created, and rejects a schema that needs a capability the plugin does not declare with `UNSUPPORTED_SQL_CAPABILITY`.

| Topic | Read |
| --- | --- |
| What each package is responsible for | [Package responsibilities](https://simtlix.github.io/simfinity.js/guide/sql-plugins.html#package-responsibilities) |
| The members a plugin implements | [Plugin contract version 1](https://simtlix.github.io/simfinity.js/guide/sql-plugins.html#plugin-contract-version-1) |
| Filter operators, quantifiers and frames | [Query features](https://simtlix.github.io/simfinity.js/guide/sql-plugins.html#query-features) |
| Batched collection reads | [Batched collection reads](https://simtlix.github.io/simfinity.js/guide/sql-plugins.html#batched-collection-reads) |
| Declared capabilities and failures | [Capabilities and failure behavior](https://simtlix.github.io/simfinity.js/guide/sql-plugins.html#capabilities-and-failure-behavior) |
| Supporting another database | [Implement another engine](https://simtlix.github.io/simfinity.js/guide/sql-plugins.html#implement-another-engine) |
| Versions and stale writes | [Optimistic concurrency](https://simtlix.github.io/simfinity.js/guide/sql-plugins.html#optimistic-concurrency) |
| A step-by-step brief for coding agents | [Plugin authoring for AI agents](https://simtlix.github.io/simfinity.js/guide/plugin-authoring.html) |

## Packages

All Simfinity packages are released together under the same version. Keep the ones you install aligned. The ESLint plugin has its own version.

| Package | Use it for |
| --- | --- |
| [`@simtlix/simfinity-js`](https://www.npmjs.com/package/@simtlix/simfinity-js) | MongoDB/Mongoose applications |
| [`@simtlix/simfinity-postgres`](https://www.npmjs.com/package/@simtlix/simfinity-postgres) | PostgreSQL 15+ applications, with real tables and foreign keys |
| [`@simtlix/simfinity-mcp`](https://www.npmjs.com/package/@simtlix/simfinity-mcp) | MCP tools and transports for any Simfinity schema |
| [`@simtlix/simfinity-js-client`](https://www.npmjs.com/package/@simtlix/simfinity-js-client) | JavaScript client for Simfinity APIs |
| [`@simtlix/simfinity-descriptor`](https://www.npmjs.com/package/@simtlix/simfinity-descriptor) | Client metadata endpoint for a schema |
| [`@simtlix/simfinity-core`](https://www.npmjs.com/package/@simtlix/simfinity-core) | Shared GraphQL runtime, installed automatically |
| **`@simtlix/simfinity-sql`** | Relational runtime and database plugin contract (this package) |
| [`@simtlix/eslint-plugin-simfinity`](https://www.npmjs.com/package/@simtlix/eslint-plugin-simfinity) | Optional lint rules for Simfinity applications |

## Contributing

Source, issues and the contribution guide live in the [simtlix/simfinity.js](https://github.com/simtlix/simfinity.js) monorepo, under `packages/sql`. See [Contributing](https://simtlix.github.io/simfinity.js/resources/contributing.html).

## License

[Apache-2.0](https://github.com/simtlix/simfinity.js/blob/master/LICENSE)
