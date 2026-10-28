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
npm install @simtlix/simfinity-sql@3.16.0 \
  @simtlix/simfinity-postgres@3.16.0 graphql@^16.11.0 pg@^8.16.3
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

Operations fail with `DATABASE_NOT_INITIALIZED` (503) until the first `initializeDatabase()` call succeeds. Before it calls the plugin, the runtime rejects modes other than `create` and `validate` with `INVALID_INITIALIZATION_MODE` (400). On a validation-only runtime (`preventCreatingCollection(true)`), a missing or false mode validates and every other mode except `validate` is rejected with `DATABASE_CREATION_DISABLED` (409) instead. A rejected request leaves readiness as it was. A ready runtime keeps serving while it is initialized again; any failure of the initialization started last makes storage unavailable until a later one succeeds. After `createSchema()`, `simfinity.compileDatabaseSchema()` returns the plugin's DDL for the runtime's schema, for review or export, without touching storage.

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

The plugin lowers that plan to its physical schema. The PostgreSQL lowering preserves the generated descriptions and DDL from 3.2.0, including private names and constraints, except that `[ID]` list columns no longer get a generated index since 3.5.6; databases that already have that index keep it and still validate. Upgrading an unchanged model from 3.2.0 to 3.3.0 does not require a generated-schema migration. Existing drift or a changed domain model still requires an explicit migration; initialization never silently alters incompatible storage.

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
| `queryFeatures` | Optional: `{ operators, referenceEmptiness?, quantifiers?, compileQuery? }`, the `QLOperator` values that `compileQuery` and `compileChildrenQuery` compile, whether they compile reference emptiness and quantified frames, and optionally the `compileQuery` the declaration describes. See [query features](#query-features) |
| `naming.validateIdentifier(value)`, `naming.generatedName(...parts)` | Enforce the engine's identifier rules and deterministic generated names |
| `describeSchema(logicalPlan, configuration)` | Lower logical storage into physical table/column/ownership metadata used by the record store. The bound configuration, or `null`, is the last argument; a plugin may ignore it |
| `compileSchema(description)` | Return physical DDL statements for review or export. The runtime calls it only from `runtime.compileDatabaseSchema()`; storage is created and validated through `initialize` |
| `initialize(configuration, description, options, context)` | Create or validate storage in the mode it receives, detecting incompatible existing definitions. The runtime rejects modes other than `create` and `validate` before calling it, and passes `validate` on a validation-only runtime. Match existing columns by name, and keep accepting indexes that earlier versions generated, such as the `[ID]` list index. Only when the runtime's types declare [virtual fields](/reference/extensions#virtual) does it pass a fourth argument, `context`, an `SQLInitializationContext` `{ virtualFields }`: one `SQLVirtualFieldLocation` `{ table, path, field, name }` per virtual field, where `table` is the table of the type that declares it, `path` the storage names of the embedded values between that table and the field, `field` the field as `Type.field` and `name` its name. Virtual fields have no storage and the description holds none of them; a plugin may use the locations to name, in a schema mismatch, a field whose storage from before it became virtual is still in the database, as the PostgreSQL plugin does, or ignore them. Otherwise the call keeps its three arguments |
| `compileQuery(models, description, queryPlan, extra, configuration)` | Return `{ text, values, aggregateFields? }`; aggregate decoding requires metadata for the group and each fact. The bound configuration, or `null`, is the last argument |
| `compileChildrenQuery(models, description, queryPlan, { column, ids }, configuration)` | Optional, used only with `batchedCollections: true`: one statement whose rows, for each parent in `ids`, are exactly the rows `compileQuery` returns for `{ column, id }`, in the same order, each tagged with its parent's 1-based position in `ids` in the column the returned `parentColumn` names, and optional `setup` statements to run before it in its transaction; `setup` may be `null` or absent. See [batched collection reads](#batched-collection-reads) |
| `compileRecord(description, operation)` | Compile one record operation into `{ text, values }` |
| `compileRecordBatch(description, operation)`, `maxRecordBatchValues` | Optional, together: compile `{ kind: 'insertMany', table, rows }` into one statement that inserts every row, and bound the values (rows times columns) of such a statement with a positive safe integer |
| `values` | Create/cast IDs, encode/decode scalars, encode embedded values |
| `driver` | Validate configuration, execute statements, acquire/release connections, begin/commit/rollback transactions, classify retries and normalize errors |

`compileQuery` receives `SQLModelDescription`. State-machine fields can include `stateNames`, an array of `{ value, name }` entries mapping persisted enum values to GraphQL state names for aggregate output. SQL runtimes require state-machine `state` fields to be GraphQL enums and reject any other with `INVALID_MODEL` (400) at `createSchema()`, so every state field has `stateNames`. `SQLFieldDescription` exposes this metadata to typed compilers and codecs. Compiled SQL must not depend on the physical column order of a table, for example through `SELECT *` in a `UNION`: a migration that appends columns changes it.

`compileRecord` receives a physical table metadata object in `operation.table`. Supported operations are listed below; the union, `SQLRecordOperation`, does not include batches, so exhaustive switches keep compiling:

| `operation.kind` | Additional fields |
| --- | --- |
| `selectById` | `id`, optional `lock` |
| `selectOwned` | `ids`, `ordered` |
| `insert` | `data` |
| `update` | `id`, `data`; optional `version: { column, expected }` |
| `deleteById` | `id`; optional `version: { column, expected }` |
| `deleteOwned` | `ownerId` |

With both `compileRecordBatch` and `maxRecordBatchValues`, the record store inserts the owned rows of a write in runs: consecutive rows of one table with the same columns in the same order, split so that rows times columns stay within the limit, and ended before a row of another table, before owned rows are deleted and before a validation error is thrown, so the rows reach the database in the per-row order. The operation, typed `SQLInsertManyOperation`, is `{ kind: 'insertMany', table, rows }`; no result rows are needed. A single row goes through `compileRecord` as an `insert`, and the configuration `multiRowInserts: false` keeps one `insert` per row. PostgreSQL sets the limit to 32,767 values. `bindPlugin` rejects a `compileRecordBatch` that is not a function, or a `maxRecordBatchValues` that is not a positive safe integer, `null` included, with `INVALID_SQL_PLUGIN`. A copy of a plugin that overrides `compileRecord` for `insert`, such as `{ ...postgresPlugin(options), compileRecord }`, inherits `compileRecordBatch` and `maxRecordBatchValues`, so owned rows inserted in runs of two or more do not reach the override: also override `compileRecordBatch`, set both members to `undefined`, or set `multiRowInserts: false`.

The driver provides `assertConfiguration(configuration)`, `query(configuration, statement, client?)`, `acquire(configuration)`, `begin(client)`, `commit(client)`, `rollback(client)`, `release(client, error?)`, `isRetryable(error)` and `normalizeError(error)`. Queries resolve to `{ rows }`. `client` is the connection of a transaction or of a single-statement read; counts and aggregates omit it. `release` receives the rollback failure when ROLLBACK did not complete, whether after a failed transaction or as the probe after a failed single-statement read; discard that connection instead of returning it to a pool. The value hooks are `createId()`, `castId(value)`, `encodeScalar(field, value)`, `decodeScalar(field, value, gqlField)` and `encodeEmbedded(value)`. `createId()` and `castId()` may produce any identifier, including `0`; generated references to it resolve like any other ID, and only a stored `null`, missing value or empty string reads as no reference. For a malformed value, `castId()` should throw a `SimfinityError` with code `NOT_VALID_ID` and status 400, as the PostgreSQL plugin does; it must not create a new identifier.

`commit(client)` must reject when the engine did not commit, for example when it rolled the transaction back because a statement had failed; PostgreSQL resolves such a `COMMIT` without an error, so its plugin rejects when the result reports the `ROLLBACK` command. A rejected commit is retried, like any other confirmed abort, only when `isRetryable()` accepts its error: reject with an error that it does not accept when a failed statement caused the rollback, and with a retryable one only for an abort that is safe to replay, such as a serialization failure reported at `COMMIT`. `isRetryable(error)` and `normalizeError(error)` receive any object thrown in an owned transaction or operation, application errors included, but never `null` or another value that is not an object; `normalizeError` never receives a `SimfinityError`. `normalizeError` must map its own engine's errors and return every other error unchanged, so application errors propagate as thrown. When it returns a failed `acquire`, `begin`, `query` or `commit` call's error unchanged, the runtime masks it as `DATABASE_ERROR` (500), with the original as its non-enumerable `cause` and `getCause()`; return a new object or a `SimfinityError` to keep your own mapping. Statement errors that `session.query()` returns inside a callback are the driver's own, so a savepoint can recover from them.

SQL owns session validity and transaction orchestration; the plugin owns connection operations and error classification. PostgreSQL begins repeatable-read transactions and permits at most five retries of confirmed serialization/deadlock aborts. SQL retries an owned transaction only for errors that `isRetryable()` accepts, and waits a random delay of less than 10, 20, 40, 80 and 160 ms before each retry, once the failed attempt has rolled back and `release()` has completed, so conflicting transactions do not retry in lock-step. Unknown commit outcomes and attempts whose rollback failed are not replayed. Supplied active sessions join the existing transaction; foreign and expired sessions are rejected. A session expires as soon as its callback settles, before COMMIT or ROLLBACK is sent, so un-awaited session work fails with `INVALID_SESSION` instead of running outside the transaction.

When the plugin advertises `singleStatementReads`, as PostgreSQL does, a read without a session and without a lock that one statement answers, of a type without owned tables, runs on one acquired connection: `acquire`, `query` and `release`, without `begin` or `commit`. SQL retries it, with the same delays and limit, for an error that `isRetryable()` accepts, without a rollback step. After any other failed driver call, SQL calls `rollback(client)` on that connection, outside a transaction, to probe it, as after a failed statement in a transaction, and passes a probe failure to `release(client, error)`, so the driver discards the connection instead of returning it to a pool. The read's own error is reported, normalized the same way; the connection is never accepted as a session. Reads that hydrate owned rows keep one transaction. To keep a transaction around every PostgreSQL read, for example in a wrapper whose `begin()` sets per-transaction settings, pass a copy of the plugin without the capability:

```javascript
const plugin = postgresPlugin({ pool, schema: 'library' });
const simfinity = createSQL({
  plugin: { ...plugin, capabilities: plugin.capabilities.filter((name) => name !== 'singleStatementReads') },
});
```

### Query features

`queryFeatures.operators` lists the filter operators the plugin's compilers support, including `EQ`, which a condition without an operator means. Names Simfinity does not know are ignored until a version that knows them, so a declaration that listed `CONTAINS_ALL` or `IIN` before they existed passes them to `compileQuery` on upgrade: list only the operators that the compilers compile. The SQL runtime declares the list as its adapter's `queryFeatures` and passes it to `createQueryPlan` as `operators`, so the runtime, before middleware runs and again before it calls the adapter, and the plans of reads that do not go through it, such as `getModel(Type).find()`, reject any other operator with `UNSUPPORTED_QUERY` (400) before `compileQuery` sees it. A plugin without `queryFeatures`, or with `null`, compiles the operators of 3.7.0: `EQ`, `NE`, `LT`, `LTE`, `GT`, `GTE`, `BTW`, `IN`, `NIN` and `LIKE`. `bindPlugin` rejects a `queryFeatures` that is not an object whose `operators` is an array of strings with `INVALID_SQL_PLUGIN` (400), and binds a frozen copy.

Like `compileChildrenQuery`, a declaration may name, as its `compileQuery`, the `compileQuery` it describes. It then holds only while that is the plugin's own `compileQuery`; otherwise the plugin compiles the operators of 3.7.0. A declaration without `compileQuery` describes whichever `compileQuery` the plugin has, so a copy of such a plugin that replaces its compiler inherits it. `bindPlugin` rejects a `queryFeatures.compileQuery` that is present and not a function with `INVALID_SQL_PLUGIN` (400).

`queryFeatures.referenceEmptiness`, a boolean, declares that the compilers also answer [emptiness through references and collections](./queries#references-and-collections). `bindPlugin` binds it with `operators`, under the same rule: a plugin without a declaration, or whose declaration names another function than its `compileQuery`, gets `false`. `bindPlugin` rejects a `referenceEmptiness` that is not a boolean, `undefined` or `null` with `INVALID_SQL_PLUGIN` (400), as it does a malformed `operators`, also when the declaration names another `compileQuery`; 3.10.0 ignored this member. The SQL adapter declares the bound value as its own `queryFeatures.referenceEmptiness` and passes it to `createQueryPlan` with `operators`, so without it the runtime, and the plans of reads that do not go through it, reject an emptiness condition that crosses or ends at a reference or ends at a collection, or reads a reference or collection member, with `UNSUPPORTED_QUERY` (400) before `compileQuery` sees it.

`postgresPlugin()` declares every operator, the [text operators](./queries#text-operators), the [list operators](./queries#filters-on-lists) and the [emptiness operators](./queries#empty-values) included, declares `referenceEmptiness: true`, and names its own `compileQuery`. So a copy that replaces the compiler, such as `{ ...postgresPlugin(options), compileQuery: myCompileQuery }`, keeps the operators of 3.7.0 without reference emptiness, and a request that uses another operator, or emptiness through a reference or a collection, fails with `UNSUPPORTED_QUERY` (400) before `myCompileQuery` runs. To let it compile more, declare what it supports: `queryFeatures: { operators: [...], referenceEmptiness: true, compileQuery: myCompileQuery }`.

A plan's text predicates carry values that core has validated: a string without U+0000 on a `String` field or list. A plugin that declares `IIN` receives `{ kind: 'predicate', path, operator: 'IIN', value }` with an array of such strings, possibly empty, neither folded nor deduplicated, on a `String` field or list; it must apply the case-folding contract of the text operators to each value, matching where `IEQ` would match one of them, and match no row for `[]`. A plugin that declares `CONTAINS_ALL` receives `{ kind: 'predicate', path, operator: 'CONTAINS_ALL', value }` with the non-empty array of non-null scalars that core validated, neither cast nor deduplicated, on a path that ends at a scalar list or at a scalar read through embedded lists and crosses no collection and no reference after an embedded list; it must cast each element as for `IN` and match the rows whose values at the path, the values of every item of embedded lists included, hold every element, and it must stay two-valued under an `ALL` body, where a `NULL` list does not hold the values. Both carry `joins` only inside frames, and a copy of `postgresPlugin()` that replaces `compileQuery` keeps the operators of 3.7.0 and rejects both. The bundled compiler validates hand-built plans again, fails closed before any join for a hand-built `CONTAINS_ALL` path, leaf or value with core's codes, and rejects an operator it does not compile with `UNSUPPORTED_QUERY`.

A plugin that declares `IS_EMPTY` and `IS_NOT_EMPTY` receives each emptiness condition as `{ kind: 'predicate', path, operator, value: null }`, whose `path` may end at a scalar, a scalar list, an embedded list or an embedded object, for the forms with and without a path alike. Core has already checked it: nothing follows an embedded list or a collection, and an embedded object's members hold no cycle, interface or union. Without `referenceEmptiness`, the path also names only the record's own stored fields and crosses no reference or collection, and the members hold no reference or collection. The plugin must compile the [emptiness rules](./queries#empty-values): an embedded object is empty when it is missing, `null` or every stored member is empty by its own rule, and `IS_NOT_EMPTY`, which has no negation node, is the exact complement, so every row matches one of the two. The bundled compiler does this without bound parameters for the record's own fields; see [compiled forms](./queries#compiled-forms-and-indexes). A plugin that does not declare them keeps rejecting them with `UNSUPPORTED_QUERY` before `compileQuery` runs, and declaring them does not lift the rejection of emptiness through references and collections; `referenceEmptiness` does.

A plugin that also declares `referenceEmptiness: true` receives emptiness predicates whose `path` may cross single references and end at a reference or a collection, and whose embedded objects may have reference and collection members; emptiness keeps its predicate node. Collection frames add the `quantified` node described below. A predicate from a client's condition carries `scopes`, an object with one key per dotted path relative to the containing frame: each reference that the path crosses, the reference or collection that it ends at, and each reference or collection member that it reads. Each value is the target type's `find` scope as a `QueryPredicate` on the target type, or `null` when the scope added nothing; `createQueryPlan()` fails with `DETACHED_CLIENT_FILTER` (500) rather than leave a key out. The compiler must read a crossed reference through a join that admits the target only where its scope admits it, at most one row, and a reference or collection that the condition ends at or reads as a member as the set of records that its scope admits, before the emptiness test and never negated, so a hidden record reads as a missing one. While every value on the path so far is `null`, the predicate may compile exactly as a trusted one and share its plain joins; a hop after a scoped crossing stays correlated through that join, even when its own value is `null`. A predicate without `scopes` reads stored data, as server/direct conditions and unmarked client conditions on unscoped chains do: a reference is empty when no stored reference resolves to an existing record, a collection when no stored child references the record, and fields through references are read through plain joins. Each scope predicate is trusted, so it carries no `scopes` of its own. The bundled compiler crosses references through the plain `LEFT JOIN` of other paths until the first value that is not `null`, and from there on through `LEFT JOIN LATERAL (… LIMIT 1)` scoped joins, writes `NOT EXISTS` frames with fresh aliases, binds the scope values as parameters, and compiles a reference end or member whose value is `null`, like a trusted reference, as `"r" IS NULL`; see [compiled forms](./queries#compiled-forms-and-indexes).

`queryFeatures.quantifiers: true` declares collection/reference frames and requires `referenceEmptiness: true`. `bindPlugin` validates both as boolean, undefined or null, rejecting a malformed flag or `quantifiers: true` without reference emptiness with `INVALID_SQL_PLUGIN` (400), even when the declaration names a different compiler. It binds the flag only under the same `compileQuery` identity rule as `operators`. The SQL adapter passes the bound value to `createQueryPlan`. A plugin without it receives no `quantified` node, `joins` or `anchor`; explicit quantified forms, including raw target-scope inputs, fail with `UNSUPPORTED_QUERY`. Collection shorthand keeps legacy joins, while sorts through collections fail for every plugin.

A declaring compiler receives `{ kind: 'quantified', quantifier, path, where, scope, joins?, anchor? }`. `path` resolves from the containing frame (from `anchor` when present); `where` and `scope` use element-relative paths and null means no restriction. Apply `scope` to the element set before `ANY`, `ALL` or `NONE`; never negate it. `ANY` is existence of a matching element, `NONE` absence of one, and `ALL` absence of a violating element; use two-valued violation logic such as `(G) IS NOT TRUE` for nulls. An empty element set gives false/true/true. Frames must preserve root cardinality.

`joins` on a quantified node or ordinary predicate maps single-reference prefixes, relative to the containing frame, to target-scope predicates or null. Apply each at its crossing, keep a hop after a scoped crossing correlated, and share only within the same full frame/scope context. `anchor` names an aggregate legacy join chain; its node's `path` is relative to that chain. Literal-only anchors retain legacy joined scopes with no `joins`; comparison bodies can additionally guard scoped anchor references without changing the J aliases, as described below. Fail closed with `DETACHED_CLIENT_FILTER` (500) on a scope or join key the compiler cannot honour, just as for incomplete emptiness `scopes`; never silently discard `scope`, `joins` or `anchor`. Internal input keys `__scope`, `__implicit` and `__anchor` belong to core's rewrite.

`postgresPlugin()` declares `quantifiers: true` with reference emptiness and every operator. `createQueryPlan()` without operator options enables both features by default and emits frames for collection filters; supplying `operators` makes each omitted capability false. A compiler replacement must redeclare only the capabilities it implements. This supersedes the historical 3.11.0 “no new node kind” description.

`createQueryPlan()` and SQL native reads such as `getModel(Type).find(args)` accept top-level dotted scalar-filter keys, for example `{ 'reviews.rating': { operator: 'GTE', value: 4 } }`. With `quantifiers` enabled, each entry crossing a collection outside aggregate J rewrites as its own implicit `ANY` group, with nested frames as needed. Distinct entries can match different children; use one `conditions` list or relation `terms` set when several predicates must hold for the same child. The actual scalar carrier's operator and value are used, including default `EQ`; ignored scalar `terms` do not become predicates. Reference-only paths, paths wholly in J and reads without `quantifiers` keep their prior behaviour; a later collection crossing beyond a J prefix uses the existing joined anchor. These dotted keys belong to direct planner and SQL native argument objects; GraphQL callers continue to express paths with generated relation filters or group conditions.

A plugin opts into [field comparisons](./queries#compare-stored-fields) with `queryFeatures.valuePath: true`, requiring `referenceEmptiness: true`; only literal `true` enables it. Null/undefined/false means unsupported, and invalid types/dependencies give `INVALID_SQL_PLUGIN` (400). The flag follows `compileQuery` identity binding; overriding PostgreSQL's compiler loses inherited support until the wrapper truthfully redeclares it. It does not require quantifiers for scalar/reference reads, but collection shorthand does.

An ordinary comparison predicate is `{ kind: 'predicate', path, operator, value: null, operand: { up, path, joins? }, joins? }`. The public `QueryOperand` uses path arrays: `up: 0` is the same frame, while positive `up` is an internal shorthand binding to that ancestor frame. At zero, the predicate's `joins` is the union for both paths and `operand.joins` is absent. At positive depth, each joins map belongs to its own frame. Preserve origin, scope chains, null/list/type rules, aggregate J aliases and cardinality; no right operand may add a collection witness. Anchored shorthand frames containing comparisons can carry `joins` for reference prefixes of the full anchor: guard visibility without replacing the existing J row. An outer operand may read only the J collections that its anchor already bound.

The bundled compiler checks hand-built operands before SQL generation: shape and available depth, scalar endpoints, types/operators, bound embedded-list contexts, structural containment and complete scope metadata. Physical identifiers come from descriptions and scope values stay bound. Portable descriptions preserve additive logical `enumName` and effective `temporalName` fields; missing information gives `UNSUPPORTED_QUERY`. PostgreSQL uses UUID identities, `IS [NOT] DISTINCT FROM` scalar equality, null-safe array membership, C-collated strings and normalized native/jsonb temporal instants. Batched UNION branches preserve the same aliases and results as individual child reads.

### Batched collection reads

Batched collection reads are opt-in. Only with `batchedCollections: true` in the configuration and a `compileChildrenQuery` does the SQL adapter define `findChildrenBatch` and read generated collection fields in [batches](./relationships#batched-collection-reads); otherwise it keeps one `compileQuery` statement per field, as 3.6.0 did. It calls the compiler with paginated find plans only, 1 to 100 distinct cast parent IDs and the bound configuration, runs the statements one after another, and hydrates every child once. PostgreSQL's compiler returns a `UNION ALL` with one branch per parent: the `compileQuery` statement for that parent, with the parent ID as a parameter of its own and the other parameters, such as filter values and the page, shared, so its values are those of `compileQuery` without the parent ID, then one ID per parent. Each branch tags its rows with the parent's position and their row number, and an outer `ORDER BY` on both keeps each parent's rows together and in its statement's order; the adapter itself needs only `parentColumn` and each parent's rows in that order, and accepts rows of different parents interleaved. PostgreSQL plans an unnamed statement with its parameter values, so it plans each branch for its own parent ID. A compiler that binds every parent through one array parameter, such as a `LATERAL` join over `unnest`, is planned once for all parents from average statistics, and when a few parents hold most rows it can scan the table once per parent. A row whose position is outside `ids` fails the batch with `DATABASE_ERROR` (500), and the fields are then read per parent.

The returned `SQLChildrenStatement` may carry `setup`, a list of statements (`{ text, values? }`) for settings that must hold while it runs, typed `readonly SQLStatement[] | null`. The adapter runs them, in order, on the same connection right before the statement, ignoring their rows. The runtime passes at most 100 parents per call, so each batch has one statement; only a direct `findChildrenBatch` call with more than 100 IDs runs further statements of 100 parents, in the same transaction, each after its own setup. When any statement of a batch has setup, the whole batch, owned-row hydration included, runs in one transaction from the driver's `begin` to its `commit`, even for a type without owned tables, and is retried like other owned transactions; without setup, the batch runs on the connection or transaction `findChildren` would use. Use transaction-scoped settings, such as PostgreSQL's `SET LOCAL`, so that the connection goes back to the pool unchanged. PostgreSQL returns `setup: [{ text: 'SET LOCAL jit = off', values: [] }]`, because a plan of up to 100 branches costs about as much as their statements together and can cross `jit_above_cost` when none of them does. A `setup` that is `null`, `undefined` or absent means no setup; any other value that is not a list of objects with a string `text` fails the batch with a `TypeError` before a connection is taken, which the runtime reports once per type before reading each parent with `compileQuery`.

The compiler must name, as its `compileQuery` property, the `compileQuery` whose rows it reproduces, and the runtime binds it only when that is the plugin's own `compileQuery`; otherwise each parent is read with `compileQuery`. So a copy such as `{ ...postgresPlugin(options), compileQuery: myCompileQuery }` reads each parent with `myCompileQuery`, and its filters apply to every parent. Such a copy keeps batching only with a `compileChildrenQuery` of its own that names `myCompileQuery` and returns, for each parent, exactly the rows `myCompileQuery` returns; the bundled compiler wraps the bundled `compileQuery`, not yours.

`bindPlugin` rejects a `compileChildrenQuery` that is not a function with `INVALID_SQL_PLUGIN` (400). The statement type is `SQLChildrenStatement`, with the optional `setup?: readonly SQLStatement[]`, and the compiler type `SQLChildrenQueryCompiler`.

### Capabilities and failure behavior

| Capability | Required when |
| --- | --- |
| `transactions` | Every SQL runtime |
| `foreignKeys`, `deferredForeignKeys` | The relational layout contains references or ownership FKs |
| `embeddedValues` | Inline embedded values need shape and presence guarantees |
| `ownedRecords` | Embedded data needs private owned storage |
| `scalarLists` | A scalar list is stored as a relational column |
| `uniqueValues`, `nullableUnique` | Generated uniqueness must preserve NULL-equal semantics |
| `singleStatementReads` | Never required. Advertise it only when one statement reads one consistent snapshot without a transaction, and `rollback(client)` resolves on a usable connection that has no open transaction and rejects on an unusable one; sessionless reads then skip `begin` and `commit`, as described above |

Malformed plugins fail at runtime construction with `INVALID_SQL_PLUGIN`; unknown contract versions raise `UNSUPPORTED_SQL_PLUGIN_VERSION`. After logical planning, missing required guarantees raise `UNSUPPORTED_SQL_CAPABILITY` before physical schema compilation and initialization. Driver configuration validation must be synchronous and perform no database I/O.

The runtime snapshots contract members, option properties and capability arrays. Connection objects remain caller-owned references. Plugin authors should use explicit arguments or stable closures rather than replacing methods/configuration after construction.

## Implement another engine

Implement the contract and export a factory from a separate package depending on SQL/core plus that engine's driver. Reuse the relational plan and typed core query plans; implement the engine's complete storage lowering, query and record compiler, codecs, initialization and transaction guarantees. Reusing only PostgreSQL's parameter syntax is insufficient.

Run the shared query/lifecycle/relationship corpus against a disposable instance of the engine. Include raw-database tests proving FKs, required values, nullable lists, embedded ownership/presence, uniqueness, rollback and schema-drift detection. Verify packed installation and strict TypeScript consumers without PostgreSQL dependencies. The recording plugin in Simfinity's tests verifies delegation only; it is not another supported database adapter.

## Optimistic concurrency

A plugin must declare the `optimisticConcurrency` capability when a protected type adds the logical `Version` column and requirement; otherwise preparation fails with `UNSUPPORTED_SQL_CAPABILITY`. Encode safe integer versions from 1 to `9007199254740991` and decode valid `Version` values to JavaScript numbers. PostgreSQL stores them as `bigint NOT NULL DEFAULT 1`. Its decoder also accepts a custom bigint parser; malformed/unsafe values remain invalid for core's managed reader.

`compileRecord(description, operation)` receives optional `operation.version: { column: string, expected: number }` on `update` and `deleteById`. A versioned update must atomically match ID and version, increment the version and return the updated row. Its `data` may be empty: still issue an update containing the increment. A versioned delete must atomically match both and return a deleted row, since the driver's portable result is `{ rows }`. For example, PostgreSQL compiles `UPDATE ... SET ..., "version" = "version" + 1 WHERE id = $1::uuid AND "version" = $k::bigint RETURNING *` and `DELETE ... WHERE id = $1::uuid AND "version" = $2::bigint RETURNING id`. Operations without `version` keep their existing contract.

A spread copy of `postgresPlugin()` retains this capability when it overrides `compileRecord`; the override must honor `operation.version` or delegate versioned `update`/`deleteById` to the original. SQL checks returned updates for `expected + 1` and checks that a versioned delete returned a row after its locked read, raising `DATABASE_ERROR` on inconsistent results. These are defensive diagnostics, not proof an arbitrary compiler honored the predicate. Core adds its own observed-advancement check for lifecycle writes; native model handles have no extra pre-read merely to reproduce it. See [optimistic concurrency](./concurrency).

### Embedded element frames (3.18.0)

`queryFeatures.elementFrames: true` requires `quantifiers`, `referenceEmptiness` and `valuePath` all true. The flag follows the exact `compileQuery` identity, including child batches. Core rejects a valid new form with `UNSUPPORTED_QUERY` if the compiler does not declare it; malformed declarations fail with `INVALID_SQL_PLUGIN`.

A quantified node may end at an embedded list. Its body uses the list's local field descriptions, not a registered entity model. A structural operand adds `container: { up, path }` to `QueryOperand`, keeping the outer `up: 0`. `container.up` counts bound frame ancestors; `container.path` reaches the containing single object within that frame; operand `path` is relative to that object. For `ANY shipping.lines`, `$parent.limit` is `{ up: 0, path: ['limit'], container: { up: 1, path: ['shipping'] } }`. Its `operand.joins` belongs to that container, separately from local predicate joins. The compiler must prove containment, preserve scoped crossings to the container, and reject arbitrary outer bindings. Existing operands and the meaning of their `up` remain unchanged.

Only non-null object elements participate. Use absence of a complete-body counterexample for `ALL`, with null-safe predicates. Preserve the selected outer element through nested frames, including repeated equal objects and elements without IDs. The bundled compiler uses guarded `jsonb_array_elements` or existing owned rows with owner/state/item-presence checks, without new DDL. `compileChildrenQuery` retains the transaction and `SET LOCAL jit = off` contract. See [the public semantics](./queries#embedded-object-lists-and-parent).
