# Simfinity Client in the monorepo

Date: 2026-10-30
Status: approved by the user on 2026-10-30 and implemented. Independent design and whole-branch reviews completed; see the verification report under docs/superpowers/reports/.

## Intent and agreed direction

Bring `@simtlix/simfinity-js-client` into this repository and support the public client-facing features present in Simfinity 3.18.0. The user accepted the recommendation to preserve the current JavaScript API and add capabilities compatibly. Preserve the package name, default `SimfinityClient` export, existing call signatures, builder chaining and documented result shapes.

The source is the sibling `simfinity-js-client` checkout, commit `32d9c5bf7264cd3ecddcd3441bffea3b21566cb0` (version 1.1.0). Import its tracked implementation, README, license and useful demo, recording the full source commit as provenance. Do not import old `.tgz` archives, `.claude`, Git metadata or the old implementation prompt. Copy a source snapshot; retaining the old repository's complete Git history is not required by this proposal.

The monorepo is at 3.18.0 on commit `55fb651`, currently checked out on `chore/barber-simfinity-3.18.0`, with unrelated local changes. Implementation must use its own `codex/` branch and preserve those changes and the sibling checkout. This design file is the only intended edit during design preparation; commit it with the implementation branch after approval.

## Goals

- Make the existing client an owned, documented and tested monorepo package.
- Support both legacy extended introspection and schema-owned descriptor format 1, including servers that disable extended introspection or all GraphQL introspection.
- Discover exact operations, distinguish canonical lists from named views and custom queries, and respect each schema's allowlists.
- Expose text/list/emptiness operators, field comparisons, quantified collection and embedded-element filters, collection-field arguments and named-view params without changing their server semantics.
- Support managed versions on updates, deletes, actions and nested writes, and expose the generated transaction mutation.
- Publish complete browser-compatible declarations and verify actual packed consumers.
- Prove generated requests against real GraphQL schemas and, for database semantics, both supported engines.

## Constraints and exclusions

The browser client uses HTTP metadata and GraphQL only. It must not import core, SQL, the descriptor builder, Mongoose, pg, MCP, Node built-ins or server internal modules at runtime. Shared runtime errors and their identities stay untouched; client transport errors preserve GraphQL errors rather than importing server error classes. Keep the implementation dependency-free unless a specific implementation need is demonstrated and reviewed.

Metadata describes a schema, not a caller's permissions or an adapter's supported queries. Do not infer authorization from descriptor fields, retry writes automatically, refresh versions automatically or reimplement server business rules. No server feature, database schema, React component redesign, subscriptions, code generation, cache layer or runtime backend switching is included.

No package publication, release tag or version bump is authorized by this task. The eventual reviewed PR needs a repository issue with the use case, current gaps, browser-client ownership and both-engine coverage before opening it. No external comments or review feedback should be posted without authorization.

## Approaches

1. **Compatible package import plus shared metadata normalization — recommended and accepted direction.** Keep the current class and API, add descriptor ingestion and a complete introspection input graph, then drive request construction from the normalized schema. It retains existing consumers and gives new server features one source of truth.
2. **New client API with a major redesign.** Could replace the builders and metadata accessors, but requires migrating consumers such as Barber and was not the user's selected direction.
3. **Copy only, with new features left to raw GraphQL.** Cheap to move, but leaves incorrect endpoint selection, missing versions and inadequate metadata/input support. It does not meet the update request.

## Package and release integration

Proposed implementation choice: put the library at `packages/client`, retaining its public name and default entry `src/SimfinityClient.js`. Add `types/index.d.ts`, a types-first conditional root export and an explicit publication file list containing source, declarations, README and license. Keep Node >=18.18.0 aligned with the monorepo and document the existing requirement for fetch in the execution environment. Browser import must not execute Node-only code or contact a server.

Proposed implementation choice: add the client as the seventh package in the existing aligned release set. This reuses the monorepo's publication, archive verification and registry integrity gates rather than adding a parallel release workflow. The client version will follow the monorepo, with the jump from 1.x documented as a packaging/version-policy change; the JavaScript compatibility promises above still apply. Adding a package to the source does not republish the existing 3.18.0 release. At implementation time match the checked-out root version for source consistency; a future requested release chooses a new unpublished aligned version through the release helper.

Update the release package list, manifest expectations, package-quality and isolated-consumer tests, workspace lockfile and package-set documentation. Audit publication/registry tests and release fixtures for hardcoded six-package assumptions. Core, SQL and PostgreSQL gain no dependency on the client. The client needs no publication ordering dependency because it consumes JSON/HTTP, not a server package.

The existing npm package already exists. Its Trusted Publishing configuration will need to point to this repository's existing tag-triggered release workflow before a later client release; record this operational requirement without mutating account settings or claiming publication now. Include GitHub Packages availability/configuration in that later release's checks.

## Metadata sources and normalized representation

Preserve `new SimfinityClient(endpoint, options)` and `await client.init()`.

Add optional, mutually exclusive `options.descriptor` (a descriptor document) and `options.descriptorEndpoint` (an explicitly supplied metadata URL), plus optional `options.fetch` for an injected HTTP implementation. With neither descriptor option, retain extended-introspection initialization. Add `options.introspection: 'extended' | 'standard'` with `'extended'` as default. Descriptor mode does not issue an introspection request. No endpoint guessing, background probing or silent fallback after authorization/transport errors.

A descriptor URL is fetched with GET. The same `prepareHeaders` mechanism applies per request; no ambient credentials option or URL is invented. Preserve the existing synchronous callback and permit an async callback additively by awaiting its result. Resolve fetch at construction or request time so an explicit implementation can be used without a global fetch. Do not capture one global fetch permanently at module import.

Validate the descriptor envelope, format version, operation/type references and complete SDL type references sufficiently to construct requests. Ignore unknown additive properties in format 1; reject unsupported format versions and structurally unusable metadata. Loading either source builds a fresh registry and installs it only after successful completion, avoiding mixed metadata after a failed init/re-init. Metadata belongs to each client instance; no endpoint-global metadata cache or inferred sharing across schemas.

The internal model retains full type references, field arguments, input-object fields, enum values, descriptions/defaults, interfaces/union possible types and descriptor operation classifications. Preserve the existing `getTypes/getQueries/getMutations/getFieldsOfType` view shapes (`kind`, unwrapped `type`, `rawType`, field extension view); new information is additive. Descriptor mode normalizes its SDL strings into the same wrapper representation. Expose `getDescriptor()` for the descriptor document when used (otherwise null), without importing descriptor runtime code. Declare the structural client-side descriptor input without a required server-package or GraphQL type dependency.

Introspection must request input fields and full wrapper types as well as output fields and arguments. The standard form excludes `__Field.extensions`; in that mode Simfinity relation/state flags that standard introspection cannot provide remain unknown. Document those limits and use descriptors for authoritative operation classification and relation metadata. Do not request newly added optional introspection fields unconditionally against old servers.

## Exact operation lookup and public additions

Descriptor `types[entity].endpoints` and `operations` supply exact roots. Never overwrite a canonical list because a view or custom query returns the same type. Respect a missing query/mutation root and excluded endpoints. Keep query and mutation name registries separate, including identical custom names on both roots.

Legacy introspection keeps existing generated-name conventions and familiar type lookup. Use available root signatures/descriptions to avoid treating arbitrary same-return-type custom queries as generated CRUD. Prefer an identifiable canonical list; if metadata truly cannot disambiguate, require an explicitly named operation instead of silently selecting the last field. Tests pin the existing client's valid supported cases. No claim that standard introspection can reconstruct metadata which is not present in it.

Add the following APIs; exact existing signatures remain accepted:

- `client.query(name, args?, fields?)`: execute an exact query root. A scalar or enum result has no selection braces; object results default to scalar/enum selections, and interface/union selections accept an explicit selection including fragments and `__typename`. This is also the explicit escape hatch for roots not classified by introspection.
- `client.findView(name, params?)`: a normal QueryBuilder bound to that exact list root, with named params. Descriptor mode verifies the operation is a view; legacy mode verifies a list root and its available arguments without claiming view provenance. Add `getViews(typeName?)` returning descriptor-classified views (empty when unknown).
- `QueryBuilder.filter(group)` and `AggregateBuilder.filter(group)`: append a whole `QLFilterGroup` as one AND group, preserving witness boundaries. Existing `.and()` and `.or()` remain unchanged. These groups carry `conditions`, `AND`, `OR`, `ANY`, `ALL` and `NONE` as the schema declares.
- `.where(field, filterObject)` in both builders, alongside both current overloads. The object is the server's field filter, supporting `operator`, `value`, `value2`, `valuePath`, `terms` and `quantifier` without inventing values. Existing `.where(field, operator, value, value2)` and term-array forms retain their semantics. Preserve `$parent` paths as literal strings; never evaluate or rewrite them.
- `QueryBuilder.collectionArgs(path, args)`: attach schema-declared arguments to that nested collection selection using GraphQL variables. This is distinct from the existing `joinCollection(path, fields, filter)` parent-filter behavior, which stays intact. Validate each path and its actual field arguments; allocate collision-free variables for multiple/nested occurrences.
- `client.transaction(operations, fields?, options?)`: bind to the descriptor-classified generated transaction root; `options.name` selects an exact root explicitly when needed. In introspection mode require its exact name rather than classifying an arbitrary structurally similar custom mutation as generated. Preserve operation keys and `$K`/`$$K` strings, send one variable-bearing mutation, and return its result list in server order. Default selection includes result IDs; explicit fields can select each operation's returned record/version. Validate the selected operation's arguments/input shape; the server remains authoritative for transaction eligibility and cross-operation references.

Do not silently discard explicitly supplied unknown arguments in new exact-root/query/collection APIs. Existing builder combinations that were valid remain valid. Invalid unsupported operations should produce useful client or server errors rather than a request that quietly loses a filter.

## Operators, selections and result compatibility

Discover operator enum members from the schema instead of maintaining a competing operator list. Cover ILIKE, STARTS_WITH, ISTARTS_WITH, ENDS_WITH, IENDS_WITH, IEQ, IS_EMPTY, IS_NOT_EMPTY, CONTAINS_ALL and IIN, as well as existing operators. Enum presence alone is not proof of backend support. Preserve server errors such as UNSUPPORTED_QUERY and INVALID_FILTER_PATH.

Type references must retain list/nullability at every level; do not use a single collapsed `isNonNull` flag for validation. Values are GraphQL variables, including filter strings, view params and collection args. Emit no interpolated input values.

Retain existing field selection, nested joins, `.autoSelect()`, scalar defaults, `.exec()` results with `__extensions`, and `.execWithMeta()`'s `{ data, extensions }`. Auto-selection must avoid invalid object selections, cycles and requiring arguments for virtual fields. Descriptor virtual/queryable flags inform metadata and selection safety but never permission claims. A virtual field with required arguments is selected explicitly; it is not silently called without them.

Use a structured selection representation sufficient for existing field syntax, fragments and per-field arguments. How to implement that representation without importing server libraries is left to the builder. Keep custom-operation explicit selection strings intact; reject invalid builder selection syntax clearly instead of silently dropping pieces.

## Versions and mutation input handling

Use the concrete operation's arguments and reachable input graph to decide accepted writes; output `readOnly` alone is insufficient. A protected type's `version` is read-only output but required update/action input. Preserve it when that concrete input accepts it; exclude it from creates. Never manufacture a version, infer it from an ID or fetch one to retry a conflict.

Existing `update(type, id, input, fields?, options?)` accepts `input.version`, including with `transform: true`. Existing state actions accept it in the already supported input object. Extend `delete(type, id, fields?, options?)` with `options.version`; supply it only when the root accepts it, and report an invalid argument rather than silently dropping an explicitly supplied precondition. Return version fields when explicitly selected or selected among scalar defaults. Preserve exact GraphQL error extensions on failures.

For root add/update with `transform: true`, traverse the actual root input. Relations, embedded objects/lists and nested collection deltas follow their specific input graph. Do not remove back-references globally based on an entity's root input: a nested input can intentionally omit a required root back-reference. Preserve managed nested versions and reference IDs without assuming ObjectId format; IDs remain opaque strings, including PostgreSQL IDs and transaction tokens.

Retain the documented legacy transformer conventions that omit null/empty string and skip collections when called without explicit opt-ins, apart from corrections necessary for managed versions and exact accepted-field safety. Add `preserveEmpty: true` to retain explicit null and empty-string clears; do not silently change existing form-cleaning behavior. Caller-supplied collections remain untouched when `transform` is off. Add `includeCollections: true` for automatic nested collection transformation through the concrete root input graph. These are opt-ins because `transformInput` historically omits collection fields.

`transformCollectionDelta(childType, delta, options)` keeps legacy signatures and metadata cleanup, with optional `options.inputType` naming a concrete collection-delta input type when context is needed. Resolve that type from the owning operation's graph for automatic nested transformations. When only the child type is supplied, infer its protected/unprotected identity shape from declared update/delete input types; do not invent a nested back-reference omission. The existing explicit `connectionField` option keeps its cleanup behavior.

For protected children, deleted objects keep `{ id, version }`; missing versions are errors, not conversion to bare IDs. Unprotected legacy deletes still become IDs. Null deleted entries retain the server's accepted behavior. Updated entries keep their accepted version. Strip form-only markers and `__typename` without mutating the caller's input. Recognize numeric coercion from base-scalar hints when available; versions must be safe integer JSON numbers in the declared range and must not be silently converted from strings. Avoid applying Number() to a scalar-list as though it were a scalar.

## HTTP and errors

Preserve `execute(query, variables)` as the raw GraphQL-envelope method and preserve `error.graphQLErrors` on helper failures. Errors include all server extensions, especially version codes/status and transaction operationIndex/operation. Keep documented partial-data behavior of existing list/get helpers; do not make a successful nullable result crash while attaching extensions. Add meaningful failures for malformed JSON/envelopes and non-GraphQL HTTP responses, without putting headers or credentials into messages. An HTTP error with a valid GraphQL error envelope retains those errors.

No automatic retry of mutations, transaction batches, version conflicts or uncertain transport failures. Cancellation/timeouts and transport retry policy can be added later rather than widening this project.

## Verification and acceptance

1. Characterization coverage runs the original public API on representative schema fixtures: filters, groups, joins, sorting/pagination/count, aggregates, CRUD, actions, metadata, selections, transformations, custom mutations and raw execution. Pin valid behavior and label corrections to previously invalid requests explicitly.
2. Descriptor/introspection initialization tests execute actual GraphQL introspection against schemas from core and both adapters; use fresh processes for enabled/disabled global patch modes. Test descriptors with introspection denied entirely, renamed roots, excluded roots/operations, schema/client isolation, initialization failure and unsupported descriptor versions. No database is needed for metadata-only tests.
3. Execute generated documents through graphql() on real created schemas rather than merely snapshotting request strings. Cover exact canonical/view separation, named params, custom query/mutation collisions, scalar/list/interface/union outputs, selection args and protected input graphs. Recording adapters test request plumbing only.
4. Database integration through disposable MongoDB replica-set and PostgreSQL fixtures covers current operators, valuePath/$parent and frame groups, view filtering/counts, successful/stale protected root and nested writes, protected deletion and transaction rollback/error positions. Reuse shared fixture models/helpers where possible; never use application databases or claim database parity from mocks. Keep existing database semantics unchanged.
5. Pack the actual client archive and install it alone into isolated JavaScript and strict TypeScript consumers. Compile NodeNext, Node16, Bundler and Node10 imports and check browser-only type environments without Node ambient types. Verify a browser bundle/import has no server/driver dependency and is safe before init. Archive quality checks require declarations, README/license and correct exports. Temporary archives belong outside the repository.
6. Run root lint, unit tests, security audit, package tests, release metadata check and docs install/build as appropriate. Run the full database suite with disposable URIs for database evidence; report skipped coverage and external blockers explicitly. New root tests live under tests/.
7. Barber keeps its independent lockfile and registry dependency. Verify its current call patterns and form payloads against a temporary packed client in an isolated consumer/trial. Do not commit a file/tarball dependency or silently change its published dependency to a version that does not exist. Removing its ambient declarations and updating the committed dependency waits until the new client is actually published, unless a dedicated packed-consumer fixture can prove integration without changing the application. If application files are edited, follow Barber's own audit/typecheck/tests and both-stack HTTP/browser contracts.

Accept when the package is reviewable in its own branch with passing appropriate checks, preserved legacy valid behavior, current feature coverage and clear compatibility documentation. Publication remains a separately authorized follow-up.

## Documentation and builder discretion

Update root/package READMEs, add a client guide/reference and link it from VitePress navigation. Document descriptor endpoint setup with the optional server descriptor package for both adapters, extended vs standard introspection, input/metadata limitations, new API examples, version conflict handling, transaction errors and package version-policy change. Update AGENTS and matching architecture/testing/release documentation only for the changed package set and client boundary, preserving unrelated edits.

The builder chooses internal file decomposition, test fixture reuse and collision-free variable allocation. Preserve `src/SimfinityClient.js` as the main compatibility entry and keep public declarations complete. Do not perform unrelated server refactors or change database query semantics to accommodate a client bug.
