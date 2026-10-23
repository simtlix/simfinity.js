---
title: Extensions
description: Reference for field and type metadata used by schema generation, storage, validation, and introspection.
---

# Extensions

Simfinity reads standard GraphQL `extensions` metadata when building models, input types, and resolvers. Define field extensions on individual field configurations and type extensions on `GraphQLObjectType`.

## Field extensions

| Extension | Value | Effect |
| --- | --- | --- |
| `relation` | Relationship configuration | Declares how an object or object collection is stored and resolved. |
| `readOnly` | Boolean | Omits the field from generated create and update inputs. |
| `queryable` | Boolean | `false` rejects client filter, sort and aggregation paths through the field; `true` allows them for a field with its own `resolve`. |
| `virtual` | `true` or `{ mcp }` | Resolves the field with its own `resolve` and stores it nowhere: it has no generated input and no filter, sort or aggregation argument or path. |
| `unique` | Boolean | Adds a backend uniqueness structure for supported fields. |
| `validations` | Operation-keyed validators | Runs field validation during materialization. |
| `stateMachine` | Boolean, generated | Marks a state field managed by a connected state machine. |

### relation

```javascript
const field = {
  type: CountryType,
  extensions: {
    relation: {
      embedded: false,
      connectionField: 'country',
      displayField: 'name',
    },
  },
};
```

| Property | Description |
| --- | --- |
| `embedded` | `true` gives the value parent-owned storage: inline on MongoDB, JSONB or owned tables on PostgreSQL; `false` uses referenced records. |
| `connectionField` | For a reference, the stored ObjectId/UUID field; for a reverse collection, the required child field linking back to the parent. A field name of that record, never a path such as `meta.key`. |
| `displayField` | Descriptive field name exposed through introspection for client tooling. |

For a single-object reference, `connectionField` defaults to the GraphQL field name for model generation, reads, writes, and explicit-null clears. Set it to use a different stored reference field. It names a field of the reference's own type: a value with a dot, such as `meta.key`, or one that is not a string fails `createSchema()` with `INVALID_MODEL` (400), also in an embedded type that is not registered itself. To keep a link inside an embedded value, declare the reference in the embedded type, as `Meta { label, owner: Target }`, which stores it at `meta.owner` on MongoDB and in the embedded storage on PostgreSQL. Versions up to 3.7.0 accepted a dotted value; the [upgrade notes](/resources/compatibility#moving-links-of-a-dotted-connectionfield) show how to move the links it stored. On MongoDB, a reference cannot be stored under `constructor`, which Mongoose drops: `createSchema()` rejects it with `INVALID_MODEL` (400), and a collection must not use it either; see [fields named like Object.prototype members](/guide/schema#fields-named-like-object-prototype-members).

For referenced collections, `connectionField` is required: name the child's back-reference, either the child's single reference field or its stored field name. It names a field of the child type itself, not a path into one of its embedded values. When it is missing or an empty string, `createSchema()` throws `INVALID_MODEL` (400, `Type.field requires a child connectionField`) on every adapter. In default MongoDB mode and with custom adapters only, a collection with its own resolver, or marked `readOnly`, is exempt: it builds with a `Configuration issue` warning, or silently when it is `readOnly` and has its own resolver, and nested writes through it fail with `INVALID_MODEL` (500). PostgreSQL and `referentialIntegrity: 'transactional'` always require it. When the child declares no field for the back-reference, MongoDB stores the link in a private ObjectId field of the generated child model, also when the child has a collection with the same `connectionField`, as in chained or self-referencing collections. PostgreSQL uses the metadata to create real FKs for single, inverse, explicit-link, and embedded references.

Scalar lists do not need relationship metadata. Object fields and object lists do, unless they are [virtual](#virtual). Embedded self-references are rejected by model generation. See [relationships](/guide/relationships) for complete forward and reverse examples.

### readOnly

```javascript
createdBy: {
  type: GraphQLString,
  extensions: { readOnly: true },
}
```

The field remains in the output type and generated model. Assign it in a controller when it is server-owned. `readOnly` is an input-generation setting, not output authorization or a database-level immutability constraint. A `readOnly` field is stored like any other; a field that your resolver computes, and that nothing should store, is [virtual](#virtual).

### queryable

```javascript
fields: () => ({
  internalCode: {
    type: GraphQLString,
    extensions: { queryable: false },
  },
  title: {
    type: GraphQLString,
    extensions: { queryable: true },
    resolve: (parent) => parent.title,
  },
}),
```

Client filter, sort, `groupId` and fact paths compare stored values, not resolver output. A field with its own `resolve`, such as a masking resolver, a manual relationship resolver or a custom `id` resolver, is therefore non-queryable unless it sets `queryable: true`; only the resolvers Simfinity generates keep a field queryable. Set `queryable: true` when the resolver returns the stored value, and `queryable: false` to make any field non-queryable.

A client path with a non-queryable segment fails with `FORBIDDEN_FILTER_PATH` (403), although the generated filter argument remains in the schema. Paths added by middleware, scope functions or a view's `where` are not checked against `queryable`; a path through a [virtual](#virtual) field fails even then. `queryable: true` does not bypass authorization rules or the `find` scopes of related types, and introspection does not expose it. See [path restrictions](/guide/queries#path-restrictions).

### virtual

```javascript
busyRanges: {
  type: new GraphQLList(new GraphQLNonNull(BusyRangeType)),
  args: { date: { type: new GraphQLNonNull(GraphQLString) } },
  extensions: { virtual: true },
  resolve: (shop, { date }) => listBusyRanges(shop, date),
},
```

A virtual field is computed by its own `resolve` and stored nowhere. Use one for a read that the filter language cannot express, on the type the read belongs to; see [virtual fields](/guide/queries#virtual-fields) for a complete example on both backends.

| Value | Meaning |
| --- | --- |
| `true` | A virtual field with the default options, the same as `{ mcp: 'tool' }`. |
| `{ mcp: 'tool' }` | The default. A virtual field with a required argument that has no default gets its own [MCP read tool](/reference/mcp#virtual-field-tools), `<byIdQuery>_<field>`, on a type with a generated by-ID query. |
| `{ mcp: 'select' }` | Also lets generated MCP list tools select the field when it has no required arguments; each listed record then runs the resolver. A field with a required argument still gets its own tool. |
| `{ mcp: false }` | No per-field MCP tool. Nothing else changes: by-ID and mutation tools still select a field without required arguments. |

`virtual: undefined` declares nothing, and `{ mcp: undefined }` is the same as `true`. Virtual fields are allowed on entity types, on types registered with `addNoEndpointType()`, on members of embedded types, and on unregistered object types that a schema reaches, such as the result type of another virtual field.

On every backend and in every mode, a virtual field:

- **Has no storage.** `describeModels()` leaves it out of entities and embedded types, and describes no type that only virtual fields reach. PostgreSQL gets no column, presence flag, check, JSON validation function, owned table, index or foreign key for it; generated MongoDB models get no path, `[]` default or index, and [transactional reference integrity](/guide/mongodb-integrity) never checks it. On MongoDB, an embedded type whose members are all virtual becomes a strict subdocument without paths, not a Mixed path, so nothing is stored for it except the `_id` of list items. Adding a virtual field to a deployed type is therefore not a schema change. A custom adapter still receives the field in the GraphQL types that `prepare()` and `createModel()` get, so one that builds storage from a type's fields must skip it: `isVirtualField(field)` and `virtualFieldOptions(field)`, exported by `@simtlix/simfinity-core`, identify it, or the adapter can build its storage from `describeModels()`.
- **Has no input.** Virtual implies `readOnly`, so the field is absent from generated create, update, embedded and one-to-many inputs. Generated writes also drop a value that middleware or `saveObject()` passes for it, without setting or unsetting anything. The PostgreSQL record store ignores such values in native writes too, and generated MongoDB models drop them in strict mode, including a value that a controller assigns. A Mongoose model that you supply keeps the paths it declares.
- **Is not part of the query language.** List queries, `_aggregate` queries and generated collection fields have no filter argument for it, so a client that sends one fails GraphQL validation (`Unknown argument "busyRanges" on field "RootQueryType.barbershops".`). A client filter, `AND`/`OR` condition, sort term, `groupId` or fact path through it fails with `FORBIDDEN_FILTER_PATH` (403): `Query path busyRanges uses the virtual field Barbershop.busyRanges, which is not stored`. A path that middleware or a `find`, `get_by_id`, joined or collection scope adds through it fails with `INVALID_MODEL` (500) before the database is queried: `Query path busyRanges, added by middleware or a scope, uses the virtual field Barbershop.busyRanges, which is not stored`. Native reads reject such paths with `INVALID_FILTER_FIELD` (400): PostgreSQL's `getModel(Type).find()`, and MongoDB's `buildQuery()` and `buildFilterGroupMatch()`.
- **Resolves wherever its type appears**: in by-ID and list queries, references and collections that reach the type, mutation results after commit, in-process execution and MCP tools. The resolver receives the record that the generated read returned (with `_id` on MongoDB, and `id` and `_id` on PostgreSQL), the field's coerced arguments and the request context. It receives no session.
- **Accepts any output type** as its result: scalars, including custom scalars without `baseScalarType`, enums, object types, lists, non-null wrappers, interfaces and unions, without registering it. A registered type, entity or not, needs no `relation` as the result of a virtual field: the field adds no reference or collection storage and no inferred inverse reference, and the result's own relation fields still resolve from the records that your resolver returns. Non-null virtual fields work on every backend, because no create has to supply them.
- **Reads as read-only in introspection**: `extensions { readOnly }` returns `true`; see [introspection metadata](#introspection-metadata).

Permission rules of the [authorization plugin](/guide/authorization) apply to a virtual field as to any field, and its rule receives the parent record and the field's arguments. Path rules never see it, because no path can name it.

`createSchema()` checks every virtual declaration of the object types a schema reaches before it prepares any storage, and throws `INVALID_MODEL` (400), naming the type and field. `describeModels()`, and with it PostgreSQL's `describeDatabase()` and `compileDatabaseSchema()`, reject the same declarations:

| Declaration | Message |
| --- | --- |
| A value other than `true` or a plain options object, such as `false`, `'yes'` or an array | `Barbershop.busyRanges extensions.virtual must be true or an options object such as { mcp: 'select' }` |
| An option other than `mcp` | `Barbershop.busyRanges extensions.virtual has the unknown option batch; its only option is mcp` |
| An `mcp` other than `'tool'`, `'select'` or `false` | `Barbershop.busyRanges extensions.virtual.mcp must be 'tool', 'select' or false` |
| No `resolve` of its own | `Barbershop.busyRanges is virtual, so it requires its own resolve function` |
| `relation`, `unique: true`, `validations`, `queryable: true` or `readOnly: false` as well | `Barbershop.busyRanges is virtual, which is never stored, so it cannot declare extensions.relation` (or `unique: true`, `extensions.validations`, `queryable: true`, `readOnly: false`) |
| A field named `id` or `_id` | `Barbershop.id is the identity field, so it cannot be virtual` |
| A field named in the type's `extensions.indexes`, also as a member of a dotted key such as `address.pin` | `An index of Barbershop names the virtual field Barbershop.score, which is never stored`; for a dotted key, `An index of Barbershop names the virtual field Address.pin (through address.pin), which is never stored` |
| The `state` field of a type with a state machine | `Barbershop.state holds the state of its state machine, so it cannot be virtual` |
| The `connectionField` of a reference, or of a collection, on the type that stores it: also a dotted `connectionField` such as `meta.key` that ends at or passes through a virtual member of an embedded type (checked on every backend), and the field name that a collection without a `connectionField` reads its items by, unless the application resolves that collection | `Shop.bookings uses the virtual field Booking.shopRef as its connectionField; a virtual field is never stored`; for a dotted path, `Booking.shop uses the virtual field BookingMeta.key as its connectionField (through meta.key); a virtual field is never stored` |

`readOnly: true` and `queryable: false` restate what `virtual` implies, so they are allowed.

`createSchema()` also logs a warning, once per field and runtime, for a field of a registered type that is `readOnly`, has arguments and has its own resolver, but is not virtual, a reference or a collection. Such a field is usually computed, yet it is described as stored data:

```text
Configuration issue: Barbershop.busyRanges is readOnly and has arguments and its own resolver, but it is not virtual, so Simfinity describes it as stored data: backends may store it, and list queries get a filter argument for it. If its resolver computes it, declare extensions: { virtual: true }.
```

When the field also declares a setting that a virtual field cannot, the advice names it, so that following it builds a schema. For a computed embedded value, such as a `busyRanges` declared with `relation: { embedded: true }` so that PostgreSQL accepts its object result, the warning ends with `declare extensions: { virtual: true } and remove extensions.relation.` It names `unique: true`, `extensions.validations` and `queryable: true` the same way.

Declare such a field virtual only when nothing reads what its storage holds: the change is breaking for the application, as the [upgrade notes](/resources/compatibility#virtual-fields) describe.

### unique

```javascript
slug: {
  type: GraphQLString,
  extensions: { unique: true },
}
```

Uniqueness is a database constraint, not a pre-save validator. The MongoDB generator creates indexes for supported string, enum, and numeric mappings. PostgreSQL supports all mapped native scalar types, single references, scalar lists, and scalar/reference fields inside embedded trees. Root unique indexes use `NULLS NOT DISTINCT`; embedded and multikey declarations use typed owner-key tables so duplicate values within one root are allowed but another root cannot claim the same key. Whole embedded-object uniqueness is rejected. Manage existing duplicates and schema evolution through an explicit database process.

### validations

```javascript
title: {
  type: new GraphQLNonNull(GraphQLString),
  extensions: {
    validations: simfinity.validators.stringLength('Title', 2, 120),
  },
}
```

The field-level shape is `{ CREATE: [validator], UPDATE: [validator] }`. Each validator exposes `validate(typeName, fieldName, value, session)`. Async validators are awaited. See [validation](/guide/validation) for helpers and custom rules.

## Type extensions

| Extension | Value | Effect |
| --- | --- | --- |
| `validations` | `{ CREATE, UPDATE }` validator arrays | Validates the full input and materialized model after field validation. |
| `scope` | Plain object with optional `find`, `get_by_id` and `aggregate` functions | Adds filters to generated root reads. Any other shape throws `INVALID_SCOPE`. |
| `indexes` | `{ fields: string[], unique?: boolean }[]` | Declares PostgreSQL composite indexes over stored scalar/reference fields; MongoDB uses its model index configuration. |

Type validators receive `(typeName, args, modelArgs, session)`. Scope callbacks receive `{ type, args, operation, context }` and mutate `args` in place. Omit a key to leave an operation unscoped; misspelled keys, non-function values, arrays and `scope: undefined` or `null` throw `INVALID_SCOPE` (500) at registration and `createSchema()`, and on reads if the scope is changed later. A type's `find` scope also restricts the referenced records that client filter, sort and aggregation paths reach. See [query scope](/guide/query-scope) for supported operations, [relationship paths](/guide/query-scope#relationship-paths-in-filters-sorts-and-aggregations) and their authorization boundaries.

## Automatic MongoDB indexes

When generating a Mongoose model, the MongoDB adapter registers ascending indexes for direct `GraphQLID` fields, stored single-object references, and ObjectId leaves inside embedded objects and arrays of embedded objects. Virtual fields get no index. For example, a direct `countryId` field gets `{ countryId: 1 }`; the same leaf inside `address` gets `{ 'address.countryId': 1 }`. Nested embedded paths are traversed recursively.

References use their stored `connectionField` name, or the GraphQL field name when it is omitted. The adapter also indexes private child connection fields that it generates for inverse collections. These are reference indexes; MongoDB does not enforce PostgreSQL-style foreign keys.

Inspect generated declarations after registering your types and calling `createSchema()`:

```javascript
const model = simfinity.getModel(SerieType);
const indexes = model.schema.indexes();
```

Generated models also declare `{ id: 1 }` on the top-level `id` field. The record key is `_id`, and generated reads, filters, sorts, aggregations, relation lookups and MCP tools never use that index. To stop declaring it for a `connect()` type, remove it in `onModelCreated`, the sixth argument of `connect()`:

```javascript
simfinity.connect(null, SerieType, 'serie', 'series', controller, (model) => model.schema.removeIndex({ id: 1 }));
```

Types registered with `addNoEndpointType()` and generated supporting models have no `onModelCreated`. Mongoose `autoIndex` builds the index at startup on any process whose schema still declares it, so drop an existing one with `db.getCollection('Serie').dropIndex('id_1')` only once every process runs with the recipe, and expect `syncIndexes()` to drop it as soon as the recipe is in place. Keep the index when your code queries the stored `id`, or when a link is stored under `id`, as with `connectionField: 'id'`. Version 4.0 plans to stop declaring it by default and to remove the stored `id` path and the duplicate `$set.id` that generated updates write.

This automatic traversal does not add indexes for arbitrary string/number fields or direct lists of scalar IDs. Supported `unique` flags are handled separately as described above. Supplied Mongoose models keep their own schemas and index definitions; use their native configuration for additional or composite indexes.

PostgreSQL generates indexes and real foreign keys from its storage description instead. See [PostgreSQL storage and constraints](/postgresql) for its index declarations and initialization contract.

## Introspection metadata

Simfinity extends GraphQL's `__Field` introspection type with `extensions`. Clients can inspect `readOnly`, `stateMachine`, and relation metadata:

```graphql
query SerieMetadata {
  __type(name: "Serie") {
    fields {
      name
      extensions {
        readOnly
        stateMachine
        relation {
          embedded
          connectionField
          displayField
        }
      }
    }
  }
}
```

This is a Simfinity introspection extension, not a field in standard GraphQL introspection. It does not expose arbitrary extensions such as validator functions. A virtual field reads `readOnly: true`, whether it declares `virtual: true` or an options object, so generic clients leave it out of their forms; it has no filter arguments. The metadata types have no `virtual` field, so schemas without virtual fields introspect exactly as before; describing virtual fields to clients belongs to the client descriptor proposed in [#101](https://github.com/simtlix/simfinity.js/issues/101). Avoid schema-cloning middleware; use [Envelop plugins](/reference/plugins) and in-place resolver wrapping.

Initialization supports GraphQL fields that have already been materialized and schemas that already exist. Repeated evaluation of Simfinity with the same GraphQL peer preserves the existing extension field and metadata type identities, with one exception: when the first Simfinity schema of the process has an application type named `FieldExtensionsType` or `RelationType`, Simfinity replaces the metadata types once with renamed ones, described below, and every evaluation follows the shared extension field to them. Your application field's `extensions` metadata remains intact.

The extension is global to that GraphQL peer, including unrelated schemas. Simfinity type and middleware registries belong to each runtime instance. Schemas constructed after import register `FieldExtensionsType` and `RelationType` in their type maps. Schemas constructed before import keep their original type maps: ordinary operations and direct selections such as the query above work, but named fragments on these metadata types require a schema constructed after import.

When the first Simfinity schema of a process has an application type named `FieldExtensionsType` or `RelationType`, Simfinity names its metadata types `SimfinityFieldExtensionsType` and `SimfinityRelationType` instead, with a number appended when those names are taken too, in every schema the process constructs from then on, Simfinity's or not, and logs a `Configuration issue` warning. Selections by field name, such as the query above, are unaffected; named fragments and permission maps use the new names. The first Simfinity schema of the process fixes the names, so a later schema with an application type of a current name fails with `RESERVED_TYPE_NAME`. A schema constructed before the rename keeps the old types, like a schema constructed before import. See [what gets generated](/guide/schema#what-gets-generated).

In a process that has imported Simfinity, passing a post-import schema's introspection result to `buildClientSchema()` can still fail with duplicate `FieldExtensionsType` names, or duplicates of whichever metadata names are current. This is the same retained global-type limitation that affects schema-cloning middleware; import-order safety does not make schema cloning supported.
