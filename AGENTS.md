# Agent guidance for the Simfinity monorepo

This file helps coding agents (and humans) work productively and safely in this repository. It complements—not replaces—the detailed rules under `.cursor/rules/`.

## What this project is

- **Workspace**: the root `simfinity-workspace` package is private. All five publishable libraries, their declarations, licenses and package READMEs live under `packages/`.
- **Examples**: `examples/barber/{mongodb,postgres,frontend}` are independent private npm applications with their own lockfiles, outside the `packages/*` workspaces. The two backends consume released Simfinity runtime packages at exact version 3.3.0; the Next.js frontend is shared.
- **Packages**: `@simtlix/simfinity-js` is the MongoDB/Mongoose facade; `@simtlix/simfinity-core` owns the shared GraphQL runtime; `@simtlix/simfinity-sql` owns driver-free relational planning/runtime; `@simtlix/simfinity-postgres` is the PostgreSQL 15+ plugin and compatible facade; `@simtlix/simfinity-mcp` generates MCP tools from a GraphQL schema.
- **Runtime**: Node.js `>=18.18.0` for library consumers. Use Node.js 24 for development and CI; documentation requires Node.js 22 or later.
- **Peers**: every package uses `graphql` ^16. The Mongo facade alone has a `mongoose` ^8 peer; MCP has an optional `@modelcontextprotocol/sdk` peer. PostgreSQL depends on SQL, `pg` and core, without MongoDB, Mongoose, or MCP.

## Authoritative rules (read these)

| Topic | Rule file |
| --- | --- |
| Architecture, core flow, global state | `.cursor/rules/simfinity-architecture.mdc` |
| Coding style, imports, errors, schema transforms | `.cursor/rules/simfinity-coding-standards.mdc` |
| Internal APIs / functions | `.cursor/rules/simfinity-core-functions.mdc` |
| Auth plugin, rules, expressions | `.cursor/rules/simfinity-auth-module.mdc` |
| Field extensions / introspection | `.cursor/rules/simfinity-extensions.mdc` |
| Tests | `.cursor/rules/simfinity-testing.mdc` |
| README / docs updates | `.cursor/rules/simfinity-documentation.mdc` |
| Barber applications and their CI | `.cursor/rules/simfinity-barber-examples.mdc` |

If something is ambiguous, prefer the matching `.mdc` file over this summary.

## Non-negotiables

1. **Do not** use `graphql-middleware`’s `applyMiddleware` or `@graphql-tools/utils` `mapSchema` on a Simfinity schema — they rebuild the schema and duplicate globally injected introspection types. Use **Envelop** plugins and in-place resolver wrapping instead (see architecture rule).
2. **Imports**: static ES imports belong at the top; match existing style (single quotes, semicolons, trailing commas in multiline constructs). Preserve MCP's lazy optional-SDK loading and the explicit import-order test fixtures described in the rules.
3. **Behavior changes**: update tests under `tests/` and public docs (`README.md`) when the public API or documented behavior changes.
4. **Package boundaries**: core and SQL must remain driver-free; PostgreSQL must not import MongoDB, Mongoose or MCP. Keep GraphQL semantics in core, relational planning/record/session orchestration in SQL, and physical SQL/DDL/codecs/driver operations in engine plugins. Backend selection is fixed for each runtime; do not add runtime switching.
5. **Compatibility**: `packages/mongodb` still publishes as `@simtlix/simfinity-js`. Preserve its entry points and `src/` deep imports inside the published archive. Keep shared helper/error identities and update package declarations for public API changes.
6. **Example boundaries**: install and test Barber apps in their own directories. Keep them private, preserve registry dependencies and separate Compose projects, and do not add them to library workspaces or npm release tooling. Native database code stays in each backend; the frontend treats GraphQL IDs as opaque strings.
7. **Mongo reference integrity**: `createMongoAdapter({ referentialIntegrity: 'transactional' })` is opt-in and fixed at startup; default `'off'` stays compatible. Await `adapter.initialize()` after schema creation and database connection. Preserve target-document locks, snapshot/majority transactions, incoming-reference checks and rollback of supplied sessions on integrity violations. Native model/driver writes remain outside that guarantee; see `docs/guide/mongodb-integrity.md`.

## Verification commands

Run from the repo root after substantive edits:

```bash
npm run lint
npm test
```

Use `npm run test:watch` while iterating; `npm run test:coverage` when coverage matters.

- For package boundaries, dependencies, exports or declarations: `npm run test:packages` checks isolated packed applications, including strict TypeScript consumers and MongoDB deep imports.
- For database behavior: run the full suite with disposable database URIs, as described in the testing rule. `npm run test:integration` covers only `tests/integration/`; additional MongoDB regression suites live directly under `tests/`.
- For documentation: `npm run docs:install` and `npm run docs:build`.
- For Barber changes: follow `examples/barber/README.md` and `.github/workflows/barber.yml`. Root lint and Vitest exclude `examples/`; run the affected app checks and the shared HTTP/browser contract against both databases for shared behavior changes. Use only disposable example databases for data-changing checks.
- For release metadata: `node scripts/release-packages.js check`. Release tooling aligns the private root version, all five package versions and exact internal dependencies; the root itself is never published.

## Layout hints

- **Implementation**: `packages/core/src/` owns the shared runtime and helpers; `packages/mongodb/src/` owns the MongoDB facade/adapter and compatibility shims; `packages/sql/src/` owns relational planning and runtime; `packages/postgres/src/` owns the plugin, SQL compilation, codecs and physical schema lifecycle; `packages/mcp/src/` owns MCP generation and transports.
- **Tests**: `tests/` covers core, both adapters, MCP and release tooling; `tests/contracts/` and `tests/fixtures/` hold shared fixtures. See the testing rule for MongoDB collection suppression in tests without a database.
- **Documentation**: `README.md` is the repository overview; `packages/*/README.md` describes each published package; `docs/` builds the public website independently of the runtime packages.
- **Barber examples**: `examples/barber/` contains both backends, the shared frontend, per-stack Compose files, and HTTP contracts. The dedicated `barber.yml` workflow owns their dependencies and checks. PostgreSQL schema exports go to ignored `examples/barber/postgres/generated/`.
- **Release tooling**: `release.yml` automatically coordinates each new aligned version on `master`: validate/package/database tests, immutable tag, npm OIDC + GitHub Packages, verified registry availability, GitHub release assets and stable Pages deployment. `publish.yml` is reusable, not a separate manual publication step. Use `scripts/release-packages.js version <version>` in a reviewed PR; do not publish from a local login. `release-state.js` prevents superseded retries from moving current releases backward; `verify-published.js` checks npm visibility and integrity. npm trusts caller `release.yml` with environment `npm-release`, restricted to `master`. See `docs/resources/contributing.md`.

## When editing

- Keep changes scoped to the task; avoid drive-by refactors.
- Extend existing patterns rather than introducing parallel abstractions.
- For GraphQL types in examples/tests: use `extensions.relation` on relationship fields; use `extensions.readOnly` where appropriate.
- Keep the root free of backup READMEs and local `.tgz`/`.zip` output. Generate temporary archives outside the repository. Archives under `docs/public/` are intentional website downloads; check links and checksums before changing them.
