# Controller callbacks after commit — proposal for #143

Status: proposed, not approved or implemented. All new API names below are recommendations, not an accepted public contract. This document is the local decision checkpoint requested for this session.

## Source and scope

- [Issue #143](https://github.com/simtlix/simfinity.js/issues/143) was read with its current comments on 2026-10-23. It is open, has no comments, and was last updated on 2026-10-21. Its six API questions remain open.
- The checkout and remote `master` were both `738767141ecb3e017a9a590e52c7e1a795f68428`, version 3.12.0. Work is isolated on `feat/143-controller-after-commit`.
- [PR #147](https://github.com/simtlix/simfinity.js/pull/147) is open at `f6efefb511de5ca5e3d2a66d305999d60642623e`. Its lifecycle diff was inspected without checking out or modifying that branch.
- [PR #148](https://github.com/simtlix/simfinity.js/pull/148) is open at `fb91b1f2eefdfc56ddc5f938943dbfb2dae5cf70`. There is no demonstrated dependency on it; do not include its implementation.
- No merge, remote feedback, release version change, or publication is authorized here.

The goal is best-effort process-local effects after a confirmed commit, while preserving every existing transactional hook. Durable delivery still requires a transactional outbox and a worker. This feature cannot promise exactly-once external delivery, survive process failure, or prevent duplicates from an application resubmitting a request.

## Existing implementation to extend

`packages/core/src/runtime.js` already owns `onSaveObject`, `onUpdateSubject`, `onDelete`, `onStateChanged`, `executeItemFunction`, `saveObject`, and `executeRegisteredOperation`. Reuse these paths. Do not build a parallel CRUD dispatcher or change authorization/middleware behavior.

The MongoDB runner in `packages/mongodb/src/mongo/transactions.js` owns commit/abort/retries only when no session was supplied. It reuses one session for successive attempts. Commit uncertainty retries the commit only; it never replays the body. The integrity adapter also enters this runner and must receive the same new queue support.

`packages/sql/src/transactions.js` owns SQL attempts and creates a new session handle per attempt. It closes the handle before commit, releases the client after the attempt, and retries only confirmed aborts. `createSQL().withTransaction()` already delegates to that runner. PostgreSQL's plugin owns physical commit and must continue rejecting a COMMIT whose command result is ROLLBACK.

Registered mutations already own a transaction. A `saveObject(..., session, context)` inside one borrows that active transaction; this is different from a session whose owner is wholly outside Simfinity.

## Approaches

1. **Four controller members with an adapter-owned attempt queue (recommended).** Fits the existing controller surface, gives state actions an unambiguous notification, and observes commit where it actually happens. Requires a small optional adapter contract for queue registration.
2. **One `onCommitted(event)` controller member with the same queue.** A discriminated event is easier to extend to more operation kinds, but makes every controller dispatch on operation and needs a larger new payload contract. Its transaction guarantees would be identical.
3. **An explicit caller-managed effect batch, including externally committed sessions.** Supports external owners, but adds a public prepare/confirm/discard protocol and makes correctness depend on the caller reporting commit outcomes and retry boundaries. Defer this instead of guessing that a borrowed session committed.

A runtime-only `await adapter.withTransaction(...); flush()` is insufficient: borrowed calls return before their owner's commit, SQL's public transaction wrapper bypasses a runtime-only collector, and an owned call can reject during cleanup after successfully committing.

## Decisions proposed for approval

| Issue question | Recommended contract |
| --- | --- |
| 1. Names | `onSaveCommitted(record, args, context)`, `onUpdateCommitted(record, context)`, `onDeleteCommitted(record, context)`, `onTransitionCommitted(record, action, context)` |
| 2. Supplied sessions | Join a queue only when this adapter already owns the active attempt. For an external owner, skip new callbacks and warn once per runtime/type about the unsupported notification boundary. Keep the writes and existing hooks unchanged. No automatic observation, method patching, or manual confirmation API in this scope. |
| 3. Callback failures | Add runtime-local `configureAfterCommit({ onError })`; `onError(error, details)` receives the original failure and `{ committed: true, typeName, operation, callbackName, context }`. Catch its failures too. Default/fallback reporting logs static operation metadata without records, input, context, or driver error contents. It never changes the successful mutation result. |
| 4. Order and waiting | Serial FIFO, awaited before returning from the owning transaction call. One callback failure is reported and does not stop later callbacks. No automatic callback retry, parallel execution, background queue, or timeout. Applications bound their own external I/O. |
| 5. State actions | A transition emits only `onTransitionCommitted`, with `action` equal to the registered action-name string. Existing `onUpdating`/`onUpdated` still run unchanged. Ordinary updates emit `onUpdateCommitted`. |
| 6. Registered mutations | Their lifecycle writes automatically join their owned queue. Do not add a generic public function for arbitrary after-commit closures yet. Direct native model writes remain outside controller callbacks. |

`configureAfterCommit` is per runtime, exposed by the existing facades, with an optional function `onError`; calling it without options resets reporting to the default. Invalid/unknown options fail before changing configuration. Configuration errors and unsupported adapter capability are setup errors, not post-commit callback errors. Their exact error-code spelling is left to implementation conventions.

## Queue ownership and state

Add a driver-free internal queue factory in core, instantiated separately by each bundled adapter. No process-global session registry and no business data added to GraphQL context or native session objects. The adapter exposes an optional `enqueueAfterCommit(session, run): boolean` capability: true means it accepted the job into its currently owned attempt; false means it does not own that session's attempt. Core registers guarded jobs through that capability.

Adapters without this capability retain current behavior when no new callbacks are configured. Configuring a new callback against an unsupported adapter must fail explicitly, before its write, rather than silently claim support. Validate at schema setup and at operation entry to cover mutable controller objects. The optional method and its guarantees belong in `DatabaseAdapter` declarations and adapter-author documentation.

Each attempt has a fresh identity, state, ordered jobs, and a session association. The native session alone is not the attempt identity. Begin creates the association, nested joins reuse it, and completion removes it. Registration is accepted only while the attempt is active. Each queued job captures its controller function/receiver, payload, context, and runtime error reporter; later configuration changes do not change that job.

Lifecycle:

1. Begin an owned attempt and attach its empty queue before invoking the body.
2. Queue an operation only after that operation's write, nested operations, legacy hooks, and result normalization succeed. A missing delete result queues nothing. A create is a create notification even when it initializes a state machine.
3. Before commit, close registration. A rejected body discards the whole attempt queue. Rollback failures retain the existing primary-error and no-retry behavior.
4. A confirmed abort discards that queue before backoff and the next attempt. MongoDB's next attempt gets a new queue even though its session object is reused.
5. MongoDB's commit-only retry retains the sealed queue without dispatching it. Exhausted/expired uncertainty dispatches nothing: the write outcome is unknown, not known to be rolled back. SQL does not replay uncertain commits.
6. A successful commit marks the queue confirmed independently of cleanup. Remove its session association, attempt cleanup/release, then drain it exactly once in this process, outside every transaction rollback/retry catch block.
7. Clear retained jobs and payload references when discarded or drained. Callback failures cannot turn the queue back into an active attempt.

The existing cleanup-error contract is preserved: `tests/mutation-transactions.test.js` explicitly requires an awaited `endSession()` failure after successful commit to reject the call. Such an error must still propagate unchanged, but the confirmed queue must drain even if cleanup throws. A cleanup error means cleanup failed after commit; it does not mean rollback and is never a reason to replay writes. Do not silently change this separate 3.x behavior while introducing callbacks.

No callback runs with the old active session. Cleanup is attempted before callbacks so PostgreSQL effects can acquire a pool connection even with `max: 1`. A callback that starts another Simfinity operation creates an independent transaction with its own queue.

## Nested operations, context, and payload

Queue at lifecycle completion, so nested operations finish and enqueue before their parent. Preserve the existing field traversal and item order: each collection's `added`, then `updated`, then `deleted`, with array order inside each group. Serial programmatic operations inside a registered mutation follow their completion order. No ordering guarantee spans independent transactions or concurrent operations started by application code.

Reference collection children have their own controller notifications; embedded values and native database cascades do not invent child lifecycle events. Children created by a transition keep their own create/update/delete notifications; only the transitioning parent's update notification is replaced by its transition notification.

Pass the same context reference supplied to that individual operation, including `undefined`. Do not clone it, attach an effects array to it, mutate it for bookkeeping, or derive an inner operation's context from a different root. Transaction retries can already mutate application context; the framework does not restore those application changes.

Use a detached plain representation of the operation result through the existing adapter conversion, not a Mongoose document with a live session. Capture after legacy hooks and state normalization, before returning the operation result. Copy plain objects/arrays and Dates so later mutations of ordinary result/input structures cannot rewrite queued notifications. Preserve opaque custom scalar values rather than JSON-serializing them or stripping their prototypes; their internals must be treated as immutable, as with existing typed input copying. Do not claim a universally deep-immutable snapshot. Preserve backend identifier/scalar representations and existing storage-field names; this is not a GraphQL selection or a new normalized DTO schema.

Creation `args` are the successful attempt's inner input, captured at operation completion. Delete receives the actual deleted record returned by the adapter, not the earlier hook pre-read. State `record.state` follows the existing operation's returned enum value. Multiple operations on one entity generate multiple notifications; payloads describe each completed operation, not a fresh read of the entity's final transaction state.

In the state path, carry `actionName` explicitly from the generated resolver and suppress only the parent's new update notification. Do not change existing positional preconditions that #147 adds to `onUpdateSubject` and `onDelete`.

## Transaction control outside the owner

| Call | Proposed behavior |
| --- | --- |
| Generated mutation or `saveObject` without session | Owned attempt and dispatch after its confirmed commit |
| `saveObject` with the session of a registered mutation | Join the outer owned attempt; no early dispatch |
| `saveObject` inside SQL's existing `withTransaction(null, ...)` | Join that adapter-owned attempt and dispatch after the outer commit |
| Native MongoDB session supplied by application code | Existing active-session checks and write semantics; skip new callbacks, warn, and retain external ownership |
| Arbitrary `pg.Client` supplied as a SQL session | Keep existing `INVALID_SESSION` rejection; no new acceptance |
| Session from another adapter instance | Keep existing validation; if accepted for MongoDB writes but not owned by this adapter, no notification guarantee and no queue adoption |

The queue observes the owner's complete transaction attempts, not arbitrary native savepoints, manual commits/aborts inside the body, or an application restarting a transaction on the same session. A raw `ROLLBACK TO SAVEPOINT` after a successful lifecycle operation cannot rewind its notification queue. Do not advertise that combination as supported. Statement-only savepoints that do not undo queued lifecycle work retain their current use. Supporting nested lifecycle rollback scopes needs an explicit coordinated savepoint API, outside this proposal.

Applications must let lifecycle failures propagate to the owning transaction. Catching such a failure inside a registered callback and then committing does not roll back its already-performed writes today; this proposal does not invent nested atomicity or a rollback-only flag. The full transaction abort/retry guarantee assumes the owner controls transaction completion.

## Failure taxonomy

| Outcome | Writes | Notification queue | Caller result |
| --- | --- | --- | --- |
| Validation, authorization, legacy hook, or definite commit failure | Existing rollback semantics | Discard | Existing error |
| Retryable confirmed abort | Retry using existing limits/backoff | Discard; fresh queue next attempt | Successful attempt or existing exhausted-retry error |
| Unknown commit result | May have committed | Retain during commit-only retry; discard on unresolved exit | Existing uncertainty error; reconcile before resubmitting |
| Confirmed commit, callback throws/rejects | Committed | Report failure and continue | Existing successful operation result |
| Error reporter throws/rejects | Committed | Guard fallback report and continue | Existing successful operation result |
| Cleanup failure after confirmed commit | Committed | Still drain after cleanup attempt | Existing cleanup rejection, unchanged |
| Process exits after commit | Committed | Delivery may be absent or partial | No delivery guarantee; use outbox for durable intent |

Callback failures must remain operational failures even if the thrown value resembles a MongoDB transient label or a SQL serialization/deadlock error. Never route them through adapter error normalization or retry classification. Guard non-Error throws and logger failures as well. No callback-generated GraphQL errors/extensions and no masking of the successful write as a rollback.

## Integration points

For #147, retain expected/observed version capture, visibility-sensitive conflict handling, nested ownership checks, conditional-write options, and returned-version validation. Enqueue only after all those checks and the legacy hook finish. A child conflict or final controller failure discards all preceding jobs of that attempt. Re-run an actual combined implementation against the then-current #147 head in this session's own isolated checkout before any final integration; the diff inspection here is not test evidence.

For [#142](https://github.com/simtlix/simfinity.js/issues/142), future programmatic update/delete operations should use these existing lifecycle helpers and enqueue once through them. No implementation dependency or speculative public functions are introduced here.

For [#100](https://github.com/simtlix/simfinity.js/issues/100), a future multi-operation transaction owns one attempt queue for its entire list; each item joins it, and only the outer commit can dispatch. Preserve each item's supplied context. Multiple current GraphQL mutation root fields still have separate transactions.

Core owns lifecycle payloads and reporting; the reusable queue helper has no driver imports. MongoDB and SQL own attempt boundaries; PostgreSQL retains only its physical driver responsibilities. Existing middleware and Envelop authorization remain untouched.

## Required implementation and verification after approval

1. Extend core controller/runtime/adapter declarations, facade exports and MongoDB's existing controller declaration consistently. Re-export shared new types from core; avoid new duplicate definitions. Add an internal core export only for the queue factory needed by bundled adapters. Update packed TypeScript consumers/export assertions for new public values.
2. Add meaningful tests to the existing runtime/transaction suites, plus focused after-commit suites. Cover success, no-op delete, nested traversal, state-only notification, context identity/undefined, snapshot isolation, per-runtime reporter isolation, and callbacks initiating independent transactions.
3. Exercise both transaction runners: body retry, definite commit retry, commit-only uncertainty, exhausted uncertainty, exhausted conflicts, abort failure, cleanup failure after success, and a callback/reporter throwing retry-shaped or non-Error values. Assert actual job counts and order, not elapsed time.
4. Use newly provisioned disposable databases only: MongoDB replica set with integrity both off and transactional, and PostgreSQL with its own unique schema/database. Assert visibility through a separate connection inside the callback; deletion must already be visible. Include SQL pool `max: 1`, nested rollback, legacy hook failure, registered mutations, borrowed external MongoDB sessions, same MongoDB session reused for a later attempt/transaction, and the existing SQL public transaction wrapper.
5. Retain `tests/mutation-transactions.integration.test.js` coverage via `SIMFINITY_TEST_MONGODB_URI` as well as other MongoDB suites via `SIMFINITY_MONGODB_URI`; PostgreSQL uses `SIMFINITY_POSTGRES_URI`. Run the full root suite with those fresh fixture URIs, not only `tests/integration/`. Cover the repository's PostgreSQL 15/16/18 and MongoDB 7/8 compatibility matrix in the applicable CI/integration run.
6. Run `npm run lint`, `npm test`, `npm run test:packages`, and documentation install/build on this implementation's actual base. Extend README, controllers/mutations/state-machines/server-side-operations/API/adapter-author guides and relevant rules. Document external ownership, cleanup distinctions, savepoint limits, and outbox requirements explicitly.
7. Repeat the lifecycle/OCC contract on the combined #147 implementation and record exact commits, versions, commands, test counts, skips, and remaining external blockers. Do not reuse tests from another checkout/base.

The current checkout has Node 24.2.0 and a responding Docker engine. It has no installed root `node_modules`. No dependency installation, database creation, runtime tests, package checks, or documentation build have been performed for this proposal. Those checks are pending implementation approval, not passing evidence.

Proposal verification on 2026-10-23: an independent read-only builder review found no additional material decisions beyond the six pending recommendations. The document passed `git diff --no-index --check`; all five explicitly referenced local source/test files exist. A content check found no private consumer identifiers or local absolute paths. This is design verification only, not runtime or database verification.

## Decision to resume this session

Approve or revise the six recommendations in the decision table, especially the four names, external-session skip policy, error reporter, and separate transition callback. After approval, write the implementation plan and implement/test in this branch. The existing hooks and public middleware compatibility are not part of that decision and remain preserved.
