# Embedded query frames and embedded `$parent`

Status: implementation design following the maintainer's approval of the scope and query example. A fresh builder check found no consequential unresolved questions. Detailed choices below are the author's implementation decisions, not additional statements attributed to the maintainer.

Baseline: `v3.17.0`, master `2f16e0b79006517116c2775bd6368929ac4c8841`.
Rationale: [issue #108](https://github.com/simtlix/simfinity.js/issues/108), sections 4.4–4.6, and its [revised delivery order](https://github.com/simtlix/simfinity.js/issues/108#issuecomment-6325201790). The issue is closed although this part remains unimplemented. This design narrows its proposed upward references following the maintainer's discussion: `$parent` belongs to embedded containment only; `$root` is excluded.

## Intent and agreed scope

Let generated queries select stored records by conditions on individual objects inside embedded lists, including comparison with their containing objects. Keep authorization, scopes, counts, pagination and aggregate behavior in Simfinity rather than loading and filtering records in application code.

The maintainer agreed to extend `ANY`, `ALL` and `NONE` to embedded object lists, allow element-local field comparisons and nested embedded lists, and include `$parent` for embedded objects and list elements. References between registered entities continue to use declared field paths such as `barbershop.slotDurationMinutes`. A proposed shared-supplier example did not establish a need for upward references between entities and is not a rationale for adding them.

This is a library feature across core and both engine compilers. It does not change application schemas or storage layouts. The existing six-package release alignment applies when a release is requested; the completed 3.17.0 publication does not itself authorize publication of this next feature.

## Approach

Extend the existing query path walker, quantified groups, comparison operands and client provenance. Core defines the language and resolves context; MongoDB and PostgreSQL compile the same resolved meaning using their existing storage metadata.

This is the approach carried forward from the approved query examples. A separate embedded-filter operator would duplicate `ANY`/`ALL`/`NONE` and require another recursive input shape. Synthetic parent fields on application types would expose a containment implementation detail as a stored relationship and would not represent an embedded element's identity reliably. Neither serves the agreed API.

The concrete implementation of context descriptors and the additive plan representation is left to the implementer, within the compatibility and validation requirements below. There is no new general expression language.

## Models and public examples

The examples use illustrative registered roots `Pedido` and `Proveedor`, with generated list root `pedidos`. `Envio`, `Linea` and `Bulto` are embedded GraphQL object types: their fields use `extensions.relation: { embedded: true }`. References use `embedded: false`; inverse collections also declare their connection field.

```text
Pedido {
  id: ID
  maxCantidadPorLinea: Int
  envio: Envio
  lineas: [Linea]
}
Envio {
  maxCantidadPorLinea: Int
  lineas: [Linea]
}
Linea {
  cantidad: Int
  maxCantidad: Int
  sku: String
  etiquetas: [String]
  proveedor: Proveedor
  bultos: [Bulto]
}
Bulto {
  cantidad: Int
  limite: Int
}
Proveedor { id: ID, maxCantidad: Int }
```

All lines satisfy the order's limit:

```graphql
query {
  pedidos(AND: [{ ALL: [{
    path: "lineas"
    conditions: [{
      field: "cantidad", operator: LTE,
      valuePath: "$parent.maxCantidadPorLinea"
    }]
  }] }]) { id }
}
```

At least one line has both the requested SKU and an acceptable quantity. Both tests read the same element:

```graphql
query {
  pedidos(AND: [{ ANY: [{
    path: "lineas"
    conditions: [
      { field: "sku", operator: EQ, value: "A" }
      { field: "cantidad", operator: LTE, valuePath: "maxCantidad" }
    ]
  }] }]) { id }
}
```

Nested groups preserve the selected outer element:

```graphql
query {
  pedidos(AND: [{ ANY: [{
    path: "lineas"
    ALL: [{
      path: "bultos"
      conditions: [{ field: "cantidad", operator: LTE, valuePath: "$parent.maxCantidad" }]
    }]
  }] }]) { id }
}
```

The existing field form is equivalent: `lineas: { quantifier: ALL, terms: [{ path: "cantidad", operator: LTE, valuePath: "$parent.maxCantidadPorLinea" }] }`. Every term still needs a path when `quantifier` is present; empty terms retain existing quantifier semantics.

## Element membership and quantifiers

An embedded-list frame ranges over its non-null object elements. Missing lists, null lists, `[]` and `[null]` contain no elements. An empty object `{}` is an element; its missing fields are read using existing null rules. Duplicate equal objects are separate elements, though they do not duplicate a matching root record.

| Construct | Meaning | No elements |
| --- | --- | --- |
| `ANY` | At least one element satisfies the entire body | false |
| `ALL` | Every element satisfies the entire body | true |
| `NONE` | No element satisfies the entire body | true |

A body with no conditions is true. Boolean groups do not change the current element or its parent. `ALL` negates the complete two-valued body when searching for a counterexample; it does not invert individual expanded rows. Null operands fail ordered/text comparisons, so a non-null element with a missing quantity fails `ALL cantidad LTE limit` even when its siblings pass. `EQ` and `NE` retain 3.17.0's null-safe comparison behavior.

For the first query above, this acceptance fixture fixes the intended results:

| Order limit | Line quantities | `ANY` | `ALL` | `NONE` |
| --- | --- | --- | --- | --- |
| 10 | 3, 8 | true | true | false |
| 10 | 3, 12 | true | false | false |
| 10 | 12 | false | false | true |
| 10 | one object whose quantity is null | false | false | true |
| null | 3 | false | false | true |
| 10 | no non-null elements | false | true | true |

A quantified path may cross single embedded objects and single references and end at an embedded object list, a collection or a single reference. It may not cross another list before its endpoint: use nested groups. Scalar-list endpoints and single embedded-object endpoints remain invalid for quantifiers. A single embedded object is accessed with field paths or relation terms, not `ANY`.

Within an element, use the existing literal operators and their supported types, including list membership, `CONTAINS_ALL`, `IIN`, emptiness on local fields, and the supported 3.17.0 `valuePath` pairs. This is not a relaxation of the operator/type matrix. In particular, case-insensitive field comparisons, lists on the right, whole-object comparisons, Version comparisons and arbitrary expressions remain unsupported.

## `$parent`: structural embedded containment

The following detailed rules are design choices made by the author. They give the same meaning regardless of whether an application uses a dotted path or nested filter syntax.

1. `$parent` is accepted only at the start of `valuePath`. One or more `$parent.` prefixes must be followed by a nonempty ordinary GraphQL field path. `$root`, suffix dollar segments, a bare `$parent`, mixed prefixes and expressions are invalid.
2. Each prefix moves from the current embedded object or embedded-list element to the object that contains it. A list itself is not an object level. Repetition is allowed while every upward edge is embedded containment.
3. Single embedded objects crossed while entering an element remain in the containment chain. For `ANY path: "envio.lineas"`, `$parent.maxCantidadPorLinea` reads `Envio.maxCantidadPorLinea`; `$parent.$parent.maxCantidadPorLinea` reads `Pedido.maxCantidadPorLinea`. With `ANY lineas` then `ANY bultos`, one prefix reads the selected Linea, two read Pedido.
4. The chain stops at a registered entity read through a reference or collection. From an embedded object of a related entity, a prefix may reach that entity, but another cannot return to the previous entity. Being inside a relationship quantifier alone never enables `$parent`.
5. Context comes from the filter carrier, not just from the left field's path. A root `AND` condition on `envio.maxCantidadPorLinea` is still in Pedido, so `$parent` there is invalid. The equivalent root comparison uses ordinary `valuePath`. Relation terms on the single embedded `envio` begin in Envio and may use `$parent` to read Pedido.
6. Legacy terms on an embedded list already describe element-relative paths. For new field comparisons their `$parent` origin is that element's containing object; they do not change the correlation of existing literal terms. Explicit quantified terms share one element.
7. Inside a quantified element, an ordinary `valuePath` begins at that element. It never falls back to a parent because a field is absent. Unknown fields are errors, not a request to search higher levels.
8. After moving upward, ordinary single references and single embedded objects may be traversed with existing scope/path checks. The right operand must still be scalar. It cannot descend into an unbound list or choose another element. Use an element-local path for the already selected element's fields.
9. Collection-field arguments start a new child query at its registered entity. They do not inherit the GraphQL selection parent's containment chain. Embedded filters inside that child have their own chain. `$parent` cannot name the owner of an entity collection; use the child's declared reference.
10. Embedded field-read checks apply to every real path traversed. `$parent` is syntax for resolving a bound object, not a stored field, relation, resolver, backend identifier or permission bypass.

Single embedded terms retain their existing missing-object behavior: there is no new implicit existence condition. A missing embedded object produces null fields; it does not prevent an otherwise valid null-safe comparison.

## Dotted comparisons through embedded lists

Complete the embedded-list comparison gap left by part 5 while preserving all existing literal filters:

- `{ field: "lineas.cantidad", operator: LTE, valuePath: "lineas.maxCantidad" }` binds both operands to the same line.
- `{ field: "lineas.cantidad", operator: LTE, valuePath: "maxCantidadPorLinea" }` binds the right operand to the queried Pedido.
- Nested shared list prefixes bind the same nested items. A right-only or unrelated list remains invalid.
- Each such comparison is an implicit existential element test for positive scalar operators. As specified for legacy embedded-list leaves, `NE` is the complement of the corresponding existential `EQ`, rather than existential `NE`. Explicit `ANY` with a local `NE` retains its ordinary element predicate meaning.
- Separate shorthand conditions do not gain new same-element correlation across an embedded list. Callers requiring that correlation use one explicit group. Existing collection-prefix group correlation remains unchanged.
- Parent resolution is captured before normalization. Rewriting a relation term, splitting a collection prefix or inserting an implicit element frame must not rebind either operand.

Filters select root records; they do not trim the returned embedded array. Selection of embedded fields retains its current behavior. No new arguments are added to embedded selection fields in this change.

## Scopes, permissions and generated read surfaces

The feature applies consistently to generated lists, pagination counts, aggregate filters, collection-field reads (individual and batched), named views, middleware, scopes and MCP-generated inputs. Root aggregate group/fact paths keep their supported meaning and cardinality. A filter-only element frame never adds a multiplying join to the outer result or facts. Existing aggregate collection anchors must preserve their already-bound row when an embedded comparison is below that row.

Embedded values have no independent entity `find` scope. They inherit admission of their containing record and remain subject to field read/queryability rules. References reached from an element, and references in a parent operand, use the target's existing `find` scope for client filters: hidden targets read as missing. Their joins stay local to the relevant element or containing object. Trusted middleware/scope additions retain stored-data semantics.

Extend `collectQueryPathEntries` and the shared resolver so the auth plugin and runtime inspect both operands at their correct absolute paths, including parent paths not selected in the response. Preserve client markers and bound origins through copies, normalization and trusted scope prefixing. Replaced or detached client restrictions must still fail with `DETACHED_CLIENT_FILTER`; internal keys cannot allow client-supplied outer bindings to escape validation.

Scopes for a registered target start at that target and cannot use `$parent` to capture the calling query's object. They may enter their own embedded objects/lists and use those containers. Keep scope frequency, caching, supplied sessions, hooks and batching fallback rules unchanged. An embedded list with a reference inside it must be tested with restrictive and empty target scopes; do not lift unrelated legacy join restrictions globally.

## Capability, plan and error contract

Proposed capability: `queryFeatures.elementFrames: true`, requiring `quantifiers`, `referenceEmptiness` and `valuePath` all true. It covers embedded frames, embedded upward comparisons and their shorthand normalization as one supported compiler feature. Bundled adapters declare it only when the full implementation is present. Existing/custom adapters without it retain their current supported behavior and reject valid new forms with `UNSUPPORTED_QUERY` (400). A malformed declaration is a startup `INVALID_QUERY_FEATURES` or `INVALID_SQL_PLUGIN`, following the current owner.

Extend the current SQL plugin binding and override checks: copying a plugin and replacing its compiler must not accidentally inherit support. Thread the effective feature through root/child/batch/scoped reads, `createQueryPlan` and public declarations; follow existing default rules for an omitted plan declaration. MCP/descriptor must expose the actual generated contract without inventing new stored fields.

Core must resolve registered entities and embedded-local field sets without registering embedded types as independent entities. Preserve the meaning of the existing `QueryOperand.up` and the serialized shape of existing plans. Use a distinct, validated additive representation for structural embedded ancestry where needed; its exact spelling is an implementer choice. Document and test that representation before changing engine consumers. Public/internal hand-built plans must reject missing containment context rather than guess or treat an object as a root model.

| Fault | Result |
| --- | --- |
| Valid new form without `elementFrames` | `UNSUPPORTED_QUERY` (400) |
| Invalid parent syntax, outside embedded context, crossing an entity boundary or moving above the root | `INVALID_FILTER_PATH` (400) |
| Unknown field after valid parent resolution | `INVALID_FILTER_FIELD` (400) |
| Incompatible scalar types or both literal value and non-null valuePath | `INVALID_FILTER_VALUE` (400) |
| Unsupported operator/type pair | `INVALID_FILTER_OPERATOR` (400) |
| Right operand introduces an unbound list; invalid quantified endpoint/path | `INVALID_FILTER_PATH` (400) |
| Forbidden/non-queryable path or read-rule denial | Existing `FORBIDDEN_FILTER_PATH`/`FORBIDDEN` behavior |
| Detached or invalid client scope/origin provenance | `DETACHED_CLIENT_FILTER` (500) |

Keep existing precedence for previously accepted/rejected forms. New dollar syntax is validated before resolving its remaining path. Limits continue to apply: actual quantified element groups consume frame depth and frame units like existing collection groups; implicit element witnesses also count toward compiled client units. Single embedded containers retained for parent addressing are not extra quantified groups. Parent traversal is bounded by the finite resolved containment chain; aliases cannot reset budgets. Keep named-view and trusted-scope limit rules.

## Engine work and boundaries

### Core and SQL

Extend the existing path/context machinery, group normalization, provenance and typed plan. Preserve core/SQL driver independence. Reuse the same containment resolution for runtime authorization and engine planning. Explicit bodies bind one element and capture its ancestor objects; normalization must retain root versus element operand origin. The planner needs local embedded fields and containing contexts, not just a registered entity name.

### MongoDB

An embedded element is an object value, not a separate collection and not necessarily a subdocument with `_id`. The existing collection compiler's target-model lookup cannot be reused unchanged. Compile a local existential/counterexample witness, preserving the containing record and exact array positions. Pure expression evaluation is possible where the body needs no joins; bodies containing references require lookups isolated within the element witness. A correlated pipeline from the nearest stored entity with element-position binding is one viable implementation; choosing a common lowering and any later fast path is left to the implementer.

Do not unwind embedded lists into the outer result merely to filter them. Equal objects and null elements must not confuse element identity, and nested lists must retain their actual containing element. Parent operands bind object values or validated expressions in the correct witness context. Guard expression argument types against eager evaluation/constant folding, as part 5 requires. Preserve supplied-model storage aliases and identity representations. Native collation behavior remains the documented 3.17.0 contract.

### PostgreSQL

Support both actual storage forms: JSONB embedded lists and privately owned tables for embedded objects containing references. JSONB frames use a correlated element source with explicit null handling; owned frames correlate owner keys, position and presence state. Parent addressing must work across inline values, JSONB and owned boundaries without changing DDL. Reuse existing codecs for temporal/enum/scalar operands and existing scoped joins for references. `ANY`/`NONE` use existence/nonexistence; `ALL` searches for a failing complete body. The query remains one predicate on the outer row, including batched child reads.

No ordinary-index performance guarantee is added. Test representative compiled statements/pipelines for row multiplication and bounded lookups; optimize only with preserved semantics.

## Verification required before implementation is complete

Use one fixture model and expected result sets across both engines. At minimum:

1. Null/missing/empty lists, `[null]`, empty objects, duplicates, mixed passing/failing/null-field elements, and empty bodies for all three quantifiers.
2. Same-element correlation: two different lines individually satisfy each condition but no line satisfies both. Explicit `ANY` must reject; legacy separate literal filters retain their old results.
3. Element-local comparisons, parent comparisons, intermediate single embedded containers, repeated parents through nested lists, and nullable single embedded terms.
4. Counterexamples for forbidden `$parent` in entity references, collection child roots, plain root conditions, and attempts to climb past an entity boundary. `$root` always rejects.
5. Dotted embedded comparison correlation, implicit `NE` complement versus explicit `ANY NE`, unrelated right lists, root-relative operands, mixed collection/embedded paths and repeat normalization.
6. JSONB and owned PostgreSQL layouts representing the same logical model; MongoDB generated/supplied models with embedded IDs disabled or present and storage aliases.
7. References inside elements and parent operands with target scopes that hide all/some rows; permissions on a parent-only RHS field; tenant separation; middleware cloning/rewriting and detached markers; native/trusted semantics.
8. Lists/counts/pagination, aggregate cardinality and collection anchors, individual/batched selected collections, named views, `get_by_id` scopes, MCP and descriptor/declaration consumers.
9. A literal-only regression matrix pins embedded legacy filters/sorts/aggregates and existing collection frames. No storage-schema golden changes.
10. Capability/override validation, direct compiler/plan rejection of malformed ancestry, frame limits and nested mixed reference/embedded chains.

Run focused tests while developing, then lint, the full suite with disposable MongoDB replica/standalone and PostgreSQL URIs, security audit, packed consumer tests and documentation build. Real database checks are necessary for correlated lookups, JSONB/owned correlation and null behavior. A syntax/compiler-only probe is not evidence of execution parity.

Update the root and affected package READMEs; query, scope, authorization, SQL plugin, API, errors, MCP/descriptor and compatibility guides; relevant repository rules and the query/report skill. Clearly distinguish newly supported element frames from legacy dotted filters and give the order/line examples above.

## Delivery and author decisions to review

Develop on `codex/embedded-query-frames` in the managed worktree. Reuse #108 for motivation while stating its closed status; link the approved design from the implementation PR. Follow the repository review/check workflow. Publication is a later explicitly authorized action.

The detailed choices made here, beyond the maintainer's example and scope, are: structural parent counting including intermediate embedded objects; repeatable `$parent` with entity-boundary stops; one `elementFrames` capability; and inclusion of the originally deferred dotted embedded comparisons with their existing-list `NE` convention. The implementer owns the additive IR spelling and engine lowering, subject to the fixed semantics, tests and package boundaries above.
