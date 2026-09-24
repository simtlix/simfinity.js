# Barber dependency security follow-up — 2026-09-24

## Why this follow-up exists

After the [library dependency review](./2026-09-24-package-security.md), GitHub reported additional alerts in the three independent Barber application lockfiles. The library audit does not cover these applications. This change fixes their dependency baselines separately from the Simfinity 3.4.2 npm release.

The initial GitHub count was 121 open advisory records across the root and example lockfiles, including three critical records in frontend development tooling. This differs from `npm audit` package-entry counts: one installed package can match several advisory records, and the same package can occur in multiple applications.

## Audit results

Full audits include runtime and development dependencies:

| Application | Affected entries before | Severity before | After |
| --- | --- | --- | --- |
| MongoDB backend | 12 | 6 high, 5 moderate, 1 low | 0 |
| PostgreSQL backend | 11 | 6 high, 4 moderate, 1 low | 0 |
| Shared frontend | 14 | 4 critical, 6 high, 2 moderate, 2 low | 0 |

These are dated dependency advisory matches. They do not establish that every advisory was exploitable in the running demo.

## Main findings and corrections

- **Mongoose update-casting prototype pollution:** the MongoDB example locked 8.23.0. It now requires `^8.24.2` and locks 8.24.4, matching the corrected library baseline. See the [maintainer advisory](https://github.com/Automattic/mongoose/security/advisories/GHSA-664h-wqgq-64gw).
- **Multer multipart parsing:** both backends locked 2.1.1. Crafted upload fields can terminate a Node process or bypass upload limits in affected versions. Both now require `^2.3.0` and lock 2.4.0. Multer is used by the applications' upload routes, so this is a runtime dependency correction. See the [multipart denial-of-service advisory](https://github.com/expressjs/multer/security/advisories/GHSA-wc9g-mqfw-jrwm).
- **Vitest Browser critical advisories:** the frontend locked the 4.1.0 browser/coverage cohort, including affected command/file-access behavior. These findings concern an exposed development test server, not the production Next.js bundle. Vitest, its browser provider and coverage tools now require `^4.1.11` and resolve together at 4.1.11. Both backends' Vitest versions were also updated to 4.1.11. See the [Browser Mode advisory](https://github.com/vitest-dev/vitest/security/advisories/GHSA-g8mr-85jm-7xhm).
- **Vite development server:** the frontend's 7.3.3 resolution had Windows path/file-access advisories. Its minimum is now `^7.3.5`, resolving to 7.3.6. See the [file-deny bypass advisory](https://github.com/vitejs/vite/security/advisories/GHSA-fx2h-pf6j-xcff).
- **Other transitive findings:** compatible updates cover the backend HTTP/parser/address dependencies and development dependencies including Babel, humanfs, brace-expansion, browserslist, image-size, js-yaml, ws and esbuild. The Storybook 10 packages were updated together to 10.6.0 because their previous esbuild range retained an affected development-server release.

The backend SDK, Express and Simfinity direct resolutions were retained. The examples still consume the exact released Simfinity **3.3.0** packages; no file dependencies, vendor archives or workspace memberships were introduced. The final frontend lockfile preserves its existing direct runtime resolutions, including Next.js, React, charting and styling libraries.

## Resolution and validation

Updating the frontend's tightly coupled Vitest peer cohort against its old lockfile initially failed npm peer resolution. A targeted lockfile refresh replaced that cohort and the affected dependency paths together. No `--force` or `--legacy-peer-deps` bypass was used. A trial full refresh was discarded because it changed unrelated runtime/lint dependencies; it is not the committed result.

Verified locally on Node.js 24:

- Clean installs and full audits: zero known alerts in all three apps.
- MongoDB backend: 62 unit tests passed.
- PostgreSQL backend: 72 unit tests passed.
- Frontend: strict type checking, three unit tests and Storybook production build passed; lint passed with the existing custom-font warning in `.storybook/preview.tsx`.

The dedicated Barber workflow validates the final commit against both disposable database stacks, shared HTTP/MCP/query/mutation contracts, transaction/dataset checks and the Playwright booking flow. It now runs `npm run test:security` in each app, including development tools, before those checks. Root library publication tooling continues to exclude the private examples.

Reproduce the audits from the repository root:

```sh
npm ci --prefix examples/barber/mongodb
npm run test:security --prefix examples/barber/mongodb
npm ci --prefix examples/barber/postgres
npm run test:security --prefix examples/barber/postgres
npm ci --prefix examples/barber/frontend
npm run test:security --prefix examples/barber/frontend
```

Use the [Barber runbook](https://github.com/simtlix/simfinity.js/blob/master/examples/barber/README.md) for database and browser checks. Those checks change synthetic records and must run only against disposable databases. Audit results depend on the current advisory feed and do not replace application security review.
