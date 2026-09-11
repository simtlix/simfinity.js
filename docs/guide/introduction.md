---
title: Introduction
description: Understand how Simfinity turns GraphQL types into a MongoDB-backed API, and where to extend it.
---

# Introduction

Simfinity turns JavaScript `GraphQLObjectType` definitions into a GraphQL API backed by MongoDB. Define your domain once, register your types, and generate queries, mutations, input types, Mongoose models, and relationship resolvers.

You keep the GraphQL schema as the center of your application. Validation, lifecycle hooks, authorization, and state transitions provide places to add the behavior that makes your API specific to your product.

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
4. **Serve GraphQL.** Pass the resulting schema directly to a GraphQL server such as Yoga.
5. **Add application behavior.** Attach validators, controllers, access policies, and state machines as the domain grows.

Simfinity uses Mongoose for persistence. Generated mutations run inside MongoDB transactions, including changes to related collections. Your application provides the database connection, HTTP server, authentication mechanism, and deployment environment.

## Choose your next step

| You want to… | Start here |
| --- | --- |
| Run a working API | [Getting started](./getting-started) |
| Design your domain model | [Schema definition](./schema) and [relationships](./relationships) |
| Build a list or detail screen | [Queries](./queries) |
| Write records and enforce rules | [Mutations](./mutations) and [validation](./validation) |
| Protect data | [Authorization](./authorization) and [query scope](./query-scope) |
| Expose your API to AI tools | [MCP integration](./mcp) |
| Look up a function | [Core API reference](../reference/api) |

## Requirements

The library supports Node.js `>=18.18.0` and uses GraphQL 16 and Mongoose 8 as peer dependencies. For a new application, use a supported Node.js LTS release. MongoDB must support transactions: use a replica set or a sharded cluster.

This documentation uses ES modules and a consistent `Serie` / `Season` domain. The [Series Sample Project](https://github.com/simtlix/series-sample) provides a larger application to explore alongside the guides.

::: tip Bring your existing GraphQL knowledge
The generated result is a `GraphQLSchema`. You can inspect it in GraphiQL, use standard GraphQL clients, add custom resolvers, and integrate Envelop plugins. See [middleware](./middleware) for the supported extension points.
:::
