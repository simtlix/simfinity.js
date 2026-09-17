---
title: Plugin authoring for AI agents
description: Implementation instructions for agents building Simfinity extensions across GraphQL, persistence, and MCP.
---

# Plugin authoring for AI agents

Use this guide when implementing a reusable extension for `@simtlix/simfinity-js`. It describes existing integration points and their boundaries; it does not introduce a new plugin API. Read the implementation in the target checkout before changing behavior. When code and documentation disagree, reproduce the behavior and report the discrepancy instead of silently assuming either is correct.

## Establish the contract first

Record the requested behavior, affected entities and operations, supported execution paths, trusted identity source, and failure behavior in a short implementation note. Infer routine choices from the application; ask only about missing decisions that materially change behavior.

Simfinity currently exports `createAuthPlugin`, `envelopCountPlugin`, and `apolloCountPlugin` through `simfinity.plugins`. There is no general plugin-object installer, automatic controller composition, dependency ordering, or uninstall lifecycle. `simfinity.use()` accepts middleware functions, not Envelop plugin objects. Do not invent APIs such as `registerPlugin()` or advertise an installer as a built-in API.

Choose the smallest existing integration point:

| Requirement | Integration | Boundary |
| --- | --- | --- |
| GraphQL validation, execution, context, response metadata | Envelop/Yoga hooks; a separate adapter for Apollo | Server-specific lifecycle; not automatically executed by standalone MCP |
| Field authorization or field result transformation | In-place resolver wrappers, usually installed by `onSchemaChange` | Preserve schema identity, resolver behavior, and GraphQL output types |
| Prepare or reject generated operations | `simfinity.use(middleware)` | Runs before database execution; not an execution wrapper |
| Restrict generated reads | Type `extensions.scope` | Does not authorize writes |
| Validate or enrich persistence | Controller passed to `connect()` | Runs within the mutation transaction, before commit |
| Inspect, reject, or wrap an MCP tool call | `toolMiddleware` | Separate contract from global Simfinity middleware |

Use [middleware](./middleware.md), [controllers](./controllers.md), [query scope](./query-scope.md), [authorization](./authorization.md), and the [MCP reference](../reference/mcp.md) for complete signatures. Use the [Series Sample Project](https://github.com/simtlix/series-sample) for application structure.

## Source map for repository agents

Consult these repository-relative files; locate functions by name rather than relying on fixed line numbers:

| File | Contracts to inspect |
| --- | --- |
| `packages/core/src/plugins.js` | Existing server adapters and exports |
| `packages/core/src/auth/index.js` | `createAuthPlugin`, configuration validation, permission resolution |
| `packages/core/src/runtime.js` and the selected adapter under `packages/mongodb/src/` or `packages/postgres/src/` | `use`, `executeMiddleware`, `executeScope`, `connect`, `generateModel`, `saveObject`, transaction and controller implementation |
| `packages/mcp/src/index.js` | `applySchemaPlugins`, `composeToolMiddleware`, `createCallTool`, execution modes and result limits |
| `packages/*/types/` | Existing public declarations that may need updating |
| `tests/` | Existing regression and integration fixtures |
| `.cursor/rules/` | Architecture, coding, auth, extensions, testing, and documentation rules |

For external plugin packages, inspect the installed Simfinity version and its matching source. Verify the installed server's hook signatures against its official documentation. Do not assume Apollo and Envelop callbacks are interchangeable or copy a mocked callback payload as proof of runtime compatibility.

## GraphQL resolver and server plugins

1. Wrap existing resolvers on the supplied schema. Never apply `graphql-middleware`'s `applyMiddleware` or `@graphql-tools/utils`'s `mapSchema` to a Simfinity schema. Type cloning can duplicate its globally injected introspection metadata types.
2. Capture the previous resolver and delegate to it, using GraphQL's `defaultFieldResolver` when no explicit resolver exists. Preserve `parent`, `args`, request context, `info`, and any receiver the original resolver relies on. Await asynchronous checks and results; propagate failures deliberately.
3. Restrict wrapping to the intended types and fields. Skip introspection types. Respect nullability and scalar serialization when transforming a result; masking a non-null field as `null` can null out its parent through GraphQL error propagation.
4. Make repeated application of the same plugin instance to the same schema safe. A closure-local `WeakSet` is the pattern used by the auth plugin. A new plugin instance has a new set: it does not prevent duplicate wrapping across instances.
5. Declare installation order where it matters, especially authorization, cache lookup, result masking, and instrumentation. Test their composition. Do not allow a cached response to bypass the caller's access policy.
6. Keep request identity, timing, and intermediate results in request-local state. Do not store a current user or tenant in a plugin factory closure or shared schema metadata.
7. Validate configuration at creation time. Distinguish absent configuration from explicitly invalid values, especially permission rules. Authorization checks must not grant access on errors or malformed configuration.
8. Execution results may contain both data and errors. Handle streaming/async iterable results if the supported host exposes them; otherwise declare the supported execution mode. Preserve unrelated response extensions.

Authentication is supplied by the application. `createAuthPlugin` evaluates permissions against context; it does not authenticate tokens. Root mutation permissions do not automatically authorize nested child mutations or direct model access.

## Global middleware and scopes

Register global middleware once at application startup. Type and middleware registries are module-level state, not independent per-server containers. Do not register middleware on every request or promise isolated application instances without implementing isolation.

For `simfinity.use()`, `await next()` advances only the middleware chain. The database resolver runs after the chain returns. Code after `next()` is still pre-execution; omitting `next()` skips remaining middleware but does not cancel the resolver. Throw to reject an operation. Do not implement response caching, after-save events, or complete operation timing with this hook.

Mutate the existing `args` or `context` object where the contract permits it. Replacing `params.args` does not reliably replace the resolver's arguments. Generated save/update middleware receives `{ input }`; delete receives `{ id }`. Custom mutation metadata differs from entity operations, so do not assume `type` is always present.

Scopes mutate query arguments; their return value is not a database filter. Preserve normalized ID filters for `get_by_id`. Generated non-embedded relationship reads apply the target type's middleware and scope, with a separate predicate enforcing the persisted relationship. Embedded fields, custom resolvers, and direct Mongoose calls do not inherit that coverage.

For tenant isolation, derive the tenant from trusted context, set server-owned fields during creation, scope reads, and authorize updates, deletes, state actions, and nested writes separately. `extensions.readOnly` removes fields from generated inputs; it is not a universal security boundary for programmatic access. Do not trust a client-supplied tenant or assume a parent permission grants child permission.

## Controllers, models, and transaction boundaries

The controller is the fifth argument to `connect(model, gqltype, singular, plural, controller, onModelCreated, stateMachine)`. Supply it before schema generation. If an application already has a controller, explicitly compose hooks in a documented order rather than overwriting it. Await each hook and preserve its mutations and failures.

| Hook | Arguments | Timing |
| --- | --- | --- |
| `onSaving` | `document, args, session, context` | Before parent insertion |
| `onSaved` | `document, args, session, context` | After parent save and collection inputs |
| `onUpdating` | `id, changes, session, context` | Before parent update |
| `onUpdated` | `document, session, context` | After parent update and collection inputs |
| `onDelete` | `document, session, context` | Before physical deletion |

Create `args` is the inner mutation input. `onSaved` receives a plain parent snapshot; `onUpdated` receives the updated Mongoose document. Update `changes` is materialized input, not a full previous or current record, and may include `$unset`. `onDelete` may receive `null`. Read previous values explicitly, in the supplied session, when an audit feature needs them.

All these hooks execute before transaction commit. Nested collection writes use the same session and invoke the child controller. A failure later in the mutation can roll back earlier hook writes.

- Pass the supplied session to every related database operation. Do not commit, abort, end, or replace a caller-owned session.
- `saveObject()` with an active supplied session joins that transaction. Without one, it owns a separate transaction. It runs the creation pipeline but bypasses GraphQL coercion, field authorization, and global middleware. Direct Mongoose access also bypasses Simfinity controllers and validation.
- Transient transaction errors can retry the transaction body and its hooks. Unknown commit results retry only the commit. If commit uncertainty remains, an error does not prove that nothing was persisted. Design retry-sensitive work and client retries accordingly.
- For email, webhooks, or indexing, persist an outbox event with the entity change and process it after commit. The external processor needs idempotency and retry handling; an outbox alone does not guarantee exactly-once delivery.
- There is no general after-commit controller hook, `onDeleted` hook, or controller return value that substitutes a delete. Soft deletion requires an explicit alternative mutation or a deliberate core change.
- `onModelCreated` runs after `mongoose.model()` and is not awaited. Do not treat it as an asynchronous pre-compilation Mongoose schema-plugin hook. Verify model customization timing before proposing Mongoose middleware installation there.

## MCP integration

State support separately for Yoga/Envelop, Apollo, standalone in-process MCP, remote MCP, and direct programmatic calls. A plugin working in one path is not evidence for the others.

In-process MCP uses bare `graphql()`. `schemaPlugins` invokes only `onSchemaChange`, synchronously, and provides a no-op `replaceSchema`. It neither awaits asynchronous installation nor runs the full Envelop lifecycle. Use synchronous in-place wrapping for that adapter. Reuse the same auth plugin instance when sharing a schema already wrapped by Yoga.

MCP `toolMiddleware` receives `{ name, args, extra, kind, operation }`. `kind` is query/mutation metadata; `operation` is the generated GraphQL document string, not Simfinity's `save`/`find` operation enum. It can replace `call.args`, return a complete tool result without delegation, or wrap real execution with `return await next()`. Calling `next()` twice or returning `undefined` is rejected.

The configured GraphQL context factory executes inside the terminal executor, after tool middleware begins. Do not assume middleware receives `call.context` or a precomputed authenticated user. Establish a trusted identity source through the application's transport/authentication integration. Treat `extra` according to that integration, not as automatically authenticated caller data.

In remote mode, local schema plugins and local GraphQL context are not applied. The remote server enforces its own plugins. Configured `execution.headers` are not an automatic forwarding mechanism for incoming credentials. Do not reuse one user's credentials across tenants or claim dynamic credential propagation without implementing it.

Preserve the MCP result contract, including `content`, `isError`, optional `structuredContent`, and metadata. GraphQL errors can arrive as `isError: true` results rather than thrown exceptions. Inspect both when measuring success or caching. Middleware-created results bypass the terminal result-size cap; enforce appropriate limits on results you create or enlarge, and keep text and structured representations consistent.

Cancellation checks prevent some work from starting; they do not roll back completed writes. Do not implement blanket retries around mutations. Remote transport retries are query-only, and authorization failures must not become successful fallback responses.

## Packaging and public API

Prefer a small factory with explicit options and adapters over import-time registration. Keep application models, credentials, transports, and external clients injectable. Do not rely on private Simfinity registries or GraphQL internals.

For an external npm package, declare compatible peers for the runtimes it actually shares and verify the supported versions; avoid bundling another GraphQL copy. For a built-in feature, update the appropriate exports and public declarations. Keep ES module imports at the top and follow repository style. Use stable domain error codes without exposing credentials or sensitive inputs.

Document installation order, complete application wiring, supported modes, configuration defaults, failure behavior, and known limitations. Distinguish a proposed new core contract from functionality already available. A plugin must not silently change global behavior just because it was imported.

## Verify behavior, not implementation shape

Select checks according to the extension's actual risk. Do not add arbitrary tests for runtime version strings, file existence, or export shape as substitutes for behavior. For documentation-only changes, check links and the documentation build.

| Extension behavior | Required material scenarios |
| --- | --- |
| Resolver wrapping or authorization | Real GraphQL execution; allow/deny/error paths; default and custom resolvers; repeated installation; composition order; schema introspection |
| Tenant or ownership restrictions | Separate users/tenants; list, ID, aggregation, relations; nested writes; spoofed ownership input; explicit direct-access boundaries |
| Persistence or audit | Actual MongoDB replica-set transaction; rollback after a later failure; same-session writes; relevant retry paths; nested operations |
| Caching or request state | Concurrent distinct identities; permission isolation; partial errors; invalidation and rollback behavior |
| MCP | Real generated tool execution in every claimed mode; error results and thrown errors; short-circuit and delegation; context timing; relevant cancellation/limit behavior |
| Server lifecycle hooks | Integration with the actual supported server/runtime, not only manually invoking hooks with fabricated payloads |

Reuse existing fixtures. Run `npm run lint` and `npm test` for implementation changes. Database integration suites require an appropriate MongoDB replica set; existing transaction tests use `SIMFINITY_TEST_MONGODB_URI`. Report skipped checks explicitly. A green run with skipped integration tests does not verify transactional behavior. Build docs with `npm run docs:build` when changing documentation.

## Reusable agent task

Copy this task and fill in the feature-specific details:

```text
Implement [extension name] for @simtlix/simfinity-js.
Behavior: [observable behavior and failure policy].
Entities and operations: [scope, including relevant nested operations].
Execution modes: [GraphQL host, MCP mode, programmatic access if required].
Identity and external dependencies: [trusted sources and injected clients].
Packaging: [application module, external package, or built-in feature].

Read AGENTS.md, docs/guide/plugin-authoring.md, and the matching source/rules.
Trace each affected execution path before selecting hooks. Use existing public
contracts; identify any core change explicitly. Preserve existing controllers,
resolvers, transaction ownership, and request isolation. Do not infer security
coverage across adapters or access paths.

Implement the smallest complete solution with installation examples and public
types where applicable. Verify observable behavior using the actual execution
paths, including the material negative and concurrency/transaction scenarios.
Report what changed, evidence, skipped checks, and remaining limitations.
Keep public artifacts in English and free of private paths or incidental metadata.
```

When a requested behavior cannot be implemented through current hooks, explain the specific missing contract and propose the smallest change. Do not hide unsupported behavior behind a plugin-shaped API.
