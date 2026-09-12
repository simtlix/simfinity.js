---
title: MongoDB quick start
description: Build and run a complete Simfinity API with GraphQL Yoga, Mongoose, and a MongoDB replica set.
---

# MongoDB quick start

Build a small series catalog with a working GraphQL endpoint. By the end, you will be able to create, query, update, and delete a serie, then call the same catalog through an MCP tool.

This page is the MongoDB starter. For UUID identities, generated PostgreSQL tables, and real foreign keys, follow the [PostgreSQL quick start](./postgresql).


## Download the starter

[Download the 3.2.0 preview kit](/preview/simfinity-3.2.0-preview.zip) and extract it. The `mongodb` starter contains the files shown below. Keep the adjacent `packages` directory, which supplies the verified Simfinity archives. See [package availability and checksums](./databases#download-the-preview).

For the published MongoDB release, the [original 3.0.1 starter](/simfinity-series-starter.zip) remains available; its schema and server support this page's operations. The rest of this site documents 3.2.0 preview, which is not yet on npm.

| Before you begin | You will build |
| --- | --- |
| Node.js 22+, npm, and a transaction-capable MongoDB deployment | A GraphQL endpoint at `http://localhost:4000/graphql` |
| Docker for the local database recipe, or an existing replica set | A series catalog with embedded seasons and a generated MCP read tool |

<DomainDiagram kind="schema" />

## 1. Create the project

Use a supported Node.js LTS release and npm. The library itself requires Node.js `>=18.18.0`.

```sh
cd simfinity-3.2.0-preview/mongodb
npm install
```

The included `package.json` installs Simfinity core, MongoDB facade and MCP compatibility package from the local archives. GraphQL and Mongoose are peer dependencies. This guide uses Yoga as the HTTP server; Simfinity generates the schema supplied to it. Then configure MongoDB below and run `npm start`.

## 2. Start MongoDB

You need a MongoDB deployment that supports transactions. A standalone MongoDB server can accept connections and serve reads, but it cannot execute Simfinity's transactional mutations. Use a replica set or a sharded cluster, as described in the [MongoDB transaction requirements](https://www.mongodb.com/docs/manual/core/transactions-production-consideration/).

For local development with Docker, start a single-node replica set:

```sh
docker run --name simfinity-mongo -p 127.0.0.1:27017:27017 -d mongo:8 --replSet rs0 --bind_ip_all
```

After MongoDB has started, initialize the replica set once:

```sh
docker exec simfinity-mongo mongosh --quiet --eval "rs.initiate({_id: 'rs0', members: [{_id: 0, host: 'localhost:27017'}]})"
```

Check that the node is writable before starting the API. Election can take a few seconds; run this again until it prints `true`:

```sh
docker exec simfinity-mongo mongosh --quiet --eval "db.hello().isWritablePrimary"
```

The application below defaults to this local deployment. To use an existing database, set `MONGODB_URI` to its connection string before starting the server.

::: info Local development configuration
This Docker example binds MongoDB to your machine's loopback interface and does not configure database credentials. Configure authentication and network access for a deployed database. If port `27017` is already occupied, use an available host port and update the application's connection string.
:::

## 3. Define the schema and server

Keep database initialization and schema registration in `schema.js`. Both the HTTP server and MCP entry point import this same file. The embedded `Season` type adds a nested array inside each serie document.

```text
mongodb/
  package.json
  schema.js   # database + types + generated schema
  server.js   # GraphQL HTTP endpoint
  mcp.js      # generated tool example
```

::: code-group

<<< @/public/starter/schema.js

<<< @/public/starter/server.js

:::

Start the application:

```sh
npm start
```

Open `http://localhost:4000/graphql`. Yoga provides GraphiQL, an editor with schema discovery and autocomplete. The server setup follows [Yoga's Node.js integration](https://the-guild.dev/graphql/yoga-server/docs).

## 4. Create your first record

Paste this operation into GraphiQL and run it:

```graphql
mutation CreateSerie {
  addserie(input: {
    name: "The Expanse"
    year: 2015
    category: "Science fiction"
    seasons: [{ number: 1 }, { number: 2 }]
  }) {
    id
    name
    year
    category
    seasons { number }
  }
}
```

Example response; MongoDB generates a different ID for your record:

```json
{
  "data": {
    "addserie": {
      "id": "507f1f77bcf86cd799439011",
      "name": "The Expanse",
      "year": 2015,
      "category": "Science fiction",
      "seasons": [{ "number": 1 }, { "number": 2 }]
    }
  }
}
```

Keep the returned `id` for the update and delete examples.

::: tip Endpoint names are explicit
`connect(null, SerieType, 'serie', 'series')` generates `addserie`, `updateserie`, and `deleteserie`. The GraphQL operation name `CreateSerie` is your own label and can use any naming convention.
:::

## 5. Query the catalog

```graphql
query BrowseSeries {
  series(
    category: { operator: EQ, value: "Science fiction" }
    pagination: { page: 1, size: 10, count: true }
    sort: { terms: [{ field: "name", order: ASC }] }
  ) {
    id
    name
    year
  }
}
```

The list is returned directly under `data.series`. With the count plugin enabled, a nonzero total matching count is added as `extensions.count`. See [pagination and counts](./queries#pagination-and-total-count) for current count behavior.

## 6. Update and delete

Use the ID returned by `CreateSerie` as the `$id` variable. Run the update before the delete:

::: code-group

```graphql [Update]
mutation UpdateSerie($id: ID!) {
  updateserie(input: { id: $id, category: "Sci-fi" }) {
    id
    name
    category
  }
}
```

```graphql [Delete]
mutation DeleteSerie($id: ID!) {
  deleteserie(id: $id) {
    id
    name
  }
}
```

```json [Variables]
{
  "id": "REPLACE_WITH_THE_CREATED_ID"
}
```

:::

Update inputs include `id` and the fields you want to change. Deleting returns the deleted record, so you can request its fields in the response.

## 7. Call the same API through MCP

Create `mcp.js` alongside the other files, or use the file in the download:

<<< @/public/starter/mcp.js

Run `node mcp.js` after creating the record. If you ran the delete example, create it again to include it in the tool response. It prints the generated `series` tool name and its result, then closes its database connection. This calls the tool directly; follow [MCP integration](./mcp) to attach a protocol transport or configure permissions.

## Where to go next

- Add seasons using [relationships](./relationships).
- Define business rules with [validation](./validation) and [controllers](./controllers).
- Add [authorization](./authorization) before exposing protected data.
- Explore the complete [Series Sample Project](https://github.com/simtlix/series-sample).

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `Transaction numbers are only allowed on a replica set member or mongos` | Initialize a replica set and use its URI. A standalone server is insufficient for mutations. |
| Database connection fails | Check that MongoDB is running, the URI is correct, and the replica set has a writable primary. |
| `Cannot query field "addSerie"` | Use the exact generated name: `addserie`. |
| Required input is missing | Supply `name` when creating and `id` when updating. GraphiQL shows the generated input types. |
| A rejected value produces `Unexpected error.` | Yoga masks Simfinity validation errors by default. See [error handling](../reference/errors) to expose selected application errors. |
| `EADDRINUSE` on port `4000` | Change the port passed to `server.listen()` and open that port in your browser. |
