# Modeling decisions

| Choice | Contract |
| --- | --- |
| Entity | `id: GraphQLID`, `connect(null, Type, singular, plural, controller, onModelCreated, stateMachine)`; MongoDB may supply a model, PostgreSQL requires null |
| Embedded value | `extensions.relation.embedded: true`, supporting type via `addNoEndpointType`; object updates merge, supplied arrays replace |
| Independent reference | Object field with `relation.connectionField`; input `{ id }`, stored ObjectId/UUID |
| Referenced children | List field with `connectionField` identifying the child's stored parent link; input `{ added, updated, deleted }` |
| Server-managed field | `readOnly: true`, populated by trusted hooks; still readable unless separately protected |
| Sensitive output | Permission rule or omit from the public type; `queryable: false` independently forbids filter/sort/group paths |
| Invariant | GraphQL shape plus `extensions.validations`, controller for persisted/context-dependent checks; unique database constraint for concurrency |

For an order with lines, `Order.lines` and `Line.order` can both use `connectionField: 'orderId'`. This retains an existing storage field while presenting a typed relationship. Use field thunks for circular references; recursive embedded types are not a substitute for entity references. A many-to-many relationship generally needs an explicit association entity.

Lines that require their own lifecycle belong in referenced collections. Value lines can be embedded. A JSON string containing ordinary business lines prevents generated validation, references and query paths. An encrypted payload, rich-text document or external opaque object may legitimately remain opaque; model exposed facts separately without weakening its privacy requirements.

Register once at startup, then build the schema. Create fresh type objects per runtime when generated relation resolvers bind them. Await PostgreSQL initialization before serving operations. Select root operations with `createSchema()` include lists; do not delete generated fields or rebuild a Simfinity schema with `mapSchema`/`applyMiddleware`. If parent hooks maintain totals, exclude standalone child mutations or maintain the invariant from those paths too.

## Inspect rather than infer

Create inputs omit entity IDs and read-only fields; update inputs require the ID and have different requiredness. Referenced `added` items cannot choose IDs. Keep external identifiers/idempotency keys in separate fields. Omission preserves a value; explicit null clears a nullable value under the documented update contract. Do not force Mongo `_id` or stored nulls through adapter overrides.

`GraphQLNonNull` and validation are different. Built-in validation helpers return CREATE/UPDATE arrays; merge those arrays when combining helpers. A shallow spread can replace earlier validation. On partial update, `modelArgs` is not the whole record: session-bound checks must account for stored values and `$unset`.

GraphQL Int is signed 32-bit; design monetary/count fields for actual bounds. For portable enum ordering and states, prefer string internal values matching names. Do not assume MongoDB reference checks equal PostgreSQL foreign keys; Mongo transactional integrity is opt-in and native writes fall outside it.

Sources: [schema](https://simtlix.github.io/simfinity.js/guide/schema.html), [relationships](https://simtlix.github.io/simfinity.js/guide/relationships.html), [validation](https://simtlix.github.io/simfinity.js/guide/validation.html), [extensions](https://simtlix.github.io/simfinity.js/reference/extensions.html), [mutations](https://simtlix.github.io/simfinity.js/guide/mutations.html).
