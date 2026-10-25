---
title: Queries
description: Retrieve records with scalar filters, related-field conditions, AND/OR groups, pagination, sorting, aggregation, virtual fields for reads that filters cannot express, custom queries for results that are not stored records, and named views.
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
| `IS_EMPTY`, `IS_NOT_EMPTY` | The field holds no value, or holds one; see [empty values](#empty-values) | None: omit `value` or pass `null` |

Use the value's actual JSON type: a number for a numeric comparison, a Boolean for a Boolean field, a string for the [text operators](#text-operators), and an array for `IN`, `NIN`, or `BTW`. `IS_EMPTY` and `IS_NOT_EMPTY` take no value; any value other than `null`, including `""`, `[]`, `false` and `0`, fails with `INVALID_FILTER_VALUE` (400) on both backends.

`IN` and `NIN` require flat scalar lists; `BTW` requires exactly two non-null bounds. Null list elements, literal objects, nested lists, unsupported operators and invalid scalar values are rejected. Explicit `null` is supported by `EQ` and `NE`, and is the only value that `IS_EMPTY` and `IS_NOT_EMPTY` accept. Inline GraphQL values and variables follow the same rules. List items may be operation variables, as in `value: [$from, $to]`. Declare them as `QLValue` (or `QLValue!`): GraphQL rejects other declared types, such as `Int` or `String`, in that position. A list item whose variable the request leaves unset reads as `null`, as GraphQL reads list arguments, so it is rejected like an explicit null element. Enum literals such as `value: ACTIVE` or `value: [ACTIVE, INACTIVE]` are read as the enum names, like `"ACTIVE"`. Enum names or declared internal values are converted to the stored representation, including the state names used by state machines. Date values are converted without changing the input arguments. Validated scalars use their base scalar type for filters, allowing string fragments in the text operators and range bounds outside create/update constraints.

### Filters on lists

On a scalar list, such as a `tags: [String]` field, a condition compares the list's elements, on both backends. The value is a single element, never a whole list: `tags: { operator: EQ, value: ["a", "b"] }` fails with `INVALID_FILTER_VALUE` (400).

| Condition | A record matches when |
| --- | --- |
| `EQ "a"`, `IN ["a", "b"]` | Some element equals the value, or one of the values |
| `NE "a"`, `NIN ["a", "b"]` | No element equals the value, or any of the values, so a missing, `null` or empty list matches too |
| `EQ null` | The list is missing or `null`, or some element is `null`: `[null]` matches, `[]` does not |
| `NE null` | The list is present and holds no `null` element: `[]` matches, a missing list and `[null]` do not |
| `LT`, `LTE`, `GT`, `GTE` and the [text operators](#text-operators) | Some element matches |

A leaf reached through an embedded list, such as `lines.qty`, compares the values of the list's items: `EQ`, `IN`, the comparisons and the text operators match when some item's value matches, and `NE` and `NIN` when none does. No condition on the elements matches exactly the lists that hold nothing, since `EQ null` also matches `[null]` and never `[]`; [`IS_EMPTY`](#empty-values) does: it holds for a missing, `null` or empty list, and not for `[null]` or `[""]`.

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
- **Where they work.** Everywhere `LIKE` works: field filters, relationship `terms`, `AND`/`OR` conditions, paths through references and embedded values, collection fields, `pagination.count`, aggregate filters, [scopes](./query-scope) and joined scopes, and [MCP tools](./mcp). On an adapter that declares `queryFeatures.quantifiers`, a path into a collection is an `ANY` frame and returns each record once; see [collection frames](#collection-frames).
- **Invalid input.** A value that is not a string, and a field whose base scalar is not `String`, fail with `INVALID_FILTER_VALUE` (400) on both backends. `ILIKE`, `STARTS_WITH`, `ISTARTS_WITH`, `ENDS_WITH`, `IENDS_WITH` and `IEQ` also reject a value that contains U+0000 with `INVALID_FILTER_VALUE`, before the database is queried; `LIKE` keeps its earlier handling of that character. On MongoDB, a value too long for a regular expression fails with `INVALID_FILTER_VALUE` too, with every one of these operators; see [indexes for text filters](#indexes-for-text-filters).
- **Custom adapters.** The MongoDB and PostgreSQL adapters support every operator. A custom `DatabaseAdapter` or SQL plugin supports only the operators of 3.7.0 until it declares `queryFeatures`, and so does a copy of `postgresPlugin()` that replaces its `compileQuery`; a request that uses another operator fails with `UNSUPPORTED_QUERY` (400); see [custom adapters and SQL plugins](../resources/compatibility#custom-adapters-and-sql-plugins).

### Case folding

Both backends ignore case through the Unicode simple case foldings, which map one character to one character, so that each case-insensitive operator returns every record that its case-sensitive form returns. On both, `É` matches `é`, `ẞ` matches `ß`, the Kelvin sign `K` matches `k`, `ǅ`, `ǆ` and `Ǆ` match each other, `Σ`, `σ` and the final sigma `ς` match each other wherever they appear, and lowercase variants match their usual letters, such as `ſ` and `s`, `µ` (micro sign) and `μ`, or `ϑ` and `θ`. Apart from PostgreSQL's lowering of `İ` (U+0130) to two characters, described below, neither backend applies length-changing or language-specific foldings: `ß` does not match `ss`, `ﬁ` does not match `fi`, and `"istanbul"` does not find `İstanbul`.

MongoDB uses the case-insensitive option of its regular expressions. PostgreSQL folds both sides of `ILIKE`, `ISTARTS_WITH`, `IENDS_WITH` and `IEQ` with one expression, `translate(lower((x) COLLATE "pg_catalog"."und-x-icu"), from, to)`, which [`caseFoldExpression`](#indexes-for-text-filters) writes with its two lists of characters. `lower()` under the ICU root collation `und-x-icu` applies the case mappings of every script, whatever the database's locale, and `translate()` then maps the 22 lowercase variants that `lower()` keeps to the letters that simple case folding gives them:

| Characters | Fold to |
| --- | --- |
| `µ` (U+00B5, micro sign), `ſ` (U+017F, long s), `ς` (U+03C2, final sigma) | `μ`, `s`, `σ` |
| U+0345 (combining ypogegrammeni) and U+1FBE (prosgegrammeni) | `ι` |
| The Greek symbols `ϐ`, `ϑ`, `ϕ`, `ϖ`, `ϰ`, `ϱ` and `ϵ` (U+03D0, U+03D1, U+03D5, U+03D6, U+03F0, U+03F1, U+03F5) | `β`, `θ`, `φ`, `π`, `κ`, `ρ`, `ε` |
| The Cyrillic variants U+1C80 to U+1C88 | `в`, `д`, `о`, `с`, `т`, `т`, `ъ`, `ѣ`, `ꙋ` |
| `ẛ` (U+1E9B, long s with dot above) | `ṡ` |

Mapping `ς` to `σ` also matters for a capital `Σ` at an end of a search value. `lower()` turns a `Σ` that ends a word into `ς` and any other into `σ`, and PostgreSQL folds the value apart from the stored text, so `ΚΑΣ`, the value of `ISTARTS_WITH "ΚΑΣ"`, lowers to `κας` while `ΚΑΣΤΡΟ` lowers to `καστρο`; both fold to `σ`, so the search finds `ΚΑΣΤΡΟ`, as `STARTS_WITH "ΚΑΣ"` and MongoDB do.

Two known differences remain, and the integration tests pin them:

| Characters | MongoDB | PostgreSQL |
| --- | --- | --- |
| `İ` (U+0130, capital I with dot above) | Matches only itself | `lower()` turns it into `i` followed by U+0307, so `ISTARTS_WITH "i"` finds `İstanbul`, and `IEQ "İSTANBUL"` also finds `i̇stanbul` |
| Letters newer than the server's Unicode tables, such as U+A7DC, whose lowercase is U+019B (Unicode 16) | Do not match on MongoDB 8.0 | Match when the server's ICU version knows them |

Folding follows the Unicode version of the server's ICU library on PostgreSQL and of its regular-expression library on MongoDB. On PostgreSQL, the case-insensitive operators need a database whose encoding is `UTF8`, the only server encoding that has every character of the fold, on a server built with ICU, which provides `und-x-icu`. On another database, such as one in `LATIN1` or `SQL_ASCII`, or on a server without ICU, they fail with `UNSUPPORTED_QUERY` (400), `ILIKE, ISTARTS_WITH, IENDS_WITH and IEQ need a UTF8 database with the ICU collation und-x-icu`, with the driver error as the cause, while initialization and every other operation keep working. The fold is part of each statement, not a database object, so initialization creates and checks nothing for it, and there is nothing to migrate.

### Indexes for text filters

On PostgreSQL, text columns use the `C` collation, and the operators compile to these conditions, where `$1` is a bound parameter and `fold(x)` stands for the expression that `caseFoldExpression(x)` returns:

| Operator | Condition | Index that serves it |
| --- | --- | --- |
| `STARTS_WITH` | `starts_with("column" COLLATE "C", $1)` | Any btree index on the column |
| `IEQ` | `fold("column") = fold($1)` | A btree index on `fold("column")` |
| `ISTARTS_WITH` | `fold("column") LIKE fold($1)`, with `$1` = `value%` | A btree index on `fold("column")` with `text_pattern_ops`, or a trigram index |
| `ILIKE`, `IENDS_WITH` | The same, with `$1` = `%value%` or `%value` | A trigram index |
| `LIKE`, `ENDS_WITH` | `strpos("column" COLLATE "C", $1) > 0`, `right("column" COLLATE "C", char_length($1)) = $1` | None |

In the `LIKE` patterns, `\`, `%` and `_` of the value are escaped. Simfinity creates no index for the text operators: create the ones your searches need in your own migration, on exactly the compiled expression. `caseFoldExpression(sqlExpression)`, exported by `@simtlix/simfinity-postgres`, returns it for a column or any other SQL expression. It inserts the expression as given, in parentheses, so that `COLLATE`, which binds more tightly than `->>` and the other binary operators, applies to all of it, as in the compiled statement; pass trusted SQL with quoted identifiers, never request input:

```js
import { caseFoldExpression } from '@simtlix/simfinity-postgres';

await pool.query(`CREATE INDEX series_name_ci ON "app"."Serie" (${caseFoldExpression('"name"')} text_pattern_ops)`);
await pool.query(`CREATE INDEX series_label_ci ON "app"."Serie" (${caseFoldExpression('"details" ->> \'label\'')})`);
```

These are the statements it gives for a column and for a member of an embedded value stored as jsonb. An index on `lower("column" COLLATE "und-x-icu")` alone, or on `lower("column")`, does not serve the operators. Initialization keeps such indexes in both modes:

```sql
-- IEQ and ISTARTS_WITH
CREATE INDEX series_name_ci ON "app"."Serie" (translate(lower(("name") COLLATE "pg_catalog"."und-x-icu"), 'µſͅςϐϑϕϖϰϱϵᲀᲁᲂᲃᲄᲅᲆᲇᲈẛι', 'μsισβθφπκρεвдосттъѣꙋṡι') text_pattern_ops);
-- ILIKE, ISTARTS_WITH and IENDS_WITH
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX series_name_trgm ON "app"."Serie" USING gin (translate(lower(("name") COLLATE "pg_catalog"."und-x-icu"), 'µſͅςϐϑϕϖϰϱϵᲀᲁᲂᲃᲄᲅᲆᲇᲈẛι', 'μsισβθφπκρεвдосттъѣꙋṡι') gin_trgm_ops);
-- IEQ on a member of an embedded value stored as jsonb
CREATE INDEX series_label_ci ON "app"."Serie" (translate(lower(("details" ->> 'label') COLLATE "pg_catalog"."und-x-icu"), 'µſͅςϐϑϕϖϰϱϵᲀᲁᲂᲃᲄᲅᲆᲇᲈẛι', 'μsισβθφπκρεвдосттъѣꙋṡι'));
```

A btree index on `fold("column")` with the default operator class serves `IEQ` but not `ISTARTS_WITH`. A trigram index narrows an `ILIKE` search only for values of three or more characters. For the `LIKE` patterns, PostgreSQL derives the index condition from the bound value when it plans the statement, which it does for the unnamed statements that Simfinity sends. Conditions on a `String` list read every element of the list, so these indexes do not serve them. If a later release changes the fold, its upgrade notes say so: an index on the earlier expression then stops serving the operators, without ever returning other rows, until you build it again with `caseFoldExpression`.

On MongoDB, `STARTS_WITH` reads a prefix range of an index on the field. The other text operators, like `LIKE`, test every key of such an index, or every document without one. `$regex` ignores collations, so a case-insensitive collation index does not serve them; for frequent case-insensitive equality or prefix searches, store a normalized copy of the field, such as its lowercase form, and filter it with `EQ` or `STARTS_WITH`. MongoDB accepts regular expressions of at most 32,764 bytes of UTF-8, so on MongoDB a value whose pattern is longer fails with `INVALID_FILTER_VALUE` (400) before the query runs, with `LIKE` and with the text operators. Every escaped character counts one byte more, and the operators add up to four bytes of their own: `^` for the prefixes, `\z` for the suffixes, both for `IEQ` and `.*` twice for `LIKE`. So an `ILIKE` value of 32,764 ASCII letters runs, while 16,383 dots or 16,383 two-byte letters such as `é` fail. PostgreSQL has no such limit.

## Empty values

`IS_EMPTY` matches the records in which a field holds no value, and `IS_NOT_EMPTY` the records in which it holds one, so every record matches exactly one of the two. They take no value: omit `value`, or pass `null`. They test the queried record's own fields, scalars, enums, lists, embedded objects and embedded lists, and, on an adapter that supports [references and collections](#references-and-collections), as both bundled adapters do, its references and collections and the fields it reaches through single references, wherever filters apply: field filters, relation `terms`, `AND`/`OR` conditions, `pagination.count`, aggregate filters, collection fields, batched or not, `find`, `get_by_id` and `aggregate` [scopes](./query-scope), middleware and [MCP tools](./mcp).

```graphql
query {
  series(
    category: { operator: IS_EMPTY }
    director: { terms: [{ operator: IS_NOT_EMPTY }] }
  ) {
    id
    name
  }
}
```

This returns the series that have a director and no category. What counts as empty depends on the field, and is the same on both backends:

| Field | `IS_EMPTY` holds when the value is |
| --- | --- |
| `String`, and a scalar whose base scalar is `String`, such as a validated email | Missing, `null` or `""`; `" "` is not empty |
| Any other scalar or enum: numbers, Booleans, `ID`, dates, a state machine's `state`, an application scalar such as `JSON`, and the ID of an inferred inverse reference | Missing or `null` |
| The record identity, the queried type's own `id`, whatever its declared scalar | Missing or `null`, which a stored record never is: `IS_EMPTY` matches no record and `IS_NOT_EMPTY` every record |
| A scalar list | Missing, `null` or `[]`; `[null]` and `[""]` are not empty |
| An embedded list | Missing, `null` or `[]`; `[null]` and `[{}]` are not empty |
| An embedded object | Missing or `null`, or an object whose stored members are all empty by their own rules |
| A leaf inside embedded objects, such as `director.country` | Empty by the leaf's rule; a missing or `null` object on the way makes the leaf empty |
| A single reference, such as `serie` on a season | No record exists that the reference points to and that the target type's `find` [scope](./query-scope) admits for the caller: no stored reference, a record that the scope hides, or, on MongoDB, a reference to a record that no longer exists |
| A collection, such as `seasons` on a serie | No child that the child type's `find` scope admits for the caller references the record |
| A field, reference or collection reached through single references, such as `serie.name`, `serie.director` or `serie.seasons` on a season | Empty by its own rule, and also when a reference on the way points to no record that the caller may see |
| The `id` right after a reference, such as `serie.id` on a season, the identity of the record it points to | Empty exactly when the reference is, whatever the target's declared scalar |

An embedded object's members are the fields its type stores; [virtual fields](#virtual-fields) store nothing and are left out. A nested embedded object follows the object rule, a list member the list rule, which never looks at the items, so `{ tags: [null] }` is not empty, and a reference or collection member the reference or collection rule, with its target type's `find` scope. An `id` member follows the rule of its declared scalar, unlike the record identity, so a `String` `id` member is empty when it is `""`. An embedded type that stores no member is always empty: `IS_EMPTY` matches every record and `IS_NOT_EMPTY` none. On MongoDB, an embedded object whose `id` member resolves to an automatic subdocument `_id`, as in the supplied subdocument schemas that [IDs in paths](#ids-in-paths) describes, always holds that `_id`, so it is never empty; generated models give embedded objects no `_id`.

An application scalar such as `JSON` is empty only when it is missing or `null`. On MongoDB it can hold an array, and an array is a value even when it holds `null`, so `[null]` and `[1, null]` are not empty.

### Conditions without a path

`IS_EMPTY` and `IS_NOT_EMPTY` are the only operators that test an embedded object, an embedded list, a reference or a collection itself, so their relation terms and group conditions may leave out `path`: a `path` that is omitted, `null` or `""` names the field itself. Such a term can sit next to terms that have paths. These series have a director whose country is empty:

```graphql
query {
  series(director: { terms: [{ operator: IS_NOT_EMPTY }, { path: "country", operator: IS_EMPTY }] }) {
    id
    name
  }
}
```

In a group, name the field alone. These series have no director, or one from Argentina:

```graphql
query {
  series(
    OR: [
      { conditions: [{ field: "director", operator: IS_EMPTY }] }
      { conditions: [{ field: "director.country", operator: EQ, value: "Argentina" }] }
    ]
  ) {
    id
    name
  }
}
```

A scalar list takes a field filter, as a scalar does: `tags: { operator: IS_EMPTY }`. A group condition may also use the dotted form, `{ field: "director.country", operator: IS_EMPTY }`, but not together with a `path`, which fails with `AMBIGUOUS_FILTER_FIELD` (400). Other operators still need a path into an object field, and keep their codes when it is missing.

### References and collections

An adapter that declares `queryFeatures.referenceEmptiness`, as `createMongoAdapter()` and `postgresPlugin()` do, also answers emptiness through references and collections: a path may cross single references and end at a scalar, a list, an embedded object, a reference or a collection, and an embedded object's reference and collection members follow their own rules. With another adapter or SQL plugin, these conditions fail with `UNSUPPORTED_QUERY` (400); see [custom adapters and SQL plugins](../resources/compatibility#reference-emptiness-in-custom-adapters-and-sql-plugins). These seasons have no serie that the caller may see:

```graphql
query {
  seasons(serie: { terms: [{ operator: IS_EMPTY }] }) {
    id
    number
  }
}
```

`series(seasons: { terms: [{ operator: IS_EMPTY }] })` returns the series without a season that the caller may see. In a group, name the field alone. These seasons belong to one serie or to none:

```graphql
query SeasonsOfSerie($serie: QLValue) {
  seasons(
    OR: [
      { conditions: [{ field: "serie", path: "id", operator: EQ, value: $serie }] }
      { conditions: [{ field: "serie", operator: IS_EMPTY }] }
    ]
  ) {
    id
    number
  }
}
```

A client's condition reads each reference and collection through the target type's `find` [scope](./query-scope#emptiness-through-references-and-collections), so a record that the scope hides reads exactly like a missing one. A season whose serie the caller may not see matches `serie IS_EMPTY`, and `serie.name IS_EMPTY` as well, and matches neither `IS_NOT_EMPTY` form. No emptiness condition can tell a hidden record from a missing one, whatever the scope's conditions are, including conditions such as `NE` that accept `null`. The target's `find` scope decides, never its `get_by_id` scope.

Each reference on the path is read on its own. A reference that the path crosses joins its target only when the target's scope admits it, which the guides call a scoped join. A reference or collection that the condition ends at, or that an embedded object holds as a member, counts only the records that the scope admits, which the guides call a frame. The scope decides which records exist before the condition tests them and is never negated, so `seasons IS_NOT_EMPTY` holds when at least one season that the caller may see exists. On a path through several references, each one is read through the one before it, so a hidden record anywhere on the path makes the rest of the path empty, also when the types after it have no scope.

The `id` right after a reference, as in `serie.id`, is the identity of the record the reference points to. It follows the `null` rule whatever scalar the target declares, as the queried record's own identity does, so `serie.id IS_EMPTY` holds exactly when `serie IS_EMPTY` holds. An `id` member inside an embedded object keeps its declared scalar's rule.

For each list, aggregate or collection-field call, each target type's `find` scope runs once, after middleware and the query's own scope, with empty arguments, `operation: 'find'` and the request context, in a cache separate from [joined scopes](./query-scope#relationship-paths-in-filters-sorts-and-aggregations), which cache by prefix. A type reached both ways runs twice. The sort and pagination it sets are checked for shape and then ignored, and its conditions are checked on its own type, with the codes that its own list query would give. A scope that adds nothing for the caller, such as one that returns early for administrators, hides no record.

One resolver call allows at most 10 compiled client frames and scoped joins (`maxReferenceFrames`), whether their targets have scopes or not. A shorthand frame counts once per group and absolute collection prefix; explicit frames count separately. Within each containing frame, scoped joins count once per path and scope chain; emptiness frames count once per path and shape. Nested collection and reference frames also have a chain limit, `maxFrameNesting`, default 3, for client and trusted constructs. More give `FILTER_DEPTH_EXCEEDED` (400). Configure these process-wide limits with [`configureQueryLimits`](../reference/api#configurequerylimits). Client units are counted after all client 400 checks and before middleware; trusted constructs do not count toward that per-call total. A [named view](#named-views) has a separate budget of the same size for its `where` groups, checked after middleware.

Conditions that middleware, the query's own scope, joined scopes and other scope functions add are trusted, as their paths are, and read stored data whoever the caller is. A reference is empty when no stored reference resolves to an existing record, a collection when no stored child references the record, and a field through references is read through plain joins, without any target scope. On MongoDB, a reference to a record that no longer exists counts as empty; PostgreSQL's foreign keys keep a reference from pointing to a missing record. A `Season` scope that adds `{ field: 'serie', operator: 'IS_EMPTY' }` therefore selects the seasons that store no existing serie, for every caller. See [client and trusted conditions](./query-scope#client-and-trusted-conditions).

With the [authorization plugin](./authorization#filter-sort-and-aggregation-paths), `serie IS_EMPTY` needs only the `Season.serie` read rule, since it reads whether a serie exists and none of its fields; `serie.name IS_EMPTY` also needs the `Serie.name` rule, and `serie.id IS_EMPTY` the `Serie.id` rule.

Other legacy client paths through a single reference outside a collection frame keep their [joined scopes](./query-scope#relationship-paths-in-filters-sorts-and-aggregations): conditions with every other operator, such as `serie.name EQ "Dark"`, the [text operators](#text-operators) included, and sorts, `groupId` and fact paths. Such a joined scope still restricts the emptiness conditions of the same group, or of the whole query; see [legacy joined scopes beside emptiness conditions](./query-scope#legacy-joined-scopes-beside-emptiness-conditions). The earlier form `serie: { terms: [{ path: "id", operator: EQ, value: null }] }` keeps its results, so under a `Serie` scope whose conditions reject `null` it still returns none of the seasons without a serie to a caller whom that scope restricts; write `IS_EMPTY` instead.

Emptiness of a value inside an embedded list is not defined. Shorthand emptiness through a collection, such as `seasons.year IS_EMPTY`, also fails with `INVALID_FILTER_PATH` (400): the shorthand excludes it; use an explicit group such as `ANY: [{ path: "seasons", conditions: [{ field: "year", operator: IS_EMPTY }] }]` on a quantifier-capable adapter. An embedded list is tested as a list, so `lines: { terms: [{ operator: IS_EMPTY }] }` does not read the references that its items hold.

### What generated mutations store

Generated mutations seldom store `null` for an embedded object, which is why the object rule reads every stored member instead of testing for `null` alone:

- A create that omits an embedded object, or sends `null`, `{}` or only `null` members, stores nothing when the embedded type has no list member. When it has one, such as `tags`, the omitted list defaults to `[]`, so the object is stored as `{ tags: [] }` and reads back with `null` members. Both are empty, and so is a stored `{ label: "" }`, while `{ label: " " }` is not.
- An update that sets the embedded object to `null` removes it, and one that sets each of its members to `null` stores an object with `null` members, such as `{ a: null, b: null }`. Both are empty.
- On PostgreSQL, an embedded object that is stored in a table of its own, because it has a `unique` member, gets a row on create even when every member is empty. That row is empty by the same rule.

`EQ null` is a different test: it does not apply to an embedded object, it treats `""` as a value, and on a list it matches `[null]` and never `[]`; see [filters on lists](#filters-on-lists).

### Rejected emptiness conditions

| Condition | Code |
| --- | --- |
| A value other than `null`, such as `""`, `[]`, `{}`, `false` or `0` | `INVALID_FILTER_VALUE` (400) |
| A path inside an embedded list, such as `lines.qty`, or shorthand emptiness through a collection, such as `seasons.year`: use an explicit collection group for the latter | `INVALID_FILTER_PATH` (400) |
| An interface or union field, on the path or among the members of an embedded object, which only MongoDB's default mode allows | `INVALID_FILTER_PATH` (400) |
| An embedded object whose type reaches itself again through single embedded members, which custom adapters and supplied MongoDB models allow when a field of the cycle is `readOnly`; a type that reaches itself only through a list member is accepted | `INVALID_FILTER_OPERATOR` (400) |
| `IS_EMPTY` or `IS_NOT_EMPTY` written on the filter of an embedded, reference or collection field itself, as in `director: { operator: IS_EMPTY }`, with or without `terms`; only server code, such as middleware and scopes, can write this form, since the GraphQL input has no `operator` there | `MISSING_FILTER_PATH` (400); write a term without a path instead |
| An unknown field, a path through a scalar, a dotted field with a `path`, or a group nested more than five levels deep | `INVALID_FILTER_FIELD`, `INVALID_FILTER_PATH`, `AMBIGUOUS_FILTER_FIELD` or `FILTER_DEPTH_EXCEEDED` (400), as with other operators |
| A custom adapter or SQL plugin that does not declare the operators in `queryFeatures` | `UNSUPPORTED_QUERY` (400); see [emptiness in custom adapters and SQL plugins](../resources/compatibility#emptiness-in-custom-adapters-and-sql-plugins) |
| A path that crosses or ends at a reference, such as `serie.name` or `serie` on a season, a path that ends at a collection, such as `seasons` on a serie, or an embedded object with a reference or collection member, on a custom adapter or SQL plugin that does not declare `referenceEmptiness` in `queryFeatures` | `UNSUPPORTED_QUERY` (400), with a message that says that the database adapter does not support emptiness through references and collections; see [reference emptiness in custom adapters and SQL plugins](../resources/compatibility#reference-emptiness-in-custom-adapters-and-sql-plugins) |
| Client conditions of one call that read more than 10 distinct scoped joins and frames, or the number that `configureQueryLimits({ maxReferenceFrames })` sets | `FILTER_DEPTH_EXCEEDED` (400); see [references and collections](#references-and-collections) |
| A marked client construct that middleware or a scope dropped, rebuilt, parked only in ignored terms, wrapped in an unmarked explicit frame, or aliased into incompatible target positions | `DETACHED_CLIENT_FILTER` (500); see [keep the client's filter objects](./middleware#keep-client-filter-objects) |

The runtime validates client paths, forms, operators and values before middleware and before the per-query frame count. It validates the final arguments again after middleware and the query's own scope, checking detachments before that gate and filling target scopes after it. Raw joined scopes are validated on their target type before prefixing, so an intrinsically invalid scope keeps its own error before prefix restrictions. For already-invalid inputs this can change error precedence or reject before the adapter: `BTW` with an omitted-variable list element still reports `Filter lists require non-null scalar elements`, now before middleware. On MongoDB, `INVALID_FILTER_VALUE` (400) now uses `Filter lists require non-null scalar elements` for null elements in `IN`/`NIN`/`BTW` (formerly `<OP> does not accept null elements`), `Expected a scalar filter value` for null ordered/`LIKE` values (formerly `<OP> does not accept null` or `LIKE requires a string field and string value`), and `BTW requires two values` for a wrong-sized list (formerly `BTW requires exactly two values`). Existing sort-shape diagnostics are preserved. Ignored scalar/scalar-list `terms` remain inspection-only; the actual scalar filter, including default `EQ`, must be valid. On quantifier-capable adapters, `seasons.year EQ 2025` reads the `Season` frame scope, while `seasons.year IS_EMPTY` remains excluded shorthand. [`createQueryPlan()`](../guide/sql-plugins#query-features) and MongoDB's `buildQuery()` and `buildFilterGroupMatch()` apply the same structural rules to direct calls; a direct path through a virtual field gives `INVALID_FILTER_FIELD`.

Within a group the structural gate checks shape/known keys, Boolean depth, quantified paths and required term paths, shorthand terms, path resolution, operators, permanent path restrictions, values, capability gates, then frame nesting; filled-marker checks are last in direct planner/compiler calls. Client authorization and stored-path restrictions run before these checks. Sorts validate whole shape, path syntax, collection crossing and the final field's type in that order. A request invalid in several independent conditions reports one of their errors. See the [error reference](../reference/errors#core-error-codes).

### Compiled forms and indexes

| Field | MongoDB `IS_EMPTY` | PostgreSQL `IS_EMPTY` |
| --- | --- | --- |
| `String` | `{ f: { $in: [null, ""] } }` | `("f" IS NULL OR "f" = '')` |
| Other scalars and enums, and the record identity | `{ f: null }`, `{ _id: null }` | `"f" IS NULL`, `"id" IS NULL` |
| Scalar list, embedded list | `{ "f.0": { $exists: false } }` | `COALESCE(cardinality("f"), 0) = 0` on an array column; a guarded `jsonb_array_length` on jsonb; in a table of its own, state not `present` or no row |
| Embedded object | `{ $or: [{ f: null }, { $and: [<member forms>] }] }` | `(J IS NULL OR J = 'null'::jsonb OR (<member forms>))` on jsonb; in a table of its own, state not `present` or no row with a non-empty member |
| A client's reference | `{ $lookup: { from, localField: "r", foreignField: "_id", pipeline: [<scope>, { $limit: 1 }, { $project: { _id: 1 } }], as: "__sf_qN" } }`, then `{ "__sf_qN.0": { $exists: false } }` | `NOT EXISTS (SELECT 1 FROM "Target" tK WHERE tK."id" = t0."r" AND (<scope>))`; `t0."r" IS NULL` when the scope adds nothing |
| A client's collection | the same `$lookup` on the child collection, from the record's `_id` to the child's connection field, then `{ $or: [{ <localField>: null }, { "__sf_qN.0": { $exists: false } }] }`, where `<localField>` is `_id`, or `__sf_jK._id` or `__sf_lK._id` behind a reference; `$lookup` matches a missing key with every child whose connection field is `null`, so the guard keeps a collection behind a missing or hidden reference empty | `NOT EXISTS (SELECT 1 FROM "Child" tK WHERE tK."c" = t0."id" AND (<scope>))` |
| A client's field through a reference | the field's form on `__sf_jN`, after `{ $lookup: { from, localField: "r", foreignField: "_id", pipeline: [<scope>, { $limit: 1 }], as: "__sf_jN" } }` and an `$unwind` that keeps the record; the trusted form while the scopes on the path add nothing | the field's form on `tJ`, after `LEFT JOIN LATERAL (SELECT tK.* FROM "Target" tK WHERE tK."id" = t0."r" AND (<scope>) LIMIT 1) tJ ON TRUE`; the trusted form while the scopes on the path add nothing |
| A trusted reference, collection or field through a reference | the client's frame without a scope for a reference or a collection; for a field, the plain lookup that other conditions on the path share | `t0."r" IS NULL` for a reference; `NOT EXISTS` without a scope for a collection; for a field, the plain `LEFT JOIN` that other conditions on the path share |

`IS_NOT_EMPTY` compiles to the complement: `$nin`, `$ne: null`, `$exists: true` and a `$nor` of the object form on MongoDB; on PostgreSQL, the positive forms of the leaf and list tests, such as `("f" IS NOT NULL AND "f" <> '')` and `COALESCE(cardinality("f"), 0) > 0`, and `NOT (…)` of the forms of embedded objects and of tables of their own. A reference or collection frame gives the `$nor` of its match on MongoDB and `EXISTS` on PostgreSQL. The forms of the record's own fields bind no parameters and read jsonb members with `->>`, without casts. An index on the field serves the `String` and `null` forms on both backends, on MongoDB with index bounds for `null` and `""` and on PostgreSQL with a btree index on the column, through a BitmapOr for the `String` form. No index serves the list forms.

`<scope>` is the target type's `find` scope, compiled on the target from the arguments it set, with its values bound as parameters on PostgreSQL. A scope that adds nothing for the caller, such as one that returns early for administrators, restricts nothing: a frame on MongoDB and a collection frame on PostgreSQL leave `<scope>` out, and on PostgreSQL a reference that the condition ends at or reads as a member compiles to `"r" IS NULL`, as a trusted one does. A reference that the path crosses shares the plain lookup or `LEFT JOIN` of other conditions while the scopes of every reference crossed so far add nothing, so a client's condition whose scopes all add nothing compiles exactly to the trusted forms. From the first crossed reference whose scope adds conditions on, every crossing is a scoped join, `__sf_jN` on MongoDB and `LEFT JOIN LATERAL` on PostgreSQL, even when its own target has no scope, so it never shares a plain join, and each reference after it is correlated to the scoped join before it: a second hop reads `localField: "__sf_j0.r"` on MongoDB and `tJ."r"` on PostgreSQL, also in `tJ."r" IS NULL`, which holds when the scoped join hides the record before it. On MongoDB, the aliases of scoped joins and frames are counted apart from the `__sf_lN` aliases of other conditions, so those keep their pipelines, and every alias is removed before the results are returned; the lookups sit with the others before the `$match`, so they also apply to counts, aggregates and batched collection reads. On PostgreSQL, a reference member of an embedded value stored in a table of its own compiles inside that table's subquery. The primary key serves reference frames and scoped joins, as `_id_` on MongoDB, an index on the child's connection field serves collection frames, such as the one that generated MongoDB models and PostgreSQL storage create for each reference, and on PostgreSQL that index on the reference column also serves the `"r" IS NULL` form. The other conditions keep their pipelines and statements.

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

All `terms` are ANDed, including multiple conditions on the same path. In one group, terms crossing the same collection prefix must match the same child; different groups may match different children. For example, `[{ path: "year", operator: GTE, value: 2020 }, { path: "year", operator: LTE, value: 2025 }]` preserves both bounds. These conditions remain ANDed with logical groups and scope filters. Paths must terminate at a declared scalar or enum field, except with `IS_EMPTY` and `IS_NOT_EMPTY`, whose path may also end at an embedded list or an embedded object, and, on an adapter that supports it, at a reference or a collection, or be left out to test the field itself; see [empty values](#empty-values). MongoDB ID comparisons use the actual Mongoose schema path, including supplied models with string or numeric `_id` fields; PostgreSQL entity and reference IDs are UUIDs.

### Collection frames

On both bundled adapters, every collection filter path becomes a correlated frame: it tests children linked to the current record and never multiplies list rows, counts or pages. These forms are equivalent: a condition `{ field: "seasons.year", operator: EQ, value: 2025 }`, a relation filter `seasons: { terms: [{ path: "year", operator: EQ, value: 2025 }] }`, and an explicit `ANY` group:

```graphql
query {
  series(AND: [{ ANY: [{ path: "seasons", conditions: [{ field: "year", operator: EQ, value: 2025 }] }] }]) {
    id
    name
  }
}
```

`QLQuantifier` has `ANY`, `ALL` and `NONE`. `QLFilterGroup` adds lists with those names, whose `QLQuantifiedGroup` members have required `path` and optional `conditions`, `AND`, `OR`, `ANY`, `ALL` and `NONE`. `QLTypeFilterExpression` adds optional `quantifier`; no top-level query argument is added. A relation term can also cross a collection from its target: `shop: { terms: [{ path: "products.name", operator: EQ, value: "a" }] }` creates a `shop.products` frame. All forms nest when another collection is crossed. Every runtime exposes these inputs; adapters gate their use at request time.

`ANY` needs some matching element, `ALL` needs every element to match, and `NONE` needs no matching element. With no visible elements they return false, true and true respectively. With no conditions, `ANY` tests existence, `NONE` tests absence and `ALL` is always true. The field-filter form `seasons: { quantifier: ALL, terms: [{ path: "year", operator: GTE, value: 2020 }] }` expands into an explicit group; terms may be omitted or empty, but every supplied term needs a non-empty `path`, including emptiness terms. Plain shorthand still needs non-empty terms.

Each explicit `path` is relative to its containing frame, may cross single references and single embedded objects, and must end at a collection or single reference without crossing a list. Nest groups to traverse two collections, or use a dotted shorthand such as `seasons.episodes.duration`. Paths ending at an embedded list give `UNSUPPORTED_QUERY` until embedded element frames are supported; scalar, scalar-list, single embedded object, interface and union ends give `INVALID_FILTER_PATH`. `IS_EMPTY`, `IS_NOT_EMPTY` and `CONTAINS_ALL` remain excluded on a leaf through shorthand collections; move the condition into an explicit group, retaining the operator's own validity rules.

One group shares one frame for each collection prefix. A single `terms` set or `conditions` list with `seasons.year EQ 2025` and `seasons.number EQ 1` requires one season with both properties. Put the conditions in separate `AND` groups to allow different seasons. Each `OR` branch has its own frames; a longer prefix nests inside its shorter prefix in the same group. Appending a server restriction as a separate group preserves both filters but allows different witnesses; merge conditions into one group when they must hold for the same child.

A client frame ranges only over elements admitted by the target's `find` scope. Single references crossed inside it use scoped joins, so a hidden reference reads as missing. Scopes run after middleware and the query's own scope; a scope is outside `ALL`/`NONE` negation. Trusted conditions from middleware, scopes or direct compiler calls range over stored children and existing references, without target scopes. A mixed client/trusted group on one prefix shares one visible witness. Scalar leaves are two-valued: `EQ null` accepts null/missing; `NE` with a non-null comparison value and `NIN` with a valid list accept null/missing; `NE null` requires a non-null leaf; ordered/text operators reject null/missing leaves. A missing child is no element, so `NE`, `NIN` and `EQ null` shorthand cannot match a parent without visible children; use collection `IS_EMPTY` or `NONE` for absence.

Frames use MongoDB `$lookup` existence probes and PostgreSQL `EXISTS`/`NOT EXISTS` subqueries with the child's connection index; references use their identity index. `ALL` searches for a violating element, and `NONE` for a matching one, without negating the frame scope. A broad or unindexed child predicate can still cost a probe per parent; compare database plans on representative data. On both backends, an `OR` with a collection branch evaluates the frame per parent: MongoDB cannot split the branch before its `$lookup`, and PostgreSQL can pull `EXISTS` up to a semi-join only under a top-level `AND`. Put selective record-level conditions in the top-level `AND` to reduce that work. Custom adapters must declare `quantifiers: true` and `referenceEmptiness: true`; otherwise explicit quantified inputs give `UNSUPPORTED_QUERY` and collection filters retain their earlier joins.

### IDs in paths

In filters, sorts and aggregation paths, `id` names the record identity at the root and after a relationship (`_id` on MongoDB). Inside an embedded object, such as `address.id` or `lines.id`, `id` is the embedded object's declared `id` member on both backends, the value that reads return. These MongoDB cases use the subdocument `_id` instead:

- An entity type, registered with `connect()` or targeted by a reference, that is embedded as a list item. Its reads return the automatic `_id` that Mongoose gives each item, and filters match that value. The declared `id` stays stored but is neither returned nor matched; see [supporting types without endpoints](./schema#supporting-types-without-endpoints).
- A supplied subdocument schema that declares no `id` path. Filters, sorts and groups use the subdocument `_id`. Mutation responses, and by-ID and reference reads of a type without a `get_by_id` scope, return it through Mongoose's `id` virtual, but list queries, collection fields and scoped by-ID reads return `null` for `id`, because aggregation results carry no virtuals. Declare an `id` path in the subdocument schema if clients filter by IDs they read from lists.
- An entity type stored in a supplied single-nested subdocument schema that has an automatic `_id`, such as `tag: new Schema({ id: ObjectId, name: String })`. Reads return the subdocument `_id` and filters match it, as for embedded lists.

### Path restrictions

Filter, sort, `groupId` and fact paths supplied by the client are collected before middleware and scopes run, so the paths those add are trusted:

- No path segment may name a field with `extensions.queryable: false`, or a field with an application-defined `resolve`. This includes masking resolvers, relationship fields with a manual resolver, and a custom `id` resolver; only the resolvers Simfinity generates keep a field queryable. Set `extensions.queryable: true` to let clients query a stored field that has its own resolver. Such paths fail with `FORBIDDEN_FILTER_PATH` (403); unknown fields still fail with `INVALID_FILTER_FIELD` (400).
- On a quantifier-capable adapter, collection filters apply the target's `find` scope inside the frame, and references crossed inside frames use scoped joins. A path into a type whose scope filters through collections is allowed when its prefix crosses no embedded list. `groupId` and fact paths into a scoped collection still fail with `FORBIDDEN_FILTER_PATH`, as do scopes reaching a reference inside an embedded list, and joined scopes through an embedded-list prefix that use collections or quantified groups. A client path crossing a reference inside an embedded list before or inside a collection frame also gives 403 when that reference's scope adds conditions. Adapters without `quantifiers` retain their earlier scoped-collection restrictions. Legacy paths through single references outside frames keep group/query-level joined scopes; see [query scope](./query-scope#relationship-paths-in-filters-sorts-and-aggregations).
- No path segment may name a [virtual field](#virtual-fields), which holds no stored value. Such paths fail with `FORBIDDEN_FILTER_PATH` (403) too, whatever `queryable` says.
- An `IS_EMPTY` or `IS_NOT_EMPTY` condition on a whole embedded object, with or without a path, reads every member that the object stores, at any depth through single embedded objects, so each member path counts as a client path too. A member with `extensions.queryable: false` or an application-defined `resolve` fails with `FORBIDDEN_FILTER_PATH` (403), naming the member path, such as `director.salary`, and the authorization plugin checks each member's read rule. Virtual members are not read and not checked. These 403s come before the 400s of [rejected emptiness conditions](#rejected-emptiness-conditions), also for a reference or collection member, which is checked without being entered. Neither members nor named emptiness paths get the `find`-scope checks of the second bullet. An emptiness condition reads each reference and collection it reaches through a scoped join or a frame on the target's own `find` scope, as [references and collections](#references-and-collections) describes, which never repeats a record, so the scope cannot be misapplied: a restricted caller's `seasons: { terms: [{ operator: IS_EMPTY }] }` counts only the seasons that the `Season` scope admits instead of failing with 403, and `serie IS_EMPTY` gets no 403 when the `Serie` scope filters through a collection. On an adapter that does not declare `referenceEmptiness`, an emptiness condition that enters a reference or a collection fails with a 400 before any scope runs.
- With the [authorization plugin](./authorization#filter-sort-and-aggregation-paths), every field a path names also needs a read rule.

Paths that middleware or scope functions add are trusted and are not checked, with one exception: a path through a virtual field fails with `INVALID_MODEL` (500) before the database is queried, because it cannot compile against storage that does not exist. Their `IS_EMPTY` and `IS_NOT_EMPTY` conditions read stored data through references and collections, without target scopes; see [references and collections](#references-and-collections).

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

List sort paths are checked against the declared fields. `id` and related `.id` paths resolve to the backend identity column; embedded paths stay dotted, and an embedded `.id` follows the [embedded `id` rule](#ids-in-paths). Multiple terms through the same single-reference relationship reuse its join. A list sort that crosses a collection fails with `INVALID_FILTER_PATH` (400), including count mode, on every adapter before any scope or middleware runs; no minimum/maximum child is selected implicitly.

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

For aggregates, let J be all collection prefixes crossed by `groupId` or any fact path, at every level. Those prefixes keep row-expanding joins: a parent without children contributes one null row, and an own-field fact counts once per joined child row. Top-frame filters wholly on J restrict the same joined rows across groups. A filter-only collection prefix becomes a frame and does not multiply facts. Beyond the last J prefix, intervening single references and embedded objects form an anchor; a following collection frame tests the joined anchor record. Explicit groups and quantified field filters always remain frames, even on J, and their element-relative nested paths never enter J. See [aggregation](../reference/aggregation#related-paths).

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

## Custom queries

Generated queries, [query scopes](./query-scope), [aggregates](#aggregate-records) and [virtual fields](#virtual-fields) read stored records, and they stay the first choice for those reads. Some reads return a result that is not a stored record:

- a computation without storage, such as a price preview, an estimate or the free slots that a set of rules allows;
- data from another source, such as a search index, another service or a catalog defined in code;
- a permission evaluation, such as what the caller may do on a resource;
- a result assembled from several sources, such as a federated search, a dashboard or an export.

Register such a read as a **custom query**: a field of `RootQueryType` whose callback is application code. Clients send it in a `query` document, together with other query fields; Simfinity's [middleware](./middleware) and the [authorization plugin](./authorization) see it; `createSchema()` can include or exclude it; and [MCP](./mcp#custom-query-tools) publishes it as a read-only tool. A read of stored records does not belong here: a custom query bypasses the scopes, filters and permission rules of the generated reads, so it would have to repeat them. A named read of stored records with a fixed predicate is a [named view](#named-views).

This example estimates a duration from a catalog defined in code. `simfinity` is the runtime your application already set up; register the query before the `createSchema()` call that should expose it.

```javascript
import {
  GraphQLInputObjectType, GraphQLInt, GraphQLList,
  GraphQLNonNull, GraphQLObjectType, GraphQLString,
} from 'graphql';

const minutesByService = new Map([
  ['haircut', 30],
  ['beard', 15],
]);

const durationService = {
  estimate(serviceCodes) {
    const minutes = serviceCodes.reduce((total, code) => {
      const duration = minutesByService.get(code);
      if (duration === undefined) throw new Error(`Unknown service: ${code}`);
      return total + duration;
    }, 0);
    return { minutes };
  },
};

const DurationInput = new GraphQLInputObjectType({
  name: 'DurationInput',
  fields: {
    serviceCodes: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
  },
});

const DurationEstimate = new GraphQLObjectType({
  name: 'DurationEstimate',
  fields: { minutes: { type: new GraphQLNonNull(GraphQLInt) } },
});

simfinity.registerCustomQuery(
  'estimateServiceDuration',
  'Estimate the total duration of selected services',
  DurationInput,
  DurationEstimate,
  (input, context) => durationService.estimate(input.serviceCodes),
);

const schema = simfinity.createSchema();
```

```graphql
query {
  estimateServiceDuration(input: { serviceCodes: ["haircut", "beard"] }) {
    minutes
  }
}
```

The result is `{ "data": { "estimateServiceDuration": { "minutes": 45 } } }`. An input object type creates one required `input` argument. Pass `null` or `undefined` instead of that type for a query without arguments; its callback receives `undefined` as the input. Outputs can also be scalars, enums, lists, interfaces or unions, with GraphQL nullability wrappers, and need no registration or storage model.

The callback receives `(input, context)`. GraphQL validates and coerces the arguments first, then [global middleware](./middleware) runs with `operation: 'custom_query'` and `entry: 'estimateServiceDuration'`, and the callback gets a copy of the input after middleware and the request context. It returns the result or a promise of it. An error it throws keeps its code and status, as in a custom mutation. Unlike a custom mutation's `(input, session, context)`, the callback receives no session, so a callback ported from `registerMutation()` drops that parameter. The callback is engine-specific application code: Simfinity makes no promise that one callback works on both backends. See [`registerCustomQuery()`](/reference/api#registercustomquery) for its parameters and registration errors.

### Select custom queries

`createSchema()` includes every registered custom query. Its fourth argument, an options object, selects them by name:

```javascript
// Every generated query and mutation, every custom mutation, and one custom query.
const schema = simfinity.createSchema(null, null, null, {
  includedCustomQueries: ['estimateServiceDuration'],
});
```

An omitted `includedCustomQueries` or `null` includes every custom query, `[]` includes none, and a name that is not registered is ignored. A fourth argument that is not a plain object, such as an array of names, and an option other than `includedCustomQueries` fail with `INVALID_SCHEMA_OPTIONS` (500) before any model is prepared.

An included custom query named like an included generated query (`<entity>`, `<list>` or `<list>_aggregate`) fails with `QUERY_NAME_CONFLICT` (500), also before any model is prepared; exclude one of them. GraphQL accepts a custom query and a custom mutation with the same name, but [MCP](./mcp#custom-query-tools) then publishes only the query's tool, so give them distinct names. A schema without mutation fields, such as one that has only custom queries, has no `Mutation` root.

### Transactions

Simfinity opens no transaction around a custom query, and the callback receives no session. Its native reads run outside any transaction, like the generated queries, and see committed data. A callback whose reads must see one snapshot opens its own transaction with the engine's API and passes the session to each read. This price preview reads every product of a cart from one snapshot; `ProductType` is a registered type with a `price` field:

```javascript
// PostgreSQL: simfinity is the @simtlix/simfinity-postgres instance.
simfinity.registerCustomQuery('pricePreview', 'Price a cart without storing it', CartInput, PricePreview,
  (input) => simfinity.withTransaction(null, async (session) => {
    const products = simfinity.getModel(ProductType);
    let total = 0;
    for (const { productId, quantity } of input.lines) {
      const product = await products.findById(productId, { session });
      total += product.price * quantity;
    }
    return { total };
  }));
```

```javascript
// MongoDB: the Mongoose connection of the models that the callback reads.
simfinity.registerCustomQuery('pricePreview', 'Price a cart without storing it', CartInput, PricePreview,
  (input) => mongoose.connection.transaction(async (session) => {
    const products = simfinity.getModel(ProductType);
    let total = 0;
    for (const { productId, quantity } of input.lines) {
      const product = await products.findById(productId).session(session);
      total += product.price * quantity;
    }
    return { total };
  }));
```

PostgreSQL's [`withTransaction()`](./postgresql#native-model-and-session-apis) uses repeatable-read isolation and retries serialization failures and deadlocks; Mongoose's `transaction()` retries transient transaction errors. Both may run the function more than once, so keep it free of other side effects. On MongoDB, a session belongs to one client: open the transaction on the connection of the models the callback reads, such as `ProductModel.db.transaction()` for models of another connection. The transaction ends when the function's promise settles. Output field resolvers run afterwards, outside it, and sibling query fields run their own callbacks and transactions. Registering a custom query does not make database access read-only.

### Authorization

With the [authorization plugin](./authorization), the rule for `RootQueryType.<name>` authorizes the field before middleware and the callback run, such as `RootQueryType: { estimateServiceDuration: requireAuth() }`. Without a rule, the default policy applies, so under `defaultPolicy: 'DENY'` the field is denied. The fields of its output type are authorized by their own rules. The fields inside its `input` are not checked as field paths.

The callback authorizes its own reads with the trusted request context: query scopes, controllers, generated filters and pagination do not run for it. Generated relationship fields selected on its result still run their middleware and scopes, after the callback has returned.

## Named views

A named view gives a frequent list read one name, typed params and a fixed predicate. Web clients, MCP agents and in-process callers use the same root field. It returns the base type's records with the generated filters, `AND`/`OR`, `sort` and `pagination` arguments available alongside its params.

Visibility belongs in the type's [scope](./query-scope). A view always runs that scope and never returns a row that the generated list would hide from the same caller. Its `where` adds the read's predicate without repeating tenant or other visibility rules.

### Declare a view

This example uses Barber's registered `bookingType`, whose GraphQL name is `booking`. The application has already connected it to the selected runtime and configured its scope. Register the view before building the schema:

```javascript
import { graphql, GraphQLString } from 'graphql';
import { simfinity } from './runtime.js';

simfinity.registerView('upcomingBookings', {
  type: bookingType,
  description: 'Confirmed bookings from a date on, default today, that the caller may read. For clock order pass sort scheduledDate ASC, startTime ASC.',
  params: {
    from: {
      type: GraphQLString,
      description: 'First date included, YYYY-MM-DD. Defaults to today (UTC).',
    },
  },
  where: ({ params }) => [{
    conditions: [
      { field: 'state', operator: 'EQ', value: 'CONFIRMED' },
      {
        field: 'scheduledDate',
        operator: 'GTE',
        value: params.from ?? new Date().toISOString().slice(0, 10),
      },
    ],
  }],
});

const schema = simfinity.createSchema();
```

Initialize the backend before serving operations, as in [database setup](./databases). Call the field through GraphQL with the same trusted request context as any generated query:

```javascript
const result = await graphql({
  schema,
  source: `query Upcoming($from: String) {
    upcomingBookings(
      from: $from
      sort: { terms: [
        { field: "scheduledDate", order: ASC }
        { field: "startTime", order: ASC }
      ] }
      pagination: { page: 1, size: 20, count: true }
    ) {
      scheduledDate
      startTime
      state
    }
  }`,
  variableValues: { from: '2026-11-01' },
  contextValue: context,
});
```

With one matching booking visible to that caller, an illustrative result is:

```json
{
  "data": {
    "upcomingBookings": [
      { "scheduledDate": "2026-11-02", "startTime": "09:00", "state": "CONFIRMED" }
    ]
  }
}
```

The count is available as `context.count`, here `1`. Use the [count plugin](#pagination-and-total-count) to expose it in the GraphQL response.

The view is included exactly when its base type is in `createSchema()`'s `includedQueryTypes`. There is no separate `includedViews` option. See [`registerView()`](/reference/api#registerview) for the registration contract.

### Params

Each param declares `{ type, description?, defaultValue? }`. Its type is a GraphQL scalar, enum or list of those, with `GraphQLNonNull` wrappers allowed. Input objects are not accepted. GraphQL coerces the values before the resolver runs. A `NonNull` param without a default is required.

Param names must be valid GraphQL names without the `__` prefix. A param cannot share a name with any base-type field, including a reference, collection or virtual field, or with `AND`, `OR`, `sort` or `pagination`. Use `barbershopId` for a param that identifies the `barbershop` reference:

```javascript
import { GraphQLID, GraphQLNonNull, GraphQLString } from 'graphql';
import { SimfinityError } from '@simtlix/simfinity-core';

simfinity.registerView('barbershopDay', {
  type: bookingType,
  description: 'Confirmed bookings of one barbershop on one date that the caller may read. For clock order pass sort startTime ASC.',
  params: {
    barbershopId: { type: new GraphQLNonNull(GraphQLID), description: 'The barbershop.' },
    date: { type: new GraphQLNonNull(GraphQLString), description: 'The day, YYYY-MM-DD, in the shop timezone.' },
  },
  where: ({ params }) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(params.date)) {
      throw new SimfinityError('date must be YYYY-MM-DD', 'INVALID_INPUT', 400);
    }
    return [{
      conditions: [
        { field: 'barbershop', path: 'id', operator: 'EQ', value: params.barbershopId },
        { field: 'scheduledDate', operator: 'EQ', value: params.date },
        { field: 'state', operator: 'EQ', value: 'CONFIRMED' },
      ],
    }];
  },
});
```

Register this view before `createSchema()` too. Only `where` receives the params. Their descriptions and defaults also appear in the MCP input schema. These examples illustrate the API; the Barber applications still pin their published runtime version.

### How a view resolves

After GraphQL coercion, the resolver removes the params from the client's arguments. No param reaches path inspection, middleware, the scope or the adapter as a filter path. The client's remaining arguments receive the same path and condition checks as a generated list.

Middleware runs with `{ type, args, operation: 'find', entry: <view name>, context }`. It sees only the client's list arguments. Then `where({ params, context })` returns an array of `AND` groups or a promise of that array. Keep it free of database reads and do not write to `context`. Returning `[]` adds no conditions.

The returned groups are copied, checked and appended to the top-level `AND` after middleware. Replacing `params.args` in middleware cannot drop them. Their paths and conditions, including shorthand and explicit quantified frames, are inspected as a client's constructs, so references receive joined scopes and hidden records read as missing. For example, `barbershopDay` returns `[]` for a shop the caller cannot see. Collection paths have the same behavior and restrictions as the equivalent client filter.

The base type's `find` scope then runs with its usual payload. It receives no view params or view metadata. The scoped list and count use the same predicate. `pagination.count: true` reports the total through the generated list's [count mechanism](#pagination-and-total-count).

### Errors

`INVALID_VIEW` (500) identifies a declaration or `where` bug. `registerView()` rejects an invalid name, the reserved `_aggregate` suffix, unknown options, an empty description, invalid param definitions or a `where` that is not a function. `createSchema()` rejects an unregistered base type, an invalid param name or a param name collision.

At request time, `INVALID_VIEW` rejects a `where` result that is not an array of groups. Groups and conditions must be plain objects, and each condition must name a `field`. Groups accept only `conditions`, `AND`, `OR`, `ANY`, `ALL` and `NONE`; quantified group members also require a non-empty `path` relative to their containing frame. Conditions accept only `field`, `operator`, `value` and `path`. Unknown structural keys and cyclic groups fail with `INVALID_VIEW`. Empty groups and sharing a group between separate branches are allowed, and the contents of `value` are opaque to this structural check. Unknown fields, including below references, paths past scalars, virtual fields and the reserved `__scope` key on conditions or quantified groups also fail with this code.

An application error thrown by `where` keeps its code and status, as `INVALID_INPUT` does above. Other filter errors follow the generated list: unsupported operators give `UNSUPPORTED_QUERY`, and invalid filter values use the backend's existing codes. The view does not validate IDs itself. A duplicate view name gives `QUERY_NAME_CONFLICT` at registration; conflicts with included generated roots or custom queries give it at schema creation.

### Limits

`where` uses the generated filter language over stored fields with the adapter's supported operators. Its groups count toward the same five-level nesting limit as a client's groups. Put alternatives inside an `OR` group. [`maxReferenceFrames`](../reference/api#configurequerylimits) applies separately to the client's arguments and the `where` groups, as two sets of compiled frames and scoped joins, whether or not a target has a scope. The client set is checked before middleware, and the `where` set after middleware, before the base scope. Both use one provenance registry, so a base scope must preserve their marked objects. `maxFrameNesting` also applies to both sets.

A view fixes no order or page size. Callers send `sort` and `pagination`; MCP also applies its `defaultPagination`. The generated list's query limits and count behavior apply. A view creates no aggregate root, projection, by-ID read, write or database object. A per-parent read belongs in a [virtual field](#virtual-fields).

`@simtlix/simfinity-js-client` 1.1.0 chooses the last list root for `client.find(type)`. Registering a view over that type can therefore change which root it calls. Applications using that method should wait for a client fix before registering a view over the type. Call a view with `client.execute(document, variables)`.

### Views in MCP

MCP publishes each view as a read-only list tool with its params and the generated list arguments. It keeps the view's name and description and reports `totalCount` for counted pages. See [named view tools](./mcp#named-view-tools) for invocation and selectors.

### Authorization

Authorize the root as `RootQueryType.<view name>`, such as `RootQueryType: { upcomingBookings: requireAuth() }`. Under `defaultPolicy: 'DENY'`, an unruled view fails with `FORBIDDEN`. Returned rows keep the base type's field and virtual-field rules.

The paths a view's `where` names are the author's, like paths added by middleware and scopes. The authorization plugin's field read rules do not check them, and `queryable` does not restrict them. Virtual fields still fail. The type's scope remains the visibility boundary; the view's predicate only narrows its result.

To constrain which records a caller may query, continue with [query scope](./query-scope).
