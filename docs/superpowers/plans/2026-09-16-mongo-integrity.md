# MongoDB transactional reference integrity implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this approved design task by task.

**Goal:** Offer immutable `createMongoAdapter({ referentialIntegrity: 'off' | 'transactional' })` configuration, defaulting to `off`, with transactional reference existence and restrict-delete enforcement.

**Architecture:** Keep integrity metadata, locks, startup validation and database operations in the Mongo package. Reuse core `describeModels` for aliases, embedded references, explicit link entities and inferred/private inverse keys. All guarded writes use the same Mongo transaction, and all reference creators and target deleters modify the same reserved target-document field before they can commit.

**Tech stack:** ES modules, GraphQL 16, Mongoose 8, MongoDB replica sets, Vitest; Node >=18.18.0 consumers and Node 24 development.

**Spec:** User-approved configuration and transaction protocol in this task, September 16, 2026. The concrete design below specifies startup and supplied-session behavior.

## Global constraints and concrete design

- Preserve Mongo's default behavior and all GraphQL endpoints/scopes. Do not disable PostgreSQL's native FKs.
- No new dependencies; core/SQL remain driver-free.
- Capture configuration once; reject unknown values. Bind strict adapters to one runtime and freeze the registration set at schema preparation.
- Add `MongoAdapter.initialize(): Promise<void>`; call after `createSchema()` and Mongo connection, before serving. Strict writes reject until successful initialization. Off-mode initialization is a no-op.
- Initialize all registered persistent models, verify a single Mongo connection and an actual transaction, and audit existing references in a snapshot. Reject unsupported topology, malformed metadata, reserved field collisions, or existing orphans. Startup never repairs data.
- Use reserved `_simfinityReferenceLock` ObjectId with `select: false` on persistent models. Every lock writes a fresh ObjectId with the native collection API, preserving domain hooks, timestamps, version keys and public GraphQL shape. It is storage metadata, not a GraphQL field.
- Validate the persisted document after save/update inside the same transaction, including controller changes, all embedded levels, inferred GraphQLID keys and private inverse fields. Deduplicate and sort target locks per operation. Missing optional/null references remain allowed. Scalar IDs without declared/inferred relations remain ordinary data.
- For deletion, first modify the target lock then query every incoming reference path in the same snapshot. Exclude the document being deleted for self-references; embedded subdocuments disappear with their owner. Other references restrict deletion.
- A reference violation returns `REFERENCE_CONSTRAINT_VIOLATION` (409) and aborts the transaction, including a supplied transaction, so catching the error cannot commit an invalid preceding write. Healthy supplied transactions remain caller-owned; any guarded-write failure, including a post-write hook error, aborts the session while preserving the error. Existing bounded transient retries and commit-only uncertain-result retries remain in use.
- Guarantee covers adapter/runtime writes. Native Mongoose/raw writes in controllers, custom mutations, seeds, migrations or external clients must coordinate separately. All writers must use the same full relation registry/configuration. Existing uncoordinated writers must be stopped during initial audit. This is not general serializable isolation or a database FK.

## Task 1: Startup and configuration

**Files:** `packages/mongodb/src/mongo/adapter.js`, new `packages/mongodb/src/mongo/integrity.js`, `packages/mongodb/types/index.d.ts`, new `tests/mongodb-integrity.test.js`.

**Interfaces:** `createMongoIntegrity(options)` owns prepare/bind/model registration, readiness and initialization; adapter exports immutable `referentialIntegrity` plus `initialize()`.

- [x] Add configuration/readiness/reserved-field tests. Example: `expect(() => createMongoAdapter({ referentialIntegrity: 'typo' })).toThrow()` and reject guarded mutation before initialization without writing.
- [x] Run new tests and verify failure on the absent option/readiness enforcement.
- [x] Capture validated configuration; implement strict lifecycle and startup snapshot audit. Use native collections under the model's connection; reject mixed connections and supplied model shapes that cannot represent the declared references.
- [x] Run configuration tests and real startup success/orphan/unsupported-topology cases.

## Task 2: Writes, relationships and rollback

**Files:** integrity/adapter modules above; new `tests/integration/mongodb-integrity.test.js` and fixture in `tests/fixtures/mongodb-integrity.js`.

**Interfaces:** `validateRecord(Model, record, session)` inspects stored references and locks targets; `deleteRecord(Model, id, session)` locks and enforces incoming-reference restrictions. Both require successful initialization and an active transaction.

- [x] Add real database GraphQL cases for missing direct/aliased/embedded references, deep nullable lists, inferred/private inverse keys, explicit link entities, valid nested parent/child insertion, self-reference, controller mutation, null/unset/list replacement and full nested rollback. Assert exact domain code and persisted state.
- [x] Verify failures against current implementation before adding guards.
- [x] Wrap adapter save/update/delete with guards. Read the persisted post-image to include defaults/setters/hooks. Abort on integrity violation even in a borrowed session. Keep off paths unchanged.
- [x] Verify successful operations and unchanged database state after failed operations; verify supplied-session success, rollback and uncommittable failure.

## Task 3: Concurrency proof and packaging

**Files:** integration suite, `scripts/test-packages.js`, declarations and matching documentation.

- [x] Add controlled two-session schedules: creator locks first; deleter commits first after creator has an old snapshot; deletion starts on an old snapshot before a reference commits. Retry the whole loser transaction and assert final outcomes contain no orphans. Use promises/barriers and active sessions, no sleeps as synchronization.
- [x] Exercise separate runtime instances/connections to the same database, self-references and reference removal before deletion in one transaction. Verify no lock metadata leaks through GraphQL.
- [x] Add a real HTTP GraphQL regression for invalid embedded references and rollback, and packed TypeScript coverage for new options/initialize.
- [x] Run root lint/full real Mongo+Postgres tests, package consumers and docs build. Existing database CI discovers the new suite through `SIMFINITY_MONGODB_URI`.
- [x] Update root/package READMEs, website relationships/startup docs, AGENTS and Cursor architecture/testing guidance. Document contention, immediate constraints, retryable hooks, full-registry requirement and native-write boundary.
- [ ] Review changes, integrate through repository workflow under existing user authorization, and remove only task-owned temporary database containers.

## Verification results

- Configuration and database cases failed before the corresponding guards were added.
- 42 new tests cover options, startup, HTTP, nested/inverse/dotted/link relations, rollback, supplied sessions, real concurrent schedules, model hooks and legacy behavior.
- Full suite: 53 files, 1,071 tests, no skips, using MongoDB 8 replica set + standalone and PostgreSQL 18.
- Root lint, all six packed runtime/strict TypeScript consumers, documentation build and aligned 3.4.0 release checks pass.
- Independent reviewer findings were reproduced and fixed; focused final review reported no remaining findings.
