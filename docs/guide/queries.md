---
title: Queries
description: Retrieve records with scalar filters, related-field conditions, AND/OR groups, pagination, sorting, and aggregation.
---

# Queries

Each connected type gets a single-record query, a list query, and an aggregation query. The examples below use the `Serie` fields from [getting started](./getting-started) and the `Season` relationship from [relationships](./relationships).

## Get one record

```graphql
query GetSerie($id: ID!) {
  serie(id: $id) {
    id
    name
    year
  }
}
```

Supply a MongoDB document ID. The generated argument is `id: ID`; declaring your operation variable as `ID!` makes it required for that operation. An ID with no matching record returns `null`.

## Filter a list

Scalar fields accept `{ operator, value }`. Filters supplied on different fields are combined with AND:

```graphql
query {
  series(
    category: { operator: EQ, value: "Science fiction" }
    year: { operator: GTE, value: 2010 }
    name: { operator: LIKE, value: "Expanse" }
  ) {
    id
    name
    year
  }
}
```

The result is an array directly under `data.series`, rather than an `edges` / `nodes` connection. With no pagination supplied, list queries return at most 100 records.

### Operators

| Operator | Meaning | Example value |
| --- | --- | --- |
| `EQ` | Equal; also the default when omitted | `"Drama"` |
| `NE` | Not equal | `"Drama"` |
| `LT`, `LTE` | Less than, less than or equal | `2020` |
| `GT`, `GTE` | Greater than, greater than or equal | `2010` |
| `IN`, `NIN` | In, or not in, a supplied list | `["Drama", "Comedy"]` |
| `BTW` | Inclusive lower and upper bounds | `[2010, 2020]` |
| `LIKE` | Case-sensitive literal substring match | `"Expanse"` |

`LIKE` escapes regular expression characters; `.` or `*` in the value are literal characters. Use the value's actual JSON type: a number for a numeric comparison, a Boolean for a Boolean field, and an array for `IN`, `NIN`, or `BTW`.

## Combine conditions with AND and OR

Use `OR` when any of several alternatives should match:

```graphql
query {
  series(
    year: { operator: GTE, value: 2010 }
    OR: [
      { conditions: [{ field: "category", operator: EQ, value: "Drama" }] }
      { conditions: [{ field: "category", operator: EQ, value: "Comedy" }] }
    ]
  ) {
    id
    name
    category
  }
}
```

This means `year >= 2010 AND (category = "Drama" OR category = "Comedy")`. Top-level field filters remain ANDed with the logical groups.

A group contains `conditions`, nested `AND` groups, and/or nested `OR` groups. Conditions within one group are ANDed:

```graphql
query {
  series(
    OR: [
      {
        conditions: [
          { field: "category", operator: EQ, value: "Drama" }
          { field: "year", operator: GTE, value: 2020 }
        ]
      }
      {
        conditions: [
          { field: "name", operator: LIKE, value: "Expanse" }
        ]
      }
    ]
  ) {
    id
    name
  }
}
```

Simfinity limits recursive filter-group depth and rejects unknown fields or invalid paths. Keep groups shallow enough to remain understandable to the people maintaining the query.

## Filter through a relationship

A relationship filter uses `terms` and a path relative to the related type. For the `Season.serie` relationship:

```graphql
query {
  seasons(
    serie: {
      terms: [{ path: "name", operator: LIKE, value: "Northern" }]
    }
  ) {
    id
    number
    serie { name }
  }
}
```

To filter series by a child season, use the `Serie.seasons` relation on the root query:

```graphql
query {
  series(
    seasons: {
      terms: [{ path: "year", operator: EQ, value: 2025 }]
    }
  ) {
    id
    name
  }
}
```

Logical groups can describe the same path with `{ field: "serie", path: "name", ... }` or the dotted field form `{ field: "serie.name", ... }`. Do not combine the dotted form and a separate `path` in one condition.

::: info Referenced collection joins
Root filters that traverse a one-to-many relation use MongoDB lookups and unwinds. A parent can appear more than once when multiple child records match; the generated list pipeline does not add a distinct-parent grouping stage. Account for this when designing result lists and counts.
:::

## Pagination and total count

Pagination is page-based, starting at `1`. Supply a positive page number and size:

```graphql
query {
  series(
    pagination: { page: 2, size: 20, count: true }
    sort: { terms: [{ field: "name", order: ASC }] }
  ) {
    id
    name
  }
}
```

`page: 2, size: 20` skips the first 20 matching records and returns the next 20. Both `page` and `size` are required when the pagination object is present. Use a deterministic sort for paginated screens; if a field is not unique, consider a unique stored field as a final sort term.

When `count: true`, the list resolver calculates the matching count before pagination and places it on the GraphQL context. Add the count plugin to expose it in the response:

```javascript
const yoga = createYoga({
  schema,
  plugins: [simfinity.plugins.envelopCountPlugin()],
});
```

For a nonzero count, the response includes:

```json
{
  "data": {
    "series": [{ "id": "507f1f77bcf86cd799439011", "name": "Northern Lights" }]
  },
  "extensions": { "count": 41 }
}
```

::: warning Current count behavior
The built-in count plugins omit `extensions.count` when the count is zero. They also expose one shared count value per operation, not a count keyed by root field. Request one counted root list per operation. Collection-field resolvers and aggregation queries do not publish a total count through this plugin.
:::

## Sort records

Supply an ordered list of terms. `ASC` sorts ascending and `DESC` descending:

```graphql
query {
  series(
    sort: {
      terms: [
        { field: "year", order: DESC }
        { field: "name", order: ASC }
      ]
    }
  ) {
    id
    name
    year
  }
}
```

Referenced fields can use dotted paths, for example `serie.name` when sorting seasons. Provide at least one sort term when supplying `sort`.

## Aggregate records

The `series_aggregate` endpoint groups matching records and calculates named facts:

```graphql
query {
  series_aggregate(
    year: { operator: GTE, value: 2000 }
    aggregation: {
      groupId: "category"
      facts: [
        { operation: COUNT, factName: "total", path: "id" }
        { operation: MIN, factName: "firstYear", path: "year" }
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

Each result contains a `groupId` and a JSON `facts` object, such as `{ "total": 12, "firstYear": 2004 }`. Select `facts` directly without a sub-selection.

Supported operations are `SUM`, `COUNT`, `AVG`, `MIN`, and `MAX`. Every fact requires `path`, including `COUNT`; use an existing field such as `id` for counting. Filters run before grouping. Aggregate sorting accepts a fact name or `groupId`, and pagination applies to groups. Unlike list queries, aggregates have no default 100-result limit when pagination is omitted. See the [aggregation reference](../reference/aggregation) for input and result details.

To constrain which records a caller may query, continue with [query scope](./query-scope).
