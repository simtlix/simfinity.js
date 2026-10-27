import type { GraphQLField, GraphQLSchema } from 'graphql';
import type { EnvelopSchemaPlugin } from '@simtlix/simfinity-core';

/** Loose JSON Schema fragment (draft 2020-12 keywords as plain properties). */
export type JSONSchema = Record<string, unknown>;

/** MCP behavioral hints attached to every generated tool. */
export interface MCPToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
  [key: string]: unknown;
}

/** Root operation category a tool was generated from. */
export type MCPToolKind = 'query' | 'mutation';

/** A generated MCP tool definition. */
export interface MCPTool {
  /**
   * Published tool name (GraphQL field name, optionally prefixed via
   * `toolNamePrefix`). The read tool of a virtual field is named
   * `<byIdQuery>_<field>`, such as `barbershop_busyRanges`.
   */
  name: string;
  title: string;
  description: string;
  /**
   * JSON Schema for GraphQL arguments, preserving defaults and nullable
   * input/list positions. The arguments object is closed
   * (`additionalProperties: false`), so hosts that validate tool input reject
   * an undeclared key before the call reaches the server (and its
   * middleware); `callTool` rejects an undeclared key the caller sent with
   * MCP_UNKNOWN_ARGUMENT. Date/DateTime/Time scalars keep a string `format`
   * here as a hint for the value to send. Generated tools share one object
   * per input or enum type in their `$defs`, so treat tool definitions as
   * read-only and copy one (e.g. with structuredClone) before changing it.
   */
  inputSchema: JSONSchema;
  /**
   * JSON Schema mirroring the generated selection set (nullable GraphQL
   * positions accept `null`). Omitted when a `toolOverrides` `selection` is
   * set for the tool, since the mirrored schema could no longer be guaranteed
   * accurate. Next to the root field it declares the optional keys MCP adds:
   * `totalCount` on list tools with a `pagination` argument, and `truncated`
   * on mutation tools when `limits.maxResultBytes` is set (`__totalCount` /
   * `__truncated` when the root field itself has that name). A scalar field
   * gets a JSON `type` only when it is a GraphQL spec scalar or a
   * createValidatedScalar chain ending at one; any other scalar (Date,
   * DateTime and Time included, and custom scalars with a `baseScalarType`
   * storage hint) serializes with its own `serialize`, so it is published
   * without a `type` or `format`, with a curated description for date/time
   * scalars that have none.
   */
  outputSchema?: JSONSchema;
  /**
   * Behavioral hints, by operation. Queries are `readOnlyHint: true`.
   * Generated updates are `idempotentHint: true` unless their input can carry
   * collection items to insert (`added`, at any depth), which every repeat
   * inserts again; generated deletes are `destructiveHint: true` and
   * `idempotentHint: true`. Idempotency is about the stored data: a repeat
   * runs middleware and controller hooks again, and a repeated delete calls
   * `onDelete` with `null`. Creates, state-machine transitions and custom
   * mutations get `readOnlyHint: false` only. The transaction tool (see
   * {@link GenerateMCPToolsOptions.transactionTools}) is always
   * `destructiveHint: true` and `idempotentHint: false`. Mutations are
   * recognized by core's `extensions.simfinityMutation` marker or, without it,
   * by the placeholder description plus the matching name prefix, never by
   * name alone. `toolOverrides` annotations are merged over these.
   */
  annotations: MCPToolAnnotations;
  kind: MCPToolKind;
}

/** Retry policy for remote execution (queries only — mutations are never retried). */
export interface MCPRetryOptions {
  /** Number of retries after the initial attempt. */
  attempts?: number;
  /**
   * Linear backoff base in milliseconds (default 250): retry k waits
   * `backoffMs * k`, longer only with `retryAfter` or `jitter`. Client
   * cancellation (`extra.signal`) during a retry wait rejects at once,
   * without another attempt.
   */
  backoffMs?: number;
  /**
   * Opt-in (default false). On a retried HTTP 429 or 5xx response, the next
   * retry waits at least its `Retry-After` (delta-seconds or an HTTP-date).
   * When it asks for more than `maxRetryAfterMs`, the retries end at once
   * with that response's error.
   */
  retryAfter?: boolean;
  /**
   * Longest `Retry-After`, in milliseconds, that a retry waits for when
   * `retryAfter` is true (default 10000, capped at 2147483647). It bounds
   * each wait, not their total.
   */
  maxRetryAfterMs?: number;
  /**
   * Opt-in (default false). Adds a random wait of up to half of
   * `backoffMs * k` to retry k, so concurrent callers spread their retries.
   */
  jitter?: boolean;
}

/** Execute operations in-process against the provided GraphQLSchema (default). */
export interface MCPInProcessExecutionOptions {
  mode?: 'in-process';
}

/** Execute operations by POSTing to a remote GraphQL HTTP endpoint. */
export interface MCPRemoteExecutionOptions {
  mode: 'remote';
  /**
   * GraphQL HTTP endpoint URL, passed to fetch and read on every call.
   * Required in remote mode. A URL with a username or password (send
   * credentials through `headers`) throws MCP_INVALID_EXECUTION_CONFIG at
   * setup, as fetch rejects it on every call. An endpoint fetch cannot
   * request otherwise (relative, unparsable, not http(s)) fails each call
   * with MCP_REMOTE_REQUEST_FAILED. Neither message quotes the URL.
   */
  endpoint: string;
  /**
   * Extra HTTP headers merged over `content-type: application/json`, read on
   * every call (later changes, e.g. a rotated token, apply). Names are
   * case-insensitive: a `Content-Type` in any casing replaces the default
   * instead of being sent next to it. The factories also accept a Headers
   * instance, a Map or [name, value] pairs ({@link MCPRemoteExecutionInit}).
   */
  headers?: Record<string, string>;
  /**
   * Abort each remote attempt, including response-body reading, after this
   * many milliseconds. Fractions round up and values above 2147483647 (the
   * Node.js timer limit) are capped. Unset, 0 and NaN disable the timeout.
   * The factories also accept numeric strings, bigints, `null` and `false`
   * ({@link MCPRemoteExecutionInit}). Infinity, negative and non-numeric
   * values throw MCP_INVALID_EXECUTION_CONFIG at setup.
   */
  timeoutMs?: number;
  /** Retry policy for transport failures, HTTP 5xx and 429 (queries only). */
  retry?: MCPRetryOptions;
}

/**
 * The members of a Fetch `Headers` instance that identify one, declared
 * structurally so these types need neither the DOM lib nor `@types/node`.
 */
export interface MCPHeadersLike {
  get(name: string): string | null;
  has(name: string): boolean;
}

/**
 * Remote header forms the factories accept: a plain object, a Headers
 * instance, a Map or an array of [name, value] pairs. They are read again on
 * every call, so they must be re-readable: one-shot iterators (such as
 * `map.entries()` or a generator), promises and functions throw
 * MCP_INVALID_EXECUTION_CONFIG at setup. Invalid header names or values fail
 * the call with MCP_REMOTE_REQUEST_FAILED, naming the header but not its value.
 */
export type MCPRemoteHeadersInit =
  | Record<string, string>
  | MCPHeadersLike
  | ReadonlyMap<string, string>
  | ReadonlyArray<readonly [string, string]>;

/**
 * Remote execution options as the factories accept them: like
 * {@link MCPRemoteExecutionOptions}, with the wider {@link MCPRemoteHeadersInit}
 * for `headers`, numeric strings (e.g. from environment variables) and
 * bigints for `timeoutMs`, and `null` or `false` (as `cond && value`
 * produces) meaning no extra headers or no timeout. Used only by the factory
 * parameters ({@link GenerateMCPToolsInit}); the option interfaces keep the
 * narrower {@link MCPRemoteExecutionOptions}, so code reading them back is
 * unaffected. An own getter for `headers` or `timeoutMs` is not run at
 * setup, only on every call. An inherited (class) getter or a Proxy is read
 * at setup and its value checked; a read that throws (say, a token that is
 * not loaded yet) leaves the check to each call.
 */
export interface MCPRemoteExecutionInit extends Omit<MCPRemoteExecutionOptions, 'headers' | 'timeoutMs'> {
  headers?: MCPRemoteHeadersInit | null | false;
  timeoutMs?: number | string | bigint | null | false;
}

/** Execution strategy: discriminated on `mode`. */
export type MCPExecutionOptions = MCPInProcessExecutionOptions | MCPRemoteExecutionOptions;

/**
 * Which nested collections the generated selection set and output schema
 * include. A nested collection is an object list field with a `pagination`
 * argument, such as core's non-embedded one-to-many relations, which core
 * reads with one query per returned row, or per batch of rows with an
 * adapter that batches collection reads. 'all' (the default) includes them;
 * 'none' leaves them out.
 */
export type MCPNestedCollections = 'all' | 'none';

/**
 * JSON format of the text content block of tool results: 'pretty' (the
 * default, indented by two spaces) or 'compact' (no whitespace).
 */
export type MCPTextFormat = 'pretty' | 'compact';

/** Per-tool override applied over the generated definition. */
export interface MCPToolOverride {
  description?: string;
  title?: string;
  /** Merged over the generated annotations. */
  annotations?: MCPToolAnnotations;
  /**
   * Overrides {@link GenerateMCPToolsOptions.selectionDepth} for this tool.
   * The transaction tool (see {@link GenerateMCPToolsOptions.transactionTools})
   * ignores it: each of its operations is selected with the depth of that
   * operation's own tool, and the result list takes no level.
   */
  selectionDepth?: number;
  /**
   * Overrides {@link GenerateMCPToolsOptions.nestedCollections} for this tool;
   * ignored when `selection` is set. Validated (MCP_INVALID_OPTIONS) for
   * every entry, whether or not its tool is published. The transaction tool
   * ignores it, as it ignores `selectionDepth`: each operation uses the value
   * of its own tool.
   */
  nestedCollections?: MCPNestedCollections;
  /**
   * @deprecated Ignored. It never changed the generated selection: every
   * scalar/enum field without required arguments, `id` included, is selected.
   */
  includeId?: boolean;
  /**
   * Explicit GraphQL selection set replacing the generated one. Accepts
   * `'id title'` or `'{ id title }'`. Setting it omits the tool's
   * `outputSchema` and ignores `nestedCollections`. On the transaction tool
   * it replaces the selection of its result list, whose items are then
   * returned as selected instead of reduced to `id` and their own operation
   * key. The `selection` of an operation's own tool is not reused inside the
   * transaction tool, so fields it hides still appear in the transaction
   * result: hide them with field authorization instead.
   */
  selection?: string;
}

/**
 * Guardrails applied by `callTool`. Validated at setup (MCP_INVALID_LIMITS)
 * and read again on every call, so later changes to the object apply. A cap
 * must be a number of at least 1, and 0 or NaN leaves it unset (NaN with a
 * warning at setup). The factories also accept the wider {@link MCPLimitsInit}.
 */
export interface MCPLimits {
  /** Reject (isError MCP_PAGE_SIZE_EXCEEDED) when `args.pagination.size` exceeds this. */
  maxPageSize?: number;
  /**
   * Injected as `args.pagination` when the tool has a pagination arg and the
   * caller sent none. Validated at setup against the `pagination` argument
   * type of every published tool: for Simfinity's QLPagination, `page` and
   * `size` are required positive integers and no other key than `count` is
   * allowed; custom pagination types are checked against their own GraphQL
   * type. `size` must not exceed `maxPageSize`. Core's own page-size cap
   * (`configureQueryLimits`) is not checked.
   */
  defaultPagination?: {
    page: number;
    size: number;
    count?: boolean;
    [key: string]: unknown;
  };
  /**
   * Cap the UTF-8 text content block (pretty-printed JSON, or compact JSON
   * with `textFormat: 'compact'`) of data (including `totalCount`) or
   * { errors, data? } with MCP_RESULT_TOO_LARGE; for a counted list that error
   * carries `extensions.totalCount`. Checking occurs after execution, so an
   * oversized mutation result is not an error when the mutation succeeded: it
   * is replaced by a `truncated` notice (`isError: false`,
   * `_meta.truncated`) and the root id(s), which are kept only when they fit
   * within the cap; a transaction tool keeps
   * `[{ id, <operationKey>: { id, version? } | null }]`, where `id` is null
   * for a delete of a missing record, and its notice says that the
   * operations are applied all together or not at all, never in part. The
   * notice reports the cap rounded down to whole bytes.
   * With GraphQL errors it stays MCP_RESULT_TOO_LARGE with
   * `extensions.applied` (`true`, or `'unknown'` when no root value came
   * back), `extensions.firstError` and the ids in `data` when present.
   * Limit diagnostics (including that notice and MCP_UNKNOWN_ARGUMENT), MCP
   * envelope overhead, duplicate structuredContent and middleware-created
   * results are exempt.
   */
  maxResultBytes?: number;
}

/**
 * `limits` as the factories accept it: like {@link MCPLimits}, plus the
 * forms configuration code often produces. A falsy value (`false`, `null`,
 * `0`, `''`, as `cond && 100` produces) leaves a cap or the default page
 * unset. Numeric strings (e.g. from environment variables, `'Infinity'`
 * included) and bigints are converted with Number(). Numbers below 1,
 * `true`, blank strings, strings that are not numeric or coerce to a number
 * below 1, and objects throw MCP_INVALID_LIMITS. Used only by the factory parameters
 * ({@link GenerateMCPToolsInit}); the option interfaces keep the narrower
 * {@link MCPLimits}, so code reading them back is unaffected.
 */
export interface MCPLimitsInit {
  /** {@link MCPLimits.maxPageSize}. */
  maxPageSize?: number | string | bigint | null | false;
  /** {@link MCPLimits.defaultPagination}. */
  defaultPagination?: MCPLimits['defaultPagination'] | null | false;
  /** {@link MCPLimits.maxResultBytes}. */
  maxResultBytes?: number | string | bigint | null | false;
}

/** Per-call metadata passed through to middleware and context factories (e.g. the SDK's RequestHandlerExtra). */
export interface MCPCallExtra {
  /**
   * Aborted signals prevent execution, including after awaiting the context.
   * Remote fetch, body reading and retry backoff receive the signal: an abort
   * rejects the call at once, without retrying. Already-started database work
   * is not undone. With the stateless {@link createHTTPMCPHandler}, only a
   * closed HTTP connection aborts it: an MCP `notifications/cancelled` is a
   * separate request, served by another server instance, so it cannot reach
   * the call.
   */
  signal?: AbortSignal;
  [key: string]: unknown;
}

/** The mutable call descriptor handed to each tool middleware. */
export interface MCPToolMiddlewareCall {
  /**
   * Published (prefixed) tool name. A gate by name sees the transaction
   * tool's name only, never the operations it runs, which are in
   * `args.operations`.
   */
  name: string;
  /**
   * Tool arguments; middleware may mutate or replace this. An undeclared key
   * the caller sent that is still here when the chain reaches execution is
   * rejected (MCP_UNKNOWN_ARGUMENT, nothing executed), so middleware that
   * reads such a key must delete it before `next()`. Keys middleware adds are
   * passed through. Hosts that validate input against the closed
   * `inputSchema` reject undeclared keys before they reach middleware.
   */
  args: Record<string, unknown>;
  /** Per-call metadata (may be undefined for direct `callTool` invocations). */
  extra: MCPCallExtra | undefined;
  kind: MCPToolKind;
  /** The prebuilt GraphQL operation document for this tool. */
  operation: string;
}

/** Result of a tool call (MCP CallToolResult shape). */
export interface CallToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError: boolean;
  /**
   * Present on success when the GraphQL `data` is non-null; absent on errors.
   * Holds the GraphQL `data` plus the keys MCP adds next to the root field:
   * `totalCount` on counted list calls, or, for an oversized mutation result,
   * only the root id(s) and a `truncated` notice (`__totalCount` /
   * `__truncated` when the root field itself has that name).
   */
  structuredContent?: Record<string, unknown>;
  /**
   * `count`: the total record count when one is available (pagination.count /
   * remote extensions.count). `truncated`: set when an oversized mutation
   * result was replaced by its id(s) and a notice.
   */
  _meta?: { count?: number; truncated?: boolean };
}

/**
 * Koa-style middleware run around every tool execution. May mutate
 * `call.args` (see {@link MCPToolMiddlewareCall.args} for undeclared keys),
 * short-circuit by returning a result without calling `next()`, or throw.
 * Middleware may be synchronous: if it throws, the previous middleware's
 * `next()` promise rejects, as with an async one, so use
 * `try { return await next(); } catch { ... }` or `next().catch(...)` to
 * handle it. A middleware may await other work before awaiting `next()`; a
 * rejection of a `next()` promise that no middleware awaits or returns is
 * dropped. Calling `next()` twice rejects with MCP_MIDDLEWARE_ERROR. Every
 * function runs regardless of its declared parameter count.
 */
export type MCPToolMiddleware = (
  call: MCPToolMiddlewareCall,
  next: () => Promise<CallToolResult>,
) => CallToolResult | Promise<CallToolResult>;

/** GraphQL context factory for in-process / stdio execution. */
export type MCPContextFactory = (extra?: MCPCallExtra) => unknown;

/** GraphQL context factory for the HTTP handler (invoked per request with the Express request). */
export type MCPHTTPContextFactory = (req: any, extra?: MCPCallExtra) => unknown;

// The Envelop-style plugin type is the declaration of @simtlix/simfinity-core, re-exported rather
// than declared again, so `export *` of this package together with the core root, `/auth`,
// `/plugins` or a database package exports one `EnvelopSchemaPlugin`. How MCP applies it is
// described on `GenerateMCPToolsOptions.schemaPlugins`.
export type { EnvelopSchemaPlugin };

/**
 * Any other plugin object accepted by `schemaPlugins`, such as an Envelop or
 * Yoga `Plugin` or a class instance (interfaces and classes have no index
 * signature, so they do not match {@link EnvelopSchemaPlugin}), including
 * ones with `call` or `apply` members. Entries are validated at runtime.
 * Functions (pass the plugin factory's result, not the factory) and promises
 * are excluded through members that plugin objects do not have:
 * `Symbol.hasInstance` (from the ES2015 `lib`) and `then`.
 */
export type SchemaPluginObject = object & { [Symbol.hasInstance]?: never; then?: never };

/** Options for {@link generateMCPTools}. All optional; defaults preserve previous behavior. */
export interface GenerateMCPToolsOptions {
  /**
   * Execution strategy. Defaults to in-process execution against the schema.
   * The remote `endpoint` (for credentials only), `headers` and `timeoutMs`
   * are checked at setup (MCP_INVALID_EXECUTION_CONFIG) and read again on
   * every call, so later changes apply. The factories also accept
   * {@link MCPRemoteExecutionInit}.
   */
  execution?: MCPExecutionOptions | null;
  /**
   * GraphQL context value or factory. In-process / stdio: `(extra) => ctx`
   * ({@link MCPContextFactory}); the HTTP handler invokes a function context as
   * `(req, extra) => ctx` per request ({@link MCPHTTPContextFactory}).
   */
  context?: unknown;
  /**
   * Only expose these tool/field names or the categories 'query' / 'mutation'.
   * A virtual field tool matches its own name (`<byIdQuery>_<field>`, with or
   * without the prefix) and 'query', not its by-ID query's name.
   */
  include?: string | string[];
  /** Never expose these tool/field names or categories. Wins over `include`. */
  exclude?: string | string[];
  /**
   * Only expose tools whose entity (return) type has one of these names. A
   * virtual field tool's entity type is the type that declares the field. The
   * transaction tool has no entity type: it needs every type its operations
   * write in this list (see `transactionTools`).
   */
  includeTypes?: string | string[];
  /**
   * Never expose tools whose entity (return) type has one of these names, nor
   * the transaction tool when one of the types its operations write is here.
   */
  excludeTypes?: string | string[];
  /**
   * Nesting depth for the auto-generated selection set and output schema.
   * Default 1. Each nested collection it reaches is read with one query per
   * returned row, or per batch of rows with an adapter that batches
   * collection reads; see `nestedCollections`. A virtual field tool counts
   * it from the field's result, as a root field's tool does from its own.
   */
  selectionDepth?: number;
  /**
   * 'none' leaves nested collections out of every generated selection set
   * and output schema (see {@link MCPNestedCollections}); a tool's
   * `toolOverrides` value wins. Default 'all'. Other values throw
   * MCP_INVALID_OPTIONS at setup.
   */
  nestedCollections?: MCPNestedCollections;
  /**
   * JSON format of the text content block of results, which
   * `limits.maxResultBytes` measures. Default 'pretty'. Other values throw
   * MCP_INVALID_OPTIONS at setup.
   */
  textFormat?: MCPTextFormat;
  /**
   * Publish the schema's generated transaction field (core's `transaction`
   * schema option) as one multi-write tool. Unset, `null` or `false` (the
   * default): neither that field nor any mutation shaped like it (core's
   * `extensions.simfinityTransaction`, the description's marker sentence, or
   * a single `operations: [X!]!` argument each of whose fields matches a
   * mutation root of the same schema by name and input type, a generated
   * root or any root of that name; also when some or all of those roots are
   * missing, as long as X has at least one field, every field of X named
   * after a remaining root matches it, and the field returns a list of an
   * object type with a field named after each field of X) is ever published,
   * not even as a custom tool.
   * `true`: the field is published when its marker description, its
   * structure and its `@oneOf` operation type are all present (rebuild a
   * schema from `getIntrospectionQuery({ oneOf: true })` with descriptions),
   * `include`/`exclude` accept it by its own name or 'mutation', `exclude`
   * names none of its operation keys, and every type its operations write
   * (their own types and nested collection targets) passes
   * `includeTypes`/`excludeTypes`; a field shaped like one that is not
   * recognized is omitted with a one-time warning. Each operation is
   * selected with the `selectionDepth` and `nestedCollections` of its own
   * tool and, below the result list, only the virtual fields with
   * `mcp: 'select'`; each result item keeps only `id` and its own operation
   * key, unless the tool has an explicit `selection`. Other values throw
   * MCP_INVALID_OPTIONS at setup.
   */
  transactionTools?: boolean | null;
  /**
   * @deprecated Ignored. It never changed the generated selection: every
   * scalar/enum field without required arguments, `id` included, is selected,
   * and an object type with none selects `__typename`.
   */
  includeId?: boolean;
  /** Prefix prepended to every published tool name (validated /^[a-zA-Z0-9_-]+$/). */
  toolNamePrefix?: string;
  /**
   * Per-tool overrides keyed by published tool name or unprefixed field name
   * (`<byIdQuery>_<field>` for a virtual field tool). An override's
   * `selection` replaces a virtual field tool's selection of the field.
   */
  toolOverrides?: Record<string, MCPToolOverride>;
  /**
   * Koa-style middleware run around every tool execution. A single function is
   * a one-element stack. Validated at setup (MCP_INVALID_MIDDLEWARE for a
   * non-array, a non-function entry or an empty slot in a sparse array) and
   * copied: later changes to the array have no effect. Middleware that gates
   * tools by name sees only the transaction tool's name (see
   * `transactionTools`); its operations are in `call.args.operations`.
   */
  toolMiddleware?: MCPToolMiddleware | MCPToolMiddleware[];
  /**
   * Pagination / result-size guardrails. The factories also accept
   * {@link MCPLimitsInit}, and a falsy value meaning none.
   */
  limits?: MCPLimits;
  /**
   * Envelop-style plugins whose `onSchemaChange` hook is applied before serving
   * (in-process mode only; remote mode neither validates nor applies them).
   * Every entry is validated before any hook runs: falsy entries are skipped;
   * a non-array, a function (pass the factory's result), an array, a promise,
   * a non-function `onSchemaChange`, an object with no plugin hooks, or one
   * without `onSchemaChange` that declares a misspelling of it (a method or
   * getter whose name starts with `onSchema`, or is at most two edits away
   * from `onSchemaChange`, ignoring case, such as `onSchemaChanged` or
   * `onSchemChange`) throws MCP_INVALID_SCHEMA_PLUGIN. Validation does not
   * invoke getters other than `onSchemaChange`. Only `onSchemaChange` is
   * invoked, once before serving; other recognized hooks (`on*`,
   * `instrumentation`, `requestDidStart`, `serverWillStart`) are ignored with
   * a one-time warning. The hook's `replaceSchema` is a no-op for the same
   * schema; any other schema throws MCP_UNSUPPORTED_SCHEMA_REPLACEMENT.
   * Asynchronous hooks are awaited by the server and HTTP factories;
   * `generateMCPTools` calls wait for them and reject if one fails. Envelop
   * and Yoga do not await them, so plugins shared with them should install
   * synchronously.
   */
  schemaPlugins?: Array<EnvelopSchemaPlugin | SchemaPluginObject | false | null | undefined>;
}

/** Options for the MCP server / transport factories. */
export interface MCPServerOptions extends GenerateMCPToolsOptions {
  /** MCP server name (default 'simfinity-mcp'). */
  serverName?: string;
  /** MCP server version (default '1.0.0'). */
  serverVersion?: string;
}

/** Extra options accepted by {@link createHTTPMCPHandler}. */
export interface HTTPMCPHandlerOptions extends MCPServerOptions {
  /** Stateless SDK options; stateful settings raise MCP_INVALID_TRANSPORT_OPTIONS at setup. */
  transportOptions?: Record<string, unknown> & {
    sessionIdGenerator?: never;
    onsessioninitialized?: never;
    onsessionclosed?: never;
    eventStore?: never;
  };
  /** Invoked when the handler fails; the handler then responds 500 (JSON-RPC internal error) if headers were not sent. */
  onError?: (err: unknown, req: any, res: any) => void;
}

/**
 * The `execution` and `limits` forms the factories accept, wider than the
 * option interfaces declare.
 */
export interface MCPOptionsInit {
  /**
   * {@link GenerateMCPToolsOptions.execution}, also accepting the remote
   * forms of {@link MCPRemoteExecutionInit}.
   */
  execution?: MCPExecutionOptions | MCPRemoteExecutionInit | null;
  /** {@link GenerateMCPToolsOptions.limits} as {@link MCPLimitsInit}; a falsy value means none. */
  limits?: MCPLimitsInit | null | false;
}

/**
 * Options parameter of {@link generateMCPTools}: {@link GenerateMCPToolsOptions}
 * with the wider {@link MCPOptionsInit} forms. Every GenerateMCPToolsOptions
 * value is accepted; declare variables you read back with the option
 * interface.
 */
export interface GenerateMCPToolsInit extends Omit<GenerateMCPToolsOptions, keyof MCPOptionsInit>, MCPOptionsInit {}

/** Options parameter of {@link createMCPServer} and {@link startStdioMCPServer}: {@link MCPServerOptions} with the wider {@link MCPOptionsInit} forms. */
export interface MCPServerInit extends Omit<MCPServerOptions, keyof MCPOptionsInit>, MCPOptionsInit {}

/** Options parameter of {@link createHTTPMCPHandler}: {@link HTTPMCPHandlerOptions} with the wider {@link MCPOptionsInit} forms. */
export interface HTTPMCPHandlerInit extends Omit<HTTPMCPHandlerOptions, keyof MCPOptionsInit>, MCPOptionsInit {}

/** Result of {@link generateMCPTools}. */
export interface GeneratedMCPTools {
  tools: MCPTool[];
  /**
   * Execute a tool by its published name. Returns a {@link CallToolResult}
   * (GraphQL errors become `isError` results). Throws SimfinityError
   * MCP_TOOL_NOT_FOUND for unknown names and MCP_CALL_CANCELLED when
   * `extra.signal` is aborted before execution, including while awaiting context.
   * Waits for asynchronous `schemaPlugins` hooks and rejects with their error if
   * one failed.
   */
  callTool: (
    name: string,
    args?: Record<string, unknown>,
    extra?: MCPCallExtra,
  ) => Promise<CallToolResult>;
  /** Return the prebuilt GraphQL operation document for a tool; throws MCP_TOOL_NOT_FOUND for unknown names. */
  getOperation: (name: string) => string;
}

/**
 * An MCP SDK Server instance (call `server.connect(transport)`). Typed loosely
 * to avoid a hard dependency on the optional `@modelcontextprotocol/sdk`.
 */
export type MCPServer = any;

/** Express-style request handler serving the MCP over Streamable HTTP. */
export type HTTPMCPRequestHandler = (req: any, res: any) => Promise<void>;

/**
 * Generate MCP tool definitions and an executor from a Simfinity-generated
 * GraphQLSchema. Every root Query and Mutation field becomes a tool. So does
 * each virtual field (`extensions.virtual`) with a required argument that has
 * no default, on a type with a by-ID query, unless its `mcp` option is false:
 * a read-only tool named `<byIdQuery>_<field>` that takes the record's `id`
 * and the field's arguments and comes after the root field tools. A
 * duplicate name skips it with a warning, and a field argument named `id`
 * throws SimfinityError MCP_INVALID_OPTIONS when the tool is published. Below
 * any list position (the items of a root field that returns a list, of a
 * nested collection or embedded list, or of a list-valued per-field tool's
 * result), tools select only the virtual fields whose `mcp` option is 'select'.
 */
export function generateMCPTools(
  schema: GraphQLSchema,
  options?: GenerateMCPToolsInit,
): GeneratedMCPTools;

/**
 * Build the MCP `inputSchema` (JSON Schema) for a single GraphQL field's
 * arguments. The arguments object is closed (`additionalProperties: false`).
 * An input object that is `@oneOf` (`isOneOf`, which a schema rebuilt from
 * introspection keeps only when it requested `oneOf: true`) becomes an object
 * with exactly one property, whose value is not null (`minProperties` and
 * `maxProperties` 1, `additionalProperties: false`, no `required`); earlier
 * releases described it as an object whose properties were all optional.
 */
export function graphqlArgsToJSONSchema(field: GraphQLField<any, any>): JSONSchema;

/**
 * Create a transport-agnostic MCP Server exposing every GraphQL operation as a
 * tool. Requires the optional `@modelcontextprotocol/sdk` dependency (throws
 * SimfinityError MCP_SDK_NOT_INSTALLED / MCP_SDK_INCOMPATIBLE / MCP_SDK_LOAD_FAILED;
 * MCP_SDK_INCOMPATIBLE also covers SDK modules that lack the expected exports).
 * The SDK loads before the options are validated and `schemaPlugins` run.
 * Resolves after asynchronous `schemaPlugins` hooks finish, and rejects if one fails.
 */
export function createMCPServer(
  schema: GraphQLSchema,
  options?: MCPServerInit,
): Promise<MCPServer>;

/**
 * Create an MCP Server and connect it over stdio (for a standalone MCP
 * executable). The SDK and its stdio transport load before the options are
 * validated and `schemaPlugins` run, so an SDK error (MCP_SDK_NOT_INSTALLED /
 * MCP_SDK_INCOMPATIBLE / MCP_SDK_LOAD_FAILED) leaves the schema untouched.
 */
export function startStdioMCPServer(
  schema: GraphQLSchema,
  options?: MCPServerInit,
): Promise<MCPServer>;

/**
 * Create an Express-style request handler serving the MCP over Streamable
 * HTTP; mount it for every method (e.g. `app.all`). Tool definitions are
 * built once; a fresh server + transport pair is created per POST request,
 * and a function `context` is invoked `(req, extra)` per request. Other methods
 * (GET, DELETE, ...) get 405 with `Allow: POST` and a JSON-RPC error, without
 * invoking `context` or `onError`: the handler is stateless, so there is no
 * standalone SSE stream and no session to terminate (MCP clients treat a 405
 * on GET as no server stream). The SDK and its transport load first; then
 * `transportOptions`, `execution`, `toolMiddleware`, `limits`, `textFormat`,
 * `nestedCollections`, `transactionTools` and `schemaPlugins` are validated, and asynchronous `schemaPlugins` hooks
 * awaited, before the handler is returned; `options.limits` is read again
 * for every request and call.
 */
export function createHTTPMCPHandler(
  schema: GraphQLSchema,
  options?: HTTPMCPHandlerInit,
): Promise<HTTPMCPRequestHandler>;


declare const mcp: {
  generateMCPTools: typeof generateMCPTools;
  graphqlArgsToJSONSchema: typeof graphqlArgsToJSONSchema;
  createMCPServer: typeof createMCPServer;
  startStdioMCPServer: typeof startStdioMCPServer;
  createHTTPMCPHandler: typeof createHTTPMCPHandler;
};

export default mcp;
