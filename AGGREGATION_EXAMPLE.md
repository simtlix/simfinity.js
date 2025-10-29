# GraphQL Aggregation Query Support

This library now supports GraphQL aggregation queries with group by functionality, allowing you to perform aggregate operations (SUM, COUNT, AVG, MIN, MAX) on your data.

## Overview

For each entity type registered with `connect()`, an additional aggregation endpoint is automatically generated with the format `{entityname}_aggregate`.

## Features

- **Group By**: Group results by any field (direct or related entity field path)
- **Aggregation Operations**: SUM, COUNT, AVG, MIN, MAX
- **Filtering**: Use the same filter parameters as regular queries
- **Pagination**: Use the same pagination parameters as regular queries
- **Related Entity Fields**: Group by or aggregate on fields from related entities using dot notation

## GraphQL Types

### QLAggregationOperation (Enum)
- `SUM`: Sum of numeric values
- `COUNT`: Count of records
- `AVG`: Average of numeric values
- `MIN`: Minimum value
- `MAX`: Maximum value

### QLTypeAggregationFact (Input)
```graphql
input QLTypeAggregationFact {
  operation: QLAggregationOperation!
  factName: String!
  path: String!
}
```

### QLTypeAggregationExpression (Input)
```graphql
input QLTypeAggregationExpression {
  groupId: String!
  facts: [QLTypeAggregationFact!]!
}
```

### QLTypeAggregationResult (Output)
```graphql
type QLTypeAggregationResult {
  groupId: JSON
  facts: JSON
}
```

## Usage Examples

### Example 1: Simple Group By with Direct Field

Group series by category and count them:

```graphql
query {
  series_aggregate(
    aggregation: {
      groupId: "category"
      facts: [
        {
          operation: COUNT
          factName: "totalSeries"
          path: "id"
        }
      ]
    }
  ) {
    groupId
    facts
  }
}
```

**Result:**
```json
{
  "data": {
    "series_aggregate": [
      {
        "groupId": "Drama",
        "facts": {
          "totalSeries": 15
        }
      },
      {
        "groupId": "Comedy",
        "facts": {
          "totalSeries": 23
        }
      }
    ]
  }
}
```

### Example 2: Group By Related Entity Field

Group series by country name (where country is a related entity):

```graphql
query {
  series_aggregate(
    aggregation: {
      groupId: "country.name"
      facts: [
        {
          operation: COUNT
          factName: "seriesCount"
          path: "id"
        },
        {
          operation: AVG
          factName: "avgRating"
          path: "rating"
        }
      ]
    }
  ) {
    groupId
    facts
  }
}
```

**Result:**
```json
{
  "data": {
    "series_aggregate": [
      {
        "groupId": "United States",
        "facts": {
          "seriesCount": 45,
          "avgRating": 7.8
        }
      },
      {
        "groupId": "United Kingdom",
        "facts": {
          "seriesCount": 32,
          "avgRating": 8.2
        }
      }
    ]
  }
}
```

### Example 3: Multiple Aggregation Facts

Calculate multiple metrics per group:

```graphql
query {
  series_aggregate(
    aggregation: {
      groupId: "category"
      facts: [
        {
          operation: COUNT
          factName: "total"
          path: "id"
        },
        {
          operation: SUM
          factName: "totalEpisodes"
          path: "episodeCount"
        },
        {
          operation: AVG
          factName: "avgRating"
          path: "rating"
        },
        {
          operation: MIN
          factName: "minRating"
          path: "rating"
        },
        {
          operation: MAX
          factName: "maxRating"
          path: "rating"
        }
      ]
    }
  ) {
    groupId
    facts
  }
}
```

**Result:**
```json
{
  "data": {
    "series_aggregate": [
      {
        "groupId": "Drama",
        "facts": {
          "total": 15,
          "totalEpisodes": 1234,
          "avgRating": 7.5,
          "minRating": 6.2,
          "maxRating": 9.1
        }
      }
    ]
  }
}
```

### Example 4: With Filtering

Filter data before aggregation:

```graphql
query {
  series_aggregate(
    category: {
      operator: IN
      value: ["Drama", "Thriller"]
    }
    rating: {
      operator: GTE
      value: 7.0
    }
    aggregation: {
      groupId: "country.name"
      facts: [
        {
          operation: COUNT
          factName: "highRatedCount"
          path: "id"
        },
        {
          operation: AVG
          factName: "avgRating"
          path: "rating"
        }
      ]
    }
  ) {
    groupId
    facts
  }
}
```

### Example 5: Sorting by GroupId

Sort aggregation results by groupId (ascending or descending):

```graphql
query {
  series_aggregate(
    sort: {
      terms: [
        {
          field: "groupId"   # Sort by the groupId
          order: "DESC"      # ASC or DESC
        }
      ]
    }
    aggregation: {
      groupId: "category"
      facts: [
        {
          operation: COUNT
          factName: "total"
          path: "id"
        }
      ]
    }
  ) {
    groupId
    facts
  }
}
```

### Example 5b: Sorting by a Fact

Sort aggregation results by a calculated fact (metric):

```graphql
query {
  series_aggregate(
    sort: {
      terms: [
        {
          field: "avgRating"  # Sort by the avgRating fact
          order: "DESC"       # Highest rating first
        }
      ]
    }
    aggregation: {
      groupId: "category"
      facts: [
        {
          operation: COUNT
          factName: "total"
          path: "id"
        }
        {
          operation: AVG
          factName: "avgRating"
          path: "rating"
        }
      ]
    }
  ) {
    groupId
    facts
  }
}
```

**Result (sorted by avgRating descending):**
```json
{
  "data": {
    "series_aggregate": [
      {
        "groupId": "SciFi",
        "facts": {
          "total": 18,
          "avgRating": 8.9
        }
      },
      {
        "groupId": "Drama",
        "facts": {
          "total": 15,
          "avgRating": 7.5
        }
      },
      {
        "groupId": "Comedy",
        "facts": {
          "total": 23,
          "avgRating": 7.2
        }
      }
    ]
  }
}
```

**Note**: You can sort by either `groupId` or any of the fact names defined in your aggregation. If the field doesn't match any fact name or groupId, it defaults to sorting by groupId.

### Example 6: With Pagination

Paginate aggregation results:

```graphql
query {
  series_aggregate(
    pagination: {
      page: 2
      size: 10
    }
    aggregation: {
      groupId: "category"
      facts: [
        {
          operation: COUNT
          factName: "total"
          path: "id"
        }
      ]
    }
  ) {
    groupId
    facts
  }
}
```

**Note**: The `count` parameter in pagination is ignored for aggregation queries. Results are sorted by `groupId` in ascending order by default (or by the field and direction specified in the sort parameter).

### Example 7: Multiple Sort Fields

Sort by multiple fields (e.g., by total count descending, then by groupId ascending):

```graphql
query {
  series_aggregate(
    sort: {
      terms: [
        { field: "total", order: "DESC" },       # Primary sort: by total count
        { field: "groupId", order: "ASC" }       # Secondary sort: by groupId
      ]
    }
    aggregation: {
      groupId: "category"
      facts: [
        {
          operation: COUNT
          factName: "total"
          path: "id"
        }
        {
          operation: AVG
          factName: "avgRating"
          path: "rating"
        }
      ]
    }
  ) {
    groupId
    facts
  }
}
```

**Result:**
```json
{
  "data": {
    "series_aggregate": [
      {
        "groupId": "Drama",
        "facts": { "total": 45, "avgRating": 7.8 }
      },
      {
        "groupId": "Comedy",
        "facts": { "total": 32, "avgRating": 8.1 }
      },
      {
        "groupId": "Action",
        "facts": { "total": 32, "avgRating": 7.5 }
      }
    ]
  }
}
```

This shows how items with the same total count (Comedy and Action both have 32) are then sorted by groupId alphabetically.

### Example 8: With Sorting and Pagination Combined

Combine sorting by a fact with pagination (top 5 categories by total count):

```graphql
query {
  series_aggregate(
    sort: {
      terms: [
        { field: "total", order: "DESC" }  # Sort by total count
      ]
    }
    pagination: {
      page: 1
      size: 5
    }
    aggregation: {
      groupId: "category"
      facts: [
        {
          operation: COUNT
          factName: "total"
          path: "id"
        }
        {
          operation: SUM
          factName: "totalRevenue"
          path: "revenue"
        }
      ]
    }
  ) {
    groupId
    facts
  }
}
```

This query returns the top 5 categories with the most items, sorted by count in descending order.

### Example 9: Aggregate on Related Entity Field

Sum revenue from episodes (where episodes is a related entity collection):

```graphql
query {
  series_aggregate(
    aggregation: {
      groupId: "category"
      facts: [
        {
          operation: COUNT
          factName: "seriesCount"
          path: "id"
        },
        {
          operation: SUM
          factName: "totalRevenue"
          path: "episodes.revenue"
        }
      ]
    }
  ) {
    groupId
    facts
  }
}
```

## Field Path Resolution

The `groupId` and `path` parameters support:

1. **Direct Fields**: Simple field names from the entity
   - Example: `"category"`, `"rating"`, `"id"`

2. **Related Entity Fields**: Dot notation for fields in related entities
   - Example: `"country.name"`, `"studio.foundedYear"`
   
3. **Nested Related Entities**: Multiple levels of relationships
   - Example: `"country.region.name"`

## MongoDB Translation

The aggregation queries are translated to MongoDB aggregation pipelines:

1. **$lookup**: Used for non-embedded related entities
2. **$unwind**: Used to flatten joined collections
3. **$match**: Applied for filtering (before grouping)
4. **$group**: Groups by the specified field with aggregation operations
5. **$project**: Formats the final output with groupId and facts fields
6. **$sort**: Sorts results by groupId (ascending or descending)
7. **$limit** / **$skip**: Applied for pagination (after sorting)

## Notes

### Result Structure
- The `groupId` field in the result will contain the value used for grouping
- The `facts` field will contain a JSON object with all calculated metrics
- Both fields use the `GraphQLJSON` type to support flexible data structures

### Aggregation Operations
- **COUNT**: Counts the number of documents in each group
- **SUM, AVG, MIN, MAX**: Require numeric fields to operate on

### Filtering
- All filter parameters from regular queries work with aggregation
- Filters are applied **before** grouping

### Sorting
- You can sort by **groupId** or **any fact name**
- **Multiple sort fields are supported** - results are sorted by the first field, then by the second field for ties, etc.
- Set the `field` parameter to:
  - `"groupId"` to sort by the grouping field
  - Any fact name (e.g., `"avgRating"`, `"total"`) to sort by that calculated metric
- The `order` parameter (ASC/DESC) determines the sort direction for each field
- If a field doesn't match groupId or any fact name, it defaults to groupId
- If no sort is specified, defaults to sorting by groupId ascending

### Pagination
- The `page` and `size` parameters work as expected
- The `count` parameter is **ignored** for aggregation queries
- Pagination is applied **after** grouping and sorting

