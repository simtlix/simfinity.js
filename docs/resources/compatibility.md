---
title: Compatibility and releases
description: Runtime requirements, documentation version, releases and upgrade checks for Simfinity.js.
---

<script setup>
import library from '../../package.json';
</script>

# Compatibility and releases

This documentation covers Simfinity.js **{{ library.version }}**, for **MongoDB and PostgreSQL**. All five packages are versioned and released together.

## Package availability

| Package | Purpose | Release |
| --- | --- | --- |
| [@simtlix/simfinity-js](https://www.npmjs.com/package/@simtlix/simfinity-js) | MongoDB facade, including compatibility exports | {{ library.version }} |
| [@simtlix/simfinity-postgres](https://www.npmjs.com/package/@simtlix/simfinity-postgres) | PostgreSQL adapter with generated schema and FKs | {{ library.version }} |
| [@simtlix/simfinity-sql](https://www.npmjs.com/package/@simtlix/simfinity-sql) | Driver-free relational runtime and plugin contract | {{ library.version }} |
| [@simtlix/simfinity-core](https://www.npmjs.com/package/@simtlix/simfinity-core) | Shared runtime and helpers | {{ library.version }} |
| [@simtlix/simfinity-mcp](https://www.npmjs.com/package/@simtlix/simfinity-mcp) | Optional MCP integration for either database | {{ library.version }} |

Follow [installation and downloads](../guide/databases#install-from-npm) or read the [latest stable release notes](https://github.com/simtlix/simfinity.js/releases/latest).

## Requirements

| Component | Requirement |
| --- | --- |
| Library runtime | Node.js 18.18.0 or newer; use a maintained release for a new application |
| GraphQL peer | `^16.11.0` |
| MongoDB facade | Mongoose `^8.24.2`; MongoDB 7 or 8 replica set/sharded cluster for mutations |
| PostgreSQL facade | PostgreSQL 15, 16, or 18; `pg` `^8.16.3` |
| Downloadable starters | Node.js 22 or newer, npm and the database selected in the corresponding quick start |
| MCP tool generation | Opt-in `@simtlix/simfinity-mcp`; the SDK is needed for MCP transports |
| Documentation development | Node.js 22 or newer |

## Upgrade to 3.5.3

Version 3.5.3 includes the runtime, authorization, scalar and MCP fixes below. Keep all directly installed Simfinity packages at 3.5.3. When upgrading from an earlier version, also review the [3.5.2 notes](#upgrade-to-3-5-2) below.

### New startup errors

These errors are raised while the application starts. Most of them replace configurations that previously started and then misbehaved on requests:

- `TYPE_BOUND_TO_OTHER_RUNTIME` (409): the first schema a runtime builds claims two kinds of `GraphQLObjectType`: the types whose relation fields receive its generated resolvers, and the reachable types that still have a non-embedded relation field without a resolver, such as an unregistered custom mutation result. Registering a claimed type in another runtime with `connect()` or `addNoEndpointType()`, or building another runtime's schema that reaches it through fields, interfaces, union members or custom mutation results, now throws. `createSchema()` also rejects a type with a relation field copied after another runtime generated its resolver, by `new GraphQLObjectType(Type.toConfig())` or a `...Type.toConfig().fields` spread, including a spread inside a `fields` thunk that runs later. Previously the second runtime silently read those relations through the first runtime's adapter and middleware, or `createSchema()` failed with a duplicate `QLFilter` type. Create type objects once per runtime, for example with a factory function. See [types belong to one runtime](../guide/schema#types-belong-to-one-runtime).
  - Types without non-embedded relation fields, and types whose relation fields all have your own resolvers, can still be shared. A `toConfig()` copy made before the first runtime built its schema can still be used by another runtime.
  - A copied relation field from which you removed the resolver still builds, as in 3.5.2, and gets the second runtime's resolver. A copied object field with your own resolver is rejected if it keeps the copied `extensions` object; give it a new one.
  - A shared custom mutation result type that is not registered and has a non-embedded relation field without a resolver is now rejected in the second runtime, although no resolvers are generated for it; in 3.5.2 both schemas built. Create the result type per runtime, or give its relation field your own resolver.
  - When Simfinity generates a relation resolver, it also gives the field a new `extensions` object with a null prototype and the same entries. For single relation fields, a reference to `field.extensions` taken before `createSchema()` no longer points at the field's extensions, so changes made through it are ignored; read `Type.getFields()[name].extensions` again after `createSchema()`. List relation fields previously got an `extensions` object with `Object.prototype`; it now has a null prototype, like the `extensions` of every other GraphQL field, so use `Object.hasOwn(field.extensions, key)` instead of `field.extensions.hasOwnProperty(key)`.
- `INVALID_SCOPE` (500): `extensions.scope` must be a plain object whose keys are `find`, `get_by_id` or `aggregate` and whose values are functions. `connect()`, `addNoEndpointType()` and `createSchema()` reject anything else, including misspelled keys such as `getById` or `findAll`, a key set to `undefined` such as `{ find: undefined }` (which the `TypeScopes` type accepts), arrays, a bare function, class instances, and `scope: undefined` or `scope: null`. Non-enumerable keys are checked too. Previously these scopes were skipped, so reads ran without the restriction. See the [scope contract](../guide/query-scope#callback-contract).
- `INVALID_MIDDLEWARE` (500): `use()` accepts only functions. Previously a `null` or `undefined` entry silently skipped the middleware registered after it, and other values failed each operation.
- `UNREGISTERED_RELATION_TARGET` (500): a list relation, embedded object or embedded list whose type was not registered with `connect()` or `addNoEndpointType()` now fails `createSchema()` with a message naming the field as `Type.field`. Previously it failed with a `TypeError`. Single references to unregistered types, and read-only lists with their own resolver, still build.
- `MCP_INVALID_SCHEMA_PLUGIN`, `MCP_UNSUPPORTED_SCHEMA_REPLACEMENT` and `MCP_INVALID_MIDDLEWARE` (500) are thrown when MCP tools, servers or HTTP handlers are created; see [MCP](#mcp) below.
- `createAuthPlugin` throws `TypeError` from `onSchemaChange`, before wrapping any field, when a schema type comes from another copy of the graphql module; see [authorization](#authorization) below.
- `requireAuth`, `requireRole`, `requirePermission` and `isOwner` throw `TypeError` when the helper is created with an `async` extractor function; see [authorization](#authorization) below.
- A policy expression with a literal NaN operand, such as `{ eq: [{ ref: 'ctx.user.score' }, NaN] }`, makes `createAuthPlugin`, the deprecated `createAuthMiddleware` and `createRuleFromExpression` throw `TypeError` when they are called.
- `validators.pattern()` and `scalars.createPatternStringScalar()` throw `TypeError` (`pattern must be a RegExp or a string`) when created with any other pattern, including a custom matcher object with a `test()` method, which 3.5.2 used as is; see [validated scalars and pattern helpers](#validated-scalars-and-pattern-helpers) below.
- The new opt-in `configureMutationLimits()` throws `INVALID_MUTATION_LIMITS` (400) for invalid options; see [runtime behavior](#runtime-behavior) below.

### Runtime behavior

- A scope changed after `createSchema()` into an invalid shape now fails every read of that type with `INVALID_SCOPE`, including relation reads and filter paths that join it. Previously it was skipped. Omit a key, or the whole `scope` property, to leave an operation unscoped.
- The middleware chain is awaited even when a middleware calls `next()` without awaiting it, including when that middleware awaits other work afterwards, so an error from a later middleware cancels the operation instead of becoming an unhandled rejection. A middleware that throws after such a `next()` call rejects the operation with its own error once the rest of the chain settles. Calling `next()` twice runs the rest of the chain once. An error from the rest of the chain now cancels the operation even when a middleware catches it. Omitting `next()` still skips only the remaining middleware.
- A `next()` called after its middleware has finished, for example from `setTimeout(next)` or another callback, now does nothing and returns a resolved promise. Previously it started the remaining middleware after the operation had already run, and their errors became unhandled rejections. Call `next()` before the middleware returns, preferably as `await next()`. See [middleware](../guide/middleware#execution-order).
- New opt-in `configureMutationLimits({ maxNestedOperations })` caps the nested `added`, `updated` and `deleted` entries of one generated mutation. It is process-wide and unlimited by default, so nothing changes until you set it. Invalid options, including unknown or misspelled keys such as `maxNestedOperation`, throw `INVALID_MUTATION_LIMITS` (400) and keep the current limit. See [limit nested collection operations](../guide/mutations#limit-nested-collection-operations).

### Error formatting

`buildErrorFormatter()` now returns a `GraphQLError` instead of the Simfinity error, and classifies the errors GraphQL servers pass to it:

- For a field error, the `GraphQLError` that graphql-js creates around a value a resolver threw, it classifies the thrown value. A `SimfinityError` thrown by a resolver therefore keeps its code when the server passes the wrapping error. Previously the result was `INTERNAL_SERVER_ERROR`.
- Request errors from syntax, validation and variable coercion become `BAD_REQUEST` (400) instead of `INTERNAL_SERVER_ERROR`, unless the server already set a code, which they keep, such as Yoga's `GRAPHQL_PARSE_FAILED` or Apollo Server's `GRAPHQL_VALIDATION_FAILED` and `BAD_USER_INPUT`. This includes input rejected by built-in scalars and by Simfinity's validated scalars, such as an invalid `EmailScalar` value, whether sent as a variable or an inline literal. They keep their original message, including the `Variable "$x" got invalid value … at "x.path"` prefix, and their extensions, such as the `http` status Yoga adds, so the documented Yoga integration responds with HTTP 400 for invalid variables. Yoga does not pass validation errors, including invalid inline literals, to `maskError`, so they keep Yoga's response. A `SimfinityError` thrown by a custom scalar supplies only the code and status.
- A scalar literal validation error may wrap a plain `Error` with the same message, with or without AST nodes. It remains a request error. A subscription source failure that a server reports without `path` is indistinguishable from that input error: mark unexpected stream failures as `InternalServerError` at their source, or use an execution-aware server hook. For a path-less GraphQL error, the formatter preserves an explicit internal cause through nested GraphQL wrappers for masking. An unmarked path-less GraphQL error keeps its message; see [server differences](../reference/errors#server-differences).
- A `GraphQLError` raised while resolving a field keeps its message and extensions when it has its own string `extensions.code` or a `SimfinityError` cause. Its code is that of the `SimfinityError` cause, or its own `extensions.code`; its status is the cause's, or its integer `extensions.status`, or 500 for `INTERNAL_SERVER_ERROR` and 400 for other codes. Its `originalError`, such as a database error behind a safe message, is never exposed. Previously such errors became `INTERNAL_SERVER_ERROR`. A `GraphQLError` without either, such as one a resolver throws without a code, with or without its own `path`, is still an `InternalServerError` (`INTERNAL_SERVER_ERROR`), as in 3.5.2; give it an `extensions.code` to show its message to clients. This also applies to the errors graphql-js raises when it cannot complete a resolved value, such as a built-in scalar that cannot serialize it or a failed `isTypeOf` check, whose messages can print the value.
- A value that is not an `Error`, including one a resolver throws, becomes `Unexpected error value` with no cause, and the value is no longer printed in the message, when graphql-js's own executor wraps it. Yoga's executor first turns such a value into an `Error` with the value's text, which then becomes an `InternalServerError` with that message; mask `InternalServerError` in the callback.
- The result keeps the input's locations and path, sets `originalError` to the classified error, and serializes to `{ message, locations, path, extensions }` without the cause.

Code that compared the result with its input, checked `instanceof SimfinityError`, or called `getCode()` on it should read `formatted.originalError` and `formatted.extensions.code` instead. The callback still receives the classified `SimfinityError`. To mask unexpected errors in it, check `error instanceof InternalServerError`, not `error.getCode() === 'INTERNAL_SERVER_ERROR'`: an application error can carry that code without being an `InternalServerError`, and then has no `getCause()`. Do not pass the formatter directly to Envelop's `useErrorHandler`. See [buildErrorFormatter](../reference/errors#builderrorformatter) and [server integration](../reference/errors#connect-it-to-your-server).

### Validated scalars and pattern helpers

- Validated scalars parse variables with their base scalar before calling the validation callback, as they already did for inline literals. The callback now receives the internal value for variables too, such as a `Date` from a DateTime base or a string from an ID base, and in a chain the innermost callback runs first. A variable of the wrong type reports the base scalar's error: `EmailScalar` given `5` reports `String cannot represent a non string value: 5` instead of `Invalid email format`. Input the base rejects by returning `undefined` is reported by GraphQL without calling the callback. See [createValidatedScalar](../reference/scalars#createvalidatedscalar).
- Inline literal kinds follow the root of the chain of validated scalars. A scalar built on `PositiveIntScalar` now accepts `4`, one built on `PositiveFloatScalar` accepts `4.5`, and one on a Boolean-based scalar accepts `true`; previously these chains rejected every inline literal. When the root is a custom scalar, such as DateTime, its `parseLiteral` decides which literals are valid instead of requiring a string, even if you set a `baseScalarType` storage hint on that scalar. See [literal behavior](../reference/scalars#literal-behavior).
- Float-rooted validated scalars, such as `PositiveFloatScalar`, `createBoundedFloatScalar()` scalars and chains built on them, now accept integer literals such as `4`, as `GraphQLFloat` does. Previously they required a float literal such as `4.0`. This also fixes MCP tools with an argument of such a scalar and an integral default, such as `defaultValue: 5`, which failed on every call.
- `validators.pattern()` and `scalars.createPatternStringScalar()` copy the pattern when they are created and test each value from its first character. A `g` flag no longer rejects every other value, a `y` flag no longer depends on the previous value, and your `RegExp` object is not changed. A pattern that is not a `RegExp` or a string throws `TypeError` when the helper is created; previously objects with a `test` method were used as is, and other values failed every validation.
- `validators.url()` no longer writes rejected input and its stack trace to the console.

### Authorization

- `requireAuth`, `requireRole`, `requirePermission` and `isOwner` accept dotted paths or synchronous extractor functions. An `async` extractor throws `TypeError` when the helper is created. A path that yields a promise at runtime, such as an un-awaited `ctx.user`, denies with `TypeError` (`Authorization paths must return values synchronously; …`). Previously `requireAuth()` granted access for a pending user promise. The helpers never call `then()` on the value, so a lazy query builder such as a Mongoose `Query` left in the context is not executed. Resolve asynchronous identity data in the context factory. See [rule helpers](../guide/authorization#rule-helpers).
- `createAuthPlugin` rejects a schema that contains types from another copy of the graphql module, such as a second installed version or its ESM and CommonJS builds loaded together, with `TypeError` (`Cannot authorize type X: it was created by a different copy of the graphql module…`). This happens in every environment and also when MCP applies `schemaPlugins`. Previously those fields were left unprotected. Install one graphql version and load it through one entry point. See [schema integration](../guide/authorization#schema-integration).
- Policy expressions compare `Date` values by time. A Date compared with any non-null value that is not a valid Date is invalid, an invalid Date never matches, and Date literals are copied when the rule is created. NaN never matches: comparing it with a non-null value is invalid, and a literal NaN operand throws `TypeError` when the rule is created. Promise operands are invalid. A rejected native promise that a reference yields, or that an `in` comparison reads from a list, is now handled, so it no longer crashes the process with an unhandled rejection. See [JSON policy expressions](../guide/authorization#json-policy-expressions).

### MCP

- `schemaPlugins` entries are validated before any hook runs. A non-array value, a function (pass the factory's result, such as `createAuthPlugin(permissions)`), an array, a promise (an object with a `then` method or getter), a non-function `onSchemaChange` or an object with no plugin hooks throws `MCP_INVALID_SCHEMA_PLUGIN`. So does a misspelling of `onSchemaChange` on a plugin that lacks a function `onSchemaChange`: an own or inherited method or getter whose name starts with `onSchema` in any letter case, or is at most two edits from `onSchemaChange` ignoring case, such as `onSchemaChanged`, `onschemaChange`, `onSchemChange` or `onShemaChange`. The message asks whether you meant `onSchemaChange`. Helpers such as `onSchemaReady` or `onSchemaChangeImpl` next to a function `onSchemaChange` are accepted. `false`, `null` and `undefined` entries are skipped. A plugin with hooks MCP does not run, such as the count plugin's `onExecute`, gets one console warning that names them. Validation reads only `onSchemaChange` directly and inspects every other property, `then` included, through its descriptor, so it calls no other getter.
- In TypeScript, `schemaPlugins` also accepts typed Envelop and Yoga `Plugin` arrays, class instances, including ones with `call` or `apply` members, and interface-typed plugins through the new exported `SchemaPluginObject` type, without a cast. A function, such as an uncalled plugin factory, is still a compile error, and so is a promise. Function entries are excluded through `Symbol.hasInstance`, so they compile with a `lib` setting older than ES2015, but are still rejected at runtime.
- `replaceSchema` with a different schema throws `MCP_UNSUPPORTED_SCHEMA_REPLACEMENT`; previously the call was ignored.
- An asynchronous `onSchemaChange` is awaited. `createMCPServer`, `startStdioMCPServer` and `createHTTPMCPHandler` resolve after it finishes and reject if it fails. `generateMCPTools` stays synchronous; its tool calls wait for installation and reject with the installer's error. A failed installer no longer crashes the process with an unhandled rejection.
- `toolMiddleware` accepts a single function, which now runs as a one-element stack; previously it was skipped or failed every call. A non-array value or a non-function entry, including `null` from `condition && middleware` and an empty slot in a sparse array such as `[a, , b]`, throws `MCP_INVALID_MIDDLEWARE` at setup with the entry's index. The stack is copied at setup, so later changes to the array have no effect.
- `createHTTPMCPHandler` now throws `MCP_INVALID_LIMITS` when the handler is created, instead of failing every request.
- Validated scalars built on other validated scalars publish their root JSON type in tool schemas, for example `integer` for a scalar built on `PositiveIntScalar`, instead of an empty schema. A custom scalar's description now appears in tool input and output schemas unless the field or argument has its own description.

See the [MCP reference](../reference/mcp) for the complete setup contract.

## Upgrade to 3.5.2

Keep all directly installed Simfinity packages at 3.5.2. When upgrading from an earlier version, also review the [3.5.1 notes](#upgrade-to-3-5-1) and [3.5.0 notes](#upgrade-to-3-5-0) below.

These authorization changes apply to `@simtlix/simfinity-core/auth` and the runtime `auth` namespaces:

- Policy expressions compare MongoDB `ObjectId` values by their hexadecimal string in `eq` and `in`, and `in` compares items the same way for plain arrays and Mongoose arrays. Comparing values of different types, such as `'42'` with `42` or a string with a list, is invalid, so `not` no longer turns it into a grant; `null` remains comparable with any value. A list or plain object on the left of `in` is invalid. Policies that already compare normalized strings behave as before. See [JSON policy expressions](../guide/authorization#json-policy-expressions).
- A literal `in` array may contain only strings, finite numbers, bigints, booleans, `null` and MongoDB ObjectIds, and literal operands cannot contain nested `{ ref }` values. Such policies now throw `TypeError` at configuration time. A rule keeps the list items it validated; later changes to the configured array have no effect.
- Created expression rules fix each operand as a literal or reference at configuration time. Adding a `ref` property to a literal later does not reinterpret it; object literals still compare by identity. `requireRole` and `requirePermission` also keep copies of their validated required lists, so later changes to the caller's arrays do not alter access requirements. User claims are checked on each call.
- `composeRules()` and `anyRule()` throw `TypeError` when called without rules. Use `allow()` for an intentional grant.
- `anyRule` executes decorated, proxied and bound rules in full, preserving any additional authorization checks they perform.
- `createAuthPlugin` wraps each field once per plugin instance. In a schema processed by other plugin instances only, its wrappers defer to theirs, so separate instances no longer combine their rules on shared types; a schema no instance processed still enforces every wrapper. Allowed fields without rules or query paths keep their original resolver. Simfinity's `extensions` metadata introspection is no longer denied under `DENY`, unless the permission map names `FieldExtensionsType` or `RelationType`. A field whose rules are all synchronous, or an unwrapped field with no rule under `ALLOW`, starts its resolver before the rules of the following sibling fields run; keep the context values that rules read stable while resolvers run. See [schema integration](../guide/authorization#schema-integration).
- The deprecated `createFieldMiddleware` returns the same function as `createAuthMiddleware`, so `'*'` rules and the default policy apply to every field instead of only the named ones.
- Root-query permissions must use the schema's type name. Simfinity names its query root `RootQueryType`; the plugin warns once when a permission map uses `Query` for a schema without that type.

## Upgrade to 3.5.1

Keep all directly installed Simfinity packages at 3.5.1. When upgrading from an earlier version than 3.5.0, also review the [3.5.0 notes](#upgrade-to-3-5-0) below.

- Generated MongoDB models store numeric and boolean enum values as numbers and booleans instead of strings. Documents written by earlier versions need a one-time conversion before lists, filters and aggregations match them; unique enum fields must be converted before new writes. See [What gets generated](../guide/schema#what-gets-generated).
- An embedded MongoDB type can declare a field named `type`.

## Upgrade to 3.5.0

Keep all directly installed Simfinity packages at 3.5.0 and review these behavior changes:

- Client filter, sort and aggregation paths now enforce field read rules and related-type scopes. Rules receive the identity of each path field in `info.fieldName`, `info.parentType` and `info.returnType`, with no parent and empty arguments. Parent-dependent rules deny such paths. See [authorization](../guide/authorization#filter-sort-and-aggregation-paths) and [scope restrictions](../guide/query-scope#relationship-paths-in-filters-sorts-and-aggregations).
- Fields with an application-defined resolver reject these paths unless they set `extensions.queryable: true`; `queryable: false` blocks paths regardless of the resolver. Remove manual relationship resolvers that only load stored references, or explicitly allow querying fields whose resolver returns the stored value. `readOnly` still controls mutation inputs only. See [path restrictions](../guide/queries#path-restrictions).
- Generated single-reference reads can batch within an object request context. Scoped targets and Mongoose models with any `find` or `findOne` pre/post hook retain individual reads, including when both operations share a hook function. See [relationships](../guide/relationships#query-related-records).
- MongoDB uses the application's GraphQL and Mongoose peers. Install the optional MCP SDK explicitly for transports; `graphql-middleware` is no longer installed by Simfinity. See [installation](../guide/databases#install-from-npm).
- Embedded updates enforce required fields when constructing replacement objects or list items; existing embedded objects still accept valid partial patches. SQL sessions reject statements after their callback settles, and a failed rollback discards the connection. See [mutations](../guide/mutations) and the [SQL plugin contract](../guide/sql-plugins#plugin-contract-version-1).

The current [downloadable starters](../guide/databases#download-the-starters) use 3.5.3. Historical archives and the Barber examples retain their documented package pins; upgrade all their Simfinity dependencies together before relying on newer library behavior.

## Upgrade from 3.2.0

Version 3.3.0 extracts the SQL runtime and adds `postgresPlugin` without changing existing PostgreSQL entry points or generated physical storage. Keep `createPostgres`, or use the explicit [SQL plugin API](../guide/sql-plugins). An unchanged 3.2.0 domain requires no generated-schema migration for this extraction. All Simfinity packages installed together should use the same version. PostgreSQL is currently the only supported SQL plugin.

## Before upgrading

Check the [release history](https://github.com/simtlix/simfinity.js/releases) and the [npm package](https://www.npmjs.com/package/@simtlix/simfinity-js), then read changes between your installed version and the version you intend to use.

Exercise the operations your application relies on: generated names and input shapes, relationships, permissions, scopes, custom mutations, state actions and MCP allowlists. Keep GraphQL and the selected adapter within supported ranges. PostgreSQL adoption also requires reviewing stronger `NOT NULL`, FK, uniqueness, embedded-shape, and UUID constraints, plus replacing Mongoose-native calls with the PostgreSQL Model/Session APIs.

The site documents two database adapters for the same GraphQL API. It does not host separate historical documentation archives. The 3.0.1 starter is retained as a published-version entry point; newer reference APIs may not exist in that release.

## Get help with an integration

Start with [troubleshooting](./troubleshooting). If an issue remains, [open a GitHub issue](https://github.com/simtlix/simfinity.js/issues/new) with the installed versions, minimal schema and operation, expected result, and actual error. Remove credentials and private data from the reproduction.
