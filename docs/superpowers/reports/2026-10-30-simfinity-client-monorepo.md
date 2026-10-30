# Simfinity client monorepo verification

Date: 2026-10-30
Issue: https://github.com/simtlix/simfinity.js/issues/172
Implementation under test: `3a08fcf` (base `55fb651`).

The approved compatible client import is implemented under `packages/client` with its existing public npm name and default class export. It has no runtime dependencies. Descriptor and introspection metadata drive exact roots, views, current filters and collection arguments, concrete mutation inputs, optimistic versions and transactions. The source joins the aligned seven-package release set. No version bump, tag, package publication or deployment was requested or performed.

The original checkout and sibling client checkout were preserved. The source snapshot's provenance is recorded in the client README. Barber retains its existing registry dependency and independent lockfile; its public call patterns are exercised by the isolated packed consumer. The typed client replaces its ambient shim only after a verified future publication.

## Evidence

- Client regression and metadata suites: 38 passed, including fresh-process MongoDB/PostgreSQL metadata with extended introspection enabled and disabled.
- Disposable MongoDB replica-set and PostgreSQL client integration: 4 passed. Covers current operators and element/parent comparisons, named-view filtering/counts, stale protected writes, child versions/deletes and transaction rollback/error indexes.
- Full suite against both disposable engines: 220 files passed; 10301 tests passed and 237 skipped (10538 total), 207.04 seconds. The standalone MongoDB URI was not configured; standalone variants and existing conditional matrix cases remain skipped. All four new client database tests ran and passed.
- `npm run lint`: passed.
- `npm run test:security`: passed, zero vulnerabilities.
- `npm run test:packages`: all seven archives scored 100/100; isolated JavaScript and strict TypeScript consumers passed, including four module-resolution modes and a real browser bundle without server packages or Node ambient types.
- `node scripts/release-packages.js check`: passed with seven aligned 3.18.0 source manifests and exact internal dependencies.
- Documentation install and build: passed. VitePress reports its ordinary large-chunk warning.

The complete suite ran on a fixed commit. Its first attempt hit MongoDB's minimum 500 MiB free-space requirement during index creation in nine suites; the disposable MongoDB tmpfs was enlarged from 768 MiB to 1536 MiB and the full run restarted on unchanged source. An earlier run overlapped a commit and was stopped because its HEAD-provenance assertions were invalidated; it is not completion evidence. The first broader run exposed stale six-package test expectations, which were corrected, and an unchanged SQL import timeout that passed in isolation.

## Independent review and one fix pass

One independent whole-branch review identified seven important findings and one declaration finding. The declaration finding was regraded as important because TypeScript consumers could not use exposed public metadata. All eight entered one test-first fix pass; no minor findings were deferred and no second review was dispatched.

The regression tests were observed failing before their fixes and then passed:

1. Repeated deep selections merge recursively without dropping previous fields (`merges repeated deep selections without losing previously requested fields`).
2. Introspection-only clients preserve required child IDs/versions even when that child has no mutation roots (`retains protected child identity and version without exposed child roots under introspection`).
3. Automatic unprotected deletion forms produce scalar identities (`converts automatic unprotected nested deletion forms to scalar identities`).
4. Explicit blank values survive numeric coercion with `preserveEmpty` at every depth (`preserveEmpty retains explicit blanks before numeric coercion at every depth`). A related enum regression prevents numeric-looking enum names from triggering numeric coercion.
5. Auto-selection avoids nested fields with required arguments and invalid object fallbacks; declared argument defaults remain eligible (the two auto-selection regression tests).
6. Invalid descriptor input references fail atomically before replacing installed metadata (`rejects invalid descriptor update input %s before replacing installed metadata`, three cases).
7. Ambiguous legacy singular reads require an exact root (`requires an exact root when singular reads are ambiguous under introspection`).
8. Structural declarations expose abstract membership, state-machine metadata and field root-input usage. A strict browser-only TypeScript consumer failed on the missing properties before the declarations changed; all packed resolution-mode consumers now compile these properties.

## Rulings, in execution order

1. Use two workers and a 15000 ms CLI test timeout on the shared host after existing default-concurrency timeouts and an isolated passing SQL rerun. No production or test-source timeout was changed. Cost if wrong: functional regressions with latency below that limit could escape this run.
2. The functional suite does not establish performance below that timeout. Dedicated benchmarks are required for latency claims. Cost if wrong: a sub-timeout performance regression remains undetected.
3. Publication and npm Trusted Publisher configuration remain outside this source-integration task. The migration requirement is documented for the next requested release. Cost if wrong: that release cannot publish the client until a maintainer configures the existing package's trust relationship.
4. Withhold full-suite success until a fixed-HEAD run after all review fixes; discard the interrupted provenance-invalid run. Cost: an additional complete verification run was required.

## Remaining scope

No product implementation or review findings remain open. Publication is a separate follow-up, including Trusted Publisher configuration and verification in both registries. The managed branch/worktree remains available for PR review.
