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

## Release a new version

Every new aligned version merged into `master` automatically runs **Release Simfinity** (`.github/workflows/release.yml`). Prepare the version in the same reviewed pull request as the intended release:

```sh
node scripts/release-packages.js version 3.4.1
node scripts/release-packages.js check
```

Choose the next patch, minor or major version according to the changes. Commit the private root manifest, workspace lockfile and all five package manifests together. The helper keeps exact internal dependencies aligned. Ordinary commits that keep an existing release version do not create another release, and example-only/documentation-only changes do not require a new package version.

After the merge, the workflow automatically:

1. Selects clean committed source and validates the aligned version.
2. Runs lint, tests, all isolated package/TypeScript consumers, and the MongoDB/PostgreSQL database matrix.
3. Creates the annotated `vX.Y.Z` tag, or verifies that an existing tag points to the exact same commit.
4. Publishes the same verified archives to npm and GitHub Packages in order: core, SQL, MCP, PostgreSQL, MongoDB.
5. Waits for all npm versions and their distribution tags to become visible, and compares registry SHA-512 integrity against the archive manifest.
6. Creates the GitHub release with generated notes, the five archives, manifest and npm verification evidence.
7. Publishes the stable release documentation to GitHub Pages.

Stable versions use npm `latest`; prereleases use `next`, are marked as GitHub prereleases, and do not replace the stable website. Runs queue instead of canceling pending versions. A tag is never moved, an existing registry version is skipped only when its archive integrity matches, and superseded runs cannot move distribution tags, the latest release or Pages backward.

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

Use the **calling** workflow filename `release.yml`, even though its reusable `publish.yml` contains the publishing job. New npm trust entries default to staged publishing; direct publication must be enabled for this automatic flow. The GitHub `npm-release` environment allows deployments from the `master` branch only. The publish job runs on GitHub-hosted runners with `id-token: write` and npm 11. These settings must be established once by a package maintainer; npm may require their passkey to save the trust relationship.

The workflows call each other explicitly. They do not rely on a tag pushed with `GITHUB_TOKEN` triggering another workflow, because GitHub suppresses those recursive events. Keep publication permissions restricted to the owning jobs and preserve the `npm-release` environment restriction.

## Preview and recover a release

Open **Actions → Release Simfinity → Run workflow** with **dry_run** enabled to validate the selected branch's current committed code and version. This runs packaging and the real database matrix without tags, releases, registry writes or deployments. A preview uses the candidate checkout even when its version already has an older release tag.

For a failed release, inspect the failed job and correct its cause, then use **Re-run failed jobs** or **Re-run all jobs**. Matching archives are skipped safely, artifact names support reruns, and the tag remains immutable. Manual dispatch without **dry_run**, on `master`, retries the current version using its tagged source when available. It does not invent a new version. Superseded historical runs fail closed instead of replacing a newer release or website; recover any historical archive separately without moving current distribution tags.

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
