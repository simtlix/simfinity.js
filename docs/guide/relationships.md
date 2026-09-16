---
title: Relationships
description: Model embedded objects and referenced collections, then create and query related records with Simfinity.
---

# Relationships

Use `extensions.relation` on fields whose value is another GraphQL object or a list of objects. This metadata tells Simfinity how to store the relationship, generate inputs, and resolve related records.

<DomainDiagram kind="relationships" />

Examples use the selected runtime from [database setup](./databases#runtime-setup-for-shared-examples). After `createSchema()`, PostgreSQL also requires awaited storage initialization before operations are served.

## Choose a storage model

| Relationship | Storage | Mutation input |
| --- | --- | --- |
| Embedded object | MongoDB nested document; PostgreSQL JSONB or a private owned table | The object's fields |
| Embedded list | MongoDB nested array; PostgreSQL JSONB or ordered private rows | An array of nested inputs |
| Referenced object | ObjectId or UUID reference in the source record | `{ id: "..." }` |
| Referenced collection | Child records with a parent reference/FK | `{ added, updated, deleted }` |

An embedded object belongs to its parent record. A referenced type can have its own storage model, endpoints, and lifecycle.

## Embedded objects

A director profile can be stored directly in a serie. Register the supporting type without endpoints:

```javascript
import {
  GraphQLID,
  GraphQLObjectType,
  GraphQLString,
} from 'graphql';
import { simfinity } from './runtime.js';

const DirectorType = new GraphQLObjectType({
  name: 'Director',
  fields: {
    name: { type: GraphQLString },
    country: { type: GraphQLString },
  },
});

const SerieType = new GraphQLObjectType({
  name: 'Serie',
  fields: {
    id: { type: GraphQLID },
    name: { type: GraphQLString },
    director: {
      type: DirectorType,
      extensions: { relation: { embedded: true } },
    },
  },
});

simfinity.addNoEndpointType(DirectorType);
simfinity.connect(null, SerieType, 'serie', 'series');
const schema = simfinity.createSchema();
```

Create the serie and its director together:

```graphql
mutation {
  addserie(input: {
    name: "Northern Lights"
    director: { name: "Alex Rivera", country: "Argentina" }
  }) {
    id
    name
    director { name country }
  }
}
```

For an embedded list, use `new GraphQLList(DirectorType)` with the same `embedded: true` metadata and supply an array of objects. Updating an embedded object merges its supplied fields with the stored object. Supplying an embedded array replaces that array.

Both outer and item `GraphQLNonNull` wrappers are supported. An embedded `[Director!]!` field generates a required create list of non-null nested inputs, and an optional update list whose items are still non-null. Nullable embedded list items are stored as `null`. An empty list replaces the stored list with `[]`.

## Referenced objects and collections

In this complete schema, each `Season` stores a reference to its `Serie`. The serie's `seasons` field reads back the matching child records:

```javascript
import {
  GraphQLID,
  GraphQLInt,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from 'graphql';
import { simfinity } from './runtime.js';

const SerieType = new GraphQLObjectType({
  name: 'Serie',
  fields: () => ({
    id: { type: GraphQLID },
    name: { type: new GraphQLNonNull(GraphQLString) },
    seasons: {
      type: new GraphQLList(SeasonType),
      extensions: {
        relation: {
          embedded: false,
          connectionField: 'serie',
        },
      },
    },
  }),
});

const SeasonType = new GraphQLObjectType({
  name: 'Season',
  fields: () => ({
    id: { type: GraphQLID },
    number: { type: new GraphQLNonNull(GraphQLInt) },
    year: { type: GraphQLInt },
    serie: {
      type: new GraphQLNonNull(SerieType),
      extensions: {
        relation: {
          embedded: false,
          connectionField: 'serie',
          displayField: 'name',
        },
      },
    },
  }),
});

simfinity.connect(null, SerieType, 'serie', 'series');
simfinity.connect(null, SeasonType, 'season', 'seasons');
const schema = simfinity.createSchema();
```

The `fields: () => ({ ... })` functions defer access to the types, allowing both sides of the relationship to reference each other.

`connectionField` has two related roles: on `Season.serie`, it is the ObjectId or UUID storage field in a season; on `Serie.seasons`, it identifies the child's back-reference. Use the matching field name on both sides, as in this example, so nested creation and collection queries share the same link.

::: tip Configure the stored link
For a single-object reference, omitting `connectionField` uses the GraphQL field name consistently for model generation, creation, updates, clearing, and resolution. Set it when storage uses a different field name. For referenced collections, specify the child's back-reference explicitly. `displayField` is a descriptive UI hint, not a uniqueness rule or a persistence field.
:::

## Create children with their parent

The `added` input for a referenced collection omits its parent connection field. Simfinity fills in the newly created parent's ID:

Required collection fields retain a required operation object on create and become optional on update. If the collection has non-null object items, its `added` and `updated` lists also require non-null items. Nullable operation items are ignored; use `deleted` with child IDs to remove records.

```graphql
mutation {
  addserie(input: {
    name: "Northern Lights"
    seasons: {
      added: [
        { number: 1, year: 2024 }
        { number: 2, year: 2025 }
      ]
    }
  }) {
    id
    seasons { id number year }
  }
}
```

To create a season for an existing serie, pass an ID reference instead:

```graphql
mutation AddSeason($serieId: String!) {
  addseason(input: {
    number: 3
    year: 2026
    serie: { id: $serieId }
  }) {
    id
    serie { id name }
  }
}
```

The generated reference wrapper is `IdInputType`, whose `id` field is `String!`. Root entity IDs and update IDs use the GraphQL `ID` scalar; use the variable type required by the position you are filling.

## Query related records

```graphql
query {
  series {
    id
    name
    seasons(
      year: { operator: GTE, value: 2025 }
      sort: { terms: [{ field: "number", order: ASC }] }
      pagination: { page: 1, size: 10 }
    ) {
      id
      number
      year
    }
  }
}
```

Referenced collections receive scalar filters, relationship filters, logical groups, sorting, and pagination. Filtering inside `seasons(...)` changes the returned children; it does not exclude the parent serie. To filter the parent by its children, put a relationship filter on the root `series` query, as shown in [queries](./queries#filter-through-a-relationship).

Generated referenced-object resolvers run the target type's `get_by_id` middleware and [query scope](./query-scope); generated collection resolvers run its `find` middleware and scope. They await callbacks and pass the request context. The original referenced ID or parent connection remains required even when middleware or scope changes filters. Scoped-out single records return `null`, and scoped-out children are omitted before pagination.

## Update a collection

```graphql
mutation EditSeasons($serieId: ID!, $seasonId: ID!, $removedId: ID!) {
  updateserie(input: {
    id: $serieId
    seasons: {
      added: [{ number: 4, year: 2027 }]
      updated: [{ id: $seasonId, year: 2026 }]
      deleted: [$removedId]
    }
  }) {
    id
    seasons { id number year }
  }
}
```

`added` creates records, `updated` changes records by ID, and `deleted` deletes child records. These changes share the parent mutation's transaction. Each child runs global middleware for the target type with the same request context and root argument shape: `save` and `update` receive `{ input }`; `delete` receives `{ id }`.

After middleware, updated and deleted children are read in the transaction and must already belong to the current parent. A missing child raises `NOT_VALID_ID` (404); a child owned by another parent raises `FORBIDDEN` (403). Nested updates do not reparent foreign children. The required parent link is retained after child pre-write hooks, including ordinary field assignments and `$set`/`$unset` updates. A rejection aborts all changes in the parent mutation.

Parent ownership does not replace application permissions. Use child operation middleware or [controller checks](./controllers) to authorize writes; query scope is a read restriction. Root mutation permissions in the [authorization plugin](./authorization) do not automatically authorize nested child mutation inputs.

Deleting a parent does not automatically cascade through referenced collections. Implement the required deletion policy in your application. Existing field resolvers are preserved; Simfinity only generates a relation resolver when the field has none.

PostgreSQL creates real `NO ACTION` foreign keys for single references, child-backed inverse collections, explicit link entities, and references inside private owned embedded tables. Only the private owner-to-embedded link cascades. See [PostgreSQL relationship foreign keys](./postgresql#relationship-foreign-keys) for the physical mapping and unsupported shapes.

MongoDB defaults to allowing a well-formed but nonexistent referenced ID, which resolves to `null` on reads. To reject missing references and restrict target deletion, create the Mongo adapter with `referentialIntegrity: 'transactional'` and await `adapter.initialize()` before serving. This covers embedded reference paths and inverse/link-entity keys, with coordinated locks and full mutation rollback. Read [MongoDB reference integrity](./mongodb-integrity) for supplied sessions, startup auditing and the boundary around native writes. PostgreSQL continues to enforce its FKs directly in the database.
