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

For root reads and generated non-embedded relationship reads, the sequence is middleware, query scope, query construction, and database execution. Root mutation middleware runs before the transactional mutation handler. Nested collection mutations run the target child's middleware inside that transaction before checking its persisted parent and performing the child operation.

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
| `context` | The GraphQL request context. |
| `type` | Registered type metadata for generated entity operations; absent for custom mutations. |
| `entry` | Custom mutation name when `operation` is `custom_mutation`. |
| `actionName`, `actionField` | State-machine action name and configuration for `state_changed`. |

| Operation | Trigger |
| --- | --- |
| `find` | List query or generated non-embedded collection relation. |
| `get_by_id` | Single-record query or generated non-embedded single relation with a reference. |
| `aggregate` | Aggregation query. |
| `save` | Generated add mutation or nested `added` child. |
| `update` | Generated update mutation or nested `updated` child. |
| `delete` | Generated delete mutation or nested `deleted` child. |
| `state_changed` | Generated state-machine action. |
| `custom_mutation` | Registered custom mutation. |

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

Prefer mutating the existing `args` object. Generated list queries (including their total count), aggregations and collection-relationship reads pass the `params.args` object left after the middleware chain to the query scope and the database adapter, so `find` and `aggregate` middleware may also replace it. Mutations, nested collection writes and `get_by_id` reads keep the resolver's own reference, so replacing `params.args` there has no effect. Client filter, sort and aggregation paths are checked before middleware runs, and paths that middleware adds are trusted; see [path restrictions](/guide/queries#path-restrictions).

For record visibility, prefer the type's [query scope](/guide/query-scope). Generated relationship reads and nested collection writes invoke middleware with the target type, the same request context, and root-compatible argument shapes. Existing custom resolvers and direct programmatic data access remain responsible for invoking their own checks. Review middleware that assumes a request only invokes it for its root operation.
