# Descriptor review corrections implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans. Implement inline; only the final independent review is delegated.

**Goal:** Apply the approved package extraction, rootInputUsage and PR #149 review corrections.
**Architecture:** Core captures raw registrations by schema identity; the optional descriptor package builds and serves versioned metadata. Shared errors and relation helpers retain their identities.
**Tech Stack:** ES modules, GraphQL16, Node>=18.18, Node24 for checks, Vitest and strict packed TypeScript consumers.
**Spec:** ../specs/2026-10-23-client-descriptor-design.md (2026-10-25 revision)

## Global Constraints

- Work only in this worktree/branch; no changes to other sessions or consumers.
- Preserve 3.x introspection default, driver-free core/SQL, public middleware and schema ownership.
- Sixth package aligned at3.12.0 with exact core dependency; no version bump, merge or publication.
- Update PR #149 after verification; do not post comments or change issues.

## Review Focus

- Import descriptor first, then opt out: no accidental runtime import through errors/helpers.
- Later registration replacement and auth wrappers do not change captured registration metadata.
- Root input hints cannot leak into nested input semantics or excluded mutation roots.
- Node-free declarations must compile under types:[] and isolated dependency layouts.
- Release manifests/registry safeguards must include the sixth package without weakening first-publication gates.

### Task 1: Package and registration ownership

**Files:** core/src/schema-registrations.js, descriptor/{src,types,package.json,README.md,LICENSE}, core/facade exports, descriptor/configuration tests.
**Interfaces:** captureSchemaRegistrations(schema, registrations, queryable); schemaRegistrations(schema); descriptor buildClientDescriptor(schema), createClientDescriptorHandler(schema, options).
- [x] Add extraction/import-order regressions; run them and observe missing package/export failure.
- [x] Move format/HTTP/types into descriptor, add raw immutable registration capture and canonical internal error export, remove old facade/core exports/dependency.
- [x] Run descriptor/configuration suites; expect pass.

### Task 2: Root input hints and review coverage

**Files:** descriptor builder/HTTP, tests/client-descriptor*.test.js, fixtures/client-descriptor*.js, introspection fixture.
**Interfaces:** field.rootInputUsage?: {add?:required|optional,update?:required|optional}; onError only unexpected failures.
- [x] Add failing rootInputUsage and observer-count assertions; observe failure before implementation.
- [x] Derive usage from actual root input fields including defaults; correct observer behavior.
- [x] Add legacy key parity, Serie/Season/Episode examples, inverse ambiguity/storage-only, empty inputs, validated-scalar chains, real auth wrapping and disabled auth, HTTP gate/content assertions, byte/ETag determinism and permissive-adapter fixtures; test MCP observable annotations/titles.
- [x] Run focused suites; expect pass.

### Task 3: Six-package tooling and declarations

**Files:** scripts/release-packages.js, scripts/test-packages.js, release fixtures/tests, package-lock.json, package boundary tests, relevant workflows.
**Interfaces:** sixth manifest/archive entry; structural request/response types; generated descriptor package identity.
- [x] Add sixth-package release and types:[] consumer checks; observe old release-set failures.
- [x] Update release order, generated identity, fixtures, packaging consumers and applicable workflow references. Preserve fail-closed unbootstrapped package handling.
- [x] Run release/package/security checks; expect pass.

### Task 4: Documentation and delivery

**Files:** README/package READMEs, docs reference/API/errors/troubleshooting/compatibility, rules/skills, approved design record.
- [x] Correct auth example; document exact imports, production setup, full format sample, rootInputUsage/nested distinctions and proposal deltas. Update six-package guidance.
- [x] Run lint, full tests, docs build and required package/security checks; record actual results.
- [x] Obtain required independent final review and resolve findings with evidence.
- Delivery: commit/push the correction and update the existing PR description; no merge/release.

## Pre-flight and rulings

Task1 supplies raw registrations to Task2 builder; queryability and initial state are captured without callbacks. Task3 publishes Task1 package/types and keeps exact alignment. Task4 documents Task2 final names, including rootInputUsage rather than the older write proposal. No interface conflicts.
The user explicitly approved these changes and corrections after clarifying input semantics; no second design approval is required. GraphQL schema declarations are treated as immutable after construction; metadata construction moves to the optional package's first build while core snapshots registrations. Keep ledger in the existing ignored SDD workspace.

## Verification of the correction

On Node 24.2.0, `npm test -- --maxWorkers=4` with dedicated disposable MongoDB 8
replica-set/standalone and PostgreSQL 16 containers passed 155 files: 5264 tests passed,
3 skipped. The containers were removed afterward. Lint, documentation build,
release alignment and security audit passed (0 vulnerabilities). All six packed
archives scored 100/100; all seven isolated runtime/TypeScript consumer cases
passed, including descriptor import order, Node HTTP compatibility and main-entry
`types:[]` without Node ambient declarations. Mongo's existing MCP AbortSignal
requires the DOM library in that check. A read-only independent review found no
actionable defects. These are results for this correction, not the older PR head.

The audit required compatible development-transitive lock updates for body-parser,
fast-uri and Zod, documented in the next-release notes; runtime declarations and
versions remain unchanged.

Integration remains separate: PR #147 merged at master e6fa85aadc0ff19fe46e351b5c1569630d86ea02
while this work retained its agreed base 738767141ecb3e017a9a590e52c7e1a795f68428.
GitHub reports PR #149 conflicts with current master. Reconcile lifecycle capture,
shared guidance/docs, package exports and consumer-test fixtures when updating
the base, then rerun verification on that result. PR #148 remains open and was not
incorporated. The new package also needs registry bootstrap/trusted publisher
setup before any future release; this task performs no publication.
