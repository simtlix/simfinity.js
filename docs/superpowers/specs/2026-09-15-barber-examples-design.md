# Barber examples in the Simfinity monorepo

The user requests publishing both existing Barber implementations under Simtlix using the authenticated account, preferably as examples in this repository, with independent pipelines. Their standing instruction authorizes completing implementation and publication without additional approval checkpoints.

## Structure

Use `examples/barber/mongodb/` and `examples/barber/postgres/` for independent private backend applications, and `examples/barber/frontend/` for the shared Next.js client. Each application keeps its own npm manifest and lockfile outside the library workspaces. MongoDB comes from Barber commit `00718c0195374ab1baaefd32d8a24e21a238b4c3`; PostgreSQL and the shared frontend come from `d149c625100178f412b792d961a8ac4f42dc78b8`.

Preserve the existing GraphQL entities, scopes, JWT authorization, state transitions, booking flow and MCP integration. Applications choose their backend by the Compose file/startup entry point, never by runtime switching. Consume the published Simfinity packages at exactly 3.2.0, replacing PostgreSQL's local vendor archives. Keep the application frontend dependencies independent from the library.

## Reproducible operation

Provide `compose.mongodb.yaml` and `compose.postgres.yaml` at the example root, with distinct project names, loopback ports and named volumes. MongoDB runs a single-node replica set; PostgreSQL runs version 18. Both APIs wait for database initialization and expose `/health`, `/graphql` and `/mcp`. Both use synthetic seeded demo accounts and a common `barber-demo` shop compatible with the shared frontend. The existing demo on ports 4300/4301 and its database/volumes remain untouched.

Copy tracked source, tests, synthetic dataset and public UI assets. Exclude environment files, node_modules, generated build output, uploaded user files, agent worktrees, local prompts, vendor archives and old generated schema snapshots. Preserve frontend licensing and document provenance. PostgreSQL schema export remains available as a generated local artifact, including SQL and FK descriptions.

## CI and documentation

Add a dedicated Barber Action, triggered by example and workflow changes, with explicit permissions and bounded jobs. Validate both backend unit suites, published dependency installation, real database initialization, login/scopes/booking and MCP behavior, and the shared frontend build/unit/browser tests against both backends. Keep library lint and Vitest discovery out of example applications; their own pipeline owns those dependencies and checks.

Document Docker and host development, environment variables, demo credentials, reset commands restricted to each example, PostgreSQL/MongoDB differences and independent CI. Link the examples from the main README and public documentation, and update agent guidance for the new directory boundary.

## Completion

Both examples must install from a clean checkout, run their documented Compose flows and pass their checks. Review the final diff, push a PR to `simtlix/simfinity.js`, wait for CI, merge, deploy changed documentation and synchronize the local checkout. No npm release is needed because the libraries are unchanged.
