# Four different meanings of projection

| Requirement | Mechanism | Limit |
| --- | --- | --- |
| Return selected fields | GraphQL selection/typed DTO | Does not promise column/pipeline projection pushdown or grant access |
| Group stored facts | Generated `_aggregate` with SUM/COUNT/AVG/MIN/MAX | Supported paths and cardinality; not arbitrary pricing arithmetic |
| Calculate domain facts | One pure application policy reused by readers/writers | Must define currency, precision, rounding and effective date |
| Avoid repeated expensive calculation | Materialized facts/read model | Needs ownership, consistency, revision and revocation rules |

## Choose the read boundary

| Read | Boundary |
| --- | --- |
| Stored-record list with client filters | Generated query and the type's scope |
| Frequent stored-record predicate with typed params | Since 3.12.0, `registerView(name, { type, description, params, where })` |
| Computed output on a stored record | Since 3.8.0, `extensions.virtual` and its resolver |
| Non-record preview, external data or federated result | Since 3.10.0, `registerCustomQuery(name, description, inputModel, outputModel, callback)` |

A view's `where({ params, context })` returns AND groups. Keep it free of database reads/context mutation; it narrows the base list, retains its `find` scope, and supplies neither ordering/pagination defaults nor an aggregate endpoint. Authorize the view's own root. Its predicate gets client-style target visibility, but author-supplied paths are not checked by client field-read/queryability rules. Preserve filter provenance in the base scope. A view cannot add unsupported operators. Legacy `@simtlix/simfinity-js-client` 1.1.0 may select the last registered list root: verify the client, or call an explicit document instead of assuming `find(type)` still names the canonical root.

With client 3.19.0 and a descriptor, `find(type)` uses the canonical list, `findView(name, params)` binds a view root, and `query(name, args, fields)` selects an exact query. Introspection alone cannot prove which roots are views. Builders accept `.where(field, filterObject)` for `valuePath` and `.filter(group)` for explicit element groups; each `.filter()` appends one AND member, so separate calls keep separate witnesses. Use `.collectionArgs(path, args)` for filters/paging on a selected child collection: the legacy third argument to `.joinCollection()` filters the parent. The client forwards server semantics, not new capabilities. See the [client guide](https://simtlix.github.io/simfinity.js/guide/client.html#queries-and-views).

Virtual resolvers run after the record's scope, but their own native reads do not acquire other types' scopes or a transaction session. Batch per request when lists need them. Virtual output cannot be filtered, sorted or aggregated as stored data.

A custom query's callback receives input/context, not a session. Root and output permissions apply, but its source reads require explicit visibility checks; it does not automatically run entity scopes/controllers. Do not expose ordinary stored CRUD through a parallel custom query or disguise a read as a retried mutation. See [named views](https://simtlix.github.io/simfinity.js/guide/queries.html#named-views) and [custom queries](https://simtlix.github.io/simfinity.js/guide/queries.html#custom-queries).

## Limits that need an explicit alternative

At the 3.19.0 baseline there is no generated aggregate filter such as “customers with more than three visible bookings”. ANY is existence, not COUNT; `_aggregate` returns summaries, not a general HAVING predicate for a list. A virtual count or named view does not change that boundary.

For this requirement, calculate the authorized population and threshold before global ordering/count/pagination in a deliberate application report, or maintain a read model with the required freshness and visibility semantics. A global stored count is insufficient when child visibility varies by caller. Test hidden bookings, revocation and page boundaries. General arithmetic/date expressions, general NOT groups, relevance search and geographic distance also require a supported application implementation or a concrete capability proposal; do not invent filter syntax.

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

Aggregate pagination occurs after grouping/sorting and does not supply a group count. Without pagination aggregate output is unbounded; choose a deliberate bound. Generated list count lives in context and is not automatically an atomic snapshot with the page under concurrent writes. Where a count/page snapshot is required, design an application query/transaction that supplies it.

## Calculations and materialized facts

Rounding each line then summing can differ from rounding the final sum. Reuse one canonical calculation for totals and ordering; define allowed bounds, currencies and precision. GraphQL Int is signed 32-bit, while JavaScript safe-integer limits are different. A sum of values from one fetched page is not a complete total.

Prefer authoritative values after controllers have normalized input. If a parent hook maintains totals from children, both create and update paths must refresh them, and standalone child writes must preserve that invariant. Transactional reads use the session, not generated root queries.

A materialized record needs source identity/revision, tenant/scope ownership, calculation version, freshness/expiry, and a transactional or outbox update strategy. Plan backfill, deletion and permission revocation. Scope IDs cached in a search index cannot prove current access after membership changes. Keep live checks or implement an explicit authorization-aware read model; do not simply remove candidate checks because scopes exist elsewhere.

Keep observation outside business calculations. Server admission/quotas and driver deadlines can be centralized, but a gateway timeout alone does not cancel database work. Driver monitoring and query plans answer different questions from fetched-row counts. Instrumentation must not change Mongoose hooks, selected fields, records, errors or session behavior.

Sources: [queries](https://simtlix.github.io/simfinity.js/guide/queries.html), [aggregation](https://simtlix.github.io/simfinity.js/reference/aggregation.html), [scopes](https://simtlix.github.io/simfinity.js/guide/query-scope.html), [server-side operations](https://simtlix.github.io/simfinity.js/guide/server-side-operations.html).
