import type { GraphQLField, GraphQLSchema } from 'graphql';

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
  /** Published tool name (GraphQL field name, optionally prefixed via `toolNamePrefix`). */
  name: string;
  title: string;
  description: string;
  /** JSON Schema for GraphQL arguments, preserving defaults and nullable input/list positions. */
  inputSchema: JSONSchema;
  /**
   * JSON Schema mirroring the generated selection set (nullable GraphQL
   * positions accept `null`). Omitted when a `toolOverrides` `selection` is
   * set for the tool, since the mirrored schema could no longer be guaranteed
   * accurate.
   */
  outputSchema?: JSONSchema;
  annotations: MCPToolAnnotations;
  kind: MCPToolKind;
}

/** Retry policy for remote execution (queries only — mutations are never retried). */
export interface MCPRetryOptions {
  /** Number of retries after the initial attempt. */
  attempts?: number;
  /** Linear backoff base in milliseconds (delay = backoffMs * attemptIndex). */
  backoffMs?: number;
}

/** Execute operations in-process against the provided GraphQLSchema (default). */
export interface MCPInProcessExecutionOptions {
  mode?: 'in-process';
}

/** Execute operations by POSTing to a remote GraphQL HTTP endpoint. */
export interface MCPRemoteExecutionOptions {
  mode: 'remote';
  /** GraphQL HTTP endpoint URL. Required in remote mode. */
  endpoint: string;
  /** Extra HTTP headers merged over `content-type: application/json`. */
  headers?: Record<string, string>;
  /** Abort each remote attempt, including response-body reading, after this many milliseconds. */
  timeoutMs?: number;
  /** Retry policy for transport failures, HTTP 5xx and 429 (queries only). */
  retry?: MCPRetryOptions;
}

/** Execution strategy: discriminated on `mode`. */
export type MCPExecutionOptions = MCPInProcessExecutionOptions | MCPRemoteExecutionOptions;

/** Per-tool override applied over the generated definition. */
export interface MCPToolOverride {
  description?: string;
  title?: string;
  /** Merged over the generated annotations. */
  annotations?: MCPToolAnnotations;
  selectionDepth?: number;
  includeId?: boolean;
  /**
   * Explicit GraphQL selection set replacing the generated one. Accepts
   * `'id title'` or `'{ id title }'`. Setting it omits the tool's
   * `outputSchema`.
   */
  selection?: string;
}

/** Guardrails applied by `callTool`. */
export interface MCPLimits {
  /** Reject (isError MCP_PAGE_SIZE_EXCEEDED) when `args.pagination.size` exceeds this. */
  maxPageSize?: number;
  /**
   * Injected as `args.pagination` when the tool has a pagination arg and the
   * caller sent none. QLPagination declares `page` and `size` non-null, so
   * both are required here; `size` must not exceed `maxPageSize` (validated
   * at setup, MCP_INVALID_LIMITS).
   */
  defaultPagination?: {
    page: number;
    size: number;
    count?: boolean;
    [key: string]: unknown;
  };
  /**
   * Cap pretty-printed UTF-8 JSON for data or { errors, data? } with MCP_RESULT_TOO_LARGE.
   * Limit diagnostics, MCP envelope overhead, duplicate structuredContent and
   * middleware-created results are exempt. Checking occurs after execution.
   */
  maxResultBytes?: number;
}

/** Per-call metadata passed through to middleware and context factories (e.g. the SDK's RequestHandlerExtra). */
export interface MCPCallExtra {
  /**
   * Aborted signals prevent execution, including after awaiting the context.
   * Remote fetch/body reading receives the signal. Already-started database work is not undone.
   */
  signal?: AbortSignal;
  [key: string]: unknown;
}

/** The mutable call descriptor handed to each tool middleware. */
export interface MCPToolMiddlewareCall {
  /** Published (prefixed) tool name. */
  name: string;
  /** Tool arguments; middleware may mutate or replace this. */
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
  /** Present on success when the GraphQL `data` is non-null; absent on errors. */
  structuredContent?: Record<string, unknown>;
  /** Present when a total record count is available (pagination.count / remote extensions.count). */
  _meta?: { count?: number };
}

/**
 * Koa-style middleware run around every tool execution. May mutate
 * `call.args`, short-circuit by returning a result without calling `next()`,
 * or throw. Calling `next()` twice rejects with MCP_MIDDLEWARE_ERROR.
 */
export type MCPToolMiddleware = (
  call: MCPToolMiddlewareCall,
  next: () => Promise<CallToolResult>,
) => CallToolResult | Promise<CallToolResult>;

/** GraphQL context factory for in-process / stdio execution. */
export type MCPContextFactory = (extra?: MCPCallExtra) => unknown;

/** GraphQL context factory for the HTTP handler (invoked per request with the Express request). */
export type MCPHTTPContextFactory = (req: any, extra?: MCPCallExtra) => unknown;

/** Envelop-style plugin; only the `onSchemaChange` hook is invoked (in-process mode, once before serving). */
export interface EnvelopSchemaPlugin {
  onSchemaChange?: (payload: {
    schema: GraphQLSchema;
    replaceSchema: (schema: GraphQLSchema) => void;
  }) => void;
  [key: string]: unknown;
}

/** Options for {@link generateMCPTools}. All optional; defaults preserve previous behavior. */
export interface GenerateMCPToolsOptions {
  /** Execution strategy. Defaults to in-process execution against the schema. */
  execution?: MCPExecutionOptions | null;
  /**
   * GraphQL context value or factory. In-process / stdio: `(extra) => ctx`
   * ({@link MCPContextFactory}); the HTTP handler invokes a function context as
   * `(req, extra) => ctx` per request ({@link MCPHTTPContextFactory}).
   */
  context?: unknown;
  /** Only expose these tool/field names or the categories 'query' / 'mutation'. */
  include?: string | string[];
  /** Never expose these tool/field names or categories. Wins over `include`. */
  exclude?: string | string[];
  /** Only expose tools whose entity (return) type has one of these names. */
  includeTypes?: string | string[];
  /** Never expose tools whose entity (return) type has one of these names. */
  excludeTypes?: string | string[];
  /** Nesting depth for the auto-generated selection set and output schema. Default 1. */
  selectionDepth?: number;
  /** Select a scalar/enum `id` as a fallback; otherwise use __typename. Default true. */
  includeId?: boolean;
  /** Prefix prepended to every published tool name (validated /^[a-zA-Z0-9_-]+$/). */
  toolNamePrefix?: string;
  /** Per-tool overrides keyed by published tool name or unprefixed field name. */
  toolOverrides?: Record<string, MCPToolOverride>;
  /** Koa-style middleware run around every tool execution. */
  toolMiddleware?: MCPToolMiddleware[];
  /** Pagination / result-size guardrails. */
  limits?: MCPLimits;
  /** Envelop-style plugins whose `onSchemaChange` hook is applied before serving (in-process mode only). */
  schemaPlugins?: EnvelopSchemaPlugin[];
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

/** Result of {@link generateMCPTools}. */
export interface GeneratedMCPTools {
  tools: MCPTool[];
  /**
   * Execute a tool by its published name. Returns a {@link CallToolResult}
   * (GraphQL errors become `isError` results). Throws SimfinityError
   * MCP_TOOL_NOT_FOUND for unknown names and MCP_CALL_CANCELLED when
   * `extra.signal` is aborted before execution, including while awaiting context.
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
 * GraphQLSchema. Every root Query and Mutation field becomes a tool.
 */
export function generateMCPTools(
  schema: GraphQLSchema,
  options?: GenerateMCPToolsOptions,
): GeneratedMCPTools;

/** Build the MCP `inputSchema` (JSON Schema) for a single GraphQL field's arguments. */
export function graphqlArgsToJSONSchema(field: GraphQLField<any, any>): JSONSchema;

/**
 * Create a transport-agnostic MCP Server exposing every GraphQL operation as a
 * tool. Requires the optional `@modelcontextprotocol/sdk` dependency (throws
 * SimfinityError MCP_SDK_NOT_INSTALLED / MCP_SDK_INCOMPATIBLE / MCP_SDK_LOAD_FAILED).
 */
export function createMCPServer(
  schema: GraphQLSchema,
  options?: MCPServerOptions,
): Promise<MCPServer>;

/** Create an MCP Server and connect it over stdio (for a standalone MCP executable). */
export function startStdioMCPServer(
  schema: GraphQLSchema,
  options?: MCPServerOptions,
): Promise<MCPServer>;

/**
 * Create an Express-style request handler serving the MCP over Streamable
 * HTTP. Tool definitions are built once; a fresh server + transport pair is
 * created per request, and a function `context` is invoked `(req, extra)` per
 * request.
 */
export function createHTTPMCPHandler(
  schema: GraphQLSchema,
  options?: HTTPMCPHandlerOptions,
): Promise<HTTPMCPRequestHandler>;


declare const mcp: {
  generateMCPTools: typeof generateMCPTools;
  graphqlArgsToJSONSchema: typeof graphqlArgsToJSONSchema;
  createMCPServer: typeof createMCPServer;
  startStdioMCPServer: typeof startStdioMCPServer;
  createHTTPMCPHandler: typeof createHTTPMCPHandler;
};

export default mcp;

