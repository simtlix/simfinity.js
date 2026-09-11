---
title: Core API
description: Public schema registration, model access, mutation, and configuration APIs.
---

# Core API

Import the public API as an ES module:

```javascript
import * as simfinity from '@simtlix/simfinity-js';
```

The package also provides named exports and TypeScript declarations. Schema registration and middleware configuration are held in module-level state; register your application types once during startup.

## Find an operation

| Task | API | Result |
| --- | --- | --- |
| Register a domain type | [connect](#connect) | Type registration; no return value |
| Build the executable API | [createSchema](#createschema) | `GraphQLSchema` |
| Register an application operation | [registerMutation](#registermutation) | Custom mutation registration |
| Retrieve a registered type | [getType](#gettype) | Type, `undefined`, or `null` as described below |
| Work with its model | [getModel](#getmodel) | Registered Mongoose model |
| Inspect a create input | [getInputType](#getinputtype) | Generated `GraphQLInputObjectType` |
| Create within an existing transaction | [saveObject](#saveobject) | Persisted document |

## connect

```javascript
simfinity.connect(
  model,
  gqltype,
  simpleEntityEndpointName,
  listEntitiesEndpointName,
  controller,
  onModelCreated,
  stateMachine,
);
```

Registers a `GraphQLObjectType` and its generated operations. Returns `undefined`.

| Parameter | Type | Required | Behavior |
| --- | --- | --- | --- |
| `model` | Mongoose model or `null` | Yes | Pass `null` to generate a model during `createSchema()`. |
| `gqltype` | `GraphQLObjectType` | Yes | The exact type instance to register. |
| `simpleEntityEndpointName` | `string` | Yes | Single-record query name and CRUD suffix; no inferred default. |
| `listEntitiesEndpointName` | `string` | Yes | List query name and aggregation prefix; no inferred default. |
| `controller` | Controller object or `null` | No | [Lifecycle hooks](/guide/controllers); omitted hooks add no application behavior. |
| `onModelCreated` | `(model) => void` or `null` | No | Synchronous callback for a generated model, not a supplied model. |
| `stateMachine` | State machine object or `null` | No | [State transitions](/guide/state-machines); omitted means no configured machine. |

```javascript
simfinity.connect(null, SerieType, 'serie', 'series');
```

This creates `serie`, `series`, `series_aggregate`, `addserie`, `updateserie`, and `deleteserie`. Names are used as supplied; Simfinity does not pluralize them for you. Generated MongoDB models and collections use the GraphQL type name, such as `Serie`.

## addNoEndpointType

```javascript
simfinity.addNoEndpointType(gqltype);
```

Registers a supporting object type without root CRUD endpoints. Use it for embedded or supporting types needed by connected types. Model creation is conditional: the implementation inspects the supporting type's relationship fields. A scalar-only supporting type does not automatically receive a Mongoose model. For a referenced collection that needs automatic database resolution, register an explicit model through `connect()` and use schema allowlists to control its endpoints.

## createSchema

```javascript
const schema = simfinity.createSchema(
  includedQueryTypes,
  includedMutationTypes,
  includedCustomMutations,
);
```

Builds models, generated resolvers, input types, and an executable `GraphQLSchema`. The root names are `RootQueryType` and `Mutation`.

| Argument | Matching behavior |
| --- | --- |
| `includedQueryTypes` | Array of the exact object-type instances passed to `connect()`. |
| `includedMutationTypes` | Array of the exact object-type instances passed to `connect()`. |
| `includedCustomMutations` | Array of registered custom mutation names. |

Omitting an argument or passing `null` includes all registered entries in that category. An empty array excludes that category's fields. String type names do not work in the first two arrays.

```javascript
const schema = simfinity.createSchema(
  [SerieType, SeasonType],
  [SerieType],
  ['importSeries'],
);
```

Ensure the resulting schema has fields in both generated roots. `createSchema()` always creates a `Mutation` object; excluding all mutations and all custom mutations leaves an empty root that GraphQL rejects. Allowlists control exposed fields, not whether registered models are initialized.

## registerMutation

```javascript
simfinity.registerMutation(name, description, inputModel, outputModel, callback);
```

Registers a custom mutation before creating the schema. When `inputModel` is a `GraphQLInputObjectType`, the mutation receives a required `input` argument. Passing `null` or `undefined` omits that argument. `outputModel` is a GraphQL output type.

The callback runs as `callback(input, session, context)` inside the mutation transaction. Use the supplied session for related writes.

```javascript
import { GraphQLInputObjectType, GraphQLNonNull, GraphQLString } from 'graphql';
import * as simfinity from '@simtlix/simfinity-js';

const ImportSerieInput = new GraphQLInputObjectType({
  name: 'ImportSerieInput',
  fields: { name: { type: new GraphQLNonNull(GraphQLString) } },
});

simfinity.registerMutation(
  'importSeries',
  'Create a series through the import workflow.',
  ImportSerieInput,
  SerieType,
  (input, session, context) => simfinity.saveObject('Serie', input, session, context),
);
```

## getType

```javascript
simfinity.getType('Serie');
simfinity.getType({ name: 'Serie' });
```

Returns the registered `GraphQLObjectType`. A missing registered name returns `undefined`; an unsupported argument returns `null`. For circular imports, perform lookups inside GraphQL's lazy `fields: () => ({ ... })` function after the referenced types have been registered.

## getModel

```javascript
const SerieModel = simfinity.getModel(SerieType);
```

Returns the model associated with a registered type. Retrieve generated models after `createSchema()`. The argument must have a `name` property; this function does not take a string name.

Direct Mongoose calls bypass generated GraphQL permissions, scopes, middleware, validators, and controller pipelines.

## getInputType

```javascript
const SerieInput = simfinity.getInputType(SerieType);
```

Returns the registered create input type after schema generation. For the generated update input, inspect the schema's `updateserie` field instead of assuming that `getInputType()` returns the update variant.

## saveObject

```javascript
await simfinity.saveObject('Serie', input, session, context);
```

Runs create materialization, field/type validators, collection processing, state initialization, and create controller hooks for a registered type. The type name is a string. Generated models must already exist.

`saveObject()` does not open a transaction by itself. Pass an active session from a controller or custom mutation to participate in that transaction. Calling it directly also bypasses GraphQL input coercion, field authorization, and global middleware; validate and authorize programmatic callers accordingly.

## Configuration and helpers

| Export | Purpose |
| --- | --- |
| `use(middleware)` | Register a global [pre-operation middleware](/guide/middleware). |
| `preventCreatingCollection(prevent)` | Toggle Simfinity's explicit `model.createCollection()` calls globally; useful for schema-only inspection and tests. This does not disable model registration or all Mongoose database activity. |
| `createValidatedScalar(name, description, baseScalarType, validate)` | Create a [validated scalar](/reference/scalars#createvalidatedscalar). |
| `buildErrorFormatter(callback)` | Create an [error normalization function](/reference/errors#builderrorformatter). |
| `buildQuery(input, gqltype, isCount = false)` | Build a MongoDB aggregation pipeline from list-query arguments. Does not execute scopes or middleware. |
| `buildFilterGroupMatch(group, gqltype, clauses, included, depth = 0)` | Low-level recursive filter compiler; mutates the supplied lookup accumulators. |

The `auth`, `validators`, `scalars`, `plugins`, and `mcp` namespaces group their respective helpers. MCP factories are also [named package exports](/reference/mcp).
