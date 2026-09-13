# Working on the documentation

The website is a separate, private npm project in `docs/`. Its dependencies and build output are excluded from the published library. Use Node.js 22 or newer to work on the site; the library's runtime requirement remains unchanged.

From the repository root:

```sh
npm run docs:install
npm run docs:dev
```

Open the local URL printed by VitePress. To inspect the static production build:

```sh
npm run docs:build
npm run docs:preview
```

## Content and design

- `docs/guide/`: progressive, task-focused guides.
- `docs/reference/`: public signatures, options, and behavior.
- `docs/resources/`: troubleshooting and contribution guidance.
- `docs/.vitepress/config.mts`: navigation, search, metadata, and deployment base.
- `docs/.vitepress/theme/`: custom home page and shared design tokens.
- `docs/public/`: static assets. The original infinity mark combines amber and blue; it is a Simfinity identity inspired by the supplied corporate colors, not a reproduction of Simtlix's node logo.

The active concept is **a schema becoming a connected system**. An original amber/blue infinity mark, Space Grotesk typography, IBM Plex Mono code, and an interactive topology connect the brand to the library's behavior. Both fonts are hosted locally by the build. The palette has complete light and dark variants: warm mineral surfaces or graphite, amber accents, and blue for the MCP connection. The company logo supplied as a reference informed the colors only; it is not used as the library logo.

The homepage combines a continuous animated graph, pointer and keyboard node exploration, separators drawn on entry, interactive code examples, and an explorable MCP tool list. The capabilities section keeps its introduction and a fine-line animated infinity together in a sticky left column while the capability descriptions scroll on the right. The infinity draws once and occasionally carries a softly lit point; the navigation mark repeats that detail. `useHomeMotion.js` coordinates entry, bounded scroll offsets, and pointer light without changing native scrolling. On narrow screens the columns become a normal vertical flow and parallax is disabled. Animations are decorative explanations, not live runtime telemetry; `prefers-reduced-motion` removes motion. Selecting a graph node opens a hero focus view: the circuit retracts, a capability-specific SVG assembles, and masked headings, description, and code reveal in sequence. The desktop hero keeps one viewport-based height through overview, selection, and return, with content centered vertically and no bottom status strips. The capability navigation switches views directly; Back or Escape restores the original graph focus. On mobile, Back scrolls to the restored graph after its return animation. Graph nodes describe generated capabilities. The documentation uses the same type and color system with quieter reading surfaces, full-text local search, navigation, code copying, and persistent theme selection.

Review both themes whenever changing colors. Use dark amber for text on light surfaces and bright amber on graphite. Keep code examples legible in their intentionally dark homepage editor. The custom graph accepts `active`, `light`, `focused`, and `phase` props and emits `select` for node selection. Its responsive rules use the graph container's width so node labels fit even in narrow desktop columns.

Create a Markdown page with `title` and `description` frontmatter, a single H1, practical examples, and links to its prerequisites. Add it to `themeConfig.sidebar` in `config.mts`. Use `/guide/page` links in Markdown and `withBase('/guide/page.html')` in Vue components. Check examples against the current source. Keep JavaScript imports as ES modules; Simfinity's core uses namespace or named imports, not a default export.

The release label reads the root `package.json`. It identifies the documented library version. Deploy release documentation only after all matching npm packages are published and verified. Last-updated dates come from Git history after a page has been committed.

VitePress 1.6.4 is pinned to the stable release. Its Vite dependency is overridden to `^6.4.3` to use the patched development server instead of the vulnerable Vite 5 dependency. Keep the override until upgrading to a VitePress release that uses a patched version itself; validate development, production builds, and local search when updating it.

## Build and publication

The build fails on unresolved internal page links. Output is in `docs/.vitepress/dist/`. It contains static HTML and assets; no Node server or database is needed to host it. Keep `.html` routes enabled on the host. The root build works without environment variables.

For a domain subdirectory, set `DOCS_BASE_PATH` to that directory, including leading and trailing slashes. Set `DOCS_SITE_URL` to the public origin to enable canonical URLs and a sitemap. For the repository's GitHub Pages path:

```powershell
$env:DOCS_BASE_PATH = '/simfinity.js/'
$env:DOCS_SITE_URL = 'https://simtlix.github.io'
npm run docs:build
npm run docs:preview
```

Or in a POSIX shell:

```sh
DOCS_BASE_PATH=/simfinity.js/ DOCS_SITE_URL=https://simtlix.github.io npm run docs:build
DOCS_BASE_PATH=/simfinity.js/ npm run docs:preview
```

Use the same base path for preview as for the build. Open `/simfinity.js/` on the preview server. For a custom domain, use `/` as the base and the domain's origin as the site URL.

The `Documentation` GitHub Actions workflow builds on relevant pull requests and pushes to `master`, and uploads a Pages artifact. Publication is an explicit workflow dispatch with **deploy** selected, on `master`. To enable it, select **GitHub Actions** under repository Settings → Pages → Build and deployment. Set repository variables `DOCS_BASE_PATH` and `DOCS_SITE_URL` if the public location differs from the defaults above. This implementation does not enable Pages or publish anything by itself.

The public site is [simtlix.github.io/simfinity.js](https://simtlix.github.io/simfinity.js/). After pushing the reviewed documentation to `master`, publish it from Actions or with the GitHub CLI:

```sh
gh workflow run docs.yml --repo simtlix/simfinity.js --ref master -f deploy=true
```

The deployment job requires `pages: write` and `id-token: write`; pull requests only build the site. Publication replaces the static Pages site and does not publish an npm release. To roll back content or deployment configuration, revert the relevant commit on `master` and dispatch publication again. Confirm the Actions deployment succeeds and that the home page, a guide, and their assets load at the public subdirectory.

For another static host, use install command `npm ci --prefix docs`, build command `npm run docs:build`, output directory `docs/.vitepress/dist`, and Node.js 22+. See the [VitePress deployment documentation](https://vuejs.github.io/vitepress/v1/guide/deploy).

Before submitting changes, build the site, verify search, navigation, code copying, light/dark themes, and mobile layouts. Run the repository's `npm run lint` and `npm test`. Do not include generated output in Git or npm.

## Maintaining starter downloads

The npm-based ZIP uses `docs/starters/package.*.json`, `docs/starters/README.md`, and the same server sources rendered by the quick starts. When updating the release, align the starter package versions and README, then rebuild:

```sh
python3 docs/scripts/build-starters.py
```

The builder checks Simfinity dependency versions against the root package and writes a deterministic ZIP plus SHA-256 checksum under `docs/public/releases/`. Commit both artifacts with the source changes. Verify clean registry installs and real quick-start operations for both databases after npm publication, then deploy Pages.

The original MongoDB 3.0.1 starter and the earlier 3.2.0 preview archive kit remain unchanged as historical downloads. `docs/scripts/build-preview.py` rebuilds that archived snapshot only from the verified archives in its manifest; it is not the current release builder. The docs workflow publishes the site only. Library tags/releases and npm publication follow the separate workflows described in the contribution guide.
