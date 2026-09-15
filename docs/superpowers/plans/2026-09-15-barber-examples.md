# Barber Examples Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan in the current session. The user's standing instruction authorizes continuing through publication without further approval pauses.

**Goal:** Publish runnable MongoDB/PostgreSQL Barber examples with their own CI in the Simtlix monorepo.

**Architecture:** Two private backend applications consume published Simfinity packages and share one independent Next.js frontend. Separate Compose projects select the database at startup; library workspace dependencies remain unchanged.

**Tech Stack:** Node.js 24, Simfinity 3.2.0, GraphQL Yoga, MongoDB 8 replica set, PostgreSQL 18, Next.js, Vitest, Playwright, Docker Compose and GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-15-barber-examples-design.md`.

## Global constraints

- Preserve the running Barber demo on ports 4300/4301 and its database/volumes.
- Keep example applications outside `packages/*` workspaces and publish no npm package.
- Copy tracked source only; exclude real environment files, uploads, vendor archives and generated output.
- Pin all consumed Simfinity runtime packages to 3.2.0 and preserve the shared GraphQL semantics.

## Task 1: Independent source applications

- [ ] Copy the two backend source trees and PostgreSQL frontend into `examples/barber/{mongodb,postgres,frontend}` using the pinned source commits and the spec's exclusions.
- [ ] Install each application with its own lockfile and run the inherited backend tests before changing behavior: `npm test --prefix examples/barber/mongodb` and `npm test --prefix examples/barber/postgres`.
- [ ] Replace `file:vendor/*.tgz` with exact registry dependencies; mark both backends private. Keep package licenses and record source provenance in `examples/barber/README.md`.
- [ ] Add MongoDB application/database initialization matching the PostgreSQL startup contract; verify `/health` against a disposable replica set before and after the readiness change.
- [ ] Keep PostgreSQL integration runners and replace the obsolete snapshot comparison in `scripts/exportSchema.js` with current GraphQL/SQL/FK export to an ignored generated directory.

## Task 2: Reproducible demos and application checks

- [ ] Add both Compose files, Dockerfiles, `.dockerignore` and safe `.env.example` files. Use default ports 4400/4401 for MongoDB and 4500/4501 for PostgreSQL; keep database ports distinct from existing services.
- [ ] Standardize the existing HTTP seed and browser scenarios on the same demo slug/accounts. Preserve real authorization and booking assertions; accept each backend's ID representation.
- [ ] Add a shared HTTP contract runner that asserts health, public catalog, authenticated scope boundaries, a real booking and MCP tools against `GRAPHQL_ENDPOINT`; failures must exit nonzero.
- [ ] Run clean Docker startup and seed commands for each backend, then backend tests/integration, frontend unit/build and browser tests. Fix observed failures with focused regression coverage.

## Task 3: Monorepo integration and delivery

- [ ] Exclude `examples/**` from root ESLint/Vitest discovery; give the example a dedicated workflow with frontend validation and backend matrix checks, failure logs and owned-resource cleanup.
- [ ] Document Compose startup/seeding/reset, host development and generated schema/FKs; link examples from `README.md` and the public resources page. Update `AGENTS.md`/Cursor guidance to explain independent checks.
- [ ] Verify root lint/tests, package boundaries, docs build, example clean installs, matching API contracts, archive/environment exclusions and local service health.
- [ ] Request scoped read-only review; commit and push `codex/barber-examples`, create PR, wait for all Actions, merge and deploy documentation. Clean only owned test resources and synchronize the main checkout.
