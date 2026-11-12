[![Simfinity.js — Define once. Build beyond. GraphQL, MongoDB, PostgreSQL, and optional MCP.](https://raw.githubusercontent.com/simtlix/simfinity.js/master/.github/assets/readme-cover.png)](https://simtlix.github.io/simfinity.js/)

# @simtlix/simfinity-js

[![npm version](https://img.shields.io/npm/v/@simtlix/simfinity-js.svg)](https://www.npmjs.com/package/@simtlix/simfinity-js)
[![Node.js](https://img.shields.io/node/v/@simtlix/simfinity-js.svg)](https://nodejs.org/)
[![License](https://img.shields.io/npm/l/@simtlix/simfinity-js.svg)](https://github.com/simtlix/simfinity.js/blob/master/LICENSE)
[![Documentation](https://img.shields.io/badge/docs-simtlix.github.io-2563eb.svg)](https://simtlix.github.io/simfinity.js/)

**Simfinity.js turns GraphQL object types into a complete API: generated queries, mutations, relationships, validation and database storage.** This package is the MongoDB/Mongoose edition. For PostgreSQL, install [`@simtlix/simfinity-postgres`](https://www.npmjs.com/package/@simtlix/simfinity-postgres) instead; both expose the same GraphQL contract.

**[Documentation](https://simtlix.github.io/simfinity.js/)** ·
**[Quick start](https://simtlix.github.io/simfinity.js/guide/getting-started.html)** ·
**[API reference](https://simtlix.github.io/simfinity.js/reference/api.html)** ·
**[Example app](https://simtlix.github.io/simfinity.js/resources/barber.html)** ·
**[Releases](https://github.com/simtlix/simfinity.js/releases)**

## Install

```sh
npm install @simtlix/simfinity-js graphql@^16.11.0 mongoose@^8.24.2
```

| Requirement | Version |
| --- | --- |
| Node.js | 18.18 or later, ES modules |
| `graphql` (peer) | `^16.11.0` |
| `mongoose` (peer) | `^8.24.2` |
| MongoDB | A replica set or sharded cluster, since generated mutations run in transactions |
| `@modelcontextprotocol/sdk` (optional peer) | `^1.31.0`, only for the MCP transports |

`graphql` and `mongoose` are peer dependencies, so Simfinity uses your application's copies. npm reports an out-of-range version as a peer conflict instead of installing a second one.

## Quick start

Set `"type": "module"` in your `package.json`, add `graphql-yoga` (or any GraphQL server), and create `server.js`:

```javascript
import { createServer } from 'node:http';
import { GraphQLID, GraphQLNonNull, GraphQLObjectType, GraphQLString } from 'graphql';
import { createYoga } from 'graphql-yoga';
import mongoose from 'mongoose';
import * as simfinity from '@simtlix/simfinity-js';

const SerieType = new GraphQLObjectType({
  name: 'Serie',
  fields: {
    id: { type: GraphQLID },
    name: { type: new GraphQLNonNull(GraphQLString) },
  },
});

await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/series?replicaSet=rs0&directConnection=true');
simfinity.connect(null, SerieType, 'serie', 'series');
const schema = simfinity.createSchema();

createServer(createYoga({ schema })).listen(4000, '127.0.0.1', () => {
  console.log('GraphQL ready at http://127.0.0.1:4000/graphql');
});
```

`connect()` registers the type with its singular and plural endpoint names, and `createSchema()` returns an executable schema with the generated operations:

```graphql
mutation {
  addserie(input: { name: "The Expanse" }) {
    id
    name
  }
}
```

```graphql
query {
  series(name: { operator: LIKE, value: "Expanse" }) {
    id
    name
  }
}
```

The [MongoDB quick start](https://simtlix.github.io/simfinity.js/guide/getting-started.html) walks through the local replica set, the downloadable starter, and create, read, update and delete operations.

## What you get

| Capability | What it does | Guide |
| --- | --- | --- |
| Schema and models | Mongoose models, input types and indexes generated from your GraphQL types | [Schema & models](https://simtlix.github.io/simfinity.js/guide/schema.html) |
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
| MCP tools | Generated tools for AI agents from the same schema | [MCP & AI tools](https://simtlix.github.io/simfinity.js/guide/mcp.html) |

## MongoDB options

The package root gives you a ready runtime. Two optional behaviors need your own adapter and runtime, created once at startup.

**Batched collection reads** load the collection fields of several parents in one aggregate command instead of one read per parent:

```javascript
import { createMongoAdapter, createRuntime } from '@simtlix/simfinity-js';

const adapter = createMongoAdapter({ batchedCollections: true }); // collectionBatchSize: 5
const simfinity = createRuntime(adapter);
```

See [batched collection reads](https://simtlix.github.io/simfinity.js/guide/relationships.html#batched-collection-reads) for the cases that keep individual reads.

**Transactional reference integrity** rejects references to missing records and restricts deleting a referenced record:

```javascript
import { createMongoAdapter, createRuntime } from '@simtlix/simfinity-js';

const adapter = createMongoAdapter({ referentialIntegrity: 'transactional' });
const simfinity = createRuntime(adapter);
await mongoose.connect(process.env.MONGODB_URI);
simfinity.connect(null, SerieType, 'serie', 'series');
const schema = simfinity.createSchema();
await adapter.initialize();
```

A violation rolls back the whole mutation with `REFERENCE_CONSTRAINT_VIOLATION` (409). Direct Mongoose or driver writes bypass this protection. See [MongoDB reference integrity](https://simtlix.github.io/simfinity.js/guide/mongodb-integrity.html) for setup, concurrency and migration.

## Documentation

| I want to… | Read |
| --- | --- |
| Decide between MongoDB and PostgreSQL | [Choose a database](https://simtlix.github.io/simfinity.js/guide/databases.html) |
| Build a first API | [MongoDB quick start](https://simtlix.github.io/simfinity.js/guide/getting-started.html) |
| Look up a function or option | [Core API](https://simtlix.github.io/simfinity.js/reference/api.html), [field extensions](https://simtlix.github.io/simfinity.js/reference/extensions.html) |
| Understand an error code | [Errors](https://simtlix.github.io/simfinity.js/reference/errors.html), [troubleshooting](https://simtlix.github.io/simfinity.js/resources/troubleshooting.html) |
| See a complete application | [Barber example app](https://simtlix.github.io/simfinity.js/resources/barber.html) |
| Avoid common mistakes | [Usage anti-patterns](https://simtlix.github.io/simfinity.js/guide/anti-patterns.html) |
| Upgrade between versions | [Compatibility & releases](https://simtlix.github.io/simfinity.js/resources/compatibility.html) |
| Start a project with an AI agent | [Build with an AI agent](https://simtlix.github.io/simfinity.js/guide/ai-project-bootstrap.html) |

## Packages

All Simfinity packages are released together under the same version. Keep the ones you install aligned. The ESLint plugin has its own version.

| Package | Use it for |
| --- | --- |
| **`@simtlix/simfinity-js`** | MongoDB/Mongoose applications (this package) |
| [`@simtlix/simfinity-postgres`](https://www.npmjs.com/package/@simtlix/simfinity-postgres) | PostgreSQL 15+ applications, with real tables and foreign keys |
| [`@simtlix/simfinity-mcp`](https://www.npmjs.com/package/@simtlix/simfinity-mcp) | MCP tools and transports for any Simfinity schema |
| [`@simtlix/simfinity-js-client`](https://www.npmjs.com/package/@simtlix/simfinity-js-client) | JavaScript client for Simfinity APIs |
| [`@simtlix/simfinity-descriptor`](https://www.npmjs.com/package/@simtlix/simfinity-descriptor) | Client metadata endpoint for a schema |
| [`@simtlix/simfinity-core`](https://www.npmjs.com/package/@simtlix/simfinity-core) | Shared GraphQL runtime, installed automatically |
| [`@simtlix/simfinity-sql`](https://www.npmjs.com/package/@simtlix/simfinity-sql) | Relational runtime and database plugin contract |
| [`@simtlix/eslint-plugin-simfinity`](https://www.npmjs.com/package/@simtlix/eslint-plugin-simfinity) | Optional lint rules for Simfinity applications |

This package also re-exports the MCP helpers and keeps its historical deep imports under `@simtlix/simfinity-js/src/`. New code should import `auth`, `plugins`, `scalars` and `validators` from the package root.

## Contributing

Source, issues and the contribution guide live in the [simtlix/simfinity.js](https://github.com/simtlix/simfinity.js) monorepo, under `packages/mongodb`. See [Contributing](https://simtlix.github.io/simfinity.js/resources/contributing.html).

## License

[Apache-2.0](https://github.com/simtlix/simfinity.js/blob/master/LICENSE)
