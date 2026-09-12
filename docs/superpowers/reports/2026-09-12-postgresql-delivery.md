# PostgreSQL 3.2.0 delivery record

This record captures verified work and its boundaries. Library implementation and task reviews are complete. The Barber application port is implemented and running; its task review and final combined review are in progress.

## Library and package provenance

The library work is on `codex/postgresql-foundations`, based on upstream `37efd341dd42741a4f5539f6b6f137733b6b3ada` (Simfinity 3.1.0). The upstream import is a real merge, `1e9a811`, so the final feature comparison uses that upstream commit as its base.

Four packages are prepared at **3.2.0**, with exact internal dependency versions:

| Package | Purpose |
| --- | --- |
| `@simtlix/simfinity-core` | Shared GraphQL runtime, metadata, authorization, scalar and validator helpers |
| `@simtlix/simfinity-postgres` | PostgreSQL adapter, schema generation, native records and transactions |
| `@simtlix/simfinity-mcp` | Optional MCP tools and transports; server SDK is opt-in |
| `@simtlix/simfinity-js` | Existing MongoDB facade and public exports |

The verified release archive set is `3.2.0-96a50dcd9450`, with manifest source commit `96a50dcd945020e4232a26e4042051530037e698`. Its archive identities, dependency versions, SHA512 integrity and SHA256 hashes were checked. No registry package, remote branch, tag, GitHub release or website was published.

| Archive | SHA256 |
| --- | --- |
| `simtlix-simfinity-core-3.2.0.tgz` | `8cb9f9dbd0460cb612e11062a37e9419b335e8c090d98df63a903127ea6c77b8` |
| `simtlix-simfinity-mcp-3.2.0.tgz` | `08d4ee626f9f9b5c25971301059bf4dde965fd632c5f54f5569eaa1877d7dfc1` |
| `simtlix-simfinity-postgres-3.2.0.tgz` | `3b152d2d01aae4407a4dacf310001cfaf3600c956a4c062ea971340358f4b9f3` |
| `simtlix-simfinity-js-3.2.0.tgz` | `2b712acd4b7cba3b0458441b41e3d8482825892f89e14939eb2c7087e33b8076` |

## Verified library behavior

The shared runtime retains the current generated GraphQL contract, including relationship scopes, nested write authorization and ownership checks, bounded query inputs, hooks, state transitions and transaction participation. Backend choice is fixed during startup. PostgreSQL uses UUID identities and plain native records; it does not emulate Mongoose documents or pipelines.

Schema generation includes real reference FKs, inverse relationships through the dependent table, explicit many-to-many link entities, and private owned tables for embedded references. It also generates required/type/enum/shape checks, ownership consistency triggers, multikey uniqueness keys and indexes. Initialization creates missing compatible objects or performs read-only validation; incompatible drift is rejected without modifying existing definitions.

Differential tests cover nested embedded scalar lists, ragged group projections, absent/null distinctions, list order and duplicates, array facts and sorting, joined cardinality, default/minimization behavior, uniqueness and historical Date values. SQL and JSON null group keys are normalized at the outer group boundary while nulls within arrays remain distinct.

The public contract and executable startup example are documented in `docs/guide/postgresql.md`; detailed storage and compatibility rules remain in `docs/postgresql.md` and `docs/compatibility.md`.

## Verification

Final runtime/package-version matrix, run sequentially with distinct disposable contract and upstream Mongo databases:

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

A focused probe of the unchanged original application, using its real Yoga authorization plugin and synthetic MongoDB data, confirmed three missing permission checks: self-service privilege updates, modifications to another user, and modifications to another owner's service. A foreign-shop update control correctly returned `FORBIDDEN`. The disposable database was removed and the original source was unchanged. The PostgreSQL port must preserve legitimate flows while closing these reproduced gaps.

The application implementation is committed as `e74571ed88377c075119d84f66c1271ae2a6c754` on `codex/postgresql`, in `/Users/claudiogonzalez/SCM/simfinity-barber/.worktrees/codex-postgresql`. It consumes the verified core/PostgreSQL/MCP archives above, committed with checksums in its `backend/vendor/`. The installed backend has one shared core and no Mongoose/MongoDB dependencies.

The port centralizes Pool and schema readiness for Yoga, scripts and MCP, forwards active sessions through custom writes and controllers, and enforces resource ownership for root and nested mutations. The three reproduced original authorization gaps are covered by denial regressions alongside legitimate self/owner/admin operations. Native paging covers more than 100 records. Bundle and booking updates recalculate derived values; review statistics commit or roll back with the review. An explicit `(state, (address->>'city'))` index supplements generated indexes because embedded paths are not supported by generated compound index metadata.

| Application verification | Result |
| --- | --- |
| Backend unit suite | 11 files, 63 tests passed; all 59 original tests retained/adapted |
| Isolated PostgreSQL API runner | 49 successful/denied operation checks, plus auth, scopes, paging, FK, rollback and MCP assertions |
| Dataset through GraphQL | Loaded and deleted 3 shops, 13 services, 8 categories, 6 professionals, 4 bundles, 4 bookings, 4 reviews and 4 favorites in a private schema |
| SDL comparison | All 33 queries and 47 mutations retained; zero field/argument type differences |
| Frontend | 3 unit tests, 4 browser tests including actual login/full booking, production build with 32 static pages |
| Independent browser QA | Three demo logins, UUID token subjects, real search/detail and dashboards; zero GraphQL/JavaScript errors; 390-pixel mobile layout fits |
| Infrastructure | New Compose volume, generated schema readiness, same-volume restart, repeated seeding and final health checks passed |

Browser QA found two invalid existing frontend selections (`review.professional` and `barbershop.createdAt`), now corrected and covered against the real schema. The mobile detail overflow was also corrected. Other frontend changes are backend URL configuration and tests. The existing nonfatal Storybook warning about missing MDX stories remains; the unit run passes.

The application records the generated SQL, FK catalog, original/PostgreSQL SDL and empty API diff in `backend/schema/`. Its `docs/postgresql-port.md` and root/backend/frontend READMEs contain reproducible commands, native migration examples, archive provenance and explicit limitations. Test mutation runners use random schemas and remove them in `finally`; browser booking tests create synthetic future reservations in the local demo.

## Running local application

The Compose project is `simfinity-barber-postgres`, with its own database and uploads volumes. All three services are healthy and bound to `127.0.0.1` by default:

- Frontend: http://localhost:4301
- GraphQL: http://localhost:4300/graphql
- MCP: http://localhost:4300/mcp
- PostgreSQL: port 55440, database/user `barber`, local password `barber_local`

Demo accounts are `cliente@demo.com`, `propietario@demo.com` and `admin@demo.com`, all with password `demo1234`. The approved shop is `/b/postgres-demo`, with an active service/professional and all-week 09:00–18:00 hours. From the application worktree, `docker compose up --build -d` starts services; `docker compose exec backend npm run seed:admin` and `docker compose exec backend npm run seed:demo` create or retain the synthetic demo accounts/data. `docker compose restart` retains data; `docker compose down` stops this project while retaining its volumes.

The application task review and final combined review remain pending. Their final verdicts, any fix commits and cleanup status will be recorded before delivery is marked complete.
