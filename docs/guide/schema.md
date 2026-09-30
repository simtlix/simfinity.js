---
title: Schema definition
description: Define GraphQL object types, register models, configure field metadata, and build your Simfinity schema.
---

# Schema definition

A GraphQL object type is the starting point for both your API and generated storage. Simfinity reads its fields and extensions to create input types, queries, mutations, relationship resolvers, and either Mongoose models or PostgreSQL tables.

<DomainDiagram kind="schema" />

Examples use the selected runtime from [database setup](./databases#runtime-setup-for-shared-examples). After `createSchema()`, PostgreSQL also requires awaited storage initialization before operations are served.

## Define an entity

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
  description: 'A television serie available in the catalog.',
  fields: {
    id: { type: GraphQLID },
    name: {
      type: new GraphQLNonNull(GraphQLString),
      description: 'The name shown to viewers.',
    },
    year: { type: GraphQLInt },
    tags: { type: new GraphQLList(GraphQLString) },
    createdAt: {
      type: GraphQLString,
      extensions: { readOnly: true },
    },
  },
});

simfinity.connect(null, SerieType, 'serie', 'series');
const schema = simfinity.createSchema();
```

Use `id: { type: GraphQLID }` for the entity identifier. Simfinity supplies an `id` resolver for connected types. MongoDB reads `_id`; PostgreSQL exposes `id` and `_id` as the same UUID. The generated creation input omits `id`; the update input requires it.

Descriptions are part of your public API. Write them for the people using autocomplete, introspection, and [generated MCP tools](./mcp).

## Register types before building

Call `connect()` for each type that needs its own root operations, then call `createSchema()` after all types are registered:

```javascript
simfinity.connect(null, SerieType, 'serie', 'series');
simfinity.connect(null, SeasonType, 'season', 'seasons');

const schema = simfinity.createSchema();
```

Here `SeasonType` is another `GraphQLObjectType`, such as the one in the [relationships guide](./relationships). With the MongoDB facade, the first argument can be an existing Mongoose model or `null` to generate one. PostgreSQL registrations pass `null`. The optional arguments attach a controller, a model callback, and a state machine; see the [core API reference](../reference/api).

::: info Registration belongs to a runtime
Type registrations and middleware belong to the selected runtime instance. The default MongoDB and PostgreSQL module facades each expose one instance; `createPostgres()` creates an isolated PostgreSQL runtime. Register the application's types during startup and reuse the built schema. Do not register types or create a new schema for each request.
:::

## What gets generated

For a connected `Serie` type:

| Artifact | Name or behavior |
| --- | --- |
| Output type | Your `Serie` object type |
| Creation input | `SerieInput` |
| Update input | `SerieInputForUpdate` |
| Storage model | Mongoose model/collection or PostgreSQL table named from `Serie` |
| Root queries | `serie`, `series`, `series_aggregate` |
| Root mutations | `addserie`, `updateserie`, `deleteserie` |

Scalar and enum fields become filters on the list query. Object and collection fields receive relation-aware inputs. State machines add their own action mutations.

A generated Mongoose model stores enum internal values with their own type: numbers when every value is a number, booleans when every value is a boolean, strings when every value is a string, and any other combination of strings, numbers, booleans and `null` as given. Enums with other internal values (objects, dates) keep string storage, so writes of those values are rejected on MongoDB. Any scalar (non-list) enum field named `state` whose values are not all strings is also stored as given, at any level and whether or not its type has a state machine, because state machines persist state names there. Embedded types can declare a field named `type`.

MongoDB therefore compares, sorts and groups numeric and boolean enums by their own type, while PostgreSQL stores every enum as text and uses the text form. With `TWO: { value: 2 }` and `TEN: { value: 10 }`, filter `LT TEN` selects `TWO` on MongoDB and nothing on PostgreSQL, an ascending sort puts `TEN` first only on PostgreSQL, and aggregate `groupId` is `10` on MongoDB and `"10"` on PostgreSQL. Use string internal values when both backends must order an enum the same way.

Earlier versions stored every generated enum value as a string. Unscoped reads by ID convert legacy strings in number and boolean enum fields, but lists, aggregations and filters use the stored strings, so convert them once in the collection named after the type, for example `db.Task.updateMany({ priority: { $type: 'string' } }, [{ $set: { priority: { $toInt: '$priority' } } }])`. Use `$toDouble` for fractional values, `{ $eq: ['$flag', 'true'] }` for booleans and `{ $map: { input: '$priorities', in: { $toInt: '$$this' } } }` for lists; in embedded lists, merge the converted field into each item with `$mergeObjects`. Fields stored as given, such as mixed-value enums and non-string `state` fields without a state machine, keep legacy strings on every read, so update each legacy string to its value. If distinct internal values shared the same string representation (for example, `1` and `"1"` in a mixed enum), the stored text cannot recover the original type; choose the migration mapping using application-specific information. For a `unique` enum field, convert before accepting new writes (or resolve duplicates first): a new `1` can otherwise be stored next to a legacy `"1"`, and the conversion then stops with a duplicate-key error.

`GraphQLNonNull` makes scalar, enum, object, and list fields required in the creation input. Ordinary update fields have only their outer non-null wrapper removed so a partial update can omit them. List items keep their nullability: `[String!]!` becomes `[String!]` for updates. Supported validated scalars, date scalars, embedded lists, and referenced collections follow the same wrapper handling. Use [validation](./validation) for rules that must hold during updates; input optionality is not a substitute for a domain rule.

## Field metadata

Use standard GraphQL `extensions` to configure Simfinity behavior:

| Extension | Purpose | Learn more |
| --- | --- | --- |
| `relation` | Describe embedded objects and references | [Relationships](./relationships) |
| `readOnly` | Exclude a field from create and update inputs | [Controllers](./controllers) |
| `unique` | Add a unique index for supported generated string and number fields | [Field extensions](../reference/extensions) |
| `validations` | Run validators during create and update materialization | [Validation](./validation) |

A read-only field remains queryable. Set its persisted value in a controller or through your own model logic:

```javascript
const controller = {
  onSaving: async (document) => {
    document.createdAt = new Date().toISOString();
  },
};

simfinity.connect(null, SerieType, 'serie', 'series', controller);
```

This registration replaces the earlier `connect()` line; perform it before building the schema.

## Supporting types without endpoints

Use `addNoEndpointType()` for a type that should appear inside another object without its own root CRUD operations:

```javascript
const DirectorType = new GraphQLObjectType({
  name: 'Director',
  fields: {
    name: { type: GraphQLString },
    country: { type: GraphQLString },
  },
});

simfinity.addNoEndpointType(DirectorType);
```

Then reference it from `SerieType` with `extensions.relation.embedded: true`. See the [embedded object example](./relationships#embedded-objects) for the complete definition.

Use `connect()` when a type needs its own root CRUD operations. A supporting type receives persistent storage when another registered type references it; a value-only embedded type stays inside its owner.

## Use an existing Mongoose model

This option applies to `@simtlix/simfinity-js`. PostgreSQL generates its storage description from GraphQL metadata and requires `null` as the model argument.

You can retain an existing Mongoose schema, indexes, and collection mapping:

```javascript
import mongoose from 'mongoose';

const serieSchema = new mongoose.Schema({
  name: String,
  year: Number,
  tags: [String],
  createdAt: String,
});

const SerieModel = mongoose.model('Serie', serieSchema, 'catalog_series');
simfinity.connect(SerieModel, SerieType, 'serie', 'series');
```

Place the import at the top of your module. Supply the model instead of `null`, before calling `createSchema()`. Keep the GraphQL fields and MongoDB storage fields aligned, particularly each relation's `connectionField`.

PostgreSQL applications call and await `initializeDatabase()` after `createSchema()`. See the [PostgreSQL quick start](./postgresql) for create and read-only validation modes.

## Work with the built schema

Pass the schema directly to your server. Extend it through custom resolvers, Simfinity middleware, or Envelop plugins.

::: warning Preserve schema identity
Do not wrap a Simfinity schema with `graphql-middleware`'s `applyMiddleware()` or rebuild it with `mapSchema()`. Simfinity extends GraphQL introspection with relation metadata, and schema cloning can duplicate those types. Use the [Envelop authorization plugin](./authorization) and in-place resolver wrapping instead.
:::
