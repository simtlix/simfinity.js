---
title: Middleware
description: Inspect and prepare generated operations with Simfinity's global middleware chain.
---

# Middleware

Register global middleware with `simfinity.use()` to inspect arguments, enforce prerequisites, or attach request metadata before a generated operation executes.

```javascript
import * as simfinity from '@simtlix/simfinity-js';

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

Register middleware once during application startup. Registrations are global to the loaded Simfinity module and apply to its generated operations.

## Execution order

For root reads and generated non-embedded relationship reads, the sequence is middleware, query scope, query construction, and database execution. Root mutation middleware runs before the transactional mutation handler. Nested collection mutations run the target child's middleware inside that transaction before checking its persisted parent and performing the child operation.

::: warning What next() means
`next()` advances to the next registered middleware. The database resolver executes after the entire middleware chain returns. Code after `await next()` still runs before database execution, and omitting `next()` only skips the remaining middleware. Throw an error to cancel the operation.
:::

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

Mutate the existing `args` object. Replacing `params.args` is not a reliable way to replace the resolver's arguments, because the resolver retains its own reference.

For record visibility, prefer the type's [query scope](/guide/query-scope). Generated relationship reads and nested collection writes invoke middleware with the target type, the same request context, and root-compatible argument shapes. Existing custom resolvers and direct programmatic data access remain responsible for invoking their own checks. Review middleware that assumes a request only invokes it for its root operation.
