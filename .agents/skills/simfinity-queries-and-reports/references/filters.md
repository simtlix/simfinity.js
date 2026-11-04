# Filters and correlated elements

## Select by capability

| Requirement | Since | Mechanism / check |
| --- | --- | --- |
| Literal text search | 3.9.0 | `ILIKE`, `STARTS_WITH`, `ISTARTS_WITH`, `ENDS_WITH`, `IENDS_WITH`, `IEQ`; declared operators |
| Own value missing or empty | 3.10.0 | `IS_EMPTY` / `IS_NOT_EMPTY`, no value |
| Reference/collection emptiness | 3.11.0 | `referenceEmptiness: true` |
| Correlated related elements | 3.14.0 | `quantifiers: true` plus `referenceEmptiness: true` |
| Case-insensitive code/email set | 3.16.0 | `IIN` on String, declared operator |
| Has every requested tag | 3.16.0 | `CONTAINS_ALL` on a list, declared operator |
| Compare stored fields | 3.17.0 | `valuePath: true` plus `referenceEmptiness`; quantifiers for collection shorthand |
| Correlate embedded object lists | 3.18.0 | `elementFrames: true`, `quantifiers: true`, `referenceEmptiness: true` and `valuePath: true` |

The bundled adapters implement these features at this baseline. A custom adapter or a compiler override may not. Check its `queryFeatures` and the application's installed source; input presence or a newer repository checkout is insufficient.

Text operators take literal strings, not regex patterns. Both engines fold case alike except for `İ` and Unicode-version differences. PostgreSQL case folding needs UTF8 and ICU; build matching expression indexes with the documented `caseFoldExpression` helper. Test expected locale semantics instead of inventing regex/native replacements. `IIN` is a literal set, not a comparison with a stored list field.

`IS_EMPTY` is not `EQ null`: an empty string and empty list are empty, while `[null]` is nonempty. A missing/null list or `[null]` can match literal list `EQ null`, but `[]` does not. Whole embedded objects/lists can use conditions without a path. Client reference emptiness uses target `find` visibility; trusted scope/middleware conditions read storage. On versions/adapters lacking reference emptiness, distinguish an exact null test from the unsupported empty test rather than promising equivalent results.

## Related collections

Illustrative input for a model with Order.lines and Line.state:

```javascript
const allApprovedAndNonempty = {
  AND: [
    { ANY: [{ path: 'lines' }] },
    { ALL: [{ path: 'lines', conditions: [
      { field: 'state', operator: 'EQ', value: 'APPROVED' },
    ] }] },
  ],
};
```

`ANY` requires a visible element, `ALL` checks every visible element and `NONE` rejects any matching visible element. Empty visible sets satisfy ALL/NONE, not ANY. Add an existence condition when “all” must also mean “at least one”. A hidden referenced target reads as missing; trusted `get_by_id` and other scope predicates range over stored children.

One group with a shared referenced-collection prefix uses one child; separate groups can use different children. An explicit quantified `path` is relative to the current frame and cannot cross a list before its endpoint: nest groups for successive collections. Field-filter `quantifier` terms are element-relative; every supplied term needs a nonempty path. Shorthand `NE`/`NIN`/`EQ null` still requires a child, so use collection emptiness/NONE for absence. Put leaf `IS_EMPTY`, `IS_NOT_EMPTY` or `CONTAINS_ALL` inside an explicit element group; they are invalid through shorthand collection paths.

Query frame budgets (`maxReferenceFrames` and `maxFrameNesting`) still apply; a supported shape can exceed them. Named-view predicates and client filters have separate frame budgets. Inspect the configured limits before diagnosing a capability gap.

Filter-only collection frames do not multiply root rows/counts/pages. Aggregate group/fact paths retain joined-row cardinality; a filter sharing that prefix constrains the joined row. Sorts through collections remain unsupported. Scoped aggregate joins and unsupported joined paths retain documented restrictions; do not weaken access to make a report pass.

Preserve the marked client filter objects when appending server restrictions in scopes/middleware. Rebuilding them can raise `DETACHED_CLIENT_FILTER`; wrapping them inside a trusted quantified group can change visibility semantics. Both client and server conditions need to retain their origin. Separate server groups can intentionally use different witnesses: test the intended correlation.

## Embedded lists

Use explicit element groups to require several conditions on the same embedded object. Separate dotted embedded conditions retain independent witnesses, unlike shared referenced-collection prefixes. Missing/null/empty lists and null items contribute no elements: `[null]` satisfies ALL/NONE even though the list itself is not `IS_EMPTY`. `[{}]` has one element and evaluates the body.

Filters select records without trimming returned embedded arrays; selection fields gain no filter arguments. For comparisons to containing objects, see [stored-field comparisons](comparisons.md). Confirm installed capability before carrying older embedded-path restrictions forward.

Sources: [queries](https://simtlix.github.io/simfinity.js/guide/queries.html), [collection frames](https://simtlix.github.io/simfinity.js/guide/queries.html#collection-frames), [query scopes](https://simtlix.github.io/simfinity.js/guide/query-scope.html), [filter provenance](https://simtlix.github.io/simfinity.js/guide/middleware.html#keep-client-filter-objects).
