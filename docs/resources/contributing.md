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

All publishable code and TypeScript declarations live in `packages/core`, `packages/mongodb`, `packages/postgres`, and `packages/mcp`. The root `package.json` is private and coordinates development, shared tests, and releases. MongoDB still publishes as `@simtlix/simfinity-js`; the directory move does not change consumer imports. Run `npm pack --workspace @simtlix/simfinity-js` to inspect its archive, or use the release helper for the full package set.

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

## Create a GitHub release

After merging the intended changes, open **Actions → Create GitHub release → Run workflow** and select `master`.

- Choose `current` to tag an already prepared lockstep version, when all package manifests already contain the intended release version. Choose `patch`, `minor`, or `major` for a future bump. The workflow updates the private root version, all four package manifests, exact internal dependency versions, and workspace lock metadata together.
- Enable **draft** to review the generated release notes before making the release public.
- Enable **dry_run** to validate and preview the next version without changing the repository or creating a release.

The workflow installs locked dependencies, runs lint and the existing tests, packs/validates all four packages in dependency order, and performs a local publication dry run. A normal run then pushes the version commit and matching `v` tag together and creates the GitHub release with generated notes. It does not publish packages. Real releases run only from `master`; other branches support dry runs and make no remote writes.

The push fails if `master` changed during validation, and existing tags are never overwritten. If the tag was pushed but GitHub release creation failed, create the release from that existing tag in GitHub's Releases page instead of incrementing the version again.

## Publish packages separately

After the intended commit is on `master`, create the GitHub release first. For an already prepared version select **current**; otherwise select the appropriate bump. Existing release tags are never overwritten. Then open **Actions → Publish packages → Run workflow** on `master` and enter the existing tag, such as `v3.2.0`. Select `npm`, `github`, or `both`; npm is the default. Start with **dry_run** to validate without registry reads or publication.

The tag must match every package version. The workflow builds one verified archive set from that exact committed tag and publishes core, MCP, PostgreSQL, then the MongoDB facade. Before writing any package, it checks all existing registry versions: a matching SHA512 is skipped safely, while missing/malformed/conflicting integrity aborts. Stable versions use the `latest` distribution tag; prereleases use `next`. npm publication uses the repository's `NPMJS_TOKEN` secret; GitHub Packages uses the workflow token. Creating a GitHub release does not start package publication automatically.

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
