# Stored-field comparisons and structural parents

Since 3.17.0, `valuePath` compares compatible stored fields. Check `queryFeatures.valuePath` and `referenceEmptiness`; collection shorthand also requires `quantifiers`. Embedded-list traversal and structural parents require 3.18.0 `elementFrames` with all three dependencies.

```javascript
const lowStock = { stock: { operator: 'LTE', valuePath: 'reorderLevel' } };
const linesWithinOrderLimit = {
  AND: [{ ALL: [{ path: 'lines', conditions: [
    { field: 'quantity', operator: 'LTE', valuePath: '$parent.limit' },
  ] }] }],
};
```

The second example assumes an embedded Order.lines list with quantity and a containing Order.limit. With no elements ALL is true; add ANY when nonemptiness is required. This is a field comparison, not arithmetic such as `price * quantity`.

## Origins and correlation

A field-filter or ordinary group RHS starts at its containing record. A relation term starts at the related object; explicit quantified bodies start at their element. Collection-field arguments start at the queried child, not the owner of the GraphQL selection. Boolean groups do not change origins.

In collection shorthand, `reviews.rating LT valuePath: 'reviews.maxRating'` binds the same review; `valuePath: 'stock'` reads its containing Product. The RHS cannot introduce an unrelated/right-only collection. Dotted embedded comparisons likewise bind both operands to one element, but separate dotted embedded conditions can use different elements; explicit groups express shared-element conditions.

`$parent` means the actual containing object, including intermediate single embedded objects. With Order.shipping.lines, `$parent.limit` reads Shipping and `$parent.$parent.limit` reads Order. Array containers add no object level. Entity references/collections stop ancestry: use declared references across entities. `$root`, root/bare `$parent` and excessive upward prefixes are invalid. Nested duplicate-valued objects retain their own identity; do not correlate them by equal values.

## Values, permission and storage semantics

`value` and non-null `valuePath` are mutually exclusive, including `value: null`; null/undefined `valuePath` preserves literal behavior. Scalar EQ/NE normalizes missing/null to null; ordered/text comparisons with null are false. Scalar-list left EQ is membership and NE its complement: a null RHS matches a missing/null list or `[null]`, not `[]`. A right list or whole object is invalid.

Use numeric/String/matching-temporal ordering; compatible scalar/enum equality; or case-sensitive String LIKE/STARTS_WITH/ENDS_WITH. Case-insensitive operators, set operators, emptiness, arithmetic expressions and managed version fields are unsupported with `valuePath`. Both client paths require read permission and stored/queryable fields even when the RHS is not selected. Hidden reference targets read as null. Preserve comparison markers and scope provenance when editing either final path in middleware.

MongoDB String ordering with `valuePath` uses the effective aggregate-command collation, including lookups/frames; PostgreSQL uses explicit C collation. Simfinity does not inspect/override Mongo collection collation. EQ/NE, scalar-list membership, enum and supported text comparisons remain exact: under case-insensitive collation `A` and `a` may satisfy LTE and GTE without EQ. Raw driver options and Mongoose aggregate hooks/options are not interchangeable. Preserve existing literal-filter behavior.

In aggregates retain each operand's origin and group/fact joined-row cardinality. Combine comparisons with selective literal predicates and measure plans on representative data; use a maintained derived field only for a demonstrated indexing or query need.

Sources: [compare stored fields](https://simtlix.github.io/simfinity.js/guide/queries.html#compare-stored-fields), [embedded objects and parent](https://simtlix.github.io/simfinity.js/guide/queries.html#embedded-object-lists-and-parent).
