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

The source now lives in `packages/mongodb` in the monorepo. Its public npm name remains `@simtlix/simfinity-js`; existing imports, including paths under `@simtlix/simfinity-js/src/`, retain their layout. Shared helpers, error identities and MCP compatibility exports are preserved. Internal Simfinity dependencies use the same exact release version.

- [MongoDB quick start](https://simtlix.github.io/simfinity.js/guide/getting-started.html)
- [API reference](https://simtlix.github.io/simfinity.js/reference/api.html)
- [Database comparison](https://simtlix.github.io/simfinity.js/guide/databases.html)
- [MCP integration](https://simtlix.github.io/simfinity.js/guide/mcp.html)
- [Complete library documentation](https://github.com/simtlix/simfinity.js#readme)
- [Aggregation examples](./AGGREGATION_EXAMPLE.md)
