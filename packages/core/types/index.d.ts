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
  /** Participates in a supplied transaction; does not begin one by itself. */
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
  withTransaction<T>(session: Session | null | undefined, callback: (session: Session) => Promise<T> | T): Promise<T>;
  newRecord(model: Model, data: any, session?: Session): any;
  saveRecord(model: Model, record: any, session?: Session): any;
  toObject(record: any): any;
  getById(model: Model, id: any, session?: Session | null, options?: { projection?: Record<string, number>; plain?: boolean; lock?: boolean }): any;
  prepareUpdate(set: Record<string, any>, unset: Record<string, string>): any;
  update(model: Model, id: any, changes: any, session?: Session): any;
  delete(model: Model, id: any, session?: Session): any;
  find(model: Model, type: GraphQLObjectType, args: any, session?: Session | null): any;
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
