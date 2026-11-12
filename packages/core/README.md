[![Simfinity.js — Define once. Build beyond. GraphQL, MongoDB, PostgreSQL, and optional MCP.](https://raw.githubusercontent.com/simtlix/simfinity.js/master/.github/assets/readme-cover.png)](https://simtlix.github.io/simfinity.js/)

# @simtlix/simfinity-core

[![npm version](https://img.shields.io/npm/v/@simtlix/simfinity-core.svg)](https://www.npmjs.com/package/@simtlix/simfinity-core)
[![Node.js](https://img.shields.io/node/v/@simtlix/simfinity-core.svg)](https://nodejs.org/)
[![License](https://img.shields.io/npm/l/@simtlix/simfinity-core.svg)](https://github.com/simtlix/simfinity.js/blob/master/LICENSE)
[![Documentation](https://img.shields.io/badge/docs-simtlix.github.io-2563eb.svg)](https://simtlix.github.io/simfinity.js/)

**The driver-free GraphQL runtime of [Simfinity.js](https://simtlix.github.io/simfinity.js/).** It holds model metadata, schema generation, the query and mutation engine, and the shared `auth`, `validators`, `scalars` and `plugins` helpers. It imports no Mongoose, MongoDB, PostgreSQL or MCP package.

Applications rarely install it by hand: the database packages depend on it. Start with [`@simtlix/simfinity-js`](https://www.npmjs.com/package/@simtlix/simfinity-js) for MongoDB or [`@simtlix/simfinity-postgres`](https://www.npmjs.com/package/@simtlix/simfinity-postgres) for PostgreSQL. Install core directly when you import one of its subpaths or write a database adapter.

**[Documentation](https://simtlix.github.io/simfinity.js/)** ·
**[API reference](https://simtlix.github.io/simfinity.js/reference/api.html)** ·
**[Field extensions](https://simtlix.github.io/simfinity.js/reference/extensions.html)** ·
**[Errors](https://simtlix.github.io/simfinity.js/reference/errors.html)** ·
**[Releases](https://github.com/simtlix/simfinity.js/releases)**

## Install

```sh
npm install @simtlix/simfinity-core graphql@^16.11.0
```

| Requirement | Version |
| --- | --- |
| Node.js | 18.18 or later, ES modules |
| `graphql` (peer) | `^16.11.0` |

As a direct dependency, pin core to the exact version of the database package you use, also under pnpm or Yarn PnP.

## Create a runtime

`createRuntime(adapter)` binds one database adapter. Each runtime owns its registrations, generated input types, middleware, scopes, hooks, custom operations, views and state machines.

```javascript
import { createRuntime } from '@simtlix/simfinity-core';

const simfinity = createRuntime(adapter); // for example, createMongoAdapter()
simfinity.connect(null, BookType, 'book', 'books');
const schema = simfinity.createSchema();
```

| Area | Functions | Reference |
| --- | --- | --- |
| Registration and schema | `connect`, `addNoEndpointType`, `createSchema` | [connect](https://simtlix.github.io/simfinity.js/reference/api.html#connect), [createSchema](https://simtlix.github.io/simfinity.js/reference/api.html#createschema) |
| Inspection | `getModel`, `getType`, `getInputType`, `getRegistrations` | [Core API](https://simtlix.github.io/simfinity.js/reference/api.html) |
| Middleware and custom writes | `use`, `registerMutation` | [Middleware](https://simtlix.github.io/simfinity.js/guide/middleware.html), [registerMutation](https://simtlix.github.io/simfinity.js/reference/api.html#registermutation) |
| Custom reads | `registerCustomQuery`, `registerView` | [registerCustomQuery](https://simtlix.github.io/simfinity.js/reference/api.html#registercustomquery), [registerView](https://simtlix.github.io/simfinity.js/reference/api.html#registerview) |
| Writes from your own code | `saveObject`, `updateObject`, `deleteObject`, `transitionObject` | [Server-side operations](https://simtlix.github.io/simfinity.js/guide/server-side-operations.html) |
| Limits and setup | `configureQueryLimits`, `configureMutationLimits`, `preventCreatingCollection` | [configureQueryLimits](https://simtlix.github.io/simfinity.js/reference/api.html#configurequerylimits) |

## Shared helpers

The package root also exports what every database package re-exports:

| Export | Purpose | Reference |
| --- | --- | --- |
| `auth` | Authorization rules and policy expressions | [Authorization](https://simtlix.github.io/simfinity.js/guide/authorization.html) |
| `validators`, `createValidatedScalar` | Field validators and validated scalars | [Validation](https://simtlix.github.io/simfinity.js/guide/validation.html), [scalars](https://simtlix.github.io/simfinity.js/reference/scalars.html) |
| `scalars` | Built-in scalar types | [Scalars](https://simtlix.github.io/simfinity.js/reference/scalars.html) |
| `plugins` | Server plugins: `createAuthPlugin`, `envelopCountPlugin` and `apolloCountPlugin` | [Plugins](https://simtlix.github.io/simfinity.js/reference/plugins.html) |
| `SimfinityError` and subclasses, `buildErrorFormatter` | Error identities and formatting | [Errors](https://simtlix.github.io/simfinity.js/reference/errors.html) |
| `RecordVersion`, `MAX_RECORD_VERSION` | The managed version of optimistic concurrency | [Optimistic concurrency](https://simtlix.github.io/simfinity.js/guide/concurrency.html) |
| `describeModels`, `createQueryPlan` | Model metadata and query plans for adapter authors | [SQL core & plugins](https://simtlix.github.io/simfinity.js/guide/sql-plugins.html) |

Public subpaths: `/auth`, `/auth/errors`, `/auth/expressions`, `/auth/rules`, `/plugins`, `/scalars`, `/validators` and `/introspection`. Paths under `/internal/` are for the Simfinity packages and can change in any release.

## Documentation

| I want to… | Read |
| --- | --- |
| Learn the model and schema rules | [Schema & models](https://simtlix.github.io/simfinity.js/guide/schema.html), [relationships](https://simtlix.github.io/simfinity.js/guide/relationships.html) |
| Understand filters, quantifiers and pagination | [Queries & filtering](https://simtlix.github.io/simfinity.js/guide/queries.html) |
| Understand generated and transaction mutations | [Mutations](https://simtlix.github.io/simfinity.js/guide/mutations.html) |
| Add business logic | [Controllers & hooks](https://simtlix.github.io/simfinity.js/guide/controllers.html), [state machines](https://simtlix.github.io/simfinity.js/guide/state-machines.html) |
| Restrict what a request can read | [Query scope](https://simtlix.github.io/simfinity.js/guide/query-scope.html) |
| Serve client metadata or disable the legacy introspection field | [Client descriptor](https://simtlix.github.io/simfinity.js/reference/client-descriptor.html) |
| Write a database adapter | [Custom database adapters](https://simtlix.github.io/simfinity.js/reference/api.html#custom-database-adapters) |
| Write a relational database plugin | [SQL core & plugins](https://simtlix.github.io/simfinity.js/guide/sql-plugins.html) |
| Upgrade between versions | [Compatibility & releases](https://simtlix.github.io/simfinity.js/resources/compatibility.html) |

## Packages

All Simfinity packages are released together under the same version. Keep the ones you install aligned. The ESLint plugin has its own version.

| Package | Use it for |
| --- | --- |
| [`@simtlix/simfinity-js`](https://www.npmjs.com/package/@simtlix/simfinity-js) | MongoDB/Mongoose applications |
| [`@simtlix/simfinity-postgres`](https://www.npmjs.com/package/@simtlix/simfinity-postgres) | PostgreSQL 15+ applications, with real tables and foreign keys |
| [`@simtlix/simfinity-mcp`](https://www.npmjs.com/package/@simtlix/simfinity-mcp) | MCP tools and transports for any Simfinity schema |
| [`@simtlix/simfinity-js-client`](https://www.npmjs.com/package/@simtlix/simfinity-js-client) | JavaScript client for Simfinity APIs |
| [`@simtlix/simfinity-descriptor`](https://www.npmjs.com/package/@simtlix/simfinity-descriptor) | Client metadata endpoint for a schema |
| **`@simtlix/simfinity-core`** | Shared GraphQL runtime, installed automatically (this package) |
| [`@simtlix/simfinity-sql`](https://www.npmjs.com/package/@simtlix/simfinity-sql) | Relational runtime and database plugin contract |
| [`@simtlix/eslint-plugin-simfinity`](https://www.npmjs.com/package/@simtlix/eslint-plugin-simfinity) | Optional lint rules for Simfinity applications |

## Contributing

Source, issues and the contribution guide live in the [simtlix/simfinity.js](https://github.com/simtlix/simfinity.js) monorepo, under `packages/core`. See [Contributing](https://simtlix.github.io/simfinity.js/resources/contributing.html).

## License

[Apache-2.0](https://github.com/simtlix/simfinity.js/blob/master/LICENSE)
