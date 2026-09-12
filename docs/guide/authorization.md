---
title: Authorization
description: Protect generated GraphQL operations and individual fields with Envelop permission rules.
---

# Authorization

Use the authorization plugin to decide who may execute an operation or read a field. Your application authenticates the request and supplies a trusted user in the GraphQL context; Simfinity evaluates permissions against that context.

<DomainDiagram kind="access" />

## Add the Envelop plugin

This example exposes the series catalog to authenticated users and restricts writes to editors. It assumes a connected `Serie` type with the endpoints `serie` and `series`. Export the initialized schema from `schema.js` for either database. For PostgreSQL, await `initializeDatabase()` before serving requests, as in the [PostgreSQL quick start](./postgresql).

```javascript
import { createYoga } from 'graphql-yoga';
import * as auth from '@simtlix/simfinity-core/auth';
import { schema } from './schema.js';
import { authenticate } from './authenticate.js';

const { allow, requireAuth, requireRole, createAuthPlugin } = auth;

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
  schema,
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

A permission value can be a function, a nonempty array of rules that must all pass (including nested nonempty arrays), a JSON policy expression, or a boolean. Rule functions receive `(parent, args, context, info)`. Only `true` and `undefined` allow access. Every other return value, including `false`, `null`, `0`, an empty string, or an object, denies access. Throwing also denies access. The same contract applies to `composeRules`, `anyRule`, and `createRule`, including async results.

Permission maps must be plain objects or objects with a null prototype; only own entries participate in rule resolution. `defaultPolicy` must be exactly `'ALLOW'` or `'DENY'` and defaults to `'DENY'`. The plugin and legacy middleware factories throw `TypeError` for invalid permission maps, configured rules, empty rule arrays, malformed expressions, or invalid default policies. This validation happens when the factory is called, before serving requests. Only absent entries use the default policy; an explicit `null`, `undefined`, or unknown object cannot fall back to `ALLOW`. Use `allow()` or `true` for an intentional grant.

## Rule helpers

All helpers below are exported by `@simtlix/simfinity-core/auth` and are also available on the selected runtime’s `auth` namespace.

| Helper | Behavior |
| --- | --- |
| `requireAuth(userPath = 'user')` | Requires a truthy user in context. |
| `requireRole(role, options)` | Accepts a nonempty role string or nonempty array of role strings; compares exactly against the user's single role value. |
| `requirePermission(permission, options)` | Requires every permission when given a nonempty array; claims must be arrays of nonempty strings, and a standalone `'*'` entry grants all. |
| `composeRules(...rules)` | Requires every rule to pass. |
| `anyRule(...rules)` | Requires at least one rule to pass. |
| `isOwner(ownerField = 'userId', userIdField = 'id', options)` | Compares an owner ID on the parent result with the current user's ID. |
| `createRule(predicate, message = 'Access denied', code = 'FORBIDDEN')` | Creates a rule from a predicate; only `true` or `undefined` allows access. |
| `allow()` / `deny(message)` | Unconditionally permits or denies a field. |

`requireRole` accepts `{ userPath: 'user', rolePath: 'role' }`. `requirePermission` accepts `{ userPath: 'user', permissionsPath: 'permissions' }`. Paths may be dotted strings or extractor functions. `rolePath` resolves inside the user, so use `'profile.role'`, not `'user.profile.role'`.

Invalid required roles or permissions (including `null`, `undefined`, empty strings, empty arrays, or non-string entries) throw `TypeError` when the helper is created. Malformed permission claims deny access: use `['posts:read']`, not the string `'posts:read'`. Substrings and embedded wildcard characters such as `'posts:*'` do not grant other permissions. Composition helpers and `createRule` require function arguments; `anyRule` may continue after a denied result or error to another granting rule.

```javascript
const canEdit = auth.requireRole(['admin', 'editor'], {
  userPath: 'auth.user',
  rolePath: 'profile.role',
});
```

`isOwner` reads the resolver's parent object. A root mutation's parent is not the target record, so a root update/delete ownership check must load and validate the target in application code. See [controllers](/guide/controllers) for mutation checks and [query scope](/guide/query-scope) for root query filtering.

Ownership IDs may be nonempty strings, finite numbers (including zero), or Mongoose `ObjectId` instances. Numbers compare by string representation and ObjectIds by hexadecimal value. Missing/null IDs, empty strings, arrays, booleans, and arbitrary objects deny access. Use an extractor to obtain a supported ID from a custom identity object.

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

Expressions are JSON objects or booleans; strings such as `'ROLE:admin'` are not a supported policy language. Equality is strict, so normalize IDs before comparing an ObjectId to a string. Explicit `null`, `false`, `0`, and empty-string operands remain valid. For required identity checks, use `requireAuth()` or `isOwner()` explicitly; two explicit null values comparing equal do not establish ownership.

`eq` and `in` take exactly two operands. The right side of `in` must be an array or a reference to an array. `allOf` and `anyOf` take arrays of valid expressions, while `not` takes one valid expression. Empty logical arrays retain their identities: `allOf: []` is true and `anyOf: []` is false. Multiple operator keys form an implicit AND.

Reference paths support the `parent`, `args`, and `ctx` roots, dotted fields, document getters, and numeric array indices. Empty segments and the `__proto__`, `prototype`, and `constructor` segments are invalid. Missing references and runtime `in` operands that are not arrays cannot become grants through negation; invalid results propagate through AND. A valid `anyOf` branch can still grant access independently, such as a published post with no logged-in user.

The factories and `createRuleFromExpression` throw `TypeError` for malformed ASTs, including unknown operators in any nested branch. `isPolicyExpression` validates the whole AST; direct `evaluateExpression` calls return `false` for malformed ASTs. Valid `false` expressions remain negatable (`{ not: false }` is true).

## Schema integration

`createAuthPlugin` wraps resolvers in place through Envelop's `onSchemaChange` hook. Reusing the same plugin and schema does not wrap it twice.

Do not apply `graphql-middleware`'s `applyMiddleware` or schema-cloning transforms such as `mapSchema` to a Simfinity schema. Simfinity extends GraphQL introspection globally, and rebuilding the schema can duplicate those introspection types. The older `createAuthMiddleware` and `createFieldMiddleware` exports are deprecated.

For standalone MCP execution, install the auth plugin through `schemaPlugins`; see [MCP authorization](/guide/mcp#preserve-authorization).
