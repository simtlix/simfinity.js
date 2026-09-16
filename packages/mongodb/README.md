# @simtlix/simfinity-js

MongoDB/Mongoose adapter and compatibility facade for Simfinity. This package generates GraphQL queries, mutations, relationships and models from `GraphQLObjectType` definitions using the shared Simfinity runtime.

```sh
npm install @simtlix/simfinity-js graphql@^16.11.0 mongoose@^8.16.2
```

```javascript
import mongoose from 'mongoose';
import * as simfinity from '@simtlix/simfinity-js';

await mongoose.connect(process.env.MONGODB_URI);
// Register your GraphQLObjectType definitions before creating the schema.
simfinity.connect(null, SerieType, 'serie', 'series');
const schema = simfinity.createSchema();
```

Use a MongoDB replica set or sharded cluster for transactional mutations. The library requires Node.js >=18.18.0 and GraphQL 16.

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

- [MongoDB quick start](https://simtlix.github.io/simfinity.js/guide/getting-started.html)
- [API reference](https://simtlix.github.io/simfinity.js/reference/api.html)
- [Database comparison](https://simtlix.github.io/simfinity.js/guide/databases.html)
- [MCP integration](https://simtlix.github.io/simfinity.js/guide/mcp.html)
- [Complete library documentation](https://github.com/simtlix/simfinity.js#readme)
- [Aggregation examples](./AGGREGATION_EXAMPLE.md)
