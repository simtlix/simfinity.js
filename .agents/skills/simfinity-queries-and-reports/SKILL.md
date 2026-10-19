---
name: simfinity-queries-and-reports
description: Use when implementing Simfinity application lists, searches, counts, aggregates, dashboards, calculated projections or materialized reports.
---

# Query and report with explicit semantics

Check the installed version, selected engine, actual type relationships and access policy. This guidance targets 3.7.0. Define the metric, visible population, ordering, pagination and freshness requirements before choosing an implementation.

Use the [report guide](references/reports.md) to distinguish response selection, stored-field aggregation, pure domain calculation and materialized read models. Apply visibility before counts, grouping and paging. Fields selected in GraphQL are not automatic database projection pushdown or authorization.

Reuse generated filters/scopes/aggregates where they express the requirement. For unsupported calculations or traversal, use an explicitly authorized application report or read model, or, after 3.7.0, a virtual field (`extensions.virtual`) on the type the read describes; keep native engine details in infrastructure. Do not rewrite Simfinity's compiled pipeline to insert hidden query semantics.

Verify cross-tenant exclusions, adversarial client filters, aggregate cardinality, rounding, ties/page boundaries and revocation/staleness where relevant. Compare returned totals to authoritative stored/domain values. Deliver the metric definition, query/canonical calculation and evidence; distinguish latency, command count and query-plan cost when making performance claims.
