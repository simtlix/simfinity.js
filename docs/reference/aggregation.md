---
title: Aggregation
description: Group matching records and calculate counts, sums, averages, minima, and maxima.
---

# Aggregation

Each connected entity receives an aggregation endpoint named after its list query: `series` produces `series_aggregate`. It accepts the normal query filters plus a required `aggregation` expression.

## Group and calculate

This example assumes a `Serie` type with `category` and numeric `rating` fields.

```graphql
query RatingsByCategory {
  series_aggregate(
    rating: { operator: GTE, value: 7 }
    aggregation: {
      groupId: "category"
      facts: [
        { operation: COUNT, factName: "total", path: "id" }
        { operation: AVG, factName: "averageRating", path: "rating" }
      ]
    }
    sort: { terms: [{ field: "total", order: DESC }] }
    pagination: { page: 1, size: 10 }
  ) {
    groupId
    facts
  }
}
```

An illustrative result is:

```json
{
  "data": {
    "series_aggregate": [
      { "groupId": "Science fiction", "facts": { "total": 12, "averageRating": 8.4 } },
      { "groupId": "Drama", "facts": { "total": 8, "averageRating": 8.1 } }
    ]
  }
}
```

`facts` is a JSON scalar. Select it directly; do not add a GraphQL subselection such as `facts { total }`.

## Input types

```graphql
enum QLAggregationOperation {
  SUM
  COUNT
  AVG
  MIN
  MAX
}

input QLTypeAggregationFact {
  operation: QLAggregationOperation!
  factName: String!
  path: String!
}

input QLTypeAggregationExpression {
  groupId: String!
  facts: [QLTypeAggregationFact!]!
}

type QLTypeAggregationResult {
  groupId: JSON
  facts: JSON
}
```

If your schema already has a scalar named `JSON`, such as `GraphQLJSON` from graphql-scalars or graphql-type-json, `groupId` and `facts` use that scalar, and its `serialize` formats the results. Otherwise Simfinity adds its own `JSON` scalar. The reused scalar must serialize any JSON value: `groupId` may be a string, a number or `null`, not only an object. A JSONObject-style scalar would turn aggregation results into field errors. Any other application type named `JSON` still makes `createSchema()` fail with `Schema must contain uniquely named types`.

| Operation | Calculation |
| --- | --- |
| `COUNT` | Adds one per pipeline row in the group. The required `path` does not make this a count of non-null values. |
| `SUM` | Sums the numeric values at `path`. |
| `AVG` | Averages the numeric values at `path`. |
| `MIN` | Returns the smallest value at `path`. |
| `MAX` | Returns the largest value at `path`. |

Choose unique, simple `factName` values because they become fields in the generated backend aggregation and keys of the returned `facts` object.

## Related paths

`groupId` and fact `path` values accept direct fields and dot-separated relationship paths, such as `country.name` or `country.region.name`. Relations must be defined in your schema.

Simfinity adds backend joins for non-embedded references and resolves embedded paths inline. Grouping occurs over the resulting rows. When joins expand a source record into multiple rows, counts and sums reflect those rows; check the cardinality of the relationship for your metric.

`groupId` and fact paths follow the [path restrictions](/guide/queries#path-restrictions) of filters. A segment that names a non-queryable field fails with `FORBIDDEN_FILTER_PATH` (403). A path through a non-embedded single reference to a type with a `find` scope is restricted by that scope (not the type's `aggregate` scope), so rows whose referenced record the scope excludes, including rows without a reference, are left out of the groups. A path into a collection relation whose type's `find` scope restricts the caller fails with `FORBIDDEN_FILTER_PATH`. See [relationship paths](/guide/query-scope#relationship-paths-in-filters-sorts-and-aggregations).

PostgreSQL preserves nested scalar-list arrays in group keys, including ragged lists, duplicates, explicit nulls, and empty arrays. Array facts use `SUM = 0` and `AVG = null`; `MIN` and `MAX` compare complete arrays with typed/null ordering. Result sorting by an array-valued group or fact selects its immediate minimum/maximum element. Whole embedded objects remain unsupported as group or fact paths.

## Filtering, sorting, and pagination

Flat field filters and [logical AND/OR filters](/guide/queries) apply before grouping. A configured `scope.aggregate` restriction is applied as well; see [query scope](/guide/query-scope). On the aggregate endpoint `aggregation` is the expression argument, so a field named `aggregation` is filtered only through `AND`/`OR` group conditions; list queries filter it like any other field. See [fields named like query arguments](/guide/queries#fields-named-like-query-arguments).

Sort terms can use `groupId` or a declared `factName`. Multiple terms are applied in order. An unrecognized sort field falls back to `groupId`. Without a sort argument, groups are sorted by `groupId` ascending.

Pagination applies after grouping and sorting. `pagination.count` does not compute the number of groups and does not add a total count to the response.

When pagination is supplied, `page` and `size` must be positive safe integers, the computed skip must be safe, and `size` must not exceed the process-wide `configureQueryLimits({ maxPageSize })` setting (1000 by default). Invalid pagination throws `INVALID_PAGINATION` (400). Omitting pagination keeps aggregate results unbounded. All relationship filter terms, including repeated bounds on one path, remain ANDed before grouping; scalar value and path validation follows the [query input rules](/guide/queries#operators).

When using default-deny [authorization](/guide/authorization), grant access to both the root aggregation field and the returned `QLTypeAggregationResult` fields. The authorization plugin also checks the read rule of every field that a filter, `groupId` or fact path names, including the `COUNT` path `id`. In the example above, `Serie.rating`, `Serie.category` and `Serie.id` each need an exact or `'*'` rule under `defaultPolicy: 'DENY'`, and a relationship path needs a rule for every segment. Parent-dependent rules such as `isOwner` deny these paths, because they run without a parent. Aggregate sort terms name result keys and are not checked. See [filter, sort and aggregation paths](/guide/authorization#filter-sort-and-aggregation-paths).
