import type { ModelRegistration, Runtime } from '@simtlix/simfinity-core';
import type { SQLPlugin } from '@simtlix/simfinity-sql';
import { auth, plugins, scalars, validators } from '@simtlix/simfinity-core';
import type { GraphQLObjectType } from 'graphql';
export {
  auth,
  buildErrorFormatter,
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
  EntityController,
  EnvelopSchemaPlugin,
  FieldValidations,
  FieldValidator,
  ItemValidators,
  MiddlewareContext,
  MutationLimitsOptions,
  PermissionSchema,
  PolicyExpression,
  ScopeFunction,
  ScopeOperation,
  ScopeParams,
  StateMachine,
  TypePermissions,
  TypeScopes,
} from '@simtlix/simfinity-core';

export interface DatabaseColumn {
  name: string;
  type: string;
  collation?: 'C';
  nullable: boolean;
  default?: string;
  /** Private boolean marker; SQL NULL without this marker represents an absent embedded field. */
  presenceColumn?: string;
}
export interface DatabaseForeignKey {
  name: string;
  columns: string[];
  targetTable: string;
  targetColumns: string[];
  onDelete: 'NO ACTION' | 'CASCADE';
  onUpdate: 'NO ACTION';
  deferrable: boolean;
  initiallyDeferred: boolean;
}
export interface DatabaseIndex {
  name: string;
  columns: string[];
  unique: boolean;
  nullsNotDistinct: boolean;
}
export interface DatabaseTable {
  name: string;
  columns: DatabaseColumn[];
  primaryKey: { name: string; columns: string[] };
  foreignKeys: DatabaseForeignKey[];
  indexes: DatabaseIndex[];
  checks: Array<{ name: string; expression: string }>;
  auxiliary?: { rootTable: string; kind: 'guard' | 'uniqueKeys' };
  uniqueKeys?: { rootTable: string; sourceTable: string; field: string };
  ownership?: {
    ownerTable: string;
    ownerColumn: string;
    field: string;
    path: string[];
    list: boolean;
    required: boolean;
    nullableItems: boolean;
    stateColumn: string;
  };
}
export interface DatabaseFunction {
  name: string;
  arguments: string[];
  returns: 'boolean' | 'void' | 'trigger' | 'jsonb' | 'bytea';
  language: 'plpgsql';
  volatility: 'IMMUTABLE' | 'VOLATILE';
  configuration: string[];
  body: string;
}
export interface DatabaseTrigger {
  name: string;
  table: string;
  function: string;
  constraint: boolean;
  deferrable: boolean;
  initiallyDeferred: boolean;
}
export interface DatabaseMaintenance {
  rootTable: string;
  guardTable: string;
  validateFunction: string;
  refreshFunction: string;
}
export interface DatabaseDescription {
  schema: string;
  tables: DatabaseTable[];
  functions: DatabaseFunction[];
  triggers: DatabaseTrigger[];
  maintenance: DatabaseMaintenance[];
}
export interface DatabasePool {
  connect(): Promise<{
    query(sql: string, values?: unknown[]): Promise<{
      rows: any[];
      rowCount: number | null;
      /** Command tag reported by pg, such as `COMMIT`. Wrappers should pass pg's `command` through, so that a COMMIT that PostgreSQL turned into ROLLBACK is detected. */
      command?: string;
    }>;
    /** An error means the connection must be destroyed instead of reused. */
    release(error?: unknown): void;
  }>;
}
/**
 * Low-level describer for any registrations. `options.schema` defaults to `public`, not to the schema
 * of a configured runtime; pass the schema given to configure() or createPostgres().
 */
export function describeDatabase(registrations: ModelRegistration[], options?: { schema?: string }): DatabaseDescription;
/** Describes the default module instance in its configured schema, after configure/connect/createSchema. */
export function describeDatabase(): DatabaseDescription;
/** Accepts a trusted description produced by describeDatabase. */
export function compileDatabaseSchema(description: DatabaseDescription): string[];
/** DDL of the default module instance in its configured schema, after configure/connect/createSchema. */
export function compileDatabaseSchema(): string[];
/** Borrows one pool client; owns its transaction, not the pool lifecycle. PostgreSQL >=15. */
export function initializeDatabase(pool: DatabasePool, description: DatabaseDescription, options?: { mode?: 'create' | 'validate' }): Promise<{ mode: 'create' | 'validate'; created: string[] }>;

export interface DatabaseQueryable {
  query(sql: string, values?: any[]): Promise<{
    rows: any[];
    rowCount: number | null;
    /** Command tag reported by pg, such as `COMMIT`. Wrappers should pass pg's `command` through, so that a COMMIT that PostgreSQL turned into ROLLBACK is detected. */
    command?: string;
  }>;
}
export interface PostgresPool extends DatabasePool, DatabaseQueryable {}
export interface PostgresSession extends DatabaseQueryable {
  /** Native pg client, valid only for the lifetime of this transaction. */
  readonly client: DatabaseQueryable;
  inTransaction(): boolean;
}
export interface PostgresRecord {
  _id: string;
  id: string;
  [field: string]: any;
}
export interface PostgresModel {
  readonly name: string;
  readonly gqltype: GraphQLObjectType;
  findById(id: string, options?: { session?: PostgresSession }): Promise<PostgresRecord | null>;
  /** Uses the same filter/sort/pagination arguments as the GraphQL list query. */
  find(args?: Record<string, any>, options?: { session?: PostgresSession }): Promise<PostgresRecord[]>;
  /** Native helpers bypass GraphQL validators/controllers; references use storage column names. */
  create(data: Record<string, any>, options?: { session?: PostgresSession }): Promise<PostgresRecord>;
  update(id: string, changes: Record<string, any>, options?: { session?: PostgresSession }): Promise<PostgresRecord | null>;
  delete(id: string, options?: { session?: PostgresSession }): Promise<PostgresRecord | null>;
}
export interface PostgresConfiguration { pool: PostgresPool; schema?: string }
export interface InitializationOptions { mode?: 'create' | 'validate' }
export interface InitializationResult { mode: 'create' | 'validate'; created: string[] }
export interface PostgresRuntime extends Runtime<PostgresModel, PostgresSession> {
  readonly auth: typeof auth;
  readonly plugins: typeof plugins;
  readonly scalars: typeof scalars;
  readonly validators: typeof validators;
  /** Bind pool/schema once, before createSchema. The caller owns the pool lifetime. */
  configure(options: PostgresConfiguration): void;
  describeDatabase(): DatabaseDescription;
  /** Physical DDL for this instance's description and schema, for review or export; initializeDatabase does not run it. */
  compileDatabaseSchema(): string[];
  /**
   * Must be awaited before operations execute. Does not synchronize incompatible schemas. A request rejected before
   * storage is touched, such as an unknown mode (INVALID_INITIALIZATION_MODE, 400) or, on a validation-only runtime,
   * a non-empty mode other than validate (DATABASE_CREATION_DISABLED, 409), keeps the current readiness; a ready runtime keeps serving while it is initialized again, and any failure of the latest
   * initialization makes it unavailable.
   */
  initializeDatabase(options?: InitializationOptions): Promise<InitializationResult>;
  withTransaction<T>(session: PostgresSession | null | undefined, callback: (session: PostgresSession) => Promise<T> | T): Promise<T>;
}
/** PostgreSQL 15+ plugin for createSQL; omitted options allow later runtime.configure. */
export function postgresPlugin(options?: PostgresConfiguration): SQLPlugin<
  PostgresConfiguration,
  DatabaseQueryable,
  DatabaseDescription,
  {
    rows: Record<string, unknown>[];
    rowCount: number | null;
    /** Command tag reported by pg, such as `COMMIT`. Wrappers should pass pg's `command` through, so that a COMMIT that PostgreSQL turned into ROLLBACK is detected. */
    command?: string;
  }
>;
export function createPostgres(options?: PostgresConfiguration): PostgresRuntime;
export const configure: PostgresRuntime['configure'];
export const connect: PostgresRuntime['connect'];
export const addNoEndpointType: PostgresRuntime['addNoEndpointType'];
export const createSchema: PostgresRuntime['createSchema'];
export const getModel: PostgresRuntime['getModel'];
export const getType: PostgresRuntime['getType'];
export const getInputType: PostgresRuntime['getInputType'];
export const getRegistrations: PostgresRuntime['getRegistrations'];
export const use: PostgresRuntime['use'];
export const registerMutation: PostgresRuntime['registerMutation'];
export const saveObject: PostgresRuntime['saveObject'];
export const preventCreatingCollection: PostgresRuntime['preventCreatingCollection'];
export const withTransaction: PostgresRuntime['withTransaction'];
/** Initializes the default module instance, after configure/connect/createSchema. */
export function initializeDatabase(options?: InitializationOptions): Promise<InitializationResult>;

export const configureQueryLimits: Runtime['configureQueryLimits'];
/**
 * The same process-wide setter as every runtime's configureMutationLimits. Unknown or misspelled
 * options throw INVALID_MUTATION_LIMITS (400) and keep the current limit.
 */
export const configureMutationLimits: Runtime['configureMutationLimits'];
