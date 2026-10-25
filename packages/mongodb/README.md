# @simtlix/simfinity-js

MongoDB/Mongoose adapter and compatibility facade for Simfinity. This package generates GraphQL queries, mutations, relationships and models from `GraphQLObjectType` definitions using the shared Simfinity runtime.

```sh
npm install @simtlix/simfinity-js graphql@^16.11.0 mongoose@^8.24.2
```

`graphql` and `mongoose` are peer dependencies: the facade uses your application's copies, and npm reports an out-of-range version as a peer conflict instead of installing a second copy. The MCP transports (`createMCPServer`, `startStdioMCPServer`, `createHTTPMCPHandler`) need the optional peer `@modelcontextprotocol/sdk@^1.31.0`; install it only when you use them. `generateMCPTools` works without it. The package does not install `graphql-middleware`.

```javascript
import mongoose from 'mongoose';
import * as simfinity from '@simtlix/simfinity-js';

await mongoose.connect(process.env.MONGODB_URI);
// Register your GraphQLObjectType definitions before creating the schema.
simfinity.connect(null, SerieType, 'serie', 'series');
const schema = simfinity.createSchema();
```

Use a MongoDB replica set or sharded cluster for transactional mutations. The library requires Node.js >=18.18.0 and GraphQL 16.

Generated single-reference reads can be batched within a request. Models with any `find` or `findOne` pre/post query hook retain individual `findOne` reads, including hooks shared by both operations, to preserve access restrictions and other middleware behavior. For the same reason, they keep the read that generated mutations otherwise skip before a delete without `onDelete` and before an update that merges no embedded value. So do models with `findOneAndUpdate` or `findOneAndDelete` hooks (including the one Mongoose's `timestamps` option adds) or with their own `findById`, `findOne`, `findByIdAndUpdate`, `findOneAndUpdate`, `findByIdAndDelete` or `findOneAndDelete` statics, which run before Mongoose casts the ID: the read rejects a malformed ID first. Models with application `_id` setters also keep the read, because setters can branch on the query operation before casting; Mongoose's built-in automatic ObjectId setter remains eligible for the optimization. See the [relationship contract](https://simtlix.github.io/simfinity.js/guide/relationships.html).

Generated models store enum internal values with their own type (numbers, booleans or strings; other combinations as given) and support embedded fields named `type`. Embedded types that contain each other are rejected with `INVALID_MODEL` (`Embedded cycle at …`) when a generated model reaches them, and always in transactional mode; in the default mode, a cycle that only supplied models reach is not checked. Range filters, sorts and aggregates on numeric and boolean enums follow that type; PostgreSQL uses their text form. Earlier versions stored numeric and boolean enum values as strings; convert existing documents once as described in the [schema guide](https://simtlix.github.io/simfinity.js/guide/schema.html#what-gets-generated).

Virtual fields (`extensions: { virtual: true }`, with the field's own `resolve`) get no path, no `[]` default and no index in generated models, on entities and embedded types, and no entry in the transactional integrity registry, so they need no `relation` in either mode and documents look the same with or without them. Generated writes never set or unset them, and Mongoose's strict mode drops a value that a controller assigns to a generated document for one. An embedded type whose members are all virtual becomes a strict subdocument without paths rather than a Mixed path, so nothing is stored for it but the `_id` of list items. With a generated model, values stored before a field became virtual stay in the documents: Mongoose drops an `$unset` of a path the model does not declare, so remove them with a driver-level update, such as `getModel(Type).collection.updateMany({}, { $unset: { busyRanges: '' } })`, or with `updateMany(filter, update, { strict: false })`; a generated update that sets an embedded parent rewrites it, which drops the stored keys of its virtual members. A supplied model keeps the paths it declares: documents stored earlier keep their values for the field, which nothing reads or writes until `$unset` removes them, and an index on such a path stays until you drop it. `buildQuery()` rejects a path through a virtual field with `INVALID_FILTER_FIELD` (400).

Text filters compile to escaped regular expressions, so a value never becomes regex syntax: `LIKE` and `ILIKE` match anywhere, `STARTS_WITH` and `ISTARTS_WITH` are anchored with `^`, `ENDS_WITH` and `IENDS_WITH` with `\z` (so a trailing newline is part of the value), and `IEQ` with both. The `I` operators add the `i` option, which applies the Unicode simple case folding of the server's PCRE2 build (`É`/`é`, `ẞ`/`ß`, `σ`/`ς`, `µ`/`μ`, `ſ`/`s`), never a length-changing or Turkic folding (`ß`/`ss`, `İ`/`i`), and does not fold characters newer than that build, such as U+A7DC; the [queries guide](https://simtlix.github.io/simfinity.js/guide/queries.html) lists where PostgreSQL differs. Only `STARTS_WITH` reads a prefix range of an index on the field, a String list or an embedded path; the other text operators test every key of such an index, or every document without one, and `$regex` ignores collations, so a case-insensitive collation index does not serve them. A value whose escaped pattern is longer than MongoDB's 32,764-byte pattern limit fails with `INVALID_FILTER_VALUE` (400) before the query runs, also for `LIKE`. `createMongoAdapter()` declares every operator it compiles in `queryFeatures`; a copy of the adapter without it supports only the operators of 3.7.0.

`IS_EMPTY` and `IS_NOT_EMPTY` take no value and compile to plain query operators inside the same `$match`, so they also filter counts, aggregates and batched collection reads (`$unionWith`): `$in: [null, ""]` and `$nin` on `String` fields, which an index on the field serves; `null` and `$ne: null` on other scalars, enums and the record identity `_id`; on an application scalar without a supported base, such as a `JSON` scalar, which MongoDB stores as written, `null` without arrays, `{ $and: [{ p: null }, { p: { $not: { $type: "array" } } }] }`, and its `$nor`, so that an array, also `[null]`, is a value, as reads return it; `"p.0": { $exists: false }` and `$exists: true` on scalar lists and embedded lists, which never look inside the items; and, on an embedded object, an `$or` of `null` and the `IS_EMPTY` form of every stored member, with its `$nor` for `IS_NOT_EMPTY`, so an object whose stored members are all empty, such as `{ w: null, label: "" }`, is empty. A term or group condition without a `path` tests the object or list field itself. Embedded `id` members are read where other filters read them, so an object of a supplied subdocument schema with an automatic `_id` is never empty, unlike on PostgreSQL. A path that continues inside an embedded list or a collection, such as `lines.qty` or `seasons.year`, fails with the permanent `INVALID_FILTER_PATH` (400), since emptiness of a value inside a list is not defined; the [queries guide](https://simtlix.github.io/simfinity.js/guide/queries.html#empty-values) has the rules and the other codes.

The adapter also declares `queryFeatures.referenceEmptiness`, so these operators cross single references and end at references and collections, such as `director IS_EMPTY`, `director.name IS_EMPTY` or `seasons IS_EMPTY`, and an embedded object with a reference or collection member follows the member rule. A crossing joins the target with `$lookup` and `$unwind`, and the target's `id` right after it is its record identity, which is empty exactly when the reference is. A reference or collection is a frame: one `$lookup` that keeps at most one record id, so it never repeats a document, matched with `"alias.0": { $exists: false }` and its `$nor`; a collection frame reads the child's connection field and also tests its local key for null, because `$lookup` matches a missing local key with every child whose connection field is null. The joins and frames run before the `$match`, so they also filter counts, aggregates and batched collection reads, and they probe the `_id` index or the index on the connection field, which generated models create and a supplied model needs to declare. A client's condition reads each target through its `find` scope, inside the `$lookup` pipeline, so a record the scope hides reads as missing, also on the way to a later hop. Conditions that middleware and scopes add, and `buildQuery()` called directly, read stored data, so a dangling reference, to a record that no longer exists, is empty. A related type without a model fails with `INVALID_FILTER_PATH` (400), as for the other operators, and supplied models on another database or connection and discriminator targets are not supported, as for every relation path. A collection inside an embedded type, which only a supplied model can declare, is read through the embedded object's `_id`, as relation paths read it. The [query scope guide](https://simtlix.github.io/simfinity.js/guide/query-scope.html) describes client and trusted conditions, and the [middleware guide](https://simtlix.github.io/simfinity.js/guide/middleware.html) how to edit client filters without detaching them.

The facade registers generated models on your application's default Mongoose instance and does not change global Mongoose options such as `strictQuery`. Supplied models may use another connection, such as one from `mongoose.createConnection()`: generated mutations and `saveObject()` use the model's connection, and, in the default `referentialIntegrity: 'off'` mode, custom mutations use the default connection unless it is unused, never opened and without compiled models, also on its `useDb()` descendants, and the registered models share one MongoDB client; with transactional reference integrity they use the first protected model's connection. Named views need no session: they run the generated list path. Custom queries registered with `registerCustomQuery()` receive no session; a callback that needs a transaction opens it with the `transaction()` of the Mongoose connection whose models it reads. `createMongoAdapter().castId` accepts only an ObjectId or its 24-character hexadecimal string and throws `NOT_VALID_ID` (400) otherwise; create new identifiers with `new mongoose.Types.ObjectId()`. Owned transactions retry transient failures after a short random delay, and a write conflict that outlasts the retries fails with `TRANSACTION_RETRY_EXCEEDED` (409).

Mongoose 8.24.2 or later within version 8 is required to exclude the update-casting prototype-pollution vulnerability. Existing applications should update Mongoose and their dependency lockfile, then run `npm audit`; upgrading Simfinity does not refresh every transitive dependency already locked by the application.

## Optional batched collection reads

Generated collection fields read one parent at a time by default. With `batchedCollections: true`, the adapter reads the collection fields of many parents that share their arguments with aggregate commands of up to `collectionBatchSize` parents each (an integer from 1 to 100, default 5), sent concurrently:

```javascript
import { createMongoAdapter, createRuntime } from '@simtlix/simfinity-js';

const adapter = createMongoAdapter({ batchedCollections: true }); // collectionBatchSize: 5
const simfinity = createRuntime(adapter);
```

Each parent's own pipeline (filters, sort and page) runs as one sub-pipeline: the first is the command's pipeline and the others are `$unionWith` stages. Like `referentialIntegrity`, the option needs your own adapter and runtime; the package-root runtime (`simfinity.connect()` and the rest) keeps one read per parent. Children of models with `aggregate` middleware, their own `aggregate` static, a discriminator child model or a wrapped `Model.collection.aggregate`, reads inside a `transactionAsyncLocalStorage` transaction, and adapter copies or overrides of `findChildren` keep one read per parent. A command runs its sub-pipelines one after another, so fewer commands can come with a slower single request, and command monitoring, query settings and `$queryStats` see the new command shape: read the [upgrade notes](https://simtlix.github.io/simfinity.js/resources/compatibility.html#upgrade-to-3-7-0) before enabling it. Invalid values throw `INVALID_MONGO_ADAPTER_OPTIONS` (400).

## Optional transactional reference integrity

Choose the mode once when creating an adapter; the default remains `'off'`:

```javascript
import { createMongoAdapter, createRuntime } from '@simtlix/simfinity-js';

const adapter = createMongoAdapter({ referentialIntegrity: 'transactional' });
const simfinity = createRuntime(adapter);
await mongoose.connect(process.env.MONGODB_URI);
// Register every application type on this runtime.
simfinity.connect(null, SerieType, 'serie', 'series');
const schema = simfinity.createSchema();
await adapter.initialize();
```

Initialization checks transaction support and audits existing references. Protected mutations reject nonexistent references, including embedded paths, inferred/private inverse keys and explicit link entities. Deleting a referenced target is restricted. Target-document writes coordinate concurrent creation/deletion; a violation rolls back the whole mutation with `REFERENCE_CONSTRAINT_VIOLATION` (409).

Owned transactions use snapshot reads and majority commits. Supplied sessions need the same options; a reference violation or guarded-write error aborts even a supplied transaction. The reserved `_simfinityReferenceLock` storage field is excluded from GraphQL. All writers must use the same complete registry and mode. Direct Mongoose/driver writes bypass this protection; this is not a native MongoDB FK. Read the [full setup, concurrency and migration contract](https://simtlix.github.io/simfinity.js/guide/mongodb-integrity.html).

The source now lives in `packages/mongodb` in the monorepo. Its public npm name remains `@simtlix/simfinity-js`; existing imports, including paths under `@simtlix/simfinity-js/src/`, retain their layout. Shared helpers, error identities and MCP compatibility exports are preserved. Internal Simfinity dependencies use the same exact release version.

Its legacy `src/` modules that re-export public API (`src/index.js`, `src/auth/index.js`, `src/auth/errors.js`, `src/auth/expressions.js`, `src/auth/rules.js`, `src/plugins.js`, `src/scalars.js`, `src/validators.js`, `src/mcp.js`, `src/const/*.js`, `src/errors/*.js`, and their extensionless aliases) ship TypeScript declarations with the types of the package root and the matching `@simtlix/simfinity-core` subpaths; `src/mongo/*` is internal and undeclared. New code should still import `auth`, `plugins`, `scalars` and `validators` from the package root. Importing the typed `@simtlix/simfinity-core` subpaths, such as `@simtlix/simfinity-core/auth`, instead needs `@simtlix/simfinity-core` as a direct dependency pinned to this package's exact version.

For tooling that locates the package, use `require.resolve('@simtlix/simfinity-js/package.json')` or the package root without a trailing slash. Directory specifiers ending in `/` were not valid ESM imports and are not supported by the export map, including in `require.resolve`; use explicit filenames such as `src/auth/index.js`.

- [MongoDB quick start](https://simtlix.github.io/simfinity.js/guide/getting-started.html)
- [API reference](https://simtlix.github.io/simfinity.js/reference/api.html)
- [Database comparison](https://simtlix.github.io/simfinity.js/guide/databases.html)
- [MCP integration](https://simtlix.github.io/simfinity.js/guide/mcp.html)
- [Complete library documentation](https://github.com/simtlix/simfinity.js#readme)
- [Aggregation examples](./AGGREGATION_EXAMPLE.md)

## Client metadata

In the next release, install the optional `@simtlix/simfinity-descriptor` package,
aligned with your Simfinity version. It exports `buildClientDescriptor(schema)`
and `createClientDescriptorHandler(schema, { authorize: 'public' })`. The builder
describes the exact `createSchema()` result; the explicitly mounted handler can
instead use an application access function. These functions are not facade/core
exports. The descriptor does not evaluate dynamic permissions or serialize
arbitrary validators.

Legacy introspection stays enabled by default in 3.x. To opt out, import
`configureIntrospection` from `@simtlix/simfinity-core/introspection` in a separate
bootstrap module and call it with `{ fieldExtensions: false }` **before importing
the runtime or facades**. That direct import requires core as a direct dependency
pinned to the facade's exact version, including under pnpm or Yarn PnP. A late
call fails without deleting installed metadata. Migrate clients selecting
`__Field.extensions` before opting out. See the [descriptor reference](https://simtlix.github.io/simfinity.js/reference/client-descriptor.html)
for the format, protected HTTP access and composition limits.
