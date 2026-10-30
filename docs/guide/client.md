---
title: JavaScript client
description: Browser and Node HTTP client with schema metadata, queries and managed writes.
---

# JavaScript client

::: tip Available since 3.19.0
`@simtlix/simfinity-js-client` is maintained at `packages/client` and follows the aligned Simfinity release version. Version 3.19.0 adds the APIs on this page while preserving existing valid 1.1 JavaScript calls.
:::

```sh
npm install @simtlix/simfinity-js-client@3.19.0
```

The client runs in browsers and Node.js >=18.18.0 and uses HTTP without any dependency on a database driver or Simfinity server package. It retains the default `SimfinityClient` export and the existing 1.1 call signatures. TypeScript declarations ship in the package.

## Initialize with a descriptor

Configure the optional server package [`@simtlix/simfinity-descriptor`](../reference/client-descriptor) against the exact schema you serve and explicitly authorize its HTTP endpoint. This works with MongoDB and PostgreSQL. The browser needs only the endpoint or its JSON document:

```javascript
import SimfinityClient from '@simtlix/simfinity-js-client';

const client = new SimfinityClient('/graphql', {
  descriptorEndpoint: '/client-metadata',
  async prepareHeaders(headers) {
    headers.Authorization = `Bearer ${await tokenStore.getAccessToken()}`;
  },
});
await client.init();
```

Supply `descriptor: document` instead of `descriptorEndpoint` for a descriptor already loaded by your application. These options are mutually exclusive. Descriptor mode makes no introspection request and works when GraphQL introspection is disabled. An explicit metadata URL receives the same header callback; choose its origin deliberately. There is no automatic URL discovery or silent fallback after a denial. `options.fetch` supplies an HTTP implementation when needed.

With neither descriptor option, `init()` keeps the existing extended introspection mode. Set `introspection: 'standard'` when the server disables `__Field.extensions`; relation/state metadata unavailable through standard introspection stays unknown. Descriptors supply authoritative operation categories, canonical endpoints and relation/input hints. Unsupported descriptor format versions fail initialization; failed reinitialization leaves the preceding metadata intact. Metadata describes schema shape, not caller permissions or adapter capabilities.

## Queries and views

Existing builders continue to work:

```javascript
const { data, extensions } = await client.find('booking')
  .where('state', 'EQ', 'CONFIRMED')
  .fields('id scheduledDate startTime version')
  .sort('scheduledDate', 'ASC')
  .page(1, 10, true)
  .execWithMeta();
```

Use schema type and operation names as declared by your application; examples on this page require those fields and features in your schema. Descriptors keep canonical lists separate from views and custom queries returning the same type.

`findView(name, params?)` binds a normal builder to a named list root. `getViews(typeName?)` lists descriptor-classified views; standard introspection cannot prove which roots are views. `query(name, args?, fields?)` calls an exact root, including custom scalar/enum/list results. Object results default to scalar fields; supply selections such as `__typename ... on Person { name }` for abstract results. Query and mutation names occupy separate registries.

```javascript
await client.findView('barbershopDay', { barbershopId, date })
  .fields('id startTime state').exec();
await client.query('estimateServiceDuration', {
  input: { serviceCodes: ['haircut', 'beard'] },
}, 'minutes');
```

The list and aggregate builders add `.where(field, filterObject)` and `.filter(group)`. The latter appends the supplied group as one `AND` member; separate groups retain their separate child witnesses. Existing `.where(field, operator, value?, value2?)`, term arrays, `.and()` and `.or()` remain available. Operators are discovered from the schema; a server can still reject an operator its adapter does not support.

```javascript
await client.find('Order')
  .where('stock', { operator: 'LTE', valuePath: 'reorderLevel' })
  .where('tags', 'CONTAINS_ALL', ['priority', 'delivery'])
  .filter({ ALL: [{
    path: 'lines',
    conditions: [{ field: 'quantity', operator: 'LTE', valuePath: '$parent.limit' }],
  }] })
  .fields('id').exec();
```

Text operators, `IIN`, `IS_EMPTY`/`IS_NOT_EMPTY`, `valuePath`, quantifiers and `$parent` have the [server's query semantics](./queries). The client forwards paths and values without interpreting them.

`collectionArgs(path, args)` applies arguments to a selected nested collection. Values use GraphQL variables, including nested filters, sorting and pagination:

```javascript
await client.find('Order').fields('id')
  .joinCollection('lines', 'id quantity version')
  .collectionArgs('lines', { pagination: { page: 1, size: 5 } })
  .exec();
```

Paths follow selection response names, including aliases. This differs from the existing `joinCollection(path, fields, filter)` third argument, which filters the parent query. Unknown explicitly supplied arguments fail instead of being silently lost. Auto-selection avoids fields requiring arguments; select those virtual fields explicitly with their arguments.

## Managed writes and forms

Read and return [managed versions](./concurrency) explicitly. `transform: true` preserves a version required by the actual update input, even though output metadata marks it read-only:

```javascript
const changed = await client.update('booking', booking.id, {
  scheduledDate: newDate,
  version: booking.version,
}, 'id scheduledDate version', { transform: true });

await client.transition('booking', 'confirm', booking.id,
  { version: changed.version }, 'id state version');
await client.delete('booking', booking.id, 'id version', {
  version: currentVersion,
});
```

Versions are safe integer JSON numbers from 1 to 9007199254740991. The client never manufactures, refreshes or retries them. Handle `error.graphQLErrors`, including `extensions.code === 'VERSION_CONFLICT'`, by rereading and reconciling in the application. HTTP failures with a valid GraphQL error envelope retain all error extensions. Raw `execute()` returns the GraphQL envelope; mutation helpers throw GraphQL errors, preserving `graphQLErrors`. Legacy list/get partial-data behavior and `.exec()`'s `__extensions` remain available.

Form transformations use the concrete operation's generated input graph, including embedded values and nested inputs that omit a back-reference required by a root create. Existing cleaning defaults omit null/empty strings and collection fields. Add `preserveEmpty: true` for explicit clears and `includeCollections: true` for nested collection transformations. With `transform` off, inputs pass through to the server. Scalar lists are cleaned element by element; IDs remain opaque strings.

`transformInput(typeName, input, options?)` also works standalone. Options include `mode: 'create' | 'update'`, `skipFields`, `transientFields`, `preserveEmpty`, `includeCollections` and an explicit `inputType` when a concrete input context is needed. `transformCollectionDelta(childType, delta, options?)` preserves `{ id, version }` deletes for protected children and ID deletes for unprotected children, with `connectionField` cleanup retained. Its optional `inputType` names the actual collection-delta input rather than the child's root input. Never infer nested writability from `rootInputUsage` alone. Transformations do not mutate the caller's form input.

## Transactions

Enable the server's [transaction mutation](./mutations#run-several-mutations-in-one-transaction), then send its actual operation keys and inputs:

```javascript
const results = await client.transaction([
  { addorder: { name: 'First order' } },
  { updateorder: { id: '$0', version: 1, name: 'Updated order' } },
], 'id addorder { id version } updateorder { id version }');
```

The descriptor supplies the exact transaction name. In introspection mode pass the configured name as the third argument: `{ name: 'saveOrders' }`. `$K` and `$$K` strings pass unchanged to the server; versions remain explicit. Results stay in operation order. Failures preserve `extensions.operationIndex` and `extensions.operation`. The server owns authorization, reference resolution, atomicity and retries; the HTTP client does not retry writes or uncertain transport failures.

## Package policy and migration

The client keeps its public npm name and default import while moving from the separate 1.x repository to the monorepo's aligned release version. This version-policy jump does not require changing existing valid JavaScript calls. New features require the corresponding server schema; introspection alone does not advertise storage-engine support. The package has no runtime dependencies and does not require the descriptor builder in the browser.

Maintainers publish through this repository's tag-triggered Release Simfinity workflow and verify both registries, following the [contributor release contract](../resources/contributing). Barber can upgrade its independent frontend dependency to 3.19.0 and replace its local ambient declaration with the shipped types after running the application's integration checks; publication does not change the example automatically.
