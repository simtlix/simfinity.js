# Choose a supported path

| Requirement | Starting point | Verify |
| --- | --- | --- |
| Entity CRUD | Types, relations, validators, generated operations | Shape, lifecycle, permissions and tenant boundaries |
| Parent and dependent children change together | One generated mutation with nested `added`/`updated`/`deleted` | Child checks and parent totals, rollback |
| Stored invariant or derived value | Validator or controller with the supplied session | Partial updates, all exposed write paths, concurrency |
| Fixed entity lifecycle | Enum `state` and registered state machine | Source state and action authorization separately |
| Configurable/versioned workflows | Application workflow types, policies and explicit transition command | Workflow revision, current state and atomic write |
| Worker reuses an operation | Validated in-process GraphQL with actor context | Auth plugin installed, no implicit enclosing transaction |
| Several creations in one transaction | Registered mutation and `saveObject(..., session, context)` | Its omitted coercion/auth/middleware/limits are addressed |
| Counter, lock, lease, receipt or outbox | Native model/driver in application infrastructure | Conditional atomicity, supplied session, affected rows |
| Summary | Scoped aggregate over stored facts, or application calculation/read model | Cardinality, rounding, visibility and ordering before pagination |
| Read that filters cannot express, on the record it describes | After 3.7.0: a virtual field (`extensions.virtual`) on the type, read through its generated queries | The type's scope runs first; the resolver's native reads skip other types' scopes; batch per request for lists |
| Request quota, deadline or query telemetry | Server/driver infrastructure configured centrally | Cancellation and observation preserve results and semantics |

The schema is the common interface; Mongoose documents, SQL sessions and driver errors remain backend-specific. Native access is supported and bypasses Simfinity's lifecycle. Localize it and explicitly supply the checks its operation needs. A blanket ban on native calls can lead to worse replacements: hand-called resolvers, per-operation adapter overrides, or pipeline rewriting.

## Existing applications

Inventory actual entry points, generated fields, models, hooks, permissions, sessions and dependencies. Demonstrate one operation end to end before proposing a migration. Retain working scopes and specialized infrastructure rather than assuming every wrapper is defective.

Classify each deviation as supported usage, an application fix, a documentation gap, or a library capability proposal. Preserve encrypted/opaque payloads where their contract requires opacity; model the business facts that actually need relations, validation or queries. Per-project workflow definitions need not become one static enum.

If repository guards contradict documented native boundaries, identify the conflict and propose a focused rule correction within the authorized task; do not suppress checks or conceal native code inside an adapter. Migrate one aggregate/module at a time, preserving receipts, locks, permission revocation and data compatibility. Do not drop production data or silently replace MongoDB with PostgreSQL.

At 3.7.0, `runtime.execute`, `storage.filter/increments`, read observers and the introspection opt-out proposed in PR #96 are not public APIs. At that version, optimistic concurrency (#98), heterogeneous transactional operations (#100) and separate client metadata (#101) were proposals. That is a historical 3.7.0 boundary. Simfinity implements #98 as opt-in record versioning; see [optimistic concurrency](https://simtlix.github.io/simfinity.js/guide/concurrency.html) and confirm the installed release before using it. Other roadmap items keep their own status. A roadmap is not executable API documentation. The next release also exposes early `@simtlix/simfinity-core/introspection` configuration and schema-owned metadata through the optional `@simtlix/simfinity-descriptor` package; see `docs/reference/client-descriptor.md`. These descriptor APIs are not in published 3.14.0; heterogeneous transactions (#100) remain a proposal.

Sources: [choosing Simfinity](https://simtlix.github.io/simfinity.js/guide/choosing-simfinity.html), [server operations](https://simtlix.github.io/simfinity.js/guide/server-side-operations.html), [anti-patterns](https://simtlix.github.io/simfinity.js/guide/anti-patterns.html), [compatibility](https://simtlix.github.io/simfinity.js/resources/compatibility.html).
