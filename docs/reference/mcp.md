---
title: MCP API
description: Tool generation, transport factories, execution options, limits, and MCP results.
---

# MCP API

The MCP functions are named exports of the opt-in `@simtlix/simfinity-mcp` package. The MongoDB facade also retains them through named exports and `simfinity.mcp` for compatibility. PostgreSQL applications import from the MCP package so core/PostgreSQL do not install its SDK chain. For a complete integration walkthrough, start with the [MCP guide](/guide/mcp).

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

The examples use the optional MCP package with an initialized schema from either backend:

```javascript
import * as mcp from '@simtlix/simfinity-mcp';
import { schema } from './schema.js';

const { tools, callTool, getOperation } = mcp.generateMCPTools(schema);

const source = getOperation('series');
const result = await callTool('series', {
  pagination: { page: 1, size: 10 },
});
```

`tools` contains `name`, `title`, `description`, `inputSchema`, `annotations`, `kind`, and normally `outputSchema`. `kind` is `query` or `mutation` and is internal metadata omitted from SDK tool listings.

`callTool(name, args = {}, extra)` accepts the published tool name. `extra` carries per-call metadata, including an optional `AbortSignal`. `getOperation(name)` returns the prebuilt GraphQL document.

Input schemas accept explicit `null` at nullable arguments, input fields and list items. Non-null positions reject null, including opaque scalars; nullable `$ref` values use `anyOf` with a null alternative. Recursive input types retain shared `$defs`. Defaulted arguments are optional and generated variable defaults use GraphQL literals, including external enum names. Opaque scalar defaults without a literal representation use the field's default when the variable is omitted. Explicit null never substitutes for omission at non-null positions. Validated scalars, including chains built on other validated scalars, use the JSON type of their root scalar. A custom scalar's description is published unless the field or argument has its own.

## Generation options

| Option | Default | Behavior |
| --- | --- | --- |
| `include`, `exclude` | Unset | A name or array of raw GraphQL names, published tool names, or the categories `'query'` and `'mutation'`. Exclusion wins. |
| `includeTypes`, `excludeTypes` | Unset | Filter by object return type name. Aggregate tools resolve their entity through their sibling list query. |
| `toolNamePrefix` | `''` | Prefix published names; GraphQL field names remain unchanged. |
| `selectionDepth` | `1` | Depth of automatically selected object relationships. |
| `includeId` | `true` | Include a scalar/enum ID as a fallback; use `__typename` if no leaf is selectable. |
| `toolOverrides` | `{}` | Per-tool title, description, annotations, selection depth, ID fallback, or explicit selection. |
| `limits` | Unset | Pagination and serialized result-size controls. |
| `toolMiddleware` | Unset | A middleware function or array surrounding actual tool execution; validated and copied at setup. |
| `context` | `{}` | In-process GraphQL context value or factory. |
| `schemaPlugins` | Unset | Plugins whose `onSchemaChange` hook is invoked in in-process mode; validated before any hook runs, falsy entries skipped, a misspelling of `onSchemaChange` on a plugin that lacks it rejected, asynchronous hooks awaited. Typed as `EnvelopSchemaPlugin` or `SchemaPluginObject` entries, so Envelop and Yoga `Plugin` arrays and class instances compile, including ones with `call` or `apply` members; functions and promises do not. |
| `execution` | `{ mode: 'in-process' }` | Local schema execution or remote GraphQL HTTP execution. |

Tool names must contain only letters, digits, underscores, and hyphens, with a maximum length of 128. A prefix must use the same character set. If query and mutation fields generate the same name, the first tool wins and the duplicate is skipped with a warning.

An `includeTypes` allowlist also excludes tools without an object entity type. Excluding an entity type hides its recognized aggregate tool as well.

## Tool overrides

```javascript
const generated = mcp.generateMCPTools(schema, {
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
| `maxResultBytes` | Caps pretty-printed UTF-8 JSON for successful `data` or the error payload `{ errors, data? }`; oversized payloads return `MCP_RESULT_TOO_LARGE`. |

A default page size above `maxPageSize` raises `MCP_INVALID_LIMITS` when the executor, server or HTTP handler is created. Configure positive bounds appropriate for your application. A page-size cap by itself does not add pagination to unpaginated calls; pair it with `defaultPagination` when you need bounded defaults. Result-size checking happens after execution, so it does not limit database work.

The size cap covers the logical payload, including errors and partial data. It excludes MCP envelope overhead, the duplicate `structuredContent`, and middleware-created results. Limit diagnostics (`MCP_RESULT_TOO_LARGE` and `MCP_PAGE_SIZE_EXCEEDED`) are exempt so a tiny cap still produces an actionable error. The cap does not limit remote downloads or undo completed mutations.

## Tool middleware

MCP middleware receives `call = { name, args, extra, kind, operation }`. It may mutate or replace `call.args`, return a tool result directly, or surround the executor using `next()`.

```javascript
const generated = mcp.generateMCPTools(schema, {
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

Pass one function or an array of functions. Every function runs, whatever its declared parameter count. A non-array value or a non-function entry, including `null` from `condition && middleware` and an empty slot in a sparse array such as `[a, , b]` or `new Array(2)`, throws `MCP_INVALID_MIDDLEWARE` naming the index when the tools, server or HTTP handler are created. The stack is copied at setup, so later changes to the array have no effect.

## Execution and context

In-process execution calls GraphQL directly against the supplied schema. `context` may be an object or an async factory `(extra) => context`. For the HTTP handler, a factory is invoked as `(req, extra) => context`, which allows application authentication to populate context per call.

Pass [authorization plugins](/guide/authorization) in `schemaPlugins` for standalone in-process execution. Only `onSchemaChange` is invoked; resolver wrapping is supported, a full Envelop request lifecycle is not.

- Every entry is validated before any hook runs. `false`, `null` and `undefined` entries are skipped. A non-array value, a function (pass the factory's result, such as `createAuthPlugin(permissions)`), an array, a promise (any object with a `then` method or getter), a non-function `onSchemaChange`, or an object with no plugin hooks throws `MCP_INVALID_SCHEMA_PLUGIN`.
- On a plugin without a function `onSchemaChange`, a misspelling of it also throws `MCP_INVALID_SCHEMA_PLUGIN`, with a hint to use `onSchemaChange`. A misspelling is an own or inherited method or getter whose name starts with `onSchema` in any letter case, or is at most two edits from `onSchemaChange` ignoring case, where swapping two adjacent letters counts as one edit: for example `onSchemaChanged`, `onschemaChange`, `onSchemChange` or `onShemaChange`. A property under such a name that is neither a method nor a getter is not treated as a misspelling.
- Next to a function `onSchemaChange`, other `onSchema*` members, such as an `onSchemaReady` or `onSchemaChangeImpl` helper, are accepted. Like any other `on*` member, they appear in the one-time warning described below.
- Validation reads `onSchemaChange` directly and inspects every other property, including `then`, through its property descriptor, so it calls no getter other than `onSchemaChange`. A hook defined as a getter counts as present, and an entry with a `then` getter is rejected as a promise without running it.
- A plugin with other hooks (`on*`, `instrumentation`, `requestDidStart` or `serverWillStart`) gets one console warning naming the hooks MCP ignores. Plugins it would add through `onPluginInit`/`addPlugin` are not installed.
- `replaceSchema` accepts only the schema MCP was given; any other schema throws `MCP_UNSUPPORTED_SCHEMA_REPLACEMENT`. Wrap resolvers in place instead.
- A promise returned by `onSchemaChange` is awaited. `createMCPServer`, `startStdioMCPServer` and `createHTTPMCPHandler` resolve after installation and reject if it fails. `generateMCPTools` stays synchronous; its tool calls wait for installation and reject with the installer's error if it failed. Envelop and Yoga do not await `onSchemaChange`, so keep installation synchronous for plugins you share with them.
- Hooks run only after the other options and every entry are validated, so a configuration error is reported before any hook changes the schema.

### Remote execution

```javascript
const generated = mcp.generateMCPTools(schema, {
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

`timeoutMs` limits a remote attempt through completion of response-body reading. `retry.attempts` counts additional attempts, with linear backoff of `backoffMs × retry number`; the default backoff is 250 ms. Only queries retry after network or body-read failures, timeouts, HTTP 429, or HTTP 5xx. Mutations are never retried by this transport. Client cancellation during fetch or body reading rejects without retrying.

Successful HTTP responses must contain object `data` or a nonempty `errors` array whose entries have string messages. If present, `data` must be an object or null, and null data requires errors. Empty or malformed errors arrays are invalid. Malformed JSON and invalid successful response shapes return `MCP_REMOTE_INVALID_RESPONSE` without retrying.

## Server and HTTP options

| Option | Default | Applies to |
| --- | --- | --- |
| `serverName` | `'simfinity-mcp'` | All SDK server factories. |
| `serverVersion` | `'1.0.0'` | All SDK server factories. |
| `transportOptions` | Unset | HTTP handler; spread into `StreamableHTTPServerTransport`. |
| `onError(error, req, res)` | Unset | HTTP handler error reporting callback. |

The HTTP factory builds tool definitions once, then creates a fresh stateless server and transport per request. Setting `sessionIdGenerator`, `onsessioninitialized`, `onsessionclosed` or `eventStore` is rejected at setup with `MCP_INVALID_TRANSPORT_OPTIONS`; session persistence and resumable streams require an application-managed transport with `createMCPServer`. The handler passes `req.body` to the SDK, so mount appropriate JSON parsing middleware.

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

Execution errors return `isError: true` and text containing `{ errors, data? }`. Partial GraphQL data is preserved when available and within `maxResultBytes`; `structuredContent` is omitted on errors.

For a counted list call, in-process execution isolates the count per call and returns `_meta: { count }`, including zero. Remote execution reads numeric `extensions.count` from the GraphQL response. Aggregation resolvers do not compute counts.

| Code | Behavior |
| --- | --- |
| `MCP_PAGE_SIZE_EXCEEDED`, `MCP_RESULT_TOO_LARGE` | Returned as an error tool result. |
| `MCP_REMOTE_HTTP_ERROR` | Non-success HTTP response without a usable GraphQL body; includes status metadata. |
| `MCP_REMOTE_REQUEST_FAILED` | Network failure or timeout returned as an error result. |
| `MCP_REMOTE_INVALID_RESPONSE` | Remote response is not valid JSON or lacks a GraphQL response shape. |
| `MCP_TOOL_NOT_FOUND` | Thrown for an unknown published tool name. |
| `MCP_CALL_CANCELLED` | Thrown when the call's signal is already aborted before execution. |
| `MCP_MIDDLEWARE_ERROR` | Thrown during a call when middleware calls `next()` twice or the chain returns no result. |
| `MCP_INVALID_MIDDLEWARE` | Invalid `toolMiddleware` configuration, including an empty slot in a sparse array; thrown at setup. |
| `MCP_INVALID_SCHEMA_PLUGIN`, `MCP_UNSUPPORTED_SCHEMA_REPLACEMENT` | Invalid `schemaPlugins` configuration, including a misspelling of `onSchemaChange` on a plugin that lacks it, or a plugin replacing the schema; thrown at setup. |
| `MCP_INVALID_SCHEMA`, `MCP_INVALID_TOOL_NAME`, `MCP_INVALID_LIMITS` | Configuration or generation errors. |
| `MCP_INVALID_EXECUTION_MODE`, `MCP_MISSING_ENDPOINT` | Invalid execution configuration. |
| `MCP_INVALID_TRANSPORT_OPTIONS` | Stateful transport settings supplied to the stateless HTTP factory. |
| `MCP_SDK_NOT_INSTALLED`, `MCP_SDK_INCOMPATIBLE`, `MCP_SDK_LOAD_FAILED` | SDK initialization failures in transport/server factories. |

Remote non-success responses with a usable GraphQL body preserve that body's errors. An aborted signal is checked before in-process execution and again after awaiting the context factory, preventing a cancelled call from starting a mutation. This does not undo or cancel database work that already started. Active remote cancellation rejects during fetch or body reading. Application context factories and middleware may also throw.
