---
title: Plugins
description: Integrate authorization and pagination counts with GraphQL Yoga, Envelop, and Apollo Server.
---

# Plugins

The `simfinity.plugins` namespace contains `createAuthPlugin`, `envelopCountPlugin`, and `apolloCountPlugin`.

## Authorization plugin

```javascript
const plugin = simfinity.plugins.createAuthPlugin(permissions, {
  defaultPolicy: 'DENY',
  debug: false,
});
```

This is the same factory exposed as `simfinity.auth.createAuthPlugin`. It wraps schema resolvers through the Envelop `onSchemaChange` hook. See [authorization](/guide/authorization) for permission maps, rule helpers, and the generated `RootQueryType` name.

## Envelop count plugin

```javascript
import { createYoga } from 'graphql-yoga';
import * as simfinity from '@simtlix/simfinity-js';

const yoga = createYoga({
  schema: simfinity.createSchema(),
  context: () => ({}),
  plugins: [simfinity.plugins.envelopCountPlugin()],
});
```

The generated list resolver computes a total when the query requests `pagination.count`. The plugin copies that count from the request context into GraphQL response extensions.

```graphql
query SeriesPage {
  series(pagination: { page: 1, size: 10, count: true }) {
    id
    name
  }
}
```

```json
{
  "data": { "series": [{ "id": "...", "name": "The Expanse" }] },
  "extensions": { "count": 42 }
}
```

The count describes matching records before pagination, not the number returned on the current page.

## Apollo count plugin

```javascript
import { ApolloServer } from '@apollo/server';
import * as simfinity from '@simtlix/simfinity-js';

const server = new ApolloServer({
  schema: simfinity.createSchema(),
  plugins: [simfinity.plugins.apolloCountPlugin()],
});
```

Configure a fresh request context in your Apollo HTTP integration. The plugin writes `extensions.count` for single-result response bodies.

## Count behavior

- Request both `page` and `size`; they are required fields of `QLPagination`.
- A fresh mutable context is required because the generated resolver writes `context.count`.
- Both HTTP count plugins currently include a count only when it is truthy. A result count of zero is omitted from response extensions.
- A request context stores one count value. Do not use multiple counted list fields in one operation when you need a distinct total for each field.
- Aggregation queries do not compute a pagination count.

In-process [MCP calls](/reference/mcp#results-and-errors) capture list counts separately, preserve zero, and expose them as `_meta.count`.

## Integration boundaries

These plugins do not start an HTTP server or authenticate credentials. `envelopCountPlugin` and `apolloCountPlugin` only expose counts. The auth plugin requires a host that invokes its Envelop schema hook.

For standalone MCP, pass auth plugins in `schemaPlugins`. That option invokes `onSchemaChange` only; it is not a complete Envelop execution lifecycle and does not run the count plugin's `onExecute` hook.
