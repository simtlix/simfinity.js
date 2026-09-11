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

| Operation | Calculation |
| --- | --- |
| `COUNT` | Adds one per pipeline row in the group. The required `path` does not make this a count of non-null values. |
| `SUM` | Sums the numeric values at `path`. |
| `AVG` | Averages the numeric values at `path`. |
| `MIN` | Returns the smallest value at `path`. |
| `MAX` | Returns the largest value at `path`. |

Choose unique, simple `factName` values because they become fields in the generated MongoDB group stage and keys of the returned `facts` object.

## Related paths

`groupId` and fact `path` values accept direct fields and dot-separated relationship paths, such as `country.name` or `country.region.name`. Relations must be defined in your schema.

Simfinity adds MongoDB lookups for non-embedded references and resolves embedded paths inline. Grouping occurs over the resulting pipeline rows. When joins expand a source record into multiple rows, counts and sums reflect those rows; check the cardinality of the relationship for your metric.

## Filtering, sorting, and pagination

Flat field filters and [logical AND/OR filters](/guide/queries) apply before grouping. A configured `scope.aggregate` restriction is applied as well; see [query scope](/guide/query-scope).

Sort terms can use `groupId` or a declared `factName`. Multiple terms are applied in order. An unrecognized sort field falls back to `groupId`. Without a sort argument, groups are sorted by `groupId` ascending.

Pagination applies after grouping and sorting. `pagination.count` does not compute the number of groups and does not add a total count to the response.

When using default-deny [authorization](/guide/authorization), grant access to both the root aggregation field and the returned `QLTypeAggregationResult` fields.
