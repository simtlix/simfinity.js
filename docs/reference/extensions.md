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
| `unique` | Boolean | Adds a Mongoose unique index for supported string/enum and numeric fields. |
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
| `embedded` | `true` stores the object inline; `false` uses referenced records. |
| `connectionField` | For a reference, the stored ObjectId field; for a reverse collection, the child field linking back to the parent. |
| `displayField` | Descriptive field name exposed through introspection for client tooling. |

Set `connectionField` explicitly on non-embedded relationships. Read-side model generation and resolvers have field-name fallbacks, but write materialization accesses `connectionField` directly. Explicit configuration keeps reads and writes aligned.

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

Uniqueness is enforced by a MongoDB index when that index exists. It is not a pre-save validator. The generator applies this flag to string, enum, and numeric mappings; it does not apply it uniformly to every field kind. Manage index creation and existing duplicates through your application's database process.

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

Type validators receive `(typeName, args, modelArgs, session)`. Scope callbacks receive `{ type, args, operation, context }` and mutate `args` in place. See [query scope](/guide/query-scope) for supported operations and their authorization boundaries.

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
