---
title: MCP API
description: Tool generation, transport factories, execution options, limits, and MCP results.
---

# MCP API

The MCP functions are named exports and also available on `simfinity.mcp`. For a complete integration walkthrough, start with the [MCP guide](/guide/mcp).

## Functions

| Function | Returns | Purpose |
| --- | --- | --- |
| `generateMCPTools(schema, options = {})` | `{ tools, callTool, getOperation }` | Generate definitions and an executor without starting a transport. |
| `graphqlArgsToJSONSchema(field)` | JSON Schema object | Convert a GraphQL field's arguments to an input schema. |
| `createMCPServer(schema, options = {})` | Promise of an MCP SDK server | Create a server for a transport you connect yourself. |
| `startStdioMCPServer(schema, options = {})` | Promise of a connected server | Create and connect the stdio transport. |
| `createHTTPMCPHandler(schema, options = {})` | Promise of `(req, res) => Promise<void>` | Create an Express-style Streamable HTTP handler. |

Only the transport/server factories require `@modelcontextprotocol/sdk`. Definitions are generated from root query and mutation fields; subscriptions are not exposed as tools.

### Generated result

```javascript
const { tools, callTool, getOperation } = simfinity.generateMCPTools(schema);

const source = getOperation('series');
const result = await callTool('series', {
  pagination: { page: 1, size: 10 },
});
```

`tools` contains `name`, `title`, `description`, `inputSchema`, `annotations`, `kind`, and normally `outputSchema`. `kind` is `query` or `mutation` and is internal metadata omitted from SDK tool listings.

`callTool(name, args = {}, extra)` accepts the published tool name. `extra` carries per-call metadata, including an optional `AbortSignal`. `getOperation(name)` returns the prebuilt GraphQL document.

## Generation options

| Option | Default | Behavior |
| --- | --- | --- |
| `include`, `exclude` | Unset | A name or array of raw GraphQL names, published tool names, or the categories `'query'` and `'mutation'`. Exclusion wins. |
| `includeTypes`, `excludeTypes` | Unset | Filter by object return type name. Aggregate tools resolve their entity through their sibling list query. |
| `toolNamePrefix` | `''` | Prefix published names; GraphQL field names remain unchanged. |
| `selectionDepth` | `1` | Depth of automatically selected object relationships. |
| `includeId` | `true` | Include ID as a fallback when an object has no other selected fields. |
| `toolOverrides` | `{}` | Per-tool title, description, annotations, selection depth, ID fallback, or explicit selection. |
| `limits` | Unset | Pagination and serialized result-size controls. |
| `toolMiddleware` | Unset | Middleware surrounding actual tool execution. |
| `context` | `{}` | In-process GraphQL context value or factory. |
| `schemaPlugins` | Unset | Plugins whose `onSchemaChange` hook is invoked in in-process mode. |
| `execution` | `{ mode: 'in-process' }` | Local schema execution or remote GraphQL HTTP execution. |

Tool names must contain only letters, digits, underscores, and hyphens, with a maximum length of 128. A prefix must use the same character set. If query and mutation fields generate the same name, the first tool wins and the duplicate is skipped with a warning.

An `includeTypes` allowlist also excludes tools without an object entity type. Excluding an entity type hides its recognized aggregate tool as well.

## Tool overrides

```javascript
const generated = simfinity.generateMCPTools(schema, {
  toolNamePrefix: 'catalog_',
  toolOverrides: {
    catalog_series: {
      title: 'Search series',
      description: 'Browse the catalog by name, year, or category.',
      selection: 'id name year category',
    },
  },
});
```

Keys may use the published tool name or the original field name; a published-name override takes precedence. Supported properties are `title`, `description`, `annotations`, `selectionDepth`, `includeId`, and `selection`. Annotation properties are merged over generated annotations.

`selection` accepts `id name` or `{ id name }`. It replaces the automatic selection and omits `outputSchema`. Ensure the selection is valid for the schema; invalid selections become GraphQL execution errors.

## Limits

```javascript
const limits = {
  maxPageSize: 100,
  defaultPagination: { page: 1, size: 20 },
  maxResultBytes: 262144,
};
```

| Property | Behavior |
| --- | --- |
| `maxPageSize` | Rejects `pagination.size` above the cap with `MCP_PAGE_SIZE_EXCEEDED`. |
| `defaultPagination` | Injected when a tool has a pagination argument and the caller supplies none. Provide both `page` and `size`. |
| `maxResultBytes` | Rejects successful data whose serialized UTF-8 JSON exceeds the cap with `MCP_RESULT_TOO_LARGE`. |

A default page size above `maxPageSize` raises `MCP_INVALID_LIMITS` when the executor is created. Configure positive bounds appropriate for your application. A page-size cap by itself does not add pagination to unpaginated calls; pair it with `defaultPagination` when you need bounded defaults. Result-size checking happens after execution, so it does not limit database work.

## Tool middleware

MCP middleware receives `call = { name, args, extra, kind, operation }`. It may mutate or replace `call.args`, return a tool result directly, or surround the executor using `next()`.

```javascript
const generated = simfinity.generateMCPTools(schema, {
  toolMiddleware: [
    async (call, next) => {
      const started = Date.now();
      try {
        return await next();
      } finally {
        console.error(`${call.name}: ${Date.now() - started}ms`);
      }
    },
  ],
});
```

Return the result from `next()`. Calling it twice, or returning no result from the completed chain, throws `MCP_MIDDLEWARE_ERROR`. This contract differs from Simfinity's [global middleware](/guide/middleware), which runs before the database resolver.

## Execution and context

In-process execution calls GraphQL directly against the supplied schema. `context` may be an object or an async factory `(extra) => context`. For the HTTP handler, a factory is invoked as `(req, extra) => context`, which allows application authentication to populate context per call.

Pass [authorization plugins](/guide/authorization) in `schemaPlugins` for standalone in-process execution. Only `onSchemaChange` is invoked; resolver wrapping is supported, schema replacement and a full Envelop request lifecycle are not.

### Remote execution

```javascript
const generated = simfinity.generateMCPTools(schema, {
  execution: {
    mode: 'remote',
    endpoint: 'https://api.example.com/graphql',
    headers: { Authorization: `Bearer ${process.env.GRAPHQL_TOKEN}` },
    timeoutMs: 10000,
    retry: { attempts: 2, backoffMs: 250 },
  },
});
```

The local schema still determines tool definitions and generated operations. Keep it compatible with the remote server.

`endpoint` is required in remote mode. Requests use HTTP POST with the generated query and variables. `headers` is a configured object, not a per-request factory; incoming MCP credentials are not forwarded automatically. Local context and schema plugins are not applied to remote execution.

`timeoutMs` limits a remote fetch attempt. `retry.attempts` counts additional attempts, with linear backoff of `backoffMs × retry number`; the default backoff is 250 ms. Only queries retry after network failures, timeouts, HTTP 429, or HTTP 5xx. Mutations are never retried by this transport.

## Server and HTTP options

| Option | Default | Applies to |
| --- | --- | --- |
| `serverName` | `'simfinity-mcp'` | All SDK server factories. |
| `serverVersion` | `'1.0.0'` | All SDK server factories. |
| `transportOptions` | Unset | HTTP handler; spread into `StreamableHTTPServerTransport`. |
| `onError(error, req, res)` | Unset | HTTP handler error reporting callback. |

The HTTP factory builds tool definitions once, then creates a fresh server and transport per request. Its default transport is stateless. The handler passes `req.body` to the SDK, so mount appropriate JSON parsing middleware.

When an HTTP request fails, `onError` can log the failure. The handler sends an HTTP 500 JSON-RPC internal error if headers have not been sent. A throwing `onError` callback does not replace that fallback handling.

## Results and errors

A successful call returns text JSON and structured data using the original GraphQL response shape:

```javascript
{
  content: [{ type: 'text', text: '{ "series": [] }' }],
  structuredContent: { series: [] },
  isError: false,
}
```

Execution errors return `isError: true` and text containing `{ errors, data? }`. Partial GraphQL data is preserved when available; `structuredContent` is omitted on errors.

For a counted list call, in-process execution isolates the count per call and returns `_meta: { count }`, including zero. Remote execution reads numeric `extensions.count` from the GraphQL response. Aggregation resolvers do not compute counts.

| Code | Behavior |
| --- | --- |
| `MCP_PAGE_SIZE_EXCEEDED`, `MCP_RESULT_TOO_LARGE` | Returned as an error tool result. |
| `MCP_REMOTE_HTTP_ERROR` | Non-success HTTP response without a usable GraphQL body; includes status metadata. |
| `MCP_REMOTE_REQUEST_FAILED` | Network failure or timeout returned as an error result. |
| `MCP_REMOTE_INVALID_RESPONSE` | Remote response is not valid JSON or lacks a GraphQL response shape. |
| `MCP_TOOL_NOT_FOUND` | Thrown for an unknown published tool name. |
| `MCP_CALL_CANCELLED` | Thrown when the call's signal is already aborted before execution. |
| `MCP_MIDDLEWARE_ERROR` | Thrown for an invalid tool middleware chain. |
| `MCP_INVALID_SCHEMA`, `MCP_INVALID_TOOL_NAME`, `MCP_INVALID_LIMITS` | Configuration or generation errors. |
| `MCP_INVALID_EXECUTION_MODE`, `MCP_MISSING_ENDPOINT` | Invalid execution configuration. |
| `MCP_SDK_NOT_INSTALLED`, `MCP_SDK_INCOMPATIBLE`, `MCP_SDK_LOAD_FAILED` | SDK initialization failures in transport/server factories. |

Remote non-success responses with a usable GraphQL body preserve that body's errors. Active client cancellation can reject the remote call; the already-aborted check is not a guarantee that ongoing in-process database work can be cancelled. Application context factories and middleware may also throw.
