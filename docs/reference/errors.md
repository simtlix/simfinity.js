---
title: Errors
description: Application error classes, stable error codes, and normalization behavior.
---

# Errors

Simfinity errors attach structured metadata to GraphQL errors through `extensions`. Use codes for application decisions and messages for human-readable feedback.

## SimfinityError

```javascript
import { SimfinityError } from '@simtlix/simfinity-js';

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

## InternalServerError

```javascript
import { InternalServerError } from '@simtlix/simfinity-js';

const wrapped = new InternalServerError('Catalog lookup failed', originalError);
console.error(wrapped.getCause());
```

This subclass uses code `INTERNAL_SERVER_ERROR` and retains the cause. It does not assign an HTTP-like status value automatically.

## buildErrorFormatter

```javascript
import { buildErrorFormatter } from '@simtlix/simfinity-js';

const normalizeError = buildErrorFormatter((error) => {
  console.error(error.getCode(), error.message);
  // Return a replacement error, or return nothing to keep this error.
});
```

The returned function preserves `SimfinityError` instances and wraps other errors in `InternalServerError`, retaining the original message and cause. It is a standalone helper; integrate it into your server's own error-handling hook.

The helper checks the error instance it receives. If your server wraps an application error inside `GraphQLError.originalError`, choose the appropriate underlying error before normalizing it. This helper does not automatically redact unexpected-error messages.

## Core error codes

| Code | Trigger |
| --- | --- |
| `VALIDATION_ERROR` | A declarative field validator rejects a value. |
| `INPUT_TYPE_UNRESOLVED` | Input generation cannot resolve registered relationships or dependencies. |
| `MISSING_RELATION_EXTENSION` | An object field used during materialization lacks relationship metadata. |
| `INVALID_FILTER_FIELD` | A logical filter condition names an unknown field. |
| `INVALID_FILTER_PATH` | A filter path has an invalid structure or segment. |
| `MISSING_FILTER_PATH` | A logical condition on an object field omits its related field path. |
| `INVALID_FILTER_VALUE` | An array-valued filter has an invalid value shape. |
| `FILTER_DEPTH_EXCEEDED` | A recursive filter group exceeds the supported nesting limit. |
| `NOT_VALID_ID` | A state action targets a record that does not exist. |
| `BAD_REQUEST` | A state action is not allowed from the record's current state. |

This table covers intentional core errors; GraphQL coercion, Mongoose, and MongoDB can also produce their own errors. MCP returns execution failures as tool results and throws some setup/dispatch errors; see [MCP error handling](/reference/mcp#results-and-errors).
