---
name: simfinity-queries-and-reports
description: Use when implementing Simfinity application lists, searches, counts, aggregates, dashboards, calculated projections or materialized reports.
---

# Query and report with explicit semantics

Check the installed version, selected engine, actual type relationships and access policy. This guidance targets 3.7.0. Define the metric, visible population, ordering, pagination and freshness requirements before choosing an implementation.

Use the [report guide](references/reports.md) to distinguish response selection, stored-field aggregation, pure domain calculation and materialized read models. Apply visibility before counts, grouping and paging. Fields selected in GraphQL are not automatic database projection pushdown or authorization.

Reuse generated filters/scopes/aggregates where they express the requirement. For unsupported calculations or traversal, use an explicitly authorized application report or read model, or, after 3.7.0, a virtual field (`extensions.virtual`) on the type the read describes; keep native engine details in infrastructure. Do not rewrite Simfinity's compiled pipeline to insert hidden query semantics. For search boxes, after 3.8.0 use the literal text operators (`ILIKE`, `STARTS_WITH`, `ISTARTS_WITH`, `ENDS_WITH`, `IENDS_WITH`, `IEQ`) instead of native regex reads or custom queries; know their case-folding differences between backends, including PostgreSQL's capital-sigma gap (by default a case-insensitive value that starts or ends with `Σ` can miss rows; where that matters, configure the PostgreSQL runtime with `foldFinalSigma: true`, which needs a server encoding with `σ` and `ς`, such as UTF8, or search a controller-maintained normalized copy), and on PostgreSQL create the expression index that the search needs on the expression of the runtime's setting, `lower("column" COLLATE "und-x-icu")` or, with `foldFinalSigma: true`, `translate(lower("column" COLLATE "und-x-icu"), 'ς', 'σ')`, rebuilding it if the setting changes (see `docs/guide/queries.md`).

Verify cross-tenant exclusions, adversarial client filters, aggregate cardinality, rounding, ties/page boundaries and revocation/staleness where relevant. Compare returned totals to authoritative stored/domain values. Deliver the metric definition, query/canonical calculation and evidence; distinguish latency, command count and query-plan cost when making performance claims.
