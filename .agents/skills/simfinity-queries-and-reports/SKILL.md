---
name: simfinity-queries-and-reports
description: Use when implementing Simfinity application lists, searches, counts, aggregates, dashboards, calculated projections or materialized reports.
---

# Query and report with explicit semantics

Check the installed version, selected engine, actual type relationships and access policy. This guidance targets 3.7.0. Define the metric, visible population, ordering, pagination and freshness requirements before choosing an implementation.

Use the [report guide](references/reports.md) to distinguish response selection, stored-field aggregation, pure domain calculation and materialized read models. Apply visibility before counts, grouping and paging. Fields selected in GraphQL are not automatic database projection pushdown or authorization.

Reuse generated filters/scopes/aggregates where they express the requirement. For unsupported calculations or traversal, use an explicitly authorized application report or read model, or, after 3.7.0, a virtual field (`extensions.virtual`) on the type the read describes; keep native engine details in infrastructure. Do not rewrite Simfinity's compiled pipeline to insert hidden query semantics. For search boxes, from 3.9.0 use the literal text operators (`ILIKE`, `STARTS_WITH`, `ISTARTS_WITH`, `ENDS_WITH`, `IENDS_WITH`, `IEQ`) instead of native regex reads or custom queries; both backends fold case alike, except on `İ` and letters newer than one side's Unicode tables; on PostgreSQL they need a `UTF8` database with ICU, and the expression index that the search needs must be built with `caseFoldExpression('"column"')` from `@simtlix/simfinity-postgres` (see `docs/guide/queries.md`). For records whose own field is missing or empty, after 3.9.0 use `IS_EMPTY`/`IS_NOT_EMPTY` with no value, on scalars, lists and whole embedded objects or lists (a term or group condition without `path`), instead of `EQ null`, which treats `""` as a value and on a list also matches `[null]` and never `[]`; emptiness of a reference or a collection, or through a reference, fails with `UNSUPPORTED_QUERY` until a later release, so keep `EQ null` there and in `find` scopes of types that clients reach through references; a path that continues inside an embedded list or a collection fails with the permanent `INVALID_FILTER_PATH`.

Verify cross-tenant exclusions, adversarial client filters, aggregate cardinality, rounding, ties/page boundaries and revocation/staleness where relevant. Compare returned totals to authoritative stored/domain values. Deliver the metric definition, query/canonical calculation and evidence; distinguish latency, command count and query-plan cost when making performance claims.
