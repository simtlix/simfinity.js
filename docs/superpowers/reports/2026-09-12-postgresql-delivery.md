# PostgreSQL 3.2.0 delivery record

Library and Barber implementation, verification and independent reviews are complete. The final enum-filter correction and its source-to-application package handoff are approved, with no open findings. The application is running locally.

## Library and package provenance

The library work is on `codex/postgresql-foundations`, based on upstream `37efd341dd42741a4f5539f6b6f137733b6b3ada` (Simfinity 3.1.0). The upstream import is a real merge, `1e9a811`, so the final feature comparison uses that upstream commit as its base.

Four packages are prepared at **3.2.0**, with exact internal dependency versions:

| Package | Purpose |
| --- | --- |
| `@simtlix/simfinity-core` | Shared GraphQL runtime, metadata, authorization, scalar and validator helpers |
| `@simtlix/simfinity-postgres` | PostgreSQL adapter, schema generation, native records and transactions |
| `@simtlix/simfinity-mcp` | Optional MCP tools and transports; server SDK is opt-in |
| `@simtlix/simfinity-js` | Existing MongoDB facade and public exports |

The verified release archive set is `3.2.0-d98197387543`, with manifest source commit `d98197387543d185fc79d5c31757b12e07ef2436`. Its archive identities, dependency versions, SHA512 integrity and SHA256 hashes were checked. No registry package, remote branch, tag, GitHub release or website was published.

| Archive | SHA256 |
| --- | --- |
| `simtlix-simfinity-core-3.2.0.tgz` | `856d3b471ec708416a6cb116ca0ac9a470adc87d3ed0aca6dd4165f2c190bc43` |
| `simtlix-simfinity-mcp-3.2.0.tgz` | `628f7351bb5d352f60bd4d5ad7a8da4dfc464aa35221ddfa5dd7882c77ad6778` |
| `simtlix-simfinity-postgres-3.2.0.tgz` | `ba9525440e0a30e67f452e6cc7093f9a9a869cdcbe9c45da4d63dab4cf3108ae` |
| `simtlix-simfinity-js-3.2.0.tgz` | `d734d486eda56fddb5f8b31cbf41e6e38338e4814f20304aeecef68ce341e6f8` |

Both preceding archive directories (`3.2.0-03ac88d0543a` and `3.2.0-96a50dcd9450`) remain intact. All 70 files in the new archives byte-match the named Git source commit. Later delivery-report commits do not alter packaged source.

## Verified library behavior

The shared runtime retains the current generated GraphQL contract, including relationship scopes, nested write authorization and ownership checks, bounded query inputs, hooks, state transitions and transaction participation. Backend choice is fixed during startup. PostgreSQL uses UUID identities and plain native records; it does not emulate Mongoose documents or pipelines.

Schema generation includes real reference FKs, inverse relationships through the dependent table, explicit many-to-many link entities, and private owned tables for embedded references. It also generates required/type/enum/shape checks, ownership consistency triggers, multikey uniqueness keys and indexes. Initialization creates missing compatible objects or performs read-only validation; incompatible drift is rejected without modifying existing definitions.

Differential tests cover nested embedded scalar lists, ragged group projections, absent/null distinctions, list order and duplicates, array facts and sorting, joined cardinality, default/minimization behavior, uniqueness and historical Date values. SQL and JSON null group keys are normalized at the outer group boundary while nulls within arrays remain distinct.

The public contract and executable startup example are documented in `docs/guide/postgresql.md`; detailed storage and compatibility rules remain in `docs/postgresql.md` and `docs/compatibility.md`.

## Verification

Pre-correction runtime/package-version matrix, run sequentially with distinct disposable contract and upstream Mongo databases:

| PostgreSQL | MongoDB | Result |
| --- | --- | --- |
| 15 | 7 | 47 test files, 956 tests passed |
| 16 | 8 | 47 test files, 956 tests passed |
| 18 | 8 | 47 test files, 956 tests passed |

The later release-only fixes passed 34 focused release/publisher tests. A temporary Git regression executes the release workflow's actual staging command after a version bump and verifies that no helper-owned version file remains unstaged.

Other completed checks:

- Repository ESLint and CRLF-aware diff checks.
- Five isolated archive consumers: core, PostgreSQL, MCP without SDK, MCP with SDK and MongoDB; runtime imports and strict TypeScript compilation.
- The same five consumers on Node 18.20.8 for the final runtime changes. The declared minimum remains Node 18.18.0; development verification uses Node 24.
- Documentation dependency installation, VitePress build and exclusion of internal plan/spec content from generated pages/search.
- An actual Yoga server running the documented nested mutation on PostgreSQL, including controller context and a catalog-verified deferrable `NO ACTION` FK.
- Browser checks of home and PostgreSQL guide, desktop and mobile navigation, no JavaScript errors, and no horizontal document overflow at a 390-pixel viewport.
- Actionlint on database/release/publication workflows; local-only publication dry run; actual archive manifest verification.

The browser harness initially expected extensionless navigation URLs; VitePress's canonical `.html` links were confirmed and the harness corrected. No site behavior change was necessary.

## Decisions made during implementation

1. Continued the existing library feature branch and used a separate Barber worktree. This follows the authorization to implement locally while preserving the original checkout; changing that choice would require only local branch/worktree cleanup.
2. Used the latest fetched 3.1.0 upstream contract, including its scope and standalone-save fixes. Older application consumers may need to adapt to that documented contract.
3. Prepared local packages and release automation without public publication or production data migration. Distribution through registries remains a separate operation; the application consumes verified local archives.
4. Ignored the Barber worktree in `.git/info/exclude` instead of changing the original branch's tracked ignore file. The ignore entry is local to this clone.
5. Put shared helpers in core and MCP in a separate package with an optional SDK peer, preserving the Mongo facade exports. PostgreSQL applications that expose MCP must add the separate package/import explicitly.
6. Versioned all four packages together at unpublished 3.2.0. This makes dependency/release consistency straightforward; the new packages do not have independent initial version numbers.
7. Split stored-key integrity from native default normalization during implementation, then closed the integration gap with differential uniqueness tests. The intermediate constraint-only checkpoint was not accepted as final parity.
8. Split JSONB Date acceptance from historical native driver Date serialization, then fixed both. The final runtime serializes generated Date parameters in UTC without changing global driver settings or the process timezone.

The manual GitHub-release recovery process from upstream is retained: if tag push succeeds but release creation fails, create the release from that existing tag. Package publication has its own integrity-checked rerun path.

Required PostgreSQL storage constraints remain stronger than Mongoose. An optional inline parent materialized by descendant list defaults must contain any required scalar. This consequence is tested and documented, including the native explicit-null alternative.

## Application handoff

The original Barber `main` remains at `00718c0195374ab1baaefd32d8a24e21a238b4c3`. Work is isolated on `codex/postgresql`. Baselines include 59 backend tests, 3 frontend unit tests, a production frontend build and the original 33-query/47-mutation SDL.

A focused probe of the unchanged original application, using its real Yoga authorization plugin and synthetic MongoDB data, confirmed three missing permission checks: self-service privilege updates, modifications to another user, and modifications to another owner's service. A foreign-shop update control correctly returned `FORBIDDEN`. The disposable database was removed and the original source was unchanged. The PostgreSQL port preserves legitimate flows and closes these reproduced gaps.

The application implementation is committed as `e74571ed88377c075119d84f66c1271ae2a6c754`, with review fix `d8d6424cc662e40fc17c40202f9913d2411d1685`, on `codex/postgresql`, in `/Users/claudiogonzalez/SCM/simfinity-barber/.worktrees/codex-postgresql`. The final archive refresh and Storybook cleanup are committed as `d149c625100178f412b792d961a8ac4f42dc78b8`. It consumes the verified core/PostgreSQL/MCP archives above, committed with checksums in its `backend/vendor/`. The installed backend has one shared core and no Mongoose/MongoDB dependencies.

The port centralizes Pool and schema readiness for Yoga, scripts and MCP, forwards active sessions through custom writes and controllers, and enforces resource ownership for root and nested mutations. The three reproduced original authorization gaps are covered by denial regressions alongside legitimate self/owner/admin operations. Native paging covers more than 100 records. Bundle and booking updates recalculate derived values; review statistics commit or roll back with the review. An explicit `(state, (address->>'city'))` index supplements generated indexes because embedded paths are not supported by generated compound index metadata.

| Application verification | Result |
| --- | --- |
| Backend unit suite | 11 files, 69 tests passed after corrected archive installation; all 59 original tests retained/adapted |
| Isolated PostgreSQL API runner | Final 67 successful/denied operation checks, plus auth, scopes, paging, FK, rollback and MCP assertions |
| Dataset through GraphQL | Loaded and deleted 3 shops, 13 services, 8 categories, 6 professionals, 4 bundles, 4 bookings, 4 reviews and 4 favorites in a private schema |
| SDL comparison | All 33 queries and 47 mutations retained; zero field/argument type differences |
| Frontend | 3 unit tests, 4 browser tests including actual login/full booking, production build with 32 static pages |
| Independent browser QA | Three demo logins, UUID token subjects, real search/detail and dashboards; zero GraphQL/JavaScript errors; 390-pixel mobile layout fits |
| Infrastructure | New Compose volume, generated schema readiness, same-volume restart, repeated seeding and final health checks passed |

Browser QA found two invalid existing frontend selections (`review.professional` and `barbershop.createdAt`), now corrected and covered against the real schema. The mobile detail overflow was also corrected. Other frontend changes are backend URL configuration and tests. The final correction removes the unused MDX Storybook glob; the frontend unit command passes all 3 tests without the warning.

The task reviewer reproduced stale derived fields when booking lines or bundle services were cleared to `[]` or `null`. Fix `d8d6424` applies unsets before calculating the effective record and resets the resulting charge/duration while retaining explicit null versus empty arrays. Omitted lists remain unchanged; the existing empty-bundle price exemption is preserved. Scoped re-review independently reproduced all four clear cases, omission controls and valid/invalid replacement behavior, then approved the fix with no new breakage. Task 6 is approved. The pre-existing Storybook warning was subsequently removed in the final correction wave.

The application records the generated SQL, FK catalog, original/PostgreSQL SDL and empty API diff in `backend/schema/`. Its `docs/postgresql-port.md` and root/backend/frontend READMEs contain reproducible commands, native migration examples, archive provenance and explicit limitations. Test mutation runners use random schemas and remove them in `finally`; browser booking tests create synthetic future reservations in the local demo.

## Running local application

The Compose project is `simfinity-barber-postgres`, with its own database and uploads volumes. All three services are healthy and bound to `127.0.0.1` by default:

- Frontend: http://localhost:4301
- GraphQL: http://localhost:4300/graphql
- MCP: http://localhost:4300/mcp
- PostgreSQL: port 55440, database/user `barber`, local password `barber_local`

Demo accounts are `cliente@demo.com`, `propietario@demo.com` and `admin@demo.com`, all with password `demo1234`. The approved shop is `/b/postgres-demo`, with an active service/professional and all-week 09:00–18:00 hours. From the application worktree, `docker compose up --build -d` starts services; `docker compose exec backend npm run seed:admin` and `docker compose exec backend npm run seed:demo` create or retain the synthetic demo accounts/data. `docker compose restart` retains data; `docker compose down` stops this project while retaining its volumes.

All six implementation task reviews are approved. The final combined review found F1 (enum query compatibility) and M1 (whitespace hygiene). The scoped final review approved their corrections, Storybook cleanup and package handoff, with no new breakage or remaining findings.

## Final correction verification

Library source commit: `d98197387543d185fc79d5c31757b12e07ef2436`, from fix base `47bdd1f2643975d4bfe5687e568955f5fc124562`. App commit: `d149c625100178f412b792d961a8ac4f42dc78b8`, from fix base `d8d6424cc662e40fc17c40202f9913d2411d1685`.

Enum metadata now retains names and original internal values. Only query encoding resolves a member name first, then a strictly equal internal value, before conversion to PostgreSQL text storage. This fixes the `ONE → TWO`, `TWO → two` collision and numeric values across EQ/NE/LT/LTE/GT/GTE/BTW/IN/NIN. LIKE rejects enum fields. The persistence encoder, state guards and GraphQL output semantics are unchanged. Dedicated differential cases exercise root/list/embedded/reference/state paths through find, count and aggregate, including nulls, unknowns, malformed inputs and actual Mongo baselines. The existing lifecycle regression now expects name precedence while retaining persisted-value and denied-transition assertions.

Before runtime changes, the new compiler/differential/lifecycle run failed 24 tests and passed 20; afterward all 44 passed. The full suite on PostgreSQL 15/MongoDB 7 passed **48 files / 990 tests**, including upstream opt-in tests. The affected compiler/query/embedded/lifecycle suites on PostgreSQL 16/MongoDB 8 and PostgreSQL 18/MongoDB 8 each passed **5 files / 212 tests**. ESLint, all five packed runtime/strict-TypeScript consumers on Node 24 and the docs build passed. The coordinator independently verified all five packed consumers on Node 18.20.8 from the corrected source (read-only mount, temporary container removed). The full upstream-to-HEAD CRLF-aware whitespace comparison now passes after only the identified trailing-space/EOF cleanup.

Release manifest verification and the local-only npm publication dry run passed. Barber's lockfile SHA512 entries were refreshed despite unchanged filenames/3.2.0 versions. Clean host `npm ci` and Docker `npm ci --omit=dev` both ran, and every installed file in all three packages (45 files total) byte-matches its archive on the host and in the running container. Dependency inspection confirms one deduplicated core and no Mongoose/MongoDB dependency.

After archive replacement, Barber passed **11 backend files / 69 tests**, the **67-operation private-schema API runner** plus auth/scopes/FK/rollback/derived-value and real MCP assertions, unchanged **33-query/47-mutation SDL** with zero field/argument differences, and both dashboard schema selections. The warning-free frontend unit run passed **3 tests**. The backend was rebuilt from the exact archives, all three Compose services remain healthy on loopback bindings 4300/4301/55440, and an actual Chromium login/full-booking smoke passed (**1 test**) against that rebuilt backend. Its synthetic future reservation was confirmed with a UUID. No production frontend rebuild was needed for the Storybook configuration-only change. The coordinator then independently repeated all three actual logins, UUID checks, search/detail and dashboards against the rebuilt backend: zero GraphQL/JavaScript errors, with mobile width 390/390.

Detailed commands, disposable URIs and logs are preserved in the [final verification record](2026-09-12-postgresql-final-verification.md). The [final review record](2026-09-12-postgresql-review.md) preserves both the original whole-branch findings and the subsequent approval of every correction. The final reviewed library HEAD is `a311134df2d9b8273466b80ad509828b7f9c6313`; the application HEAD is `d149c625100178f412b792d961a8ac4f42dc78b8`. Later delivery-record commits do not alter package contents or their source provenance.

## Final local handoff

Both feature branches and the Barber worktree are retained for local use. The original Barber `main` was finally verified clean at `00718c0195374ab1baaefd32d8a24e21a238b4c3`; its PostgreSQL worktree is clean at `d149c625100178f412b792d961a8ac4f42dc78b8`. The library retains only the six original untracked user tarballs outside its committed work.

The five task-owned MongoDB/PostgreSQL test containers and their anonymous volumes were stopped and removed after final review. The Barber Compose project and its persistent volumes remain available, with all three services healthy on loopback ports 4300, 4301 and 55440. Final HTTP checks of the API health endpoint and frontend returned 200. Unrelated Docker services were left running.

All plan steps are complete. Permanent records preserve the verification evidence, final review and all eight implementation decisions before removal of this plan's temporary scratch workspace. No remote publication, push, merge to the original main, production deployment or data migration was performed.
