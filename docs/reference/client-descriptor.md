---
title: Client descriptor
description: Schema-owned JSON metadata and an early opt-out from legacy introspection extensions.
---

# Client descriptor

`buildClientDescriptor(schema)` returns immutable, JSON-compatible metadata for
an exact schema returned by Simfinity's `createSchema()`. It works with core,
MongoDB and PostgreSQL, without querying a database. It is independent of GraphQL
introspection validation rules and can be served even when introspection queries
are disabled.

The builder is exported by `@simtlix/simfinity-core`, `@simtlix/simfinity-js` and
`@simtlix/simfinity-postgres`. The HTTP handler is exported by both database
facades and `@simtlix/simfinity-core/http`; core's main entry has no Node imports.
The HTTP declarations use Node request/response types, supplied by the package's
`@types/node` dependency. Importing only core's main entry does not load those declarations.

## Build for the schema you serve

```javascript
import { buildClientDescriptor } from '@simtlix/simfinity-core';

const publicSchema = simfinity.createSchema([Book], [], [], {
  includedCustomQueries: [],
});
const adminSchema = simfinity.createSchema();
const publicMetadata = buildClientDescriptor(publicSchema);
const adminMetadata = buildClientDescriptor(adminSchema);
// The public schema advertises no mutation endpoints.
console.log(publicMetadata.operations.mutation); // {}
console.log(adminMetadata.types.Book.endpoints.add); // 'addbook', if registered that way
```

`Book` and `simfinity` above are your registered type and runtime. Endpoints use
exact generated names, not guesses from type names. Schema allowlists govern the
result, including the custom-query selector. Named views follow their type's
allowlist and appear as list operations with a `view` name; they do not replace
its canonical list endpoint.

Metadata is captured at schema construction. Finish declarations first; create a
new schema and handler when metadata changes. A later registration or another
schema does not change an earlier descriptor. Repeated calls return the same
frozen document. In-place auth resolver wrapping is supported. Freezing metadata
does not freeze dynamic scopes or runtime execution behavior.

A schema cloned or composed outside `createSchema()`, an arbitrary GraphQL schema
or one owned by another installation of core fails with `NOT_A_SIMFINITY_SCHEMA`
(500). Metadata cannot establish resolver ownership by matching names. Keep
Simfinity packages aligned and deduplicated. This API does not make arbitrary
schema transformations or schema-cloning middleware supported.

## Format version 1

| Key | Content |
| --- | --- |
| `formatVersion` | `1`. Additive optional fields can be ignored; incompatible changes need a new format version. |
| `generator` | Core package name and version. |
| `roots` | Actual `query` and `mutation` type names; an absent root is `null`. |
| `operations.query`, `operations.mutation` | Separate maps keyed by root field name. The same name can exist in both. |
| `types` | Reachable types, including inputs, scalars, interfaces and union members. Introspection-only types are excluded. |

Operations have `operation`, entity `type` (or `null`), `args`, `returns` and
`description`. Kinds are `get`, `list`, `aggregate`, `add`, `update`, `delete`,
`transition`, `customQuery` and `customMutation`. Transitions also carry `action`,
`from` and `to`. Descriptions that are generated CRUD placeholders become `null`;
custom descriptions are preserved.

Type `kind` is `entity`, `object`, `interface`, `union`, `input`, `enum` or `scalar`.
Entities expose the available `endpoints` and `stateMachine`. Registered types
include `inputs.add` and/or `inputs.update` only when those generated input types
are present. Interfaces/unions include `possibleTypes`; objects/interfaces list
`interfaces`. Enums list external names, descriptions and deprecations, never
internal enum values.

Fields/arguments use complete SDL type references, such as `[Book!]!`. Fields
carry descriptions, deprecations, `readOnly`, `unique`, `stateMachine`, and optional
`relation`, `virtual`, `queryable` and `args`. Input fields and arguments include
`hasDefault`; a representable `defaultValue` is a **GraphQL literal string**, not
an internal JavaScript value. An opaque default may have `hasDefault: true` with
no `defaultValue`. Building the descriptor may call a custom scalar's `serialize`
for a default, once per shared argument/input field; schema construction does not.

Relation hints preserve declared `connectionField` and `displayField` (or `null`),
with `target`, boolean `embedded` and resolved GraphQL `inverseField`. An absent,
private or ambiguous inverse is `null`. There is no automatic display-field
fallback. Virtual fields carry `{ mcp: 'tool' | 'select' | false }`, are read-only
and are not queryable.

`queryable` describes local field eligibility for registered types. It is not a
permission decision or a guarantee for every path, operator or backend. `unique`
reflects the declaration, not universal enforcement on every storage mapping.
Scalar `baseScalar` is a base-chain hint (or `null`), not a validator description
or a guarantee of output serialization.

Inspect the concrete operation's arguments and input graph to build writes.
A root input and an `added` or `updated` nested item can accept different fields,
including omitted back-references. The descriptor does not invent a universal
writability flag or an endpoint whose input is unavailable.

Validators, scopes, controllers, auth rules, indexes, private storage links and
arbitrary application extensions are not published. The document describes what
the schema exposes, not what the current caller may execute.

## Mount the HTTP handler

```javascript
import { createClientDescriptorHandler } from '@simtlix/simfinity-core/http';

app.all('/graphql-metadata', createClientDescriptorHandler(schema, {
  context: (req) => authenticateRequest(req),
  authorize: (_req, context) => context.user !== null,
  onError: (error) => logger.error(error),
}));
```

`app`, `schema`, authentication and logging belong to the application. Use
`authorize: 'public'` to deliberately expose the whole descriptor publicly.
Missing access configuration fails at setup with `INVALID_CLIENT_DESCRIPTOR_OPTIONS`
(500). A gate grants access only on `true` or `undefined`; other results deny.
Throw `UnauthenticatedError` for 401 or `ForbiddenError` for 403. Unexpected errors
are masked as 500 with an `errors` envelope; observer failures do not replace
that response. GraphQL auth still enforces actual operations separately.

The application mounts the endpoint explicitly; there is no automatic route or
metadata discovery. A sibling path avoids a GraphQL prefix mount intercepting it.
Authentication, CORS and rate limiting remain application responsibilities.

- GET returns JSON and a strong ETag over stable bytes. HEAD returns headers with
  no body, including on errors. Other methods get 405 with `Allow: GET, HEAD`.
- Context and access checks run on every GET/HEAD, including conditional requests.
  A matching `If-None-Match` returns 304 after authorization; weak tags, lists and
  `*` are supported.
- Public responses use `Cache-Control: no-cache`. Gated responses use
  `private, no-cache` and `Vary: Authorization, Cookie`. Errors use `no-store`.
- The handler captures its options and the document at creation. It never evaluates
  dynamic GraphQL permission rules to filter individual operations.

## Disable the legacy extension explicitly

The 3.x default remains unchanged: importing the runtime installs the shared
`__Field.extensions` extension. Metadata-aware legacy clients keep working.
To avoid installation, configure **before importing the runtime or a facade**:

```javascript
// configure-simfinity.js
import { configureIntrospection } from '@simtlix/simfinity-core/introspection';
configureIntrospection({ fieldExtensions: false });
```

```javascript
// server.js — separate file, with no cycle through the configuration module
import './configure-simfinity.js';
import './application.js';
```

The configuration subpath does not load the runtime. Putting its call below a
runtime import in the same module is too late: static imports evaluate first.
Node applications can also preload the configuration file using `--import`.

Only `{ fieldExtensions: false }` is supported. Repeating a successful opt-out is
idempotent. A late call throws `INVALID_INTROSPECTION_CONFIGURATION` (500) and
leaves the installed extension untouched. No existing metadata fields or types
are deleted. The setting applies to cooperating Simfinity copies sharing one
GraphQL peer in one JavaScript realm, not to an individual runtime or schema.
An older core or another library can still patch that peer; use aligned packages.

Without the patch, standard introspection and `buildClientSchema` no longer have
this particular duplicate-metadata-type problem. This is not a compatibility
promise for arbitrary gateways, transforms, resolver cloning or middleware.
Public runtime middleware APIs are unchanged; use the official Envelop auth
plugin and in-place resolver wrapping.

## Client migration boundary

Serving the descriptor does not update existing clients. Clients that still
select `__Field.extensions`, including the inspected simfinity-js-client 1.1.0
and simfinity-web implementations, fail against an unpatched schema. Keep the
3.x default until your clients read the descriptor or need no Simfinity metadata.
The Barber examples retain their current configuration and dependencies.

A descriptor-aware reader fetches the explicitly configured metadata URL, checks
`formatVersion`, and uses exact operation names and concrete input types. It must
not fall back after 401/403. Updating simfinity-js-client/simfinity-web, preserving
their getter shapes and agreeing on discovery/fallback behavior are separate
client changes; no client release or universal automatic retry is implied here.
