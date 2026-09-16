# Simfinity 3.3.0 starters

Choose one starter for your application. Use Node.js 22 or newer.
`npm install` installs Simfinity 3.3.0 and its dependencies from npm.

## MongoDB

From the extracted directory:

```sh
cd mongodb
npm install
export MONGODB_URI='mongodb://127.0.0.1:27017/series?replicaSet=rs0&directConnection=true'
npm start
```

MongoDB must be a replica set or sharded cluster for mutations. Open
http://127.0.0.1:4000/graphql. The example embeds seasons in each serie. Run
`npm run mcp` in another terminal to execute its generated read tool.

Full setup and GraphQL operations:
https://simtlix.github.io/simfinity.js/guide/getting-started.html

## PostgreSQL

From the extracted directory:

```sh
cd postgres
npm install
export DATABASE_URL='postgresql://postgres:simfinity@127.0.0.1:5432/series'
npm start
```

Use PostgreSQL 15, 16, or 18. Open http://127.0.0.1:4000/graphql. This starter
uses `createSQL` with `postgresPlugin` and creates the `series_api` schema, including the season-to-serie foreign key. The existing `createPostgres` facade remains available.
`SIMFINITY_SCHEMA_MODE=validate npm start` validates existing generated storage
without DDL. MCP is optional: install `@simtlix/simfinity-mcp@3.3.0`
only when needed; protocol transports also need `@modelcontextprotocol/sdk`.

Full setup, GraphQL operations, storage rules and MCP integration:
https://simtlix.github.io/simfinity.js/guide/postgresql.html

## Release

Source, release notes, package archives and integrity manifest:
https://github.com/simtlix/simfinity.js/releases/tag/v3.3.0

The adapters share generated GraphQL operations, validation, authorization,
scopes, controllers and optional MCP. PostgreSQL uses UUID IDs, SQL constraints
and its own native Model/Session APIs. Choosing a backend is application setup;
this kit does not migrate data or switch a running application between engines.
