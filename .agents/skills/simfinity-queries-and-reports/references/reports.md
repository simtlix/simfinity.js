# Four different meanings of projection

| Requirement | Mechanism | Limit |
| --- | --- | --- |
| Return selected fields | GraphQL selection/typed DTO | Does not promise column/pipeline projection pushdown or grant access |
| Group stored facts | Generated `_aggregate` with SUM/COUNT/AVG/MIN/MAX | Supported paths and cardinality; not arbitrary pricing arithmetic |
| Calculate domain facts | One pure application policy reused by readers/writers | Must define currency, precision, rounding and effective date |
| Avoid repeated expensive calculation | Materialized facts/read model | Needs ownership, consistency, revision and revocation rules |

## Lists and generated aggregates

Use all relevant scopes before query execution. Preserve caller conditions with a server AND. Filtering a fetched page can create short pages and wrong counts; sorting derived amounts after pagination cannot produce global amount ordering. Define a deterministic tie-breaker when stable pages matter.

```graphql
query OrderTotals {
  orders_aggregate(
    aggregation: {
      groupId: "tenantId"
      facts: [{ operation: SUM, factName: "total", path: "total" }]
    }
    pagination: { page: 1, size: 20 }
  ) { groupId facts }
}
```

Assumes an Order type with stored tenantId/total, an aggregate tenant scope and permission grants for the root, referenced paths and `QLTypeAggregationResult`. `facts` is JSON: do not select `facts { total }`. COUNT counts resulting rows, not non-null values of its path. Joins can multiply rows and therefore sums/counts. Test the metric's intended cardinality.

Aggregate pagination occurs after grouping/sorting and does not supply a group count. Without pagination aggregate output is unbounded at 3.7.0. Generated list count lives in context and is not automatically an atomic snapshot with the page under concurrent writes. Where a count/page snapshot is required, design an application query/transaction that supplies it.

## Calculations and materialized facts

Rounding each line then summing can differ from rounding the final sum. Reuse one canonical calculation for totals and ordering; define allowed bounds, currencies and precision. GraphQL Int is signed 32-bit, while JavaScript safe-integer limits are different. A sum of values from one fetched page is not a complete total.

Prefer authoritative values after controllers have normalized input. If a parent hook maintains totals from children, both create and update paths must refresh them, and standalone child writes must preserve that invariant. Transactional reads use the session, not generated root queries.

A materialized record needs source identity/revision, tenant/scope ownership, calculation version, freshness/expiry, and a transactional or outbox update strategy. Plan backfill, deletion and permission revocation. Scope IDs cached in a search index cannot prove current access after membership changes. Keep live checks or implement an explicit authorization-aware read model; do not simply remove candidate checks because scopes exist elsewhere.

Keep observation outside business calculations. Server admission/quotas and driver deadlines can be centralized, but a gateway timeout alone does not cancel database work. Driver monitoring and query plans answer different questions from fetched-row counts. Instrumentation must not change Mongoose hooks, selected fields, records, errors or session behavior.

Sources: [queries](https://simtlix.github.io/simfinity.js/guide/queries.html), [aggregation](https://simtlix.github.io/simfinity.js/reference/aggregation.html), [scopes](https://simtlix.github.io/simfinity.js/guide/query-scope.html), [server-side operations](https://simtlix.github.io/simfinity.js/guide/server-side-operations.html).
