# PostgreSQL Foundations Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Start the approved PostgreSQL version with executable MongoDB compatibility fixtures, common model metadata, and real PostgreSQL schema creation/validation with mandatory FKs.

**Architecture:** Keep the working MongoDB engine while introducing driver-free metadata in `packages/core` and the PostgreSQL schema compiler in `packages/postgres`. This first independently testable increment establishes the storage contract; subsequent increments move query/mutation execution into the shared runtime.

**Tech Stack:** ES modules, GraphQL 16, Mongoose 8, pg 8, Vitest, disposable MongoDB replica set and PostgreSQL containers.

**Spec:** `docs/superpowers/specs/2026-09-10-postgresql-support-design.md`

## Global Constraints

- Preserve the existing MongoDB exports and generated GraphQL API.
- All references with known targets generate PostgreSQL foreign keys; indexes alone do not qualify.
- Support inverse one-to-many, explicit many-to-many link entities, self-references, no-endpoint targets, and reference-bearing embedded objects/lists.
- Scalar ID fields without a target remain scalar values.
- Keep PostgreSQL/core packages independent of Mongoose and the MongoDB driver.
- Use Node.js >=18.18.0 for library runtime, GraphQL ^16.11.0, PostgreSQL >=15, top-level ES imports, and SimfinityError domain errors.
- Keep all user-created tarballs intact. Do not publish, merge, or change an existing database.

## Task 1: MongoDB compatibility fixtures and documented relation/lifecycle fixes

**Files:** `src/index.js`, `tests/contracts/model-fixtures.js`, `tests/integration/mongodb.test.js`, `.github/workflows/master.yml`, `docs/compatibility.md`, `tests/mongodb-regressions.test.js`.

**Interface:** Existing public `connect`, `createSchema`, `saveObject`, `buildQuery`, and controller callbacks retain signatures. Tests read `SIMFINITY_MONGODB_URI`; without it the integration suite is skipped, while CI supplies a disposable replica set.

- [x] Add regression tests for missing connectionField fallback, nullable relation clearing using the storage field, referenced scalar-only no-endpoint model creation, awaited `onUpdated` record, and multiple flat terms preserved.
- [x] Run the new tests against unchanged implementation and record the expected failures.
- [x] Correct only those defects. Leave root-only scope coverage, duplicate root cardinality, and standalone saveObject transaction behavior intact.
- [x] Add real GraphQL integration assertions for reference/nested CRUD, scopes plus OR, duplicate-preserving counts, aggregate results, validation rollback, and hook context/session.
- [x] Run focused tests, the full suite, and lint; record results in the compatibility ledger.

Example assertion for the regression contract:

```javascript
expect(await simfinity.buildQuery({
  author: { terms: [
    { path: 'name', operator: 'EQ', value: 'Alice' },
    { path: 'id', operator: 'EQ', value: authorId },
  ] },
}, BookType)).toEqual(expect.arrayContaining([
  { $match: { 'author.name': 'Alice', 'author._id': expect.anything() } },
]));
```

## Task 2: Driver-free metadata and reusable scalar factory

**Files:** `packages/core/package.json`, `packages/core/src/metadata.js`, `packages/core/src/scalars/factory.js`, `packages/core/src/errors/simfinity.error.js`, `packages/core/src/index.js`, `tests/model-metadata.test.js`, root package metadata and forwarding modules.

**Interfaces:** `describeModels(registrations)` consumes `{ gqltype, endpoint }[]`; returns `{ entities }` where each entity has `name`, `gqltype`, `fields`, and `indexes`. Each field records `name`, `storageName`, `kind` (`scalar`, `reference`, `collection`, `embedded`), `scalar`, `required`, `list`, `itemRequired`, `unique`, `readOnly`, `target`, `fields`, and `connectionField` as applicable. Embedded fields recursively contain descriptors. References identify an entity name; collection fields identify the child's normalized storage column. Additional inferred reference descriptors on child entities have `private: true`.

- [x] Add tests with fresh GraphQL type factories for the complete relation graph, required/list attributes, renamed connection fields, inverse-only FKs, invalid targets, and embedded cycles.
- [x] Verify failure before implementing `describeModels`.
- [x] Implement graph discovery, field normalization, inverse reconciliation, and validation without importing a database driver.
- [x] Move the validated scalar factory and shared error class into core with backward-compatible forwarding exports. Verify scalar imports work in a packed core-only installation.

Example contract assertion:

```javascript
const description = describeModels(registrations);
expect(description.entities.find((item) => item.name === 'episode').fields)
  .toEqual(expect.arrayContaining([
    expect.objectContaining({ name: 'season', storageName: 'season', kind: 'reference', target: 'season', required: true }),
  ]));
```

## Task 3: PostgreSQL schema compiler and catalog validation

**Files:** `packages/postgres/package.json`, `packages/postgres/src/schema/{describe,ddl,initialize}.js`, `packages/postgres/src/index.js`, `tests/postgres-schema.test.js`, `tests/integration/postgres-schema.test.js`.

**Interfaces:** `describeDatabase(registrations, { schema = 'public' })` returns serializable `{ schema, tables }` metadata, each table containing `name`, `columns`, `primaryKey`, `foreignKeys`, `indexes`, and ownership metadata. `compileDatabaseSchema(description)` returns a deterministic array of SQL statements. `initializeDatabase(pool, description, { mode = 'create' })` creates or validates the description under a transaction-level advisory lock; returns `{ mode, created }`, with `created` listing new objects. These low-level functions are explicitly foundational APIs; do not advertise the unfinished full PostgreSQL GraphQL facade.

- [x] Add SQL/catalog tests for one-to-many deduplication, both association FKs, UUID/int/text/boolean/date/enum columns, reference-bearing owned tables, ordering columns, required/unique fields, and identifier quoting.
- [x] Verify failures before implementation.
- [x] Generate tables, primary keys, foreign keys, and indexes from core metadata. Use deterministic shortened names and reject collisions rather than overwriting fields.
- [x] Implement parameterized catalog reads, awaited creation/validation, advisory lock, transaction rollback, and actionable schema mismatch errors. Validate FK targets/actions/deferrability and avoid destructive schema sync.
- [x] Execute generated DDL in PostgreSQL and assert catalog contents plus direct SQL invalid insert/update/delete failures, owned cascades, idempotence, drift detection, and transaction rollback.

Example integrity assertion:

```javascript
await expect(pool.query('INSERT INTO "episode" ("id", "season") VALUES ($1, $2)', [episodeId, missingSeasonId]))
  .rejects.toMatchObject({ code: '23503' });
```

## Task 4: Documentation, packaging, CI, and review

**Files:** `README.md`, `docs/postgresql.md`, `docs/compatibility.md`, relevant `.cursor/rules/*.mdc`, package declarations, database CI workflow, dependency-isolation tests.

- [x] Document implemented foundational exports with runnable examples and clearly mark full PostgreSQL GraphQL execution as the next increment.
- [x] Add npm workspaces and lockfile entries; test packed core/PostgreSQL packages without MongoDB dependencies.
- [x] Configure CI unit tests on a current Vitest-supported Node version and real database integration jobs.
- [x] Run `npm run lint`, `npm test`, and both integration suites against disposable databases; inspect the final diff and address review findings.
- [x] Report implemented capabilities, verification evidence, and remaining roadmap phases accurately.

## Implementation record — 2026-09-10

Completed this foundational increment on `codex/postgresql-foundations`. The complete PostgreSQL GraphQL facade remains in the design's subsequent runtime/query/mutation phases.

Review added explicit rejection of implicit reciprocal many-to-many, embedded/multikey uniqueness and colliding enum storage values; nullable enum items, disabled FK enforcement, Mongo inverse-list clearing and repeated same-path predicates received regressions. PostgreSQL 18 catalog handling is included alongside PostgreSQL 15/16 support.

No packages were published, no application databases were modified, and no merge/push was performed. Existing release/publish workflows need a separate release preparation step with core published before dependent packages.
