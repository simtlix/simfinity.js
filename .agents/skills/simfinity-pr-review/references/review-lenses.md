# Simfinity review lenses

Read the sections relevant to the changed behavior. The linked repository rules and current implementation take precedence over these review prompts; historical limitations are not permanent API bans.

## Verify the motivation

Apply the [issue and PR requirements](../../../../docs/resources/contributing.md#explain-the-change-in-an-issue). Read the actual linked repository issue, not just the PR's implementation summary or closing keyword. Confirm it covers the current diff and explains a concrete problem. A bare title such as “add native filters” does not establish why they are needed; an unrelated issue does not satisfy the rule.

For features and public behavior changes, identify the actor, desired outcome, minimal example, current API usage, alternatives considered and the remaining gap. Compare the claim with today's relationships, scopes, aggregates, controllers and registered operations. Look for repository-style wrappers that bypass the stack and then request APIs to replace its existing capabilities. Demonstrate that mismatch and suggest the supported usage; do not assume unfamiliarity from the author's vocabulary or reject a real missing capability.

Check why the change belongs in the library, which lifecycle guarantees apply, how MongoDB/PostgreSQL are affected, and what outcome would satisfy the issue. Treat untried alternatives as open questions, not fabricated experiments. Bug fixes need expected/actual behavior and reproduction evidence; documentation, dependency and maintenance changes need a proportionate explanation of their gap and result. Automated PRs still need a relevant issue supplied by a maintainer.

Report a missing issue or insufficient rationale as a readiness blocker separate from code defects. Continue useful technical review, but do not recommend approval or merge until it is resolved. If the issue cannot be accessed, report that readiness remains unverified until its contents can be checked; do not assume it is absent or recommend unconditional approval. A review-only request does not authorize creating or editing issues; when opening a PR is authorized, create or reuse its required issue using the established task context. A linked issue is not automatic design approval.

## Choose the owning layer

| Need or proposal | First place to look | Evidence needed for a library change |
| --- | --- | --- |
| Record visibility, tenant isolation, candidate selection | Query scopes intersecting caller filters; relation-path restrictions | Restrictions apply before pagination/counts, including joined and nested reads. Query scopes do not authorize writes. |
| Totals, summaries and reduced result shapes | Generated aggregates and GraphQL selections; typed DTOs for application reports | A GraphQL selection describes the response, not automatic SQL/Mongo projection pushdown or access control. Prove a gap before adding native projection options. |
| Business condition on update/delete, derived values, state transitions | Controllers, validators, state machines; a registered operation for a distinct command | A reusable declarative contract, with the same lifecycle and error semantics on both engines, rather than arbitrary filters or operators on generic CRUD. |
| Parent and children written together | Relations and generated nested `added`/`updated`/`deleted` | Preserve child middleware, ownership checks, validators, hooks and the parent's transaction. Separate root fields are not one transaction. |
| Job, webhook or worker invoking existing operations | Parsed/validated GraphQL execution with explicit actor context and installed auth | A shortcut must justify every omitted step and cannot claim equivalence while bypassing coercion, permissions, scopes or callbacks. |
| Counter, lease, conditional primitive, bulk job, outbox | Application native model/driver code, using the supplied session inside a hook or custom operation | Native access is legitimate; document its bypassed lifecycle. A blanket ban merely pushes it into adapter overrides. |
| HTTP deadline, rate limit, request tracing | API gateway/server policy or infrastructure instrumentation | Library work limits can protect library operations; a particular application's deadline should not become hidden policy scattered through resolvers/adapters. |
| Query timing, command count or cost investigation | Existing execution instrumentation, driver monitoring, engine diagnostics | Observation must preserve executed queries, selected rows, hooks, sessions, authorization and errors. Distinguish latency, query count and query-plan cost. |
| General missing capability | A focused proposal with shared semantics | Typed custom queries, declarative optimistic concurrency or transaction composition can fit; demonstrate the need and full lifecycle instead of exposing MongoDB options in core. |

A repository-shaped wrapper around flat records can hide the domain, discard relationships and rebuild CRUD by hand. Trace its actual use before accepting new `filter`, `pipeline`, `$inc`, upsert, native cursor, projection or observer parameters in the shared API. Ask whether modelling relations, using scopes, or moving the operation into a controller/application endpoint solves the need. An application endpoint still owns its authorization and validation.

Backend-specific APIs inside backend-specific infrastructure are not themselves defects. Nor is a PostgreSQL catalog test or codec fix required to have a MongoDB equivalent. Keep shared GraphQL semantics in core, relational planning and sessions in SQL, and physical statements/codecs/DDL in engine plugins. Do not import drivers into core/SQL or MongoDB/MCP into PostgreSQL.

Sources: [architecture](../../../../.cursor/rules/simfinity-architecture.mdc), [server-side operations](../../../../docs/guide/server-side-operations.md), [anti-patterns](../../../../docs/guide/anti-patterns.md).

## Authorization and lifecycle

Follow the operation through GraphQL coercion → resolver authorization → runtime middleware → applicable scopes or write lifecycle → adapter → output resolvers. Not every step applies to every operation: verify the actual call path.

- Calling a captured `field.resolve` or internal helper is not equivalent to executing a validated GraphQL document. Check enum internal values, custom scalars, list coercion, defaults, create versus update inputs, and resolvers captured before auth wrapping.
- In-process execution enforces Simfinity auth only after the plugin has processed that schema. Envelop/Yoga request hooks, cost controls, masking and tracing do not run merely because graphql-js executes it. A “trusted” actor needs explicit grants; a second schema is not a universal scope bypass.
- Query scopes restrict reads; write ownership belongs in middleware/controllers or permission rules. Nested writes do not automatically invoke root mutation permission rules. Check changed IDs after middleware, persisted parent links, and attempts to move/delete another parent's child.
- Field permissions also affect filter, sort and aggregation paths. Projections, observer callbacks, summary/count endpoints and MCP output must not become routes to restricted fields or records.
- Auth refactors must preserve fail-closed behavior for malformed rules, missing references, thenables and mutations of configuration. Exercise decorated/bound/proxied rules where shortcuts identify built-in checks; copied properties are not function identity. Validated arrays and literal/reference operands must not change meaning later through caller mutation.
- `saveObject()` is a create helper with documented omissions, not a complete programmatic CRUD API. Do not imply root middleware, field authorization, GraphQL coercion or mutation limits apply when the helper bypasses them.
- Schema changes must respect shared type identity and the global introspection patch. Do not rebuild a Simfinity schema with `mapSchema` or `applyMiddleware`; verify repeated initialization, import order and multiple runtimes when relevant.

Sources: [auth rule](../../../../.cursor/rules/simfinity-auth-module.mdc), [core flow](../../../../.cursor/rules/simfinity-core-functions.mdc), [scopes](../../../../docs/guide/query-scope.md), [authorization](../../../../docs/guide/authorization.md).

## Transactions, concurrency and hooks

For each changed write path, identify who opens, owns, commits and aborts the transaction, and which calls receive its session.

- Root fields, nested writes, custom callbacks and native model calls have different boundaries. A fresh generated mutation inside a callback opens its own transaction; a generated read cannot be assumed to see the caller's uncommitted writes.
- Verify callback order and records passed to hooks, reads required for ownership or pre-write guards, rollback after partial child writes, supplied-session failures, and transaction retry behavior. Await session operations sequentially; do not parallelize MongoDB session work.
- Retried attempts must not reuse mutated inputs or turn a stale precondition into a fresh one. External email/webhook effects are not rolled back; write an outbox with the session and process it after commit.
- MongoDB transaction/reference-integrity guarantees are opt-in where documented. Native writes are outside Simfinity's integrity guarantee. Preserve target locks, incoming-reference checks and rollback; do not claim default MongoDB references equal PostgreSQL FKs.
- A concurrency contract that requires the latest `version` is **optimistic**, not pessimistic locking. A declarative proposal may return and accept the same version field. Require atomic comparison and increment/delete, stable conflict errors, retry preservation of the submitted version, and defined nested/state-action/native-write behavior on both engines. The current source implements [the next-release contract](../../../../docs/guide/concurrency.md); published 3.11.0 does not include it. Verify the reviewed/installed version and preserve the documented scope visibility, native middleware and supplied-session limits. Read [the originating proposal](https://github.com/simtlix/simfinity.js/issues/98) only when relevant.
- Output-field resolution happens after a mutation commits. A result permission/read failure can coexist with a committed write; examples and retry helpers must not imply every GraphQL error means rollback. Minimal selections reduce, but do not eliminate, that risk.

Sources: [controllers](../../../../docs/guide/controllers.md), [mutation boundaries](../../../../docs/guide/mutations.md#transaction-boundaries), [Mongo integrity](../../../../docs/guide/mongodb-integrity.md).

## Engine compatibility and read optimizations

For changed shared behavior, compare meaningful scenarios across engines, not just method names or happy-path output:

| Dimension | Compare |
| --- | --- |
| API | Schema/input/output shape, enum/scalar coercion, ID opacity, documented error codes and defaults |
| Visibility | Tenant scopes, joined scopes, nested collections/references, counts and pagination after restrictions |
| Writes | Hooks and ownership, child failures, missing/malformed IDs, constraints, sessions and retries |
| Data | Null versus missing, scalar/embedded lists, reference storage names, generated versus native records |
| Reads | Sort/ties, pagination, selected fields, model hooks, overrides, context and session behavior |

Use the existing documented backend differences; parity does not mean inventing MongoDB foreign keys or making native APIs identical. Shared options that silently do nothing or throw only on PostgreSQL need explicit, justified capability boundaries, not a claim of universal compatibility.

On MongoDB, compare the exact old and new Mongoose methods. A move to `Model.collection.*` can bypass discriminator filtering, default projection, casting/setters or middleware previously applied by the model method. Which guarantees disappear depends on that method; demonstrate the actual difference. Inspect aggregate pipelines for retained scope filters, sort and limits.

Batched reads must reproduce corresponding single reads, including an adapter override and relevant Mongoose hooks/session behavior. Preserve the declared opt-in defaults and fallback rules in AGENTS.md. Fewer commands is not proof of lower latency or unchanged semantics. Benchmark representative rows, pool size and network conditions without rewriting business visibility.

For PostgreSQL-specific inspection, prefer catalog OID relationships over converting names back into `regclass` inside a filtered query: expression evaluation need not follow the apparent filter order. Check namespace restrictions and result multiplicity, not only that the query stops throwing.

## Public surfaces, MCP and documentation

- A runtime member must reach the appropriate core/SQL/runtime facades and public declarations, including legacy MongoDB imports. Check shared helper/error identities and exact export/type fixtures in `scripts/test-packages.js`; test the archives when package boundaries or public types change. Do not add driver dependencies to make a type compile.
- MCP must retain the same schema authorization and business restrictions as GraphQL. Inspect tool exposure, read/write annotations, input coercion, bounded nested operations/results, partial errors and response shaping. A `readOnlyHint` is a hint, not enforcement that callbacks cannot write; a generated tool is another client entry point.
- Run examples through their actual lifecycle. If a hook normalizes price/quantity or computes a total, later invoices or summaries must use that authoritative result. Recomputing from the original input can contradict the records just saved. A docs build only proves the page renders.
- Distinguish GraphQL-shaped results from native records and their backend-specific error/ID formats. Validate example operations against both schemas where they claim portability, and describe required initialization and controller registration.
- For dependency/example changes, compare manifests and lockfiles with released versions, exact internal pins and package integrity. Independent Barber apps need their own checks. Do not pin a new version merely to change instructions.
- For requested publication, use the existing [workflow rule](../../../../.cursor/rules/simfinity-development-workflow.mdc) and [contribution contract](../../../../docs/resources/contributing.md#development-and-publication-contract). Verify deployed content and source, not just a green build. Tests, skills and docs alone do not require an npm release.

## Calibrate the verdict

| Proposed change | Appropriate review direction |
| --- | --- |
| An observer switches scoped model reads to raw collection reads; only MongoDB implements the options | Demonstrate the bypass and engine mismatch; keep telemetry on the existing execution path and application-specific reads in the application. |
| A native counter/outbox write uses the hook's session and application checks | Accept the boundary if retries, rollback and invariants hold; do not demand a driver ban. |
| A typed registered query or entity version option preserves the common lifecycle | Evaluate the implementation and missing guarantees; do not reject it solely for adding an API. |
| A PG-only catalog fixture fix preserves assertions | Review the query and supported PG versions; no shared runtime API or Mongo implementation is required. |
| A docs checkout bills raw input after hooks change stored prices | Reproduce the mismatch; invoice the completed order's total or read authoritative data with the same session. |
| Green tests cover only mocks, while the new path bypasses the model | Report the missing behavioral evidence and any demonstrated regression separately; do not promote a hypothetical risk to a proven exploit. |

Historical review examples: [PR #96](https://github.com/simtlix/simfinity.js/pull/96), [PR #99](https://github.com/simtlix/simfinity.js/pull/99), [PR #102](https://github.com/simtlix/simfinity.js/pull/102). Consult them only if needed after independent analysis. They illustrate decisions, not a standing rejection of future designs. No external application's private details are needed to explain these principles.
