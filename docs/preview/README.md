# Simfinity 3.2.0 preview

This preview contains both database adapters. It is not an npm release. Choose
one starter for your application and keep the adjacent `packages/` directory.
Use Node.js 22 or newer. `npm install` fetches the third-party dependencies from
npm and installs Simfinity from the included archives.

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
creates the `series_api` schema, including the season-to-serie foreign key.
`SIMFINITY_SCHEMA_MODE=validate npm start` validates existing generated storage
without DDL. MCP is optional: install `../packages/simtlix-simfinity-mcp-3.2.0.tgz`
only when needed; protocol transports also need `@modelcontextprotocol/sdk`.

Full setup, GraphQL operations, storage rules and MCP integration:
https://simtlix.github.io/simfinity.js/guide/postgresql.html

## Package provenance

`packages/manifest.json` records the version, source commit, SHA-256 and npm
SHA-512 integrity of every included archive. These exact packages were verified
with the PostgreSQL library and Barber application. They have version `3.2.0`
inside their package metadata, but remain a preview until an npm release is made.
Keep all installed Simfinity packages at this same version.

The adapters share generated GraphQL operations, validation, authorization,
scopes, controllers and optional MCP. PostgreSQL uses UUID IDs, SQL constraints
and its own native Model/Session APIs. Choosing a backend is application setup;
this kit does not migrate data or switch a running application between engines.
