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
npm install @simtlix/simfinity-mcp@3.16.0
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

`limits` bound reads, not writes. Generated add and update tools accept nested collection inputs, and each nested `added`, `updated` or `deleted` entry runs inside the parent's transaction. On servers exposed to MCP clients, cap them with [`configureMutationLimits({ maxNestedOperations })`](/guide/mutations#limit-nested-collection-operations) at startup. Since 3.16.0, the [transaction tool](#transaction-tool) takes a list of operations, which `maxTransactionOperations` caps (100 by default) in the same call.

## Custom query tools

[Custom queries](./queries#custom-queries), registered with `registerCustomQuery()`, are published as read-only query tools (`readOnlyHint: true`), titled by their field name and described by their description. For example, the duration estimate from the query guide is called with:

```javascript
const { callTool } = mcp.generateMCPTools(schema, {
  include: ['estimateServiceDuration'],
});

const result = await callTool('estimateServiceDuration', {
  input: { serviceCodes: ['haircut', 'beard'] },
});
```

Selectors treat a custom query like any other query tool:

- `include` and `exclude` match its field name, its published name with `toolNamePrefix`, or the category `'query'`. `exclude: 'mutation'` keeps it, so a read-only server publishes it, and `exclude: 'query'` hides it.
- `includeTypes` and `excludeTypes` match its named output object type. A custom query whose output is not an object type, such as a scalar, is hidden whenever `includeTypes` is set.
- `toolOverrides` apply by published name or by field name.

Custom inputs do not acquire generated pagination or filtering behavior. Apply domain limits inside the callback and configure [authorization](#preserve-authorization) for its root and output fields. If a custom query and a custom mutation share a name, MCP publishes only the query's tool and skips the mutation with a warning; use distinct names to expose both. A custom query named like a [virtual field tool](/reference/mcp#virtual-field-tools), `<byIdQuery>_<field>`, takes that tool name, and the virtual field's tool is skipped with a warning.

## Named view tools

[Named views](./queries#named-views), registered with `registerView()`, are published as list tools with `readOnlyHint: true`. Each tool is titled by the view's field name. Its description starts with the view's description and appends the generated sentence: `Supports per-field filters (operators: ...; ...), nested AND/OR filter groups, pagination (page/size) and sorting.` This is the same filter sentence as the generated list tool's. A `toolOverrides` title or description takes precedence.

The input schema includes the typed params next to the generated filters, `AND`/`OR`, `sort` and `pagination`. Param descriptions and defaults are preserved. A `NonNull` param without a default is required, and unknown arguments are rejected. For the view in the queries guide:

```javascript
const { callTool } = mcp.generateMCPTools(schema, {
  include: ['upcomingBookings'],
});

const result = await callTool('upcomingBookings', {
  from: '2026-11-01',
  pagination: { page: 1, size: 20, count: true },
});
```

The result carries `totalCount` next to the list when `pagination.count` is true. The rows and output schema use the base type's selection, including its usual virtual-field selection rules. Callers send sorting and pagination; the tool also applies `limits.defaultPagination` when pagination is omitted.

Selectors use the view's name and base type:

- `include` and `exclude` match the field name, the published name with `toolNamePrefix`, or the category `'query'`. A prefix changes the published tool name, not its GraphQL field name.
- `includeTypes` and `excludeTypes` match the base type, such as `'booking'`.
- `toolOverrides` match the published name or field name. Exclude a view by name to hide its tool on one server.

The view's base-type scope and [root authorization](./queries#named-views) still apply to every call.

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

If a call is cancelled while its context factory is pending, GraphQL execution does not start. Cancellation cannot undo database work already started. Remote timeouts cover both the request and response-body reading; only queries may retry, and client cancellation, including during a retry backoff, rejects without retrying. Retry k waits `backoffMs × k`; set `retry.retryAfter: true` to honor a server's `Retry-After`, and `retry.jitter: true` to spread concurrent retries (see [remote execution](/reference/mcp#remote-execution)). Through the stateless HTTP handler, an MCP cancellation arrives as a separate request that cannot reach the call in flight, so only a closed HTTP connection cancels a call there.

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

Nested collections, such as a series' seasons, return up to 100 items for each returned row and are read with one query per row, or, with an adapter that [batches collection reads](./relationships#batched-collection-reads), one per nested collection field and batch of rows: with `batchedCollections: true`, one statement per 100 rows on PostgreSQL and one command per `collectionBatchSize` rows on MongoDB. `limits` do not bound that work. For list-heavy agents, leave them out with `nestedCollections: 'none'`, globally or per tool in `toolOverrides`, or set `selectionDepth: 0`:

```javascript
const lean = mcp.generateMCPTools(schema, {
  nestedCollections: 'none',
  toolOverrides: { serie: { nestedCollections: 'all' } },
});
```

[Virtual fields](./queries#virtual-fields) cost a resolver call each, so list tools select one only when it sets `extensions: { virtual: { mcp: 'select' } }`, while get-by-id and mutation tools select every virtual field without required arguments, except inside the items of a nested collection or embedded list, where the same `mcp: 'select'` rule applies. A virtual field with a required argument, which no generated selection can include, gets its own read tool instead, named `<byIdQuery>_<field>`, such as `barbershop_busyRanges`: it takes the record's `id` and the field's arguments and returns the field under its record. Set `mcp: false` on the field to leave that tool out; see [virtual field tools](/reference/mcp#virtual-field-tools).

An explicit selection omits that tool's generated `outputSchema`, because the generator can no longer promise a matching output contract. Tool annotations describe behavior to clients; they do not grant or restrict access. Generated unprotected updates are marked idempotent unless their input can add collection items, and deletes are marked destructive and idempotent; protected updates keep the idempotent hint even with added items; see [annotations](/reference/mcp#annotations).

See the [MCP reference](/reference/mcp) for all options, remote execution, middleware, and error behavior.

## Transaction tool

::: info Available since 3.16.0
The transaction tool requires the schema's `transaction` field and an MCP package of the same release, 3.16.0 or later.
:::

A schema that opts into the [transaction mutation](./mutations#run-several-mutations-in-one-transaction) can publish it as one tool, so an agent can apply several generated writes together or not at all. It is off by default:

```javascript
const { tools, callTool } = mcp.generateMCPTools(schema, {
  transactionTools: true,
  include: ['serie', 'series', 'transaction'],
});
```

Without `transactionTools: true` (unset, `null` or `false`) MCP never publishes the field, and neither does it publish any other mutation shaped like it: one with the field's `extensions`, whose description starts with `Simfinity transaction: runs the listed generated mutations in order in one database transaction.`, or that has a single `operations: [X!]!` argument whose fields each match a mutation root of the schema by name and input type, a generated root or any root of that name, also when some or all of those roots are missing and the field returns a list of an object type with a field named after each operation. Without this rule, an unrecognized mutation would be published as a custom tool. Any other value throws `MCP_INVALID_OPTIONS` at setup.

With the opt-in, the tool is named like the field, with `toolNamePrefix`, and the filters apply as follows:

- `include` and `exclude` accept it by its own name or by the category `'mutation'`. `include` does not need to list its operation keys.
- It is omitted when `exclude` names any of its operation keys, bare or with the prefix: the tool can run every operation, so excluding `deleteserie` also removes the transaction tool, which could otherwise delete through it.
- `includeTypes` and `excludeTypes` apply to the types its operations write: each operation's own type and, transitively, the targets of the nested collections its inputs declare. Reference targets and output relations do not count. The tool is published when none of those types is in `excludeTypes` and, if `includeTypes` is set, all of them are in it. `TransactionResult` is not an entity for these filters.

The input schema is closed like every tool's: each item of `operations` is an object with exactly one known operation property, whose value is not null (`minProperties` and `maxProperties` are 1, and `additionalProperties` is `false`); nullability inside the values is kept. A call is held to the schema before anything executes, locally and in remote mode, on the arguments as the tool middleware leaves them: an `operations` that is not a list, or an item that is not an object with exactly one advertised operation key whose value is not `undefined`, is rejected with the `MCP_UNKNOWN_ARGUMENT` error that any undeclared argument gets, and no operation runs. The annotations are always `destructiveHint: true` and `idempotentHint: false`: updates, state actions and controllers can overwrite data, and adds create records on every call. The description follows the field's, and adds how to write an operation, the `$K` references and the `$$` escape.

Each operation field of the result is selected with the `selectionDepth` and `nestedCollections` of that operation's own tool; as below any list position, only virtual fields with `mcp: 'select'` are selected. The result list takes no level of `selectionDepth`. Each result item keeps only `id` and its own operation's key, so the result does not grow with the number of generated mutations the field accepts. A `toolOverrides` entry for the transaction tool changes its title, description and annotations, and an explicit `selection` on it replaces the selection of the result list and drops its `outputSchema`, as for any tool; its items are then returned as selected. Its `selectionDepth` and `nestedCollections` are ignored, and the overrides of an operation's own tool apply to that operation, except that an explicit `selection` there is not reused inside the batch: fields that selection hides still appear in the transaction result, so hide fields with [field authorization](./authorization) instead. When the result exceeds `maxResultBytes`, the compact value keeps one `{ id, <operationKey>: { id, version? } | null }` per operation, with `null` for a delete of a missing record, and the notice says that the operations were applied all together or not at all, never in part. If errors leave no root value, the outcome remains unknown: errors can occur after a successful commit, including during session cleanup, result serialization or a remote request. Check the current state before retrying; repeating the call can repeat committed changes.

The tool executes the `transaction` mutation, so the [authorization rules](./authorization#authorize-the-transaction-mutation) of the field and of each operation apply in-process, through `schemaPlugins`, and remotely, on the server. A [`toolMiddleware`](/reference/mcp#tool-middleware) that gates tools by name sees only the transaction tool; the operations it runs are in `call.args.operations`.

### Rebuilt and remote schemas

MCP never rebuilds a schema. It recognizes the transaction field from the schema it receives, and publishes it only when the field has the marker description, the structure above, and an operation input type that is `@oneOf`. A schema that your application rebuilds from introspection must therefore request `getIntrospectionQuery({ oneOf: true })` with descriptions on, because the default introspection query leaves out `isOneOf` and the marker is a description:

```javascript
import { buildClientSchema, getIntrospectionQuery } from 'graphql';

const query = getIntrospectionQuery({ descriptions: true, oneOf: true });
const schema = buildClientSchema((await introspect(query)).data);
```

`introspect` is your application's request to the GraphQL endpoint. A schema built from SDL printed with `printSchema()` keeps `@oneOf` and descriptions. When `transactionTools` is on and a mutation has the field's shape but MCP cannot classify it, the mutation is omitted with a one-time `[simfinity-mcp]` warning. Remote execution needs the server's schema to expose the same field, and the local schema that MCP classifies must expose the same transaction operations as the remote server: the tool advertises the operation keys of the local schema, and a key it does not advertise, such as an operation that only the remote schema has, is rejected before the request is sent, so the local filters and `exclude` cannot be bypassed through the remote server.

A rebuild that removes generated mutations must also remove the transaction field or add it to `exclude`. MCP recognizes the field by its shape where it can, but `exclude` by operation key only applies to a recognized transaction tool. The tool rejects an operation key it does not advertise, but a client that calls the server's GraphQL endpoint directly can still send any operation the server's transaction field accepts, so the local MCP schema and the server must expose the same transaction operations.

A server that enables `transaction` exposes the field as a custom mutation tool to an earlier MCP package, including MCP processes in remote mode that no package pin aligns. Upgrade those processes first, or add the field to their `exclude`. See the [upgrade notes](/resources/compatibility#lifecycle-helpers-and-the-generated-transaction).

## Protected records

For [optimistic concurrency](./concurrency), generated selections include `version`, and `RecordVersion` becomes an integer from 1 to `9007199254740991` in tool input/output schemas. Send the observed version on updates, state actions and deletes; nested protected children also need their own versions. Protected update/delete hints remain idempotent for stored data, including updates with `added` items, because the same version cannot apply another revision. Hooks may still run again. Re-read and reapply on `VERSION_CONFLICT` or `TRANSACTION_RETRY_EXCEEDED`; an earlier call may already have applied the change. Transition hints are unchanged.

If an oversized protected mutation result is compacted, MCP keeps `{ id, version }` when it fits within the configured cap. Keep `version` in any `toolOverrides.selection` so subsequent edits use the new revision. The compact-result and retry messages explain what was applied; avoid a blind repeat.
