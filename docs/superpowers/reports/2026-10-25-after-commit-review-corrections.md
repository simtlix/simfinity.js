# After-commit callbacks: PR #150 review corrections

This records corrections to the [2026-10-25 review](https://github.com/simtlix/simfinity.js/pull/150#pullrequestreview-5643722229) of [PR #150](https://github.com/simtlix/simfinity.js/pull/150), for [issue #143](https://github.com/simtlix/simfinity.js/issues/143). The user authorized the proposed corrections and updating the PR. Merge, release versioning and publication remain outside this task.

## Scope and decisions

The reviewed head was `c6bf164398721c2408ac06db33ed9ef19ca1743e` on base `738767141ecb3e017a9a590e52c7e1a795f68428` (3.12.0). Corrections first reached `e8350749ca1720f91d225d5f54a000b91a9a4c5b` on that base, beginning with `e541a91c7472deea1728da7e5bda742814c91238`. The branch was subsequently rebased after #147 merged; see the final integration section. All work stayed in this session's worktree, on `feat/143-controller-after-commit`. No consumer application or other session's worktree was changed.

The initial review corrections left the controller, queue and database runtime implementations unchanged from the reviewed head. The executable fix adds `configureAfterCommit` to the optional ESLint plugin's known runtime members so later schema/relation checks retain binding provenance. No plugin or runtime version was bumped.

| Review items | Resolution |
| --- | --- |
| 1 | Added next-release upgrade notes and a compatibility ledger with executable evidence and a genuine check against 3.12.0. |
| 2–3 | Corrected SQL/PostgreSQL session ownership guidance and restored “lifecycle hooks” terminology in public declarations, guides and rules. Existing hooks are not deprecated by this feature. |
| 4 | Retained the approved safe default: static operation metadata only. Error messages and stacks can themselves contain sensitive values; coercing them to strings does not remove those values. Applications receive the full thrown value in their explicit `onError` reporter. The regression still requires arbitrary error contents to be absent from default logs. |
| 5–6 | Added the three public error codes and linked best-effort callbacks from existing transaction, state-machine, outbox and application guidance. Durable delivery still needs an outbox and workers. |
| 7 | Reproduced four missing ESLint diagnostics, then fixed runtime provenance with one member declaration. Checked both MongoDB and PostgreSQL fixtures for `no-schema-cloning` and `valid-connection-field`. |
| 8 | Packed runtime consumers now assert facade exports, MongoDB compatible-entry identity, invalid-option rejection and distinct runtime configuration functions. |
| 9 | Corrected the plan's file list: runner coverage is in the new `after-commit-transactions` suite; the pre-existing transaction suites run unchanged. |
| 10, 14 | Unit coverage now checks the reporter's original context reference and proves that a throwing child's callback does not stop the parent's callback, even when reporting also fails. |
| 11 | Registered mutations assert no early dispatch after joined `saveObject`, and rejection after that write rolls back the row without notification on both engines. |
| 12 | Invalid controller callbacks fail with `INVALID_CONTROLLER` (400) at schema creation and after controller mutation, before any write/commit. |
| 13 | Unit and real-database cases perform child add/update/delete inside a transition and require child notifications followed by transition only. |
| 15 | Real database cases reject a later nested update with `NOT_VALID_ID`, or the second child with an actual unique violation. Each proves the earlier child's lifecycle hook ran, all writes rolled back and no notification escaped. |

## Verification before the base changed

Fresh checks use Node.js 24.2.0 and synthetic records in task-owned disposable MongoDB 8.0.32 replica-set/standalone databases and PostgreSQL 16.14. MongoDB callbacks run with integrity both off and transactional. The PostgreSQL fixture uses a one-client pool. Logs are local ignored artifacts under `.superpowers/sdd/2026-10-25-review-150/`.

The base check used temporary local branch `codex/143-review-base-check` at exactly `7387671` in this same worktree, with only the new public runtime test copied into it. Workspace package links resolved to that checkout's base implementations. Ten of eleven tests failed for missing notifications, configuration or validation; the lifecycle-hook rejection pin passed. The copied test was removed and the feature branch restored; all eleven then passed. This is evidence for that suite, not a claim that every new database or unchanged regression case fails on the base.

The four ESLint regression cases failed before the one-line fix (expected one diagnostic, received none) and passed afterward. The complete plugin suite passed 497 tests. Its packed consumer passed thirteen JavaScript and eight TypeScript diagnostics, config/rule types and valid fixtures. The bounded Barber trial read 61 MongoDB and 62 PostgreSQL application files with zero diagnostics, and detected ten injected violations per backend in memory; it executed or modified no application code. Plugin security audit found zero vulnerabilities.

The focused runtime/database run passed 44 tests with three backend-inapplicable skips.

After the dependency update and fresh root installation, `npm test -- --maxWorkers=1` completed with **152 passing files, one failed file; 5,282 passing tests, one timeout, six skips**, in 709.45 seconds. The only failure was the existing `returns, with each case-insensitive operator, every word that its case-sensitive form returns, on both backends` case in `tests/integration/query-text-operators-parity.test.js`, which exceeded its unchanged 5,000 ms limit at 5,017 ms. No callback case failed. This run is retained as a failure, not counted as a full pass.

The entire affected suite then passed unchanged in isolation against the same final dependencies and databases: **148 passed**, 4.98 seconds total (3.85 seconds of tests, versus 23.319 seconds for that file in the full run). Other concurrent test processes were active on the shared host during the slower run. These timings and the isolated pass support resource contention as the cause; neither the assertions nor timeouts were relaxed. CI on the updated PR must independently validate the final head.

Final `npm run test:packages` passed on the corrected source and updated dependencies: all five archives scored **100/100**, and all six isolated consumers (`core`, `sql`, `postgres`, `mcp`, `mcp-sdk`, `mongo`) passed their runtime and strict TypeScript checks, including the new facade assertions. This final verification uses runtime/tests/plugin source from `e541a91` and the lockfile from `13207c0`; the subsequent ledger, plan and report changes are documentation only.

All three task-owned database containers and their anonymous volumes were removed after local verification. Other containers and worktrees were left untouched.

### Required security gate

The first root `npm run test:security` failed on three dependencies already locked at the base: `body-parser` 2.3.0, `fast-uri` 3.1.8 and `zod` 4.4.3 (two high, one moderate findings). The root manifests and lockfile had no differences from `7387671` before this check. A dry run showed a bounded update within the existing ranges, applied in `13207c0`: `body-parser` 2.4.0, `fast-uri` 3.1.9, `zod` 4.6.7 and the `content-type` 2.1.0, `iconv-lite` 0.7.3 and `qs` 6.16.1 versions required by the updated parser. Package manifests, library dependency ranges and release versions remain unchanged; the lockfile keeps its existing CRLF format.

A fresh root `npm ci` and `npm run test:security` both passed with zero vulnerabilities. A separate temporary application freshly installed the same SDK version, `@modelcontextprotocol/sdk@1.32.1`, and its audit also found zero vulnerabilities; it was removed afterward. `npm run lint` and the release-metadata consistency check passed after the root reinstall. The first complete database suite had already passed 5,283 tests with six skips in 235.22 seconds before this dependency update; a new full run verifies the final dependency graph separately. Documentation dependencies were installed independently with `npm run docs:install` (zero audit findings), and `npm run docs:build` passed in 6.03 seconds with only the existing bundle-size warning.

## Integration with the merged OCC implementation

At the start of this correction on 2026-10-25, #147 remained open at `f6efefb511de5ca5e3d2a66d305999d60642623e`, #148 at `fb91b1f2eefdfc56ddc5f938943dbfb2dae5cf70` and #149 at `cd1b7d0c5d6c30a78121e765631da40cb7ddaad7`, each still based on `7387671`. None was mixed into the initial correction.

At 15:56:07 UTC, #147 merged at `e6fa85aadc0ff19fe46e351b5c1569630d86ea02`, including its reviewed head `8f823efb4b6de0dc972fe27696671336d54cb664`. GitHub marked #150 conflicting and created no checks for the just-pushed `e835074`. The task branch was rebased onto that exact merge commit. This brings master’s prepared 3.13.0 metadata and security fixes into the base; this PR adds no release bump, manifest or lockfile change beyond its internal queue export. The redundant security-fix commit was dropped during rebase. #148 remains excluded.

The original branch is preserved locally at `codex/143-review-before-occ`; the earlier [OCC evidence branch](2026-10-23-controller-after-commit-verification.md#occ-integration-evidence) remains historical evidence. Its five lifecycle conflict resolutions were reused, preserving OCC preconditions and result checks while awaiting results before queue registration. The newer #147 schema-validation correction was retained. Shared guides, architecture guidance and packed-consumer imports now preserve both features; obsolete claims that #143 is only proposed were replaced with callback/outbox guidance.

`tests/integration/after-commit-occ.test.js` is now part of this PR, rather than only the evidence branch. Its nine cases cover successful versioned save/update/transition/delete notifications, stale versions emitting nothing, a stale nested child rolling back an earlier child's write and notification, and retries retaining the expected revision while dispatching only the confirmed attempt. They run on MongoDB with integrity off and transactional, and PostgreSQL.

Fresh focused verification after the rebase: **328 passed** across eight callback/OCC/declaration suites; **244 passed, three backend-inapplicable skips** across six real-database suites, including the nine interaction cases, ordinary callbacks and the current OCC contracts. Root installation and lint also passed. These runs used new task-owned disposable databases and the new base; the earlier full-suite and package results above do not certify the rebased source. Final full-suite/package/documentation results and CI links are recorded in the [PR validation section](https://github.com/simtlix/simfinity.js/pull/150).

The full local run on `111c4742e0406828ea70a31791040a48709e0b03` then passed **165 files, 5,803 tests, six skips**, in 320.84 seconds, with disposable MongoDB 8 replica-set/standalone and PostgreSQL 16. Its [Library CI run](https://github.com/simtlix/simfinity.js/actions/runs/40210099845) passed lint, security and packed consumption: five archives scored 100/100 and six runtime/strict TypeScript consumers passed. Documentation and ESLint plugin checks also passed on that head. Those three local database containers were removed afterward.

The first [database matrix run](https://github.com/simtlix/simfinity.js/actions/runs/40210099785) passed the MongoDB 7/PostgreSQL 15 and MongoDB 8/PostgreSQL 16 jobs. The PostgreSQL 18 pairing failed one existing **MongoDB** named-view test: it compared the complete extensions of two separately created errors, whose matching code/status had timestamps `16:08:51 GMT` and `16:08:52 GMT`. The comparison now preserves equality for every other extension and requires a string timestamp, without requiring two errors to be created in the same second. No runtime code or timeout changed. The affected suite passed **68 tests** on fresh disposable MongoDB 8/PostgreSQL 18 databases, and its lint passed. The PR's final CI checks validate this last test-only correction as well.

Future #142/#100 operations must reuse the existing adapter-owned transaction and lifecycle completion sites, preserving authorization, hook ordering and exactly one notification registration for each successful lifecycle operation. This PR adds no parallel dispatcher or CRUD facade. Callback delivery remains best effort and is not an exactly-once or durable worker contract.
