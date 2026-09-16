# SQL core and database plugins

The approved design introduces `@simtlix/simfinity-sql`, with PostgreSQL as the first and only supported SQL plugin. The existing PostgreSQL facade and generated storage remain compatible. Selection is fixed per runtime; this is not runtime database switching.

## Boundaries

- Core keeps GraphQL lifecycle, query plans, model metadata, scopes, hooks and state machines.
- SQL owns logical relational planning (tables, columns, references, indexes, embedded ownership/presence and constraints), record normalization/reconstruction, model handles and transaction/session orchestration. It imports neither pg nor a concrete database plugin.
- PostgreSQL owns physical type mapping, statements/query compilation, functions/triggers, catalog validation, DDL initialization, connection operations, native codecs, retry classification and SQL generation.
- MCP remains optional and independent. MongoDB remains on its existing adapter.

## Public API and compatibility

`createSQL({ plugin: postgresPlugin({ pool, schema }) })` creates the new SQL runtime. `createPostgres({ pool, schema })` remains a convenience facade over the same implementation. The default PostgreSQL namespace configure/connect/createSchema API remains valid, including configure-once and initialize-before-use rules. Existing PostgreSQL model/session APIs, error codes, exports, descriptions and DDL are preserved.

`planRelationalSchema(models, { schema, naming })` is a pure exported planner receiving core ModelDescription. It returns serializable logical storage, without physical SQL types or SQL expressions. Naming delegates only engine limits/shortening to the plugin. Logical requirements are checked against plugin capabilities before physical compilation or I/O. Unsupported guarantees fail explicitly, never silently omit FKs or constraints.

## SQL plugin contract version 1

A plugin is a factory result, bound by createSQL into one runtime. It has:

- `apiVersion: 1`, `name`, `displayName`, `defaultSchema`, `options` (configuration or null), and `capabilities` (array of strings).
- `naming.validateIdentifier(value)` and `naming.generatedName(...parts)`.
- `describeSchema(logicalPlan)` returns physical metadata with tables/columns/ownership used by record reconstruction; `initialize(configuration, description, options)` performs schema initialization; `compileSchema(description)` returns statements.
- `compileQuery(models, description, queryPlan, extra)` returns `{text, values, aggregateFields?}`.
- `compileRecord(description, operation)` returns `{text, values}`. Operation is one of selectById `{kind, table, id, lock?}`, selectOwned `{kind, table, ids, ordered}`, insert `{kind, table, data}`, update `{kind, table, id, data}`, deleteById `{kind, table, id}`, deleteOwned `{kind, table, ownerId}`.
- `values.createId()`, `values.castId(value)`, `values.encodeScalar(field, value)`, `values.decodeScalar(field, value, gqlField)`, `values.encodeEmbedded(value)`.
- `driver.assertConfiguration(configuration)`, `driver.query(configuration, statement, client?)` returns `{rows}`, `driver.acquire(configuration)`, `driver.begin(client)`, `driver.commit(client)`, `driver.rollback(client)`, `driver.release(client)`, `driver.isRetryable(error)`, `driver.normalizeError(error)`.

Plugin structure is validated eagerly; required capabilities are validated after logical planning, before initialization. SQL snapshots plugin methods/options/capabilities to prevent reassignment from switching a configured runtime. PostgreSQL uses current pg Pool/query interface and REPEATABLE READ with at most five retries of confirmed aborts; unknown outcomes are not replayed. Caller-owned pools stay open.

Logical capability names: transactions (all runtimes); foreignKeys and deferredForeignKeys (references); embeddedValues (inline embedded data); ownedRecords (owned embedded storage); scalarLists (scalar list storage); uniqueValues (unique constraints, including indexes); nullableUnique (NULL-equal uniqueness). Presence and shape guarantees are mandatory semantics of the corresponding embedded/owned capabilities.

## Validation and release

Node >=18.18.0 library floor, Node 24 CI/development, GraphQL ^16.11.0, PostgreSQL >=15 remain. Exact internal versions stay aligned; the additive release is 3.3.0. New dependency chain PostgreSQL -> SQL -> core, plus PostgreSQL -> pg. Only PostgreSQL is advertised as a supported SQL plugin.

Existing DDL/descriptions are captured before extraction and compared afterwards, including embedded references, list uniqueness, nulls and quoted names. Real database differential tests and Barber exercise unchanged runtime semantics. A non-PostgreSQL recording plugin verifies actual delegation and rejection paths without pretending to support a second production database. Packed runtime and strict TypeScript consumers enforce boundaries and old/new entry points.

Publishing, merging and documentation deployment follow the user's standing authorization after verification. Original Barber demo on ports4300/4301 and its database are preserved; all data-changing checks use disposable databases/stacks.
