# Required Collection Links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Diagnose proven missing child links before generated writable collections fail at startup.

**Architecture:** Extend `valid-connection-field` using the existing local analyzer. Keep directly registered type checks separate from recursive embedded plain-link validation. Unknown syntax stays unknown.

**Tech Stack:** ESM JavaScript, ESLint 9 RuleTester, optional TypeScript parser, Node.js 24.

**Spec:** `docs/superpowers/specs/2026-10-28-lint-required-collection-links-design.md`

## Global Constraints

- Explicit `recommended-3.8`; eleven rule IDs; no runtime/driver dependencies or autofixes.
- Direct local registration and known object-list shape required; no inferred engine or cross-file graph.
- Existing alias depth 40 and type traversal bound 200 remain bounded.
- No runtime-package change or publication; #116 stays open.

## Review Focus

- A type reached as embedded before direct registration still receives its missing-link diagnostic once.
- Unknown resolver/readOnly/embedded/virtual values cannot prove the new error.
- Scalar lists, nested lists and unregistered embedded types must not acquire new requirements.
- Mutable or escaped target types and shadowed GraphQL/runtime imports remain unknown.
- Repeated registrations, TypeScript wrappers and non-null wrappers must preserve diagnostic locations and counts.

### Task 1: Extend the rule and its coverage

**Files:** Modify `tools/eslint-plugin-simfinity/src/rules/valid-connection-field.js` and `tools/eslint-plugin-simfinity/src/analysis.js`; create `tools/eslint-plugin-simfinity/tests/collection-links.test.mjs` and `tests/eslint-collection-link-contract.test.js`; modify `tools/eslint-plugin-simfinity/tests/consumer.mjs` and `tools/eslint-plugin-simfinity/scripts/trial.mjs`.

**Interfaces:** Consumes `analyze(context)` (`origin`, `resolve`, `value`, `properties`) and `unwrap(node)`; produces the existing rule with a new `missing` diagnostic and no new exported API.

- [x] Add positive/negative RuleTester fixtures for absent/null/undefined/empty links, Mongo/Postgres/core registrations, non-null lists/items, aliases and TS assertions. Assert one `missing` diagnostic on the relation object for omission and on the link value otherwise.
- [x] Include all five Review Focus cases and valid whitespace links, singular refs, readOnly/resolver combinations, virtual results and embedded lists.
- [x] Run `node --test tests/collection-links.test.mjs` in the plugin. Expected: missing-diagnostic cases fail against baseline while valid fixtures pass.
- [x] Extend the rule with proven object-list, writable and no-resolver checks; retain existing plain-link diagnostics and limits.
- [x] Review correction: follow retaining GraphQL containers conservatively so mutations or escapes through list/non-null wrappers or object fields invalidate type provenance. Six regression cases failed before the correction; stable wrapper aliases remain supported.
- [x] Run `npm test` in the plugin. Expected: all suites pass.
- [x] Extend packed JS/TS fixtures and both engine trials with the new violation and valid exclusions. Run `npm run test:consumer` and `npm run test:trial`. Expected: exact diagnostics, no source fixes, zero diagnostics on untouched Barber files.

### Task 2: Document and verify delivery

**Files:** Modify `tools/eslint-plugin-simfinity/README.md`, `docs/guide/linting.md`, `README.md`; record results in this plan's ignored ledger.

**Interfaces:** Consumes Task 1's `missing` diagnostic; documents its supported syntax and exclusions.

- [x] Document examples, explicit unreleased-source status, unknown targets and backend-specific exclusions without claiming MOD-03 or #116 complete.
- [x] Run plugin `npm run test:security`, root `npm run lint`, `npm test`, `npm run docs:install` and `npm run docs:build`. Expected: pass; report environment/database skips explicitly.
- [x] Complete fresh whole-branch review, fix material findings with regression tests, rerun affected checks and prepare the scoped commit.
- [ ] Open a PR referencing #116 and #112, attach it to this chat, and report review/check status. Do not close the broader issue or publish a package.
