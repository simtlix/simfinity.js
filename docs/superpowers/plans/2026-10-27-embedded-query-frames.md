# Embedded Query Frames Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend `ANY`/`ALL`/`NONE` and field comparisons to embedded object lists, with structural `$parent` references inside embedded objects and elements.

**Architecture:** Core resolves embedded containment and produces validated element-relative predicates. MongoDB and PostgreSQL implement correlated witnesses using their existing metadata and storage, preserving scopes and outer row cardinality. Existing collection operands and serialized plans remain unchanged.

**Tech Stack:** ES modules, GraphQL 16, Vitest 4, Mongoose 8, MongoDB 7/8, PostgreSQL 15+; Node.js 24 for development.

**Spec:** `docs/superpowers/specs/2026-10-27-embedded-query-frames-design.md`

## Global Constraints

- `$parent` belongs to embedded containment only; `$root` is excluded.
- Missing lists, null lists, `[]` and `[null]` contain no elements. An empty object `{}` is an element.
- `ANY` is false and `ALL`/`NONE` are true without elements. `ALL` negates the complete two-valued body.
- Preserve the meaning of the existing `QueryOperand.up` and the serialized shape of existing plans.
- Core/SQL stay driver-free. No DDL changes, synthetic parent fields, new dependencies or embedded selection arguments.
- Filters select records and do not trim returned embedded arrays. Existing literal behavior and aggregate cardinality stay unchanged.
- `elementFrames: true` requires `quantifiers`, `referenceEmptiness` and `valuePath` all true; undeclared compilers reject valid new forms.
- Development is isolated on `codex/embedded-query-frames`. Publication is a later explicitly authorized action.

## Review Focus

- A missing intermediate single embedded object still supplies null operands, without adding an existence test (tasks 1, 3, 4).
- Repeated equal elements and embedded IDs disabled must preserve the exact selected outer element (tasks 3, 4, 5).
- A copied compiler must not inherit a capability its replacement did not declare (task 2).
- Middleware copies and shared filter-object aliases must preserve lexical origins and authorization on parent-only fields (task 2).
- An aggregate's already-bound collection row must survive embedded filtering without multiplying facts or rebinding a sibling row (tasks 3, 4, 5).

## Files and interfaces

Extend `query-frames.js` and `query-plan.js`, factoring their schema context resolution into internal `packages/core/src/query-context.js` so validation, normalization, path collection and planning share one definition. Keep public exports stable. Extend the existing MongoDB query compiler and PostgreSQL query compiler rather than adding a second query engine.

An internal context supports either GraphQL types or portable model fields, a structural `parent`, an absolute field path, and a binding `{ depth, path }`. `depth` counts actual quantified frames, while `path` addresses a single object from that frame. References/collections clear structural ancestry. Entering a quantified list resets the element's binding to its new depth but retains the containing objects' bindings.

New plan operands may add `container: { up: number, path: string[] }` to the existing `{ up, path, joins? }`. For structural operands the outer `up` is zero; `container.up` addresses a bound quantified ancestor, and `container.path` addresses the embedded containing object within that bound frame. The operand's `path` then addresses its scalar field. Example: in `ANY envio.lineas`, `$parent.limit` becomes `{ up: 0, path: ['limit'], container: { up: 1, path: ['envio'] } }`; two parents use `container.path: []`. Existing collection `up` operands do not gain this property. Validation must prove that the container is in the resolved structural chain, including after implicit normalization; it must not accept arbitrary outer joins.

### Task 1: Core containment, normalization and plan contract

**Files:**
- Create: `packages/core/src/query-context.js`, `tests/query-element-frames.test.js`
- Modify: `packages/core/src/query-comparisons.js`, `packages/core/src/query-frames.js`, `packages/core/src/query-plan.js`, `packages/core/types/index.d.ts`
- Test: `tests/query-field-comparisons.test.js`, `tests/query-field-comparison-plans.test.js`, `tests/query-plan.test.js`

**Interfaces:**
- Consumes: GraphQL `graphqlStep` / portable `modelStep`, existing comparison type rules and quantified group input shapes.
- Produces: `resolveQueryContext(path, context, options?) -> { steps, raw, end }`, `enterQueryFrame(context, path) -> context`, `resolveComparisonContext(valuePath, context, prefix?) -> { resolved, container? }` in `query-context.js`. A context retains model/type identity, structural ancestry, absolute paths and binding depth/path. Invalid paths use existing Simfinity errors.
- Produces: `createQueryPlan(..., { elementFrames })` with embedded-local predicates and the additive `QueryOperand.container` above. Existing `resolveModelPath` remains compatible; it may accept local fields internally without treating embedded types as entities.

- [x] **Step 1: Add failing public validation/plan cases.** Assert `ANY envio.lineas` accepts local `cantidad LTE maxCantidad`, resolves one parent to Envio and two to Pedido, and rejects root `$parent`, `$root`, entity-boundary crossings and three parents. Assert dotted operands bind the same element, right-only arrays reject, and implicit `NE` differs from explicit `ANY NE`. Include nullable single embedded terms, field-form quantifiers and repeated normalization.
- [x] **Step 2: Run the new tests.** Run `npm test -- tests/query-element-frames.test.js`; expect failure because embedded frames and dollar paths are currently rejected.
- [x] **Step 3: Implement the shared context and additive plan contract.** Preserve source carrier origin before rewriting, retain intermediate single containers, normalize implicit embedded comparisons independently instead of coalescing separate legacy conditions, and extend frame budgets. Validate direct internal operands against actual ancestry. Keep old plans byte-for-byte equivalent for old inputs.
- [x] **Step 4: Verify core cases.** Run `npm test -- tests/query-element-frames.test.js tests/query-field-comparisons.test.js tests/query-field-comparison-plans.test.js tests/query-plan.test.js`; expect all passing, including prior literal and collection correlation cases.
- [x] **Step 5: Commit core resolution and tests.** Commit as `feat(core): resolve embedded query frames and parent operands`.

### Task 2: Capability, runtime scopes and provenance

**Files:**
- Modify: `packages/core/src/query-operators.js`, `packages/core/src/runtime.js`, `packages/core/src/query-plan.js`, `packages/sql/src/plugin.js`, `packages/sql/src/adapter.js`, `packages/core/types/index.d.ts`
- Create: `tests/query-element-frame-runtime.test.js`
- Test: `tests/query-field-comparison-runtime.test.js`, `tests/query-path-authorization.test.js`, `tests/sql-plugin.test.js`

**Interfaces:**
- Consumes: task 1 context resolution and `QueryOperand.container`.
- Produces: validated effective `QueryFeatures.elementFrames`; path collectors and runtime scope preparation resolve both operands to real absolute field paths. SQL passes the effective flag to every root/child/batch plan.

- [x] **Step 1: Add failing capability and execution-boundary tests.** Undeclared support returns `UNSUPPORTED_QUERY`; invalid flag/dependencies fail startup; compiler replacement loses inherited support. A read rule denying only the parent RHS rejects the query. A hidden referenced target reads as missing inside the element. Scope callbacks start at their registered type, cannot capture the caller, and may use their own embedded parents. Middleware cloning preserves results; detached restrictions retain `DETACHED_CLIENT_FILTER`.
- [x] **Step 2: Run `npm test -- tests/query-element-frame-runtime.test.js tests/sql-plugin.test.js`.** Expect the new cases to fail at capability/origin handling.
- [x] **Step 3: Implement capability validation and origin-aware path collection.** Reuse task 1 resolution in provenance and scope filling; retain every real reference crossing in both paths. Lift vector restrictions only for bound element contexts that the compilers will handle. Preserve named-view, get-by-ID, aggregate, session and batching behavior.
- [x] **Step 4: Run `npm test -- tests/query-element-frame-runtime.test.js tests/query-field-comparison-runtime.test.js tests/query-path-authorization.test.js tests/sql-plugin.test.js`.** Expect all passing. Add an aliased filter used at two depths to catch accidental context memo reuse.
- [x] **Step 5: Commit as `feat(core): preserve scoped embedded query operands`**.

### Task 3: MongoDB execution

**Files:**
- Modify: `packages/mongodb/src/mongo/queries.js`, `packages/mongodb/src/mongo/adapter.js`
- Create: `tests/element-frames-mongodb.test.js`
- Test: `tests/field-comparisons-mongodb.test.js`, `tests/mongodb-collection-batching.test.js`

**Interfaces:**
- Consumes: validated element groups, structural operands and client scope provenance from tasks 1–2.
- Produces: correlated element witnesses in existing `buildQueries` compilation, plus bundled `elementFrames: true` after all paths are supported.

- [x] **Step 1: Add failing real MongoDB cases.** Use a disposable database per configured replica/standalone URI. Hand-derived fixtures: limit 10 and quantities `[3,8]`, `[3,12]`, `[12]`, `[null]`, empty/missing/null arrays and null elements; assert exact ANY/ALL/NONE ID sets. Add duplicate equal objects, nested lists, `_id: false`, nullable single objects, supplied storage aliases, reference scopes and parent-reference scopes.
- [x] **Step 2: Run `npm test -- tests/element-frames-mongodb.test.js` with disposable MongoDB URIs.** Expect new valid queries to fail before execution support. Missing URIs/skips are not a RED result.
- [x] **Step 3: Implement correlated embedded witnesses.** Keep the outer record stream intact. Use the nearest stored entity and exact element positions when a witness requires lookups, retaining containing values for operands; do not treat embedded types as models. Use the existing two-valued comparison and safe-string lowering. Compile ALL as absence of a complete-body counterexample. Native collation behavior stays unchanged.
- [x] **Step 4: Verify real MongoDB execution and regressions.** Run `npm test -- tests/element-frames-mongodb.test.js tests/field-comparisons-mongodb.test.js tests/mongodb-collection-batching.test.js`; expect all applicable cases passing for replica/standalone. Pin aggregate collection anchors and no multiplying outer unwind, and compare child batches to individual reads.
- [x] **Step 5: Commit as `feat(mongodb): execute correlated embedded query frames`**.

### Task 4: PostgreSQL JSONB and owned storage execution

**Files:**
- Modify: `packages/postgres/src/query/compiler.js`, `packages/postgres/src/plugin.js`
- Create: `tests/element-frames-postgres.test.js`, `tests/integration/element-frames-postgres.test.js`
- Test: `tests/field-comparisons-postgres.test.js`, `tests/integration/field-comparisons-postgres.test.js`, `tests/postgres-collection-batching.test.js`

**Interfaces:**
- Consumes: portable element plans and `QueryOperand.container` from tasks 1–2.
- Produces: existing `compileQuery`/`compileChildrenQuery` statements for element frames across JSONB, inline and owned storage; plugin declares `elementFrames: true` only with complete execution.

- [ ] **Step 1: Add failing compiler and real database tests.** Apply the task 3 literal ID expectations to logical models stored as JSONB and owned tables. Cover owner keys, null item presence, duplicate positions, inline→owned→JSONB containers, scoped references, temporal/enum codecs, aggregate J rows and child batches.
- [ ] **Step 2: Run `npm test -- tests/element-frames-postgres.test.js tests/integration/element-frames-postgres.test.js` with a disposable PostgreSQL URI.** Expect embedded plan rejection/execution failures; verify tests actually execute.
- [ ] **Step 3: Extend existing frame/path compilation.** Use correlated guarded `jsonb_array_elements` sources or owned rows filtered by owner/presence. Resolve `container` against the retained bound context without changing legacy `up`. Reuse reference joins and codecs inside witnesses; ALL uses the complete two-valued predicate. Do not add schema tables or columns.
- [ ] **Step 4: Run the task's five test files.** Expect all passing. Confirm physical schema golden tests remain unchanged and batch setup still uses `SET LOCAL jit = off` with the existing transaction contract.
- [ ] **Step 5: Commit as `feat(postgres): execute embedded frames across storage layouts`**.

### Task 5: Cross-engine API and security acceptance

**Files:**
- Create: `tests/helpers/element-frames.js`, `tests/integration/element-frames-parity.test.js`
- Modify as needed: `tests/mcp-field-comparisons.test.js`, `tests/client-descriptor-backends.test.js`, `scripts/test-packages.js`, relevant packed fixtures under `tests/fixtures/`
- Test: `tests/integration/embedded-query-parity.test.js`, `tests/core-subpath-types.test.js`

**Interfaces:**
- Consumes: complete core/runtime and both bundled compilers.
- Produces: common hand-derived fixtures and exact public GraphQL/MCP result assertions, without substituting a memory adapter for database execution.

- [ ] **Step 1: Add acceptance tests before any remaining fixes.** Run the same queries through lists, counts, pagination, aggregates, selected collection arguments (batch on/off), named views, trusted scopes and MCP. Assert complete result objects, untrimmed arrays, no fact multiplication, target-scope admission and rejection of root/selection-owner `$parent`. Include same-element two-condition counterexamples and scalar-list operators inside elements.
- [ ] **Step 2: Run `npm test -- tests/integration/element-frames-parity.test.js tests/mcp-field-comparisons.test.js tests/client-descriptor-backends.test.js tests/core-subpath-types.test.js`.** Diagnose any mismatch with a reproducer before fixing it. Expect both actual engines to pass the common assertions.
- [ ] **Step 3: Extend packed TypeScript consumers for the capability and container operand.** Compile existing subpath/root aliases without changing export identity; run `npm run test:packages` and expect all consumers/archive checks passing.
- [ ] **Step 4: Verify the legacy embedded fixture in a non-UTC timezone.** Run `TZ=America/New_York npm test -- tests/integration/embedded-query-parity.test.js tests/integration/element-frames-parity.test.js`; expect all applicable database cases passing.
- [ ] **Step 5: Commit as `test: verify embedded frame parity and read contracts`**.

### Task 6: Documentation, full verification and review delivery

**Files:**
- Modify: `README.md`, affected `packages/*/README.md`, `docs/guide/queries.md`, `docs/guide/scopes.md`, `docs/guide/middleware.md`, `docs/reference/api.md`, relevant SQL/plugin/auth/errors/MCP/descriptor guides identified by `rg 'valuePath|quantifiers' docs`, `.cursor/rules/simfinity-testing.mdc`, `.agents/skills/simfinity-queries-and-reports/SKILL.md` and its relevant references.

**Interfaces:**
- Consumes: verified behavior from tasks 1–5.
- Produces: public examples matching the design, clear capability/IR contracts, verification evidence and a reviewed implementation PR linked to issue #108.

- [ ] **Step 1: Update public docs and guidance.** Use the order/line model; explain one/two structural parents, entity boundary stops, null/empty truth table, scopes, local versus dotted comparisons and no array projection trimming. Preserve existing collation notes. Do not describe unpublished functionality as available in 3.17.0.
- [ ] **Step 2: Run full verification.** `npm run lint`, `npm test` with disposable contract/test MongoDB, standalone MongoDB and PostgreSQL URIs, `npm run test:security`, `npm run test:packages`, `npm run docs:install`, `npm run docs:build`, and `node scripts/release-packages.js check`; expect each exit code zero. Read the summary and explain every skip; test setup must remove only its disposable resources.
- [ ] **Step 3: Commit docs and verification-related fixes.** Commit as `docs: document embedded quantifiers and parent comparisons`.
- [ ] **Step 4: Request a fresh whole-branch review with the repository PR review skill.** Review core semantics, both engines, scopes, compatibility and the Review Focus cases. Reproduce consequential findings with failing tests, fix them and rerun affected checks.
- [ ] **Step 5: Deliver a reviewable PR.** Link issue #108 with its remaining motivation and the design. Include exact verification results; attach the created PR to this chat. Keep new publication outside this task unless the maintainer explicitly requests it.
