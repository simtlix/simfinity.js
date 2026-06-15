# Agent guidance for `@simtlix/simfinity-js`

This file helps coding agents (and humans) work productively and safely in this repository. It complements—not replaces—the detailed rules under `.cursor/rules/`.

## What this project is

- **Package**: `@simtlix/simfinity-js` — GraphQL schema/model generation from `GraphQLObjectType`, MongoDB via Mongoose, Vitest for tests, ESLint 9 (flat config), ES modules (`"type": "module"`).
- **Runtime**: Node.js `>=18.18.0`.
- **Peers**: `graphql` ^16, `mongoose` ^8.

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

- **Implementation**: `src/` (`index.js` is the main engine; `src/mcp.js` generates MCP tools/servers from the GraphQL schema; `src/auth/`, `src/errors/`, `src/const/`, etc.).
- **Tests**: `tests/*.test.js` — mirror modules; see `.cursor/rules/simfinity-testing.mdc` for `simfinity.preventCreatingCollection(true)` in `beforeAll`.

## When editing

- Keep changes scoped to the task; avoid drive-by refactors.
- Extend existing patterns rather than introducing parallel abstractions.
- For GraphQL types in examples/tests: use `extensions.relation` on relationship fields; use `extensions.readOnly` where appropriate.
