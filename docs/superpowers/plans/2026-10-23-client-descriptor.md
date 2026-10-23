# Client Descriptor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Implement the approved schema-owned descriptor, early public introspection opt-out and explicit HTTP endpoint.

**Architecture:** A side-effect-free configuration module coordinates the legacy installer per GraphQL peer. Core captures schema metadata independently of storage, and a Node-only HTTP subpath serves immutable JSON. Runtime ownership and auth execution remain unchanged.

**Tech Stack:** ES modules, graphql 16, Node >=18.18.0, Vitest, TypeScript consumer fixtures.

**Spec:** ../specs/2026-10-23-client-descriptor-design.md

## Global Constraints

- Default introspection behavior remains unchanged in 3.x.
- No deletion of installed metadata, schema cloning or new GraphQL markers.
- No drivers/MCP/Node built-ins in the core main-entry graph.
- Exact schema identity; no transformed-schema or cross-core adoption.
- No release version change, merge, push or client repository changes.
- Implement inline in the existing branch; review the whole change independently at the end.

## Review Focus

- Import ordering and repeated module evaluation cannot silently re-enable disabled metadata (task 1).
- Query/mutation name collisions and mutable registration replacement cannot contaminate descriptors (task 2).
- Prototype-like GraphQL names and arbitrary custom scalar defaults must remain safe JSON (task 2).
- Conditional requests must authorize before 304, and HEAD failures must have no body (task 3).
- Declaration graphs must keep core free of Node types unless HTTP is imported (task 4).

### Task 1: Early introspection configuration

Files: create packages/core/src/introspection-config.js and tests/fixtures/introspection-configuration.js; modify introspection.js; create tests/introspection-configuration.test.js.
Interfaces: configureIntrospection({ fieldExtensions: false }): void; internal introspectionState(): per-peer configuration state.

- [x] Write fresh-process assertions for early disable, default preservation, late rejection, unrelated schemas, repeated module evaluations and facade imports.
- [x] Run npm test -- tests/introspection-configuration.test.js; expect missing configuration export/module.
- [x] Add the side-effect-free configuration module, make existing metadata helpers tolerate disabled mode, preserve installer identity/default behavior.
- [x] Run configuration, schema-initialization and field-metadata-names suites; expect all passing.

### Task 2: Schema-owned descriptor

Files: create packages/core/src/client-descriptor.js and package-info.js; modify runtime.js, index.js and release-packages.js; create tests/client-descriptor.test.js.
Interfaces: internal captureClientDescriptor(schema, registrations, queryability): void; public buildClientDescriptor(schema): frozen ClientDescriptor.

- [x] Write behavior tests covering two schemas/one runtime, equal names/two runtimes, replacement, actual roots/inputs, custom queries/views, state actions, virtuals, inverse fields, unsupported storage scalars, inherited names and defaults.
- [x] Run descriptor tests; expect absent builder.
- [x] Capture allowlisted graph data at schema creation; use existing ownership/classification helpers, never describeModels. Preserve deferred scalar-default serialization so schema creation does not newly invoke it.
- [x] Add a generated package identity module kept aligned by the existing release helper (without bumping versions); verify alignment in tests.
- [x] Run descriptor and affected existing runtime/auth/view/virtual suites; expect all passing.

### Task 3: HTTP handler

Files: create packages/core/src/http.js and tests/client-descriptor-http.test.js; re-export from database facades.
Interfaces: createClientDescriptorHandler(schema, { authorize, context?, onError? }): async Node handler.

- [x] Write GET/HEAD/405, required access decision, gated cache-hit, ETag weak/list/wildcard, masking and observer-failure tests.
- [x] Run handler tests; expect absent handler.
- [x] Implement canonical JSON, SHA-256 ETags, fixed cache policy, context/access gate and error envelope with no HEAD bodies.
- [x] Run handler suite; expect all passing.

### Task 4: Public declarations, documentation and verification

Files: core/package.json, core/types/index.d.ts, new core/types/introspection.d.ts and http.d.ts, facade declarations, scripts/test-packages.js, tests/core-subpath-types.test.js, README and relevant docs/rules.
Interfaces: documented/exported builder, configuration subpath and HTTP types matching runtime exactly.

- [x] Add package consumer assertions for new exports/subpaths, isolated bootstrap, readonly descriptor shapes, HTTP generics, Node-free core consumers and package identity alignment.
- [x] Implement declarations/export maps and public documentation including migration limits and bootstrap ordering.
- [x] Run lint, full npm test (DB suites may skip without disposable URIs), test:packages, release metadata check and docs:build; record actual outcomes.
- [x] Request one fresh whole-change review, resolve material findings with regressions, and leave the solution local on this branch.

## Execution record

Design approval authorizes implementation; no second approval of the same scope is required. No commits or publication are prerequisites for local verification; the package archive checker may require tracking the new files, without including private/untracked files outside this task.


## Implementation decisions and review

- Package identity is generated JavaScript, checked and maintained by the existing
  release helper. This avoids Node imports in core and JSON import syntax beyond
  the supported Node 18.18 floor; the release version is unchanged.
- Input defaults retain the type/value until the first explicit descriptor build,
  so schema construction does not newly execute custom scalar serializers. The
  deferred references are released after that build; the returned JSON is frozen.
- Core supplies `@types/node` for its HTTP subpath and the facade re-exports, avoiding
  new manual TypeScript setup for existing facade consumers. The root-only
  declaration graph is checked independently with no implicit Node types.
- The independent final review found one material classification defect: a custom
  query could inherit an excluded entity's endpoint name. A failing regression
  preceded the correction; included-root capture plus exact type identity also
  covers overlapping generated singular names. The reviewer verified String and
  entity custom results and overlapping generated roots, with no remaining
  material findings. There were no minor findings or deferred fix requests.
- The user's local-only instruction already selects retaining this branch and
  worktree. There is no integration menu or additional scope approval to request.
- Lifecycle integration point: descriptor capture follows `constructSchema()` in
  `createSchema()`. It adds no mutation hooks, adapter calls or query-path auth
  markers. Concurrent lifecycle work should preserve this successful-construction
  hook; PRs #147 and #148 are not included.


## Completion verification — 2026-10-23

All checks below ran in this worktree on the implementation based on
`738767141ecb3e017a9a590e52c7e1a795f68428`, using Node.js v24.2.0.

| Check | Result |
| --- | --- |
| `npm run lint` | Passed. |
| `npm test` without disposable database URIs | 102 files / 3565 tests passed; 51 files / 1688 tests skipped. No database integration claimed. |
| `npm run test:packages` | All five extracted archives scored 100/100; core, SQL, PostgreSQL, MCP with/without SDK, and MongoDB runtime/strict TypeScript consumers passed. Core/Mongo subpaths cover NodeNext, Node16, Bundler and Node10. |
| Core root-only TypeScript | Passed with `types: []`, ES2022-only libs and no Node/HTTP declarations in the loaded graph. |
| `npm run test:security` | Passed; zero vulnerabilities. |
| `node scripts/release-packages.js check` | All five packages remain aligned at 3.12.0; generated package identity matches. No version bump. |
| `npm run docs:build` | Passed; existing Vite chunk-size advisory remains. |
| Whitespace | Passed with CR-at-EOL recognized for the existing CRLF lockfile. |

Fresh-process adapter fixtures cover core, MongoDB default/transactional and
PostgreSQL, with legacy metadata enabled and disabled, without database I/O.
No external dependency blocks this local scope. Real database integration and
adopting the descriptor in the separate client repositories are not verified here.
No merge, push, release, remote issue/PR modification or consumer changes occurred.
The implementation is retained as a local checkpoint on `feat/101-schema-descriptor`.
The branch and worktree remain available for follow-up; no remote integration is authorized.
