import type {
  GraphQLEnumType,
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
}

export class InternalServerError extends SimfinityError {
  constructor(message: string, cause?: unknown);
  cause?: unknown;
  getCause(): unknown;
}
export function buildErrorFormatter(callback?: (error: SimfinityError) => Error | void): (error: Error) => Error;

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
}
export interface MiddlewareContext {
  args: any;
  operation: string;
  entry?: string;
  type?: RuntimeRegistration;
  context?: any;
  [key: string]: any;
}
export interface Runtime<Model = any, Session = any> {
  configureQueryLimits(options?: { maxPageSize?: number }): void;
  connect(model: Model | null, type: GraphQLObjectType, singular: string, plural: string, controller?: EntityController<Session> | null, onModelCreated?: ((model: Model) => void) | null, stateMachine?: StateMachine<Session> | null): void;
  addNoEndpointType(type: GraphQLObjectType): void;
  createSchema(includedQueryTypes?: GraphQLObjectType[] | null, includedMutationTypes?: GraphQLObjectType[] | null, includedCustomMutations?: string[] | null): GraphQLSchema;
  getModel(type: GraphQLObjectType | { name: string }): Model | null | undefined;
  getType(name: string | { name: string }): GraphQLObjectType | null | undefined;
  /** Available after createSchema has built input types. */
  getInputType(type: GraphQLObjectType | { name: string }): GraphQLInputObjectType | undefined;
  getRegistrations(): RuntimeRegistration<Model, Session>[];
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
  castId(value: any): any;
  stateValue?(state: { name: string; value: any }): any;
  withTransaction<T>(session: Session | null | undefined, callback: (session: Session) => Promise<T> | T, model?: Model): Promise<T>;
  newRecord(model: Model, data: any, session?: Session): any;
  saveRecord(model: Model, record: any, session?: Session): any;
  toObject(record: any): any;
  getById(model: Model, id: any, session?: Session | null, options?: { projection?: Record<string, number>; plain?: boolean; lock?: boolean; requiredId?: any; context?: any }): any;
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
  /** Wraps schema resolvers in-place. Throws TypeError for invalid rules, maps, or defaultPolicy. */
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
  /** Required roles must be nonempty strings; invalid configuration throws TypeError. */
  requireRole(role: string | string[], options?: { userPath?: string; rolePath?: string }): AuthRuleFunction;
  /** Exact array membership; only a standalone '*' claim grants all permissions. */
  requirePermission(
    permission: string | string[],
    options?: { userPath?: string; permissionsPath?: string },
  ): AuthRuleFunction;
  composeRules(...rules: AuthRuleFunction[]): AuthRuleFunction;
  anyRule(...rules: AuthRuleFunction[]): AuthRuleFunction;
  /** Compares nonempty string, finite number, or MongoDB ObjectId identities; missing IDs deny. */
  isOwner(ownerField?: string, userIdField?: string, options?: { userPath?: string }): AuthRuleFunction;
  createRule(predicate: AuthRuleFunction, errorMessage?: string, errorCode?: string): AuthRuleFunction;
  allow(): AuthRuleFunction;
  deny(message?: string): AuthRuleFunction;
  /** Invalid ASTs and unresolved comparisons deny, including under negation. */
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
