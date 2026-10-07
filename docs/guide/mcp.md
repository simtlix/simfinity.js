---
title: MCP integration
description: Expose your generated GraphQL API as MCP tools using the same schema and application rules.
---

# MCP integration

Simfinity can turn a GraphQL schema into Model Context Protocol tools. Each exposed root query or mutation becomes a tool with generated input schema, descriptions, and a GraphQL operation behind it.

Start with a working schema from the [MongoDB](/guide/getting-started) or [PostgreSQL](/guide/postgresql) quick start. MCP adds another way to invoke its operations; the same database and mutation transaction requirements apply.

The MongoDB facade retains MCP compatibility exports. For either database, the dependency-light integration is the opt-in `@simtlix/simfinity-mcp` package. Install `@modelcontextprotocol/sdk` only when using server or transport factories; `generateMCPTools` itself needs only GraphQL. PostgreSQL applications import MCP functions from this separate package, as shown in the [PostgreSQL quick start](/guide/postgresql#optional-mcp-integration).

## Choose the MCP package

The following examples import `@simtlix/simfinity-mcp`, which works with either adapter. In either application, install it from npm:

```sh
npm install @simtlix/simfinity-mcp@3.5.6
```

Keep it at the same version as your other Simfinity packages. The archived MongoDB starter already includes its matching version for compatibility. The published MongoDB 3.0.1 release instead exports these functions from `@simtlix/simfinity-js`.

## Continue from the quick start

The [starter project](/guide/getting-started#download-the-starter) already separates `schema.js`, `server.js`, and `mcp.js`. Importing `schema.js` connects to MongoDB, registers the types and exports the built schema. Each entry point reuses that initialization. For PostgreSQL, export the schema only after awaiting `initializeDatabase()`; close its pool when shutting down the MCP process.

Run `node mcp.js` for the included read-tool example. If your existing project defines everything in `server.js`, move the type definitions, database connection and schema creation into `schema.js`, export `schema`, and import it from both entry points. Keep `server.listen()` in `server.js`.

## Generate and inspect tools

Tool generation and direct execution do not require the optional MCP SDK.

```javascript
import * as mcp from '@simtlix/simfinity-mcp';
import { schema } from './schema.js';

const { tools, callTool, getOperation } = mcp.generateMCPTools(schema, {
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

Generated inputs distinguish omission from explicit null: defaulted arguments use their GraphQL defaults when omitted, nullable fields and list items accept null, and non-null positions reject it. Input schemas are closed, and an argument the tool does not declare, such as a misspelled filter or a guessed `limit`, returns an `MCP_UNKNOWN_ARGUMENT` error that names the valid arguments; the tool does not run. With `count: true`, the result carries the total as `totalCount` next to the list.

`maxResultBytes` also covers errors and partial data. Oversized query results are replaced by an actionable limit error. An oversized mutation result is not an error when the mutation succeeded, because the write already ran: the tool returns a `truncated` notice telling the agent whether calling it again would repeat the change, with the record's id when the id fits within the cap. Limit diagnostics and that notice are exempt from the cap. `limits` is validated when the tools are created; see [limits](/reference/mcp#limits).

## Start a stdio server

Install the SDK for protocol transports:

```sh
npm install @modelcontextprotocol/sdk@^1.31.0
```

Create a standalone entry point that initializes your database and schema, then starts the transport:

```javascript
import * as mcp from '@simtlix/simfinity-mcp';
import { schema } from './schema.js';

await mcp.startStdioMCPServer(schema, {
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
import { createAuthPlugin, requireAuth, allow } from '@simtlix/simfinity-core/auth';
import * as mcp from '@simtlix/simfinity-mcp';
import { schema } from './schema.js';
import { authenticateRequest } from './authenticate.js';

const app = express();
app.use(express.json());

const permissions = {
  RootQueryType: { serie: requireAuth(), series: requireAuth() },
  Serie: { '*': allow() },
};

const handler = await mcp.createHTTPMCPHandler(schema, {
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

Install Express separately if your application does not already use it. `authenticateRequest` is application-owned credential verification. Adjust host and origin values for your deployment. Mount the handler with `app.all`: it creates a fresh stateless MCP server and transport for each POST request and answers other methods, such as the GET an MCP client sends to open a server stream, with 405 and `Allow: POST`, which clients treat as "no server stream". Stateful options (`sessionIdGenerator`, session callbacks and `eventStore`) are rejected at setup; use `createMCPServer` with your own transport management if you need sessions.

## Preserve authorization

The context reaches generated resolvers and [root query scopes](/guide/query-scope). Field authorization needs the auth plugin's `onSchemaChange` hook to have run.

For standalone in-process MCP, pass the plugin through `schemaPlugins`, as shown above. Creating a plugin object alone does not install it. If Yoga has already applied the same plugin to the same schema object, MCP executes those wrapped resolvers as well.

`schemaPlugins` invokes schema hooks only. It does not run every Envelop request hook; a plugin with request hooks gets a one-time console warning naming them. Each entry must be a plugin object, so pass `createAuthPlugin(permissions)`, not the factory; invalid entries, including a misspelled hook such as `onSchemaChanged` on a plugin without `onSchemaChange`, throw `MCP_INVALID_SCHEMA_PLUGIN` before any hook runs, and `false`, `null` and `undefined` entries are skipped. An asynchronous `onSchemaChange` is awaited before the server or HTTP handler is ready, and `generateMCPTools` calls wait for it. A schema containing types from another copy of the graphql module makes the auth plugin throw `TypeError` at this point. In remote mode, the remote GraphQL server enforces authorization using the credentials supplied in `execution.headers`.

If a call is cancelled while its context factory is pending, GraphQL execution does not start. Cancellation cannot undo database work already started. Remote timeouts cover both the request and response-body reading; only queries may retry, and client cancellation, including during a retry backoff, rejects without retrying. Through the stateless HTTP handler, an MCP cancellation arrives as a separate request that cannot reach the call in flight, so only a closed HTTP connection cancels a call there.

## Choose the result shape

Generated tools have a fixed GraphQL selection for each tool. Set `selectionDepth` for nested output, or define a per-tool selection:

```javascript
const generated = mcp.generateMCPTools(schema, {
  toolOverrides: {
    series: {
      title: 'Search the series catalog',
      description: 'Find series by name, year, or category.',
      selection: 'id name year category',
    },
  },
});
```

An explicit selection omits that tool's generated `outputSchema`, because the generator can no longer promise a matching output contract. Tool annotations describe behavior to clients; they do not grant or restrict access. Generated updates are marked idempotent unless their input can add collection items, and deletes are marked destructive and idempotent; see [annotations](/reference/mcp#annotations).

See the [MCP reference](/reference/mcp) for all options, remote execution, middleware, and error behavior.
