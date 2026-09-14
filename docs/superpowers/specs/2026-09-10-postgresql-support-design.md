# PostgreSQL support: design proposal and delivery plan

Status: draft for architectural review; no implementation is included. Automatic, database-enforced foreign-key generation is a required feature.

Repository baseline: `@simtlix/simfinity-js` 3.0.1, commit `c850238`, inspected on 2026-09-10.

## 1. Recommendation

Extract the Simfinity engine into a database-independent core, keep the existing package as the MongoDB entry point, and publish a separate PostgreSQL entry point. Both use the same GraphQL schema builder and operation lifecycle. Each binds its database adapter once when the application starts.

Use PostgreSQL tables and typed columns for entities, with actual foreign-key constraints for every declared reference. Embedded values without references can use JSONB; embedded structures containing references use generated owned tables so their references also receive real FKs. Generate storage from the existing `GraphQLObjectType` definitions and `extensions`; applications should not maintain a second ORM model definition.

Use `pg` directly behind the PostgreSQL adapter. Simfinity already supplies the model metadata, validation, relationship semantics, and query language; adding a full ORM would introduce another representation to reconcile. This is an architectural recommendation, not a claim that the SQL compiler is trivial.

The compatibility target is the Simfinity application contract: GraphQL operations, input/output types, filters, scopes, middleware, validation, state machines, and controller lifecycle. Mongoose models, documents, sessions, and raw MongoDB pipelines remain database-specific integration points.

**Working assumption awaiting user feedback:** applications choosing PostgreSQL can adapt code that directly uses Mongoose. Exact Mongoose method compatibility is not part of this proposal. Supporting it would be a separate, substantial project.

## 2. Requirements and boundaries

- Select MongoDB or PostgreSQL for an application at setup time; do not support changing adapters after registration or while serving requests.
- Keep existing MongoDB imports and normal registration calls working.
- Keep the generated GraphQL names and shapes, including `QLFilter`, `QLTypeFilterExpression`, `QLFilterGroup`, pagination, sorting, aggregation, and nested mutation inputs.
- Preserve `extensions.scope.find`, `get_by_id`, and `aggregate` callback signatures and the sequence of middleware, scope, and execution.
- Keep `extensions.relation`, `readOnly`, `unique`, and validation metadata as the application-facing schema language.
- Generate and validate actual PostgreSQL foreign-key constraints for every declared reference, including one-to-many inverses, both ends of many-to-many linking entities, and references inside embedded values. Index creation alone does not satisfy this requirement.
- Preserve application API shapes while enforcing referential integrity in PostgreSQL. Dangling-reference writes and deletes that leave dangling references are rejected; this is an intentional storage guarantee.
- Generate storage objects in an already provisioned database. Database-server provisioning, users, credentials, and `CREATE DATABASE` are outside this feature.
- Support initial schema creation and validation of an existing schema. Evolving an application's schema remains necessary even when its database choice never changes.
- Keep the PostgreSQL dependency tree free of Mongoose and the MongoDB driver; keep the MongoDB tree free of PostgreSQL drivers.
- Do not require data migration between MongoDB and PostgreSQL, dual writes, cross-database joins, or multiple adapters in one application runtime.
- Retain ES modules, top-level imports, GraphQL 16 compatibility, and the published Node.js runtime floor of `>=18.18.0` unless a separate version decision changes it.
- Preserve in-place Envelop resolver wrapping. Do not rebuild the schema using `mapSchema` or `applyMiddleware`.

## 3. What the current project actually does

The engine is concentrated in the 2,006-line `src/index.js`. PostgreSQL support requires extracting persistence responsibilities from several flows, not replacing one connection call.

| Area | Current implementation | Consequence for the design |
| --- | --- | --- |
| Registration | `connect()` stores model/type/controller/state-machine metadata in module globals; `addNoEndpointType()` uses a separate endpoint flag | Keep registration semantics; move mutable registries into the internal runtime object |
| Schema creation | `createSchema()` generates Mongoose models, attaches relation resolvers, then builds queries and mutations | Separate synchronous GraphQL construction from asynchronous storage readiness |
| Models | `generateSchemaDefinition()` maps GraphQL fields to Mongoose types; ObjectId paths receive indexes | Introduce an independent entity/field/relation description, then two storage mappings |
| Queries | `buildQuery()` emits `$lookup`, `$unwind`, `$match`, `$sort`, `$skip`, and `$limit` | Share argument normalization and semantics; compile separately to MongoDB and SQL |
| Aggregations | `buildAggregationQuery()` adds `$group` and projects `{ groupId, facts }` | Preserve result shape, grouping, aggregate values, and ordering |
| Writes | `materializeModel()` mixes validation and nested-write discovery with ObjectId construction; mutation handlers instantiate Mongoose documents | Keep the lifecycle in core; delegate IDs, record preparation, and persistence |
| Transactions | Generated and custom mutations use `withTransaction()` with at most five transient retries after the initial attempt | Put transaction ownership, native sessions, and retry classification behind the adapter |
| Controllers | `onSaving` receives a Mongoose document; other callbacks receive plain records, update data, or currently a query thenable | Names and argument positions can stay; native object capabilities cannot be universally portable |
| Scopes | Root find/get/aggregate resolvers execute scopes; generated relation resolvers do not | Preserve the existing scope boundary in the extraction; decide any expanded coverage explicitly |
| Authorization | `src/auth/` wraps resolvers and evaluates rules independently of storage | Reuse without a second authorization implementation |
| Scalars | `src/scalars.js` imports its factory from `src/index.js` | Break this import cycle while extracting the core so scalar imports do not pull in Mongoose |
| MCP | `src/mcp.js` derives tools from the executable GraphQL schema and executes GraphQL | Reuse the same generation/execution paths for both databases |
| Public escape hatches | `getModel()`, `connect(existingModel, ...)`, `onModelCreated`, `buildQuery()`, and `buildFilterGroupMatch()` expose MongoDB concepts | Keep the legacy MongoDB exports; explicitly document adapter-specific APIs |

Code anchors in the inspected revision:

- `src/index.js:476`: input-type generation.
- `src/index.js:637`: materialization and validation.
- `src/index.js:721`: transaction wrapper.
- `src/index.js:791`: update lifecycle and embedded updates.
- `src/index.js:892`: programmatic `saveObject()`.
- `src/index.js:971`: scope dispatcher.
- `src/index.js:1126`: storage schema generation.
- `src/index.js:1412`: logical filter compilation.
- `src/index.js:1567`: list-query compilation.
- `src/index.js:1700`: root-query generation.
- `src/index.js:1803`: `createSchema()`.
- `src/index.js:1853`: generated relationship resolvers.
- `types/index.d.ts:347`: public model registration signature.

The entry point currently has named exports and **no default export**. New examples must use namespace or named imports even though some older README examples imply otherwise. The root query type is named `RootQueryType`; preserving it matters for permission maps.

### Verified baseline and limitations

- `npm test`: 14 test files passed, 329 tests passed.
- `npm run lint`: passed.
- Existing persistence tests largely inspect schema metadata, generated pipelines, or mocked Mongoose calls. They do not establish real database equivalence. PostgreSQL must additionally pass FK enforcement tests that MongoDB cannot supply.
- No MongoDB or PostgreSQL server was used for this investigation. Database result semantics still need the integration suite described below.
- The current CI workflow requests Node 14, while the installed Vitest 4.1.9 requires Node 20, 22, or 24+. The implementation must correct CI and separately check the package's minimum runtime compatibility.

### Existing discrepancies that affect the compatibility contract

These are findings, not changes made by this proposal:

1. **Repeated flat relation terms can overwrite earlier terms.** A read-only probe with `author.name = Alice` and `author.id = ...` produced a match containing only the ID. Conditions in logical groups use a different accumulation path.
2. **Generated child resolvers bypass child scopes and Simfinity middleware.** A mocked child collection read invoked the child's scope zero times. Field authorization plugins can still wrap those resolvers.
3. **Collection filters expand root rows.** The generated pipeline uses `$lookup` plus `$unwind` without regrouping roots. Several matching children can therefore duplicate parents and affect pagination, counts, and aggregate facts. This follows from pipeline inspection and needs a real-data fixture.
4. **`onUpdated` runs before the update thenable is awaited.** A probe recorded the hook before query execution, with the query thenable as its argument, contrary to the documented updated-document contract.
5. **Relation storage defaults are inconsistent.** Model generation and reads default `connectionField` to the field name, but materialization indexes it directly. A probe saving a reference without an explicit connection field retained only `_id` in the parent document. Clearing a relation also currently uses the GraphQL field name rather than necessarily its storage name.
6. **A referenced no-endpoint type with only scalar fields receives no model.** The current heuristic looks at its own relation fields, not inbound references. A probe returned `null` from `getModel()` for that type.
7. **Required GraphQL fields are not automatically required in Mongoose.** A probe confirmed `GraphQLNonNull(String)` did not create a storage `required` constraint. Automatically adding PostgreSQL `NOT NULL` everywhere would strengthen behavior.
8. **`saveObject()` does not open a transaction itself.** It calls the save handler directly, despite the declaration comment describing transactional persistence. It can participate in a supplied session.
9. **Empty strings are treated as absent by materialization**, while `false` and `0` are retained. Omitted array fields can receive Mongoose's empty-array defaults. These need explicit fixtures.

Recommended disposition: establish a written compatibility ledger in the first delivery phase. Fix documented defects such as relation defaults, dropped filter terms, no-endpoint model detection, and update-hook timing in separately reviewable changes applied to the shared behavior. Preserve existing scope coverage, collection multiplicity, and standalone `saveObject()` transaction behavior unless a specific versioned change is approved. Do not make PostgreSQL alone silently correct these behaviors.

## 4. Architecture alternatives

| Approach | Benefits | Costs | Recommendation |
| --- | --- | --- | --- |
| Shared core, separate database entry points | One definition of APIs and lifecycle; separate driver dependencies; straightforward install-time choice | Requires extracting the persistence boundary and building a SQL compiler | **Choose this** |
| Independent PostgreSQL fork | Initially avoids changing the MongoDB package | Duplicates fixes, schema generation, scopes, input rules, and MCP behavior; semantic drift becomes likely | Avoid as the maintained design |
| PostgreSQL as a generic JSONB document store with a Mongo-like facade | Keeps document storage close to today's representation | Still needs query and transaction translation; weakens generated relational schema; Mongoose emulation becomes another major subsystem | Only reconsider if document-first storage is the actual requirement |

Keep one repository initially, using npm workspaces, so both adapters and shared tests can change together. Separate published libraries do not require separate repositories.

### Proposed package graph

```text
Application choosing MongoDB
  @simtlix/simfinity-js       [existing package name]
    @simtlix/simfinity-core
    mongoose

Application choosing PostgreSQL
  @simtlix/simfinity-postgres [new package]
    @simtlix/simfinity-core
    pg

Shared core
  graphql (peer)
  no database driver
```

Keep `@simtlix/simfinity-js` at the repository root initially to minimize compatibility churn; put the new packages in `packages/core` and `packages/postgres`. A separately published MongoDB adapter package is unnecessary for the first release.

`graphql` remains a peer across the packages. Keep Mongoose confined to the existing package and `pg` confined to the PostgreSQL package. Align core versions deliberately and test packed packages in fresh directories; workspace hoisting must not conceal missing or unwanted dependencies.

The MCP SDK is currently an optional dependency, which still participates in normal npm installation. Make it an optional peer where the transport loaders resolve it, keeping tool-definition generation available without it. Remove the unused `graphql-middleware` dependency as part of the release's dependency changes. npm documents that optional peers are not automatically installed. [npm package metadata](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#peerdependenciesmeta)

### Internal boundary

Core owns registration, GraphQL schema construction, input materialization, validators, hooks, middleware, scopes, nested-write orchestration, and state transitions. The adapter owns storage metadata, ID conversion, database reads/writes, native handles, transaction management, error classification, and schema operations.

Use an internal runtime factory to bind one adapter and hold one registry. Public package-level named functions delegate to that runtime, preserving existing registration style. There is no `setBackend()` operation. Reject connection reconfiguration after registration begins. Repeated readiness calls are idempotent; concurrent calls share the same initialization promise.

Introspection patching must remain centralized and idempotent for the loaded GraphQL module. Tests should construct fresh GraphQL type objects for each runtime because current resolver generation mutates them; reusing already-bound type objects across adapters is not supported.

## 5. Public API and application setup

The MongoDB entry point continues accepting the current `connect()`, `createSchema()`, `getModel()`, `saveObject()`, middleware, auth, and MCP calls.

Proposed PostgreSQL setup:

```javascript
import { Pool } from 'pg';
import * as simfinity from '@simtlix/simfinity-postgres';
import { SerieType, serieController } from './serie.js';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

simfinity.configure({ pool, schema: 'public' });
simfinity.connect(null, SerieType, 'serie', 'series', serieController);

const schema = simfinity.createSchema();
await simfinity.initializeDatabase({ mode: 'create' });

// Start the GraphQL server with schema after initialization resolves.
```

`configure()` and `initializeDatabase()` are proposed additions, not existing exports. The supplied pool remains application-owned, including shutdown. No database request should silently trigger DDL or start serving before initialization completes.

Keep `createSchema()` synchronous and keep its current allowlist parameters. Registration describes all entities; endpoint allowlists do not remove tables required by other registered relationships. PostgreSQL initialization creates storage from the full finalized model graph.

| Surface | Compatibility promise |
| --- | --- |
| `connect(null, Type, singular, plural, controller, onModelCreated, stateMachine)` | Same signature and purpose |
| Generated GraphQL operations and input types | Same schema and semantic contract on both adapters |
| Scope callbacks | Same signature, operation names, argument-mutation pattern, and approved execution coverage |
| Field/type validators | Same signature and ordering; `session` is the selected adapter's native transaction context |
| Controller hooks | Same names and argument positions; ordinary record field reads/writes remain supported |
| `getType()`, `getInputType()`, scalar factories, auth and count plugins | Shared implementation |
| `saveObject(typeName, args, session, context)` | Same signature and approved transaction-ownership behavior |
| `getModel()`, supplied `model`, `onModelCreated()` | Adapter-specific model handles; MongoDB continues returning Mongoose models |
| `buildQuery()` / `buildFilterGroupMatch()` | Keep their existing MongoDB pipeline return contract in the MongoDB package; do not reuse those names for incompatible SQL return values |
| Direct imports under existing `src/` paths | Inventory and preserve used paths with forwarding modules; do not introduce an export map that unintentionally blocks them |

On PostgreSQL, native customizations use a documented PostgreSQL model handle and transaction client. No promise is made that `.lean()`, `.populate()`, `.schema`, `.save()`, Mongo operators, or Mongoose plugins work there. `onModelCreated()` means the model handle is ready, not that asynchronous DDL has finished; applications await initialization for that guarantee.

## 6. Shared model metadata and PostgreSQL storage

### Evidence from documentation and the reference application

The relationship contract comes from `README.md:618`, the nested mutation examples at `README.md:955`, `.cursor/rules/simfinity-extensions.mdc`, and the historical [ObjectId index examples](https://github.com/simtlix/simfinity.js/blob/5f5d592075c6f96854391980ac2aac986d3ddb80/README_INDEX_EXAMPLE.md). The current index reference is maintained in [Extensions](../../reference/extensions.md#automatic-mongodb-indexes). The implementation was checked at `graphQLListInputType()`, `materializeModel()`, `generateSchemaDefinition()`, `executeItemFunction()`, and `autoGenerateResolvers()`.

The reference application's actual type definitions confirm these structures:

| Model path | Declaration and meaning | PostgreSQL result |
| --- | --- | --- |
| `serie.seasons` / `season.serie` | Reverse list with `connectionField: 'serie'`, paired with a single reference | `season.serie` column with FK to `serie.id`; no `serie.seasons` storage column |
| `season.episodes` / `episode.season` | Reverse list with `connectionField: 'season'`; the episode's reference is non-null | `episode.season` column with FK to `season.id`; proposed `NOT NULL` from the required reference |
| `serie.stars` / `star.series` | Both lists target `assignedStarAndSerie`, not each other | A first-class linking table named `assignedStarAndSerie` |
| `assignedStarAndSerie.serie` / `.star` | Two non-null entity references; the assignment has its own `id` | Two FKs, to `serie.id` and `star.id`, retaining the assignment ID and its CRUD endpoints |
| `serie.director` | Non-null embedded object containing name/country; registered with `addNoEndpointType()` | Owned value in the serie row; no independent director reference or endpoint |
| `serie.categories` | List of strings, with no relation metadata | Scalar array value, with no FK |
| `star.name` | String with `extensions.unique: true` | Unique storage constraint |
| `season.description` / `.state` | Read-only string and state-machine enum | Persisted fields with the existing input/hook/state-machine behavior |
| `episode.date` / `.number` | DateTime scalar and a validated numeric scalar | Timestamp and numeric storage through their scalar codecs |

Sources: [serie](https://github.com/simtlix/series-sample/blob/main/types/serie.js), [season](https://github.com/simtlix/series-sample/blob/main/types/season.js), [episode](https://github.com/simtlix/series-sample/blob/main/types/episode.js), [assignment](https://github.com/simtlix/series-sample/blob/main/types/assignedStarAndSerie.js), [director](https://github.com/simtlix/series-sample/blob/main/types/director.js), [star](https://github.com/simtlix/series-sample/blob/main/types/star.js).

The README also shows reciprocal `User.groups` / `Group.members` lists in its circular-reference section. Those examples are not evidence of a working implicit junction-table feature: their `GraphQLList(() => getType(...))` construction fails under GraphQL 16, and the current collection write path inserts one parent ID into a child field. The core has no separate implicit many-to-many association writer. The PostgreSQL version must support the verified explicit-link-entity pattern. Direct reciprocal-list support requires a separate shared design for association creation/removal and cannot be claimed from the current examples alone.

### Attribute normalization

Build one normalized model graph containing GraphQL field name, storage name, scalar codec, all list/non-null wrappers, read-only status, indexes, embedded ownership, reference target, and relationship direction. Query, write, and DDL code all consume that graph.

| GraphQL/schema construct | Proposed PostgreSQL mapping and behavior |
| --- | --- |
| Persistent entity | One table; preserve the GraphQL type name through quoted identifiers |
| Entity `id` | UUID primary key by default, generated before `onSaving`; GraphQL exposes a string ID |
| Other `GraphQLID` field | Indexed scalar ID value. It becomes an FK only when relation metadata or an inverse collection supplies a target; an ID type/name alone cannot identify another table |
| String / Int / Float / Boolean | `text` / `integer` / `double precision` / `boolean` with matching codecs |
| Enum | `text` with consistent storage labels and decoding of GraphQL internal values; generated allowed-value checks are proposed for this release |
| Date/DateTime/Time scalar | Preserve current instant-based behavior with `timestamptz` and millisecond normalization; do not infer SQL `time` from the name alone |
| Validated scalar | Storage from `baseScalarType`; preserve custom validation functions |
| `GraphQLNonNull(T)` | Preserve create-input/output requirements and optional update patches. Proposed DDL policy: `NOT NULL` for persisted scalar/reference columns, with hooks setting read-only required fields before the write |
| List wrappers | Distinguish nullable list, required list, nullable items, and required items. A required list may be empty; it does not mean at least one related row |
| Scalar/enum list | JSONB array initially; retain order, duplicates, nullability, scalar codecs, and operator semantics; no FK |
| `extensions.readOnly` | Exclude from add/update inputs, while retaining persisted values set by hooks. Do not confuse this flag with a computed/unpersisted field |
| `extensions.unique` | Generate uniqueness for supported scalar paths. Extend the same marker to single-reference columns when one-to-one uniqueness is requested; the current Mongo generator does not apply it to object references |
| `extensions.validations` | Keep field/type validation and session flow. Arbitrary JavaScript validators cannot be translated automatically into SQL checks or unique constraints |
| `extensions.scope` | Query policy in core; not an FK or a replacement for database integrity |
| `relation.displayField` | Presentation/introspection metadata; does not choose the FK target key |
| Unsupported scalar or inconsistent relation | Named configuration error before DDL; never silently omit a field or FK |

The required-value and enum-check policies above are explicit recommendations for the PostgreSQL schema contract. Mongoose currently enforces less at storage level, so these changes must be listed in the compatibility ledger. Automatic FK enforcement is already a required part of the design.

UUID remains a recommendation for new PostgreSQL applications; consumers validating ObjectId shape must adapt. PostgreSQL records expose a derived `_id` string alias for existing hook/resolver conventions, not a second user-visible ID column. FK columns always use the referenced key's storage type, including references inferred from inverse lists.

### Relationship normalization and FK generation

Resolve the complete graph before emitting SQL. A single reference's FK is on its source; a reverse list's FK is on its target. Never add an array column for a non-embedded reverse collection.

1. For a single non-embedded field, resolve its target type, the target's primary key, and `connectionField || fieldName`; generate that column, a named FK, and a referencing-side index.
2. For a non-embedded list, resolve `connectionField` on the child as either a GraphQL field name or an already declared storage column. When it names a child object field, use that child's normalized storage name. Match the two declarations into one relation and one FK.
3. A child scalar ID named by the inverse list has an inferable parent target and receives an FK. If the inverse storage column is absent, generate a private child column from the known parent relation, without inventing a public GraphQL field. Reject conflicting targets or incompatible field types.
4. A single-valued reference is normally many-to-one. True one-to-one requires uniqueness of the referencing column; cardinality cannot be inferred merely because the GraphQL field is singular.
5. An explicit many-to-many link type is an ordinary entity with two or more declared references. Generate its table, preserve its ID and extra attributes, and generate every FK. Do not collapse it into an anonymous table or redirect its deletes to the shared target entity.
6. Discover tables from endpoint registration and inbound references. `addNoEndpointType()` suppresses endpoints; a referenced no-endpoint type still needs a table and target key.
7. Handle self-references and cycles by creating all tables/keys before adding FKs. Reject recursively embedded cycles and ambiguous inverse relation declarations at schema-build time.

Default proposed actions are `ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE` for references to independently stored entities. This rejects dangling references while permitting explicitly deferred checks for a custom transaction that builds a valid cyclic graph. Cascades are automatic only for the ownership links of generated embedded storage. Association-row deletion does not delete a serie or star. Custom cascade/set-null policies require explicit metadata and lifecycle rules; do not infer them from plural names.

Generate referencing-side indexes as separate DDL objects; PostgreSQL does not create them merely because an FK exists. [PostgreSQL foreign keys](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-FK)

### Embedded ownership, including embedded references

`embedded: true` describes ownership and nested API behavior. It does not require PostgreSQL to use one physical JSON document for every case.

- **Value-only embedded object/list:** JSONB is suitable when the complete embedded subtree contains no entity reference. The sample's director is this case. Preserve absent versus null objects, array order/duplicates, validators, shallow object patches, and array replacement. Generate shape/required-value checks according to the approved attribute policy. [PostgreSQL JSON types](https://www.postgresql.org/docs/current/datatype-json.html)
- **Embedded object containing a reference:** generate a private owned table for that embedding path. Give it an internal key and a unique owner FK; its entity-reference columns get ordinary FKs. Deleting the owner cascades to this owned row. The shared referenced entity is not owned and is not cascaded.
- **Embedded list containing references:** generate a private item table with owner FK, item key, and ordinal, plus actual FKs for each referenced entity. `(owner_id, ordinal)` is unique; keep duplicates of equal item values and preserve their order. Nested owned tables apply the same rule recursively.
- **Mixed use of one type:** an embedded occurrence is owned by its embedding path; a referenced occurrence points to an independent table. Do not make embedded values accidentally share identity because they use the same GraphQL type.

An embedded `Order.items[].product` declared as a non-embedded `Product` reference therefore produces owner/item/product FK relationships. A bare `items[].productId: GraphQLID` without target metadata is only a scalar ID; no generator can safely infer its target from its spelling.

The SQL adapter reassembles owned rows into the same nested record before hooks, custom resolvers, and GraphQL see it. Private owner IDs and ordinals do not appear in the GraphQL schema. Replacing an embedded list replaces its owned rows within the mutation transaction. Do not run new independent-entity controller hooks for private embedded rows; preserve the existing embedded validator/lifecycle behavior.

This mapping ensures a reference is never left unenforced just because it appears inside an embedded array. A normal FK cannot refer directly to arbitrary JSONB array elements; the owned-table mapping exposes real constrained columns. If a later model change introduces references into a formerly JSONB-only value, schema planning must produce an explicit data migration, not switch its layout silently at startup.

### Concrete generated relationship schema for the reference application

The following is the relationship portion of proposed generated SQL; field codecs, JSON checks, and additional scalar columns are described above. The nullable `season.serie` follows its nullable declaration; `episode.season` and both assignment references are required. UUID storage remains the proposed ID choice.

```sql
CREATE TABLE "serie" (
  "id" uuid PRIMARY KEY,
  "name" text NOT NULL,
  "categories" jsonb,
  "director" jsonb NOT NULL
);
CREATE TABLE "star" (
  "id" uuid PRIMARY KEY,
  "name" text UNIQUE NULLS NOT DISTINCT
);
CREATE TABLE "season" (
  "id" uuid PRIMARY KEY,
  "number" integer,
  "year" integer,
  "state" text,
  "description" text,
  "serie" uuid
);
CREATE TABLE "episode" (
  "id" uuid PRIMARY KEY,
  "number" integer,
  "name" text,
  "date" timestamptz,
  "season" uuid NOT NULL
);
CREATE TABLE "assignedStarAndSerie" (
  "id" uuid PRIMARY KEY,
  "serie" uuid NOT NULL,
  "star" uuid NOT NULL
);

ALTER TABLE "season" ADD CONSTRAINT "season_serie_fk"
  FOREIGN KEY ("serie") REFERENCES "serie" ("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE "episode" ADD CONSTRAINT "episode_season_fk"
  FOREIGN KEY ("season") REFERENCES "season" ("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE "assignedStarAndSerie" ADD CONSTRAINT "assignment_serie_fk"
  FOREIGN KEY ("serie") REFERENCES "serie" ("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;
ALTER TABLE "assignedStarAndSerie" ADD CONSTRAINT "assignment_star_fk"
  FOREIGN KEY ("star") REFERENCES "star" ("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE;

CREATE INDEX "season_serie_idx" ON "season" ("serie");
CREATE INDEX "episode_season_idx" ON "episode" ("season");
CREATE INDEX "assignment_serie_idx" ON "assignedStarAndSerie" ("serie");
CREATE INDEX "assignment_star_idx" ON "assignedStarAndSerie" ("star");
```

The assignment's validator also expresses pair uniqueness, but that intent is implemented in JavaScript, not declared as a composite index. Preserve/adapt the validator; do not claim the compiler can infer arbitrary business rules. To generate `UNIQUE (serie, star)` or `UNIQUE (season, number)`, propose an additive type-level `extensions.indexes` declaration such as `{ fields: ['serie', 'star'], unique: true }`. This is new metadata requiring implementation and documentation. Do not automatically make every entity with two FKs pair-unique. [Sample validators](https://github.com/simtlix/series-sample/blob/main/types/validators/typeValidators.js)

### Other indexes and constraint semantics

- Avoid redundant primary-key indexes; retain the existing intent to index scalar ID paths, including IDs that are not declared references.
- Preserve currently effective scalar `extensions.unique` behavior. Nullable scalar uniqueness uses `UNIQUE NULLS NOT DISTINCT`; recommend PostgreSQL 15 as the capability floor. [MongoDB unique indexes](https://www.mongodb.com/docs/manual/core/index-unique/), [PostgreSQL uniqueness](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-UNIQUE-CONSTRAINTS)
- Unique values inside embedded arrays need owner-aware treatment, whether stored in JSONB or private rows: MongoDB multikey uniqueness permits a repeated value within one owner but disallows the same key under another owner. Implement and test a database-enforced key-ownership mechanism; a whole-JSONB unique constraint or naive per-item unique column is insufficient.
- Every FK must be present in the database catalog and enforce direct SQL writes as well as GraphQL writes. Application-only existence checks do not satisfy the FK requirement.
- Normalize SQLSTATE `23503` to a domain error such as `REFERENCE_CONSTRAINT_VIOLATION`, covering invalid references and blocked deletes. Keep scope authorization separate from existence checks: a valid FK does not imply the caller may access the referenced row.

## 7. Query semantics and scopes

The shared query representation describes field paths, scalar types, relation traversals, logical groups, ordering, pagination, and aggregation. It must contain neither Mongoose objects nor SQL text. It must retain which conditions share a relation traversal, because that affects whether the same child must satisfy several predicates.

```text
GraphQL args
  -> Simfinity middleware
  -> scope callback for the current operation
  -> normalized query plan
  -> MongoDB pipeline OR parameterized PostgreSQL statement
  -> adapter result decoding
  -> GraphQL serialization / auth field wrappers
```

Scopes stay above the adapter. A callback that adds `args.owner = { terms: [...] }` works identically. Flat scope constraints remain conjoined with user logical groups. Get-by-ID combines the requested ID with scope predicates and returns null when excluded. Count and aggregation use the same scoped predicate as their corresponding operation.

Preserve the current limitation that scopes apply to the generated root read operations. Expanding them to child resolution, relationship filter traversals, writes, or raw model access is a separate authorization-policy decision. Do not promise SQL row-level security or global tenant isolation merely because root scopes exist.

| Behavior | Required implementation/test |
| --- | --- |
| Operators | EQ, NE, LT, LTE, GT, GTE, BTW, IN, NIN, LIKE; preserve omitted-operator EQ and inclusive BTW |
| LIKE | Literal, case-sensitive substring search; user `%`, `_`, and regex punctuation are literal. `strpos` on a validated text expression is a candidate implementation |
| Null/missing | EQ null and NE null need explicit predicates. NE against a non-null value includes absent/null values in MongoDB; plain SQL `<>` alone differs |
| IN/NIN | Define empty lists, null-containing lists, absent fields, and scalar/list comparisons from real MongoDB fixtures; never emit invalid `IN ()` |
| Arrays | Scalar equality can mean element membership; array equality preserves order. JSONB containment alone is insufficient for all operators |
| Logical groups | Preserve flat plus AND/OR behavior, empty-group behavior, dotted-field syntax, explicit path syntax, and the current depth limit |
| Relationships | Preserve same-child predicate correlation, optional references, nested traversals, and mixed embedded/reference paths. Dangling-reference fixtures remain MongoDB characterization cases; PostgreSQL rejects creating them |
| Multiplicity | Match approved result cardinality before optimizing; do not automatically replace unwind-style joins with EXISTS or DISTINCT |
| Pagination | Page numbers are 1-based; default list limit is 100; counts precede pagination. Aggregations have no default limit |
| Sorting | Preserve multi-key order and explicit null placement. Array sort keys need Mongo-compatible rules. Do not claim a stable order without an explicit sort |
| Aggregations | Preserve `{ groupId, facts }`, names, filters, grouped pagination, default group ordering, and empty/no-value behavior |

MongoDB's inequality semantics include missing values; PostgreSQL ordinary comparisons use SQL's three-valued null logic. Implement typed compatibility predicates rather than translating operator names mechanically. [MongoDB NE](https://www.mongodb.com/docs/manual/reference/operator/query/ne/), [PostgreSQL comparisons](https://www.postgresql.org/docs/current/functions-comparison.html)

SQL values must use bound parameters. Table names, aliases, columns, sort fields, and aggregation paths must be resolved from validated metadata and quoted as identifiers; value parameters do not protect identifiers. [node-postgres queries](https://node-postgres.com/features/queries)

For aggregation, Simfinity COUNT counts contributing rows, not non-null values of the supplied path. PostgreSQL `SUM` over only null inputs needs normalization to preserve MongoDB's zero result for an existing group; no matching groups still means an empty result list. Numeric results must be decoded to the existing JavaScript/GraphQL number contract rather than leaking driver strings. [MongoDB SUM](https://www.mongodb.com/docs/manual/reference/operator/aggregation/sum/), [PostgreSQL aggregates](https://www.postgresql.org/docs/current/functions-aggregate.html), [node-postgres type parsing](https://node-postgres.com/features/types)

## 8. Mutations, hooks, and transactions

Keep nested `{ added, updated, deleted }` processing in the shared operation engine. The core passes a backend-independent change description with explicit set/unset entries to the adapter. MongoDB encodes those into document updates; PostgreSQL encodes column assignments, JSONB changes, and private owned-row changes. Creating a parent and its children shares one transaction, so children can reference the just-created parent. Deletes from `serie.stars` remove assignment entities; they do not delete shared stars.

Preserve the distinction between omitted input and explicit null, including the current handling of nullable versus non-null update fields. Preserve shallow merge of embedded objects and replacement of embedded arrays; recursively changing this to a deep merge would change behavior. Relation clearing must target the normalized storage field after the corresponding compatibility correction is approved.

Lifecycle sequence for the documented contract:

```text
middleware -> transaction -> validation/materialization -> before hook
  -> write -> nested child operations -> after hook -> commit
```

After hooks run after the write but still before commit. They are not after-commit notifications. Retried transactions may run hooks again, just as today's retry wrapper can; callbacks doing external side effects need a separately designed after-commit/outbox feature if exactly-once delivery is required. That feature is outside this project.

For PostgreSQL, every statement in a transaction, including nested writes and hook-issued database work, must use one checked-out client. Do not use `pool.query()` inside that transaction. Preserve the session argument positions; PostgreSQL callbacks receive the documented transaction handle. [node-postgres transactions](https://node-postgres.com/features/transactions)

Specify transaction ownership: generated/custom mutations own their transaction; nested operations join it; supplied sessions are not committed or closed by lower-level operations. Preserve the current standalone `saveObject()` behavior during extraction and document the discrepancy; changing it to always open a transaction is a separate approved change.

PostgreSQL should use snapshot-like transaction behavior for mutation workflows and bounded whole-transaction retries for serialization failures/deadlocks. Rebuild attempt-local materialized input on retry so hooks and nested writes do not reuse mutated state. Never retry a connection failure with an unknown commit outcome as though it were a confirmed rollback. Validate the isolation/retry contract with competing state transitions and embedded updates. [PostgreSQL transaction isolation](https://www.postgresql.org/docs/current/transaction-iso.html)

Use row locking or conditional writes so two competing transitions cannot both act on the same old state. Keep state-machine storage names separate from GraphQL enum internal values. Preserve the behavior of nested update/delete IDs until ownership validation is separately specified; silently adding parent-ownership restrictions would also change existing semantics.

Normalize PostgreSQL storage failures into `SimfinityError` without exposing SQL or credentials. Define errors for missing initialization, schema mismatch, unsupported field mapping, invalid ID/filter, duplicate key, reference constraint violations, and retry exhaustion. Preserve existing named domain errors from user hooks. Changes to MongoDB's driver-error formatting require explicit compatibility tests, not an assumption that every backend previously had one common error format.

## 9. Automatic schema creation and evolution

Keep GraphQL schema construction and database schema initialization separate because the latter can fail asynchronously. The current MongoDB `createCollection()` call is not awaited and does not prove storage is ready; copying that pattern would make PostgreSQL startup unreliable.

Proposed additions on the PostgreSQL entry point:

```javascript
await simfinity.initializeDatabase({ mode: 'create' });
await simfinity.initializeDatabase({ mode: 'validate' });
const plan = await simfinity.planDatabaseChanges();
```

- `create`: under a schema-level advisory lock and a DDL transaction, inspect existing objects, create missing tables/keys/FKs/indexes/owned-storage objects, and verify the resulting model. Compatible existing objects are retained. Do not alter incompatible columns or silently reinterpret an existing table. When adding an FK to a populated table, reject orphaned data with an actionable report; never silently omit the constraint.
- `validate`: inspect the catalog and compare it with the finalized model graph; make no DDL changes; report actionable differences.
- `planDatabaseChanges`: produce deterministic, inspectable SQL and a description of additions, removals, type changes, constraint changes, and possible data backfills. Planning makes no database changes.

Record applied schema changes in a namespaced metadata table with version/checksum information, and inspect the actual catalog so external drift is detected. Use deterministic identifier shortening/hashing to respect PostgreSQL identifier limits, including collisions among embedded index names. Quote every identifier and qualify every table by schema.

Initial schema creation should support circular references by discovering all tables and relationships before emitting dependent objects. Create tables and primary/unique keys first, then FKs and referencing-side indexes. Compare FK source columns, target table/key, actions, deferrability, and validation status with the catalog. `CREATE TABLE IF NOT EXISTS` alone is not validation. Failed creation should roll back generated changes and prevent request serving.

Versioned SQL migrations handle later evolution. Generate additive changes where unambiguous; report a removed and added field as separate operations rather than guessing a rename. Required-column additions need a backfill strategy. Destructive changes, retypes, renames, and enum-value remapping require explicit migration SQL. Provide a migration runner with a lock and checksums; do not implement an automatic destructive startup sync.

Retain `preventCreatingCollection()` for MongoDB. On the PostgreSQL facade, the proposed compatibility alias makes `initializeDatabase({ mode: 'create' })` perform validation only when the flag is true. No DDL is issued in that case, and absent tables cause a validation error. New PostgreSQL applications should use `initializeDatabase({ mode: 'validate' })` directly. Schema planning remains read-only regardless of this flag.

## 10. Delivery plan

Execute as small reviewed changes. The design is intentionally broader than a single implementation PR; each phase has a working result and a verification gate. Detailed task-by-task coding plans should be written per phase after the compatibility decisions are reviewed.

### Phase 1 — Establish the executable compatibility contract

Files: retain the existing `tests/*.test.js`; add `tests/contracts/model-fixtures.js`, `tests/contracts/operations.js`, `tests/contracts/expectations.js`, `tests/integration/mongodb.test.js`, and `docs/compatibility.md`; update `.github/workflows/master.yml` and add a database integration workflow.

Build a Serie/Season/Episode/Star/AssignedStarAndSerie model graph from the inspected sample, with references, embedded values, validated scalars, read-only fields, unique values, controller hooks, state transitions, and per-tenant root scopes. Add separate fixtures for true one-to-one uniqueness, inverse-only relations, no-endpoint FK targets, and embedded objects/lists containing references. Run actual GraphQL operations against a disposable MongoDB replica set so transactions are exercised. Store result expectations with generated IDs normalized, retaining duplicates and explicit ordering where relevant.

Characterize every discrepancy in section 3. Assign each one a preserve/fix/defer decision and regression test before changing code. Fix the agreed documented defects in individual changes against MongoDB first.

Gate: existing tests and lint pass; the MongoDB integration fixtures cover root/nested CRUD, operators, scope exclusions, hooks, rollback, counts, and real aggregate results. Pipeline snapshots alone do not satisfy this gate.

### Phase 2 — Extract the shared engine with MongoDB still working

Create `packages/core/package.json` and modules under `packages/core/src/`: `runtime.js`, `metadata.js`, `inputs.js`, `queries.js`, `operations.js`, `introspection.js`, and `scalars/factory.js`. Move reusable auth, validators, scalar helpers, plugins, errors, and MCP modules into that package while leaving forwarding modules where required.

Create `src/mongo/adapter.js`, `src/mongo/models.js`, `src/mongo/queries.js`, and `src/mongo/transactions.js`. Reduce the existing `src/index.js` to binding the MongoDB adapter and forwarding public exports. Update root `package.json`, the lockfile, and `types/index.d.ts` together.

The internal adapter contract supplies model preparation, read/query execution, create/patch/delete, ID codecs, native handles, transaction execution, and storage initialization. The shared query plan describes typed predicates and relation traversals; adapter compiler outputs stay private. Keep public MongoDB pipeline helper exports forwarding to their original semantics.

Gate: the Phase 1 corpus still passes unchanged except for approved fixes; schema/introspection snapshots and public exports match; importing packed core/scalar/auth modules succeeds without Mongoose installed.

### Phase 3 — PostgreSQL schema generation and first complete CRUD flow

Create `packages/postgres/package.json`, `packages/postgres/src/index.js`, `adapter.js`, `models.js`, `codecs.js`, `schema/describe.js`, `schema/relations.js`, `schema/owned-storage.js`, `schema/ddl.js`, `schema/introspect.js`, and `schema/initialize.js`; add PostgreSQL declarations, `tests/integration/postgres-schema.test.js`, and `tests/integration/postgres-foreign-keys.test.js`.

Implement one fixed pool binding, generated IDs/columns/keys/FKs, native record decoding, parameterized simple reads/writes, primary/reference/unique indexes, and awaited create/validate initialization. Cover scalar-only embedded values, owned tables for reference-bearing embedded values, and referenced no-endpoint types. Normalize inverse declarations so one-to-many relationships create exactly one FK, and explicit linking entities create FKs to both endpoints. Implement nullable unique and JSONB index cases before expanding the advertised supported model surface.

Gate: an empty database is initialized from the same GraphQL definitions; create/get/update/delete works; catalog assertions verify all expected FKs and their targets; direct SQL attempts to insert/update dangling references or delete referenced entities fail; owned rows cascade with their owner; assignment deletion preserves both shared endpoints; a second initialization is a no-op; incompatible schemas fail clearly; concurrent initialization is serialized; normal package installation contains no MongoDB dependency.

### Phase 4 — Complete the query/filter/sort/aggregation semantics

Create `packages/postgres/src/query/compiler.js`, `predicates.js`, `paths.js`, `relations.js`, and `aggregates.js`; add `tests/integration/postgres-queries.test.js` and run the shared contract corpus on both adapters.

Implement all operators, null and array cases, relation correlation and multiplicity, logical nesting, embedded paths, counts, sorting, grouped facts, and result decoding. Share path validation and semantic tests with MongoDB. Keep adapter-specific pipeline/SQL construction tests alongside end-to-end assertions.

Gate: identical GraphQL operations over valid related data produce equivalent normalized values, duplicate counts, scoped results, and relevant errors. The compatibility ledger records PostgreSQL's required integrity guarantees and any approved stronger attribute constraints separately. Explain plans for representative reference filters demonstrate use of generated indexes; parameter and identifier-injection tests pass.

### Phase 5 — Complete nested mutations and lifecycle behavior

Create `packages/postgres/src/transactions.js` and `writes.js`; extend shared operation orchestration only where needed; add `tests/integration/postgres-mutations.test.js`, `tests/integration/transaction-contract.test.js`, and `tests/integration/scope-contract.test.js`.

Implement parent/child transaction sharing, embedded merge and array replacement across JSONB and owned tables, set/unset semantics, custom mutations, native hook handles, retries, rollback, and state-transition concurrency. Test FK errors during nested writes, ordered embedded replacement, deferred cyclic references, ownership cascades, and association removal independently from target deletion. Complete embedded-array uniqueness enforcement and its concurrent-write tests before declaring full model compatibility.

Gate: a failing child write, validator, or hook rolls back the entire generated mutation; competing transitions cannot both succeed from one old state; hooks see the documented record shape and session; root scopes cannot be bypassed by user OR; existing relationship scope boundaries remain explicit.

### Phase 6 — Storage evolution and release packaging

Create `packages/postgres/src/schema/plan.js` and `schema/migrate.js`; add `tests/integration/postgres-migrations.test.js`, `tests/packaging/dependency-isolation.test.js`, and `docs/postgresql.md`. Update `README.md`, `types/index.d.ts`, package declarations, release workflows, and relevant `.cursor/rules/*.mdc` files.

Add schema plans, versioned migration execution, drift detection, examples for initial creation and production validation, and a native-integration migration guide. Run generated GraphQL/MCP/auth/count behavior against both adapters. Test packed packages without the other database driver or MCP SDK present; separately test opt-in MCP transports.

Gate: clean-install and minimum-runtime smoke tests pass, all supported database integration jobs pass, migrations are repeatable and recover correctly from failure, and the compatibility ledger contains no unexplained differences. Publish a coordinated prerelease before the stable version. A major MongoDB release is appropriate if approved bug fixes or native-facing contracts change observably.

## 11. Acceptance matrix

| Scenario | Required evidence |
| --- | --- |
| GraphQL schema compatibility | Stable operation/type/argument names, descriptions, input nullability, relation metadata, and auth permission targets |
| Root and relationship reads | Real data across valid/optional references, explicit many-to-many link entities, multiple matching children, reference-bearing embedded structures, and no-endpoint types |
| Foreign-key schema and enforcement | Catalog-verified source/target columns and policies; one FK per normalized one-to-many relation; both junction FKs; owned-row FKs; failed direct SQL dangling writes/deletes; cascade cleanup only for owned data |
| Filters and scopes | Flat plus logical filters, repeated terms, same-child predicates, two tenants, scoped single reads, counts, aggregates, and documented nested scope boundary |
| Values | Null/absent/empty strings, false/zero, enum internal values, IDs, UTC dates, empty arrays, duplicates, and validated scalars |
| Writes | Added/updated/deleted collections, embedded object merge, embedded array replacement, nullable clears, read-only hook values, and custom mutations |
| Concurrency | Atomic rollback, same-client transaction usage, uniqueness conflicts, competing state changes, bounded retries, and session cleanup |
| Schema lifecycle | Fresh creation, repeated creation, validate-only, changed definitions, FK action/target drift, circular references, naming collisions, orphan detection during FK addition, owned-storage migration, and failed migration rollback |
| Dependency isolation | Packed PostgreSQL installation imports and executes without Mongoose/MongoDB; MongoDB without pg; core without either driver; MCP definitions without SDK |
| Documentation | One example model reused with two setup modules; database-specific customization changes identified explicitly |

The [Series Sample Project](https://github.com/simtlix/series-sample) is the application-level pilot after the package contract suite passes. Its six main type definitions, relationship documentation, type validators, and serie/season controllers have now been inspected. Controllers and validators include native Mongoose queries and document saves, so their PostgreSQL adaptation is a concrete part of the pilot. Some sample validation operation names also differ from the current engine's CREATE/UPDATE dispatch; characterize and correct those sample mismatches rather than treating the sample as a passing integration suite.

## 12. Decisions for architectural review

The proposed defaults are:

1. Preserve Simfinity semantics and hook signatures; adapt native Mongoose integration code for PostgreSQL.
2. Publish the PostgreSQL package separately with one shared core in this repository.
3. Generate actual FKs for all declared references. Use JSONB for value-only embedded data and owned tables for embedded structures containing references, preserving their nested API behavior.
4. Use opaque UUID strings for new PostgreSQL entity identities; do not require ObjectId compatibility.
5. Add awaited database initialization while keeping `createSchema()` synchronous.
6. Enforce referential integrity in PostgreSQL with blocking reference-delete behavior by default and ownership cascades for private embedded rows. Preserve current root-scope coverage; broader scope enforcement remains a separate decision.
7. Make supported database behavior explicit through a shared real-database contract suite before claiming compatibility.

Automatic FK generation is required. Native Mongoose compatibility remains the largest unresolved scope question: full emulation would invalidate the lightweight-adapter premise. UUIDs, required-value constraints, reference action defaults, owned-storage details, and additive composite-index metadata remain concrete design recommendations for review.
