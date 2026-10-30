# Choose a supported path

| Requirement | Starting point | Verify |
| --- | --- | --- |
| Entity CRUD | Types, relations, validators, generated operations | Shape, lifecycle, permissions and tenant boundaries |
| Parent and dependent children change together | One generated mutation with nested `added`/`updated`/`deleted` | Child checks and parent totals, rollback |
| Stored invariant or derived value | Validator or controller with the supplied session | Partial updates, all exposed write paths, concurrency |
| Fixed entity lifecycle | Enum `state` and registered state machine | Source state and action authorization separately |
| Configurable/versioned workflows | Application workflow types, policies and explicit transition command | Workflow revision, current state and atomic write |
| Worker reuses an operation | Validated in-process GraphQL with actor context | Auth plugin installed, no implicit enclosing transaction |
| Several independent generated writes atomically | Since 3.16.0, opt-in transaction mutation; for a server command, registered mutation plus lifecycle helpers and its session | Root authorization versus helper omissions, shared rollback, explicit versions |
| Counter, lock, lease, receipt or outbox | Native model/driver in application infrastructure | Conditional atomicity, supplied session, affected rows |
| Summary | Scoped aggregate over stored facts, or application calculation/read model | Cardinality, rounding, visibility and ordering before pagination |
| Computed output belonging to an existing record | Since 3.8.0: a virtual field (`extensions.virtual`) on the type, read through its generated queries | The type's scope runs first; the resolver's native reads skip other types' scopes; batch per request for lists |
| Repeated stored-record list with typed parameters | Since 3.12.0, `registerView` over the generated list | Base scopes, explicit view-root permission, no new query operators |
| Non-record computation or external/federated read | Since 3.10.0, `registerCustomQuery` | Explicit authorization and visibility for every source |
| Request quota, deadline or query telemetry | Server/driver infrastructure configured centrally | Cancellation and observation preserve results and semantics |

The schema is the common interface; Mongoose documents, SQL sessions and driver errors remain backend-specific. Native access is supported and bypasses Simfinity's lifecycle. Localize it and explicitly supply the checks its operation needs. A blanket ban on native calls can lead to worse replacements: hand-called resolvers, per-operation adapter overrides, or pipeline rewriting.

## Existing applications

Inventory actual entry points, generated fields, models, hooks, permissions, sessions and dependencies. Demonstrate one operation end to end before proposing a migration. Retain working scopes and specialized infrastructure rather than assuming every wrapper is defective.

Classify each deviation as supported usage, an application fix, a documentation gap, or a library capability proposal. Preserve encrypted/opaque payloads where their contract requires opacity; model the business facts that actually need relations, validation or queries. Per-project workflow definitions need not become one static enum.

If repository guards contradict documented native boundaries, identify the conflict and propose a focused rule correction within the authorized task; do not suppress checks or conceal native code inside an adapter. Migrate one aggregate/module at a time, preserving receipts, locks, permission revocation and data compatibility. Do not drop production data or silently replace MongoDB with PostgreSQL.

## Demonstrate a gap before designing around it

Reconstruct each business operation as an entity graph with real ownership and lifecycle. Try one generated parent mutation with nested `added`/`updated`/`deleted`, including several levels, before assuming that a sequence of repository calls needs a new coordinator. Keep child permissions and authoritative values in reusable policies and controllers. Do not invent an aggregate parent merely to join unrelated writes: use the transaction mutation or an authorized custom command with helpers when that is the actual operation.

For each remaining gap, record the installed package/source, smallest failing operation, guarantees required, existing mechanism tried and observed limitation. Separate missing application implementation, incompatible client assumptions, unsupported adapter capabilities and an actual library gap. Read the [capability checkpoints](capabilities.md); an old issue number or a historic audit is not current API evidence.

## Migrate a vertical slice

Choose one representative aggregate and carry it through schema, real authentication, scopes/controllers, API callers, frontend, workers and seeds. Share auth/scope functions, scalars and domain policies; avoid rebuilding a generic repository, dispatcher or business middleware layer around the generated lifecycle. Keep native counters, leases, receipts and outbox infrastructure where it supplies required atomicity.

If the slice needs recovery from uncertain writes, bind a durable command receipt to actor/tenant, operation and input identity, and persist it with the business change. Recover by that same identity before retrying. Distinguish the revision that the command committed from a later current revision; the UI must reconcile a stale draft, not silently replace its expected version. Preserve draft state through recovery and discard responses from an earlier session/tenant. These mechanisms are application responsibilities, not guarantees of every Simfinity mutation.

Verify the slice through the real API and its browser/worker consumers, including denied nested writes, concurrent edits/revocation when promised, rollback and uncertain outcomes. Distinguish a schema smoke test, a working pilot, the full migration and a deployed application. Test a performance failure with the accumulated data that triggered it; isolated green tests alone do not demonstrate that it is fixed.

Sources: [choosing Simfinity](https://simtlix.github.io/simfinity.js/guide/choosing-simfinity.html), [server operations](https://simtlix.github.io/simfinity.js/guide/server-side-operations.html), [anti-patterns](https://simtlix.github.io/simfinity.js/guide/anti-patterns.html), [compatibility](https://simtlix.github.io/simfinity.js/resources/compatibility.html).
