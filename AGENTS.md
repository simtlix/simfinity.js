# Agent guidance for `@simtlix/simfinity-js`

This file helps coding agents (and humans) work productively and safely in this repository. It complements—not replaces—the detailed rules under `.cursor/rules/`.

## What this project is

- **Packages**: `@simtlix/simfinity-js` is the MongoDB/Mongoose facade; `@simtlix/simfinity-core` is the driver-free runtime; `@simtlix/simfinity-postgres` is the PostgreSQL 15+ facade; `@simtlix/simfinity-mcp` is the optional database-independent MCP integration. All generate a GraphQL API from `GraphQLObjectType` definitions.
- **Runtime**: Node.js `>=18.18.0`.
- **Peers**: every package uses `graphql` ^16. The Mongo facade alone has a `mongoose` ^8 peer; MCP has an optional `@modelcontextprotocol/sdk` peer. PostgreSQL depends on `pg` and core, without MongoDB, Mongoose, or MCP.

## Authoritative rules (read these)

| Topic | Rule file |
| --- | --- |
| Architecture, core flow, global state | `.cursor/rules/simfinity-architecture.mdc` |
| Coding style, imports, errors, schema transforms | `.cursor/rules/simfinity-coding-standards.mdc` |
| Internal APIs / functions | `.cursor/rules/simfinity-core-functions.mdc` |
| Auth plugin, rules, expressions | `.cursor/rules/simfinity-auth-module.mdc` |
| Field extensions / introspection | `.cursor/rules/simfinity-extensions.mdc` |
| Tests | `.cursor/rules/simfinity-testing.mdc` |
| README / docs updates | `.cursor/rules/simfinity-documentation.mdc` |

If something is ambiguous, prefer the matching `.mdc` file over this summary.

## Non-negotiables

1. **Do not** use `graphql-middleware`’s `applyMiddleware` or `@graphql-tools/utils` `mapSchema` on a Simfinity schema — they rebuild the schema and duplicate globally injected introspection types. Use **Envelop** plugins and in-place resolver wrapping instead (see architecture rule).
2. **Imports**: top of file only; ES modules; match existing style (single quotes, semicolons, trailing commas in multiline constructs).
3. **Behavior changes**: update tests under `tests/` and public docs (`README.md`) when the public API or documented behavior changes.

## Verification commands

Run from the repo root after substantive edits:

```bash
npm run lint
npm test
```

Use `npm run test:watch` while iterating; `npm run test:coverage` when coverage matters.

## Layout hints

- **Implementation**: `packages/core/src/` owns the shared runtime and helpers; `src/` owns the MongoDB facade/adapter and compatibility shims; `packages/postgres/src/` owns PostgreSQL storage and execution; `packages/mcp/src/` owns MCP generation and transports.
- **Tests**: `tests/*.test.js` — mirror modules; see `.cursor/rules/simfinity-testing.mdc` for `simfinity.preventCreatingCollection(true)` in `beforeAll`.

## When editing

- Keep changes scoped to the task; avoid drive-by refactors.
- Extend existing patterns rather than introducing parallel abstractions.
- For GraphQL types in examples/tests: use `extensions.relation` on relationship fields; use `extensions.readOnly` where appropriate.
