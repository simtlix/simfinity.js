# Schema-owned client descriptor and early introspection opt-out

Status: initial implementation approved on 2026-10-23; the 2026-10-25 revision
below is approved and supersedes the historical design that follows. See the [implementation record](../plans/2026-10-23-client-descriptor.md).

Issue: [#101](https://github.com/simtlix/simfinity.js/issues/101). Read on
2026-10-23; open, last updated 2026-10-16, no comments. Its examples are proposals.
Implementation base: `738767141ecb3e017a9a590e52c7e1a795f68428` (3.12.0), verified
against remote master. Branch: `feat/101-schema-descriptor`.

## Revision approved 2026-10-25 (supersedes the placement and input-hint decisions below)

- Ship builder, format v1, package identity and the HTTP handler in the opt-in
  `@simtlix/simfinity-descriptor` package. It joins the aligned release set at
  3.12.0 with an exact core dependency; there is no version bump or publication.
- Core retains early `/introspection` and immutable per-schema registration data
  through `/internal/schema-registrations`. This is registration data, not a
  descriptor format or HTTP API. Snapshot initial state and queryability before
  auth wrapping; never retain a runtime callback or storage model/controller.
- Remove descriptor exports from core and the facades, core `/http`, and core's
  `@types/node` dependency. Reuse the canonical error class through a side-effect-free
  internal errors subpath. Importing the descriptor must not install introspection.
- `rootInputUsage` replaces the ambiguous proposed `write` name. It appears on
  entity fields only when this schema exposes a generated add/update root, and
  reports that root's actual input field as `required` only when NonNull without
  a default, otherwise `optional`. Omit an operation key if absent from its input;
  read-only/generated fields can have an empty usage map. Omit the entire property
  on types with no generated add/update root. Nested inputs and relation inverse
  hints remain authoritative for collection forms; never erase a root field
  merely because a collection supplies it from its parent.
- Registration/queryability values are captured during createSchema. Descriptor
  graph data is built and frozen on the first explicit builder call; applications
  must finish schema declarations first and create a new schema for metadata changes.
- Handler types are structural and usable with Node/Express objects without Node
  ambient types. `onError` observes unexpected failures only, never expected 401/403.
  Keep explicit authorization, authorization before 304, fixed cache policy and HEAD behavior.
- Selectors and cache header overrides are explicitly deferred. Preserve split
  query/mutation maps and customQuery/customMutation; views remain list+view.
- Address review documentation and test gaps. Test MCP's observable API without
  exposing a classifier just for tests. Direct core imports require an explicit
  exact-version core dependency, including with pnpm/Yarn PnP.

## Historical design (2026-10-23; apply the revision above first)

### Problem and existing implementation

`packages/core/src/introspection.js` installs `__Field.extensions` at import.
Every subsequent schema using the same GraphQL peer collects the metadata types,
including schemas unrelated to Simfinity. An earlier schema retains its original
type map. An in-process `buildClientSchema(introspectionFromSchema(schema))`
roundtrip can consequently fail with duplicate metadata names.

The default must remain unchanged in 3.x. Client metadata must also remain
available when an application explicitly disables that extension.

`createSchema()` builds new roots over shared entity types. Its query, mutation,
custom-mutation and custom-query allowlists belong to the returned schema, not
just the runtime. Existing ownership checks protect generated relation resolvers;
a descriptor must not relax those checks or infer ownership from type names.

Reuse these existing mechanisms:

- `runtime.js`: actual generated roots, registrations, generated input types,
  `applicationResolvedFields`, and existing query/mutation markers.
- `relation-storage.js`: `normalizeConnectionField`, `isVirtualField` and
  `virtualFieldOptions`.
- `auth/index.js`: existing in-place resolver wrapping. Do not add a get-by-ID
  `simfinityQuery` marker: auth interprets that marker as client filter paths.
- `metadata.js`: its scalar-chain traversal is useful prior art, but
  `describeModels()` describes storage, excludes virtual fields and rejects some
  valid client-facing shapes. It is not the descriptor builder.
- MCP already handles external defaults with GraphQL's `astFromValue`; core must
  not depend on MCP to obtain that behavior.

The issue predates custom queries and named views. Version 1 must describe both.
A query and a mutation can legally have the same field name, so the issue's flat
`operations[name]` map is insufficient.

## Approaches and recommendation

1. **Recommended: public early configuration plus a schema-owned descriptor.**
   A small configuration subpath does not load the runtime or install the patch.
   Configure it before importing the runtime/facades. Normal imports keep their
   current behavior. An already installed patch is never removed.
2. **Alternative: additional runtime/facade entry points without the patch.**
   This avoids an explicit configuration call but adds another entry surface for
   core and both facades. Importing a legacy entry elsewhere still contaminates
   the same GraphQL peer; mixing modes would need an explicit rejection policy.

A late per-runtime `createSchema` option cannot control a patch installed before
the runtime exists. The old #96 implementation deleted `__Field.extensions` and
tracked only Simfinity-created schemas; it cannot prove that an unrelated schema
has not already collected those types. Do not reuse that implementation or its
private flags.

The user approved the recommended early-configuration approach and this v1 contract on 2026-10-23.

## Proposed public API

```ts
// @simtlix/simfinity-core/introspection: no runtime import or patch installation
configureIntrospection({ fieldExtensions: false }): void;

// Core root, re-exported by MongoDB and PostgreSQL facades
buildClientDescriptor(schema: GraphQLSchema): ClientDescriptor;

// @simtlix/simfinity-core/http; re-exported by the Node database facades
createClientDescriptorHandler(schema: GraphQLSchema, options: {
  authorize: 'public' | ((req, context) => boolean | void | Promise<boolean | void>);
  context?: unknown | ((req) => unknown | Promise<unknown>);
  onError?: (error, req, res) => void;
}): (req, res) => Promise<void>;
```

These signatures summarize the approved contract. The implementation uses Node
request/response types and a generic context type.
Keep Node-specific declarations in the HTTP subpath and Node facades, so importing
only core's builder does not require the HTTP declaration graph.
No selectors, dynamic permission evaluation or second descriptor detail level in
v1: describe exactly the schema passed. Separate audiences use separate schemas.

### Configuration timing

The setting affects all Simfinity runtimes sharing the GraphQL peer in the same
JavaScript realm. It is not per schema. The descriptor ownership is per schema.

Only the exact option `{ fieldExtensions: false }` is supported initially.
Reject malformed options and an attempt to disable after installation with a
typed setup error, `INVALID_INTROSPECTION_CONFIGURATION` (500).
Repeating the successful disabled configuration is idempotent. With no call, the
legacy extension, naming behavior and auth exemptions remain unchanged.

The configuration module and installer share state keyed by the GraphQL peer;
repeated core evaluation must not reinstall the patch. A versioned internal
`Symbol.for` registry containing a WeakMap keyed by `__Field` can coordinate this
without adding fields or properties to GraphQL types. This is not an application
API. Detect an already present `__Field.extensions` before accepting opt-out;
never remove or reinterpret another library's extension. Do not claim to detect
every arbitrary `GraphQLSchema` ever created: pre-install configuration avoids
needing that capability.

All loaded runtime copies must support this configuration protocol. An older
core copy or an unrelated library can still modify its own shared GraphQL peer;
this API does not intercept them. Keep application Simfinity packages aligned.

Static ESM bootstrap example, with no runtime import in the configuration module:

```js
// configure-simfinity.js
import { configureIntrospection } from '@simtlix/simfinity-core/introspection';
configureIntrospection({ fieldExtensions: false });

// server.js — two separate files; this module has no cycles through configuration
import './configure-simfinity.js';
import './application.js';
```

Putting both a runtime import and the configuration call in one module is too
late: static imports evaluate before that module's body. Node applications can
also preload the configuration module with `--import`. Documentation must state
this ordering requirement and show the typed late-configuration failure.

### Ownership and lifetime

`createSchema()` records an internal snapshot in a module-local
`WeakMap<GraphQLSchema, Snapshot>` after successful construction. Capture the
registrations and operation associations used for that schema, input identities,
state names and the existing application-resolver classification. Copy the
allowlisted metadata; do not retain models, sessions, controllers, scopes or
validator closures in the descriptor snapshot.

The builder accepts only an exact schema returned by this core installation.
Schemas created by another copy of core, arbitrary GraphQL schemas and transformed
copies fail with `NOT_A_SIMFINITY_SCHEMA` (500). There is no global
descriptor registry, registration-by-name API or ownership transfer in v1.
MongoDB/PostgreSQL facade re-exports use the same core module and registry.

The returned JSON-compatible descriptor is immutable and cached per schema.
Declaration shapes and metadata are finalized before `createSchema`; structural
mutation after creation is unsupported by this descriptor contract. In-place
auth wrapping remains supported and does not change classification. A later
registration or schema must not change a previous descriptor, including when
that previous descriptor is first requested after the registration changed.
Freeze copies only, never the schema or application extension objects.

There is no promise that a frozen descriptor freezes execution semantics of
existing shared types, mutable scopes or named-view runtime lookups.

### Minimal version-1 document

| Member | Proposed meaning |
| --- | --- |
| `formatVersion` | `1`; unknown optional keys can be ignored, incompatible semantics need a new version. |
| `generator` | Core package name and actual version; no invented release number. |
| `roots` | Actual query/mutation names; absent mutation is `null`. |
| `operations.query`, `operations.mutation` | Separate maps keyed by field name. No collision across roots. |
| `types` | Named types reachable through exposed roots, arguments, inputs, interfaces and possible types; includes required built-in scalars. |

Operations contain actual argument definitions and return type references, a
description, entity association where known, and an explicit kind. Kinds cover
get/list/aggregate/add/update/delete/transition/customQuery/customMutation.
A named view is a list with a view name; it does not replace the entity's
canonical list endpoint. Include public parameters, never its `where` function.
Do not classify custom queries from a list return or a name suffix.

Types describe objects/entities, inputs, interfaces, unions, enums and scalars.
Fields and arguments use SDL type references such as `[Book!]!`, preserving
arbitrary wrapper nesting. Avoid duplicate `required`/`list`/`itemRequired`
representations in the initial contract. Include descriptions, deprecations,
interfaces/possible types, enum names and actual input fields.

Registered types expose only endpoint/input associations present in this schema.
State-machine metadata includes enum names, initial state and only exposed action
mutations with their `from`/`to`. A relation-only type has no invented endpoints.

Allowlisted field hints: relation target, declared `connectionField` and
`displayField`, resolved `inverseField`, effective `readOnly`, declared `unique`,
`virtual` and its MCP setting, and local `queryable` eligibility on registered
types. Use existing resolver classification; do not inspect auth wrappers as
application resolvers. `queryable` is not a guarantee for every path, operator,
adapter or caller. `unique` describes the declaration, not universal database
enforcement. Unknown arbitrary extensions are omitted.

`inverseField` uses GraphQL field names, not a generated private storage link.
Absent or ambiguous inverses produce `null`. Preserve the declared legacy
`connectionField` separately. No type-level display-field default is introduced.

The actual operation's input graph is authoritative for writable fields. Do not
add a universal field `write` flag in v1: a root input and a nested collection item
can accept different members. Clients must inspect that operation's concrete
input type, including omitted inverse fields and unavailable nested operations.

Scalar `baseScalar` is a declared base-chain hint with cycle protection, not a
serialization guarantee or serialized validator. Defaults use external GraphQL
literals with a separate `hasDefault` indicator; internal enum values must not
leak. A custom scalar default that cannot be represented is omitted without
rejecting an otherwise accepted schema. Converting a default may invoke that
scalar's `serialize`, as introspection does; never run its validator separately.

Do not expose storage descriptions, private links, indexes, controller code,
scopes, validators, auth rules or raw internal query/mutation markers. Exclude
introspection-only types by reachability/identity, not reserved-name strings:
application types named `RelationType` must remain describable.

### Handler and consumption

The handler builds the descriptor and stable JSON bytes once at setup. Core's
main entry stays free of Node built-ins; hashing belongs to the HTTP subpath.
Maps have sorted keys; arrays retain declaration order. No timestamps or random
identifiers enter the document.

Require `authorize: 'public'` or a gate function. Context and authorization run
before a successful response or a conditional `304`. Only `true` or `undefined`
grants access; other results deny. Preserve 401/403 from auth errors, mask
unexpected errors as 500, and let `onError` observe the original error without
allowing an observer failure to prevent the response.

Serve GET and HEAD, with JSON content type and a strong ETag. HEAD never has a
body, including on failure. Other methods return 405 and `Allow: GET, HEAD`,
before context/auth work. Conditional requests support weak comparison, tag
lists and `*`. Public responses use `no-cache`; gated responses use
`private, no-cache` and `Vary: Authorization, Cookie`. Errors use `no-store`.
Do not add configurable cache policy in v1. Errors use a small GraphQL-style
`errors` envelope; the descriptor endpoint never evaluates GraphQL auth rules.

The application chooses and mounts an exact path. Examples use the sibling
`/graphql-metadata`, avoiding a `/graphql` prefix mount swallowing the request.
It is an example route, not automatic discovery or a client default.

```js
// application.jss, after the early bootstrap when opting out
import * as simfinity from '@simtlix/simfinity-js';
// PostgreSQL uses the same builder/handler contract from its own facade.

// Register application types, then create the schema used by this endpoint.
const schema = simfinity.createSchema();
const descriptor = simfinity.buildClientDescriptor(schema);
const endpoint = descriptor.types.Book.endpoints.add; // e.g. 'addbook', not 'addBook'
const args = descriptor.operations.mutation[endpoint].args;

app.all('/graphql-metadata', simfinity.createClientDescriptorHandler(schema, {
  authorize: 'public', // deliberate for this application's public schema
}));
```

This is an illustrative excerpt, not a runnable application or an existing client
API. Consumers can fetch the document with `fetch('/graphql-metadata')` and
resolve argument/input shapes through `types`. Serving an alternate format does
not teach existing clients to read it.

## Compatibility and repository boundaries

The 3.x default preserves all existing introspection output. Opt-out is usable
only with descriptor-aware clients, an application-owned descriptor reader or
clients that need no Simfinity metadata. Current clients that select
`__Field.extensions` remain incompatible with disabled mode; do not silently
disable it in Barber or claim those clients already work.

Read-only source inspection confirms `simfinity-js-client` at `32d9c5b` requests
the extension in `init()` and constructs CRUD names from type names.
`simfinity-web` at `9aa971e` hard-codes root/metadata names and matches relation
storage strings. Its checkout has local changes; inspect committed source for
changed files, and do not edit either repository in this task.

Client work is a separate assignment: descriptor detection, exact endpoint use,
preservation of introspection-shaped getters, nested-input handling, auth headers,
and migration/fallback tests. Never fall back after descriptor 401/403. Do not
promise automatic retries of arbitrary GraphQL operations or universal fallback
on every validation failure. No client release number is promised here.

Unpatched standard introspection removes this particular duplicate-type cause.
It does not certify `mapSchema`, middleware schema cloning, gateway composition,
auth propagation, resolver ownership or metadata transfer. Preserve public
middleware exports. Keep the existing guidance against schema-cloning middleware
until a specific supported composition contract is separately established.

No change to core/SQL driver boundaries. No MCP dependency in core. MCP continues
using its schema tooling; parity checks should cover the common classifications,
but its structural fallback for custom queries is not the descriptor's authority.
No dependency on #147 or #148: both were open and unmerged on 2026-10-23.
Integration points are `createSchema`, generated inputs/operation markers and
their tests. Consume future OCC/input/filter shapes structurally; do not copy
either branch or change lifecycle, transaction or collection-frame semantics.

## Acceptance tests for implementation

1. Fresh-process import-order fixtures: default behavior unchanged; early opt-out
   through core, MongoDB and PostgreSQL; repeated evaluations; mixed package
   imports; unrelated schemas before and after installation; late opt-out rejects
   without mutation; no reinstallation after disabling.
2. Two schemas from one runtime sharing types but with different root allowlists;
   two runtimes using distinct types with equal names; descriptor requested before
   and after registration replacement. No cross-schema endpoints or state data.
3. Reject a foreign schema, a `toConfig` copy and a schema owned by another core
   module instance. Existing runtime ownership checks and auth tests stay intact.
4. Query/mutation name collisions, custom queries, named views, custom mutations,
   no mutation root, omitted empty inputs, state transitions, root and nested
   input differences, interfaces/unions and nested list type references.
5. Relations with a declared GraphQL or storage inverse name, default reference
   storage name, missing/private/ambiguous inverses; virtual/read-only fields;
   app resolvers and queryability before/after auth wrapping; scalar chains and
   enum defaults with internal values different from names.
6. MongoDB/default/transactional and PostgreSQL schema fixtures. Descriptor
   construction needs no database I/O. Explicitly test the shapes accepted by
   default MongoDB that `describeModels` rejects. Real DB checks, if needed for
   changed behavior, use only separately configured disposable databases.
7. Identical descriptor with legacy patch on/off or renamed. Builder/handler
   setup changes no SDL, introspection result, field extension or resolver.
   Output contains no functions, internal values or storage-only metadata.
8. HTTP GET/HEAD/405, strong tags and weak/list/wildcard conditional matches,
   authorization on cache hits, per-request context, error masking, failing
   `onError`, and denied HEAD without a body. Deterministic bytes across processes.
9. Package consumers for core root/introspection/http and both facade re-exports;
   NodeNext/Node16/Bundler/Node10 declarations and archive contents; no driver/MCP
   dependencies in core and no Node imports from its main-entry graph.

Implementation must update README, affected package READMEs, API/introspection and
compatibility docs, relevant agent rules, declarations and package-consumer tests.
Run root lint/tests, package checks and documentation build on the actual changed
base. Do not reuse baseline evidence as evidence of the future implementation.

## Design-phase baseline verification (before implementation)

- Node.js `v24.2.0`; installed this worktree's locked dependencies with
  `npm ci --ignore-scripts --no-audit --no-fund` (no manifest/lock changes).
- `npm run lint`: passed.
- Existing schema initialization, metadata names, runtime and auth suites:
  4 files, 278 tests passed. The first command also named two nonexistent suite
  paths; those were not counted as coverage.
- Actual custom-query, view, view-MCP, custom-query-MCP, virtual-field and core
  subpath suites: 6 files, 229 tests passed.
- A fresh Node assertion probe reproduced unrelated-schema contamination and the
  duplicate-type roundtrip, valid same-name query/mutation fields, shared entity
  identity with distinct schema roots, view inclusion despite an empty
  custom-query allowlist, and the absence of a get-by-ID query-path marker.
  The initial probe omitted the required view description and failed with
  `INVALID_VIEW`; adding that fixture description made all assertions pass.
- These baseline checks do not verify the implementation. Implementation results
  are recorded in the plan completion section.
- `npm run docs:install`: passed, audit reported zero vulnerabilities.
- `npm run docs:build`: passed; Vite emitted its chunk-size advisory.
- Independent builder review: no additional important planning questions.

## Approved public decisions

| Issue question | Recommendation for v1 |
| --- | --- |
| Route/discovery | Application-mounted path; examples `/graphql-metadata`; explicit client URL later. |
| Builder placement/dual copies | Core root + facade re-exports; module-local schema ownership; no cross-copy adoption. |
| Transformed schemas | Reject; no name matching or inferred metadata transfer. |
| Detail | Full input/type graph; no detail switch or selector API initially. |
| Authorization | Required explicit public access or whole-document gate. |
| Fetch/Yoga variant | Defer; pure builder remains usable by those hosts. |
| Negotiation | Version field only for v1; no hypothetical older-format serving. |
| Display defaults | Preserve declared relation hint; no type-level fallback. |
| Deprecation | Document migration; no new warning or default flip in this delivery. |
| Naming | Client descriptor; avoid storage-oriented `describeSchema`/`describeModels`. |
| Opt-out timing | Public configuration subpath before runtime import; reject late calls, never delete installed metadata. |
| Format corrections | Separate operation roots; actual input graph instead of universal write flags; include custom queries/views/virtuals. |

The user approved this v1 contract on 2026-10-23. No further library API decision
is pending for this scope. Client URL discovery, fallback behavior and client
API adaptation remain separate work; this implementation does not decide them.
