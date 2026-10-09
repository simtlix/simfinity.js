/**
 * Type declarations for @simtlix/simfinity-js.
 *
 * Mirrors the MongoDB facade in src/index.js. Shared helper and MCP types are
 * re-exported from their canonical packages; MongoDB model and session values
 * remain deliberately typed loosely (`any`).
 */

import type {
  GraphQLSchema,
  GraphQLObjectType,
  GraphQLInputObjectType,
  GraphQLOutputType,
} from 'graphql';
import type {
  DatabaseAdapter,
  MutationLimitsOptions,
  RuntimeRegistration,
  SimfinityError,
} from '@simtlix/simfinity-core';
export {
  auth,
  buildErrorFormatter,
  createRuntime,
  createValidatedScalar,
  InternalServerError,
  plugins,
  scalars,
  SimfinityError,
  validators,
} from '@simtlix/simfinity-core';
export type {
  AuthPluginOptions,
  AuthRule,
  AuthRuleFunction,
  EnvelopSchemaPlugin,
  FieldValidations,
  FieldValidator,
  ItemValidators,
  MutationLimitsOptions,
  PermissionSchema,
  PolicyExpression,
  ScopeFunction,
  ScopeOperation,
  ScopeParams,
  TypePermissions,
  TypeScopes,
} from '@simtlix/simfinity-core';
export * from '@simtlix/simfinity-mcp';
export { default as mcp } from '@simtlix/simfinity-mcp';
export interface MongoAdapterOptions {
  /** Fixed at adapter creation. Defaults to off; transactional mode requires initialize(). */
  referentialIntegrity?: 'off' | 'transactional';
}
/**
 * In the default 'off' mode, withTransaction(null, callback) without a model, as custom mutations
 * call it, opens its session on the default mongoose.connection, unless that connection has no
 * client, no model is compiled on it or on its useDb() descendants, and every model of the bound
 * runtime's registrations uses one MongoDB client: then it opens it on that client. A supplied
 * session or model is used as is. In transactional mode it uses the first protected model's
 * connection.
 */
export interface MongoAdapter extends DatabaseAdapter {
  readonly referentialIntegrity: 'off' | 'transactional';
  /**
   * Accepts only an ObjectId or a 24-character hexadecimal string, normalized to lowercase, and
   * throws `NOT_VALID_ID` (400) for anything else, including undefined, null and numbers. It never
   * creates an identifier; use `new mongoose.Types.ObjectId()` for that.
   */
  castId(value: any): any;
  /** Returns null for a hydrated nested path whose stored value is an explicit null; otherwise the value. */
  readEmbeddedValue(value: any): any;
  /**
   * Returns the raw stored data of a hydrated nested path or subdocument, or a Mongoose map's
   * entries as a plain object, without running schema getters or virtuals. Returns the value
   * unchanged when its schema declares a getter, a virtual other than Mongoose's automatic `id`, an
   * alias or a subdocument method on a member at any depth inside it, so Simfinity keeps the object
   * as stored, and for any other value.
   */
  rawEmbeddedValue(value: any): any;
  /** After connecting MongoDB and createSchema(), await the transaction capability and existing-reference audit. */
  initialize(): Promise<void>;
}
export function createMongoAdapter(options?: MongoAdapterOptions): MongoAdapter;
export function getRegistrations(): RuntimeRegistration[];

/* ========================================================================== *
 * Core schema-building API (src/index.js)
 * ========================================================================== */

/** Lifecycle hooks run before commit and may repeat on a transient transaction retry. */
export interface EntityController {
  onSaving?(doc: any, args: any, session: any, context: any): void | Promise<void>;
  onSaved?(result: any, args: any, session: any, context: any): void | Promise<void>;
  onUpdating?(id: any, args: any, session: any, context: any): void | Promise<void>;
  /** Receives the updated Mongoose document after parent and nested writes complete. */
  onUpdated?(result: any, session: any, context: any): void | Promise<void>;
  onDelete?(doc: any, session: any, context: any): void | Promise<void>;
}

/** State machine attached to an entity (initial state plus named action transitions). */
export interface StateMachine {
  initialState: any;
  actions: Record<string, any>;
  [key: string]: any;
}

/**
 * Register a Mongoose model + GraphQL type pair, exposing single and list endpoints.
 * Throws INVALID_SCOPE (500) for an invalid `extensions.scope`, and TYPE_BOUND_TO_OTHER_RUNTIME
 * (409) when another runtime bound the type by generating its relation resolvers, or reserved it
 * because its schema reached the type with an unresolved relation field.
 */
export function connect(
  model: any,
  gqltype: GraphQLObjectType,
  simpleEntityEndpointName: string,
  listEntitiesEndpointName: string,
  controller?: EntityController | null,
  onModelCreated?: ((model: any) => void) | null,
  stateMachine?: StateMachine | null,
): void;

/** Register a GraphQL type without exposing root endpoints (e.g. embedded/related types). Throws like connect(). */
export function addNoEndpointType(gqltype: GraphQLObjectType): void;

/**
 * Build the executable GraphQLSchema from every connected type. The first two
 * allowlists are matched against the GraphQLObjectType INSTANCES passed to
 * connect(); only custom mutations are matched by name. Scopes are validated
 * (INVALID_SCOPE), and reachable types bound or reserved by another runtime, or
 * holding a field copied with toConfig() after another runtime generated its
 * relation resolver, keeping the generated resolver or its extensions, are rejected (TYPE_BOUND_TO_OTHER_RUNTIME), before models
 * are created; a list or embedded relation to an unregistered type throws
 * UNREGISTERED_RELATION_TARGET. A writable non-embedded list relation without a child
 * connectionField, whose resolver Simfinity would generate, throws INVALID_MODEL (400). In default
 * mode, one with its own resolver or readOnly only logs a warning and rejects nested writes
 * (INVALID_MODEL, 500); referentialIntegrity 'transactional' rejects every such collection.
 * Embedded types that contain each other throw INVALID_MODEL (400, `Embedded cycle at …`) when a
 * generated model's embedded fields reach them, and always in transactional mode; in default mode a
 * cycle that only supplied models reach is not checked.
 * A generated input that would have no fields is left out with a warning, together with the
 * collection operation, embedded field or add/update/state-action mutation that would take it; a
 * non-null embedded field whose embedded type has no writable fields throws INVALID_MODEL (400)
 * when the generated mutations reach its owner. An application type named FieldExtensionsType or
 * RelationType renames Simfinity's introspection metadata types (SimfinityFieldExtensionsType,
 * SimfinityRelationType) with a warning when it is in the process's first Simfinity schema. That
 * schema fixes the names: in a later createSchema(), an application type with one of the current
 * names (the original ones, or the fallback names after a rename) throws RESERVED_TYPE_NAME (500),
 * before models are created when it is an included endpoint type, a registered mutation's input or
 * output type, an output type they reach or a field argument's type, and when the schema is
 * constructed otherwise.
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

/** Operation context for root operations, generated non-embedded relation reads, and nested collection writes. */
export interface SimfinityMiddlewareContext {
  args: any;
  operation: string;
  entry?: string;
  type?: any;
  context?: any;
  [key: string]: any;
}

/**
 * Register middleware before generated operations, including related-type reads and nested child writes.
 * Nested operations keep root argument shapes and the GraphQL request context.
 * Await next() to advance the middleware chain; throw to reject before the operation executes.
 * A non-function throws INVALID_MIDDLEWARE (500). The rest of the chain runs at most once and is
 * awaited even when next() is not; its errors cancel the operation, even if a middleware catches them.
 * Call next() before the middleware returns or its promise settles: a later call, such as
 * setTimeout(next), does nothing, so the remaining middleware is skipped.
 */
export function use(
  middleware: (
    context: SimfinityMiddlewareContext,
    next: () => Promise<void>,
  ) => void | Promise<void>,
): void;

/** Globally prevent Mongoose collection creation for generated models. */
export function preventCreatingCollection(prevent: boolean): void;

/** Process-wide limits for generated list and paginated aggregate queries. */
export interface QueryLimitsOptions {
  /** Positive safe integer; defaults to 1000. Unpaged lists use min(100, maxPageSize). */
  maxPageSize?: number;
}

/** Configure at startup. Invalid configuration throws INVALID_QUERY_LIMITS (400). */
export function configureQueryLimits(options?: QueryLimitsOptions): void;

/**
 * Process-wide limit on nested added/updated/deleted entries per generated add, update or
 * state-action mutation; unlimited by default, restored by calling it without options.
 * Invalid configuration, including an unknown or misspelled option key, throws
 * INVALID_MUTATION_LIMITS (400) and keeps the current limit; a mutation over the limit
 * fails with NESTED_OPERATIONS_EXCEEDED (400) before its transaction starts.
 */
export function configureMutationLimits(options?: MutationLimitsOptions): void;

/**
 * Get the generated create input type, preserving field and list-item non-null
 * wrappers. Update inputs remove only the outer wrapper (except entity id).
 * References use IdInputType; embedded lists use nested inputs; referenced
 * collections use added/updated/deleted operation inputs. It has no fields for a type without
 * writable fields; such inputs are not part of generated schemas.
 */
export function getInputType(type: GraphQLObjectType | { name: string }): GraphQLInputObjectType;

/**
 * Persist an object and its nested writes inside a transaction (runs controllers/validators).
 * Without a session, owns a transaction on the model's connection and awaits cleanup.
 * A supplied session must have an active transaction and belong to the model's MongoDB client.
 * The caller then owns retries, commit, abort, and cleanup; inactive sessions are rejected.
 * Exception: transactional reference integrity aborts on a violation, guarded-write error or ambiguous update result.
 * That mode requires snapshot read concern and majority write concern on supplied transactions.
 * Owned transactions retry transient failures after a short randomized backoff, and uncertain commits
 * immediately, up to five times each. An exhausted write conflict throws TRANSACTION_RETRY_EXCEEDED
 * (409) with the driver error as `cause`; a supplied session receives the raw driver error.
 * Relation inputs need `{ id }`; a missing or malformed ID throws NOT_VALID_ID (400).
 */

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

/**
 * Translate list-query arguments (filters, AND/OR, sort, pagination) into a MongoDB aggregation
 * pipeline. `input.aggregation` filters a field named `aggregation`; the aggregate stage is never
 * built here. An embedded `.id` path uses the declared `id` member, except for entity types embedded
 * as lists and supplied subdocument schemas without an `id` path, which use the subdocument `_id`.
 */
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
