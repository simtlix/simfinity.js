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

Supply an entity ID: a MongoDB ObjectId for the Mongo facade or a UUID for PostgreSQL. The generated argument is `id: ID`; declaring your operation variable as `ID!` makes it required for that operation. An ID with no matching record returns `null`. A malformed ID fails with `NOT_VALID_ID` (400); on MongoDB, a type with a `get_by_id` [scope](./query-scope) validates the ID as a filter value instead and fails with `INVALID_FILTER_VALUE` (400).

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

The result is an array directly under `data.series`, rather than an `edges` / `nodes` connection. With no pagination supplied, list queries return at most `Math.min(100, maxPageSize)` records; the configurable maximum defaults to 1000.

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

`IN` and `NIN` require flat scalar lists; `BTW` requires exactly two non-null bounds. Null list elements, literal objects, nested lists, unsupported operators and invalid scalar values are rejected. Explicit `null` is supported by `EQ` and `NE`. Inline GraphQL values and variables follow the same rules. List items may be operation variables, as in `value: [$from, $to]`. Declare them as `QLValue` (or `QLValue!`): GraphQL rejects other declared types, such as `Int` or `String`, in that position. A list item whose variable the request leaves unset reads as `null`, as GraphQL reads list arguments, so it is rejected like an explicit null element. Enum literals such as `value: ACTIVE` or `value: [ACTIVE, INACTIVE]` are read as the enum names, like `"ACTIVE"`. Enum names or declared internal values are converted to the stored representation, including the state names used by state machines. Date values are converted without changing the input arguments. Validated scalars use their base scalar type for filters, allowing string fragments in `LIKE` and range bounds outside create/update constraints.

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

### Fields named like query arguments

List queries and collection fields generate the control arguments `sort`, `pagination`, `AND` and `OR`; aggregate queries also generate `aggregation`. Every other field gets a top-level filter argument with its own name, on both backends:

- A field named `sort`, `pagination`, `AND` or `OR` has no top-level filter, because the control argument takes its name. Filter it with a group condition, such as `AND: [{ conditions: [{ field: "sort", operator: EQ, value: "s1" }] }]`. It can still be sorted, grouped and aggregated. `createSchema()` logs a `Configuration issue: Type.sort has the name of a generated list query argument, …` warning once per runtime for each such field of a type with a list query or a collection field. A collection field has no filter for its child's back-reference, so a back-reference with one of these names keeps the control argument there and is reported only by the child's own list query, if it has one.
- A field named `aggregation` is an ordinary top-level filter on list queries, counts and collection fields, and in `find` and `get_by_id` scopes. On `<list>_aggregate`, `aggregation` is the aggregation expression, so filter the field there with a group condition; `createSchema()` logs a warning once per runtime for such a type with an aggregate query.
- A field named `conditions` is an ordinary top-level filter everywhere; `conditions` lists conditions only inside an `AND` or `OR` group.

These filters follow the same [path restrictions](#path-restrictions) as other fields. Rename such fields when you can.

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

All `terms` are ANDed, including multiple conditions on the same path. For example, `[{ path: "year", operator: GTE, value: 2020 }, { path: "year", operator: LTE, value: 2025 }]` preserves both bounds. These conditions remain ANDed with logical groups and scope filters. Paths must terminate at a declared scalar or enum field. MongoDB ID comparisons use the actual Mongoose schema path, including supplied models with string or numeric `_id` fields; PostgreSQL entity and reference IDs are UUIDs.

::: info Referenced collection joins
Root filters that traverse a one-to-many relation preserve one result row per matching child. A parent can appear more than once when multiple child records match, on both supported backends. Account for this when designing result lists and counts.
:::

### IDs in paths

In filters, sorts and aggregation paths, `id` names the record identity at the root and after a relationship (`_id` on MongoDB). Inside an embedded object, such as `address.id` or `lines.id`, `id` is the embedded object's declared `id` member on both backends, the value that reads return. These MongoDB cases use the subdocument `_id` instead:

- An entity type, registered with `connect()` or targeted by a reference, that is embedded as a list item. Its reads return the automatic `_id` that Mongoose gives each item, and filters match that value. The declared `id` stays stored but is neither returned nor matched; see [supporting types without endpoints](./schema#supporting-types-without-endpoints).
- A supplied subdocument schema that declares no `id` path. Filters, sorts and groups use the subdocument `_id`. Mutation responses, and by-ID and reference reads of a type without a `get_by_id` scope, return it through Mongoose's `id` virtual, but list queries, collection fields and scoped by-ID reads return `null` for `id`, because aggregation results carry no virtuals. Declare an `id` path in the subdocument schema if clients filter by IDs they read from lists.
- An entity type stored in a supplied single-nested subdocument schema that has an automatic `_id`, such as `tag: new Schema({ id: ObjectId, name: String })`. Reads return the subdocument `_id` and filters match it, as for embedded lists.

### Path restrictions

Filter, sort, `groupId` and fact paths supplied by the client are collected before middleware and scopes run, so the paths those add are trusted:

- No path segment may name a field with `extensions.queryable: false`, or a field with an application-defined `resolve`. This includes masking resolvers, relationship fields with a manual resolver, and a custom `id` resolver; only the resolvers Simfinity generates keep a field queryable. Set `extensions.queryable: true` to let clients query a stored field that has its own resolver. Such paths fail with `FORBIDDEN_FILTER_PATH` (403); unknown fields still fail with `INVALID_FILTER_FIELD` (400).
- A path through a non-embedded single reference to a type with a `find` scope only matches rows whose referenced record that scope admits, including when it is used for sorting or grouping; a path used only in `AND`/`OR` group conditions restricts just the groups that use it. A path into a collection relation whose type's `find` scope restricts the caller, such as `seasons.year` when `Season` is scoped, fails with `FORBIDDEN_FILTER_PATH`. So does a path into a type whose `find` scope, while it restricts the caller, filters through a collection relation or a reference inside an embedded list. See [query scope](./query-scope#relationship-paths-in-filters-sorts-and-aggregations).
- With the [authorization plugin](./authorization#filter-sort-and-aggregation-paths), every field a path names also needs a read rule.

Paths that middleware or scope functions add are trusted and are not checked.

::: tip Upgrading
Relationship fields and `id` fields that define their own `resolve` were previously usable in filter, sort and aggregation paths. Remove manual relationship resolvers that only load the related record, since Simfinity generates them, or set `extensions: { queryable: true }` on fields whose resolver returns the stored value.
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

The default maximum page size is **1000**. Configure the process-wide limit at startup:

```javascript
simfinity.configureQueryLimits({ maxPageSize: 500 });
```

The configured maximum may be any positive safe integer. Unpaged lists use `Math.min(100, maxPageSize)`; unpaged aggregates remain unbounded. Both pagination values and the computed skip must be safe integers, with `page >= 1` and `1 <= size <= maxPageSize`. Invalid pagination throws `INVALID_PAGINATION` (400); invalid configuration throws `INVALID_QUERY_LIMITS` (400). `configureQueryLimits()` restores the default maximum. This is an intentional limit on previously unrestricted explicit page sizes; configure a larger maximum when your application requires it.

When `count: true`, the list resolver calculates the matching count before pagination and places it on the GraphQL context (a context object is required; without one the rows are returned and the count query is skipped). [MCP tools](/reference/mcp#counted-lists) collect it through the root value instead and return it as `totalCount`. Add the count plugin to expose it in a GraphQL response:

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

List sort paths are checked against the declared fields. `id` and related `.id` paths resolve to the backend identity column; embedded paths stay dotted, and an embedded `.id` follows the [embedded `id` rule](#ids-in-paths). Multiple terms through the same relationship reuse its join.

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

Supported operations are `SUM`, `COUNT`, `AVG`, `MIN`, and `MAX`. Every fact requires `path`, including `COUNT`; use an existing field such as `id` for counting. `groupId` and fact paths follow the same [path restrictions](#path-restrictions) as filters. Filters run before grouping. Aggregate sorting accepts a fact name or `groupId`, and pagination applies to groups. Unlike list queries, aggregates have no default 100-result limit when pagination is omitted. See the [aggregation reference](../reference/aggregation) for input and result details.

PostgreSQL also supports scalar-list leaves inside nested embedded lists for filters, sorts, ragged group keys, and array-valued facts. Array `MIN`/`MAX` compares the complete array, while result sorting selects the immediate extrema. Whole embedded objects cannot be sorted or grouped. The [PostgreSQL query boundaries](./postgresql#query-support-and-boundaries) list the exact remaining limits.

To constrain which records a caller may query, continue with [query scope](./query-scope).
