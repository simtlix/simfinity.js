# After-commit callbacks: PR #150 review corrections

This records corrections to the [2026-10-25 review](https://github.com/simtlix/simfinity.js/pull/150#pullrequestreview-5643722229) of [PR #150](https://github.com/simtlix/simfinity.js/pull/150), for [issue #143](https://github.com/simtlix/simfinity.js/issues/143). The user authorized the proposed corrections and updating the PR. Merge, release versioning and publication remain outside this task.

## Scope and decisions

The reviewed head was `c6bf164398721c2408ac06db33ed9ef19ca1743e`; the base remains `738767141ecb3e017a9a590e52c7e1a795f68428` (3.12.0). Corrections are on `feat/143-controller-after-commit`, beginning with `e541a91c7472deea1728da7e5bda742814c91238`. All work, including the temporary base check, stayed in this session's worktree. No consumer application or other session's worktree was changed.

The controller, queue and database runtime implementations are unchanged from the reviewed head. The executable fix adds `configureAfterCommit` to the optional ESLint plugin's known runtime members so later schema/relation checks retain binding provenance. No plugin or runtime version was bumped.

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

## Verification

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

## Integration limits

On 2026-10-25, #147 remained open at `f6efefb511de5ca5e3d2a66d305999d60642623e`, #148 at `fb91b1f2eefdfc56ddc5f938943dbfb2dae5cf70` and #149 at `cd1b7d0c5d6c30a78121e765631da40cb7ddaad7`, each still based on `7387671`. None was mixed into this branch.

The [previous report](2026-10-23-controller-after-commit-verification.md#occ-integration-evidence) preserves the separate OCC combination at `6acc1f66d6f1215c729030bbb395b382e07ad13a`. That is historical evidence at its pinned heads, not a new-head test result. These review corrections do not alter the lifecycle runtime. Repeat the combined lifecycle/OCC check after #147 lands or either implementation changes, resolving the documented shared files before final integration. The stale-version rollback case remains on that evidence branch until #147 is integrated; the new missing-ID and unique-constraint rollback cases run directly on #150.

Future #142/#100 operations must reuse the existing adapter-owned transaction and lifecycle completion sites, preserving authorization, hook ordering and exactly one notification registration for each successful lifecycle operation. This PR adds no parallel dispatcher or CRUD facade. Callback delivery remains best effort and is not an exactly-once or durable worker contract.
