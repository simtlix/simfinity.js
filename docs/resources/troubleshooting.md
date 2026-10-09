---
title: Troubleshooting
description: Diagnose common setup, schema, relationship, transaction, authorization, and MCP integration problems.
---

# Troubleshooting

Start with the generated schema and the exact operation that fails. GraphiQL's documentation explorer shows the field names, arguments, and input types your application actually exposes.

## The package has no default export

Simfinity's core exports named functions. Use a namespace import or select named exports:

```javascript
import * as simfinity from '@simtlix/simfinity-js';
// Or: import { connect, createSchema } from '@simtlix/simfinity-js';
```

Use ES modules (`"type": "module"` in your application's `package.json`). The [quick start](../guide/getting-started) contains a complete server example.

## A generated mutation cannot be found

Names use the endpoint strings passed to `connect()` without changing their capitalization:

```javascript
simfinity.connect(null, SerieType, 'serie', 'series');
```

This creates `addserie`, `updateserie`, and `deleteserie`. `addSerie` is a different GraphQL field. State-machine operations use `{actionName}_{singular}`, such as `activate_season`.

If an operation is missing entirely, check the filters passed to `createSchema()`. See [schema selection](../reference/api#createschema).

## Reads work but mutations fail with a transaction error

MongoDB mutations require a replica set or sharded deployment; wait for a writable primary. PostgreSQL mutations require successful awaited initialization and run in repeatable-read transactions. The [MongoDB quick start](../guide/getting-started#_2-start-mongodb) and [PostgreSQL quick start](../guide/postgresql) include local setup.

Pass the supplied active backend session from a custom mutation to `saveObject()` to share its transaction. Without a session, `saveObject()` owns a separate transaction. See [mutations](../guide/mutations) and the [core API](../reference/api).

On MongoDB, a custom mutation that fails with `Connection operation buffering timed out` or `ClientSession must be from the same MongoClient` writes models or collections whose MongoDB client is not its session's. In the default `referentialIntegrity: 'off'` mode, its session uses the default Mongoose connection, unless that connection is unused, with no client and no model compiled on it or on its `useDb()` descendants, and every registered model shares one client; with transactional reference integrity it uses the first protected model's connection. An application that opens the default connection after it starts serving, without a model compiled on it, therefore gives requests that arrive before `mongoose.connect()` a session of the registered models' client, which native writes such as `mongoose.connection.collection(…)` reject; compile a model on the default connection, or open it before serving. Keep the models that the callback writes on the session's client. In the default `referentialIntegrity: 'off'` mode only, you can instead open a transaction on the model's connection inside the callback: every write that must be atomic has to happen inside it, and it commits independently of the custom mutation's transaction. `saveObject()` without a session is atomic only per call. See [which connection the session uses](../guide/mutations#which-connection-the-session-uses-on-mongodb).

## Duplicate introspection types

Do not wrap a Simfinity schema with `graphql-middleware`'s `applyMiddleware` or rebuild it with `mapSchema`. Simfinity extends GraphQL introspection globally; rebuilding a schema can introduce duplicate introspection type names.

The same limitation affects `buildClientSchema()` on a post-import schema's introspection when called in a process that has imported Simfinity. Repeated Simfinity module evaluation with a shared GraphQL peer is safe and reuses its introspection types; it does not provide schema-cloning support. See [introspection metadata](../reference/extensions#introspection-metadata) for schemas created before import and their type-map limitations.

Use the [Envelop authorization plugin](../guide/authorization) with GraphQL Yoga, or wrap existing resolvers in place. Register application types once at startup and reuse the resulting schema.

## A relationship is empty or its input is wrong

Check that:

- Every related type was registered before `createSchema()`.
- The field declares `extensions.relation`.
- `embedded` matches how you intend to store the value.
- `connectionField` matches the stored link. Single-object references default to the GraphQL field name; referenced collections require the child back-reference explicitly.
- On MongoDB, children added through a chained or self-referencing collection whose back-reference is not a field of the child were stored without the link by 3.5.3 and earlier. Current versions store it, but do not repair those records.
- An existing custom resolver returns the expected value. Simfinity preserves custom resolvers.

See [relationships](../guide/relationships) for embedded, reference, and collection examples.

## Startup fails with a configuration error

These errors are thrown while you register types or build the schema:

- `TYPE_BOUND_TO_OTHER_RUNTIME`: another runtime already claimed the type object, because it generated the type's relation resolvers or its schema reached the type with a relation field that has no resolver, such as a shared custom mutation result. A message starting `Field Type.field was copied from a relation field` means the field was copied with `toConfig()`, or spread from `Type.toConfig().fields`, after the other runtime generated its resolver, and the copy kept that resolver or the field's `extensions` object. Create the type objects once per runtime, for example with a factory function. See [types belong to one runtime](../guide/schema#types-belong-to-one-runtime).
- `INVALID_SCOPE`: `extensions.scope` must be a plain object whose keys are `find`, `get_by_id` or `aggregate` functions. Check for misspelled keys such as `getById`, and omit a key, or the whole property, instead of setting it to `undefined`. See the [scope contract](../guide/query-scope#callback-contract).
- `INVALID_MIDDLEWARE`: `use()` received a value that is not a function, often `null` from `enabled && middleware`. Register the middleware conditionally instead.
- `UNREGISTERED_RELATION_TARGET`: the field named in the message, as `Type.field`, is a list relation or embedded field whose type was never registered. Register that type with `connect()` or `addNoEndpointType()` before `createSchema()`.
- `INVALID_MUTATION_LIMITS`: `configureMutationLimits()` needs a plain object whose only option is `maxNestedOperations`, set to `null` or a non-negative safe integer. Check for misspellings such as `maxNestedOperation`.
- `INVALID_MODEL` with `Type.field requires a child connectionField`: the referenced collection named in the message has no `connectionField`. Set it to the child's back-reference. In default MongoDB mode and with custom adapters, a collection with your own resolver, or marked `readOnly`, is accepted with a warning instead; PostgreSQL and `referentialIntegrity: 'transactional'` always require it. Other `INVALID_MODEL` messages from PostgreSQL or transactional MongoDB name metadata that their storage cannot represent. Generated MongoDB models also raise `INVALID_MODEL`, in every mode: `Type.field cannot be stored on MongoDB: …` for embedded fields named like `Object.prototype` members and for fields stored under the path `constructor`, and `Embedded cycle at …` for embedded types that contain each other. `Type.field is non-null but its embedded type … has no writable fields` means generated creates could not set that field: mark it `readOnly` and set it in a controller, or make it nullable. See [relation](../reference/extensions#relation) and [what gets generated](../guide/schema#what-gets-generated).
- `INPUT_TYPE_UNRESOLVED`: the message `Could not build input types for: …` names every field of the listed types whose input cannot be generated. It names the causes first: writable lists whose items have no generated input, such as lists of lists, and embedded fields whose types contain each other. Mark each such list `readOnly`. Embedded cycles reach this error with custom adapters that do not validate models, and in default MongoDB mode when only supplied models reach the cycle; there, marking one of the cycle's fields `readOnly` breaks it. On PostgreSQL, with MongoDB's `referentialIntegrity: 'transactional'`, and in default MongoDB mode when Simfinity generates a model whose embedded fields reach the cycle, embedded types that contain each other fail first with `INVALID_MODEL` (`Embedded cycle at …`) whatever `readOnly` says; replace one embedded link with a reference or a referenced collection. The fields listed after `These fields only wait for another listed type`, such as `Sheet.meta waits for Meta`, need no change: they build once the type they wait for does. Referenced collections, including cycles across types, never cause it.
- `RESERVED_TYPE_NAME`: an application type has the name of a type that Simfinity adds to every schema for `__Field.extensions`, `FieldExtensionsType` or `RelationType`, or their fallback names, and an earlier Simfinity schema of the process already fixed those names. It is raised before models are created, except for a type nested in an input object's fields or one that only generated types reach, which is found when the schema is constructed. When such a type is in the first Simfinity schema of the process, Simfinity names its own types `SimfinityFieldExtensionsType` and `SimfinityRelationType` instead, with a warning. Create the schema that has that type first, or rename the type. See [what gets generated](../guide/schema#what-gets-generated).
- `Schema must contain uniquely named types but contains multiple types named "OneToManyAchildren"` (or another `OneToManyA…`/`OneToManyU…` name): two types have a self-referencing collection with the same name, and Simfinity could not give one of them qualified input names. This happens when the second type is reached only through a `registerMutation()` input, or when a later `createSchema()` reaches both types after earlier calls built their inputs with the unqualified names, for example after a first call with a narrower mutation allowlist. See [self-referencing collections with the same name](../guide/relationships#self-referencing-collections-with-the-same-name).

A console warning that starts with `Configuration issue:` does not stop startup. It names the field to fix, for example:

- a field that a generated query argument hides, such as a field named `sort` or `aggregation`; see [fields named like query arguments](../guide/queries#fields-named-like-query-arguments);
- a collection without `connectionField` whose nested writes are rejected with `INVALID_MODEL` (500);
- `Field name does not define extensions.relation`: an object field without relation metadata, which generated create and update inputs leave out. Declare it as embedded or as a reference, as described in [relationships](../guide/relationships#choose-a-storage-model);
- `Comment.children and Category.children are self-referencing collections with the same name, …`: the same schema reaches both types, and the type named second keeps the unqualified names, so the collection inputs of the type named first are named after it, such as `OneToManyCommentAchildren`. Register the type that should keep the unqualified names first, or make the other type unreachable from the generated mutations; see [self-referencing collections with the same name](../guide/relationships#self-referencing-collections-with-the-same-name);
- `T.f has an interface or union type, so generated inputs leave it out and generated mutations cannot set it; resolve it yourself, and mark it readOnly to state that it is output-only.`; see [what gets generated](../guide/schema#what-gets-generated);
- an input that would have no fields, which generated inputs leave out: ``Author.books has no `added` operation in generated inputs …`` (or `updated`), `Doc.stamp is left out of generated create and update inputs …`, `Doc.ref is left out of generated create inputs, because the create input of its embedded type Ref would have no fields (create inputs leave out ids), …` (generated updates still set it, so do not mark it `readOnly`), `Tag has no writable fields, so the schema has no addtag mutation; …` or `… and no writable id, so its generated update input would have no fields …`. Give the type a writable field, or create and update its records with a registered mutation whose input is not `getInputType(Type)`; a state machine type's registered mutation must also set the initial state. Mark output-only fields `readOnly`. See [what gets generated](../guide/schema#what-gets-generated);
- `the schema has a type named RelationType, the name of a type that Simfinity adds to every schema for __Field.extensions, …`: Simfinity renamed its metadata types; use the names that the warning gives in named fragments and permission maps;
- `validators.arrayLength('Tags') …` or `validators.dateFormat('Visit') does not check the format …`: a validator helper received an `itemValidator` it cannot use, or a date format it does not check; see [available helpers](../guide/validation#available-helpers).

One such warning is logged at request time, once per runtime: `the GraphQL context does not accept a count property (it is frozen, sealed or has a read-only count), so pagination counts are not reported; pass a fresh mutable context object for each request.` See [count behavior](../reference/plugins#count-behavior).

## Authorization or scope is not applied

Creating permission metadata alone does not install an authorization plugin. Add `auth.createAuthPlugin()` to your Yoga/Envelop configuration and supply the request's authenticated user in the GraphQL context.

Generated query permissions target `RootQueryType`, not `Query`. Query scopes apply to generated root reads; they do not automatically protect every nested relationship or write. See [authorization](../guide/authorization) and [query scope](../guide/query-scope) for their separate responsibilities.

`Cannot authorize type X: it was created by a different copy of the graphql module` means the schema mixes types from two graphql installations, or from its ESM and CommonJS builds. Run `npm ls graphql`, deduplicate it with your package manager's overrides or resolutions, and make your bundler resolve one entry point.

`Authorization paths must return values synchronously` means a rule helper read a promise, for example an un-awaited `ctx.user`. Await the user and claims in your context factory, or write an async rule. See [rule helpers](../guide/authorization#rule-helpers).

## A hook or middleware does not behave as expected

Global middleware runs before the operation. Throw to reject an operation; omitting `next()` only stops the middleware chain. Code after `await next()` still runs before the resolver. An error from a later middleware cancels the operation even if you catch it around `next()`. If later middleware never runs, check that `next()` is called before the middleware returns: a `next()` called from `setTimeout` or another callback after the middleware finished does nothing. See [middleware](../guide/middleware#execution-order).

Lifecycle hooks run inside the generated operation's transaction flow, before commit. Retried transactions can repeat hook execution. See [controllers and hooks](../guide/controllers) before performing external side effects there.

## An MCP tool returns an error result

Inspect `isError`, `structuredContent`, and the text content of the returned tool result. Check the tool's published name, `inputSchema`, inclusion filters, and limits. With remote execution, also check the target endpoint and authentication headers.

`MCP_UNKNOWN_ARGUMENT` means the call carried an argument the tool does not declare, often a misspelled filter; nothing ran, and the message lists the valid arguments. A tool middleware that reads its own custom argument must delete it from `call.args` before calling `next()`. `MCP_INVALID_LIMITS` and `MCP_INVALID_EXECUTION_CONFIG` at startup name the setting to fix. A GET request to the HTTP MCP endpoint gets 405 by design; mount the handler with `app.all`.

The SDK is needed for MCP transports. Tool definition generation itself can be used without starting an MCP server. See the [MCP guide](../guide/mcp) and [MCP reference](../reference/mcp).

## Still need help?

Compare your setup with the [Barber example for your database](/resources/barber), then [report a minimal reproduction](./contributing#report-a-problem) with the exact type definition and operation.
