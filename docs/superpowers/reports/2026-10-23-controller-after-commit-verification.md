# Controller after-commit callbacks — local verification

Issue: [#143](https://github.com/simtlix/simfinity.js/issues/143). The user approved the six decisions in the [proposal](../specs/2026-10-23-controller-after-commit-proposal.md) on 2026-10-23. This report covers local implementation and verification; it is not a merge or release approval.

## Revisions and scope

- Base: remote `master`, `738767141ecb3e017a9a590e52c7e1a795f68428` (3.12.0).
- Task branch: `feat/143-controller-after-commit`. Implementation through `d50098b8eacea4167db53c24efacd961f159ce66`; subsequent changes to this report, the proposal checkpoint and plan status are documentation only.
- [PR #147](https://github.com/simtlix/simfinity.js/pull/147) was still open at `f6efefb511de5ca5e3d2a66d305999d60642623e` when refreshed during verification. Its base was the same `7387671`.
- [PR #148](https://github.com/simtlix/simfinity.js/pull/148) was still open at `fb91b1f2eefdfc56ddc5f938943dbfb2dae5cf70`, with the same base. No dependency was demonstrated and none of its changes were included.
- Work, including the temporary OCC combination, stayed in this session's worktree. No remote issue/PR, other worktree, consumer application, release version, tag or publication was changed.

## Delivered contract

The optional controller members are `onSaveCommitted(record, args, context)`, `onUpdateCommitted(record, context)`, `onDeleteCommitted(record, context)` and `onTransitionCommitted(record, action, context)`. Existing hooks remain inside the transaction. State actions dispatch the transition callback only.

Each adapter owns a queue per transaction attempt. Nested lifecycle writes and lifecycle calls in registered mutations join that queue. SQL's public transaction wrapper uses the same owner. A retry/abort discards its queue; uncertain MongoDB commits retain it while retrying commit and dispatch only after confirmation. Confirmed jobs run serially after cleanup has been attempted, outside retry/rollback catches. Child completion precedes parent completion. Callback/reporter failures cannot cause the confirmed write to be retried or reported as rolled back. Existing cleanup failures retain their own rejection behavior.

Core captures ordinary payload snapshots and the original context reference. Opaque scalar instances keep their identity. Runtime-local `configureAfterCommit({ onError })` reports callback failures; its guarded default logs static operation metadata. The adapter's optional `enqueueAfterCommit` capability rejects unsupported callback configurations explicitly. Native externally owned MongoDB sessions are not observed: callbacks are skipped and warned once per runtime/type.

Declarations, packed consumer checks, root/package READMEs, public controller/mutation/state-machine/server-operation/API/plugin guides and matching repository rules were updated. Core and SQL remain driver-free.

## Environment and evidence

Development used Node.js 24.2.0. All database checks used task-owned disposable Docker databases with synthetic records and separate MongoDB databases/PostgreSQL schemas. No consumer database or credentials were used. Versions queried from the running servers: MongoDB 7.0.37 and 8.0.32; PostgreSQL 15.19, 16.14 and 18.6. The main full-suite environment also supplied MongoDB 8 standalone.

Local raw logs are in the ignored `.superpowers/sdd/2026-10-23-controller-after-commit/` directory. They are session artifacts, not package files. All six task-owned database containers and their anonymous volumes were removed after verification; other containers were left untouched.

| Check | Revision/environment | Result |
| --- | --- | --- |
| Queue and transaction runners, including existing suites | Feature implementation | 104 passed |
| Runtime and declaration checks after review correction | `d50098b` | 56 passed |
| New database contract | MongoDB 8 off/transactional integrity + PostgreSQL 16 | 21 passed; 3 backend-inapplicable skips |
| New database contract + both existing transaction suites + new runner suite | `d50098b`, MongoDB 7/PostgreSQL 15 | 121 passed; 3 backend-inapplicable skips |
| Same four suites | `d50098b`, MongoDB 8/PostgreSQL 18 | 121 passed; 3 backend-inapplicable skips |
| Final full `npm test -- --maxWorkers=1` | `d50098b`, MongoDB 8 replica set/standalone + PostgreSQL 16 | 153 files passed; 5,269 tests passed, 6 skipped; 332.61 seconds |
| `npm run lint` | `d50098b` | Passed |
| Final `npm run test:packages` | `d50098b` | Passed: all five archives score 100/100; six isolated runtime/strict TypeScript consumers passed |
| `npm run docs:install` and `npm run docs:build` | Public guides and final report | Passed; final build 12.88 seconds, with the existing bundle-size warning |

The full-suite command sources four disposable variables: `SIMFINITY_MONGODB_URI`, `SIMFINITY_TEST_MONGODB_URI` (a different database), `SIMFINITY_STANDALONE_MONGODB_URI`, and `SIMFINITY_POSTGRES_URI`. The version-matrix command is:

```sh
npx vitest run tests/integration/after-commit.test.js \
  tests/after-commit-transactions.test.js tests/mutation-transactions.test.js \
  tests/sql-transactions.test.js --maxWorkers=2
```

The matrix rows are focused contracts; they are not full-suite runs on PostgreSQL 15/18 or MongoDB 7. The database retry case injects a retryable failure after real writes; separate runner tests drive commit uncertainty, failed commits, abort failure, cleanup rejection and retry exhaustion. These are distinct forms of evidence.

### Failures investigated

The initial unconstrained full run overlapped package builds and overloaded the shared host (load average about 36), causing timeouts in several pre-existing suites and the new integration suite. Only this session's test process tree was stopped. A subsequent complete run with two workers had 151 passing files, 5,255 passing tests, two PostgreSQL emptiness-test timeouts and one MongoDB standalone preparation-hook timeout (18 skipped tests). It is retained as a failed run, not counted as a pass.

Both affected emptiness suites were then rerun together with one worker and their original assertions/timeouts: **111 passed in 32.67 seconds**. Their failing combined-run durations had been 164.05 and 104.07 seconds. This supports resource contention as the cause; no product change or timeout increase was made for those failures. The final full run with one worker then passed all 153 files, as recorded separately above.

The initial strict-Mongo external-session fixture lacked the already-required snapshot/majority transaction options. Correcting the fixture made all applicable database cases pass. No runtime behavior was weakened.

## OCC integration evidence

Temporary branch `codex/143-occ-integration`, commit **`6acc1f66d6f1215c729030bbb395b382e07ad13a`**, preserves the exact tested combination. It starts from `d50098b` and applies #147's `packages/`, `tests/` and `scripts/` changes with a three-way patch in the same worktree. It is a separate local evidence branch, not a merge into the task branch.

Five conflict blocks in `packages/core/src/runtime.js` required preserving both behaviors: callback validation in delete/update/state helpers, OCC preconditions and version checks, awaited operation results, and notification registration after successful lifecycle completion. The SQL README conflict was resolved by retaining both independent contracts. #147's optional positional precondition arguments remained intact; this feature queues at caller completion sites instead of occupying those argument slots.

The combined branch includes `tests/integration/after-commit-occ.test.js`, with three scenarios on each of MongoDB off, MongoDB transactional integrity and PostgreSQL:

1. Successful save/update/state/delete callbacks carry confirmed revisions; stale update/state/delete attempts emit nothing.
2. A later stale child discards an earlier added child's notification and rolls back its write. A corrected version then emits child-before-parent callbacks once.
3. A retry after real nested writes retains the requested parent version, advances it once and emits only the committed attempt's notifications.

Combined verification:

- Five focused lifecycle/queue/declaration suites: **137 passed**.
- Ten focused OCC/callback/declaration suites: **373 passed, 2 skipped**. The skipped cases were MCP SDK database contracts because that particular unit-focused command did not set database URIs; it is not evidence for those two cases.
- Six real-database suites (new OCC+callback interaction, ordinary after-commit, OCC MongoDB, OCC PostgreSQL, OCC parity and PostgreSQL version-column): **226 passed, 3 backend-inapplicable skips**, MongoDB 8/PostgreSQL 16.
- PostgreSQL statement/storage/conditional-write suite: **43 passed**.
- ESLint on the resolved lifecycle file and new interaction test: passed.

These combined results establish coexistence at the pinned #147 head; they do not replace #147's review or full validation. The task worktree was returned to `feat/143-controller-after-commit` before final package/full-suite verification. #147 source files and its temporary interaction test are absent from this branch.

## Review and future integration

One independent read-only final review covered `7387671..a48482f`, before the final correction. It found no critical/important issue in ownership, retries, cleanup or transition dispatch; it did not independently run suites and explicitly left database/OCC verification to the implementer. It found two minor issues: sparse arrays lost trailing holes during snapshotting, and MongoDB's `configureAfterCommit` declaration inherited the wrong JSDoc. The payload defect was treated as a correctness fix: its regression failed with length 1 instead of 3, then passed after preserving the original array length. Both findings were corrected in `d50098b`; no second review was requested.

Future #142/#100 operations must enter the same adapter-owned transaction, run the existing lifecycle/authorization path, and register exactly one callback at successful lifecycle completion. A new caller of `onUpdateSubject` or `onDelete` must preserve that registration boundary; calling a helper alone is not enough. No programmatic update/delete API, dispatcher or repository abstraction was invented here.

Delivery remains best effort: process failure, resubmission and external-service behavior can lose or duplicate effects. Durable delivery requires a transactional outbox and workers. Manual savepoint rollback or external commit/abort inside an owned operation is outside this queue's contract. Later changes to #147 or lifecycle code need a new combined check before integration. No external blocker remains for this local scope. Remote CI, review, merge and publication remain outside this local assignment.
