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

## InternalServerError

```javascript
import { InternalServerError } from '@simtlix/simfinity-core';

const wrapped = new InternalServerError('Catalog lookup failed', originalError);
console.error(wrapped.getCause());
```

This subclass uses code `INTERNAL_SERVER_ERROR` and retains the cause. It does not assign an HTTP-like status value automatically.

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

The returned function takes the error your GraphQL server reports and classifies it. GraphQL servers report an error raised while resolving a field as a field error, a `GraphQLError` with the field `path`. Usually it is the `GraphQLError` that graphql-js creates around the raised value, with the same message, and the formatter then classifies the value that was raised, such as the one a resolver threw. A raised `GraphQLError` that already has a `path` is reported as it is and classified as a field error too, unless it repeats the message of its `originalError` and has no code of its own, in which case it is treated like the graphql-js wrapper. Request errors from a syntax, validation or variable problem have no `path`. A `GraphQLError` without a `path` that repeats the message of a plain `Error` it wraps and has no code of its own, such as the error a subscription's source stream raised under Yoga, wraps a value raised during execution, and that value is classified. Any other input is classified as it is:

| Classified value | Result |
| --- | --- |
| `SimfinityError` | The same error, with its code and status. |
| `GraphQLError`: a request error, or one raised while resolving a field that has its own string `extensions.code` or a `SimfinityError` cause | A `SimfinityError` with the error's own message and extensions, including extensions your server added, such as Yoga's `http` status. Its code and status are described below. Its `originalError` is never exposed. |
| Any other `GraphQLError` raised while resolving a field, such as one a resolver threw without a code, or one graphql-js raised because it could not complete the resolved value | `InternalServerError` with the same message and no status; the `GraphQLError` is its cause. |
| Any other `Error` | `InternalServerError` with the same message and no status; the original error is its cause. |
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
- **Non-`Error` values.** Yoga's executor turns a value that is not an `Error`, thrown by a resolver, into an `Error` before graphql-js wraps it: a string becomes the message, and an object with a `message` property keeps that message. The formatter then returns an `InternalServerError` with that text instead of `Unexpected error value`. Mask `InternalServerError` in the callback, as above, so that text is not sent to clients.

## Core error codes

| Code | Trigger |
| --- | --- |
| `VALIDATION_ERROR` | A declarative field validator rejects a value. |
| `INPUT_TYPE_UNRESOLVED` | Input generation cannot resolve registered relationships or dependencies. |
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
| `NOT_VALID_ID` | A state action targets a record that does not exist. |
| `BAD_REQUEST` | A state action is not allowed from the record's current state. `buildErrorFormatter` also uses `BAD_REQUEST` (400) for GraphQL syntax, validation and variable errors, including input rejected by a scalar, and for a request `GraphQLError` without its own code. A `GraphQLError` raised while resolving a field without its own code or a `SimfinityError` cause is `INTERNAL_SERVER_ERROR`. |

This table covers intentional core errors; GraphQL coercion and backend drivers can also produce their own errors. PostgreSQL constraint errors are normalized without leaking SQL or constraint details. MCP returns execution failures as tool results and throws some setup/dispatch errors; see [MCP error handling](/reference/mcp#results-and-errors).
