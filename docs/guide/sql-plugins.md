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
npm install @simtlix/simfinity-sql@3.3.0 \
  @simtlix/simfinity-postgres@3.3.0 graphql@^16.11.0 pg@^8.16.3
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

The plugin lowers that plan to its physical schema. The PostgreSQL lowering preserves the generated descriptions and DDL from 3.2.0, including private names and constraints. Upgrading an unchanged model from 3.2.0 to 3.3.0 does not require a generated-schema migration. Existing drift or a changed domain model still requires an explicit migration; initialization never silently alters incompatible storage.

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
| `describeSchema(logicalPlan)` | Lower logical storage into physical table/column/ownership metadata used by the record store |
| `compileSchema(description)` | Return physical DDL statements |
| `initialize(configuration, description, options)` | Create or validate storage, enforcing the initialization mode and detecting incompatible existing definitions |
| `compileQuery(models, description, queryPlan, extra)` | Return `{ text, values, aggregateFields? }`; aggregate decoding requires metadata for the group and each fact |
| `compileRecord(description, operation)` | Compile one record operation into `{ text, values }` |
| `values` | Create/cast IDs, encode/decode scalars, encode embedded values |
| `driver` | Validate configuration, execute statements, acquire/release connections, begin/commit/rollback transactions, classify retries and normalize errors |

`compileQuery` receives `SQLModelDescription`. State-machine fields can include `stateNames`, an array of `{ value, name }` entries mapping persisted enum values to GraphQL state names for aggregate output. `SQLFieldDescription` exposes this metadata to typed compilers and codecs.

`compileRecord` receives a physical table metadata object in `operation.table`. Supported operations are:

| `operation.kind` | Additional fields |
| --- | --- |
| `selectById` | `id`, optional `lock` |
| `selectOwned` | `ids`, `ordered` |
| `insert` | `data` |
| `update` | `id`, `data` |
| `deleteById` | `id` |
| `deleteOwned` | `ownerId` |

The driver provides `assertConfiguration(configuration)`, `query(configuration, statement, client?)`, `acquire(configuration)`, `begin(client)`, `commit(client)`, `rollback(client)`, `release(client)`, `isRetryable(error)` and `normalizeError(error)`. Queries resolve to `{ rows }`. The value hooks are `createId()`, `castId(value)`, `encodeScalar(field, value)`, `decodeScalar(field, value, gqlField)` and `encodeEmbedded(value)`.

SQL owns session validity and transaction orchestration; the plugin owns connection operations and error classification. PostgreSQL begins repeatable-read transactions and permits at most five retries of confirmed serialization/deadlock aborts. Unknown commit outcomes are not replayed. Supplied active sessions join the existing transaction; foreign and expired sessions are rejected.

### Capabilities and failure behavior

| Capability | Required when |
| --- | --- |
| `transactions` | Every SQL runtime |
| `foreignKeys`, `deferredForeignKeys` | The relational layout contains references or ownership FKs |
| `embeddedValues` | Inline embedded values need shape and presence guarantees |
| `ownedRecords` | Embedded data needs private owned storage |
| `scalarLists` | A scalar list is stored as a relational column |
| `uniqueValues`, `nullableUnique` | Generated uniqueness must preserve NULL-equal semantics |

Malformed plugins fail at runtime construction with `INVALID_SQL_PLUGIN`; unknown contract versions raise `UNSUPPORTED_SQL_PLUGIN_VERSION`. After logical planning, missing required guarantees raise `UNSUPPORTED_SQL_CAPABILITY` before physical schema compilation and initialization. Driver configuration validation must be synchronous and perform no database I/O.

The runtime snapshots contract members, option properties and capability arrays. Connection objects remain caller-owned references. Plugin authors should use explicit arguments or stable closures rather than replacing methods/configuration after construction.

## Implement another engine

Implement the contract and export a factory from a separate package depending on SQL/core plus that engine's driver. Reuse the relational plan and typed core query plans; implement the engine's complete storage lowering, query and record compiler, codecs, initialization and transaction guarantees. Reusing only PostgreSQL's parameter syntax is insufficient.

Run the shared query/lifecycle/relationship corpus against a disposable instance of the engine. Include raw-database tests proving FKs, required values, nullable lists, embedded ownership/presence, uniqueness, rollback and schema-drift detection. Verify packed installation and strict TypeScript consumers without PostgreSQL dependencies. The recording plugin in Simfinity's tests verifies delegation only; it is not another supported database adapter.
