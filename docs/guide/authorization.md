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

The subpath ships TypeScript declarations: `moduleResolution` `node16`, `nodenext` and `bundler` read them through the export map, and `node10` through `typesVersions`. Its named and default exports have the same types as the root `auth` namespace, and it re-exports `AuthRuleFunction`, `PermissionSchema` and the other authorization types. `requireRole()` and `requirePermission()` accept a string or an array of strings, which may be readonly, such as an `as const` list or a frozen array.

| Helper | Behavior |
| --- | --- |
| `requireAuth(userPath = 'user')` | Requires a truthy user in context; a promise is not a user. |
| `requireRole(role, options)` | Accepts a nonempty role string or nonempty array of role strings; compares exactly against the user's single role value. |
| `requirePermission(permission, options)` | Requires every permission when given a nonempty array; claims must be arrays of nonempty strings, and a standalone `'*'` entry grants all. |
| `composeRules(...rules)` | Requires every rule to pass. Needs at least one rule. |
| `anyRule(...rules)` | Requires at least one rule to pass. Needs at least one rule. |
| `isOwner(ownerField = 'userId', userIdField = 'id', options)` | Compares an owner ID on the parent result with the current user's ID. |
| `createRule(predicate, message = 'Access denied', code = 'FORBIDDEN')` | Creates a rule from a predicate; only `true` or `undefined` allows access. |
| `allow()` / `deny(message)` | Unconditionally permits or denies a field. |

`requireRole` accepts `{ userPath: 'user', rolePath: 'role' }`. `requirePermission` accepts `{ userPath: 'user', permissionsPath: 'permissions' }`. Paths may be dotted strings or synchronous extractor functions. `rolePath` resolves inside the user, so use `'profile.role'`, not `'user.profile.role'`. Both helpers copy their required lists when created; changing the original arrays later does not change the rule. User claims are checked on every call.

Rule checks are synchronous, so they never wait for a promise. An `async` extractor passed to `requireAuth`, `requireRole`, `requirePermission` or `isOwner` throws `TypeError` when the helper is created. A path that yields a promise or other thenable at runtime, including an un-awaited promise stored in the context such as `ctx.user`, denies with `TypeError` (`Authorization paths must return values synchronously; …`). GraphQL servers such as Yoga mask that error as an unexpected error and log it; filter, sort and aggregation path checks report `FORBIDDEN`; and in `anyRule` another granting rule still grants. Resolve asynchronous data in the context factory, or write an async rule with `createRule`.

The helpers never call `then()` on such a value, so a lazy query builder left un-awaited in the context, such as a Mongoose `Query` or a Knex builder, is not executed. A rejected native promise found there is handled, so it cannot crash the process. Promise detection applies only to the value at the end of the path. A promise reached partway along a path, such as `session.user` when `ctx.session` is a promise, is not detected: the check reads `undefined` and denies, with `UNAUTHENTICATED` from `requireAuth` or a denial from `isOwner`, instead of the `TypeError`, and a rejection of that promise stays your application's own.

The same applies to `{ ref }` paths in [policy expressions](#json-policy-expressions). A promise at the end of a reference path, or among the list items an `in` comparison reads, makes the comparison invalid without calling its `then()`, and a rejected native promise there is handled. `in` stops at the first matching item, so items after it are not read, and a rejection among them stays your application's own, as does the rejection of a promise reached partway along a reference path.

Invalid required roles or permissions (including `null`, `undefined`, empty strings, empty arrays, or non-string entries) throw `TypeError` when the helper is created. Malformed permission claims deny access: use `['posts:read']`, not the string `'posts:read'`. Substrings and embedded wildcard characters such as `'posts:*'` do not grant other permissions. Composition helpers and `createRule` require function arguments, and `composeRules` and `anyRule` throw `TypeError` without any rule; use `allow()` for an intentional grant. `anyRule` may continue after a denied result or error to another granting rule.

```javascript
const canEdit = auth.requireRole(['admin', 'editor'], {
  userPath: 'auth.user',
  rolePath: 'profile.role',
});
```

`isOwner` reads the resolver's parent object. A root mutation's parent is not the target record, so a root update/delete ownership check must load and validate the target in application code. Filter, sort and aggregation paths have no parent either, so `isOwner` denies them (see below). See [controllers](/guide/controllers) for mutation checks and [query scope](/guide/query-scope) for root query filtering.

Ownership IDs may be nonempty strings, finite numbers (including zero), or Mongoose `ObjectId` instances. Numbers compare by string representation and ObjectIds by hexadecimal value. Missing/null IDs, empty strings, arrays, booleans, and arbitrary objects deny access. Use a synchronous extractor to obtain a supported ID from a custom identity object.

## Filter, sort and aggregation paths

Generated list, aggregate and collection-relationship fields accept field paths in their arguments: field filters and relation `terms`, `AND`/`OR` conditions, list `sort` terms, and aggregation `groupId` and fact paths. Before the resolver runs, the plugin evaluates the read rule of every field such a path names, following related types. For example, `posts(author: { terms: [{ path: "email", operator: LIKE, value: "@" }] })` needs the `Post.author` and `User.email` rules. With the permissions above, only admins can read `internalNotes`, filter by it or sort by it. Rules resolve as for reads (exact rule, `'*'`, then the default policy), so with `defaultPolicy: 'DENY'` every type a path reaches needs a rule.

Path rules run with an `undefined` parent and empty `args`, so parent-dependent rules such as `isOwner` deny paths through their field, even for a caller who may read that value on their own record. Their `info.fieldName`, `info.parentType` and `info.returnType` identify the field being checked: for `author.email`, the email rule sees `email`, `User` and the email field's GraphQL type. The remaining operation metadata, including `info.path` and `info.fieldNodes`, still belongs to the invoking list, aggregate or collection field; a path argument is not a response selection. This preserves rules that choose permissions by field or type name. A custom rule that reads `parent` should tolerate `undefined`; if a rule throws anything other than a Simfinity or GraphQL error, the path is denied with `FORBIDDEN`. Aggregate sort terms name result keys (`groupId` or a fact name) and are not checked. Paths added by middleware or scope functions are trusted. The deprecated `createAuthMiddleware` applies the same check.

These rules add to the runtime checks that apply without the plugin: non-queryable fields and paths through scoped relationships are described under [path restrictions](/guide/queries#path-restrictions).

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

Expressions are JSON objects or booleans; strings such as `'ROLE:admin'` are not a supported policy language. Equality is strict, except that MongoDB `ObjectId` values compare by their hexadecimal string: an ObjectId matches the same ID as a string or as another ObjectId instance. Values of different types never match, such as the string `'42'` and the number `42`, or a string and a list. Such a comparison is invalid, like a missing reference, so `not` cannot turn it into a grant. `Date` values compare by time, including Dates from another realm. A Date compared with any non-null value other than a valid Date, such as an invalid Date, a number, an ISO string, a list or an object, is invalid; an invalid Date never matches, even itself. NaN matches nothing: comparing it with a non-null value is invalid, and a literal NaN operand throws `TypeError` when the rule is created. A promise or other thenable operand is invalid. `null` remains comparable with any value, including NaN and invalid Dates. Explicit `null`, `false`, `0`, and empty-string operands remain valid. For required identity checks, use `requireAuth()` or `isOwner()` explicitly; two explicit null values comparing equal do not establish ownership.

`eq` and `in` take exactly two operands. The right side of `in` must be an array or a reference to an array. A literal `in` array may contain only strings, finite numbers, bigints, booleans, `null` and MongoDB ObjectIds; the rule keeps the items it validated, so later changes to the configured array have no effect. `in` compares each item like `eq`, for plain arrays and Mongoose arrays alike. It compares Dates in referenced lists by time. When no item matches, it is invalid if any non-null item cannot be compared with the value, such as an item of another type, NaN, a thenable or a Date mismatch; it is also invalid when the value itself is a list or plain object. Literal `in` arrays cannot contain Dates or NaN. Literal operands cannot contain nested `{ ref }` values, because literals are never resolved. `allOf` and `anyOf` take arrays of valid expressions, while `not` takes one valid expression. Empty logical arrays retain their identities: `allOf: []` is true and `anyOf: []` is false. Multiple operator keys form an implicit AND.

Reference paths support the `parent`, `args`, and `ctx` roots, dotted fields, document getters, and numeric array indices. Empty segments and the `__proto__`, `prototype`, and `constructor` segments are invalid. Missing references and runtime `in` operands that are not arrays cannot become grants through negation; invalid results propagate through AND. A valid `anyOf` branch can still grant access independently, such as a published post with no logged-in user.

The factories and `createRuleFromExpression` throw `TypeError` for malformed ASTs, including unknown operators in any nested branch. `isPolicyExpression` validates the whole AST; direct `evaluateExpression` calls return `false` for malformed ASTs. Valid `false` expressions remain negatable (`{ not: false }` is true).

Created expression rules classify each operand as a literal or reference once. Adding `ref` to a literal afterwards does not turn it into a reference. Date literals are copied when the rule is created and compare by time, so later changes to the configured Date have no effect; other object literals continue to compare by identity.

## Schema integration

`createAuthPlugin` wraps resolvers in place through Envelop's `onSchemaChange` hook. A plugin instance wraps each field once, even when several schema objects share the same types, such as a `toConfig()` copy or a second `createSchema()` call. In a schema processed by other plugin instances only, its wrappers defer to theirs, so separate instances keep separate permission maps. A schema that no plugin instance processed still enforces the rules of every wrapper on its shared fields. Fields with no rule under `ALLOW` and no filter, sort or aggregation paths keep their original resolver. The plugin does not wrap introspection types or Simfinity's `extensions` field metadata types (`FieldExtensionsType` and `RelationType`, or their fallback names `SimfinityFieldExtensionsType` and `SimfinityRelationType` when an application type took those names; see [what gets generated](./schema#what-gets-generated)), so metadata introspection works under `DENY`; name those types in the permission map to protect them. A permission-map entry for an application type named `RelationType` applies to that type.

A field whose rules are all synchronous, or an unwrapped field with no rule under `ALLOW`, starts its resolver right away, before the rules of the following sibling fields run. Fields with filter, sort or aggregation paths start after those paths are checked. Keep the context values that rules read stable while resolvers run.

If the permission map has a `Query` key but the schema's query root has another name, the plugin logs a warning once.

Every schema type must come from the graphql module the plugin uses. If a schema contains types from another copy, such as a second installed graphql version or its ESM and CommonJS builds loaded together by a bundler, `onSchemaChange` throws `TypeError` (`Cannot authorize type X: it was created by a different copy of the graphql module…`) in every environment, before wrapping any field, instead of leaving those fields unprotected. Deduplicate graphql (`npm ls graphql`, then overrides or resolutions) and make the bundler resolve one entry point.

Do not apply `graphql-middleware`'s `applyMiddleware` or schema-cloning transforms such as `mapSchema` to a Simfinity schema. Simfinity extends GraphQL introspection globally, and rebuilding the schema can duplicate those introspection types. The older `createAuthMiddleware` and `createFieldMiddleware` exports are deprecated. `createFieldMiddleware` returns the same function as `createAuthMiddleware`, so wildcard rules and the default policy apply to every field.

For standalone MCP execution, install the auth plugin through `schemaPlugins`; see [MCP authorization](/guide/mcp#preserve-authorization).
