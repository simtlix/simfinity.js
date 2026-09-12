# PostgreSQL completion implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Finish PostgreSQL compatibility against current Simfinity and deliver the barber application using it.

**Architecture:** Shared GraphQL runtime with separate MongoDB/PostgreSQL adapters and optional MCP integration. PostgreSQL metadata generates physical constraints; application native persistence is ported explicitly.

**Tech Stack:** Node.js >=18.18.0, GraphQL 16, Mongoose 8, pg 8, PostgreSQL >=15, Vitest on Node.js 24, Docker, VitePress.

**Spec:** `docs/superpowers/specs/2026-09-12-postgresql-completion-design.md`

## Global Constraints

- Use upstream `37efd341dd42741a4f5539f6b6f137733b6b3ada` as the current API contract.
- Backend selection is fixed at startup; no migration of application data is requested.
- Core/PostgreSQL install no MongoDB, Mongoose or MCP dependency; MCP is opt-in.
- Keep real generated FKs, non-destructive initialization, authorization and transactional lifecycle.
- Preserve original checkouts and user tarballs; use only disposable databases for tests.
- User authorized local implementation and infrastructure without approval pauses.

### Task 1: Integrate the current upstream runtime contract

**Files:** `packages/core/src/runtime.js`, `packages/core/src/introspection.js`, `packages/core/src/const/QLValue.js`, `packages/core/types/index.d.ts`, `src/mongo/*`, `src/index.js`, `packages/postgres/src/{adapter,records,transactions}.js`, `packages/postgres/types/index.d.ts`, upstream regression tests and PostgreSQL equivalents.

**Interfaces:** Preserve `createRuntime(adapter)`, existing facade exports and `createPostgres` instance API. Add upstream `configureQueryLimits(options)` to both runtime facades/types. Adapter operations receive request context, session and immutable relationship ownership predicates as needed.

- [x] Read `git diff c850238..origin/master -- src/index.js` and current upstream tests for schema initialization, input/list materialization, mutation transactions, query correctness and relation authorization. Upstream auth/MCP files have already merged. Follow repository rules. Read the upstream docs for query-scope, mutations, relationships and queries.
- [x] Run `npm test` and record failing upstream contracts before editing runtime code. Integration tests with URI-dependent skips must also be run against disposable real databases before completion.
- [x] Port upstream changes into the extracted engine and adapters (do not restore the monolith): robust materialized introspection, non-null/list input wrappers, empty strings/null list entries, recursive literals, bounded pagination and safe sort/filter paths, protected relationship identity/parent predicates, target middleware/scopes for relation reads, nested child operation middleware and ownership checks, hook-proof parent linkage, connection-aware transactional saves and borrowed-session ownership. Preserve the foundation's fixes for connection-field aliases, PostgreSQL enum values, fresh retry inputs, no-endpoint inferred models, and private FKs.
- [x] For transactions, owned MongoDB saves retry transient bodies and uncertain commits separately; borrowed active sessions never commit/abort/end. PostgreSQL preserves active-session validation, aborted transaction retries and atomic reads/writes. `saveObject` now wraps its entire workflow for both adapters, as v3.1.0 documents.
- [x] Add real cross-backend regressions for scoped relationship reads, child middleware/ownership, empty strings, standalone rollback, query limits and sort-path rejection. Reuse upstream tests without weakening their assertions; adapt mocked internals only when extraction legitimately changes the interface.
- [x] Run `npm run lint`, `npm test`, and `npm run test:packages`; report exact evidence. Update affected compatibility statements and public PostgreSQL guide to v3.1.0 semantics. Commit task files, write the task report, and request controller review.

### Task 2: Expose shared helpers and optional MCP without MongoDB

- [x] Move current upstream auth, validators, scalar helpers and count plugins into shared modules; retain root compatibility exports. Place MCP in an optional workspace with SDK dependency and preserve the current tool contract. Add public package exports/types and isolated install tests for both backends and MCP; run current auth/MCP test suites.

### Task 3: Complete embedded schema constraints and uniqueness

- [x] Extend metadata/DDL/initialization with owner-aware embedded/multikey uniqueness and required embedded consistency; prove duplicate-within-owner, conflict-across-owner, null/absent, FK and direct SQL behavior against MongoDB and PostgreSQL. Record exact mapping and intentional unsupported shapes in docs.

### Task 4: Complete embedded and scalar-list query parity

- [ ] Differentially test scalar lists within embedded lists, array facts and grouping projections with absent/null values. Add typed presence representation/compiler support required for equal results. Preserve cardinality, order, filters, enum/date values and bounded query inputs; retain explicit errors for documented unsupported whole-object operations.

### Task 5: Deliver library packages, documentation and release preparation

- [ ] Integrate PostgreSQL into VitePress guides/reference/navigation and startup examples. Adapt upstream manual release workflow to the workspace dependency order. Run full MongoDB/PG15/16/18, package installation/types, lint and docs build checks, then independent review and commits.

### Task 6: Port and exercise barber on PostgreSQL

- [ ] Create an isolated local `codex/postgresql` worktree from barber main. Inventory GraphQL metadata/controllers/scripts/native persistence; preserve frontend API. Install actual library archives, replace native database operations, add PostgreSQL Docker/seed/startup configuration and migration notes. Run backend tests and real API scenarios, inspect generated FKs, check frontend, and review/commit the runnable application.

### Task 7: Final delivery verification

- [ ] Re-run checks affected by final fixes, verify clean task branches and documented startup from fresh local data. Provide branch/worktree paths, test results, any remaining declared limitations, and commands to use the completed library and application.
