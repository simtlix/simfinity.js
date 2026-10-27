# Native MongoDB collation for field comparisons

Spec: `../specs/2026-10-27-field-comparisons-design.md`, approved collation amendment.

Goal: update PR #163 so ordered String valuePath predicates use native MongoDB collation, without changing exact equality, text predicates, literal filters or PostgreSQL.

## Task 1: Remove rejection and verify/document the contract

- Update `tests/field-comparisons-mongodb.test.js` first: compilation with non-simple/offline models succeeds; real collection/schema/operation collations determine ordered results across find/count/aggregate/children/batches; equality stays exact, literals retain collation; case/accent/numeric ordering, null guards, scopes and direct execution are covered.
- Run the focused suite before implementation. Expected: new compilation/execution cases fail with the old collation UNSUPPORTED_QUERY errors.
- Remove the collation-only command context, metadata inspection and Aggregate checks from `packages/mongodb/src/mongo/{queries,adapter}.js`. Keep expressions, type checks, scopes and session plumbing unchanged.
- Update the query guide, error reference, compatibility notes, READMEs and application guidance; replace the superseded design amendment. Explain exact equality versus locale-equivalent ordered operands and raw-driver versus Mongoose execution.
- Run focused MongoDB tests on disposable standalone and replica servers; then root lint/full database suite and docs build. Expected: all applicable tests pass. No package exports, dependencies or declarations change.
- Review the complete change with a fresh reviewer, fix actionable findings, commit and push to the existing PR branch. Update PR #163 description and verify its checks. No merge or release.

## Review focus

Ensure there is no stale collation rejection/metadata lookup, no implicit simple override, no loss of scope or outer bindings when removing command policy, no claim of universal String ordering parity, and no change to exact String/enum membership or literal semantics. Compare current regressions with the prior PR tests so removing rejection coverage does not remove unrelated behavior coverage.
