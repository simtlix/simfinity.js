import type { FieldDescription, ModelDescription, QueryPlan, Runtime } from '@simtlix/simfinity-core';
import { auth, plugins, scalars, validators } from '@simtlix/simfinity-core';
import type { GraphQLField, GraphQLObjectType } from 'graphql';

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

export type SQLCapability = 'transactions' | 'foreignKeys' | 'deferredForeignKeys' | 'embeddedValues' | 'ownedRecords' | 'scalarLists' | 'uniqueValues' | 'nullableUnique';
/** Core field metadata enriched by SQL runtime preparation. */
export interface SQLFieldDescription extends FieldDescription {
  fields?: SQLFieldDescription[];
  /** Registered state enum names paired with String(enumValue) storage values. SQL runtimes require state machine fields to be enums. */
  stateNames?: Array<{ value: string; name: string }>;
}
export interface SQLModelDescription extends ModelDescription {
  entities: Array<Omit<ModelDescription['entities'][number], 'fields'> & { fields: SQLFieldDescription[] }>;
}
export type RelationalScalar = NonNullable<SQLFieldDescription['scalar']> | 'Embedded';
/** Serializable field metadata: GraphQL enum runtime values are deliberately omitted. */
export interface RelationalField extends Omit<SQLFieldDescription, 'enumValues' | 'fields'> {
  fields?: RelationalField[];
}
export interface SQLNaming {
  /** Throws when an identifier cannot be represented by this engine. */
  validateIdentifier(value: string): void;
  generatedName(...parts: string[]): string;
}
export interface SQLPrimaryKey { name: string; columns: string[] }
export interface SQLForeignKey {
  name: string;
  columns: string[];
  targetTable: string;
  targetColumns: string[];
  onDelete: 'NO ACTION' | 'CASCADE';
  onUpdate: 'NO ACTION';
  deferrable: boolean;
  initiallyDeferred: boolean;
}
export interface SQLOwnership {
  ownerTable: string;
  ownerColumn: string;
  field: string;
  path: string[];
  list: boolean;
  required: boolean;
  nullableItems: boolean;
  stateColumn: string;
}
export interface RelationalColumn {
  name: string;
  scalar: RelationalScalar;
  list: boolean;
  nullable: boolean;
  default?: { kind: 'identity' } | { kind: 'value'; value: string | number | boolean | null };
  presenceColumn?: string;
}
export interface RelationalIndex {
  name: string;
  columns: string[];
  unique: boolean;
  nullsEqual: boolean;
}
export type RelationalCheck = { name: string; column: string } & (
  | { kind: 'presentWhenItem' | 'requiredWhenItem' | 'nonnegative' }
  | { kind: 'state'; values: string[] }
  | { kind: 'embeddedShape'; field: RelationalField }
  | { kind: 'enum'; values: string[]; list: boolean }
  | { kind: 'itemsRequired'; scalar: NonNullable<FieldDescription['scalar']> }
);
export interface RelationalTable {
  name: string;
  columns: RelationalColumn[];
  primaryKey: SQLPrimaryKey;
  foreignKeys: SQLForeignKey[];
  indexes: RelationalIndex[];
  checks: RelationalCheck[];
  ownership?: SQLOwnership;
}
export interface RelationalPlan {
  schema: string;
  tables: RelationalTable[];
  checkOrder: Array<{ table: string; name: string }>;
  uniqueValues: Array<{ table: string; field: RelationalField }>;
  requirements: SQLCapability[];
}
/** Pure planning; no physical SQL types, expressions, driver objects, or I/O. */
export function planRelationalSchema(models: SQLModelDescription, options?: { schema?: string; naming?: SQLNaming }): RelationalPlan;

/** Physical metadata needed by shared record reconstruction. Plugins may extend it. */
export interface SQLColumnDescription {
  name: string;
  presenceColumn?: string;
}
export interface SQLTableDescription {
  name: string;
  columns: SQLColumnDescription[];
  primaryKey: SQLPrimaryKey;
  ownership?: SQLOwnership;
}
export interface SQLDatabaseDescription<Table extends SQLTableDescription = SQLTableDescription> {
  schema: string;
  tables: Table[];
}
export interface SQLStatement { text: string; values?: unknown[] }
export interface SQLCompiledQuery extends SQLStatement {
  /** Group field followed by each fact field, required for aggregate queries. */
  aggregateFields?: SQLFieldDescription[];
}
export interface SQLQueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount?: number | null;
}
export type SQLRecordOperation<Table extends SQLTableDescription = SQLTableDescription, Id = string> =
  | { kind: 'selectById'; table: Table; id: Id; lock?: boolean }
  | { kind: 'selectOwned'; table: Table; ids: Id[]; ordered: boolean }
  | { kind: 'insert'; table: Table; data: Record<string, unknown> }
  | { kind: 'update'; table: Table; id: Id; data: Record<string, unknown> }
  | { kind: 'deleteById'; table: Table; id: Id }
  | { kind: 'deleteOwned'; table: Table; ownerId: Id };
export interface SQLConfiguration { schema?: string }
/**
 * Plugins receive only `create`, `validate` or no mode. Before calling the plugin, a runtime that allows creation rejects
 * any other mode with INVALID_INITIALIZATION_MODE (400); a validation-only runtime validates when the mode is missing or
 * false and rejects every other mode except `validate` with DATABASE_CREATION_DISABLED (409).
 */
export interface SQLInitializationOptions { mode?: 'create' | 'validate' }
export interface SQLInitializationResult { mode: 'create' | 'validate'; created: string[] }
export interface SQLValueCodec<Id = string> {
  /** Any identifier, including `0`; only a stored null, missing value or empty string reads as no reference. */
  createId(): Id;
  /** Throw a `SimfinityError` with code `NOT_VALID_ID` (400) for a malformed value; never create a new identifier. */
  castId(value: unknown): Id;
  encodeScalar(field: SQLFieldDescription, value: unknown): unknown;
  decodeScalar(field: SQLFieldDescription, value: unknown, gqlField?: GraphQLField<unknown, unknown>): unknown;
  encodeEmbedded(value: unknown): unknown;
}
export interface SQLDriver<Configuration extends object = SQLConfiguration, Client = unknown, Result extends SQLQueryResult = SQLQueryResult> {
  /** Called before planning; must reject missing or invalid configuration. */
  assertConfiguration(configuration: Configuration | null): void;
  query(configuration: Configuration, statement: SQLStatement, client?: Client): Promise<Result>;
  acquire(configuration: Configuration): Promise<Client>;
  begin(client: Client): void | Promise<unknown>;
  /** Must reject when the engine did not commit, for example when it rolled the transaction back instead. The rejection is retried only when `isRetryable` accepts it. */
  commit(client: Client): void | Promise<unknown>;
  rollback(client: Client): void | Promise<unknown>;
  /** Receives the rollback failure when ROLLBACK did not complete; the driver must then discard the connection instead of reusing it. */
  release(client: Client, error?: unknown): void | Promise<unknown>;
  /**
   * True only for confirmed transaction aborts safe to replay. Each of up to five retries waits a random delay that starts after `release` completes.
   * Receives any object thrown in an owned transaction or operation, application errors included; never null or a primitive.
   */
  isRetryable(error: unknown): boolean;
  /**
   * Maps errors of this engine and returns every other error unchanged, so application errors propagate as thrown.
   * Never receives a `SimfinityError`, null or a primitive. A failed `acquire`, `begin`, `query` or `commit` returned
   * unchanged becomes `DATABASE_ERROR` (500) with the driver error as its `cause`.
   */
  normalizeError(error: unknown): unknown;
}
/** Version 1 plugin. createSQL snapshots methods/options; connection objects remain caller-owned. */
export interface SQLPlugin<
  Configuration extends object = SQLConfiguration,
  Client = unknown,
  Description extends SQLDatabaseDescription = SQLDatabaseDescription,
  Result extends SQLQueryResult = SQLQueryResult,
  Id = string,
> {
  apiVersion: 1;
  name: string;
  displayName: string;
  defaultSchema: string;
  options: Configuration | null;
  capabilities: readonly string[];
  naming: SQLNaming;
  describeSchema(plan: RelationalPlan): Description;
  initialize(configuration: Configuration, description: Description, options?: SQLInitializationOptions): Promise<SQLInitializationResult>;
  /** Physical DDL for review or export, returned by `runtime.compileDatabaseSchema()`; storage is created and validated through `initialize`. */
  compileSchema(description: Description): string[];
  compileQuery(models: SQLModelDescription, description: Description, plan: QueryPlan, extra?: { column: string; id: Id } | null): SQLCompiledQuery;
  /** The operation's table is the physical metadata from describeSchema. */
  compileRecord(description: Description, operation: SQLRecordOperation<Description['tables'][number], Id>): SQLStatement;
  values: SQLValueCodec<Id>;
  driver: SQLDriver<Configuration, Client, Result>;
}
export interface SQLSession<Client = unknown, Result extends SQLQueryResult = SQLQueryResult> {
  /** Native client, valid only for the lifetime of this transaction. */
  readonly client: Client;
  inTransaction(): boolean;
  query(text: string, values?: unknown[]): Promise<Result>;
}
export interface SQLRecord<Id = string> {
  _id: Id;
  id: Id;
  [field: string]: unknown;
}
export interface SQLModel<Client = unknown, Result extends SQLQueryResult = SQLQueryResult, Id = string> {
  readonly name: string;
  readonly gqltype: GraphQLObjectType;
  findById(id: Id, options?: { session?: SQLSession<Client, Result> }): Promise<SQLRecord<Id> | null>;
  /** Accepts the generated GraphQL list query's filter/sort/pagination arguments. */
  find(args?: Record<string, unknown>, options?: { session?: SQLSession<Client, Result> }): Promise<SQLRecord<Id>[]>;
  /** Native helpers bypass GraphQL validators/controllers; fields use storage names. */
  create(data: Record<string, unknown>, options?: { session?: SQLSession<Client, Result> }): Promise<SQLRecord<Id>>;
  update(id: Id, changes: Record<string, unknown>, options?: { session?: SQLSession<Client, Result> }): Promise<SQLRecord<Id> | null>;
  delete(id: Id, options?: { session?: SQLSession<Client, Result> }): Promise<SQLRecord<Id> | null>;
}
export interface SQLRuntime<
  Configuration extends object = SQLConfiguration,
  Client = unknown,
  Description extends SQLDatabaseDescription = SQLDatabaseDescription,
  Result extends SQLQueryResult = SQLQueryResult,
  Id = string,
> extends Runtime<SQLModel<Client, Result, Id>, SQLSession<Client, Result>> {
  readonly auth: typeof auth;
  readonly plugins: typeof plugins;
  readonly scalars: typeof scalars;
  readonly validators: typeof validators;
  /** Configure once before createSchema, when plugin.options was null. */
  configure(options: Configuration): void;
  describeDatabase(): Description;
  /** The bound plugin's DDL for this runtime's schema, for review or export; it does not touch storage. */
  compileDatabaseSchema(): string[];
  /**
   * Await before executing operations. A request rejected before storage is touched keeps the current readiness; a ready
   * runtime keeps serving while it is initialized again, and any failure of the latest initialization makes it unavailable.
   */
  initializeDatabase(options?: SQLInitializationOptions): Promise<SQLInitializationResult>;
  withTransaction<T>(session: SQLSession<Client, Result> | null | undefined, callback: (session: SQLSession<Client, Result>) => Promise<T> | T): Promise<T>;
}
export function createSQL<
  Configuration extends object,
  Client,
  Description extends SQLDatabaseDescription,
  Result extends SQLQueryResult,
  Id,
>(options: { plugin: SQLPlugin<Configuration, Client, Description, Result, Id> }): SQLRuntime<Configuration, Client, Description, Result, Id>;
