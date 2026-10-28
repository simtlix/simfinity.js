import type {
  GraphQLEnumType,
  GraphQLError,
  GraphQLInputObjectType,
  GraphQLList,
  GraphQLNonNull,
  GraphQLObjectType,
  GraphQLOutputType,
  GraphQLScalarType,
  GraphQLSchema,
} from 'graphql';

/** The filter operator enum; its values are the {@link QueryOperator} names. */
export const QLOperator: GraphQLEnumType;
/** The collection and reference quantifier enum. */
export const QLQuantifier: GraphQLEnumType;
export const QLSort: GraphQLInputObjectType;
export const QLValue: GraphQLScalarType<unknown, unknown>;

/**
 * The scalar of the `version` field that Simfinity adds to a type that declares optimistic
 * concurrency (see {@link ConcurrencyDeclaration}). It holds safe integers from 1 to
 * {@link MAX_RECORD_VERSION}, a JSON number on the wire: a string, a float, 0, a negative number and an
 * unsafe integer fail GraphQL coercion. A client sends the version it read back unchanged in updates
 * and deletes, and Simfinity advances it. Only the managed field may use it in a type, which
 * `createSchema()` and `describeModels()` enforce with `INVALID_MODEL` (400); a registered mutation or
 * custom query may use it in its own input and output types. Import it from the facade the application
 * uses: the protection depends on one copy of core per process.
 */
export const RecordVersion: GraphQLScalarType;
/** The highest version, `Number.MAX_SAFE_INTEGER`. The version of a record never goes past it. */
export const MAX_RECORD_VERSION: number;

/**
 * A `QLOperator` value. The operators of 3.7.0 are `EQ`, `NE`, `LT`, `LTE`, `GT`, `GTE`, `BTW`, `IN`,
 * `NIN` and `LIKE`. The literal text operators take a non-null string without U+0000 on a `String`
 * field or `String` list (a validated scalar filters by its base scalar), and match it literally:
 * `ILIKE` as a substring ignoring case, `STARTS_WITH` and `ISTARTS_WITH` as a prefix, `ENDS_WITH`
 * and `IENDS_WITH` as a suffix, respecting or ignoring case, and `IEQ` as the whole value ignoring
 * case. An empty value matches every non-null string, except for `IEQ`, where it matches only the
 * empty string. On a list, some element must match.
 *
 * `IS_EMPTY` and `IS_NOT_EMPTY` take no value (omitted or null; any other value fails with
 * `INVALID_FILTER_VALUE`), and every record matches exactly one of them. `IS_EMPTY` holds for a
 * missing, null or `""` String (`" "` is not empty), a missing or null value of any other scalar or
 * enum, a missing, null or `[]` list (`[null]` and `[""]` are not empty), and a missing or null
 * embedded object or one whose stored members are all empty by these rules; the record identity is
 * never empty. The target's `id` right after a reference is empty exactly when the reference is,
 * including when the target is missing or hidden by its `find` scope. A path that continues inside an
 * embedded list fails with `INVALID_FILTER_PATH`; shorthand through a collection excludes emptiness
 * on a leaf, so use an explicit group. With an adapter that declares
 * `queryFeatures.referenceEmptiness: true`, a path may also cross single references and end at a
 * reference or a collection, and an embedded object may have reference and collection members: a
 * reference is empty when no record it points to exists that the target's `find` scope admits for
 * the caller, a collection when no such child exists, and a hidden record on the way reads as
 * missing; constructs that middleware and scopes add read stored data. With any other adapter they
 * fail with `UNSUPPORTED_QUERY`. A term or group condition without a path tests the field itself, except that every term
 * of a quantified relation filter needs a non-empty element-relative path.
 *
 * `IIN` is `IN` ignoring case: an array of non-null strings without U+0000, possibly empty, on a `String` field or
 * `String` list by its effective scalar; it matches where `IEQ` matches one of them, and `[]` matches nothing.
 * `CONTAINS_ALL` takes a non-empty array of non-null scalars, cast like `IN` elements; it applies to a scalar list or a
 * field reached through embedded lists, where it holds when every value is among the values of all items, and fails
 * with `INVALID_FILTER_OPERATOR` on other leaves and with `INVALID_FILTER_PATH` through a collection or a reference
 * inside an embedded list. Neither has a negated form.
 */
export type QueryOperator =
  | 'EQ' | 'NE' | 'LT' | 'LTE' | 'GT' | 'GTE' | 'BTW' | 'IN' | 'NIN' | 'LIKE'
  | 'ILIKE' | 'STARTS_WITH' | 'ISTARTS_WITH' | 'ENDS_WITH' | 'IENDS_WITH' | 'IEQ'
  | 'IS_EMPTY' | 'IS_NOT_EMPTY' | 'CONTAINS_ALL' | 'IIN';

/** The quantifier applied to the elements visible in a collection or reference frame. */
export type QueryQuantifier = 'ANY' | 'ALL' | 'NONE';

/** A condition inside a filter group, with paths relative to the current frame. */
export interface QLFilterCondition {
  field: string;
  operator?: QueryOperator | null;
  value?: any;
  /** A stored field path, mutually exclusive with a supplied value; null preserves literal behavior. */
  valuePath?: string | null;
  path?: string | null;
}

/** Recursive Boolean groups and quantified frames. */
export interface QLFilterGroup {
  conditions?: Array<QLFilterCondition | null> | null;
  AND?: Array<QLFilterGroup | null> | null;
  OR?: Array<QLFilterGroup | null> | null;
  ANY?: Array<QLQuantifiedGroup | null> | null;
  ALL?: Array<QLQuantifiedGroup | null> | null;
  NONE?: Array<QLQuantifiedGroup | null> | null;
}

/** A frame path ends at a collection or single reference without crossing a list; inner paths are element-relative. */
export interface QLQuantifiedGroup extends QLFilterGroup {
  path: string;
}

/** A quantified field filter may omit terms; every supplied term needs a non-empty element-relative path. */
export interface QLTypeFilterExpression {
  quantifier?: QueryQuantifier | null;
  terms?: Array<{
    operator?: QueryOperator | null;
    value?: any;
    /** A stored field path, mutually exclusive with a supplied value; null preserves literal behavior. */
    valuePath?: string | null;
    path?: string | null;
  } | null> | null;
}

/**
 * A condition of a {@link FilterGroup}, as the `QLFilterCondition` input takes it: the field it
 * tests, its {@link QueryOperator} (`EQ` when omitted) and its value. On an object field, `path`
 * names the member it tests; `IS_EMPTY` and `IS_NOT_EMPTY` take no value and may omit `path` to test
 * the field itself.
 */
export interface FilterCondition {
  field: string;
  operator?: QueryOperator | (string & {});
  value?: any;
  /** A stored field path, mutually exclusive with a supplied value; null preserves literal behavior. */
  valuePath?: string | null;
  path?: string;
}

/** A `QLFilterGroup` value: flat conditions, Boolean groups and element-relative quantified groups. */
export interface FilterGroup {
  ANY?: QLQuantifiedGroup[];
  ALL?: QLQuantifiedGroup[];
  NONE?: QLQuantifiedGroup[];
  AND?: FilterGroup[];
  OR?: FilterGroup[];
  conditions?: FilterCondition[];
}

/**
 * The query language features a {@link DatabaseAdapter} compiles. Declare it so that the runtime
 * sends the adapter only conditions it compiles; later releases add members for later features.
 */
export interface QueryFeatures {
  /**
   * The `QLOperator` values the adapter compiles, including an omitted operator's `EQ`. Names this
   * version of Simfinity does not know are ignored.
   */
  operators: readonly (QueryOperator | (string & {}))[];
  /**
   * Whether the adapter compiles `IS_EMPTY` and `IS_NOT_EMPTY` through single references and at
   * references and collections, including reference and collection members of embedded objects.
   * Undefined or null means false; any other value that is not a boolean fails `createRuntime` with
   * `INVALID_QUERY_FEATURES` (500). An adapter that declares it receives client constructs that carry
   * a filled client scope marker, `__scope: { id, scopes }`, on their term or group condition, and
   * must apply each target scope in `scopes`; constructs without a marker read stored data.
   */
  referenceEmptiness?: boolean | null | undefined;
  /**
   * Whether the adapter compiles quantified frames and their scoped joins. Requires
   * `referenceEmptiness: true`; undefined or null means false. Invalid declarations fail with
   * `INVALID_QUERY_FEATURES` (500). Client markers have frame-relative scope keys; compilers must
   * apply frame scopes before quantification and honour scoped joins/aggregate anchors. Without
   * this flag explicit quantified forms fail with `UNSUPPORTED_QUERY`; collection filters keep
   * legacy joins. All adapters reject list sorts through collections, including count mode.
   */
  quantifiers?: boolean | null | undefined;
  /** Field operands, including scoped references. Requires referenceEmptiness: true. */
  valuePath?: boolean | null | undefined;
  /** Embedded element frames and structural parent operands. Requires all three preceding flags. */
  elementFrames?: boolean | null | undefined;
}

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
  /** `'Version'` is the managed version field of a type that declares optimistic concurrency (`version: true`). */
  scalar?: 'ID' | 'String' | 'Int' | 'Float' | 'Boolean' | 'DateTime' | 'Enum' | 'Version';
  values?: string[];
  enumValues?: { name: string; value: unknown }[];
  /** Logical GraphQL enum identity, required for field comparisons. */
  enumName?: string;
  /** Effective temporal base before storage normalizes Date and Time to DateTime. */
  temporalName?: 'DateTime' | 'Date' | 'Time';
  target?: string;
  connectionField?: string;
  fields?: FieldDescription[];
  private?: boolean;
  inferred?: boolean;
  /**
   * Set on the managed version field of a type that declares optimistic concurrency, which
   * `describeModels()` appends after the type's own fields: `{ name: 'version', scalar: 'Version',
   * required: true, readOnly: true, version: true }`.
   */
  version?: true;
}
export interface ModelDescription {
  entities: Array<{
    name: string;
    gqltype: GraphQLObjectType;
    fields: FieldDescription[];
    indexes: Array<{ fields: string[]; unique: boolean }>;
  }>;
}
/**
 * Describes the stored data of the registered entities and the embedded types they reach. Virtual
 * fields are left out of every entity and embedded type, and the types only they reach are not
 * described. Throws `INVALID_MODEL` (400) for an invalid `extensions.virtual` declaration, as
 * `createSchema()` does (see {@link VirtualFieldOptions}).
 *
 * A type that declares optimistic concurrency (see {@link ConcurrencyDeclaration}) is described with
 * its version field last, before `createSchema()` has added it and after, and the call throws
 * `INVALID_MODEL` (400) for an invalid declaration, for a field named `version` that Simfinity did not
 * add, for a reference stored under `version` (`connectionField: 'version'`), for a collection of
 * such items that links through `version`, for such a type used as an embedded value, and for any
 * other field typed {@link RecordVersion}.
 */
export function describeModels(registrations: ModelRegistration[]): ModelDescription;
/**
 * Options of a virtual field. A field declares itself virtual with `extensions: { virtual: true }` or
 * `extensions: { virtual: { mcp } }` (see {@link VirtualFieldDeclaration}), and must have its own
 * `resolve`, which receives the record, the field's arguments and the request context. No backend
 * stores it, generated inputs leave it out, and it is not part of the query language: list,
 * aggregate and collection fields have no filter argument for it, a client filter, sort, `groupId`
 * or fact path through it fails with `FORBIDDEN_FILTER_PATH` (403), and a path that middleware or a
 * scope adds through it fails with `INVALID_MODEL` (500). Virtual implies `readOnly`, and
 * introspection reads `extensions { readOnly }` as true for it. Any output type may be its
 * result, registered or not; a registered type needs no `relation`, and gets no reference or
 * collection storage and no inferred inverse reference.
 *
 * `createSchema()` and `describeModels()` throw `INVALID_MODEL` (400), naming the type and field, for
 * a value other than `true` or a plain options object, an unknown option, an invalid `mcp` value, a
 * field without its own `resolve`, a field that also declares `relation`, `unique: true`,
 * `validations`, `queryable: true` or `readOnly: false`, an identity field (`id` or `_id`), and for a
 * virtual field named in the type's `extensions.indexes`, used as the `state` field of its state
 * machine, or used as the `connectionField` of a reference or a collection.
 */
export interface VirtualFieldOptions {
  /**
   * How generated MCP tools read the field. `'tool'`, the default, generates a
   * `<byIdQuery>_<field>` read tool for a field with a required argument on a type with a generated
   * by-ID query. `'select'` also lets tools select a field without required arguments below a list
   * position, as in the records of list tools and the items of nested collections, where each item
   * runs its resolver; elsewhere, such as at the top of by-ID results, tools always select it. A
   * field with a required argument still gets its tool. `false` generates no per-field tool, and
   * changes nothing else: by-ID and mutation tools still select a field without required
   * arguments, so for such a field `'tool'` and `false` behave the same.
   */
  mcp?: 'tool' | 'select' | false;
}
/** The value of a virtual field's `extensions.virtual`. */
export type VirtualFieldDeclaration = true | VirtualFieldOptions;
/** A GraphQL field, or its configuration, as far as the virtual field helpers read it. */
export interface VirtualFieldCandidate {
  readonly extensions?: Readonly<{ [name: string]: unknown }> | null;
}
/**
 * Whether a field is virtual: its `extensions.virtual` is `true`, or a plain object whose only key is
 * a valid `mcp`. The GraphQL types that `DatabaseAdapter.prepare()` and `createModel()` receive still
 * contain virtual fields, so an adapter that builds storage from a type's fields skips the fields for
 * which this returns true, on entities and embedded types alike. In a schema that `createSchema()`
 * accepted, every field that declares `extensions.virtual` (other than `undefined`) is virtual,
 * because it rejects every other value.
 */
export function isVirtualField(field: VirtualFieldCandidate | null | undefined): boolean;
/**
 * The normalized options of a virtual field, `{ mcp }` with `mcp` defaulting to `'tool'`, or null
 * when the field is not virtual (see {@link isVirtualField}).
 */
export function virtualFieldOptions(field: VirtualFieldCandidate | null | undefined): Required<VirtualFieldOptions> | null;
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
  /**
   * Set on errors that wrap a driver error, such as TRANSACTION_RETRY_EXCEEDED, and on the PostgreSQL database errors
   * that a SQL runtime maps or reports as DATABASE_ERROR; on those PostgreSQL errors it is not enumerable.
   */
  cause?: unknown;
  /** Set on errors that wrap a driver error, such as TRANSACTION_RETRY_EXCEEDED, and on PostgreSQL database errors; returns `cause`. */
  getCause?(): unknown;
}

/**
 * An unexpected failure: code `INTERNAL_SERVER_ERROR` and status 500 (`getStatus()` and
 * `extensions.status`). `cause` keeps the original error. The cause is never included in GraphQL
 * responses, or in the errors that `buildErrorFormatter` returns when they are serialized. It is an
 * enumerable own property of this error, so `JSON.stringify(error)`, or a logger that copies
 * enumerable properties, includes it.
 */
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
 * Every `InternalServerError` has code `INTERNAL_SERVER_ERROR` and status 500.
 *
 * `callback` receives the classified error; check `error instanceof InternalServerError` to mask
 * unexpected errors. A returned error replaces it, and a returned `GraphQLError` is returned
 * unchanged. The result is a `GraphQLError` that keeps the input's locations and path, has the
 * chosen error as `originalError`, and copies its `extensions`.
 */
export function buildErrorFormatter(callback?: (error: SimfinityError) => Error | void): (error: unknown) => GraphQLError;

export interface AfterCommitErrorDetails {
  committed: true;
  typeName: string;
  operation: 'save' | 'update' | 'delete' | 'state_changed';
  callbackName: 'onSaveCommitted' | 'onUpdateCommitted' | 'onDeleteCommitted' | 'onTransitionCommitted';
  context: any;
}
export interface AfterCommitOptions {
  /** Operational reporting only. Rejections are caught and never fail the committed write. */
  onError?: (error: unknown, details: AfterCommitErrorDetails) => void | Promise<void>;
}
export interface CommittedControllerCallbacks {
  /** After the owning transaction commits; a detached result and the successful attempt's input. */
  onSaveCommitted?(record: any, args: any, context: any): void | Promise<void>;
  onUpdateCommitted?(record: any, context: any): void | Promise<void>;
  /** Called only when a record was actually deleted. */
  onDeleteCommitted?(record: any, context: any): void | Promise<void>;
  /** Exclusive notification for a state action; action is its registered name. */
  onTransitionCommitted?(record: any, action: string, context: any): void | Promise<void>;
}
export interface EntityController<Session = any> extends CommittedControllerCallbacks {
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
 * Value of a type's `extensions.concurrency`: the entity is protected by optimistic concurrency.
 * Simfinity adds a read-only `version: RecordVersion!` field to the type, which starts at 1 and grows
 * by 1 with each accepted write; a client sends the version it read back in updates and deletes, and a
 * write at another version fails with `VERSION_CONFLICT` (409). The only valid value is
 * `{ mode: 'optimistic' }`: `null`, an array, another mode or an extra key throws `INVALID_MODEL`
 * (400). So does a type that is not an entity, one used as an embedded value, one that already has a
 * field named `version` (or a field stored under that name), and an adapter that does not declare
 * `writeFeatures.optimisticConcurrency`.
 */
export interface ConcurrencyDeclaration {
  mode: 'optimistic';
}

/**
 * Process-wide limits for generated mutations. Each call replaces both values: an omitted or
 * `undefined` option restores its default. Any other option, such as a misspelled
 * `maxNestedOperation`, throws `INVALID_MUTATION_LIMITS` (400) and keeps the current limits.
 */
export interface MutationLimitsOptions {
  /**
   * Maximum number of `added`, `updated` and `deleted` entries across every nested level of
   * non-embedded collection fields in one generated mutation. A non-negative safe integer;
   * `null` or omitted means unlimited (the default). The helpers `updateObject` and
   * `transitionObject` apply it to their `input` as the generated mutations do.
   */
  maxNestedOperations?: number | null;
  /**
   * Maximum number of operations in one generated transaction mutation. A positive safe integer;
   * omitted means 100 (the default). `null`, `0`, a negative number or a non-integer throws
   * `INVALID_MUTATION_LIMITS` (400).
   */
  maxTransactionOperations?: number;
}

/**
 * The fourth `createSchema()` argument. Any other key, or a value that is not a plain object,
 * throws `INVALID_SCHEMA_OPTIONS` (500) before models are prepared.
 */
export interface CreateSchemaOptions {
  /**
   * Custom queries to include, by name. `null` or omission includes every registered custom query,
   * `[]` includes none, and names that are not registered are ignored.
   */
  includedCustomQueries?: string[] | null;
  /**
   * Adds one mutation field that runs a list of generated mutations in order in one database
   * transaction. `null` or omission adds none. `name` defaults to `transaction` and must be a GraphQL
   * name that does not start with `__`; it names the field and its types (for `transaction`:
   * `TransactionOperation`, a `@oneOf` input keyed by operation, `TransactionResult` and, for deletes
   * of types without optimistic concurrency, `TransactionDeleteInput`). The operations are the
   * generated add, update, delete and state machine action mutations of `types` that this schema
   * includes; registered mutations never are. `types` is a non-empty array of distinct types registered
   * in this runtime. An invalid option throws `INVALID_SCHEMA_OPTIONS` (500) before models are prepared,
   * or once the generated mutations are built when the field name or a derived type name is taken or
   * no operation remains; a type bound to another runtime throws `TYPE_BOUND_TO_OTHER_RUNTIME` (409),
   * and an adapter without `assertTransactionModels` throws `TRANSACTION_UNSUPPORTED` (500). A failed
   * `createSchema()` keeps no transaction field or type.
   */
  transaction?: { name?: string; types: GraphQLObjectType[] } | null;
}

export interface QueryLimitsOptions {
  /** Positive safe integer; defaults to 1000. Unpaged lists use min(100, maxPageSize). */
  maxPageSize?: number;
  /**
   * Positive safe integer; defaults to 10. The most compiled frames and scoped joins that the
   * client's conditions may need in one list, aggregate or collection-field call; more fail with
   * `FILTER_DEPTH_EXCEEDED` (400), after every client 400 check and before middleware. Units count
   * independently of markers: shorthand per group/prefix, explicit frames separately, scoped joins
   * per containing frame/path/scope chain and emptiness frames per path/shape. Trusted units do
   * not count toward this total. Named views check client arguments and their `where` groups
   * against separate budgets of the same size; the `where` budget runs after middleware.
   */
  maxReferenceFrames?: number;
  /** Positive safe integer; defaults to 3. Maximum client/trusted collection or reference frames on one chain. */
  maxFrameNesting?: number;
}

/**
 * The type of a view parameter: a value the client sends as a variable or a literal, so a scalar,
 * an enum or a list of them, each possibly non-null, never an input object.
 */
export type ViewParamType =
  | GraphQLScalarType
  | GraphQLEnumType
  | GraphQLList<ViewParamType>
  | GraphQLNonNull<GraphQLScalarType | GraphQLEnumType | GraphQLList<ViewParamType>>;

/** A view parameter: an argument of the view's root field that only its `where` reads. */
export interface ViewParam {
  type: ViewParamType;
  description?: string;
  defaultValue?: unknown;
}

/** The declaration of a named view (see {@link Runtime.registerView}). */
export interface ViewOptions {
  /** The connected endpoint type whose list the view returns. */
  type: GraphQLObjectType;
  /** Non-empty; the root field's description. */
  description: string;
  /**
   * Arguments of the root field besides the generated list arguments, named unlike them and unlike
   * the fields of `type`. They never reach the adapter: only `where` receives them.
   */
  params?: Record<string, ViewParam>;
  /**
   * Called on every read with the param values and the request context. The groups it returns are
   * appended to the client's filters after middleware, so neither the client nor middleware can drop
   * them; their paths may name fields that are not queryable.
   */
  where: (input: { params: Record<string, any>; context: any }) => FilterGroup[] | Promise<FilterGroup[]>;
}

export interface Runtime<Model = any, Session = any> {
  /** Per runtime. No arguments resets to safe default logging; invalid options leave it unchanged. */
  configureAfterCommit(options?: AfterCommitOptions): void;
  /** The same process-wide setting as the root `configureQueryLimits`. */
  configureQueryLimits(options?: QueryLimitsOptions): void;
  /**
   * Process-wide; calling it without options restores both defaults (`maxNestedOperations`
   * unlimited, `maxTransactionOperations` 100). Invalid options, including unknown or misspelled
   * option keys, throw `INVALID_MUTATION_LIMITS` (400) and keep the current limits. A generated
   * mutation over the nested limit fails with `NESTED_OPERATIONS_EXCEEDED` (400) before its
   * transaction starts. `updateObject` and `transitionObject` apply `maxNestedOperations` to their
   * `input` in the same way (`null` = no limit).
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
   * `INVALID_MODEL` (500). Fields named like generated query arguments also log a warning. Invalid
   * virtual field declarations throw `INVALID_MODEL` (400) before `adapter.prepare()` (see
   * {@link VirtualFieldOptions}), and a `readOnly` field with arguments and its own resolver that is
   * not virtual, and is not a reference or collection, logs a `Configuration issue` warning once. The
   * first schema binds the types whose relation resolvers it generates to this runtime and
   * reserves reachable types that still have a
   * non-embedded relation field without a resolver, such as an unregistered custom operation result.
   * Every entity type resolves `id` to `_id ?? id`, whatever the allowlists include.
   *
   * A generated input that would have no fields is left out, with a `Configuration issue`
   * warning: the `added` or `updated` operation of a collection whose child has no writable fields
   * for it, an embedded field whose embedded type has none, `add<type>` for a type without
   * writable fields, and `update<type>` and its state actions for a type without writable fields
   * and without a writable `id`. A non-null embedded field whose embedded type has no writable
   * fields throws `INVALID_MODEL` (400) while inputs are built when the generated mutations reach
   * its owner's create input. When the process's first Simfinity schema has an application type
   * named `FieldExtensionsType` or `RelationType`, Simfinity renames its `__Field.extensions`
   * metadata types `SimfinityFieldExtensionsType` and `SimfinityRelationType` (numbered when
   * taken) for every later schema and logs a warning; once those names are fixed, a type with one
   * of them throws `RESERVED_TYPE_NAME` (500), before `adapter.prepare()` when it is an included
   * endpoint type, a registered custom operation's input or output type, an output type they reach or a
   * field argument's type, and when the schema is constructed otherwise, such as for a type inside
   * an input object's fields. The check before `adapter.prepare()` never reads an input object's
   * fields, so a registered input's `fields` function may call `getInputType()`.
   *
   * `options.includedCustomQueries` selects custom queries by name (see {@link CreateSchemaOptions});
   * an included custom query named like an included generated query throws `QUERY_NAME_CONFLICT`
   * (500). `options.transaction` adds the generated transaction field (see {@link CreateSchemaOptions}).
   * A schema without mutation fields has no `Mutation` root.
   */
  createSchema(includedQueryTypes?: GraphQLObjectType[] | null, includedMutationTypes?: GraphQLObjectType[] | null, includedCustomMutations?: string[] | null, options?: CreateSchemaOptions): GraphQLSchema;
  getModel(type: GraphQLObjectType | { name: string }): Model | null | undefined;
  getType(name: string | { name: string }): GraphQLObjectType | null | undefined;
  /**
   * Available after createSchema has built input types. It has no fields for a type without
   * writable fields; such inputs are not part of generated schemas.
   */
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
  /**
   * Register a custom query on `RootQueryType`, for a result that is not a stored record. The
   * callback receives the input and the request context; no transaction or session wraps it.
   * Throws `INVALID_QUERY_REGISTRATION` (500) for invalid arguments and `QUERY_NAME_CONFLICT`
   * (500) for a name already registered.
   */
  registerCustomQuery(name: string, description: string, input: GraphQLInputObjectType | null | undefined, output: GraphQLOutputType, callback: (input: any, context: any) => any): void;
  /**
   * Register a named view: a root query field that returns the list of `options.type` with the
   * generated list arguments plus `options.params`, and appends the groups of `options.where` after
   * middleware. A schema includes the view exactly when it includes the type. Throws `INVALID_VIEW`
   * (500) for an invalid declaration and `QUERY_NAME_CONFLICT` (500) for a name already registered as
   * a view, keeping the first registration. `createSchema` throws `INVALID_VIEW` when the type is not
   * connected in this runtime or a param is named like one of its fields or a generated list
   * argument, and `QUERY_NAME_CONFLICT` when an included view is named like an included generated or
   * custom query.
   */
  registerView(name: string, options: ViewOptions): void;
  /** Owns the full workflow transaction unless an active caller session is supplied. */
  saveObject(typeName: string, args: Record<string, any>, session?: Session, context?: any): Promise<any>;
  /**
   * Runs the lifecycle of the generated update mutation from code: validators, controller hooks,
   * optimistic concurrency and the nested `added`, `updated` and `deleted` entries, in one transaction.
   * `typeName` names a type registered in this runtime that stores records and has its update input
   * prepared by `createSchema()`, with an `id` field. Whether a schema exposes the mutation does not
   * matter: the helper is not an authorization boundary. Any other `typeName` rejects with
   * `INVALID_OPERATION_TARGET` (500), before the input is read.
   *
   * `input` has the shape of the type's generated update input, `version` included on a type with
   * optimistic concurrency. It is checked structurally and copied before anything runs, and the
   * caller's object is never written to. It is not coerced like a GraphQL input: enum fields take
   * their internal values, scalars are not parsed, a reference is its record key as a string, such as
   * `{ id: String(record._id) }`, and the `state` of a type with a state machine changes only through
   * `transitionObject`. A scalar field takes a primitive, a `Date` or plain data (objects and arrays,
   * copied deeply, at most 256 levels deep); class instances such as `ObjectId`, `Buffer` or `Map` are
   * rejected with `INVALID_INPUT`. An own `undefined` counts as omitted, and a bare value is never
   * wrapped into a list. A missing `input`, `id` or value for a non-null field rejects with
   * `REQUIRED_VALUE` (400); any other violation, such as an unknown field, an object that is not plain
   * or a list that is not dense, rejects with `INVALID_INPUT` (400). The message names the path, such
   * as `input.lines.added[1].price`, and never a value. More nested entries than `maxNestedOperations`
   * from `configureMutationLimits()` (`null` = no limit) reject with `NESTED_OPERATIONS_EXCEEDED` (400)
   * before the transaction starts.
   *
   * Without `session`, the adapter owns the transaction and its retries. A supplied `session` must have
   * an active transaction, and the helper itself never commits, retries, aborts or cleans up a supplied
   * session; an adapter may still abort it on a write error (for example MongoDB with transactional
   * reference integrity). Like `saveObject`, it skips the global middleware of the record itself; nested entries keep theirs and
   * receive `context`, which may be `undefined`.
   *
   * Resolves to the updated record, as the generated mutation returns it. An `id` that has no record
   * rejects with `NOT_VALID_ID` (404), and a stale `version` with `VERSION_CONFLICT` (409).
   */
  updateObject(typeName: string, input: Record<string, any>, session?: Session, context?: any): Promise<any>;
  /**
   * Runs the lifecycle of the generated delete mutation from code. `target` is `{ id }`, the record key
   * as a string, plus `version`, the version read, on a type with optimistic concurrency; on any other
   * type `version` is an unknown field. The type is checked as in {@link Runtime.updateObject}, except
   * that it needs no update input of its own; the type must still be a stored record type, which only
   * `createSchema()` establishes. The target is checked before anything runs: a missing
   * target, `id` or required `version` rejects with `REQUIRED_VALUE` (400), and any other violation
   * with `INVALID_INPUT` (400). A stale `version` rejects with `VERSION_CONFLICT` (409). Sessions,
   * `context` and middleware work as in `updateObject`.
   *
   * Resolves to the deleted record, or to `null` when no record has that ID.
   */
  deleteObject(typeName: string, target: { id: string; version?: number }, session?: Session, context?: any): Promise<any>;
  /**
   * Runs the state machine action `actionName` of `typeName` from code, with the lifecycle of the
   * generated action mutation: the check of the current state, the action's callback, the update and the
   * controller hooks, in one transaction. An `actionName` that is not an own action of the type's state
   * machine, or a type without one, rejects with `UNKNOWN_ACTION` (500). The type, the checks of `input`,
   * the session, `context`, the middleware and the errors are as in {@link Runtime.updateObject}. `input` has
   * the shape of the update input and does not carry `state`. An action that does not start from the
   * record's state rejects with `BAD_REQUEST` (400).
   *
   * Resolves to the updated record, with `state` set to the action's target state.
   */
  transitionObject(typeName: string, actionName: string, input: Record<string, any>, session?: Session, context?: any): Promise<any>;
  preventCreatingCollection(prevent: boolean): void;
}

/** Driver adapter contract. GraphQL generation and lifecycle live in createRuntime. */
export interface DatabaseAdapter<Model = any, Session = any> {
  /**
   * Optional. The filter operators this adapter compiles. `createRuntime` reads it once and throws
   * `INVALID_QUERY_FEATURES` (500) unless it is undefined, null or an object whose `operators` is an
   * array of strings and whose `referenceEmptiness`, if present, is a boolean or null. Without it the
   * adapter supports the operators of 3.7.0 (`EQ`, `NE`, `LT`, `LTE`, `GT`, `GTE`, `BTW`, `IN`, `NIN`
   * and `LIKE`) and no reference emptiness. A list, aggregate or collection read, or a
   * by-ID read through a `get_by_id` scope, whose arguments use a `QLOperator` value the adapter
   * does not support fails with `UNSUPPORTED_QUERY` (400), before middleware runs for the client's
   * arguments and before `find`, `count`, `aggregate`, `findChildren` or `findChildrenBatch` for
   * conditions that middleware, scopes and joined scopes added. Operators outside `QLOperator`, which
   * only trusted code can write, fail with `INVALID_FILTER_OPERATOR` (400) before the adapter is
   * called, except in the forms the compilers ignore: an operator beside the `terms` of an object
   * filter, and the `terms` of a scalar, scalar-list, interface or union field's filter. Those reach
   * the adapter, which ignores them. Declaring `IS_EMPTY` and `IS_NOT_EMPTY` means compiling their
   * semantics on the record's own fields; emptiness through references and collections also needs
   * `referenceEmptiness: true`, and fails with `UNSUPPORTED_QUERY` without it.
   * Declaring `CONTAINS_ALL` means compiling set containment over the leaf's values, including the
   * values of every item of embedded lists, two-valued under negation; declaring `IIN` means
   * compiling case-insensitive membership under the case-folding contract of the text operators.
   * Names that an older version ignored are honored once this version knows them.
   */
  queryFeatures?: QueryFeatures | null | undefined;
  /**
   * Optional. Declares the write features this adapter implements. `createRuntime` reads it once and
   * throws `INVALID_WRITE_FEATURES` (500) unless it is undefined, null or an object whose
   * `optimisticConcurrency`, if present, is a boolean. A schema with a type that declares
   * `extensions.concurrency` (see {@link ConcurrencyDeclaration}) throws `INVALID_MODEL` (400) unless
   * the adapter declares `optimisticConcurrency: true`, which commits it to the `options.expectedVersion`
   * contract of `update` and `delete` and to the requirements on `find` below.
   */
  writeFeatures?: { optimisticConcurrency?: boolean } | null | undefined;
  /**
   * Optional, and required to enable the generated transaction field (see
   * `CreateSchemaOptions.transaction`). Receives the models one transaction of that field may
   * write: those of the types that own its operations and of the referenced collection items their
   * inputs declare, at any depth, without duplicates. Core calls it before each transaction of the
   * field opens, never in `createSchema()`, so a schema can be created before the connection opens.
   * It must be synchronous and never write, and it throws when the models cannot share one session; a
   * returned promise fails the transaction with `TRANSACTION_UNSUPPORTED` (500).
   */
  assertTransactionModels?(models: Model[]): void;
  bind?(runtime: Pick<Runtime<Model, Session>, 'getModel' | 'getType' | 'getRegistrations'>): void;
  validateRegistration?(registration: RuntimeRegistration<Model, Session>): void;
  /**
   * Optional. Receives every registration before models are created. Their GraphQL types, like the
   * type that `createModel()` receives, still contain virtual fields (`extensions.virtual`), which
   * must never be stored: an adapter that builds storage from a type's fields skips each field for
   * which {@link isVirtualField} returns true, on the types its embedded fields reach as well, or
   * builds it from `describeModels(registrations)`, which leaves them out. Generated writes, filters,
   * sorts and aggregations never name a virtual field; a controller hook can still assign one. The
   * version field of a type that declares optimistic concurrency is injected after `prepare()`, so a
   * type here may not have it yet; `describeModels(registrations)` describes it either way.
   */
  prepare?(registrations: RuntimeRegistration<Model, Session>[], options: { createCollection: boolean }): void;
  /**
   * Creates the model of a registered type. Its fields include virtual fields; see `prepare()`. A type
   * that declares optimistic concurrency already has its injected version field here, which
   * `describeModels(registrations)` describes as well.
   */
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
  /**
   * Optional capability for controller callbacks. Accept only into an active attempt owned by this
   * adapter; false means the supplied session has no owned attempt. A new queue is required per
   * retry, including retries on the same native session. Seal before commit, discard on abort or
   * unresolved uncertainty, and drain once, serially, after confirmed commit and cleanup attempt.
   * Callback failures must never enter transaction retry/rollback paths or fail a committed write.
   * Borrowed operations join the owning attempt; this method does not observe external commits.
   */
  enqueueAfterCommit?(session: Session, run: () => void | Promise<void>): boolean;
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
   * Simfinity then reads as null an object that holds no data when a non-null member would read as
   * null, whatever the selection. These members do not count: `id`, readOnly and virtual members,
   * interface and union members, members with their own resolver and referenced collections. An object whose type
   * has no member that counts is returned untouched. Otherwise Simfinity reads the stored members
   * (see `rawEmbeddedValue`), never calling a getter, and counts a stored `_id` as `id`; an error
   * while reading them returns the object unchanged. Runtimes that share the type read through the
   * same resolver, with or without the hook. On MongoDB, a create that writes an empty object for a
   * required embedded member stores it as absent (Mongoose minimizes it), so an object that holds
   * nothing else reads as null too, except in by-ID and reference reads and update responses where
   * the member is a nested path, as generated models declare every embedded member except one named
   * `type`.
   */
  readEmbeddedValue?(value: any): any;
  /**
   * Optional, used with `readEmbeddedValue`. Returns the stored data of a hydrated embedded value
   * as a plain object, without running getters or virtuals, such as a document's raw data; returns
   * any other value unchanged. Return a hydrated value unchanged when its stored data does not show
   * what it renders, such as one whose schema supplies members through getters, virtuals, methods
   * or aliases: a value that is not a plain object counts as data, so Simfinity keeps it as it is.
   * Simfinity calls it on the embedded objects it checks for data, including those it finds inside
   * the returned data, and reads only own data properties of the result; a null or undefined result
   * has no members. Without it, a plain object is read as it is, an accessor property counts as
   * present without being called, and a value that is not a plain object counts as data.
   */
  rawEmbeddedValue?(value: any): any;
  getById(model: Model, id: any, session?: Session | null, options?: { projection?: Record<string, number>; plain?: boolean; lock?: boolean; requiredId?: any; context?: any }): any;
  /** Optional batch read: the records found for `ids`, in getById shape and any order. After a failure, the runtime reads each ID with getById. */
  getByIds?(model: Model, ids: any[], options?: { context?: any }): any;
  /**
   * Optional. Return true when a `getById` of `model` has no side effects (no query middleware or
   * hooks that guard, count or change reads) and cannot fail where `update` or `delete` by the same
   * ID would succeed: both reject a malformed ID with `NOT_VALID_ID` (400) as the read does, and
   * return null for a missing record. The runtime may then skip a read whose result it does not use:
   * the read before a delete without an `onDelete` hook, and, for a type with embedded fields, the
   * read before an update that merges no embedded value and has neither `onUpdating` nor nested
   * collection items. When it is absent or returns false, those reads run.
   */
  readByIdIsInert?(model: Model): boolean;
  prepareUpdate(set: Record<string, any>, unset: Record<string, string>): any;
  /**
   * With `options.expectedVersion`, one atomic write that matches the ID and a stored version equal to
   * it (on MongoDB a missing or null stored version counts as 1), applies `changes`, sets the version
   * to `expectedVersion + 1` and returns the updated record. When nothing matches, or when
   * `expectedVersion >= MAX_RECORD_VERSION` and the write is skipped, it reads the record by ID in the
   * same session: it returns null for a missing one, throws `VERSION_CONFLICT` (409) when the stored
   * version differs, `VERSION_EXHAUSTED` (409) when stored and expected are `MAX_RECORD_VERSION`, and
   * returns null otherwise. Without `options.expectedVersion` it behaves as before. A wrapper must
   * forward every argument, `options` included.
   */
  update(model: Model, id: any, changes: any, session?: Session, options?: { expectedVersion?: number }): any;
  /**
   * With `options.expectedVersion`, one atomic delete that matches the ID and the version, and returns
   * the deleted record. When nothing matches, it decides as `update` does, without the exhausted case:
   * a delete does not advance the version, so a record at `MAX_RECORD_VERSION` is deleted like any
   * other. Without it, it behaves as before. A wrapper must forward every argument, `options`
   * included.
   */
  delete(model: Model, id: any, session?: Session, options?: { expectedVersion?: number }): any;
  /**
   * An adapter that declares `writeFeatures.optimisticConcurrency` must run `find` inside the given
   * `session`, honor `options.requiredId` and accept `options.context`: the runtime reads through
   * `find` with the caller's session to check, before a hook runs, whether the caller can read a
   * record whose version is stale.
   */
  find(model: Model, type: GraphQLObjectType, args: any, session?: Session | null, options?: { requiredId?: any; context?: any }): any;
  count(model: Model, type: GraphQLObjectType, args: any, session?: Session | null): Promise<number> | number;
  aggregate(model: Model, type: GraphQLObjectType, args: any, session?: Session | null): any;
  findChildren(model: Model, type: GraphQLObjectType, connectionField: string, parentId: any, args: any, session?: Session | null): any;
  /**
   * Optional batch form of `findChildren` for generated collection fields. The runtime calls it as
   * an adapter method (`this` is the adapter) only when `batchesChildren` does not return false, and
   * checks both members on every read. Within one request (a GraphQL context object), it groups the
   * collection reads of one related type and connection storage field whose effective arguments
   * (after middleware, the scope and joined scopes) hold the same plain data and are requested
   * before the promise jobs queued so far have run, and calls this method with 2 to 100 distinct
   * parent IDs: each one the raw ID the first of its fields read, never null, and one that `castId`
   * accepts without changing its string form. A group with one distinct parent calls `findChildren`
   * instead. `args` is a copy the method may change; it holds only plain data and dates, and its
   * pagination is valid. `options.context` is the request context; the runtime passes no session.
   *
   * Return, or resolve to, one array per parent ID, in `parentIds` order, each holding exactly the
   * records, order and page that `findChildren(model, type, connectionField, parentIds[i], args, null)`
   * returns for that parent; the result must not depend on `options.context`. Records should show
   * their parent under `connectionField` (or the connection field's GraphQL name), as `findChildren`
   * records do, or not show one. Fields that read the same parent share its records, each with its
   * own array. After a rejection or throw, or a result of another shape (not an array, another
   * length, an entry that is not an array, or a record that shows another parent), each field reads
   * alone with `findChildren`; a failure other than a `SimfinityError` and a result of another shape
   * are reported once per type with `console.warn`. To keep per-parent reads for a model or field,
   * return false from `batchesChildren`.
   */
  findChildrenBatch?: ((model: Model, type: GraphQLObjectType, connectionField: string, parentIds: any[], args: any, options?: { context?: any }) => any[][] | PromiseLike<any[][]>) | undefined;
  /**
   * Optional, synchronous. Return false to read the children of `model` through `connectionField`
   * with one `findChildren` call per field, as an adapter without `findChildrenBatch` does: at once,
   * with the arguments object the field built. The runtime calls it as an adapter method on every
   * read that could join a batch. Return false whenever `findChildrenBatch` would not reproduce
   * `this.findChildren`, such as when `this.findChildren` is not the adapter's own function (a copy
   * or an `Object.assign` override that changes how children are read), or for a model whose reads
   * have hooks or settings that a batched read would bypass. When it is absent, the runtime batches
   * every read it can.
   */
  batchesChildren?: ((model: Model, type: GraphQLObjectType, connectionField: string) => boolean) | undefined;
}
export function createRuntime<Model = any, Session = any>(adapter: DatabaseAdapter<Model, Session>): Runtime<Model, Session>;

/** Scoped single-reference joins, keyed by a dotted prefix relative to the containing frame. */
export type QueryJoins = Record<string, QueryPredicate | null>;

/** A field operand in the same frame (up: 0) or an enclosing shorthand frame. */
export type QueryOperand = {
  up: number;
  path: string[];
  joins?: QueryJoins;
  /** Structural embedded container: bound frame distance and a single-object path within it.
   * When present, the outer `up` is zero and `path` is relative to this container.
   * This must identify an actual embedded ancestor, never an arbitrary outer entity. */
  container?: { up: number; path: string[] };
};

/**
 * `operator` is a {@link QueryOperator}; the value of a text operator is a validated string. For
 * `CONTAINS_ALL` the value is a non-empty array of non-null scalars, validated and not cast; the
 * compiler casts each element as for `IN`. For `IIN` it is an array of strings, possibly empty. For
 * `IS_EMPTY` and `IS_NOT_EMPTY` the value is null, and `path` may end at an embedded object, an
 * embedded list or a scalar list as well as at a scalar; `IS_NOT_EMPTY` is the exact complement,
 * which the compiler builds. With `referenceEmptiness: true`, their `path` may also cross single
 * references and end at a reference or a collection.
 *
 * `scopes` exists only on such an emptiness predicate from a client, and only for a compiler that
 * declares `referenceEmptiness: true`. It has one key per dotted path relative to its frame: each
 * single reference the path crosses (a scoped join, which admits the target only where the scope
 * admits it), the end when it is a reference or a collection, and each reference and collection
 * member of an embedded object (frames, which keep only the records the scope admits). Each value is
 * the target's `find` scope as a predicate in the target's own frame, or null when the scope added
 * nothing; after a scoped crossing, a null hop still correlates through that scoped join. Without
 * `scopes` the predicate reads stored data, through plain joins. `joins` carries the scopes of
 * single references crossed inside a client frame, with keys relative to the containing frame.
 * A `quantified` node selects elements with `ANY`, `ALL` or `NONE`, applying `scope` before `where`;
 * both predicates use paths relative to the element, and null means no restriction. Empty elements
 * give ANY false, ALL/NONE true; scope is never negated, and frames never multiply roots. `anchor` is
 * an aggregate's legacy join chain; when present, `path` is relative to it. Comparison-bearing
 * anchored frames may carry full-prefix joins as visibility guards, preserving the existing J row.
 */
export type QueryPredicate =
  | { kind: 'predicate'; path: string[]; operator: string; value: any; operand?: QueryOperand; scopes?: Record<string, QueryPredicate | null>; joins?: QueryJoins }
  | { kind: 'and' | 'or'; terms: QueryPredicate[] }
  | {
      kind: 'quantified';
      quantifier: QueryQuantifier;
      path: string[];
      where: QueryPredicate | null;
      scope: QueryPredicate | null;
      joins?: QueryJoins;
      anchor?: string[];
    };
export interface QueryPlan {
  entity: string;
  where: QueryPredicate | null;
  mode: 'find' | 'count' | 'aggregate';
  sort: Array<{ path: string[]; order: 'ASC' | 'DESC' }>;
  pagination: { limit: number; offset: number } | null;
  aggregation?: { groupId: string[]; facts: Array<{ path: string[]; factName: string; operation: 'SUM' | 'COUNT' | 'AVG' | 'MIN' | 'MAX' }> };
}
/**
 * Validates the arguments into a plan: paths, operators and values, with `INVALID_FILTER_VALUE` (400)
 * for a text operator on a field that is not a `String` field or list, or with a value that is not
 * a string or contains U+0000. With `operators`, the names the caller compiles, any other
 * `QLOperator` value fails with `UNSUPPORTED_QUERY` (400); unknown operators fail with
 * `INVALID_FILTER_OPERATOR` (400) either way.
 *
 * An emptiness condition is checked in this order: its form, path and group depth
 * (`MISSING_FILTER_PATH` for `IS_EMPTY` or `IS_NOT_EMPTY` on an object filter without terms or beside
 * terms, `AMBIGUOUS_FILTER_FIELD`, `INVALID_FILTER_PATH`, `INVALID_FILTER_FIELD`,
 * `FILTER_DEPTH_EXCEEDED`), then `operators` (`UNSUPPORTED_QUERY`), then `INVALID_FILTER_PATH` for a
 * value inside an embedded list or a collection, `INVALID_FILTER_OPERATOR` for an embedded type that
 * reaches itself through single embedded members, `INVALID_FILTER_VALUE` for a value that is not
 * omitted or null, and `UNSUPPORTED_QUERY` for a reference or collection on the path or among the
 * members. A nonquantified emptiness term without a path (omitted, null or `""`) and a group
 * condition without a path test the field itself; quantified filter terms always need a path. For other operators, a filter path of more than one segment that ends at an
 * object fails with `INVALID_FILTER_PATH`, as on MongoDB; a bare object field keeps
 * `MISSING_FILTER_PATH`.
 *
 * `CONTAINS_ALL` and `IIN` are checked in this order: the path (`AMBIGUOUS_FILTER_FIELD`,
 * `INVALID_FILTER_PATH`, `INVALID_FILTER_FIELD`) and the object-end rule above, then an unknown name
 * (`INVALID_FILTER_OPERATOR`) and `operators` (`UNSUPPORTED_QUERY`), then, for `CONTAINS_ALL` only,
 * `INVALID_FILTER_PATH` through a collection, aggregate join prefixes included
 * (`The shorthand excludes them; use an explicit group`), `INVALID_FILTER_PATH` through a reference
 * inside an embedded list, and `INVALID_FILTER_OPERATOR` on a leaf that is neither a scalar list nor
 * a scalar reached through an embedded list, and the values last, with `INVALID_FILTER_VALUE`.
 * `CONTAINS_ALL` takes a non-empty array of non-null scalars, none of them an array or a plain
 * object; `IIN` takes an array of strings without U+0000, possibly empty, on a `String` field or list
 * by its effective scalar. A hole of a sparse array fails for both, while `IN`, `NIN` and `BTW` keep
 * skipping holes.
 * Both plan `{ kind: 'predicate', path, operator, value }` with the array as validated, neither cast
 * nor deduplicated. `IIN` through a collection plans as `IN` does: an implicit `ANY` frame with
 * `quantifiers`, a row filter on an aggregate's join prefix, a legacy join otherwise. `CONTAINS_ALL`
 * is never cut into a frame.
 *
 * `valuePath` selects a compatible stored scalar operand instead of a literal value. It defaults
 * like `quantifiers`; a comparison node has `value: null` and `operand: { up, path, joins? }`.
 * Same-frame operands use the union of scoped paths in `joins`; internal shorthand outer bindings
 * use positive `up` and their own operand joins. Structural $parent operands add container: { up, path } with outer up zero; existing up semantics stay unchanged.
 * Null equality is two-valued, and a left scalar list uses null-safe EQ/NE membership.
 * Embedded-list comparisons require elementFrames; right scalar lists and incompatible logical types fail explicitly.
 *
 * `referenceEmptiness` defaults to true when `operators` is omitted and to false when it is given.
 * When it is false, an emptiness condition that crosses or ends at a reference or a collection, or
 * reads a reference or collection member, fails with `UNSUPPORTED_QUERY` where the order above has
 * `UNSUPPORTED_QUERY` for references; when it is true, such a condition plans with stored semantics,
 * unless its term or group condition carries a client scope marker that the runtime filled, which
 * becomes the predicate's `scopes`. `quantifiers` has the same default rule and requires reference
 * emptiness; enabled collection filters emit quantified nodes, with per-group/prefix correlation,
 * element-relative scopes/joins and aggregate anchors beyond legacy J joins. `__scope`, `__implicit`
 * and `__anchor` are reserved internal input metadata. A group that trusted code writes with
 * `__implicit: true` must, after its `__anchor`, end at a collection, or at a reference without
 * crossing a list, and its `__anchor`, when present, must have exactly the shape the collection
 * shorthand writes: in an aggregate, on a group at the root, a non-empty array of field names without
 * dots that crosses at least one collection, each a join prefix, followed by a `path` of one
 * collection. Otherwise the group fails with `INVALID_FILTER_PATH` (400), whatever operators it holds
 * and before its conditions are checked, with the message
 * `An implicit quantified path must end at a collection, or at a reference without crossing a list` or
 * `An implicit quantified anchor must name the aggregate's join prefixes`; the anchor's form is
 * checked before the path rule, the rest after it.
 * A marker not filled for every path fails with `DETACHED_CLIENT_FILTER` (500).
 */
export function createQueryPlan(models: ModelDescription, entityName: string, input?: Record<string, any>, options?: { mode?: QueryPlan['mode']; operators?: Iterable<string>; referenceEmptiness?: boolean; quantifiers?: boolean; valuePath?: boolean; elementFrames?: boolean }): QueryPlan;
export function resolveModelPath(models: ModelDescription, entityName: string, path: string | string[]): FieldDescription[];

/**
 * Process-wide. `maxPageSize` (default 1000) caps page sizes. `maxReferenceFrames` (default 10) caps,
 * per list, aggregate or collection-field call, the compiled frames and scoped joins a client's
 * conditions need. Named views check client arguments and `where` groups separately. `maxFrameNesting` (default 3) caps nested frames along one chain in client and
 * trusted constructs. Exceeding either frame limit fails with `FILTER_DEPTH_EXCEEDED` (400). Each
 * option must be a positive safe integer, or the call throws `INVALID_QUERY_LIMITS` (400) and keeps
 * every current limit; an omitted option takes its default again.
 */
export function configureQueryLimits(options?: QueryLimitsOptions): void;
/**
 * Same process-wide setting as `Runtime.configureMutationLimits`. Unknown or misspelled options
 * throw `INVALID_MUTATION_LIMITS` (400) and keep the current limits.
 */
export function configureMutationLimits(options?: MutationLimitsOptions): void;
export function paginationStages(pagination: { page: number; size: number } | null | undefined, withDefault: boolean): Array<{ $skip: number } | { $limit: number }>;

/**
 * Envelop-style schema plugin, as MCP `schemaPlugins` accepts it; `createAuthPlugin` returns the
 * narrower {@link AuthSchemaPlugin}. `@simtlix/simfinity-mcp` re-exports this declaration, so
 * `export *` of both packages exports one `EnvelopSchemaPlugin`.
 */
export interface EnvelopSchemaPlugin {
  /**
   * Wraps resolvers in place. MCP `schemaPlugins` awaits a returned promise; Envelop and Yoga do
   * not, so plugins shared with them should install synchronously.
   */
  onSchemaChange?: (payload: {
    schema: GraphQLSchema;
    replaceSchema: (schema: GraphQLSchema) => void;
  }) => void | Promise<void>;
  [key: string]: unknown;
}

/**
 * What `createAuthPlugin` returns: an {@link EnvelopSchemaPlugin} whose hook wraps the resolvers
 * synchronously and returns nothing.
 */
export interface AuthSchemaPlugin extends EnvelopSchemaPlugin {
  onSchemaChange?: (payload: {
    schema: GraphQLSchema;
    replaceSchema: (schema: GraphQLSchema) => void;
  }) => void;
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

/**
 * What `validators.arrayLength()` runs on each item: a validator, a helper result such as
 * `validators.maxLength('Tag', 20)`, whose `CREATE` rules run on every item on create and update,
 * or an array of them. Falsy array entries are skipped, so `[flag && rule]` works.
 */
export type ItemValidators =
  | FieldValidator
  | FieldValidations
  | ReadonlyArray<FieldValidator | FieldValidations | null | undefined | false | '' | 0>;

/** Built-in field validator factories. A `null` or omitted bound means no bound. */
export const validators: {
  stringLength(name: string, min?: number | null, max?: number | null): FieldValidations;
  maxLength(name: string, max: number | null): FieldValidations;
  /**
   * Copies the pattern when the helper is created and tests each value from its first character,
   * so `g` and `y` keep no state between values. Throws `TypeError` unless the pattern is a
   * `RegExp` or a string.
   */
  pattern(name: string, regex: RegExp | string, message?: string): FieldValidations;
  email(): FieldValidations;
  url(): FieldValidations;
  numberRange(name: string, min?: number | null, max?: number | null): FieldValidations;
  positive(name: string): FieldValidations;
  /**
   * A falsy `itemValidator` adds no item checks. A single validator runs when it is a plain object or a
   * function; a class instance with its own `validate()`, such as a Joi or yup schema, is ignored with a
   * warning. Other unusable values log a `Configuration issue` warning when the helper is created.
   */
  arrayLength(
    name: string,
    maxItems?: number | null,
    itemValidator?: FieldValidator | FieldValidator[] | FieldValidations | ItemValidators | null | undefined | false | '' | 0,
  ): FieldValidations;
  /**
   * Values must be dates JavaScript can parse. Strings that start with an ISO date (`YYYY-MM-DD`), and
   * slashed `MM/DD/YYYY` strings, must be real calendar dates, so `2024-02-31` and `02/31/2024` fail.
   * Only the `'YYYY-MM-DD'` format is checked; any other format logs a warning when the helper is created.
   */
  dateFormat(name: string, format?: string): FieldValidations;
  /** Same date checks as `dateFormat()` without a format, plus the date must be in the future. */
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
  /** A `null` or omitted bound means no bound; the description names only the bounds that are set. */
  createBoundedStringScalar(name: string, min?: number | null, max?: number | null): GraphQLScalarType;
  /** A `null` or omitted bound means no bound; the description names only the bounds that are set. */
  createBoundedIntScalar(name: string, min?: number | null, max?: number | null): GraphQLScalarType;
  /** A `null` or omitted bound means no bound; the description names only the bounds that are set. */
  createBoundedFloatScalar(name: string, min?: number | null, max?: number | null): GraphQLScalarType;
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

/**
 * Authentication error: code `UNAUTHENTICATED`, status 401, default message `Authentication required`.
 * The same class as `auth.UnauthenticatedError` and the `/auth` and `/auth/errors` subpath exports.
 */
export class UnauthenticatedError extends SimfinityError {
  constructor(message?: string);
}

/**
 * Authorization error: code `FORBIDDEN`, status 403, default message `Access denied`.
 * The same class as `auth.ForbiddenError` and the `/auth` and `/auth/errors` subpath exports.
 */
export class ForbiddenError extends SimfinityError {
  constructor(message?: string);
}

/** Authorization utilities (RBAC/ABAC rules, plugin factories and auth errors). */
export const auth: {
  /**
   * Wraps schema resolvers in-place. Throws TypeError for invalid rules, maps, or defaultPolicy.
   * `onSchemaChange` throws TypeError, before wrapping any field, when a schema type was created
   * by another copy of the graphql module.
   */
  createAuthPlugin(permissions: PermissionSchema, options?: AuthPluginOptions): AuthSchemaPlugin;
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
  /**
   * Required roles must be nonempty strings; invalid configuration throws TypeError. The array,
   * which may be readonly, is copied when the rule is created.
   */
  requireRole(
    role: string | readonly string[],
    options?: { userPath?: string | ((ctx: any) => unknown); rolePath?: string | ((user: any) => unknown) },
  ): AuthRuleFunction;
  /**
   * Exact array membership; only a standalone '*' claim grants all permissions. The array of
   * required permissions, which may be readonly, is copied when the rule is created.
   */
  requirePermission(
    permission: string | readonly string[],
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
  createAuthPlugin(permissions: PermissionSchema, options?: AuthPluginOptions): AuthSchemaPlugin;
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

/** Early opt-out. Import its function from /introspection before loading the runtime. */
export interface IntrospectionOptions { fieldExtensions: false; }
