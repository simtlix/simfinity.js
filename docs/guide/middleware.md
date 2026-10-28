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
| `args` | GraphQL arguments: `args.input` for add/update/actions, `{ id }` for deletes; `{ id, version }` for protected root and nested deletes. |
| `operation` | One of the operation values below. |
| `context` | The GraphQL request context. For nested collection children of a programmatic `saveObject()` call, the `context` passed to `saveObject()`, which is `undefined` when omitted; guard with `context?.`. |
| `type` | Registered type metadata for generated entity operations; absent for custom queries and mutations. |
| `entry` | Registered name of the custom query or custom mutation, for `custom_query` and `custom_mutation`, and the view name for a `find` that a [named view](./queries#named-views) runs. |
| `actionName`, `actionField` | State-machine action name and configuration for `state_changed`. |

| Operation | Trigger |
| --- | --- |
| `find` | List query, named view or generated non-embedded collection relation. |
| `get_by_id` | Single-record query or generated non-embedded single relation with a reference. |
| `aggregate` | Aggregation query. |
| `save` | Generated add mutation, an `add<endpoint>` operation of a transaction mutation or nested `added` child (including children of a `saveObject()`, `updateObject()` or `transitionObject()` call). |
| `update` | Generated update mutation, an `update<endpoint>` operation of a transaction mutation or nested `updated` child (including children of a `saveObject()`, `updateObject()` or `transitionObject()` call). |
| `delete` | Generated delete mutation, a `delete<endpoint>` operation of a transaction mutation or nested `deleted` child (including children of a `saveObject()`, `updateObject()` or `transitionObject()` call). |
| `state_changed` | Generated state-machine action, also as an operation of a transaction mutation. |
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

Prefer mutating the existing `args` object. Generated list queries (including their total count), named views, aggregations and collection-relationship reads pass the `params.args` object left after the middleware chain to the query scope and the database adapter, so `find` and `aggregate` middleware may also replace it, with an object that keeps the client's filter objects, as [below](#keep-client-filter-objects). A view's `where` groups are appended after middleware, so replacing `params.args` cannot drop them. Mutations, nested collection writes and `get_by_id` reads keep the resolver's own reference, so replacing `params.args` there has no effect. With an adapter that [batches collection reads](/guide/relationships#batched-collection-reads), a generated collection read that can join a batch passes the adapter a copy of `params.args`, taken once the middleware chain and scopes finish, even when it ends up reading alone, and fields whose arguments hold the same data may share one adapter read, so change `args` before your middleware returns. Only reads that cannot join a batch pass `params.args` itself, as before: those without a context object, with an adapter that has no `findChildrenBatch` or whose `batchesChildren` returns `false`, for a parent without an ID the adapter casts unchanged, or with arguments that are not plain data, would form a key over 64 KiB or have invalid pagination. Client filter, sort and aggregation paths are checked before middleware runs, and paths that middleware adds are trusted; see [path restrictions](/guide/queries#path-restrictions). The `IS_EMPTY` and `IS_NOT_EMPTY` conditions that middleware adds read stored data through references and collections, whoever the caller is; see [client and trusted conditions](/guide/query-scope#client-and-trusted-conditions). The conditions that middleware adds are validated like the client's, before the adapter is called, so a middleware that builds a [`CONTAINS_ALL`](/guide/queries#filters-on-lists) list for each request, for example from `context.user`, must leave the condition out when that list is empty, which restricts nothing, or write `IN []` to match no record: `CONTAINS_ALL []` fails the request with `INVALID_FILTER_VALUE` (400), which the client cannot fix.

For record visibility, prefer the type's [query scope](/guide/query-scope). Generated relationship reads and nested collection writes invoke middleware with the target type, the same request context (for a programmatic `saveObject()` call, the `context` passed to it, possibly `undefined`), and root-compatible argument shapes. Existing custom resolvers and direct programmatic data access remain responsible for invoking their own checks. Review middleware that assumes a request only invokes it for its root operation.

## Operations of a transaction mutation

Each operation of a [transaction mutation](./mutations#run-several-mutations-in-one-transaction) runs the global middleware of its root with the same parameters the root receives: `type`, `args`, `operation`, `context` and, for state actions, `actionName` and `actionField`. It runs after the operation's `$K` references are resolved and its [authorization](./authorization#authorize-the-transaction-mutation) checks pass, and before its nested limit is checked and its lifecycle runs. `args` is `{ input }` or, for a delete, `{ id }` or `{ id, version }`, the same object the authorization rules saw, and middleware may rewrite it as it can for a root. The middleware runs once per operation on every attempt of a retried transaction, and the `context` is the same object for every operation and attempt, so a change that middleware makes to it is not undone by a retry.

The lifecycle helpers `updateObject()`, `deleteObject()` and `transitionObject()` skip the root record's middleware, as `saveObject()` does. Their nested collection children run their type's middleware with the `context` passed to the helper.

## Keep client filter objects

Each list, aggregate and collection-field call receives its own copy of the client's filter arguments: field filters, relation `terms`, `AND`/`OR` and `ANY`/`ALL`/`NONE` groups with their conditions, quantified field filters, and the value arrays of `IN`, `NIN`, `IIN`, `BTW` and `CONTAINS_ALL`, whose items stay shared. A middleware that changes these in place changes only its own field's arguments, never those of another field of the request that uses the same GraphQL variable. In 3.10.0, which copied only the `AND` and `OR` groups and their `conditions` lists for each call, an in-place change to a field filter or its terms, a condition inside a group, or a value array also reached those other fields.

On the bundled adapters, eligible client collection constructs, emptiness conditions and field comparisons (including top-level field filters) carry `__scope: { id }` when their absolute relation chain has a registered `find` scope. Explicit frame groups and their marked inner conditions each retain their markers. After middleware and the query's own scope the runtime checks detachments, validates final arguments, then fills the target scopes for their final paths. To preserve those scopes:

- Change the client's filter objects in place, or copy them with a spread or `structuredClone()`, which keep the key. Append server restrictions, for example to `args.AND`, instead of assigning over a client's argument.
- Do not rebuild a client's condition from its fields, as in `{ field: c.field, operator: c.operator }`, and do not drop it, assign over it, change or remove its `__scope`, or write a `__scope` of your own.
- Keep marked descendants inside marked client frames; do not move, wrap or duplicate them into an explicit `ANY`/`ALL`/`NONE` group or `quantifier` filter that middleware created without a marker. Do not park them only in ignored scalar/scalar-list terms: those terms never become predicates and cannot preserve a client condition.
- Keep a marked reference-only condition eligible for its target scope: emptiness and `valuePath` comparisons support it outside frames; an ordinary literal `shop.name EQ "S1"` there does not.
- Do not place one marked condition object both where it reads a reference or a collection and where it reads none, such as under a reference field and under an embedded list, since one marker cannot serve both. Place a spread copy, `{ ...condition }`, where it reads none.

A request that breaks these rules fails with `DETACHED_CLIENT_FILTER` (500), naming the original path, before the adapter. Valid operator/path edits that still read relations are allowed only when the final construct can receive its scope: an emptiness condition, a `valuePath` comparison, an explicit quantified group, a condition inside a frame, or shorthand through a collection outside aggregate joined prefixes J. A marked ordinary literal condition on a reference-only path outside a frame fails with the same error. For a comparison, retained markers are refilled from both final operands: changing or narrowing only the left path must preserve a right-side scope. Narrowing both operands to own fields can remove the marker; a relative scope key aliased to different target types is rejected. Changing an ordinary top-frame shorthand condition's aggregate J membership is rejected; explicit groups remain frames regardless of J, and separate emptiness constructs keep their existing rules. Conditions on unscoped collection chains need no marker, so rebuilding those remains valid. Appending a server group preserves the client filter but allows a different child witness; merge within a group when the same child is required. See [client and trusted conditions](/guide/query-scope#client-and-trusted-conditions).

## Version preconditions

With optimistic concurrency, a protected root delete and each protected nested `deleted` child receive `params.args = { id, version }`. Unprotected deletes retain `{ id }`. Update and state-action middleware keep `{ input }`, with the version in `input.version`; nested `updated` entries use the same shape. A protected collection's `deleted` input is `[RecordVersionRef]`, not `[ID]`, even when the parent is unprotected. Null entries are still skipped.

The runtime captures and validates the version after the applicable middleware and before the protected pre-read. Middleware may prepare it then, but validators, controller hooks and state actions cannot replace the captured precondition. Missing/null versions on paths that bypass GraphQL coercion raise `REQUIRED_VALUE`; invalid ones raise `INVALID_VERSION`. Keep authorization in the appropriate rules/hooks, and preserve arguments when wrapping adapters: the middleware stage does not itself prove a conditional write is atomic. See [optimistic concurrency](./concurrency).

The unreleased `elementFrames` extension resolves `$parent` against embedded containment before normalization. Both operand paths are authorized at their actual absolute fields, including unselected parent-only fields. References in bound elements and parent operands retain target `find` scopes, so hidden targets contribute null. Keep the original client filter carriers when copying or narrowing them; moving a parent comparison to another origin is not equivalent. Scope callbacks begin at their registered entity and may enter their own embedded containers; they cannot capture the caller or cross an entity boundary upward. Legacy unbound literal-vector restrictions remain. See [embedded object lists and `$parent`](./queries#embedded-object-lists-and-parent).
