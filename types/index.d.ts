/**
 * Type declarations for @simtlix/simfinity-js.
 *
 * Mirrors the public API of src/index.js (which re-exports the MCP surface of
 * src/mcp.js). Mongoose and @modelcontextprotocol/sdk values are deliberately
 * typed loosely (`any`) so this package does not hard-depend on either
 * optional dependency's type definitions.
 */

import type {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLInputObjectType,
  GraphQLOutputType,
  GraphQLScalarType,
  GraphQLField,
} from 'graphql';

/* ========================================================================== *
 * Errors
 * ========================================================================== */

/** Base error type: carries a code, an HTTP-like status and a timestamp in `extensions`. */
export class SimfinityError extends Error {
  constructor(message: string, code?: string, status?: number);
  extensions: {
    code: string | undefined;
    status: number | undefined;
    timestamp: string;
  };
  getCode(): string | undefined;
  getStatus(): number | undefined;
  getTimestamp(): string;
}

/** Wrapper for unexpected errors; code is always 'INTERNAL_SERVER_ERROR'. */
export class InternalServerError extends SimfinityError {
  constructor(message: string, cause?: unknown);
  cause?: unknown;
  getCause(): unknown;
}

/* ========================================================================== *
 * MCP surface (src/mcp.js)
 * ========================================================================== */

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
  /** JSON Schema for the tool arguments (full-fidelity conversion of the GraphQL args). */
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
  /** Abort slow remote requests after this many milliseconds (AbortSignal.timeout). */
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
  /** Reject (isError MCP_RESULT_TOO_LARGE) when the serialized data is larger than this. */
  maxResultBytes?: number;
}

/** Per-call metadata passed through to middleware and context factories (e.g. the SDK's RequestHandlerExtra). */
export interface MCPCallExtra {
  /** Already-aborted signals make `callTool` throw MCP_CALL_CANCELLED; remote fetches receive the combined signal. */
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
  /** Always select `id` when nothing else is selectable on an object type. Default true. */
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
  /** Spread into the SDK's StreamableHTTPServerTransport options (e.g. enableDnsRebindingProtection, allowedHosts, allowedOrigins). */
  transportOptions?: Record<string, unknown>;
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
   * `extra.signal` is already aborted.
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

/** Namespace object bundling the MCP surface (default export of src/mcp.js). */
export const mcp: {
  generateMCPTools: typeof generateMCPTools;
  graphqlArgsToJSONSchema: typeof graphqlArgsToJSONSchema;
  createMCPServer: typeof createMCPServer;
  startStdioMCPServer: typeof startStdioMCPServer;
  createHTTPMCPHandler: typeof createHTTPMCPHandler;
};

/* ========================================================================== *
 * Core schema-building API (src/index.js)
 * ========================================================================== */

/** Lifecycle hooks invoked around create / update / delete of an entity. */
export interface EntityController {
  onSaving?(doc: any, args: any, session: any, context: any): void | Promise<void>;
  onSaved?(result: any, args: any, session: any, context: any): void | Promise<void>;
  onUpdating?(id: any, args: any, session: any, context: any): void | Promise<void>;
  onUpdated?(result: any, session: any, context: any): void | Promise<void>;
  onDelete?(doc: any, session: any, context: any): void | Promise<void>;
}

/** State machine attached to an entity (initial state plus named action transitions). */
export interface StateMachine {
  initialState: any;
  actions: Record<string, any>;
  [key: string]: any;
}

/** Register a Mongoose model + GraphQL type pair, exposing single and list endpoints. */
export function connect(
  model: any,
  gqltype: GraphQLObjectType,
  simpleEntityEndpointName: string,
  listEntitiesEndpointName: string,
  controller?: EntityController | null,
  onModelCreated?: ((model: any) => void) | null,
  stateMachine?: StateMachine | null,
): void;

/** Register a GraphQL type without exposing root endpoints (e.g. embedded/related types). */
export function addNoEndpointType(gqltype: GraphQLObjectType): void;

/**
 * Build the executable GraphQLSchema from every connected type. The first two
 * allowlists are matched against the GraphQLObjectType INSTANCES passed to
 * connect(); only custom mutations are matched by name.
 */
export function createSchema(
  includedQueryTypes?: GraphQLObjectType[] | null,
  includedMutationTypes?: GraphQLObjectType[] | null,
  includedCustomMutations?: string[] | null,
): GraphQLSchema;

/** Register a custom mutation executed inside a transaction. */
export function registerMutation(
  name: string,
  description: string,
  inputModel: GraphQLInputObjectType | null | undefined,
  outputModel: GraphQLOutputType,
  callback: (input: any, session: any, context: any) => any,
): void;

/** Operation context passed to Simfinity middlewares registered via {@link use}. */
export interface SimfinityMiddlewareContext {
  args: any;
  operation: string;
  entry?: string;
  type?: any;
  context?: any;
  [key: string]: any;
}

/** Register a koa-style middleware run around every Simfinity operation. */
export function use(
  middleware: (
    context: SimfinityMiddlewareContext,
    next: () => Promise<void>,
  ) => void | Promise<void>,
): void;

/** Build a GraphQL error formatter that normalizes unexpected errors to {@link InternalServerError}. */
export function buildErrorFormatter(
  callback?: (error: SimfinityError) => Error | void,
): (err: Error) => Error;

/** Globally prevent Mongoose collection creation for generated models. */
export function preventCreatingCollection(prevent: boolean): void;

/** Get the generated GraphQL input type registered for an object type. */
export function getInputType(type: GraphQLObjectType | { name: string }): GraphQLInputObjectType;

/** Persist an object of a connected type inside a transaction (runs controllers/validators). */
export function saveObject(
  typeName: string,
  args: Record<string, any>,
  session?: any,
  context?: any,
): Promise<any>;

/** Get the Mongoose model registered for a connected GraphQL type. */
export function getModel(gqltype: GraphQLObjectType | { name: string }): any;

/** Look up a connected GraphQL type by name (or by another type's name). */
export function getType(
  typeName: string | { name: string },
): GraphQLObjectType | null | undefined;

/**
 * Create a custom scalar that validates values against `validate` while
 * (de)serializing via `baseScalarType`. The resulting scalar is named
 * `${name}_${baseScalarType.name}` and exposes `baseScalarType`.
 */
export function createValidatedScalar(
  name: string,
  description: string,
  baseScalarType: GraphQLScalarType,
  validate: (value: any) => void,
): GraphQLScalarType & { baseScalarType: GraphQLScalarType };

/* ========================================================================== *
 * Query building (src/index.js)
 * ========================================================================== */

/** A QLFilterGroup input value (recursive AND/OR groups plus flat conditions). */
export interface FilterGroupInput {
  AND?: FilterGroupInput[];
  OR?: FilterGroupInput[];
  conditions?: Array<{
    field: string;
    operator?: string;
    value?: any;
    path?: string;
  }>;
  [key: string]: any;
}

/** Translate list-query arguments (filters, AND/OR, sort, pagination) into a MongoDB aggregation pipeline. */
export function buildQuery(
  input: Record<string, any>,
  gqltype: GraphQLObjectType,
  isCount?: boolean,
): Promise<Array<Record<string, any>>>;

/** Translate a QLFilterGroup into a MongoDB `$match` expression, collecting required lookups. */
export function buildFilterGroupMatch(
  filterGroup: FilterGroupInput,
  gqltype: GraphQLObjectType,
  aggregateClauses: any[],
  aggregationsIncluded: Record<string, any>,
  depth?: number,
): Promise<any>;

/* ========================================================================== *
 * Validators (src/validators.js default export)
 * ========================================================================== */

/** A single field validator (throws SimfinityError VALIDATION_ERROR on failure). */
export interface FieldValidator {
  validate(typeName: string, fieldName: string, value: unknown, session?: unknown): Promise<void>;
}

/** Validators grouped by operation, as expected by field `extensions.validations`. */
export interface FieldValidations {
  CREATE: FieldValidator[];
  UPDATE: FieldValidator[];
  /** Backward-compatible alias of CREATE. */
  save: FieldValidator[];
  /** Backward-compatible alias of UPDATE. */
  update: FieldValidator[];
}

/** Built-in field validator factories. */
export const validators: {
  stringLength(name: string, min?: number, max?: number): FieldValidations;
  maxLength(name: string, max: number): FieldValidations;
  pattern(name: string, regex: RegExp | string, message?: string): FieldValidations;
  email(): FieldValidations;
  url(): FieldValidations;
  numberRange(name: string, min?: number, max?: number): FieldValidations;
  positive(name: string): FieldValidations;
  arrayLength(name: string, maxItems?: number, itemValidator?: FieldValidator[]): FieldValidations;
  dateFormat(name: string, format?: string): FieldValidations;
  futureDate(name: string): FieldValidations;
};

/* ========================================================================== *
 * Scalars (src/scalars.js default export)
 * ========================================================================== */

/** Pre-built validated scalars and factory functions. */
export const scalars: {
  EmailScalar: GraphQLScalarType;
  URLScalar: GraphQLScalarType;
  PositiveIntScalar: GraphQLScalarType;
  PositiveFloatScalar: GraphQLScalarType;
  createBoundedStringScalar(name: string, min?: number, max?: number): GraphQLScalarType;
  createBoundedIntScalar(name: string, min?: number, max?: number): GraphQLScalarType;
  createBoundedFloatScalar(name: string, min?: number, max?: number): GraphQLScalarType;
  createPatternStringScalar(name: string, pattern: RegExp | string, message?: string): GraphQLScalarType;
};

/* ========================================================================== *
 * Auth (src/auth/index.js default export)
 * ========================================================================== */

/** A rule function: return true/void to allow, false to deny (or throw). */
export type AuthRuleFunction = (
  parent: any,
  args: any,
  ctx: any,
  info: any,
) => boolean | void | Promise<boolean | void>;

/** Declarative policy expression (JSON AST). */
export type PolicyExpression = Record<string, unknown>;

/** A rule: function, array of functions (AND), or a policy expression. */
export type AuthRule = AuthRuleFunction | AuthRuleFunction[] | PolicyExpression;

/** Field-name (or '*') to rule mapping for one GraphQL type. */
export type TypePermissions = Record<string, AuthRule>;

/** Type-name to {@link TypePermissions} mapping. */
export type PermissionSchema = Record<string, TypePermissions>;

/** Options for the auth plugin / middleware factories. */
export interface AuthPluginOptions {
  /** Policy applied when no rule matches. Default 'DENY'. */
  defaultPolicy?: 'ALLOW' | 'DENY';
  debug?: boolean;
}

declare class UnauthenticatedError extends SimfinityError {
  constructor(message?: string);
}

declare class ForbiddenError extends SimfinityError {
  constructor(message?: string);
}

/** Authorization utilities (RBAC/ABAC rules, plugin factories and auth errors). */
export const auth: {
  /** Envelop-compatible plugin that wraps schema resolvers in-place via `onSchemaChange`. */
  createAuthPlugin(permissions: PermissionSchema, options?: AuthPluginOptions): EnvelopSchemaPlugin;
  /** @deprecated Use createAuthPlugin instead. graphql-middleware compatible middleware. */
  createAuthMiddleware(
    permissions: PermissionSchema,
    options?: AuthPluginOptions,
  ): (resolve: any, parent: any, args: any, ctx: any, info: any) => Promise<any>;
  /** @deprecated Use createAuthPlugin instead. Field middleware object for graphql-middleware. */
  createFieldMiddleware(
    permissions: PermissionSchema,
    options?: AuthPluginOptions,
  ): Record<string, Record<string, any>>;
  resolvePath(obj: any, pathOrFn: string | ((obj: any) => any)): any;
  requireAuth(userPath?: string): AuthRuleFunction;
  requireRole(role: string | string[], options?: { userPath?: string; rolePath?: string }): AuthRuleFunction;
  requirePermission(
    permission: string | string[],
    options?: { userPath?: string; permissionsPath?: string },
  ): AuthRuleFunction;
  composeRules(...rules: AuthRuleFunction[]): AuthRuleFunction;
  anyRule(...rules: AuthRuleFunction[]): AuthRuleFunction;
  isOwner(ownerField?: string, userIdField?: string, options?: { userPath?: string }): AuthRuleFunction;
  createRule(predicate: AuthRuleFunction, errorMessage?: string, errorCode?: string): AuthRuleFunction;
  allow(): AuthRuleFunction;
  deny(message?: string): AuthRuleFunction;
  evaluateExpression(expression: PolicyExpression, context: any): boolean;
  isPolicyExpression(value: unknown): boolean;
  createRuleFromExpression(expression: PolicyExpression): AuthRuleFunction;
  UnauthenticatedError: typeof UnauthenticatedError;
  ForbiddenError: typeof ForbiddenError;
  createAuthError(message: string, code?: string): SimfinityError;
};

/* ========================================================================== *
 * Plugins (src/plugins.js default export)
 * ========================================================================== */

/** GraphQL server plugins: auth plugin factory plus count-extension plugins. */
export const plugins: {
  createAuthPlugin(permissions: PermissionSchema, options?: AuthPluginOptions): EnvelopSchemaPlugin;
  /** Apollo Server plugin that copies `contextValue.count` into `extensions.count`. */
  apolloCountPlugin(): {
    requestDidStart(): Promise<{
      willSendResponse(payload: any): Promise<void>;
    }>;
  };
  /** Envelop plugin that copies `contextValue.count` into `extensions.count`. */
  envelopCountPlugin(): {
    onExecute(): {
      onExecuteDone(payload: any): void;
    };
  };
};
