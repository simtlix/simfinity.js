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

Generated mutations use MongoDB transactions. A standalone MongoDB server does not support them. Connect to a replica set or a sharded deployment and wait for a writable primary. The [quick start](../guide/getting-started#_2-start-mongodb) includes a local replica-set setup.

Custom mutation callbacks and `saveObject()` have different transaction responsibilities. See [mutations](../guide/mutations) and the [core API](../reference/api).

## Duplicate introspection types

Do not wrap a Simfinity schema with `graphql-middleware`'s `applyMiddleware` or rebuild it with `mapSchema`. Simfinity extends GraphQL introspection globally; rebuilding a schema can introduce duplicate introspection type names.

Use the [Envelop authorization plugin](../guide/authorization) with GraphQL Yoga, or wrap existing resolvers in place. Register application types once at startup and reuse the resulting schema.

## A relationship is empty or its input is wrong

Check that:

- Every related type was registered before `createSchema()`.
- The field declares `extensions.relation`.
- `embedded` matches how you intend to store the value.
- `connectionField` names the correct reference field; provide it explicitly.
- An existing custom resolver returns the expected value. Simfinity preserves custom resolvers.

See [relationships](../guide/relationships) for embedded, reference, and collection examples.

## Authorization or scope is not applied

Creating permission metadata alone does not install an authorization plugin. Add `auth.createAuthPlugin()` to your Yoga/Envelop configuration and supply the request's authenticated user in the GraphQL context.

Generated query permissions target `RootQueryType`, not `Query`. Query scopes apply to generated root reads; they do not automatically protect every nested relationship or write. See [authorization](../guide/authorization) and [query scope](../guide/query-scope) for their separate responsibilities.

## A hook or middleware does not behave as expected

Global middleware runs before the operation. Throw to reject an operation; omitting `next()` only stops the middleware chain. Code after `await next()` still runs before the resolver. See [middleware](../guide/middleware).

Lifecycle hooks run inside the generated operation's transaction flow, before commit. Retried transactions can repeat hook execution. See [controllers and hooks](../guide/controllers) before performing external side effects there.

## An MCP tool returns an error result

Inspect `isError`, `structuredContent`, and the text content of the returned tool result. Check the tool's published name, `inputSchema`, inclusion filters, and limits. With remote execution, also check the target endpoint and authentication headers.

The SDK is needed for MCP transports. Tool definition generation itself can be used without starting an MCP server. See the [MCP guide](../guide/mcp) and [MCP reference](../reference/mcp).

## Still need help?

Compare your setup with the [Series Sample Project](https://github.com/simtlix/series-sample), then [report a minimal reproduction](./contributing#report-a-problem) with the exact type definition and operation.
