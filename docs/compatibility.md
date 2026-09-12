# Database compatibility contract

This ledger records behavior shared by the MongoDB and PostgreSQL implementations and the remaining differences. The MongoDB contract is in `tests/integration/mongodb.test.js`, PostgreSQL execution in the runtime/lifecycle/options suites, and direct result/schema comparison in `tests/integration/query-parity.test.js`, using the graph in `tests/contracts/model-fixtures.js`.

Set `SIMFINITY_MONGODB_URI` to a disposable replica-set database to run the integration suite. The database is dropped during setup, so the URI must never identify an application database. When the variable is absent, Vitest reports the integration suite as skipped.

## MongoDB contract

| Behavior | Decision | Executable evidence |
| --- | --- | --- |
| A non-embedded relation with no `connectionField` stores its ObjectId under the GraphQL field name. | Fixed and shared | Unit regression plus real `ContractSerie.label` create/read/clear flow. |
| Clearing a nullable singular reference unsets its storage field (`connectionField` when declared, otherwise the GraphQL field). Clearing an inverse collection does not unset the child connectionField on the parent. | Fixed and shared | Unit regression and real update followed by a raw MongoDB record check. |
| A scalar-only no-endpoint type receives a model when another registered type references it. It still receives no root endpoint. | Fixed and shared | Unit regression and the real `ContractLabel` reference fixture. |
| `onUpdated` receives the resolved updated record after the database operation completes. | Fixed and shared | Unit regression and live hook assertions. |
| Multiple flat terms on one relation are all present in the generated match. | Fixed and shared | Unit regressions for `author.name` plus `author.id`, and two predicates on the same `author.name` path. |
| Scope callbacks apply to root `find`, `get_by_id`, and `aggregate` operations. Generated child relation resolvers do not run child scopes. | Preserve current root-only boundary | Live root `find` combines a tenant scope with a caller-supplied OR group. |
| A one-to-many filter uses `$lookup` plus `$unwind`; a root with two matching children appears twice. Count uses the same multiplicity. | Preserve current cardinality | Live collection-filter result contains the same root twice and sets `context.count` to `2`. |
| Generated mutations own a transaction and pass its native session plus the GraphQL context to validation and controller hooks. A nested failure rolls back the parent write. | Preserve | Live nested validation failure leaves neither parent nor child records; hook assertions observe an active session and the original context. |
| `saveObject(typeName, args, session, context)` participates in a supplied session; without one it does not wrap hooks and nested independent entities in a workflow transaction. | Preserve | PostgreSQL still commits an owner and its normalized embedded rows atomically. A failed embedded FK leaves no partial owner. |
| Empty strings are treated as absent during materialization, while `false` and `0` are stored. | Preserve for this foundation | Existing MongoDB behavior; callers should not rely on an empty string being persisted. |
| `GraphQLNonNull` controls GraphQL inputs but does not automatically add a Mongoose `required` validator. | Preserve for MongoDB | PostgreSQL schema metadata may use the declaration for `NOT NULL`; this is a documented storage-level difference. |
| Lists preserve outer and item nullability (`[T]`, `[T!]`, `[T]!`, `[T!]!`). Update fields allow omission while retaining item wrappers. | Fixed and shared | Runtime input/schema regressions; real scalar/date/embedded list operations. |
| Inverse relations may use a scalar ID or an alias for the child's reference storage field. | Fixed and shared | Explicit connection-field normalization and real nested create/read/update regressions. |
| Aggregation through inverse collections uses the child FK and counts contributing rows. | Fixed and shared | Live cross-database SUM/COUNT and scalar Boolean MIN/MAX comparison. |
| Embedded lists can be restored after being cleared. Object patches stay shallow, list patches replace the list. | Fixed and shared | Runtime regression and real owned-reference-list clear/restore flow. |
| Retried generated/custom mutations start with fresh typed input structures; middleware executes once. | Fixed and shared | Synthetic retry tests retain enum identity and reset nested lists/objects/Dates; real PostgreSQL aborted-attempt rollback. |
| State storage/guards use a single adapter-specific representation. | Shared orchestration | Mongo preserves state names; PostgreSQL stores/decodes enum internal values. Real tests cover overlapping names/values and concurrent transitions. |

## PostgreSQL execution contract and limits

The query parity corpus compares actual schemas and responses for operators, nested logical filters, dates, enums, scalar arrays, nullable values, array sorts, embedded paths, scopes, joined row multiplicity, pagination/counts and aggregate facts. Typed invalid values and unsupported paths produce explicit errors. PostgreSQL text comparisons use binary C collation, including on databases configured with an ICU language locale.

PostgreSQL owner/embedded reads use one repeatable-read snapshot. Generated and custom mutations share one transaction for hooks, parent rows, owned embeddeds and independent nested writes. Supplied session handles are joined without commit/release; expired/foreign handles are rejected. Confirmed serialization/deadlock aborts retry up to five times. Standalone saveObject retains the workflow ownership distinction described above.

PostgreSQL identities are UUIDs and native models/sessions are not Mongoose objects. Optional scalar storage uses SQL NULL rather than preserving every Mongoose missing/default distinction; native hooks/code must adapt. Required typed database columns and real FKs are stronger storage constraints than the Mongo generator. Native methods and pipeline helpers are outside GraphQL API parity.

Unsupported schema mappings are rejected before DDL: implicit many-to-many reciprocal lists, non-embedded collections inside embeddeds, embedded cycles, nested lists, embedded/multikey uniqueness, unrecognized custom scalar storage and conflicting metadata. Unsupported queries include whole embedded object sorting/grouping, aggregate array facts except COUNT, grouping by paths inside embedded lists, and scalar lists nested inside embedded lists. Explicit rejection avoids returning different aggregates for missing array fields. See [PostgreSQL documentation](postgresql.md) for setup and details.

Reference and nested writes retain the generated GraphQL input shapes. The live fixture creates a parent with an ObjectId reference and nested child, patches an embedded object, updates and deletes the child through the parent mutation, clears the reference, reads generated relation fields, and deletes the parent. Scalar list order and duplicates remain storage data. Aggregate queries retain `{ groupId, facts }`, deterministic default ordering by `groupId`, and MongoDB numeric results.

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
- CI provisions MongoDB 7 and PostgreSQL 15/16/18; normal unit runs skip database suites explicitly when their URI is absent.
