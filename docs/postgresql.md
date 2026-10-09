---
title: PostgreSQL storage reference
description: PostgreSQL types, generated foreign keys, embedded storage, schema validation, native APIs, and compatibility boundaries in Simfinity 3.5.9.
---

# PostgreSQL support

Simfinity 3.5.9 provides PostgreSQL schema generation and GraphQL execution through the shared core and SQL runtime. PostgreSQL is the first [SQL plugin](guide/sql-plugins.md); its existing facade and generated 3.2.0 physical schema remain compatible. The existing `@simtlix/simfinity-js` package continues to run MongoDB. Both backends share schema/input generation, scopes, middleware, validators, controllers, nested mutations, and state-machine orchestration. Version 3.5.9 is available from npm; supported behavior and remaining limits are listed below and in the [compatibility ledger](compatibility.md).

Start with the canonical [PostgreSQL quick start](guide/postgresql.md) for a complete Yoga server, initialization choice, controller/session example, and pool shutdown. This page is the detailed storage and compatibility reference.

The intended backend choice is permanent application configuration. There is no runtime switching, dual writing, or MongoDB-to-PostgreSQL data migration.

## Packages and local setup

Use the [v3.5.9 starters](guide/databases.md#download-the-starters) and run `npm install` in the `postgres` folder. For library development, `npm ci` at the repository root installs the workspaces. Packages are distributed together:

| Package | Current exports and dependencies |
| --- | --- |
| `@simtlix/simfinity-js` | MongoDB facade and native adapter, plus compatibility auth/MCP/scalar/validator/plugin exports. Mongoose dependencies remain here. |
| `@simtlix/simfinity-core` | `createRuntime`, model metadata, typed query plans, scalar factory and error classes. GraphQL peer only; no drivers or MCP. |
| `@simtlix/simfinity-sql` | `createSQL`, pure `planRelationalSchema`, plugin contract and relational orchestration. Depends on core; no driver, Mongoose or MCP. |
| `@simtlix/simfinity-postgres` | `postgresPlugin`, `createPostgres`, default-module runtime facade, schema description/DDL/initialization, shared scalar factory and errors. Depends on SQL, core and `pg`; GraphQL peer. No MongoDB, Mongoose or MCP dependency. |
| `@simtlix/simfinity-mcp` | Optional database-independent tool generation and transports. Depends on core; the MCP SDK is an optional peer. |

All five packages are versioned together at version `3.5.9` with exact internal dependencies. The verified package set includes standalone consumer checks for SQL as well as both facades, covering MCP with and without its SDK and strict TypeScript checks. Library code requires Node.js >=18.18.0; the starter requires Node.js 22.15.0+. PostgreSQL 15, 16, and 18 are covered by the release verification.

## Executable example

Run this from a new file in the extracted `postgres` starter folder after `npm install`. Set `DATABASE_URL` to a development PostgreSQL instance. Register every object type used by generated GraphQL inputs and relations. `AuthorType` has a model even though it is registered without a root endpoint.

```javascript
import pg from 'pg';
import { GraphQLObjectType, GraphQLID, GraphQLString, GraphQLNonNull, GraphQLList, graphql } from 'graphql';
import { createPostgres, compileDatabaseSchema } from '@simtlix/simfinity-postgres';

const AuthorType = new GraphQLObjectType({
  name: 'Author',
  fields: () => ({
    id: { type: GraphQLID },
    name: { type: new GraphQLNonNull(GraphQLString) },
    books: {
      type: new GraphQLList(BookType),
      extensions: { relation: { embedded: false, connectionField: 'author_id' } },
    },
  }),
});
const BookType = new GraphQLObjectType({
  name: 'Book',
  fields: {
    id: { type: GraphQLID },
    title: { type: new GraphQLNonNull(GraphQLString) },
    author: {
      type: new GraphQLNonNull(AuthorType),
      extensions: { relation: { embedded: false, connectionField: 'author_id' } },
    },
  },
});
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const simfinity = createPostgres({ pool, schema: 'library' });
simfinity.addNoEndpointType(AuthorType);
simfinity.connect(null, BookType, 'book', 'books');
const schema = simfinity.createSchema();

console.log(compileDatabaseSchema(simfinity.describeDatabase()).join(';\n'));
try {
  await simfinity.initializeDatabase({ mode: 'create' });
  const author = await simfinity.getModel(AuthorType).create({ name: 'Ada' });
  const result = await graphql({
    schema,
    source: `mutation($input: BookInput!) {
      addbook(input: $input) { id title author { name } }
    }`,
    variableValues: { input: { title: 'Models', author: { id: author.id } } },
  });
  console.log(result);
} finally {
  await pool.end();
}
```

The generated `Book.author_id` is a `uuid NOT NULL` column with exactly one FK to `Author.id` and a referencing index. The inverse `Author.books` does not add a column. Both tables receive UUID primary keys with `gen_random_uuid()` defaults.

For the module facade, use `import * as simfinity from '@simtlix/simfinity-postgres'` followed by `simfinity.configure({ pool, schema: 'library' })` once. Registration and GraphQL APIs have the same signatures. The factory is useful for independent instances: use fresh `GraphQLObjectType` objects for each instance because resolver generation mutates those objects in place; reusing types whose relations another instance resolves, `toConfig()` copies of them made after that instance built its schema, or a shared custom mutation result type with an unresolved relation field throws `TYPE_BOUND_TO_OTHER_RUNTIME`. Register types before `createSchema()`; PostgreSQL rejects later registrations. Configuration takes a snapshot of the pool/schema binding and rejects reconfiguration. The caller owns the pool and closes it at application shutdown.

The server must await `initializeDatabase()` before accepting operations. Until the first initialization succeeds, operations fail with `DATABASE_NOT_INITIALIZED` (503). To disable schema creation, call `preventCreatingCollection(true)` before `createSchema()`; initialization then validates only: a missing or false mode validates, and every other mode except `validate`, such as an explicit `mode: 'create'`, is rejected with `DATABASE_CREATION_DISABLED` (409). `mode: 'validate'` can also be selected directly. On a runtime that allows creation, any mode other than `create` or `validate`, including `null` and `''`, fails with `INVALID_INITIALIZATION_MODE` (400); omit `mode` for the default, `create`.

A rejected request leaves readiness as it was. A runtime that is ready keeps serving while `initializeDatabase()` runs again, and any failure of an initialization, such as `SCHEMA_MISMATCH` or a connection error, makes operations fail with `DATABASE_NOT_INITIALIZED` until a later one succeeds; when initializations overlap, the one started last decides. `create` mode locks each existing managed table against writes until it commits, and a deadlock or lock timeout fails it, so check a live runtime with `mode: 'validate'`.

## GraphQL execution and native access

Generated operation names, arguments, introspection extensions and nested `added`/`updated`/`deleted` inputs are shared with MongoDB. `GraphQLNonNull` and list-item nullability are retained in create inputs; update inputs permit omission while retaining item nullability. Root `find`, `get_by_id` and `aggregate` scopes run after middleware and before adapter queries. Scope predicates stay conjoined with caller OR groups. Generated single relationships run target `get_by_id` middleware/scopes, and generated collections run target `find` middleware/scopes. Immutable referenced-ID and parent predicates are applied independently of mutable filters and before pagination. Custom resolvers retain their own authorization responsibility.

Filters support EQ, NE, LT, LTE, GT, GTE, BTW, IN, NIN and literal case-sensitive LIKE, with nested AND/OR, typed scalar and relationship paths, pagination, sort, and `context.count`. Queries preserve repeated roots from matching inverse children and their contribution to counts and aggregates. Matching predicates on the same referenced child share a join. Embedded scalar predicates retain Mongo's array membership behavior, without expanding root rows. Comparisons use bound values and metadata-validated paths; malformed paths or values produce domain errors. Text ordering uses binary `C` collation rather than the database's language locale.

`configureQueryLimits({ maxPageSize: 500 })` configures the shared process-wide list maximum (default 1000). Calling it without options restores the default. Unpaged lists return at most `Math.min(100, maxPageSize)` rows. Explicit page/size and calculated skip must be safe integers, with page >= 1 and size between 1 and the maximum; invalid input raises `INVALID_PAGINATION`. Unpaged aggregates stay unbounded. Sort/filter paths must end at a declared scalar or enum. Filter lists cannot contain null elements, and EQ/NE take scalar values rather than whole arrays. The process-wide `configureMutationLimits({ maxNestedOperations })` caps nested `added`/`updated`/`deleted` entries per generated mutation before its transaction starts; it is unlimited by default.

Nested collection mutations run child middleware (`{ input }` for save/update, `{ id }` for delete). Child update/delete IDs are checked for existing parent ownership after middleware, inside the transaction, against the parent's stored UUID, so an uppercase parent UUID owns its children. Malformed child IDs raise `NOT_VALID_ID` (400), missing children raise `NOT_VALID_ID` (404), and foreign-parent children raise `ForbiddenError` (`FORBIDDEN`, 403). Pre-write hooks cannot change the required parent connection. These checks do not replace application write permissions or turn query scopes into write authorization.

Aggregation returns `{ groupId, facts }`; SUM/AVG/COUNT use JavaScript numbers and COUNT counts contributing joined rows. Scalar-list leaves can be filtered and sorted through nested embedded lists, in JSONB and owned reference-bearing trees. Group projections preserve array order, duplicates, ragged shapes and explicit-null leaves while excluding absent child fields and null parent items. Arrays such as `[]`, `[null]`, `[[]]`, `[[null]]`, `[[1,2]]` and `[[1],[2]]` remain distinct group keys.

Array-valued facts yield SUM `0` and AVG `null`; MIN/MAX compare the entire array lexicographically with typed/null ordering. Scalar MIN/MAX continue to support Boolean and UUID values. Result sorting (including default ascending `groupId`) selects the lowest/highest immediate element of an array; it does not compare the entire array as MIN/MAX do. An empty terminal array sorts below null. Add a second sort term when primary keys tie, since tied Mongo results have no guaranteed order. PostgreSQL uses generated immutable comparison helpers, not native JSONB length-first ordering. Date and string-enum aggregates return the same logical values as Mongo; numeric and boolean enums group as their text form on PostgreSQL but as native values on MongoDB (see [What gets generated](/guide/schema#what-gets-generated)); state-machine aggregates expose stored state names even though PostgreSQL state columns hold enum internal values. Whole embedded-object sorting/grouping remains explicitly unsupported; arbitrary Mongo pipelines and unknown custom storage are outside this contract.

Generated and registered custom mutations run on one transaction client using repeatable-read isolation. Validators and hooks receive the same context and active session. The adapter retries confirmed serialization/deadlock aborts up to five times, each after a random delay of less than 10, 20, 40, 80 and 160 ms that starts once the failed attempt has rolled back and released its client; middleware runs once, while transactional hooks/callbacks may run again. Each attempt receives fresh input-object/list/Date structures. Enum values and opaque custom scalar payloads retain their identity; treat those payloads as immutable. Keep external effects in retryable hooks idempotent.

State transitions lock and check the current row in that transaction. The `state` field must be a GraphQL enum: `createSchema()` rejects any other field with `INVALID_MODEL` (400). PostgreSQL uses GraphQL enum internal values for storage and guards. Query filters resolve member names first, then internal values by strict equality, matching Mongo. When `ONE` stores `TWO` and `TWO` stores `two`, filter `"TWO"` selects member `TWO`; writes of internal `TWO` still store member `ONE`. Numeric internal values accept numbers, not numeric strings. This resolution applies to EQ, NE, LT, LTE, GT, GTE, BTW, IN and NIN, including scalar lists and embedded/reference leaves; LIKE requires a string field. Mutation results and subsequent reads serialize through the same enum.

`getModel(Type)` returns a PostgreSQL handle with `findById`, `find`, `create`, `update`, and `delete`. It is not a Mongoose model and has no query chaining or `.lean()`. Native writes bypass GraphQL validation and controller hooks, use storage field names (for example `{ author_id: author.id }`), and still enforce generated database constraints. Records are plain objects exposing `_id` and `id` as the same UUID. `onModelCreated` receives this handle; native Mongoose integrations must be adapted.

```javascript
await simfinity.withTransaction(null, async (session) => {
  await simfinity.saveObject('Book', {
    title: 'Another book', author: { id: author.id },
  }, session, requestContext);
  // Same client, parameterized application SQL if required:
  await session.query('SELECT 1');
});
```

`session.inTransaction()` and `session.query()` are available inside the callback; `session.client` exposes the native client. A supplied active Simfinity PostgreSQL session is joined without committing or releasing it. Handles from other instances or completed transactions are rejected. The wrapper does not adopt an arbitrary `pg.Client`.

In v3.1.0, standalone `saveObject(typeName, args, session?, context?)` owns one transaction for the complete workflow: validators, controller hooks, parent rows, normalized embeddeds and nested independent entities. A failure rolls back that workflow. A supplied active session is joined without taking over its lifecycle or retries. Reads reconstruct an owner and its embeddeds from one snapshot, preserving array order, duplicates and null items even during concurrent replacements.

Errors that PostgreSQL reports are exposed as `SimfinityError`s without SQL or constraint details, wherever they come from: Simfinity's statements, `session.query()`, `session.client` and other `pg` connections used inside the callback. A connection that cannot be acquired or is lost becomes `DATABASE_ERROR` (500). The driver error is available as the non-enumerable `error.cause` and through `error.getCause()`; see [PostgreSQL database errors](reference/errors.md#postgresql-database-errors) for the codes. Inside the callback, `session.query()` rejects with the driver's own error, so you can recover with a savepoint. Errors thrown by validators, controllers, middleware, custom mutations and `withTransaction` callbacks propagate unchanged, whether or not they carry a `code`, as on MongoDB. So does a client-side failure of a connection Simfinity did not open, such as your own pool's `connect ECONNREFUSED host:port`. A transaction in which a statement failed cannot commit, even when your code caught the error, and fails with `DATABASE_ERROR` (500). When another statement runs in it after the failure, such as Simfinity's own write after an `onSaving` hook, that statement fails with `Database operation failed`. When it reaches `COMMIT` without another statement, as after an `onSaved` hook or at the end of a callback, PostgreSQL rolls it back and reports `ROLLBACK` for the `COMMIT`; the call then fails with `Transaction was rolled back because one of its statements failed`, and `error.getCause()` returns an `Error` with the message `COMMIT reported ROLLBACK`. The plugin reads that from the `command` of the `COMMIT` result, which `pg` clients report: a custom pool or client wrapper must pass `command` through, or such a transaction reports success with nothing stored.

## Attributes and relationships

| Declaration | Generated storage |
| --- | --- |
| Entity identity | `id uuid PRIMARY KEY`; declared `id`/`_id` aliases refer to that identity, not separate columns. |
| `String`, `Int`, `Float`, `Boolean` | `text COLLATE "C"`, `integer`, `double precision`, `boolean`. |
| `DateTime`, `Date`, `Time` custom scalar | `timestamp with time zone`, following Mongo's date storage interpretation. |
| Validated scalar | Recursively follows `.baseScalarType`. Validation code stays application behavior and is not translated to SQL. |
| Enum | `text COLLATE "C"` plus a check against its internal values converted to strings; decoded back to GraphQL internal values. Internal values may contain quotes and backslashes, but not NUL (U+0000). Exported DDL writes values with backslashes as `E''` literals, and initialization compares check constants by value. |
| Scalar list | Native PostgreSQL array, with no generated index. Required item wrappers add a non-null-item check; nullable enum items are accepted. Element filters scan the array. |
| Other `GraphQLID` | Indexed `uuid` for a single value, with no FK unless a relation supplies a target; an `[ID]` list is a `uuid[]` array without an index, as on MongoDB. Applications need valid UUID values. |
| Required persisted scalar/reference | `NOT NULL`. Stronger than the current Mongo generator, which does not map every GraphQL required marker to Mongoose `required`. |
| `readOnly` | Excluded from generated mutation inputs. The stored field remains writable by hooks/native code. |
| `unique: true` on a root scalar/single reference | Unique index with `NULLS NOT DISTINCT`. A single optional unique value permits at most one SQL NULL. |
| Single non-embedded object | FK in `connectionField` (or the GraphQL field name when omitted). A singular field alone does not imply one-to-one; `unique: true` supplies that constraint. |
| Non-embedded list | FK on the child; resolve `connectionField` as a child GraphQL name or storage name. Reuse its declared reference, infer a target for an existing scalar ID, or add a private child reference. |
| Many-to-many | Explicit linking entity with its own identity and two FKs. Use a declarative composite unique index if duplicate pairs are forbidden. |
| Embedded subtree without references or unique fields | JSONB in the owner row. Generated immutable validation functions and CHECKs enforce declared nested object/list shapes, required fields/items, scalar types and enum values. Optional parents and nullable items remain valid; unknown object keys are allowed. JSONB DateTime values use the runtime UTC ISO timestamp encoding. |
| Embedded subtree containing references or unique fields | Private owned tables, owner FKs, and real FKs to external entities. Reconstructed into the original nested API shape. |

UUID identities are a PostgreSQL storage choice for new applications. Custom code expecting 24-character ObjectIds must adapt. Accepted empty strings are persisted, alongside zero, false and empty arrays. Only undefined/null skip value materialization; explicit nullable clears retain their documented update behavior. PostgreSQL's typed columns also reject values MongoDB might coerce or accept. Optional root scalar columns use SQL NULL for absent values. Embedded storage additionally preserves field presence, defaults and minimization as described below; PostgreSQL records remain plain objects rather than Mongoose documents. Fields named like `Object.prototype` members, such as `constructor` or `toString`, are stored and read like other fields, scalar and embedded; see [fields named like Object.prototype members](guide/schema.md#fields-named-like-object-prototype-members).

For explicit pair uniqueness:

```javascript
const Assignment = new GraphQLObjectType({
  name: 'Assignment',
  extensions: { indexes: [{ fields: ['serie', 'star'], unique: true }] },
  fields: { /* id, serie reference, star reference */ },
});
```

Index field names resolve to stored scalar/reference columns. `extensions.indexes` is a new PostgreSQL metadata feature; the Mongo engine still uses existing index configuration/onModelCreated. JavaScript validators cannot be inferred as database constraints.

Private owned tables use `__id`, `__owner_id`, and, for arrays, `__position`. An owner/position unique index preserves distinct positions while allowing repeated referenced entities. Nullable object-array items have `__item_present`; required fields are checked when an item is present. Parent `__<field>_state` columns distinguish `missing`, `null`, and `present`, including empty arrays. Deferred constraint triggers enforce final-state consistency, including direct SQL INSERT/UPDATE/DELETE: missing/null markers have no rows, present singular values have exactly one row, lists have consecutive positions from zero, and null items have no hidden payload or children. Empty required lists remain valid. Use a transaction when writing parent markers and children separately. Immediate triggers update a private owner-version row to serialize concurrent child edits; REPEATABLE READ transactions may receive a serialization failure and must retry the whole transaction. Embedded object updates preserve the existing shallow merge, while embedded lists are replaced, including when restored after clearing.

Native writes preserve explicit null embedded fields and null list items. Omitted inline objects materialize descendant list defaults; scalar-only empty inline objects minimize away, while empty objects inside embedded lists remain items. The generated GraphQL create materializer omits null object fields before these defaults apply. A stricter PostgreSQL consequence is that an optional inline parent with defaulted descendant lists and a required scalar becomes present: creation must supply that required scalar. MongoDB instead stores the defaulted parent without the required scalar and reads it as `null`. GraphQL create's explicit `null` also gets omitted and does not suppress the defaults; native `create` can store an explicit null parent. Required database constraints are retained.

Owned scalar/reference/JSONB columns and root JSONB columns carry a private `__field__<field>__present` boolean (long names are shortened deterministically) (listed as `presenceColumn` in the column description). A non-null column is present regardless of its marker; SQL NULL with marker false is absent, and SQL NULL with marker true is explicit null. Native writes maintain markers automatically. Direct SQL consumers can set the marker to true when storing explicit null, or set both the value to NULL and marker to false to remove a field. Null owned items cannot carry true field markers. These markers preserve missing-versus-null projection semantics without changing the GraphQL schema.

Date parameters are serialized in canonical UTC per query, including astronomical year zero/negative years translated to PostgreSQL BC notation. No global driver defaults or process timezone are changed. Native timestamp fields/lists remain limited to PostgreSQL's timestamp range, which starts at 4714-11-24 00:00 BC UTC: an earlier value, written or used in a filter, fails with `INVALID_VALUE` (400). JSONB DateTime strings retain finite JavaScript ISO encoding.

Text, text lists and JSONB strings cannot contain NUL (U+0000): such a value, written or used in a filter, fails with `INVALID_VALUE` (400). MongoDB accepts such text and dates. A JSONB string with an unpaired UTF-16 surrogate also fails with `INVALID_VALUE` (400), with the message `Invalid stored value`. A btree index entry is limited to about 2.7 KB after compression: a longer text value in a unique field, an `extensions.indexes` index (including composite indexes) or an embedded unique key fails with `DATABASE_ERROR` (500, PostgreSQL error `54000`), while MongoDB accepts it.

Scalar/reference `unique` fields inside embedded trees and declared unique native scalar lists use private auxiliary key tables with root-owner cascading FKs and native typed values. Real unique indexes distinguish value, null and terminal-empty-array keys. Repeated keys within one root are allowed; another owner cannot claim any of those keys. Missing/null scalar leaves and missing/null/empty ancestor embedded lists contribute null keys; an empty terminal scalar list contributes an empty-array key. Updates/deletes release old keys at transaction end. Key refresh is enforced by deferred database triggers, including for direct SQL. Private key/version tables are generated implementation storage and must not be edited independently.

PostgreSQL supports uniqueness for all its mapped native scalar types (String, enum, Int, Float, Boolean, UUID ID and DateTime), scalar lists, and single references, including within embedded trees. The Mongo generator currently creates `unique` indexes only for scalar string/enum/numeric mappings, including nested scalar fields; scalar-list field flags, Boolean, ID and DateTime flags remain ignored there. Differential tests use explicitly created Mongo array indexes when comparing PostgreSQL's declared scalar-list uniqueness. Both native writers default omitted lists to `[]`, including lists inside omitted singular inline parents; direct SQL does not apply these application defaults.

All entity-reference FKs use `ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE`. Only private ownership links use `ON DELETE CASCADE`. Removing an assignment does not delete either linked entity. All tables/primary keys are created before FKs, allowing self/cyclic references and cycles of referenced collections; callers can explicitly defer constraints within their own transaction to insert a valid cycle.

Unsupported shapes fail before DDL generation: reciprocal lists representing implicit many-to-many, non-embedded collections inside embedded objects, embedded cycles, conflicting aliases/targets, unknown custom scalar storage, enum values that collide after conversion to text, nested lists, and whole embedded-object uniqueness.

## Schema lifecycle

`describeModels(registrations)` returns the discovered GraphQL entity graph without mutating its types. `describeDatabase(registrations, { schema })` returns serializable tables, columns, primary keys, FKs, indexes, checks, ownership/auxiliary metadata, functions, triggers and maintenance queries. Names are deterministic, identifiers are quoted, generated long names are shortened with a hash, and collisions are rejected. This low-level function uses the `public` schema when `schema` is omitted, not the schema of a configured runtime, so pass the schema given to `configure()` or `createPostgres()`. A runtime's `describeDatabase()`, and the module function called without arguments, describe the runtime in its configured schema after `createSchema()`.

`compileDatabaseSchema(description)` returns SQL statements for review/export or execution against an empty schema. Use a trusted description produced by `describeDatabase`; description expressions are SQL configuration, not user input. Functions precede CHECKs and triggers follow tables/FKs/indexes. The exported DDL itself is not an idempotent migration runner. A runtime's `compileDatabaseSchema()`, and the module function called without arguments, return the DDL for the runtime's own description and schema without touching storage; before `createSchema()` they throw `SCHEMA_NOT_CREATED`.

`initializeDatabase(pool, description, { mode })` borrows one `pg.Pool` client, opens its own transaction, takes a transaction-level advisory lock for the schema, inspects the catalog, and awaits completion. It releases the client but never closes the supplied pool.

- `create` (default) creates missing schemas, tables, FKs, indexes, generated functions and triggers. It validates existing column types, collation, nullability/defaults, primary keys, checks, FKs, and indexes. It does not add/change columns or replace incompatible constraints. Existing orphan data makes FK creation fail.
- `validate` uses a read-only transaction and performs no DDL. Missing or mismatched objects produce `SimfinityError` with code `SCHEMA_MISMATCH` and the affected object.
- Columns are matched by name: their physical order is neither checked nor relied on, so columns that a migration appends are fine. A migration must still bring every generated object in line with the new `describeDatabase()` or `compileDatabaseSchema()` output. Adding or reordering fields can change generated function bodies such as `<Root>__owned_valid`, `<Root>__refresh` and `<Table>__<field>__json_valid`, which must be replaced before validation, and a `NOT NULL` column added with a temporary `DEFAULT` must have that default dropped.
- FK checks cover columns, target schema/table/key, actions, deferrability, validation status, and enabled integrity triggers on both source and target tables. Index checks include uniqueness/null behavior, validity, method, expressions/predicates, ordering, and collation. Additional unique constraints/indexes and unexpected table constraints are rejected; unrelated tables and additional nonunique indexes are allowed. These include the btree indexes on `[ID]` list columns that earlier versions generated: initialization keeps them, and each successful run prints a console warning that names them with the `DROP INDEX CONCURRENTLY` statements to run once every process uses the new version. While such an index exists, its list is limited to about 167 identifiers. See the [upgrade notes](resources/compatibility.md#postgresql-id-list-indexes).
- Generated functions are checked for exact identity, body, signature, language, volatility and configuration; triggers are checked for function identity, events, enabled state and deferrability. Drift raises `SCHEMA_MISMATCH` and is never silently replaced. Creation locks existing managed tables, validates stored checks/owned shapes, and backfills unique keys before returning ready; duplicate existing data rolls back every newly created object and key.
- Any failure rolls back the initialization transaction. Existing source storage is never dropped or rewritten. Database errors retain their PostgreSQL error codes; migrations remain explicit application operations.

Startup validation describes the catalog at that time. It is not continuous monitoring of subsequent administrator changes. PostgreSQL's catalog representation changes by version, including [table NOT NULL constraints in PostgreSQL 18](https://www.postgresql.org/docs/18/catalog-pg-constraint.html); integration coverage must accompany support for a new server version.

## Verification and remaining boundaries

The release is verified against real databases and standalone package consumers. The test names in the [compatibility ledger](compatibility.md) refer to suites in the repository. Run `npm test` and `npm run test:packages`; use disposable database URIs for integration suites.

The shared fixture covers Serie/Season/Episode, Star/Assignment, embedded directors and reference-bearing credits, no-endpoint labels, inverse scalar IDs, scopes, hooks and validators. Tests compare actual GraphQL schemas/results across both databases and check PostgreSQL constraints directly, alongside custom mutations, retries, concurrency, state guards and rollback. Release verification covers PostgreSQL 15, 16, and 18 with MongoDB 7/8 replica sets and separate databases for upstream MongoDB regressions.

Existing schemas generated before these constraints or presence columns require an explicit migration where their table/check layouts differ; initialization does not alter columns or replace checks. Generated ordering/date helpers are also catalog-checked for drift.

This version does not claim compatibility with arbitrary Mongoose models, native Mongoose code, MongoDB aggregation pipelines, automatic schema migration, or runtime backend switching. PostgreSQL's Model and Session APIs are intentionally native to its adapter. Shared auth, scalar, validator, and count-plugin helpers live in core; MCP lives in its opt-in package while the MongoDB facade retains compatibility exports.
