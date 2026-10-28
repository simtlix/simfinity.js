---
title: Errors
description: Application error classes, stable error codes, and normalization behavior.
---

# Errors

Simfinity errors attach structured metadata to GraphQL errors through `extensions`. Use codes for application decisions and messages for human-readable feedback.

## SimfinityError

```javascript
import { SimfinityError } from '@simtlix/simfinity-core';

throw new SimfinityError(
  'A series with active seasons cannot be deleted',
  'SERIE_HAS_ACTIVE_SEASONS',
  409,
);
```

`new SimfinityError(message, code, status)` extends `Error` and sets:

```javascript
{
  code: 'SERIE_HAS_ACTIVE_SEASONS',
  status: 409,
  timestamp: '...',
}
```

The timestamp is generated with `Date#toUTCString()`. Access values through `extensions` or `getCode()`, `getStatus()`, and `getTimestamp()`. No default code or status is assigned when those arguments are omitted.

`extensions.status` is error metadata. Your GraphQL server decides the HTTP response status; a GraphQL execution error can still arrive in an HTTP 200 response.

## Authentication and authorization errors

These classes are available on `simfinity.auth`. `UnauthenticatedError` and `ForbiddenError` are also exported by `@simtlix/simfinity-core`, from its root and its `/auth` and `/auth/errors` subpaths, as the same classes; the database packages expose them only through `auth`.

| Export | Default message | Code | Status |
| --- | --- | --- | --- |
| `UnauthenticatedError(message)` | `Authentication required` | `UNAUTHENTICATED` | 401 |
| `ForbiddenError(message)` | `Access denied` | `FORBIDDEN` | 403 |
| `createAuthError(message, code = 'FORBIDDEN')` | Supplied message | Supplied code | 401 for `UNAUTHENTICATED`; otherwise 403 |

When the authorization plugin denies a filter, sort or aggregation path, it throws `ForbiddenError` with the message `Access denied to Type.field`. Simfinity and GraphQL errors that a rule throws itself, such as `UnauthenticatedError` from `requireAuth`, are kept. See [filter, sort and aggregation paths](/guide/authorization#filter-sort-and-aggregation-paths).

Nested collection writes throw `ForbiddenError('Child does not belong to this parent')` when an `updated` or `deleted` child belongs to another parent. See [update a collection](/guide/relationships#update-a-collection).

## InternalServerError

```javascript
import { InternalServerError } from '@simtlix/simfinity-core';

const wrapped = new InternalServerError('Catalog lookup failed', originalError);
console.error(wrapped.getCause());
```

This subclass uses code `INTERNAL_SERVER_ERROR` and status 500 and retains the cause. The cause is never included in GraphQL responses, or in the errors that `buildErrorFormatter` returns when they are serialized. It is an enumerable own property of the error, so `JSON.stringify(error)`, or a logger that copies enumerable properties, includes it. As for every `extensions.status`, your server still decides the HTTP response status.

## buildErrorFormatter

```javascript
import { buildErrorFormatter, InternalServerError } from '@simtlix/simfinity-core';

const formatError = buildErrorFormatter((error) => {
  if (error instanceof InternalServerError) {
    console.error(error.getCause() ?? error);
    // Hide the unexpected message from clients.
    return new InternalServerError('Unexpected error');
  }
  return undefined; // Keep the error.
});
```

Since 3.16.0, this callback also masks the errors of a [transaction mutation](#errors-of-the-transaction-mutation), whose new `InternalServerError` has no `operationIndex` or `operation`. That section shows how to copy them.

The returned function takes the error your GraphQL server reports and classifies it. GraphQL servers report an error raised while resolving a field as a field error, a `GraphQLError` with the field `path`. Usually it is the `GraphQLError` that graphql-js creates around the raised value, with the same message, and the formatter then classifies the value that was raised, such as the one a resolver threw. A raised `GraphQLError` that already has a `path` is reported as it is and classified as a field error too, unless it repeats the message of its `originalError` and has no code of its own, in which case it is treated like the graphql-js wrapper. Request errors from a syntax, validation or variable problem have no `path`. A `GraphQLError` without a `path` is classified as a request error, even when it wraps an `Error` with the same message: a scalar's `parseLiteral()` can report validation failures in that form. If its cause, followed through `GraphQLError`s only, is explicitly an `InternalServerError`, that internal error is kept so the callback can mask it. Any other input is classified as it is:

| Classified value | Result |
| --- | --- |
| `SimfinityError` | The same error, with its code and status. |
| `GraphQLError`: a request error, or one raised while resolving a field that has its own string `extensions.code` or a `SimfinityError` cause | A `SimfinityError` with the error's own message and extensions, including extensions your server added, such as Yoga's `http` status. Its code and status are described below. Its `originalError` is never exposed. |
| Any other `GraphQLError` raised while resolving a field, such as one a resolver threw without a code, or one graphql-js raised because it could not complete the resolved value | `InternalServerError` (status 500) with the same message; the `GraphQLError` is its cause. |
| Any other `Error` | `InternalServerError` (status 500) with the same message; the original error is its cause. |
| A value that is not an `Error`, including one a resolver threw | `InternalServerError('Unexpected error value')` with no cause. The value is not printed. Some servers turn the value into an `Error` first; see [server differences](#server-differences). |

graphql-js raises its own `GraphQLError`, without a code, while resolving a field when it cannot complete the value a resolver returned: a built-in scalar or enum cannot serialize it, an `isTypeOf` check rejects it, an abstract type cannot be resolved, or a list field returns a value that is not iterable. Some of these messages print the returned value, such as `Expected value of type "User" but got: { … }`, which can include fields the client did not select. They are `InternalServerError`s, so the masking callback above hides them. To show clients a `GraphQLError` that your resolver throws, give it an `extensions.code`.

A classified `GraphQLError` keeps its own message. Its code, and separately its status, is the first one available from:

1. A `SimfinityError` reached by following `originalError` through `GraphQLError`s only, such as one a custom scalar threw.
2. The error's own string `extensions.code`, or integer `extensions.status`.

Without either, as for most request errors, the code is `BAD_REQUEST`, and the status is 500 for the code `INTERNAL_SERVER_ERROR` or 400 for any other code.

As a result:

- Input that a scalar rejects is `BAD_REQUEST` (400), whether it is sent as a variable or as an inline literal, unless your server already gave the error its own code; see [server differences](#server-differences). This includes Simfinity's validated scalars, such as `EmailScalar`, `URLScalar`, the bounded and pattern scalars, and any `createValidatedScalar` scalar, which throw plain `Error`s. The message is GraphQL's, such as `Variable "$input" got invalid value "nope" at "input.email"; Expected type "Email_String". Invalid email format`.
- An application error such as `new GraphQLError('Could not create user', { originalError: dbError, extensions: { code: 'CONFLICT' } })` keeps its message and its `CONFLICT` code. The `dbError` message is never sent to clients.
- The same `GraphQLError` thrown by a resolver without `extensions.code` is an `InternalServerError`, so the callback above masks it.
- With GraphQL Yoga, request errors keep the `http` status that Yoga adds, so the integration below responds with HTTP 400 for invalid variables.

The callback receives the classified error. Return an error to replace it, or return nothing to keep it. A returned `GraphQLError` is used as is. The formatter wraps every unexpected error in an `InternalServerError`, including a code-less `GraphQLError` raised while resolving a field, so branch on `error instanceof InternalServerError` to mask them, as above; an `InternalServerError` your own code throws is masked too. An application error that sets the `INTERNAL_SERVER_ERROR` code itself, such as a `GraphQLError` with that `extensions.code` or `new SimfinityError(message, 'INTERNAL_SERVER_ERROR', 500)`, is not an `InternalServerError`: it has no `getCause()`, and the callback above keeps its message.

The function returns a `GraphQLError` that keeps the input's locations and path. Its `originalError` is the classified or replacement error, and its `extensions` are a copy of that error's extensions. It serializes to `{ message, locations, path, extensions }`; the cause is never serialized. In your own code, read `formatted.originalError` and `formatted.extensions.code` rather than comparing the result with its input.

The helper keeps the message of unexpected errors. Mask them in the callback, as above. It recognizes errors from the graphql copy Simfinity imports; with two installed copies of graphql, every error is classified as `INTERNAL_SERVER_ERROR`.

### Connect it to your server

Pass the function to your server's error-formatting option:

```javascript
// graphql-http
const handler = createHandler({ schema, formatError });

// express-graphql
app.use('/graphql', graphqlHTTP({ schema, customFormatErrorFn: formatError }));

// GraphQL Yoga: this replaces Yoga's default masking
const yoga = createYoga({ schema, maskedErrors: { maskError: (error) => formatError(error) } });

// Apollo Server 4 expects a plain formatted error
const server = new ApolloServer({
  schema,
  formatError: (_formatted, error) => formatError(error).toJSON(),
});
```

Envelop's `useErrorHandler` is a logging hook. It receives an object with an `errors` list, and its return value does not change the response. Do not pass the formatter to it directly. To log normalized errors, iterate the list:

```javascript
useErrorHandler(({ errors }) => {
  errors.forEach((error) => console.error(formatError(error)));
});
```

### Server differences

The outcomes above describe the errors graphql-js produces. Some servers change errors before the formatter sees them, or never pass them to it:

- **Request error codes.** A code the server already set is the error's own `extensions.code`, so it is kept instead of `BAD_REQUEST`. Yoga sets `GRAPHQL_PARSE_FAILED` on syntax errors, and Apollo Server sets codes such as `GRAPHQL_VALIDATION_FAILED` and `BAD_USER_INPUT`.
- **Yoga validation errors.** Yoga does not pass validation errors, including an invalid inline literal for a scalar, to `maskError`. They keep Yoga's own response, with the `GRAPHQL_VALIDATION_FAILED` code. Variable errors do reach the formatter and become `BAD_REQUEST`, with HTTP 400.
- **Subscription source failures without a path.** Some servers, including Yoga, wrap a source-stream failure in a `GraphQLError` without `path`. Its shape can be identical to a scalar validation error, even when `nodes` or `locations` are present. The formatter cannot infer the execution phase from that error alone. Mark unexpected stream failures with `InternalServerError` at the source, as below, or mask them in a server hook that knows they came from execution. An unmarked `GraphQLError` without a path is treated as a request error and keeps its message.
- **Non-`Error` values.** Yoga's executor turns a value that is not an `Error`, thrown by a resolver, into an `Error` before graphql-js wraps it: a string becomes the message, and an object with a `message` property keeps that message. The formatter then returns an `InternalServerError` with that text instead of `Unexpected error value`. Mask `InternalServerError` in the callback, as above, so that text is not sent to clients.

When using the custom formatter with subscriptions, catch failures where the application reads its event source:

```javascript
async function* subscriptionEvents() {
  try {
    for await (const event of readApplicationEvents()) {
      yield event;
    }
  } catch (cause) {
    throw new InternalServerError('Subscription failed', cause);
  }
}
```

Here `readApplicationEvents()` is your application's event source. When the server reports a GraphQL error without a path, the formatter preserves the explicit internal cause through nested GraphQL wrappers, so the masking callback hides the error and can still log its original cause. Keep the server's default masking if you cannot identify unexpected source failures at that boundary.

## Errors of the transaction mutation

When an operation of a [transaction mutation](/guide/mutations#run-several-mutations-in-one-transaction) ends the transaction, the field reports a new error that has the code, status and message that the same value has when a root resolver throws it, every extension of it, and the operation's position: `extensions.operationIndex`, the 0-based index in `operations`, and `extensions.operation`, the operation key (`addseason`). The field is then `null`, and nothing is stored.

```json
{
  "message": "Season 1002 is not valid",
  "path": ["transaction"],
  "extensions": { "code": "NOT_VALID_ID", "status": 404, "operationIndex": 2, "operation": "updateseason" }
}
```

The error is classified as [`buildErrorFormatter`](#builderrorformatter) classifies a value a root resolver throws:

| Operation error | Reported as |
| --- | --- |
| `SimfinityError` | A `SimfinityError` with the same message and all extensions, `timestamp` included, plus the position. |
| `GraphQLError` with its own string code or a `SimfinityError` cause | A `SimfinityError` with the message and extensions the formatter computes for it, plus the position. |
| Any other `Error`, or a value that is not an `Error` | An `InternalServerError` with the message of the error (``Unexpected error value`` for a non-`Error`), plus the position. The callback that masks `InternalServerError`s therefore hides it as it hides the same error on a root. |

The original error stays reachable as the non-enumerable `cause` of the reported error, so `JSON.stringify()`, object spread and responses leave it out, and through `error.originalError.cause` on the `GraphQLError` your server sees. It is never changed, so shared and frozen errors are safe. An adapter error that has `getCause()`, such as `DATABASE_ERROR` or `TRANSACTION_RETRY_EXCEEDED`, keeps it on the reported error. When the adapter turns the operation's error into another one after its last retry, as MongoDB does with `TRANSACTION_RETRY_EXCEEDED`, the position is that of the operation behind its `cause`.

These errors carry no position: the failure to acquire, begin, commit or roll back, the cleanup after an attempt, `TRANSACTION_OPERATIONS_EXCEEDED`, the `NESTED_OPERATIONS_EXCEEDED` of the preflight that counts the nested entries of the whole list before the transaction starts, and the model affinity check (`TRANSACTION_UNSUPPORTED`), which concern the whole list, and anything that only an earlier attempt raised. A nested limit that an attempt exceeds while it runs, because middleware, a state action, a hook or a helper call added entries, is positioned: it names the operation that was running. The checks that run before the transaction and concern one operation, such as `INVALID_INPUT`, `REQUIRED_VALUE` for a missing `id`, `INVALID_OPERATION_REFERENCE` and the `FORBIDDEN` of an operation whose root the executing schema does not expose, name theirs.

The masking callback shown for [`buildErrorFormatter`](#builderrorformatter) returns a new `InternalServerError`, which has no position, so a masked response drops `operationIndex` and `operation`. Copy them in the callback to keep them:

```javascript
const formatError = buildErrorFormatter((error) => {
  if (error instanceof InternalServerError) {
    console.error(error.getCause() ?? error);
    const masked = new InternalServerError('Unexpected error');
    masked.extensions.operationIndex = error.extensions.operationIndex;
    masked.extensions.operation = error.extensions.operation;
    return masked;
  }
  return undefined;
});
```

## Core error codes

| Code | Trigger |
| --- | --- |
| `VERSION_CONFLICT` | Status 409: the stored version differs from the expected one. `Book <id> was modified by another operation`; never includes the stored version. Re-read and reapply. |
| `VERSION_EXHAUSTED` | Status 409: an update/state action/nested update cannot advance past `9007199254740991`. `Book <id> has reached the maximum version`. Deletion can still use that version. |
| `INVALID_VERSION` | Status 400: a version that bypassed GraphQL coercion is not a safe integer from 1 to `9007199254740991`. `Invalid value for version: expected an integer from 1 to 9007199254740991`. GraphQL coercion failures normally format as `BAD_REQUEST`. |
| `VERSION_MANAGED` | Status 500: `Book.version is managed by Simfinity; onSaving cannot set it`, or `onUpdating cannot set it`. The latter includes a key inside a `$` operator. |
| `INVALID_WRITE_FEATURES` | Status 500: `createRuntime()` received `writeFeatures` other than `undefined`, `null` or a plain object whose optional `optimisticConcurrency` is boolean. |
| `REQUIRED_VALUE` | Status 400 for missing/null version preconditions on paths bypassing GraphQL coercion, including old string-shaped protected `deleted` entries: `Required value version is missing`. Protected PostgreSQL model handles provide their own missing-version guidance. The code also retains its existing required-value uses. Since 3.16.0, it is also the code of a lifecycle helper's or a transaction operation's missing `input`, top-level `id` or value for a non-null position, status 400: ``Required value input.id is missing``. In a transaction the path starts at `operations[<i>].<key>`, and a missing `id` reaches this check only for a type whose `id` is not an `ID`, because the generated update inputs declare an `ID` id as `ID!` and GraphQL rejects it first. |
| `DATABASE_ERROR` | Status 500 for `Book <id> stores an invalid version`; an update result other than `expected + 1` or not advancing beyond the immutable observed version; a deleted record with a different version; or a versioned SQL delete returning no row after a locked read. Existing storage-error uses remain. |
| `VALIDATION_ERROR` | A declarative field validator rejects a value. |
| `INPUT_TYPE_UNRESOLVED` | Status 500 at startup when a registered type has a writable field whose input cannot be generated: a list of lists (mark the field `readOnly`), or embedded types that contain each other: with custom adapters that do not validate models, and in default MongoDB mode when only supplied models reach the cycle, where marking one of the cycle's fields `readOnly` breaks it. PostgreSQL, transactional MongoDB and generated MongoDB models reject such cycles first with `INVALID_MODEL` (`Embedded cycle at …`). The message names every field of the listed types whose input cannot be generated, the causes first, and lists apart the fields that only wait for another listed type (`Type.field waits for Other`), which need no change. Referenced collections, including cycles across types, never raise it. |
| `MISSING_RELATION_EXTENSION` | An object field used during materialization lacks relationship metadata. |
| `INVALID_FILTER_FIELD` | A filter or list-sort path names an unknown field. PostgreSQL's native `getModel(Type).find()` and MongoDB's `buildQuery()` and `buildFilterGroupMatch()` also raise it for a path through a [virtual field](/reference/extensions#virtual) (status 400). |
| `INVALID_FILTER_PATH` | Status 400. A path has invalid syntax, traverses a scalar, or ends at an object where a scalar is required. All list sorts through collections fail, including count mode, before scopes. Explicit quantified paths must end at a collection, reference or supported embedded object list without crossing an earlier unbound list; every quantified field-filter term needs a non-empty path. A quantified group that middleware, a `find`, `get_by_id` or `aggregate` scope, or a direct `createQueryPlan`, `buildQuery`, `buildAggregationQuery` or `buildFilterGroupMatch` call writes by hand with `__implicit: true` must, after its `__anchor`, end at a collection, whatever it crosses first, or at a reference without crossing a list, or it fails with `An implicit quantified path must end at a collection, or at a reference without crossing a list`; its `__anchor`, if any, must have exactly the shape Simfinity writes (in an aggregate, on a group at the root, a non-empty array of field names without dots that crosses at least one collection, each a join prefix, with embedded lists, embedded objects and references allowed around them, followed by a `path` of exactly one collection), or it fails with `An implicit quantified anchor must name the aggregate's join prefixes`. Both apply on every adapter, whatever operators the group holds, before any compile or adapter call; see the [upgrade notes](/resources/compatibility#list-operators). When the path the group names does not resolve, the request keeps that path's own error, `INVALID_FILTER_PATH` (`Invalid filter path`) or `INVALID_FILTER_FIELD`, as before, and on an adapter without `quantifiers` the runtime's own checks of the conditions inside the group, such as the `UNSUPPORTED_QUERY` of an undeclared operator other than `IS_EMPTY` and `IS_NOT_EMPTY`, come first. For a non-empty array anchor, the path the group names is the anchor's fields followed by the group's `path`. For any other anchor (a `Set`, a string, `[]`) it is the group's `path` alone, so `new Set(['items'])` with `reviews` on a shop gives `INVALID_FILTER_FIELD` (`Unknown field reviews`). Shorthand excludes `IS_EMPTY`, `IS_NOT_EMPTY` and `CONTAINS_ALL` on leaves through collections, aggregate join prefixes included. `CONTAINS_ALL` fails with `The shorthand excludes them; use an explicit group` on every adapter that declares it, and so do the emptiness operators on an adapter that declares `quantifiers`. Without `quantifiers`, the emptiness operators report that emptiness of a value inside a list is not defined (`<OP> cannot test <path>: emptiness of a value inside a list is not defined, and <prefix> is a collection`). Outside an aggregate's join prefixes, use an explicit group for all three on an adapter that declares `quantifiers`; on a join prefix an explicit group is a frame per record, not a row filter, so it does not replace one. `CONTAINS_ALL` also raises it through a reference inside an embedded list, which joins one referenced record per item (`CONTAINS_ALL cannot cross the reference <path> inside an embedded list, which joins one referenced record per row; combine EQ conditions on the path instead`), and a `find` scope that uses `CONTAINS_ALL` on its own type raises it before the adapter call when a client's path reaches that type through a reference inside an embedded list, or through a reference after a collection that is a join prefix of an aggregate or, on an adapter without `quantifiers`, after any collection, since the prefixed condition then crosses a list; a path that enters that type directly through such a collection keeps the joined scope's `FORBIDDEN_FILTER_PATH` (403). Emptiness inside embedded lists remains undefined. A joined emptiness scope below a list prefix retains this rejection for embedded lists, aggregate J paths (`groupId`, facts and shared-join filters), and adapters without `quantifiers`; a declaring adapter's collection filter uses a scoped join inside its frame instead. Interfaces/unions on emptiness paths or members remain rejected. MongoDB also reports a related model missing at a required reference/collection path. |
| `FORBIDDEN_FILTER_PATH` | Status 403. A client path or stored emptiness member is not queryable, has an application resolver without `queryable: true`, or is virtual. Quantifier groups and inner paths receive the same restrictions. Declaring adapters permit filters into scoped collections and targets whose scopes filter through collections. Scope-related 403s remain for `groupId` and facts into scoped collections, scopes reaching references inside embedded lists, embedded-list prefixes with collection or quantified scopes, and undeclared adapters. A client reference crossing inside an embedded list before or inside a collection frame gives 403 when its target scope adds conditions, after middleware and the query scope during fill. See [path restrictions](/guide/queries#path-restrictions). |
| `MISSING_FILTER_PATH` | A filter on an object field names no field inside it: a group condition on a bare object field, an object filter without `terms`, or `IS_EMPTY` or `IS_NOT_EMPTY` written on an object filter itself, as in `director: { operator: IS_EMPTY }`, with or without `terms`, which only server code can write; a term without a path is the accepted form. Emptiness terms and group conditions without a path test the field itself and do not raise it. For operators other than `IS_EMPTY` and `IS_NOT_EMPTY`, a filter path of more than one segment that ends at an object raises `INVALID_FILTER_PATH` on both backends; PostgreSQL raised `MISSING_FILTER_PATH` for it in 3.9.0. |
| `INVALID_FILTER_VALUE` | A filter scalar, list, or logical group has an invalid shape or value. Groups reject unknown own keys (`Unknown filter group key: <key>`), and logical/quantified lists require plain-object members. Reserved `__scope`, `__implicit` and `__anchor` are internal metadata, accepted only as defined by the rewrite (a hand-built `__implicit` quantified group whose path or `__anchor` breaks the rules above gives `INVALID_FILTER_PATH`); unused reserved keys retain their ignored behaviour. The [text operators](/guide/queries#text-operators) and `IIN` also raise it, on both backends, for a field whose base scalar is not `String` (`IIN requires a String field on <path>`), `ILIKE`, `STARTS_WITH`, `ISTARTS_WITH`, `ENDS_WITH`, `IENDS_WITH` and `IEQ` for a value that is not a string or that contains U+0000, and `IIN` for a value that is not an array of strings or that holds one with U+0000; `IIN []` is valid and matches nothing. [`CONTAINS_ALL`](/guide/queries#filters-on-lists) raises it for an omitted or `null` value (`Expected a scalar filter value`), a value that is not an array (`CONTAINS_ALL requires an array value`), `[]` (`CONTAINS_ALL requires a non-empty list`) and an element that is `null`, a list or an object (`Filter lists require non-null scalar elements`), and both backends raise it for an element that the field's type cannot hold, as for `IN`. On MongoDB, `LIKE` and the text operators also raise it, before the query runs, for a value whose regular expression is longer than the 32,764 bytes MongoDB accepts, and `IIN` for each of its values. A record identity declared `String`, which the text operators and `IIN` accept as a `String` field, raises it on PostgreSQL, whose compiler reads the identity as the UUID it stores (`IIN requires a String field`), while MongoDB compiles the condition and matches nothing on a generated ObjectId key. Two conversions differ between the backends, for `EQ`, `IN`, the comparisons and `CONTAINS_ALL` alike: a malformed UUID on an ID leaf, such as an `[ID]` list or an `ID` member read through an embedded list, raises `NOT_VALID_ID` on PostgreSQL, as the `NOT_VALID_ID` row below describes, and this code on MongoDB; and a number or Boolean on a `DateTime`, `Date` or `Time` field raises this code on PostgreSQL (`Invalid date for <field>`), while MongoDB reads it as epoch milliseconds. Send dates as ISO strings. `IS_EMPTY` and `IS_NOT_EMPTY` raise it, on both backends and before compiling, for any value other than an omitted one or `null`, `""`, `[]`, `false` and `0` included. MongoDB also maps a case-insensitive regular expression that the server cannot compile (`Location51091`) to this code (400), including each `IIN` value; the driver error remains its cause. |
| `INVALID_FILTER_OPERATOR` | A filter uses an operator that `QLOperator` does not list. [`CONTAINS_ALL`](/guide/queries#filters-on-lists) also raises it on a field that is neither a list nor read through an embedded list, such as a `String` field of the record, an inferred inverse reference, or an interface or union field (`CONTAINS_ALL requires a list field, or a field reached through an embedded list; <path> is not one`), after the path and operator checks. `IS_EMPTY` and `IS_NOT_EMPTY` also raise it for an embedded object whose type reaches itself again through single embedded members, which custom adapters and supplied MongoDB models allow when a field of the cycle is `readOnly`; a type that reaches itself only through a list member is accepted. |
| `UNSUPPORTED_QUERY` | Status 400. A filter uses a `QLOperator` value that the database adapter does not support (`The database adapter does not support the ILIKE filter operator, used on Serie.name`). An adapter supports the operators its `queryFeatures` declaration lists, and a custom adapter or SQL plugin without one, or a copy of `postgresPlugin()` that replaces its `compileQuery`, only the operators of 3.7.0; see [custom adapters and SQL plugins](/resources/compatibility#custom-adapters-and-sql-plugins). The runtime checks the client's arguments before middleware runs and the final arguments before it calls the adapter. An adapter that does not declare `CONTAINS_ALL` or `IIN` raises it for them also where middleware or a scope writes them beside the `terms` of an object filter or in the `terms` of a scalar, scalar-list, interface or union filter, forms that the bundled compilers ignore, and for `CONTAINS_ALL` whatever collection or reference its path crosses; see the [upgrade notes](/resources/compatibility#list-operators). `createQueryPlan()` raises it for an operator outside its `operators` option, which the SQL adapter passes for its own reads, such as `getModel(Type).find()`. With an adapter that does not declare `queryFeatures.referenceEmptiness`, [`IS_EMPTY` and `IS_NOT_EMPTY`](/guide/queries#references-and-collections) raise it for a path that crosses or ends at a reference, for a path that ends at a collection, such as `seasons` on a serie, and for an embedded object with a reference or collection member, with a message that says that the database adapter does not support emptiness through references and collections, whoever wrote the condition; a shorthand emptiness path through a collection, such as `seasons.year`, raises `INVALID_FILTER_PATH` first. On such an adapter, a joined `find` scope that uses them below a client's reference path raises it too, naming the scope and suggesting `EQ null` there, after raw target-scope validation. A raw-valid prefixed condition inside an embedded list, or a legacy aggregate collection join, can still raise `INVALID_FILTER_PATH`. Declaring the operators in `queryFeatures` does not lift these rejections; `referenceEmptiness` does, and both bundled adapters declare it. `createQueryPlan()` raises it for these conditions when its `referenceEmptiness` option is `false`, which it is by default when `operators` is given. PostgreSQL also raises it for shapes its compiler does not support, such as sorting or grouping by a whole embedded object, and for `ILIKE`, `ISTARTS_WITH`, `IENDS_WITH`, `IEQ` and `IIN` on a database that cannot evaluate their [case fold](/guide/queries#case-folding) (`ILIKE, ISTARTS_WITH, IENDS_WITH, IEQ and IIN need a UTF8 database with the ICU collation und-x-icu`); see [PostgreSQL database errors](#postgresql-database-errors). |
| `INVALID_QUERY_FEATURES` | Status 500. `createRuntime()` received malformed `queryFeatures`, including a non-boolean `referenceEmptiness` or `quantifiers` other than undefined/null, or `quantifiers: true` without `referenceEmptiness: true`. A SQL plugin is rejected earlier with `INVALID_SQL_PLUGIN` (400) when `createSQL()` or `createPostgres()` binds it, even when its declaration names a different compiler. See [query features](/guide/sql-plugins#query-features). |
| `INVALID_SORT` | A sort has no terms or an unsupported direction. |
| `INVALID_PAGINATION` | Page, size, computed skip, or maximum page-size validation fails. |
| `INVALID_QUERY_LIMITS` | Status 400. [configureQueryLimits](/reference/api#configurequerylimits) received a `maxPageSize`, `maxReferenceFrames` or `maxFrameNesting` that is not a positive safe integer. Every current limit is preserved. |
| `INVALID_QUERY_REGISTRATION` | Status 500. Invalid name, description, GraphQL types or callback passed to [registerCustomQuery](/reference/api#registercustomquery). The entry is not registered. |
| `QUERY_NAME_CONFLICT` | Status 500. [registerCustomQuery](/reference/api#registercustomquery) or [registerView](/reference/api#registerview) received a name already registered in its own registry. Also raised before any model is prepared when `createSchema()` includes a custom query named like an included generated query (`<entity>`, `<list>` or `<list>_aggregate`), or a view named like an included generated root or an included custom query. A view cannot replace another view. |
| `INVALID_VIEW` | Status 500. [registerView](/reference/api#registerview) received an invalid declaration, `createSchema()` found a view whose type is not registered with `connect()` in the runtime or whose param has an invalid GraphQL name or is named like a base field or a control argument, or a view's `where` returned something other than an array of groups over existing stored fields. Groups and conditions must be plain objects, conditions must name a `field`, paths cannot continue past scalars or use virtual fields, and conditions or quantified groups cannot carry the reserved `__scope` key. Quantified groups use the generated recursive grammar and require a non-empty element-relative `path`. |
| `INVALID_SCHEMA_OPTIONS` | Status 500. The fourth [createSchema](/reference/api#createschema) argument is not a plain object (an array, `null` or a primitive), has an option other than `includedCustomQueries` or `transaction`, or has an `includedCustomQueries` that is not an array of strings, `null` or `undefined`. Raised before any model is prepared. Since 3.16.0, an invalid [`transaction` option](/reference/api#the-transaction-option) raises it too, as ``Invalid transaction option: <reason>``, in two stages that the paragraph after this table describes. |
| `INVALID_MUTATION_LIMITS` | Status 400. `configureMutationLimits()` received options that are not a plain object, an option other than `maxNestedOperations` or `maxTransactionOperations`, such as the misspelled `maxNestedOperation`, a `maxNestedOperations` that is not `null` or a non-negative safe integer, or a `maxTransactionOperations` that is not a positive safe integer (``maxTransactionOperations must be a positive safe integer``). Both current limits are kept. Since 3.16.0, the message for an unknown option is ``Unknown mutation limit option <key>; use maxNestedOperations or maxTransactionOperations``. |
| `NESTED_OPERATIONS_EXCEEDED` | Status 400. A generated add, update or state-action mutation has more nested `added`, `updated` and `deleted` entries than `maxNestedOperations`. Since 3.16.0, this also covers `updateObject()` and `transitionObject()`, and a [transaction mutation](/guide/mutations#run-several-mutations-in-one-transaction), whose operations share one budget per attempt: it counts the entries of the whole list before the transaction starts, and before it walks the input of any operation when a limit is configured, so an input that exceeds the limit reports this code, as it does on a root, even when it is also nested too deeply, and, while an attempt runs, every nested entry on its session, including those that middleware, state actions, hooks and the helpers they call add. See [limit nested collection operations](/guide/mutations#limit-nested-collection-operations). |
| `INVALID_OPERATION_TARGET` | Status 500. A lifecycle helper's `typeName` is not a stored record type registered in this runtime (``Type X is not a stored record type registered in this runtime``), or `updateObject()` or `transitionObject()` names a type without a prepared update input that has an `id` field (``Type X has no prepared update input with an id field``). The message never includes input values. |
| `UNKNOWN_ACTION` | Status 500. `transitionObject()` names an action the type's state machine does not declare, or a type without one (``Type X has no state machine action Y``). |
| `INVALID_INPUT` | Status 400: ``Invalid input at <path>: <reason>``, with a path such as `input.lines.added[1].price` and never a value. Raised for the input of a lifecycle helper and for the scalar and record key rules of a transaction operation, with a path such as `operations[0].addseason.serie.id`. The reasons are `unknown field`, `expected a plain object`, `expected a list`, `expected a dense list`, `accessor property`, `non-enumerable or symbol-keyed property`, `cycle`, `unsupported scalar value`, ``not a value of enum <Enum>``, ``state changes only through transitionObject``, ``pass the ID as a string, for example String(record._id)``, ``pass the ID as a primitive value`` and `input is nested too deeply`, which an input of objects and lists nested more than 256 levels deep raises, at the path where the limit is exceeded, for a helper and for a transaction operation alike. |
| `INVALID_OPERATION_REFERENCE` | Status 400: ``Invalid reference at <path>: <reason>``, naming a `$K` token of a transaction operation, with the operation's position. The reasons are `malformed reference`, ``operation K does not precede it``, ``operation K does not exist``, ``operation K is a delete``, ``operation K writes <Type>, expected <Type>`` and `ambiguous inverse reference`. Every token is checked before the transaction starts. |
| `TRANSACTION_OPERATIONS_EXCEEDED` | Status 400: ``A transaction may run at most <n> operations``, where `n` is `maxTransactionOperations`. Raised before any adapter call, without a position. |
| `TRANSACTION_UNSUPPORTED` | Status 500. The `transaction` option of `createSchema()` with an adapter that has no `assertTransactionModels` (``The database adapter does not support generated transactions``); an `assertTransactionModels` that returns a promise (``assertTransactionModels must be synchronous``); models that cannot share one database transaction (``Types A, B cannot share one database transaction``, with the type names sorted); or an adapter whose `withTransaction` hands an attempt a session that is not an object. See [`assertTransactionModels`](/reference/api#asserttransactionmodels). |
| `INVALID_AFTER_COMMIT_OPTIONS` | Status 400. [configureAfterCommit](/reference/api#configureaftercommit) received invalid options: a non-plain object, an unknown key, or an `onError` value other than a function or `undefined`. The previous configuration is kept. |
| `INVALID_CONTROLLER` | Status 400. An optional committed controller callback is present with a non-function value other than `null` or `undefined`. Checked during `createSchema()` and at lifecycle entry, including controller changes after schema creation. |
| `UNSUPPORTED_AFTER_COMMIT` | Status 500. A controller declares a committed callback but its adapter does not implement `enqueueAfterCommit(session, run)`. Checked during `createSchema()` and at lifecycle entry before the write. See [after-commit callbacks](/guide/controllers#after-commit-callbacks). |
| `FILTER_DEPTH_EXCEEDED` | Status 400. More than five Boolean-group levels (explicit quantified groups count, shorthand groups do not), more than `maxFrameNesting` nested collection/reference frames (default 3, client and trusted), or more than `maxReferenceFrames` compiled client units per resolver call (default 10, independent of markers). The per-call count follows all client 400 checks and precedes middleware. Its message is `The client's conditions need <count> frames and scoped joins in one query field, more than the limit of <limit> (maxReferenceFrames)`. Trusted constructs do not count toward that total. Named views check the `where` groups against a separate budget of the same size after middleware; their frames use the same units. |
| `TYPE_BOUND_TO_OTHER_RUNTIME` | Status 409. `connect()`, `addNoEndpointType()` or `createSchema()` received, or would expose, an object type that another runtime bound by generating its relation resolvers, or reserved because its schema reached the type with an unresolved relation field. `createSchema()` also raises it for a field copied with `toConfig()` after another runtime generated its relation resolver, when the copy keeps that resolver or its `extensions` object (`Field Type.field was copied from a relation field that another Simfinity runtime generated, …`). Create separate type objects for each runtime. See [types belong to one runtime](/guide/schema#types-belong-to-one-runtime). |
| `INVALID_SCOPE` | Status 500. `extensions.scope` is not a plain object whose keys are `find`, `get_by_id` or `aggregate` functions. Raised by `connect()`, `addNoEndpointType()` and `createSchema()`, and by reads of a type whose scope was changed afterwards. See [query scope](/guide/query-scope#callback-contract). |
| `INVALID_MIDDLEWARE` | Status 500. `use()` received a value that is not a function. |
| `DETACHED_CLIENT_FILTER` | Status 500. A marked client construct was dropped, rebuilt or assigned over; its marker is missing, unknown or forged; it was parked in ignored scalar terms, put inside an unmarked explicit frame, or aliased so one relative scope key names different target types. Changing an ordinary top-frame shorthand prefix's membership in aggregate J also fails; explicit groups stay frames and separate emptiness constructs retain their existing rules. Operator/path edits that still read relations are allowed only when the final construct can receive its scope: an emptiness condition, an explicit quantified group, a condition inside a frame, or shorthand through a collection outside J. A marked non-emptiness reference-only predicate outside a frame still fails, such as `shop.name IS_EMPTY` changed to `shop.name EQ "S1"`. Own-field narrowing can remove a marker. The runtime checks detachments before final validation/fill and adapter invocation, naming the original path. Planner and bundled compilers also fail closed on incomplete scope/join metadata. Copy client filter objects and append server restrictions; see [middleware](/guide/middleware#keep-client-filter-objects). |
| `UNREGISTERED_RELATION_TARGET` | Status 500. `createSchema()` found a list relation, embedded object or embedded list whose type was not registered with `connect()` or `addNoEndpointType()`. |
| `INVALID_MODEL` | Status 400 at startup when the registered types cannot be stored as declared. `createSchema()` raises `Type.field requires a child connectionField` for a writable non-embedded list relation whose `connectionField` is missing or empty and whose resolver Simfinity generates, on every adapter. PostgreSQL and MongoDB's `referentialIntegrity: 'transactional'` mode describe the whole model before creating storage and also reject any other collection without `connectionField`, implicit many-to-many relations, storage collisions and other metadata their storage cannot represent; SQL backends also reject a state machine whose `state` field is not a GraphQL enum (`State machine field Type.state must be a GraphQL enum on SQL backends`). Generated MongoDB models reject fields that Mongoose cannot store, with `Type.field cannot be stored on MongoDB: …`: embedded objects and lists named like `Object.prototype` members, such as `toString`, and any field stored under the path `constructor`; see [fields named like Object.prototype members](/guide/schema#fields-named-like-object-prototype-members). A generated MongoDB model whose embedded fields reach embedded types that contain each other, directly or through other embedded types, as objects or lists and also with a `readOnly` link, is rejected in every mode with `Embedded cycle at Type.field…`; in default mode a type that embeds itself keeps `A type cannot have a field of its same type and embedded`, while transactional mode and PostgreSQL report it as `Embedded cycle at Type.field`. In default mode a cycle that only supplied models reach is not checked. On every adapter, `createSchema()` raises `Type.field is non-null but its embedded type Embedded has no writable fields, so generated create inputs cannot set it; …` for a non-null embedded field, single or list, whose embedded type has no writable fields, when the schema's generated mutations reach the owner's create input; it is raised while inputs are built, after models are created. See [what gets generated](/guide/schema#what-gets-generated). Before any storage is prepared, `createSchema()` also rejects invalid [virtual field](/reference/extensions#virtual) declarations, such as `Type.field is virtual, so it requires its own resolve function`; `describeModels()`, `describeDatabase()` and `compileDatabaseSchema()` reject the same declarations. Status 500 at request time, before the database is queried, when a path that middleware or a scope added goes through a virtual field (`Query path busyRanges, added by middleware or a scope, uses the virtual field Barbershop.busyRanges, which is not stored`). Status 500 at request time, with the message `Type.field cannot store nested items because it has no connectionField`, when nested `added`, `updated` or `deleted` items target a collection without `connectionField`, which only builds with its own resolver or as `readOnly` in default MongoDB mode and with custom adapters. See [relation](/reference/extensions#relation). It also rejects invalid `extensions.concurrency`, changing protection after a schema, unregistered or non-entity protected types, embedded protection, version field/storage collisions, other stored `RecordVersion` fields, missing adapter support and incompatible supplied Mongoose models. |
| `RESERVED_TYPE_NAME` | Status 500 at startup. An application type has the name of a type that Simfinity adds to every schema for `__Field.extensions` (`FieldExtensionsType` and `RelationType`, or the fallback names `SimfinityFieldExtensionsType` and `SimfinityRelationType` that a clash in the first Simfinity schema of the process gave them), and an earlier Simfinity schema of the process already fixed those names. `createSchema()` raises it before `adapter.prepare()` and model creation for an included endpoint type, the input or output type of an included registered mutation, an output type that these reach through fields, interfaces or union members, or the type of an argument of those fields. That check never reads an input object's fields. `createSchema()` raises it when it constructs the schema, after models are created, for a type nested in an input object's fields, such as a registered mutation's input, and for a type that only generated types reach. Create the schema that has such a type first in the process, or rename the type. See [what gets generated](/guide/schema#what-gets-generated). It also covers application types named `RecordVersion` or `RecordVersionRef` in schemas containing protected types; only core's managed instances may use those names. |
| `INVALID_INTROSPECTION_CONFIGURATION` | Status 500. Invalid options or an opt-out attempted after the global extension was installed. No installed metadata is deleted. See [early configuration](/reference/client-descriptor#disable-the-legacy-extension-explicitly). |
| `NOT_VALID_ID` | Status 400 when an ID is malformed for its backend: on MongoDB, not an ObjectId for generated models, or a value a supplied model's `_id` type cannot hold after its setters; on PostgreSQL, not a UUID. By-ID queries, updates, deletes, state actions, nested `updated` and `deleted` entries, `{ id }` reference inputs, scalar `ID` fields and embedded `id` members raise it before anything is written. Status 404 when an update, state action or nested child operation targets a record that does not exist; a by-ID query for a missing record returns `null`. On MongoDB, ID filters and by-ID reads of a type with a `get_by_id` scope validate the ID as a filter value and fail with `INVALID_FILTER_VALUE` instead, and native `getModel()` calls keep the driver's errors. A stored single-reference value that the adapter rejects with status 400 is a data error, not a client error: the generated reference field fails with an `InternalServerError` instead (`INTERNAL_SERVER_ERROR`, 500, `Type.field stores an invalid identifier`), whose `getCause()` is the `NOT_VALID_ID` error. On MongoDB that happens for a value the target's `_id` type cannot hold, such as one written outside Simfinity or by a supplied model whose reference type disagrees with the target's key, when the record comes from a list query, a collection field or a scoped by-ID read; a target with a `get_by_id` scope fails with `INVALID_FILTER_VALUE` instead, and an unscoped by-ID read of the record returns the field as `null` when Mongoose drops the stored value it cannot cast. |
| `BAD_REQUEST` | A state action is not allowed from the record's current state. `buildErrorFormatter` also uses `BAD_REQUEST` (400) for GraphQL syntax, validation and variable errors, including input rejected by a scalar, and for a request `GraphQLError` without its own code. A `GraphQLError` raised while resolving a field without its own code or a `SimfinityError` cause is `INTERNAL_SERVER_ERROR`. |

Since 3.16.0, an invalid `transaction` option fails `createSchema()` in two stages. The checks of its shape, `name`, `types`, registration, the field name against the registered mutations and the roots the included types can generate, and the existence of an included endpoint type run before any model is prepared. The checks that need the built roots (the field name against the mutations actually built, that an operation remains, and that the derived type names are free in the schema) run after the models, versions and inputs are prepared and before the schema is constructed, so, as for `RESERVED_TYPE_NAME`, a failure there leaves them prepared. A failed call keeps no transaction field, type or authorization entry.

This table covers intentional core errors; GraphQL coercion and backend drivers can also produce their own errors. PostgreSQL database errors are normalized without leaking SQL or constraint details; see [PostgreSQL database errors](#postgresql-database-errors). MCP returns execution failures as tool results and throws some setup/dispatch errors; see [MCP error handling](/reference/mcp#results-and-errors).

Backend transaction errors: `TRANSACTION_RETRY_EXCEEDED` (409, `Concurrent write could not be completed`) means a transaction owned by Simfinity could not complete because of a concurrent write: on MongoDB, a `WriteConflict` still present after its retries; on PostgreSQL, a serialization failure or deadlock that it does not retry again. On both, the driver error is `error.cause`, which `error.getCause?.()` also returns. Both backends wait a short random delay before each of up to five retries. The whole operation was rolled back, so the client can retry the request. It is a `SimfinityError`, not an `InternalServerError`, so the masking callback above keeps its message. A transaction you supply receives the driver's error instead, and you own its retries. MongoDB's transactional reference integrity adds its own codes; see [MongoDB reference integrity](/guide/mongodb-integrity#errors).

MongoDB adapter options: `createMongoAdapter()` throws `INVALID_MONGO_ADAPTER_OPTIONS` (400) for a `batchedCollections` that is not a boolean, or a `collectionBatchSize` that is not an integer from 1 to 100, and `INVALID_MONGO_INTEGRITY_CONFIGURATION` (400) for an unknown option name or `referentialIntegrity` value; see [createMongoAdapter](/reference/api#createmongoadapter).

Quantified forms on an adapter without `quantifiers`, including those returned by target scopes, give `UNSUPPORTED_QUERY` (400); an explicit quantified path ending at an embedded list gives that temporary rejection too. Raw joined scopes are validated on their target before prefixing, so raw errors precede prefix restrictions. Invalid ordinary paths/values now reject before middleware/adapter and frame counts where applicable. On MongoDB, `INVALID_FILTER_VALUE` (400) now uses `Filter lists require non-null scalar elements` for null elements in `IN`/`NIN`/`BTW` (formerly `<OP> does not accept null elements`), `Expected a scalar filter value` for null ordered/`LIKE` values (formerly `<OP> does not accept null` or `LIKE requires a string field and string value`), and `BTW requires two values` for a wrong-sized list (formerly `BTW requires exactly two values`). Existing sort-shape diagnostics are preserved. See the [3.14.0 upgrade notes](/resources/compatibility#collection-frames).

For [optimistic concurrency](/guide/concurrency), `TRANSACTION_RETRY_EXCEEDED` (409) is a normal contention outcome: re-read and reapply as for `VERSION_CONFLICT`. A `get_by_id` scope defers stale/exhausted-version errors for hidden callers until their hooks accept the write; it does not hide malformed stored-version errors, which may occur before hooks. Root mutation authorization and middleware still precede the pre-read.

For [`valuePath` comparisons](/guide/queries#compare-stored-fields), `INVALID_FILTER_VALUE` (400) covers competing `value`/`valuePath`, a non-string path and incompatible logical types. `INVALID_FILTER_OPERATOR` (400) covers unsupported comparison operators or ordered/text list comparisons. `INVALID_FILTER_PATH` (400) covers malformed paths, scalar-list right operands, non-scalar endpoints and unbound right collections; unknown fields keep `INVALID_FILTER_FIELD`. Undeclared `elementFrames` or `valuePath` support and missing logical enum/temporal metadata give `UNSUPPORTED_QUERY` (400). Non-queryable/virtual client operands give `FORBIDDEN_FILTER_PATH`; authorization read-rule denials retain `FORBIDDEN` (403). Damaged provenance keeps `DETACHED_CLIENT_FILTER` (500). Both paths participate in the same checks.

Only `queryFeatures.valuePath: true` enables comparisons and it requires `referenceEmptiness: true`; a malformed flag or dependency gives `INVALID_QUERY_FEATURES` (500) in core or `INVALID_SQL_PLUGIN` (400) during SQL binding. For the new form, carrier/presence/path checks precede operator/type checks and capability/frame gates; existing literal diagnostic ordering is unchanged.

## Client descriptor errors

The optional descriptor package uses the same `SimfinityError` identity as core:
`NOT_A_SIMFINITY_SCHEMA` (500) rejects a schema not owned by this core installation,
including clones/compositions; `INVALID_CLIENT_DESCRIPTOR_OPTIONS` (500) rejects
missing authorization, invalid option values or unknown options at handler setup.

Its HTTP `errors` envelope uses `METHOD_NOT_ALLOWED` (405, `Allow: GET, HEAD`),
`UNAUTHENTICATED` (401) or `FORBIDDEN` (403) for access denials, and masked
`INTERNAL_SERVER_ERROR` (500) for unexpected failures. Only unexpected failures
call `onError(error, req, res)`. HEAD sends no body, including on errors. See the
[handler contract](/reference/client-descriptor#mount-the-http-handler).

## PostgreSQL database errors

PostgreSQL runtimes report database failures as `SimfinityError`s without SQL or constraint details. The driver error is available as `error.cause`, which `error.getCause()` also returns. It is not enumerable, so `JSON.stringify()`, object spread and GraphQL responses leave it out; log it on the server when you need the details.

| Code | Status | Raised for |
| --- | --- | --- |
| `DUPLICATE_KEY` | 409 | A unique violation (`23505`). |
| `REFERENCE_CONSTRAINT_VIOLATION` | 409 | A foreign-key violation (`23503`). |
| `REQUIRED_VALUE` | 400 | A not-null violation (`23502`). |
| `INVALID_VALUE` | 400 | A value that violates the generated schema (`23514`), an invalid value (`22P02`, `Invalid stored value`), a number out of range (`22003`), a value too long for a sized column (`22001`), a date or time out of range (`22008`), such as a native `DateTime` before 4714-11-24 BC, and text with NUL (U+0000) or a character the server encoding lacks (`22021`, `22P05`). |
| `UNSUPPORTED_QUERY` | 400 | A statement that applies the case fold of `ILIKE`, `ISTARTS_WITH`, `IENDS_WITH`, `IEQ` or `IIN` (`ILIKE, ISTARTS_WITH, IENDS_WITH, IEQ and IIN need a UTF8 database with the ICU collation und-x-icu`; `IIN []` applies none), on a database whose encoding lacks the fold's characters, such as `LATIN1` (`22P05`), or without the ICU collation `und-x-icu`, on a server built without ICU or in an encoding that ICU does not support, such as `SQL_ASCII` (`42704`). Every other statement keeps `INVALID_VALUE` for `22P05` and `DATABASE_ERROR` for `42704`. |
| `TRANSACTION_RETRY_EXCEEDED` | 409 | A serialization failure (`40001`) or deadlock (`40P01`) after the last retry. |
| `DATABASE_ERROR` | 500 | Any other PostgreSQL error (`Database operation failed`), such as an index row over the btree size limit (`54000`) or a statement that runs in a transaction that an earlier failed statement aborted (`25P02`), even when your code caught that failure; a connection that could not be acquired or was lost; and a transaction that PostgreSQL rolled back at `COMMIT` because one of its statements had failed (`Transaction was rolled back because one of its statements failed`). PostgreSQL reports no error for that `COMMIT`, so the cause of this error is an `Error` with the message `COMMIT reported ROLLBACK`. |

These codes apply wherever PostgreSQL reports the error: Simfinity's statements, `session.query()`, `session.client` and other `pg` connections used inside a transaction callback, so errors of your own SQL there are mapped too. Inside the callback, `session.query()` rejects with the driver's own error, so a savepoint can recover from it; the mapping applies when the error leaves the transaction. Errors that your code throws propagate unchanged, whether or not they carry a `code`, as on MongoDB, and so does a client-side failure of a connection that Simfinity did not open, such as `connect ECONNREFUSED host:port` from your own pool. A `DATABASE_ERROR` caused by a connection lost during `COMMIT` has an unknown outcome: the transaction may have committed.

Initialization has its own codes: `DATABASE_NOT_INITIALIZED` (503) for operations before the first successful initialization or after a failed one, `DATABASE_CREATION_DISABLED` (409) for any mode other than `validate` on a validation-only runtime, where a missing or false mode validates, `INVALID_INITIALIZATION_MODE` (400) for a mode other than `create` or `validate` on a runtime that allows creation, and `SCHEMA_MISMATCH` (409) for missing or different storage in `validate` mode or an incompatible definition in `create` mode. When the difference is storage that a field kept from before it became [virtual](/reference/extensions#virtual), a runtime's `initializeDatabase()` adds to the message the fields concerned and the statements that migrate them; see the [upgrade notes](/resources/compatibility#virtual-fields). Other errors of `initializeDatabase()`, such as a refused connection or orphan data that blocks a foreign key, are passed on as the driver reports them.

For the 3.18.0 embedded extension, `$root`, root `$parent`, an unavailable container or a climb through an entity boundary gives `INVALID_FILTER_PATH`. A valid embedded quantifier/comparison without `queryFeatures.elementFrames: true` gives `UNSUPPORTED_QUERY`. Enabling it without all three dependencies (`quantifiers`, `referenceEmptiness`, `valuePath`) gives `INVALID_QUERY_FEATURES` in core or `INVALID_SQL_PLUGIN` in SQL. Bound embedded comparisons apply reference scopes normally; retained legacy vector restrictions apply to the older unbound literal paths.
