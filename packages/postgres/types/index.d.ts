import type { ModelRegistration, Runtime } from '@simtlix/simfinity-core';
import type { SQLPlugin } from '@simtlix/simfinity-sql';
import { auth, plugins, scalars, validators } from '@simtlix/simfinity-core';
import type { GraphQLObjectType } from 'graphql';
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
  /** Row events the trigger fires on; omitted means INSERT, UPDATE and DELETE. Only the `refreshTriggers: 'perRoot'` guard trigger sets it. */
  events?: Array<'INSERT' | 'UPDATE' | 'DELETE'>;
  /** A WHEN condition on the row; only the `refreshTriggers: 'perRoot'` guard trigger sets it. */
  when?: string;
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
export function describeDatabase(registrations: ModelRegistration[], options?: { schema?: string } & Pick<PostgresConfiguration, 'refreshTriggers' | 'ownerIndexes'>): DatabaseDescription;
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
  /** Protected entities require changes.version; version:false ignores that field and does not advance it. */
  update(id: string, changes: Record<string, any>, options?: { session?: PostgresSession; version?: false }): Promise<PostgresRecord | null>;
  /** Protected entities require the version read, or false to bypass the version precondition. */
  delete(id: string, options?: { session?: PostgresSession; version?: number | false }): Promise<PostgresRecord | null>;
}
export interface PostgresConfiguration {
  pool: PostgresPool;
  schema?: string;
  /** Defaults to true: the owned rows of an embedded list are inserted with multi-row INSERT statements. `false` keeps one INSERT per row. */
  multiRowInserts?: boolean;
  /**
   * Defaults to false: sorts on `id` and required root fields omit the NULLS clause, so the primary key and declared
   * indexes can return them in order. `true` keeps the explicit NULLS clause on every sort term, as 3.5.9 did.
   */
  explicitNullsOrder?: boolean;
  /**
   * Defaults to false: each generated collection field is read with its own statement, as 3.6.0 did. `true` reads the
   * collection fields of many parents that share their arguments with one statement per 100 parents, a UNION ALL of
   * each parent's own statement with its parent ID as a parameter of its own, so PostgreSQL plans each parent's rows
   * for that parent's ID. A batch runs in one repeatable-read transaction, each of its statements right after
   * `SET LOCAL jit = off`, because the batch's plan can cross jit_above_cost when no per-parent plan does.
   * Each parent gets the same rows as before when its order is total, such as a sort that ends in `id`; PostgreSQL
   * does not promise an order for unsorted rows and rows with equal sort keys, which can then come in another order,
   * and on a page that does not hold all of them, other such rows can fill it. Any value other than `true` keeps the
   * default.
   */
  batchedCollections?: boolean | undefined;
  /**
   * Defaults to 'perRow', as 3.5.9: the deferred triggers of a root with owned tables or unique lists refresh its owned
   * shape and unique keys once per changed row. 'perRoot' refreshes each changed root once per transaction while its
   * guard trigger stays deferred, the default (under SET CONSTRAINTS ALL IMMEDIATE, once per changed row). It applies
   * to roots created while it is set: initialization keeps each existing root on the layout its database has, and
   * accepts both. An unknown value throws INVALID_DATABASE_SCHEMA (400) from createSchema or describeDatabase.
   */
  refreshTriggers?: 'perRow' | 'perRoot';
  /**
   * Defaults to 'all', as 3.5.9. 'minimal' does not create the (__owner_id) index of owned and guard tables, which their
   * primary key or a unique index covers; keys tables keep theirs. Existing indexes are kept and accepted. An unknown
   * value throws INVALID_DATABASE_SCHEMA (400) from createSchema or describeDatabase.
   */
  ownerIndexes?: 'all' | 'minimal';
}
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
   * initialization makes it unavailable. When the database still holds storage of a field that is now virtual (`extensions.virtual`), such as its column,
   * the SCHEMA_MISMATCH (409) message also names the field and gives the migration.
   */
  initializeDatabase(options?: InitializationOptions): Promise<InitializationResult>;
  withTransaction<T>(session: PostgresSession | null | undefined, callback: (session: PostgresSession) => Promise<T> | T): Promise<T>;
}
/**
 * PostgreSQL 15+ plugin for createSQL; omitted options allow later runtime.configure. Its `queryFeatures` lists every
 * `QLOperator` value. The case-insensitive text operators fold case with {@link caseFoldExpression}, which needs a UTF8
 * database with the ICU collation `und-x-icu`: on another database, such as one in LATIN1 or on a server built without
 * ICU, they fail with UNSUPPORTED_QUERY (400), and every other operation works.
 *
 * `IS_EMPTY` and `IS_NOT_EMPTY` compile from where a path is stored, binding no parameters: `(c IS NULL OR c = '')`
 * for a String column and `c IS NULL` for any other, the uuid identity included; `COALESCE(cardinality(c), 0) = 0`
 * for a native array; jsonb members as text without a cast, and jsonb lists through a `jsonb_typeof` guard; an
 * embedded object as missing, JSON `null`, or every stored member empty; and owned objects and lists through their
 * state column and a `NOT EXISTS` subquery on the owned table, null list items counting as items. `IS_NOT_EMPTY` is
 * the positive form of a leaf, which a btree can serve, and the `NOT` of an object or owned form.
 *
 * The plugin declares `queryFeatures.quantifiers: true`: collection filters become correlated EXISTS frames,
 * preserving one parent row, and explicit ANY/NONE/ALL frames also admit single references. Client frames and
 * crossings apply target find scopes; trusted frames read stored data. ALL uses NOT EXISTS with a two-valued
 * failing body (null operands fail ordering comparisons), and an absent body is TRUE. A frame's aliases and
 * scope/body joins are local to its subquery. Aggregate anchors share the joins of groupId and facts; filters
 * whose collection prefixes are already joined keep their multiplicity. A reference reached through an embedded
 * list keeps its vector join when the target scope is null, including after a restricted prefix; a non-null
 * target scope there is FORBIDDEN_FILTER_PATH (403). Sorting through a collection is invalid.
 *
 * The plugin also declares `queryFeatures.referenceEmptiness`. A client's condition reads as missing every record that
 * the target's `find` scope hides. The references it crosses share the plain `LEFT JOIN` of other conditions while
 * the scopes crossed so far add nothing; from the first scope that adds conditions on, each crossing is a
 * `LEFT JOIN LATERAL (... LIMIT 1)` that admits the target only where its own scope admits it, and later hops
 * correlate to that join even when their own scope adds nothing. A reference end or member whose scope adds
 * conditions is a `NOT EXISTS` subquery with that scope (`EXISTS` for `IS_NOT_EMPTY`); one whose scope adds nothing
 * compiles to `"ref" IS NULL` (`IS NOT NULL`), as a trusted one does. A collection end or member is always a
 * `NOT EXISTS` subquery (`EXISTS`) on the child's connection column, with the scope only when it adds conditions.
 * Scope values are parameters, and the target's `id` after a reference is its uuid key, under the null rule.
 * Conditions from middleware and scopes read stored data: a reference is empty when its column is `NULL`, which its
 * foreign key, validated and not deferred, keeps exact, a collection through `NOT EXISTS` on the child's column, and
 * a leaf through a plain `LEFT JOIN`. A session that defers the foreign keys (`SET CONSTRAINTS ... DEFERRED`) can see
 * a dangling reference as not empty in the `"ref" IS NULL` form, trusted or client, until it commits.
 */
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
/**
 * The SQL text with which ILIKE, ISTARTS_WITH, IENDS_WITH and IEQ fold both sides of their comparison, for an SQL
 * expression such as a quoted column name or a jsonb member: `translate(lower((<expression>) COLLATE
 * "pg_catalog"."und-x-icu"), '<22 characters>', '<their simple case foldings>')`, the Unicode simple case foldings that
 * MongoDB's case-insensitive matching applies. Indexes serve these operators only on exactly this expression, so build
 * them with it, for example `CREATE INDEX ... (${caseFoldExpression('"name"')} text_pattern_ops)` or
 * `CREATE INDEX ... (${caseFoldExpression('"details" ->> \'label\'')})`. The expression is inserted as given, in
 * parentheses, so that COLLATE applies to all of it; pass trusted SQL, never request input. Throws a TypeError for
 * anything other than a non-empty string.
 */
export function caseFoldExpression(sqlExpression: string): string;
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
export const registerCustomQuery: PostgresRuntime['registerCustomQuery'];
export const registerView: PostgresRuntime['registerView'];
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
