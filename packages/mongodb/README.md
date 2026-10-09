# @simtlix/simfinity-js

MongoDB/Mongoose adapter and compatibility facade for Simfinity. This package generates GraphQL queries, mutations, relationships and models from `GraphQLObjectType` definitions using the shared Simfinity runtime.

```sh
npm install @simtlix/simfinity-js graphql@^16.11.0 mongoose@^8.24.2
```

`graphql` and `mongoose` are peer dependencies: the facade uses your application's copies, and npm reports an out-of-range version as a peer conflict instead of installing a second copy. The MCP transports (`createMCPServer`, `startStdioMCPServer`, `createHTTPMCPHandler`) need the optional peer `@modelcontextprotocol/sdk@^1.31.0`; install it only when you use them. `generateMCPTools` works without it. The package does not install `graphql-middleware`.

```javascript
import mongoose from 'mongoose';
import * as simfinity from '@simtlix/simfinity-js';

await mongoose.connect(process.env.MONGODB_URI);
// Register your GraphQLObjectType definitions before creating the schema.
simfinity.connect(null, SerieType, 'serie', 'series');
const schema = simfinity.createSchema();
```

Use a MongoDB replica set or sharded cluster for transactional mutations. The library requires Node.js >=18.18.0 and GraphQL 16.

Generated single-reference reads can be batched within a request. Models with any `find` or `findOne` pre/post query hook retain individual `findOne` reads, including hooks shared by both operations, to preserve access restrictions and other middleware behavior. See the [relationship contract](https://simtlix.github.io/simfinity.js/guide/relationships.html).

Generated models store enum internal values with their own type (numbers, booleans or strings; other combinations as given) and support embedded fields named `type`. Embedded types that contain each other are rejected with `INVALID_MODEL` (`Embedded cycle at …`) when a generated model reaches them, and always in transactional mode; in the default mode, a cycle that only supplied models reach is not checked. Range filters, sorts and aggregates on numeric and boolean enums follow that type; PostgreSQL uses their text form. Earlier versions stored numeric and boolean enum values as strings; convert existing documents once as described in the [schema guide](https://simtlix.github.io/simfinity.js/guide/schema.html#what-gets-generated).

The facade registers generated models on your application's default Mongoose instance and does not change global Mongoose options such as `strictQuery`. Supplied models may use another connection, such as one from `mongoose.createConnection()`: generated mutations and `saveObject()` use the model's connection, and, in the default `referentialIntegrity: 'off'` mode, custom mutations use the default connection unless it is unused, never opened and without compiled models, also on its `useDb()` descendants, and the registered models share one MongoDB client; with transactional reference integrity they use the first protected model's connection. `createMongoAdapter().castId` accepts only an ObjectId or its 24-character hexadecimal string and throws `NOT_VALID_ID` (400) otherwise; create new identifiers with `new mongoose.Types.ObjectId()`. Owned transactions retry transient failures after a short random delay, and a write conflict that outlasts the retries fails with `TRANSACTION_RETRY_EXCEEDED` (409).

Mongoose 8.24.2 or later within version 8 is required to exclude the update-casting prototype-pollution vulnerability. Existing applications should update Mongoose and their dependency lockfile, then run `npm audit`; upgrading Simfinity does not refresh every transitive dependency already locked by the application.

## Optional transactional reference integrity

Choose the mode once when creating an adapter; the default remains `'off'`:

```javascript
import { createMongoAdapter, createRuntime } from '@simtlix/simfinity-js';

const adapter = createMongoAdapter({ referentialIntegrity: 'transactional' });
const simfinity = createRuntime(adapter);
await mongoose.connect(process.env.MONGODB_URI);
// Register every application type on this runtime.
simfinity.connect(null, SerieType, 'serie', 'series');
const schema = simfinity.createSchema();
await adapter.initialize();
```

Initialization checks transaction support and audits existing references. Protected mutations reject nonexistent references, including embedded paths, inferred/private inverse keys and explicit link entities. Deleting a referenced target is restricted. Target-document writes coordinate concurrent creation/deletion; a violation rolls back the whole mutation with `REFERENCE_CONSTRAINT_VIOLATION` (409).

Owned transactions use snapshot reads and majority commits. Supplied sessions need the same options; a reference violation or guarded-write error aborts even a supplied transaction. The reserved `_simfinityReferenceLock` storage field is excluded from GraphQL. All writers must use the same complete registry and mode. Direct Mongoose/driver writes bypass this protection; this is not a native MongoDB FK. Read the [full setup, concurrency and migration contract](https://simtlix.github.io/simfinity.js/guide/mongodb-integrity.html).

The source now lives in `packages/mongodb` in the monorepo. Its public npm name remains `@simtlix/simfinity-js`; existing imports, including paths under `@simtlix/simfinity-js/src/`, retain their layout. Shared helpers, error identities and MCP compatibility exports are preserved. Internal Simfinity dependencies use the same exact release version.

Its legacy `src/` modules that re-export public API (`src/index.js`, `src/auth/index.js`, `src/auth/errors.js`, `src/auth/expressions.js`, `src/auth/rules.js`, `src/plugins.js`, `src/scalars.js`, `src/validators.js`, `src/mcp.js`, `src/const/*.js`, `src/errors/*.js`, and their extensionless aliases) ship TypeScript declarations with the types of the package root and the matching `@simtlix/simfinity-core` subpaths; `src/mongo/*` is internal and undeclared. New code should still import `auth`, `plugins`, `scalars` and `validators` from the package root. Importing the typed `@simtlix/simfinity-core` subpaths, such as `@simtlix/simfinity-core/auth`, instead needs `@simtlix/simfinity-core` as a direct dependency pinned to this package's exact version.

For tooling that locates the package, use `require.resolve('@simtlix/simfinity-js/package.json')` or the package root without a trailing slash. Directory specifiers ending in `/` were not valid ESM imports and are not supported by the export map, including in `require.resolve`; use explicit filenames such as `src/auth/index.js`.

- [MongoDB quick start](https://simtlix.github.io/simfinity.js/guide/getting-started.html)
- [API reference](https://simtlix.github.io/simfinity.js/reference/api.html)
- [Database comparison](https://simtlix.github.io/simfinity.js/guide/databases.html)
- [MCP integration](https://simtlix.github.io/simfinity.js/guide/mcp.html)
- [Complete library documentation](https://github.com/simtlix/simfinity.js#readme)
- [Aggregation examples](./AGGREGATION_EXAMPLE.md)
