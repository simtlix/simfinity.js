# PostgreSQL completion and barber application

## Intent and authority

Complete the PostgreSQL library and then port `/Users/claudiogonzalez/SCM/simfinity-barber` on an isolated `codex/` branch. The user explicitly authorized autonomous implementation, local branches/worktrees, Docker infrastructure and documentation work without approval pauses. The existing PostgreSQL design remains the architecture; this document updates its compatibility baseline and delivery scope.

## Compatibility baseline

Use the current upstream Simfinity source and documentation, fetched on 2026-09-12 at `37efd341dd42741a4f5539f6b6f137733b6b3ada` (v3.1.0 plus documentation). Preserve its GraphQL schema, inputs, middleware, scope, controller, validation, authorization and state-machine contracts. In particular, scopes now apply to generated referenced relationships and standalone `saveObject` owns a transaction. Earlier foundation statements about root-only scopes, ignored empty strings and nontransactional standalone saves are superseded.

MongoDB native models, ObjectIds and aggregation pipeline helpers remain MongoDB-specific; PostgreSQL uses UUIDs and its native adapter. The application port must replace its direct Mongoose calls. A backend is selected in application code at startup; switching populated databases or migrating existing production records is outside this delivery.

## Architecture and deliverables

- Retain the shared runtime and separate PostgreSQL package. Core and PostgreSQL must not install MongoDB, Mongoose or MCP dependencies. Shared authorization, validators, scalars and count plugins are available through both facades. MCP uses a separate optional package/entry so applications opt into its SDK.
- Generate native PostgreSQL tables, indexes and real foreign keys from GraphQL metadata, covering one-to-many, explicit many-to-many link entities and embedded references. Complete embedded/multikey uniqueness with owner-aware keys and database enforcement; preserve the declared field types and wrappers.
- Extend the differential query corpus to close the supported scalar-array/embedded projection and aggregation gaps, including absent/null handling. Reject genuinely unrepresentable or unsupported metadata clearly, document exact boundaries, and never silently produce different results.
- Keep schema initialization non-destructive and deterministic. Strengthen generated embedded constraints where metadata describes required shape/ownership. Schema evolution requires explicit operator-managed migrations; do not introduce an automatic destructive synchronizer.
- Integrate PostgreSQL into the latest public documentation site, package/type checks and ordered release automation. Prepare reviewable local commits and installable archives; publishing a public npm release is not required to deliver this work.
- Port barber after the library works: preserve its API, authorization and business behavior; replace Mongoose persistence, configure PostgreSQL, generate schema/FKs, seed disposable data, and provide Docker startup plus executable application tests. Keep the original checkout and its data intact.

## Validation

Run lint, the full library test suite with disposable MongoDB and PostgreSQL, upstream v3.1.0 regressions adapted to shared runtime, differential database tests, packed standalone consumers and documentation build. Verify PostgreSQL 15, 16 and 18 compatibility. Run barber backend tests, frontend checks appropriate to unchanged API, and a real GraphQL smoke covering authentication, creation, booking lifecycle, restrictions and relational data. Inspect generated database constraints directly. Independent reviews must assess each substantial implementation and final delivery.
