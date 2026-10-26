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
  CreateSchemaOptions,
  DatabaseAdapter,
  MutationLimitsOptions,
  QueryFeatures,
  RuntimeRegistration,
  SimfinityError,
  ViewOptions,
} from '@simtlix/simfinity-core';
export {
  auth,
  buildErrorFormatter,
  createRuntime,
  createValidatedScalar,
  InternalServerError,
  MAX_RECORD_VERSION,
  plugins,
  RecordVersion,
  scalars,
  SimfinityError,
  validators,
} from '@simtlix/simfinity-core';
export type {
  AuthPluginOptions,
  AuthRule,
  AuthRuleFunction,
  AuthSchemaPlugin,
  ConcurrencyDeclaration,
  CreateSchemaOptions,
  EnvelopSchemaPlugin,
  FieldValidations,
  FieldValidator,
  FilterCondition,
  FilterGroup,
  ItemValidators,
  MutationLimitsOptions,
  PermissionSchema,
  PolicyExpression,
  ScopeFunction,
  ScopeOperation,
  ScopeParams,
  TypePermissions,
  TypeScopes,
  ViewOptions,
  ViewParam,
  ViewParamType,
  VirtualFieldDeclaration,
  VirtualFieldOptions,
} from '@simtlix/simfinity-core';
export * from '@simtlix/simfinity-mcp';
export { default as mcp } from '@simtlix/simfinity-mcp';
export interface MongoAdapterOptions {
  /** Fixed at adapter creation. Defaults to off; transactional mode requires initialize(). */
  referentialIntegrity?: 'off' | 'transactional';
  /**
   * Opt in to batched collection reads; defaults to false. When true, the adapter defines
   * `findChildrenBatch` and `batchesChildren`, so the runtime reads the generated collection fields
   * of one request that share a related type, a connection field and their arguments with aggregate
   * commands of up to `collectionBatchSize` parents each, run concurrently. Each parent's own
   * pipeline (filters, sort and page) runs as one sub-pipeline of a command, in a `$unionWith` stage
   * after the first. Children of models with aggregate middleware, their own `aggregate` static, a
   * discriminator key or a wrapped `collection.aggregate`, reads inside a Mongoose
   * `transactionAsyncLocalStorage` transaction, and adapter copies or overrides of `findChildren`
   * keep one read per parent. When false, the adapter has neither member and reads one parent at a
   * time, as 3.6.0 did. Fixed at adapter creation; a value other than a boolean throws
   * `INVALID_MONGO_ADAPTER_OPTIONS` (400).
   */
  batchedCollections?: boolean | undefined;
  /**
   * Parents per batched aggregate command, an integer from 1 to 100; defaults to 5. A command runs
   * its parents' sub-pipelines one after another, and the commands of one batch run concurrently, so
   * a larger value sends fewer commands at the cost of a longer command. Only used with
   * `batchedCollections: true`. Fixed at adapter creation; another value throws
   * `INVALID_MONGO_ADAPTER_OPTIONS` (400).
   */
  collectionBatchSize?: number | undefined;
}
/**
 * In the default 'off' mode, withTransaction(null, callback) without a model, as custom mutations
 * call it, opens its session on the default mongoose.connection, unless that connection has no
 * client, no model is compiled on it or on its useDb() descendants, and every model of the bound
 * runtime's registrations uses one MongoDB client: then it opens it on that client. A supplied
 * session or model is used as is. In transactional mode it uses the first protected model's
 * connection. With `batchedCollections: true` the adapter also has the optional `DatabaseAdapter`
 * members `findChildrenBatch` and `batchesChildren`; without it, it has neither.
 */
export interface MongoAdapter extends DatabaseAdapter {
  readonly referentialIntegrity: 'off' | 'transactional';
  /** Frozen declaration of atomic expectedVersion writes; wrappers must forward every argument. */
  readonly writeFeatures: Readonly<{ optimisticConcurrency: true }>;
  /**
   * Frozen; lists every `QLOperator` value and declares `referenceEmptiness: true`. The literal text
   * operators compile to escaped regular expressions: `ILIKE` unanchored, `STARTS_WITH` and
   * `ISTARTS_WITH` anchored with `^`, `ENDS_WITH` and `IENDS_WITH` with `\z`, and `IEQ` with both, with
   * the `i` option for the case-insensitive ones. `IS_EMPTY` and `IS_NOT_EMPTY` compile to plain query
   * operators on the record's own fields, and through single references and at references and
   * collections to joins and frames (see {@link buildQuery}). A copy of the adapter without this member
   * supports only the operators of 3.7.0, and one whose declaration leaves out `referenceEmptiness`
   * gets `UNSUPPORTED_QUERY` for emptiness through references and collections.
   */
  readonly queryFeatures: QueryFeatures;
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
/**
 * Supports extensions.concurrency: { mode: 'optimistic' }. Generated models store version as Number.
 * Supplied models must declare version: Number without immutable, select: false, getters, setters
 * or a default other than 1; versionKey must not be 'version'. Missing/null stored versions mean 1.
 * Protected writes use findOneAndUpdate/findOneAndDelete statics (integrity deletes still call
 * findByIdAndDelete). Query middleware must preserve the version condition and increment.
 * Adapter-detected conflicts abort supplied transactions only in transactional integrity mode;
 * in default mode, the caller owns the abort. Core-detected conflicts keep that caller ownership.
 */
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
 * connect(); custom queries and mutations are matched by name. Scopes are validated
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
 * Invalid virtual field declarations (`extensions.virtual`, see `VirtualFieldOptions`) throw
 * INVALID_MODEL (400) before models are created, in both referentialIntegrity modes. A virtual field
 * gets no path, `[]` default or index in generated models, on entities and embedded types, and no
 * entry in the transactional integrity registry, so it needs no `relation` in either mode; generated
 * writes never set or unset it. A supplied model keeps the paths it declares. A readOnly field with
 * arguments and its own resolver that is not virtual, and is not a reference or collection, logs a
 * `Configuration issue` warning once.
 * A generated input that would have no fields is left out with a warning, together with the
 * collection operation, embedded field or add/update/state-action mutation that would take it; a
 * non-null embedded field whose embedded type has no writable fields throws INVALID_MODEL (400)
 * when the generated mutations reach its owner. An application type named FieldExtensionsType or
 * RelationType renames Simfinity's introspection metadata types (SimfinityFieldExtensionsType,
 * SimfinityRelationType) with a warning when it is in the process's first Simfinity schema. That
 * schema fixes the names: in a later createSchema(), an application type with one of the current
 * names (the original ones, or the fallback names after a rename) throws RESERVED_TYPE_NAME (500),
 * before models are created when it is an included endpoint type, a registered custom operation's input or
 * output type, an output type they reach or a field argument's type, and when the schema is
 * constructed otherwise.
 * options.includedCustomQueries selects custom queries by name (see CreateSchemaOptions); an
 * invalid options argument throws INVALID_SCHEMA_OPTIONS (500), and an included custom query named
 * like an included generated query throws QUERY_NAME_CONFLICT (500), before models are created. A
 * schema without mutation fields has no Mutation root.
 */
export function createSchema(
  includedQueryTypes?: GraphQLObjectType[] | null,
  includedMutationTypes?: GraphQLObjectType[] | null,
  includedCustomMutations?: string[] | null,
  options?: CreateSchemaOptions,
): GraphQLSchema;

/** Register a custom mutation executed inside a transaction. */
export function registerMutation(
  name: string,
  description: string,
  inputModel: GraphQLInputObjectType | null | undefined,
  outputModel: GraphQLOutputType,
  callback: (input: any, session: any, context: any) => any,
): void;

/** Register a custom query for a result that is not a stored record. No transaction or session wraps it. */
export function registerCustomQuery(
  name: string,
  description: string,
  inputModel: GraphQLInputObjectType | null | undefined,
  outputModel: GraphQLOutputType,
  callback: (input: any, context: any) => any,
): void;

/**
 * Register a named view: a root query field that returns the type's list with the generated list
 * arguments plus the view's params, and appends the groups of `where` after middleware. Throws
 * `INVALID_VIEW` (500) for an invalid declaration and `QUERY_NAME_CONFLICT` (500) for a name already
 * registered as a view (see the core `Runtime.registerView`).
 */
export function registerView(name: string, options: ViewOptions): void;

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
  /**
   * Positive safe integer; defaults to 10. The most distinct scoped joins and frames that the
   * client's reference and collection emptiness may need in one list, aggregate or collection-field
   * call; more fail with `FILTER_DEPTH_EXCEEDED` (400).
   */
  maxReferenceFrames?: number;
}

/**
 * Configure at startup. Invalid configuration throws INVALID_QUERY_LIMITS (400) and keeps both
 * limits; an omitted option takes its default again.
 */
export function configureQueryLimits(options?: QueryLimitsOptions): void;

/**
 * Process-wide limit on nested added/updated/deleted entries per generated add, update or
 * state-action mutation; unlimited by default, restored by calling it without options.
 * Invalid configuration, including an unknown or misspelled option key, throws
 * INVALID_MUTATION_LIMITS (400) and keeps the current limit; a mutation over the limit
 * fails with NESTED_OPERATIONS_EXCEEDED (400) before its transaction starts. `updateObject` and
 * `transitionObject` apply `maxNestedOperations` to their `input` in the same way (`null` = no limit).
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

/**
 * Run the lifecycle of the generated update mutation from code, in a transaction of its own or in the
 * active session supplied (see the core `Runtime.updateObject`). `input` has the shape of the type's
 * update input and is checked structurally before anything runs: enum fields take their internal
 * values, scalars are not coerced and a reference is its record key as a string. A scalar field takes a
 * primitive, a `Date` or plain data (objects and arrays, at most 256 levels deep); class instances such
 * as `ObjectId`, `Buffer` or `Map` are rejected with `INVALID_INPUT`, an own `undefined` counts as
 * omitted and a bare value is never wrapped into a list. It skips the root record's global middleware,
 * as `saveObject` does. More nested entries than `maxNestedOperations` from `configureMutationLimits()`
 * (`null` = no limit) reject with `NESTED_OPERATIONS_EXCEEDED` (400). The helper itself never commits,
 * retries, aborts or cleans up a supplied session; an adapter may still abort it on a write error (for
 * example MongoDB with transactional reference integrity). Rejects with `INVALID_OPERATION_TARGET` (500)
 * for a type that is not a stored record type of this runtime, or that has no prepared update input with
 * an id field (before `createSchema()`, with a `readOnly` id, or with an empty update input),
 * `REQUIRED_VALUE` or `INVALID_INPUT` (400) for an invalid input, and `NOT_VALID_ID` (404) when no
 * record has the ID. Resolves to the updated record.
 */
export function updateObject(
  typeName: string,
  input: Record<string, any>,
  session?: any,
  context?: any,
): Promise<any>;

/**
 * Run the lifecycle of the generated delete mutation from code: `target` is `{ id }`, plus `version` on
 * a type with optimistic concurrency (see the core `Runtime.deleteObject`). Its type is checked as
 * `updateObject` checks it, without needing an update input; its target is checked before anything runs.
 * Resolves to the deleted record, or `null` when no record has the ID.
 */
export function deleteObject(
  typeName: string,
  target: { id: string; version?: number },
  session?: any,
  context?: any,
): Promise<any>;

/**
 * Run a state machine action from code with the lifecycle of its generated mutation (see the core
 * `Runtime.transitionObject`). It checks its type and `input` as `updateObject` does, rejects with
 * `UNKNOWN_ACTION` (500) for an action the type does not have, and resolves to the updated record.
 */
export function transitionObject(
  typeName: string,
  actionName: string,
  input: Record<string, any>,
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
    /** Omitted or null for `IS_EMPTY` and `IS_NOT_EMPTY`. */
    value?: any;
    /** Required on an object field, except for `IS_EMPTY` and `IS_NOT_EMPTY`, where it may be omitted, null or `""` to test the field itself. */
    path?: string;
  }>;
  [key: string]: any;
}

/**
 * Translate list-query arguments (filters, AND/OR, sort, pagination) into a MongoDB aggregation
 * pipeline. `input.aggregation` filters a field named `aggregation`; the aggregate stage is never
 * built here. An embedded `.id` path uses the declared `id` member, except for entity types embedded
 * as lists and supplied subdocument schemas without an `id` path, which use the subdocument `_id`.
 * A filter, condition or sort path through a virtual field rejects with `INVALID_FILTER_FIELD` (400).
 *
 * `IS_EMPTY` and `IS_NOT_EMPTY` take no value and test the queried document's own fields, inside the
 * same `$match`: `{ p: { $in: [null, ""] } }` and `{ p: { $nin: [null, ""] } }` on a `String` field (a
 * validated scalar by its base scalar), `{ p: null }` and `{ p: { $ne: null } }` on any other scalar
 * or enum and on the record identity `_id`, `{ $and: [{ p: null }, { p: { $not: { $type: "array" } } }] }`
 * and its `$nor` on an application scalar without a supported base, which MongoDB stores as written,
 * so that an array, also `[null]`, is a value, `{ "p.0": { $exists: false } }` and
 * `$exists: true` on a scalar list or an embedded list, and, on an embedded object,
 * `{ $or: [{ p: null }, { $and: [<each stored member's IS_EMPTY form>] }] }` and its `$nor`. A type
 * without stored members is always empty (`{}` stands for the members). Embedded `id` members follow
 * the `.id` rule above, so an object of a supplied subdocument schema with an automatic `_id` is never
 * empty. A term without a path (omitted, null or `""`) and a group condition without a path test the
 * field itself.
 *
 * Their path may also cross single references and end at a reference or a collection, and an
 * embedded object may have reference and collection members. A crossing reads its target through a
 * `$lookup` and `$unwind` before the `$match`, and the target's `id` right after it is the joined
 * `_id`, which takes the null rule. A reference or collection end or member is a frame, one `$lookup`
 * with `pipeline: [{ $limit: 1 }, { $project: { _id: 1 } }]` under an alias `__sf_qN`, matched with
 * `{ "__sf_qN.0": { $exists: false } }` (for a collection, `$or` a null local key, since `$lookup`
 * matches a missing local key with every child whose connection field is null) and its `$nor`. A
 * collection frame reads the child's connection field, and its local key is `<path>._id`. Arguments
 * from this function, middleware and scopes read stored data: a reference is empty when no record it
 * points to exists, so a dangling reference is empty, and leaves share the lookup aliases of the other
 * operators. A term or group condition that the runtime marked for a client, `__scope: { id, scopes }`,
 * reads through the target find scopes in `scopes`, compiled with this function into the `$lookup`
 * pipelines: crossings become scoped joins (`__sf_jN`), frames take their target's scope, and a record
 * that a scope hides reads as missing. A crossing or frame after a scoped crossing stays in that chain,
 * also when its own scope is null. The aliases are unset at the end of find pipelines. A target type
 * without a model fails with `INVALID_FILTER_PATH` (400), and a marker that is not filled for every
 * path the construct reads, or that sits on a construct that reads none or on another operator, with
 * `DETACHED_CLIENT_FILTER` (500), after the 400 checks. Supplied models on another database or
 * connection and discriminator targets are not supported here, as for the other relation paths.
 *
 * The checks, and their codes, are those of `createQueryPlan` in the same order: `MISSING_FILTER_PATH`
 * for an emptiness operator on an object filter without terms or beside terms, `INVALID_FILTER_PATH`
 * for a value inside an embedded list or a collection and for an interface or union field or member,
 * `INVALID_FILTER_OPERATOR` for an embedded type that reaches itself through single embedded members,
 * and `INVALID_FILTER_VALUE` for a value that is not omitted or null. Other operators keep their
 * pipelines.
 */
export function buildQuery(
  input: Record<string, any>,
  gqltype: GraphQLObjectType,
  isCount?: boolean,
): Promise<Array<Record<string, any>>>;

/**
 * Translate a QLFilterGroup into a MongoDB `$match` expression, collecting required lookups. A
 * condition path through a virtual field rejects with `INVALID_FILTER_FIELD` (400). `IS_EMPTY` and
 * `IS_NOT_EMPTY` conditions compile and reject as in {@link buildQuery}: on the record's own fields
 * they add no lookup, and through references and collections they append their joins and frames to
 * `aggregateClauses` and record their aliases in `aggregationsIncluded`.
 */
export function buildFilterGroupMatch(
  filterGroup: FilterGroupInput,
  gqltype: GraphQLObjectType,
  aggregateClauses: any[],
  aggregationsIncluded: Record<string, any>,
  depth?: number,
): Promise<any>;
