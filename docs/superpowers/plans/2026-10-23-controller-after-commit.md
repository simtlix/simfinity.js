# Controller After-Commit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved controller callbacks after confirmed commits, without changing existing transactional hooks.

**Architecture:** Core captures operation notifications and guards reporting. An instance-local queue shared by each adapter's transaction owner and runtime separates attempts, commit confirmation, cleanup and dispatch. MongoDB/SQL retain driver-specific retry behavior.

**Tech Stack:** JavaScript ES modules, Node 24 development / >=18.18.0 consumers, GraphQL 16, Mongoose 8, pg, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-23-controller-after-commit-proposal.md` (six decisions approved in this session).

## Global Constraints

- Own worktree/branch only; base `738767141ecb3e017a9a590e52c7e1a795f68428`; no merge, publication or release bump.
- Preserve legacy hooks, middleware, authorization, session validation, cleanup error identity and retry limits.
- No driver imports in core/SQL, global queue, external-session commit inference or generic public enqueuing API.
- Serial callbacks after cleanup attempt, no session argument, original context, per-attempt payload copy; opaque scalar instances remain opaque.
- Outbox remains required for durable delivery; manual savepoint/transaction control is outside the owner contract.

## Review Focus

- Retry-shaped callback or reporter failures cannot cause retries or rollback (Task 1/2 tests).
- Cleanup failure after commit still dispatches and preserves the cleanup rejection (Task 1 tests).
- A changed controller after schema creation cannot silently bypass adapter capability validation (Task 2 tests).
- Nested transitions do not double-send update notifications, and callback writes do not deadlock a one-client pool (Task 2/3 tests).
- Shared scalar/cyclic result structures cannot leak ordinary mutable payloads into later callbacks (Task 2 tests).

### Task 1: Queue and owned transaction integration

**Files:** create `packages/core/src/transaction-callbacks.js`, `tests/transaction-callbacks.test.js`; modify core package exports, MongoDB `mongo/{transactions,adapter,integrity}.js`, SQL `{transactions,adapter}.js`, `tests/mutation-transactions.test.js`, `tests/sql-transactions.test.js`.

**Interfaces:** `createTransactionCallbacks()` returns `begin(session)` with `seal()`, `confirm()`, `discard()`, `drain()`; `enqueue(session, run): boolean`. Adapter exposes `enqueueAfterCommit(session, run)`.

- [ ] Write failing queue tests: distinct attempts on same session; only confirmed queue drains, FIFO once; sealed/foreign sessions reject enqueue; discard releases jobs; reentrant independent queue.
- [ ] Run `npx vitest run tests/transaction-callbacks.test.js` and observe missing feature failure.
- [ ] Implement the helper and wire owned attempts in both runners. Seal before commit, discard on failure, confirm before cleanup, drain in cleanup's finally outside retry catches. Mongo integrity and default mode share the adapter's collector.
- [ ] Test actual runner behavior with driver stubs: retries discard preceding work; uncertain commit retries retain once; exhausted uncertainty sends nothing; cleanup rejection still dispatches; SQL releases before effects.
- [ ] Run focused transaction suites, inspect failures, then commit the task.

### Task 2: Controller API, payloads and declarations

**Files:** create `packages/core/src/after-commit.js`, `tests/after-commit.test.js`; modify core runtime/types, Mongo/Postgres facade exports/types, SQL type re-exports, packed consumer assertions in `scripts/test-packages.js` as needed.

**Interfaces:** approved four callbacks and `runtime.configureAfterCommit({ onError })`; optional `DatabaseAdapter.enqueueAfterCommit`. Runtime helper owns configuration, validation, snapshots, per-runtime warning/reporting and guarded registration.

- [ ] Write failing public-runtime tests for four operations, child-before-parent ordering, state callback exclusivity, supplied context, no-op delete, rollback/retry, callback/reporting failure isolation, external-session skip warning, mutable controller validation and snapshot isolation.
- [ ] Run `npx vitest run tests/after-commit.test.js` and confirm failures are missing notifications/configuration.
- [ ] Implement helpers, use existing lifecycle completion sites, pass action name without occupying OCC's precondition parameters; preserve opaque scalar instances and cycle-safe ordinary copies.
- [ ] Define shared `AfterCommitOptions`, `AfterCommitErrorDetails`, callback signatures and adapter contract. Expose configuration on Mongo/Postgres facades and SQL runtime; extend packed consumer compile coverage.
- [ ] Run focused suites and core subpath declaration checks; commit.

### Task 3: Real database contracts and documentation

**Files:** create `tests/integration/after-commit.test.js`; update README and controllers/mutations/state-machines/server-side-operations/API/adapter-author guides, matching architecture/core/testing rules.

- [ ] Add real MongoDB (off/transactional integrity) and PostgreSQL tests for independent-read visibility, nested writes, legacy hook rollback, retries, callback failure, transitions, external Mongo sessions, SQL public transaction wrapper and one-client pool reentrancy.
- [ ] Provision only disposable task-owned Mongo replica-set and PostgreSQL containers, with synthetic data and unique ports/names. Record URIs without reading consumer credentials.
- [ ] Run focused database contracts and full `npm test` with all relevant disposable URI variables; run `npm run lint`, `npm run test:packages`, `npm run docs:install`, `npm run docs:build`. Record skips and failures exactly.
- [ ] Document public contract, limitations and examples for both backends; commit.

### Task 4: OCC integration check and final review

**Interfaces:** #147's version checks/preconditions remain intact; #142/#100 reuse existing lifecycle helpers and the same owner queue.

- [ ] Refresh PR #147 status/head without changing other worktrees. In this worktree only, apply a temporary combined checkout or patch on a temporary local branch, resolve only demonstrated shared lifecycle integration, and run after-commit plus OCC/database contracts. Return to the task branch; retain separate evidence, not unrelated PR changes.
- [ ] Run one independent whole-branch review as required by executing-plans; resolve important findings with regression tests.
- [ ] Verify final diff, tests and clean task branch; record evidence in a local repository report. Leave all work local and report exact blockers, if any.
