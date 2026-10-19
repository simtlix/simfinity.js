---
title: Queries
description: Retrieve records with scalar filters, related-field conditions, AND/OR groups, pagination, sorting, aggregation, and virtual fields for reads that filters cannot express.
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
| `LIKE` | Literal substring, respecting case | `"Expanse"` |
| `ILIKE` | Literal substring, ignoring case | `"expanse"` |
| `STARTS_WITH`, `ISTARTS_WITH` | Literal prefix, respecting or ignoring case | `"The "`, `"the "` |
| `ENDS_WITH`, `IENDS_WITH` | Literal suffix, respecting or ignoring case | `" fiction"` |
| `IEQ` | Equal, ignoring case | `"science fiction"` |

Use the value's actual JSON type: a number for a numeric comparison, a Boolean for a Boolean field, a string for the [text operators](#text-operators), and an array for `IN`, `NIN`, or `BTW`.

`IN` and `NIN` require flat scalar lists; `BTW` requires exactly two non-null bounds. Null list elements, literal objects, nested lists, unsupported operators and invalid scalar values are rejected. Explicit `null` is supported by `EQ` and `NE`. Inline GraphQL values and variables follow the same rules. List items may be operation variables, as in `value: [$from, $to]`. Declare them as `QLValue` (or `QLValue!`): GraphQL rejects other declared types, such as `Int` or `String`, in that position. A list item whose variable the request leaves unset reads as `null`, as GraphQL reads list arguments, so it is rejected like an explicit null element. Enum literals such as `value: ACTIVE` or `value: [ACTIVE, INACTIVE]` are read as the enum names, like `"ACTIVE"`. Enum names or declared internal values are converted to the stored representation, including the state names used by state machines. Date values are converted without changing the input arguments. Validated scalars use their base scalar type for filters, allowing string fragments in the text operators and range bounds outside create/update constraints.

### Text operators

`LIKE`, `ILIKE`, `STARTS_WITH`, `ISTARTS_WITH`, `ENDS_WITH`, `IENDS_WITH` and `IEQ` compare a string with the value of a `String` field:

```graphql
query {
  series(
    name: { operator: ISTARTS_WITH, value: "the " }
    category: { operator: IEQ, value: "science fiction" }
  ) {
    id
    name
  }
}
```

- **Values are literal.** No character is a wildcard: `%`, `_`, `.`, `*`, `\`, `^`, `$` and `(` match themselves. A trailing newline is a character like any other, so `ENDS_WITH "a"` does not match `"a\n"`. MongoDB receives the value as an escaped regular expression and PostgreSQL as a bound parameter, so a value never becomes query syntax.
- **Case.** `LIKE`, `STARTS_WITH` and `ENDS_WITH` compare characters exactly. `ILIKE`, `ISTARTS_WITH`, `IENDS_WITH` and `IEQ` ignore case; see [case folding](#case-folding).
- **Empty values.** `""` matches every non-null string, except with `IEQ`, which matches only the empty string.
- **Fields and lists.** The field must be a `String` field or a `String` list. A validated scalar filters by its base scalar, so an email scalar accepts a fragment without running the scalar's own check. On a list, a record matches when some element matches, and through an embedded list when some item's value matches. Null and missing values never match.
- **Where they work.** Everywhere `LIKE` works: field filters, relationship `terms`, `AND`/`OR` conditions, paths through references and embedded values, collection fields, `pagination.count`, aggregate filters, [scopes](./query-scope) and joined scopes, and [MCP tools](./mcp). A path into a collection returns a record once for each matching child, as with every other operator.
- **Invalid input.** A value that is not a string, and a field whose base scalar is not `String`, fail with `INVALID_FILTER_VALUE` (400) on both backends. `ILIKE`, `STARTS_WITH`, `ISTARTS_WITH`, `ENDS_WITH`, `IENDS_WITH` and `IEQ` also reject a value that contains U+0000 with `INVALID_FILTER_VALUE`, before the database is queried; `LIKE` keeps its earlier handling of that character. On MongoDB, a value too long for a regular expression fails with `INVALID_FILTER_VALUE` too, with every one of these operators; see [indexes for text filters](#indexes-for-text-filters).
- **Custom adapters.** The MongoDB and PostgreSQL adapters support every operator. A custom `DatabaseAdapter` or SQL plugin supports only the operators of 3.7.0 until it declares `queryFeatures`, and so does a copy of `postgresPlugin()` that replaces its `compileQuery`; a request that uses another operator fails with `UNSUPPORTED_QUERY` (400); see [custom adapters and SQL plugins](../resources/compatibility#custom-adapters-and-sql-plugins).

### Case folding

Both backends ignore case through Unicode's case mappings. On both, `É` matches `é`, `ẞ` matches `ß`, the Kelvin sign `K` matches `k`, and `ǅ`, `ǆ` and `Ǆ` match each other, while `ß` does not match `ss`, `ﬁ` does not match `fi`, and `"istanbul"` does not find `İstanbul`.

MongoDB uses the case-insensitive option of its regular expressions, and PostgreSQL compares `lower()` of both sides under the ICU root collation `und-x-icu`, or, with the option [`foldFinalSigma: true`](#the-capital-sigma-on-postgresql), `lower()` followed by `translate()` of `ς` into `σ`. A few characters therefore match differently, and the integration tests pin each difference:

| Characters | MongoDB | PostgreSQL |
| --- | --- | --- |
| Lowercase variants that ICU `lower()` keeps: `ſ` (U+017F), `µ` (U+00B5), `ς` (U+03C2), `ϐ`, `ϑ`, `ϕ`, `ϖ`, `ϰ`, `ϱ`, `ϵ`, `ẛ`, U+0345, U+1FBE and U+1C80 to U+1C88 | Match their usual letters: `IEQ "sun"` finds `ſun`, and `IEQ "μm"` finds `µm` | Do not match their usual letters, except `ς`, which matches `σ` with `foldFinalSigma: true` |
| The capital sigma `Σ` (U+03A3) | `Σ`, `σ` and `ς` match each other wherever they appear, so each case-insensitive operator returns every record that its case-sensitive form returns | By default, `lower()` turns a `Σ` that ends a word into `ς` and any other `Σ` into `σ`, so `IEQ "ΟΔΟΣ"` finds `οδος` but not `οδοσ`, and `ILIKE "Σ"` does not find `ς`. A value with a `Σ` at one of its ends can also miss records that the case-sensitive operator returns: `ISTARTS_WITH "ΚΑΣ"` does not find `ΚΑΣΤΡΟ`, which `STARTS_WITH "ΚΑΣ"` finds. With `foldFinalSigma: true`, `Σ`, `σ` and `ς` match each other wherever they appear, as on MongoDB; see [the capital sigma on PostgreSQL](#the-capital-sigma-on-postgresql) |
| `İ` (U+0130) | Matches only itself | `lower()` turns it into `i` followed by U+0307, so `ISTARTS_WITH "i"` finds `İstanbul`, and `IEQ "İSTANBUL"` also finds `i̇stanbul` |
| Letters newer than the server's Unicode tables, such as U+A7DC, whose lowercase is U+019B (Unicode 16) | Do not match on MongoDB 8.0 | Match when the server's ICU version knows them |

The case-insensitive operators need a PostgreSQL server built with ICU, which provides `und-x-icu`; on a server without it they fail with `DATABASE_ERROR` (500). Folding follows the Unicode version of the server's ICU library on PostgreSQL and of its regular-expression library on MongoDB.

#### The capital sigma on PostgreSQL

ICU's `lower()` turns a capital `Σ` into the final sigma `ς` when a letter comes before it and no letter comes after it, and into `σ` otherwise. Characters such as `.`, `'`, `:` and combining accents between `Σ` and a letter do not count, while a space, a hyphen, a digit, `%` or the end of the text do. PostgreSQL lowers the search value on its own, inside the `LIKE` pattern for `ILIKE`, `ISTARTS_WITH` and `IENDS_WITH`, without the stored text around it, so a `Σ` at an end of the value can lower to the other sigma than the same `Σ` in the stored text. With the default fold, the case-insensitive operators then miss the record, even when it is written in the same case as the value and the case-sensitive operator, or MongoDB, returns it:

- **A value that ends in `Σ` after a letter**, or in `Σ` and a character such as `.`, misses stored text in which the word goes on: `ISTARTS_WITH "ΚΑΣ"` and `ILIKE "ΚΑΣ"` do not find `ΚΑΣΤΡΟ`, `ISTARTS_WITH "ΟΔΟΣ"` does not find `ΟΔΟΣΤΡΩΜΑ` or `ΟΔΟΣ.Α`, and `ILIKE "ΔΟΣ."` does not find `ΟΔΟΣ.Α`, although `STARTS_WITH "ΚΑΣ"`, `STARTS_WITH "ΟΔΟΣ"` and `LIKE "ΔΟΣ."` find them.
- **A value that starts with `Σ`** misses stored text in which that `Σ` ends a word: `IENDS_WITH "Σ ΑΒ"` does not find `ΟΔΟΣ ΑΒ`, and `ILIKE "Σ"` and `IENDS_WITH "Σ"` do not find `ΟΔΟΣ`.

`IEQ` compares whole values, so it can miss only text written with another sigma, as the table above shows, and never what `EQ` returns. A `Σ` with a letter on both sides within the value lowers as it does in the stored text, so `ISTARTS_WITH "ΚΑΣΤ"` finds `ΚΑΣΤΡΟ`. A lowercase `σ` or `ς` in the value stays as typed, so `ISTARTS_WITH "κασ"` finds `ΚΑΣΤΡΟ` but not `ΚΑΣ`, whose `Σ` lowers to `ς`. Lowering the value in the client does not help, because JavaScript's `toLowerCase()` applies the same rule as ICU.

To close the gap, set `foldFinalSigma: true` in `createPostgres(options)`, `postgresPlugin(options)` or `configure()`. PostgreSQL then folds both sides of `ILIKE`, `ISTARTS_WITH`, `IENDS_WITH` and `IEQ` with `translate(lower(x COLLATE "und-x-icu"), 'ς', 'σ')`, which turns every `ς` into `σ` after lowering, so `Σ`, `σ` and `ς` match each other wherever they appear, as on MongoDB: `ISTARTS_WITH "ΚΑΣ"` finds `ΚΑΣΤΡΟ`, `IEQ "ΟΔΟΣ"` finds `οδοσ`, `ILIKE "Σ"` finds `ς`, and each case-insensitive operator returns every record that its case-sensitive form returns. `LIKE`, `STARTS_WITH`, `ENDS_WITH` and the other operators compile the same statements with both settings, and the other characters of the table above keep their differences. The option is off by default so that the statements, and the indexes that serve them, stay as they are; a value other than `true` or `false` throws `INVALID_DATABASE_SCHEMA` (400) from `createSchema()`. Its statements and indexes contain `σ` and `ς`, which PostgreSQL converts to the server encoding, so the option needs an encoding that has both, such as `UTF8`, `ISO_8859_7` or `WIN1253`: on another, such as `LATIN1`, every case-insensitive filter would fail with `INVALID_VALUE` (400), even for an ASCII value, and the index statements below fail too, so initialization, in both modes, first checks the encoding and rejects such a database with `INVALID_DATABASE_SCHEMA` (400). The default statements contain neither character.

An [index for text filters](#indexes-for-text-filters) serves these operators only when it is on the expression of the runtime's setting, so create the indexes of the setting you deploy. For the examples of that section, a `text_pattern_ops` btree for `IEQ` and `ISTARTS_WITH`, a trigram index for `ILIKE`, `ISTARTS_WITH` and `IENDS_WITH`, which needs the `pg_trgm` extension, and a btree for `IEQ` on a member of an embedded value stored as jsonb:

```sql
-- foldFinalSigma: false, the default
CREATE INDEX series_name_ci ON "app"."Serie" (lower("name" COLLATE "und-x-icu") text_pattern_ops);
CREATE INDEX series_name_trgm ON "app"."Serie" USING gin (lower("name" COLLATE "und-x-icu") gin_trgm_ops);
CREATE INDEX series_label_ci ON "app"."Serie" (lower(("details" ->> 'label') COLLATE "und-x-icu"));
-- foldFinalSigma: true
CREATE INDEX series_name_ci_sigma ON "app"."Serie" (translate(lower("name" COLLATE "und-x-icu"), 'ς', 'σ') text_pattern_ops);
CREATE INDEX series_name_trgm_sigma ON "app"."Serie" USING gin (translate(lower("name" COLLATE "und-x-icu"), 'ς', 'σ') gin_trgm_ops);
CREATE INDEX series_label_ci_sigma ON "app"."Serie" (translate(lower(("details" ->> 'label') COLLATE "und-x-icu"), 'ς', 'σ'));
```

Changing the setting requires rebuilding these indexes on the new expression. An index on the other expression no longer serves the operators, and PostgreSQL then reads every row without any error, while `REINDEX` keeps the old expression. Create the indexes of the new setting under their own names, as above, for example with `CREATE INDEX CONCURRENTLY`, before instances with the new setting serve requests, keep the old ones while instances with the old setting still run, and drop them afterwards. Initialization keeps indexes on either expression in both modes.

Without the option, store a normalized copy of the text in a field that a [controller](./controllers) keeps up to date, such as `text.toLowerCase().replaceAll('ς', 'σ')`, and search that field with `STARTS_WITH`, `LIKE` or `EQ` and a value normalized the same way; both backends then return the same records, and an index on the field serves `STARTS_WITH` and `EQ`. Otherwise, avoid case-insensitive search values that start or end with a capital `Σ`.

### Indexes for text filters

On PostgreSQL, text columns use the `C` collation, and the operators compile to these conditions, where `$1` is a bound parameter. With [`foldFinalSigma: true`](#the-capital-sigma-on-postgresql), `translate(lower(x COLLATE "und-x-icu"), 'ς', 'σ')` takes the place of `lower(x COLLATE "und-x-icu")`, on both sides and in the indexes:

| Operator | Condition | Index that serves it |
| --- | --- | --- |
| `STARTS_WITH` | `starts_with("column" COLLATE "C", $1)` | Any btree index on the column |
| `IEQ` | `lower("column" COLLATE "und-x-icu") = lower($1 COLLATE "und-x-icu")` | A btree index on `lower("column" COLLATE "und-x-icu")` |
| `ISTARTS_WITH` | `lower("column" COLLATE "und-x-icu") LIKE lower($1 COLLATE "und-x-icu")`, with `$1` = `value%` | A btree index on the same expression with `text_pattern_ops`, or a trigram index |
| `ILIKE`, `IENDS_WITH` | The same, with `$1` = `%value%` or `%value` | A trigram index |
| `LIKE`, `ENDS_WITH` | `strpos("column" COLLATE "C", $1) > 0`, `right("column" COLLATE "C", char_length($1)) = $1` | None |

In the `LIKE` patterns, `\`, `%` and `_` of the value are escaped. Simfinity creates no index for the text operators: create the ones your searches need in your own migration, on exactly the compiled expression, `lower("column" COLLATE "und-x-icu")`, or `translate(lower("column" COLLATE "und-x-icu"), 'ς', 'σ')` with `foldFinalSigma: true`; an index on `lower("column")` without the collation does not serve them, and neither does an index on the expression of the other setting. Initialization keeps such indexes in both modes. These are the indexes of the default setting; [the capital sigma on PostgreSQL](#the-capital-sigma-on-postgresql) gives those of `foldFinalSigma: true`:

```sql
-- IEQ and ISTARTS_WITH
CREATE INDEX series_name_ci ON "app"."Serie" (lower("name" COLLATE "und-x-icu") text_pattern_ops);
-- ILIKE, ISTARTS_WITH and IENDS_WITH
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX series_name_trgm ON "app"."Serie" USING gin (lower("name" COLLATE "und-x-icu") gin_trgm_ops);
-- IEQ on a member of an embedded value stored as jsonb
CREATE INDEX series_label_ci ON "app"."Serie" (lower(("details" ->> 'label') COLLATE "und-x-icu"));
```

A btree index on `lower("column" COLLATE "und-x-icu")` with the default operator class serves `IEQ` but not `ISTARTS_WITH`. A trigram index narrows an `ILIKE` search only for values of three or more characters. For the `LIKE` patterns, PostgreSQL derives the index condition from the bound value when it plans the statement, which it does for the unnamed statements that Simfinity sends. Conditions on a `String` list read every element of the list, so these indexes do not serve them.

On MongoDB, `STARTS_WITH` reads a prefix range of an index on the field. The other text operators, like `LIKE`, test every key of such an index, or every document without one. `$regex` ignores collations, so a case-insensitive collation index does not serve them; for frequent case-insensitive equality or prefix searches, store a normalized copy of the field, such as its lowercase form, and filter it with `EQ` or `STARTS_WITH`. MongoDB accepts regular expressions of at most 32,764 bytes of UTF-8, so on MongoDB a value whose pattern is longer fails with `INVALID_FILTER_VALUE` (400) before the query runs, with `LIKE` and with the text operators. Every escaped character counts one byte more, and the operators add up to four bytes of their own: `^` for the prefixes, `\z` for the suffixes, both for `IEQ` and `.*` twice for `LIKE`. So an `ILIKE` value of 32,764 ASCII letters runs, while 16,383 dots or 16,383 two-byte letters such as `é` fail. PostgreSQL has no such limit.

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
- No path segment may name a [virtual field](#virtual-fields), which holds no stored value. Such paths fail with `FORBIDDEN_FILTER_PATH` (403) too, whatever `queryable` says.
- With the [authorization plugin](./authorization#filter-sort-and-aggregation-paths), every field a path names also needs a read rule.

Paths that middleware or scope functions add are trusted and are not checked, with one exception: a path through a virtual field fails with `INVALID_MODEL` (500) before the database is queried, because it cannot compile against storage that does not exist.

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

Records with equal sort keys have no guaranteed order on either backend, and neither do records read without a sort. End the sort with a unique field, such as `id`, when you page through results. A collection field read in a [batch](./relationships#batched-collection-reads), opt-in on both backends with `batchedCollections: true`, can return unsorted rows, or rows with equal sort keys, in another order than a read of that parent alone, and on a page that does not hold all of the parent's rows, other such rows can fill it. Each page keeps its sort keys, and a page that holds all of a parent's rows keeps those rows. On PostgreSQL, sorts on `id` and required fields of the root type can be served by the primary key or a declared index; nullable fields place nulls first ascending and last descending, as MongoDB does, which default-order indexes do not serve. A filtered and sorted page can get slower when the filter column correlates with the sort column; see [PostgreSQL query semantics](/postgresql#graphql-execution-and-native-access) for the index advice and the `explicitNullsOrder` option.

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

## Virtual fields

Most reads of stored records are generated queries: filters select what the client asks for, [query scopes](./query-scope) restrict what the caller may see, and [aggregate queries](#aggregate-records) calculate totals. Some reads need logic that the filter language cannot express, such as a projection of records that a scope hides from the caller, a calculation, or data from another source. Add such a read to the registered type it belongs to, as a **virtual field**: a field with its own resolver, optionally with arguments, declared with `extensions: { virtual: true }`. Clients select it together with the record, through the type's generated queries, so the type's middleware, scope and permission rules decide which records reach it. No backend stores it, and it is not part of the query language. Prefer it to a custom mutation that reads the records; see [reading stored records through a custom mutation](./anti-patterns#reading-stored-records-through-a-custom-mutation).

### Declare a virtual field

This field returns the times that confirmed bookings hold in a barbershop on a date. A scope on `Booking` lets clients read only their own bookings, so they cannot list the others to find the taken times, but every client who may see a shop may see when it is busy. The example assumes a `Booking` type registered with `connect()`, with references to its `barbershop` and to its `professional`, which is `null` when the booking holds the whole shop. `scheduledDate` (`'YYYY-MM-DD'`), `startTime` and `endTime` (`'HH:mm'`) are `String` fields, and `status` is an enum whose `CONFIRMED` value has no internal value, so MongoDB stores `CONFIRMED` too:

```javascript
// barbershop.js
import {
  GraphQLID,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLString,
} from 'graphql';
import { simfinity } from './runtime.js';
import { listBusyRanges } from './busy-ranges.js';

// Clients see approved shops only; administrators see every shop. Lists, reads
// by ID and aggregates each run their own scope, so all three get this one.
const approvedShops = async ({ args, context }) => {
  if (context?.user?.role === 'admin') return;
  args.AND = [
    ...(args.AND || []),
    { conditions: [{ field: 'status', operator: 'EQ', value: 'APPROVED' }] },
  ];
};

const BusyRangeType = new GraphQLObjectType({
  name: 'BusyRange',
  description: 'Time held by a confirmed booking, without client data.',
  fields: {
    startTime: { type: GraphQLString },
    endTime: { type: GraphQLString },
    professionalId: { type: GraphQLID, description: 'Null when the booking holds the whole shop.' },
  },
});

export const BarbershopType = new GraphQLObjectType({
  name: 'Barbershop',
  extensions: { scope: { find: approvedShops, get_by_id: approvedShops, aggregate: approvedShops } },
  fields: () => ({
    id: { type: GraphQLID },
    name: { type: new GraphQLNonNull(GraphQLString) },
    status: { type: GraphQLString },
    busyRanges: {
      type: new GraphQLList(new GraphQLNonNull(BusyRangeType)),
      description: 'Times held by confirmed bookings on a date, by start time.',
      args: {
        date: { type: new GraphQLNonNull(GraphQLString), description: 'Day in YYYY-MM-DD format.' },
        professionalId: { type: GraphQLID, description: 'Only the ranges that block this professional.' },
      },
      extensions: { virtual: true },
      resolve: async (shop, { date, professionalId }) => {
        const ranges = await listBusyRanges(shop, date);
        // A booking without a professional blocks every professional of the shop.
        return professionalId
          ? ranges.filter((range) => range.professionalId === null || range.professionalId === professionalId)
          : ranges;
      },
    },
  }),
});

simfinity.connect(null, BarbershopType, 'barbershop', 'barbershops');
```

`listBusyRanges` reads the bookings through the [native model](./server-side-operations#use-the-native-model-for-atomic-operations). It is written on top of `listBusyRangesOfShops`, which reads the bookings of several shops at once, so that the [batched reads](#performance-and-batching) below can reuse it:

::: code-group

```javascript [MongoDB]
// busy-ranges.js
import { simfinity } from './runtime.js';
import { BookingType } from './booking.js';

const toRange = (booking) => ({
  startTime: booking.startTime,
  endTime: booking.endTime,
  professionalId: booking.professional ? String(booking.professional) : null,
});

// The confirmed bookings of the given shops on a date, read natively, without
// Booking's scope: one list of busy ranges per shop ID, in the order of shopIds.
export const listBusyRangesOfShops = async (shopIds, date) => {
  const bookings = await simfinity.getModel(BookingType)
    .find({ barbershop: { $in: shopIds }, scheduledDate: date, status: 'CONFIRMED' })
    .select('barbershop startTime endTime professional')
    .sort({ startTime: 1 })
    .lean();
  const ranges = new Map(shopIds.map((id) => [id, []]));
  for (const booking of bookings) ranges.get(String(booking.barbershop)).push(toRange(booking));
  return shopIds.map((id) => ranges.get(id));
};

export const listBusyRanges = async (shop, date) => (await listBusyRangesOfShops([String(shop._id)], date))[0];
```

```javascript [PostgreSQL]
// busy-ranges.js
import { simfinity } from './runtime.js';
import { BookingType } from './booking.js';

// find() returns at most 100 records without pagination and rejects a page
// size above the maxPageSize of configureQueryLimits(), so read every page.
// Keep PAGE_SIZE at or below that limit.
const PAGE_SIZE = 100;

const toRange = (booking) => ({
  startTime: booking.startTime,
  endTime: booking.endTime,
  professionalId: booking.professional ?? null,
});

// The confirmed bookings of the given shops on a date, read natively, without
// Booking's scope: one list of busy ranges per shop ID, in the order of shopIds.
export const listBusyRangesOfShops = async (shopIds, date) => {
  const ranges = new Map(shopIds.map((id) => [id, []]));
  for (let page = 1; ; page += 1) {
    const bookings = await simfinity.getModel(BookingType).find({
      barbershop: { terms: [{ path: 'id', operator: 'IN', value: shopIds }] },
      scheduledDate: { operator: 'EQ', value: date },
      status: { operator: 'EQ', value: 'CONFIRMED' },
      // The ID breaks ties between equal start times, so pages do not overlap.
      sort: { terms: [{ field: 'startTime', order: 'ASC' }, { field: 'id', order: 'ASC' }] },
      pagination: { page, size: PAGE_SIZE },
    });
    for (const booking of bookings) ranges.get(booking.barbershop).push(toRange(booking));
    if (bookings.length < PAGE_SIZE) break;
  }
  return shopIds.map((id) => ranges.get(id));
};

export const listBusyRanges = async (shop, date) => (await listBusyRangesOfShops([shop.id], date))[0];
```

:::

The MongoDB query compares stored values, while PostgreSQL's `find()` takes generated filters, which accept enum names: for an enum declared as `CONFIRMED: { value: 'confirmed' }`, only the MongoDB snippet needs `'confirmed'`.

A client reads the field through the shop:

```graphql
query ShopDay($id: ID!, $date: String!, $professionalId: ID) {
  barbershop(id: $id) {
    name
    busyRanges(date: $date, professionalId: $professionalId) {
      startTime
      endTime
      professionalId
    }
  }
}
```

### What a virtual field runs

The field resolves wherever a response contains a barbershop: under `barbershop` and `barbershops`, through generated relationships that reach the type, in mutation results, in [in-process execution](./server-side-operations#execute-the-generated-schema-in-process) and in [MCP tools](#virtual-fields-in-mcp-tools). In a query, the generated read has already run the type's global middleware and its `get_by_id` or `find` scope, so a shop that the scope hides from the caller reads as `null`, or is left out of the list, and the resolver never runs for it. Generated single relationships run the `get_by_id` scope too, as described in [scope boundaries](./query-scope#scope-boundaries). In a mutation result, the field runs after the mutation has committed, on the record that the mutation wrote.

The resolver receives `(parent, args, context, info)`, as every GraphQL resolver does. `parent` is the record that the generated read returned, with `_id` on MongoDB and both `id` and `_id` on PostgreSQL; `args` holds the field's arguments, coerced by GraphQL; `context` is the request context. It receives no session: like the generated query, its native read runs outside any transaction and sees committed data.

Simfinity adds nothing to that native read: the booking scope, middleware and permission rules do not run, which is what lets it see every client's bookings. Return only what every caller who may read the shop may see, as `BusyRange` does with times and professional IDs, and check anything else in the resolver itself. With the [authorization plugin](./authorization), the root query's rule, such as `RootQueryType.barbershop`, and the field's own rule, `Barbershop.busyRanges`, both apply; unlike [path rules](./authorization#filter-sort-and-aggregation-paths), the field rule receives the shop as `parent` and the field's arguments as `args`. Under `defaultPolicy: 'DENY'`, also grant the fields of `BusyRange`.

### What virtual changes

Without `virtual`, Simfinity would describe `busyRanges` as stored data. With it, on both backends:

- **Nothing is stored.** The `Barbershop` table has only `id`, `name` and `status`, and MongoDB documents have no `busyRanges` key. Adding a virtual field to a deployed type is not a schema change: `initializeDatabase()` validates, in both modes, a PostgreSQL database created before the field existed.
- **Nothing is written.** `BarbershopInput` has `name` and `status` only, and `BusyRange` needs no registration, input type or model.
- **Nothing filters by it.** `barbershops`, `barbershops_aggregate` and collection fields that list barbershops have no `busyRanges` argument, and filter, sort, `groupId` and fact paths through it fail as described in [path restrictions](#path-restrictions).
- **Any result type works** without `relation`, including registered entities, interfaces, unions and custom scalars, and so does a non-null result.

The [`virtual` reference](../reference/extensions#virtual) lists every rule, option and error.

Virtual fields cannot be filtered, sorted, grouped or aggregated, because they hold no value to compare. Keep a value that clients must filter or sort by in a stored field that a controller keeps up to date, as the order total in [work inside the transaction with controllers](./server-side-operations#work-inside-the-transaction-with-controllers). They cannot be written either, appear on input types or subscriptions, or read inside a caller's transaction.

### Performance and batching

The resolver runs once for every shop in the response, and once more for every alias of the field. A list query such as `barbershops { busyRanges(date: "2026-10-20") { startTime } }` therefore runs one native read per returned shop after the list query, the N+1 pattern; nested collections and MCP list tools multiply it. When lists select the field, batch these reads per request with the [DataLoader](https://github.com/graphql/dataloader) package, keeping one loader per context object and per value of the arguments that change the read, here the date:

```javascript
// busy-range-loader.js
import DataLoader from 'dataloader';
import { listBusyRangesOfShops } from './busy-ranges.js';

// One loader per request context and date, so the shops of one response that
// ask for the same date share one read.
const loaders = new WeakMap();

export const loadBusyRanges = (context, shop, date) => {
  let byDate = loaders.get(context);
  if (!byDate) {
    byDate = new Map();
    loaders.set(context, byDate);
  }
  if (!byDate.has(date)) {
    byDate.set(date, new DataLoader((shopIds) => listBusyRangesOfShops(shopIds, date)));
  }
  return byDate.get(date).load(String(shop._id));
};
```

The field's resolver then takes `context` as its third argument and calls `loadBusyRanges(context, shop, date)` instead of `listBusyRanges(shop, date)`:

```javascript
resolve: async (shop, { date, professionalId }, context) => {
  const ranges = await loadBusyRanges(context, shop, date);
  // A booking without a professional blocks every professional of the shop.
  return professionalId
    ? ranges.filter((range) => range.professionalId === null || range.professionalId === professionalId)
    : ranges;
},
```

DataLoader collects the `load()` calls of one tick and passes their shop IDs to `listBusyRangesOfShops` together, which returns one list of ranges per ID, in their order, as DataLoader requires. The two shops of the list above then share one read, and two aliases with different dates take one read each.

- On MongoDB, one `$in` read returns every booking of the batch.
- On PostgreSQL, the read must page through every result, as `listBusyRangesOfShops` does: the default page of 100 records and the `maxPageSize` of [`configureQueryLimits()`](../reference/api#configurequerylimits) apply to the whole read, not to each shop. A single unpaged `find()` returns at most 100 bookings across all the shops of the batch, so the shops past them would show their taken times as free, and a page larger than `maxPageSize` fails with `INVALID_PAGINATION` (400).
- Each request needs its own context object, which GraphQL servers and the [operation runner](./server-side-operations#execute-the-generated-schema-in-process) create. A `WeakMap` cannot use a primitive as a key, and a context object shared by several requests would share its loaders and their cached ranges. MCP's in-process execution uses the `context` option itself when it is an object, `{}` by default, for every call, so pass a factory such as `context: () => ({})`, or one that authenticates the call.

### Virtual fields in MCP tools

[Generated MCP tools](./mcp) read virtual fields like other fields, with two rules, because each one costs a resolver call:

- A virtual field with a required argument that has no default, such as `busyRanges(date: String!)`, gets its own read tool on a type with a generated by-ID query, named `<byIdQuery>_<field>`: `barbershop_busyRanges`. It takes the shop's `id` and the field's arguments, runs `barbershop(id) { busyRanges(…) }`, with the type's middleware, scope and rules, and returns `{ barbershop: { busyRanges: […] } }`, or `{ barbershop: null }` for a shop that the caller cannot see. Its annotations mark it read-only. `extensions: { virtual: { mcp: false } }` leaves it out.
- A virtual field without required arguments is selected by by-ID and mutation tools, as any other field. List tools select it only with `extensions: { virtual: { mcp: 'select' } }`, since they would run its resolver for every listed record; batch its reads when you set it. The same rule applies to the items of a nested collection or an embedded list in any tool, such as the bookings that a shop's get-by-id tool selects.

A per-field tool runs the resolver once per call, and an `mcp: 'select'` field once per listed record. See [virtual field tools](../reference/mcp#virtual-field-tools) for the tool's input, operation, output and options.

### Fields that compute without virtual

A field that is `readOnly` and has arguments and its own resolver, but is not virtual, is still described as stored data: PostgreSQL gives it storage, and requires `relation` for an object result; list queries give it a filter argument, which clients cannot use unless the field sets `queryable: true`, and which then compares the stored value; and no MCP tool can pass its required arguments. `createSchema()` logs a `Configuration issue` warning once for each such field of a registered type, unless it is a reference or a collection; see [virtual](../reference/extensions#virtual). Declaring a deployed field virtual removes its storage, its filter argument and its MCP input property, so read the [upgrade notes](../resources/compatibility#virtual-fields) first.

To constrain which records a caller may query, continue with [query scope](./query-scope).
