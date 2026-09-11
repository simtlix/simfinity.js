# Simfinity series starter

Requirements: Node.js 22 or newer, npm, and a MongoDB replica set or sharded cluster. The starter binds its HTTP server to localhost and does not configure application authentication.

1. Run `npm install`.
2. Start a local database with Docker:

```sh
docker run --name simfinity-mongo -p 127.0.0.1:27017:27017 -d mongo:8 --replSet rs0 --bind_ip_all
docker exec simfinity-mongo mongosh --quiet --eval "rs.initiate({_id: 'rs0', members: [{_id: 0, host: 'localhost:27017'}]})"
docker exec simfinity-mongo mongosh --quiet --eval "db.hello().isWritablePrimary"
```

Wait for MongoDB to start before initialization. Repeat the last command until it prints `true`. If you already have a transaction-capable database, set `MONGODB_URI` to its connection string instead.

3. Run `npm start` and open http://localhost:4000/graphql.
4. Create a record:

```graphql
mutation {
  addserie(input: {
    name: "The Expanse"
    year: 2015
    category: "Science fiction"
    seasons: [{ number: 1 }, { number: 2 }]
  }) { id name seasons { number } }
}
```

5. Query it:

```graphql
query {
  series(name: { operator: LIKE, value: "Expanse" }) {
    id name seasons { number }
  }
}
```

6. In another terminal, run `npm run mcp` to inspect and call the generated `series` tool. This reuses `schema.js` and the same database; it does not start an MCP transport server.

Files: `schema.js` connects the database and builds the schema; `server.js` exposes GraphQL over HTTP; `mcp.js` calls the generated tool directly. Use `PORT` to change the HTTP port. The generated ID and any pre-existing database records affect your response.

Library and complete sample: https://github.com/simtlix/simfinity.js and https://github.com/simtlix/series-sample.
