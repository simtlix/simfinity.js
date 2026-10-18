# Agent guidance for the Simfinity monorepo

This file helps coding agents (and humans) work productively and safely in this repository. It complements—not replaces—the detailed rules under `.cursor/rules/`.

## What this project is

- **Workspace**: the root `simfinity-workspace` package is private. All five publishable libraries, their declarations, licenses and package READMEs live under `packages/`.
- **Examples**: `examples/barber/{mongodb,postgres,frontend}` are independent private npm applications with their own lockfiles, outside the `packages/*` workspaces. The two backends consume released Simfinity runtime packages at exact version 3.7.0; the Next.js frontend is shared.
- **Packages**: `@simtlix/simfinity-js` is the MongoDB/Mongoose facade; `@simtlix/simfinity-core` owns the shared GraphQL runtime; `@simtlix/simfinity-sql` owns driver-free relational planning/runtime; `@simtlix/simfinity-postgres` is the PostgreSQL 15+ plugin and compatible facade; `@simtlix/simfinity-mcp` generates MCP tools from a GraphQL schema.
- **Runtime**: Node.js `>=18.18.0` for library consumers. Use Node.js 24 for development and CI; documentation requires Node.js 22 or later.
- **Peers**: every package uses `graphql` ^16. The Mongo facade alone has a `mongoose` ^8 peer; MCP has an optional `@modelcontextprotocol/sdk` peer. PostgreSQL depends on SQL, `pg` and core, without MongoDB, Mongoose, or MCP.

## Authoritative rules (read these)

| Topic | Rule file |
| --- | --- |
| Development workflow and release completion | `.cursor/rules/simfinity-development-workflow.mdc` |
| Architecture, core flow, global state | `.cursor/rules/simfinity-architecture.mdc` |
| Coding style, imports, errors, schema transforms | `.cursor/rules/simfinity-coding-standards.mdc` |
| Internal APIs / functions | `.cursor/rules/simfinity-core-functions.mdc` |
| Auth plugin, rules, expressions | `.cursor/rules/simfinity-auth-module.mdc` |
| Field extensions / introspection | `.cursor/rules/simfinity-extensions.mdc` |
| Tests | `.cursor/rules/simfinity-testing.mdc` |
| README / docs updates | `.cursor/rules/simfinity-documentation.mdc` |
| Barber applications and their CI | `.cursor/rules/simfinity-barber-examples.mdc` |

If something is ambiguous, prefer the matching `.mdc` file over this summary.

## Application usage skills

When building or migrating an application with Simfinity, use the relevant repository skills below. They complement the public guides, check the installed version and engine, and can be copied with their references/assets into consumer projects. Load only the topics needed for the task; ordinary application work does not authorize library changes or publication.

| Task | Skill |
| --- | --- |
| Application design or migration | [simfinity-application-design](.agents/skills/simfinity-application-design/SKILL.md) |
| Types, relations and generated inputs | [simfinity-domain-modeling](.agents/skills/simfinity-domain-modeling/SKILL.md) |
| Scopes, operation/field permissions and write ownership | [simfinity-access-control](.agents/skills/simfinity-access-control/SKILL.md) |
| Controllers, states and transactional business rules | [simfinity-business-workflows](.agents/skills/simfinity-business-workflows/SKILL.md) |
| Workers, custom commands and native atomic operations | [simfinity-server-operations](.agents/skills/simfinity-server-operations/SKILL.md) |
| Lists, aggregates, calculations and read models | [simfinity-queries-and-reports](.agents/skills/simfinity-queries-and-reports/SKILL.md) |

## Pull request reviews

Every PR must link a repository issue explaining the problem and motivation, following the [issue and PR requirements](docs/resources/contributing.md#explain-the-change-in-an-issue). For features, establish the use case, existing Simfinity capabilities tried, why they are insufficient, the owning layer and engine compatibility. Create or reuse the issue before opening a PR; existing and automated PRs need it before approval or merge. Keep small fixes proportional. If rationale is missing, continue reviewing but report the readiness blocker; do not invent it or approve the PR.

For Simfinity PR reviews and re-reviews, use the repository skill [simfinity-pr-review](.agents/skills/simfinity-pr-review/SKILL.md), also invocable as `$simfinity-pr-review`. It covers architectural fit, application/library boundaries, lifecycle and authorization, MongoDB/PostgreSQL compatibility, and verification. Apply only the lenses relevant to the change; the rules above remain authoritative. A review request alone does not authorize posting feedback, merging or publishing.

## Non-negotiables

1. **Do not** use `graphql-middleware`’s `applyMiddleware` or `@graphql-tools/utils` `mapSchema` on a Simfinity schema — they rebuild the schema and duplicate globally injected introspection types. Use **Envelop** plugins and in-place resolver wrapping instead (see architecture rule).
2. **Imports**: static ES imports belong at the top; match existing style (single quotes, semicolons, trailing commas in multiline constructs). Preserve MCP's lazy optional-SDK loading and the explicit import-order test fixtures described in the rules.
3. **Behavior changes**: update tests under `tests/` and public docs (`README.md`) when the public API or documented behavior changes.
4. **Package boundaries**: core and SQL must remain driver-free; PostgreSQL must not import MongoDB, Mongoose or MCP. Keep GraphQL semantics in core, relational planning/record/session orchestration in SQL, and physical SQL/DDL/codecs/driver operations in engine plugins. Backend selection is fixed for each runtime; do not add runtime switching.
5. **Compatibility**: `packages/mongodb` still publishes as `@simtlix/simfinity-js`. Preserve its entry points and `src/` deep imports, and their sibling `.d.ts` declarations, inside the published archive. Keep shared helper/error identities and update package declarations for public API changes.
6. **Example boundaries**: install and test Barber apps in their own directories. Keep them private, preserve registry dependencies and separate Compose projects, and do not add them to library workspaces or npm release tooling. Native database code stays in each backend; the frontend treats GraphQL IDs as opaque strings.
7. **Mongo reference integrity**: `createMongoAdapter({ referentialIntegrity: 'transactional' })` is opt-in and fixed at startup; default `'off'` stays compatible. Await `adapter.initialize()` after schema creation and database connection. Preserve target-document locks, snapshot/majority transactions, incoming-reference checks and rollback of supplied sessions on integrity violations. Native model/driver writes remain outside that guarantee; see `docs/guide/mongodb-integrity.md`.
8. **Batched reads reproduce single reads**: an adapter's `getByIds` and `findChildrenBatch` must return exactly what `getById` and `findChildren` return for each ID or parent, and `batchesChildren` must return false whenever a batch would bypass the adapter's own `findChildren` (a copy or override, MongoDB aggregate hooks, a session). Both bundled adapters batch collection reads only with `batchedCollections: true` (only the literal `true`); without it they define neither member and keep 3.6.0's reads. PostgreSQL runs each batch in a transaction after `SET LOCAL jit = off`, the `setup` its `compileChildrenQuery` returns. Batching may reorder only unsorted or tied rows.
9. **Publication is part of completion**: when a task includes releasing a library change, the responsible contributor or agent must ensure both its `vX.Y.Z` tag and published GitHub release exist, and verify successful package publication and the applicable documentation deployment. A merged PR or version bump is not a completed release.

## Shared development and publication rule

This is a repository-wide rule for contributors and coding agents, not a local assistant preference. Follow the [development and publication contract](docs/resources/contributing.md#development-and-publication-contract) and the [Cursor workflow rule](.cursor/rules/simfinity-development-workflow.mdc).

Implement scoped changes on a branch, update the relevant documentation and tests, and merge through a reviewed PR with passing checks. When publication is requested or is already part of the agreed task, carry the work through the release workflow without asking again for the same authorization:

1. Prepare the intended version with `node scripts/release-packages.js version <version>` and validate it with `node scripts/release-packages.js check`. Keep all five packages, their exact internal dependencies and the private root aligned. Reuse a correctly prepared unpublished version instead of inventing another bump.
2. After merge, create the annotated `vX.Y.Z` tag on the validated merge commit in `master` (not the PR's head commit) and push it to GitHub. Ensure the matching GitHub release is published: the tag-triggered workflow can create it, or the contributor can publish the release in GitHub. Both must exist before completion.
3. Wait for **Release Simfinity** to finish. Verify npm and GitHub Packages for all five packages, the expected npm distribution tags and archive integrity, the GitHub release assets, and the stable documentation deployment, or the documentation gate's notice that the live site already contains it (then link that deployment). Prereleases use `next` and do not deploy the stable site.
4. Report the version, tag/release and workflow links, and verification results. If any step fails, resolve the cause and retry the original run; never move an existing release tag or describe a partial release as published. If access or another external dependency blocks completion, state exactly what remains.

Publication intent is required: ordinary edits, merges, and version changes do not authorize or trigger a release on their own. Documentation, CI, repository rules, and example-only changes do not need a library version just to land in the repository. Use the documentation-only deployment flow when website publication is requested. Publish packages through GitHub Actions/OIDC, not a local npm login; the only exception is the one-time bootstrap of a new package before it joins the release set (see the contribution guide). Manual release-workflow dispatch is preview-only.

## Verification commands

Run from the repo root after substantive edits:

```bash
npm run lint
npm test
```

Use `npm run test:watch` while iterating; `npm run test:coverage` when coverage matters.

- For package boundaries, dependencies, exports or declarations: `npm run test:packages` packs the working tree with the release packer (aligned versions and a Git checkout required); `npm run test:packages -- <manifest.json>` tests exactly a release manifest's archives instead, as the release build does. It checks extracted-archive quality, isolated packed applications, strict TypeScript consumers and MongoDB deep imports/resolution aliases. The core consumer also compiles every public core subpath (namespace, named, default and type imports) under NodeNext, Node16, Bundler and Node10, checking each member's exact type against the root and the export names both ways; it also checks the root's runtime value exports both ways (`coreRootValues`) and that the root error classes are the `auth` classes. The MongoDB consumer compiles the legacy `src/` deep imports under the same four resolutions with exact type equality. `tests/core-subpath-types.test.js` checks the export map, `typesVersions`, declared names and re-exported types without packing, and the MongoDB `src/` sibling declarations; the archive quality check requires every `exports` `types` target to be in the archive. Keep quality tooling in root development dependencies only.
- For dependency changes: `npm run test:security` audits the root lockfile including development dependencies; CI and release validation require it. Audit independent documentation/example applications separately. MongoDB requires Mongoose `^8.24.2`; retain the update-casting security regression.
- For database behavior: run the full suite with disposable database URIs, as described in the testing rule. `npm run test:integration` covers only `tests/integration/`; additional MongoDB regression suites live directly under `tests/`.
- For documentation: `npm run docs:install` and `npm run docs:build`.
- For Barber changes: follow `examples/barber/README.md` and `.github/workflows/barber.yml`. Root lint and Vitest exclude `examples/`; run each affected app's `npm run test:security`, its app checks, and the shared HTTP/browser contract against both databases for shared behavior changes. Use only disposable example databases for data-changing checks.
- For release metadata: `node scripts/release-packages.js check`. Release tooling aligns the private root version, all five package versions and exact internal dependencies; the root itself is never published.

## Layout hints

- **Implementation**: `packages/core/src/` owns the shared runtime and helpers; `packages/mongodb/src/` owns the MongoDB facade/adapter and compatibility shims; `packages/sql/src/` owns relational planning and runtime; `packages/postgres/src/` owns the plugin, SQL compilation, codecs and physical schema lifecycle; `packages/mcp/src/` owns MCP generation and transports.
- **Tests**: `tests/` covers core, both adapters, MCP and release tooling; `tests/contracts/` and `tests/fixtures/` hold shared fixtures. See the testing rule for MongoDB collection suppression in tests without a database.
- **Documentation**: `README.md` is the repository overview; `packages/*/README.md` describes each published package; `docs/` builds the public website independently of the runtime packages.
- **Barber examples**: `examples/barber/` contains both backends, the shared frontend, per-stack Compose files, and HTTP contracts. The dedicated `barber.yml` workflow owns their dependencies and checks. PostgreSQL schema exports go to ignored `examples/barber/postgres/generated/`.
- **Release tooling**: `release.yml` responds to `v*` tag pushes and published GitHub releases: validate the existing tag against aligned versions and `master` history, package/database tests, npm OIDC + GitHub Packages, verified registry availability, GitHub release assets and stable Pages deployment. Version changes and merges do not publish; manual dispatch only previews. `publish.yml` is reusable, not a separate manual publication step. Use `scripts/release-packages.js version <version>` in a reviewed PR; do not publish from a local login. `publish.yml` packs first, in its own `pack` job, before any install or test: `release-state.js verify-source` validates the source (workflows only check `GITHUB_REF`), the `pack` CLI refuses untracked or ignored files, and the manifest's SHA-256 is a job output that publish-npm, publish-gpr and github-release enforce (`SIMFINITY_RELEASE_MANIFEST_SHA256`; `publish-packages.js --execute` also requires `SIMFINITY_RELEASE_COMMIT`); build only uses it to test the same archives. `release-state.js` prevents superseded retries from moving current releases backward, fails closed when any release package is missing from npm, and gates Pages with `verify-docs` (stable only, forward only, skipped with a notice when the live site already contains the source) in a separate job without the `github-pages` environment. `verify-published.js` checks npm visibility and integrity from uncached reads (`?write=true`), retrying transient registry failures within a deadline. `github-release.js find` decides whether to create the GitHub release (never `gh release view`); stable releases clear pre-release before `--latest`. GitHub API reads go through `scripts/github-api.js` (token required, same-origin pagination), retries through `scripts/transient.js`, and release CLIs detect their entry point with `isEntryPoint` from `scripts/cli.js`, never a raw `process.argv[1]` comparison. Every workflow action is pinned to a commit SHA with a version comment (Dependabot proposes bumps); pack and publish jobs use exact Node.js 24.21.0 (pack and publish-gpr use its bundled npm; publish-npm installs npm 11.21.0 for Trusted Publishing), bumped by hand; changing `node-version` is what changes the npm that packs the archives. Re-runs and release events for an existing tag run that tag's tooling. Library CI and Database integration cancel only superseded pull request runs. npm trusts caller `release.yml` with environment `npm-release`, restricted to `v*` tags. Pages allows `v*` release tags and `master` for documentation-only deployments; dispatch those on `master` only. See `docs/resources/contributing.md`.

## When editing

- Keep changes scoped to the task; avoid drive-by refactors.
- Extend existing patterns rather than introducing parallel abstractions.
- For GraphQL types in examples/tests: use `extensions.relation` on relationship fields; use `extensions.readOnly` where appropriate; use `extensions.virtual` (not `readOnly` plus a resolver) for a field that its resolver computes and nothing stores. Code that walks `gqltype.getFields()` for storage, inputs or query arguments must skip virtual fields with `isVirtualField`, a public root export of `@simtlix/simfinity-core` (bundled packages import it from `@simtlix/simfinity-core/internal/relation-storage`); `describeModels()` already leaves them out.
- Keep the root free of backup READMEs and local `.tgz`/`.zip` output. Generate temporary archives outside the repository. Archives under `docs/public/` are intentional website downloads; check links and checksums before changing them.
