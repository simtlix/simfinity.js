# PostgreSQL final review record

**Final outcome: approved.** The whole-branch review below identified the enum-filter defect and formatting cleanup. Both were corrected, packages were regenerated and installed in Barber, and the subsequent scoped review approved all findings. The two original assessments are preserved below in chronological order.

## Final combined review — PostgreSQL library and Barber

Date: 2026-09-12. Reviewer: final_combined_review.

**Ready to deliver/merge: With fixes.** One Important upstream query-compatibility defect remains in PostgreSQL enum filters. The application port is otherwise ready against the reviewed packages; the combined delivery needs corrected library archives and verified replacement of Barber's consumed archives before final approval. There are no Critical findings.

## Scope and method

- Library: `37efd341dd42741a4f5539f6b6f137733b6b3ada..47bdd1f2643975d4bfe5687e568955f5fc124562`.
- Barber: `00718c0195374ab1baaefd32d8a24e21a238b4c3..d8d6424cc662e40fc17c40202f9913d2411d1685`, in `/Users/claudiogonzalez/SCM/simfinity-barber/.worktrees/codex-postgresql`.
- Read the final context, completion spec/plan, permanent delivery record, progress rulings and task review conclusions. Reviewed the branch in manageable passes: shared runtime and Mongo extraction; PostgreSQL metadata, records, transactions, SQL constraints/lifecycle and query compiler; shared helpers/MCP and declarations; package/release automation and documentation; Barber native persistence, permissions/controllers, infrastructure, frontend integration and verification artifacts.
- Compared extracted MCP/auth/scalar/validator modules directly with their upstream source. MCP is unchanged apart from its shared-error import; auth behavior changes are confined to the reviewed authentic ObjectId registration mechanism.
- Did not rerun reported suites. Two focused Node compiler probes addressed the specific enum-filter doubt, without connecting to a database or creating files. Also read source history and verified Barber vendor SHA256 values. No source, Git, persistent demo, Docker or remote mutations were made. This report is the only review output file.

## Strengths

- The extracted runtime retains the upstream lifecycle and protection boundaries. Nested update/delete ownership is checked after middleware, parent linkage is reapplied after hooks, standalone saves own complete transactions, and retries clone typed input structures. PostgreSQL sessions are validated against their originating instance; borrowed sessions remain caller-owned.
- Schema generation delivers actual reference FKs, explicit link-entity relationships and ownership cascades. Owned shape checks and owner-aware unique keys are database-enforced, with guard-row writes preventing same-owner write skew. Initialization checks catalog definitions and enforcement instead of replacing drift. The stale-key backfill correction is transactional and does not modify source records.
- Query work covers difficult value semantics with explicit presence markers and typed array comparison helpers. The outer SQL/JSON-null group-key fix preserves nested null distinctions; UTC Date encoding avoids process-wide driver/timezone changes. These are backed by meaningful real-database differential cases.
- Core and PostgreSQL have no MongoDB/Mongoose/MCP dependency. MCP is a separate opt-in package with an optional SDK peer, and the Mongo facade preserves its existing imports. The five packed consumer configurations check actual imports, dependency isolation and strict TypeScript usage.
- Release tooling validates versions and archive integrity, publishes dependencies before consumers, and supports integrity-checked reruns. The workflow now stages the helper-owned documentation lockfile. The unchanged upstream manual GitHub-release recovery procedure is an acceptable operational boundary.
- Barber forwards active sessions through authentication, native controller writes and review-statistic updates. Its controller checks protect root and nested writes, including the three reproduced original authorization gaps. The final clearing-list fix applies unsets before deriving effective values. Real API, FK, rollback, MCP, startup/restart and browser evidence materially supports the port.

## Issues

### Critical

None found.

### Important — F1: Restore upstream enum filter name/value semantics

**Primary location:** `packages/postgres/src/query/compiler.js:158`. Related locations: `packages/postgres/src/codecs.js:18`, `packages/core/src/metadata.js:21`, `tests/integration/postgres-lifecycle.test.js:127`.

The PostgreSQL filter binder calls the write-oriented `encodeScalar`. For enums, this only stringifies the input and checks it against stored internal values. Upstream `37efd341` resolves an enum filter by **member name first**, then by strict equality with an internal value, before selecting its storage representation. Current Mongo preserves that behavior in `src/mongo/queries.js:206`.

This breaks existing valid GraphQL filters whenever enum names differ from internal values. It can also silently select the wrong enum member when a name equals another member's internal value. The metadata currently retains only internal strings, so it cannot reproduce upstream resolution by itself.

Focused reproduction, using the actual Mongo and PostgreSQL query builders:

| Enum definition and filter | Upstream/current Mongo | PostgreSQL |
| --- | --- | --- |
| `ONE: { value: 'one' }`, `kind: { value: 'ONE' }` | Compiles match `kind: 'one'` | Throws `INVALID_FILTER_VALUE` |
| Same definition, `kind: { value: 'one' }` | Compiles match `kind: 'one'` | Binds `'one'` correctly |
| `ONE: { value: 'TWO' }, TWO: { value: 'two' }`, `kind: { value: 'TWO' }` | Member-name precedence selects `TWO`, stored `'two'` | Binds `'TWO'`, selecting member `ONE` |

The collision probe confirmed divergent parameters for **EQ, NE, LT, LTE, GT, GTE, BTW, IN and NIN**. This affects root, referenced and embedded enum leaves, scalar enum lists and state enum filters because they share this binder. It affects find/count/aggregate filtering rather than just output serialization. Existing differential cases use internal strings such as `'one'`, so they miss it. The PostgreSQL-only lifecycle test currently expects the divergent collision behavior and must not be treated as upstream compatibility evidence.

**Correction:** Add query-only enum resolution with upstream name-first precedence and strict internal-value fallback, retaining sufficient enum metadata or consulting the corresponding GraphQL enum definition. Convert the selected internal value to its PostgreSQL storage string only after resolution. Do not add name resolution to the shared persistence encoder: GraphQL mutations already supply internal values, and remapping those would reintroduce the prior state-name collision bug. Keep state storage, transition guards and GraphQL enum decoding unchanged. Align the enum filter operator/type checks with upstream as part of this boundary; upstream's LIKE operator is restricted to string fields.

**Validation:** Add differential name/internal/collision cases over both adapters, including numeric internal values, list/set operators, an embedded/list leaf and a state enum. Preserve the existing successful state transition and persisted-value checks while correcting the filter expectation. Run affected query/lifecycle tests across the supported PostgreSQL versions, normal lint/package checks and any required final suite gate. Produce a new commit-bound archive set, update Barber's vendor files/manifest/lockfile, and verify actual installed package provenance plus the affected application smoke. The existing archive set must remain preserved.

### Minor — M1: Whole-branch whitespace check is not clean

**Locations:** representative trailing whitespace at `packages/core/src/auth/index.js:3`, `packages/core/src/auth/rules.js:70`, `packages/core/src/validators.js:33`; extra EOF blank lines at `packages/core/src/query-limits.js:27`, `packages/core/src/scalars/factory.js:53`, `packages/mcp/LICENSE:202`, `packages/mcp/types/index.d.ts:296`.

The controller's broadened `git -c core.whitespace=cr-at-eol diff --check 37efd341...HEAD` exits 2; full diagnostics are in `/tmp/simfinity-final-whitespace.log`. Much of the whitespace was preserved when upstream modules moved, but it is visible as added content in this branch. This is formatting hygiene, not a runtime or packaging defect. Remove trailing spaces and redundant EOF lines if included in the correction batch, and rerun the whole-range check. Until then, the final record should say that per-change checks passed but the whole-branch check did not. This finding does not independently block delivery.

## Deferred finding triage

**Task 6 M1 — Storybook no-MDX warning:** `frontend/.storybook/main.ts:5` contains the unchanged `../src/**/*.mdx` glob. This is pre-existing configuration noise, not a regression caused by the port or a failed frontend test. Keep it optional and nonblocking; remove the unused glob in a separate cleanup if MDX stories are not intended. No additional test rerun is justified solely by this warning.

Historical task findings remain closed on their merits: aggregate sort syntax, authentic ObjectId normalization, stale unique-key backfill, JSONB/historical Date handling, top-level null grouping, release staging and cleared-list derived values all have corresponding final corrections and focused evidence. F1 is a newly established compatibility gap, not a reopening of those specific fixes.

## Design rulings assessment

1. **Existing library branch plus isolated Barber worktree:** appropriate for the authorization and checkout-preservation constraint. No integration risk requiring a different worktree arrangement.
2. **Latest fetched 3.1.0 baseline:** appropriate; its enum filter semantics are precisely why F1 requires correction. Earlier foundation decisions cannot silently override that binding public contract.
3. **Local packages without public publication or data migration:** meets the requested local delivery scope. Registry publication and populated-backend migration remain separate operations.
4. **Local `.git/info/exclude` for the Barber worktree:** appropriate and reversible; preserves the original tracked checkout.
5. **Helpers in core, optional MCP package:** correct dependency separation. Mongo compatibility imports remain available; PostgreSQL MCP users opt in explicitly.
6. **Four lockstep 3.2.0 packages:** reasonable and consistently implemented with exact internal versions and ordered publication.
7. **Stored-key integrity first, default normalization later:** acceptable as an implementation sequence because the final record store normalizes before encoding/key derivation and differential uniqueness/default regressions close the intermediate gap. Stronger required storage constraints are explicit and tested.
8. **JSONB Date acceptance separated from native historical Date serialization:** acceptable sequence; final UTC parameter encoding and extended-date tests close both sides without global settings changes.

## Evidence and limits

The reported library matrix is 47 files / 956 tests on each PostgreSQL 15/Mongo7, PostgreSQL 16/Mongo8 and PostgreSQL 18/Mongo8 combination. Release-only fixes have 34 focused tests, and five packed consumers, Node 18.20.8 consumers, ESLint, docs build and actionlint are reported passing. These results remain valid evidence, but they did not cover F1.

The latest controller-supplied Barber result supersedes earlier report counts: **11 backend files / 69 tests passed** at the reviewed application head (`/tmp/simfinity-barber-final-unit.log`). The final API runner reports 67 operation checks plus auth/scopes/FK/rollback/MCP assertions; frontend unit/build, four Playwright checks, all-role browser QA and Compose/restart checks are also recorded. No full suite was rerun by this reviewer.

Barber's three vendor SHA256 values independently match its manifest. That manifest names library source `96a50dcd945020e4232a26e4042051530037e698`; only the completion plan and delivery report differ between that source and the reviewed library HEAD, so current archive provenance is coherent. F1's correction will require new archives. The library working tree shows only the six preserved user tarballs as untracked; the controller reports the original Barber main clean and unchanged.

This review assesses the requested fixed-startup backend choice, public API and local runnable port. It does not certify production data migration, arbitrary Mongoose-native compatibility or remote publication, which are outside this delivery.

## Assessment

**Ready to merge: With fixes.** The architecture, relational integrity, lifecycle, package isolation and Barber integration are well supported. Correct F1 and carry the corrected source through fresh archives into Barber, then perform a scoped fix review; neither another whole-branch review nor a redesign is warranted by these findings. M1 whitespace is nonblocking, and the pre-existing Storybook warning needs no task-blocking action.


---

## Final fix-wave scoped re-review

Date: 2026-09-12. This is the one scoped re-review of the final correction wave, not another whole-branch review.

## Finding Verdicts

- **F1 — Restore upstream enum filter name/value semantics — ADDRESSED.** Core metadata now retains each enum member's name and original internal value while preserving the existing storage-string set (`packages/core/src/metadata.js:21-29`). PostgreSQL query binding resolves a member name first, then a strictly equal internal value, and only afterward passes the selected internal value through the unchanged persistence encoder (`packages/postgres/src/query/compiler.js:156-167`). This gives the required collision precedence (`ONE -> TWO`, `TWO -> two`), rejects numeric strings for numeric internal values, and applies through EQ, NE, LT, LTE, GT, GTE, BTW, IN and NIN, including scalar enum lists. LIKE is now rejected unless the effective field is String (`packages/postgres/src/query/compiler.js:166`). The targeted metadata dependency check found no alternate enum metadata consumer or write path: records still call the unchanged `encodeScalar`, and state writes/guards still use the adapter's internal `state.value`.

  The new real differential fixture exercises root, scalar-list, embedded-list, reference and state leaves through find, count and aggregate on both adapters (`tests/integration/enum-query-parity.test.js:79-105`). Literal expected keys close the collision case rather than accepting an equally wrong empty result. Focused compiler assertions inspect bound values for all nine operators and strict numeric rejection. The lifecycle correction retains successful/denied state transitions and explicitly checks the stored internal state while changing only query expectations (`tests/integration/postgres-lifecycle.test.js:124-133`). The implementation report records the required red state (24 failed / 20 passed), corrected focused run (44 passed), full PostgreSQL 15/MongoDB 7 run (48 files / 990 tests), and affected PostgreSQL 16 and 18 runs (5 files / 212 tests each).

- **Final M1 — Whole-library whitespace hygiene — ADDRESSED.** The supplied fix diff changes only whitespace in the identified auth/validator files and removes only the identified redundant EOF lines from core and MCP files. No code token changes are mixed into those cleanup hunks. The implementation report records `git -c core.whitespace=cr-at-eol diff --check 37efd341...HEAD` exiting 0 after both source and report commits.

- **Deferred Task 6 M1 — Remove the unused Storybook MDX glob — ADDRESSED.** The app fix removes exactly `../src/**/*.mdx` and retains the existing stories glob and all other Storybook configuration (`frontend/.storybook/main.ts:3-18`). The recorded frontend unit run passed 1 file / 3 tests without the warning. This edit does not affect the production frontend.

- **Corrected source-to-archive-to-Barber handoff — ADDRESSED.** The package/source fix is `d98197387543d185fc79d5c31757b12e07ef2436`; it is an ancestor of library HEAD `a311134df2d9b8273466b80ad509828b7f9c6313`, and the only later change is `docs/superpowers/reports/2026-09-12-postgresql-delivery.md`. The new four-package manifest names the source commit and its SHA256 values match the actual archives. The supplied provenance log records all 70 archive members as exact matches to that source commit (24 core, 5 MCP, 16 PostgreSQL and 25 Mongo facade files). Both previous artifact directories remain present.

  Barber's three vendor archives are byte-identical to the corresponding archives in `3.2.0-d98197387543`. Its filtered manifest names the same source commit and its SHA512 values match the refreshed lockfile (`backend/vendor/manifest.json:1-27`, `backend/package-lock.json:560-616`). A read-only verifier independently confirmed all 45 host-installed files match their archive plus the manifest and lock integrity; the recorded running-container verification confirms the same 45 files. App FIX_BASE `d8d6424cc662e40fc17c40202f9913d2411d1685` is an ancestor of app HEAD `d149c625100178f412b792d961a8ac4f42dc78b8`; app `main` remains `00718c0195374ab1baaefd32d8a24e21a238b4c3`. The six untracked historical root archives remain present alongside the separately tracked 2.1.0 archive. The coordinator's independent Node 18.20.8 evidence passes all five packed consumers, and its final read/login browser evidence reports all three roles with zero GraphQL/JavaScript errors.

## New Breakage in the Fix Diff

- None found. The query-only normalizer has the metadata it requires on every described enum leaf, and the fix does not alter persistence encoding, record materialization, state storage/guards, GraphQL enum decoding, or unrelated query behavior. Documentation and provenance changes accurately distinguish the semantic source commit from the later report-only library commit.

## Out-of-Scope Observations

- None. Historical task findings remain closed; no broad branch area was reopened.

## Checks and Boundaries

- Read `final-review.md`, `final-fix-brief.md`, `final-fix-report.md`, and both controller-generated fix diffs in manageable passes. Compared the query binder with the current Mongo implementation and the exact upstream 3.1.0 enum binder, then performed one named metadata-propagation dependency check.
- Accepted the controller's reported database matrices, lint, package consumers, application suites, rebuild, health and browser QA; none was rerun. Provenance review used only read-only commit ancestry, hashes, archive comparisons, installed-file comparison and existing logs. No database or browser probe was needed.
- No source, Git/index/branch, persistent application data, service state, prior artifact directory, original app checkout or user archive was changed. No subagents were used. This report is the only created file.

## Verdict

**Final fix wave: all findings addressed, with no new Critical or Important breakage. Ready to deliver and merge.**
