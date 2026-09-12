# Task 2 report: shared helpers and optional MCP

## Status

Complete. Implementation commit: `2d15bd4` (`Extract shared helpers and optional MCP package`).

## Delivered

- Moved the canonical auth, validator, scalar, and plugin implementations into `@simtlix/simfinity-core`; root deep imports remain named/default re-export shims.
- Exported identical `auth`, `validators`, `scalars`, and `plugins` namespace objects from core, the MongoDB root facade, the PostgreSQL module facade, and `createPostgres` instances.
- Moved the existing MCP implementation unchanged, apart from its shared error import, into the database-independent `@simtlix/simfinity-mcp` workspace. The root facade retains its synchronous MCP API and optional SDK installation behavior.
- Added canonical core/MCP declarations and re-exported them from the root and PostgreSQL declarations. Mongo-specific controller/model/session declarations remain on the root facade.
- Extended packed archive tests for core, PostgreSQL, MCP without SDK, MCP with SDK, and MongoDB root consumers, including strict TypeScript compilation and forbidden dependency checks.
- Updated root/package READMEs and `.cursor` module paths. PostgreSQL documents the separate `@simtlix/simfinity-mcp` plus SDK opt-in.

## TDD evidence

Before implementation, `tests/shared-helpers.test.js` failed because `postgres.auth` was undefined. The PostgreSQL integration suite failed at the missing `postgres.scalars` export. After extraction, both suites passed.

The real PostgreSQL integration creates a disposable schema and verifies:

- unauthenticated generated mutations fail with `UNAUTHENTICATED` before controller execution;
- the shared scalar and declarative validator reject invalid authorized input;
- valid authorized input persists and runs the controller.

## Fresh verification

- `npm run lint` — exit 0.
- `npm test` — 30 files passed, 13 skipped; 605 tests passed, 156 skipped.
- `SIMFINITY_POSTGRES_URI=postgresql://postgres:simfinity@127.0.0.1:55438/simfinity_task1 npx vitest run tests/integration/postgres-shared-helpers.test.js` — 1 file and 3 tests passed.
- `npm run test:packages` — exit 0; core, PostgreSQL, MCP without SDK, MCP with SDK, and MongoDB root archives passed runtime and strict TypeScript checks.
- Direct source comparison confirmed `packages/mcp/src/index.js` matches the reviewed upstream MCP implementation except for importing `SimfinityError` from core.

## Concerns and decisions

- Core cannot import Mongoose. `isOwner` therefore recognizes real BSON ObjectIds through their `_bsontype === 'ObjectId'` marker and `toHexString()` method. Existing auth safety tests with actual Mongoose ObjectIds pass, while arbitrary object identities remain denied.
- The MCP SDK stays behind the existing asynchronous dynamic import boundary. Tool generation/execution remains synchronous to construct and works with GraphQL alone; transport construction reports `MCP_SDK_NOT_INSTALLED` without the opt-in SDK.
- The coordinating agent's plan checkbox edit and the user's root tarballs were excluded from the implementation commit.
