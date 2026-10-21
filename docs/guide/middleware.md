---
title: Middleware
description: Inspect and prepare generated operations with Simfinity's global middleware chain.
---

# Middleware

Register global middleware with `simfinity.use()` to inspect arguments, enforce prerequisites, or attach request metadata before a generated operation executes.

```javascript
// simfinity is your selected runtime, initialized during application setup.

simfinity.use(async ({ operation, type, context }, next) => {
  if (operation === 'delete' && context?.user?.role !== 'admin') {
    throw new simfinity.auth.ForbiddenError('Only admins can delete records');
  }

  console.log('Preparing operation', {
    operation,
    type: type?.gqltype.name,
  });
  await next();
});
```

Register middleware once during application startup. `use()` accepts only functions; any other value, such as `null` from `enabled && middleware`, throws `INVALID_MIDDLEWARE` (500). Registrations belong to the selected runtime and apply to its generated operations. The MongoDB facade and PostgreSQL module facade each expose a default runtime; a `createPostgres()` instance owns its own registrations. Register middleware on the same runtime used to register your types.

For MongoDB, `simfinity` is the namespace imported from `@simtlix/simfinity-js`. For PostgreSQL, use the instance returned by `createPostgres()` in the [PostgreSQL quick start](./postgresql). Both expose `use()` and the shared `auth.ForbiddenError`.

## Execution order

For root reads and generated non-embedded relationship reads, the sequence is middleware, query scope, query construction, and database execution. Root mutation middleware runs before the transactional mutation handler. Custom query middleware runs before the callback, which no transaction wraps. Nested collection mutations run the target child's middleware inside that transaction before checking its persisted parent and performing the child operation.

::: warning What next() means
`next()` advances to the next registered middleware. The database resolver executes after the entire middleware chain returns. Code after `await next()` still runs before database execution, and omitting `next()` only skips the remaining middleware. Throw an error to cancel the operation.
:::

Middleware runs in registration order, and the runtime waits for the whole chain before the operation runs:

- The rest of the chain runs at most once. Calling `next()` again returns the same promise.
- The runtime awaits the rest of the chain even if a middleware calls `next()` without awaiting it, and an error from the rest of the chain cancels the operation. If the middleware awaits other work after an un-awaited `next()`, that error cancels the operation when the middleware finishes; it never becomes an unhandled rejection. If the middleware itself throws or rejects after an un-awaited `next()`, the runtime still waits for the rest of the chain to settle, then rejects the operation with the middleware's own error.
- An error thrown by a later middleware cancels the operation, even if an earlier middleware catches it around `await next()`. Use that `try`/`catch` for logging, not to recover.
- Call `next()` before your middleware returns, or before the promise it returns settles. A `next()` called after that, for example from `setTimeout(next)` or another callback, does nothing and returns a resolved promise. The remaining middleware is skipped, exactly as when `next()` is omitted, and the operation still runs. Write middleware as `async` functions that `await next()`.

Use [controllers](/guide/controllers) for before/after persistence hooks. Use your GraphQL server's execution hooks to measure complete request duration. MCP's separate [tool middleware](/reference/mcp#tool-middleware) wraps actual tool execution and has a different contract.

## Middleware context

```javascript
simfinity.use(async (params, next) => {
  const { args, operation, context } = params;
  // Mutate args or context in place when preparing the operation.
  await next();
});
```

| Property | Availability |
| --- | --- |
| `args` | GraphQL arguments: for example, `args.input` for add/update or `args.id` for delete. |
| `operation` | One of the operation values below. |
| `context` | The GraphQL request context. For nested collection children of a programmatic `saveObject()` call, the `context` passed to `saveObject()`, which is `undefined` when omitted; guard with `context?.`. |
| `type` | Registered type metadata for generated entity operations; absent for custom queries and mutations. |
| `entry` | Registered name of the custom query or custom mutation, for `custom_query` and `custom_mutation`. |
| `actionName`, `actionField` | State-machine action name and configuration for `state_changed`. |

| Operation | Trigger |
| --- | --- |
| `find` | List query or generated non-embedded collection relation. |
| `get_by_id` | Single-record query or generated non-embedded single relation with a reference. |
| `aggregate` | Aggregation query. |
| `save` | Generated add mutation or nested `added` child (including children of a `saveObject()` call). |
| `update` | Generated update mutation or nested `updated` child (including children of a `saveObject()` call). |
| `delete` | Generated delete mutation or nested `deleted` child (including children of a `saveObject()` call). |
| `state_changed` | Generated state-machine action. |
| `custom_mutation` | Custom mutation registered with `registerMutation()`. |
| `custom_query` | [Custom query](./queries#custom-queries) registered with `registerCustomQuery()`. Its callback receives a copy of `args.input` as middleware leaves it. |

## Prepare arguments

This middleware supplies default pagination for list queries that omit it:

```javascript
simfinity.use(async ({ operation, args }, next) => {
  if (operation === 'find' && !args.pagination) {
    args.pagination = { page: 1, size: 25 };
  }
  await next();
});
```

Prefer mutating the existing `args` object. Generated list queries (including their total count), aggregations and collection-relationship reads pass the `params.args` object left after the middleware chain to the query scope and the database adapter, so `find` and `aggregate` middleware may also replace it, with an object that keeps the client's filter objects, as [below](#keep-client-filter-objects). Mutations, nested collection writes and `get_by_id` reads keep the resolver's own reference, so replacing `params.args` there has no effect. With an adapter that [batches collection reads](/guide/relationships#batched-collection-reads), a generated collection read that can join a batch passes the adapter a copy of `params.args`, taken once the middleware chain and scopes finish, even when it ends up reading alone, and fields whose arguments hold the same data may share one adapter read, so change `args` before your middleware returns. Only reads that cannot join a batch pass `params.args` itself, as before: those without a context object, with an adapter that has no `findChildrenBatch` or whose `batchesChildren` returns `false`, for a parent without an ID the adapter casts unchanged, or with arguments that are not plain data, would form a key over 64 KiB or have invalid pagination. Client filter, sort and aggregation paths are checked before middleware runs, and paths that middleware adds are trusted; see [path restrictions](/guide/queries#path-restrictions). The `IS_EMPTY` and `IS_NOT_EMPTY` conditions that middleware adds read stored data through references and collections, whoever the caller is; see [client and trusted conditions](/guide/query-scope#client-and-trusted-conditions).

For record visibility, prefer the type's [query scope](/guide/query-scope). Generated relationship reads and nested collection writes invoke middleware with the target type, the same request context (for a programmatic `saveObject()` call, the `context` passed to it, possibly `undefined`), and root-compatible argument shapes. Existing custom resolvers and direct programmatic data access remain responsible for invoking their own checks. Review middleware that assumes a request only invokes it for its root operation.

## Keep client filter objects

Each list, aggregate and collection-field call receives its own copy of the client's filter arguments: field filters, relation `terms`, `AND` and `OR` groups with their conditions, and the value arrays of `IN`, `NIN` and `BTW`, whose items stay shared. A middleware that changes these in place changes only its own field's arguments, never those of another field of the request that uses the same GraphQL variable. In 3.10.0, which copied only the `AND` and `OR` groups and their `conditions` lists for each call, an in-place change to a field filter or its terms, a condition inside a group, or a value array also reached those other fields.

With an adapter that supports [emptiness through references and collections](/guide/queries#references-and-collections), as both bundled adapters do, the client's `IS_EMPTY` and `IS_NOT_EMPTY` terms and group conditions that read a reference or a collection carry the reserved key `__scope`, which middleware sees as `{ id }`. After middleware and the query's own scope, the runtime finds each of them in the final arguments and applies to it the `find` scopes of its targets, so that a record the caller may not see reads as a missing one. To keep that working:

- Change the client's filter objects in place, or copy them with a spread or `structuredClone()`, which keep the key. Append server restrictions, for example to `args.AND`, instead of assigning over a client's argument.
- Do not rebuild a client's condition from its fields, as in `{ field: c.field, operator: c.operator }`, and do not drop it, assign over it, change or remove its `__scope`, or write a `__scope` of your own.
- Do not change a marked condition's operator to one other than `IS_EMPTY` and `IS_NOT_EMPTY`, such as `EQ` with a `null` value, while its path still crosses or ends at a reference or a collection.
- Do not place one marked condition object both where it reads a reference or a collection and where it reads none, such as under a reference field and under an embedded list, since one marker cannot serve both. Place a spread copy, `{ ...condition }`, where it reads none.

A request that breaks these rules fails with `DETACHED_CLIENT_FILTER` (500), whose message names the condition's original path, before the adapter is called, so the condition never runs without its scopes. Copies of a marked condition, the same condition object under a second key where it also reads a reference or a collection, an edited path and a condition narrowed to a field of the queried record all work: the runtime reads the final path of each, a condition object placed under several keys gets the target scopes of all of them, a copy gets those of its own path, and a condition or a copy that reads no reference or collection where it is placed runs as one that middleware added. See [client and trusted conditions](/guide/query-scope#client-and-trusted-conditions).
