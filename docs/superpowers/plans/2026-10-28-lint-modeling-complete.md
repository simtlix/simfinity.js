# Complete modeling lint catalogue implementation plan

> **For agentic workers:** Use superpowers:executing-plans for coordination and shared implementation, with superpowers:dispatching-parallel-agents for the independent domain modules. Steps use checkbox syntax for tracking.

**Goal:** Resolve every candidate in #116 with precise diagnostics, tests and documented static limits, then integrate and publish the independent plugin.

**Architecture:** Shared bounded graph/provenance analysis feeds three domain inspectors and an optional advice rule. Existing connection-field and cloning rules are extended rather than duplicated.

**Tech Stack:** ESM JavaScript, ESLint 9 RuleTester, TypeScript parser, node:test, root Vitest.

**Spec:** `docs/superpowers/specs/2026-10-28-lint-modeling-complete-design.md`

## Global constraints

- Explicit Simfinity 3.8.0 contract; no consumer execution or runtime dependencies.
- Preserve unknowns, aliases, mutations, backend/model identity and conditional order.
- Advice is opt-in; recommended rules report demonstrated errors, with no fixes.
- Keep runtime versions unchanged and preserve unrelated untracked user files.
- No integration until every candidate and accepted alternative is accounted for.
- User has authorized merge and publication; complete both without repeated consent.

## Review focus

- Imported singleton or conditional bootstrap must not prove absent registrations.
- Shared type containers, scalar hint mutations and copied resolvers must not fabricate stable identity.
- SQL/transactional Mongo storage reachability differs from generated Mongo and writable-input reachability.
- Empty projections, private links, enum-list state fields and supplied-model cycles can be valid.
- Unknown fields/scalars/indexes must invalidate absence proofs without hiding independent positive contradictions.

### Task 1: Bounded model graph and provenance

**Files:** `src/analysis.js`, new `src/model-analysis.js`, `src/model-rule.js`, `tests/model-analysis.test.mjs` under the plugin.
**Interfaces:** Implement the shared graph interface defined in the spec. Other tasks consume it and do not edit these files.

- [ ] Add graph fixtures that distinguish two runtimes, both facade engines, transactional/off Mongo, generated/supplied/no-endpoint models, aliases/shadowing, unknown dynamic maps and schema order; observe the missing graph facts fail.
- [ ] Extend provenance conservatively; intern wrappers, object/scalar/enum/abstract descriptors and safe scalar bases without executing syntax.
- [ ] Add bounded registration snapshots, separate entity/model reachability, complete-prefix proof, and safe field-copy provenance needed by schema rules.
- [ ] Run focused graph tests and the existing plugin suite; preserve all existing 0.4.0 behavior.
- [ ] Commit the shared implementation with test evidence in the ledger.

### Task 2: Fields and local metadata

**Files:** new plugin `src/model-fields.js`, `src/rules/valid-model-fields.js`, `tests/model-fields.test.mjs`; root `tests/eslint-model-fields-contract.test.js`.
**Interfaces:** Export prefixed `messages` and `inspect(graph) -> {errors,warnings}`. Consume the shared graph without modifying it.

- [ ] For MOD-01/02/09/11/12/13/18/22, add failing diagnostics and explicit accepted alternatives from the audit and spec.
- [ ] Implement only demonstrable contracts and opt-in intent warnings; distinguish scalar identity/name semantics and enum primitive equality.
- [ ] Pair representative diagnostics with actual core/Mongo/Postgres runtime behavior; do not alter runtime production code.
- [ ] Run focused tests, report exact evidence and commit only owned files.

### Task 3: Relations and engine storage

**Files:** new plugin `src/model-storage.js`, `src/rules/valid-model-storage.js`, `tests/model-storage.test.mjs`; extend `src/rules/valid-connection-field.js` and its tests; root `tests/eslint-model-storage-contract.test.js`.
**Interfaces:** Export prefixed `messages` and `inspect(graph) -> {errors,warnings}`; expose storage missing-link evidence for the existing rule without duplicate reports.

- [ ] Add failing fixtures for MOD-03/05/06/07/08/10/14/15/16/17/23, paired with private links, supplied models, owned-vs-JSON embedded storage, valid aliases and shared type exceptions.
- [ ] Implement metadata, generated-model and input graph traversals separately; keep all traversal bounded and skip unknowns.
- [ ] Add paired runtime assertions for inverse inference, cycles, physical storage, generated Mongo naming and accepted metadata alternatives.
- [ ] Run focused tests and commit only owned files; report any shared-interface defects to the coordinator.

### Task 4: Schema lifecycle and generated inputs

**Files:** new plugin `src/model-schema.js`, `src/rules/valid-model-schema.js`, `tests/model-schema.test.mjs`; extend `src/rules/no-schema-cloning.js` with tests; root `tests/eslint-model-schema-contract.test.js`.
**Interfaces:** Export prefixed `messages` and `inspect(graph) -> {errors,warnings}`. Use name-based registration lookup and safe ordered events/copies.

- [ ] Add failing fixtures for MOD-04/19/20/21, including conditional/incomplete bootstrap, type-name aliases, excluded mutation roots, legal empty inputs and resolver-cleared copies.
- [ ] Implement complete-prefix absence proof, input projection/reachability, runtime binding and proven introspection reconstruction. Reject unsound inference, not legitimate reuse.
- [ ] Compare representative errors and legal alternatives to actual runtime fixtures, without consumer execution by the plugin.
- [ ] Run focused tests and commit only owned files.

### Task 5: Public presets, complete coverage and release

**Files:** plugin `src/index.js`, `src/index.d.ts`, `src/rules/modeling-advice.js`, tests/consumer/trial, plugin README/package/lock, root README and linting guide.
**Interfaces:** Combine domain warnings in `advice-3.8`; add proven errors to `recommended-3.8`, retain existing rule identities.

- [ ] Wire the rules and declarations; test both presets, TS/JS packed consumers, per-rule IDs/severity and absence of automatic fixes.
- [ ] Extend bounded Barber trials with applicable sentinels and verify zero unintended baseline diagnostics; contextual findings must be documented precisely.
- [ ] Document the 23-candidate coverage matrix, engine applicability, syntax and analysis limits, upgrade implications, and version alignment for the intended plugin release.
- [ ] Run plugin suite/audit/packed consumer/trial, root lint/tests and docs build; use CI for disposable database integration.
- [ ] Obtain independent whole-branch review against all 23 candidates and the review-focus cases; fix demonstrated issues with regressions.
- [ ] Create an issue-linked PR, wait for passing checks and merge reviewed source. Run the required master release preview, tag the validated merge commit and complete OIDC publication.
- [ ] Verify npm version/latest/integrity/provenance, GitHub release assets and the separate documentation deployment. Update #116/#112 with actual implemented outcomes and release evidence.
