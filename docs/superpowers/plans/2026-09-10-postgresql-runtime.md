# Shared runtime and PostgreSQL execution implementation plan

Goal: continue the foundation with shared GraphQL generation/lifecycle orchestration, preserve the MongoDB contract, and run the same supported query and nested CRUD graph against PostgreSQL. Backend instances bind once; no switching or migration.

## Adapter contract

`createRuntime(adapter)` owns the existing GraphQL registries, input types, middleware/scopes and operation hooks. It returns the existing connect/addNoEndpointType/createSchema/getModel/getType/getInputType/use/registerMutation/saveObject/preventCreatingCollection API. `getRegistrations()` exposes current registration records for setup/initialization. Static shared error/scalar/helper exports remain ordinary module exports. No database drivers, Mongo pipelines or SQL in runtime.js.

Adapter methods (all operation methods may be async; setup/model creation are synchronous):

- `bind({ getModel, getType, getRegistrations })`: optional closure configuration, called once.
- `prepare(registrations, { createCollection })`: optional synchronous pre-schema preparation. PostgreSQL computes descriptions and creation policy; Mongo discovers private inverse connection fields.
- `createModel(gqltype, onModelCreated, { createCollection })`: native/opaque model handle. Callback receives native handle. Mongo preserves existing custom model support.
- `castId(value)`: backend ID normalization.
- `stateValue(state)`: optional canonical persisted state value; defaults to state.name for Mongo, PostgreSQL returns the enum internal value.
- `withTransaction(session, body)`: generated/custom mutation transaction policy. Existing Mongo retry ownership retained; PostgreSQL supplied sessions participate without commit/close.
- `newRecord(Model, data, session)`: constructs writable hook record and preallocates ID.
- `saveRecord(Model, record, session)`: inserts and returns record. `toObject(record)` exposes plain record.
- `getById(Model, id, session, { projection, plain, lock } = {})`: native record lookup; plain option preserves Mongo lean calls; PostgreSQL lock used for state transitions/embedded patches.
- `prepareUpdate(set, unset)`: returns mutable native update payload for onUpdating hook; Mongo combines set and $unset, PostgreSQL uses the same documented payload initially.
- `update(Model, id, update, session)`, `delete(Model, id, session)`.
- `find(Model, gqltype, args, session)`, `count(Model, gqltype, args, session)`, `aggregate(Model, gqltype, args, session)`; count returns number; aggregate returns existing groupId/facts records. Middleware/scopes run in core before these calls.
- `findChildren(Model, gqltype, connectionField, parentId, args, session)`: internal child-ownership filter plus caller filters, no new scope boundary. Mongo preserves current query helper semantics where valid; PostgreSQL resolves scalar/private/renamed inverse columns directly.
- Mongo adapter additionally exposes bound `buildQuery` and `buildFilterGroupMatch` unchanged for legacy public pipeline helpers.

IDs on records retain `_id`; GraphQL's existing id resolver reads it. State-machine conversion uses adapter.toObject. PostgreSQL records are plain objects, hooks receive the PostgreSQL session handle, and native Mongoose integrations require adaptation. Missing readiness raises a domain error; SQL errors never expose statements/credentials.

## Task 1 — Shared engine and Mongo adapter extraction

Own `src/index.js`, `src/mongo/**`, `packages/core/src/runtime.js` plus shared runtime helper modules/consts/introspection/errors, root forwarding modules as needed, and `tests/runtime.test.js`. Preserve root helper exports and existing tests. Keep reusable auth/MCP packaging moves out of this extraction unless essential; root retains its existing exports. Add driver-free runtime/instance isolation tests. Run Mongo integration and full existing suite; no commits while sharing checkout. Use the adapter contract above exactly, communicate necessary refinements before changing it.

## Task 2 — Query plan, PostgreSQL queries and records

Own `packages/core/src/query-plan.js`, `packages/postgres/src/query/**`, `packages/postgres/src/adapter.js`, `packages/postgres/src/records.js`, `packages/postgres/src/transactions.js`, package public facade/declarations. Build metadata-resolved predicates, logical nesting, joins preserving root multiplicity and same-child correlation, bound values, enum/date/ID codecs, pagination/count/sort/aggregate results. Read scalar JSONB and owned embedded reference tables into original record shape. Add unit plus real database tests for filters, null/arrays, scopes+OR, counts, aggregation, invalid paths/injection, and missing initialization.

## Task 3 — PostgreSQL writes and contract parity

Implement the adapter operations needed by the shared lifecycle: typed inserts/updates/deletes, embedded shallow-merge/array replacement, owned reference row persistence, null/missing state markers, one-client transactions, SQLSTATE domain errors and retries. Generated IDs exist before onSaving. Preserve standalone saveObject's transaction ownership. Test nested added/updated/deleted CRUD, reference clearing, validations/hooks/rollback, external FK blocked deletes, owned cascades, custom mutations and state transitions. Unsupported foundation mappings remain explicit errors.

## Task 4 — Packaging, docs and review

Expose a PostgreSQL `createPostgres({pool,schema})` instance factory plus default-module configure/connect/createSchema facade, with one-time configuration and awaited initialization. Preserve the existing low-level initializeDatabase(pool,description,options) overload. Document implemented surface and remaining parity limits accurately. Keep Mongo dependencies out of PostgreSQL. Extend packed smoke and database CI checks. Run lint, unit/integration suites, real MongoDB and PostgreSQL contract tests; get independent review and resolve findings. No publish/push/merge or application database access.

## Implementation decisions from verification

- Preserve entity+embedded atomicity and one-snapshot reads even when an embedded document is stored in multiple PostgreSQL tables. Standalone saveObject still leaves workflow transaction ownership with the caller.
- Use binary C collation for text columns and query expressions; catalog validation detects collation drift.
- Use adapter-canonical state values consistently and snapshot typed mutation inputs between retries, retaining enum/opaque scalar identity.
- Support Boolean and UUID MIN/MAX explicitly. Reject array-projected embedded group keys whose missing-value representation is not yet supported instead of returning different aggregates.
- Normalize inverse connection fields across GraphQL input exclusion, child writes/resolvers and Mongo lookup paths, preserving declared aliases in generated input names.
- Keep auth/MCP/prebuilt helper extraction, embedded/multikey uniqueness, unsupported array queries, migrations and publishing workflows as subsequent work. No full arbitrary Mongo-model compatibility claim.

## Verification checkpoint — 2026-09-11

- [x] Shared engine and Mongo adapter extraction.
- [x] Typed query plans, PostgreSQL execution and embedded record reconstruction.
- [x] Transactional nested writes, lifecycle/state semantics and live parity tests.
- [x] Public instance/default APIs, declarations, documentation and isolated package smoke.
- [x] Independent review findings fixed and reproduced on PostgreSQL 16, including ICU collation.
- [x] Final full suite: 442 tests / 28 files with MongoDB 7 and PostgreSQL 16; lint and packed strict TypeScript consumers pass.
- [x] PostgreSQL 15/18: 68 integration cases each, including alias/private inverse relations.

The implementation remains experimental and uncommitted on `codex/postgresql-foundations`. No publication, migration of application data or backend-switching facility was performed.
