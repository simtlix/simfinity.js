# @simtlix/simfinity-core

Driver-free GraphQL runtime, model metadata, and shared GraphQL helpers for Simfinity. It requires GraphQL 16 and Node.js 18.18 or later, and does not import Mongoose, MongoDB, PostgreSQL, or MCP packages.

All Simfinity packages are released together. Install from npm and keep their versions aligned. Source: [simtlix/simfinity.js](https://github.com/simtlix/simfinity.js).

For relational storage, `@simtlix/simfinity-sql` builds on core and delegates physical database behavior to a plugin. PostgreSQL is the first supported plugin; its `createPostgres` facade remains available. See the [SQL plugin guide](https://simtlix.github.io/simfinity.js/guide/sql-plugins.html).

## Runtime

`createRuntime(adapter)` creates an isolated Simfinity runtime. Each instance owns its registrations, generated input types, middleware, scopes, hooks, custom mutations, and state machines. It exposes:

- `connect`, `addNoEndpointType`, and `createSchema` for registration and schema creation;
- `getModel`, `getType`, `getInputType`, and `getRegistrations` for runtime inspection;
- `use`, `registerMutation`, and `saveObject` for middleware and write orchestration;
- `preventCreatingCollection` to pass validation-only storage setup to an adapter.

The adapter supplies model creation, identifiers, transactions, record reads and writes, queries, counts, aggregations, and inverse collection reads. `DatabaseAdapter`, `Runtime`, controller, middleware, registration, and state-machine interfaces are exported in the TypeScript declarations. A runtime binds one adapter; create another runtime to use another database or configuration.

Generated and custom mutations run through `adapter.withTransaction`. Retried attempts receive fresh clones of GraphQL input objects, lists, and dates while enum values keep their identity. An adapter can define `stateValue` when its persisted enum representation differs from GraphQL enum names.

Importing the runtime installs Simfinity's `__Field.extensions` introspection field once per GraphQL module instance. Multiple runtimes and driver packages can be imported together without cloning schemas or duplicating introspection types.

## Shared metadata and helpers

`describeModels([{ gqltype, endpoint }])` discovers the persistent entity graph from `GraphQLObjectType` definitions and `extensions.relation`. Types registered with `endpoint: false` are still included when referenced. Reciprocal one-to-many definitions resolve to one child reference; explicit linking entities represent many-to-many relationships.

`createQueryPlan` and `resolveModelPath` turn Simfinity filter, sort, pagination, and aggregation inputs into a driver-neutral plan resolved against that metadata.

The package also exports the `auth`, `validators`, `scalars`, and `plugins` helper namespaces alongside `createValidatedScalar`, `SimfinityError`, `InternalServerError`, `buildErrorFormatter`, `QLOperator`, `QLSort`, and `QLValue`. Database packages reuse these exports so helpers, errors, and globally named GraphQL types retain one identity.
