---
title: Contributing
description: Work on Simfinity.js, improve the documentation, and run the project's validation commands.
---

# Contributing

Simfinity.js is maintained by Simtlix and released under the Apache 2.0 License. Contributions to the library, examples, and documentation are welcome.

## Explain the change in an issue

Every pull request must link an issue in this repository explaining **why the change is needed**. Create or reuse the relevant issue before opening the PR; existing PRs must add it before approval or merge. This applies to features, bug fixes, documentation, examples, dependencies and maintenance, including automated PRs. Keep the explanation proportional to the change: a typo fix needs a short explanation, not a feature proposal. A maintainer can supply the issue for a bot-generated PR.

For a feature or public behavior change, the issue must describe:

1. The concrete use case, actor and desired outcome, with a minimal example and the affected package/version and database engine when relevant.
2. The current behavior and what was tried with existing Simfinity capabilities. Consider relationships, generated operations, query scopes, aggregates, controllers and registered operations where relevant; explain why they do not solve the problem. Distinguish an experiment from an untested assumption.
3. Why the missing capability belongs in the library rather than application business logic or infrastructure. Consider authorization, hooks, transaction ownership and MongoDB/PostgreSQL compatibility; identify engine-specific scope explicitly.
4. Observable acceptance criteria and the proposed scope. Record uncertainties rather than inventing evidence or prescribing an implementation before understanding the need.

Bug issues need expected/actual behavior and reproduction evidence. Documentation or maintenance issues need the current gap, its impact and the desired result. Remove credentials and private application data from all examples.

The PR must link the issue, summarize the motivation, explain how the implementation addresses it, and report validation and relevant compatibility effects. Use `Closes #<issue-number>` only when the PR completes the issue; use `Refs #<issue-number>` for partial work. Update the issue when the scope changes; an unrelated issue or a bare feature name is insufficient.

Reviewers read the issue and verify the claimed gap against the current library before recommending a new API. If the issue or rationale is missing, continue the technical review but withhold approval and merge until it is supplied. An existing capability may call for usage guidance, an application change or better documentation; a demonstrated gap may justify a library feature. A linked issue records the problem, not automatic design approval.

## Work on the library

Clone the repository and install the locked dependencies:

```sh
git clone https://github.com/simtlix/simfinity.js.git
cd simfinity.js
npm ci
```

Read `AGENTS.md` and the relevant files in `.cursor/rules/` before changing behavior. The project uses ES modules, a shared runtime with MongoDB/PostgreSQL adapters, GraphQL 16, and Vitest.

All publishable code and TypeScript declarations live in `packages/core`, `packages/sql`, `packages/mongodb`, `packages/postgres`, and `packages/mcp`. The root `package.json` is private and coordinates development, shared tests, and releases. MongoDB still publishes as `@simtlix/simfinity-js`; the directory move does not change consumer imports. Run `npm pack --workspace @simtlix/simfinity-js` to inspect its archive, or use the release helper for the full package set.

Use Node.js 24 for the development commands below, matching the **Library CI** workflow. CI runs the existing lint and test commands on pull requests and pushes to `master`; it can also be started manually from Actions. This tooling version does not change the library's supported runtime range. A newer push to a pull request cancels that pull request's older **Library CI** and **Database integration** runs; pushes to `master`, manual runs and runs called by a release always complete. Re-running an older run of a pull request therefore cancels its newer run in progress.

```sh
npm run lint
npm test
```

Add focused coverage for critical behavior and regressions. Keep the public documentation synchronized with API changes. Follow the [issue and PR requirements](#explain-the-change-in-an-issue) when submitting the change.

### Package quality and dependency security

```sh
npm run test:packages
npm run test:security
```

The package check extracts each of the five npm archives and runs the pinned Skypack checker. It also verifies that entry points, declarations, README and license files actually exist, including every `types` target in `exports`, installs isolated JavaScript/TypeScript consumers, and checks dependency boundaries. The core consumer compiles every public core subpath under NodeNext, Node16, Bundler and Node10, with an exact type-equality check of each subpath member and re-exported type against the root and a two-way check of export names. It also checks the root's runtime value exports both ways against `coreRootValues`, and that the root error classes are the `auth` classes. A MongoDB compatibility fixture protects its published file paths and recorded resolution aliases, and the MongoDB consumer compiles the declarations of the legacy `src/` deep imports with exact type equality under NodeNext, Node16, Bundler and Node10. Directory specifiers ending in `/` are excluded: they were not valid ESM imports, and tools should resolve the package root or `package.json` instead. The checker is a development dependency of the private workspace and is never installed with a runtime package.

Without an argument, the package check packs the working tree with the release packer, so it needs aligned versions and a Git checkout. `npm run test:packages -- <manifest.json>` tests exactly the archives of a release manifest instead, as the release build does; see [Preview and recover a release](#preview-and-recover-a-release).

The security command runs `npm audit` against the root lockfile, including development tools. Both Library CI and release validation require it to pass. The documentation application and Barber examples have independent lockfiles; audit them in their own directories when working on those applications.

For a dependency advisory, identify the affected installed version and its parent chain with `npm explain`, update compatible versions, and re-run the affected consumer and database tests. A lockfile correction protects that checkout; an affected public dependency range must also exclude known vulnerable direct versions. Existing applications must update their own lockfiles. Do not use `npm audit fix --force` to introduce unreviewed major upgrades.

A 100/100 metadata score verifies package configuration, not browser support or freedom from security defects. See the [September 2026 library dependency review](https://github.com/simtlix/simfinity.js/blob/master/docs/superpowers/reports/2026-09-24-package-security.md) and the [Barber follow-up](https://github.com/simtlix/simfinity.js/blob/master/docs/superpowers/reports/2026-09-24-barber-security.md) for the reviewed dependency paths and fixes.

## Work on the Barber examples

The [Barber app](/resources/barber) lives in `examples/barber/`: separate MongoDB and PostgreSQL backends plus one shared frontend. These private apps have their own manifests and lockfiles and consume released packages from npm. They are outside the library workspaces and release process.

Use Node.js 24 and run `npm ci` inside each affected app. Follow the [example runbook](https://github.com/simtlix/simfinity.js/blob/master/examples/barber/README.md) and the dedicated [Barber workflow](https://github.com/simtlix/simfinity.js/blob/master/.github/workflows/barber.yml) for unit, frontend, real-database, HTTP/MCP, and browser checks. Root library lint and Vitest exclude examples. Shared app behavior should be checked against both backends; native PostgreSQL changes also need the relevant FK and transaction regressions.

Use disposable databases for seeds, datasets, and integration tests. Keep app secrets, real uploads, generated schema exports, and build output out of Git. Example-only changes do not require publishing a library version.

## Improve the documentation

Use Node.js 22 or newer for the website tooling:

```sh
npm run docs:install
npm run docs:dev
```

Edit Markdown pages in `docs/guide`, `docs/reference`, or `docs/resources`. Add new pages to the sidebar in `docs/.vitepress/config.mts`. The site's dependencies are separate from the library's dependencies; the build reads the private root version and does not install a database adapter.

Before submitting:

```sh
npm run docs:build
npm run docs:preview
```

Check links, search, mobile navigation, code examples, and both color themes. The [website maintainer guide](https://github.com/simtlix/simfinity.js/blob/master/docs/.vitepress/README.md) covers the layout, assets, build configuration, and publication workflow.

## Development and publication contract

This workflow is a shared repository rule for human contributors and coding agents. It is also required by [AGENTS.md](https://github.com/simtlix/simfinity.js/blob/master/AGENTS.md#shared-development-and-publication-rule) and the always-applied [Cursor rule](https://github.com/simtlix/simfinity.js/blob/master/.cursor/rules/simfinity-development-workflow.mdc), so it travels with every clone of the repository.

Explain the need in a [linked issue](#explain-the-change-in-an-issue), develop scoped changes on a branch, update the relevant documentation and tests, and merge through a reviewed pull request with passing checks. If the agreed task includes publishing a library change, the contributor or agent owns the complete release process below. Publication already requested in that task does not need a second request or confirmation of the same scope.

A publication task is complete only when all of these conditions hold:

1. The intended version is aligned across the private root and all five libraries, including exact internal dependencies, and the intended source has passed its checks and been merged into `master`.
2. Its `vX.Y.Z` tag points to that exact validated commit on GitHub, and the matching GitHub release is published. A tag push may let the workflow create the release automatically; the contributor or agent must still wait for and verify both results.
3. **Release Simfinity** has succeeded, all five versions are available in npm and GitHub Packages, npm `latest` or `next` points to the intended version, and npm archive integrity matches the release manifest.
4. The GitHub release contains the five package archives, manifest and npm verification report. For stable releases, the matching documentation is deployed successfully, or the documentation gate reports that the live site already contains it (for example after a newer documentation-only deployment) and the report links that live deployment. Prereleases do not replace the stable site.
5. The completion report identifies the version and includes the GitHub release/tag, workflow links and verification results. A failure is resolved and retried, or reported explicitly with its external blocker and remaining steps.

A version bump, merged pull request, draft release, or started workflow alone does not satisfy this contract. Choose the release version once and reuse a correctly prepared unpublished version. Never move a release tag, overwrite an existing published version, or bypass the workflow with a local npm publication to conceal a failed release.

This rule applies when publication is requested or explicitly included in the work. An ordinary change does not automatically authorize a release. Documentation, CI, repository rules and private example changes do not require an npm version merely to be merged; use the separate documentation deployment flow when website publication is requested.

## Release a new version

**Release Simfinity** (`.github/workflows/release.yml`) publishes only when a `vX.Y.Z` tag is pushed or its GitHub release is published. Releases with other tag prefixes, including the independent ESLint plugin, are skipped. Changing versions, merging into `master`, and saving a draft release do not publish packages. Prepare the version in a reviewed pull request first:

```sh
node scripts/release-packages.js version 3.4.1
node scripts/release-packages.js check
```

Choose the next patch, minor or major version according to the changes. Commit the private root manifest, workspace lockfile and all five package manifests together. The helper keeps exact internal dependencies aligned. Merge the reviewed changes into `master`, then choose one of these release actions:

- Push the corresponding tag on the pull request's merge commit, for example `git tag -a v3.4.1 <merge-commit> -m v3.4.1` followed by `git push origin v3.4.1`. The workflow publishes the packages and creates the GitHub release with generated notes.
- Open **Releases → Draft a new release**, choose or create the matching tag on that `master` merge commit, and click **Publish release**. The workflow publishes the packages and adds verified archives to that release, preserving your title and notes.

Tags must match the package versions exactly and point to source already merged into `master`. Tag the merge commit on `master`'s first-parent history, not a pull request's head commit: the documentation gate refuses a source that neither contains nor is contained in the live site, such as a head commit that lacks a later documentation-only deployment. Both annotated and lightweight tags are supported; annotated tags are recommended. A tag is never created from a version change or moved by the workflow. If both events arrive, runs are serialized and already published archives are skipped only after their integrity matches.

After either release action, the workflow automatically:

1. Selects the tagged commit and validates its clean source, aligned version, tag and inclusion in `master`.
2. Packs the five archives in a fresh checkout of that commit, with Node.js 24.21.0 and its bundled npm, before any dependency is installed or any test runs. This packing job validates the source again (`release-state.js verify-source`), refuses archives that would include untracked or Git-ignored files, and records the SHA-256 of the archive manifest, which lists every archive hash.
3. Runs lint, tests, the isolated package/TypeScript consumers on exactly those archives, and the MongoDB/PostgreSQL database matrix. The test job checks the recorded digest for consistency only, since code installed for the tests could change that check.
4. Rechecks that the existing `vX.Y.Z` tag still points to that exact commit after the tests.
5. Publishes the same archives in dependency order: core, SQL, MCP, PostgreSQL, MongoDB. Each publishing job refuses to start unless the downloaded manifest matches the recorded digest and the validated commit. npm publication and verification finish before GitHub Packages starts, so partial failures cannot leave that registry ahead of npm.
6. Waits for all npm versions and their distribution tags to become visible, and compares registry SHA-512 integrity against the archive manifest. It reads npm's uncached package document, because the plain one can be up to five minutes old. A 404 or a missing version or distribution tag counts as not yet visible and is waited on, as are network failures, timeouts, cut-off or unreadable answers, 429 and 5xx: 20 attempts 15 seconds apart, each request cut at 15 seconds and the whole check at 10 minutes. Integrity conflicts and other 4xx answers (401, 403, ...) fail at once; the final error names the last attempt's registry error.
7. Checks the archives against the recorded digest again and reads the complete GitHub release list to find the release for the tag (`scripts/github-release.js`, which retries transient API failures). It creates a draft only when no release, draft or published, uses the tag, then attaches only the digest-verified manifest, the five archives it lists and the npm verification evidence, never other files of the artifact, and publishes the release. A failed lookup, or several releases for one tag, stops the job instead of adding another release.
8. Deploys the stable release documentation to GitHub Pages through the documentation gate below.

Stable versions use npm `latest` and become the latest GitHub release, never a pre-release, even when the release form marked them as one: the workflow clears the pre-release flag before marking the release latest. Prereleases use `next`, are marked as GitHub pre-releases, never become latest, and do not replace the stable website. Runs queue instead of canceling pending versions. Freshness checks read npm uncached and compare actually published npm versions across all five packages; a newer tag waiting in the queue does not block an earlier release. A release package missing from npm fails that check before anything is built or published; see [Authentication and one-time setup](#authentication-and-one-time-setup). A tag is never moved, an existing registry version is skipped only when its archive integrity matches, and superseded runs cannot move distribution tags or the latest release backward.

Documentation deployments share one queue across branches and tags and only move GitHub Pages forward. A separate gate job, without the `github-pages` environment or write permissions, runs `release-state.js verify-docs` first. It accepts only a stable version that is not superseded on npm, built from the run's own commit, and compares that commit with the one currently live on Pages:

- The live commit itself or a descendant deploys, as does any commit when nothing has been deployed yet.
- An ancestor, for example a release tag after a newer documentation-only deployment, is not deployed again. The job stays green, and its notice and step summary name the live deployment.
- Anything else fails, including a source that diverged from the live commit and a live commit missing from the repository history.

The deployment job repeats the check just before deploying, because **Re-run failed jobs** reuses the gate's earlier answer; there it fails instead of skipping.

## Authentication and one-time setup

npm publication uses [Trusted Publishing with OIDC](https://docs.npmjs.com/trusted-publishers/), with short-lived credentials issued to GitHub Actions. It does not use `NPMJS_TOKEN`, a local npm login, or a maintainer's passkey during releases. GitHub Packages uses the workflow's `GITHUB_TOKEN` with `packages: write`.

The repository configuration expects these settings on **each** of `@simtlix/simfinity-core`, `@simtlix/simfinity-sql`, `@simtlix/simfinity-mcp`, `@simtlix/simfinity-postgres` and `@simtlix/simfinity-js`:

| npm Trusted Publisher field | Value |
| --- | --- |
| Provider | GitHub Actions |
| Organization | `simtlix` |
| Repository | `simfinity.js` |
| Workflow filename | `release.yml` |
| Environment | `npm-release` |
| Allowed action | Enable **Allow npm publish** |

Use the **calling** workflow filename `release.yml`, even though its reusable `publish.yml` contains the publishing job. New npm trust entries default to staged publishing; direct publication must be enabled for this automatic flow. The GitHub `npm-release` environment allows only tags matching `v*`; the workflow additionally verifies that their source is merged into `master`. The `github-pages` environment allows `v*` tags for release deployments and `master` for documentation-only deployments. The publish job runs on GitHub-hosted runners with `id-token: write`, Node.js 24.21.0 and npm 11.21.0; Trusted Publishing needs npm 11.5.1 or later. These settings must be established once by a package maintainer; npm may require their passkey to save the trust relationship.

A Trusted Publisher is configured from the package's own npm settings, so a new package must exist on npm before it joins the release set. A maintainer publishes it once, outside the workflow, and configures its Trusted Publisher; this one-time bootstrap is the only publication from a local login. Until then the freshness check refuses every release with `<name> is not on the registry; publish it once and configure its Trusted Publisher before releasing`.

The independent `@simtlix/eslint-plugin-simfinity@0.1.0` uses that same first-publication
exception without joining the five runtime packages. Pack committed, reviewed
source from `master` with scripts disabled; validate the archive contents, plugin
tests, isolated JS/TS consumer and both Barber trials before publishing it with
public access. Verify npm's version, `latest` tag and archive integrity, then
attach the archive and its checksum to an `eslint-plugin-v0.1.0` GitHub release
on the same merge commit. Keep this tool release from becoming the repository's
latest runtime release. Deploy the installation guide through the documentation-only
flow after npm availability is verified. The plugin's existing workflow only
tests it; subsequent versions require a separate OIDC publication workflow and
Trusted Publisher before release, rather than repeating the local-login exception.

The workflows call each other explicitly. A release created by this workflow uses `GITHUB_TOKEN` and does not recursively trigger publication. If another automation creates the initial tag or release, its `GITHUB_TOKEN` event will not start this workflow; use a suitably scoped GitHub App or maintainer credential for that initiating action. Keep publication permissions restricted to the owning jobs and preserve the `npm-release` environment restriction. The documentation gate and deployment jobs read deployments, so the release's documentation job grants `contents: read`, `pages: write`, `id-token: write` and `deployments: read`: a called workflow never gets a scope its caller lacks, and `tests/release-workflows.test.js` checks every call.

## Pinned actions, Node and npm

Every workflow action is pinned to a full commit SHA with a `# vX.Y.Z` comment, and the packing and publishing jobs use exact Node.js and npm versions. `tests/release-workflows.test.js` enforces both.

- Dependabot (`.github/dependabot.yml`) opens one grouped pull request a week with new action SHAs and comments. After merging one, run a release preview, plus a documentation-only deployment check when it changes `docs.yml`.
- To bump an action by hand, resolve its release with `gh api repos/actions/<repo>/git/ref/tags/<tag> --jq '.object.type + " " + .object.sha'`; the type must be `commit`. Update every occurrence and its comment, then run the tests and a preview.
- Dependabot does not bump `node-version` or the npm install. Change the three `node-version` lines (pack, publish-npm and publish-gpr) and the `npm install --global npm@…` line in `publish.yml` together, then run a preview. A new npm under Trusted Publishing is only exercised by a real release.

The pins have limits. An action called inside a composite action keeps its own reference: `actions/upload-pages-artifact` calls `actions/upload-artifact@v4`. Docker images, such as the database services and actionlint, use tags. Enable the repository policy that requires actions pinned to a full-length commit SHA only while every workflow is pinned, and follow it with a release preview and a documentation-only deployment check; only a run shows how it treats the nested reference.

## Preview and recover a release

Open **Actions → Release Simfinity → Run workflow** to preview the selected branch's current committed code and version. Manual dispatch always runs packaging and the real database matrix without tags, releases, registry writes or deployments. A preview uses the candidate checkout even when its version already has an older release tag. It skips the publishing jobs, the GitHub release job and the documentation deployment.

After merging changes to the release workflows or scripts, run a preview before the next release: it exercises the source selection, the packing job, the tests on its archives and the pinned actions these jobs use. The next real release is the first run of what a preview skips: the publishing jobs' digest and commit checks, their pinned Node.js and npm under Trusted Publishing, the GitHub release lookup and digest check, and the release's documentation gate.

For a failed release, inspect the failed job and correct its cause, then use **Re-run failed jobs** or **Re-run all jobs**. **Re-run failed jobs** reuses the packing job's archives and digest. **Re-run all jobs** packs again; after a partial npm publication it succeeds only when the new archives are byte-identical, which deterministic packing provides, and otherwise fails with `Registry integrity conflicts with the local archive`. Matching archives are skipped safely, artifact names support reruns, and the tag remains immutable. Rerun the original tag/release event to retry publication; manual dispatch is only a preview and cannot authorize publication. Superseded historical runs fail closed instead of replacing a newer release or website; recover any historical archive separately without moving current distribution tags.

Re-runs and release events for an existing tag run the workflows and scripts of that tag's commit, so a release tooling fix reaches only tags created after it. When a failure needs such a fix, release a new version instead of re-running the old tag. Other recoveries:

- Several GitHub releases for one tag, such as stray drafts: delete the extra ones, then re-run failed jobs.
- A GitHub release lookup that fails after its retries: npm and GitHub Packages are already published and the documentation was skipped; re-run failed jobs.
- A re-run of a failed documentation deployment fails when newer documentation went live in the meantime. That is expected: the failing step names the live commit and deployment, which the release report links.
- A documentation gate that refuses a release, for example a tag on a pull request's head commit that lacks a later documentation-only deployment: the packages are already published, so deploy the documentation from `master` with the documentation-only flow below.
- A live commit missing from the repository history, or a bad deployment that is live: mark that `github-pages` deployment inactive or delete it, so that the gate compares with the previous successful deployment. To roll back content, revert it on `master` and deploy again; the revert descends from the live commit.

To publish documentation-only changes, dispatch the separate **Documentation** workflow with **deploy** on `master`, never on a tag. It verifies that all packages for the documented version exist on npm, then applies the documentation gate: while `master` holds a prerelease version, deployments are refused until the stable release. Tags created before the gate, up to v3.6.0, carry an earlier `docs.yml` without it, so dispatching one of them can replace newer documentation until a newer version is on npm. A release automatically calls the same workflow after publication succeeds.

For a local archive proof without publication, use a fresh destination outside the repository:

```sh
node scripts/release-packages.js check
node scripts/release-packages.js pack /absolute/new/path/simfinity-release
node scripts/release-packages.js verify /absolute/new/path/simfinity-release/manifest.json
npm run test:packages -- /absolute/new/path/simfinity-release/manifest.json
node scripts/publish-packages.js /absolute/new/path/simfinity-release/manifest.json --registry npm --dry-run
```

The manifest records the source commit, package order, filenames, SHA512 integrity, and SHA256 hashes. Final artifacts must come from clean committed source; `pack` refuses archives that would include untracked or Git-ignored files. Do not reuse a dirty preview as a release archive. With a manifest, `test:packages` verifies the archive hashes, requires the manifest's commit to be the checked-out commit (or `SIMFINITY_RELEASE_COMMIT`) and tests exactly those archives. `verify`, `test:packages` and the dry run also check `SIMFINITY_RELEASE_MANIFEST_SHA256` when it is set. `assets`, which builds the GitHub release upload list, requires it, and publishing with `--execute` requires both variables; both belong to the workflow.

## Report a problem

Open an [issue on GitHub](https://github.com/simtlix/simfinity.js/issues) with your package version, Node version, the relevant type definitions, the GraphQL operation, and the observed result. Include a minimal reproduction when possible. Remove credentials and private data from examples.

## Resources

- [Barber example app](/resources/barber)
- [Source repository](https://github.com/simtlix/simfinity.js)
- [Series Sample Project](https://github.com/simtlix/series-sample)
- [Package on npm](https://www.npmjs.com/package/@simtlix/simfinity-js)
- [Release history](https://github.com/simtlix/simfinity.js/releases)
- [Apache 2.0 License](https://github.com/simtlix/simfinity.js/blob/master/LICENSE)

### Development dependency security overrides

The private workspace overrides `@graphql-tools/utils` under `graphql-middleware` to `^12.0.1` for [GHSA-7mx3-vvmw-hjmv](https://github.com/advisories/GHSA-7mx3-vvmw-hjmv). This affects the plain-GraphQL authorization compatibility tests only; it is not shipped as a library dependency. Keep the real middleware integration test in `tests/auth-policy-safety.test.js` when updating this override. The downloadable starters use the same patched utility range for Yoga. Remove these overrides only after the corresponding dependency trees require a patched version and the tests and audits pass.
