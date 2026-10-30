---
name: simfinity-queries-and-reports
description: Use when implementing Simfinity application lists, searches, counts, aggregates, dashboards, calculated projections or materialized reports.
---

# Query and report with explicit semantics

Check the installed version, engine, actual relationships and access policy. The maintained reference is 3.18.0; generated input fields alone do not prove adapter support. Define the visible population, metric, ordering, pagination and freshness before choosing a path.

Use only the references relevant to the task:

- [Filters and correlated elements](references/filters.md): text, emptiness, list operators, `ANY`/`ALL`/`NONE`, versions and capability gates.
- [Stored-field comparisons](references/comparisons.md): `valuePath`, embedded `$parent`, permissions, lexical origins and engine collation.
- [Reads and reports](references/reports.md): named views, virtual fields, custom queries, aggregation and materialized calculations.

Prefer generated filters/scopes/aggregates where they express the requirement. Visibility belongs in scopes before counts, grouping and paging. A view narrows a generated list; a virtual field computes output; neither adds arbitrary filter arithmetic or aggregate predicates. For an unsupported requirement, identify the exact gap and choose an explicitly authorized report/read model without rewriting compiled pipelines.

Verify same-element correlation, empty sets, cross-tenant exclusions, adversarial filters, aggregate cardinality, ties/page boundaries and revocation/freshness where relevant. Compare returned totals to authoritative values. Diagnose performance with representative accumulated data and plans; distinguish latency, command count and query-plan cost. Deliver the query or canonical calculation and its evidence.
