---
title: Introduction
description: Understand how Simfinity turns GraphQL types into a MongoDB- or PostgreSQL-backed API, and where to extend it.
---

# Introduction

Simfinity turns JavaScript `GraphQLObjectType` definitions into a GraphQL API backed by MongoDB or PostgreSQL. Define your domain once, register your types, and generate queries, mutations, input types, storage models, and relationship resolvers.

You keep the GraphQL schema as the center of your application. Validation, lifecycle hooks, authorization, and state transitions provide places to add the behavior that makes your API specific to your product.

::: tip Choose your database
Start with [MongoDB](./getting-started) or [PostgreSQL](./postgresql). These guides cover the 3.2.0 preview; [download the packages and compare storage semantics](./databases). Shared examples use `simfinity` for the selected runtime: the MongoDB namespace or the instance returned by `createPostgres()`.
:::

## From a type to an API

```javascript
import { GraphQLID, GraphQLObjectType, GraphQLString } from 'graphql';
import * as simfinity from '@simtlix/simfinity-js';

const SerieType = new GraphQLObjectType({
  name: 'Serie',
  fields: {
    id: { type: GraphQLID },
    name: { type: GraphQLString },
  },
});

simfinity.connect(null, SerieType, 'serie', 'series');
const schema = simfinity.createSchema();
```

The registration generates these root fields:

| Operation | Generated field | Purpose |
| --- | --- | --- |
| Query | `serie(id: ID)` | Retrieve one serie |
| Query | `series(...)` | Filter, sort, and paginate series |
| Query | `series_aggregate(...)` | Group records and calculate facts |
| Mutation | `addserie(input: SerieInput!)` | Create a serie |
| Mutation | `updateserie(input: SerieInputForUpdate!)` | Update a serie |
| Mutation | `deleteserie(id: ID!)` | Delete a serie |

Names come from the singular and plural strings passed to `connect()`. `Serie` is the GraphQL type name; `serie` is the endpoint name. Simfinity does not capitalize mutation names or infer a plural for you.

## How the pieces fit together

1. **Define the domain.** Use GraphQL scalars, enums, object types, and relation metadata to describe your records.
2. **Register types.** Call `connect()` for types with endpoints, or `addNoEndpointType()` for supporting types.
3. **Build the schema.** Call `createSchema()` after registration. Simfinity prepares the models, inputs, and resolvers.
4. **Initialize storage.** MongoDB uses the connected Mongoose deployment. PostgreSQL applications await `initializeDatabase()` in create or validation mode.
5. **Serve GraphQL.** Pass the resulting schema directly to a GraphQL server such as Yoga.
6. **Add application behavior.** Attach validators, controllers, access policies, and state machines as the domain grows.

Choose one database facade during application startup. `@simtlix/simfinity-js` uses Mongoose and MongoDB transactions. `@simtlix/simfinity-postgres` uses PostgreSQL tables, UUIDs, real constraints, and repeatable-read transactions. Your application provides the database connection, HTTP server, authentication mechanism, and deployment environment.

## Choose your next step

| You want to… | Start here |
| --- | --- |
| Run a working API | [Getting started](./getting-started) |
| Start with PostgreSQL | [PostgreSQL quick start](./postgresql) |
| Design your domain model | [Schema definition](./schema) and [relationships](./relationships) |
| Build a list or detail screen | [Queries](./queries) |
| Write records and enforce rules | [Mutations](./mutations) and [validation](./validation) |
| Protect data | [Authorization](./authorization) and [query scope](./query-scope) |
| Expose your API to AI tools | [MCP integration](./mcp) |
| Look up a function | [Core API reference](../reference/api) |

## Requirements

All packages support Node.js `>=18.18.0` and GraphQL 16. The MongoDB facade uses Mongoose 8 and requires a replica set or sharded cluster for transactions. PostgreSQL support requires PostgreSQL 15 or later. For a new application, use a maintained Node.js release.

This documentation uses ES modules and a consistent `Serie` / `Season` domain. The [Series Sample Project](https://github.com/simtlix/series-sample) provides a larger application to explore alongside the guides.

::: tip Bring your existing GraphQL knowledge
The generated result is a `GraphQLSchema`. You can inspect it in GraphiQL, use standard GraphQL clients, add custom resolvers, and integrate Envelop plugins. See [middleware](./middleware) for the supported extension points.
:::
