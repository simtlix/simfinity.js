# Query language part 5: field comparisons

Status: implemented from the design approved by the maintainer on 2026-10-27, including the collation amendment below. Verification is recorded in the pull request.

Baseline: `v3.16.0`, master `e8d7f6e425271eb889588bf78c391eb3211e91b2`.
Motivation and original contract: [issue #108](https://github.com/simtlix/simfinity.js/issues/108), sections 4.1–4.4, 4.7–4.10 and [compiler proposal](https://github.com/simtlix/simfinity.js/issues/108#issuecomment-6252215307).
The [collection-frame decision](https://github.com/simtlix/simfinity.js/issues/108#issuecomment-6325201790) supersedes the issue's old collection-join semantics. The issue is closed, but this part is unimplemented in 3.16.0.

## Intent and delivery boundary

Applications need generated reads such as stock at or below its reorder level, stock below the containing shop's minimum, and two dimensions of the same stored object compared with one another. A literal filter cannot express these when the threshold differs per record. Native reads or filtering in application memory lose the generated query's authorization, scopes, paging, counts and MCP contract.

The maintainer selected part 5 after the 3.16.0 release. Deliver `valuePath` across generated list/count/aggregate filters, collection-field reads, named views, middleware and scopes, with matching MongoDB and PostgreSQL semantics. This is a shared library feature: core owns meaning and authorization, SQL owns its driver-free plan, and the engine compilers own physical expressions. The six-package release alignment remains unchanged. A new release is not inferred from this implementation request; publication requires separate intent.

Part 6 remains separate: public `$parent`/`$root` syntax, element frames for embedded lists, references read inside an embedded list for a comparison, and comparisons requiring such element frames. Part 5 may bind an outer record internally when normalizing an already-supported collection shorthand; that does not expose the part-6 syntax.

## Approach

Use the existing generated inputs, shared path walker/validator, collection-frame normalization and client scope provenance, extending them to understand both operands. MongoDB still compiles validated arguments; PostgreSQL still compiles `QueryPlan`. Share operand resolution/validation, not driver expressions.

The architecture leaves one appropriate approach. A separate query endpoint or an application-side filter would bypass the contract this change is intended to extend. Two independent operand parsers in the engines would duplicate GraphQL semantics and risk divergent authorization. Neither alternative fits the requested feature. The internal representation below is the author's proposal, to be reviewed with this document.

## Public syntax

Add nullable `valuePath: String` to `QLFilter`, `QLTypeFilter` and `QLFilterCondition`. Do not add an operator or a new top-level argument.

```graphql
products(stock: { operator: LTE, valuePath: "reorderLevel" }) { id }
products(stock: { operator: LT, valuePath: "shop.minStock" }) { id }
products(AND: [{ conditions: [
  { field: "dims.width", operator: LT, valuePath: "dims.height" }
] }]) { id }
products(shop: { terms: [
  { path: "minStock", operator: LT, valuePath: "maxStock" }
] }) { id }
```

In the last example both operands belong to Shop. A top-level condition whose `field` is `shop.minStock` instead resolves its `valuePath` from Product. AND/OR groups do not change that origin. Within explicit ANY/ALL/NONE groups, both operands are relative to the group's element. Collection-field arguments start at the queried child, not at the owner of that relationship.

Presence is semantic, not `hasOwn` alone:

- `value` is supplied when its value is not `undefined`.
- `valuePath` is supplied when its value is neither `undefined` nor `null`.
- Both supplied, including `value: null`, fail with `INVALID_FILTER_VALUE` (400).
- `valuePath: null`/`undefined` follows exactly the existing literal path, including existing omitted-value behavior.
- A supplied `valuePath` must be a nonempty string of dot-separated GraphQL-name segments. No dollar prefixes, empty segments, operators, expressions or arbitrary syntax.
- Omitted `operator` remains EQ. Values and field contents never become syntax.

## Supported operators and types

| Operator | Allowed field pairs |
| --- | --- |
| EQ, NE | Compatible scalar/enum pairs below; also a scalar-list left operand with a compatible scalar right operand |
| LT, LTE, GT, GTE | Numeric pairs; String/String; the same supported date/time scalar on both sides |
| LIKE, STARTS_WITH, ENDS_WITH | String/String, literal and case-sensitive |

With `valuePath`, ILIKE, ISTARTS_WITH, IENDS_WITH, IEQ, IIN, IN, NIN, BTW, CONTAINS_ALL, IS_EMPTY and IS_NOT_EMPTY fail with `INVALID_FILTER_OPERATOR` (400). Their literal behavior is unchanged.

Compatibility follows the effective base scalar, including validated scalars:

- Int/Float mix numerically.
- String/String equality and supported text predicates are exact and case-sensitive. Ordered String comparisons use PostgreSQL C collation or MongoDB's effective aggregate-command collation, as specified in the amendment below.
- Boolean/Boolean permits EQ/NE only.
- ID/ID permits EQ/NE only. Actual record identities are treated as identities even when declared String; this applies only to the new comparison form. MongoDB additionally validates compatible physical identity representations from the supplied/generated model (ObjectId, String or Number); mismatches fail rather than silently compare unrelated types. PostgreSQL uses its stored UUID identities.
- Enums must be the same GraphQL enum, EQ/NE only. Compare semantic members, accounting for a MongoDB state field storing names while another field stores internal values. Do not assume display names equal storage values. Reuse metadata/codecs and reject ambiguous unsupported storage representations rather than compare the wrong values.
- DateTime/Date/Time must match the same effective scalar; EQ/NE and ordered comparisons operate on instants, with the same precision as existing stored values.
- Any other pair is `INVALID_FILTER_VALUE` (400), naming both paths/types. Unsupported custom scalars need an existing effective supported base; no new custom coercion protocol is introduced.

Validation must retain logical enum identity and the original effective Date/Time/DateTime name; the current storage description collapses temporal scalars to DateTime and enum names to Enum. Resolve these from registered GraphQL types or preserve the needed logical identity in additive description metadata, without changing physical storage. Equal enum storage-value lists do not prove that two enum types are the same. A hand-built description lacking enough information for a new comparison must fail explicitly with `UNSUPPORTED_QUERY`, naming the missing type information, rather than guess. Exact metadata naming is a builder decision. Managed RecordVersion/Version is outside this part's supported comparison types; its existing literal filters remain unchanged.

## Nulls and lists

For scalar operands, missing and null normalize to null. EQ is true when both are null, false when just one is null; NE is its exact complement. Ordered and text comparisons are false if either is null. Empty strings are values: a string contains, starts with and ends with an empty string; null does not.

A scalar-list left operand supports EQ/NE against one scalar right operand. EQ means membership; NE is its complement. A null right operand matches a missing/null list or a list containing null, but not an empty list. A right scalar-list leaf always fails with `INVALID_FILTER_PATH`; ordered/text operators on a left scalar-list fail with `INVALID_FILTER_OPERATOR`.

Crossing an embedded list with either operand requires part 6 and fails with `UNSUPPORTED_QUERY` (400), including a scalar leaf or reference reached through that list. A scalar list inside a single embedded object is supported as a left operand because no element frame is needed. Whole objects/references/collections are not scalar operands; reference identities are named with `.id`/`._id` as permitted by the existing path rules.

Malformed stored values written outside the declared model are not silently coerced into a different semantic type. Implementation must document any engine limitation discovered while testing supplied models; it must not promise parity on arbitrary native corruption. Missing/null guards and legitimate nullable list elements are always in scope.

## Collection correlation and aggregate behavior

Preserve 3.16.0's group-local ANY normalization. All conditions on the same collection prefix in one group bind the same child. Separate groups may use separate children. Explicit ANY/ALL/NONE retains its current empty-set and two-valued semantics.

For a shorthand comparison, each collection prefix the right operand crosses must also occur on the left operand's chain; it binds to that exact child, not a second independent child. A right operand naming an unrelated collection or a deeper collection not bound by the left is `INVALID_FILTER_PATH`, with guidance to use an explicit group. The right operand alone must never introduce a new collection witness.

Examples in a Product root condition:

| Left | Right `valuePath` | Meaning |
| --- | --- | --- |
| `reviews.rating` | `reviews.maxRating` | One visible review compares its own two fields |
| `reviews.rating` | `stock` | A visible review compares its rating to the containing Product's stock |
| `reviews.rating` | `shop.minStock` | Same, with the Product's visible Shop operand |
| `reviews.rating` | `otherReviews.rating` | Reject: no binding connects the right collection |
| `stock` | `reviews.rating` | Reject: the right operand is not single-valued |

These outer reads are compiler-generated bindings. Public `$parent.stock` still fails in part 5. Normalize lexical operand origins before rewriting relation terms or moving scopes; stripping a collection prefix must not change the field an operand names. Nested common collection prefixes follow the same rule.

Aggregate J prefixes (collections crossed by group/fact paths) retain existing joined-row cardinality. A comparison is a pre-group row filter; both operands on the same J chain use the same joined row. A remaining collection outside J is a correlated frame anchored on that row. A right operand must not extend J, add a multiplying join, or introduce an independent collection. Counts and list pages keep one root per matching record. No HAVING, aggregate-result operand, sort expression or computed fact is added.

## Authorization, scopes and provenance

Both operand paths participate in `collectQueryPathEntries`/`collectQueryPaths`, with their absolute path, lexical origin, role and owning construct. The auth plugin checks read rules for every segment of both, including a right field omitted from the selection. Core rejects virtual/non-queryable client paths before middleware, and rejects trusted virtual reads under the existing stored-path policy. A right path must not bypass checks because the left is a simple scalar.

Comparisons are extended predicates. A client's single references on either side use scoped joins; a hidden/missing referenced record yields null. Comparison-only references do not create legacy group-level joined-scope restrictions. Existing literal filters, sorts, facts and grouping still use their established join behavior, even when combined with a comparison on the same path; join identities must keep trusted, legacy and scoped reads distinct.

Extend the existing per-resolver deep copies and `__scope` provenance to comparisons, including top-level field filters (which currently have no marked ordinary-predicate construct). An owning comparison needs the union of both sides' scoped targets, relative to the correct operand frame. Mark registered target scopes even when they later return no restrictions, and mark containing client frames as today. An outer operand's scope executes and joins in its outer frame, not in its child.

After middleware/query scopes: detect lost/rebuilt markers, unknown IDs, markers moved under trusted wrappers, changed J binding, incompatible target aliases and malformed metadata; validate final arguments; then fill fresh scope maps. Errors remain `DETACHED_CLIENT_FILTER` (500). Paths may be changed by trusted middleware under existing rules, but a retained marker must be refilled for every final operand it reads. Narrowing away all scoped relations may remove a marker; changing only the left side must not remove a right-side scope. Direct compiler/planner calls reject incomplete filled metadata.

Scopes supplied by trusted middleware and find/get_by_id/aggregate scopes read stored data without recursively adding target scopes, as today. Prefixing joined scopes must preserve both operands: a scope root comparison x/y becomes P.x/P.y, relation terms r.a/r.b become P.r.a/P.r.b, and explicit quantified bodies retain element-relative operands. Validate the original scope before prefixing, and the final query afterward. Cases that become embedded-list comparisons through the prefix fail with the staged unsupported error rather than dropping the comparison. Keep existing restrictions on scoped references inside embedded lists.

Scope execution remains once per resolver call and target type for the frame/scoped-join cache; legacy joined scopes retain their separate cache behavior. `maxReferenceFrames` counts the union of compiled scoped joins/frames needed by either operand in their actual frames, deduplicating shared reads; existing default 10 and `maxFrameNesting` default 3 remain. Generated implicit outer bindings add no extra frame by themselves. Named views retain separate author-where and client budgets and their existing trust rules.

## Capabilities and plan representation

Use the issue's proposed name: `queryFeatures.valuePath?: boolean | null`. Only literal true enables it. Undefined/null/false means unsupported. Invalid nonbooleans fail with the existing configuration error (`INVALID_QUERY_FEATURES` in core, `INVALID_SQL_PLUGIN` in SQL binding). Proposed dependency: valuePath true requires referenceEmptiness true, because the declaration includes scoped reference operands. It does not require quantifiers; a collection shorthand comparison additionally requires quantifiers and cannot fall back to a legacy multiplying join.

Bundled MongoDB/PostgreSQL declare it. SQL copies the flag only when the queryFeatures declaration describes the bound compileQuery, preserving the compiler-identity rule. Old/overridden plugins receive no new operand shape unless they declare support. Runtime gates client input before middleware and final trusted input before adapter calls; adapters/planners also gate their direct entry points. An otherwise valid comparison on an undeclared adapter gives `UNSUPPORTED_QUERY` (400).

Extend `createQueryPlan` options with valuePath using the same default rule as its existing feature flags (true with omitted operators, false with an explicitly supplied operator set, unless explicitly enabled). Preserve the old literal node shape byte-for-byte. Add an optional operand to an ordinary predicate:

```ts
type QueryOperand = { up: number; path: string[]; joins?: QueryJoins };
// Added to the existing predicate member:
// operand?: QueryOperand
```

When operand exists, the predicate compares its path with that field operand; value is a null placeholder, not a literal competing with it. `up` is zero for a direct same-frame comparison and positive only for bindings generated while normalizing shorthand. A hand-built plan must validate nonnegative integer depth, frame availability, path/type/list constraints, supported operators and complete scope metadata; it must not silently ignore an operand or fall back to literal comparison. Public GraphQL input never accepts up or joins.

The predicate's joins describe its left/current frame. The operand's joins describe its own frame when up is positive; at up zero use one union of both paths in the predicate's joins. This avoids confusing identically named paths from different frames. Share joins only when frame, target and scope chain are identical. The exact internal cache structures and helper names are left to the builder; keep the normalized meaning and public declarations explicit. No new not node is needed: reuse existing ALL/NONE negation handling.

Core may add a small internal comparison module, exported through the existing internal/query-operators surface, for operand presence, path/type validation and origin-preserving normalization. Avoid a second complete query IR or a MongoDB dependency in core/SQL. Synchronize root/subpath declarations and exact-type package consumer tests when exporting QueryOperand as a public plan type.

## Compiler requirements

MongoDB resolves both physical paths using model metadata, never a raw client string. Compare in `$expr` after required joins. Normalize missing/null via `$ifNull`; ordered comparisons must not inherit BSON cross-type/null ordering. Read outer bound values through safely allocated `$lookup.let` variables, defining them after outer reference joins and passing them across nested frames without alias capture. Preserve supplied-model identity mapping and enum/date storage semantics.

Text comparisons use literal code-point operations, not a regex assembled from stored text: `$indexOfCP` for contains/prefix, safe length/substr expressions for suffix. Protect operations with `$cond` branches, including a shorter left string, rather than relying on `$and` short-circuiting. This corrects section 6.2 of the original issue: [MongoDB documents that an expression after a false `$and` member may still error](https://www.mongodb.com/docs/manual/reference/operator/aggregation/and/); [`$cond` selects which result expression to evaluate](https://www.mongodb.com/docs/manual/reference/operator/aggregation/cond/). Constants in expression positions use `$literal` where appropriate. Invalid values never become pipeline operators.

PostgreSQL resolves both operands through the existing frame-aware path compiler. EQ/NE use null-safe distinctness; ordered/text predicates remain two-valued under negation. String operands use compatible C collation. Normalize native temporal columns and jsonb temporal leaves to comparable instants using existing helpers; do not compare epoch numbers to timestamptz or stringify numeric/Boolean values. Scalar-list membership is null-safe, including null array elements. Outer bindings reference the correct outer SQL alias; scoped joins remain owned by that frame. Values remain bound and identifiers quoted from metadata. Hand-built plans get the same structural guard before generating SQL.

`compileChildrenQuery` and both adapters' batching continue to reproduce individual child reads exactly. Frame alias/parameter allocation must work per UNION branch; keep PostgreSQL's existing transaction and JIT setup. Do not change adapter session ownership, write lifecycle, concurrency or transactions.

Do not promise that field comparisons use ordinary indexes or that they are always scans: verify representative plans. Recommend combining comparisons with selective literal filters and using an application-maintained derived field when a measured hot path needs indexing.

## Errors and compatibility

Keep existing diagnostics for literal-only queries and their precedence. For a new comparison: validate its carrier/group shape, mutual operand presence and valuePath syntax; resolve both paths and legal endpoints/origins; validate known and declared operators; validate operator/type/list compatibility; then capability/frame gates. Client permission/stored-path checks and final marker validation retain their existing lifecycle order. Multi-error requests may report one documented earlier error, but both engines must agree for the same single fault.

| Fault | Code |
| --- | --- |
| Both value and valuePath; non-string valuePath; incompatible types | INVALID_FILTER_VALUE |
| Empty/dotted-invalid path, public dollar prefix, unbound right collection/list, whole non-scalar endpoint | INVALID_FILTER_PATH (retain MISSING_FILTER_PATH for the existing bare left object case) |
| Unknown field | INVALID_FILTER_FIELD |
| Unsupported operator/pair or ordered comparison on scalar-list left | INVALID_FILTER_OPERATOR |
| Valid new form on undeclared adapter; comparison crossing embedded list | UNSUPPORTED_QUERY |
| Client non-queryable/virtual operand path | FORBIDDEN_FILTER_PATH (authorization read-rule denials retain FORBIDDEN) |
| Broken client provenance | DETACHED_CLIENT_FILTER |

The generated input addition is additive. No data migration or new index is required. A new capability field previously ignored by core becomes meaningful; document that custom declarations must be truthful and wrappers must redeclare their own compiler support. A trusted caller already writing valuePath into an untyped object may change from ignored metadata to validation/comparison: call out that compatibility change. Preserve every valid 3.16.0 literal filter's results, row counts and compilation unless a separate, demonstrated correction is explicitly approved.

## Documentation, clients and verification

Update root README and affected package READMEs; queries, query scopes, authorization, middleware, SQL plugin, API/error and compatibility references; MCP filter descriptions; application query/report guidance. Explain lexical origins, scope visibility, null/list semantics, unsupported part-6 paths and examples across all supported surfaces. The descriptor should expose the three new input fields through its existing schema traversal without a format-version bump. MCP must accept valuePath (including nullable optional fields), preserve it through local and SDL/remote execution, describe mutual exclusion, and report the same runtime error for both operands; do not mark the entire filter input as GraphQL oneOf.

Tests must cover:

1. Shared GraphQL/model validators and planners: supported type/operator matrix, missing/null/empty handling, value presence, invalid paths, scalar-list membership, capability defaults/dependencies and compiler override identity. Literal plan/pipeline snapshots remain stable.
2. Correlation: same child, different groups, nested collections, root/right reference reads, right sibling collection rejection, explicit quantifiers, empty frames, aggregate J anchors, list/count/page parity and no row multiplication.
3. Authorization: left/right-only denied paths; non-queryable/resolver/virtual fields; hidden/missing references; scoped chains on either side; mixed trusted/client/legacy conditions; both operands on one target; marker dropping/copying/moving, RHS-only edits, shared object positions, unknown keys and frame limits.
4. Runtime surfaces: generated GraphQL, server list/count/aggregate helpers, collection resolvers and batches, named-view where/client filters, find/get_by_id/aggregate scopes, joined-scope rewrites, direct Mongo builders, direct plans/PostgreSQL compilation.
5. Real databases: MongoDB 7 and 8 and PostgreSQL 15/16/18 via CI; disposable local MongoDB/PostgreSQL. Verify enums with nontrivial internal values and state names, date/time root versus jsonb/single-owned members, numeric and nullable types, supplied ID models, Unicode and metacharacter text, suffix longer than source, scalar arrays with null, references with scopes and sessions/batching.
6. Public clients: MCP generated/SDL tools, descriptor schema snapshots, NodeNext/Node16/Bundler/Node10 strict package consumers, root/subpath exact type parity, old plugin plans, no driver dependencies added to core/SQL.

Before PR: repository lint, full tests with disposable databases, packed consumer tests, security audit and docs build. Reuse #108 as the rationale link or create a focused follow-up only if tracking benefits; do not misrepresent its closed state as implementation evidence. Review with the repository simfinity-pr-review skill. No version bump/tag/publication is part of design approval by itself.

## Decisions for approval and builder discretion

Approval covers the existing #108 intent plus these explicit refinements for the current baseline: exclude embedded-list comparison until part 6; retain scalar-list EQ/NE; preserve lexical origins through internal outer bindings without public dollar syntax; use the valuePath capability name and referenceEmptiness dependency; treat identities as identities for the new form; extend provenance to both operands and top-level filters; and use guarded MongoDB conditional expressions instead of the original unsafe short-circuit assumption.

Helper names, file splits, cache representation, fixture organization and equivalent safe expression optimizations are builder decisions, subject to this contract and repository rules. If implementation evidence requires changing accepted inputs, null semantics, trust boundaries or supported storage types, bring that concrete difference back for a design amendment.

Builder check (2026-10-27): a fresh software-engineer reviewer read this design and the current query walkers, normalization, scope issuance/fill, planner and PostgreSQL compiler. Result: "nothing important left". This is a design-readiness check, not runtime verification or maintainer approval.

## Approved MongoDB collation amendment (2026-10-27)

The maintainer chose native MongoDB ordering with documented engine differences. This supersedes the earlier approved rejection of non-simple collations. For String `LT`/`LTE`/`GT`/`GTE`, MongoDB applies the effective aggregate-command collation, including to lookups and collection frames. PostgreSQL keeps explicit C collation. Both engines retain the existing null/type guards.

Three approaches were considered: forcing simple collation changes existing literal filters; rejecting non-simple or unknown collation preserves portable ordering but requires metadata reads and rejects otherwise executable queries; accepting native collation keeps the database configuration and removes that overhead. The maintainer selected the third approach and approved the documented difference between exact equality and locale ordering.

Remove collection/schema collation inspection, per-compilation command policy and Aggregate-option rejection. Do not set or override command collation. Mongoose schema options and application aggregate hooks/overrides continue to affect execution normally; direct raw-driver calls use their own operation options or collection default. Compilation requires no collection metadata access and works with an offline model.

Exact String EQ/NE, scalar-list membership, enum member decoding and the three text operators remain collation-independent. With `name: "A"`, `needle: "a"` and `{ locale: 'en', strength: 2 }`, `name EQ needle` is false, LT/GT are false and LTE/GTE are true. Locale strength and numericOrdering may also alter accent and digit-string ordering. Document this explicitly rather than promising cross-engine ordering parity. Preserve existing literal-filter behavior, authorization/scopes, null handling, all other unsupported-query errors and public interfaces.

Verify the native collection default, a declared schema collation, application Aggregate overrides (including removal of a schema declaration), the root command's effect through lookups/scopes, and every adapter read path including eligible child batches. Check the case/accent/numeric-order examples against real MongoDB, retain exact EQ/NE/text regressions, and prove compilation does not require metadata access.
