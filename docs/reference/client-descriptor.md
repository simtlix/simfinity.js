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

Both `buildClientDescriptor` and `createClientDescriptorHandler` are named exports
of the optional `@simtlix/simfinity-descriptor` package. It depends on the exact
matching core version; the facades do not re-export it. Install it as a direct
application dependency, aligned with your Simfinity packages. This package is new
in the next release; it is not part of the published 3.12.0 API.

Core remains dependency-free. The handler uses structural request/response types
compatible with Node HTTP and Express; its declarations need no Node ambient
types. Importing the descriptor package does not install introspection extensions.

## Build for the schema you serve

```javascript
import { buildClientDescriptor } from '@simtlix/simfinity-descriptor';

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

Core captures the registrations, initial state and field queryability for each
schema at construction. The descriptor package builds and freezes the full
metadata document on the first `buildClientDescriptor()` call. Finish schema
declarations before that call; create a new schema and handler when metadata
changes. A later registration or another schema does not change an earlier
descriptor. Repeated calls return the same frozen document. In-place auth resolver wrapping is supported. Freezing metadata
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
| `generator` | Descriptor package name and version, independent of the format version. |
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
are present. A state machine has `field: 'state'`, `enum`, external
`initialState` (or `null`), `states` and `actions`. Each action has `name`, the exact
`mutation`, `description`, `from` and `to` (external state names, or `null`).
Interfaces/unions include `possibleTypes`; objects/interfaces list
`interfaces`. Enums list external names, descriptions and deprecations, never
internal enum values.

Fields/arguments use complete SDL type references, such as `[Book!]!`. Fields
carry descriptions, deprecations, `readOnly`, `unique`, `stateMachine`, and optional
`relation`, `virtual`, `queryable`, `rootInputUsage` and `args`. Field `kind` is
`scalar`, `enum`, `embedded`, `reference`, `collection`, `object`, `interface` or
`union`. There are no separate `named`, `required`, `list` or `itemRequired` flags;
read those from the complete type reference. Input fields and arguments include
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

`rootInputUsage` describes a field in the **generated root** `add` and `update`
operations exposed by this schema. For each operation, the value is `'required'`
if the actual input field is non-null and has no default; it is `'optional'` if
nullable or defaulted. An absent field has no key. An empty object means neither
root operation accepts the field; the property is omitted entirely if that type
has no generated add/update root. This describes input shape, not authorization.
For example, `Project!` becomes a required relation input for add when the actual
add input is non-null without a default. Update may still accept it optionally.

Inspect the concrete operation's arguments and input graph to build writes.
A root input and an `added` or `updated` nested item can accept different fields,
including omitted back-references. The descriptor does not invent a universal
writability flag or an endpoint whose input is unavailable. A child may require
its parent in a root add while the nested `added` input omits that reference
because the parent supplies it. Use `inverseField` as a relation hint without
deleting that field globally from the child metadata.

Validators, scopes, controllers, auth rules, indexes, private storage links and
arbitrary application extensions are not published. The document describes what
the schema exposes, not what the current caller may execute.

An abridged document for a synthetic Serie/Season/Episode schema follows. Fields
and types not relevant to the example are omitted.

<!-- descriptor-example -->
```json
{
  "formatVersion": 1,
  "roots": {
    "query": "RootQueryType",
    "mutation": "Mutation"
  },
  "operations": {
    "query": {
      "featured": {
        "operation": "list",
        "type": "Serie",
        "view": "featured"
      }
    }
  },
  "types": {
    "Serie": {
      "kind": "entity",
      "endpoints": {
        "get": "serie",
        "list": "series",
        "aggregate": "series_aggregate",
        "add": "addserie",
        "delete": "deleteserie",
        "update": "updateserie"
      },
      "stateMachine": {
        "field": "state",
        "enum": "PublicationState",
        "initialState": "DRAFT",
        "states": [
          "DRAFT",
          "LIVE"
        ],
        "actions": [
          {
            "name": "publish",
            "mutation": "publish_serie",
            "description": "Publish a serie",
            "from": "DRAFT",
            "to": "LIVE"
          }
        ]
      },
      "fields": [
        {
          "name": "name",
          "type": "String!",
          "kind": "scalar",
          "unique": true,
          "rootInputUsage": {
            "add": "required",
            "update": "optional"
          }
        },
        {
          "name": "summary",
          "type": "String",
          "kind": "scalar",
          "readOnly": true,
          "virtual": {
            "mcp": "tool"
          },
          "rootInputUsage": {}
        }
      ]
    },
    "Episode": {
      "fields": [
        {
          "name": "season",
          "type": "Season",
          "kind": "reference",
          "relation": {
            "target": "Season",
            "embedded": false,
            "connectionField": null,
            "displayField": "number",
            "inverseField": "episodes"
          },
          "rootInputUsage": {
            "add": "optional",
            "update": "optional"
          }
        }
      ]
    },
    "EpisodeInput": {
      "kind": "input",
      "fields": [
        {
          "name": "title",
          "type": "String",
          "hasDefault": true,
          "defaultValue": "\"Untitled\""
        }
      ]
    }
  }
}
```

## Mount the HTTP handler

```javascript
import { createClientDescriptorHandler } from '@simtlix/simfinity-descriptor';

app.all('/graphql-metadata', createClientDescriptorHandler(schema, {
  context: (req) => authenticateRequest(req),
  authorize: (_req, context) => Boolean(context.user),
  onError: (error) => logger.error(error),
}));
```

`app`, `schema`, authentication and logging belong to the application. Use
`authorize: 'public'` to deliberately expose the whole descriptor publicly.
Missing access configuration or unknown options fail at setup with `INVALID_CLIENT_DESCRIPTOR_OPTIONS`
(500). A gate grants access only on `true` or `undefined`; other results deny.
Throw `UnauthenticatedError` for 401 or `ForbiddenError` for 403. The example
denies both `null` and `undefined` users. Expected denials do not call `onError`.
Unexpected errors call `onError(error, req, res)` and are masked as 500 with an
`errors` envelope; observer failures do not replace that response. GraphQL auth still enforces actual operations separately.

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

Version 1 has no include/exclude selectors and no `cacheControl` or `vary`
overrides. These remain deferred; passing them as handler options throws at
setup. Use separate `createSchema()` allowlists for separate audiences instead
of advertising operations that the served schema does not expose.

In production, GraphQL introspection can be disabled independently of this
endpoint. Gate the descriptor with application authentication, or deliberately
choose `'public'`; neither choice evaluates dynamic GraphQL auth for each caller.

## Disable the legacy extension explicitly

The 3.x default remains unchanged: importing the runtime installs the shared
`__Field.extensions` extension. Metadata-aware legacy clients keep working.
To avoid installation, configure **before importing the runtime or a facade**.
A direct import from `@simtlix/simfinity-core/introspection` requires core as a
**direct dependency pinned to the facade's exact version**, including with pnpm
or Yarn PnP. Installing only a facade or the descriptor package is insufficient
for that direct import under isolated dependency layouts:


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
