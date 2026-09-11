---
title: Authorization
description: Protect generated GraphQL operations and individual fields with Envelop permission rules.
---

# Authorization

Use the authorization plugin to decide who may execute an operation or read a field. Your application authenticates the request and supplies a trusted user in the GraphQL context; Simfinity evaluates permissions against that context.

<DomainDiagram kind="access" />

## Add the Envelop plugin

This example exposes the series catalog to authenticated users and restricts writes to editors. It assumes a connected `Serie` type with the endpoints `serie` and `series`.

```javascript
import { createYoga } from 'graphql-yoga';
import * as simfinity from '@simtlix/simfinity-js';
import { authenticate } from './authenticate.js';

const { allow, requireAuth, requireRole, createAuthPlugin } = simfinity.auth;

const permissions = {
  RootQueryType: {
    serie: requireAuth(),
    series: requireAuth(),
  },
  Mutation: {
    addserie: requireRole('editor'),
    updateserie: requireRole('editor'),
    deleteserie: requireRole('admin'),
  },
  Serie: {
    '*': allow(),
    internalNotes: requireRole('admin'),
  },
};

const yoga = createYoga({
  schema: simfinity.createSchema(),
  context: async ({ request }) => ({
    user: await authenticate(request),
  }),
  plugins: [createAuthPlugin(permissions, { defaultPolicy: 'DENY' })],
});
```

`authenticate` is application code: it should verify the incoming credentials and return a user or `null`. A typical user for these rules is `{ id: '...', role: 'editor' }`.

::: warning Use the generated root name
The generated query type is named `RootQueryType`. Permission keys must match the schema's actual type names. A `Query` key will not match Simfinity's generated query root.
:::

With `defaultPolicy: 'DENY'`, every field without a matching rule is denied, including fields on returned objects. Add permissions for related object types and `QLTypeAggregationResult` if you expose those results. The `series_aggregate` endpoint is deliberately absent from this example and remains denied.

## Permission resolution

Rules resolve in this order: an exact field entry, the type's `'*'` entry, then the default policy. A field-specific rule replaces the wildcard; it does not automatically combine with it.

A permission value can be a function, an array of rules that must all pass, or a JSON policy expression. Rule functions receive `(parent, args, context, info)`. Return `true` or `undefined` to allow access, return `false` to deny, or throw an error.

## Rule helpers

All helpers below are available on `simfinity.auth`.

| Helper | Behavior |
| --- | --- |
| `requireAuth(userPath = 'user')` | Requires a truthy user in context. |
| `requireRole(role, options)` | Accepts one role or an array of allowed roles; compares against the user's single role value. |
| `requirePermission(permission, options)` | Requires every permission when given an array; a user permission of `'*'` grants all. |
| `composeRules(...rules)` | Requires every rule to pass. |
| `anyRule(...rules)` | Requires at least one rule to pass. |
| `isOwner(ownerField = 'userId', userIdField = 'id', options)` | Compares an owner ID on the parent result with the current user's ID. |
| `createRule(predicate, message = 'Access denied', code = 'FORBIDDEN')` | Creates a rule from a predicate; return an explicit boolean. |
| `allow()` / `deny(message)` | Unconditionally permits or denies a field. |

`requireRole` accepts `{ userPath: 'user', rolePath: 'role' }`. `requirePermission` accepts `{ userPath: 'user', permissionsPath: 'permissions' }`. Paths may be dotted strings or extractor functions. `rolePath` resolves inside the user, so use `'profile.role'`, not `'user.profile.role'`.

```javascript
const canEdit = simfinity.auth.requireRole(['admin', 'editor'], {
  userPath: 'auth.user',
  rolePath: 'profile.role',
});
```

`isOwner` reads the resolver's parent object. A root mutation's parent is not the target record, so a root update/delete ownership check must load and validate the target in application code. See [controllers](/guide/controllers) for mutation checks and [query scope](/guide/query-scope) for root query filtering.

## JSON policy expressions

Policies support `eq`, `in`, `allOf`, `anyOf`, and `not`. Values may reference `parent`, `args`, or `ctx`.

```javascript
const permissions = {
  Mutation: {
    updateserie: {
      anyOf: [
        { eq: [{ ref: 'ctx.user.role' }, 'admin'] },
        { in: ['series:write', { ref: 'ctx.user.permissions' }] },
      ],
    },
  },
};
```

These are JSON objects; strings such as `'ROLE:admin'` are not a supported policy language. Equality is strict, so normalize IDs before comparing an ObjectId to a string. For required identity checks, use `requireAuth()` explicitly.

## Schema integration

`createAuthPlugin` wraps resolvers in place through Envelop's `onSchemaChange` hook. Reusing the same plugin and schema does not wrap it twice.

Do not apply `graphql-middleware`'s `applyMiddleware` or schema-cloning transforms such as `mapSchema` to a Simfinity schema. Simfinity extends GraphQL introspection globally, and rebuilding the schema can duplicate those introspection types. The older `createAuthMiddleware` and `createFieldMiddleware` exports are deprecated.

For standalone MCP execution, install the auth plugin through `schemaPlugins`; see [MCP authorization](/guide/mcp#preserve-authorization).
