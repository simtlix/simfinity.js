---
title: Database compatibility contract
description: Shared API semantics and explicit storage differences between the MongoDB and PostgreSQL adapters in Simfinity 3.5.4.
---

# Database compatibility contract

This ledger records the v3.5.4 behavior shared by the MongoDB and PostgreSQL implementations and the remaining differences. The MongoDB contract is in `tests/integration/mongodb.test.js`, PostgreSQL execution in the runtime/lifecycle/options suites, and direct result/schema comparison in the query-parity suites, using the graph in `tests/contracts/model-fixtures.js`.

The test paths below are available in the [v3.5.4 source](https://github.com/simtlix/simfinity.js/tree/v3.5.4). To try the API, use the [released starters](guide/databases.md#download-the-starters).

When running the source tests, set `SIMFINITY_MONGODB_URI` and `SIMFINITY_POSTGRES_URI` to disposable databases for the cross-backend suites. Set `SIMFINITY_TEST_MONGODB_URI` to a separate disposable MongoDB database for upstream opt-in regressions. Mongo setup drops its configured databases, so these URIs must never identify application data. When a variable is absent, its integration suites are reported as skipped.

## MongoDB contract

| Behavior | Decision | Executable evidence |
| --- | --- | --- |
| A non-embedded relation with no `connectionField` stores its ObjectId under the GraphQL field name. | Fixed and shared | Unit regression plus real `ContractSerie.label` create/read/clear flow. |
| Clearing a nullable singular reference unsets its storage field (`connectionField` when declared, otherwise the GraphQL field). Clearing an inverse collection does not unset the child connectionField on the parent. | Fixed and shared | Unit regression and real update followed by a raw MongoDB record check. |
| An explicit `null` for a nullable member of a singular embedded patch clears it: a list member becomes `[]`, other members are stored as `null` (a reference under its storage field), and a non-null member keeps its stored value. Every GraphQL read path returns the cleared value; a top-level `null` still removes the field. | Fixed and shared (3.5.4) | Memory regressions in `tests/embedded-update-required.test.js`; `tests/integration/embedded-update-required-parity.test.js` compares update responses, by-ID and list reads, plus raw MongoDB documents, in default and transactional MongoDB modes and on PostgreSQL. |
| A scalar-only no-endpoint type receives a model when another registered type references it. It still receives no root endpoint. | Fixed and shared | Unit regression and the real `ContractLabel` reference fixture. |
| Every entity type, registered with `connect()` or targeted by a non-embedded relation, resolves `id` to its stored identity whatever the query and mutation allowlists include. Embedded-only types return their declared `id`. Embedded copies of entity types return their declared `id` (`null` for copies created through add inputs, the supplied `id` for copies written through update inputs, `saveObject()` or native writes), except that on MongoDB copies in an embedded list report the automatic subdocument `_id`. | Fixed (3.5.4); embedded list copies of entity types differ by backend | `tests/integration/id-resolver-parity.test.js` on both backends and `entity id resolution` in `tests/runtime.test.js`. |
| `onUpdated` receives the resolved updated record after the database operation completes. | Fixed and shared | Unit regression and live hook assertions. |
| Multiple flat terms on one relation are all present in the generated match. | Fixed and shared | Unit regressions for `author.name` plus `author.id`, and two predicates on the same `author.name` path. |
| Filters, sorts, `groupId` and fact paths on `<embedded>.id` use the declared `id` member, the value that reads return. On MongoDB, entity types embedded as lists use the automatic subdocument `_id`, which their reads also return. Supplied subdocument schemas without an `id` path keep using the subdocument `_id`, which only hydrated reads expose, through Mongoose's `id` virtual; list queries return `null` for that `id`. | Fixed and shared (3.5.4); MongoDB exceptions as noted | `tests/integration/embedded-query-parity.test.js` filters, sorts and groups by every displayed embedded ID on both backends; generated, supplied and schema-less paths in `tests/mongodb-query-paths.test.js`. |
| Root reads and generated non-embedded relationships run target middleware and scopes. Relationship IDs and parent predicates cannot be redirected by mutable arguments. | v3.1.0 shared | Upstream authorization integration tests and cross-backend `runtime-v31.test.js`. |
| A one-to-many filter uses `$lookup` plus `$unwind`; a root with two matching children appears twice. Count uses the same multiplicity. | Preserve current cardinality | Live collection-filter result contains the same root twice and sets `context.count` to `2`. |
| Generated mutations own a transaction and pass its native session plus the GraphQL context to validation and controller hooks. A nested failure rolls back the parent write. | Preserve | Live nested validation failure leaves neither parent nor child records; hook assertions observe an active session and the original context. |
| `saveObject(typeName, args, session, context)` owns the entire workflow transaction without a supplied session. Active supplied sessions remain caller-owned. | v3.1.0 shared | Standalone nested middleware/hook/FK failure rolls back parent, child and embedded writes. |
| Accepted empty strings, `false`, `0` and empty arrays survive materialization. Nullable embedded list items retain null; null referenced-operation items are skipped. | v3.1.0 shared | Upstream materialization regressions and live standalone save/update checks on both backends. |
| A malformed record, reference, scalar `ID` or embedded `id` value fails with `NOT_VALID_ID` (400) before anything is written; supplied models' `_id` setters still apply. A well-formed ID of a missing record keeps `null` from by-ID reads and `NOT_VALID_ID` (404) from writes. ID filters and scoped by-ID reads keep `INVALID_FILTER_VALUE`. A stored reference value that the adapter rejects is a data error: its field fails with `INTERNAL_SERVER_ERROR`. | Fixed and shared (3.5.4); MongoDB filters keep their own code | `malformed identifiers` and supplied keys with setters in `tests/integration/mongodb.test.js`, `tests/mongodb-ids.test.js`, and supplied-session aborts in `tests/integration/mongodb-integrity.test.js`. Stored references in `tests/runtime.test.js` and `tests/integration/id-resolver-parity.test.js`. PostgreSQL already returned `NOT_VALID_ID`. |
| Fields named `aggregation` or `conditions` are ordinary top-level filters on list, count and collection queries and in scopes; `aggregation` is the aggregation expression only on aggregate queries. | Fixed and shared (3.5.4) | `tests/integration/query-parity.test.js` and `tests/integration/query-path-authorization.test.js` on both backends. |
| `GraphQLNonNull` controls GraphQL inputs but does not automatically add a Mongoose `required` validator. | Preserve for MongoDB | PostgreSQL schema metadata may use the declaration for `NOT NULL`; this is a documented storage-level difference. |
| Lists preserve outer and item nullability (`[T]`, `[T!]`, `[T]!`, `[T!]!`). Update fields allow omission while retaining item wrappers. | Fixed and shared | Runtime input/schema regressions; real scalar/date/embedded list operations. |
| Inverse relations may use a scalar ID or an alias for the child's reference storage field. | Fixed and shared | Explicit connection-field normalization and real nested create/read/update regressions. |
| A referenced collection whose private `connectionField` equals the `connectionField` of a collection on the child type, including a self-referencing collection, gives the generated child model its own private ObjectId field, so nested writes store the link. | Fixed and shared (3.5.4) | Model-path regressions in both modes (`tests/mongodb-regressions.test.js`), nested create/read with raw link checks on both backends (`tests/integration/relationship-aliases.test.js`) and transactional initialization (`tests/integration/mongodb-integrity.test.js`). |
| A referenced collection requires a non-empty `connectionField`. A writable one whose resolver Simfinity generates is rejected at startup with `INVALID_MODEL` (400) in every mode, as PostgreSQL does. In default mode, one with its own resolver or marked `readOnly` builds with a warning, and its nested writes fail with `INVALID_MODEL` (500). | Fixed (3.5.4); the exemption is default-MongoDB-only | `referenced collection connectionField` in `tests/runtime.test.js` and the startup cases in `tests/mongodb-regressions.test.js`. |
| Aggregation through inverse collections uses the child FK and counts contributing rows. | Fixed and shared | Live cross-database SUM/COUNT and scalar Boolean MIN/MAX comparison. |
| Embedded lists can be restored after being cleared. Object patches stay shallow, list patches replace the list. | Fixed and shared | Runtime regression and real owned-reference-list clear/restore flow. |
| Retried generated/custom mutations start with fresh typed input structures; middleware executes once. | Fixed and shared | Synthetic retry tests retain enum identity and reset nested lists/objects/Dates; real PostgreSQL aborted-attempt rollback. |
| State storage/guards use a single adapter-specific representation. | Shared orchestration | Mongo preserves state names; PostgreSQL stores/decodes enum internal values. Real tests cover overlapping names/values and concurrent transitions. |
| The facade leaves global Mongoose options, including `strictQuery`, as the application sets them; generated queries do not depend on them. | Fixed (3.5.4) | `tests/mongodb-global-options.test.js` checks fresh processes; the MongoDB contract suite runs under `strictQuery: 'throw'`. |

## PostgreSQL execution contract and limits

The query parity corpus compares actual schemas and responses for operators, nested logical filters, dates, enums, scalar arrays, nullable values, array sorts, embedded paths, scopes, joined row multiplicity, pagination/counts and aggregate facts. Typed invalid values and unsupported paths produce explicit errors. PostgreSQL text comparisons use binary C collation, including on databases configured with an ICU language locale.

PostgreSQL owner/embedded reads use one repeatable-read snapshot. Generated and custom mutations share one transaction for hooks, parent rows, owned embeddeds and independent nested writes. Supplied session handles are joined without commit/release; expired/foreign handles are rejected. Confirmed serialization/deadlock aborts retry up to five times, each after a random backoff that starts once the failed attempt has rolled back and released its client. Standalone `saveObject` also wraps its full lifecycle, including hooks and nested writes, in that transaction.

PostgreSQL identities are UUIDs and native models/sessions are not Mongoose objects. Optional root scalar storage uses SQL NULL for absence. Embedded records preserve absent versus explicit-null fields through private presence markers, materialize descendant list defaults and minimize empty inline objects; native hooks/code still use plain records rather than Mongoose documents. Required typed database columns and real FKs are stronger storage constraints than the Mongo generator. Native methods and pipeline helpers are outside GraphQL API parity.

Unsupported schema mappings are rejected before DDL: implicit many-to-many reciprocal lists, non-embedded collections inside embeddeds, embedded cycles, nested list wrappers, whole embedded-object uniqueness, unrecognized custom scalar storage and conflicting metadata. Whole embedded-object sorting/grouping remains unsupported. Scalar-list leaves inside nested embedded lists support filters/sorts and ragged group projections. Array facts use SUM=0/AVG=null, joined-row COUNT and whole-array lexicographic MIN/MAX. Aggregate sorting selects immediate array extrema, including default groupId order; ties need an additional sort term. Date and string-enum outputs and state-name aggregates retain Mongo's logical JSON values. For numeric and boolean enums, PostgreSQL compares, sorts and groups the text form (aggregate `groupId` `"10"`, sorted before `"2"`), while MongoDB uses numbers and booleans. Generated immutable comparison helpers and private presence columns are validated during initialization; existing schemas need an explicit migration. See [PostgreSQL documentation](postgresql.md) for setup and details.

Reference and nested writes retain the generated GraphQL input shapes. The live fixture creates a parent with an ObjectId reference and nested child, patches an embedded object, updates and deletes the child through the parent mutation, clears the reference, reads generated relation fields, and deletes the parent. Scalar list order and duplicates remain storage data. Aggregate queries retain `{ groupId, facts }`, default ascending ordering by `groupId` (ties are unspecified), and MongoDB numeric results.

## Verification ledger

The regression suite was first run against the unchanged implementation. All five new tests failed for the expected reasons: the omitted relation fallback discarded the ObjectId, null clearing targeted the API field, the inbound no-endpoint target had no model, `onUpdated` received a pending query, and only the last flat relation term survived.

Final foundation verification (2026-09-10):

- Full `npm test` with both disposable database URIs: **19 files, 361 tests passed**, no skips.
- PostgreSQL integration: **11 tests passed** on each of PostgreSQL 15, 16 and 18. Includes live constraints, nullable embedded/enum items, disabled-trigger detection, schema drift, concurrent initialization and orphan-data rollback.
- `npm run lint`: passed. Diff whitespace check passed with the original package JSON CRLF convention preserved.
- `npm run test:packages`: core, PostgreSQL and MongoDB packed installations passed; core/PostgreSQL installed no MongoDB/Mongoose/MCP packages.
- The review added regressions for collection-null storage isolation and repeated same-path terms; both fixes pass with the existing filter/update suite.

The foundation verification above is retained as the first increment's baseline. Runtime verification is recorded below after the complete shared-engine and PostgreSQL execution changes.

Independent runtime review reproduced and resolved: inconsistent owner/embedded read snapshots, enum-name/value state collisions, DDL prevention, locale-dependent text comparisons, unsupported array group projections, Boolean/UUID MIN/MAX, and partial standalone owner writes after an embedded FK failure. Review repeated these cases against PostgreSQL 16, including an ICU-configured database, with no open findings.

Runtime verification (2026-09-11):

- Full `npm test` with disposable MongoDB 7 and PostgreSQL 16: **28 files, 442 tests passed**, no skips.
- PostgreSQL 15 and 18: **68 schema/runtime/parity integration cases passed on each version**, including connection-field aliases and private inverse FKs against MongoDB.
- `npm run lint` and the diff whitespace check passed.
- `npm run test:packages` installed all three actual archives outside the workspace, exercised their runtimes/exports/introspection, and compiled strict TypeScript consumers with GraphQL 16. Core/PostgreSQL installed no MongoDB, Mongoose or MCP packages.
- At this runtime checkpoint, CI provisioned MongoDB 7 and PostgreSQL 15/16/18; normal unit runs skipped database suites explicitly when their URI was absent.

## v3.1.0 authorization and query limits

Nested child saves/updates/deletes run target middleware with root argument shapes. Update/delete ownership is checked from persisted records after middleware selects the effective ID. Missing records raise `NOT_VALID_ID`; foreign-parent records raise `FORBIDDEN`. Hooks cannot clear or replace the required parent connection. Query scopes authorize reads only; custom resolvers and native database access retain application-defined checks.

`configureQueryLimits({ maxPageSize })` is available on MongoDB and PostgreSQL facades and runtime instances. Its shared process-wide default is 1000; unpaged lists use the smaller of 100 and the configured maximum. Explicit page/size and calculated skip must be positive/safe integers within the maximum; unpaged aggregates remain unbounded. Invalid sort/filter paths and malformed filter values fail with domain errors. v3.1.0 rejects whole-array EQ values and null elements in filter lists; these older permissive parity cases now assert rejection on both backends. The later process-wide `configureMutationLimits({ maxNestedOperations })` setting, also on both facades and runtime instances, caps nested collection operations per generated mutation and is unlimited by default.

MongoDB transactions use the registered model connection, retry transient bodies and uncertain commits separately, and await owned cleanup. Each complete MongoDB retry first waits a random backoff that starts after the abort, and a `WriteConflict` that outlasts the retries fails with `TRANSACTION_RETRY_EXCEEDED` (409), the code PostgreSQL uses for its exhausted serialization and deadlock retries. PostgreSQL waits the same backoff before each retry, once the failed attempt has rolled back and released its client. Borrowed active sessions remain caller-owned in default Mongo mode. With opt-in transactional reference integrity, violations and guarded-write errors abort supplied sessions; those sessions require snapshot reads and majority commits. See [MongoDB reference integrity](guide/mongodb-integrity.md). PostgreSQL validates instance-owned active handles, retains repeatable-read atomicity, and retries confirmed serialization/deadlock aborts only.

Embedded parity also covers native/GraphQL default and minimization differences, direct SQL presence, uniqueness after omitted-parent defaults, and UTC historical Date parameters under `America/New_York`. PostgreSQL keeps required constraints: an omitted optional inline parent materialized by descendant array defaults must contain any required scalar; GraphQL create omits explicit null before applying defaults. See the PostgreSQL native/default contract for the explicit-null native alternative.

Embedded query completion verification (2026-09-12): full suites passed **47 files /954 tests** on each of PostgreSQL15/Mongo7 and PostgreSQL18/Mongo8; PostgreSQL16/Mongo8 integration plus schema checks passed **12 files /266 tests**. All ran under America/New_York. Full lint and all five packed runtime/TypeScript consumers passed. The new embedded differential suite contributes 122 cases.

## v3.2.0 package and CI delivery

The MongoDB facade, core, PostgreSQL, and MCP packages use version 3.2.0 in lockstep with exact internal dependency versions. All four packages are released on npm. Release archives and registry publication are ordered core, MCP, PostgreSQL, then the MongoDB facade. Core/PostgreSQL install no MongoDB, Mongoose, or MCP dependency chain; MCP and its SDK remain opt-in.

Database CI runs three bounded full-suite jobs: PostgreSQL 15/MongoDB 7, PostgreSQL 16/MongoDB 8, and PostgreSQL 18/MongoDB 8. Each job sets both MongoDB environment variables to distinct databases so the differential and upstream regression suites run without colliding.

PostgreSQL initialization exposes generated tables, primary keys, real FKs, indexes, presence columns, private ownership/key tables, functions, triggers, and maintenance metadata through `describeDatabase()`. These physical constraints are PostgreSQL behavior rather than a claim that native Mongoose APIs or storage coercions are identical. See the [canonical quick start](guide/postgresql.md) and [detailed storage reference](postgresql.md).

## v3.3.0 SQL core and PostgreSQL plugin

The new `@simtlix/simfinity-sql` package owns driver-free relational planning, records and session orchestration. PostgreSQL supplies physical schema/query/record compilation, native codecs, initialization and driver operations through `postgresPlugin`. Existing PostgreSQL factories and namespace entry points use the same SQL runtime and remain compatible. The explicit composition API is `createSQL({ plugin: postgresPlugin({ pool, schema }) })`; see the [SQL plugin contract](guide/sql-plugins.md).

All five packages use exact internal 3.3.0 versions. Publication order is core, SQL, MCP, PostgreSQL, then MongoDB. Installing SQL alone brings no PostgreSQL, MongoDB, Mongoose or MCP driver chain. PostgreSQL is the only supported SQL plugin initially.

Logical capability checks reject missing guarantees before physical compilation and initialization. Foreign keys, embedded ownership, presence/default behavior, list ordering, NULL-equal uniqueness, scopes, hooks and state semantics are preserved. Three golden fixtures compare complete PostgreSQL descriptions and DDL with 3.2.0, including nested/null/unique/enums and special identifiers. An unchanged model requires no generated-schema migration for this extraction.

Verification adds a non-PostgreSQL recording plugin, early contract/capability failures, fixed binding, transaction/session delegation, and real PostgreSQL interoperability between the old and new factories. Recording tests establish the plugin boundary; they do not establish support for a second SQL engine.

SQL extraction verification (2026-09-16): the full suite passed **51 files / 1,029 tests** with disposable PostgreSQL 18 and MongoDB 8, with no skips. All six isolated packed runtime/strict TypeScript consumers passed. A separate registry-installed 3.2.0 runtime created real schema and nested data; 3.3.0 `createSQL` validated that schema without DDL, produced identical metadata/SQL, preserved the records and successfully updated them. Barber passed both backend unit suites (69 PostgreSQL and 59 MongoDB tests), its PostgreSQL 67-operation/native-constraint corpus, MongoDB transaction checks, shared 19-operation HTTP/MCP contract on each backend, both dataset load/delete suites and frontend query validation against the generated schema.

## v3.4.0 optional MongoDB reference integrity

Mongo adapters accept immutable `referentialIntegrity: 'off' | 'transactional'` configuration. The default remains off. Transactional mode requires awaited startup auditing, coordinates target-document writes against concurrent deletion, and rejects missing direct/embedded/inferred/private/link references with `REFERENCE_CONSTRAINT_VIOLATION`. Supplied transactions require snapshot/majority options and abort on guarded-write errors. Native writers remain outside the guarantee. See [the full contract](guide/mongodb-integrity.md). PostgreSQL physical schemas and FK behavior are unchanged.

Verification: **53 files / 1,071 tests** passed against disposable MongoDB 8 replica-set and standalone deployments plus PostgreSQL 18, with no skipped tests. The 42 new cases include real GraphQL HTTP rejection, owned/borrowed rollback, post-write hook errors, three ordered concurrency schedules, independent runtime/client locks, actual transient retries, legacy off-mode Query compatibility and strict startup rejection. All six packed runtime/strict TypeScript consumers, lint and the website build passed.

## v3.5.0 query authorization and reference batching

Client filter, sort and aggregation paths enforce read rules for every segment and restrict referenced records through the target's scope. Fields with custom resolvers require an explicit `queryable: true` to allow stored-value queries; `queryable: false` blocks them. Path rules receive the checked field's identity, with no parent and empty arguments. See the [upgrade notes](resources/compatibility.md#upgrade-to-3-5-0) for compatibility and scope restrictions.

Generated single references can batch by request, type and nesting level. Both adapters preserve per-field middleware, while scoped targets and MongoDB models with any `find` or `findOne` pre/post hook retain individual reads. Shared hook functions do not establish equivalent behavior: hooks may depend on the operation or filter shape.

Regression coverage includes `tests/query-path-authorization.test.js`, `tests/relation-batching.test.js`, and their cross-backend counterparts in `tests/integration/`. Embedded replacement validation is covered by `embedded-update-required-parity.test.js`; SQL transaction tests cover expired sessions and failed rollback cleanup. The release matrix runs these cases with PostgreSQL 15/16/18 and MongoDB 7/8.

## v3.5.4 data-correctness fixes

Version 3.5.4 fixes data-correctness defects in the shared runtime, the driver-free planner, MCP classification and the MongoDB adapter, and adds a retry backoff to SQL transactions. The table rows marked "3.5.4" record the resulting contract; see the [upgrade notes](resources/compatibility.md#upgrade-to-3-5-4) for the changes applications can observe.

The new regression tests were checked against the 3.5.3 code, where they fail; tests that pin unchanged behavior pass on both. Beyond the suites named in the table, the coverage includes `tests/query-plan.test.js`, `tests/scope-args.test.js`, `tests/query-path-authorization.test.js` and `tests/mcp.test.js` for fields named like query arguments; `tests/mutation-transactions.test.js` for the MongoDB retry backoff and the 409 mapping, with real write conflicts in `tests/mutation-transactions.integration.test.js` and `tests/integration/mongodb-integrity.test.js`; `tests/sql-transactions.test.js` for the SQL retry backoff and its order after rollback and release; and `tests/sql-plugin.test.js` and `tests/runtime.test.js` for references to a numeric `0` identifier, read one at a time and in batches.
