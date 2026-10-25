# Controller After-Commit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

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

**Files:** create `packages/core/src/transaction-callbacks.js`, `tests/transaction-callbacks.test.js`, `tests/after-commit-transactions.test.js`; modify core package exports, MongoDB `mongo/{transactions,adapter,integrity}.js`, SQL `{transactions,adapter}.js`. Run `tests/mutation-transactions.test.js` and `tests/sql-transactions.test.js` unchanged as regression coverage.

**Interfaces:** `createTransactionCallbacks()` returns `begin(session)` with `seal()`, `confirm()`, `discard()`, `drain()`; `enqueue(session, run): boolean`. Adapter exposes `enqueueAfterCommit(session, run)`.

- [x] Write failing queue tests: distinct attempts on same session; only confirmed queue drains, FIFO once; sealed/foreign sessions reject enqueue; discard releases jobs; reentrant independent queue.
- [x] Run `npx vitest run tests/transaction-callbacks.test.js` and observe missing feature failure.
- [x] Implement the helper and wire owned attempts in both runners. Seal before commit, discard on failure, confirm before cleanup, drain in cleanup's finally outside retry catches. Mongo integrity and default mode share the adapter's collector.
- [x] Test actual runner behavior with driver stubs: retries discard preceding work; uncertain commit retries retain once; exhausted uncertainty sends nothing; cleanup rejection still dispatches; SQL releases before effects.
- [x] Run focused transaction suites, inspect failures, then commit the task.

### Task 2: Controller API, payloads and declarations

**Files:** create `packages/core/src/after-commit.js`, `tests/after-commit.test.js`; modify core runtime/types, Mongo/Postgres facade exports/types, SQL type re-exports, packed consumer assertions in `scripts/test-packages.js` as needed.

**Interfaces:** approved four callbacks and `runtime.configureAfterCommit({ onError })`; optional `DatabaseAdapter.enqueueAfterCommit`. Runtime helper owns configuration, validation, snapshots, per-runtime warning/reporting and guarded registration.

- [x] Write failing public-runtime tests for four operations, child-before-parent ordering, state callback exclusivity, supplied context, no-op delete, rollback/retry, callback/reporting failure isolation, external-session skip warning, mutable controller validation and snapshot isolation.
- [x] Run `npx vitest run tests/after-commit.test.js` and confirm failures are missing notifications/configuration.
- [x] Implement helpers, use existing lifecycle completion sites, pass action name without occupying OCC's precondition parameters; preserve opaque scalar instances and cycle-safe ordinary copies.
- [x] Define shared `AfterCommitOptions`, `AfterCommitErrorDetails`, callback signatures and adapter contract. Expose configuration on Mongo/Postgres facades and SQL runtime; extend packed consumer compile coverage.
- [x] Run focused suites and core subpath declaration checks; commit.

### Task 3: Real database contracts and documentation

**Files:** create `tests/integration/after-commit.test.js`; update README and controllers/mutations/state-machines/server-side-operations/API/adapter-author guides, matching architecture/core/testing rules.

- [x] Add real MongoDB (off/transactional integrity) and PostgreSQL tests for independent-read visibility, nested writes, legacy hook rollback, retries, callback failure, transitions, external Mongo sessions, SQL public transaction wrapper and one-client pool reentrancy.
- [x] Provision only disposable task-owned Mongo replica-set and PostgreSQL containers, with synthetic data and unique ports/names. Record URIs without reading consumer credentials.
- [x] Run focused database contracts and full `npm test` with all relevant disposable URI variables; run `npm run lint`, `npm run test:packages`, `npm run docs:install`, `npm run docs:build`. Record skips and failures exactly.
- [x] Document public contract, limitations and examples for both backends; commit.

### Task 4: OCC integration check and final review

**Interfaces:** #147's version checks/preconditions remain intact; #142/#100 reuse existing lifecycle helpers and the same owner queue.

- [x] Refresh PR #147 status/head without changing other worktrees. In this worktree only, apply a temporary combined checkout or patch on a temporary local branch, resolve only demonstrated shared lifecycle integration, and run after-commit plus OCC/database contracts. Return to the task branch; retain separate evidence, not unrelated PR changes.
- [x] Run one independent whole-branch review as required by executing-plans; resolve important findings with regression tests.
- [x] Verify final diff, tests and clean task branch; record evidence in a local repository report. Leave all work local and report exact blockers, if any.

Initial evidence: [local verification report](../reports/2026-10-23-controller-after-commit-verification.md). The user subsequently authorized publishing [PR #150](https://github.com/simtlix/simfinity.js/pull/150) and correcting its review; the separate OCC evidence branch remains local and unmerged.

### Review follow-up (2026-10-25)

- [x] Reproduce and fix ESLint provenance loss after `configureAfterCommit`, keeping the plugin's existing analysis boundaries.
- [x] Pin facade runtime exports, reporter context identity, invalid controllers, continued dispatch, registered mutation ownership/rollback and transitions with children.
- [x] Add real database rollback cases after an earlier child write for missing IDs and unique constraint violations.
- [x] Correct SQL session guidance and lifecycle terminology; add error codes, callback/outbox cross-links, upgrade notes and a compatibility ledger. Keep the approved static-only default logging contract.
- [x] Check the public runtime tests against the actual 3.12.0 base, then restore this branch and verify the final changes with disposable databases, packed consumers, docs and the independent ESLint plugin checks.
- [x] Record fresh evidence and prepare the authorized PR update without merging or publishing a release.

The [review-corrections report](../reports/2026-10-25-after-commit-review-corrections.md) distinguishes the initial full pass, a later timeout after the security dependency update, and the unchanged affected suite's isolated pass. It also records the required security fix, package checks and limits of the historical OCC evidence. The PR's final CI checks are separate from local verification.
