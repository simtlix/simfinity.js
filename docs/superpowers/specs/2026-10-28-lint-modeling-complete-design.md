# Complete the modeling lint catalogue (#116)

## Intent and authorization

The user requests completing all of #116 before integration. They have also
authorized publishing each integrated linter delivery. Extend the independently
versioned optional ESLint plugin; keep the six runtime packages unchanged.
The existing 0.4.0 delivery covers only parts of MOD-03 and MOD-21.

This design records implementation decisions within the catalogue's existing
contract. The user has authorized execution of the whole catalogue, integration
and publication; do not re-request permission for those same actions.

## Approach

Extend the existing bounded local analyzer with runtime identity, backend proof,
GraphQL type descriptors and ordered schema events. Add three cohesive error
rules (`valid-model-fields`, `valid-model-storage`, `valid-model-schema`) and an
opt-in `modeling-advice` rule. Extend `valid-connection-field` and
`no-schema-cloning` instead of duplicating them. Keep `recommended-3.8` for proven
errors and provide `advice-3.8` for contextual warnings.

Alternatives considered: one rule per catalogue entry duplicates graph analysis
and fragments configuration; executing consumers or loading their runtime would
violate the static-analysis contract. Whole-program inference is inappropriate
for an optional local linter. Use the existing ESM, constant-alias and simple
field-thunk proof model, with explicitly documented additional finite syntax.

## Constraints

- Target the explicit Simfinity 3.8.0 contract; revalidate with current runtime
  fixtures without claiming universal support for every later feature.
- Do not load application modules, execute getters/thunks/validators, connect to
  databases, or add runtime/driver dependencies to the plugin.
- Unknown values, mutations, escapes, dynamic bootstraps and unsupported syntax
  stay unknown. Absence needs a complete local proof; positive contradictions
  can be reported without pretending the entire application is known.
- Keep exact binding/runtime/type identities and ordered events. Registration
  lookup is by GraphQL type name where the runtime uses names.
- Mongo's default integrity remains off. SQL and explicitly transactional Mongo
  share storage-metadata checks. Supplied Mongo models and custom hooks are not
  evidence of generated storage or missing live constraints.
- No automatic permission, storage, registration, exposure or transaction edits.
- All new errors need positive/negative fixtures and runtime evidence. Advice
  describes an accepted behavior or intent question and remains opt-in.
- Preserve the existing alias bound of 40 and type graph bound of 200; add finite
  event/field traversal limits and fail closed when a required proof is truncated.

## Candidate acceptance matrix

| Candidate | Delivered check and required exceptions |
| --- | --- |
| MOD-01 | Advice for misplaced known field metadata; unrelated custom metadata remains valid. |
| MOD-02 | Storage error for missing object relation metadata in SQL/transactional Mongo; advice for input/mapping omissions where core/Mongo accepts the declaration. Valid virtual/output-only types stay exempt. |
| MOD-03 | Existing link syntax checks plus all proven storage-mode missing-link variants. Advice for exactly one of readOnly/own resolver outside metadata mode; both together are accepted. Private inverse fields and whitespace links remain legal. |
| MOD-04 | At a proven schema build, missing required target registration by name in a fresh closed local runtime; imported singleton/incomplete bootstrap cannot prove absence. ReadOnly + own-resolver collections and readOnly embedded outputs remain legal. |
| MOD-05 | Conflicting inverse aliases, wrong target/kind, or distinct parents claiming one inferred inverse in metadata mode. Singular IDs infer references; absent fields synthesize private links. |
| MOD-06 | Metadata-mode collection link names a child collection. Explicit link entities and Mongo-off collection patterns stay legal. |
| MOD-07 | Metadata storage-name collision; contextual generated-Mongo overwrite advice. Collections occupy no parent storage slot. |
| MOD-08 | Reachable storage or writable-input embedded cycles, with distinct traversal rules. ReadOnly breaks input recursion but not generated/storage recursion; sibling reuse and all-supplied Mongo models remain valid. |
| MOD-09 | Unsupported nested storage/input lists. Core readOnly/virtual outputs and nested abstract output lists remain legal; own resolver alone does not exempt writable scalar/object nested inputs. |
| MOD-10 | Metadata-mode nonembedded collection inside an embedded value. Singular references and embedded lists remain supported. |
| MOD-11 | Unsupported stored interfaces/unions in metadata mode; contextual generated-input omission advice. Independent GraphQL output types remain legal. |
| MOD-12 | Unsupported/cyclic storage scalar bases, with factory and static hint provenance. Mongo uses identity and date-name fallback; SQL metadata uses supported names and rejects cycles. Never execute scalar callbacks. |
| MOD-13 | Metadata enum string collisions between distinct primitive internal values. Preserve same-value aliases, default/undefined entry names and Object.is semantics; never invoke object conversion. |
| MOD-14 | Invalid index field arrays in metadata mode and unsupported stored index targets in SQL. GraphQL names/storage aliases are accepted; native Mongo indexes are outside the check. |
| MOD-15 | SQL entity identity shape and reserved physical private columns. Embedded JSON keys and owned embedded IDs do not inherit entity-root restrictions. |
| MOD-16 | Generated Mongo constructor/prototype-name storage failures and synthesized private constructor links. Aliased references, other prototype scalar fields, embedded type and supplied models remain legal where runtime permits. |
| MOD-17 | SQL whole-embedded uniqueness error; generated-Mongo ignored unique advice. SQL scalar lists and manual/native constraints remain valid. |
| MOD-18 | Advice for known nonboolean nonnullish flags, preserving truthiness/exact-boolean differences and unknowns. |
| MOD-19 | Required embedded empty-create projection reachable from included generated mutation roots is an error. Empty create/update/added projections otherwise give contextual omission advice; preserve update IDs and deleted collections. |
| MOD-20 | Ordered reuse of runtime-bound generated/reserved relation fields across runtimes, including safely proven field copies. Sharing unbound types, same-runtime rebuilds, interface fields and resolver-cleared copies remains legal. |
| MOD-21 | Existing schema cloners plus proven same-process post-import introspection reconstruction. Arbitrary external introspection, pre-import schemas and legal toConfig copies stay unknown/accepted. |
| MOD-22 | Advice for stateMachine field flags without a proven registered machine; SQL error for a present non-enum state field with a machine. Missing state and enum lists are accepted. |
| MOD-23 | Advice for shared entity/embedded identity when a declared id has no own resolver and build/identity proof exists. Reuse is legal; do not claim a data-independent corruption. |

## Shared analysis interface

`buildModelGraph(context)` returns one cached, read-only-by-convention graph per
ESLint SourceCode. The implementation modules must not mutate its descriptors.

- `analysis`: existing `origin`, `resolve`, `properties`, `value` plus stable
  provenance helpers. Existing rule behavior remains compatible.
- `type(input)`: stable descriptor or null. Descriptor members: `node`, `kind`
  (`object`, `scalar`, `enum`, `interface`, `union`, `list`, `nonNull`), `name`
  (string or null), `config`, `fields` (Map or null), `item`, `base`, `builtin`.
- `shape(typeOrInput)`: `{ named, listDepth, nonNull, itemNonNull }` or null.
- Field descriptor: `name`, `node`, `config`, `extensions`, `relation`, `type`,
  `readOnly`, `resolve`, `virtual`, `embedded`, `connection`. Metadata values are
  `{ known, value }`; absent differs from unknown. `virtual` is true/false/null.
- `constant(node)`: safe primitive/truthiness value; absent is known undefined.
  `property(map,key)`: known undefined for an absent key, unknown for unknown map.
- `calls`: all bounded AST call nodes, in source order. `registrations`: records
  `{ node, runtime, type, endpoint, model, onModelCreated, stateMachine }`.
- Runtime: `{ key, engine, integrity, fresh, node }`; key is a canonical facade
  name or factory AST node. Engine is core/mongo/sql/postgres/unknown.
- `builds`: `{ node, runtime }` schema calls. `registrationsFor(runtime, before)`
  returns name-replaced records before an optional source position. Unknown
  registrations are retained so absence proofs can reject incomplete snapshots.
- `metadata(runtime)`: true for SQL/Postgres or transactional Mongo.
- `entities(runtime, registrations)`: known endpoint roots plus nonembedded
  object reference closure, with a finite bound. `generated(reg, registrations)`
  returns true/false/null for actual Mongo model generation including needsModel.
- `block(node)`: enclosing direct straight-line Program/BlockStatement or null;
  `closed(build)` verifies the local fresh-runtime prefix used for absence/order
  diagnostics. Conditional/imported/escaped or unknown registrations fail closed.
- `types`: bounded interned descriptors; `truncated` invalidates proofs that need
  a complete graph. Scalar hint and safe field-copy details are documented in
  source with their own mutation/order regression fixtures.

Each domain module exports `messages` and `inspect(graph)`, returning
`{ errors, warnings }`. Diagnostics contain `node`, `messageId`, optional `data`.
Message IDs are prefixed `field`, `storage`, or `schema` to compose advice safely.
`makeModelRule(name, description, messages, inspect, mode)` wraps reporting and
deduplicates repeated evidence. Only the coordinator edits public plugin exports,
presets, declarations, shared analysis, aggregate advice and shared consumers.

## Completion

Map all 23 candidates to implemented messages and tests in the public guide.
Do not close #116 based only on an example for each candidate: audit all the
specified accepted alternatives and engine/context variants. Run plugin tests,
audit, packed JS/TS consumers, both Barber trials, root lint/tests and docs build.
Obtain an independent whole-branch review and passing CI, then merge. Publish the
plugin through its separate preview/tag/OIDC/release/docs flow and verify actual
registry bytes, latest tag, release assets and the deployed guide. Update #116
and #112 accurately; runtime packages are not versioned or released by this work.
