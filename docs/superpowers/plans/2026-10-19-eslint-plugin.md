# Simfinity ESLint Plugin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a reviewable optional plugin for the five precise checks agreed in issue #112.

**Architecture:** A standalone development package uses bounded ESTree analysis, never runtime imports. Five rules share import provenance and static-value helpers. A named flat preset explicitly selects the 3.8.0 contract.

**Tech Stack:** ESM JavaScript, ESLint 9, node:test/RuleTester, optional TypeScript parser.

**Spec:** `docs/superpowers/specs/2026-10-19-eslint-plugin-design.md`

## Global Constraints

- Independent package version `0.1.0`; all five runtime packages remain `3.8.0`.
- Node.js `^18.18.0 || ^20.9.0 || >=21.1.0`; development and CI use Node.js 24.
- No production dependencies other than the ESLint peer; no application execution or autofixes.
- Unknown provenance/values are not errors; no new restrictions on native application operations.
- User authorized the issue comment and implementation PR, not merge/publication.

## Review Focus

- Shadowed imports and modified aliases must not produce false provenance.
- Object spreads, duplicate keys and dynamic values must not be mistaken for constants.
- Independent GraphQL types and valid virtual/embedded fields must remain valid.
- Package installation must work without the runtime, database drivers or repository node_modules.
- The preset must explicitly document its 3.8.0 baseline, without claiming other versions were tested.

### Task 1: Standalone rules and precision tests

**Files:** Create `tools/eslint-plugin-simfinity/{package.json,src/index.js,src/analysis.js,src/rules/*.js,tests/rules.test.mjs}` and its lockfile/license. Exclude the independently tested tool from root Vitest collection.

**Interfaces:** Default plugin export with `rules` and `configs['recommended-3.8']`; shared helpers resolve import identities, literal values and local registered types without execution.

- [ ] Add RuleTester cases for five rules, including aliases, shadowing, unknown spreads, duplicate keys, registered embedded and independent types, virtual fields and TypeScript.
- [ ] Run the new tests and observe missing implementation fail.
- [ ] Implement the bounded helpers, rules and preset; run tests until all cases pass.
- [ ] Commit the standalone implementation and regression tests.

### Task 2: Packed consumer, documentation and CI

**Files:** Create tool README, `tests/consumer.mjs`, `scripts/trial.mjs`, `.github/workflows/eslint-plugin.yml`, `docs/guide/linting.md`; update root README, sidebar and AGENTS layout guidance.

**Interfaces:** The packed consumer installs the Task 1 package, imports its flat preset and runs ESLint on JS/TS; it requires no Simfinity runtime. CI runs the same commands documented for contributors.

- [ ] Add and run the isolated packed consumer; prove expected rule IDs/locations and absence of runtime dependencies/application execution.
- [ ] Run the bounded Barber trial and document its coverage limits.
- [ ] Add installation/rule guidance, independent CI and package-boundary documentation.
- [ ] Run package audit/tests/pack, root lint/tests/release metadata checks and docs build; inspect all results.
- [ ] Obtain independent final review, fix demonstrated defects, commit and open a PR linked to #112; verify its CI.
