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
  PermissionSchema,
  PolicyExpression,
  TypePermissions,
} from '@simtlix/simfinity-core';
export * from '@simtlix/simfinity-mcp';
export { default as mcp } from '@simtlix/simfinity-mcp';
export interface MongoAdapterOptions {
  /** Fixed at adapter creation. Defaults to off; transactional mode requires initialize(). */
  referentialIntegrity?: 'off' | 'transactional';
}
export interface MongoAdapter extends DatabaseAdapter {
  readonly referentialIntegrity: 'off' | 'transactional';
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
 * Get the generated create input type, preserving field and list-item non-null
 * wrappers. Update inputs remove only the outer wrapper (except entity id).
 * References use IdInputType; embedded lists use nested inputs; referenced
 * collections use added/updated/deleted operation inputs.
 */
export function getInputType(type: GraphQLObjectType | { name: string }): GraphQLInputObjectType;

/**
 * Persist an object and its nested writes inside a transaction (runs controllers/validators).
 * Without a session, owns a transaction on the model's connection and awaits cleanup.
 * A supplied session must have an active transaction and belong to the model's MongoDB client.
 * The caller then owns retries, commit, abort, and cleanup; inactive sessions are rejected.
 * Exception: transactional reference integrity aborts on a violation, guarded-write error or ambiguous update result.
 * That mode requires snapshot read concern and majority write concern on supplied transactions.
 * Owned transactions retry transient failures and uncertain commits separately, up to five times each.
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
