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
Type registrations and middleware belong to the selected runtime instance. The default MongoDB and PostgreSQL module facades each expose one instance; `createPostgres()` creates a separate PostgreSQL runtime with its own registrations. Register the application's types during startup and reuse the built schema. Do not register types or create a new schema for each request.
:::

### Types belong to one runtime

`createSchema()` adds generated resolvers and filter arguments to the relation fields of your type objects. Those resolvers read through the runtime that created them: its adapter, registrations, middleware and scopes. When a runtime first creates a schema, it therefore claims two kinds of object types:

- **Bound types**: each type whose non-embedded relation fields receive this runtime's generated resolvers. These are usually the registered types that have relations. The resolvers that an adapter's `readEmbeddedValue` hook adds to nullable, singular embedded object fields (MongoDB's adapter defines it) read no data, so they do not bind their types.
- **Reserved types**: each object type the schema reaches that still has a non-embedded relation field without a resolver, such as an unregistered custom mutation result with a relation field. Reserving it stops another runtime from later generating resolvers that this schema would execute.

A schema reaches a type through registered types, fields, interfaces, union members and custom mutation results, as GraphQL itself does. Another runtime cannot use a claimed type: registering it with `connect()` or `addNoEndpointType()`, or building a schema that reaches it, throws `TYPE_BOUND_TO_OTHER_RUNTIME` (409).

Copies are checked too. After a runtime generates a relation field's resolver, a copy of that field keeps the generated resolver, or the field's `extensions` object, or both. `createSchema()` rejects a reachable type with such a copy, with the message `Field Type.field was copied from a relation field that another Simfinity runtime generated, with its resolver or its extensions; …`. This covers `new GraphQLObjectType(BookType.toConfig())` and `fields: () => ({ ...BookType.toConfig().fields })`, including a `fields` thunk that is defined at startup but runs only when the second runtime builds its schema. `connect()` accepts such a copy; `createSchema()` rejects it before building anything. In detail:

- A copied field without a resolver is accepted, as in 3.5.2: the second runtime generates its own resolver for it.
- A copied field whose resolver the first runtime generated is rejected, also after `createAuthPlugin` wrapped that resolver, because the auth plugin's wrapper keeps its owner.
- On an object type, a copied field whose resolver Simfinity neither generated nor wrapped, such as your own resolver, is rejected when it keeps the copied `extensions` object. Simfinity cannot tell such a resolver apart from a generated resolver that other code wrapped in place. Give the field its own `extensions` object, or define the field for each runtime.
- Interface fields are not checked, because graphql-js never runs an interface field's resolver; the object types that implement the interface, and the types its fields reference, are checked.

The check has one known gap: a generated resolver that a third-party tool wrapped in place, such as Envelop or OpenTelemetry-style instrumentation, copied together with a rebuilt `extensions` object, is not detected, and the copy reads through the first runtime. Creating the type objects for each runtime avoids it.

To serve the same model from two runtimes, create the type objects once per runtime, for example with a factory function:

```javascript
const createTypes = () => {
  const SeasonType = new GraphQLObjectType({ name: 'Season', fields: () => ({ /* ... */ }) });
  const SerieType = new GraphQLObjectType({ name: 'Serie', fields: () => ({ /* ... */ }) });
  return { SerieType, SeasonType };
};

// first and second are two runtimes, such as two createPostgres() instances.
const catalog = createTypes();
first.connect(null, catalog.SerieType, 'serie', 'series');
first.connect(null, catalog.SeasonType, 'season', 'seasons');

const archive = createTypes();
second.connect(null, archive.SerieType, 'serie', 'series');
second.connect(null, archive.SeasonType, 'season', 'seasons');
```

These object types can be shared between runtimes:

- types without non-embedded relation fields, such as scalar-only types and types whose relation fields are all embedded;
- types whose non-embedded relation fields all have your own resolvers.

Resolvers that an adapter's `readEmbeddedValue` hook adds to nullable, singular embedded object fields do not prevent sharing: every runtime that shares the type reads those fields through the hook of the first runtime that added them. A shared type also has a single `id` rule. Once a runtime that registers the type as an entity builds its schema, every runtime that shares the type reads and filters its `id` as an entity's, including runtimes that only embed it; see [supporting types without endpoints](#supporting-types-without-endpoints).

Another runtime can also use a copy made with `toConfig()` before the first runtime built its schema, because the copy's fields do not yet hold generated resolvers. The copy then belongs to that other runtime. A factory function is safer: a copy made too late fails at startup.

A custom mutation result type that is not registered and has a non-embedded relation field without a resolver cannot be shared. If two runtimes pass the same `CheckoutResult` type object, with an `order` relation, to `registerMutation()`, the first schema reserves it and the second runtime's `createSchema()` throws `TYPE_BOUND_TO_OTHER_RUNTIME`. That error message mentions generated relation resolvers even though none were generated. Create the result type for each runtime, or give its relation field your own resolver.

A runtime can rebuild its own schema from the types it claimed.

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

### Fields named like Object.prototype members

A field can be named like a member that every JavaScript object inherits: `constructor`, `hasOwnProperty`, `isPrototypeOf`, `propertyIsEnumerable`, `toLocaleString`, `toString` or `valueOf`. Simfinity reads only the value such a field holds, never the inherited member. An omitted field is stored as a field with another name would be: without a value, or as `[]` for a list. An update that does not mention it keeps the stored value, and an absent value reads `null`. For output fields with these names that have no resolver of their own, on registered types and the embedded types they reach, Simfinity installs a resolver that returns `null` for the inherited member and otherwise reads the value as graphql's default resolver does, so own values, methods and class getters still work. Custom mutation result types that are not registered do not get it. A reference named `constructor` reads its `connectionField`.

Some limits remain:

- graphql-js 16 reads variable input objects with plain property access. A JSON variable that omits such a field therefore passes the inherited function, and the request fails before Simfinity runs: `Variable "$input" got invalid value [function toString] at "input.toString"; String cannot represent a non string value: [function toString]`. Nothing is written. Inline literal arguments are not affected. Clients that send input as variables, including MCP tool calls, must include these fields: `null` stores nothing in a create, and clears the stored value in an update, so send the current value to keep it.
- On MongoDB, `createSchema()` rejects the fields that Mongoose cannot store, with `INVALID_MODEL` (400, `Type.field cannot be stored on MongoDB: …`), where `Type` is the type that declares the field. These are an embedded object or embedded list with one of these names, at any depth, and any field stored under the path `constructor`, which Mongoose drops from every write: a scalar or scalar list named `constructor`, a reference named `constructor` stored under its own name, and a reference whose `connectionField` is `constructor`. On MongoDB, use these names only for scalars, scalar lists and references, do not name a scalar or scalar list `constructor`, and store a reference named `constructor` under another `connectionField`. A collection whose `connectionField` is `constructor` and whose child type has no field of that name is rejected the same way, naming `Child.constructor`, because the private link field Simfinity would add to the child is dropped too. Models that you pass to `connect()` are not checked. PostgreSQL stores all these fields.
- On MongoDB, a document stored without a list with such a name, such as one written before the field was added or outside Simfinity, reads `null` for that list in by-ID reads and mutation results, where a missing list with another name reads `[]`; list queries read `null` for both. The next update of an embedded object stores `[]` for its missing list members, but a missing root list stays missing until a write sets it.

Versions before 3.5.6 stored the text of the inherited function, or an object built from it, for some of these fields; see the [upgrade notes](../resources/compatibility#fields-named-like-object-prototype-members).

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

Use `connect()` when a type needs its own root CRUD operations. A supporting type receives persistent storage when another registered type references it; a value-only embedded type stays inside its owner. A referenced supporting type is an entity, so its `id` resolves to its stored identity (`_id` on MongoDB), whatever the `createSchema()` allowlists include; a value-only embedded type returns its declared `id` member.

Avoid using one type both as an entity and as an embedded value. Its embedded copies return the declared `id` they store: `null` for copies created through add inputs, which have no `id`, and the supplied value for copies written through update inputs (which require an `id`), `saveObject()` or native writes. On MongoDB, copies in an embedded list are the exception: they return the automatic `_id` that Mongoose adds to each list item, and `<list>.id` filters match that value. Their declared `id` is still stored but is neither returned nor matched, and the automatic `_id` changes whenever the list is rewritten. This rule follows the type object, so a type that any runtime registers as an entity behaves this way in every runtime that shares it. When clients need a stable embedded `id`, embed a separate embedded-only type instead.

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
