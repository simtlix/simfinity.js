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

Only the transport/server factories require `@modelcontextprotocol/sdk@^1.31.0`. Definitions are generated from root query and mutation fields; subscriptions are not exposed as tools.

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

Input schemas accept explicit `null` at nullable arguments, input fields and list items. Non-null positions reject null, including opaque scalars; nullable `$ref` values use `anyOf` with a null alternative. Recursive input types retain shared `$defs`. Defaulted arguments are optional and generated variable defaults use GraphQL literals, including external enum names. Opaque scalar defaults without a literal representation use the field's default when the variable is omitted. Explicit null never substitutes for omission at non-null positions. Validated scalars, including chains built on other validated scalars, and custom scalars with a `baseScalarType` storage hint use the JSON type of their root scalar. `Date`, `DateTime` and `Time` roots carry a string `format` (`date`, `date-time` or `time`) as a hint for the value to send. A custom scalar's description is published unless the field or argument has its own.

The arguments object of every input schema is closed with `additionalProperties: false`, so hosts that validate tool input reject an undeclared key before the call reaches the server. `callTool` rejects an undeclared key that the caller sent with an [`MCP_UNKNOWN_ARGUMENT`](#unknown-arguments) result, without executing the tool. Nested input objects are not closed in the schema; GraphQL already rejects their unknown fields.

### Output schemas

An output schema mirrors the generated selection set; nullable GraphQL positions accept `null`. A scalar gets a JSON `type` only when it is a GraphQL spec scalar (`Int`, `Float`, `String`, `Boolean`, `ID`) or a [`createValidatedScalar`](/reference/scalars#createvalidatedscalar) chain that ends at one, because only those serialize through a spec scalar. Every other scalar is published without a `type` or `format`, since its own `serialize` decides its JSON form:

- `Date`, `DateTime` and `Time`, whose serializer may return an ISO instant, epoch milliseconds or `YYYY-MM-DD`. When neither the scalar nor the field has a description, the schema carries one such as `Date/time value; its JSON form is defined by the server's Date scalar (commonly an ISO 8601 string).`
- Custom scalars with a hand-set `baseScalarType` storage hint, such as a `Decimal` hinted as `Float` that serializes `'12.30'`.
- Opaque custom scalars.

Validating MCP clients, including the SDK `Client`, check `structuredContent` against the output schema with formats, so a published `format` or primitive type that the serializer does not produce would make them reject a valid result.

Input and output differ for these scalars: an input `Time` argument still advertises `format: 'time'`, while the output carries whatever `serialize` returns, often an ISO instant. A host that validates input formats can reject a value an agent copies from one tool's output into another tool's input. On MongoDB these scalars are stored in `Date` paths, so a value such as `'14:30:00Z'` that matches the `time` format fails the generated write with a cast error instead of being stored.

Next to the root field, the output schema declares the optional keys MCP adds to results: `totalCount` on list tools with a `pagination` argument, and `truncated` on mutation tools when `limits.maxResultBytes` is set at setup. The key is `__totalCount` or `__truncated` when the root field itself has that name; GraphQL reserves the `__` prefix, so no root field can collide with it. See [results and errors](#results-and-errors).

## Generation options

| Option | Default | Behavior |
| --- | --- | --- |
| `include`, `exclude` | Unset | A name or array of raw GraphQL names, published tool names, or the categories `'query'` and `'mutation'`. Exclusion wins. |
| `includeTypes`, `excludeTypes` | Unset | Filter by object return type name. Aggregate tools resolve their entity through their sibling list query. |
| `toolNamePrefix` | `''` | Prefix published names; GraphQL field names remain unchanged. |
| `selectionDepth` | `1` | Depth of automatically selected object relationships. |
| `includeId` | Ignored | Deprecated; it never changed the generated selection. Every scalar or enum field without required arguments, `id` included, is selected; an object type with none selects `__typename`. |
| `toolOverrides` | `{}` | Per-tool title, description, annotations, selection depth, or explicit selection. |
| `limits` | Unset | Pagination and serialized result-size controls, validated at setup. |
| `toolMiddleware` | Unset | A middleware function or array surrounding actual tool execution; validated and copied at setup. |
| `context` | `{}` | In-process GraphQL context value or factory. |
| `schemaPlugins` | Unset | Plugins whose `onSchemaChange` hook is invoked in in-process mode; validated before any hook runs, falsy entries skipped, a misspelling of `onSchemaChange` on a plugin that lacks it rejected, asynchronous hooks awaited. Typed as `EnvelopSchemaPlugin` or `SchemaPluginObject` entries, so Envelop and Yoga `Plugin` arrays and class instances compile, including ones with `call` or `apply` members; functions and promises do not. |
| `execution` | `{ mode: 'in-process' }` | Local schema execution or remote GraphQL HTTP execution. |

Tool names must contain only letters, digits, underscores, and hyphens, with a maximum length of 128. A prefix must use the same character set. If query and mutation fields generate the same name, the first tool wins and the duplicate is skipped with a warning.

An `includeTypes` allowlist also excludes tools without an object entity type. Excluding an entity type hides its recognized aggregate tool as well.

### TypeScript option types

The `options` parameter is typed `GenerateMCPToolsInit` for `generateMCPTools`, `MCPServerInit` for `createMCPServer` and `startStdioMCPServer`, and `HTTPMCPHandlerInit` for `createHTTPMCPHandler`. Each accepts every value of its option interface (`GenerateMCPToolsOptions`, `MCPServerOptions` or `HTTPMCPHandlerOptions`), plus the wider `execution` and `limits` forms of `MCPOptionsInit` that the runtime accepts:

- `execution` also takes `MCPRemoteExecutionInit`. Its `headers` is an `MCPRemoteHeadersInit` (a plain object, a `Headers` instance, a `Map` or readonly `[name, value]` pairs), `null` or `false`. Its `timeoutMs` is a number, a numeric string, a bigint, `null` or `false`.
- `limits` takes `MCPLimitsInit`, `null` or `false`. Caps are numbers, numeric strings, bigints, `null` or `false`, and `defaultPagination` may also be `null` or `false`.

The option interfaces, `MCPLimits` and `MCPRemoteExecutionOptions` keep their 3.5.6 shapes, such as `headers?: Record<string, string>` and number caps, so code that reads options back, for example to rotate `execution.headers.authorization`, compiles unchanged. Annotate a variable with the option interface when you read it back. Pairs built in a separate variable need `as const`.

### Tool classification

Each root field is classified into an operation that decides its title, description and annotations:

- Simfinity's generated list and aggregate queries carry their operation in `extensions.simfinityQuery`, which decides whether a query is published as a list or an aggregate tool. A list query stays a list tool, with `totalCount`, even when its type declares a field named `aggregation` and so has an `aggregation` filter argument. Generated list fields also carry `countSink: true` there; see [counted lists](#counted-lists).
- Other query fields, including those of a schema rebuilt from SDL, are published as aggregate tools when they have an `aggregation` argument. Otherwise a list query is a list tool only with a `pagination` argument, and a single-record query is a get-by-id tool only with an `id` argument. Any other query is a read-only custom query, titled by its field name and described as ``Run the read-only `currentUser` query.``, unless the field has its own description.
- Simfinity's generated mutations carry `extensions.simfinityMutation`: `{ typeName, operation }` with `operation` `'save'`, `'update'` or `'delete'` for the generated add, update and delete mutations; `{ typeName, operation: 'state_changed', action, from, to }` for state-machine actions; and `{ operation: 'custom_mutation' }` for mutations registered with `registerMutation()`. Extensions are not part of SDL, and Simfinity's introspection extension does not expose these keys.
- Without that marker, as in a schema rebuilt from SDL or introspection or a hand-built schema, a mutation is a create, update or delete tool only when it has the placeholder description Simfinity gives generated mutations (`'add'`, `'update'` or `'delete'`) and the matching name prefix. A name alone never makes a CRUD tool, so a description-less `deleteDraft_book` state action or `updateStats` custom mutation is a custom tool. In such a schema, a custom mutation registered with exactly the placeholder description and the matching prefix, such as `registerMutation('addCredits', 'add', …)`, still reads as a create.

A state-machine action without its own description is described from its marker, for example ``Apply the `publish` state transition to an existing Book. It is allowed only while the Book is in state DRAFT and moves it to PUBLISHED. Provide `input` with the record's `id`; other fields in `input` are updated too. Returns the updated Book.`` State-machine actions, custom queries and custom mutations are titled by their field name.

### Annotations

Every tool has `title` and `openWorldHint: false`. The behavioral hints depend on the operation:

| Operation | Hints |
| --- | --- |
| List, get-by-id, aggregate and custom queries | `readOnlyHint: true` |
| Create | `readOnlyHint: false`; `destructiveHint` and `idempotentHint` are unset, so MCP's defaults apply |
| Update | `readOnlyHint: false`, `idempotentHint: true`, or `idempotentHint: false` when its input can carry collection items to insert |
| Delete | `readOnlyHint: false`, `destructiveHint: true`, `idempotentHint: true` |
| State-machine action and custom mutation | `readOnlyHint: false` |

`idempotentHint` describes the stored data only. A repeated call runs tool middleware, Simfinity middleware and controller hooks again. An update input can carry items to insert through an `added` list, as the generated input of a non-embedded one-to-many collection does at any depth, including `updated[].<collection>.added`; every repeat inserts those items again, so such updates are not idempotent. Embedded lists, which an update replaces as a whole, and single references keep the hint, and so does a collection without `added`, which Simfinity leaves out when the child has no writable field besides its back-reference. A repeated delete deletes nothing more, but it still calls the controller's `onDelete` hook, with `null` because the record no longer exists, so `onDelete` hooks must tolerate `null`.

`toolOverrides` annotations are merged over these hints, so you can mark a tool idempotent when your hooks make repeats harmless. A state-machine action is usually safe to mark idempotent, because a repeat fails the transition's from-state check, unless the action keeps the record in the same state and its input inserts collection items.

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

Keys may use the published tool name or the original field name; a published-name override takes precedence. Supported properties are `title`, `description`, `annotations`, `selectionDepth`, and `selection`; a deprecated `includeId` is accepted and ignored. Annotation properties are merged over generated annotations.

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
| `defaultPagination` | Injected when a tool has a pagination argument and the caller supplies none. Must be valid for the `pagination` argument type of every published tool; for Simfinity's `QLPagination`, provide both `page` and `size`. |
| `maxResultBytes` | Caps pretty-printed UTF-8 JSON for successful `data` or the error payload `{ errors, data? }`. Oversized query payloads return `MCP_RESULT_TOO_LARGE`; an oversized mutation payload is replaced by the root ids and a notice, because the write already ran. |

`limits` is validated when the executor, server or HTTP handler is created, before `schemaPlugins` run; invalid settings throw `MCP_INVALID_LIMITS`:

- A falsy `limits`, `defaultPagination` or cap (`undefined`, `null`, `false`, `0`, `''`, as `condition && 100` produces) leaves it unset. A truthy `limits` or `defaultPagination` must be an object.
- A cap must be a number of at least 1. Numeric strings, such as environment variables, and bigints are converted, `'Infinity'` included. A `NaN` cap, such as `Number()` of an unset environment variable, applies no cap and logs one warning per setup. Numbers below 1, such as `-1` or `0.5`, `true`, blank strings, strings that are not numeric or that convert to a number below 1 (such as `'0'`, `'0.0'` or `'0.5'`), objects, arrays and functions throw.
- `defaultPagination` is checked against the `pagination` argument type of every published tool. For `QLPagination`, `page` and `size` are required positive integers, `count` must be a boolean and no other key is allowed; a custom pagination type is checked against its own GraphQL type. `size` must not exceed `maxPageSize`. The error names the tool and quotes the GraphQL error, for example `limits.defaultPagination is not a valid QLPagination for the pagination argument of tool "books": Field "page" of required type "Int!" was not provided.` Core's own page-size cap, [`configureQueryLimits`](/reference/api#configurequerylimits), can change at runtime and is unknown in remote mode, so it is not checked.

`callTool` reads the `limits` object you passed on every call, and the HTTP handler reads `options.limits` again for every request, so later changes apply. A cap changed after setup to an invalid value makes calls reject with `MCP_INVALID_LIMITS`; a `defaultPagination` set after setup is injected without the type check.

Configure positive bounds appropriate for your application. A page-size cap by itself does not add pagination to unpaginated calls; pair it with `defaultPagination` when you need bounded defaults. Result-size checking happens after execution, so it does not limit database work.

The size cap covers the logical payload, including errors, partial data and a counted list's `totalCount`. It excludes MCP envelope overhead, the duplicate `structuredContent`, and middleware-created results. Limit diagnostics (`MCP_RESULT_TOO_LARGE`, `MCP_PAGE_SIZE_EXCEEDED` and `MCP_UNKNOWN_ARGUMENT`) and the notice that replaces an oversized mutation result are exempt, so a tiny cap still produces an actionable result. The root id, or the id list, is returned next to that notice only when it fits within the cap. The cap does not limit remote downloads. See [oversized results](#oversized-results).

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

Middleware may be synchronous. If any middleware throws, synchronously or asynchronously, the previous middleware's `next()` promise rejects, so outer `try { return await next(); } catch { … }`, `.catch()`, `.then(onSuccess, onFailure)` and `.finally()` boundaries see the error. A middleware may start `next()` and await other work before awaiting the promise it returned. Every `next()` promise is marked as handled: a rejection that no middleware awaits or returns is dropped instead of becoming an unhandled rejection, so await or return `next()` when you need its outcome. A synchronous `try { return next(); } catch { … }` without `await` catches nothing, because the error arrives as a rejection.

Keys in `call.args` must be declared arguments of the tool when the chain reaches execution, unless middleware added them:

- An undeclared key that the caller sent is rejected with `MCP_UNKNOWN_ARGUMENT` and the tool does not run. The caller's keys are recorded before middleware runs, so a middleware that reads its own custom key must delete it from `call.args` before calling `next()`. This only helps with hosts that do not validate tool input: hosts that validate against the closed `inputSchema` reject undeclared keys before the call reaches the server and its middleware. There is no option to declare extra keys in the published schema.
- Keys that middleware adds, such as an owner filter added to every tool, pass through as before, including to tools that do not declare them. They are still sent as GraphQL variables, which GraphQL ignores when the operation does not declare them.
- Keys whose value is `undefined` are ignored.

Pass one function or an array of functions. Every function runs, whatever its declared parameter count. A non-array value or a non-function entry, including `null` from `condition && middleware` and an empty slot in a sparse array such as `[a, , b]` or `new Array(2)`, throws `MCP_INVALID_MIDDLEWARE` naming the index when the tools, server or HTTP handler are created. The stack is copied at setup, so later changes to the array have no effect.

## Execution and context

In-process execution calls GraphQL directly against the supplied schema. `context` may be an object or an async factory `(extra) => context`. For the HTTP handler, a factory is invoked as `(req, extra) => context`, which allows application authentication to populate context per call.

Generated tools receive your context object itself, on counted list calls too: its identity, class, private fields, own properties and in-place writes are those of the object you supply, and a factory may return `null`. Only a list tool whose field lacks core's `countSink` marker, such as a custom list query, sees a different object on counted calls; see [counted lists](#counted-lists).

Pass [authorization plugins](/guide/authorization) in `schemaPlugins` for standalone in-process execution. Only `onSchemaChange` is invoked; resolver wrapping is supported, a full Envelop request lifecycle is not.

- Every entry is validated before any hook runs. `false`, `null` and `undefined` entries are skipped. A non-array value, a function (pass the factory's result, such as `createAuthPlugin(permissions)`), an array, a promise (any object with a `then` method or getter), a non-function `onSchemaChange`, or an object with no plugin hooks throws `MCP_INVALID_SCHEMA_PLUGIN`.
- On a plugin without a function `onSchemaChange`, a misspelling of it also throws `MCP_INVALID_SCHEMA_PLUGIN`, with a hint to use `onSchemaChange`. A misspelling is an own or inherited method or getter whose name starts with `onSchema` in any letter case, or is at most two edits from `onSchemaChange` ignoring case, where swapping two adjacent letters counts as one edit: for example `onSchemaChanged`, `onschemaChange`, `onSchemChange` or `onShemaChange`. A property under such a name that is neither a method nor a getter is not treated as a misspelling.
- Next to a function `onSchemaChange`, other `onSchema*` members, such as an `onSchemaReady` or `onSchemaChangeImpl` helper, are accepted. Like any other `on*` member, they appear in the one-time warning described below.
- Validation reads `onSchemaChange` directly and inspects every other property, including `then`, through its property descriptor, so it calls no getter other than `onSchemaChange`. A hook defined as a getter counts as present, and an entry with a `then` getter is rejected as a promise without running it.
- A plugin with other hooks (`on*`, `instrumentation`, `requestDidStart` or `serverWillStart`) gets one console warning naming the hooks MCP ignores. Plugins it would add through `onPluginInit`/`addPlugin` are not installed.
- `replaceSchema` accepts only the schema MCP was given; any other schema throws `MCP_UNSUPPORTED_SCHEMA_REPLACEMENT`. Wrap resolvers in place instead.
- A promise returned by `onSchemaChange` is awaited. `createMCPServer`, `startStdioMCPServer` and `createHTTPMCPHandler` resolve after installation and reject if it fails. `generateMCPTools` stays synchronous; its tool calls wait for installation and reject with the installer's error if it failed. Envelop and Yoga do not await `onSchemaChange`, so keep installation synchronous for plugins you share with them.
- Hooks run only after the schema, the other options and every entry are validated, so a configuration error is reported before any hook changes the schema and leaves its resolvers as they were. The server and transport factories load the SDK first: `createMCPServer` loads the SDK server API, `startStdioMCPServer` also loads the stdio transport, and `createHTTPMCPHandler` also loads the Streamable HTTP transport, all before validating options and running hooks. An SDK error therefore comes before any option error, including `createHTTPMCPHandler`'s `MCP_INVALID_TRANSPORT_OPTIONS`, and leaves the schema untouched.

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

`endpoint` is required in remote mode. Requests use HTTP POST with the generated query and variables. Local context and schema plugins are not applied to remote execution.

The endpoint is passed to `fetch` as given, so it can also be a `URL` or `Request` instance. It must not include a username or password; send credentials in `headers`. `fetch` rejects such a URL on every call, so it throws `MCP_INVALID_EXECUTION_CONFIG` when the tools, server or HTTP handler are created. Other endpoints that the default `fetch` cannot request, such as relative, unparsable or non-`http(s)` URLs, are accepted at setup, because an application that replaces `globalThis.fetch` may handle them. When `fetch` rejects one with an error that quotes the URL, the call fails with `MCP_REMOTE_REQUEST_FAILED` and the message `execution.endpoint must be an absolute http(s) URL, such as https://api.example.com/graphql` instead of that error; other `fetch` errors, such as an application `fetch`'s own network failure, keep their message. No message quotes the URL, which may carry credentials or an API key. `endpoint` is read on every call: one changed after setup to a URL with credentials fails the call with `MCP_REMOTE_REQUEST_FAILED` and the setup message.

`headers` is configuration, not a per-request factory; incoming MCP credentials are not forwarded automatically. It accepts a plain object, a `Headers` instance, a `Map` or an array of `[name, value]` pairs, and any falsy value (`undefined`, `null`, `false`, `''`, `0`) sends no extra headers:

- A plain object contributes its own enumerable string keys, as spreading it did.
- Names are case-insensitive. A `Content-Type` in any casing replaces the `application/json` default and is sent once; when the input repeats it, the last value wins. Other repeated names are combined, as `fetch` does.
- Headers are read on every call, so mutating or replacing them, for example to rotate a token, applies to later calls. They must be readable more than once: a string, a number, `true`, a promise (await it first), a function or a one-shot iterator such as `map.entries()` or a generator throws `MCP_INVALID_EXECUTION_CONFIG` when the tools, server or HTTP handler are created. That check reads no header value, so lazy getters on header values run only when a call reads them.
- A getter defined on the execution object itself, such as `get headers() { … }` or `get timeoutMs() { … }` in an object literal, is not run at setup, only on every call, where its value is checked like a plain property. It may therefore throw until a token loads. A getter inherited from a class, and a `Proxy` execution object, are read at setup and the value they return is checked there. A read that throws, for example until a token loads, does not fail setup: that property is then read and checked on every call only.
- An invalid header name or value, or a malformed pair, fails the call with `MCP_REMOTE_REQUEST_FAILED` before any request is sent, and a query retries it like other request failures. The message names the entry position or the header, never its value, which may be a credential. Headers replaced after setup by a value that setup would reject fail calls the same way.
- `fetch` receives the headers as a plain object with lowercase names, such as `authorization`. For the TypeScript forms, see [TypeScript option types](#typescript-option-types).

`timeoutMs` limits each remote attempt through completion of response-body reading. It takes positive milliseconds: numeric strings and bigints are converted, fractions round up (`1500.5` waits 1501 ms), and values above 2147483647, the Node.js timer limit, are capped to it. Unset, `0`, `'0'`, `NaN`, `null`, `false` and `''` disable the timeout. `Infinity`, `'Infinity'`, negative numbers, `true`, blank or non-numeric strings such as `'5s'`, objects, arrays and functions throw `MCP_INVALID_EXECUTION_CONFIG` at setup. `timeoutMs` is read again on every call; a value changed after setup to an invalid one makes the call reject with `MCP_INVALID_EXECUTION_CONFIG`.

`retry.attempts` counts additional attempts, with linear backoff of `backoffMs × retry number`; the default backoff is 250 ms. Only queries retry after network or body-read failures, timeouts, HTTP 429, or HTTP 5xx. Mutations are never retried by this transport. Client cancellation during fetch, body reading or a retry backoff rejects at once with the signal's abort reason, without another request. This holds for `callTool` with `extra.signal`, stdio and `createMCPServer` over a persistent transport. Through `createHTTPMCPHandler`, only a closed HTTP connection cancels a call; see [server and HTTP options](#server-and-http-options).

Successful HTTP responses must contain object `data` or a nonempty `errors` array whose entries have string messages. If present, `data` must be an object or null, and null data requires errors. Empty or malformed errors arrays are invalid. Malformed JSON and invalid successful response shapes return `MCP_REMOTE_INVALID_RESPONSE` without retrying.

## Server and HTTP options

| Option | Default | Applies to |
| --- | --- | --- |
| `serverName` | `'simfinity-mcp'` | All SDK server factories. |
| `serverVersion` | `'1.0.0'` | All SDK server factories. |
| `transportOptions` | Unset | HTTP handler; spread into `StreamableHTTPServerTransport`. |
| `onError(error, req, res)` | Unset | HTTP handler error reporting callback. |

The HTTP factory builds tool definitions once, then creates a fresh stateless server and transport per POST request. Mount the handler for every method, for example with `app.all`. It answers any other method, such as GET or DELETE, with HTTP 405, an `Allow: POST` header and the JSON-RPC body `{"jsonrpc":"2.0","error":{"code":-32000,"message":"Method not allowed."},"id":null}`, without invoking `context` or `onError` or creating a server or transport: a stateless handler has no standalone SSE stream to open on GET and no session to terminate on DELETE. MCP clients treat a 405 on GET as "no server stream". With `app.post`, Express answers GET with 404, which SDK clients report through `onerror`. Setting `sessionIdGenerator`, `onsessioninitialized`, `onsessionclosed` or `eventStore` is rejected at setup with `MCP_INVALID_TRANSPORT_OPTIONS`; session persistence and resumable streams require an application-managed transport with `createMCPServer`. The handler passes `req.body` to the SDK, so mount appropriate JSON parsing middleware.

Because each POST gets its own server, an MCP `notifications/cancelled`, which the client sends as a separate request, cannot reach a call in flight. That call keeps running, through a remote fetch, body reading or retry backoff, and a remote query retry still sends its request. Only closing the HTTP connection, such as a client disconnect or `client.close()`, aborts the call's signal and settles it at once.

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

`structuredContent` holds the GraphQL `data` plus the keys MCP adds next to the root field: `totalCount` on counted list calls, or, when an oversized mutation result is replaced, only the root ids and a `truncated` notice. These keys are `__totalCount` and `__truncated` when the root field itself is named `totalCount` or `truncated`. The text content is the same JSON.

Execution errors return `isError: true` and text containing `{ errors, data? }`. Partial GraphQL data is preserved when available and within `maxResultBytes`; `structuredContent` is omitted on errors.

In-process execution serializes the GraphQL errors as graphql-js produces them and does not apply [`buildErrorFormatter()`](/reference/errors#builderrorformatter). An error that a hook, validator or custom mutation throws therefore reaches the tool result with its own message, such as `connect ECONNREFUSED 10.0.0.5:8443` from a Node.js HTTP client, on both backends. Database failures appear as the adapter reports them, such as PostgreSQL's `Database operation failed` with `DATABASE_ERROR`. Replace sensitive results in [tool middleware](#tool-middleware) when tools are exposed to untrusted clients.

### Counted lists

A list tool call with `pagination: { count: true }`, sent by the caller or injected through `limits.defaultPagination`, returns the total number of matching records across all pages as `totalCount` next to the results, in `structuredContent` and in the text, and as `_meta: { count }` for client code. In-process calls report zero too. Hosts give the model `structuredContent` or the text and keep `_meta` for client code, so the model sees `totalCount`:

```javascript
{
  content: [{ type: 'text', text: '{ "series": [ … ], "totalCount": 41 }' }],
  structuredContent: { series: [/* … */], totalCount: 41 },
  isError: false,
  _meta: { count: 41 },
}
```

`totalCount` is declared in the output schema of list tools that have a `pagination` argument. It is counted toward `maxResultBytes`; when a counted list exceeds the cap, the `MCP_RESULT_TOO_LARGE` error carries the total in `extensions.totalCount`, so the agent can choose a page size. Remote execution reads a numeric `extensions.count` from the GraphQL response, such as the one the [count plugins](/reference/plugins#count-behavior) add; it becomes `totalCount` only when it is a non-negative integer and otherwise stays in `_meta.count` alone. Simfinity's count plugins omit a count of zero, so a remote call that matches nothing returns neither `totalCount` nor `_meta.count`. Aggregation resolvers do not compute counts.

In-process, Simfinity's generated list resolver reports the count to a per-call sink in the GraphQL root value instead of writing `context.count`, so the call receives your context object unchanged. Every in-process call of a generated list tool, counted or not, runs with a null-prototype root value that carries that sink: wrappers and authorization rules on the root field see it as `parent`, and every resolver in the operation sees it as `info.rootValue`. MCP reads the count only when the call requested one; a count that Simfinity middleware forces by changing the arguments is neither returned nor written to the context.

MCP picks the mechanism when the tools are created, from the field's `extensions.simfinityQuery.countSink` marker, not from the resolver that runs. A list field without the marker, such as a custom list query, keeps the previous mechanism on counted calls: its resolver receives a per-call object whose prototype is your context and writes `context.count` there. Reads reach your object, but writes stay on the per-call object and its identity differs from yours, so code that relies on private fields, own-property checks or `===` must not run in such a resolver on counted calls. Uncounted calls receive your context itself.

A generated list field keeps its marker when an application replaces or wraps its resolver, so MCP still passes your context itself. A resolver that writes `context.count` then writes it onto your shared object, and the call returns no total. Do one of the following:

- When a wrapper calls the generated resolver, forward `parent` or `info`. Wrappers that pass all four arguments on, such as the auth plugin's, or only `(parent, args, context)`, keep working.
- In a replacement resolver, report the total through the root-value sink:

  ```javascript
  const sink = parent?.[Symbol.for('simfinity.countSink')];
  if (typeof sink === 'function') sink(total);
  else context.count = total;
  ```

- Clear the marker before creating the tools, so MCP uses the per-call object: `schema.getQueryType().getFields().series.extensions.simfinityQuery.countSink = false`. `schemaPlugins` run after the tools are created, too late for this.

### Oversized results

When a mutation result exceeds `maxResultBytes`, the write has already run, so the result is not reported as a failure that invites a retry. A mutation that succeeded returns `isError: false`, `_meta: { truncated: true }`, and only the id of the root value (or the ids of a returned list, when every item has one) next to a `truncated` notice:

```javascript
{
  content: [{ type: 'text', text: '{ "addbook": { "id": "9" }, "truncated": { … } }' }],
  structuredContent: {
    addbook: { id: '9' },
    truncated: {
      applied: true,
      message: 'addbook was applied (the record was created). Its full result (470 bytes) exceeds maxResultBytes (256) and was omitted; only the id is returned. Calling addbook again would create another record; do not call addbook again for this change; use a query tool to read the record if you need its other fields.',
      resultBytes: 470,
      maxResultBytes: 256,
    },
  },
  isError: false,
  _meta: { truncated: true },
}
```

The message depends on the operation and on the tool's merged `idempotentHint`, including a `toolOverrides` annotation. It always says whether calling the tool again could repeat the change, and never contradicts the hint: for an idempotent update or delete it says that a repeat would not repeat the change, so there is no need to call the tool again. A create says a repeat would create another record; state-machine actions and custom mutations say a repeat could repeat the change. A delete never sends the agent to read the record back. When the root value has no `id`, only the notice is returned. The id, or the id list, is also subject to the cap: when it alone exceeds `maxResultBytes`, it is dropped too, and the message says so. The notice reports `maxResultBytes` rounded down to whole bytes, so a fractional cap such as `512.5` appears as `512`. The output schema declares the notice only when `limits.maxResultBytes` is set at setup and the tool has no `selection` override.

A mutation result that carries GraphQL errors stays `isError: true` with `MCP_RESULT_TOO_LARGE`, and its extensions say whether the write ran: `applied: true` when the root field returned a value, otherwise `applied: 'unknown'`, never `false`, because a non-null error in a nested field can null the root of a committed write. `extensions.firstError` holds the first error message, cut to 300 characters and an ellipsis, and `data` holds the root ids when present. With `'unknown'`, the message asks the agent to check the current state with a query tool before calling the tool again.

Oversized query results keep returning the `MCP_RESULT_TOO_LARGE` error. Its message, like the notice, reports `maxResultBytes` rounded down to whole bytes.

### Unknown arguments

When the caller sends an argument key that the tool does not declare, with a value other than `undefined`, the call returns an error result and nothing is executed, so no GraphQL operation or remote request runs and a corrected retry is safe:

```json
{
  "errors": [{
    "message": "Unknown arguments \"titel\", \"limit\" for tool \"books\". Did you mean \"title\" instead of \"titel\"? Valid arguments: title, pagination. The tool was not executed.",
    "extensions": { "code": "MCP_UNKNOWN_ARGUMENT" }
  }]
}
```

A suggestion is given for a declared argument that matches the key ignoring letter case, or that is at most one edit away when either name has four characters or fewer and at most two edits away otherwise. `id` is suggested only for a match ignoring case, so a key such as `AND` or `q` is never mapped to `id`. A tool without arguments says `The tool takes no arguments.` See [tool middleware](#tool-middleware) for keys that middleware adds or consumes.

### Error codes

| Code | Behavior |
| --- | --- |
| `MCP_PAGE_SIZE_EXCEEDED` | Returned as an error tool result. |
| `MCP_RESULT_TOO_LARGE` | Returned as an error tool result for an oversized query result, or for an oversized mutation result with GraphQL errors (with `extensions.applied` and `extensions.firstError`); a counted list adds `extensions.totalCount`. |
| `MCP_UNKNOWN_ARGUMENT` | Returned as an error tool result when the caller sent an undeclared argument; the tool was not executed. |
| `MCP_REMOTE_HTTP_ERROR` | Non-success HTTP response without a usable GraphQL body; includes status metadata. |
| `MCP_REMOTE_REQUEST_FAILED` | Network failure or timeout returned as an error result; also remote `headers` that cannot be sent, reported without their values, and an `endpoint` that `fetch` cannot request (relative, unparsable, not `http(s)`, or changed after setup to one with credentials), reported without the URL, both before any request is sent. |
| `MCP_REMOTE_INVALID_RESPONSE` | Remote response is not valid JSON or lacks a GraphQL response shape. |
| `MCP_TOOL_NOT_FOUND` | Thrown for an unknown published tool name. |
| `MCP_CALL_CANCELLED` | Thrown when the call's signal is already aborted before execution. |
| `MCP_MIDDLEWARE_ERROR` | Thrown during a call when middleware calls `next()` twice or the chain returns no result. |
| `MCP_INVALID_MIDDLEWARE` | Invalid `toolMiddleware` configuration, including an empty slot in a sparse array; thrown at setup. |
| `MCP_INVALID_SCHEMA_PLUGIN`, `MCP_UNSUPPORTED_SCHEMA_REPLACEMENT` | Invalid `schemaPlugins` configuration, including a misspelling of `onSchemaChange` on a plugin that lacks it, or a plugin replacing the schema; thrown at setup. |
| `MCP_INVALID_SCHEMA`, `MCP_INVALID_TOOL_NAME`, `MCP_INVALID_LIMITS` | Configuration or generation errors, thrown at setup. A `limits` cap changed after setup to an invalid value also makes calls reject with `MCP_INVALID_LIMITS`. |
| `MCP_INVALID_EXECUTION_MODE`, `MCP_MISSING_ENDPOINT` | Invalid execution configuration. |
| `MCP_INVALID_EXECUTION_CONFIG` | A remote `endpoint` with a username or password, or an invalid `headers` container or `timeoutMs`, thrown at setup; the message never quotes the endpoint. A `timeoutMs` changed after setup to an invalid value makes calls reject with it. |
| `MCP_INVALID_TRANSPORT_OPTIONS` | Stateful transport settings supplied to the stateless HTTP factory. |
| `MCP_SDK_NOT_INSTALLED`, `MCP_SDK_INCOMPATIBLE`, `MCP_SDK_LOAD_FAILED` | SDK initialization failures in transport/server factories. `MCP_SDK_INCOMPATIBLE` also covers SDK modules that lack the expected exports (`Server`, the request schemas, `StdioServerTransport` or `StreamableHTTPServerTransport`); its message suggests `npm install @modelcontextprotocol/sdk@^1.31.0`. |

Remote non-success responses with a usable GraphQL body preserve that body's errors. An aborted signal is checked before in-process execution and again after awaiting the context factory, preventing a cancelled call from starting a mutation. This does not undo or cancel database work that already started. Active remote cancellation rejects during fetch, body reading or a retry backoff. Through `createHTTPMCPHandler`, a call's signal is aborted only when its HTTP connection closes, not by an MCP cancellation notification. Application context factories and middleware may also throw.
