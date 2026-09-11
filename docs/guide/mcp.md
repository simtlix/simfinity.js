---
title: MCP integration
description: Expose your generated GraphQL API as MCP tools using the same schema and application rules.
---

# MCP integration

Simfinity can turn a GraphQL schema into Model Context Protocol tools. Each exposed root query or mutation becomes a tool with generated input schema, descriptions, and a GraphQL operation behind it.

Start with a working schema from [getting started](/guide/getting-started). MCP adds another way to invoke its operations; the same database and mutation transaction requirements apply.

## Continue from the Quick start

The [starter project](/guide/getting-started#download-the-starter) already separates `schema.js`, `server.js`, and `mcp.js`. Importing `schema.js` connects to MongoDB, registers the types and exports the built schema. Each entry point reuses that initialization.

Run `node mcp.js` for the included read-tool example. If your existing project defines everything in `server.js`, move the type definitions, database connection and schema creation into `schema.js`, export `schema`, and import it from both entry points. Keep `server.listen()` in `server.js`.

## Generate and inspect tools

Tool generation and direct execution do not require the optional MCP SDK.

```javascript
import * as simfinity from '@simtlix/simfinity-js';
import { schema } from './schema.js';

const { tools, callTool, getOperation } = simfinity.generateMCPTools(schema, {
  exclude: 'mutation',
  toolNamePrefix: 'catalog_',
  limits: {
    maxPageSize: 100,
    defaultPagination: { page: 1, size: 20 },
    maxResultBytes: 262144,
  },
});

console.log(tools.map((tool) => tool.name));
console.log(getOperation('catalog_series'));

const result = await callTool('catalog_series', {
  category: { operator: 'EQ', value: 'Science fiction' },
  pagination: { page: 1, size: 10, count: true },
});
```

Here `schema.js` exports your already registered and built schema. The generated operation uses the original GraphQL field `series`, while callers use the published name `catalog_series`.

`exclude: 'mutation'` publishes only query tools. Use `include` to expose a specific allowlist, and inspect `tools` before connecting clients.

## Start a stdio server

Install the SDK for protocol transports:

```sh
npm install @modelcontextprotocol/sdk
```

Create a standalone entry point that initializes your database and schema, then starts the transport:

```javascript
import * as simfinity from '@simtlix/simfinity-js';
import { schema } from './schema.js';

await simfinity.startStdioMCPServer(schema, {
  serverName: 'series-catalog',
  serverVersion: '1.0.0',
  include: ['serie', 'series'],
  limits: {
    maxPageSize: 100,
    defaultPagination: { page: 1, size: 20 },
  },
});
```

Configure your MCP client to launch this Node entry point. Reserve stdout for the protocol; send application diagnostics to stderr, for example with `console.error`.

## Serve Streamable HTTP

`createHTTPMCPHandler()` returns an Express-style request handler. This example assumes authentication middleware has verified the caller and populated `req.user`.

```javascript
import express from 'express';
import * as simfinity from '@simtlix/simfinity-js';
import { schema } from './schema.js';
import { authenticateRequest } from './authenticate.js';

const app = express();
app.use(express.json());

const { createAuthPlugin, requireAuth, allow } = simfinity.auth;
const permissions = {
  RootQueryType: { serie: requireAuth(), series: requireAuth() },
  Serie: { '*': allow() },
};

const handler = await simfinity.createHTTPMCPHandler(schema, {
  include: ['serie', 'series'],
  context: (req) => ({ user: req.user }),
  schemaPlugins: [createAuthPlugin(permissions, { defaultPolicy: 'DENY' })],
  limits: {
    maxPageSize: 100,
    defaultPagination: { page: 1, size: 20 },
  },
  transportOptions: {
    enableDnsRebindingProtection: true,
    allowedHosts: ['127.0.0.1:3000', 'localhost:3000'],
    allowedOrigins: ['http://localhost:3000'],
  },
  onError: (error) => console.error('MCP request failed', error),
});

app.all('/mcp', authenticateRequest, handler);
app.listen(3000, '127.0.0.1');
```

Install Express separately if your application does not already use it. `authenticateRequest` is application-owned credential verification. Adjust host and origin values for your deployment. By default the handler creates a fresh stateless MCP server and transport for each HTTP request.

## Preserve authorization

The context reaches generated resolvers and [root query scopes](/guide/query-scope). Field authorization needs the auth plugin's `onSchemaChange` hook to have run.

For standalone in-process MCP, pass the plugin through `schemaPlugins`, as shown above. Creating a plugin object alone does not install it. If Yoga has already applied the same plugin to the same schema object, MCP executes those wrapped resolvers as well.

`schemaPlugins` invokes schema hooks only. It does not run every Envelop request hook. In remote mode, the remote GraphQL server enforces authorization using the credentials supplied in `execution.headers`.

## Choose the result shape

Generated tools have a fixed GraphQL selection for each tool. Set `selectionDepth` for nested output, or define a per-tool selection:

```javascript
const generated = simfinity.generateMCPTools(schema, {
  toolOverrides: {
    series: {
      title: 'Search the series catalog',
      description: 'Find series by name, year, or category.',
      selection: 'id name year category',
    },
  },
});
```

An explicit selection omits that tool's generated `outputSchema`, because the generator can no longer promise a matching output contract. Tool annotations describe behavior to clients; they do not grant or restrict access.

See the [MCP reference](/reference/mcp) for all options, remote execution, middleware, and error behavior.
