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

Omitting an optional embedded object whose type, or an embedded type inside it, has a list member stores it with empty lists on both backends. When the type also has a required member that is not a list, PostgreSQL rejects the create with `REQUIRED_VALUE`. MongoDB stores the object, and reads it as `null` unless that member is `id`, `readOnly`, an interface or union member or one with your own resolver; see [MongoDB embedded objects in hydrated documents](./mutations#update-selected-fields).

Embedded types cannot contain themselves, directly or through other embedded types (`A.b: B` and `B.a: A`), as objects or lists. `createSchema()` fails with `INVALID_MODEL` (`Embedded cycle at …`), even when a field of the cycle is `readOnly`, on PostgreSQL, with MongoDB's `referentialIntegrity: 'transactional'`, and in default MongoDB mode when Simfinity generates a model whose embedded fields reach the cycle, including the model of an embedded type registered with `addNoEndpointType()`. In default MongoDB mode, a cycle that only supplied models reach is not checked: it fails with `INPUT_TYPE_UNRESOLVED`, or works when a field of the cycle is `readOnly`. Use a reference or a referenced collection for recursive structures.

An embedded type without writable fields, such as one whose fields are all `readOnly`, has no generated input, so generated mutations cannot set the fields that embed it; see [what gets generated](./schema#what-gets-generated).

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

The `fields: () => ({ ... })` functions defer access to the types, allowing both sides of the relationship to reference each other. Writable collections can also form cycles across types, such as `Department.employees` and `Employee.managedDepartments`; nested inputs follow them at any depth. See [generated collection input names](#generated-collection-input-names).

`connectionField` has two related roles: on `Season.serie`, it is the ObjectId or UUID storage field in a season; on `Serie.seasons`, it identifies the child's back-reference. Use the matching field name on both sides, as in this example, so nested creation and collection queries share the same link.

::: tip Configure the stored link
For a single-object reference, omitting `connectionField` uses the GraphQL field name consistently for model generation, creation, updates, clearing, and resolution. Set it when storage uses a different field name. For referenced collections, `connectionField` is required: `createSchema()` rejects a collection without it with `INVALID_MODEL` (400), except, in default MongoDB mode and with custom adapters, one with its own resolver or marked `readOnly`; see [relation](../reference/extensions#relation). When the child type declares no field for the back-reference, the link is stored privately, in an ObjectId field of the generated MongoDB model or a foreign-key column on PostgreSQL. This includes self-referencing collections, such as `Category.children`, and chained collections that reuse one name. `displayField` is a descriptive UI hint, not a uniqueness rule or a persistence field.
:::

## Create children with their parent

The `added` input for a referenced collection omits its parent connection field. Simfinity fills in the newly created parent's ID:

Required collection fields retain a required operation object on create and become optional on update. When the collection has no `added` operation, because the child has no writable field besides the back-reference, send an empty operation object, such as `seasons: {}`, on create. If the collection has non-null object items, its `added` and `updated` lists also require non-null items. `deleted` is `[ID]` whatever the item nullability. Nullable operation items and null IDs are ignored; use `deleted` with child IDs to remove records.

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

The generated reference wrapper is `IdInputType`, whose `id` field is `String!`. Root entity IDs and update IDs use the GraphQL `ID` scalar; use the variable type required by the position you are filling. A malformed `id`, such as one that is not an ObjectId on MongoDB, fails with `NOT_VALID_ID` (400) and nothing is stored.

## Generated collection input names

Each writable referenced collection gets one operation input in the type's creation input and one in its update input. For `Serie.seasons`, linked through `serie`:

| Part | In `SerieInput` | In `SerieInputForUpdate` |
| --- | --- | --- |
| Operation input | `OneToManySerieAseasons` | `OneToManySerieUseasons` |
| `added` items | `SerieASeasonInputForSerie` | `SerieUSeasonInputForSerie` |
| `updated` items | `SeasonInputForUpdate` | `SeasonInputForUpdate` |
| `deleted` | `[ID]` | `[ID]` |

In general the operation inputs are `OneToMany<Type>A<field>` and `OneToMany<Type>U<field>`. An `added` item, `<Type>A<Item>InputFor<ConnectionField>` or `<Type>U<Item>InputFor<ConnectionField>`, is the item's creation input without the back-reference, which the parent supplies. `deleted` is `[ID]` whatever the item nullability, and null IDs are ignored. A collection without `connectionField`, which builds only with its own resolver or as `readOnly` in default MongoDB mode and with custom adapters, uses the item's `<Item>Input` for `added` items.

An operation input has no `added` field when the child has no writable field besides the back-reference, such as a child with only `id`, the back-reference and `readOnly` fields, and no `updated` field when the child's update input would be empty, because it has no writable fields and no writable `id`. Each omission logs a `Configuration issue` warning; `deleted` always remains. Create such children with their own add mutation or a registered mutation.

Collections that reach the same child through the same `connectionField`, such as `Serie.episodes` and `Serie.featured`, share one `added` item input. They also read the same children: both fields return every episode linked to the serie, unless one of them has its own resolver.

Nested inputs follow trees and cycles of collections at any depth, such as `Department.employees` and `Employee.managedDepartments`, where an employee added to a department can add the departments it manages. To cap how many entries one mutation may carry, set `configureMutationLimits({ maxNestedOperations })`; see [limit nested collection operations](./mutations#limit-nested-collection-operations).

### Self-referencing collections

A collection whose items are its own type, such as `Category.children` linked through `parent`, is named without the type: `OneToManyAchildren` and `OneToManyUchildren`. Its `added` items are `ACategoryInputForParent` and `UCategoryInputForParent`.

Items that an add mutation creates (`A<Type>InputFor<ConnectionField>`) accept the item's own self-referencing collections as optional fields, even when the field is non-null, so one create can build a tree at any depth:

```graphql
mutation {
  addcategory(input: {
    name: "Books"
    children: {
      added: [
        { name: "Fiction", children: { added: [{ name: "Science fiction" }] } }
      ]
    }
  }) {
    id
    children { name children { name } }
  }
}
```

Items that an update adds (`U<Type>InputFor<ConnectionField>`) keep the declared requiredness: when the collection field is non-null, each of them needs its operation object, for example `children: {}`.

### Self-referencing collections with the same name

When several types have a self-referencing collection with the same name, such as `Category.children` and `Comment.children`, only one of the types that a schema reaches keeps `OneToManyA<field>` and `OneToManyU<field>`. A type is reached when it has generated mutations in that schema, or when a writable list or embedded field of a reached type leads to it. In the first `createSchema()`, the first registered reached type keeps the names. The other reached types are named after their type, `OneToMany<Type>A<field>` and `OneToMany<Type>U<field>`, as other collections are, and startup logs a warning that names both types:

```text
Configuration issue: Comment.children and Category.children are self-referencing collections with the same name, so the inputs of Comment.children are named OneToManyCommentAchildren and OneToManyCommentUchildren, while Category.children keeps OneToManyAchildren and OneToManyUchildren. To choose which type keeps those names, register it first, or make the other type unreachable from the generated mutations.
```

Types that no generated mutation reaches, such as one registered with `addNoEndpointType()` that no collection or embedded field leads to, keep the unqualified names, because their inputs never meet in one schema.

A type registered after a `createSchema()` call gets its inputs from the next `createSchema()`; PostgreSQL rejects such registrations with `SCHEMA_ALREADY_CREATED`. It is named after its type, with the warning, only when the next schema also reaches a type that has the unqualified names and that one is still the type object registered under its name. Otherwise it keeps the unqualified names, with no warning, and becomes one of the types that have them. For example:

- A type registered after a `createSchema()` call whose next schema does not reach the type that has the names, for example because of its mutation allowlist.
- A type that has the names and is registered again under the same name with a new type object, for example when an application reloads its types on one runtime: the earlier object no longer counts.

Core and MongoDB also allow re-registering the same self-referencing type object. Its next schema gets fresh collection inputs; previously built schemas retain their input types.

The names are decided when the types' inputs are first built, so a later change to the model can move them. Making an earlier-registered type reachable, by registering it with `connect()` instead of `addNoEndpointType()`, by adding a collection that leads to it, or by widening the mutation allowlist of the first `createSchema()`, gives it the unqualified names and renames the inputs of the type that had them. Clients that declare variables of those input types must then use the new names. Register the type that should keep the names first, or keep the other type unreachable.

Two cases still fail at startup with `Schema must contain uniquely named types but contains multiple types named "OneToManyAchildren"`:

- A second type with a same-named self-referencing collection that only a `registerMutation()` input reaches, for example through `getInputType(Comment)` in the input's `fields` function. Rename one of the fields, or make the type reachable from generated mutations, for example by registering it with `connect()`.
- A later `createSchema()` call that reaches two such types whose inputs earlier calls built with the unqualified names: after a first call with a narrower mutation allowlist, or after a type registered later was built by a call that did not reach the other. Build the widest schema first, register every type before it, or rename one of the fields.

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

Generated referenced-object resolvers run the target type's `get_by_id` middleware and [query scope](./query-scope); generated collection resolvers run its `find` middleware and scope. They await callbacks and pass the request context. The original referenced ID or parent connection remains required even when middleware or scope changes filters. Scoped-out single records return `null`, and scoped-out children are omitted before pagination. A generated single reference reads the related record whenever the stored value is not `null`, missing or an empty string, so numeric identifiers such as `0` from a custom SQL plugin or adapter resolve like any other ID.

Within a request, generated single-reference fields are batched: `get_by_id` middleware still runs once per field, the bundled MongoDB and PostgreSQL adapters read the referenced records of one type and nesting level in one batched read (split at `maxPageSize`), and fields that reference the same ID share the returned record. References to a type with a `get_by_id` scope, IDs that middleware changes or the adapter cannot cast (such as non-ObjectId MongoDB `_id` values), executions without a context object, and Mongoose models with any `find` or `findOne` pre/post query hook are read one ID at a time. Even a hook function shared by both operations may branch on `this.op` or the filter shape, so those models retain the original `findOne` behavior. Collection fields keep one read per parent, because each parent's filters and pagination apply separately.

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

`added` creates records, `updated` changes records by ID, and `deleted` deletes child records. These changes share the parent mutation's transaction. To cap the number of entries one mutation may carry across all nesting levels, set `configureMutationLimits({ maxNestedOperations })`; see [limit nested collection operations](./mutations#limit-nested-collection-operations). Each child runs global middleware for the target type with the same request context (for a programmatic `saveObject()` call, the `context` passed to it, possibly `undefined`) and root argument shape: `save` and `update` receive `{ input }`; `delete` receives `{ id }`.

After middleware, updated and deleted children are read in the transaction and must already belong to the current parent. Ownership compares the child's stored parent link with the parent's stored identifier. So any spelling of the parent ID that the backend accepts, such as an uppercase ObjectId or UUID, owns its children, and new or updated children are linked with the stored identifier. A malformed child ID raises `NOT_VALID_ID` (400), a missing child raises `NOT_VALID_ID` (404), and a child owned by another parent raises `ForbiddenError` (`FORBIDDEN`, 403). Nested updates do not reparent foreign children. The required parent link is retained after child pre-write hooks, including ordinary field assignments and `$set`/`$unset` updates. A rejection aborts all changes in the parent mutation.

Parent ownership does not replace application permissions. Use child operation middleware or [controller checks](./controllers) to authorize writes; query scope is a read restriction. Root mutation permissions in the [authorization plugin](./authorization) do not automatically authorize nested child mutation inputs.

Deleting a parent does not automatically cascade through referenced collections. Implement the required deletion policy in your application. Existing field resolvers are preserved; Simfinity only generates a relation resolver when the field has none.

PostgreSQL creates real `NO ACTION` foreign keys for single references, child-backed inverse collections, explicit link entities, and references inside private owned embedded tables. Only the private owner-to-embedded link cascades. See [PostgreSQL relationship foreign keys](./postgresql#relationship-foreign-keys) for the physical mapping and unsupported shapes.

MongoDB defaults to allowing a well-formed but nonexistent referenced ID, which resolves to `null` on reads. To reject missing references and restrict target deletion, create the Mongo adapter with `referentialIntegrity: 'transactional'` and await `adapter.initialize()` before serving. This covers embedded reference paths and inverse/link-entity keys, with coordinated locks and full mutation rollback. Read [MongoDB reference integrity](./mongodb-integrity) for supplied sessions, startup auditing and the boundary around native writes. PostgreSQL continues to enforce its FKs directly in the database.
