# Final PostgreSQL verification record

Date: 2026-09-12. Status: **PASS — corrections implemented, verified and approved by the independent scoped final review.**

## Commits and artifacts

- Library workspace: `/Users/claudiogonzalez/SCM/GitHub/simfinity.js`, branch `codex/postgresql-foundations`.
- Library FIX_BASE: `47bdd1f2643975d4bfe5687e568955f5fc124562`.
- Library package/source fix: `d98197387543d185fc79d5c31757b12e07ef2436` (`fix: preserve Mongo enum filter resolution in PostgreSQL`).
- Library HEAD/report commit: `a311134df2d9b8273466b80ad509828b7f9c6313` (`docs: record final enum correction and verified package handoff`). Only the permanent delivery report differs after the package/source commit.
- App workspace: `/Users/claudiogonzalez/SCM/simfinity-barber/.worktrees/codex-postgresql`, branch `codex/postgresql`.
- App FIX_BASE: `d8d6424cc662e40fc17c40202f9913d2411d1685`.
- App HEAD: `d149c625100178f412b792d961a8ac4f42dc78b8` (`fix: consume corrected enum query packages and quiet Storybook`).
- New final archive set: `/Users/claudiogonzalez/SCM/simfinity-postgresql-artifacts/3.2.0-d98197387543`, manifest commit `d98197387543d185fc79d5c31757b12e07ef2436`.
- Previous sets `3.2.0-03ac88d0543a` and `3.2.0-96a50dcd9450` remain intact. The six original root user tarballs remain untracked and untouched.

| Archive | SHA256 |
| --- | --- |
| core | `856d3b471ec708416a6cb116ca0ac9a470adc87d3ed0aca6dd4165f2c190bc43` |
| MCP | `628f7351bb5d352f60bd4d5ad7a8da4dfc464aa35221ddfa5dd7882c77ad6778` |
| PostgreSQL | `ba9525440e0a30e67f452e6cc7093f9a9a869cdcbe9c45da4d63dab4cf3108ae` |
| Mongo facade | `d734d486eda56fddb5f8b31cbf41e6e38338e4814f20304aeecef68ce341e6f8` |

All remain unpublished 3.2.0 with unchanged lockstep internal dependency versions. SHA512 integrity values are in the source and filtered Barber manifests and the app lockfile.

## Findings addressed

F1 verified against current `src/mongo/queries.js` and original upstream `37efd341:src/index.js:1386–1445` (saved excerpt `/tmp/simfinity-final-fix-upstream-binder.txt`). Both resolve enum member names first, then strictly equal internal values; LIKE requires an effective String field.

Core scalar metadata now retains `{ name, value }` enum entries alongside its unchanged stored-string list. PostgreSQL's query compiler uses those original values to resolve enum query inputs before calling its unchanged persistence encoder. No name remapping was added to `encodeScalar`, state persistence, transition guards or GraphQL decoding. The `ONE → TWO`, `TWO → two` collision now selects the named member `TWO` for filter `"TWO"`, and numeric internal `1` requires numeric input rather than string `"1"`. LIKE rejects enum fields before binding.

Meaningful tests were added before runtime edits:

- Focused compiler coverage checks literal bound parameters for every EQ/NE/LT/LTE/GT/GTE/BTW/IN/NIN operator, scalar enums and enum scalar lists, mixed name/numeric set values, strict invalid inputs and valid-internal-string LIKE rejection.
- New real `enum-query-parity.test.js` compares both adapters through GraphQL find/count/aggregate on root, scalar-list, embedded-list and reference leaves and actual state-machine enums. All nine operators cover member names/internal values, collision precedence and numeric enums. Literal expected selected keys prevent an empty/shared result from masking the main collision. Nulls, empty IN/NIN sets, unknowns, numeric strings, invalid LIKE/null/array/bounds are covered.
- Existing lifecycle test now expects `PUBLISHED` to select the member named PUBLISHED, while `DRAFT` selects the initial record. Its persisted internal `PUBLISHED` value, denied invalid transition, successful concurrent transition and enum output assertions remain.

M1: only trailing whitespace and extra EOF lines in the files identified by `/tmp/simfinity-final-whitespace.log` were normalized. Original line endings were preserved. The whole upstream comparison now passes the same CRLF-aware check, rather than only per-change checks.

Storybook: removed only the unused `../src/**/*.mdx` entry from `frontend/.storybook/main.ts`. Existing unit command now passes without the warning. No configuration-mirroring test or production UI change was introduced.

Public README/storage guide, architecture rule, permanent library delivery report, and app root/backend READMEs/compact port report describe the corrected behavior/provenance. They do not declare final review approved.

## Library validation

All npm commands used `PATH=/Users/claudiogonzalez/.nvm/versions/node/v24.2.0/bin:$PATH`.

Disposable database environment:

| Combination | SIMFINITY_POSTGRES_URI | SIMFINITY_MONGODB_URI |
| --- | --- | --- |
| PG15/Mongo7 | `postgresql://postgres:simfinity@127.0.0.1:55435/simfinity_completion` | `mongodb://127.0.0.1:27027/simfinity_completion?replicaSet=rs0&directConnection=true` |
| PG16/Mongo8 | `postgresql://postgres:simfinity@127.0.0.1:55436/simfinity_completion` | `mongodb://127.0.0.1:27028/simfinity_task1?replicaSet=rs0&directConnection=true` |
| PG18/Mongo8 | `postgresql://postgres:simfinity@127.0.0.1:55438/simfinity_task1` | `mongodb://127.0.0.1:27028/simfinity_task1?replicaSet=rs0&directConnection=true` |

Full suite also set `SIMFINITY_TEST_MONGODB_URI=mongodb://127.0.0.1:27027/simfinity_completion_upstream?replicaSet=rs0&directConnection=true`. New differential tests create/drop random private Mongo databases and PostgreSQL schemas; no persistent demo records were used for these probes.

| Command | Result | Log |
| --- | --- | --- |
| `npm test -- tests/postgres-query.test.js tests/integration/enum-query-parity.test.js tests/integration/postgres-lifecycle.test.js` on PG15/Mongo7, before runtime edit | Expected red: **24 failed / 20 passed**, exit1. Failures reproduce missing name resolution, wrong collision row/parameter, numeric-string acceptance and LIKE acceptance. | `/tmp/simfinity-final-fix-red.log` |
| Same focused command after runtime edit | **3 files / 44 passed**, exit0 | `/tmp/simfinity-final-fix-green.log` |
| `npm test` on PG15/Mongo7 with opt-in upstream URI | **48 files / 990 passed**, no skips, exit0 | `/tmp/simfinity-final-fix-full.log` |
| `npm test -- tests/postgres-query.test.js tests/integration/enum-query-parity.test.js tests/integration/embedded-query-parity.test.js tests/integration/query-parity.test.js tests/integration/postgres-lifecycle.test.js` on PG16/Mongo8 | **5 files / 212 passed**, exit0 | `/tmp/simfinity-final-fix-pg16.log` |
| Same affected command on PG18/Mongo8 | **5 files / 212 passed**, exit0 | `/tmp/simfinity-final-fix-pg18.log` |
| `npm run lint` | exit0 | `/tmp/simfinity-final-fix-lint.log` |
| `npm run test:packages` | Five isolated runtime/strict-TypeScript consumers passed, exit0 | `/tmp/simfinity-final-fix-packages.log` |
| `npm run docs:build` | VitePress build passed, exit0 | `/tmp/simfinity-final-fix-docs.log` |
| `git -c core.whitespace=cr-at-eol diff --check 37efd341...HEAD` | Whole branch exit0 after source and report commits | final terminal output |

Coordinator's independent minimum-runtime verification: five consumers (core, PostgreSQL, MCP without SDK, MCP with SDK, Mongo) passed imports and strict TypeScript on confirmed **Node18.20.8**, exit0. Temporary `simfinity-final-node18-package-check` container used `node:18-bookworm-slim` with read-only library mount and was automatically removed. Log `/tmp/simfinity-final-enum-node18-packages.log`. No duplicate Node18 run was performed here.

## Packing and actual-byte provenance

Source was committed and tracked tree clean before packing. One four-package set was packed with the existing release helper; a mistyped newly created destination suffix was immediately renamed to the actual source prefix before consuming it (no repack or older directory mutation).

```sh
node scripts/release-packages.js pack /Users/claudiogonzalez/SCM/simfinity-postgresql-artifacts/3.2.0-d98197340d12
mv /Users/claudiogonzalez/SCM/simfinity-postgresql-artifacts/3.2.0-d98197340d12 /Users/claudiogonzalez/SCM/simfinity-postgresql-artifacts/3.2.0-d98197387543
node scripts/release-packages.js verify /Users/claudiogonzalez/SCM/simfinity-postgresql-artifacts/3.2.0-d98197387543/manifest.json
node scripts/publish-packages.js /Users/claudiogonzalez/SCM/simfinity-postgresql-artifacts/3.2.0-d98197387543/manifest.json --registry npm --dry-run
```

All exit0. Logs `/tmp/simfinity-final-fix-pack.log`, `/tmp/simfinity-final-fix-verify.log`, `/tmp/simfinity-final-fix-dry-run.log`. Dry run is the existing local-only mode; no registry publication occurred.

Independent local byte verification iterated every tar member and compared it to `git show <manifest.commit>:<package-source-path>`: **24 core + 5 MCP + 16 PostgreSQL + 25 Mongo files, all 70 exact matches**. Log `/tmp/simfinity-final-fix-provenance.log`.

Barber vendor archives were copied from this final directory; its manifest is the exact three-package filtered manifest. Only the three package lock integrity values changed. `npm ci --prefix backend` completed successfully, recreating installed content using the changed integrity instead of trusting an old same-name/version cache. Log `/tmp/barber-final-fix-ci.log`.

`/tmp/verify-final-packages.mjs` verifies each vendored archive's SHA256/SHA512, lockfile integrity, and every tar member against actual installed files. Host command `node /tmp/verify-final-packages.mjs <app>/backend` passed **all 45 package files**, log `/tmp/barber-final-fix-installed.log`. After Docker rebuild, `docker compose exec -T backend node --input-type=module - /app < /tmp/verify-final-packages.mjs` passed the same **45 files** in the running backend, log `/tmp/barber-final-fix-docker-installed.log`.

`npm ls --prefix backend @simtlix/simfinity-core @simtlix/simfinity-postgres @simtlix/simfinity-mcp mongoose mongodb` exits0 and shows one deduplicated core with no Mongoose/MongoDB dependency; log `/tmp/barber-final-fix-dependencies.log`.

## App verification after installing corrected archives

Commands run from app root except the noted frontend commands. Node24 PATH as above. Existing app DB defaults use `postgres://barber:barber_local@localhost:55440/barber`; mutation integration runner always replaces `DATABASE_SCHEMA` with a unique private schema and drops it in cleanup.

| Command | Result | Log |
| --- | --- | --- |
| `npm test --prefix backend` | **11 files / 69 tests passed**, exit0 | `/tmp/barber-final-fix-backend.log` |
| `npm run test:postgres --prefix backend` | **67 API operation checks**, plus auth/scopes/paging/derived values/FK/rollback and actual in-process/HTTP MCP assertions, exit0 | `/tmp/barber-final-fix-api.log` |
| `npm run schema:export --prefix backend` | **33 original queries / 47 original mutations; 0 SDL differences**, exit0; generated artifacts unchanged | `/tmp/barber-final-fix-schema.log` |
| `npm run test:frontend-queries --prefix backend` | Both real dashboard selections validate, exit0 | `/tmp/barber-final-fix-queries.log` |
| `env -u NO_COLOR PATH=... npm run test:unit` from frontend | **1 file / 3 tests passed**, no Storybook MDX warning, exit0 | `/tmp/barber-final-fix-frontend.log` |
| `docker compose up --build -d backend` | exit0; fresh `npm ci --omit=dev` added169 packages (not cached), backend rebuilt/recreated; existing DB retained | `/tmp/barber-final-fix-build.log` |
| `env -u NO_COLOR PATH=... PLAYWRIGHT_BASE_URL=http://localhost:4301 npm run test:e2e -- --grep 'client logs in and books'` from frontend | **1 actual Chromium booking test passed in3.1s**, exit0; login, service/date/professional/time/review and UUID confirmation through rebuilt backend | `/tmp/barber-final-fix-booking.log` |
| `git diff --check` and staged equivalent | exit0 | final terminal output |

Booking screenshot: app `frontend/test-results/postgres-booking-confirmed.png` (ignored test output). The booking is synthetic future demo data, as in the established authorized browser fixture. No new diagnostic mutation probes targeted the persistent demo.

Coordinator repeated independent read/login QA after rebuilt-backend booking: all three real logins, UUID subjects, search, shop detail, owner/admin dashboards passed; **zero GraphQL/JavaScript errors**, mobile width **390/390**. Log `/tmp/simfinity-barber-final-browser.log`; updated results/screenshots `/tmp/simfinity-barber-browser/`.

Final `docker compose ps --format json` recorded in `/tmp/barber-final-fix-health.json`: all three services healthy on **127.0.0.1:4300 / 4301 / 55440**. Final GETs to `http://127.0.0.1:4300/health` and `http://127.0.0.1:4301` return200; backend body `{"status":"ok","database":"postgresql"}`. Log `/tmp/barber-final-fix-health.log`. Demo remains running.

No production frontend rebuild was performed for the Storybook-only configuration edit. Previous production UI/build evidence remains applicable; actual booking and independent read/login QA exercised the existing frontend against the corrected backend.

## Delivery state

Tracked library/app trees are clean; the library has only the six preserved untracked user archives. Original app main/data and original user tarballs were not edited. No remote push, publication, tag, release, website deployment or original-main merge occurred. The permanent library report distinguishes source commit versus later report commit and records the new archive/app provenance and updated69-test backend count. App compact report/docs are committed.

The independent scoped final review approved F1, whitespace hygiene, Storybook cleanup and the source-to-installed-package handoff with no new breakage. See the companion final review record. No implementation finding remains open.
