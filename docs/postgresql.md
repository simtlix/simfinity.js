# PostgreSQL support

This branch implements PostgreSQL schema generation and GraphQL execution through the shared runtime. The existing `@simtlix/simfinity-js` package continues to run MongoDB. Both backends share schema/input generation, scopes, middleware, validators, controllers, nested mutations, and state-machine orchestration. The packages are experimental; supported behavior and remaining limits are listed below and in the [compatibility ledger](compatibility.md).

The intended backend choice is permanent application configuration. There is no runtime switching, dual writing, or MongoDB-to-PostgreSQL data migration.

## Packages and local setup

Run `npm install` at the repository root to install the workspaces:

| Package | Current exports and dependencies |
| --- | --- |
| `@simtlix/simfinity-js` | Existing MongoDB facade and native adapter, plus existing auth/MCP/scalar/validator/plugin exports. Mongoose dependencies remain here. |
| `@simtlix/simfinity-core` | `createRuntime`, model metadata, typed query plans, scalar factory and error classes. GraphQL peer only; no drivers or MCP. |
| `@simtlix/simfinity-postgres` | `createPostgres`, default-module runtime facade, schema description/DDL/initialization, shared scalar factory and errors. Depends on core and `pg`; GraphQL peer. No MongoDB, Mongoose or MCP dependency. |

The new packages are experimental version `0.1.0` workspaces and have not been published. Before a release, update the existing release/publish workflows for the new packages and publish core before either dependent package; publishing the root package alone would leave its new core dependency unavailable. `npm run test:packages` packs all three, installs them into separate temporary applications, verifies exports and checks dependency isolation. Library code requires Node.js >=18.18.0; development and CI use Node.js 24 for Vitest 4. PostgreSQL requires version 15 or later.

## Executable example

Run this from a file in the repository after `npm install`. Set `DATABASE_URL` to a development PostgreSQL instance. Register every object type used by generated GraphQL inputs and relations. `AuthorType` has a model even though it is registered without a root endpoint.

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

For the module facade, use `import * as simfinity from '@simtlix/simfinity-postgres'` followed by `simfinity.configure({ pool, schema: 'library' })` once. Registration and GraphQL APIs have the same signatures. The factory is useful for independent instances: use fresh `GraphQLObjectType` objects for each instance because resolver generation mutates those objects in place. Register types before `createSchema()`; PostgreSQL rejects later registrations. Configuration takes a snapshot of the pool/schema binding and rejects reconfiguration. The caller owns the pool and closes it at application shutdown.

The server must await `initializeDatabase()` before accepting operations. A missing or failed initialization produces `DATABASE_NOT_INITIALIZED`. To disable schema creation, call `preventCreatingCollection(true)` before `createSchema()`; default initialization then validates only, and an explicit `mode: 'create'` is rejected. `mode: 'validate'` can also be selected directly.

## GraphQL execution and native access

Generated operation names, arguments, introspection extensions and nested `added`/`updated`/`deleted` inputs are shared with MongoDB. `GraphQLNonNull` and list-item nullability are retained in create inputs; update inputs permit omission while retaining item nullability. Root `find`, `get_by_id` and `aggregate` scopes run after middleware and before adapter queries. Scope predicates stay conjoined with caller OR groups. Generated single relationships run target `get_by_id` middleware/scopes, and generated collections run target `find` middleware/scopes. Immutable referenced-ID and parent predicates are applied independently of mutable filters and before pagination. Custom resolvers retain their own authorization responsibility.

Filters support EQ, NE, LT, LTE, GT, GTE, BTW, IN, NIN and literal case-sensitive LIKE, with nested AND/OR, typed scalar and relationship paths, pagination, sort, and `context.count`. Queries preserve repeated roots from matching inverse children and their contribution to counts and aggregates. Matching predicates on the same referenced child share a join. Embedded scalar predicates retain Mongo's array membership behavior, without expanding root rows. Comparisons use bound values and metadata-validated paths; malformed paths or values produce domain errors. Text ordering uses binary `C` collation rather than the database's language locale.

`configureQueryLimits({ maxPageSize: 500 })` configures the shared process-wide list maximum (default 1000). Calling it without options restores the default. Unpaged lists return at most `Math.min(100, maxPageSize)` rows. Explicit page/size and calculated skip must be safe integers, with page >= 1 and size between 1 and the maximum; invalid input raises `INVALID_PAGINATION`. Unpaged aggregates stay unbounded. Sort/filter paths must end at a declared scalar or enum. Filter lists cannot contain null elements, and EQ/NE take scalar values rather than whole arrays.

Nested collection mutations run child middleware (`{ input }` for save/update, `{ id }` for delete). Child update/delete IDs are checked for existing parent ownership after middleware, inside the transaction. Missing children raise `NOT_VALID_ID`; foreign-parent children raise `FORBIDDEN`. Pre-write hooks cannot change the required parent connection. These checks do not replace application write permissions or turn query scopes into write authorization.

Aggregation returns `{ groupId, facts }`; SUM/AVG/COUNT use JavaScript numbers and COUNT counts contributing rows. MIN/MAX support scalar values including Boolean and UUID identities. Unsupported queries fail with `UNSUPPORTED_QUERY`: whole embedded object sort/grouping, scalar lists nested inside embedded lists, array-valued aggregate facts except COUNT, and grouping by scalar paths inside embedded lists. The latter requires preserving Mongo's distinction between absent fields and explicit nulls when projecting array group keys.

Generated and registered custom mutations run on one transaction client using repeatable-read isolation. Validators and hooks receive the same context and active session. The adapter retries confirmed serialization/deadlock aborts up to five times; middleware runs once, while transactional hooks/callbacks may run again. Each attempt receives fresh input-object/list/Date structures. Enum values and opaque custom scalar payloads retain their identity; treat those payloads as immutable. Keep external effects in retryable hooks idempotent.

State transitions lock and check the current row in that transaction. PostgreSQL uses GraphQL enum internal values consistently for storage, filters and guards, including when an internal value equals another state's name. Mutation results and subsequent reads serialize through the same enum.

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

Foreign-key, uniqueness, required-value and other PostgreSQL execution errors are exposed as `SimfinityError`, without SQL or constraint details. Existing domain errors from validators/controllers are preserved.

## Attributes and relationships

| Declaration | Generated storage |
| --- | --- |
| Entity identity | `id uuid PRIMARY KEY`; declared `id`/`_id` aliases refer to that identity, not separate columns. |
| `String`, `Int`, `Float`, `Boolean` | `text COLLATE "C"`, `integer`, `double precision`, `boolean`. |
| `DateTime`, `Date`, `Time` custom scalar | `timestamp with time zone`, following Mongo's date storage interpretation. |
| Validated scalar | Recursively follows `.baseScalarType`. Validation code stays application behavior and is not translated to SQL. |
| Enum | `text COLLATE "C"` plus a check against its internal values converted to strings; decoded back to GraphQL internal values. |
| Scalar list | Native PostgreSQL array. Required item wrappers add a non-null-item check; nullable enum items are accepted. |
| Other `GraphQLID` | Indexed `uuid`, with no FK unless a relation supplies a target. Applications need valid UUID values. |
| Required persisted scalar/reference | `NOT NULL`. Stronger than the current Mongo generator, which does not map every GraphQL required marker to Mongoose `required`. |
| `readOnly` | Excluded from generated mutation inputs. The stored field remains writable by hooks/native code. |
| `unique: true` on a scalar/single reference | Unique index with `NULLS NOT DISTINCT`. A single optional unique value permits at most one SQL NULL. |
| Single non-embedded object | FK in `connectionField || fieldName`. A singular field alone does not imply one-to-one; `unique: true` supplies that constraint. |
| Non-embedded list | FK on the child; resolve `connectionField` as a child GraphQL name or storage name. Reuse its declared reference, infer a target for an existing scalar ID, or add a private child reference. |
| Many-to-many | Explicit linking entity with its own identity and two FKs. Use a declarative composite unique index if duplicate pairs are forbidden. |
| Embedded subtree without references | JSONB in the owner row. The runtime validates typed nested writes; DDL enforces top-level nullability, not a complete JSON document schema. |
| Embedded subtree containing references | Private owned tables, owner FKs, and real FKs to external entities. Reconstructed into the original nested API shape. |

UUID identities are a PostgreSQL storage choice for new applications. Custom code expecting 24-character ObjectIds must adapt. Accepted empty strings are persisted, alongside zero, false and empty arrays. Only undefined/null skip value materialization; explicit nullable clears retain their documented update behavior. PostgreSQL's typed columns also reject values MongoDB might coerce or accept. Optional stored scalars use SQL NULL for absent values; hooks should not depend on Mongoose document defaults or distinguish absence from null in native records.

For explicit pair uniqueness:

```javascript
const Assignment = new GraphQLObjectType({
  name: 'Assignment',
  extensions: { indexes: [{ fields: ['serie', 'star'], unique: true }] },
  fields: { /* id, serie reference, star reference */ },
});
```

Index field names resolve to stored scalar/reference columns. `extensions.indexes` is a new PostgreSQL metadata feature; the Mongo engine still uses existing index configuration/onModelCreated. JavaScript validators cannot be inferred as database constraints.

Private owned tables use `__id`, `__owner_id`, and, for arrays, `__position`. An owner/position unique index preserves distinct positions while allowing repeated referenced entities. Nullable object-array items have `__item_present`; required fields are checked when an item is present. Parent `__<field>_state` columns distinguish `missing`, `null`, and `present`, including empty arrays. The writer maintains these markers and rows together. Arbitrary direct SQL can still create inconsistent marker/row combinations; required embedded-row existence is not enforced by SQL. Embedded object updates preserve the existing shallow merge, while embedded lists are replaced, including when restored after clearing.

All entity-reference FKs use `ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY IMMEDIATE`. Only private ownership links use `ON DELETE CASCADE`. Removing an assignment does not delete either linked entity. All tables/primary keys are created before FKs, allowing self/cyclic references; callers can explicitly defer constraints within their own transaction to insert a valid cycle.

Unsupported shapes fail before DDL generation: reciprocal lists representing implicit many-to-many, non-embedded collections inside embedded objects, embedded cycles, conflicting aliases/targets, unknown custom scalar storage, enum values that collide after conversion to text, nested lists, embedded uniqueness, and scalar-list/multikey uniqueness. The last two need owner-aware handling to preserve Mongo's missing/null and duplicate-within-owner behavior; simple SQL unique indexes would be incorrect.

## Schema lifecycle

`describeModels(registrations)` returns the discovered GraphQL entity graph without mutating its types. `describeDatabase(registrations, { schema })` returns serializable tables, columns, primary keys, FKs, indexes, checks, and ownership metadata. Names are deterministic, identifiers are quoted, generated long names are shortened with a hash, and collisions are rejected.

`compileDatabaseSchema(description)` returns SQL statements for review/export or execution against an empty schema. Use a trusted description produced by `describeDatabase`; description expressions are SQL configuration, not user input. The exported DDL itself is not an idempotent migration runner.

`initializeDatabase(pool, description, { mode })` borrows one `pg.Pool` client, opens its own transaction, takes a transaction-level advisory lock for the schema, inspects the catalog, and awaits completion. It releases the client but never closes the supplied pool.

- `create` (default) creates missing schemas, tables, FKs, and indexes. It validates existing column types, collation, nullability/defaults, primary keys, checks, FKs, and indexes. It does not add/change columns or replace incompatible constraints. Existing orphan data makes FK creation fail.
- `validate` uses a read-only transaction and performs no DDL. Missing or mismatched objects produce `SimfinityError` with code `SCHEMA_MISMATCH` and the affected object.
- FK checks cover columns, target schema/table/key, actions, deferrability, validation status, and enabled integrity triggers on both source and target tables. Index checks include uniqueness/null behavior, validity, method, expressions/predicates, ordering, and collation. Additional unique constraints/indexes and unexpected table constraints are rejected; unrelated tables and additional nonunique indexes are allowed.
- Any failure rolls back the initialization transaction. Existing storage is never dropped or rewritten. Database errors retain their PostgreSQL error codes; migrations remain explicit application operations.

Startup validation describes the catalog at that time. It is not continuous monitoring of subsequent administrator changes. PostgreSQL's catalog representation changes by version, including [table NOT NULL constraints in PostgreSQL 18](https://www.postgresql.org/docs/18/catalog-pg-constraint.html); integration coverage must accompany support for a new server version.

## Verification and remaining work

```bash
npm run lint
npm test
npm run test:packages
SIMFINITY_MONGODB_URI='mongodb://.../disposable_db?replicaSet=rs0&directConnection=true' \
SIMFINITY_POSTGRES_URI='postgresql://.../disposable_db' npm run test:integration
```

MongoDB tests drop the configured database; PostgreSQL tests create and remove private random schemas. Use disposable instances. Without the corresponding environment variables, integration suites are reported as skipped. CI provisions real databases.

The shared fixture covers Serie/Season/Episode, Star/Assignment, embedded directors and reference-bearing credits, no-endpoint labels, inverse scalar IDs, scopes, hooks and validators. Tests compare actual GraphQL schemas/results across both databases and check PostgreSQL constraints directly, alongside custom mutations, retries, concurrency, state guards and rollback. CI covers PostgreSQL 15, 16 and 18 with MongoDB 7 replica sets.

Remaining work includes embedded/multikey uniqueness, the explicitly unsupported array queries, broader parity fixtures for legacy Mongo edge behavior, schema migrations and release automation. Auth/MCP/prebuilt scalar/validator/count-plugin helpers remain exports of the original MongoDB package; extracting those optional helpers without importing its dependency chain is a separate packaging phase. This version does not claim complete compatibility with arbitrary MongoDB models, native code or query pipelines.
