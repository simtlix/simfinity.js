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
| `connectionField` | For a reference, the stored ObjectId/UUID field; for a reverse collection, the child field linking back to the parent. |
| `displayField` | Descriptive field name exposed through introspection for client tooling. |

For a single-object reference, `connectionField` defaults to the GraphQL field name for model generation, reads, writes, and explicit-null clears. Set it to use a different stored reference field. For referenced collections, specify the child's back-reference explicitly. PostgreSQL uses the metadata to create real FKs for single, inverse, explicit-link, and embedded references.

Scalar lists do not need relationship metadata. Object fields and object lists do. Embedded self-references are rejected by model generation. See [relationships](/guide/relationships) for complete forward and reverse examples.

### readOnly

```javascript
createdBy: {
  type: GraphQLString,
  extensions: { readOnly: true },
}
```

The field remains in the output type and generated model. Assign it in a controller when it is server-owned. `readOnly` is an input-generation setting, not output authorization or a database-level immutability constraint.

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
| `scope` | `{ find, get_by_id, aggregate }` callbacks | Adds filters to generated root reads. |
| `indexes` | `{ fields: string[], unique?: boolean }[]` | Declares PostgreSQL composite indexes over stored scalar/reference fields; MongoDB uses its model index configuration. |

Type validators receive `(typeName, args, modelArgs, session)`. Scope callbacks receive `{ type, args, operation, context }` and mutate `args` in place. See [query scope](/guide/query-scope) for supported operations and their authorization boundaries.

## Automatic MongoDB indexes

When generating a Mongoose model, the MongoDB adapter registers ascending indexes for direct `GraphQLID` fields, stored single-object references, and ObjectId leaves inside embedded objects and arrays of embedded objects. For example, a direct `countryId` field gets `{ countryId: 1 }`; the same leaf inside `address` gets `{ 'address.countryId': 1 }`. Nested embedded paths are traversed recursively.

References use their stored `connectionField` name, or the GraphQL field name when it is omitted. The adapter also indexes private child connection fields that it generates for inverse collections. These are reference indexes; MongoDB does not enforce PostgreSQL-style foreign keys.

Inspect generated declarations after registering your types and calling `createSchema()`:

```javascript
const model = simfinity.getModel(SerieType);
const indexes = model.schema.indexes();
```

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

This is a Simfinity introspection extension, not a field in standard GraphQL introspection. It does not expose arbitrary extensions such as validator functions. Avoid schema-cloning middleware; use [Envelop plugins](/reference/plugins) and in-place resolver wrapping.

Initialization supports GraphQL fields that have already been materialized and schemas that already exist. Repeated evaluation of Simfinity with the same GraphQL peer preserves the existing extension field and metadata type identities. Your application field's `extensions` metadata remains intact.

The extension is global to that GraphQL peer, including unrelated schemas. Simfinity type and middleware registries belong to each runtime instance. Schemas constructed after import register `FieldExtensionsType` and `RelationType` in their type maps. Schemas constructed before import keep their original type maps: ordinary operations and direct selections such as the query above work, but named fragments on these metadata types require a schema constructed after import.

In a process that has imported Simfinity, passing a post-import schema's introspection result to `buildClientSchema()` can still fail with duplicate `FieldExtensionsType` names. This is the same retained global-type limitation that affects schema-cloning middleware; import-order safety does not make schema cloning supported.
