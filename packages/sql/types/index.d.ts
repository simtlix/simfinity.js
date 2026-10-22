import type { FieldDescription, ModelDescription, QueryFeatures, QueryPlan, Runtime } from '@simtlix/simfinity-core';
import { auth, plugins, scalars, validators } from '@simtlix/simfinity-core';
import type { GraphQLField, GraphQLObjectType } from 'graphql';

export {
  auth,
  buildErrorFormatter,
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
  EntityController,
  EnvelopSchemaPlugin,
  FieldValidations,
  FieldValidator,
  FilterCondition,
  FilterGroup,
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
  ViewOptions,
  ViewParam,
  ViewParamType,
  VirtualFieldDeclaration,
  VirtualFieldOptions,
} from '@simtlix/simfinity-core';

/**
 * Guarantees a plugin provides. Planning never requires `singleStatementReads`: a plugin advertises it when one
 * statement reads one consistent snapshot without a transaction and `rollback` resolves on a connection with no open
 * transaction, and sessionless reads that one statement answers then run on one acquired connection without `begin`
 * and `commit`.
 */
export type SQLCapability = 'optimisticConcurrency' | 'transactions' | 'foreignKeys' | 'deferredForeignKeys' | 'embeddedValues' | 'ownedRecords' | 'scalarLists' | 'uniqueValues' | 'nullableUnique' | 'singleStatementReads';
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
/** The children of many parents in one statement, from `compileChildrenQuery`. */
export interface SQLChildrenStatement extends SQLStatement {
  /** Result column holding the 1-based position, in `extra.ids`, of the parent each row belongs to. */
  parentColumn: string;
  /**
   * Optional statements the adapter runs, in order, on the same connection right before this statement, such as
   * settings scoped to the transaction (PostgreSQL's `SET LOCAL`). When any statement of a batch has setup, the whole
   * batch, owned-row hydration included, runs in one transaction from the driver's `begin` to its `commit`, even for
   * types without owned tables. Their rows are ignored. A value that is not a list of statements makes the batch fail
   * with a TypeError, and the runtime then reads each parent with `compileQuery`. `null` or an absent value means no setup.
   */
  setup?: readonly SQLStatement[] | null;
}
/**
 * Optional plugin member for batched collection reads: one statement that runs, for each parent in `extra.ids`, the
 * find statement the paired `compileQuery` returns for `{ column, id }`, with exactly its rows in the same order, and
 * tags each row with its parent's 1-based position in `parentColumn`, optionally with `setup` statements to run before
 * it in its transaction. It receives only paginated find plans and 1 to 100 distinct cast IDs, and the bound
 * configuration, or null when there is none, as its last argument. The adapter uses it only with
 * `batchedCollections: true`.
 */
export interface SQLChildrenQueryCompiler<
  Configuration extends object = SQLConfiguration,
  Description extends SQLDatabaseDescription = SQLDatabaseDescription,
  Id = string,
> {
  (models: SQLModelDescription, description: Description, plan: QueryPlan, extra: { column: string; ids: Id[] }, configuration?: Configuration | null): SQLChildrenStatement;
  /**
   * The `compileQuery` whose per-parent statements this compiler reproduces. The runtime uses the compiler only when
   * this is the plugin's own `compileQuery`, so a plugin copy that overrides `compileQuery` reads each parent with it.
   */
  readonly compileQuery?: (models: SQLModelDescription, description: Description, plan: QueryPlan, extra?: { column: string; id: Id } | null, configuration?: Configuration | null) => SQLCompiledQuery;
}
/**
 * A SQL plugin's query language features: core's `QueryFeatures`, optionally tied to the `compileQuery` they describe,
 * as a `compileChildrenQuery` names the `compileQuery` it reproduces. `referenceEmptiness` may be null, which means
 * false like undefined; any other value that is not a boolean throws `INVALID_SQL_PLUGIN` (400). The adapter's
 * bound `queryFeatures` holds `referenceEmptiness: true` only when the declaration holds and says true.
 */
export interface SQLQueryFeatures<
  Configuration extends object = SQLConfiguration,
  Description extends SQLDatabaseDescription = SQLDatabaseDescription,
  Id = string,
> extends QueryFeatures {
  /**
   * The `compileQuery` these features describe. The declaration holds only when this is the plugin's own
   * `compileQuery`, so a plugin copy that overrides `compileQuery` compiles the operators of 3.7.0 until it declares
   * its own features. Without it, the declaration describes whichever `compileQuery` the plugin has. A value that is
   * not a function throws `INVALID_SQL_PLUGIN` (400).
   */
  readonly compileQuery?: ((models: SQLModelDescription, description: Description, plan: QueryPlan, extra?: { column: string; id: Id } | null, configuration?: Configuration | null) => SQLCompiledQuery) | undefined;
}
export interface SQLQueryResult {
  rows: Array<Record<string, unknown>>;
  rowCount?: number | null;
}
export type SQLRecordOperation<Table extends SQLTableDescription = SQLTableDescription, Id = string> =
  | { kind: 'selectById'; table: Table; id: Id; lock?: boolean }
  | { kind: 'selectOwned'; table: Table; ids: Id[]; ordered: boolean }
  | { kind: 'insert'; table: Table; data: Record<string, unknown> }
  | { kind: 'update'; table: Table; id: Id; data: Record<string, unknown>; version?: { column: string; expected: number } }
  | { kind: 'deleteById'; table: Table; id: Id; version?: { column: string; expected: number } }
  | { kind: 'deleteOwned'; table: Table; ownerId: Id };
/** Owned rows of one table that share their columns in the same order; no result rows are needed. */
export interface SQLInsertManyOperation<Table extends SQLTableDescription = SQLTableDescription> {
  kind: 'insertMany';
  table: Table;
  rows: Array<Record<string, unknown>>;
}
export interface SQLConfiguration {
  schema?: string;
  /**
   * Defaults to true: with a plugin that has `compileRecordBatch` and `maxRecordBatchValues`, the owned rows of
   * a write are inserted with multi-row statements. `false` keeps one INSERT per owned row.
   */
  multiRowInserts?: boolean;
  /**
   * Defaults to false: the adapter has no `findChildrenBatch`, so each generated collection field reads with
   * `findChildren`, as 3.6.0 did. Only `true`, with a plugin whose `compileChildrenQuery` is paired with its
   * `compileQuery`, reads the collection fields of many parents that share their arguments with one statement per 100
   * parents, after the statement's `setup`; any other value keeps the default.
   */
  batchedCollections?: boolean | undefined;
}
/**
 * Plugins receive only `create`, `validate` or no mode. Before calling the plugin, a runtime that allows creation rejects
 * any other mode with INVALID_INITIALIZATION_MODE (400); a validation-only runtime validates when the mode is missing or
 * false and rejects every other mode except `validate` with DATABASE_CREATION_DISABLED (409).
 */
export interface SQLInitializationOptions { mode?: 'create' | 'validate' }
export interface SQLInitializationResult { mode: 'create' | 'validate'; created: string[] }
/**
 * Where a virtual field (`extensions.virtual`) would hold storage, had it any. Virtual fields store nothing and
 * the description has none of them; a plugin uses the location only to name a field whose storage from before it
 * became virtual is still in a database, such as a column of `table`.
 */
export interface SQLVirtualFieldLocation {
  /** The table of the type that declares the field: its entity's table, or the owned table of an embedded value. */
  table: string;
  /** Storage names of the embedded values between a column of `table` and the field, outermost first; empty for a field of the table itself. */
  path: string[];
  /** The field as `Type.field`. */
  field: string;
  /** The field's name. */
  name: string;
}
/** Passed to `initialize` only when the runtime's types declare virtual fields; otherwise `initialize` receives three arguments. */
export interface SQLInitializationContext { virtualFields: SQLVirtualFieldLocation[] }
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
  /** `client` is the connection of a transaction or of a single-statement read; counts and aggregates omit it. */
  query(configuration: Configuration, statement: SQLStatement, client?: Client): Promise<Result>;
  acquire(configuration: Configuration): Promise<Client>;
  begin(client: Client): void | Promise<unknown>;
  /** Must reject when the engine did not commit, for example when it rolled the transaction back instead. The rejection is retried only when `isRetryable` accepts it. */
  commit(client: Client): void | Promise<unknown>;
  /** Also called outside a transaction on the connection of a failed single-statement read, to probe it: resolve when the connection is usable, reject when it is not. */
  rollback(client: Client): void | Promise<unknown>;
  /**
   * Receives the rollback failure when ROLLBACK did not complete, including the probe after a failed single-statement read;
   * the driver must then discard the connection instead of reusing it.
   */
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
  /**
   * Optional: the query language features `compileQuery` and `compileChildrenQuery` compile. `operators` lists the
   * `QLOperator` values they compile, including `EQ`, which a condition without an operator means; names Simfinity
   * does not know are ignored. Without it, the plugin compiles the operators of 3.7.0 (`EQ`, `NE`, `LT`, `LTE`, `GT`,
   * `GTE`, `BTW`, `IN`, `NIN` and `LIKE`). The runtime, and the query plans of reads that do not go through it, reject
   * any other operator with `UNSUPPORTED_QUERY` (400) before compiling. A value that is not an object whose `operators`
   * is an array of strings throws `INVALID_SQL_PLUGIN` (400). A declaration whose `compileQuery` is another function
   * than this plugin's `compileQuery`, as in a copy that overrides it, gives the operators of 3.7.0.
   *
   * A plugin that declares `IS_EMPTY` and `IS_NOT_EMPTY` receives their predicates as
   * `{ kind: 'predicate', path, operator, value: null }`, whose `path` may end at an embedded object, an embedded list
   * or a scalar list as well as at a scalar, after `createQueryPlan` has applied their checks; it compiles the
   * emptiness of the record's own fields described by `QueryOperator`, and builds `IS_NOT_EMPTY` as its exact
   * complement. Emptiness through references and collections fails with `UNSUPPORTED_QUERY` (400) in the plans
   * unless the declaration also says `referenceEmptiness: true`, under the same `compileQuery` rule as `operators`.
   *
   * With `referenceEmptiness: true`, an emptiness predicate's `path` may also cross single references and end at a
   * reference or a collection, and an embedded object may have reference and collection members. A predicate without
   * `scopes` comes from trusted code (middleware, scopes, direct calls) and reads stored data: a reference is empty
   * when it points to no record, a collection when no child points to the record, and a leaf through a reference
   * reads that record's value. A predicate with `scopes` is a client's: `scopes` has one key per dotted path that it
   * crosses (each a join that admits the target only where the predicate there admits it), and per reference or
   * collection end and member (each restricted to the records the predicate admits); each value is a
   * `QueryPredicate` planned on the target entity, or null when the target's scope added nothing, and a record that
   * a scope hides reads as missing. A null hop after a restricted one still reads through that restricted join. A
   * `scopes` that lacks a key for one of those paths must not compile as trusted; `postgresPlugin()` fails such a
   * plan with `DETACHED_CLIENT_FILTER` (500).
   */
  queryFeatures?: SQLQueryFeatures<Configuration, Description, Id> | null | undefined;
  naming: SQLNaming;
  /** Receives the bound configuration, or null when there is none, as its last argument. */
  describeSchema(plan: RelationalPlan, configuration?: Configuration | null): Description;
  initialize(configuration: Configuration, description: Description, options?: SQLInitializationOptions, context?: SQLInitializationContext): Promise<SQLInitializationResult>;
  /** Physical DDL for review or export, returned by `runtime.compileDatabaseSchema()`; storage is created and validated through `initialize`. */
  compileSchema(description: Description): string[];
  /** Receives the bound configuration, or null when there is none, as its last argument. */
  compileQuery(models: SQLModelDescription, description: Description, plan: QueryPlan, extra?: { column: string; id: Id } | null, configuration?: Configuration | null): SQLCompiledQuery;
  /**
   * Optional: batched collection reads, used only with `batchedCollections: true` in the configuration. Bound only when
   * its `compileQuery` property is this plugin's `compileQuery`; otherwise, and when it is absent, each parent's
   * children are read with `compileQuery`. A value that is not a function throws INVALID_SQL_PLUGIN (400).
   */
  compileChildrenQuery?: SQLChildrenQueryCompiler<Configuration, Description, Id> | undefined;
  /**
   * The operation's table is the physical metadata from describeSchema. With optimisticConcurrency,
   * update must atomically match version.expected and increment version.column, even for empty data,
   * and return the updated row. A versioned deleteById must condition on that version and return its row.
   */
  compileRecord(description: Description, operation: SQLRecordOperation<Description['tables'][number], Id>): SQLStatement;
  /**
   * Optional, with `maxRecordBatchValues`: one statement that inserts every row of the operation. The runtime
   * sends a single row through `compileRecord` instead.
   */
  compileRecordBatch?: ((description: Description, operation: SQLInsertManyOperation<Description['tables'][number]>) => SQLStatement) | undefined;
  /** Positive safe integer: the most values (rows times columns) one `compileRecordBatch` statement carries. */
  maxRecordBatchValues?: number | undefined;
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
  /** Protected entities require changes.version; version:false ignores that field and does not advance it. */
  update(id: Id, changes: Record<string, unknown>, options?: { session?: SQLSession<Client, Result>; version?: false }): Promise<SQLRecord<Id> | null>;
  /** Protected entities require the version read, or false to bypass the version precondition. */
  delete(id: Id, options?: { session?: SQLSession<Client, Result>; version?: number | false }): Promise<SQLRecord<Id> | null>;
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
