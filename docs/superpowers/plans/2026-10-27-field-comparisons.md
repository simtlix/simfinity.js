# Field comparisons implementation plan

Goal: implement issue #108 part 5, `valuePath`, on all generated read surfaces with matching authorization and database behavior.
Architecture: extend the existing query walker, collection normalization and scoped provenance; core owns the comparison contract, SQL owns plans, engines own physical expressions.
Tech stack: ES modules, GraphQL 16, Vitest, MongoDB/Mongoose, PostgreSQL/pg.
Spec: [approved design](../specs/2026-10-27-field-comparisons-design.md).

## Global constraints

- The maintainer approved the design and implementation on 2026-10-27. No further design approval or publication is implied.
- Preserve literal filters, package boundaries, session ownership and aggregate cardinality. No dependencies or version changes.
- Write failing behavioral tests before implementation. Use Node 24 and disposable databases.
- Shared input syntax is nullable `valuePath`; public plan operand is `{ up, path, joins? }`. Internal normalization uses `__operand: { up, path, scopes? }` only for compiler-generated outer bindings. Original arguments are validated before normalization; public input cannot supply internal bindings.
- Work on `codex/query-field-comparisons`; no edits to unrelated worktrees. Link #108 in the PR.

## Review focus

1. RHS-only denied/hidden references and marker edits must not bypass authorization (task 3).
2. Collection shorthand must bind the same child and retain outer origins without multiplying roots (tasks 2, 4, 5).
3. Nulls, empty arrays, enum identities and native/json dates must agree across engines (tasks 1, 4, 5).
4. Undeclared or overridden compilers must never receive the new operand shape (tasks 1, 4).
5. Trusted scope prefixing, aggregate anchors and batched children must preserve operand ownership (tasks 2–5).

## Task 1 — Shared comparison contract

Files: `packages/core/src/query-comparisons.js`, `query-operators.js`, `metadata.js`, `tests/query-field-comparisons.test.js`.
Write and run failing cases for presence, operator/type/list matrix, missing logical metadata, capability defaults/dependency. Implement shared scalar descriptions and comparison validation; preserve effective enum and temporal identity additively. Re-export internal helpers through internal/query-operators. Run new and existing operator/metadata suites.

## Task 2 — Paths, normalization and plans

Files: `packages/core/src/query-plan.js`, `query-frames.js`, related core declarations and packed consumer fixtures.
First pin both operand paths/origins, direct and relation-term plans, shorthand same-child/outer binding, sibling collection rejection, scope unions and frame budgets. Extend walker and validator; normalize implicit operands without changing literal node shape. Lift same-frame joins into predicate joins and outer joins into operand joins. Add QueryOperand exports and exact type checks. Run planner/collection suites.

## Task 3 — Runtime provenance and schema

Files: `packages/core/src/runtime.js`, runtime authorization/scope tests.
First fail generated GraphQL input and RHS authorization, hidden references, final middleware path edits/marker loss, scope prefix rewrites and named-view tests. Add input fields and flags; issue and refill comparison markers across both operands. Keep client inspections before middleware and trusted final validation. Run path authorization, emptiness, collection-frame and runtime suites.

## Task 4 — PostgreSQL and SQL binding

Files: `packages/sql/src/{plugin,adapter}.js`, `packages/postgres/src/plugin.js`, `packages/postgres/src/query/compiler.js`, engine-specific field-comparison tests.
Independent engine work after the public plan contract above: write failing direct plan/compiler and capability cases, then implement validated frame-aware operands, null-safe equality/list membership, guarded text/ordered predicates, date normalization and C collation. Verify root/outer aliases, scopes, aggregate anchors and child UNION branches. Run SQL/PG suites, then real PostgreSQL parity fixtures.

## Task 5 — MongoDB

Files: `packages/mongodb/src/mongo/{adapter,queries}.js`, engine-specific field-comparison tests.
Independent engine work using validated normalized conditions: first fail pipeline/real-row cases, then implement safe physical operands, identity/enum validation and null normalization. Use guarded `$cond` expressions and allocated lookup let variables for outer bindings. Validate scope completeness and scoped joins for either operand. Verify batch and standalone behavior with existing suites and real Mongo fixtures.

## Task 6 — Public surfaces and documentation

Files: affected package/root READMEs, queries/scopes/auth/middleware/API/error/SQL plugin/compatibility docs, MCP descriptions and tests, descriptor tests, query/report skill.
Pin MCP local/SDL and descriptor exposure, nullable valuePath and mutual-exclusion runtime errors; extend prose using approved examples and limitations. Do not change descriptor format or claim field-comparison index guarantees.

## Task 7 — Integrated verification and review

Run lint, full tests against disposable MongoDB replica/standalone and PostgreSQL, security audit, packed consumers and documentation build. Inspect failures by root cause; fix with regressions. Fresh whole-branch review using simfinity-pr-review, address findings, rerun affected checks. Create/update a PR linking #108 and attach it; inspect CI. No tag or publication in this task.
