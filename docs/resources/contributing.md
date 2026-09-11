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

Read `AGENTS.md` and the relevant files in `.cursor/rules/` before changing behavior. The project uses ES modules, Mongoose 8, GraphQL 16, and Vitest.

Use Node.js 24 for the development commands below, matching the **Library CI** workflow. CI runs the existing lint and test commands on pull requests and pushes to `master`; it can also be started manually from Actions. This tooling version does not change the library's supported runtime range.

```sh
npm run lint
npm test
```

Add focused coverage for critical behavior and regressions. Keep the public documentation synchronized with API changes. A useful pull request explains the affected behavior, the change, and how it was validated.

## Improve the documentation

Use Node.js 22 or newer for the website tooling:

```sh
npm run docs:install
npm run docs:dev
```

Edit Markdown pages in `docs/guide`, `docs/reference`, or `docs/resources`. Add new pages to the sidebar in `docs/.vitepress/config.mts`. The site's dependencies are separate from the library's dependencies.

Before submitting:

```sh
npm run docs:build
npm run docs:preview
```

Check links, search, mobile navigation, code examples, and both color themes. The [website maintainer guide](https://github.com/simtlix/simfinity.js/blob/master/docs/.vitepress/README.md) covers the layout, assets, build configuration, and publication workflow.

## Create a GitHub release

After merging the intended changes, open **Actions → Create GitHub release → Run workflow** and select `master`.

- Choose `patch`, `minor`, or `major` according to the compatibility impact. The workflow increments the version in `package.json` and the lockfile.
- Enable **draft** to review the generated release notes before making the release public.
- Enable **dry_run** to validate and preview the next version without changing the repository or creating a release.

The workflow installs locked dependencies, runs lint and the existing tests, and checks the package contents. A normal run then pushes the version commit and matching `v` tag together and creates the GitHub release with generated notes. It does not publish packages. Real releases run only from `master`; other branches support dry runs.

The push fails if `master` changed during validation, and existing tags are never overwritten. If the tag was pushed but GitHub release creation failed, create the release from that existing tag in GitHub's Releases page instead of incrementing the version again.

## Publish packages separately

Open **Actions → Publish packages → Run workflow**, select the workflow on `master`, and enter the existing release tag, such as `v3.0.2`. Select `npm`, `github`, or `both`; npm is the default. **dry_run** validates without publishing.

The tag must match the package version. Validation runs against that tag, and publication uses the exact validated commit. Stable versions use the `latest` distribution tag; prereleases use `next`. npm publication uses the repository's `NPMJS_TOKEN` secret; GitHub Packages uses the workflow token. Creating a GitHub release does not start package publication automatically.

## Report a problem

Open an [issue on GitHub](https://github.com/simtlix/simfinity.js/issues) with your package version, Node version, the relevant type definitions, the GraphQL operation, and the observed result. Include a minimal reproduction when possible. Remove credentials and private data from examples.

## Resources

- [Source repository](https://github.com/simtlix/simfinity.js)
- [Series Sample Project](https://github.com/simtlix/series-sample)
- [Package on npm](https://www.npmjs.com/package/@simtlix/simfinity-js)
- [Release history](https://github.com/simtlix/simfinity.js/releases)
- [Apache 2.0 License](https://github.com/simtlix/simfinity.js/blob/master/LICENSE)
