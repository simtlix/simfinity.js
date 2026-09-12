# Database compatibility contract

This ledger records the v3.2.0 behavior shared by the MongoDB and PostgreSQL implementations and the remaining differences. The MongoDB contract is in `tests/integration/mongodb.test.js`, PostgreSQL execution in the runtime/lifecycle/options suites, and direct result/schema comparison in the query-parity suites, using the graph in `tests/contracts/model-fixtures.js`.

Set `SIMFINITY_MONGODB_URI` and `SIMFINITY_POSTGRES_URI` to disposable databases for the cross-backend suites. Set `SIMFINITY_TEST_MONGODB_URI` to a separate disposable MongoDB database for upstream opt-in regressions. Mongo setup drops its configured databases, so these URIs must never identify application data. When a variable is absent, its integration suites are reported as skipped.

## MongoDB contract

| Behavior | Decision | Executable evidence |
| --- | --- | --- |
| A non-embedded relation with no `connectionField` stores its ObjectId under the GraphQL field name. | Fixed and shared | Unit regression plus real `ContractSerie.label` create/read/clear flow. |
| Clearing a nullable singular reference unsets its storage field (`connectionField` when declared, otherwise the GraphQL field). Clearing an inverse collection does not unset the child connectionField on the parent. | Fixed and shared | Unit regression and real update followed by a raw MongoDB record check. |
| A scalar-only no-endpoint type receives a model when another registered type references it. It still receives no root endpoint. | Fixed and shared | Unit regression and the real `ContractLabel` reference fixture. |
| `onUpdated` receives the resolved updated record after the database operation completes. | Fixed and shared | Unit regression and live hook assertions. |
| Multiple flat terms on one relation are all present in the generated match. | Fixed and shared | Unit regressions for `author.name` plus `author.id`, and two predicates on the same `author.name` path. |
| Root reads and generated non-embedded relationships run target middleware and scopes. Relationship IDs and parent predicates cannot be redirected by mutable arguments. | v3.1.0 shared | Upstream authorization integration tests and cross-backend `runtime-v31.test.js`. |
| A one-to-many filter uses `$lookup` plus `$unwind`; a root with two matching children appears twice. Count uses the same multiplicity. | Preserve current cardinality | Live collection-filter result contains the same root twice and sets `context.count` to `2`. |
| Generated mutations own a transaction and pass its native session plus the GraphQL context to validation and controller hooks. A nested failure rolls back the parent write. | Preserve | Live nested validation failure leaves neither parent nor child records; hook assertions observe an active session and the original context. |
| `saveObject(typeName, args, session, context)` owns the entire workflow transaction without a supplied session. Active supplied sessions remain caller-owned. | v3.1.0 shared | Standalone nested middleware/hook/FK failure rolls back parent, child and embedded writes. |
| Accepted empty strings, `false`, `0` and empty arrays survive materialization. Nullable embedded list items retain null; null referenced-operation items are skipped. | v3.1.0 shared | Upstream materialization regressions and live standalone save/update checks on both backends. |
| `GraphQLNonNull` controls GraphQL inputs but does not automatically add a Mongoose `required` validator. | Preserve for MongoDB | PostgreSQL schema metadata may use the declaration for `NOT NULL`; this is a documented storage-level difference. |
| Lists preserve outer and item nullability (`[T]`, `[T!]`, `[T]!`, `[T!]!`). Update fields allow omission while retaining item wrappers. | Fixed and shared | Runtime input/schema regressions; real scalar/date/embedded list operations. |
| Inverse relations may use a scalar ID or an alias for the child's reference storage field. | Fixed and shared | Explicit connection-field normalization and real nested create/read/update regressions. |
| Aggregation through inverse collections uses the child FK and counts contributing rows. | Fixed and shared | Live cross-database SUM/COUNT and scalar Boolean MIN/MAX comparison. |
| Embedded lists can be restored after being cleared. Object patches stay shallow, list patches replace the list. | Fixed and shared | Runtime regression and real owned-reference-list clear/restore flow. |
| Retried generated/custom mutations start with fresh typed input structures; middleware executes once. | Fixed and shared | Synthetic retry tests retain enum identity and reset nested lists/objects/Dates; real PostgreSQL aborted-attempt rollback. |
| State storage/guards use a single adapter-specific representation. | Shared orchestration | Mongo preserves state names; PostgreSQL stores/decodes enum internal values. Real tests cover overlapping names/values and concurrent transitions. |

## PostgreSQL execution contract and limits

The query parity corpus compares actual schemas and responses for operators, nested logical filters, dates, enums, scalar arrays, nullable values, array sorts, embedded paths, scopes, joined row multiplicity, pagination/counts and aggregate facts. Typed invalid values and unsupported paths produce explicit errors. PostgreSQL text comparisons use binary C collation, including on databases configured with an ICU language locale.

PostgreSQL owner/embedded reads use one repeatable-read snapshot. Generated and custom mutations share one transaction for hooks, parent rows, owned embeddeds and independent nested writes. Supplied session handles are joined without commit/release; expired/foreign handles are rejected. Confirmed serialization/deadlock aborts retry up to five times. Standalone `saveObject` also wraps its full lifecycle, including hooks and nested writes, in that transaction.

PostgreSQL identities are UUIDs and native models/sessions are not Mongoose objects. Optional root scalar storage uses SQL NULL for absence. Embedded records preserve absent versus explicit-null fields through private presence markers, materialize descendant list defaults and minimize empty inline objects; native hooks/code still use plain records rather than Mongoose documents. Required typed database columns and real FKs are stronger storage constraints than the Mongo generator. Native methods and pipeline helpers are outside GraphQL API parity.

Unsupported schema mappings are rejected before DDL: implicit many-to-many reciprocal lists, non-embedded collections inside embeddeds, embedded cycles, nested list wrappers, whole embedded-object uniqueness, unrecognized custom scalar storage and conflicting metadata. Whole embedded-object sorting/grouping remains unsupported. Scalar-list leaves inside nested embedded lists support filters/sorts and ragged group projections. Array facts use SUM=0/AVG=null, joined-row COUNT and whole-array lexicographic MIN/MAX. Aggregate sorting selects immediate array extrema, including default groupId order; ties need an additional sort term. Date/enum outputs and state-name aggregates retain Mongo's logical JSON values. Generated immutable comparison helpers and private presence columns are validated during initialization; existing schemas need an explicit migration. See [PostgreSQL documentation](postgresql.md) for setup and details.

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

`configureQueryLimits({ maxPageSize })` is available on MongoDB and PostgreSQL facades and runtime instances. Its shared process-wide default is 1000; unpaged lists use the smaller of 100 and the configured maximum. Explicit page/size and calculated skip must be positive/safe integers within the maximum; unpaged aggregates remain unbounded. Invalid sort/filter paths and malformed filter values fail with domain errors. v3.1.0 rejects whole-array EQ values and null elements in filter lists; these older permissive parity cases now assert rejection on both backends.

MongoDB transactions use the registered model connection, retry transient bodies and uncertain commits separately, and await owned cleanup. Borrowed active sessions never commit, abort, retry or end inside the runtime. PostgreSQL validates instance-owned active handles, retains repeatable-read atomicity, and retries confirmed serialization/deadlock aborts only.

Embedded parity also covers native/GraphQL default and minimization differences, direct SQL presence, uniqueness after omitted-parent defaults, and UTC historical Date parameters under `America/New_York`. PostgreSQL keeps required constraints: an omitted optional inline parent materialized by descendant array defaults must contain any required scalar; GraphQL create omits explicit null before applying defaults. See the PostgreSQL native/default contract for the explicit-null native alternative.

Embedded query completion verification (2026-09-12): full suites passed **47 files /954 tests** on each of PostgreSQL15/Mongo7 and PostgreSQL18/Mongo8; PostgreSQL16/Mongo8 integration plus schema checks passed **12 files /266 tests**. All ran under America/New_York. Full lint and all five packed runtime/TypeScript consumers passed. The new embedded differential suite contributes 122 cases.

## v3.2.0 package and CI delivery

The root MongoDB facade, core, PostgreSQL, and MCP packages use local version 3.2.0 in lockstep with exact internal dependency versions. This version is not claimed to be published. Release archives and registry publication are ordered core, MCP, PostgreSQL, then the root facade. Core/PostgreSQL install no MongoDB, Mongoose, or MCP dependency chain; MCP and its SDK remain opt-in.

Database CI runs three bounded full-suite jobs: PostgreSQL 15/MongoDB 7, PostgreSQL 16/MongoDB 8, and PostgreSQL 18/MongoDB 8. Each job sets both MongoDB environment variables to distinct databases so the differential and upstream regression suites run without colliding.

PostgreSQL initialization exposes generated tables, primary keys, real FKs, indexes, presence columns, private ownership/key tables, functions, triggers, and maintenance metadata through `describeDatabase()`. These physical constraints are PostgreSQL behavior rather than a claim that native Mongoose APIs or storage coercions are identical. See the [canonical quick start](guide/postgresql.md) and [detailed storage reference](postgresql.md).
