# Skypack Package Quality Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task by task. Steps use checkboxes for tracking. This document proposes work; creating the plan does not implement or publish it.

**Goal:** Make all five published Simfinity libraries pass the official Skypack package checks while preserving existing consumers and preventing packaging regressions.

**Architecture:** Correct package metadata and extend the existing packed-consumer checks. Keep the runtime and dependency boundaries intact. Treat security audit findings and the stale external Skypack listing separately from the metadata score.

**Tech Stack:** Node.js, ES modules, npm workspaces, TypeScript NodeNext consumer checks, `@skypack/package-check@0.2.2`, GitHub Actions.

**Spec:** The user's request to review the Skypack score and plan improvements; the requirements below; `AGENTS.md`; `.cursor/rules/simfinity-development-workflow.mdc`; and `docs/resources/contributing.md#development-and-publication-contract`.

**Implementation review, 2026-09-24:** Tasks 1–3 are implemented and verified; the report is `docs/superpowers/reports/2026-09-24-package-security.md`. Task 4 is proceeding through review and release. The final map also preserves the extensionless `package` alias. Trailing-slash directory specifiers are explicitly outside the retained resolution contract: they were never ESM entry points, and Node export maps cannot retain the root `/` alias. Canonical package/file imports and the 50 recorded resolution paths are preserved.

## Global Constraints

- Preserve the GraphQL API, scopes, relationships, transaction behavior and fixed backend selection.
- Library consumers: Node.js `>=18.18.0`; development and CI: Node.js 24; documentation: Node.js 22 or later.
- Keep MongoDB published as `@simtlix/simfinity-js`, including existing `src/` deep imports and shared helper/error identities.
- Keep core and SQL driver-free; PostgreSQL must not pull MongoDB, Mongoose or MCP. Add quality tooling only to root development dependencies.
- Retain ESM and the existing declarations. Do not add a CommonJS build, browser shims or `sideEffects: false` to improve a score.
- Exclude the private root, documentation application and Barber examples from the five-library score gate.
- Keep versions and exact internal dependencies aligned. Publication follows tag/release-triggered Actions with OIDC; no local npm publication.
- This planning task does not change package versions or authorize a new release by itself.

## Review Focus

1. An export map can block formerly accessible paths: compare the published MongoDB archive's paths and legacy resolution aliases before and after the change in Task 1.
2. A metadata check can pass with missing or unusable declarations: retain archive-content assertions and strict TypeScript consumers in Tasks 1–2.
3. A quality tool can accidentally become a runtime dependency: retain isolated dependency checks and verify the checker is absent from consumer lockfiles in Task 2.
4. An export can resolve to a different module instance: preserve the existing root/deep-import identity and schema-introspection tests in Task 1.
5. A local audit or stale CDN result can be mistaken for the published package's state: record audit scope in Task 3 and verify the exact released artifacts independently in Task 4.

## Verified baseline — 2026-09-21

The [Skypack listing](https://www.skypack.dev/view/@simtlix/simfinity-js) reports its last update as **August 11, 2021**. Its HTML marks four checks missing; the numeric score and Package Security result remain loading in the retrieved page. Do not attribute a numeric live-site score to this observation.

All five npm `latest` versions inspected are **3.4.1**. Their public tarballs were downloaded and inspected, rather than relying only on the workspace manifests.

| Check | Skypack's MongoDB listing | Published 3.4.1 artifacts | Required work |
| --- | --- | --- | --- |
| ES Module Entrypoint | Missing | All five declare `type: module` | Preserve and verify |
| Export Map | Missing | Missing only from MongoDB | Add a compatible MongoDB map |
| Keywords | Missing | Missing from all five | Add package-specific keywords |
| TypeScript Types | Missing | All five declare and ship `types/index.d.ts` | Preserve and test consumers |
| License | Pass | All five declare Apache-2.0 and ship LICENSE | Preserve |
| README | Pass | All five ship README.md | Preserve |
| Repository URL | Pass | All five identify the repository and package directory | Preserve |
| Package Security | Loading/unconfirmed | Separate dependency audit required | Task 3 |

The official checker was run against the extracted **unmodified** npm archives:

- MongoDB fails at Export Map.
- Core, SQL, PostgreSQL and MCP pass Export Map and fail at Keywords.
- The checker exits on the first failure; these outputs alone do not enumerate every missing check.

In separate temporary copies, adding keywords to all five and the candidate MongoDB export map below made the official checker report **100/100 for every package**. No repository manifests were changed. This experiment verifies metadata feasibility, not runtime compatibility, security or a refreshed Skypack website score.

## Task 1: Complete metadata without breaking imports

**Files:**

- Modify: `packages/{mongodb,core,sql,postgres,mcp}/package.json`.
- Modify: `scripts/test-packages.js` for compatibility coverage.
- Create: `tests/fixtures/mongodb-published-paths.json` containing the baseline import/resolution inventory.
- Modify: `package-lock.json` only as required to keep workspace metadata consistent.

**Interfaces:** Keep the package root resolving to the current implementation and declarations. Preserve the existing MongoDB published file paths, including package metadata, declarations and documentation. Other packages retain their existing export maps.

- [x] Capture the baseline MongoDB paths from the registry's 3.4.1 archive before editing exports. Store the relative paths in the fixture; do not depend on a live registry lookup for future CI tests. Include every published `src/*.js` path recursively, `types/index.d.ts`, `package.json`, README.md, LICENSE and both published aggregation Markdown files.
- [x] Add existing extensionless `require.resolve` aliases to the baseline where Node resolves them, including `src`, `src/auth` and extensionless JavaScript paths. This preserves resolution behavior without promising CommonJS execution of an ESM package. Keep the already-tested ESM imports with explicit `.js` extensions.
- [x] Extend the isolated MongoDB consumer to resolve each fixture entry, assert that the resulting file exists, and retain actual ESM imports for root, auth, errors, MCP and adapter entry points. Compare root/deep-export object identities using the existing assertions. Run `npm run test:packages` before editing the manifests to establish the baseline.
- [x] Add this candidate export map to `packages/mongodb/package.json`, keeping `main`, `type`, `types`, `files` and dependency declarations unchanged:

```json
{
  "exports": {
    ".": {
      "types": "./types/index.d.ts",
      "default": "./src/index.js"
    },
    "./src": "./src/index.js",
    "./src/auth": "./src/auth/index.js",
    "./src/*.js": "./src/*.js",
    "./src/*": "./src/*.js",
    "./*": "./*"
  }
}
```

The explicit `.js` pattern preserves full filenames; the other source pattern retains extensionless resolution. The final pattern preserves already accessible non-source files. MongoDB historically exposed the archive, so tightening that boundary belongs in a separately reviewed compatibility change. Confirm this candidate against the baseline fixture before accepting it. [Node's export-map guidance](https://nodejs.org/api/packages.html#package-entry-points) explains why adding a root-only map can break consumers.

- [x] Add these keyword arrays:

| Package directory | Keywords |
| --- | --- |
| mongodb | `simfinity`, `graphql`, `mongodb`, `mongoose`, `crud`, `nodejs` |
| core | `simfinity`, `graphql`, `runtime`, `schema`, `crud`, `nodejs` |
| sql | `simfinity`, `graphql`, `sql`, `relational`, `database`, `nodejs` |
| postgres | `simfinity`, `graphql`, `postgresql`, `postgres`, `sql`, `nodejs` |
| mcp | `simfinity`, `graphql`, `mcp`, `model-context-protocol`, `nodejs` |

- [x] Run `npm run test:packages`, including existing strict TypeScript consumers. Do not claim that all deep imports gain TypeScript declarations; this change preserves the existing typed root API.
- [x] Verify the resolver fixture on Node.js 18.18.0 and Node.js 24 using the same packed files. Run these focused resolution checks without requiring development tools to execute on the older consumer runtime.
- [x] Commit the metadata and compatibility tests together after confirming no published paths were removed.

**Acceptance:** Both missing metadata categories are fixed; existing resolution, ESM usage and root types still work; library dependency boundaries are unchanged.

## Task 2: Check the actual npm archives in CI and release validation

**Files:**

- Modify: root `package.json` and `package-lock.json`.
- Modify: `scripts/test-packages.js`.
- Modify: `docs/resources/contributing.md` to explain the package-quality gate.
- Inspect existing callers: `.github/workflows/master.yml` and `.github/workflows/publish.yml`; both already run `npm run test:packages`.

**Interfaces:** The existing `pack(path)` helper continues returning an archive path and now rejects an archive that fails quality checks. `npm run test:packages` remains the single entry point used by development and release workflows.

- [x] Install the checker as an exact root development dependency:

```sh
npm install --save-dev --save-exact @skypack/package-check@0.2.2
```

- [x] Resolve its CLI from the root development installation using `createRequire(import.meta.url).resolve('@skypack/package-check/index.bin.js')`. Do not install it in any published package or consumer fixture.
- [x] After `npm pack`, extract each archive into a unique directory under the script's existing temporary directory and run the checker on its `package/` directory. Add the following operations inside `pack`, using the existing `run`, `temporary` and `root` helpers:

```javascript
const archive = join(temporary, output[0].filename);
const extracted = mkdtempSync(join(temporary, 'quality-'));
run('tar', ['-xzf', archive, '-C', extracted], root);
run(process.execPath, [packageCheckBin, '--cwd', join(extracted, 'package')], root);
return archive;
```

- [x] Keep the existing required-file assertions. Read the extracted package.json and assert that `main` and `types` name real files in `output[0].files`, after removing a leading `./`. The checker verifies metadata presence; the archive assertions and existing consumer tests verify the referenced contents.
- [x] Add `@skypack/package-check` to the forbidden consumer dependency assertions for all six isolated consumer cases, including MongoDB. Keep the existing core/SQL/PostgreSQL/MCP restrictions.
- [x] Demonstrate failure on disposable extracted copies with missing exports and with missing/empty keywords. Demonstrate failure of the archive assertion when its declared type file is absent. These are packaging checks; no new database fixtures are needed.
- [x] Run `npm run lint`, `npm test`, `npm run test:packages` and `node scripts/release-packages.js check`. Expect all five archives to pass the checker and all existing isolated consumers to pass.
- [x] Document the gate in the contributor guide: package checks cover the five libraries, use packed artifacts and run before publication. State that a metadata score does not certify browser support or vulnerability absence. Build the documentation with `npm run docs:install` and `npm run docs:build`.
- [x] Commit the CI gate and its contributor documentation. Reuse the existing workflow callers; no second publication trigger is needed.

**Acceptance:** Removing required metadata or a declared artifact file fails existing PR/release validation. Installing a Simfinity runtime does not install the quality checker.

## Task 3: Triage dependency security independently

**Files:** Inspect root and package manifests/lockfile; modify dependency ranges only where evidence requires them. Record confirmed findings and dispositions in `docs/superpowers/reports/2026-09-21-package-security.md` when this task is executed.

A read-only `npm audit --omit=dev --json` of the current local workspace lockfile reported **six affected dependency entries: two high and four moderate**. Names: `fast-uri`, `ip-address`, `@hono/node-server`, `hono`, `mongoose`, `qs`. This is not six confirmed exploitable Simfinity defects and is not the Skypack Security result. It does not establish the dependency tree of a fresh published-package consumer.

- [x] Reproduce the audit against the latest development lockfile and clean consumer installations of the released MongoDB, PostgreSQL and MCP packages. For MCP, cover both SDK absent and explicitly installed. Keep these installations outside the repository and use `--ignore-scripts`.
- [x] Record package/version, advisory URL, dependency parent chain, vulnerable range, fixed version, and whether the dependency is installed and used in that configuration. Use `npm explain <package>` and the advisories from the audit output. Separate dev-only, optional and runtime exposure.
- [x] Choose fixes from confirmed patched versions within supported majors. If Mongoose needs a higher minimum, update matching peer/optional declarations and development fixtures consistently within Mongoose 8. Do not run `npm audit fix --force` or introduce Mongoose 9 as part of metadata cleanup.
- [x] Distinguish a stale repository lockfile from a vulnerable permitted minimum. Updating the root lock alone does not constrain dependencies installed by library consumers.
- [x] Re-run the affected packed-consumer checks and database regressions if runtime dependency versions change; use disposable databases following `.cursor/rules/simfinity-testing.mdc`. Re-audit and document remaining findings and their scope.
- [x] Keep remediation in a separate commit or PR from metadata changes so the compatibility impact can be reviewed independently.

**Acceptance:** Each reported finding has a reproducible scope and disposition. The quality score is never used as evidence that security findings were resolved.

## Task 4: Publish the verified correction and recheck the external listing

Execute this phase when the implementation and publication are part of the agreed task. No release is performed merely for writing this plan.

**Files:** Version metadata managed by `scripts/release-packages.js`; release notes and existing publication workflows. No new trigger or local login is required.

- [ ] Complete the reviewed PR with passing checks. For a compatible packaging fix, use the next unpublished patch version; **3.4.2 is the candidate after the currently observed 3.4.1**, subject to checking registry and GitHub state at execution time.
- [ ] Align root, all five libraries and exact internal dependencies with the release helper; run its validation. After merging, create the annotated `vX.Y.Z` tag on the validated `master` commit and ensure the matching GitHub release is published.
- [ ] Wait for **Release Simfinity**. Verify npm and GitHub Packages for all five packages, archive integrity, distribution tags, release assets and the applicable documentation deployment, following the repository's publication contract.
- [ ] Download the exact newly published npm archives and run the pinned checker against them. Confirm **100/100 per library** and re-run consumer checks against those releases, rather than relying only on workspace results.
- [ ] Revisit the Skypack listing and record its reported update/version and check states. If it still reflects 2021, investigate the service's supported refresh/support path. Treat stale indexing as an external follow-up; do not keep bumping Simfinity versions or promise the listing will refresh on a deadline.
- [ ] Report the released version, tag/release/workflow links, five artifact-check results and the observed Skypack state separately.

**Acceptance:** Correct metadata is verifiably published and protected by CI. Any stale external listing is clearly identified. Simfinity remains a Node.js server framework; these changes do not claim that a MongoDB/PostgreSQL backend can run in a browser through a CDN.

## Recommended order

Implement Tasks 1–2 as one scoped metadata/packaging PR. Triage Task 3 separately and include confirmed compatible dependency fixes in the release only after their own validation. Finish Task 4 through the existing release process when publication is agreed.

## Sources and verification

- [Skypack package listing](https://www.skypack.dev/view/@simtlix/simfinity-js): observed stale date and check states.
- [Skypack package-quality criteria](https://docs.skypack.dev/package-authors/package-checks): meaning of the checks.
- [Official checker](https://github.com/skypackjs/package-check): CLI used for the baseline and temporary metadata experiment, pinned to npm version 0.2.2.
- [Node.js package entry points](https://nodejs.org/api/packages.html#package-entry-points): export-map compatibility requirements.
- npm registry metadata and extracted 3.4.1 tarballs for all five `@simtlix/simfinity-*` packages: observed package contents and metadata.

Plan self-review: all visible check categories have a disposition; proposed imports and CLI invocation were checked against repository/tool source; metadata-only success is distinguished from compatibility, security and external indexing. Tasks 1–3 have been implemented and verified on 2026-09-24; publication completion is tracked by the release workflow and final delivery report.
