# SQL Plugins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Extract a driver-free SQL package with a versioned plugin contract and preserve PostgreSQL behavior.

**Architecture:** SQL owns relational planning, record reconstruction and adapter orchestration. PostgreSQL supplies physical schema/query/record compilation and driver operations. Existing PostgreSQL entry points delegate to the new core.

**Tech Stack:** ES modules, GraphQL 16, pg8, Vitest4, npm workspaces, Node24, Docker.

**Spec:** docs/superpowers/specs/2026-09-16-sql-plugins-design.md

## Global Constraints

- Library Node >=18.18.0; Node24 development/CI; GraphQL ^16.11.0; PostgreSQL >=15.
- Version3.3.0, all five published package versions and exact internal dependencies aligned.
- SQL depends on core only; PostgreSQL depends on SQL, core where directly imported, and pg; MongoDB/MCP boundaries preserved.
- Fixed plugin/configuration per runtime; current GraphQL API, scopes, hooks, states, FK enforcement, physical PostgreSQL metadata and DDL preserved.
- No data-changing tests on existing user applications; disposable databases only.

## Task 1: Logical relational schema and PostgreSQL lowering

Files: create packages/sql/src/schema/plan.js; modify packages/postgres/src/schema/describe.js; create tests/sql-schema.test.js and tests/fixtures/postgres-3.2-schema.json.

Interfaces: produce planRelationalSchema(models, {schema, naming}) as specified. Logical columns have scalar (ID, String, Int, Float, Boolean, DateTime, Enum, Embedded), list, nullable, optional default `{kind:'identity'}` or `{kind:'value',value}`, and presenceColumn. Logical checks use kind/state/column/value descriptors; no SQL expressions. Plan returns schema, tables, checkOrder, uniqueValues, requirements. PostgreSQL describeRelationalSchema(plan) lowers it; existing describeDatabase(registrations, options) invokes the planner with PostgreSQL naming rules.

- [x] Capture 3.2 descriptions and DDL using current schemaFixture plus edge cases before changing implementation.
- [x] Add red tests asserting scalar:'ID' rather than uuid, embedded storage layout, FK targets, null/empty ownership metadata, no SQL, capability requirements, and PostgreSQL lowering equality against the captured fixture.
- [x] Implement pure planner and engine lowering. Keep constraintBuilder and SQL expression compilation in PostgreSQL; replay logical checks in original order so descriptions/DDL stay identical.
- [x] Run new planner tests and existing postgres-schema/metadata/constraints suites; commit scoped files.

## Task 2: SQL runtime and PostgreSQL plugin

Files: create packages/sql/src/{index,adapter,records,transactions,plugin}.js; create packages/postgres/src/{plugin,record-statements}.js; update packages/postgres/src/{index,adapter,records,transactions}.js; create tests/sql-plugin.test.js and integration/new-entry-point coverage. Package manifest/types work belongs to Task3.

Interfaces: consume Task1 planner plus the exact plugin contract in the spec. Public createSQL({plugin}) and postgresPlugin({pool,schema}) expose the same runtime operations as createPostgres; plugin factories allow no initial options so existing namespace configure(options) remains usable. SQL source cannot embed PostgreSQL syntax or import PostgreSQL modules. Existing low-level PostgreSQL file imports used by tests remain valid via wrappers.

- [x] Add tests first for missing/malformed plugin, incompatible apiVersion, unsupported required capability, independent runtimes, configure-once, current facade equivalence and a non-PG recording plugin exercising create/read/update/delete/nested ownership without PostgreSQL casts or driver assumptions.
- [x] Move adapter/record/session orchestration into SQL. Delegate every statement and driver-specific value/transaction/error operation using the exact contract; preserve lifecycle order, UUID behavior through the PG plugin, result decoding and confirmed-abort retries.
- [x] Implement PostgreSQL plugin and record statement compiler by moving existing SQL text, with unchanged physical schema/query functions. Forward legacy createPostgres/default exports and internal wrappers to shared SQL implementations.
- [x] Run new plugin tests and existing postgres runtime/options/transaction tests. Record exact commands and results; commit only owned files.

## Task 3: Packaging, declarations and release tooling

Files: packages/sql/{package.json,LICENSE,types/index.d.ts,README.md}; packages/postgres/{package.json,types/index.d.ts,README.md}; scripts/{release-packages,test-packages}.js; tests/{release-packages,publish-packages}.test.js; .github/workflows/{release,publish}.yml; root/package manifests/lock and version metadata.

Interfaces: expose concrete SQLPlugin, relational plan, physical storage and SQL runtime/session/model types; PostgreSQL pool/session native types remain source compatible. Publication order core, SQL, MCP, PostgreSQL, MongoDB. Existing script consumers must get SQL archives when installing PG.

- [x] Add SQL package metadata and typed old/new consumer cases; assert isolated SQL install never resolves pg/Mongoose/MCP/SDK.
- [x] Update five-package release set and fixtures, topological dependency validation, manifests and workflow staging/summary text. Keep fail-closed integrity checks.
- [x] Align to3.3.0 with release helper and regenerate root lock; run release/publisher tests, lint, and npm run test:packages.
- [x] Commit scoped packaging/declaration changes after review of runtime interface.

## Task 4: Integration, documentation and publication

Files: README.md, docs/guide/sql-plugins.md, docs/.vitepress/config.mts, relevant database/API/package docs, AGENTS.md, .cursor/rules/*.mdc, starter source/version assets, example dependency manifests after package publication.

- [x] Document architecture, full plugin contract, supported capabilities, old/new setup and immutable selection; advertise only PostgreSQL initially. Update development rules and package counts.
- [x] Run root lint/tests; full database suite on disposable Mongo/Postgres; verify an existing3.2 schema with new createSQL+postgresPlugin in validate mode and compare generated SQL; test both Barber backends against packed packages while retaining registry manifests in committed examples.
- [ ] Build docs and verify primary navigation/setup examples; request independent whole-branch review and resolve findings.
- [ ] Push PR, wait relevant CI at exact head, merge; create tag/release following existing format; publish all five verified npm artifacts in dependency order under standing user authorization.
- [ ] Verify anonymous registry metadata/tarballs and consumer installs; update examples to released3.3.0, build current starter assets and publish matching website; verify public pages.
- [ ] Clean only owned worktree/test resources, keep master current and original demo healthy.
