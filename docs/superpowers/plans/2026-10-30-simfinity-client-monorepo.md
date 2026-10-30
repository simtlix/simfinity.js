# Simfinity Client Monorepo Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the existing compatible browser client into the aligned monorepo and support current public schema features.

**Architecture:** Import the licensed client at packages/client, normalize descriptor/introspection metadata into its existing registry views, and build variable-bearing operations from exact roots and actual inputs. Keep browser runtime independent from all server packages. Execute inline with a fresh whole-branch review.

**Tech Stack:** ES modules, dependency-free browser JavaScript, structural TypeScript declarations, Vitest/GraphQL fixtures, existing release tooling.

**Spec:** docs/superpowers/specs/2026-10-30-simfinity-client-monorepo-design.md (approved 2026-10-30).

## Global Constraints

- Preserve @simtlix/simfinity-js-client, the default class export and existing valid calls/result shapes.
- Node >=18.18.0; browser sources and declarations require no Node/server/driver imports.
- Seven aligned packages; no release/publication/version bump in this task.
- Work on a codex/ branch isolated from the dirty original checkout and preserve source commit provenance.
- New root tests live under tests/; disposable databases only; examples keep registry dependencies and independent locks.

## Review Focus

- Failed reinitialization must not leave partially installed metadata or cross-client state (Task 1).
- Explicit null/empty clears and scalar lists must survive opt-in transformations without coercion loss (Task 3).
- Renamed/excluded roots, same-type views, and identical query/mutation names must not change CRUD selection (Task 2).
- Missing nested versions, opaque IDs and transaction tokens must not be silently discarded (Task 3).
- Client-only browser/TypeScript consumers must work without any server package or Node ambient types (Task 4).

### Task 1: Import and metadata

Files: packages/client/{package.json,LICENSE,README.md,src/SimfinityClient.js,src/metadata.js}; tests/client-metadata.test.js; tests/helpers/client-schema.js.
Interfaces: normalizeDescriptor(document) and normalizeIntrospection(schema) provide the existing type/query/mutation registries plus exact descriptor operation metadata; fetch is injected through client options.

- [ ] Add real-GraphQL tests for original init/metadata and descriptor init with no introspection, standard vs extended queries, invalid references/format, full wrappers/inputs and atomic re-init. Assert a renamed descriptor endpoint maps to its entity and two clients remain isolated.
- [ ] Run npm test -- tests/client-metadata.test.js; expect missing package/new APIs failures before import/implementation.
- [ ] Import tracked source/license/demo with provenance, implement normalization and atomic initialization; no server imports.
- [ ] Run the metadata suite; expect all tests pass; commit the task.

### Task 2: Exact queries, filters, selections and transport

Files: packages/client/src/{SimfinityClient.js,metadata.js,selection.js}; tests/client-queries.test.js; tests/client-http.test.js.
Interfaces: query(name,args?,fields?), findView(name,params?), getViews(type?), builder.filter(group), where(field,filterObject), collectionArgs(path,args); existing methods remain.

- [ ] Add tests executing built documents with graphql(): canonical list vs views, param values, custom scalar/object/interface/union results, full filter groups/valuePath/$parent/operators, nested collection args, existing joins/groups/counts/aggregate results, unknown arguments and nullable partial responses. Assert HTTP errors retain graphQLErrors and callbacks/fetch injection work asynchronously.
- [ ] Run the new suites; expect absent API/incorrect generated-query failures.
- [ ] Implement exact lookups, safe variable allocation and selection handling, retain legacy behavior and transport error envelopes.
- [ ] Run all client suites; expect green; commit the task.

### Task 3: Protected writes, input graphs and transactions

Files: packages/client/src/{SimfinityClient.js,inputs.js}; tests/client-mutations.test.js.
Interfaces: concrete input graph cleaning; preserveEmpty/includeCollections/inputType opt-ins; delete(type,id,fields?,{version}); transaction(operations,fields?,{name}?).

- [ ] Add tests for readOnly managed versions on root updates/actions, protected deletes and nested deleted objects, root vs nested backrefs, null/empty/scalar-list inputs, safe versions, immutable caller inputs, oneOf operation payloads and unchanged $K/$$K tokens/errors. Test legacy transformations/default signatures too.
- [ ] Run mutations suite; expect version loss and absent transaction failures.
- [ ] Implement concrete-input transformation and transaction requests; reject explicitly discarded preconditions and preserve server errors without write retries.
- [ ] Run all client suites; expect green; commit the task.

### Task 4: Package, declarations, documentation and integration

Files: packages/client/types/index.d.ts; scripts/release-packages.js; scripts/test-packages.js; tests/release*.test.js and fixtures as required; tests/client-package.test.js; tests/fixtures/client-*; tests/integration/client-*.test.js; root README/AGENTS/rules; docs/guide/client.md; docs/.vitepress/config.*.
Interfaces: seventh release manifest entry @simtlix/simfinity-js-client; client root default export plus complete structural types, four TS resolution modes/browser-only environment.

- [ ] Add failing package-set/declaration/import tests and real-schema fresh-process metadata tests for both adapters and disabled introspection. Add disposable database integration exercising client calls for operators/frames, views/counts, protected writes and rollback.
- [ ] Run targeted suites; confirm missing seventh package/type/coverage failures.
- [ ] Integrate aligned manifest/lock, declarations and isolated packed/browser/Barber call-pattern consumers; document import/version policy, all public additions, metadata limits and OIDC follow-up.
- [ ] Run lint, npm test, npm run test:security, npm run test:packages, release check and docs install/build. Run database tests if disposable infrastructure is available; otherwise record exactly which coverage cannot execute. Commit the task.

### Task 5: Whole-branch review and completion

- [ ] Generate a review package covering the base commit through HEAD and dispatch a fresh reviewer against spec, plan, code, tests and recorded decisions.
- [ ] Reproduce material findings with failing tests, fix them and rerun relevant verification plus the full suite if behavior changes.
- [ ] Commit verified fixes and report implementation, evidence and any actual blockers; preserve the managed worktree for review. No publication or shared-branch merge.
