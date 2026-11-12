# Capability checkpoints for application maintenance

Use this map to find the relevant contract, not to infer what a consumer installed. The reviewed repository baseline is 3.19.0. Record the engine, package source and direct/transitive resolutions. Use the application’s package tree (for example, `npm ls`) and check imports from the consuming module (for example, `import.meta.resolve` in ES modules). Inspect private forks and tarballs and identify callers of each private export or behavior before swapping dependencies. Within each runtime, align and deduplicate the package instances used for schema creation, authorization and the optional descriptor. Check each entry point that creates or consumes the schema. Preserve the application's selected version until an upgrade is in scope.

| Since | Capability | Application consequence |
| --- | --- | --- |
| 3.8.0 | Virtual fields | Computed output without storage; not filter/sort paths |
| 3.9.0 | Literal text operators | Prefer generated search with the documented Unicode and index contract |
| 3.10.0 | Own-value emptiness; `registerCustomQuery` | Distinguish empty from null; custom reads are not mutations |
| 3.11.0 | Reference/collection emptiness | Visible missing targets differ from stored targets |
| 3.12.0 | `registerView` | Reuse scoped lists with typed parameters and a fixed predicate |
| 3.13.0 | Optimistic concurrency | Carry observed versions through roots, nested edits and clients |
| 3.14.0 | Correlated collection `ANY`/`ALL`/`NONE` | Test same-child semantics, visible empty sets and aggregate cardinality |
| 3.15.0 | Committed callbacks; client descriptor; early introspection opt-out | Best-effort effects versus durable outbox; schema-owned metadata |
| 3.16.0 | Lifecycle update/delete/transition helpers; opt-in transaction mutation; `IIN`/`CONTAINS_ALL` | Use supported write boundaries and literal list operators |
| 3.17.0 | `valuePath` | Compare compatible stored fields with permission checks on both |
| 3.18.0 | Embedded element frames and structural `$parent` | Correlate embedded objects without inventing entity ancestry |
| 3.19.0 | Aligned browser client with descriptor, view and managed-input support | Preserve valid 1.1 calls; use shipped types and concrete inputs, keep versions explicit |

Query input shape alone does not prove adapter support. Inspect `queryFeatures`: declared operators, `referenceEmptiness`, `quantifiers`, `valuePath` and `elementFrames` have separate contracts/dependencies. Custom adapter/compiler overrides may remove support. Match documentation to the installed release and demonstrate the intended operation on its engine.

At this baseline, general aggregate predicates such as “customers with more than three visible bookings”, arbitrary arithmetic/date expressions and general `NOT` groups are not generated filter APIs. `ANY` is existence, not a count threshold; a named view does not extend the filter language. Use an explicitly authorized report/read model when appropriate, or document a concrete library proposal without treating it as an implemented dependency.

For current-release comparison, use the [compatibility notes](https://simtlix.github.io/simfinity.js/resources/compatibility.html), [server operations](https://simtlix.github.io/simfinity.js/guide/server-side-operations.html), [queries](https://simtlix.github.io/simfinity.js/guide/queries.html), [client descriptor](https://simtlix.github.io/simfinity.js/reference/client-descriptor.html), and [browser client](https://simtlix.github.io/simfinity.js/guide/client.html). In a checkout these are `docs/resources/compatibility.md`, `docs/guide/server-side-operations.md`, `docs/guide/queries.md`, `docs/reference/client-descriptor.md` and `docs/guide/client.md`.
