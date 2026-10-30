# @simtlix/simfinity-js-client

Introspection-driven GraphQL client for [simfinity-js](https://github.com/simtlix/simfinity.js) APIs. It discovers your schema at runtime via introspection and exposes a chainable query builder, CRUD helpers, aggregate queries, state-machine transitions, schema metadata access, mutation input transformation, and more — no code generation required.

> Since 3.19.0, the client is maintained in the Simfinity monorepo and follows its aligned release version. Existing valid 1.1 JavaScript calls remain supported.

## Installation

```bash
npm install @simtlix/simfinity-js-client@3.19.0
```

## Quick Start

```js
import SimfinityClient from '@simtlix/simfinity-js-client';

const client = new SimfinityClient('http://localhost:3000/graphql');
await client.init();

// Optional: attach auth headers (perform login in your app; this client does not include login)
const tokenStore = { accessToken: null };
const authedClient = new SimfinityClient('http://localhost:3000/graphql', {
  prepareHeaders(headers) {
    if (tokenStore.accessToken) {
      headers['Authorization'] = `Bearer ${tokenStore.accessToken}`;
    }
  },
});
await authedClient.init();

const series = await client.find('serie').exec();
console.log(series);
```

## API Reference

### `new SimfinityClient(endpoint [, options])`

Creates a new client instance pointing at the given GraphQL endpoint.

- **`options.prepareHeaders(headers)`** (optional): invoked before every GraphQL HTTP request. Mutate the plain `headers` object to add credentials (for example `Authorization`). The client does not implement login — call your auth API separately, then set tokens in a closure or store that `prepareHeaders` reads.

### `client.init()`

By default, runs an extended introspection query against the endpoint and builds internal registries of types, queries, and mutations — including Simfinity-specific field extensions (relation metadata, state machine flags, read-only markers). **Must be called before any other method.**

### Schema Inspection

| Method | Returns |
|---|---|
| `client.getTypes()` | All discovered types (objects, enums, scalars, inputs) |
| `client.getQueries()` | All root query fields |
| `client.getMutations()` | All root mutation fields |

---

### Query Builder — `client.find(typeName)`

Returns a chainable `QueryBuilder`. Call `.exec()` to execute.

```js
const results = await client.find('serie')
  .where('categories', 'EQ', 'Drama')
  .joinObject('director', 'name country')
  .joinCollection('seasons', 'number year state')
  .joinCollection('seasons.episodes', 'number name')
  .fields('id name categories')
  .page(1, 10)
  .sort('name', 'ASC')
  .exec();
```

#### `.where(field, operator, value [, value2])`

Filter by a scalar field. Supported operators depend on the server schema (e.g. `EQ`, `NE`, `GT`, `LT`, `GTE`, `LTE`, `BTW`, `LIKE`, `NIN`).

#### `.where(field, terms)`

Filter by a collection field using an array of term objects:

```js
.where('seasons', [
  { path: 'episodes.name', operator: 'EQ', value: 'Pilot' }
])
```

#### `.or(groups)` / `.and(groups)`

Add AND/OR logical filter groups for complex boolean conditions. Each method accepts an array of `QLFilterGroup` objects and can be called multiple times (groups accumulate). These combine with existing flat `.where()` filters via AND at the top level.

A `QLFilterGroup` is a plain object with optional `AND`, `OR`, and `conditions` fields:

```js
{
  conditions: [{ field: 'category', operator: 'EQ', value: 'Drama' }],
  AND: [/* nested QLFilterGroup objects */],
  OR:  [/* nested QLFilterGroup objects */],
}
```

**Simple OR** -- return series in either Drama or Comedy:

```js
const results = await client.find('serie')
  .or([
    SimfinityClient.condition('categories', 'EQ', 'Drama'),
    SimfinityClient.condition('categories', 'EQ', 'Comedy'),
  ])
  .fields('id name categories')
  .exec();
```

**Flat filters combined with OR** -- flat `.where()` is ANDed with the OR group:

```js
const results = await client.find('serie')
  .where('categories', 'NE', 'Horror')
  .or([
    SimfinityClient.condition('name', 'LIKE', 'Breaking'),
    SimfinityClient.condition('name', 'LIKE', 'Game'),
  ])
  .fields('id name categories')
  .exec();
// Equivalent to: categories != "Horror" AND (name LIKE "Breaking" OR name LIKE "Game")
```

**Nested AND inside OR**:

```js
const results = await client.find('serie')
  .or([
    { AND: [
      SimfinityClient.condition('categories', 'EQ', 'Drama'),
      SimfinityClient.condition('year', 'GTE', 2020),
    ]},
    { AND: [
      SimfinityClient.condition('categories', 'EQ', 'Comedy'),
      SimfinityClient.condition('year', 'GTE', 2015),
    ]},
  ])
  .exec();
// Equivalent to: (categories = "Drama" AND year >= 2020) OR (categories = "Comedy" AND year >= 2015)
```

**AND with nested OR groups**:

```js
const results = await client.find('serie')
  .where('year', 'GTE', 2000)
  .and([
    { OR: [
      SimfinityClient.condition('categories', 'EQ', 'Drama'),
      SimfinityClient.condition('categories', 'EQ', 'Comedy'),
    ]},
    { OR: [
      SimfinityClient.condition('director', 'EQ', 'UK', 'country'),
      SimfinityClient.condition('director', 'EQ', 'US', 'country'),
    ]},
  ])
  .exec();
// Equivalent to: year >= 2000 AND (Drama OR Comedy) AND (UK OR US director)
```

**Relationship path filtering** -- use the `path` parameter for object field conditions:

```js
.or([
  SimfinityClient.condition('director', 'LIKE', 'Adams', 'name'),
  SimfinityClient.condition('director', 'LIKE', 'Nolan', 'name'),
])
```

The Aggregate Builder also supports `.or()` and `.and()` with identical behavior. The server enforces a maximum nesting depth of 5 levels.

#### `SimfinityClient.condition(field, operator, value [, path])`

Static convenience factory for creating a filter group with a single condition. Returns a `QLFilterGroup` object:

```js
SimfinityClient.condition('category', 'EQ', 'Drama')
// Equivalent to: { conditions: [{ field: 'category', operator: 'EQ', value: 'Drama' }] }

SimfinityClient.condition('author', 'LIKE', 'Adams', 'name')
// Equivalent to: { conditions: [{ field: 'author', operator: 'LIKE', value: 'Adams', path: 'name' }] }
```

#### `.joinObject(path, fields)`

Include a related object's fields in the selection.

#### `.joinCollection(path, fields [, filter])`

Include a related collection's fields. Supports dot-notation for nested joins (e.g. `'seasons.episodes'`). An optional `filter` array of terms can be passed.

#### `.fields(selectionString)`

Space-separated list of scalar fields to select on the root type. If omitted, all scalar and enum fields are selected automatically.

#### `.autoSelect()`

Automatically builds a full selection set using schema metadata, including nested object fields with display field resolution. Returns the builder for chaining. The selection metadata is available via `builder._selectionMeta`.

```js
const results = await client.find('serie')
  .autoSelect()
  .page(1, 10)
  .exec();
```

#### `.page(page, size [, count])`

Paginate results. `page` is 1-based. Set `count` to `true` to include total count in response extensions.

#### `.sort(field, order)`

Sort results. `order` is `'ASC'` or `'DESC'`. Can be called multiple times for multi-field sorting.

#### `.exec()`

Executes the query and returns the result array. If the server returns extensions (e.g. pagination count), they are attached as `result.__extensions`.

#### `.execWithMeta()`

Executes the query and returns a `{ data, extensions }` wrapper for clean access to response metadata:

```js
const { data: series, extensions } = await client.find('serie')
  .page(1, 10, true)
  .execWithMeta();

console.log(series);              // the result array
console.log(extensions?.count);   // total count from server
```

---

### Aggregate Builder — `client.aggregate(typeName)`

Returns a chainable `AggregateBuilder`. Call `.exec()` to execute.

```js
const results = await client.aggregate('season')
  .groupBy('serie')
  .fact('COUNT', 'seasonCount', 'id')
  .fact('AVG', 'avgYear', 'year')
  .page(1, 5)
  .sort('serie', 'ASC')
  .exec();
```

#### `.groupBy(field)`

**Required.** The field to group by.

#### `.fact(operation, factName, path)`

Add an aggregation fact. `operation` can be `COUNT`, `SUM`, `AVG`, `MIN`, `MAX`, etc.

#### `.where()`, `.page()`, `.sort()`

Same API as the Query Builder.

---

### Get by ID

```js
const serie = await client.getById('serie', '507f1f77bcf86cd799439011', 'id name categories');
```

If `fields` is omitted, all scalar fields are returned.

---

### Collection Item Queries — `client.findByParent()`

Query collection items filtered by their parent entity:

```js
const seasons = await client.findByParent('season', 'serie', parentSerieId)
  .page(1, 10, true)
  .fields('id number year state')
  .exec();
```

Returns a `QueryBuilder` pre-configured with a connection field filter and default sort by `id ASC`. Chain additional `.where()`, `.page()`, `.fields()`, `.sort()` as needed.

---

### FK/Relation Search — `client.search()`

Search-as-you-type for FK reference fields:

```js
const results = await client.search('Genre', 'com', {
  displayField: 'name',
  page: 1,
  size: 10,
});
// [{ id: '1', name: 'Comedy' }, { id: '2', name: 'Romantic Comedy' }]
```

Automatically selects the appropriate operator (`LIKE` for strings, `EQ` for numeric/boolean) and casts the search term to the field's scalar type.

| Option | Default | Description |
|---|---|---|
| `displayField` | auto-resolved (`name` or first scalar) | Field to search by |
| `page` | `1` | Page number |
| `size` | `10` | Page size |

---

### CRUD Mutations

```js
const created = await client.add('star', { name: 'John Doe' }, 'id name');

const updated = await client.update('star', createdId, { name: 'Jane Doe' }, 'id name');

const deleted = await client.delete('star', createdId, 'id name');
```

#### Automatic Input Transformation

Pass `{ transform: true }` as the last argument to have the client automatically clean mutation input based on schema metadata — stripping `__typename`, coercing scalar types, extracting FK IDs, handling embedded objects, and skipping read-only/state-machine fields:

```js
const created = await client.add('serie', rawFormData, 'id name', { transform: true });

const updated = await client.update('serie', id, rawFormData, 'id name', {
  transform: true,
  skipFields: ['temporaryField'],
});
```

---

### Mutation Input Transformation — `client.transformInput()`

Schema-aware mutation input cleaning, usable standalone:

```js
const cleaned = client.transformInput('serie', rawInput, {
  mode: 'create',           // or 'update'
  skipFields: [],            // fields to exclude
  transientFields: [],       // transient fields to exclude
});
```

Handles: `__typename` removal, numeric/date coercion, embedded object cleaning, FK reference extraction (`{ id }` only), and skipping read-only, state-machine, and collection fields.

---

### Collection Delta Mutations — `client.transformCollectionDelta()`

Build the `{ added, updated, deleted }` structure for collection field mutations:

```js
const delta = {
  added: [{ id: 'temp_1', number: '3', year: '2025', __status: 'added' }],
  updated: [{ id: 'real-id', number: '2', year: '2024', __status: 'modified' }],
  deleted: [{ id: 'del-id' }],
};

const cleaned = client.transformCollectionDelta('season', delta, {
  connectionField: 'serie',
});
// { added: [{ number: 3, year: 2025 }], updated: [{ id: 'real-id', number: 2, year: 2024 }], deleted: ['del-id'] }
```

Strips metadata (`__status`, `__originalData`, `__typename`), removes temporary IDs and connection fields, coerces scalar types, and extracts FK object IDs.

---

### State Machine Transitions

```js
const activated = await client.transition('season', 'activate', seasonId, 'id number state');
```

Optionally pass extra input fields:

```js
await client.transition('season', 'activate', seasonId, { extraField: 'value' }, 'id number state');
```

---

### Custom Mutations

```js
const result = await client.customMutation('myCustomMutation', { arg1: 'value' }, 'id status');
```

---

### Raw GraphQL Execution

```js
const response = await client.execute(
  '{ stars(pagination: { page: 1, size: 2 }) { id name } }'
);
console.log(response.data);
```

---

### Selection Set Building — `client.buildSelectionSet()`

Generate a complete GraphQL selection set string with metadata from the schema, useful for building dynamic UIs:

```js
const { selection, columns, sortFieldByColumn, fieldTypeByColumn } =
  client.buildSelectionSet('serie');
```

Returns:

| Property | Type | Description |
|---|---|---|
| `selection` | `string` | GraphQL selection set string (includes nested object sub-selections) |
| `columns` | `string[]` | Display column names (excludes `id`) |
| `sortFieldByColumn` | `object` | Maps column name to sort field path (e.g. `director` -> `director.name`) |
| `fieldTypeByColumn` | `object` | Maps column name to scalar type name |

---

### Schema Metadata Access

#### Field Extensions

```js
const ext = client.getFieldExtensions('serie', 'director');
// { relation: { displayField: 'name', embedded: true, connectionField: null }, stateMachine: null, readOnly: null }
```

| Method | Signature | Description |
|---|---|---|
| `getFieldExtensions` | `(typeName, fieldName)` | Full extensions object for a field |
| `getDisplayField` | `(typeName, fieldName)` | Display field with fallback chain (extension -> `name` -> first scalar) |
| `isEmbeddedField` | `(typeName, fieldName)` | Whether the field is an embedded object |
| `getConnectionField` | `(typeName, fieldName)` | Back-reference field name for collections |
| `isStateMachineField` | `(typeName, fieldName)` | Whether the field is state-machine managed |
| `isReadOnlyField` | `(typeName, fieldName)` | Whether the field is read-only |
| `getEnumValues` | `(typeName)` | Enum values for an enum type |
| `getFieldsOfType` | `(typeName)` | All fields with full metadata |
| `getDescriptionFieldType` | `(typeName, fieldName)` | Scalar type name of a display field |

#### Entity & Query Name Resolution

```js
client.getTypeNameForQuery('series');           // 'serie'
client.getPluralQueryName('serie');              // 'series'
client.getSingularQueryName('serie');            // 'serie'
client.getListEntityNames();                    // ['episodes', 'seasons', 'series', 'stars', ...]
client.getListEntityNamesOfType('serie');        // ['series']
client.getQueryNamesForType('serie');
// { pluralQueryName: 'series', singularQueryName: 'serie', aggregateQueryName: 'series_aggregate' }
```

#### Scalar Type Utilities

Simfinity uses validated scalar names like `SeasonNumber_Int` where the suffix after `_` indicates the base type:

```js
client.getActualScalarType('SeasonNumber_Int');  // 'Int'
client.isNumericScalar('SeasonNumber_Int');       // true
client.isBooleanScalar('Boolean');               // true
client.isDateTimeScalar('StartDate_DateTime');   // true
```

#### State Machine Metadata

```js
client.getStateMachineFields('season');          // ['state']
client.getAvailableTransitions('season');
// [{ action: 'activate', mutationName: 'activate_season' }, { action: 'finalize', mutationName: 'finalize_season' }]
```

---

## Examples

See [`examples/demo.js`](examples/demo.js) for a comprehensive walkthrough covering all features: schema discovery, filtering, joins, pagination, sorting, CRUD, state machine transitions, aggregates, raw queries, schema metadata, selection set building, entity resolution, input transformation, collection deltas, parent queries, FK search, and response extensions.

```bash
GRAPHQL_ENDPOINT=http://localhost:3000/graphql npm run demo
```

## License

[Apache-2.0](LICENSE)

## Source provenance

Imported from simtlix/simfinity-js-client commit `32d9c5bf7264cd3ecddcd3441bffea3b21566cb0` (1.1.0), under its Apache-2.0 license.

## Monorepo additions

See the [JavaScript client guide](https://simtlix.github.io/simfinity.js/guide/client) for the complete current API and both-engine setup. The client remains dependency-free and browser compatible.

- Constructor options add mutually exclusive `descriptor` and `descriptorEndpoint`, injected `fetch`, `introspection: 'extended' | 'standard'`, and asynchronous `prepareHeaders`. Descriptor mode never introspects; use it when the server disables introspection. `getDescriptor()` returns the loaded descriptor or null.
- `query(name, args?, fields?)` executes exact query roots, including scalar and abstract outputs. `findView(name, params?)` returns a normal list builder, while `getViews(typeName?)` lists descriptor-classified views. Canonical lists are not replaced by views.
- List and aggregate builders accept `.where(field, filterObject)` and `.filter(group)` for `valuePath`, `ANY`/`ALL`/`NONE` and `$parent`. Operators come from the schema, including text, emptiness, `CONTAINS_ALL` and `IIN`; the server still gates engine support. `collectionArgs(path, args)` applies variables to selected nested collections, separately from legacy parent filtering. Aliased paths use response names.
- Transformed updates/actions preserve required managed versions. `delete(type, id, fields?, { version })` supplies the protected delete precondition. `transformInput` adds `preserveEmpty`, `includeCollections` and concrete `inputType` opt-ins. Collection delta transformation keeps `{ id, version }` for protected deletions and IDs for unprotected deletions.
- `transaction(operations, fields?, { name }?)` sends one generated transaction mutation, preserving reference tokens and explicit versions. Descriptor mode discovers its root; introspection mode requires the exact configured name. Errors preserve all `graphQLErrors` extensions, including transaction positions. Writes are never retried by this client.

Version 3.19.0 starts the client's aligned monorepo release policy, preserving the package name and existing valid 1.1 JavaScript calls. Releases use this repository's Release Simfinity workflow with npm Trusted Publishing and verified archives in both registries.
