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

These classes are available on `simfinity.auth`:

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

## Core error codes

| Code | Trigger |
| --- | --- |
| `VALIDATION_ERROR` | A declarative field validator rejects a value. |
| `INPUT_TYPE_UNRESOLVED` | Status 500 at startup when a registered type has a writable field whose input cannot be generated: a list of lists (mark the field `readOnly`), or, on the core runtime with adapters that do not validate models, embedded types that contain each other (PostgreSQL rejects those with `INVALID_MODEL`, `Embedded cycle at …`). The message names every field of the listed types whose input cannot be generated, the causes first, and lists apart the fields that only wait for another listed type (`Type.field waits for Other`), which need no change. Referenced collections, including cycles across types, never raise it. |
| `MISSING_RELATION_EXTENSION` | An object field used during materialization lacks relationship metadata. |
| `INVALID_FILTER_FIELD` | A filter or list-sort path names an unknown field. |
| `INVALID_FILTER_PATH` | A filter path has an invalid structure or segment. |
| `FORBIDDEN_FILTER_PATH` | Status 403. A client filter, sort, `groupId` or fact path names a non-queryable field, or enters a relationship whose `find` scope cannot be applied to that path. See [path restrictions](/guide/queries#path-restrictions). |
| `MISSING_FILTER_PATH` | A logical condition on an object field omits its related field path. |
| `INVALID_FILTER_VALUE` | A filter scalar, list, or logical group has an invalid shape or value. |
| `INVALID_FILTER_OPERATOR` | A filter uses an unsupported operator. |
| `INVALID_SORT` | A sort has no terms or an unsupported direction. |
| `INVALID_PAGINATION` | Page, size, computed skip, or maximum page-size validation fails. |
| `INVALID_QUERY_LIMITS` | The configured maximum page size is not a positive safe integer. |
| `INVALID_MUTATION_LIMITS` | Status 400. `configureMutationLimits()` received options that are not a plain object, an option other than `maxNestedOperations` (such as the misspelled `maxNestedOperation`), or a `maxNestedOperations` that is not `null` or a non-negative safe integer. The current limit is kept. |
| `NESTED_OPERATIONS_EXCEEDED` | Status 400. A generated add, update or state-action mutation has more nested `added`, `updated` and `deleted` entries than `maxNestedOperations`. See [limit nested collection operations](/guide/mutations#limit-nested-collection-operations). |
| `FILTER_DEPTH_EXCEEDED` | A recursive filter group exceeds the supported nesting limit. |
| `TYPE_BOUND_TO_OTHER_RUNTIME` | Status 409. `connect()`, `addNoEndpointType()` or `createSchema()` received, or would expose, an object type that another runtime bound by generating its relation resolvers, or reserved because its schema reached the type with an unresolved relation field. `createSchema()` also raises it for a field copied with `toConfig()` after another runtime generated its relation resolver, when the copy keeps that resolver or its `extensions` object (`Field Type.field was copied from a relation field that another Simfinity runtime generated, …`). Create separate type objects for each runtime. See [types belong to one runtime](/guide/schema#types-belong-to-one-runtime). |
| `INVALID_SCOPE` | Status 500. `extensions.scope` is not a plain object whose keys are `find`, `get_by_id` or `aggregate` functions. Raised by `connect()`, `addNoEndpointType()` and `createSchema()`, and by reads of a type whose scope was changed afterwards. See [query scope](/guide/query-scope#callback-contract). |
| `INVALID_MIDDLEWARE` | Status 500. `use()` received a value that is not a function. |
| `UNREGISTERED_RELATION_TARGET` | Status 500. `createSchema()` found a list relation, embedded object or embedded list whose type was not registered with `connect()` or `addNoEndpointType()`. |
| `INVALID_MODEL` | Status 400 at startup when the registered types cannot be stored as declared. `createSchema()` raises `Type.field requires a child connectionField` for a writable non-embedded list relation whose `connectionField` is missing or empty and whose resolver Simfinity generates, on every adapter. PostgreSQL and MongoDB's `referentialIntegrity: 'transactional'` mode describe the whole model before creating storage and also reject any other collection without `connectionField`, implicit many-to-many relations, storage collisions and other metadata their storage cannot represent; SQL backends also reject a state machine whose `state` field is not a GraphQL enum (`State machine field Type.state must be a GraphQL enum on SQL backends`). Generated MongoDB models reject fields that Mongoose cannot store, with `Type.field cannot be stored on MongoDB: …`: embedded objects and lists named like `Object.prototype` members, such as `toString`, and any field stored under the path `constructor`; see [fields named like Object.prototype members](/guide/schema#fields-named-like-object-prototype-members). Status 500 at request time, with the message `Type.field cannot store nested items because it has no connectionField`, when nested `added`, `updated` or `deleted` items target a collection without `connectionField`, which only builds with its own resolver or as `readOnly` in default MongoDB mode and with custom adapters. See [relation](/reference/extensions#relation). |
| `NOT_VALID_ID` | Status 400 when an ID is malformed for its backend: on MongoDB, not an ObjectId for generated models, or a value a supplied model's `_id` type cannot hold after its setters; on PostgreSQL, not a UUID. By-ID queries, updates, deletes, state actions, nested `updated` and `deleted` entries, `{ id }` reference inputs, scalar `ID` fields and embedded `id` members raise it before anything is written. Status 404 when an update, state action or nested child operation targets a record that does not exist; a by-ID query for a missing record returns `null`. On MongoDB, ID filters and by-ID reads of a type with a `get_by_id` scope validate the ID as a filter value and fail with `INVALID_FILTER_VALUE` instead, and native `getModel()` calls keep the driver's errors. A stored single-reference value that the adapter rejects with status 400 is a data error, not a client error: the generated reference field fails with an `InternalServerError` instead (`INTERNAL_SERVER_ERROR`, 500, `Type.field stores an invalid identifier`), whose `getCause()` is the `NOT_VALID_ID` error. On MongoDB that happens for a value the target's `_id` type cannot hold, such as one written outside Simfinity or by a supplied model whose reference type disagrees with the target's key, when the record comes from a list query, a collection field or a scoped by-ID read; a target with a `get_by_id` scope fails with `INVALID_FILTER_VALUE` instead, and an unscoped by-ID read of the record returns the field as `null` when Mongoose drops the stored value it cannot cast. |
| `BAD_REQUEST` | A state action is not allowed from the record's current state. `buildErrorFormatter` also uses `BAD_REQUEST` (400) for GraphQL syntax, validation and variable errors, including input rejected by a scalar, and for a request `GraphQLError` without its own code. A `GraphQLError` raised while resolving a field without its own code or a `SimfinityError` cause is `INTERNAL_SERVER_ERROR`. |

This table covers intentional core errors; GraphQL coercion and backend drivers can also produce their own errors. PostgreSQL database errors are normalized without leaking SQL or constraint details; see [PostgreSQL database errors](#postgresql-database-errors). MCP returns execution failures as tool results and throws some setup/dispatch errors; see [MCP error handling](/reference/mcp#results-and-errors).

Backend transaction errors: `TRANSACTION_RETRY_EXCEEDED` (409, `Concurrent write could not be completed`) means a transaction owned by Simfinity could not complete because of a concurrent write: on MongoDB, a `WriteConflict` still present after its retries; on PostgreSQL, a serialization failure or deadlock that it does not retry again. On both, the driver error is `error.cause`, which `error.getCause?.()` also returns. Both backends wait a short random delay before each of up to five retries. The whole operation was rolled back, so the client can retry the request. It is a `SimfinityError`, not an `InternalServerError`, so the masking callback above keeps its message. A transaction you supply receives the driver's error instead, and you own its retries. MongoDB's transactional reference integrity adds its own codes; see [MongoDB reference integrity](/guide/mongodb-integrity#errors).

## PostgreSQL database errors

PostgreSQL runtimes report database failures as `SimfinityError`s without SQL or constraint details. The driver error is available as `error.cause`, which `error.getCause()` also returns. It is not enumerable, so `JSON.stringify()`, object spread and GraphQL responses leave it out; log it on the server when you need the details.

| Code | Status | Raised for |
| --- | --- | --- |
| `DUPLICATE_KEY` | 409 | A unique violation (`23505`). |
| `REFERENCE_CONSTRAINT_VIOLATION` | 409 | A foreign-key violation (`23503`). |
| `REQUIRED_VALUE` | 400 | A not-null violation (`23502`). |
| `INVALID_VALUE` | 400 | A value that violates the generated schema (`23514`), an invalid value (`22P02`, `Invalid stored value`), a number out of range (`22003`), a value too long for a sized column (`22001`), a date or time out of range (`22008`), such as a native `DateTime` before 4714-11-24 BC, and text with NUL (U+0000) or a character the server encoding lacks (`22021`, `22P05`). |
| `TRANSACTION_RETRY_EXCEEDED` | 409 | A serialization failure (`40001`) or deadlock (`40P01`) after the last retry. |
| `DATABASE_ERROR` | 500 | Any other PostgreSQL error (`Database operation failed`), such as an index row over the btree size limit (`54000`) or a statement that runs in a transaction that an earlier failed statement aborted (`25P02`), even when your code caught that failure; a connection that could not be acquired or was lost; and a transaction that PostgreSQL rolled back at `COMMIT` because one of its statements had failed (`Transaction was rolled back because one of its statements failed`). PostgreSQL reports no error for that `COMMIT`, so the cause of this error is an `Error` with the message `COMMIT reported ROLLBACK`. |

These codes apply wherever PostgreSQL reports the error: Simfinity's statements, `session.query()`, `session.client` and other `pg` connections used inside a transaction callback, so errors of your own SQL there are mapped too. Inside the callback, `session.query()` rejects with the driver's own error, so a savepoint can recover from it; the mapping applies when the error leaves the transaction. Errors that your code throws propagate unchanged, whether or not they carry a `code`, as on MongoDB, and so does a client-side failure of a connection that Simfinity did not open, such as `connect ECONNREFUSED host:port` from your own pool. A `DATABASE_ERROR` caused by a connection lost during `COMMIT` has an unknown outcome: the transaction may have committed.

Initialization has its own codes: `DATABASE_NOT_INITIALIZED` (503) for operations before the first successful initialization or after a failed one, `DATABASE_CREATION_DISABLED` (409) for any mode other than `validate` on a validation-only runtime, where a missing or false mode validates, `INVALID_INITIALIZATION_MODE` (400) for a mode other than `create` or `validate` on a runtime that allows creation, and `SCHEMA_MISMATCH` (409) for missing or different storage in `validate` mode or an incompatible definition in `create` mode. Other errors of `initializeDatabase()`, such as a refused connection or orphan data that blocks a foreign key, are passed on as the driver reports them.
