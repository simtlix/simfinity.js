---
title: Contributing
description: Work on Simfinity.js, improve the documentation, and run the project's validation commands.
---

# Contributing

Simfinity.js is maintained by Simtlix and released under the Apache 2.0 License. Contributions to the library, examples, and documentation are welcome.

## Work on the library

Clone the repository and install the locked dependencies:

```sh
git clone https://github.com/simtlix/simfinity.js.git
cd simfinity.js
npm ci
```

Read `AGENTS.md` and the relevant files in `.cursor/rules/` before changing behavior. The project uses ES modules, a shared runtime with MongoDB/PostgreSQL adapters, GraphQL 16, and Vitest.

All publishable code and TypeScript declarations live in `packages/core`, `packages/sql`, `packages/mongodb`, `packages/postgres`, and `packages/mcp`. The root `package.json` is private and coordinates development, shared tests, and releases. MongoDB still publishes as `@simtlix/simfinity-js`; the directory move does not change consumer imports. Run `npm pack --workspace @simtlix/simfinity-js` to inspect its archive, or use the release helper for the full package set.

Use Node.js 24 for the development commands below, matching the **Library CI** workflow. CI runs the existing lint and test commands on pull requests and pushes to `master`; it can also be started manually from Actions. This tooling version does not change the library's supported runtime range.

```sh
npm run lint
npm test
```

Add focused coverage for critical behavior and regressions. Keep the public documentation synchronized with API changes. A useful pull request explains the affected behavior, the change, and how it was validated.

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

Develop scoped changes on a branch, update the relevant documentation and tests, and merge through a reviewed pull request with passing checks. If the agreed task includes publishing a library change, the contributor or agent owns the complete release process below. Publication already requested in that task does not need a second request or confirmation of the same scope.

A publication task is complete only when all of these conditions hold:

1. The intended version is aligned across the private root and all five libraries, including exact internal dependencies, and the intended source has passed its checks and been merged into `master`.
2. Its `vX.Y.Z` tag points to that exact validated commit on GitHub, and the matching GitHub release is published. A tag push may let the workflow create the release automatically; the contributor or agent must still wait for and verify both results.
3. **Release Simfinity** has succeeded, all five versions are available in npm and GitHub Packages, npm `latest` or `next` points to the intended version, and npm archive integrity matches the release manifest.
4. The GitHub release contains the five package archives, manifest and npm verification report. For stable releases, the matching documentation is deployed successfully; prereleases do not replace the stable site.
5. The completion report identifies the version and includes the GitHub release/tag, workflow links and verification results. A failure is resolved and retried, or reported explicitly with its external blocker and remaining steps.

A version bump, merged pull request, draft release, or started workflow alone does not satisfy this contract. Choose the release version once and reuse a correctly prepared unpublished version. Never move a release tag, overwrite an existing published version, or bypass the workflow with a local npm publication to conceal a failed release.

This rule applies when publication is requested or explicitly included in the work. An ordinary change does not automatically authorize a release. Documentation, CI, repository rules and private example changes do not require an npm version merely to be merged; use the separate documentation deployment flow when website publication is requested.

## Release a new version

**Release Simfinity** (`.github/workflows/release.yml`) publishes only when a `vX.Y.Z` tag is pushed or a GitHub release is published. Changing versions, merging into `master`, and saving a draft release do not publish packages. Prepare the version in a reviewed pull request first:

```sh
node scripts/release-packages.js version 3.4.1
node scripts/release-packages.js check
```

Choose the next patch, minor or major version according to the changes. Commit the private root manifest, workspace lockfile and all five package manifests together. The helper keeps exact internal dependencies aligned. Merge the reviewed changes into `master`, then choose one of these release actions:

- Push the corresponding tag, for example `git tag -a v3.4.1 <merged-commit> -m v3.4.1` followed by `git push origin v3.4.1`. The workflow publishes the packages and creates the GitHub release with generated notes.
- Open **Releases → Draft a new release**, choose or create the matching tag on the intended `master` commit, and click **Publish release**. The workflow publishes the packages and adds verified archives to that release, preserving your title and notes.

Tags must match the package versions exactly and point to source already merged into `master`. Both annotated and lightweight tags are supported; annotated tags are recommended. A tag is never created from a version change or moved by the workflow. If both events arrive, runs are serialized and already published archives are skipped only after their integrity matches.

After either release action, the workflow automatically:

1. Selects the tagged commit and validates its clean source, aligned version and inclusion in `master`.
2. Runs lint, tests, all isolated package/TypeScript consumers, and the MongoDB/PostgreSQL database matrix.
3. Rechecks that the existing `vX.Y.Z` tag still points to that exact commit after the tests.
4. Publishes the same verified archives in dependency order: core, SQL, MCP, PostgreSQL, MongoDB. npm publication and verification finish before GitHub Packages starts, so partial failures cannot leave that registry ahead of npm.
5. Waits for all npm versions and their distribution tags to become visible, and compares registry SHA-512 integrity against the archive manifest.
6. Creates the GitHub release if necessary and attaches the five archives, manifest and npm verification evidence.
7. Publishes the stable release documentation to GitHub Pages.

Stable versions use npm `latest`; prereleases use `next`, are marked as GitHub prereleases, and do not replace the stable website. Runs queue instead of canceling pending versions. Freshness checks compare actually published npm versions across all five packages; a newer tag waiting in the queue does not block an earlier release. Pages deployments share one queue across branches and tags. A tag is never moved, an existing registry version is skipped only when its archive integrity matches, and superseded runs cannot move distribution tags, the latest release or Pages backward.

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

Use the **calling** workflow filename `release.yml`, even though its reusable `publish.yml` contains the publishing job. New npm trust entries default to staged publishing; direct publication must be enabled for this automatic flow. The GitHub `npm-release` environment allows only tags matching `v*`; the workflow additionally verifies that their source is merged into `master`. The `github-pages` environment allows `v*` tags for release deployments and `master` for documentation-only deployments. The publish job runs on GitHub-hosted runners with `id-token: write` and npm 11. These settings must be established once by a package maintainer; npm may require their passkey to save the trust relationship.

The workflows call each other explicitly. A release created by this workflow uses `GITHUB_TOKEN` and does not recursively trigger publication. If another automation creates the initial tag or release, its `GITHUB_TOKEN` event will not start this workflow; use a suitably scoped GitHub App or maintainer credential for that initiating action. Keep publication permissions restricted to the owning jobs and preserve the `npm-release` environment restriction.

## Preview and recover a release

Open **Actions → Release Simfinity → Run workflow** to preview the selected branch's current committed code and version. Manual dispatch always runs packaging and the real database matrix without tags, releases, registry writes or deployments. A preview uses the candidate checkout even when its version already has an older release tag.

For a failed release, inspect the failed job and correct its cause, then use **Re-run failed jobs** or **Re-run all jobs**. Matching archives are skipped safely, artifact names support reruns, and the tag remains immutable. Rerun the original tag/release event to retry publication; manual dispatch is only a preview and cannot authorize publication. Superseded historical runs fail closed instead of replacing a newer release or website; recover any historical archive separately without moving current distribution tags.

To publish documentation-only changes, the separate **Documentation** workflow still accepts **deploy** on `master`. It verifies that all packages for the documented version exist on npm first. A release automatically calls the same workflow after publication succeeds.

For a local archive proof without publication, use a fresh destination outside the repository:

```sh
node scripts/release-packages.js check
node scripts/release-packages.js pack /absolute/new/path/simfinity-release
node scripts/release-packages.js verify /absolute/new/path/simfinity-release/manifest.json
node scripts/publish-packages.js /absolute/new/path/simfinity-release/manifest.json --registry npm --dry-run
```

The manifest records the source commit, package order, filenames, SHA512 integrity, and SHA256 hashes. Final artifacts must come from clean committed source. Do not reuse a dirty preview as a release archive.

## Report a problem

Open an [issue on GitHub](https://github.com/simtlix/simfinity.js/issues) with your package version, Node version, the relevant type definitions, the GraphQL operation, and the observed result. Include a minimal reproduction when possible. Remove credentials and private data from examples.

## Resources

- [Barber example app](/resources/barber)
- [Source repository](https://github.com/simtlix/simfinity.js)
- [Series Sample Project](https://github.com/simtlix/series-sample)
- [Package on npm](https://www.npmjs.com/package/@simtlix/simfinity-js)
- [Release history](https://github.com/simtlix/simfinity.js/releases)
- [Apache 2.0 License](https://github.com/simtlix/simfinity.js/blob/master/LICENSE)
