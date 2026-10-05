import type {
  GraphQLEnumType,
  GraphQLError,
  GraphQLInputObjectType,
  GraphQLObjectType,
  GraphQLOutputType,
  GraphQLScalarType,
  GraphQLSchema,
} from 'graphql';

export const QLOperator: GraphQLEnumType;
export const QLSort: GraphQLInputObjectType;
export const QLValue: GraphQLScalarType<unknown, unknown>;

export interface ModelRegistration {
  gqltype: GraphQLObjectType;
  /** Defaults to true. False excludes embedded-only types until referenced. */
  endpoint?: boolean;
}
export interface FieldDescription {
  name: string;
  storageName: string;
  kind: 'scalar' | 'reference' | 'collection' | 'embedded';
  required: boolean;
  list: boolean;
  itemRequired: boolean;
  unique: boolean;
  readOnly: boolean;
  scalar?: 'ID' | 'String' | 'Int' | 'Float' | 'Boolean' | 'DateTime' | 'Enum';
  values?: string[];
  enumValues?: { name: string; value: unknown }[];
  target?: string;
  connectionField?: string;
  fields?: FieldDescription[];
  private?: boolean;
  inferred?: boolean;
}
export interface ModelDescription {
  entities: Array<{
    name: string;
    gqltype: GraphQLObjectType;
    fields: FieldDescription[];
    indexes: Array<{ fields: string[]; unique: boolean }>;
  }>;
}
export function describeModels(registrations: ModelRegistration[]): ModelDescription;
/**
 * Creates the scalar `${name}_${baseScalarType.name}`. `validate` throws to reject a value and
 * receives the base scalar's internal value: the base's `parseValue` result for variables, the
 * base's `parseLiteral` result for inline literals, and the resolver's value before serialization
 * for output. Inline literal kinds are checked against the root of the chain of
 * `createValidatedScalar` scalars when that root is String, ID, Int, Float or Boolean; a Float
 * root accepts integer and float literals. Any other scalar is the root, even with a hand-set
 * `baseScalarType` storage hint, and its own `parseLiteral` decides. `validate` is not called
 * when the base rejects input by returning `undefined`.
 */
export function createValidatedScalar<TInternal, TExternal>(
  name: string,
  description: string,
  baseScalarType: GraphQLScalarType<TInternal, TExternal>,
  validate: (value: unknown) => void,
): GraphQLScalarType<TInternal, TExternal> & { baseScalarType: GraphQLScalarType<TInternal, TExternal> };
export class SimfinityError extends Error {
  constructor(message: string, code?: string, status?: number);
  extensions: { code: string | undefined; status: number | undefined; timestamp: string };
  getCode(): string | undefined;
  getStatus(): number | undefined;
  getTimestamp(): string;
  /** Set on errors that wrap a driver error, such as MongoDB's TRANSACTION_RETRY_EXCEEDED. */
  cause?: unknown;
  /** Set on errors that wrap a driver error, such as MongoDB's TRANSACTION_RETRY_EXCEEDED; returns `cause`. */
  getCause?(): unknown;
}

export class InternalServerError extends SimfinityError {
  constructor(message: string, cause?: unknown);
  cause?: unknown;
  getCause(): unknown;
}
/**
 * Creates an error formatter for a GraphQL server's error hook. A field error is a `GraphQLError`
 * with a `path`: for the one graphql-js creates around a value raised while resolving a field, such
 * as one a resolver threw, it classifies that value, and a raised `GraphQLError` that already had a
 * path is classified as a field error itself. A path-less `GraphQLError` is a request error, even
 * when it wraps a plain Error with the same message. An explicit `InternalServerError` cause,
 * followed through GraphQLErrors only, is kept for masking; mark unexpected subscription source
 * failures with it because a path-less wrapper cannot distinguish them from scalar input errors.
 * Any other input, such as a syntax, validation or variable error, is classified as is:
 * - a `SimfinityError` is kept;
 * - a request `GraphQLError`, or one raised while resolving a field that has its own string
 *   `extensions.code` or a `SimfinityError` cause, becomes a `SimfinityError` with its own message
 *   and extensions (including ones the server added, such as Yoga's `http`). Its code is that of a
 *   `SimfinityError` reached through `GraphQLError` causes only, else its string `extensions.code`
 *   (so a code the server set, such as Yoga's `GRAPHQL_PARSE_FAILED`, is kept), else
 *   `BAD_REQUEST`; its status is that error's, else its integer `extensions.status`, else 500 for
 *   `INTERNAL_SERVER_ERROR` and 400 otherwise. Its `originalError` is never exposed, so input
 *   rejected by Simfinity's validated scalars is `BAD_REQUEST` (400);
 * - any other `GraphQLError` raised while resolving a field, including the ones graphql-js raises
 *   when it cannot complete a resolved value (scalar or enum serialization, `isTypeOf`, abstract
 *   type resolution, a non-iterable list), becomes `InternalServerError` with that message and the
 *   error as its cause;
 * - any other `Error` becomes `InternalServerError` with that error as its cause;
 * - a non-Error value becomes `InternalServerError('Unexpected error value')` with no cause. Servers
 *   whose executor first turns it into an `Error`, such as Yoga, pass the value's text instead.
 *
 * `callback` receives the classified error; check `error instanceof InternalServerError` to mask
 * unexpected errors. A returned error replaces it, and a returned `GraphQLError` is returned
 * unchanged. The result is a `GraphQLError` that keeps the input's locations and path, has the
 * chosen error as `originalError`, and copies its `extensions`.
 */
export function buildErrorFormatter(callback?: (error: SimfinityError) => Error | void): (error: unknown) => GraphQLError;

export interface EntityController<Session = any> {
  onSaving?(record: any, args: any, session: Session | undefined, context: any): void | Promise<void>;
  onSaved?(record: any, args: any, session: Session | undefined, context: any): void | Promise<void>;
  onUpdating?(id: any, update: any, session: Session | undefined, context: any): void | Promise<void>;
  onUpdated?(record: any, session: Session | undefined, context: any): void | Promise<void>;
  onDelete?(record: any, session: Session | undefined, context: any): void | Promise<void>;
}
export interface StateMachine<Session = any> {
  initialState: { name: string; value: any };
  actions: Record<string, {
    description?: string;
    from: { name: string; value: any };
    to: { name: string; value: any };
    action?: (args: any, session: Session) => void | Promise<void>;
  }>;
}
export interface RuntimeRegistration<Model = any, Session = any> extends ModelRegistration {
  model?: Model | null;
  simpleEntityEndpointName?: string;
  listEntitiesEndpointName?: string;
  controller?: EntityController<Session> | null;
  onModelCreated?: ((model: Model) => void) | null;
  stateMachine?: StateMachine<Session> | null;
  /**
   * Set by `createSchema()` before `adapter.prepare()`: true for entity types, those registered
   * with `connect()` and the targets of non-embedded relations, whose `id` resolves to the stored
   * `_id`, falling back to `id`. False for types this runtime uses only as embedded values. The `id`
   * rule follows the type object, so a type that another runtime sharing it treats as an entity
   * resolves `id` the same way here.
   */
  storedIdentity?: boolean;
}
export interface MiddlewareContext {
  args: any;
  operation: string;
  entry?: string;
  type?: RuntimeRegistration;
  context?: any;
  [key: string]: any;
}
/** Operations that a type's `extensions.scope` can restrict. */
export type ScopeOperation = 'find' | 'get_by_id' | 'aggregate';
/** Argument of a scope function. Mutate `args` in place; the return value is ignored. */
export interface ScopeParams<Model = any, Session = any> {
  type: RuntimeRegistration<Model, Session>;
  args: Record<string, any>;
  operation: ScopeOperation;
  context: any;
}
export type ScopeFunction<Model = any, Session = any> = (params: ScopeParams<Model, Session>) => unknown;
/**
 * Value of a type's `extensions.scope`: a plain object whose keys are scope operations and whose
 * values are functions. Omit a key to leave that operation unscoped. A present key must hold a
 * function: `{ find: undefined }` type-checks but throws `INVALID_SCOPE` (500) at startup, so
 * leave the key out instead. Every own string key is checked, including non-enumerable ones. Any
 * other shape throws `INVALID_SCOPE` at registration, at `createSchema()`, or on a read after it
 * was changed.
 */
export type TypeScopes<Model = any, Session = any> = Partial<Record<ScopeOperation, ScopeFunction<Model, Session>>>;

/**
 * Process-wide limits for generated add, update and state-action mutations. Any other option,
 * such as a misspelled `maxNestedOperation`, throws `INVALID_MUTATION_LIMITS` (400).
 */
export interface MutationLimitsOptions {
  /**
   * Maximum number of `added`, `updated` and `deleted` entries across every nested level of
   * non-embedded collection fields in one generated mutation. A non-negative safe integer;
   * `null` or omitted means unlimited (the default).
   */
  maxNestedOperations?: number | null;
}

export interface Runtime<Model = any, Session = any> {
  configureQueryLimits(options?: { maxPageSize?: number }): void;
  /**
   * Process-wide; calling it without options restores the unlimited default. Invalid options,
   * including unknown or misspelled option keys, throw `INVALID_MUTATION_LIMITS` (400) and keep
   * the current limit. A generated mutation over the limit fails with
   * `NESTED_OPERATIONS_EXCEEDED` (400) before its transaction starts.
   */
  configureMutationLimits(options?: MutationLimitsOptions): void;
  /**
   * Throws `INVALID_SCOPE` (500) for an invalid `extensions.scope`, and
   * `TYPE_BOUND_TO_OTHER_RUNTIME` (409) when another runtime bound the type by generating its
   * relation resolvers, or reserved it because its schema reached the type with an unresolved
   * relation field. A rejected type is not registered.
   */
  connect(model: Model | null, type: GraphQLObjectType, singular: string, plural: string, controller?: EntityController<Session> | null, onModelCreated?: ((model: Model) => void) | null, stateMachine?: StateMachine<Session> | null): void;
  /** Throws like `connect` for an invalid scope or a type bound to another runtime. */
  addNoEndpointType(type: GraphQLObjectType): void;
  /**
   * Validates every registered scope (`INVALID_SCOPE`) before building models, and rejects
   * (`TYPE_BOUND_TO_OTHER_RUNTIME`) any reachable type that another runtime bound or reserved, or
   * whose field was copied with `toConfig()` after another runtime generated its relation
   * resolver, keeping the generated resolver or its extensions. A list or embedded relation to an unregistered type throws
   * `UNREGISTERED_RELATION_TARGET` (500). A writable non-embedded list relation without a
   * non-empty child `connectionField`, whose resolver this runtime would generate, throws
   * `INVALID_MODEL` (400) before `adapter.prepare()`; one with an application resolver or
   * `readOnly` only logs a `Configuration issue` warning, and its nested writes fail with
   * `INVALID_MODEL` (500). Fields named like generated query arguments also log a warning. The
   * first schema binds the types whose relation resolvers it generates to this runtime and
   * reserves reachable types that still have a
   * non-embedded relation field without a resolver, such as an unregistered custom mutation result.
   * Every entity type resolves `id` to `_id ?? id`, whatever the allowlists include.
   */
  createSchema(includedQueryTypes?: GraphQLObjectType[] | null, includedMutationTypes?: GraphQLObjectType[] | null, includedCustomMutations?: string[] | null): GraphQLSchema;
  getModel(type: GraphQLObjectType | { name: string }): Model | null | undefined;
  getType(name: string | { name: string }): GraphQLObjectType | null | undefined;
  /** Available after createSchema has built input types. */
  getInputType(type: GraphQLObjectType | { name: string }): GraphQLInputObjectType | undefined;
  getRegistrations(): RuntimeRegistration<Model, Session>[];
  /**
   * Middleware runs in registration order before the operation. Throws `INVALID_MIDDLEWARE`
   * (500) for a non-function. The rest of the chain runs at most once and is awaited even when a
   * middleware does not await `next()`; its errors cancel the operation, even if a middleware
   * catches them. Call `next()` before the middleware returns or its promise settles: a later
   * call, such as `setTimeout(next)`, does nothing. Omitting `next()` skips the remaining
   * middleware only.
   */
  use(middleware: (params: MiddlewareContext, next: () => Promise<void>) => void | Promise<void>): void;
  registerMutation(name: string, description: string, input: GraphQLInputObjectType | null | undefined, output: GraphQLOutputType, callback: (args: any, session: Session, context: any) => any): void;
  /** Owns the full workflow transaction unless an active caller session is supplied. */
  saveObject(typeName: string, args: Record<string, any>, session?: Session, context?: any): Promise<any>;
  preventCreatingCollection(prevent: boolean): void;
}

/** Driver adapter contract. GraphQL generation and lifecycle live in createRuntime. */
export interface DatabaseAdapter<Model = any, Session = any> {
  bind?(runtime: Pick<Runtime<Model, Session>, 'getModel' | 'getType' | 'getRegistrations'>): void;
  validateRegistration?(registration: RuntimeRegistration<Model, Session>): void;
  prepare?(registrations: RuntimeRegistration<Model, Session>[], options: { createCollection: boolean }): void;
  createModel(type: GraphQLObjectType, callback: ((model: Model) => void) | null | undefined, options: { createCollection: boolean }): Model;
  /**
   * Casts a reference or batch key to the stored identifier type. Throw a `SimfinityError` with
   * code `NOT_VALID_ID` (400) for a malformed value; never create a new identifier. A batched
   * reference read whose ID throws or is normalized reads that ID alone with `getById`. When
   * `getById` rejects a stored reference with that error, the generated reference field fails with
   * an `InternalServerError` whose cause is that error, since the client did not send the value.
   */
  castId(value: any): any;
  stateValue?(state: { name: string; value: any }): any;
  withTransaction<T>(session: Session | null | undefined, callback: (session: Session) => Promise<T> | T, model?: Model): Promise<T>;
  newRecord(model: Model, data: any, session?: Session): any;
  saveRecord(model: Model, record: any, session?: Session): any;
  toObject(record: any): any;
  /**
   * Optional. When defined, every nullable, singular embedded object field without a resolver
   * passes its value through `readEmbeddedValue(value)`. The field is read as graphql's default
   * resolver reads it: a method on the parent is called with (args, context, info), and the hook
   * receives its result once a returned promise settles. Return null for a value that a hydrated
   * record renders as an object although the stored value is an explicit null; return any other
   * value unchanged. It must depend only on the value: these resolvers read no data and do not bind
   * their types, so a runtime that reaches a shared type may read through another runtime's hook.
   */
  readEmbeddedValue?(value: any): any;
  getById(model: Model, id: any, session?: Session | null, options?: { projection?: Record<string, number>; plain?: boolean; lock?: boolean; requiredId?: any; context?: any }): any;
  /** Optional batch read: the records found for `ids`, in getById shape and any order. After a failure, the runtime reads each ID with getById. */
  getByIds?(model: Model, ids: any[], options?: { context?: any }): any;
  prepareUpdate(set: Record<string, any>, unset: Record<string, string>): any;
  update(model: Model, id: any, changes: any, session?: Session): any;
  delete(model: Model, id: any, session?: Session): any;
  find(model: Model, type: GraphQLObjectType, args: any, session?: Session | null, options?: { requiredId?: any; context?: any }): any;
  count(model: Model, type: GraphQLObjectType, args: any, session?: Session | null): Promise<number> | number;
  aggregate(model: Model, type: GraphQLObjectType, args: any, session?: Session | null): any;
  findChildren(model: Model, type: GraphQLObjectType, connectionField: string, parentId: any, args: any, session?: Session | null): any;
}
export function createRuntime<Model = any, Session = any>(adapter: DatabaseAdapter<Model, Session>): Runtime<Model, Session>;

export type QueryPredicate = { kind: 'predicate'; path: string[]; operator: string; value: any } | { kind: 'and' | 'or'; terms: QueryPredicate[] };
export interface QueryPlan {
  entity: string;
  where: QueryPredicate | null;
  mode: 'find' | 'count' | 'aggregate';
  sort: Array<{ path: string[]; order: 'ASC' | 'DESC' }>;
  pagination: { limit: number; offset: number } | null;
  aggregation?: { groupId: string[]; facts: Array<{ path: string[]; factName: string; operation: 'SUM' | 'COUNT' | 'AVG' | 'MIN' | 'MAX' }> };
}
export function createQueryPlan(models: ModelDescription, entityName: string, input?: Record<string, any>, options?: { mode?: QueryPlan['mode'] }): QueryPlan;
export function resolveModelPath(models: ModelDescription, entityName: string, path: string | string[]): FieldDescription[];

export function configureQueryLimits(options?: { maxPageSize?: number }): void;
/**
 * Same process-wide setting as `Runtime.configureMutationLimits`. Unknown or misspelled options
 * throw `INVALID_MUTATION_LIMITS` (400) and keep the current limit.
 */
export function configureMutationLimits(options?: MutationLimitsOptions): void;
export function paginationStages(pagination: { page: number; size: number } | null | undefined, withDefault: boolean): Array<{ $skip: number } | { $limit: number }>;

/** Envelop-style schema plugin used by the shared authorization helpers. */
export interface EnvelopSchemaPlugin {
  onSchemaChange?: (payload: {
    schema: GraphQLSchema;
    replaceSchema: (schema: GraphQLSchema) => void;
  }) => void;
  [key: string]: unknown;
}

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
  /**
   * Copies the pattern when the helper is created and tests each value from its first character,
   * so `g` and `y` keep no state between values. Throws `TypeError` unless the pattern is a
   * `RegExp` or a string.
   */
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
 * Shared scalars (packages/core/src/scalars.js default export)
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
  /** Same pattern rules as `validators.pattern`: a private copy, tested from the first character. */
  createPatternStringScalar(name: string, pattern: RegExp | string, message?: string): GraphQLScalarType;
};

/* ========================================================================== *
 * Shared auth (packages/core/src/auth/index.js default export)
 * ========================================================================== */

/** A rule function: only true/void allows; all other values deny (or throw). */
export type AuthRuleFunction = (
  parent: any,
  args: any,
  ctx: any,
  info: any,
) => boolean | void | Promise<boolean | void>;

/** Declarative policy expression (JSON AST or boolean). The complete AST is validated at runtime. */
export type PolicyExpression = boolean | Record<string, unknown>;

/** A rule: function, nonempty nested array of rules (AND), or a policy expression. */
export type AuthRule = AuthRuleFunction | AuthRule[] | PolicyExpression;

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
  /**
   * Wraps schema resolvers in-place. Throws TypeError for invalid rules, maps, or defaultPolicy.
   * `onSchemaChange` throws TypeError, before wrapping any field, when a schema type was created
   * by another copy of the graphql module.
   */
  createAuthPlugin(permissions: PermissionSchema, options?: AuthPluginOptions): EnvelopSchemaPlugin;
  /** @deprecated Use createAuthPlugin instead. graphql-middleware compatible middleware. */
  createAuthMiddleware(
    permissions: PermissionSchema,
    options?: AuthPluginOptions,
  ): (resolve: any, parent: any, args: any, ctx: any, info: any) => Promise<any>;
  /**
   * @deprecated Use createAuthPlugin instead. The same graphql-middleware function as
   * createAuthMiddleware, which applies wildcard rules and the default policy to every field.
   */
  createFieldMiddleware(
    permissions: PermissionSchema,
    options?: AuthPluginOptions,
  ): (resolve: any, parent: any, args: any, ctx: any, info: any) => Promise<any>;
  resolvePath(obj: any, pathOrFn: string | ((obj: any) => any)): any;
  /**
   * Paths in the helpers below are dotted strings or synchronous extractors. An `async`
   * extractor throws TypeError when the helper is created; a path that yields a promise or other
   * thenable denies with TypeError.
   */
  requireAuth(userPath?: string | ((ctx: any) => unknown)): AuthRuleFunction;
  /** Required roles must be nonempty strings; invalid configuration throws TypeError. */
  requireRole(
    role: string | string[],
    options?: { userPath?: string | ((ctx: any) => unknown); rolePath?: string | ((user: any) => unknown) },
  ): AuthRuleFunction;
  /** Exact array membership; only a standalone '*' claim grants all permissions. */
  requirePermission(
    permission: string | string[],
    options?: { userPath?: string | ((ctx: any) => unknown); permissionsPath?: string | ((user: any) => unknown) },
  ): AuthRuleFunction;
  /** Requires at least one rule function; throws TypeError otherwise. */
  composeRules(...rules: AuthRuleFunction[]): AuthRuleFunction;
  /** Requires at least one rule function; throws TypeError otherwise. */
  anyRule(...rules: AuthRuleFunction[]): AuthRuleFunction;
  /** Compares nonempty string, finite number, or MongoDB ObjectId identities; missing IDs deny. */
  isOwner(
    ownerField?: string | ((parent: any) => unknown),
    userIdField?: string | ((user: any) => unknown),
    options?: { userPath?: string | ((ctx: any) => unknown) },
  ): AuthRuleFunction;
  createRule(predicate: AuthRuleFunction, errorMessage?: string, errorCode?: string): AuthRuleFunction;
  allow(): AuthRuleFunction;
  deny(message?: string): AuthRuleFunction;
  /**
   * Invalid ASTs and unresolved comparisons deny, including under negation. Dates compare by
   * time. Promise operands are always invalid; NaN and Date/non-Date comparisons are invalid
   * except against `null`, which stays comparable with any value (the comparison is false).
   */
  evaluateExpression(expression: unknown, context: any): boolean;
  isPolicyExpression(value: unknown): boolean;
  /** Throws TypeError for a malformed expression. */
  createRuleFromExpression(expression: PolicyExpression): AuthRuleFunction;
  UnauthenticatedError: typeof UnauthenticatedError;
  ForbiddenError: typeof ForbiddenError;
  createAuthError(message: string, code?: string): SimfinityError;
};

/* ========================================================================== *
 * Shared plugins (packages/core/src/plugins.js default export)
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
