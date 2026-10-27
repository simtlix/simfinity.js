import {
  configureQueryLimits, getQueryMaxPageSize, getQueryMaxReferenceFrames, paginationStages,
} from './query-limits.js';
import {
  configureMutationLimits, getMaxNestedOperations, getMaxTransactionOperations, nestedOperationsExceededError,
  transactionOperationsExceededError,
} from './mutation-limits.js';
import {
  GraphQLObjectType, GraphQLString, GraphQLID, GraphQLSchema, GraphQLList,
  GraphQLNonNull, GraphQLInputObjectType, GraphQLScalarType,
  GraphQLInt, GraphQLEnumType, GraphQLBoolean, GraphQLError, GraphQLInterfaceType, GraphQLUnionType,
  Kind, defaultFieldResolver, getNamedType, isEnumType, isListType, isNonNullType, isObjectType, isOutputType,
  isScalarType,
} from 'graphql';

import SimfinityError from './errors/simfinity.error.js';
import InternalServerError from './errors/internal-server.error.js';
import { ForbiddenError } from './auth/errors.js';
import QLOperator from './const/QLOperator.js';
import QLValue from './const/QLValue.js';
import QLSort from './const/QLSort.js';
import {
  collectQueryOperators, collectQueryPathEntries, collectQueryPaths, walkQueryPath,
} from './query-plan.js';
import { QUERY_OPERATORS, isQueryOperator, resolveQueryFeatures } from './query-operators.js';
import {
  assertEmptinessPath, describeEmptiness, emptinessScopePaths, emptinessScopeTargets, isEmptinessOperator,
} from './query-emptiness.js';
import { relationFieldOwners } from './relation-owners.js';
import { discardThenable, isThenable } from './auth/thenable.js';
import { authorizeOperation } from './auth/operation-entries.js';
import {
  assertPlainConnectionField, getFieldStorageName, getListShape, isVirtualField, markStoredIdentity, normalizeConnectionField,
} from './relation-storage.js';
import {
  assertVirtualConnection, assertVirtualDeclaration, assertVirtualIndexes, assertVirtualStateField, virtualConflicts,
} from './virtual-fields.js';
import {
  fieldMetadataNamesFixed, fieldMetadataTypes, fixFieldMetadataNames, renameFieldMetadataTypes,
} from './introspection.js';
import {
  MAX_RECORD_VERSION, RecordVersion, RecordVersionRef, assertVersionInput, concurrencyDeclared, createVersionFieldConfig,
  isProtectedType, isVersionField, readStoredVersion, recordVersionFieldMisuse, retainedStoredVersion, unadvancedVersionError,
  unexpectedDeleteError, versionConflictError, versionConnectionCollision, versionEmbeddedMisuse, versionExhaustedError,
  versionFieldCollision, versionManagedError,
} from './record-version.js';
import {
  attachExecutionState, countNestedEntry, createExecutionState, detachExecutionState, executionStateOf,
  remainingNestedBudget,
} from './execution-state.js';
import { readDeleteTarget, snapshotOperationInput } from './operation-input.js';
import {
  assertTransactionSchema, buildTransactionField, collectOperationFields, invalidTransactionOption, noOperationError,
  readTransactionOption, recordTransactionState, transactionUnsupportedError, withTransactionField,
} from './transaction-schema.js';
import { planReferences, resolveReferences } from './transaction-references.js';

// Resolvers Simfinity generates. Any other resolver on a registered type when its schema is first
// created is application code, such as a masking resolver, recorded once per type so later
// in-place wrapping (for example by the auth plugin) does not change the snapshot.
const generatedResolvers = new WeakSet();
// A caller that runs one operation per call, such as simfinity-mcp, can collect the pagination
// count through the root value instead of the shared context: a function stored under this key
// receives the count. The key is not exported; simfinity-mcp defines the same Symbol.for key.
const COUNT_SINK = Symbol.for('simfinity.countSink');
const countSinkOf = (value) => {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  const sink = value[COUNT_SINK];
  return typeof sink === 'function' ? sink : undefined;
};
// The root value arrives as parent, which resolver wrappers that forward only (parent, args,
// context) still pass on; info.rootValue is the fallback.
const countSinkFor = (parent, info) => countSinkOf(parent) || (info ? countSinkOf(info.rootValue) : undefined);
// Without a sink the count goes to context.count, where Envelop/Apollo/Yoga count plugins read it.
// With neither, such as a graphql() call without contextValue, nothing could read a count, so the
// count query is skipped.
const canReportCount = (parent, info, context) => countSinkFor(parent, info) !== undefined
  || (context !== null && (typeof context === 'object' || typeof context === 'function'));
// Returns whether the count was stored.
const reportCount = (parent, info, context, count) => {
  const sink = countSinkFor(parent, info);
  if (sink) {
    sink(count);
    return true;
  }
  // Reflect.set returns false for a frozen, sealed or read-only context, where an assignment would
  // throw after both queries ran.
  return Reflect.set(context, 'count', count);
};
const applicationResolvedFields = new WeakMap();
const markGenerated = (resolve) => {
  generatedResolvers.add(resolve);
  return resolve;
};
const listApplicationResolvedFields = (gqltype) => new Set(Object.entries(gqltype.getFields())
  .filter(([, field]) => field.resolve && !generatedResolvers.has(field.resolve))
  .map(([fieldName]) => fieldName));
const hasApplicationResolver = (gqltype, fieldName) => (
  applicationResolvedFields.get(gqltype) || listApplicationResolvedFields(gqltype)
).has(fieldName);
// Object types whose relation fields hold resolvers and filter arguments generated by one runtime,
// mapped to that runtime. Those resolvers read through its adapter, registrations and middleware,
// so a bound type cannot be registered in, or reached from, another runtime's schema.
const runtimeBoundTypes = new WeakMap();
const forbiddenPath = (message) => new SimfinityError(message, 'FORBIDDEN_FILTER_PATH', 403);
// Generated inputs never write a readOnly field, nor a virtual one, which virtual implies.
const isReadOnlyField = (field) => !!field.extensions?.readOnly || isVirtualField(field);

// Optimistic concurrency (#98). A type is protected once it carries the version field createSchema()
// injects, which it keeps for good, so code that builds schemas and runs requests asks this instead of
// reading the live `extensions.concurrency`.
const isProtected = (gqltype) => isVersionField(gqltype.getFields().version);
// Whether each registered type was protected when the first createSchema() that contained it returned,
// for every runtime of this copy of the core code. A failed createSchema() records nothing.
const protectionStatus = new WeakMap();

const invalidWriteFeatures = (message) => {
  throw new SimfinityError(`DatabaseAdapter writeFeatures ${message}`, 'INVALID_WRITE_FEATURES', 500);
};

// Reads an adapter's `writeFeatures` declaration once, into a frozen copy. Undefined or null declares
// nothing; a plain object may declare `optimisticConcurrency` as a boolean, and its other members are
// left for later features. Anything else throws INVALID_WRITE_FEATURES (500).
const resolveWriteFeatures = (writeFeatures) => {
  if (writeFeatures == null) return Object.freeze({ optimisticConcurrency: false });
  if (typeof writeFeatures !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(writeFeatures))) {
    invalidWriteFeatures('must be a plain object');
  }
  const { optimisticConcurrency } = writeFeatures;
  if (optimisticConcurrency !== undefined && typeof optimisticConcurrency !== 'boolean') {
    invalidWriteFeatures('optimisticConcurrency must be a boolean');
  }
  return Object.freeze({ optimisticConcurrency: optimisticConcurrency === true });
};

// Query scopes restrict reads, so a scope Simfinity cannot run must fail rather than be skipped.
const SCOPE_OPERATIONS = ['find', 'get_by_id', 'aggregate'];
const invalidScope = (typeName, detail) => new SimfinityError(
  `${typeName} extensions.scope ${detail}`, 'INVALID_SCOPE', 500,
);
const validateScope = (gqltype) => {
  const extensions = gqltype.extensions || {};
  if (!Object.hasOwn(extensions, 'scope')) return;
  const { scope } = extensions;
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(scope))) {
    throw invalidScope(gqltype.name, 'must be a plain object of find, get_by_id or aggregate functions');
  }
  // Every own string key, enumerable or not, because getScope reads any of them.
  for (const operation of Object.getOwnPropertyNames(scope)) {
    if (!SCOPE_OPERATIONS.includes(operation)) {
      throw invalidScope(gqltype.name, `has unknown operation ${operation}; use find, get_by_id or aggregate`);
    }
    if (typeof scope[operation] !== 'function') {
      throw invalidScope(gqltype.name, `${operation} must be a function`);
    }
  }
};

// Returns the type's scope function for an operation, or null when it declares none. Revalidates
// on each call because extensions stay mutable after createSchema.
const getScope = (gqltype, operation) => {
  if (!gqltype?.extensions || !Object.hasOwn(gqltype.extensions, 'scope')) return null;
  validateScope(gqltype);
  const { scope } = gqltype.extensions;
  return Object.hasOwn(scope, operation) ? scope[operation] : null;
};

const requireRegisteredType = (dict, type, fieldName, ownerName) => {
  const registration = dict.types[type.name];
  if (!registration) {
    throw new SimfinityError(`Field ${ownerName ? `${ownerName}.` : ''}${fieldName} references ${type.name}, which is not `
      + 'registered; register it with connect() or addNoEndpointType()', 'UNREGISTERED_RELATION_TARGET', 500);
  }
  return registration;
};
// A joined scope is a find scope, so `aggregation` is a field filter there, as on list queries.
const SCOPE_IGNORED_ARGS = new Set(['sort', 'pagination']);

// A joined scope cannot sort or paginate the records it restricts. Its sort and pagination values are
// checked for shape only (INVALID_SORT: non-empty terms with a field and an ASC or DESC order;
// INVALID_PAGINATION: as on direct queries), then ignored; sort field names are not resolved.
const assertScopeControlArg = (name, value) => {
  if (name === 'pagination') {
    paginationStages(value, false);
    return;
  }
  if (!Array.isArray(value.terms) || !value.terms.length) {
    throw new SimfinityError('Sort requires non-empty terms', 'INVALID_SORT', 400);
  }
  for (const term of value.terms) {
    if (typeof term?.field !== 'string' || !['ASC', 'DESC'].includes(term.order)) {
      throw new SimfinityError('Sort terms require a field and an ASC or DESC order', 'INVALID_SORT', 400);
    }
  }
};

// Moves a joined type's scope group below the relation path that entered it.
const prefixScopeGroup = (group, prefix) => {
  if (!group || typeof group !== 'object' || Array.isArray(group)) {
    throw new SimfinityError('Expected a scope filter group object', 'INVALID_FILTER_VALUE', 400);
  }
  const prefixed = {};
  if (group.conditions != null) {
    prefixed.conditions = [].concat(group.conditions).map((condition) => ({
      field: `${prefix}.${condition?.path != null && condition.path !== '' ? `${condition.field}.${condition.path}` : condition?.field}`,
      operator: condition?.operator,
      value: condition?.value,
    }));
  }
  if (group.AND != null) prefixed.AND = [].concat(group.AND).map((item) => prefixScopeGroup(item, prefix));
  if (group.OR != null) prefixed.OR = [].concat(group.OR).map((item) => prefixScopeGroup(item, prefix));
  return prefixed;
};

const prefixScopeArgs = (scopeArgs, prefix, typeName) => {
  const conditions = [];
  const groups = [];
  for (const [name, value] of Object.entries(scopeArgs)) {
    if (value == null) continue;
    if (SCOPE_IGNORED_ARGS.has(name)) {
      assertScopeControlArg(name, value);
      continue;
    }
    if (name === 'AND') groups.push(...[].concat(value).map((group) => prefixScopeGroup(group, prefix)));
    else if (name === 'OR') {
      const branches = [].concat(value);
      if (branches.length) groups.push({ OR: branches.map((group) => prefixScopeGroup(group, prefix)) });
    } else if (Object.hasOwn(value, 'terms')) {
      if (!Array.isArray(value.terms) || !value.terms.length) {
        throw new SimfinityError(`Scope filter ${typeName}.${name} requires non-empty terms`, 'MISSING_FILTER_PATH', 400);
      }
      for (const term of value.terms) {
        // An emptiness term without a path (omitted, null or "") tests the field itself; other
        // operators keep the path as written.
        const itself = isEmptinessOperator(term?.operator) && (term.path == null || term.path === '');
        conditions.push({ field: itself ? `${prefix}.${name}` : `${prefix}.${name}.${term?.path}`, operator: term?.operator, value: term?.value });
      }
    } else conditions.push({ field: `${prefix}.${name}`, operator: value.operator, value: value.value });
  }
  return conditions.length ? [{ conditions }, ...groups] : groups;
};

const GraphQLJSON = new GraphQLScalarType({
  name: 'JSON',
  description: 'The `JSON` scalar type represents JSON values as specified by ECMA-404',
  serialize(value) {
    return value;
  },
  parseValue(value) {
    return value;
  },
  parseLiteral(ast) {
    switch (ast.kind) {
      case Kind.STRING:
      case Kind.BOOLEAN:
        return ast.value;
      case Kind.INT:
        return parseInt(ast.value, 10);
      case Kind.FLOAT:
        return parseFloat(ast.value);
      case Kind.OBJECT: {
        const value = Object.create(null);
        ast.fields.forEach((field) => {
          value[field.name.value] = GraphQLJSON.parseLiteral(field.value);
        });
        return value;
      }
      case Kind.LIST:
        return ast.values.map((n) => GraphQLJSON.parseLiteral(n));
      case Kind.NULL:
        return null;
      default:
        return undefined;
    }
  },
});

// The type called `name` that a schema built from these roots would contain, other than through
// `skip`, following the references GraphQLSchema collects: fields, arguments, interfaces, union
// members and input fields. With `inputFields` false, input objects are matched by their own name
// only, and their fields are never read.
const findSchemaType = (roots, name, skip, { inputFields = true } = {}) => {
  const visited = new Set();
  const pending = [...roots];
  while (pending.length) {
    const type = getNamedType(pending.pop());
    if (!type || type === skip || visited.has(type)) continue;
    visited.add(type);
    if (type.name === name) return type;
    if (type instanceof GraphQLUnionType) pending.push(...type.getTypes());
    if (type instanceof GraphQLObjectType || type instanceof GraphQLInterfaceType) {
      pending.push(...type.getInterfaces());
      for (const field of Object.values(type.getFields())) {
        pending.push(field.type, ...field.args.map((arg) => arg.type));
      }
    }
    if (inputFields && type instanceof GraphQLInputObjectType) {
      for (const field of Object.values(type.getFields())) pending.push(field.type);
    }
  }
  return null;
};

// Every schema contains Simfinity's field metadata types, the types of `__Field.extensions`, named
// FieldExtensionsType and RelationType unless a clash renamed them. Returns the type of a schema built
// from these roots that has the name of one of them, or null (#162).
const fieldMetadataClash = (roots, options) => fieldMetadataTypes()
  .map((own) => findSchemaType(roots, own.name, own, options)).find(Boolean) || null;

// The first schema that contains the metadata types fixes their names for the process, so a later
// schema with a type of the same name is rejected.
const reservedTypeNameError = (clash) => new SimfinityError(
  `Type ${clash.name} has the name of a type that Simfinity adds to every schema for __Field.extensions, `
    + 'and a schema created earlier in this process already contains that type under this name. Rename '
    + `${clash.name}, or create this schema first, so that Simfinity gives its types other names, such as `
    + 'SimfinityFieldExtensionsType and SimfinityRelationType',
  'RESERVED_TYPE_NAME',
  500,
);
// The check before anything is built reads only what the output type check before it reads: output
// types, their fields, arguments, interfaces and union members. Input objects, a registered
// mutation's input among them, are checked by their own name, because their fields function may read
// generated inputs (getInputType) that do not exist yet, and graphql-js keeps what it returns. A clash
// inside an input's fields is found when the schema is constructed.
const assertFieldMetadataNamesFree = (roots) => {
  const clash = fieldMetadataNamesFixed() && fieldMetadataClash(roots, { inputFields: false });
  if (clash) throw reservedTypeNameError(clash);
};

// A schema with protected types contains RecordVersion, and RecordVersionRef whenever a generated input
// reaches a collection of protected items, so an application type with either name, other than the
// instances this module exports, is rejected there (#98). Like the field metadata names, they are first
// checked before anything is built, reading input objects by their own name only, and then in the whole
// schema when it is constructed.
const versionTypeClash = (roots, options) => [RecordVersion, RecordVersionRef]
  .map((own) => findSchemaType(roots, own.name, own, options)).find(Boolean) || null;
// A scalar named RecordVersion with core's own description is almost always core's scalar from a
// second copy of this package, which protected types cannot work with.
const reservedVersionTypeNameError = (clash) => new SimfinityError(
  clash instanceof GraphQLScalarType && clash.name === RecordVersion.name && clash.description === RecordVersion.description
    ? 'RecordVersion is reserved for optimistic concurrency, and this RecordVersion comes from another copy of '
      + '@simtlix/simfinity-core: two copies of the package are loaded; import RecordVersion from the facade the '
      + 'application uses'
    : `${clash.name} is reserved for optimistic concurrency; rename the application type`,
  'RESERVED_TYPE_NAME', 500,
);

const buildSchemaConfig = (query, mutation) => {
  const config = { query };
  if (Object.keys(mutation.getFields()).length > 0) {
    config.mutation = mutation;
  }
  return config;
};

// Constructs the schema of these roots. When one of its types has the name of a field metadata type,
// those are renamed SimfinityFieldExtensionsType and SimfinityRelationType, with a number appended
// when the schema also has those names, in every schema the process constructs from then on. A
// construction that fails puts the previous metadata types back, so only a schema that exists fixes
// the names. With `reserveVersionTypeNames`, for a schema with protected types, an application type
// named RecordVersion or RecordVersionRef fails, even one that only an input field reaches.
const constructSchema = (query, mutation, reserveVersionTypeNames = false) => {
  const config = buildSchemaConfig(query, mutation);
  const roots = Object.values(config);
  const clash = fieldMetadataClash(roots);
  if (clash && fieldMetadataNamesFixed()) throw reservedTypeNameError(clash);
  const versionClash = reserveVersionTypeNames && versionTypeClash(roots);
  if (versionClash) throw reservedVersionTypeNameError(versionClash);
  let names = null;
  if (clash) {
    const taken = (name) => findSchemaType(roots, name) !== null;
    let suffix = '';
    for (let n = 2; taken(`SimfinityFieldExtensionsType${suffix}`) || taken(`SimfinityRelationType${suffix}`); n += 1) {
      suffix = String(n);
    }
    names = [`SimfinityFieldExtensionsType${suffix}`, `SimfinityRelationType${suffix}`];
  }
  const restore = names ? renameFieldMetadataTypes(...names) : null;
  let schema;
  try {
    schema = new GraphQLSchema(config);
  } catch (error) {
    if (restore) restore();
    throw error;
  }
  fixFieldMetadataNames();
  if (names) {
    console.warn(`Configuration issue: the schema has a type named ${clash.name}, the name of a type that `
      + `Simfinity adds to every schema for __Field.extensions, so Simfinity names its types ${names[0]} and `
      + `${names[1]} in every schema this process creates from now on. Use these names in named fragments `
      + 'and permission maps.');
  }
  return schema;
};

// graphql-js wraps a value thrown while resolving a field (locatedError): the wrapper has the field
// path and repeats the thrown error's message. A thrown non-Error becomes a NonErrorThrown whose
// message prints the value.
const isFieldErrorWrapper = (error) => Array.isArray(error.path) && error.originalError != null
  && error.message === error.originalError.message
  // locatedError adds no code of its own, so a thrown GraphQLError with its own code is not a wrapper.
  && (error.originalError instanceof SimfinityError || typeof error.extensions?.code !== 'string'
    || error.extensions === error.originalError.extensions);
const thrownValueOf = (error) => (error.name === 'NonErrorThrown' && Object.hasOwn(error, 'thrownValue')
  ? error.thrownValue : error);

// The SimfinityError behind a GraphQLError, such as one a custom scalar threw, followed only through
// GraphQLErrors; any other hidden cause is ignored.
const simfinityCauseOf = (error) => {
  let cause = error.originalError;
  while (cause instanceof GraphQLError) cause = cause.originalError;
  return cause instanceof SimfinityError ? cause : null;
};

// Request errors (syntax, validation, variable coercion) and application GraphQLErrors keep their own
// message and extensions, such as the http status a server adds. A SimfinityError cause supplies only
// the code and status, so a scalar's or application's hidden cause never replaces them.
const classifyGraphQLError = (error) => {
  const simfinity = simfinityCauseOf(error)?.extensions ?? {};
  const extensions = error.extensions || {};
  const code = [simfinity.code, extensions.code].find((value) => typeof value === 'string') ?? 'BAD_REQUEST';
  const status = [simfinity.status, extensions.status].find(Number.isInteger)
    ?? (code === 'INTERNAL_SERVER_ERROR' ? 500 : 400);
  const classified = new SimfinityError(error.message, code, status);
  classified.extensions = { ...extensions, ...classified.extensions };
  return classified;
};

const classifyValue = (value) => {
  if (value instanceof SimfinityError) return value;
  if (value instanceof GraphQLError) return classifyGraphQLError(value);
  // Never keep a non-Error value, such as a server's hook payload with request variables, as the cause.
  return value instanceof Error
    ? new InternalServerError(value.message, value)
    : new InternalServerError('Unexpected error value');
};

// A value thrown while executing a field. graphql-js raises its own code-less GraphQLErrors there too
// when it cannot complete a value (scalar or enum serialization, isTypeOf, abstract type resolution, a
// non-iterable list), and some print the value. So a GraphQLError raised there is an application error
// only with its own code or a SimfinityError cause; any other is unexpected.
const classifyThrown = (thrown) => {
  if (thrown instanceof GraphQLError && typeof thrown.extensions?.code !== 'string' && !simfinityCauseOf(thrown)) {
    return new InternalServerError(thrown.message, thrown);
  }
  return classifyValue(thrown);
};

// Errors raised while executing a field have a path; request errors (syntax, validation, variable
// coercion) never do. GraphQL servers pass the GraphQLError that graphql-js created around the value
// a resolver threw, and that value is classified, without unwrapping a GraphQLError the resolver
// threw any further. A thrown GraphQLError that already has a path is passed as is.
const classifyError = (error) => {
  if (!(error instanceof GraphQLError)) return classifyValue(error);
  if (!Array.isArray(error.path)) {
    // Scalar validation errors can wrap a plain Error unchanged, with or without nodes. A server
    // may report a source-stream failure in the same shape, so only an explicit internal cause
    // identifies it as unexpected; applications must mark those failures at their source.
    const cause = simfinityCauseOf(error);
    return cause instanceof InternalServerError ? cause : classifyValue(error);
  }
  return classifyThrown(isFieldErrorWrapper(error) ? thrownValueOf(error.originalError) : error);
};

// The error that a transaction field reports when the operation `operation`, at `operationIndex`, ended
// it (#151): a new error with the code, status and message that buildErrorFormatter gives
// `cause` when a root resolver throws it, and every extension of it, plus the operation's position. An
// InternalServerError stays one, as for a root, so the callback that masks unexpected errors still hides
// the message of a cause that is not an application error. The original is its non-enumerable `cause`,
// out of every copy of the error, and is never changed: it may be frozen, or shared. `getCause()` of an
// InternalServerError does not return a value that is not an Error, as for a root. Any other decoration
// of a cause that has a `getCause()`, such as the DATABASE_ERROR and TRANSACTION_RETRY_EXCEEDED errors the
// adapters build, keeps it: it returns what the cause's own returns, the driver error.
const decorateOperationError = (cause, operationIndex, operation) => {
  const classified = classifyThrown(cause);
  const decorated = classified instanceof InternalServerError
    ? new InternalServerError(classified.message)
    : new SimfinityError(classified.message, classified.extensions?.code, classified.extensions?.status);
  decorated.extensions = { ...classified.extensions, operationIndex, operation };
  Object.defineProperty(decorated, 'cause', {
    value: cause, writable: true, configurable: true, enumerable: false,
  });
  if (decorated instanceof InternalServerError) {
    if (!(cause instanceof Error)) decorated.getCause = () => undefined;
  } else if (typeof cause?.getCause === 'function') {
    decorated.getCause = () => cause.getCause();
  }
  return decorated;
};

export const buildErrorFormatter = (callback) => (error) => {
  const classified = classifyError(error);
  const chosen = (callback && callback(classified)) || classified;
  if (chosen instanceof GraphQLError) return chosen;
  const located = error instanceof GraphQLError ? error : null;
  return new GraphQLError(chosen.message, {
    nodes: located?.nodes,
    source: located?.source,
    positions: located?.positions,
    path: located?.path,
    originalError: chosen,
    extensions: chosen.extensions && typeof chosen.extensions === 'object' ? { ...chosen.extensions } : {},
  });
};

export { SimfinityError, InternalServerError };

// A field named like an Object.prototype member (`constructor`, `toString`, ...) that reads as that
// very member holds no value: graphql input objects and stored records without the field inherit
// it, and MongoDB nested paths return it from their own accessors. Other values, overriding members
// such as class methods and getters, and every other name read as usual. The property is read once,
// so a getter runs once, as with a plain read.
const isObjectMember = (key, read) => key in Object.prototype && read === Object.prototype[key];
const ownValue = (value, key) => {
  if (value == null) return undefined;
  const read = value[key];
  return isObjectMember(key, read) ? undefined : read;
};

// Output fields with such names read through this resolver instead of graphql's default one, which
// would call the inherited member. Otherwise it resolves as the default one does, calling a method
// with the parent as receiver, but reads the property only once. It reads no data, so installing it
// binds no type to a runtime.
const readOwnField = markGenerated((parent, args, context, info) => {
  if (parent === null || (typeof parent !== 'object' && typeof parent !== 'function')) return undefined;
  const property = parent[info.fieldName];
  if (isObjectMember(info.fieldName, property)) return null;
  return typeof property === 'function' ? property.call(parent, args, context, info) : property;
});

// Puts the version field into a protected type's getFields() map, after the type's own fields, unless
// the type carries it already: from an earlier schema, another runtime of this core copy that shares
// the type, or the type it was copied from. The resolver reads only the parent, so it binds the type to
// no runtime, and a record without a stored version, such as a MongoDB document written before the
// type was protected, reads as version 1. An invalid stored version is reported under the type being
// resolved, which a renamed copy shares the resolver with, or under the type it was injected into.
const injectVersionField = (gqltype) => {
  if (isProtected(gqltype)) return;
  const typeName = gqltype.name;
  gqltype.getFields().version = createVersionFieldConfig(markGenerated((parent, args, context, info) => readStoredVersion(
    retainedStoredVersion(parent) ?? ownValue(parent, 'version'),
    { typeName: info?.parentType?.name ?? typeName, id: ownValue(parent, '_id') ?? ownValue(parent, 'id') },
  )));
};

const cloneInput = (value, type) => {
  if (value === null || value === undefined || !type) return value;
  if (type instanceof GraphQLNonNull) return cloneInput(value, type.ofType);
  if (type instanceof GraphQLList) {
    return Array.isArray(value)
      ? value.map((item) => cloneInput(item, type.ofType))
      : value;
  }
  if (type instanceof GraphQLInputObjectType) {
    const fields = type.getFields();
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      fields[key] ? cloneInput(item, fields[key].type) : item,
    ]));
  }
  if (type instanceof GraphQLScalarType && value instanceof Date) {
    return new Date(value.getTime());
  }
  return value;
};

// Each transaction attempt works on its own copy of the request input, since hooks, validators and
// state actions may change it. The first copy is taken now, before the transaction starts, and is
// handed out once; a retry copies the request input again, which no attempt receives or changes.
const attemptInputs = (input, type) => {
  let first = cloneInput(input, type);
  let taken = false;
  return () => {
    if (taken) return cloneInput(input, type);
    taken = true;
    const value = first;
    first = undefined;
    return value;
  };
};

export const createRuntime = (adapter) => {
  if (!adapter) {
    throw new SimfinityError('A database adapter is required', 'ADAPTER_REQUIRED', 500);
  }
  // The filter operators the adapter compiles, read once: its queryFeatures.operators, or the 3.7.0
  // operators when it declares none. With queryFeatures.referenceEmptiness, it also compiles
  // IS_EMPTY and IS_NOT_EMPTY through references and collections (#108 part 2b), and a client's
  // conditions of that kind carry a scope marker from the runtime (see markClientConstructs).
  const {
    operators: supportedOperators, referenceEmptiness: supportsReferenceEmptiness,
  } = resolveQueryFeatures(adapter.queryFeatures);
  const supportsEveryOperator = QUERY_OPERATORS.every((operator) => supportedOperators.has(operator));
  // The write features the adapter implements, read once: with optimisticConcurrency, schemas may
  // contain protected types (#98).
  const writeFeatures = resolveWriteFeatures(adapter.writeFeatures);

  const stateValue = adapter.stateValue || ((state) => state.name);
  const runtimeIdentity = {};
  // The identity that execution states (execution-state.js) compare, so that a session lent to another
  // runtime finds no state.
  const runtimeToken = {};
  const typesDict = { types: {} };
  const waitingInputType = {};
  const typesDictForUpdate = { types: {} };
  // `added` item inputs of referenced collections by generated name, so collections that reach the
  // same child through the same connectionField share one input type.
  const excludedFieldInputTypes = new Map();
  // The operation inputs of referenced collections (the types with `added`, `updated` and `deleted`
  // that createOneToManyInputType builds). The typed input walk (operation-input.js) knows them by
  // identity, to find the record keys inside them: `updated[].id` and each `deleted` item.
  const collectionInputTypes = new WeakSet();
  // Self-referencing collection field name -> the types whose collection inputs were built with the
  // unqualified names OneToManyA<field> and OneToManyU<field>; type -> its self-referencing
  // collections whose inputs are named after the type instead (see claimSelfCollectionNames).
  const selfCollectionNameHolders = new Map();
  const qualifiedSelfCollections = new Map();
  const registeredMutations = {};
  // Models createModel() returned for this runtime, as opposed to models supplied to connect(). A type
  // with one was built for storage without a version field, even by a createSchema() that failed later.
  const generatedModels = new WeakSet();
  const registeredQueries = {};
  const registeredViews = {};
  const middlewares = [];

  const operations = {
    SAVE: 'save',
    UPDATE: 'update',
    DELETE: 'delete',
    STATE_CHANGED: 'state_changed',
    CUSTOM_MUTATION: 'custom_mutation',
    CUSTOM_QUERY: 'custom_query',
  };

  const use = (middleware) => {
    if (typeof middleware !== 'function') {
      throw new SimfinityError('Middleware must be a function', 'INVALID_MIDDLEWARE', 500);
    }
    middlewares.push(middleware);
  };

  let preventCollectionCreation = false;

  const preventCreatingCollection = (prevent) => {
    preventCollectionCreation = !!prevent;
  };

  const assertNotBoundElsewhere = (gqltype) => {
    const owner = runtimeBoundTypes.get(gqltype);
    if (owner !== undefined && owner !== runtimeIdentity) {
      throw new SimfinityError(
        `Type ${gqltype.name} is bound to another Simfinity runtime. Its relation fields resolve through the runtime `
          + 'that first created a schema reaching the type; define separate GraphQL types for each runtime, for example with a factory function',
        'TYPE_BOUND_TO_OTHER_RUNTIME',
        409,
      );
    }
  };

  const isForeign = (owner) => owner !== undefined && owner !== runtimeIdentity;
  // A field copied, with toConfig() or a field spread, from a type after another runtime generated
  // its relation resolver keeps that resolver or its extensions object. The extensions object counts
  // only for a field whose resolver is untagged, such as one other code wrapped in place. A field
  // without a resolver gets this runtime's own. graphql-js never runs interface field resolvers, so
  // interface fields are not checked; the types they reference are.
  const assertFieldsNotBoundElsewhere = (gqltype) => {
    if (gqltype instanceof GraphQLInterfaceType) return;
    for (const [fieldName, field] of Object.entries(gqltype.getFields())) {
      if (!field.resolve) continue;
      const resolverOwner = relationFieldOwners.get(field.resolve);
      if (isForeign(resolverOwner)
        || (resolverOwner === undefined && isForeign(relationFieldOwners.get(field.extensions)))) {
        throw new SimfinityError(
          `Field ${gqltype.name}.${fieldName} was copied from a relation field that another Simfinity runtime generated, `
            + 'with its resolver or its extensions; define the field for each runtime instead of copying it from a type '
            + 'that runtime already used',
          'TYPE_BOUND_TO_OTHER_RUNTIME',
          409,
        );
      }
    }
  };

  // Object and interface types reachable from these roots, following the output references of
  // GraphQLSchema: fields, interfaces and union members. Input objects cannot hold either.
  const collectOutputTypes = (roots) => {
    const visited = new Set();
    const outputTypes = [];
    const visit = (type) => {
      const named = type && getNamedType(type);
      if (!named || visited.has(named)) return;
      visited.add(named);
      if (named instanceof GraphQLUnionType) {
        named.getTypes().forEach(visit);
        return;
      }
      if (!(named instanceof GraphQLObjectType || named instanceof GraphQLInterfaceType)) return;
      outputTypes.push(named);
      named.getInterfaces().forEach(visit);
      for (const field of Object.values(named.getFields())) visit(field.type);
    };
    roots.forEach(visit);
    return outputTypes;
  };

  // Object and interface types a schema of this runtime can reach from its registered types and
  // custom operation results, following the same references as GraphQLSchema.
  const collectSchemaOutputTypes = () => {
    const registeredTypes = Object.values(typesDict.types).map(({ gqltype }) => gqltype);
    const customOperations = [
      ...Object.values(registeredMutations),
      ...Object.values(registeredQueries),
    ];
    const customOutputTypes = customOperations.map(({ outputModel }) => outputModel);
    return collectOutputTypes([...registeredTypes, ...customOutputTypes]);
  };

  const hasUnresolvedRelation = (gqltype) => Object.values(gqltype.getFields()).some(
    (field) => field.extensions?.relation && !field.extensions.relation.embedded && !field.resolve,
  );

const QLFilter = new GraphQLInputObjectType({
  name: 'QLFilter',
  fields: () => ({
    operator: { type: QLOperator },
    value: { type: QLValue },
  }),
});

const QLTypeFilter = new GraphQLInputObjectType({
  name: 'QLTypeFilter',
  fields: () => ({
    operator: { type: QLOperator },
    value: { type: QLValue },
    path: { type: GraphQLString },
  }),
});

const IdInputType = new GraphQLInputObjectType({
  name: 'IdInputType',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLString) },
  }),
});

const QLTypeFilterExpression = new GraphQLInputObjectType({
  name: 'QLTypeFilterExpression',
  fields: () => ({
    terms: { type: new GraphQLList(QLTypeFilter) },
  }),
});

const QLFilterCondition = new GraphQLInputObjectType({
  name: 'QLFilterCondition',
  fields: () => ({
    field: { type: new GraphQLNonNull(GraphQLString) },
    operator: { type: QLOperator },
    value: { type: QLValue },
    path: { type: GraphQLString },
  }),
});

const QLFilterGroup = new GraphQLInputObjectType({
  name: 'QLFilterGroup',
  fields: () => ({
    AND: { type: new GraphQLList(QLFilterGroup) },
    OR: { type: new GraphQLList(QLFilterGroup) },
    conditions: { type: new GraphQLList(QLFilterCondition) },
  }),
});

const QLPagination = new GraphQLInputObjectType({
  name: 'QLPagination',
  fields: () => ({
    page: { type: new GraphQLNonNull(GraphQLInt) },
    size: { type: new GraphQLNonNull(GraphQLInt) },
    count: { type: GraphQLBoolean },
  }),
});

const QLSortExpression = new GraphQLInputObjectType({
  name: 'QLSortExpression',
  fields: () => ({
    terms: { type: new GraphQLList(QLSort) },
  }),
});

const QLAggregationOperation = new GraphQLEnumType({
  name: 'QLAggregationOperation',
  values: {
    SUM: { value: 'SUM' },
    COUNT: { value: 'COUNT' },
    AVG: { value: 'AVG' },
    MIN: { value: 'MIN' },
    MAX: { value: 'MAX' },
  },
});

const QLTypeAggregationFact = new GraphQLInputObjectType({
  name: 'QLTypeAggregationFact',
  fields: () => ({
    operation: { type: new GraphQLNonNull(QLAggregationOperation) },
    factName: { type: new GraphQLNonNull(GraphQLString) },
    path: { type: new GraphQLNonNull(GraphQLString) },
  }),
});

const QLTypeAggregationExpression = new GraphQLInputObjectType({
  name: 'QLTypeAggregationExpression',
  fields: () => ({
    groupId: { type: new GraphQLNonNull(GraphQLString) },
    facts: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(QLTypeAggregationFact))) },
  }),
});

// Aggregation results use Simfinity's JSON scalar, or the application's own scalar named JSON when
// the schema has one, such as GraphQLJSON from graphql-scalars, so the two do not collide.
const createAggregationResultType = (valueType) => new GraphQLObjectType({
  name: 'QLTypeAggregationResult',
  fields: () => ({
    groupId: { type: valueType },
    facts: { type: valueType },
  }),
});
const QLTypeAggregationResult = createAggregationResultType(GraphQLJSON);
const applicationJSONResultTypes = new WeakMap();
const aggregationResultTypeFor = (valueType) => {
  if (valueType === GraphQLJSON) return QLTypeAggregationResult;
  if (!applicationJSONResultTypes.has(valueType)) {
    applicationJSONResultTypes.set(valueType, createAggregationResultType(valueType));
  }
  return applicationJSONResultTypes.get(valueType);
};

const isNonNullOfType = (fieldEntryType, graphQLType) => {
  let isOfType = false;
  if (fieldEntryType instanceof GraphQLNonNull) {
    isOfType = fieldEntryType.ofType instanceof graphQLType;
  }
  return isOfType;
};

const unwrapNonNull = (type) => (type instanceof GraphQLNonNull ? type.ofType : type);
const isAbstractOutputType = (type) => type instanceof GraphQLInterfaceType || type instanceof GraphQLUnionType;

const unwrapListAndNonNull = (type) => {
  let unwrapped = type;
  while (unwrapped instanceof GraphQLList || unwrapped instanceof GraphQLNonNull) {
    unwrapped = unwrapped.ofType;
  }
  return unwrapped;
};

const wrapListInputType = (itemType, listShape, preserveOuterNonNull) => {
  const wrappedItem = listShape.itemNonNull ? new GraphQLNonNull(itemType) : itemType;
  const listType = new GraphQLList(wrappedItem);
  return preserveOuterNonNull && listShape.outerNonNull
    ? new GraphQLNonNull(listType)
    : listType;
};

const capitalize = (name) => name.charAt(0).toUpperCase() + name.slice(1);

// A GraphQL input object needs at least one field, so a generated input that would have none is
// left out, together with the operations, fields and mutations that would take it (#161).
const hasInputFields = (inputType) => Object.keys(inputType.getFields()).length > 0;

/**
 * The `added` item input of a referenced collection: the item type's create input without the
 * back-reference that the parent supplies. Its fields are read from the item's create input when
 * the schema is built, so the item's input may be built after this type, as in cycles of
 * collections. `optionalFields` lose their outer non-null wrapper. Collections that reach the same
 * item through the same connectionField with the same prefix share one type.
 * @param {string} inputNamePrefix - The prefix for the input type name.
 * @param {GraphQLObjectType} itemType - The collection's item type.
 * @param {string} fieldToExclude - The name of the field to exclude.
 * @param {string} [connectionFieldName] - The declared connectionField, which names the type.
 * @param {string[]} [optionalFields] - Fields of the item's create input that become optional.
 * @returns {GraphQLInputObjectType} An input type without the specified field.
 */
const createTypeWithExcludedField = (inputNamePrefix, itemType, fieldToExclude,
  connectionFieldName = fieldToExclude, optionalFields = []) => {
  // The item's create input is `${itemType.name}Input`, so the name is the one it always had.
  const name = `${inputNamePrefix}${itemType.name}InputFor${capitalize(connectionFieldName)}`;
  const shared = excludedFieldInputTypes.get(name);
  if (shared && shared.itemType === itemType && shared.fieldToExclude === fieldToExclude
    && shared.optionalFields.join() === optionalFields.join()) {
    return shared.type;
  }
  // Any other type with this name is a new one, so a real name clash still fails as before.
  const type = new GraphQLInputObjectType({
    name,
    fields: () => Object.fromEntries(
      Object.entries(getInputType(itemType).getFields())
        .filter(([fieldName]) => fieldName !== fieldToExclude)
        .map(([fieldName, field]) => [fieldName, {
          type: optionalFields.includes(fieldName) ? unwrapNonNull(field.type) : field.type,
          description: field.description,
          defaultValue: field.defaultValue,
        }]),
    ),
  });
  if (!shared) excludedFieldInputTypes.set(name, { itemType, fieldToExclude, optionalFields, type });
  return type;
};

// A referenced collection's operation input. The item inputs are read when the schema is built, so
// the item type's inputs need not exist yet. `added` or `updated` is left out when its item input
// would have no fields, such as `added` for a child whose only writable field is the back-reference;
// `deleted` always remains. `owner` names the collection, as `Type.field`, in the warning.
const createOneToManyInputType = (name, inputNamePrefix, itemType, connection,
  itemNonNull = false, optionalFields = [], owner = name) => {
  const inputTypeForAdd = connection.declaredFieldName
    ? createTypeWithExcludedField(
      inputNamePrefix,
      itemType,
      connection.graphqlFieldName || connection.declaredFieldName,
      connection.declaredFieldName,
      optionalFields,
    )
    : null;
  const listOf = (type) => new GraphQLList(itemNonNull ? new GraphQLNonNull(type) : type);

  const omittedOperation = {
    added: () => `because ${itemType.name} has no writable fields`
      + `${connection.declaredFieldName ? ` besides its connectionField ${connection.declaredFieldName}` : ''}; `
      + `create ${itemType.name} records with its own mutations or a registered mutation.`,
    updated: () => `because ${itemType.name} has no writable fields and no writable id; update `
      + `${itemType.name} records with a registered mutation.`,
  };

  const collectionInput = new GraphQLInputObjectType({
    name,
    fields: () => {
      const fields = {};
      const itemInputs = {
        added: inputTypeForAdd || getInputType(itemType),
        updated: typesDictForUpdate.types[itemType.name].inputType,
      };
      for (const [operation, itemInput] of Object.entries(itemInputs)) {
        if (hasInputFields(itemInput)) {
          fields[operation] = { type: listOf(itemInput) };
        } else {
          warnOnce(itemType, `emptyItemInput:${owner}:${operation}`, `Configuration issue: ${owner} has no `
            + `\`${operation}\` operation in generated inputs, ${omittedOperation[operation]()}`);
        }
      }
      // Null entries are skipped, so `deleted` accepts them whatever the collection's item nullability.
      // A protected item is deleted at the version the client read, whether or not the parent is
      // protected (#98).
      fields.deleted = { type: new GraphQLList(isProtected(itemType) ? RecordVersionRef : GraphQLID) };
      return fields;
    },
  });
  collectionInputTypes.add(collectionInput);
  return collectionInput;
};

// What graphQLListInputType returns for a list of an embedded type whose input has no fields.
const NO_INPUT_FIELDS = Symbol('no input fields');

const graphQLListInputType = (dict, fieldEntry, fieldEntryName,
  inputNamePrefix, connectionField, preserveOuterNonNull, ownerName) => {
  const listShape = getListShape(fieldEntry.type);
  if (!listShape) return null;
  const { itemType } = listShape;

  if (itemType instanceof GraphQLObjectType) {
    const registration = requireRegisteredType(dict, itemType, fieldEntryName, ownerName);
    // A referenced collection reads its item inputs lazily, so it never waits for them.
    if (!fieldEntry.extensions?.relation?.embedded) {
      const oneToMany = createOneToManyInputType(`OneToMany${inputNamePrefix}${fieldEntryName}`,
        inputNamePrefix, itemType, normalizeConnectionField(itemType, connectionField),
        listShape.itemNonNull, [], `${ownerName}.${fieldEntryName}`);
      return preserveOuterNonNull && listShape.outerNonNull
        ? new GraphQLNonNull(oneToMany)
        : oneToMany;
    }
    if (registration.inputType) {
      return hasInputFields(registration.inputType)
        ? wrapListInputType(registration.inputType, listShape, preserveOuterNonNull)
        : NO_INPUT_FIELDS;
    }
  } else if (itemType instanceof GraphQLScalarType || itemType instanceof GraphQLEnumType) {
    return wrapListInputType(itemType, listShape, preserveOuterNonNull);
  }
  return null;
};

// Writable list fields whose items are the type itself, as buildInputType selects them. Their
// collection inputs are named OneToManyA<field> and OneToManyU<field> (see claimSelfCollectionNames).
const selfCollectionFieldNames = (gqltype) => {
  const hasStateMachine = !!typesDict.types[gqltype.name]?.stateMachine;
  return Object.entries(gqltype.getFields())
    .filter(([fieldName, field]) => !isReadOnlyField(field)
      && !(fieldName === 'state' && hasStateMachine)
      && getListShape(field.type)?.itemType === gqltype)
    .map(([fieldName]) => fieldName);
};

const selfCollectionInputType = (gqltype, fieldEntryName, fieldEntry, forUpdate, selfFields) => {
  const listShape = getListShape(fieldEntry.type);
  const qualifier = qualifiedSelfCollections.get(gqltype)?.has(fieldEntryName) ? gqltype.name : '';
  const kind = forUpdate ? 'U' : 'A';
  const oneToMany = createOneToManyInputType(
    `OneToMany${qualifier}${kind}${fieldEntryName}`,
    kind,
    gqltype,
    normalizeConnectionField(gqltype, fieldEntry.extensions?.relation?.connectionField),
    listShape.itemNonNull,
    // Items an add mutation creates may carry their own self-referencing collections. These stay
    // optional there, as such items had no such fields before; items added by an update keep them
    // as the type declares them.
    forUpdate ? [] : selfFields,
    `${gqltype.name}.${fieldEntryName}`,
  );
  return !forUpdate && listShape.outerNonNull ? new GraphQLNonNull(oneToMany) : oneToMany;
};

// An embedded field, single or list, whose embedded type's create or update input has no fields is
// left out of that input of its owner. Only the create input is empty when the type's writable fields
// hold only ids, which create inputs leave out; generated updates still set the field then.
const warnEmptyEmbeddedInputs = (gqltype, fieldName, embeddedTypeName, noCreate, noUpdate) => {
  if (!noCreate && !noUpdate) return;
  const field = `Configuration issue: ${gqltype.name}.${fieldName} `;
  if (!noUpdate) {
    warnOnce(gqltype, `emptyEmbeddedInput:${fieldName}`, `${field}is left out of generated create inputs, because `
      + `the create input of its embedded type ${embeddedTypeName} would have no fields (create inputs leave out `
      + 'ids), so generated creates cannot set it, while generated updates still can; to set it on create, use a '
      + 'controller or a registered mutation.');
    return;
  }
  const inputs = [noCreate && 'create', 'update'].filter(Boolean).join(' and ');
  warnOnce(gqltype, `emptyEmbeddedInput:${fieldName}`, `${field}is left out of generated ${inputs} inputs, because `
    + `its embedded type ${embeddedTypeName} has no writable fields, so generated mutations cannot set it; set it `
    + 'in a controller or a registered mutation, and mark it readOnly to state that it is output-only.');
};

// A non-null embedded field, single or list, that generated create inputs cannot set. Generated
// mutations that reach the owner's create input would store records without it, so such a schema is
// rejected; one whose generated mutations cannot reach that input only leaves the field out.
const requiredEmbeddedWithoutInputError = (gqltype, { field, embeddedTypeName }) => new SimfinityError(
  `${gqltype.name}.${field} is non-null but its embedded type ${embeddedTypeName} has no writable fields, so `
    + 'generated create inputs cannot set it; mark it readOnly and set it in a controller, or make it nullable',
  'INVALID_MODEL',
  400,
);
// Registration -> the non-null embedded fields its create input left out.
const requiredFieldsWithoutCreateInput = new WeakMap();

// Builds a type's create and update inputs, or returns every field whose input cannot be built yet:
// `{ unresolvedFields: [{ field, waitsFor }] }`, where `waitsFor` names the embedded type whose
// inputs the field waits for, and is absent when the field can have no generated input. `reachable`
// holds the types whose inputs the generated mutations of the schema reach.
const buildInputType = (gqltype, reachable) => {
  const argTypes = gqltype.getFields();

  const fieldsArgs = {};
  const fieldsArgForUpdate = {};

  const selfReferenceCollections = {};
  const unresolvedFields = [];
  const requiredWithoutCreateInput = [];
  // Leaves a non-null embedded field without a create input out, or rejects the schema.
  const omitRequiredEmbedded = (field, embeddedTypeName) => {
    const omitted = { field, embeddedTypeName };
    if (reachable.has(gqltype)) throw requiredEmbeddedWithoutInputError(gqltype, omitted);
    requiredWithoutCreateInput.push(omitted);
  };

  for (const [fieldEntryName, fieldEntry] of Object.entries(argTypes)) {
    const fieldArg = {};
    const fieldArgForUpdate = {};

    if (!isReadOnlyField(fieldEntry)) {
      const hasStateMachine = !!typesDict.types[gqltype.name].stateMachine;
      const stateFieldManagedByStateMachine = !!(fieldEntryName === 'state' && hasStateMachine);

      if (!stateFieldManagedByStateMachine) {
        if (fieldEntry.type instanceof GraphQLScalarType
          || fieldEntry.type instanceof GraphQLEnumType
          || isNonNullOfType(fieldEntry.type, GraphQLScalarType)
          || isNonNullOfType(fieldEntry.type, GraphQLEnumType)) {
          if (fieldEntryName !== 'id') {
            fieldArg.type = fieldEntry.type;
          }
          fieldArgForUpdate.type = fieldEntry.type instanceof GraphQLNonNull
            ? fieldEntry.type.ofType : fieldEntry.type;
          if (fieldEntryName === 'id' && unwrapNonNull(fieldEntry.type) === GraphQLID) {
            fieldArgForUpdate.type = new GraphQLNonNull(GraphQLID);
          }
        } else if (fieldEntry.type instanceof GraphQLObjectType
          || isNonNullOfType(fieldEntry.type, GraphQLObjectType)) {
          if (fieldEntry.extensions && fieldEntry.extensions.relation) {
            const fieldEntryNameValue = fieldEntry.type instanceof GraphQLNonNull
              ? fieldEntry.type.ofType.name : fieldEntry.type.name;
            if (!fieldEntry.extensions.relation.embedded) {
              fieldArg.type = fieldEntry.type instanceof GraphQLNonNull
                ? new GraphQLNonNull(IdInputType) : IdInputType;
              fieldArgForUpdate.type = IdInputType;
            } else if (requireRegisteredType(typesDict, unwrapNonNull(fieldEntry.type), fieldEntryName,
              gqltype.name).inputType
              && typesDictForUpdate.types[fieldEntryNameValue].inputType) {
              // Create and update inputs are decided apart: an embedded type whose only writable
              // field is `id` has one only for updates.
              const embeddedCreate = typesDict.types[fieldEntryNameValue].inputType;
              const embeddedUpdate = typesDictForUpdate.types[fieldEntryNameValue].inputType;
              if (hasInputFields(embeddedCreate)) fieldArg.type = embeddedCreate;
              else if (fieldEntry.type instanceof GraphQLNonNull) {
                omitRequiredEmbedded(fieldEntryName, fieldEntryNameValue);
              }
              if (hasInputFields(embeddedUpdate)) fieldArgForUpdate.type = embeddedUpdate;
              warnEmptyEmbeddedInputs(gqltype, fieldEntryName, fieldEntryNameValue,
                !fieldArg.type, !fieldArgForUpdate.type);
            } else {
              unresolvedFields.push({ field: fieldEntryName, waitsFor: fieldEntryNameValue });
            }
          } else if (unresolvedFields.length === 0) {
            // Fields after one that cannot be built yet are only checked, so this logs as many times
            // as when the build stopped at that field.
            console.warn(`Configuration issue: Field ${fieldEntryName} does not define extensions.relation`);
          }
        } else if (isAbstractOutputType(unwrapListAndNonNull(fieldEntry.type))) {
          // Generated inputs cannot write an interface or union value, single or in a list, so the
          // field is output-only. readOnly fields never get here.
          warnOnce(gqltype, `abstract:${fieldEntryName}`, `Configuration issue: ${gqltype.name}.${fieldEntryName} `
            + 'has an interface or union type, so generated inputs leave it out and generated mutations cannot '
            + 'set it; resolve it yourself, and mark it readOnly to state that it is output-only.');
        } else if (getListShape(fieldEntry.type)) {
          const listShape = getListShape(fieldEntry.type);
          if (listShape.itemType === gqltype) {
            selfReferenceCollections[fieldEntryName] = fieldEntry;
          } else {
            const listInputTypeForAdd = graphQLListInputType(typesDict, fieldEntry,
              fieldEntryName, `${gqltype.name}A`,
              fieldEntry.extensions?.relation?.connectionField, true, gqltype.name);
            const listInputTypeForUpdate = graphQLListInputType(typesDictForUpdate, fieldEntry,
              fieldEntryName, `${gqltype.name}U`,
              fieldEntry.extensions?.relation?.connectionField, false, gqltype.name);
            if (listInputTypeForAdd && listInputTypeForUpdate) {
              if (listInputTypeForAdd !== NO_INPUT_FIELDS) fieldArg.type = listInputTypeForAdd;
              else if (listShape.outerNonNull) omitRequiredEmbedded(fieldEntryName, listShape.itemType.name);
              if (listInputTypeForUpdate !== NO_INPUT_FIELDS) fieldArgForUpdate.type = listInputTypeForUpdate;
              warnEmptyEmbeddedInputs(gqltype, fieldEntryName, listShape.itemType.name,
                listInputTypeForAdd === NO_INPUT_FIELDS, listInputTypeForUpdate === NO_INPUT_FIELDS);
            } else {
              // An object item here is embedded and its inputs are not built yet; any other item,
              // such as a list, has no generated input.
              unresolvedFields.push(listShape.itemType instanceof GraphQLObjectType
                ? { field: fieldEntryName, waitsFor: listShape.itemType.name }
                : { field: fieldEntryName });
            }
          }
        }
        if (fieldArg.type && fieldEntry.type instanceof GraphQLNonNull
          && !(fieldArg.type instanceof GraphQLNonNull)) fieldArg.type = new GraphQLNonNull(fieldArg.type);
        fieldArg.description = fieldEntry.description;
        fieldArgForUpdate.description = fieldEntry.description;

        if (fieldArg.type) {
          fieldsArgs[fieldEntryName] = fieldArg;
        }

        if (fieldArgForUpdate.type) {
          fieldsArgForUpdate[fieldEntryName] = fieldArgForUpdate;
        }
      } else {
        fieldEntry.extensions = { ...fieldEntry.extensions, stateMachine: true };
      }
    }
  }

  if (unresolvedFields.length > 0) return { unresolvedFields };

  // Self-referencing collections follow the other fields, as they always have. Their item inputs
  // are read when the schema is built, after these input types exist.
  const selfFields = Object.keys(selfReferenceCollections);
  for (const [fieldEntryName, fieldEntry] of Object.entries(selfReferenceCollections)) {
    fieldsArgs[fieldEntryName] = {
      type: selfCollectionInputType(gqltype, fieldEntryName, fieldEntry, false, selfFields),
      description: fieldEntry.description,
    };
    fieldsArgForUpdate[fieldEntryName] = {
      type: selfCollectionInputType(gqltype, fieldEntryName, fieldEntry, true, selfFields),
      description: fieldEntry.description,
    };
  }
  // The version field is readOnly, so only this adds it, last and required, to a protected type's
  // update input, which updates, state actions and nested `updated` entries take (#98). Create inputs,
  // and the `added` items built from them, never get it. An update input that would hold only the
  // version, with no writable id or other field, is left without fields as before (#161), so the type
  // has no update mutation, state actions or nested `updated` entries, and keeps its delete mutation.
  if (isProtected(gqltype) && Object.keys(fieldsArgForUpdate).length > 0) {
    fieldsArgForUpdate.version = { type: new GraphQLNonNull(RecordVersion), description: argTypes.version.description };
  }

  const inputTypeForAdd = new GraphQLInputObjectType({
    name: `${gqltype.name}Input`,
    description: gqltype.description,
    fields: fieldsArgs,
  });
  const inputTypeForUpdate = new GraphQLInputObjectType({
    name: `${gqltype.name}InputForUpdate`,
    description: gqltype.description,
    fields: fieldsArgForUpdate,
  });

  return {
    inputTypeBody: inputTypeForAdd, inputTypeBodyForUpdate: inputTypeForUpdate, requiredWithoutCreateInput,
  };
};

const getInputType = (type) => typesDict.types[type.name].inputType;

// Registered types whose generated inputs the generated mutations of this schema can reach: the
// included endpoint types and, through their writable fields, embedded types and the items of
// collections.
const typesWithReachableInputs = (includedMutationTypes) => {
  const reached = new Set();
  const visit = (gqltype) => {
    if (reached.has(gqltype)) return;
    reached.add(gqltype);
    for (const field of Object.values(gqltype.getFields())) {
      if (isReadOnlyField(field)) continue;
      const listShape = getListShape(field.type);
      const target = listShape ? listShape.itemType : unwrapNonNull(field.type);
      // A single reference is an IdInputType, so it reaches no input of its target.
      if (target instanceof GraphQLObjectType && typesDict.types[target.name]
        && (listShape || field.extensions?.relation?.embedded)) {
        visit(typesDict.types[target.name].gqltype);
      }
    }
  };
  for (const type of Object.values(typesDict.types)) {
    if (type.endpoint && !shouldNotBeIncludedInSchema(includedMutationTypes, type.gqltype)) {
      visit(type.gqltype);
    }
  }
  return reached;
};

// A self-referencing collection's inputs are OneToManyA<field> and OneToManyU<field>. When several
// types that the generated mutations reach have one with the same field name, the first registered
// keeps those names and the others get OneToMany<Type>A<field> and OneToMany<Type>U<field>, as other
// collections do. Types the mutations cannot reach keep the unqualified names, as such inputs never
// collided. Names are fixed when a type's inputs are built, at its first schema.
// A type is qualified only when this schema also reaches an earlier type that holds the unqualified
// names and is still the type registered under its name, since both inputs then meet in one schema,
// which failed with a duplicate type name before such names were qualified. Otherwise, as with a
// type registered again under the same name or after an earlier createSchema(), it keeps the
// unqualified names.
const claimSelfCollectionNames = (pending, includedMutationTypes) => {
  const reachable = typesWithReachableInputs(includedMutationTypes);
  const meets = (type) => typesDict.types[type.name]?.gqltype === type && reachable.has(type);
  for (const { gqltype } of Object.values(pending)) {
    if (typesDict.types[gqltype.name].inputType) continue;
    for (const fieldName of selfCollectionFieldNames(gqltype)) {
      if (!selfCollectionNameHolders.has(fieldName)) selfCollectionNameHolders.set(fieldName, []);
      const holders = selfCollectionNameHolders.get(fieldName);
      const owner = reachable.has(gqltype) && holders.find((type) => type !== gqltype && meets(type));
      if (!owner) {
        if (!holders.includes(gqltype)) holders.push(gqltype);
      } else {
        if (!qualifiedSelfCollections.has(gqltype)) qualifiedSelfCollections.set(gqltype, new Set());
        qualifiedSelfCollections.get(gqltype).add(fieldName);
        warnOnce(gqltype, `selfCollectionName:${fieldName}`, `Configuration issue: ${gqltype.name}.${fieldName} `
          + `and ${owner.name}.${fieldName} are self-referencing collections with the same name, so the inputs `
          + `of ${gqltype.name}.${fieldName} are named OneToMany${gqltype.name}A${fieldName} and `
          + `OneToMany${gqltype.name}U${fieldName}, while ${owner.name}.${fieldName} keeps OneToManyA${fieldName} `
          + `and OneToManyU${fieldName}. To choose which type keeps those names, register it first, or make `
          + 'the other type unreachable from the generated mutations.');
      }
    }
  }
};

// The INPUT_TYPE_UNRESOLVED message. It names every field whose input could not be built, by type:
// the causes (lists whose items have no generated input, and embedded fields whose types contain
// each other) and, apart from them, fields that only wait for another listed type.
const unresolvedInputTypesMessage = (pendingTypeNames, unresolvedByType) => {
  // Whether the inputs of type `from` wait, through embedded fields, for those of type `to`.
  const waitsOn = (from, to, seen = new Set()) => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (unresolvedByType[from] || [])
      .some(({ waitsFor }) => waitsFor !== undefined && waitsOn(waitsFor, to, seen));
  };
  const lists = [];
  const cycles = [];
  const waiting = [];
  for (const [typeName, fields] of Object.entries(unresolvedByType)) {
    for (const { field, waitsFor } of fields) {
      const name = `${typeName}.${field}`;
      if (waitsFor === undefined) lists.push(name);
      else if (waitsOn(waitsFor, typeName)) cycles.push(name);
      else waiting.push(`${name} waits for ${waitsFor}`);
    }
  }
  const causes = [
    lists.length > 0 && `${lists.join(', ')} (writable lists whose items have no generated input, such as lists of lists)`,
    cycles.length > 0 && `${cycles.join(', ')} (embedded types that contain each other)`,
  ].filter(Boolean);
  return `Could not build input types for: ${pendingTypeNames.join(', ')}. `
    + 'Check for circular or misconfigured relations'
    + (causes.length > 0
      ? `: no input can be generated for ${causes.join(' or for ')}; mark such a field readOnly.`
      : '.')
    + (waiting.length > 0
      ? ` These fields only wait for another listed type and build once it does: ${waiting.join(', ')}.`
      : '');
};

const buildPendingInputTypes = (waitingForInputType, includedMutationTypes) => {
  claimSelfCollectionNames(waitingForInputType, includedMutationTypes);
  // Inputs built for an earlier schema, which did not reach them, may leave out a non-null embedded
  // field that this schema's generated mutations would need; inputs built now are checked as built.
  const reachable = typesWithReachableInputs(includedMutationTypes);
  for (const gqltype of reachable) {
    const registration = typesDict.types[gqltype.name];
    const [omitted] = (registration.inputType && requiredFieldsWithoutCreateInput.get(registration)) || [];
    if (omitted) throw requiredEmbeddedWithoutInputError(gqltype, omitted);
  }
  let pending = waitingForInputType;
  let previousPendingCount = Object.keys(pending).length + 1;
  // Type name -> the fields whose input could not be built in the last pass.
  let unresolvedFields = {};

  while (Object.keys(pending).length > 0) {
    const currentCount = Object.keys(pending).length;
    if (currentCount >= previousPendingCount) {
      throw new SimfinityError(unresolvedInputTypesMessage(Object.keys(pending), unresolvedFields),
        'INPUT_TYPE_UNRESOLVED', 500);
    }
    previousPendingCount = currentCount;

    const stillWaiting = {};
    unresolvedFields = {};
    for (const [key, value] of Object.entries(pending)) {
      const { gqltype } = value;
      if (typesDict.types[gqltype.name].inputType) continue;

      const result = buildInputType(gqltype, reachable);
      if (result.inputTypeBody && result.inputTypeBodyForUpdate) {
        typesDict.types[gqltype.name].inputType = result.inputTypeBody;
        typesDictForUpdate.types[gqltype.name].inputType = result.inputTypeBodyForUpdate;
        requiredFieldsWithoutCreateInput.set(typesDict.types[gqltype.name], result.requiredWithoutCreateInput);
      } else {
        stillWaiting[key] = value;
        unresolvedFields[gqltype.name] = result.unresolvedFields;
      }
    }
    pending = stillWaiting;
  }
};

const materializeModel = async (args, gqltype, linkToParent, operation, session) => {
  if (!args) {
    return null;
  }

  const argTypes = gqltype.getFields();

  const modelArgs = {};
  const collectionFields = {};

  for (const [fieldEntryName, fieldEntry] of Object.entries(argTypes)) {
    // A virtual field stores nothing, whatever middleware or saveObject() passes for it, and Simfinity
    // writes the version field of a protected type itself (#98).
    if (isVirtualField(fieldEntry) || isVersionField(fieldEntry)) continue;
    const fieldValue = ownValue(args, fieldEntryName);
    if (fieldEntry.extensions && fieldEntry.extensions.validations
      && fieldEntry.extensions.validations[operation]) {
      for (const validator of fieldEntry.extensions.validations[operation]) {
        await validator.validate(gqltype.name, fieldEntryName, fieldValue, session);
      }
    }

    if (fieldValue !== undefined && fieldValue !== null) {
      if (fieldEntry.type instanceof GraphQLScalarType
        || fieldEntry.type instanceof GraphQLEnumType
        || isNonNullOfType(fieldEntry.type, GraphQLScalarType)
        || isNonNullOfType(fieldEntry.type, GraphQLEnumType)) {
        modelArgs[fieldEntryName] = fieldValue;
      } else if (fieldEntry.type instanceof GraphQLObjectType
        || isNonNullOfType(fieldEntry.type, GraphQLObjectType)) {
        if (fieldEntry.extensions && fieldEntry.extensions.relation) {
          if (!fieldEntry.extensions.relation.embedded) {
            modelArgs[getFieldStorageName(fieldEntryName, fieldEntry)] = adapter.castId(fieldValue.id);
          } else {
            const fieldType = fieldEntry.type instanceof GraphQLNonNull
              ? fieldEntry.type.ofType : fieldEntry.type;
            modelArgs[fieldEntryName] = (await materializeModel(fieldValue, fieldType,
              null, operation, session)).modelArgs;
          }
        } else {
          throw new SimfinityError(
            `Field ${gqltype.name}.${fieldEntryName} is an object type but does not define extensions.relation`,
            'MISSING_RELATION_EXTENSION',
            500,
          );
        }
      } else if (getListShape(fieldEntry.type)) {
        const { itemType } = getListShape(fieldEntry.type);
        if (itemType instanceof GraphQLObjectType && fieldEntry.extensions
          && fieldEntry.extensions.relation) {
          if (!fieldEntry.extensions.relation.embedded) {
            collectionFields[fieldEntryName] = fieldValue;
          } else if (fieldEntry.extensions.relation.embedded) {
            const collectionEntries = [];

            for (const element of fieldValue) {
              if (element === null) {
                collectionEntries.push(null);
              } else {
                const collectionEntry = (await materializeModel(element, itemType,
                  null, operation, session)).modelArgs;
                if (collectionEntry) collectionEntries.push(collectionEntry);
              }
            }
            modelArgs[fieldEntryName] = collectionEntries;
          }
        } else if (itemType instanceof GraphQLScalarType || itemType instanceof GraphQLEnumType) {
          modelArgs[fieldEntryName] = fieldValue;
        }
      }
    } else if (operation === 'CREATE' && fieldEntryName in Object.prototype && getListShape(fieldEntry.type)
      && !(fieldEntry.extensions?.relation && !fieldEntry.extensions.relation.embedded)) {
      // A create without a value stores [] for a list: SQL backends store it for every list, and
      // Mongoose defaults to it, except for a list named like an Object.prototype member, where it
      // finds the inherited member. Collections are not stored on the record.
      modelArgs[fieldEntryName] = [];
    }
  }

  if (linkToParent) {
    linkToParent(modelArgs);
  }

  if (gqltype.extensions && gqltype.extensions.validations
    && gqltype.extensions.validations[operation]) {
    for (const validator of gqltype.extensions.validations[operation]) {
      await validator.validate(gqltype.name, args, modelArgs, session);
    }
  }

  return { modelArgs, collectionFields };
};

// Custom queries run without a transaction or session; custom mutations run in one, which may retry.
const executeRegisteredOperation = (args, registration, operation, context) => {
  const { inputModel, callback } = registration;
  if (operation === operations.CUSTOM_QUERY) {
    return callback(cloneInput(args, inputModel), context);
  }
  const nextInput = attemptInputs(args, inputModel);
  return adapter.withTransaction(
    null,
    (mySession) => callback(nextInput(), mySession, context),
  );
};

const iterateOnCollectionFields = async (materializedModel, gqltype, objectId, session, context) => {
  for (const [collectionFieldKey, collectionField] of Object.entries(materializedModel.collectionFields)) {
    if (collectionField.added) {
      await executeItemFunction(gqltype, collectionFieldKey, objectId, session,
        collectionField.added, operations.SAVE, context);
    }
    if (collectionField.updated) {
      await executeItemFunction(gqltype, collectionFieldKey, objectId, session,
        collectionField.updated, operations.UPDATE, context);
    }
    if (collectionField.deleted) {
      await executeItemFunction(gqltype, collectionFieldKey, objectId, session,
        collectionField.deleted, operations.DELETE, context);
    }
  }
};

// Whether the runtime may skip a read by ID whose result it does not use: the adapter reports that
// such a read of the model has no side effects, such as query middleware, and fails only where the
// update or delete by that ID fails too. Without the report, those reads run as before.
const readByIdIsInert = (Model) => typeof adapter.readByIdIsInert === 'function'
  && adapter.readByIdIsInert(Model) === true;

// Optimistic concurrency (#98). Every update, state action, delete and nested entry of a protected
// type first reads its record whole, plain and locked: the pre-read, which also serves the embedded
// merge, the from-state check and onDelete. Its version is normalized before any hook sees it, so a
// MongoDB document stored before the type was protected shows 1, as on PostgreSQL.
const normalizeProtectedVersion = (record, gqltype, id) => {
  record.version = readStoredVersion(record.version,
    { typeName: gqltype.name, id: ownValue(record, '_id') ?? ownValue(record, 'id') ?? id });
  return record.version;
};

const readProtectedRecord = async (Model, gqltype, id, session) => {
  const record = await adapter.getById(Model, id, session, { plain: true, lock: true });
  if (record) normalizeProtectedVersion(record, gqltype, id);
  return record;
};

// Whether a stale or exhausted version that the pre-read found is reported at once, before the
// record's validators, hooks and action run (decision 9): to every caller of a type without a
// get_by_id scope, and to a caller who can read the record through that scope. The record is read as
// a by-ID read does, in the operation's session and by its stored key, not the client's spelling of
// the ID. A scope function that throws counts as hiding the record; errors of the gates and of
// adapter.find propagate.
const reportEarlyConflict = async (type, record, context, session) => {
  if (!getScope(type.gqltype, 'get_by_id')) return true;
  const key = String(record._id ?? record.id);
  const args = { id: { operator: 'EQ', value: key } };
  try {
    return await findVisibleById(type, args, session, context, key) !== null;
  } catch (error) {
    if (failedByIdScopes.has(args)) return false;
    throw error;
  }
};

// Outcome 3 of the pre-read: the stored version is not the expected one, or an update or a state
// action (`advances`) would take it past MAX_RECORD_VERSION; a delete does not advance it. When the
// conflict is not reported early, the operation continues exactly as with a matching version, and the
// conditional write reports it.
const assertRecordVersion = async (gqltype, id, record, expectedVersion, advances, context, session) => {
  let error = null;
  if (record.version !== expectedVersion) error = versionConflictError(gqltype.name, id);
  else if (advances && expectedVersion === MAX_RECORD_VERSION) error = versionExhaustedError(gqltype.name, id);
  if (error && await reportEarlyConflict(typesDict.types[gqltype.name], record, context, session)) throw error;
};

// The record is read for the onDelete hook; adapter.delete casts the ID, deletes and returns the
// record itself. Without a hook, the read is skipped when it is inert. A nested delete passes the
// child it has already read as `current`, and a protected delete its pre-read record, null when it is
// missing, with `precondition`: the type and the version the record must still have. The adapter then
// deletes it only at that version, and a record it deleted at another one, which an adapter wrapper
// that drops the options would delete, fails with DATABASE_ERROR and rolls back with the transaction.
const onDelete = async (Model, controller, id, session, context, current, precondition = null) => {
  const hasHook = !!(controller && controller.onDelete);
  let currentObject = current;
  if (currentObject === undefined && (hasHook || !readByIdIsInert(Model))) {
    currentObject = await adapter.getById(Model, id, session, { plain: true });
  }

  if (hasHook) {
    await controller.onDelete(currentObject, session, context);
  }

  if (!precondition) return adapter.delete(Model, id, session);
  const { gqltype, expectedVersion } = precondition;
  const deleted = await adapter.delete(Model, id, session, { expectedVersion });
  if (deleted && readStoredVersion(deleted.version, { typeName: gqltype.name, id }) !== expectedVersion) {
    throw unexpectedDeleteError(gqltype.name, id);
  }
  return deleted;
};

const getEmbeddedFieldNames = (gqltype) => {
  const cached = typesDict.types[gqltype.name];
  if (cached && cached.embeddedFieldNames) return cached.embeddedFieldNames;
  const names = [];
  for (const [fieldName, fieldEntry] of Object.entries(gqltype.getFields())) {
    if (fieldEntry.extensions?.relation?.embedded) names.push(fieldName);
  }
  if (cached) cached.embeddedFieldNames = names;
  return names;
};

// Update inputs relax embedded NonNull members, so check the embedded values an update writes
// against the embedded output type. Omitted lists are written as [], as on create. With `patch`,
// only nested embedded values supplied by that patch are checked; stored nested values it keeps
// are not. `id` and readOnly members are not accepted by generated inputs and remain the
// application's responsibility.
const completeEmbeddedValue = (fieldName, fieldEntry, value, patch = null) => {
  const listShape = getListShape(fieldEntry.type);
  const embeddedType = listShape ? listShape.itemType : unwrapNonNull(fieldEntry.type);
  let items = [value];
  if (listShape) items = Array.isArray(value) ? value : [];
  for (const item of items) {
    if (item === null || item === undefined) {
      if (listShape && listShape.itemNonNull) {
        throw new SimfinityError(`Required value ${fieldName}[] is missing`, 'REQUIRED_VALUE', 400);
      }
      continue;
    }
    for (const [memberName, member] of Object.entries(embeddedType.getFields())) {
      const relation = member.extensions?.relation;
      const memberList = getListShape(member.type);
      if ((relation && !relation.embedded && memberList) || isVirtualField(member)) continue;
      const storageName = getFieldStorageName(memberName, member);
      if (ownValue(item, storageName) === undefined && memberList) item[storageName] = [];
      if (memberName === 'id' || member.extensions?.readOnly) continue;
      const memberValue = ownValue(item, storageName);
      if (memberValue === null || memberValue === undefined) {
        if (member.type instanceof GraphQLNonNull) {
          throw new SimfinityError(`Required value ${memberName} is missing`, 'REQUIRED_VALUE', 400);
        }
      } else if (relation && relation.embedded && (!patch || Object.hasOwn(patch, storageName))) {
        completeEmbeddedValue(memberName, member, memberValue);
      }
    }
  }
};

// An explicit null for a nullable member of a singular embedded patch clears that member, as a
// top-level null clears a field. Lists become empty lists; other members, including nested embedded
// objects and references (under their storage name), are stored as null rather than removed, since
// a removed nested object is materialized again from its list defaults. A null for a non-null member
// keeps the stored value, also as at the top level. Nested objects in the patch replace the stored
// ones wholesale.
const clearNullEmbeddedMembers = (merged, fieldEntry, patch) => {
  if (!patch || typeof patch !== 'object') return;
  const members = unwrapNonNull(fieldEntry.type).getFields();
  for (const [memberName, value] of Object.entries(patch)) {
    const member = members[memberName];
    if (value !== null || !member || member.type instanceof GraphQLNonNull || isVirtualField(member)) continue;
    const relation = member.extensions?.relation;
    const listShape = getListShape(member.type);
    if (relation && !relation.embedded && listShape) continue;
    merged[getFieldStorageName(memberName, member)] = listShape ? [] : null;
  }
};

// Whether an update reads the stored embedded values of a type with embedded fields. They are used
// to merge a singular embedded object, and a non-empty embedded list is completed only for an
// existing record; empty lists and nulls use nothing. A top-level update also keeps the read before
// onUpdating, so that a malformed ID fails before the hook, and before nested collection items, so
// that the SQL adapter locks the parent row before child writes; otherwise it skips the read only
// when it is inert. A state action or a nested update has already read and checked the record
// (`recordChecked`). A protected type never reads here: its pre-read record serves the merge (#98).
const readsStoredEmbedded = (Model, controller, materializedModel, embeddedFieldNames, recordChecked) => {
  const usesStored = embeddedFieldNames.some((name) => {
    const value = ownValue(materializedModel.modelArgs, name);
    return value && (!Array.isArray(value) || value.length > 0);
  });
  if (usesStored) return true;
  if (recordChecked) return false;
  return !!(controller && controller.onUpdating)
    || Object.values(materializedModel.collectionFields).some((field) => field
      && ['added', 'updated', 'deleted'].some((key) => field[key] && hasNestedItems(field[key])))
    || !readByIdIsInert(Model);
};

// Whether an update sets the version field, at the top level or inside an operator such as $set or
// $unset. The adapter writes the version of a protected type (#98).
const setsVersion = (update) => [update, ...Object.entries(update)
  .filter(([key]) => key.startsWith('$')).map(([, value]) => value)]
  .some((target) => target !== null && typeof target === 'object' && Object.hasOwn(target, 'version'));

// The update of a protected type (#98) takes from its caller the version captured before the
// pre-read, `expectedVersion`, the immutable observed version, and the pre-read record (null when
// missing). It merges embedded values from that record and writes only at the expected version,
// which the adapter advances; onUpdating
// cannot set the version, and a result that did not advance it fails with DATABASE_ERROR.
const onUpdateSubject = async (Model, gqltype, controller, args, session, linkToParent, context,
  recordChecked = false, { expectedVersion, observedVersion, record } = {}) => {
  const versioned = isProtected(gqltype);
  const materializedModel = await materializeModel(args, gqltype, linkToParent, 'UPDATE', session);
  const objectId = args.id;
  const argTypes = gqltype.getFields();
  const embeddedFieldNames = getEmbeddedFieldNames(gqltype);

  if (embeddedFieldNames.length > 0
    && (versioned || readsStoredEmbedded(Model, controller, materializedModel, embeddedFieldNames, recordChecked))) {
    const projection = Object.fromEntries(embeddedFieldNames.map((name) => [name, 1]));
    const currentObject = versioned ? record : await adapter.getById(Model, objectId, session, {
      projection,
      plain: true,
      lock: true,
    });
    if (currentObject) {
      for (const fieldEntryName of embeddedFieldNames) {
        const oldObjectData = ownValue(currentObject, fieldEntryName);
        const newObjectData = ownValue(materializedModel.modelArgs, fieldEntryName);
        if (newObjectData) {
          if (Array.isArray(newObjectData)) {
            completeEmbeddedValue(fieldEntryName, argTypes[fieldEntryName], newObjectData);
          } else {
            materializedModel.modelArgs[fieldEntryName] = { ...oldObjectData, ...newObjectData };
            clearNullEmbeddedMembers(materializedModel.modelArgs[fieldEntryName],
              argTypes[fieldEntryName], ownValue(args, fieldEntryName));
            completeEmbeddedValue(fieldEntryName, argTypes[fieldEntryName],
              materializedModel.modelArgs[fieldEntryName], newObjectData);
          }
        }
      }
    }
  }

  for (const [fieldEntryName, fieldEntry] of Object.entries(argTypes)) {
    if (args[fieldEntryName] === null && !(fieldEntry.type instanceof GraphQLNonNull) && !isVirtualField(fieldEntry)
      && !isVersionField(fieldEntry)) {
      materializedModel.modelArgs.$unset = {
        ...materializedModel.modelArgs.$unset,
        [getFieldStorageName(fieldEntryName, fieldEntry)]: '',
      };
    }
  }

  const unset = materializedModel.modelArgs.$unset || {};
  const set = { ...materializedModel.modelArgs };
  delete set.$unset;
  const update = adapter.prepareUpdate(set, unset);

  if (controller && controller.onUpdating) {
    await controller.onUpdating(objectId, update, session, context);
    if (versioned && setsVersion(update)) throw versionManagedError(gqltype.name, 'onUpdating');
  }

  if (linkToParent) linkToParent(update);
  const result = versioned
    ? await adapter.update(Model, objectId, update, session, { expectedVersion })
    : await adapter.update(Model, objectId, update, session);
  if (!result) throw new SimfinityError(`${gqltype.name} ${objectId} is not valid`, 'NOT_VALID_ID', 404);
  // Diagnose a result that did not advance beyond the pre-read, including a dropped precondition
  // when the caller sent one revision less. This cannot prove arbitrary wrappers honored the atomic
  // condition: they must still forward it. The observation is captured before application code runs.
  if (versioned) {
    const returnedVersion = readStoredVersion(result.version, { typeName: gqltype.name, id: objectId });
    if (returnedVersion !== expectedVersion + 1
      || (observedVersion !== undefined && returnedVersion <= observedVersion)) {
      throw unadvancedVersionError(gqltype.name, objectId);
    }
  }

  if (materializedModel.collectionFields) {
    // Children link to, and are owned through, the parent's stored key, as when a new parent is
    // saved: the client may send a spelling of the ID that the adapter accepts but does not store,
    // such as an uppercase ObjectId or UUID. It is the key the generated collection field reads
    // children by (`_id`, else `id`); an adapter whose update result has neither keeps the requested ID.
    await iterateOnCollectionFields(materializedModel, gqltype, result._id ?? result.id ?? objectId, session, context);
  }

  if (controller && controller.onUpdated) {
    await controller.onUpdated(result, session, context);
  }

  return result;
};

// A protected type's version is captured before the action can change `args`, and checked on the
// plain pre-read record before the from-state check, which reads `state` from that record (#98).
const onStateChanged = async (Model, gqltype, controller, args, session, actionField, context) => {
  const versioned = isProtected(gqltype);
  const expectedVersion = versioned ? assertVersionInput(args.version) : undefined;
  const storedModel = versioned
    ? await readProtectedRecord(Model, gqltype, args.id, session)
    : await adapter.getById(Model, args.id, session, { lock: true });
  const observedVersion = versioned ? storedModel?.version : undefined;
  if (!storedModel) {
    throw new SimfinityError(`${gqltype.name} ${args.id} is not valid`, 'NOT_VALID_ID', 404);
  }
  if (versioned) await assertRecordVersion(gqltype, args.id, storedModel, expectedVersion, true, context, session);
  if (storedModel.state === stateValue(actionField.from)) {
    if (actionField.action) {
      await actionField.action(args, session);
    }

    args.state = stateValue(actionField.to);
    let result = await onUpdateSubject(Model, gqltype, controller, args, session, null, context, true,
      versioned ? { expectedVersion, observedVersion, record: storedModel } : undefined);
    result = adapter.toObject(result);
    result.state = actionField.to.value;
    return result;
  }
  throw new SimfinityError(`Action is not allowed from state ${storedModel.state}`, 'BAD_REQUEST', 400);
};

const onSaveObject = async (Model, gqltype, controller, args, session, linkToParent, context) => {
  const materializedModel = await materializeModel(args, gqltype, linkToParent, 'CREATE', session);
  if (typesDict.types[gqltype.name].stateMachine) {
    materializedModel.modelArgs.state = stateValue(
      typesDict.types[gqltype.name].stateMachine.initialState,
    );
  }
  // A protected record starts at version 1, whatever saveObject() or middleware supplied (#98).
  const versioned = isProtected(gqltype);
  if (versioned) materializedModel.modelArgs.version = 1;

  const newObject = adapter.newRecord(Model, materializedModel.modelArgs, session);

  if (controller && controller.onSaving) {
    await controller.onSaving(newObject, args, session, context);
    if (versioned && newObject.version !== 1) throw versionManagedError(gqltype.name, 'onSaving');
  }

  if (linkToParent) linkToParent(newObject);
  let result = await adapter.saveRecord(Model, newObject, session);
  result = adapter.toObject(result);

  if (materializedModel.collectionFields) {
    await iterateOnCollectionFields(materializedModel, gqltype, newObject._id, session, context);
  }

  if (controller && controller.onSaved) {
    await controller.onSaved(result, args, session, context);
  }
  if (typesDict.types[gqltype.name].stateMachine) {
    result.state = typesDict.types[gqltype.name].stateMachine.initialState.value;
  }
  return result;
};

// saveObject() and the lifecycle helpers look up, at entry, the execution state that a transaction
// attempt (#151) attached to the session they were given. When the adapter's withTransaction hands the
// body another object than that session, the state follows the body's object for as long as the body
// runs, so every nested entry the body runs counts against the attempt's budget, whatever object the
// adapter uses. Attachments are counted (execution-state.js): an object that already carries the state,
// from an enclosing body or from a body running at the same time, keeps it until the last of them ends,
// and one that carries another state gets that state back when this body ends, as long as the bodies on
// that object end in the reverse order they started (nested, or one at a time). When bodies of different
// states interleave on one object, a body that ends releases the latest attachment of its state, which
// another body may have made, so the object can carry another state while a body of this one still runs.
// Nothing is attached without a state, nor to an object that is not one.
const runInExecutionState = (state, session, bodySession, run) => {
  if (state === undefined || bodySession === session || bodySession === null
    || (typeof bodySession !== 'object' && typeof bodySession !== 'function')) {
    return run();
  }
  attachExecutionState(bodySession, state);
  return (async () => {
    try {
      return await run();
    } finally {
      detachExecutionState(bodySession, state);
    }
  })();
};

const saveObject = async (typeName, args, session, context) => {
  const type = typesDict.types[typeName];
  assertCollectionWrites(type.gqltype, args);
  const snapshot = cloneInput(args, type.inputType);
  const state = executionStateOf(session, runtimeToken);
  return adapter.withTransaction(session, (transaction) => runInExecutionState(state, session, transaction,
    () => onSaveObject(
      type.model, type.gqltype, type.controller, cloneInput(snapshot, type.inputType), transaction, null, context,
    )), type.model);
};

// The lifecycle helpers (#151): updateObject, deleteObject and transitionObject run the lifecycle of the
// generated update, delete and state action mutations from code, through runOperation, as those roots
// do, but without the root record's global middleware and without GraphQL. They check their target, then
// validate the caller's input and take a snapshot of it before anything runs; every attempt of the
// transaction works on its own copy of that snapshot, and the caller's input is never written to.

// How a type or action name that is not a string appears in a message, which never shows a value.
const operationName = (value) => (typeof value === 'string' ? value : `(${value === null ? 'null' : typeof value})`);
const notStoredTargetError = (typeName) => new SimfinityError(
  `Type ${operationName(typeName)} is not a stored record type registered in this runtime`, 'INVALID_OPERATION_TARGET', 500,
);
const noUpdateInputError = (typeName) => new SimfinityError(
  `Type ${typeName} has no prepared update input with an id field`, 'INVALID_OPERATION_TARGET', 500,
);

// The registration a helper works on: a type registered in this runtime that stores records of its own
// and has its model. An update or a transition also needs the type's generated update input, which only
// createSchema() builds, with an `id` field, which a readOnly id or an input without fields (#161) lacks;
// it gets the update registration, which holds that input. createSchema() also decides which types store
// records, so a missing input is reported first: before createSchema(), the error names what is missing.
const resolveOperationTarget = (typeName, { update }) => {
  const registration = typeof typeName === 'string' && Object.hasOwn(typesDict.types, typeName)
    ? typesDict.types[typeName] : undefined;
  if (!registration) throw notStoredTargetError(typeName);
  const updateRegistration = typesDictForUpdate.types[typeName];
  if (update && !updateRegistration?.inputType) throw noUpdateInputError(typeName);
  if (!registration.model || registration.storedIdentity !== true) throw notStoredTargetError(typeName);
  if (update && !Object.hasOwn(updateRegistration.inputType.getFields(), 'id')) throw noUpdateInputError(typeName);
  return update ? updateRegistration : registration;
};

// The input walk (operation-input.js) knows these inputs by identity, to find the record keys inside them:
// `updated[].id` and each `deleted` item of the generated collection inputs, the id of a single reference
// and the id of a versioned nested delete.
const operationWalkOptions = { collectionInputTypes, idInputType: IdInputType, recordVersionRef: RecordVersionRef };

// The look-ahead of a transaction attempt (#151): the nested entries of `input` against what the attempt
// has left of the limit it snapshotted, without counting them. No limit, no check.
const assertRemainingNestedBudget = (gqltype, input, state) => {
  const remaining = remainingNestedBudget(state);
  if (remaining === null) return;
  const limit = state.limits.maxNestedOperations;
  assertNestedOperations(gqltype, input, limit, { count: limit - remaining });
};

// The nested budget of a helper call. Outside a transaction attempt, the preflight is the whole budget,
// with the limit configured when the helper is called. Inside one, it is the attempt's look-ahead.
// Either way it only looks ahead and counts nothing.
const assertHelperNestedBudget = (gqltype, snapshot, state) => {
  if (state !== undefined) {
    assertRemainingNestedBudget(gqltype, snapshot, state);
    return;
  }
  const limit = getMaxNestedOperations();
  if (limit !== null) assertNestedOperations(gqltype, snapshot, limit);
};

// The transaction of a helper: the adapter's own when no session is supplied, retries included; with a
// session, the adapter checks it, and the helper neither commits, retries, aborts nor cleans up.
// `attemptArgs` gives each attempt its own arguments.
const runHelperTransaction = (type, operation, attemptArgs, session, state, context, actionField = null) => adapter
  .withTransaction(session ?? null, (bodySession) => runInExecutionState(state, session, bodySession,
    () => runOperation({ Model: type.model, gqltype: type.gqltype, controller: type.controller }, operation,
      attemptArgs(), bodySession, context, actionField)), type.model);

// An update or a transition: the update input checks the whole input, whose top-level id is required and
// whose state, when a state machine manages it, only a transition changes. The nested preflight and the
// collection check run on the snapshot, before the transaction.
const runHelperUpdate = (type, operation, input, session, context, actionField = null) => {
  const state = executionStateOf(session, runtimeToken);
  const snapshot = snapshotOperationInput(input, type.inputType, {
    ...operationWalkOptions, mode: 'programmatic', path: 'input', topLevelId: true, stateManaged: !!type.stateMachine,
  });
  assertHelperNestedBudget(type.gqltype, snapshot, state);
  assertCollectionWrites(type.gqltype, snapshot);
  const attemptArgs = () => snapshotOperationInput(snapshot, type.inputType, { ...operationWalkOptions, mode: 'copy' });
  return runHelperTransaction(type, operation, attemptArgs, session, state, context, actionField);
};

const updateObject = async (typeName, input, session, context) => runHelperUpdate(
  resolveOperationTarget(typeName, { update: true }), operations.UPDATE, input, session, context,
);

const transitionObject = async (typeName, actionName, input, session, context) => {
  const type = resolveOperationTarget(typeName, { update: true });
  const actions = type.stateMachine?.actions;
  if (typeof actionName !== 'string' || !actions || !Object.hasOwn(actions, actionName)) {
    throw new SimfinityError(`Type ${typeName} has no state machine action ${operationName(actionName)}`,
      'UNKNOWN_ACTION', 500);
  }
  return runHelperUpdate(type, operations.STATE_CHANGED, input, session, context, actions[actionName]);
};

// The target is { id } or, for a protected type, { id, version }; the delete takes the bare ID or a new
// { id, version } on each attempt, as the delete root passes them. A delete has no nested entries.
const deleteObject = async (typeName, target, session, context) => {
  const type = resolveOperationTarget(typeName, { update: false });
  const versioned = isProtected(type.gqltype);
  const state = executionStateOf(session, runtimeToken);
  const { id, version } = readDeleteTarget(target, { protectedType: versioned, path: 'input' });
  const attemptArgs = versioned ? () => ({ id, version }) : () => id;
  return runHelperTransaction(type, operations.DELETE, attemptArgs, session, state, context);
};

// Counts the added, updated and deleted entries of referenced collections, at every nesting level that
// iterateOnCollectionFields executes, and stops once the configured maximum is exceeded.
const assertNestedOperations = (gqltype, input, limit, state = { count: 0 }) => {
  if (!input || typeof input !== 'object') return;
  for (const [fieldName, field] of Object.entries(gqltype.getFields())) {
    const value = input[fieldName];
    const relation = field.extensions?.relation;
    const listShape = getListShape(field.type);
    if (value == null || !relation || relation.embedded || !listShape
      || !(listShape.itemType instanceof GraphQLObjectType)) continue;
    for (const key of ['added', 'updated', 'deleted']) {
      if (!Array.isArray(value[key])) continue;
      state.count += value[key].length;
      if (state.count > limit) throw nestedOperationsExceededError(limit);
      if (key !== 'deleted') {
        for (const item of value[key]) assertNestedOperations(listShape.itemType, item, limit, state);
      }
    }
  }
};

// A referenced collection links each child to its parent through the child's connectionField.
const hasConnectionField = (relation) => typeof relation.connectionField === 'string'
  && relation.connectionField !== '';
const isUnlinkedCollection = (field) => {
  const relation = field.extensions?.relation;
  const listShape = getListShape(field.type);
  return !!relation && !relation.embedded && !!listShape
    && listShape.itemType instanceof GraphQLObjectType && !hasConnectionField(relation);
};
// Null entries are skipped by every nested operation, so a list of only nulls writes nothing.
const hasNestedItems = (items) => !Array.isArray(items) || items.some((item) => item !== null);
const unlinkedCollectionError = (gqltype, fieldName) => new SimfinityError(
  `${gqltype.name}.${fieldName} cannot store nested items because it has no connectionField`,
  'INVALID_MODEL',
  500,
);

// Rejects nested items for a collection without a connectionField, at every nesting level that
// iterateOnCollectionFields executes, before anything is written or any controller hook runs. Such a
// collection only exists with its own resolver or as readOnly; createSchema rejects the others.
const assertCollectionWrites = (gqltype, input) => {
  if (!input || typeof input !== 'object') return;
  for (const [fieldName, field] of Object.entries(gqltype.getFields())) {
    const value = input[fieldName];
    const relation = field.extensions?.relation;
    const listShape = getListShape(field.type);
    if (value == null || !relation || relation.embedded || !listShape
      || !(listShape.itemType instanceof GraphQLObjectType)) continue;
    for (const key of ['added', 'updated', 'deleted']) {
      const items = value[key];
      if (!items) continue;
      if (!hasConnectionField(relation) && hasNestedItems(items)) throw unlinkedCollectionError(gqltype, fieldName);
      if (key !== 'deleted' && Array.isArray(items)) {
        for (const item of items) assertCollectionWrites(listShape.itemType, item);
      }
    }
  }
};

// The capture and the pre-read of a protected top-level update or delete (#98): the version the
// client sent is checked before anything is read, then against the pre-read record. A missing record
// is not reported here; the update fails at its write with NOT_VALID_ID and the delete returns null,
// as for an unprotected type.
const preReadTopLevel = async (Model, gqltype, { id, version }, advances, context, session) => {
  const expectedVersion = assertVersionInput(version);
  const record = await readProtectedRecord(Model, gqltype, id, session);
  const observedVersion = record?.version;
  if (record) await assertRecordVersion(gqltype, id, record, expectedVersion, advances, context, session);
  return { expectedVersion, observedVersion, record };
};

// Runs one operation on a session that already exists: for the roots, through executeOperation, and for
// the lifecycle helpers and the generated transaction (#151). A delete takes the bare ID, or
// { id, version } for a protected type; every other operation takes its attempt's copy of the input.
// The runner captures the version precondition from those args: an update or delete through
// preReadTopLevel, a transition through onStateChanged. No caller captures it a second time.
const runOperation = async ({ Model, gqltype, controller }, operation, attemptArgs, session, context,
  actionField = null) => {
  switch (operation) {
    case operations.SAVE:
      return onSaveObject(Model, gqltype, controller, attemptArgs, session, null, context);
    case operations.UPDATE: {
      const precondition = isProtected(gqltype)
        ? await preReadTopLevel(Model, gqltype, attemptArgs, true, context, session) : undefined;
      return onUpdateSubject(Model, gqltype, controller, attemptArgs, session, null, context, false, precondition);
    }
    case operations.DELETE: {
      if (!isProtected(gqltype)) return onDelete(Model, controller, attemptArgs, session, context);
      const { expectedVersion, record } = await preReadTopLevel(Model, gqltype, attemptArgs, false, context,
        session);
      return onDelete(Model, controller, attemptArgs.id, session, context, record, { gqltype, expectedVersion });
    }
    case operations.STATE_CHANGED:
      return onStateChanged(Model, gqltype, controller,
        attemptArgs, session, actionField, context);
    default:
      return null;
  }
};

// A delete passes the ID, or { id, version } for a protected type, which each attempt copies; every
// other operation passes its input, which attemptInputs copies. Either way, a retry checks the version
// the request sent.
const executeOperation = (Model, gqltype, controller, args, operation, actionField,
  session, context, inputType) => {
  const limit = getMaxNestedOperations();
  if (limit !== null && operation !== operations.DELETE) assertNestedOperations(gqltype, args, limit);
  if (operation !== operations.DELETE) assertCollectionWrites(gqltype, args);
  const versioned = isProtected(gqltype);
  let nextInput = () => args;
  if (operation !== operations.DELETE) nextInput = attemptInputs(args, inputType);
  else if (versioned) nextInput = () => ({ ...args });
  return adapter.withTransaction(
    session,
    async (mySession) => runOperation({ Model, gqltype, controller }, operation, nextInput(), mySession, context,
      actionField),
    Model,
  );
};

// parentKey is the parent's stored key: children are linked to it, and an updated or deleted child
// must already store it in its connectionField.
const executeItemFunction = async (gqltype, collectionField, parentKey, session,
  collectionFieldsList, operationType, context) => {
  const argTypes = gqltype.getFields();
  const collectionGQLType = unwrapListAndNonNull(argTypes[collectionField].type);
  const { relation } = argTypes[collectionField].extensions;
  // Checked before the operation too; this also covers items that nested middleware added.
  if (!hasConnectionField(relation) && hasNestedItems(collectionFieldsList)) {
    throw unlinkedCollectionError(gqltype, collectionField);
  }
  const connection = normalizeConnectionField(collectionGQLType, relation.connectionField);

  const type = operationType === operations.UPDATE
    ? typesDictForUpdate.types[collectionGQLType.name] : typesDict.types[collectionGQLType.name];
  const linkToParent = (item) => {
    item[connection.storageFieldName] = parentKey;
    if (item.$unset) delete item.$unset[connection.storageFieldName];
    if (item.$set) delete item.$set[connection.storageFieldName];
  };

  // A protected child is updated or deleted at the version its entry carries (#98). A deleted entry is
  // { id, version } for item middleware; one that is not an object, such as a string ID, has no version.
  const versioned = isProtected(collectionGQLType) && operationType !== operations.SAVE;
  // On the session of a transaction attempt (#151), every entry counts against the attempt's joint
  // budget before it runs, a null one included; elsewhere nothing is counted.
  const executionState = executionStateOf(session, runtimeToken);
  for (const element of collectionFieldsList) {
    if (executionState !== undefined) countNestedEntry(executionState);
    if (element === null) continue;
    let args = { input: element };
    if (operationType === operations.DELETE) {
      args = versioned ? { id: element?.id, version: element?.version } : { id: element };
    }
    await executeMiddleware({ type, args, operation: operationType, context });

    // Captured after the item's middleware, before the child is read.
    let expectedVersion;
    if (versioned) {
      expectedVersion = assertVersionInput(operationType === operations.DELETE ? args.version : args.input.version);
    }

    // The ownership check reads the child (the SQL adapter locks its row). onDelete receives this
    // record, and an update reads the child again only to merge embedded values, unless the child is
    // protected: then this is its pre-read, whose version is checked after ownership.
    let child;
    let observedVersion;
    if (operationType === operations.UPDATE || operationType === operations.DELETE) {
      const id = operationType === operations.DELETE ? args.id : args.input.id;
      child = await adapter.getById(type.model, id, session, { plain: true, lock: true });
      if (!child) {
        throw new SimfinityError(`${collectionGQLType.name} ${id} is not valid`, 'NOT_VALID_ID', 404);
      }
      if (String(child[connection.storageFieldName]) !== String(parentKey)) {
        throw new ForbiddenError('Child does not belong to this parent');
      }
      if (versioned) {
        observedVersion = normalizeProtectedVersion(child, collectionGQLType, id);
        await assertRecordVersion(collectionGQLType, id, child, expectedVersion, operationType === operations.UPDATE,
          context, session);
      }
    }

    switch (operationType) {
      case operations.SAVE:
        await onSaveObject(type.model, collectionGQLType, type.controller,
          args.input, session, linkToParent, context);
        break;
      case operations.UPDATE:
        await onUpdateSubject(type.model, collectionGQLType, type.controller,
          args.input, session, linkToParent, context, true, versioned ? { expectedVersion, observedVersion, record: child } : undefined);
        break;
      case operations.DELETE:
        await onDelete(type.model, type.controller, args.id, session, context, child,
          versioned ? { gqltype: collectionGQLType, expectedVersion } : null);
    }
  }
};

const shouldNotBeIncludedInSchema = (includedTypes,
  type) => includedTypes && !includedTypes.includes(type);

// Runs the chain in registration order. The rest of the chain runs at most once, and is awaited
// even when a middleware calls next() without awaiting it, so its errors still cancel the operation
// and never become unhandled rejections; a middleware that fails after starting it rejects only once
// it settles. A next() called after the middleware finished does nothing, so later middleware never
// runs after the operation.
const executeMiddleware = async (context) => {
  const run = async (index) => {
    if (index >= middlewares.length) return;
    let downstream;
    let finished = false;
    const next = () => {
      if (!downstream && !finished) {
        downstream = run(index + 1);
        // Handled here because the middleware may await other work first; awaited below.
        downstream.catch(() => {});
      }
      return downstream ?? Promise.resolve();
    };
    try {
      await middlewares[index](context, next);
    } catch (error) {
      finished = true;
      if (downstream) await downstream.catch(() => {});
      throw error;
    }
    finished = true;
    if (downstream) await downstream;
  };
  await run(0);
};

const executeScope = async (params) => {
  const { type, args, operation, context } = params;
  const scopeFunction = getScope(type?.gqltype, operation);
  if (!scopeFunction) return null;
  return scopeFunction({ type, args, operation, context });
};

// The arguments of a list, aggregate or collection field call that are not filters. On aggregate
// endpoints `aggregation` is one; elsewhere a field of that name is filtered like any other.
const LIST_CONTROL_ARGS = new Set(['sort', 'pagination']);
const AGGREGATE_CONTROL_ARGS = new Set(['sort', 'pagination', 'aggregation']);
const isFilterObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
// A new object with the same prototype and own enumerable properties: graphql-js builds inline literals
// with a null prototype and variables with Object's, and childArgsKey tells them apart.
const copyFilterObject = (value) => Object.assign(Object.create(Object.getPrototypeOf(value)), value);
// A term, a group condition or a field filter: a value array becomes a new Array with the same items.
const copyFilterCondition = (condition) => {
  if (!isFilterObject(condition)) return condition;
  const copy = copyFilterObject(condition);
  if (Array.isArray(condition.value)) copy.value = [...condition.value];
  return copy;
};
const copyFilterGroup = (group) => {
  if (!isFilterObject(group)) return group;
  const copy = copyFilterObject(group);
  if (Array.isArray(group.conditions)) copy.conditions = group.conditions.map(copyFilterCondition);
  if (Array.isArray(group.AND)) copy.AND = group.AND.map(copyFilterGroup);
  if (Array.isArray(group.OR)) copy.OR = group.OR.map(copyFilterGroup);
  return copy;
};
const copyFieldFilter = (filter) => {
  const copy = copyFilterCondition(filter);
  if (isFilterObject(filter) && Array.isArray(filter.terms)) copy.terms = filter.terms.map(copyFilterCondition);
  return copy;
};

// A tree copy of the query-language structure of one call's filter arguments, onto that call's args:
// field filters and their terms, AND/OR groups and their conditions. Every place gets its own object,
// also where graphql-js hands one variable object to several arguments or list items, so that a
// middleware edit or a client scope marker stays within the call. Value arrays are copied shallowly,
// and every other value, sort, pagination and aggregation included, is kept as it is. GraphQL input
// has no cycles, so nothing is memoized.
const copyClientFilters = (args, operation) => {
  const controls = operation === 'aggregate' ? AGGREGATE_CONTROL_ARGS : LIST_CONTROL_ARGS;
  for (const [name, value] of Object.entries(args)) {
    if (name === 'AND' || name === 'OR') {
      if (Array.isArray(value)) args[name] = value.map(copyFilterGroup);
    } else if (!controls.has(name)) args[name] = copyFieldFilter(value);
  }
};

// Checks the filter, sort and aggregation paths a client supplied, before middleware and scopes
// add trusted paths. Returns the scoped relations those paths enter, keyed by path, with the
// client AND/OR groups whose conditions use each path, or `topLevel` for every other form.
// graphql-js passes the same variable values to every resolver call of a request, so the client's
// filters are first copied onto this call's args (copyClientFilters), and joined scopes are only
// placed in those copies.
// An emptiness condition on an embedded object reads its stored members, so their paths are checked
// as client paths too (#108 part 2a); a member path only gets the 403 checks, and enters no joined
// scope. When the adapter compiles reference emptiness (#108 part 2b), a client's emptiness term or
// condition reads its references and collections through scoped joins and frames instead, so it
// enters no joined scope either; every other entry, beside it or on the same path, records its own.
// Without `checkQueryable`, for a view's `where`, whose paths are the author's as a scope's are, a
// non-queryable field is not rejected; a virtual one still is.
const inspectClientPaths = (gqltype, args, operation, { checkQueryable = true } = {}) => {
  copyClientFilters(args, operation);
  const joinedScopes = new Map();
  const entries = collectQueryPathEntries(args, operation, { gqltype, expandMembers: true });
  for (const {
    segments, group, member, operator,
  } of entries) {
    const joins = !member && !(supportsReferenceEmptiness && isEmptinessOperator(operator));
    walkQueryPath(gqltype, segments, ({ type, fieldName, field, index }) => {
      const path = segments.slice(0, index + 1).join('.');
      if (isVirtualField(field)) {
        throw forbiddenPath(`Query path ${path} uses the virtual field ${type.name}.${fieldName}, which is not stored`);
      }
      const queryable = field.extensions?.queryable;
      if (checkQueryable && (queryable === false || (queryable !== true && hasApplicationResolver(type, fieldName)))) {
        throw forbiddenPath(`Query path ${path} uses the non-queryable field ${type.name}.${fieldName}`);
      }
      if (!joins) return;
      const relation = field.extensions?.relation;
      if (!relation || relation.embedded) return;
      const target = typesDict.types[unwrapListAndNonNull(field.type).name];
      if (!getScope(target?.gqltype, 'find')) return;
      if (!joinedScopes.has(path)) {
        joinedScopes.set(path, {
          target,
          collection: getListShape(field.type) ? `${type.name}.${fieldName}` : null,
          topLevel: false,
          groups: new Set(),
        });
      }
      const joined = joinedScopes.get(path);
      if (group) joined.groups.add(group);
      else joined.topLevel = true;
    });
  }
  return joinedScopes;
};

// Whether a schema of this runtime declared a virtual field, so that query paths may name one.
let virtualFieldsDeclared = false;

// Client paths through a virtual field were rejected before middleware and scopes ran
// (inspectClientPaths), so a path through one now is a trusted path that middleware or a scope added.
// It would compile against storage that does not exist, so the operation fails with INVALID_MODEL
// (500), the code of model declarations that cannot be honored at request time.
const assertStoredQueryPaths = (gqltype, args, operation) => {
  if (!virtualFieldsDeclared) return;
  for (const { segments } of collectQueryPathEntries(args, operation)) {
    walkQueryPath(gqltype, segments, ({ type, fieldName, field, index }) => {
      if (!isVirtualField(field)) return;
      throw new SimfinityError(`Query path ${segments.slice(0, index + 1).join('.')}, added by middleware or a `
        + `scope, uses the virtual field ${type.name}.${fieldName}, which is not stored`, 'INVALID_MODEL', 500);
    });
  }
};

const assertDeclaredOperator = (gqltype, operator, path) => {
  if (!supportedOperators.has(operator)) {
    throw new SimfinityError(`The database adapter does not support the ${operator} filter operator, used on `
      + `${gqltype.name}.${path}`, 'UNSUPPORTED_QUERY', 400);
  }
};

// The checks of an emptiness condition (#108 part 2a) that come before rules 3 to 6 of
// describeEmptiness, with the codes and messages of createQueryPlan: the group depth, a dotted field
// next to a path, an emptiness operator on an object filter without terms or beside terms, the
// fields of the path (rule 1), then the adapter's operators (rule 2). Returns false when the backends
// never read the condition as one, so that rules 3 to 6 do not apply: a term of a field that is not
// an object (they read that filter's own operator) and a condition without a string field (they
// reject it their own way; when the adapter does not declare the operator, no compiler sees it, so
// the gate gives createQueryPlan's rule-1 code).
const assertEmptinessForm = (gqltype, {
  operator, path, segments, form, field, depth, ambiguous,
}) => {
  if (form === 'condition') {
    if (depth > MAX_FILTER_GROUP_DEPTH) throw new SimfinityError('Filter nesting too deep', 'FILTER_DEPTH_EXCEEDED', 400);
    if (typeof field !== 'string') {
      if (!supportedOperators.has(operator)) throw new SimfinityError('Invalid filter path', 'INVALID_FILTER_PATH', 400);
      return false;
    }
    if (ambiguous) {
      throw new SimfinityError('Filter condition cannot use both dotted field syntax and a separate path', 'AMBIGUOUS_FILTER_FIELD', 400);
    }
  } else {
    assertEmptinessPath(gqltype, [field]);
    const type = getNamedType(gqltype.getFields()[field].type);
    if (isObjectType(type) && form !== 'term') {
      throw new SimfinityError(`Filter on ${field} takes ${operator} only in a term; to test the field itself, use a term `
        + `without a path: ${field}: { terms: [{ operator: ${operator} }] }`, 'MISSING_FILTER_PATH', 400);
    }
    if (form === 'term' && !isObjectType(type) && !(type instanceof GraphQLInterfaceType) && !(type instanceof GraphQLUnionType)) {
      assertDeclaredOperator(gqltype, operator, path);
      return false;
    }
  }
  assertEmptinessPath(gqltype, segments, { path });
  assertDeclaredOperator(gqltype, operator, path);
  return true;
};

// Rejects a QLOperator value that the adapter does not declare in queryFeatures, with
// UNSUPPORTED_QUERY (400), so an adapter never drops or misreads a condition it does not compile,
// and applies to every IS_EMPTY or IS_NOT_EMPTY condition the order of checks of #108 part 2a,
// whatever the adapter declares, rule 6 only when it does not declare reference emptiness. Runs on
// the client's arguments before middleware and on the final arguments before the adapter call,
// which covers what middleware, scopes and joined scopes added, so that an emptiness condition gets
// the code that a direct createQueryPlan call gives, whoever wrote it and whatever the caller may
// read. Operators that QLOperator does not list are left to the adapter, which reports them as before.
// Returns every condition as `{ entry, shape }`: its collectQueryOperators entry, and the shape of an
// emptiness condition that the backends read as one, or null.
const assertQueryConditions = (gqltype, args, operation) => {
  const checked = [];
  for (const entry of collectQueryOperators(args, operation)) {
    const { operator, path } = entry;
    let shape = null;
    if (isEmptinessOperator(operator)) {
      if (assertEmptinessForm(gqltype, entry)) {
        shape = describeEmptiness(gqltype, entry.segments, {
          operator, value: entry.value, path, referenceEmptiness: supportsReferenceEmptiness,
        });
      }
    } else if (!supportsEveryOperator && isQueryOperator(operator)) assertDeclaredOperator(gqltype, operator, path);
    checked.push({ entry, shape });
  }
  return checked;
};

// Decision 3 of #108 part 2a: a target find scope with an emptiness condition is not applied below a
// client's relation path, because the prefix makes the condition cross a reference, which 2a
// rejects. Runs after the scoped-collection and assertJoinedScopePaths 403s. The raw scope arguments,
// operators beside terms included, first get the checks they get on the target's own endpoint (the
// stored paths, then each emptiness condition's), so that a rejection the scope has there keeps its
// code; otherwise the request fails with UNSUPPORTED_QUERY naming the scope and the prefixed condition.
// A prefix that continues inside an embedded list or a collection (`olines.shop`, `reviews.item`)
// adds more than a reference crossing. After its form and operator, each prefixed condition is checked
// on `rootType`, the queried type, where rule 3, which comes before rules 4 to 6, rejects it with the
// permanent INVALID_FILTER_PATH that the final gate and createQueryPlan give it wherever it is written.
// An adapter that compiles reference emptiness lifts decision 3 (#108 part 2b): after the same checks,
// the prefixed conditions are applied as trusted ones, which read stored data.
const assertJoinedScopeConditions = (rootType, scopeArgs, groups, prefix, target) => {
  const { gqltype } = target;
  const entries = collectQueryOperators(scopeArgs, 'find').filter(({ operator }) => isEmptinessOperator(operator));
  if (!entries.length) return;
  assertStoredQueryPaths(gqltype, scopeArgs, 'find');
  let throughList = false;
  walkQueryPath(rootType, prefix.split('.'), ({ field }) => { throughList ||= !!getListShape(field.type); });
  // Rule 6, here or on the target's own endpoint, is the rejection thrown below.
  const exceptRule6 = (check) => {
    try {
      check();
    } catch (error) {
      if (!(error instanceof SimfinityError) || error.getCode() !== 'UNSUPPORTED_QUERY') throw error;
    }
  };
  const referenceEmptiness = supportsReferenceEmptiness;
  for (const entry of entries) {
    if (!assertEmptinessForm(gqltype, entry)) continue;
    const { operator, value } = entry;
    if (throughList) exceptRule6(() => describeEmptiness(rootType, `${prefix}.${entry.path}`, { operator, value, referenceEmptiness }));
    exceptRule6(() => describeEmptiness(gqltype, entry.segments, {
      operator, value, path: entry.path, referenceEmptiness,
    }));
  }
  if (referenceEmptiness) return;
  const prefixed = collectQueryOperators({ AND: groups }).find(({ operator }) => isEmptinessOperator(operator))
    ?? { operator: entries[0].operator, path: `${prefix}.${entries[0].path}` };
  throw new SimfinityError(`Query path ${prefix} enters ${gqltype.name}, whose find scope tests ${prefixed.path} with `
    + `${prefixed.operator}: the database adapter does not support emptiness through references and collections; `
    + `use EQ null in the ${gqltype.name} find scope`, 'UNSUPPORTED_QUERY', 400);
};

// A joined scope must not repeat the rows it restricts: its paths may not cross a collection, nor
// reach a non-embedded relation inside an embedded list, which is joined once per list item.
const assertJoinedScopePaths = (groups, prefix, target) => {
  const depth = prefix.split('.').length;
  for (const segments of collectQueryPaths({ AND: groups })) {
    let inList = false;
    walkQueryPath(target.gqltype, segments.slice(depth), ({ type, fieldName, field }) => {
      const relation = field.extensions?.relation;
      const list = !!getListShape(field.type);
      if (relation && !relation.embedded && (list || inList)) {
        throw forbiddenPath(`Query path ${prefix} enters ${target.gqltype.name}, whose find scope filters through `
          + `${list ? 'the collection' : 'the relation'} ${type.name}.${fieldName}${list ? '' : ' inside a list'}`);
      }
      inList ||= list;
    });
  }
};

const appendAndGroups = (owner, groups) => {
  if (owner.AND != null && !Array.isArray(owner.AND)) {
    throw new SimfinityError('AND requires an array', 'INVALID_FILTER_VALUE', 400);
  }
  owner.AND = [...(owner.AND || []), ...groups];
};

// The deepest AND/OR group nesting the backends accept; groups listed in args.AND/OR are at depth 0.
const MAX_FILTER_GROUP_DEPTH = 5;
const nestedGroups = (group) => [...[].concat(group.AND ?? []), ...[].concat(group.OR ?? [])];
const groupDepth = (group) => Math.max(0, ...nestedGroups(group)
  .filter((item) => item && typeof item === 'object').map((item) => groupDepth(item) + 1));

// Maps each AND/OR group of the query to the deepest level it appears at.
const collectFilterGroups = (args) => {
  const found = new Map();
  const visit = (group, depth) => {
    if (!group || typeof group !== 'object' || found.get(group) >= depth) return;
    found.set(group, depth);
    if (depth <= MAX_FILTER_GROUP_DEPTH) for (const item of nestedGroups(group)) visit(item, depth + 1);
  };
  for (const item of nestedGroups(args)) visit(item, 0);
  return found;
};

// Restricts referenced records reached by client paths with each target type's find scope. A path
// used only in AND/OR group conditions restricts just those groups, so an OR alternative that does
// not use it keeps its matches; any other use, a group that middleware or a scope detached, or a
// group too deep to hold the scope groups within the backends' depth limit, restricts the whole query.
const applyJoinedScopes = async (joinedScopes, params) => {
  let queryGroups;
  for (const [prefix, {
    target, collection, topLevel, groups: owners,
  }] of joinedScopes) {
    const scopeArgs = {};
    await executeScope({ type: target, args: scopeArgs, operation: 'find', context: params.context });
    const groups = prefixScopeArgs(scopeArgs, prefix, target.gqltype.name);
    if (!groups.length) continue;
    if (collection) throw forbiddenPath(`Query path ${prefix} enters the scoped collection ${collection}`);
    assertJoinedScopePaths(groups, prefix, target);
    assertJoinedScopeConditions(params.type.gqltype, scopeArgs, groups, prefix, target);
    queryGroups ??= collectFilterGroups(params.args);
    const addedDepth = 1 + Math.max(...groups.map(groupDepth));
    if (topLevel || [...owners].some((owner) => !queryGroups.has(owner)
      || queryGroups.get(owner) + addedDepth > MAX_FILTER_GROUP_DEPTH)) appendAndGroups(params.args, groups);
    else for (const owner of owners) appendAndGroups(owner, groups);
  }
};

// Client scope markers (#108 part 2b). When the adapter compiles reference emptiness, each IS_EMPTY or
// IS_NOT_EMPTY term or group condition that a client sends and that crosses or ends at a reference or a
// collection, or reads one as a member, gets `__scope: { id }` on this call's copy, before middleware.
// After middleware, the query's own scope and joined scopes, the runtime checks that every marker it
// issued is still there and that no other one is, gates the final arguments, then fills each marker
// with the raw find scope arguments of every type the construct reads through, `__scope: { id, scopes:
// { [path]: args | null } }`, which the compilers apply as scoped joins and frames, so that a record
// those scopes hide reads as missing. Constructs without a marker are trusted and read stored data.
// Markers live only on the terms and group conditions collectQueryOperators returns; a `__scope`
// anywhere else, inside a value for one, is never read.
const SCOPE_MARKER = '__scope';
const DETACHED_ADVICE = 'middleware and scopes must keep the client\'s filter objects: copy them instead of rebuilding '
  + 'them, and append restrictions instead of assigning over them (docs/guide/middleware.md)';
const detachedClientFilter = (message) => new SimfinityError(`${message}; ${DETACHED_ADVICE}`, 'DETACHED_CLIENT_FILTER', 500);
const hasScopeMarker = (construct) => construct != null && Object.hasOwn(construct, SCOPE_MARKER);

// Marks the client's constructs that read references or collections, from the gate's conditions on the
// client's arguments, then applies maxReferenceFrames to the distinct (kind, path) pairs of their
// scoped joins and frames in these conditions, so every 2a code comes first. Returns the issued
// markers, as id -> the client's operator and path, or null when the adapter does not compile
// reference emptiness. Ids are ordinals in the order of the conditions, so identical arguments get
// identical markers and sibling collection reads keep one batch key. With `issued`, the markers of
// the call so far, the ids continue on that map, so that a view's `where`, marked after the client's
// arguments, shares them; the limit still applies to each set of conditions on its own.
const markClientConstructs = (checked, issued) => {
  if (!supportsReferenceEmptiness) return null;
  const markers = issued ?? new Map();
  const pairs = new Set();
  for (const { entry, shape } of checked) {
    const { construct } = entry;
    if (!shape || !construct || hasScopeMarker(construct)) continue;
    const { joins, frames } = emptinessScopePaths(shape, entry.segments);
    if (!joins.length && !frames.length) continue;
    const id = markers.size;
    construct[SCOPE_MARKER] = { id };
    markers.set(id, { operator: entry.operator, path: entry.path });
    for (const path of joins) pairs.add(`join ${path}`);
    for (const path of frames) pairs.add(`frame ${path}`);
  }
  const limit = getQueryMaxReferenceFrames();
  if (pairs.size > limit) {
    throw new SimfinityError(`Emptiness conditions through references and collections need ${pairs.size} scoped joins and `
      + 'frames in one set of conditions (the client\'s arguments of a query field, or a view\'s where), more than the limit '
      + `of ${limit} (maxReferenceFrames)`, 'FILTER_DEPTH_EXCEEDED', 400);
  }
  return markers;
};

// The detach check: every marker issued in this call sits, well formed (an object whose only own key
// is its id), on a term or group condition of the final arguments, possibly on several when middleware
// copied or duplicated the construct; no other marker sits on one.
const assertClientMarkers = (args, operation, issued) => {
  const found = new Set();
  for (const { construct, operator, path } of collectQueryOperators(args, operation)) {
    if (!hasScopeMarker(construct)) continue;
    const marker = construct[SCOPE_MARKER];
    const origin = isFilterObject(marker) ? issued.get(marker.id) : undefined;
    if (!isFilterObject(marker) || Reflect.ownKeys(marker).length !== 1 || !Object.hasOwn(marker, 'id')) {
      const named = origin ? `, the client's ${origin.operator} condition on ${origin.path},` : '';
      throw detachedClientFilter(`The ${operator} condition on ${path}${named} carries a malformed client scope marker`);
    }
    if (!origin) {
      throw detachedClientFilter(`The ${operator} condition on ${path} carries a client scope marker that this query field did not issue`);
    }
    found.add(marker.id);
  }
  for (const [id, origin] of issued) {
    if (!found.has(id)) {
      throw detachedClientFilter(`The client's ${origin.operator} condition on ${origin.path} is no longer in the arguments `
        + 'after middleware and scopes');
    }
  }
};

// The first reference or collection a path crosses or ends at, as its dotted path, or null.
const relationOnPath = (gqltype, segments) => {
  let found = null;
  walkQueryPath(gqltype, segments, ({ field, index }) => {
    const relation = field.extensions?.relation;
    if (!found && relation && !relation.embedded) found = segments.slice(0, index + 1).join('.');
  });
  return found;
};

// The find scope arguments of a type that a client's constructs read through, once per call and type
// (`cache`): its find scope runs with empty arguments, operation 'find' and the request context, as
// joined scopes do; its sort and pagination are checked for shape and dropped; the rest gets the final
// gate on the type, where everything is trusted. Null when the type has no find scope or the scope
// added nothing.
const clientScopeArgs = async (typeName, context, cache) => {
  if (cache.has(typeName)) return cache.get(typeName);
  const target = typesDict.types[typeName];
  let result = null;
  if (getScope(target?.gqltype, 'find')) {
    const scopeArgs = {};
    await executeScope({ type: target, args: scopeArgs, operation: 'find', context });
    const kept = {};
    for (const [name, value] of Object.entries(scopeArgs)) {
      if (!SCOPE_IGNORED_ARGS.has(name)) kept[name] = value;
      else if (value != null) assertScopeControlArg(name, value);
    }
    assertStoredQueryPaths(target.gqltype, kept, 'find');
    assertQueryConditions(target.gqltype, kept, 'find');
    if (Object.values(kept).some((value) => value != null && !(Array.isArray(value) && !value.length))) result = kept;
  }
  cache.set(typeName, result);
  return result;
};

// The fill, on the final arguments the gate passed (`checked`). Each marked object is read at each of
// its final positions, with its final operator and path:
// - an emptiness condition that crosses, ends at or has as members references or collections gets a
//   fresh `__scope: { id, scopes }`, one key per scoped join and frame path, with the union of the
//   keys of every position when middleware placed the object at several;
// - an emptiness condition narrowed to the record's own fields loses its marker, and is trusted;
// - another operator loses it too, unless its path still crosses or ends at a reference or a
//   collection: no joined scope was recorded for it, so it fails with DETACHED_CLIENT_FILTER.
// An object that reads references at one position and none at another fails the same way, since one
// marker cannot serve both. Every check comes before any target scope runs.
const fillClientScopes = async (gqltype, checked, context, issued) => {
  const marked = new Map();
  for (const item of checked) {
    const { construct } = item.entry;
    if (!hasScopeMarker(construct)) continue;
    if (!marked.has(construct)) marked.set(construct, []);
    marked.get(construct).push(item);
  }
  const fills = [];
  for (const [construct, positions] of marked) {
    const { id } = construct[SCOPE_MARKER];
    const origin = issued.get(id);
    const targets = {};
    const unread = [];
    for (const { entry, shape } of positions) {
      if (!entry.emptiness) {
        const relation = relationOnPath(gqltype, entry.segments);
        if (relation) {
          throw detachedClientFilter(`The client's ${origin.operator} condition on ${origin.path} now uses ${entry.operator} on `
            + `${entry.path}, which reads through ${relation} without its scope`);
        }
        unread.push(entry.path);
      } else {
        const keys = shape ? emptinessScopeTargets(shape, entry.segments) : {};
        if (Object.keys(keys).length) Object.assign(targets, keys);
        else unread.push(entry.path);
      }
    }
    const paths = Object.keys(targets);
    if (paths.length && unread.length) {
      throw detachedClientFilter(`The client's ${origin.operator} condition on ${origin.path} is used where it reads `
        + `references or collections and where it reads none (${unread.join(', ')})`);
    }
    fills.push({ construct, id, targets: paths.length ? targets : null });
  }
  const cache = new Map();
  for (const { construct, id, targets } of fills) {
    if (!targets) {
      delete construct[SCOPE_MARKER];
      continue;
    }
    const scopes = {};
    for (const [path, typeName] of Object.entries(targets)) scopes[path] = await clientScopeArgs(typeName, context, cache);
    construct[SCOPE_MARKER] = { id, scopes };
  }
};

// After middleware, the query's own scope and joined scopes, and before the adapter call: the detach
// check, the final gate (stored paths, then every condition), then the fill. Markers exist only when
// the adapter compiles reference emptiness. get_by_id builds its own arguments and never runs it.
// Returns the fill's promise, or null when no marker was issued, so that a call without one reaches
// the adapter after as many promise jobs as before.
const settleClientArgs = (gqltype, params, operation, issued) => {
  if (issued) assertClientMarkers(params.args, operation, issued);
  assertStoredQueryPaths(gqltype, params.args, operation);
  const checked = assertQueryConditions(gqltype, params.args, operation);
  return issued?.size ? fillClientScopes(gqltype, checked, params.context, issued) : null;
};

// Unscoped relation reads of one request, grouped by related type until the promise jobs queued so
// far have run, and keyed by cast ID. Nothing is cached: each batch is read once and dropped.
const referenceBatches = new WeakMap();

const readReferences = async (type, keys, batch, context) => {
  let found = new Map();
  try {
    const records = await adapter.getByIds(type.model, keys.map((key) => batch.get(key)[0].id), { context });
    for (const record of records) {
      if (record != null) found.set(String(adapter.castId(record._id ?? record.id)), record);
    }
  } catch {
    found = null;
  }
  // After a failed batch, each ID is read alone, so an error fails only the fields that use it.
  const reads = new Map();
  for (const key of keys) {
    for (const { id, requiredId, resolve, reject } of batch.get(key)) {
      if (found) {
        resolve(found.get(key) ?? null);
        continue;
      }
      if (!reads.has(id)) {
        reads.set(id, Promise.resolve().then(() => adapter.getById(type.model, id, null, { requiredId, context })));
      }
      reads.get(id).then(resolve, reject);
    }
  }
};

const flushReferences = (type, batch, context) => {
  const keys = [...batch.keys()];
  const size = getQueryMaxPageSize();
  for (let start = 0; start < keys.length; start += size) {
    readReferences(type, keys.slice(start, start + size), batch, context);
  }
};

const loadReference = (type, id, requiredId, context) => {
  let key;
  try {
    key = String(adapter.castId(id));
  } catch {
    // An ID the adapter cannot cast is read alone, so only its field reports the error.
    return adapter.getById(type.model, id, null, { requiredId, context });
  }
  // Casting may normalize (e.g. ObjectId hex case), so non-canonical IDs are read alone too.
  if (key !== String(id)) return adapter.getById(type.model, id, null, { requiredId, context });
  return new Promise((resolve, reject) => {
    let batches = referenceBatches.get(context);
    if (!batches) {
      batches = new Map();
      referenceBatches.set(context, batches);
    }
    let batch = batches.get(type);
    if (!batch) {
      batch = new Map();
      batches.set(type, batch);
      // As DataLoader does, flush once the promise jobs queued so far have run, so sibling calls
      // that awaited middleware without I/O join the same batch.
      Promise.resolve().then(() => process.nextTick(() => {
        batches.delete(type);
        flushReferences(type, batch, context);
      }));
    }
    if (!batch.has(key)) batch.set(key, []);
    batch.get(key).push({
      id, requiredId, resolve, reject,
    });
  });
};

// The query arguments whose get_by_id scope function threw in findVisibleById. The error propagates
// as it was thrown; the conflict path (reportEarlyConflict) tells it from errors of the gates and of
// adapter.find this way. Each caller (resolveById and reportEarlyConflict) allocates fresh args
// and calls findVisibleById exactly once with that object; never reuse marked args for another read.
const failedByIdScopes = new WeakSet();

// The record that the type's get_by_id scope shows the caller, or null. `args` holds an `id` EQ
// condition, to which the scope adds its own; the gates check them as for every read, and adapter.find
// reads in `session`, pinned to `requiredId`. get_by_id middleware is not run here; resolveById runs it
// first.
const findVisibleById = async (type, args, session, context, requiredId) => {
  try {
    await executeScope({ type, args, operation: 'get_by_id', context });
  } catch (error) {
    failedByIdScopes.add(args);
    throw error;
  }
  assertStoredQueryPaths(type.gqltype, args, 'find');
  assertQueryConditions(type.gqltype, args, 'find');
  const results = await adapter.find(type.model, type.gqltype, args, session, { requiredId, context });
  return results[0] || null;
};

// `requiredId` marks a generated single-reference read. Middleware still runs per call; then, when the
// adapter reads by ID in batches, and unless the type has a get_by_id scope or middleware changed the
// ID, the read joins the request's batch.
const resolveById = async (type, args, context, requiredId) => {
  const requestedId = args.id;
  await executeMiddleware({ type, args, operation: 'get_by_id', context });
  if (!getScope(type.gqltype, 'get_by_id')) {
    if (requiredId != null && args.id === requestedId && typeof context === 'object' && context !== null
      && typeof adapter.getByIds === 'function' && type.gqltype.getFields().id) {
      return loadReference(type, args.id, requiredId, context);
    }
    return adapter.getById(type.model, args.id, null, { requiredId, context });
  }
  return findVisibleById(type, { id: { operator: 'EQ', value: args.id } }, null, context, requiredId);
};

// Batched collection reads. A generated collection field reads its children with one
// adapter.findChildren call per parent unless the adapter defines findChildrenBatch and its
// batchesChildren predicate does not return false. Then, within one request (a context object), the
// reads of one related type and connection storage field whose effective arguments (after
// middleware, the scope and joined scopes) hold the same plain data wait until the promise jobs
// queued so far have run, as references do, and are read together, at most CHILD_BATCH_SIZE
// distinct parents per call.
const CHILD_BATCH_SIZE = 100;
// Arguments whose canonical key would exceed this many characters, such as a long IN list, read
// alone, so a field never spends more than this on canonicalization.
const CHILD_ARGS_KEY_BUDGET = 64 * 1024;
const NOT_PLAIN = Symbol('not plain data');

// The canonical key of a collection read's effective arguments: two reads share it only when their
// arguments hold the same data. Only plain data qualifies: strings, numbers (-0, NaN and Infinity
// kept distinct), booleans, undefined, null, bigints, dates (by time, with no own properties), dense
// arrays, and objects with the Object or a null prototype whose own string-keyed properties are
// enumerable data properties, all writable and configurable, or all fixed by freezing. The key keeps
// property order, null prototypes, frozen objects and shared references. Anything else, such as a
// function, a symbol, a class instance (an ObjectId included), an accessor, a non-enumerable,
// sealed or non-extensible member, a sparse or decorated array, a cycle, an exotic object that fails
// while it is read, or a key over the budget, returns null, and the read runs alone.
const childArgsKey = (args) => {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return null;
  const parts = [];
  let size = 0;
  const push = (part) => {
    size += part.length;
    if (size > CHILD_ARGS_KEY_BUDGET) throw NOT_PLAIN;
    parts.push(part);
  };
  const seen = new Map();
  const visit = (value) => {
    switch (typeof value) {
      case 'string':
        if (value.length > CHILD_ARGS_KEY_BUDGET) throw NOT_PLAIN;
        push(JSON.stringify(value));
        return;
      case 'number': push(Object.is(value, -0) ? '-0' : String(value)); return;
      case 'boolean':
      case 'undefined': push(String(value)); return;
      case 'bigint': push(`${value}n`); return;
      case 'object': if (value !== null) break; push('null'); return;
      default: throw NOT_PLAIN;
    }
    const known = seen.get(value);
    if (known) {
      // A shared reference repeats the index of its first visit; a cycle is not plain data.
      if (!known.done) throw NOT_PLAIN;
      push(`@${known.index}`);
      return;
    }
    const entry = { index: seen.size, done: false };
    seen.set(value, entry);
    const prototype = Object.getPrototypeOf(value);
    const frozen = Object.isFrozen(value);
    const keys = Reflect.ownKeys(value);
    if (prototype === Date.prototype) {
      if (keys.length) throw NOT_PLAIN;
      // Throws a TypeError, caught below, for an object that only inherits from Date.prototype.
      push(`D${frozen ? 'F' : ''}${Date.prototype.getTime.call(value)}`);
    } else {
      const array = Array.isArray(value);
      if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw NOT_PLAIN;
      // A dense array owns its indices, in order, then its length, and nothing else.
      if (array && (keys.length !== value.length + 1
        || keys.some((key, index) => key !== (index < value.length ? String(index) : 'length'))
        || Reflect.getOwnPropertyDescriptor(value, 'length').writable === frozen)) throw NOT_PLAIN;
      if (!frozen && !Object.isExtensible(value)) throw NOT_PLAIN;
      push(`${array ? '[' : '{'}${prototype === null ? '0' : ''}${frozen ? 'F' : ''}`);
      for (const key of keys) {
        if (typeof key === 'symbol') throw NOT_PLAIN;
        if (array && key === 'length') continue;
        const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable
          || descriptor.writable === frozen || descriptor.configurable === frozen) throw NOT_PLAIN;
        if (!array) push(`${JSON.stringify(key)}:`);
        visit(descriptor.value);
        push(',');
      }
      push(array ? ']' : '}');
    }
    entry.done = true;
  };
  try {
    visit(args);
    return parts.join('');
  } catch {
    // Not plain data, too large, or an exotic object (such as a proxy) that failed while it was read.
    return null;
  }
};

// A copy of arguments that childArgsKey accepted, with the same prototypes, frozen objects, dates
// and shared references, so the adapter may change it without reaching the request's objects.
const clonePlainArgs = (value, copies = new Map()) => {
  if (value === null || typeof value !== 'object') return value;
  if (copies.has(value)) return copies.get(value);
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Date.prototype) {
    const date = new Date(Date.prototype.getTime.call(value));
    copies.set(value, date);
    return Object.isFrozen(value) ? Object.freeze(date) : date;
  }
  const copy = Array.isArray(value) ? [] : Object.create(prototype);
  copies.set(value, copy);
  for (const key of Object.keys(value)) {
    Object.defineProperty(copy, key, {
      value: clonePlainArgs(value[key], copies), writable: true, enumerable: true, configurable: true,
    });
  }
  return Object.isFrozen(value) ? Object.freeze(copy) : copy;
};

// The batch key of a parent ID: its string form, when the adapter casts the ID without changing
// that form. A missing ID (which keeps the adapter's own semantics, such as MongoDB matching
// children without a parent), an object whose string form says nothing of its value, an ID castId
// rejects and one it normalizes have none, and read alone.
const childParentKey = (parentId) => {
  try {
    if (parentId == null) return null;
    const key = String(parentId);
    if (typeof parentId === 'object' && key === Object.prototype.toString.call(parentId)) return null;
    return String(adapter.castId(parentId)) === key ? key : null;
  } catch {
    return null;
  }
};

// Collection reads of one request that wait for a batch: context -> related type registration ->
// (connection storage field + canonical arguments) -> group. Nothing is cached: each group is read
// once and dropped.
const childBatches = new WeakMap();

const readChildrenAlone = (type, connection, parentId, args) => adapter.findChildren(
  type.model, type.gqltype, connection.storageFieldName, parentId, args, null,
);

// Whether the adapter reads this type's children in batches, checked on every read as an adapter
// method call. A predicate that throws keeps per-parent reads; an error other than a SimfinityError
// is reported once per type.
const batchesChildren = (type, connection) => {
  if (adapter.batchesChildren == null) return true;
  try {
    return adapter.batchesChildren(type.model, type.gqltype, connection.storageFieldName) !== false;
  } catch (error) {
    if (!(error instanceof SimfinityError)) {
      warnOnce(type.gqltype, 'batchesChildren', 'Configuration issue: adapter.batchesChildren failed for '
        + `${type.gqltype.name} (${error?.message ?? String(error)}); its collection fields read one parent at a time.`);
    }
    return false;
  }
};

// Whether a batched child record may belong to the parent with this key: it is an object, and the
// parent it stores under the connection storage field (or its GraphQL name), when it shows one, has
// that key by string form or by castId. A stored list (a multikey connection) needs one such entry.
const belongsToParent = (record, connection, key) => {
  if (record === null || typeof record !== 'object') return false;
  let stored = ownValue(record, connection.storageFieldName);
  if (stored === undefined && connection.graphqlFieldName) stored = ownValue(record, connection.graphqlFieldName);
  if (stored === undefined) return true;
  const matches = (value) => {
    const id = value?._id ?? value;
    if (id == null) return false;
    try {
      return String(id) === key || String(adapter.castId(id)) === key;
    } catch {
      return false;
    }
  };
  return Array.isArray(stored) ? stored.some(matches) : matches(stored);
};

// The fields of one parent share its records, as references do, but each gets its own list.
const settleChildren = (waiters, list) => waiters.forEach(({ resolve }, index) => {
  resolve(index === 0 ? list : [...list]);
});

// After a failed read, each field reads alone, in its own promise job, with its own copy of the
// arguments and its own parent ID, so an error fails only the fields it would fail alone.
const readEachChildAlone = (type, group, waiters) => {
  for (const { parentId, resolve, reject } of waiters) {
    Promise.resolve()
      .then(() => readChildrenAlone(type, group.connection, parentId, clonePlainArgs(group.args)))
      .then(resolve, reject);
  }
};

// Whether a batch result holds one list per parent, in order, of records of that parent. Every index is
// checked, holes included, since Array.prototype.every skips empty slots.
const listsMatchParents = (lists, parents, connection) => {
  if (!Array.isArray(lists) || lists.length !== parents.length) return false;
  for (let index = 0; index < lists.length; index++) {
    const records = Object.hasOwn(lists, index) ? lists[index] : undefined;
    if (!Array.isArray(records)) return false;
    for (let position = 0; position < records.length; position++) {
      if (!Object.hasOwn(records, position) || !belongsToParent(records[position], connection, parents[index].key)) return false;
    }
  }
  return true;
};

const readChildren = async (type, group, parents, context) => {
  const { connection } = group;
  if (parents.length === 1) {
    // One distinct parent reads with findChildren, as before, shared by the fields that read it.
    const { waiters } = parents[0];
    let list;
    try {
      list = await readChildrenAlone(type, connection, waiters[0].parentId, clonePlainArgs(group.args));
    } catch (error) {
      if (waiters.length === 1) waiters[0].reject(error);
      else readEachChildAlone(type, group, waiters);
      return;
    }
    if (waiters.length > 1 && !Array.isArray(list)) readEachChildAlone(type, group, waiters);
    else settleChildren(waiters, list);
    return;
  }
  let lists;
  try {
    lists = await adapter.findChildrenBatch(type.model, type.gqltype, connection.storageFieldName,
      parents.map(({ waiters }) => waiters[0].parentId), clonePlainArgs(group.args), { context });
  } catch (error) {
    if (!(error instanceof SimfinityError)) {
      warnOnce(type.gqltype, 'findChildrenBatch', `adapter.findChildrenBatch failed for ${type.gqltype.name} `
        + `(${error?.message ?? String(error)}); the fields it read were read one parent at a time. Later failures `
        + 'for this type are not reported.');
    }
    parents.forEach(({ waiters }) => readEachChildAlone(type, group, waiters));
    return;
  }
  if (!listsMatchParents(lists, parents, connection)) {
    warnOnce(type.gqltype, 'findChildrenBatch', 'Configuration issue: adapter.findChildrenBatch did not return one '
      + `list of ${type.gqltype.name} records per parent ID, in parentIds order; the fields it read were read one `
      + 'parent at a time.');
    parents.forEach(({ waiters }) => readEachChildAlone(type, group, waiters));
    return;
  }
  parents.forEach(({ waiters }, index) => settleChildren(waiters, lists[index]));
};

const flushChildren = (type, group, context) => {
  const parents = [...group.parents].map(([key, { waiters }]) => ({ key, waiters }));
  for (let start = 0; start < parents.length; start += CHILD_BATCH_SIZE) {
    const chunk = parents.slice(start, start + CHILD_BATCH_SIZE);
    // An unexpected error settles every field of the chunk that is still waiting.
    readChildren(type, group, chunk, context).catch((error) => {
      for (const { waiters } of chunk) waiters.forEach(({ reject }) => reject(error));
    });
  }
};

// A generated collection read. It runs at once, with the arguments object it received, as before,
// unless the adapter batches this type's children, the request has a context object, the parent ID
// has a batch key, and the effective arguments are plain data with valid pagination and a key within
// the budget. Then it joins the request's group for its related type, connection storage field and
// arguments: the first read of a group copies the arguments, and later reads compute only the key.
const loadChildren = (type, connection, parentId, args, context) => {
  if (typeof adapter.findChildrenBatch !== 'function' || typeof context !== 'object' || context === null
    || !batchesChildren(type, connection)) return readChildrenAlone(type, connection, parentId, args);
  const key = childParentKey(parentId);
  const argsKey = key === null ? null : childArgsKey(args);
  if (argsKey === null) return readChildrenAlone(type, connection, parentId, args);
  try {
    // Invalid pagination fails each field alone, as findChildren reports it.
    paginationStages(args.pagination, true);
  } catch {
    return readChildrenAlone(type, connection, parentId, args);
  }
  let byType = childBatches.get(context);
  if (!byType) {
    byType = new Map();
    childBatches.set(context, byType);
  }
  let groups = byType.get(type);
  if (!groups) {
    groups = new Map();
    byType.set(type, groups);
  }
  const groupKey = `${JSON.stringify(connection.storageFieldName)}${argsKey}`;
  let group = groups.get(groupKey);
  if (!group) {
    let snapshot;
    try {
      snapshot = clonePlainArgs(args);
    } catch {
      return readChildrenAlone(type, connection, parentId, args);
    }
    group = { connection, args: snapshot, parents: new Map() };
    groups.set(groupKey, group);
    const created = group;
    // As for references, flush once the promise jobs queued so far have run.
    Promise.resolve().then(() => process.nextTick(() => {
      groups.delete(groupKey);
      if (!groups.size && byType.get(type) === groups) byType.delete(type);
      flushChildren(type, created, context);
    }));
  }
  return new Promise((resolve, reject) => {
    if (!group.parents.has(key)) group.parents.set(key, { waiters: [] });
    group.parents.get(key).waiters.push({ parentId, resolve, reject });
  });
};

// Why a type's generated create or update input has no fields, for the warnings of buildMutation. An
// update input also needs a writable id.
const withoutWritableFields = (type, { noWritableId = false } = {}) => {
  const stateField = type.gqltype.getFields().state;
  const managedState = type.stateMachine && stateField && !stateField.extensions?.readOnly;
  const state = managedState ? ' besides its state, which its state machine manages' : '';
  const id = noWritableId ? `${state ? ',' : ''} and no writable id` : '';
  return `${type.gqltype.name} has no writable fields${state}${id}`;
};

const createArgsForRegisteredOperation = (inputModel) => {
  if (!inputModel) return null;
  return { input: { type: new GraphQLNonNull(inputModel) } };
};

const buildRegisteredOperationField = (entry, registration, operation) => {
  const field = {
    type: registration.outputModel,
    description: registration.description,
    args: createArgsForRegisteredOperation(registration.inputModel),
    async resolve(parent, args, context) {
      const params = {
        args,
        operation,
        entry,
        context,
      };
      await executeMiddleware(params);
      return executeRegisteredOperation(args.input, registration, operation, context);
    },
  };
  if (operation === operations.CUSTOM_MUTATION) {
    field.extensions = { simfinityMutation: { operation } };
  }
  return field;
};

// Every generated mutation field carries extensions.simfinityMutation with its operation (and, for
// a state-machine action, the action and its from/to states), so tools such as the MCP package can
// classify it without guessing from its name. Extensions do not appear in SDL or introspection.
// An input object needs a field, so a type whose create input has none gets no add mutation, and
// one whose update input has none, which only a type without a writable id can have, gets no update
// mutation or state machine actions either (#161). A registered mutation replaces a generated root of
// the same name; each replaced root is added to `shadowedRoots` as `{ entry, typeName }`.
const buildMutation = (name, includedMutationTypes, includedCustomMutations, shadowedRoots = []) => {
  const rootQueryArgs = {};
  rootQueryArgs.name = name;
  rootQueryArgs.fields = {};

  buildPendingInputTypes(waitingInputType, includedMutationTypes);

  for (const type of Object.values(typesDict.types)) {
    if (!shouldNotBeIncludedInSchema(includedMutationTypes, type.gqltype)) {
      if (type.endpoint) {
        const argsObject = { input: { type: new GraphQLNonNull(type.inputType) } };

        if (hasInputFields(type.inputType)) {
          rootQueryArgs.fields[`add${type.simpleEntityEndpointName}`] = {
            type: type.gqltype,
            description: 'add',
            args: argsObject,
            extensions: { simfinityMutation: { typeName: type.gqltype.name, operation: operations.SAVE } },
            async resolve(parent, args, context) {
              const params = {
                type,
                args,
                operation: operations.SAVE,
                context,
              };

              await executeMiddleware(params);
              return executeOperation(type.model, type.gqltype, type.controller,
                args.input, operations.SAVE, null, null, context, type.inputType);
            },
          };
        } else {
          warnOnce(type.gqltype, 'emptyCreateInput', `Configuration issue: ${withoutWritableFields(type)}, so the `
            + `schema has no add${type.simpleEntityEndpointName} mutation; create its records with a registered `
            + (type.stateMachine
              ? 'mutation, which must set the initial state (saveObject() sets it).'
              : `mutation that takes no input or an input of its own, since getInputType(${type.gqltype.name}) `
                + 'has no fields.'));
        }
        // A protected type is deleted at the version the client read (#98).
        const deleteArgs = { id: { type: new GraphQLNonNull(GraphQLID) } };
        if (isProtected(type.gqltype)) deleteArgs.version = { type: new GraphQLNonNull(RecordVersion) };
        rootQueryArgs.fields[`delete${type.simpleEntityEndpointName}`] = {
          type: type.gqltype,
          description: 'delete',
          args: deleteArgs,
          extensions: { simfinityMutation: { typeName: type.gqltype.name, operation: operations.DELETE } },
          async resolve(parent, args, context) {
            const params = {
              type,
              args,
              operation: operations.DELETE,
              context,
            };

            await executeMiddleware(params);
            // A protected delete takes the version as middleware left it.
            const target = isProtected(type.gqltype) ? { id: args.id, version: args.version } : args.id;
            return executeOperation(type.model, type.gqltype, type.controller,
              target, operations.DELETE, null, null, context, null);
          },
        };
      }
    }
  }

  for (const type of Object.values(typesDictForUpdate.types)) {
    if (!shouldNotBeIncludedInSchema(includedMutationTypes, type.gqltype)) {
      if (type.endpoint && !hasInputFields(type.inputType)) {
        const reason = withoutWritableFields(type, { noWritableId: true });
        warnOnce(type.gqltype, 'emptyUpdateInput', `Configuration issue: ${reason}, so its generated update input `
          + `would have no fields and the schema has no update${type.simpleEntityEndpointName} mutation`
          + `${type.stateMachine ? ' and no state machine actions' : ''}.`);
      } else if (type.endpoint) {
        const argsObject = { input: { type: new GraphQLNonNull(type.inputType) } };
        rootQueryArgs.fields[`update${type.simpleEntityEndpointName}`] = {
          type: type.gqltype,
          description: 'update',
          args: argsObject,
          extensions: { simfinityMutation: { typeName: type.gqltype.name, operation: operations.UPDATE } },
          async resolve(parent, args, context) {
            const params = {
              type,
              args,
              operation: operations.UPDATE,
              context,
            };

            await executeMiddleware(params);
            return executeOperation(type.model, type.gqltype, type.controller,
              args.input, operations.UPDATE, null, null, context, type.inputType);
          },
        };
        if (type.stateMachine) {
          for (const [actionName, actionField] of Object.entries(type.stateMachine.actions)) {
            if ({}.hasOwnProperty.call(type.stateMachine.actions, actionName)) {
              rootQueryArgs.fields[`${actionName}_${type.simpleEntityEndpointName}`] = {
                type: type.gqltype,
                description: actionField.description,
                args: argsObject,
                extensions: {
                  simfinityMutation: {
                    typeName: type.gqltype.name,
                    operation: operations.STATE_CHANGED,
                    action: actionName,
                    from: actionField.from && actionField.from.name,
                    to: actionField.to && actionField.to.name,
                  },
                },
                async resolve(parent, args, context) {
                  const params = {
                    type,
                    args,
                    operation: operations.STATE_CHANGED,
                    actionName,
                    actionField,
                    context,
                  };

                  await executeMiddleware(params);
                  return executeOperation(type.model, type.gqltype, type.controller,
                    args.input, operations.STATE_CHANGED, actionField,
                    null, context, type.inputType);
                },
              };
            }
          }
        }
      }
    }
  }

  for (const [entry, registeredMutation] of Object.entries(registeredMutations)) {
    if (!shouldNotBeIncludedInSchema(includedCustomMutations, entry)) {
      const generated = Object.hasOwn(rootQueryArgs.fields, entry) && rootQueryArgs.fields[entry].extensions?.simfinityMutation;
      if (generated?.typeName) shadowedRoots.push({ entry, typeName: generated.typeName });
      rootQueryArgs.fields[entry] = buildRegisteredOperationField(entry, registeredMutation,
        operations.CUSTOM_MUTATION);
    }
  }

  return new GraphQLObjectType(rootQueryArgs);
};

// The prefix every generated read shares, for the list and aggregate roots, the collection fields and
// the views: the client's paths and conditions are inspected and marked, middleware runs, with `entry`
// when one is given, `extend` adds the caller's own constructs and returns their joined scopes, the
// type's scope runs, the client's joined scopes and then the extension's are applied, and the final
// arguments are settled. Returns the params, whose args the adapter reads. An empty map of the
// client's joined scopes is not awaited, so that, with the caller's await of this function, a read
// without one still reaches the adapter after as many promise jobs as before it was shared.
const prepareRead = async (type, args, context, operation, { entry, extend } = {}) => {
  const joinedScopes = inspectClientPaths(type.gqltype, args, operation);
  const issued = markClientConstructs(assertQueryConditions(type.gqltype, args, operation));
  const params = entry === undefined
    ? { type, args, operation, context }
    : { type, args, operation, entry, context };
  await executeMiddleware(params);
  const extended = extend ? await extend(params, issued) : null;
  await executeScope(params);
  if (joinedScopes.size) await applyJoinedScopes(joinedScopes, params);
  if (extended) await applyJoinedScopes(extended, params);
  const filling = settleClientArgs(type.gqltype, params, operation, issued);
  if (filling) await filling;
  return params;
};

// The tail of a list read, shared by the generated list root and the views: the rows and, when the
// client asks for pagination.count and something can receive it, the count, reported through the sink.
const readList = async (type, params, parent, info, context) => {
  const queryArgs = params.args;
  const wantsCount = !!(queryArgs.pagination && queryArgs.pagination.count)
    && canReportCount(parent, info, context);

  const dataPromise = adapter.find(type.model, type.gqltype, queryArgs, null);
  const countPromise = wantsCount
    ? adapter.count(type.model, type.gqltype, queryArgs, null)
    : null;

  const [result, resultCount] = await Promise.all([dataPromise, countPromise]);
  if (wantsCount && !reportCount(parent, info, context, resultCount)) {
    warnOnce(runtimeIdentity, 'count-context', 'Configuration issue: the GraphQL context does not accept '
      + 'a count property (it is frozen, sealed or has a read-only count), so pagination counts are not '
      + 'reported; pass a fresh mutable context object for each request.');
  }
  return result;
};

// Separates a view's params, named by `paramNames`, from the rest of its arguments, which are exactly
// a generated list's.
const splitViewArgs = (paramNames, args) => {
  const params = {};
  const rest = {};
  for (const [name, value] of Object.entries(args)) {
    if (paramNames.has(name)) params[name] = value;
    else rest[name] = value;
  }
  return { params, args: rest };
};

const invalidWhere = (view, detail) => new SimfinityError(`View ${view.name} where ${detail}`, 'INVALID_VIEW', 500);

// The groups a view's `where` returned are plain objects whose `conditions`, `AND` and `OR`, when set,
// are arrays: of plain objects with a field name, and of groups like these. collectQueryPathEntries
// skips anything else silently, so this comes before their paths are read. Only the GraphQL input
// fields are structural keys; condition values stay opaque. A condition never carries a client scope
// marker key: only the runtime writes one. Active ancestors reject cycles without rejecting reuse.
const assertViewGroupShapes = (view, groups, ancestors = new Set()) => {
  const groupFields = QLFilterGroup.getFields();
  const conditionFields = QLFilterCondition.getFields();
  for (const group of groups) {
    if (!isNonNullPlainObject(group)) throw invalidWhere(view, 'returned a group that is not a plain object');
    if (ancestors.has(group)) throw invalidWhere(view, 'returned a cyclic group');
    for (const key of Object.keys(group)) {
      if (!Object.hasOwn(groupFields, key)) throw invalidWhere(view, `returned a group with unknown key ${key}`);
    }
    for (const key of Object.keys(groupFields)) {
      if (group[key] != null && !Array.isArray(group[key])) throw invalidWhere(view, `returned a group whose ${key} is not an array`);
    }
    for (const condition of group.conditions ?? []) {
      if (!isNonNullPlainObject(condition) || typeof condition.field !== 'string' || condition.field === '') {
        throw invalidWhere(view, 'returned a condition that is not a plain object with a field name');
      }
      if (hasScopeMarker(condition)) {
        throw invalidWhere(view, `condition on ${condition.field} carries a ${SCOPE_MARKER} key, which Simfinity reserves`);
      }
      for (const key of Object.keys(condition)) {
        if (!Object.hasOwn(conditionFields, key)) throw invalidWhere(view, `condition on ${condition.field} has unknown key ${key}`);
      }
    }
    ancestors.add(group);
    assertViewGroupShapes(view, [...(group.AND ?? []), ...(group.OR ?? [])], ancestors);
    ancestors.delete(group);
  }
};

// A `where` that does not return an array of groups, or names a field its type does not have, a path
// past a field without fields, or a virtual field, is the author's bug: INVALID_VIEW (500), never the
// FORBIDDEN_FILTER_PATH (403) that inspectClientPaths gives a client for a virtual field. Each path is
// walked here, since walkQueryPath stops silently at an unknown segment.
const assertViewGroups = (view, groups) => {
  if (!Array.isArray(groups)) throw invalidWhere(view, 'must return an array of AND groups');
  assertViewGroupShapes(view, groups);
  for (const { segments } of collectQueryPathEntries({ AND: groups }, 'find', { gqltype: view.type })) {
    let type = view.type;
    let parent = null;
    for (const [index, segment] of segments.entries()) {
      const names = (detail) => invalidWhere(view, `names ${segments.slice(0, index + 1).join('.')}, which is ${detail}`);
      if (typeof type.getFields !== 'function') throw names(`past ${parent}, whose type ${type.name} has no fields`);
      const fields = type.getFields();
      if (!Object.hasOwn(fields, segment)) throw names(`not a field of ${type.name}`);
      if (isVirtualField(fields[segment])) throw names(`the virtual field ${type.name}.${segment}`);
      parent = `${type.name}.${segment}`;
      type = unwrapListAndNonNull(fields[segment].type);
    }
  }
};

// The `extend` of a view's read (see prepareRead). After middleware, the groups of `where` are read as
// the client's constructs on a probe, whose AND holds copies of them (inspectClientPaths), so the
// author's objects are never touched: their paths are inspected, their conditions checked and marked,
// with ids that continue the client's, then the copies are appended to the top-level AND, where no
// middleware can drop them. Returns their joined scopes, which attach to the appended copies. Their
// paths are the author's, as a scope's are, so a non-queryable field is not rejected.
const viewExtension = (view, viewParams) => async (params, issued) => {
  const groups = await view.where({ params: viewParams, context: params.context });
  assertViewGroups(view, groups);
  const probe = { AND: groups };
  const scopes = inspectClientPaths(view.type, probe, 'find', { checkQueryable: false });
  const checked = assertQueryConditions(view.type, probe, 'find');
  markClientConstructs(checked, issued);
  appendAndGroups(params.args, probe.AND);
  return scopes;
};

// A view's root field: the generated list of its type, with the view's params before the generated
// arguments. Each call reads the type's registration, whose model createSchema prepares, strips the
// params, by the names the field was built with, before the list pipeline runs, and has the pipeline
// append the view's `where` after middleware (viewExtension).
const buildViewField = (view) => {
  const paramArgs = {};
  for (const [paramName, param] of Object.entries(view.params)) {
    const arg = { type: param.type };
    if (Object.hasOwn(param, 'description')) arg.description = param.description;
    if (Object.hasOwn(param, 'defaultValue')) arg.defaultValue = param.defaultValue;
    paramArgs[paramName] = arg;
  }
  const paramNames = new Set(Object.keys(paramArgs));
  return {
    type: new GraphQLList(view.type),
    description: view.description,
    args: { ...paramArgs, ...createArgsForQuery(view.type) },
    extensions: {
      simfinityQuery: {
        typeName: view.type.name, operation: 'find', countSink: true, view: { name: view.name },
      },
    },
    async resolve(parent, args, context, info) {
      const registration = typesDict.types[view.type.name];
      const split = splitViewArgs(paramNames, args);
      const params = await prepareRead(registration, split.args, context, 'find', {
        entry: view.name, extend: viewExtension(view, split.params),
      });
      return readList(registration, params, parent, info, context);
    },
  };
};

const buildRootQuery = (name, includedTypes, aggregationResultType = QLTypeAggregationResult, includedCustomQueries = null) => {
  const rootQueryArgs = {};
  rootQueryArgs.name = name;
  rootQueryArgs.fields = {};

  for (const type of Object.values(typesDict.types)) {
    if (!shouldNotBeIncludedInSchema(includedTypes, type.gqltype)) {
      const wasAddedAsNoEnpointType = !type.simpleEntityEndpointName;
      if (!wasAddedAsNoEnpointType) {
        rootQueryArgs.fields[type.simpleEntityEndpointName] = {
          type: type.gqltype,
          args: { id: { type: GraphQLID } },
          async resolve(parent, args, context) {
            return resolveById(type, args, context);
          },
        };

        const argsObject = createArgsForQuery(type.gqltype);

        rootQueryArgs.fields[type.listEntitiesEndpointName] = {
          type: new GraphQLList(type.gqltype),
          args: argsObject,
          // countSink: this resolver reports pagination counts through reportCount, so a caller
          // that supplies a root-value sink can pass its context unchanged.
          extensions: { simfinityQuery: { typeName: type.gqltype.name, operation: 'find', countSink: true } },
          async resolve(parent, args, context, info) {
            const params = await prepareRead(type, args, context, 'find');
            return readList(type, params, parent, info, context);
          },
        };

        const aggregateArgsObject = { ...argsObject };
        const fields = type.gqltype.getFields();
        if (Object.hasOwn(fields, 'aggregation') && !isVirtualField(fields.aggregation)) {
          warnOnce(type.gqltype, 'aggregation', `Configuration issue: ${type.gqltype.name}.aggregation has the name `
            + `of the aggregation argument of ${type.listEntitiesEndpointName}_aggregate, so that endpoint cannot `
            + 'filter it with a top-level argument; filter it in AND/OR group conditions or rename the field.');
        }
        aggregateArgsObject.aggregation = {
          type: new GraphQLNonNull(QLTypeAggregationExpression),
        };

        rootQueryArgs.fields[`${type.listEntitiesEndpointName}_aggregate`] = {
          type: new GraphQLList(aggregationResultType),
          args: aggregateArgsObject,
          extensions: { simfinityQuery: { typeName: type.gqltype.name, operation: 'aggregate' } },
          async resolve(parent, args, context) {
            const params = await prepareRead(type, args, context, 'aggregate');
            return adapter.aggregate(type.model, type.gqltype, params.args, null);
          },
        };
      }
    }
  }

  for (const [entry, registeredQuery] of Object.entries(registeredQueries)) {
    if (!shouldNotBeIncludedInSchema(includedCustomQueries, entry)) {
      rootQueryArgs.fields[entry] = buildRegisteredOperationField(entry, registeredQuery,
        operations.CUSTOM_QUERY);
    }
  }

  // A view is in the schema exactly when its type is; assertViewsAvailable has checked its name.
  for (const view of Object.values(registeredViews)) {
    if (!shouldNotBeIncludedInSchema(includedTypes, view.type)) {
      rootQueryArgs.fields[view.name] = buildViewField(view);
    }
  }

  return new GraphQLObjectType(rootQueryArgs);
};

// Returns the registrations that a non-embedded relation of a registered type targets.
const markReferencedTypesForModelGeneration = () => {
  const referenced = new Set();
  Object.values(typesDict.types).forEach((typeInfo) => {
    Object.values(typeInfo.gqltype.getFields()).forEach((fieldEntry) => {
      const relation = fieldEntry.extensions?.relation;
      if (!relation || relation.embedded) return;

      const relatedType = unwrapListAndNonNull(fieldEntry.type);
      const relatedTypeInfo = typesDict.types[relatedType.name];
      if (relatedTypeInfo) referenced.add(relatedTypeInfo);
      if (relatedTypeInfo && !relatedTypeInfo.endpoint) {
        relatedTypeInfo.needsModel = true;
      }
    });
  });
  return referenced;
};

// Entity records keep their identity in `_id`; MongoDB records have no `id` value, while the SQL
// store and other adapters may set both. Embedded-only types keep the default resolver, which
// returns their declared `id` member.
const installIdResolver = (gqltype) => {
  const idField = gqltype.getFields().id;
  if (idField && !idField.resolve) idField.resolve = markGenerated((parent) => parent._id ?? parent.id);
};

// A rendered embedded value that may hold no data: a plain object, or a hydrated record, which
// converts itself with toObject() (MongoDB documents and their nested paths do). Promises, arrays,
// functions and other objects, such as dates or identifiers, are values.
const isRecordObject = (value) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || isThenable(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null || typeof value.toObject === 'function';
};
const isPlainObject = (value) => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

// The members an embedded value stores. The rule below reads them instead of the value, so no getter
// or virtual of the application runs, whatever the selection. An adapter that hydrates records
// returns their stored data through rawEmbeddedValue (MongoDB: a nested path's raw value, a
// subdocument's _doc); an absent stored value has no members. A plain object is read as it is.
// Returns null for anything else, such as a record the adapter does not convert, which counts as data.
const storedMembersOf = (value) => {
  if (!isRecordObject(value)) return null;
  const stored = typeof adapter.rawEmbeddedValue === 'function' ? adapter.rawEmbeddedValue(value) : value;
  if (stored === null || stored === undefined) return {};
  return typeof stored === 'object' && !Array.isArray(stored) && !isThenable(stored) && isPlainObject(stored)
    ? stored : null;
};

// A stored member: an own data property, read without calling accessors. An accessor is present,
// whatever it would return.
const PRESENT = Symbol('present');
const ownStoredValue = (stored, key) => {
  const descriptor = Object.getOwnPropertyDescriptor(stored, key);
  if (!descriptor) return undefined;
  if (!('value' in descriptor)) return PRESENT;
  return isObjectMember(key, descriptor.value) ? undefined : descriptor.value;
};
// A referenced collection stores nothing in the object. `id` reads the stored identity, `_id` before
// `id`, as the generated entity resolver (installIdResolver) and Mongoose's id virtual do. Every other
// member is stored under its storage name.
const isReferencedCollection = (member) => {
  const relation = member.extensions?.relation;
  return Boolean(relation && !relation.embedded && getListShape(member.type));
};
const storedMemberValue = (stored, memberName, member) => {
  if (isReferencedCollection(member)) return undefined;
  const identity = memberName === 'id' ? ownStoredValue(stored, '_id') : undefined;
  return identity ?? ownStoredValue(stored, getFieldStorageName(memberName, member));
};

// Whether stored members hold no data: every member is null or undefined, an empty list, or a
// singular embedded object that holds no data. Any other value, a promise or an accessor included,
// is data. An object that contains itself, which only a custom result can, holds data.
const holdsNoData = (stored, type, ancestors = []) => !ancestors.includes(stored)
  && Object.entries(type.getFields()).every(([memberName, member]) => {
    const value = storedMemberValue(stored, memberName, member);
    if (value === null || value === undefined) return true;
    if (Array.isArray(value)) return value.length === 0;
    const memberType = unwrapNonNull(member.type);
    if (member.extensions?.relation?.embedded !== true || !(memberType instanceof GraphQLObjectType)) return false;
    const nested = storedMembersOf(value);
    return nested !== null && holdsNoData(nested, memberType, [...ancestors, stored]);
  });

// The members that count: non-null members that generated inputs accept. As on writes
// (completeEmbeddedValue), `id` and readOnly members do not; nor do interface and union members,
// which buildInputType leaves out; nor do referenced collections or members with an application
// resolver, which may compute a value.
const countsAsRequired = (type, memberName, member) => member.type instanceof GraphQLNonNull
  && !isReferencedCollection(member) && memberName !== 'id' && !isReadOnlyField(member)
  && !isAbstractOutputType(unwrapListAndNonNull(member.type)) && !hasApplicationResolver(type, memberName);
const hasRequiredMember = (type) => Object.entries(type.getFields())
  .some(([memberName, member]) => countsAsRequired(type, memberName, member));

// Whether rendering such an object fails: a member that counts is null or undefined, or is a singular
// embedded object that misses one of its own. A promise or an accessor counts as present.
const missesRequiredMember = (stored, type) => Object.entries(type.getFields()).some(([memberName, member]) => {
  if (!countsAsRequired(type, memberName, member)) return false;
  const value = storedMemberValue(stored, memberName, member);
  if (value === null || value === undefined) return true;
  if (member.extensions?.relation?.embedded !== true || !(member.type.ofType instanceof GraphQLObjectType)) return false;
  const nested = storedMembersOf(value);
  return nested !== null && missesRequiredMember(nested, member.type.ofType);
});

// A type without a member that counts never reads as null, so its values are returned untouched,
// with no member read. Reading stored members never changes the result otherwise: a value whose
// members cannot be read, because an adapter hook or a property read throws, is returned as it is.
const readEmbeddedObject = (value, type) => {
  if (!(type instanceof GraphQLObjectType) || !hasRequiredMember(type)) return value;
  try {
    const stored = storedMembersOf(value);
    return stored !== null && holdsNoData(stored, type) && missesRequiredMember(stored, type) ? null : value;
  } catch {
    return value;
  }
};

// An adapter that hydrates stored records may render an explicitly null singular embedded object as
// an object (MongoDB nested paths do); readEmbeddedValue returns null for it. Nullable singular
// embedded fields of registered types, and of the embedded types they reach, read through it. The
// hook depends only on the value and reads no data, so these resolvers do not bind their types to
// this runtime: another runtime that reaches a shared type reads the same value through it.
// The value is read as graphql's default resolver reads it, so a method on the parent, such as one a
// custom mutation result supplies, is still called; a promise it returns is read once it settles.
// Only a field named like an Object.prototype member that reads as that member reads as null.
// Such an adapter may also render an absent object, or store an omitted one, as an object that holds
// nothing but its list defaults (MongoDB nested paths do). An object that holds no data and misses a
// required member (see missesRequiredMember) cannot be rendered, so it reads as null, as an absent
// object does on other read paths, whatever the selection. The rule reads the stored members
// (storedMembersOf), never running a getter or virtual, and depends only on the value and its type,
// so runtimes that share the type, with or without the hook, read the same. An object a
// generated create or update writes does not read as null, since those writes require the members
// counted, with one exception: Mongoose minimizes empty objects when it saves a new document, so a
// create that writes an empty object for a required embedded member (`geo: {}`) stores that member
// as absent. An object that holds nothing else then reads as null, as an omitted one does, except
// where Mongoose hydrates the document (by-ID and reference reads, update responses) and the member is
// a nested path, which it renders as `{}`. Generated models declare every embedded member as a nested
// path except one named `type`, a single nested subdocument. PostgreSQL rejects such a create
// (REQUIRED_VALUE).
const readEmbeddedField = markGenerated((parent, args, context, info) => {
  const value = readOwnField(parent, args, context, info);
  const read = (resolved) => readEmbeddedObject(adapter.readEmbeddedValue(resolved), getNamedType(info.returnType));
  return isThenable(value) ? value.then(read) : read(value);
});

const installEmbeddedValueResolvers = (gqltype, visited) => {
  if (!(gqltype instanceof GraphQLObjectType) || visited.has(gqltype)) return;
  visited.add(gqltype);
  for (const fieldEntry of Object.values(gqltype.getFields())) {
    if (fieldEntry.extensions?.relation?.embedded !== true) continue;
    const listShape = getListShape(fieldEntry.type);
    if (!listShape && !(fieldEntry.type instanceof GraphQLNonNull) && !fieldEntry.resolve) {
      fieldEntry.resolve = readEmbeddedField;
    }
    installEmbeddedValueResolvers(listShape ? listShape.itemType : unwrapNonNull(fieldEntry.type), visited);
  }
};

// Fields named like Object.prototype members, of registered types and the embedded types they reach,
// read through readOwnField when they have no resolver yet; references and collections keep the ones
// autoGenerateResolvers gives them.
const installObjectMemberResolvers = (gqltype, visited) => {
  if (!(gqltype instanceof GraphQLObjectType) || visited.has(gqltype)) return;
  visited.add(gqltype);
  for (const [fieldName, fieldEntry] of Object.entries(gqltype.getFields())) {
    const relation = fieldEntry.extensions?.relation;
    if (relation && !relation.embedded) continue;
    if (fieldName in Object.prototype && !fieldEntry.resolve) fieldEntry.resolve = readOwnField;
    if (relation) installObjectMemberResolvers(unwrapListAndNonNull(fieldEntry.type), visited);
  }
};

// Configuration issues this runtime already reported, per type, so a repeated createSchema call or a
// type reached from several places logs each one once.
const reportedIssues = new WeakMap();
const warnOnce = (gqltype, key, message) => {
  if (!reportedIssues.has(gqltype)) reportedIssues.set(gqltype, new Set());
  const reported = reportedIssues.get(gqltype);
  if (reported.has(key)) return;
  reported.add(key);
  console.warn(message);
};

// A connectionField names a field, never a path (assertPlainConnectionField), in every type a model
// stores: the registered types and the embedded types they store, at any depth, whether or not an
// embedded type is registered itself, as describeModels and MongoDB's generated models reach them.
const assertPlainConnectionFields = () => {
  const visited = new Set();
  const visit = (gqltype) => {
    if (visited.has(gqltype)) return;
    visited.add(gqltype);
    for (const [fieldName, field] of Object.entries(gqltype.getFields())) {
      assertPlainConnectionField(gqltype.name, fieldName, field);
      const named = field.extensions?.relation?.embedded && getNamedType(field.type);
      if (named instanceof GraphQLObjectType) visit(named);
    }
  };
  for (const { gqltype } of Object.values(typesDict.types)) visit(gqltype);
};

// A writable referenced collection without a child connectionField would store unlinked children
// through generated nested writes and read none back, so it is rejected before anything is built.
// One with its own resolver only warns, and its nested writes are rejected per request; a readOnly
// one warns unless it has its own resolver.
const assertCollectionConnections = () => {
  for (const { gqltype } of Object.values(typesDict.types)) {
    for (const [fieldName, field] of Object.entries(gqltype.getFields())) {
      if (!isUnlinkedCollection(field)) continue;
      const problem = `${gqltype.name}.${fieldName} requires a child connectionField`;
      const readOnly = !!field.extensions.readOnly;
      const ownResolver = hasApplicationResolver(gqltype, fieldName);
      if (!readOnly && !ownResolver) throw new SimfinityError(problem, 'INVALID_MODEL', 400);
      if (!readOnly || !ownResolver) {
        warnOnce(gqltype, `connectionField:${fieldName}`,
          `Configuration issue: ${problem}; nested writes through it are rejected`);
      }
    }
  }
};

// Virtual fields (`extensions.virtual`) of the object types a schema reaches, registered or not, and
// the uses of them that registered types declare, are checked before anything is built
// (INVALID_MODEL, 400). Returns whether any field is virtual.
const assertVirtualFields = (schemaTypes) => {
  let declared = false;
  for (const type of schemaTypes) {
    if (!(type instanceof GraphQLObjectType)) continue;
    for (const [fieldName, field] of Object.entries(type.getFields())) {
      if (assertVirtualDeclaration(type.name, fieldName, field, () => hasApplicationResolver(type, fieldName))) {
        declared = true;
      }
      assertVirtualConnection(type, fieldName, field, () => hasApplicationResolver(type, fieldName));
    }
  }
  for (const { gqltype, stateMachine } of Object.values(typesDict.types)) {
    assertVirtualIndexes(gqltype);
    assertVirtualStateField(gqltype, stateMachine);
  }
  return declared;
};

// A readOnly field with arguments and its own resolver is almost always computed, yet unless it is
// virtual it is stored and filterable like any other field. References and collections, whose
// storage is a link rather than the field's value and which cannot be virtual, are not reported.
// The advice also names the settings it declares that a virtual field cannot, such as the
// `relation: { embedded: true }` of a computed embedded value.
const warnUndeclaredVirtualFields = () => {
  for (const { gqltype } of Object.values(typesDict.types)) {
    for (const [fieldName, field] of Object.entries(gqltype.getFields())) {
      const relation = field.extensions?.relation;
      if (!field.extensions?.readOnly || !field.args.length || isVirtualField(field)
        || (relation && !relation.embedded) || !hasApplicationResolver(gqltype, fieldName)) continue;
      const conflicts = virtualConflicts(field.extensions);
      const removal = conflicts.length
        ? ` and remove ${conflicts.length < 3 ? conflicts.join(' and ') : `${conflicts.slice(0, -1).join(', ')} and ${conflicts.at(-1)}`}`
        : '';
      warnOnce(gqltype, `undeclaredVirtual:${fieldName}`, `Configuration issue: ${gqltype.name}.${fieldName} is `
        + 'readOnly and has arguments and its own resolver, but it is not virtual, so Simfinity describes it as '
        + 'stored data: backends may store it, and list queries get a filter argument for it. If its resolver '
        + `computes it, declare extensions: { virtual: true }${removal}.`);
    }
  }
};

// The types a model stores: the registered types and the embedded types they reach at any depth,
// readOnly fields included, as assertPlainConnectionFields visits them.
const collectStoredTypes = () => {
  const stored = new Set();
  const visit = (gqltype) => {
    if (stored.has(gqltype)) return;
    stored.add(gqltype);
    for (const field of Object.values(gqltype.getFields())) {
      const named = field.extensions?.relation?.embedded && getNamedType(field.type);
      if (named instanceof GraphQLObjectType) visit(named);
    }
  };
  for (const { gqltype } of Object.values(typesDict.types)) visit(gqltype);
  return [...stored];
};

const invalidModel = (message) => new SimfinityError(message, 'INVALID_MODEL', 400);

// Optimistic concurrency (#98), declared per type with `extensions.concurrency`. These checks run in
// this order, after stored identities are known and before adapter.prepare(), so a rejected schema
// changes nothing. `applicationTypes` are the roots of the schema's types. Returns the registrations of
// the protected types and whether the included roots reserve the version names.
const assertConcurrencyDeclarations = (applicationTypes) => {
  const registrations = Object.values(typesDict.types);
  // The shape of every declaration.
  const protectedTypes = registrations.filter(({ gqltype }) => concurrencyDeclared(gqltype));
  // Generated inputs, models and stored data follow the protection a type had when the first schema
  // containing it was created, and an injected field is never removed, so neither can change later.
  // Inputs or a model that an earlier createSchema() built without the field, even one that failed
  // afterwards, count as such a schema; a model supplied to connect() does not.
  for (const registration of registrations) {
    const { gqltype } = registration;
    const declared = protectedTypes.includes(registration);
    const builtWithoutField = !isProtected(gqltype)
      && (!!registration.inputType || generatedModels.has(registration.model));
    if (declared && (protectionStatus.get(gqltype) === false || builtWithoutField)) {
      throw invalidModel(`${gqltype.name} declares optimistic concurrency after a schema was created without it; `
        + `declare it before the first createSchema() that contains ${gqltype.name}`);
    }
    if (!declared && isProtected(gqltype)) {
      throw invalidModel(`${gqltype.name} no longer declares optimistic concurrency, but Simfinity already added its `
        + 'version field; keep extensions.concurrency on a type once it has that field');
    }
  }
  // Another runtime that registers a protected type injects its field when that runtime creates a
  // schema, which would change a schema already built here, so this schema must register every
  // protected type it contains, whatever the adapter supports.
  const reachedTypes = collectOutputTypes(applicationTypes);
  for (const type of reachedTypes) {
    if (type instanceof GraphQLObjectType && typesDict.types[type.name]?.gqltype !== type && isProtectedType(type)) {
      throw invalidModel(`${type.name} declares optimistic concurrency, so a schema that contains it must register it `
        + 'in this runtime, with connect() or as a relation target');
    }
  }
  // An embedded value's changes belong to the revision of the record that embeds it, wherever a model
  // stores it.
  const storedTypes = collectStoredTypes();
  const storedFields = storedTypes.flatMap((gqltype) => Object.entries(gqltype.getFields())
    .map(([fieldName, field]) => ({ gqltype, fieldName, field })));
  for (const { gqltype, fieldName, field } of storedFields) {
    const named = field.extensions?.relation?.embedded && getNamedType(field.type);
    if (named instanceof GraphQLObjectType && isProtectedType(named)) {
      throw invalidModel(versionEmbeddedMisuse(named.name, `${gqltype.name}.${fieldName}`));
    }
  }
  // Only an entity has a record of its own whose version can advance.
  const nonEntity = protectedTypes.find(({ storedIdentity }) => storedIdentity !== true);
  if (nonEntity) {
    throw invalidModel(`${nonEntity.gqltype.name} declares optimistic concurrency, so it must be an entity: register it `
      + 'with connect() or make it a relation target');
  }
  // Nothing else may be stored, or link records, under the version field's name.
  for (const { gqltype } of protectedTypes) {
    const collision = versionFieldCollision(gqltype);
    if (collision) throw invalidModel(collision);
  }
  for (const { gqltype, fieldName, field } of storedFields) {
    const collision = versionConnectionCollision(gqltype, fieldName, field);
    if (collision) throw invalidModel(collision);
  }
  // RecordVersion types managed version fields only, with or without protected types; registered
  // operations may still use it in their own input and output types.
  for (const gqltype of storedTypes) {
    const misuse = recordVersionFieldMisuse(gqltype);
    if (misuse) throw invalidModel(misuse);
  }
  const reserveVersionNames = protectedTypes.some(({ gqltype }) => reachedTypes.includes(gqltype));
  if (protectedTypes.length && !writeFeatures.optimisticConcurrency) {
    throw invalidModel(`The database adapter does not support optimistic concurrency, which ${protectedTypes[0].gqltype.name} `
      + 'declares (extensions.concurrency)');
  }
  // A clash that only generated types or the fields of an input object reach is found when the schema
  // is constructed.
  const clash = reserveVersionNames && versionTypeClash(applicationTypes, { inputFields: false });
  if (clash) throw reservedVersionTypeNameError(clash);
  return { protectedTypes, reserveVersionNames };
};

const getRegistrations = () => Object.values(typesDict.types);

const includedOperationTypes = (registrations, includedOperations) => Object.entries(registrations)
  .filter(([entry]) => !shouldNotBeIncludedInSchema(includedOperations, entry))
  .flatMap(([, { inputModel, outputModel }]) => [inputModel, outputModel].filter(Boolean));

// Application types that a schema with these allowlists contains, whatever else it reaches: the
// endpoint types of its queries and mutations, the input and output types of its custom operations,
// and the scalar/enum parameters of included named views.
const includedApplicationTypes = (includedQueryTypes, includedMutationTypes, includedCustomMutations, includedCustomQueries) => [
  ...Object.values(typesDict.types)
    .filter((type) => type.endpoint
      && ((type.simpleEntityEndpointName && !shouldNotBeIncludedInSchema(includedQueryTypes, type.gqltype))
        || !shouldNotBeIncludedInSchema(includedMutationTypes, type.gqltype)))
    .map((type) => type.gqltype),
  ...includedOperationTypes(registeredMutations, includedCustomMutations),
  ...includedOperationTypes(registeredQueries, includedCustomQueries),
  ...Object.values(registeredViews)
    .filter(({ type }) => !shouldNotBeIncludedInSchema(includedQueryTypes, type))
    .flatMap(({ params }) => Object.values(params).map(({ type }) => getNamedType(type))),
];

const queryNameConflict = (name) => new SimfinityError(
  `Query ${name} is already registered or conflicts with a generated query in this schema`,
  'QUERY_NAME_CONFLICT', 500,
);

// The root names of the generated queries of the endpoint types a schema includes.
const generatedQueryNames = (includedQueryTypes) => Object.values(typesDict.types)
  .filter((type) => type.simpleEntityEndpointName && !shouldNotBeIncludedInSchema(includedQueryTypes, type.gqltype))
  .flatMap((type) => [type.simpleEntityEndpointName, type.listEntitiesEndpointName, `${type.listEntitiesEndpointName}_aggregate`]);

const isIncludedCustomQuery = (name, includedCustomQueries) => Object.hasOwn(registeredQueries, name)
  && !shouldNotBeIncludedInSchema(includedCustomQueries, name);

const assertQueryNamesAvailable = (includedQueryTypes, includedCustomQueries) => {
  for (const name of generatedQueryNames(includedQueryTypes)) {
    if (isIncludedCustomQuery(name, includedCustomQueries)) throw queryNameConflict(name);
  }
};

// Every registered view, whether or not the schema includes it: its type is an endpoint type of this
// runtime, and its params are valid argument names that are neither fields of the type, which covers
// stored, reference, collection and virtual fields, nor the generated list arguments. A view that the
// schema includes, because it includes the view's type, also needs a name that no included generated
// query or custom query takes.
const assertViewsAvailable = (includedQueryTypes, includedCustomQueries) => {
  const views = Object.values(registeredViews);
  if (!views.length) return;
  const generatedNames = new Set(generatedQueryNames(includedQueryTypes));
  for (const { name, type, params } of views) {
    const registration = typesDict.types[type.name];
    if (!registration || registration.gqltype !== type || registration.endpoint !== true
      || !registration.simpleEntityEndpointName) {
      throw invalidView(`${name} needs a type registered with connect() in this runtime`);
    }
    const fields = type.getFields();
    for (const paramName of Object.keys(params)) {
      if (!/^[_A-Za-z][_0-9A-Za-z]*$/.test(paramName) || paramName.startsWith('__')) {
        throw invalidView(`${name} param ${paramName} requires a valid GraphQL name that does not start with __`);
      }
      // A protected type's managed version is injected later in createSchema(), but its name is
      // already unavailable to view params on the first schema, as on every subsequent schema.
      if (Object.hasOwn(fields, paramName) || (paramName === 'version' && isProtectedType(type))) {
        throw invalidView(`${name} param ${paramName} has the name of a field of ${type.name}`);
      }
      if (LIST_QUERY_ARGS.includes(paramName)) {
        throw invalidView(`${name} param ${paramName} has the name of a generated list query argument`);
      }
    }
    if (!shouldNotBeIncludedInSchema(includedQueryTypes, type)
      && (generatedNames.has(name) || isIncludedCustomQuery(name, includedCustomQueries))) {
      throw queryNameConflict(name);
    }
  }
};

const invalidSchemaOptions = (detail) => new SimfinityError(
  `createSchema options ${detail}`, 'INVALID_SCHEMA_OPTIONS', 500,
);

const SCHEMA_OPTION_KEYS = new Set(['includedCustomQueries', 'transaction']);

// The root names an included endpoint type's generated mutations can have, whether or not its inputs
// leave some of them out.
const generatedMutationNames = ({ simpleEntityEndpointName: endpoint, stateMachine }) => [
  `add${endpoint}`, `delete${endpoint}`, `update${endpoint}`,
  ...Object.keys(stateMachine?.actions ?? {}).map((actionName) => `${actionName}_${endpoint}`),
];

// The generated transaction field (#151), checked before anything is prepared: the option's shape, its
// types (registered in this runtime), the adapter's support, the field name against the included
// registered mutations and every root the included endpoint types can generate, and whether any of
// its types is an included endpoint type, which always generates a delete root. Returns null or
// `{ name, types }`.
const readTransactionConfig = (option, includedMutationTypes, includedCustomMutations) => {
  const config = readTransactionOption(option);
  if (!config) return null;
  for (const type of config.types) {
    assertNotBoundElsewhere(type);
    if (typesDict.types[type.name]?.gqltype !== type) {
      throw invalidTransactionOption(`${type.name} is not registered in this runtime`);
    }
  }
  if (typeof adapter.assertTransactionModels !== 'function') throw transactionUnsupportedError();
  const { name, types } = config;
  if (Object.hasOwn(registeredMutations, name) && !shouldNotBeIncludedInSchema(includedCustomMutations, name)) {
    throw invalidTransactionOption(`name ${name} conflicts with the registered mutation ${name}`);
  }
  const included = Object.values(typesDict.types)
    .filter((type) => type.endpoint && !shouldNotBeIncludedInSchema(includedMutationTypes, type.gqltype));
  if (included.some((type) => generatedMutationNames(type).includes(name))) {
    throw invalidTransactionOption(`name ${name} conflicts with a generated mutation`);
  }
  if (!included.some((type) => types.includes(type.gqltype))) throw noOperationError();
  return config;
};

// The fourth createSchema() argument: omitted, or a plain object with known keys only.
const readSchemaOptions = (options, includedMutationTypes, includedCustomMutations) => {
  if (options === undefined) return { transaction: null };
  if (options === null || typeof options !== 'object' || !isPlainObject(options)) {
    throw invalidSchemaOptions('must be a plain object');
  }
  const unknown = Reflect.ownKeys(options).find((key) => !SCHEMA_OPTION_KEYS.has(key));
  if (unknown !== undefined) {
    throw invalidSchemaOptions(`has an unknown option ${String(unknown)}`);
  }
  const { includedCustomQueries } = options;
  if (includedCustomQueries != null && (!Array.isArray(includedCustomQueries)
    || includedCustomQueries.some((name) => typeof name !== 'string'))) {
    throw invalidSchemaOptions('includedCustomQueries must be an array of strings, null or undefined');
  }
  const transaction = readTransactionConfig(options.transaction, includedMutationTypes, includedCustomMutations);
  return { includedCustomQueries, transaction };
};

// The types whose collections a transaction's references count (planReferences, item 4): every type
// registered in this runtime.
const referenceRegistry = { registeredTypes: () => Object.values(typesDict.types).map(({ gqltype }) => gqltype) };

// The model affinity check (#151), before the session opens, so that models that cannot share one database
// transaction fail before anything runs. The adapter's check is synchronous: a thenable it returns is
// refused, once the rejection of a native promise is handled so it cannot crash the process. An error it
// throws passes through unchanged.
const assertTransactionModels = (models) => {
  if (typeof adapter.assertTransactionModels !== 'function') throw transactionUnsupportedError();
  const result = adapter.assertTransactionModels(models);
  if (isThenable(result)) {
    discardThenable(result);
    throw new SimfinityError('assertTransactionModels must be synchronous', 'TRANSACTION_UNSUPPORTED', 500);
  }
};

// An error of the input walk of one operation, as a new SimfinityError with the same message, code and
// status that names the operation, as planReferences reports its errors. Any other error is not the
// input's and passes through.
const operationInputError = (error, index, key) => {
  if (!(error instanceof SimfinityError)) return error;
  const positioned = new SimfinityError(error.message, error.extensions.code, error.extensions.status);
  positioned.extensions.operationIndex = index;
  positioned.extensions.operation = key;
  return positioned;
};

// The steps of the list GraphQL coerced, `{ index, key, entry }`, one per item. GraphQL has checked the
// items (@oneOf), so each has exactly one of the field's operation keys.
const transactionSteps = (transactionState, operationList) => operationList.map((item, index) => {
  const keys = item !== null && typeof item === 'object' ? Object.keys(item) : [];
  const entry = keys.length === 1 ? transactionState.operations.get(keys[0]) : undefined;
  if (entry === undefined) throw new TypeError(`Item ${index} is not an operation of ${transactionState.name}`);
  return { index, key: keys[0], entry };
});

// The input walk over the list GraphQL coerced, which applies the scalar and record-key rules, bounds the
// nesting and requires the top-level id of an update, an action or a delete. Returns the snapshot: one
// `{ [key]: value }` per item, which the list never shares.
const snapshotTransaction = (steps, operationList) => steps.map(({ index, key, entry }) => {
  try {
    return {
      [key]: snapshotOperationInput(operationList[index][key], entry.valueType, {
        ...operationWalkOptions, mode: 'coerced', path: `operations[${index}].${key}`, topLevelId: entry.operation !== operations.SAVE,
      }),
    };
  } catch (error) {
    throw operationInputError(error, index, key);
  }
});

// The nested entries of the whole list, nulls included, against the snapshotted limit; null is no limit.
// `list` is the list GraphQL coerced, or a snapshot of it, which has the same entries. It only looks
// ahead: the attempts count what runs. A delete has no nested entries.
const assertTransactionNestedOperations = (steps, list, limit) => {
  if (limit === null) return;
  const counted = { count: 0 };
  for (const { index, key, entry } of steps) {
    if (entry.operation !== operations.DELETE) assertNestedOperations(entry.type.gqltype, list[index][key], limit, counted);
  }
};

// What identifies the marker of a generated root by content: its type, operation and action, which a copy
// of the marker (a spread or a deep clone) keeps. Anything else under the key identifies nothing.
const rootMarkerIdentity = (marker) => {
  if (marker === null || typeof marker !== 'object') return undefined;
  const { typeName, operation, action } = marker;
  if (typeof typeName !== 'string' || typeof operation !== 'string'
    || (action !== undefined && action !== null && typeof action !== 'string')) return undefined;
  return JSON.stringify([typeName, operation, action ?? null]);
};

// An operation whose root the Mutation type that runs the transaction does not expose, positioned as the
// input walk and the references report their errors.
const unexposedOperationError = (mutationType, operationIndex, operation) => {
  const error = new ForbiddenError(`Access denied to ${mutationType.name}.${operation}`);
  error.extensions.operationIndex = operationIndex;
  error.extensions.operation = operation;
  return error;
};

// Where each operation of the list may run: `mutationType`, the Mutation type that runs the
// transaction (`info.parentType`), must expose its generated root, that is, have a field whose marker is
// the marker of the root the field was built with, or a copy of it, under any name. A served copy of the
// schema can drop a root, or put another field under its name, and a direct call could then not reach the
// root there, so neither may an operation: the first operation of the list whose root is not exposed
// fails with FORBIDDEN, `Access denied to <Mutation type>.<key>`, before the transaction.
//
// Returns operation key -> the roots whose checks the operation gets on every attempt: one per distinct
// marker, by identity, among the markers of the fields that expose the root and the marker of the root the
// field was built with. The identity field's marker comes first, then those of the other fields in field
// order, then the built one. A copy that renames the root, aliases it or clones its markers thus runs the
// checks of every name that reaches the root, and never fewer than the schema the field was built in: a
// transform that clones the markers would otherwise drop the entries its copied wrappers still enforce.
// authorizeOperation reads only a root's name, type and marker, so each root is a view of one marker with
// the identity the rules see: the operation key as `info.fieldName`, and the type of the identity field,
// which is the field that exposes the root under the key, or else the first field that exposes it, in field
// order. The rules' `info.parentType` is the Mutation type that runs the transaction, whose fields they all
// are.
const exposedOperationRoots = (steps, mutationType) => {
  const exposing = new Map();
  for (const field of Object.values(mutationType.getFields())) {
    const identity = rootMarkerIdentity(field.extensions?.simfinityMutation);
    if (identity === undefined) continue;
    if (!exposing.has(identity)) exposing.set(identity, []);
    exposing.get(identity).push(field);
  }
  const roots = new Map();
  for (const { index, key, entry } of steps) {
    if (roots.has(key)) continue;
    const builtMarker = entry.rootField.extensions.simfinityMutation;
    const fields = exposing.get(rootMarkerIdentity(builtMarker)) ?? [];
    if (fields.length === 0) throw unexposedOperationError(mutationType, index, key);
    const identityField = fields.find((field) => field.name === key) ?? fields[0];
    const markers = new Set([identityField, ...fields].map((field) => field.extensions.simfinityMutation));
    markers.add(builtMarker);
    roots.set(key, [...markers].map((marker) => Object.freeze({
      name: key, type: identityField.type, extensions: Object.freeze({ simfinityMutation: marker }),
    })));
  }
  return roots;
};

// The checks a direct call to an operation's root gets: the entries the auth plugin recorded
// on each of the operation's roots (exposedOperationRoots), in order.
const authorizeTransactionOperation = async (roots, parent, args, context, info) => {
  for (const root of roots) await authorizeOperation(root, parent, args, context, info);
};

// Whether the error that ended the transaction is the one that ended the final attempt, `operationError`,
// or an error an adapter made of it, such as TRANSACTION_RETRY_EXCEEDED, that keeps it in its `cause`
// chain. Any other error, such as the failure of a begin, a commit, a rollback or a release, or one of an
// earlier attempt, is not that operation's.
const reachesOperationError = (error, operationError) => {
  if (error === operationError) return true;
  const seen = new Set();
  let current = error;
  while ((typeof current === 'object' && current !== null) || typeof current === 'function') {
    if (seen.has(current)) return false;
    seen.add(current);
    current = current.cause;
    if (current != null && current === operationError) return true;
  }
  return false;
};

// The record of each result item of a transaction that has one, with the item's operation key and the type
// that operation's root returned when the field was built: what TransactionResult.id resolves from. The
// item of a delete of a missing record has none.
const transactionResultRecords = new WeakMap();

// The record's type in the executing schema, whose fields a plugin applied to that schema wrapped: the
// object type the executing result type gives the operation key, or else the executing schema's object
// type of the name the root returned when the field was built. Undefined when it has neither: the type the
// field was built with is never used, since a plugin applied to a copy with new type objects never wrapped it.
const executingRecordType = (info, key, builtType) => {
  const resultFields = info.parentType.getFields();
  const executing = Object.hasOwn(resultFields, key) ? getNamedType(resultFields[key].type) : undefined;
  if (isObjectType(executing)) return executing;
  const named = info.schema.getType(builtType.name);
  return isObjectType(named) ? named : undefined;
};

// TransactionResult.id: the id of the operation's record, resolved by the `id` field of the record's own
// type in the executing schema (executingRecordType), with the record as parent, no arguments and that
// field's info, as a direct call to the operation's root that selects `id` resolves it, so that a rule an
// auth plugin put on `<Type>.id` applies here too. Without such a type the id is refused with FORBIDDEN
// (null and the error). An item without a record, and a type without an `id` field, give null without
// calling anything.
const resolveTransactionResultId = (item, args, context, info) => {
  const result = item !== null && typeof item === 'object' ? transactionResultRecords.get(item) : undefined;
  if (result === undefined) return null;
  const { key, record, builtType } = result;
  const recordType = executingRecordType(info, key, builtType);
  if (recordType === undefined) throw new ForbiddenError(`Access denied to ${info.parentType.name}.id`);
  const recordFields = recordType.getFields();
  if (!Object.hasOwn(recordFields, 'id')) return null;
  const idField = recordFields.id;
  return (idField.resolve ?? defaultFieldResolver)(record, {}, context, {
    ...info, fieldName: 'id', parentType: recordType, returnType: idField.type,
  });
};

// Runs a non-empty operation list of a transaction field and returns one result per operation, `{ id,
// [key]: record }`, where the record of a delete of a missing record and its id are null. Before the
// transaction: the limits are read once, then come the operation count, the model affinity check, the
// nested entries of the whole list, counted on what GraphQL coerced so that a list past the limit fails as
// a root past it does, the input walk, the references and the roots the Mutation type that runs the
// transaction exposes. Then one owned transaction runs the list, retries included; each
// attempt works on its own copy of the snapshot, with an execution state on its session for the limits and
// the joint nested budget. When the error of an operation of the final attempt ends the transaction, the
// resolver reports it with that operation's position (decorateOperationError); every other error is
// reported as it is.
const executeTransaction = async (transactionState, operationList, parent, context, info) => {
  const limits = Object.freeze({
    maxNestedOperations: getMaxNestedOperations(), maxTransactionOperations: getMaxTransactionOperations(),
  });
  if (operationList.length > limits.maxTransactionOperations) {
    throw transactionOperationsExceededError(limits.maxTransactionOperations);
  }
  assertTransactionModels(transactionState.models);
  const steps = transactionSteps(transactionState, operationList);
  assertTransactionNestedOperations(steps, operationList, limits.maxNestedOperations);
  const snapshot = snapshotTransaction(steps, operationList);
  // Once, on the snapshot, which it changes in place: `$$` literals lose a `$` before any attempt copies them.
  const referencePlan = planReferences(snapshot, transactionState, referenceRegistry);
  // The plan's positions by operation index, in plan order, so that each operation reads only its own.
  const referencesOf = new Map();
  for (const position of referencePlan) {
    if (!referencesOf.has(position.index)) referencesOf.set(position.index, []);
    referencesOf.get(position.index).push(position);
  }
  const operationRoots = exposedOperationRoots(steps, info.parentType);

  // One record per attempt that started, in order. Its `failure` is `{ error, operationIndex, operation }`
  // for the operation whose error ended the attempt, or null: errors propagate unchanged while attempts
  // run, so that the adapter can still recognize them, and the position of the final attempt's failure
  // stays here for the error the resolver reports.
  const attempts = [];
  const runAttempt = async (session) => {
    // The joint budget follows the attempt's session; one that cannot carry it would leave it unchecked.
    if (session === null || (typeof session !== 'object' && typeof session !== 'function')) {
      throw transactionUnsupportedError();
    }
    const attempt = { failure: null };
    attempts.push(attempt);
    const state = createExecutionState({ runtimeToken, limits });
    attachExecutionState(session, state);
    try {
      const copies = steps.map(({ index, key, entry }) => ({
        [key]: snapshotOperationInput(snapshot[index][key], entry.valueType, { ...operationWalkOptions, mode: 'copy' }),
      }));
      // `{ id }` of each operation's record in this attempt, or null, which resolveReferences reads.
      const written = [];
      // One operation: its references, the checks of its roots with the root's args,
      // `{ input }` or, for a delete, `{ id }` or `{ id, version }`, the root's middleware with the same
      // args, then, on a copy of what middleware left and before anything of it is written, the look-ahead
      // of its nested entries and the collection check, and the operation itself on the attempt's session.
      const runStep = async ({ index, key, entry }) => {
        const references = referencesOf.get(index);
        if (references !== undefined) resolveReferences(copies, references, written, index);
        const args = entry.operation === operations.DELETE ? copies[index][key] : { input: copies[index][key] };
        await authorizeTransactionOperation(operationRoots.get(key), parent, args, context, info);
        await executeMiddleware(entry.operation === operations.STATE_CHANGED
          ? {
            type: entry.type, args, operation: entry.operation, actionName: entry.actionName, actionField: entry.actionField, context,
          }
          : {
            type: entry.type, args, operation: entry.operation, context,
          });
        const { model: Model, gqltype, controller } = entry.type;
        if (entry.operation === operations.DELETE) {
          // As the delete root: a protected delete takes the version as middleware left it.
          const target = entry.protected ? { id: args.id, version: args.version } : args.id;
          return runOperation({ Model, gqltype, controller }, entry.operation, target, session, context);
        }
        // The operation gets its own copy of the input middleware left, as each attempt of a root does, so
        // a value middleware put there, which may be shared, is never changed by it and a retry starts from it.
        const input = cloneInput(args.input, entry.valueType);
        // As the roots, the nested limit comes before the pre-read, so it wins over an early VERSION_CONFLICT.
        assertRemainingNestedBudget(gqltype, input, state);
        assertCollectionWrites(gqltype, input);
        return runOperation({ Model, gqltype, controller }, entry.operation, input, session, context,
          entry.actionField ?? null);
      };
      const results = [];
      for (const step of steps) {
        let record;
        try {
          record = await runStep(step);
        } catch (error) {
          attempt.failure = { error, operationIndex: step.index, operation: step.key };
          throw error;
        }
        const id = record == null ? null : record._id ?? record.id ?? null;
        written[step.index] = record == null ? null : { id };
        const item = { id, [step.key]: record ?? null };
        if (record != null) {
          transactionResultRecords.set(item, {
            key: step.key, record, builtType: getNamedType(step.entry.rootField.type),
          });
        }
        results.push(item);
      }
      return results;
    } finally {
      detachExecutionState(session, state);
    }
  };
  try {
    return await adapter.withTransaction(null, runAttempt, steps[0].entry.type.model);
  } catch (error) {
    const { failure } = attempts.at(-1) ?? {};
    throw failure && reachesOperationError(error, failure.error)
      ? decorateOperationError(error, failure.operationIndex, failure.operation) : error;
  }
};

// The models one transaction of the field may write (#151): those of the types that own
// its operations, then those of the referenced collections their inputs declare, through the items'
// own inputs and embedded values at any depth, without null models or repeats.
const transactionModels = (operationEntries) => {
  const models = [];
  const add = (model) => {
    if (model != null && !models.includes(model)) models.push(model);
  };
  const owners = [...new Set([...operationEntries.values()].map(({ type }) => typesDict.types[type.gqltype.name]))];
  owners.forEach(({ model }) => add(model));
  const visited = new Set();
  const visit = (gqltype) => {
    if (visited.has(gqltype)) return;
    visited.add(gqltype);
    for (const field of Object.values(gqltype.getFields())) {
      if (isReadOnlyField(field)) continue;
      const listShape = getListShape(field.type);
      const target = listShape ? listShape.itemType : unwrapNonNull(field.type);
      const registration = target instanceof GraphQLObjectType ? typesDict.types[target.name] : undefined;
      if (registration?.gqltype !== target) continue;
      const embedded = !!field.extensions?.relation?.embedded;
      if (listShape && !embedded) {
        add(registration.model);
        visit(target);
      } else if (embedded) {
        visit(target);
      }
    }
  };
  owners.forEach(({ gqltype }) => visit(gqltype));
  return models;
};

// The transaction field of a schema whose generated mutations are built, from the roots of `mutation`,
// which does not have it yet, and `query`, the final query root. Returns `{ field, state }`, where the
// state is what executeTransaction reads: `name`, `typeNames`, `operations` (operation key ->
// `{ type, operation, actionName?, actionField?, protected, rootField, valueType }`, with the
// registration the root runs: the update one for updates and actions; the root field the schema was
// built with, whose authorization entries a copy of the schema cannot drop; and the type of the
// operation's value in the field's operation type) and `models`, frozen, which the adapter's affinity
// check receives.
const buildTransaction = ({ name, types }, query, mutation, shadowedRoots) => {
  const typeNames = types.map((type) => type.name);
  for (const { entry, typeName } of shadowedRoots) {
    if (typeNames.includes(typeName)) {
      warnOnce(typesDict.types[typeName].gqltype, `transactionShadowed:${name}:${entry}`, 'Configuration issue: the '
        + `registered mutation ${entry} replaces the generated mutation of ${typeName} with that name, so the ${name} `
        + `field has no ${entry} operation.`);
    }
  }
  const operationEntries = new Map();
  const descriptors = [];
  for (const { key, field, marker } of collectOperationFields(mutation, typeNames)) {
    const forUpdate = marker.operation === operations.UPDATE || marker.operation === operations.STATE_CHANGED;
    const type = (forUpdate ? typesDictForUpdate : typesDict).types[marker.typeName];
    const entry = {
      type, operation: marker.operation, protected: isProtected(type.gqltype), rootField: field,
    };
    if (marker.operation === operations.STATE_CHANGED) {
      entry.actionName = marker.action;
      entry.actionField = type.stateMachine.actions[marker.action];
    }
    operationEntries.set(key, entry);
    const input = field.args.find((arg) => arg.name === 'input');
    descriptors.push({
      key,
      operation: marker.operation,
      protected: entry.protected,
      inputType: input ? unwrapNonNull(input.type) : null,
      returnType: field.type,
    });
  }
  assertTransactionSchema({
    name, mutation, operations: descriptors, typeExists: (typeName) => findSchemaType([query, mutation], typeName) !== null,
  });
  const state = {
    name, typeNames, operations: operationEntries, models: Object.freeze(transactionModels(operationEntries)),
  };
  const field = buildTransactionField({
    name,
    types,
    operations: descriptors,
    recordVersionRef: RecordVersionRef,
    resolveId: resolveTransactionResultId,
    // An empty list runs nothing: no transaction and no affinity check.
    async resolve(parent, args, context, info) {
      const { operations: list } = args;
      if (list.length === 0) return [];
      return executeTransaction(state, list, parent, context, info);
    },
  });
  const valueTypes = getNamedType(field.args.operations.type).getFields();
  for (const [key, entry] of operationEntries) entry.valueType = valueTypes[key].type;
  return { field, state };
};

const createSchema = (includedQueryTypes, includedMutationTypes, includedCustomMutations, options) => {
  // Reject before models, resolvers or roots are built, so a rejected schema changes nothing.
  const { includedCustomQueries, transaction } = readSchemaOptions(options, includedMutationTypes,
    includedCustomMutations);
  assertQueryNamesAvailable(includedQueryTypes, includedCustomQueries);
  assertViewsAvailable(includedQueryTypes, includedCustomQueries);
  Object.values(typesDict.types).forEach(({ gqltype }) => validateScope(gqltype));
  const schemaTypes = collectSchemaOutputTypes();
  schemaTypes.forEach(assertNotBoundElsewhere);
  schemaTypes.forEach(assertFieldsNotBoundElsewhere);
  if (assertVirtualFields(schemaTypes)) virtualFieldsDeclared = true;
  warnUndeclaredVirtualFields();
  assertPlainConnectionFields();
  assertCollectionConnections();
  // An application type with the name of a field metadata type that an earlier schema fixed; one that
  // only generated types or the fields of an input object reach is found when the schema is
  // constructed.
  const applicationTypes = includedApplicationTypes(includedQueryTypes, includedMutationTypes,
    includedCustomMutations, includedCustomQueries);
  assertFieldMetadataNamesFree(applicationTypes);
  const referencedTypes = markReferencedTypesForModelGeneration();
  // Entities, which keep their own stored identity: connect() types and relation targets.
  Object.values(typesDict.types).forEach((typeInfo) => {
    typeInfo.storedIdentity = typeInfo.endpoint === true || referencedTypes.has(typeInfo);
  });
  const { protectedTypes, reserveVersionNames } = assertConcurrencyDeclarations(applicationTypes);
  if (adapter.prepare) {
    adapter.prepare(getRegistrations(), { createCollection: !preventCollectionCreation });
  }
  // prepare() describes protected types from their declaration. Models, inputs, resolvers and query
  // arguments are built from here on, so they all see the field.
  protectedTypes.forEach(({ gqltype }) => injectVersionField(gqltype));

  Object.values(typesDict.types).forEach((typeInfo) => {
    if (typeInfo.gqltype && !typeInfo.model) {
      if (typeInfo.endpoint) {
        typeInfo.model = adapter.createModel(typeInfo.gqltype, typeInfo.onModelCreated, {
          createCollection: !preventCollectionCreation,
        });
      } else if (typeInfo.needsModel) {
        typeInfo.model = adapter.createModel(typeInfo.gqltype, null, { createCollection: false });
      }
      const { model } = typeInfo;
      if (model !== null && (typeof model === 'object' || typeof model === 'function')) generatedModels.add(model);
    }
  });

  Object.keys(typesDict.types).forEach((typeName) => {
    if (typesDictForUpdate.types[typeName]) {
      typesDictForUpdate.types[typeName].model = typesDict.types[typeName].model;
      typesDictForUpdate.types[typeName].storedIdentity = typesDict.types[typeName].storedIdentity;
    }
  });

  // Every entity resolves `id`, whatever the query and mutation allowlists include. The type object
  // is marked too, so query paths of any runtime that shares it follow the same identity.
  const embeddedValueTypes = new Set();
  Object.values(typesDict.types).forEach((typeInfo) => {
    if (typeInfo.gqltype) {
      if (typeInfo.storedIdentity) {
        markStoredIdentity(typeInfo.gqltype);
        installIdResolver(typeInfo.gqltype);
      }
      autoGenerateResolvers(typeInfo.gqltype);
      if (typeof adapter.readEmbeddedValue === 'function') {
        installEmbeddedValueResolvers(typeInfo.gqltype, embeddedValueTypes);
      }
    }
  });
  // After every type has its relation and embedded value resolvers, which these fields keep.
  const objectMemberTypes = new Set();
  Object.values(typesDict.types).forEach(({ gqltype }) => installObjectMemberResolvers(gqltype, objectMemberTypes));

  let query = buildRootQuery('RootQueryType', includedQueryTypes, undefined, includedCustomQueries);
  Object.values(typesDict.types).forEach(({ gqltype }) => {
    if (gqltype && !applicationResolvedFields.has(gqltype)) {
      applicationResolvedFields.set(gqltype, listApplicationResolvedFields(gqltype));
    }
  });
  const shadowedRoots = [];
  let mutation = buildMutation('Mutation', includedMutationTypes, includedCustomMutations, shadowedRoots);
  // An application scalar named JSON that this schema contains also types aggregation results. Any
  // other type named JSON still collides, and GraphQLSchema reports the duplicate name.
  const applicationJSON = findSchemaType([query, mutation], 'JSON', QLTypeAggregationResult);
  if (applicationJSON instanceof GraphQLScalarType) {
    query = buildRootQuery('RootQueryType', includedQueryTypes, aggregationResultTypeFor(applicationJSON),
      includedCustomQueries);
  }
  // The transaction field's checks that need the built roots run on them before it is added (#151).
  const built = transaction && buildTransaction(transaction, query, mutation, shadowedRoots);
  if (built) mutation = withTransactionField(mutation, transaction.name, built.field);

  const schema = constructSchema(query, mutation, reserveVersionNames);
  if (built) recordTransactionState(built.field, built.state);
  // Reserve reachable types whose relation fields still have no resolver, such as an unregistered
  // custom operation result, so another runtime cannot later generate resolvers this schema executes.
  schemaTypes.forEach((type) => {
    if (type instanceof GraphQLObjectType && hasUnresolvedRelation(type)) {
      runtimeBoundTypes.set(type, runtimeIdentity);
    }
  });
  // The schema exists, so each registered type's protection is fixed from now on.
  Object.values(typesDict.types).forEach(({ gqltype }) => {
    if (!protectionStatus.has(gqltype)) protectionStatus.set(gqltype, isProtected(gqltype));
  });
  return schema;
};

const getModel = (gqltype) => typesDict.types[gqltype.name]?.model;

const getType = (typeName) => {
  if (typeof typeName === 'string') {
    return typesDict.types[typeName]?.gqltype;
  }
  if (typeName && typeName.name) {
    return typesDict.types[typeName.name]?.gqltype;
  }
  return null;
};

const registerMutation = (name, description, inputModel, outputModel, callback) => {
  registeredMutations[name] = {
    description,
    inputModel,
    outputModel,
    callback,
  };
};

const invalidQueryRegistration = (detail) => new SimfinityError(
  `registerCustomQuery ${detail}`, 'INVALID_QUERY_REGISTRATION', 500,
);

const validateQueryRegistration = (name, registration) => {
  const { description, inputModel, outputModel, callback } = registration;
  if (typeof name !== 'string' || !/^[_A-Za-z][_0-9A-Za-z]*$/.test(name) || name.startsWith('__')) {
    throw invalidQueryRegistration('requires a valid GraphQL field name that does not start with __');
  }
  if (description != null && typeof description !== 'string') {
    throw invalidQueryRegistration('description must be a string');
  }
  if (inputModel != null && !(inputModel instanceof GraphQLInputObjectType)) {
    throw invalidQueryRegistration('input must be a GraphQLInputObjectType, null or undefined');
  }
  if (!isOutputType(outputModel)) {
    throw invalidQueryRegistration('output must be a GraphQL output type');
  }
  if (typeof callback !== 'function') {
    throw invalidQueryRegistration('callback must be a function');
  }
};

const registerCustomQuery = (name, description, inputModel, outputModel, callback) => {
  const registration = {
    description,
    inputModel,
    outputModel,
    callback,
  };
  validateQueryRegistration(name, registration);
  if (Object.hasOwn(registeredQueries, name)) {
    throw queryNameConflict(name);
  }
  registeredQueries[name] = registration;
};

const invalidView = (detail) => new SimfinityError(`registerView ${detail}`, 'INVALID_VIEW', 500);

// A view parameter is a value the client sends as a variable or a literal: a scalar, an enum or a list
// of them, each possibly NonNull. An input object is never one, wherever it is nested.
const isViewParamType = (type) => {
  if (isNonNullType(type) || isListType(type)) return isViewParamType(type.ofType);
  return isScalarType(type) || isEnumType(type);
};

const isNonNullPlainObject = (value) => value !== null && typeof value === 'object' && isPlainObject(value);

const VIEW_OPTION_KEYS = new Set(['type', 'description', 'params', 'where']);
const VIEW_PARAM_KEYS = new Set(['type', 'description', 'defaultValue']);

const validateViewParams = (params) => {
  if (params === undefined) return;
  if (!isNonNullPlainObject(params)) throw invalidView('params must be an object');
  for (const [paramName, param] of Object.entries(params)) {
    if (!isNonNullPlainObject(param)) throw invalidView(`param ${paramName} must be an object`);
    for (const key of Object.keys(param)) {
      if (!VIEW_PARAM_KEYS.has(key)) throw invalidView(`param ${paramName} has an unknown key ${key}`);
    }
    if (!isViewParamType(param.type)) {
      throw invalidView(`param ${paramName} type must be a scalar, an enum or a list of them, not an input object`);
    }
    if (param.description !== undefined && typeof param.description !== 'string') {
      throw invalidView(`param ${paramName} description must be a string`);
    }
  }
};

const validateViewRegistration = (name, options) => {
  if (typeof name !== 'string' || !/^[_A-Za-z][_0-9A-Za-z]*$/.test(name) || name.startsWith('__')) {
    throw invalidView('requires a valid GraphQL field name that does not start with __');
  }
  if (name.endsWith('_aggregate')) {
    throw invalidView(`name ${name} must not end with _aggregate, which the generated aggregate queries use`);
  }
  if (!isNonNullPlainObject(options)) throw invalidView('requires an options object');
  for (const key of Object.keys(options)) {
    if (!VIEW_OPTION_KEYS.has(key)) throw invalidView(`has an unknown option ${key}`);
  }
  if (!(options.type instanceof GraphQLObjectType)) throw invalidView('type must be a GraphQLObjectType');
  if (typeof options.description !== 'string' || options.description === '') {
    throw invalidView('requires a non-empty description');
  }
  validateViewParams(options.params);
  if (typeof options.where !== 'function') throw invalidView('where must be a function');
};

const registerView = (name, options) => {
  validateViewRegistration(name, options);
  if (Object.hasOwn(registeredViews, name)) throw queryNameConflict(name);
  registeredViews[name] = {
    name, type: options.type, description: options.description, params: options.params ?? {}, where: options.where,
  };
};

// Gives the field a new extensions object as well as the resolver, so a copy made before keeps
// untagged extensions. It has a null prototype because graphql-js keeps such an object, rather than
// copying it, when a type is rebuilt from toConfig().
const claimRelationField = (fieldEntry, resolve, extensions = {}) => {
  fieldEntry.extensions = Object.assign(Object.create(null), fieldEntry.extensions, extensions);
  fieldEntry.resolve = markGenerated(resolve);
  relationFieldOwners.set(fieldEntry.extensions, runtimeIdentity);
  relationFieldOwners.set(fieldEntry.resolve, runtimeIdentity);
};

// The identifier a single reference reads is stored, not sent by the client, so one the adapter
// rejects as malformed, such as a value written outside Simfinity, is a data error rather than a bad
// request. Missing records and other errors keep their own classification.
const storedReferenceError = (error, gqltype, fieldName) => {
  if (!(error instanceof SimfinityError) || error.getCode() !== 'NOT_VALID_ID' || error.getStatus() !== 400) {
    return error;
  }
  return new InternalServerError(`${gqltype.name}.${fieldName} stores an invalid identifier`, error);
};

const autoGenerateResolvers = (gqltype) => {
  assertFieldsNotBoundElsewhere(gqltype);
  const fields = gqltype.getFields();

  for (const [fieldName, fieldEntry] of Object.entries(fields)) {
    if (fieldEntry.resolve) continue;
    const relation = fieldEntry.extensions?.relation;
    if (!relation || relation.embedded) continue;

    const listShape = getListShape(fieldEntry.type);
    if (listShape) {
      const relatedType = listShape.itemType;
      const connection = normalizeConnectionField(
        relatedType,
        relation.connectionField || fieldName,
      );
      const relatedTypeInfo = requireRegisteredType(typesDict, relatedType, fieldName, gqltype.name);
      const argsObject = createArgsForQuery(relatedTypeInfo.gqltype, connection.graphqlFieldName);

      fieldEntry.args = formatArgs(Object.entries(argsObject));
      claimRelationField(fieldEntry, async (parent, args, context) => {
        if (!relatedTypeInfo || !relatedTypeInfo.model) {
          throw new Error(`Related type ${relatedType.name} not found or not connected. Make sure it's connected with simfinity.connect() or simfinity.addNoEndpointType().`);
        }
        const params = await prepareRead(relatedTypeInfo, args, context, 'find');
        return loadChildren(relatedTypeInfo, connection, parent._id ?? parent.id, params.args, context);
      }, { simfinityQuery: { typeName: relatedType.name, operation: 'find' } });
      runtimeBoundTypes.set(gqltype, runtimeIdentity);
    } else if (fieldEntry.type instanceof GraphQLObjectType
      || (fieldEntry.type instanceof GraphQLNonNull && fieldEntry.type.ofType instanceof GraphQLObjectType)) {
      const relatedType = unwrapNonNull(fieldEntry.type);
      const connectionField = getFieldStorageName(fieldName, fieldEntry);

      claimRelationField(fieldEntry, async (parent, args, context) => {
        const relatedTypeInfo = typesDict.types[relatedType.name];
        if (!relatedTypeInfo || !relatedTypeInfo.model) {
          throw new Error(`Related type ${relatedType.name} not found or not connected. Make sure it's connected with simfinity.connect() or simfinity.addNoEndpointType().`);
        }
        // Any stored identifier except null or an empty string, so numeric IDs such as 0 resolve. A
        // function under the field name is a member, such as the class a MongoDB document inherits
        // `constructor` from, not an identifier.
        // The field name is read only when the stored identifier is missing.
        let relatedId = ownValue(parent, connectionField);
        if (relatedId == null) {
          const linked = ownValue(parent, fieldName);
          relatedId = typeof linked === 'function' ? undefined : linked;
        }
        const id = relatedId?._id ?? relatedId;
        if (id == null || id === '') return null;
        try {
          return await resolveById(relatedTypeInfo, { id: String(id) }, context, id);
        } catch (error) {
          throw storedReferenceError(error, gqltype, fieldName);
        }
      });
      runtimeBoundTypes.set(gqltype, runtimeIdentity);
    }
  }
};

// A replaced registration builds fresh inputs. Its cached collection projections may already
// contain fields from the previous input graph; keep those alive only in earlier schemas.
const invalidateCollectionInputs = (gqltype) => {
  for (const [name, cached] of excludedFieldInputTypes) {
    if (cached.itemType.name === gqltype.name) excludedFieldInputTypes.delete(name);
  }
};

const connect = (model, gqltype, simpleEntityEndpointName,
  listEntitiesEndpointName, controller, onModelCreated, stateMachine) => {
  const registration = {
    model,
    gqltype,
    simpleEntityEndpointName,
    listEntitiesEndpointName,
    endpoint: true,
    controller,
    stateMachine,
    onModelCreated,
  };
  assertNotBoundElsewhere(gqltype);
  validateScope(gqltype);
  // The declaration's shape only; it reads extensions, never the fields (#98).
  concurrencyDeclared(gqltype);
  if (adapter.validateRegistration) adapter.validateRegistration(registration);

  invalidateCollectionInputs(gqltype);
  waitingInputType[gqltype.name] = {
    model,
    gqltype,
  };
  typesDict.types[gqltype.name] = registration;

  typesDictForUpdate.types[gqltype.name] = { ...typesDict.types[gqltype.name] };
};

const addNoEndpointType = (gqltype) => {
  assertNotBoundElsewhere(gqltype);
  const fields = gqltype.getFields();
  let needsModel = false;
  for (const fieldEntry of Object.values(fields)) {
    if (fieldEntry.extensions?.relation
      && (fieldEntry.type instanceof GraphQLObjectType
        || getListShape(fieldEntry.type)
        || (fieldEntry.type instanceof GraphQLNonNull && fieldEntry.type.ofType instanceof GraphQLObjectType))) {
      needsModel = true;
      break;
    }
  }

  const registration = {
    gqltype, endpoint: false, model: null, needsModel,
  };
  validateScope(gqltype);
  concurrencyDeclared(gqltype);
  if (adapter.validateRegistration) adapter.validateRegistration(registration);

  invalidateCollectionInputs(gqltype);
  waitingInputType[gqltype.name] = { gqltype };
  typesDict.types[gqltype.name] = registration;
  typesDictForUpdate.types[gqltype.name] = { ...typesDict.types[gqltype.name] };
};

// Arguments that every list query and collection field generates, after the field filters.
const LIST_QUERY_ARGS = ['pagination', 'sort', 'AND', 'OR'];

// `omit` is a collection's back-reference field, which its parent supplies, so it gets no filter.
// A field named like a generated argument gets no top-level filter either; it is reported once.
// A virtual field is not part of the query language, so it gets no filter at all, and neither does the
// version field of a protected type (#98): a MongoDB record without a stored version reads as 1, which
// a filter could not match.
const createArgsForQuery = (gqltype, omit = null) => {
    const argsObject = {};
    const argTypes = gqltype.getFields();
    for (const name of LIST_QUERY_ARGS) {
      if (name !== omit && Object.hasOwn(argTypes, name) && !isVirtualField(argTypes[name])) {
        warnOnce(gqltype, name, `Configuration issue: ${gqltype.name}.${name} has the name of a generated list `
          + 'query argument, so list queries and collection fields cannot filter it with a top-level argument; '
          + 'filter it in AND/OR group conditions or rename the field.');
      }
    }

    for (const [fieldEntryName, fieldEntry] of Object.entries(argTypes)) {
      if (fieldEntryName === omit || isVirtualField(fieldEntry) || isVersionField(fieldEntry)) continue;
      let filterType = null;

      if (fieldEntry.type instanceof GraphQLScalarType
        || isNonNullOfType(fieldEntry.type, GraphQLScalarType)
        || fieldEntry.type instanceof GraphQLEnumType
        || isNonNullOfType(fieldEntry.type, GraphQLEnumType)) {
        filterType = QLFilter;
      } else if (fieldEntry.type instanceof GraphQLObjectType
        || isNonNullOfType(fieldEntry.type, GraphQLObjectType)) {
        filterType = QLTypeFilterExpression;
      } else if (getListShape(fieldEntry.type)) {
        const listOfType = getListShape(fieldEntry.type).itemType;
        if (listOfType instanceof GraphQLScalarType
          || isNonNullOfType(listOfType, GraphQLScalarType)
          || listOfType instanceof GraphQLEnumType
          || isNonNullOfType(listOfType, GraphQLEnumType)) {
          filterType = QLFilter;
        } else {
          // Includes lists of interfaces and unions, which have no generated filter either. Their
          // argument has always been generated and is kept, so requests that send it as null stay valid.
          filterType = QLTypeFilterExpression;
        }
      }
      // A single interface or union field has no generated filter, so it gets no argument.
      if (filterType) argsObject[fieldEntryName] = { type: filterType };
    }

    argsObject.pagination = {};
    argsObject.pagination.type = QLPagination;

    argsObject.sort = {};
    argsObject.sort.type = QLSortExpression;

    argsObject.AND = {};
    argsObject.AND.type = new GraphQLList(QLFilterGroup);

    argsObject.OR = {};
    argsObject.OR.type = new GraphQLList(QLFilterGroup);

    return argsObject;
};

function formatArgs(argsArray) {
  const graphqlArgs = [];
  for (const [key, value] of argsArray) {
    const item = {
      name: key,
      type: value.type,
    };
    graphqlArgs.push(item);
  }
  return graphqlArgs;
}

  if (adapter.bind) {
    adapter.bind({ getModel, getType, getRegistrations });
  }

  return {
    configureQueryLimits,
    configureMutationLimits,
    connect,
    addNoEndpointType,
    createSchema,
    getModel,
    getType,
    getInputType,
    getRegistrations,
    use,
    registerMutation,
    registerCustomQuery,
    registerView,
    saveObject,
    updateObject,
    deleteObject,
    transitionObject,
    preventCreatingCollection,
  };
};
